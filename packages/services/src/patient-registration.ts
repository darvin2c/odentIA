import {
  clinicalProfileFor,
  DEFAULT_REGISTRATION_CONFIG,
  documentIssuerCountry,
  isMinor,
  isRealDate,
  kinshipFromWords,
  missingPersonData,
  type MissingPersonDatum,
  normalizePhone,
  pendingRegistrationFields,
  registrationAnswersSchema,
  registrationConfigSchema,
  validateRegistrationAnswers,
  type RegistrationAnswers,
  type RegistrationConfig,
  type RegistrationContactInput,
  type RegistrationEntryPoint,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  patientContact,
  patientDataConsent,
  patientRegistration,
  patientRegistrationLink,
} from "@odentia/db/schema/clinical"
import { contact, conversation, contactIdentity, channelConnection, crmTask } from "@odentia/db/schema/crm"
import { auditEvent, patientRegistrationConfig } from "@odentia/db/schema/org"
import { createHash, randomBytes } from "node:crypto"
import { and, eq, sql, type SQL } from "drizzle-orm"
import { addAgentCaseNote, CASE_NOTE_CHARS } from "./agent-case.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { createContactNote } from "./crm-workspace.js"
import {
  createPatient,
  patientOrganizationToday,
  REGISTRATION_NOT_COMPLETED_TEXT,
  type RegistrationHold,
  requirePatient,
  type PatientRow,
} from "./patients.js"
import { initializeDeclaredPatientHealth } from "./clinical.js"
import { applyMessagePermissions } from "./data-consents.js"
import { createPerson, findPersonByDocument } from "./people.js"
import { grantResponsibility } from "./responsibilities.js"
import { claimWhatsAppNumber, isDirectThread, lockRegistrationContacts } from "./contacts.js"
import { completeTask, createTask, discardTask } from "./tasks.js"

const LINK_TTL_MS = 72 * 60 * 60 * 1000
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

/** Registro público no disponible: respuesta uniforme sin detalle. */
function unavailable(): ServiceError {
  return notFound("Registro no disponible")
}

/** Conflicto público neutro: no revela ficha, causa ni datos del existente. */
function notCompleted(): ServiceError {
  return conflict("REGISTRATION_NOT_COMPLETED", REGISTRATION_NOT_COMPLETED_TEXT)
}

/**
 * Quien abrió su enlace ya tiene su ficha: no se registra otra vez, pero sí
 * puede registrar a otra persona. Solo lo sabe quien tiene el enlace de su
 * conversación, que es esa misma persona.
 */
const ALREADY_REGISTERED_TEXT = "Ya tienes tu registro en la clínica. Aquí puedes registrar a tu hijo o a un familiar."

/** El contacto ya tiene ficha propia (su vínculo `self`). */
async function hasOwnRecord(tx: Db, orgId: string, contactId: string): Promise<boolean> {
  const [own] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return !!own
}

function cloneDefaultConfig(): RegistrationConfig {
  return {
    version: 0,
    enabled: false,
    privacyNotice: "",
    askReminders: true,
    askMessages: true,
    fields: { ...DEFAULT_REGISTRATION_CONFIG.fields },
  }
}

function advisoryKey(value: string): SQL {
  return sql`hashtext(${value})`
}

function rowToConfig(row: typeof patientRegistrationConfig.$inferSelect): RegistrationConfig {
  return {
    version: row.version,
    enabled: row.enabled,
    fields: row.fields,
    privacyNotice: row.privacyNotice,
    askReminders: row.askReminders,
    askMessages: row.askMessages,
  }
}

/** JSON canónico: claves ordenadas de forma recursiva. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}


async function advisoryExclusive(tx: Db, value: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${advisoryKey(value)})`)
}

async function advisoryShared(tx: Db, value: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${advisoryKey(value)})`)
}

function hasMeaningfulHealth(health: NonNullable<RegistrationAnswers["health"]> | undefined): boolean {
  if (!health) return false
  if (health.bloodGroup != null) return true
  for (const group of [health.allergies, health.conditions, health.medications]) {
    if (group && group.state !== "unanswered") return true
  }
  return Object.values(health.dental ?? {}).some((v) => v !== undefined && v !== "")
}

/**
 * Persona que responde por el consentimiento del registro: el representante
 * legal si lo llenó él, o la propia persona del paciente.
 */
async function registrationGrantor(
  tx: Db,
  orgId: string,
  patientId: string,
  byRepresentative: boolean,
): Promise<string | null> {
  const rows = await tx
    .select({ contactId: patientContact.contactId, relationship: patientContact.relationship })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId)))
  const wanted = byRepresentative ? "guardian" : "self"
  return (rows.find((row) => row.relationship === wanted) ?? rows.find((row) => row.relationship === "self"))?.contactId ?? null
}

// --- Configuración ---

export async function getPatientRegistrationConfig(
  tx: Db,
  orgId: string,
): Promise<RegistrationConfig> {
  const [row] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
  return row ? rowToConfig(row) : cloneDefaultConfig()
}

/**
 * «Faltan datos para atenderla» de una ficha (decisión 10 de la fase 3): lo
 * necesario para atender más lo que «Registro de pacientes» marca
 * obligatorio, con la regla de `missingPersonData`. Se calcula aquí, en el
 * servidor, para la página de la persona; el teléfono o el correo de quien
 * habla por ella (un vínculo activo que no es ella) cuentan como suyos.
 */
export async function getPatientMissingData(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<MissingPersonDatum[]> {
  const row = await requirePatient(tx, orgId, patientId)
  const config = await getPatientRegistrationConfig(tx, orgId)
  const [spokesperson] = await tx
    .select({ id: contact.id })
    .from(patientContact)
    .innerJoin(contact, and(eq(contact.organizationId, orgId), eq(contact.id, patientContact.contactId)))
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        sql`${patientContact.relationship} <> 'self'`,
        eq(contact.isActive, true),
        sql`(${contact.phone} is not null or ${contact.email} is not null)`,
      ),
    )
    .limit(1)
  // El contacto de emergencia es una persona vinculada con la marca (decisión 25).
  const [emergency] = await tx
    .select({ name: contact.displayName, phone: contact.phone })
    .from(patientContact)
    .innerJoin(contact, and(eq(contact.organizationId, orgId), eq(contact.id, patientContact.contactId)))
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.isEmergency, true),
        eq(contact.isActive, true),
      ),
    )
    .limit(1)
  return missingPersonData(
    config,
    { ...row, emergencyContactName: emergency?.name ?? null, emergencyContactPhone: emergency?.phone ?? null },
    { representativeContact: !!spokesperson },
  )
}

export interface SaveRegistrationConfigInput {
  expectedVersion: number
  enabled: boolean
  fields: RegistrationConfig["fields"]
  privacyNotice: string
  /** Sin valor, se conserva lo que ya tenía la clínica. */
  askReminders?: boolean
  askMessages?: boolean
}

export async function savePatientRegistrationConfig(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: SaveRegistrationConfigInput,
): Promise<RegistrationConfig> {
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw validation("Versión de configuración inválida")
  }
  const parsed = registrationConfigSchema.safeParse({
    version: input.expectedVersion,
    enabled: input.enabled,
    fields: input.fields,
    privacyNotice: input.privacyNotice,
    ...(input.askReminders !== undefined ? { askReminders: input.askReminders } : {}),
    ...(input.askMessages !== undefined ? { askMessages: input.askMessages } : {}),
  })
  if (!parsed.success) {
    throw validation(parsed.error.issues[0]?.message ?? "Configuración inválida")
  }
  // Lock incompatible con registros en curso: serializa publicación frente a
  // lecturas compartidas de registerPatient/createPatientRegistrationLink.
  await advisoryExclusive(tx, `patient-registration-config:${orgId}`)
  const [current] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
    .for("update")
  const currentVersion = current?.version ?? 0
  if (currentVersion !== input.expectedVersion) {
    throw conflict(
      "STALE_REGISTRATION_CONFIG",
      "La configuración cambió en otra sesión: recarga y reintenta",
    )
  }
  const nextVersion = input.expectedVersion + 1
  const askReminders = input.askReminders ?? current?.askReminders ?? true
  const askMessages = input.askMessages ?? current?.askMessages ?? true
  await tx
    .insert(patientRegistrationConfig)
    .values({
      organizationId: orgId,
      version: nextVersion,
      enabled: parsed.data.enabled,
      fields: parsed.data.fields,
      privacyNotice: parsed.data.privacyNotice,
      askReminders,
      askMessages,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: patientRegistrationConfig.organizationId,
      set: {
        version: nextVersion,
        enabled: parsed.data.enabled,
        fields: parsed.data.fields,
        privacyNotice: parsed.data.privacyNotice,
        askReminders,
        askMessages,
        updatedAt: new Date(),
      },
    })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient-registration.config_saved",
    entity: "patient_registration_config",
    entityId: orgId,
    metadata: { version: nextVersion, enabled: parsed.data.enabled },
  })
  return {
    version: nextVersion,
    enabled: parsed.data.enabled,
    fields: parsed.data.fields,
    privacyNotice: parsed.data.privacyNotice,
    askReminders,
    askMessages,
  }
}

// --- Enlaces contextuales ---

export interface CreateRegistrationLinkInput {
  contactId: string
  conversationId: string
}

async function directConversation(tx: Db, orgId: string, conversationId: string, contactId: string): Promise<boolean> {
  const [row] = await tx.select({ thread: conversation.externalThreadId, channel: channelConnection.channel, sender: contactIdentity.externalUserId })
    .from(conversation)
    .innerJoin(channelConnection, and(eq(channelConnection.id, conversation.channelConnectionId), eq(channelConnection.organizationId, orgId)))
    .innerJoin(contactIdentity, and(eq(contactIdentity.id, conversation.contactIdentityId), eq(contactIdentity.organizationId, orgId), eq(contactIdentity.contactId, contactId), eq(contactIdentity.channel, channelConnection.channel)))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId), eq(conversation.contactId, contactId))).limit(1)
  return !!row && isDirectThread(row.channel, row.thread, row.sender)
}

/**
 * `actorUserId` es quien del equipo lo envía; `null` cuando lo emite el sistema
 * para que la persona complete sus datos al reservar desde su enlace de cita.
 */
export async function createPatientRegistrationLink(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: CreateRegistrationLinkInput,
): Promise<{ token: string; expiresAt: Date }> {
  if (!UUID_RE.test(input.contactId) || !UUID_RE.test(input.conversationId)) {
    throw validation("Contacto o conversación inválidos")
  }
  // Lock de configuración + contacto; se revalida publicado/activo al insertar.
  await advisoryShared(tx, `patient-registration-config:${orgId}`)
  const [config] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
    .for("share")
  if (!config || !config.enabled) throw validation("El registro público está deshabilitado")
  await lockRegistrationContacts(tx, orgId, [input.contactId], false)
  const [person] = await tx
    .select()
    .from(contact)
    .where(and(eq(contact.id, input.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!person) throw notFound("Contacto")
  if (!person.isActive) throw conflict("CONTACT_ARCHIVED", "Reactiva el contacto antes de enviarle el registro")
  const [thread] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
    .for("share")
  if (!thread || thread.contactId !== input.contactId) {
    throw validation("La conversación no pertenece al contacto")
  }
  if (!await directConversation(tx, orgId, thread.id, person.id)) throw validation("El registro requiere una conversación directa con identidad resuelta")
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + LINK_TTL_MS)
  await tx.insert(patientRegistrationLink).values({
    organizationId: orgId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    tokenHash: sha256Hex(token),
    createdBy: actorUserId,
    expiresAt,
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient-registration.link_created",
    entity: "patient_registration_link",
    entityId: input.conversationId,
    metadata: { contactId: input.contactId, conversationId: input.conversationId },
  })
  return { token, expiresAt }
}

// --- Vista pública ---

/**
 * `ownRecord`: quien abrió el enlace de su conversación ya tiene su ficha; el
 * formulario no le ofrece registrarse a sí misma, solo a otra persona.
 */
export type PublicRegistrationContext = { kind: "generic" } | { kind: "conversation"; ownRecord: boolean }

export async function getPublicPatientRegistration(
  tx: Db,
  orgId: string,
  token?: string,
): Promise<{ config: RegistrationConfig; today: string; countryCode: string | null; context: PublicRegistrationContext }> {
  await advisoryShared(tx, `patient-registration-config:${orgId}`)
  const [config] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
    .for("share")
  if (!config || !config.enabled) throw unavailable()
  const today = await patientOrganizationToday(tx, orgId)
  // El país de la clínica: de él dependen los documentos, seguros y regiones del formulario (ADR 0036).
  const countryCode = await findOrgCountry(tx, orgId)
  // Token vacío o inválido nunca cae al formulario genérico.
  if (token === undefined) return { config: rowToConfig(config), today, countryCode, context: { kind: "generic" } }
  const [link] = await tx
    .select()
    .from(patientRegistrationLink)
    .where(
      and(
        eq(patientRegistrationLink.tokenHash, sha256Hex(token)),
        eq(patientRegistrationLink.organizationId, orgId),
      ),
    )
    .limit(1)
    .for("share")
  if (!link || link.consumedAt || link.revokedAt || link.expiresAt.getTime() <= Date.now()) {
    throw unavailable()
  }
  // Revalida pertenencia actual: el archivo o la reasignación revocan el contexto.
  const [person] = await tx
    .select({ id: contact.id, isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, link.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  const [thread] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(
      and(eq(conversation.id, link.conversationId), eq(conversation.organizationId, orgId)),
    )
    .limit(1)
  if (!person || !person.isActive || !thread || thread.contactId !== link.contactId || !await directConversation(tx, orgId, thread.id, person.id)) {
    throw unavailable()
  }
  return {
    config: rowToConfig(config),
    today,
    countryCode,
    context: { kind: "conversation", ownRecord: await hasOwnRecord(tx, orgId, link.contactId) },
  }
}

// --- Registro transaccional ---

export type RegistrationContext =
  | {
      kind: "internal"
      userId: string
      contactId?: string
      conversationId?: string
      /**
       * `essentials`: el equipo registra con lo mínimo, al reservar, a la
       * persona de una conversación (`contactId` y `conversationId`, ficha
       * unida a ella como propia) o a alguien nuevo desde la Agenda (sin
       * vínculos ni conversación, con su teléfono). La misma regla que el
       * enlace de reserva: lo que la clínica exige y no se pidió queda anotado
       * (en el caso o en las notas de su persona) y la identidad, por revisar.
       * Ningún otro alta interna lo usa.
       */
      scope?: "essentials"
    }
  | {
      kind: "public"
      token?: string
      entryPoint: "qr" | "public_link"
      /**
       * `essentials`: datos esenciales para reservar (identidad y celular). Solo
       * con el enlace de una conversación; lo que la clínica exige y no se pide
       * queda por completar y la identidad, por revisar. Lo usa el enlace de
       * reserva; el registro público de la clínica no lo ofrece.
       */
      scope?: "essentials"
    }

export interface RegistrationInput {
  submissionId: string
  formVersion?: number
  answers: RegistrationAnswers
  contacts?: RegistrationContactInput[]
  registeredBranchId?: string
}

interface ResolvedLink {
  id: string
  contactId: string
  conversationId: string
}

async function lockTokenRow(tx: Db, orgId: string, token: string): Promise<ResolvedLink> {
  const [candidate] = await tx.select({ contactId: patientRegistrationLink.contactId }).from(patientRegistrationLink)
    .where(and(eq(patientRegistrationLink.organizationId, orgId), eq(patientRegistrationLink.tokenHash, sha256Hex(token)))).limit(1)
  if (!candidate) throw unavailable()
  await lockRegistrationContacts(tx, orgId, [candidate.contactId], false)
  const [link] = await tx
    .select()
    .from(patientRegistrationLink)
    .where(
      and(
        eq(patientRegistrationLink.tokenHash, sha256Hex(token)),
        eq(patientRegistrationLink.organizationId, orgId),
      ),
    )
    .limit(1)
    .for("update")
  if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw unavailable()
  if (link.consumedAt) throw unavailable()
  const [person] = await tx
    .select({ id: contact.id, isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.id, link.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
    .for("update")
  const [thread] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(
      and(eq(conversation.id, link.conversationId), eq(conversation.organizationId, orgId)),
    )
    .limit(1)
    .for("share")
  if (!person || !person.isActive || !thread || thread.contactId !== link.contactId || !await directConversation(tx, orgId, thread.id, person.id)) {
    throw unavailable()
  }
  return { id: link.id, contactId: link.contactId, conversationId: link.conversationId }
}

/**
 * Lo que queda anotado tras un registro con lo esencial: qué pide la clínica y
 * aún falta. Es corta: si la lista no cabe, dice cuántos más faltan en vez de cortarse.
 */
function pendingRegistrationNote(who: string, config: RegistrationConfig, answers: RegistrationAnswers): string {
  // La misma regla y las mismas palabras que el aviso de su página
  // («Faltan datos para atenderla»); tipo y número se dicen «documento».
  const pending = [...new Set(pendingRegistrationFields(config, answers).map((field) =>
    field.key === "docType" || field.key === "docNumber" ? "documento" : field.label.toLowerCase()))]
  const head = `${who}. Faltan datos para atenderla: confirmar apellidos y nombres`
  const named: string[] = []
  for (const label of pending) {
    const rest = pending.length - named.length - 1
    const tail = rest > 0 ? ` y ${rest} más` : ""
    if (`${head}, ${[...named, label].join(", ")}${tail}.`.length > CASE_NOTE_CHARS) break
    named.push(label)
  }
  const left = pending.length - named.length
  return `${head}${named.length ? `, ${named.join(", ")}` : ""}${left > 0 ? ` y ${left} más` : ""}.`
}

/**
 * Lo que pasó con su WhatsApp en el alta mínima desde la Agenda: su teléfono
 * pasó a ser su WhatsApp, ya era de otra persona de la clínica (no se mueve y
 * se dice), o no aplica (sin WhatsApp conectado o en otra vía de alta).
 */
export type RegistrationWhatsApp = "creado" | "en_uso"

export async function registerPatient(
  tx: Db,
  orgId: string,
  context: RegistrationContext,
  input: RegistrationInput,
): Promise<PatientRow & { whatsapp?: RegistrationWhatsApp }> {
  if (!UUID_RE.test(input.submissionId)) throw validation("Identificador de envío inválido")
  input = { ...input, submissionId: input.submissionId.toLowerCase() }
  const isPublic = context.kind === "public"
  if (Object.keys(input).some(key => !["submissionId", "formVersion", "answers", "contacts", "registeredBranchId"].includes(key))) throw validation("Campos de registro desconocidos")

  // Defensa estricta de forma: lo público nunca acepta vínculos ni sede.
  if (isPublic && (input.contacts !== undefined || input.registeredBranchId !== undefined)) {
    throw validation("Envío público inválido")
  }
  if (!isPublic && input.answers?.respondent === undefined) {
    throw validation("Indica quién declara la información")
  }

  // 1. Lock de envío + replay idéntico antes de versión/consumo/expiración.
  await advisoryExclusive(tx, `patient-registration-submission:${orgId}:${input.submissionId}`)
  const [prior] = await tx
    .select()
    .from(patientRegistration)
    .where(
      and(
        eq(patientRegistration.organizationId, orgId),
        eq(patientRegistration.submissionId, input.submissionId),
      ),
    )
    .limit(1)

  const publicContext = context.kind === "public" ? context : null
  const internalContext = context.kind === "internal" ? context : null
  const publicToken = publicContext?.token
  const hasToken = publicToken !== undefined
  const essentials = (publicContext ?? internalContext)?.scope === "essentials"
  if (essentials && publicContext && !hasToken) throw validation("Los datos esenciales solo se aceptan desde el enlace de una conversación")
  // El equipo registra con lo mínimo solo al reservar: a la persona de una
  // conversación, como su propia ficha, o a alguien nuevo desde la Agenda (sin
  // vínculos: su persona nace con la ficha y el teléfono es como ubicarla).
  const fromConversation =
    !!internalContext?.contactId &&
    !!internalContext.conversationId &&
    !!input.contacts?.some((link) => link.contactId === internalContext.contactId && link.relationship === "self")
  const newPerson =
    !!internalContext && !internalContext.contactId && !internalContext.conversationId && !input.contacts?.length
  if (essentials && internalContext) {
    if (!fromConversation && !newPerson) {
      throw validation("Lo mínimo solo se acepta al reservar: a la persona de una conversación o a alguien nuevo")
    }
    if (newPerson && !input.answers?.demographics?.phone) throw validation("Indica el teléfono")
  }
  const entryPoint: RegistrationEntryPoint = publicContext
    ? (hasToken ? "conversation" : publicContext.entryPoint)
    : (internalContext?.conversationId ? "conversation" : "platform")
  const actorUserId = publicContext ? null : (internalContext?.userId ?? null)
  const publicTokenHash = hasToken ? sha256Hex(publicToken as string) : null
  const stableContext = publicContext
    ? { kind: "public", entryPoint, tokenHash: publicTokenHash, ...(essentials ? { scope: "essentials" } : {}) }
    : {
        kind: "internal",
        entryPoint,
        actorUserId,
        contactId: internalContext?.contactId ?? null,
        conversationId: internalContext?.conversationId ?? null,
        ...(essentials ? { scope: "essentials" } : {}),
      }
  const payloadHash = sha256Hex(
    canonicalJson({
      answers: input.answers,
      contacts: input.contacts ?? null,
      registeredBranchId: input.registeredBranchId ?? null,
      formVersion: input.formVersion ?? null,
      context: stableContext,
    }),
  )
  if (prior) {
    // Lo público liga el envío al enlace (linkId), no a contactos resueltos:
    // el vínculo se comprueba sin tocar la fila del token.
    const formVersionOk = isPublic
      ? input.formVersion == null || (prior.formVersion ?? null) === input.formVersion
      : (prior.formVersion ?? null) === (input.formVersion ?? null)
    const same =
      prior.payloadHash === payloadHash &&
      prior.entryPoint === entryPoint &&
      (prior.actorUserId ?? null) === actorUserId &&
      formVersionOk &&
      (isPublic ||
        ((prior.contextContactId ?? null) === (internalContext?.contactId ?? null) &&
          (prior.conversationId ?? null) === (internalContext?.conversationId ?? null)))
    if (!same) throw conflict("SUBMISSION_CONFLICT", "Este envío ya se registró con otros datos")
    if (hasToken) {
      const [link] = await tx
        .select({ linkId: patientRegistrationLink.id })
        .from(patientRegistrationLink)
        .where(
          and(
            eq(patientRegistrationLink.tokenHash, sha256Hex(publicToken as string)),
            eq(patientRegistrationLink.organizationId, orgId),
          ),
        )
        .limit(1)
      if (!link || (prior.linkId ?? null) !== link.linkId) {
        throw conflict("SUBMISSION_CONFLICT", "Este envío ya se registró con otros datos")
      }
    }
    return requirePatient(tx, orgId, prior.patientId)
  }

  // 2. Configuración publicada (SHARE) + fecha de servidor.
  await advisoryShared(tx, `patient-registration-config:${orgId}`)
  const [configRow] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
    .for("share")
  const config = configRow ? rowToConfig(configRow) : cloneDefaultConfig()
  if (isPublic) {
    if (!configRow || !config.enabled) throw unavailable()
    if (input.formVersion !== config.version) {
      throw conflict(
        "FORM_CHANGED",
        "El formulario cambió: revisa los campos y envía de nuevo",
      )
    }
  }
  const today = await patientOrganizationToday(tx, orgId)
  // País de la clínica: con su perfil se acepta un teléfono nacional sin prefijo.
  const countryCode = await findOrgCountry(tx, orgId)

  // 3. Validación de respuestas (esquema + reglas de negocio). Todo revierte al fallar.
  const shape = registrationAnswersSchema.safeParse(input.answers)
  if (!shape.success) {
    throw validation(shape.error.issues[0]?.message ?? "Respuestas inválidas")
  }
  const answers = shape.data
  const errors = validateRegistrationAnswers(config, answers, {
    mode: isPublic ? "public" : "internal",
    today,
    countryCode,
    ...(essentials ? { scope: "essentials" as const } : {}),
  })
  if (Object.keys(errors).length) throw validation(Object.values(errors)[0]!)

  // 4. Resolver vínculos y contexto de token.
  let link: ResolvedLink | null = null
  let contextContactId: string | null = null
  let conversationId: string | null = null
  let links: RegistrationContactInput[] = []
  if (publicContext) {
    if (hasToken) {
      link = await lockTokenRow(tx, orgId, publicToken as string)
      contextContactId = link.contactId
      conversationId = link.conversationId
      const minor =
        !!answers.demographics.birthDate &&
        isRealDate(answers.demographics.birthDate) &&
        isMinor(answers.demographics.birthDate, today)
      if (answers.respondent === "patient") {
        // Quien ya tiene su ficha no se registra otra vez: se le dice en palabras
        // y el formulario le ofrece registrar a otra persona.
        if (await hasOwnRecord(tx, orgId, link.contactId)) throw conflict("ALREADY_REGISTERED", ALREADY_REGISTERED_TEXT)
        links = [{ contactId: link.contactId, relationship: "self", isPreferred: true }]
      } else {
        const relationship = minor ? "guardian" : (answers.representative?.relationship ?? "family")
        links = [
          {
            contactId: link.contactId,
            relationship,
            relationshipDetail: answers.representative?.relationshipDetail ?? null,
            isPreferred: true,
          },
        ]
      }
    }
  } else if (internalContext) {
    links = [...(input.contacts ?? [])]
    if (internalContext.contactId) {
      const found = links.find((c) => c.contactId === internalContext.contactId)
      if (!found) throw validation("El contacto contextual debe figurar en los vínculos")
      contextContactId = internalContext.contactId
    }
    if (internalContext.conversationId) {
      if (!UUID_RE.test(internalContext.conversationId)) throw validation("Conversación inválida")
      const [thread] = await tx
        .select()
        .from(conversation)
        .where(
          and(
            eq(conversation.id, internalContext.conversationId),
            eq(conversation.organizationId, orgId),
          ),
        )
        .limit(1)
        .for("share")
      if (!thread) throw notFound("Conversación")
      if (!contextContactId || thread.contactId !== contextContactId || !await directConversation(tx, orgId, thread.id, contextContactId)) throw validation("La conversación no pertenece al contacto contextual directo")
      conversationId = internalContext.conversationId
    }
  }

  // 5. Alta: createPatient es el único escritor inicial del snapshot.
  const demographics = answers.demographics
  const provenance = {
    submissionId: input.submissionId,
    payloadHash,
    entryPoint,
    respondent: answers.respondent,
    contextContactId,
    conversationId,
    linkId: link?.id ?? null,
    formVersion: input.formVersion ?? (isPublic ? config.version : null),
    answers,
    privacyNotice: config.privacyNotice || null,
  }
  let created: PatientRow
  try {
    created = await createPatient(
      tx,
      orgId,
      actorUserId,
      {
        ...demographics,
        ...(isPublic ? {} : { registeredBranchId: input.registeredBranchId ?? null }),
        ...(links.length ? { contacts: links } : {}),
      },
      provenance,
    )
  } catch (e) {
    if (
      isPublic &&
      e instanceof ServiceError &&
      (e.code === "DUPLICATE_DOCUMENT" || e.code === "ALREADY_PATIENT")
    ) {
      throw notCompleted()
    }
    throw e
  }

  let whatsapp: RegistrationWhatsApp | undefined
  // 5b. Con los datos esenciales los apellidos llegan de un solo campo y se
  // reparten sin certeza: la ficha queda «identidad por revisar» hasta que
  // recepción los confirme. Lo que la clínica exige y no se pidió queda
  // anotado en el caso de la conversación o, sin conversación (la Agenda), en
  // las notas de su persona, a nombre de quien la registró.
  if (essentials) {
    await tx
      .update(contact)
      .set({ identityNeedsReview: true })
      .where(and(eq(contact.id, created.personId), eq(contact.organizationId, orgId)))
    const who = publicContext
      ? `${answers.respondent === "representative" ? "Registró a otra persona" : "Se registró"} desde el enlace de reserva con los datos esenciales`
      : "El equipo creó su ficha con lo mínimo al reservar"
    const note = pendingRegistrationNote(who, config, answers)
    if (conversationId) await addAgentCaseNote(tx, orgId, conversationId, note)
    else {
      // Lo pendiente se anota en su persona, que el alta ya creó (`person_id`).
      const personId = created.personId
      await createContactNote(tx, orgId, personId, { body: note }, { userId: actorUserId })
      // Registrarla en «Nueva cita» con su teléfono es un alta manual del equipo: ese
      // número pasa a ser su WhatsApp (ADR 0027), con la misma operación que
      // «Escribirle» y a nombre de quien la registra, para que le lleguen el aviso y
      // los recordatorios. Si ya es de otra persona no se mueve: la cita sigue y se dice.
      if (newPerson && created.phone && (await hasActiveWhatsApp(tx, orgId))) {
        try {
          await claimWhatsAppNumber(tx, orgId, actorUserId, personId, created.phone)
          whatsapp = "creado"
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code !== "IDENTITY_IN_USE") throw error
          whatsapp = "en_uso"
        }
      }
    }
  }

  // 6. Salud declarada solo con contenido significativo; nunca firma revisión.
  if (answers.health && hasMeaningfulHealth(answers.health)) {
    await initializeDeclaredPatientHealth(tx, orgId, created.id, answers.health, actorUserId)
  }

  // 6b. Representante del menor (o de quien declara por otro): persona con su
  // documento, vínculo y responsabilidad de representante legal, en la misma
  // transacción. Si el enlace ya lo vinculó, solo se le asigna el rol.
  // Menor según lo que quedó guardado en su persona: desde fuera no se cambia
  // la fecha de quien ya existía, así que una fecha escrita no la vuelve menor.
  const minorPatient = !!created.birthDate && isRealDate(created.birthDate) && isMinor(created.birthDate, today)
  let representativePending = false
  if (answers.representative && minorPatient) {
    const linkedGuardian = links.find((l) => l.relationship === "guardian")
    const representativeId = await attachLegalRepresentative(tx, orgId, actorUserId, created.id, {
      existingContactId: linkedGuardian?.contactId ?? null,
      representative: answers.representative,
      countryCode,
      today,
    })
    representativePending = representativeId === null
  }

  // 7. Consentimiento de datos (la ley de cada país; en Perú, la Ley 29733) con la versión del aviso aceptada y
  // quién lo otorga; se atribuye en servidor (operador interno o null público).
  if (answers.privacyAccepted) {
    // Los permisos de mensajes son finalidades de este mismo consentimiento:
    // cuentan solo las que el registro de la clínica pregunta.
    const asked = [
      // Los recordatorios de su cita no se preguntan: son parte del servicio (ADR 0030).
      // `askReminders` queda sin uso; un «no» que llegue igual se guarda como baja.
      ...(answers.acceptsReminders === false ? ["recordatorios"] : []),
      ...(config.askMessages && answers.acceptsMessages !== undefined ? ["comunicaciones"] : []),
    ]
    const purposes = [
      "atencion",
      ...(asked.includes("recordatorios") && answers.acceptsReminders ? ["recordatorios"] : []),
      ...(asked.includes("comunicaciones") && answers.acceptsMessages ? ["comunicaciones"] : []),
    ]
    // Con el representante por confirmar no se escribe a nombre de nadie: el
    // consentimiento queda como lo dijo el formulario (M1).
    const grantorId = representativePending
      ? null
      : await registrationGrantor(tx, orgId, created.id, answers.respondent === "representative")
    if (grantorId && asked.length > 0) {
      await applyMessagePermissions(tx, orgId, actorUserId, grantorId, {
        accepted: purposes,
        asked,
        channel: isPublic ? "formulario_publico" : "presencial",
      })
    }
    await tx.insert(patientDataConsent).values({
      organizationId: orgId,
      patientId: created.id,
      noticeVersion: config.version,
      noticeText: config.privacyNotice || "Aviso de privacidad de la organización.",
      purposes,
      grantedByName:
        answers.respondent === "representative" && answers.representative
          ? answers.representative.displayName
          : created.displayName,
      channel: isPublic ? "formulario_publico" : "presencial",
      recordedBy: actorUserId,
    })
  }

  // 8. Consumir el enlace solo tras el alta exitosa, en la misma transacción.
  if (link) {
    await tx
      .update(patientRegistrationLink)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(patientRegistrationLink.id, link.id),
          eq(patientRegistrationLink.organizationId, orgId),
        ),
      )
  }

  // Releer para no responder con una revisión anterior a salud/consentimiento.
  const saved = await requirePatient(tx, orgId, created.id)
  return whatsapp ? { ...saved, whatsapp } : saved
}

/**
 * El representante legal de un menor, en la misma transacción que sus datos:
 * su persona con documento (con su país emisor), el vínculo `guardian` y la
 * responsabilidad de representante legal desde hoy. Si ya está vinculado,
 * solo se le asigna el rol. Lo usa el registro de pacientes.
 *
 * Quien ya tiene ese documento en la clínica es la misma persona (la madre
 * que registra a su segundo hijo) y se la reutiliza tal como está, sin tocar
 * sus datos. Pero desde fuera (sin una persona del equipo) un documento
 * escrito no prueba quién es: no se la vincula ni se le da el rol, y queda
 * para que recepción lo confirme con un clic (`confirmPendingRepresentative`).
 * Devuelve el representante, o null si quedó por confirmar.
 */
export async function attachLegalRepresentative(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  input: {
    existingContactId?: string | null
    representative: Pick<
      NonNullable<RegistrationAnswers["representative"]>,
      "displayName" | "phone" | "email" | "docType" | "docNumber" | "docCountry" | "relationshipDetail"
    >
    countryCode: string | null
    today: string
  },
): Promise<string | null> {
  let representativeId = input.existingContactId ?? null
  if (!representativeId) {
    const rep = input.representative
    const docCountry = rep.docNumber
      ? documentIssuerCountry(clinicalProfileFor(input.countryCode), rep.docType, rep.docCountry)
      : null
    const existing = await findPersonByDocument(tx, orgId, { docType: rep.docType ?? null, docNumber: rep.docNumber || null, docCountry })
    if (existing && actorUserId === null) {
      await leavePendingRepresentative(tx, orgId, patientId, existing, rep.relationshipDetail || null)
      return null
    }
    representativeId =
      existing ??
      (
        await createPerson(
          tx,
          orgId,
          { userId: actorUserId },
          {
            displayName: rep.displayName,
            phone: rep.phone ? normalizePhone(rep.phone, input.countryCode) : null,
            email: rep.email || null,
            docType: rep.docType ?? null,
            docNumber: rep.docNumber || null,
            docCountry,
          },
        )
      ).id
  }
  const relationshipDetail = input.existingContactId ? null : input.representative.relationshipDetail || null
  await linkLegalRepresentative(tx, orgId, actorUserId, patientId, representativeId, {
    relationshipDetail,
    kinship: kinshipFromWords(relationshipDetail),
    linked: !!input.existingContactId,
    today: input.today,
  })
  return representativeId
}

/**
 * El vínculo `guardian` (si aún no lo tiene) con el parentesco escrito y su
 * código HL7, y el rol de representante legal desde hoy.
 */
async function linkLegalRepresentative(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  representativeId: string,
  options: { relationshipDetail: string | null; kinship: string | null; linked: boolean; today: string },
): Promise<void> {
  if (!options.linked) {
    await tx
      .insert(patientContact)
      .values({
        organizationId: orgId,
        patientId,
        contactId: representativeId,
        relationship: "guardian",
        relationshipDetail: options.relationshipDetail,
        kinship: options.kinship,
        isPreferred: false,
        createdBy: actorUserId,
      })
      // Ya vinculada (como familiar, por ejemplo): conserva su vínculo y recibe el rol.
      .onConflictDoNothing({
        target: [patientContact.organizationId, patientContact.patientId, patientContact.contactId],
      })
  }
  await grantResponsibility(tx, orgId, actorUserId, patientId, {
    contactId: representativeId,
    kind: "representante_legal",
    startsAt: options.today,
  })
}

/**
 * Claves estables de las tareas que deja un registro desde fuera: repetir el
 * envío no duplica la fila. Su clase (`registro_con_documento`,
 * `confirmar_representante`) dice qué es y qué ofrece la fila.
 */
const REGISTRATION_HOLD_KEY = "registro-con-documento:"
const PENDING_REPRESENTATIVE_KEY = "confirmar-representante:"

async function leavePendingRepresentative(
  tx: Db,
  orgId: string,
  patientId: string,
  representativeId: string,
  relationshipDetail: string | null,
): Promise<void> {
  const [names] = await tx.execute<{ patientName: string; representativeName: string }>(sql`
    select pp.display_name as "patientName", r.display_name as "representativeName"
    from patient p
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    join contact r on r.organization_id = p.organization_id and r.id = ${representativeId}
    where p.organization_id = ${orgId} and p.id = ${patientId}`)
  const who = relationshipDetail ? ` (${relationshipDetail})` : ""
  await createTask(tx, orgId, {
    title: `Confirma si ${names?.representativeName ?? "esta persona"} representa a ${names?.patientName ?? "este paciente"}`,
    patientId,
    contactId: representativeId,
    area: "recepcion",
    createdBy: "sistema",
    kind: "confirmar_representante",
    relationshipDetail,
    kinship: kinshipFromWords(relationshipDetail),
    reason: `En el registro en línea escribieron el documento de ${names?.representativeName ?? "una persona de la clínica"} como representante legal${who}. Si es su madre, padre o tutor, confírmalo; si no, elige «No es ella».`,
    idempotencyKey: `${PENDING_REPRESENTATIVE_KEY}${patientId}:${representativeId}`,
  })
}

/**
 * «Confirmar» en la fila de «Te espera»: recepción confirma que la persona
 * que nombró el registro en línea es el representante legal del menor. Crea
 * el vínculo con el parentesco que se escribió («Madre», con su código HL7) y
 * el rol a nombre de quien confirma, y cierra la tarea. No toca sus datos ni
 * sus permisos de mensajes.
 */
export async function confirmPendingRepresentative(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  taskId: string,
): Promise<{ representativeId: string }> {
  const [task] = await tx
    .select({
      id: crmTask.id,
      contactId: crmTask.contactId,
      status: crmTask.status,
      relationshipDetail: crmTask.relationshipDetail,
      kinship: crmTask.kinship,
    })
    .from(crmTask)
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.id, taskId),
        eq(crmTask.patientId, patientId),
        eq(crmTask.kind, "confirmar_representante"),
      ),
    )
    .for("update")
  if (!task || !task.contactId) throw notFound("Representante por confirmar")
  if (task.status !== "open") throw conflict("ALREADY_REVIEWED", "Esto ya se revisó")
  await linkLegalRepresentative(tx, orgId, actorUserId, patientId, task.contactId, {
    relationshipDetail: task.relationshipDetail,
    kinship: task.kinship,
    linked: false,
    today: await patientOrganizationToday(tx, orgId),
  })
  await completeTask(tx, orgId, task.id, { userId: actorUserId })
  return { representativeId: task.contactId }
}

/**
 * Lo que deja para recepción un alta desde fuera con el documento de una
 * persona que ya está en la clínica (`RegistrationHeld`): una fila de «Te
 * espera» («Alguien se registró con el documento de…»), con lo que escribió
 * para comparar. Se llama en otra transacción, porque la del alta se revierte.
 * Una por persona y día: repetir el envío no llena la lista.
 */
export async function leaveRegistrationHold(tx: Db, orgId: string, hold: RegistrationHold): Promise<void> {
  const today = await patientOrganizationToday(tx, orgId)
  const wrote = [hold.declared.displayName, hold.declared.phone, hold.declared.email].filter(Boolean).join(", ")
  await createTask(tx, orgId, {
    title: `Alguien se registró con el documento de ${hold.ownerName}`,
    contactId: hold.ownerId,
    patientId: hold.ownerPatientId,
    area: "recepcion",
    createdBy: "sistema",
    kind: "registro_con_documento",
    reason: `Alguien se registró con el documento de ${hold.ownerName}: revisa si es ella. No se guardó nada en su ficha. Escribió: ${wrote}.`,
    idempotencyKey: `${REGISTRATION_HOLD_KEY}${hold.ownerId}:${today}`,
  })
}

/** Motivo con que queda cerrada cada fila del registro en línea al descartarla. */
const DISCARD_REASON = {
  confirmar_representante: "No es su representante: no se vinculó",
  registro_con_documento: "Se revisó y se descartó: no se cambió nada de esa persona",
} as const

/**
 * Descarta en «Te espera» lo que dejó un registro en línea: «No es ella» en
 * «¿… es representante de …?» (no se vincula a nadie) o «Descartar» en
 * «Alguien se registró con el documento de…». La tarea queda cerrada con su
 * motivo, a nombre de quien la descarta; no cambia nada de las personas.
 */
export async function discardRegistrationTask(
  tx: Db,
  orgId: string,
  actorUserId: string,
  taskId: string,
): Promise<{ id: string }> {
  const [task] = await tx
    .select({ id: crmTask.id, kind: crmTask.kind, status: crmTask.status })
    .from(crmTask)
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.id, taskId),
        sql`${crmTask.kind} in ('confirmar_representante', 'registro_con_documento')`,
      ),
    )
    .for("update")
  if (!task) throw notFound("Pendiente del registro en línea")
  if (task.status !== "open") throw conflict("ALREADY_REVIEWED", "Esto ya se revisó")
  await discardTask(tx, orgId, task.id, {
    userId: actorUserId,
    reason: DISCARD_REASON[task.kind as keyof typeof DISCARD_REASON],
  })
  return { id: task.id }
}

/** La clínica tiene un WhatsApp conectado por el que escribir. */
async function hasActiveWhatsApp(tx: Db, orgId: string): Promise<boolean> {
  const [connected] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .limit(1)
  return !!connected
}
