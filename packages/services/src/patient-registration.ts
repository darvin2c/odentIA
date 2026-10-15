import {
  DEFAULT_REGISTRATION_CONFIG,
  isMinor,
  isRealDate,
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
  patient,
  patientContact,
  patientDataConsent,
  patientRegistration,
  patientRegistrationLink,
} from "@odentia/db/schema/clinical"
import { contact, conversation, contactIdentity, channelConnection } from "@odentia/db/schema/crm"
import { auditEvent, patientRegistrationConfig } from "@odentia/db/schema/org"
import { createHash, randomBytes } from "node:crypto"
import { and, eq, sql, type SQL } from "drizzle-orm"
import { addAgentCaseNote, CASE_NOTE_CHARS } from "./agent-case.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry } from "./locale.js"
import { createPatient, patientOrganizationToday, requirePatient, type PatientRow } from "./patients.js"
import { initializeDeclaredPatientHealth } from "./clinical.js"
import { applyMessagePermissions } from "./data-consents.js"
import { grantResponsibility } from "./responsibilities.js"
import { isDirectThread, lockRegistrationContacts } from "./contacts.js"

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
  return conflict(
    "REGISTRATION_NOT_COMPLETED",
    "No pudimos completar el registro. Comunícate con recepción.",
  )
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

export type PublicRegistrationContext = { kind: "generic" } | { kind: "conversation" }

export async function getPublicPatientRegistration(
  tx: Db,
  orgId: string,
  token?: string,
): Promise<{ config: RegistrationConfig; today: string; context: PublicRegistrationContext }> {
  await advisoryShared(tx, `patient-registration-config:${orgId}`)
  const [config] = await tx
    .select()
    .from(patientRegistrationConfig)
    .where(eq(patientRegistrationConfig.organizationId, orgId))
    .limit(1)
    .for("share")
  if (!config || !config.enabled) throw unavailable()
  const today = await patientOrganizationToday(tx, orgId)
  // Token vacío o inválido nunca cae al formulario genérico.
  if (token === undefined) return { config: rowToConfig(config), today, context: { kind: "generic" } }
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
  return { config: rowToConfig(config), today, context: { kind: "conversation" } }
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
       * unida a ella como propia). La misma regla que el enlace de reserva: lo
       * que la clínica exige y no se pidió queda anotado en el caso y la
       * identidad, por revisar. Ningún otro alta interna lo usa.
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
 * Nota del caso tras un registro con lo esencial: qué pide la clínica y aún
 * falta. Es corta: si la lista no cabe, dice cuántos más faltan en vez de cortarse.
 */
async function notePendingRegistration(
  tx: Db,
  orgId: string,
  conversationId: string,
  who: string,
  config: RegistrationConfig,
  answers: RegistrationAnswers,
): Promise<void> {
  const pending = pendingRegistrationFields(config, answers).map((field) => field.label.toLowerCase())
  const head = `${who}. Falta en la clínica: confirmar apellidos y nombres`
  const named: string[] = []
  for (const label of pending) {
    const rest = pending.length - named.length - 1
    const tail = rest > 0 ? ` y ${rest} más` : ""
    if (`${head}, ${[...named, label].join(", ")}${tail}.`.length > CASE_NOTE_CHARS) break
    named.push(label)
  }
  const left = pending.length - named.length
  await addAgentCaseNote(
    tx,
    orgId,
    conversationId,
    `${head}${named.length ? `, ${named.join(", ")}` : ""}${left > 0 ? ` y ${left} más` : ""}.`,
  )
}

export async function registerPatient(
  tx: Db,
  orgId: string,
  context: RegistrationContext,
  input: RegistrationInput,
): Promise<PatientRow> {
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
  // El equipo registra con lo mínimo solo a la persona de una conversación, como su propia ficha.
  if (
    essentials &&
    internalContext &&
    (!internalContext.contactId ||
      !internalContext.conversationId ||
      !input.contacts?.some((link) => link.contactId === internalContext.contactId && link.relationship === "self"))
  ) {
    throw validation("Lo mínimo solo se acepta al reservar a la persona de una conversación")
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
        const [existing] = await tx
          .select({ id: patientContact.id })
          .from(patientContact)
          .where(
            and(
              eq(patientContact.organizationId, orgId),
              eq(patientContact.contactId, link.contactId),
              eq(patientContact.relationship, "self"),
            ),
          )
          .limit(1)
          .for("share")
        if (existing) throw notCompleted()
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

  // 5b. Con los datos esenciales los apellidos llegan de un solo campo y se
  // reparten sin certeza: la ficha queda «identidad por revisar» hasta que
  // recepción los confirme. Lo que la clínica exige y no se pidió queda
  // anotado en el caso de la conversación.
  if (essentials) {
    await tx
      .update(patient)
      .set({ identityNeedsReview: true })
      .where(and(eq(patient.id, created.id), eq(patient.organizationId, orgId)))
    if (conversationId) {
      const who = publicContext
        ? `${answers.respondent === "representative" ? "Registró a otra persona" : "Se registró"} desde el enlace de reserva con los datos esenciales`
        : "El equipo creó su ficha con lo mínimo al reservar"
      await notePendingRegistration(tx, orgId, conversationId, who, config, answers)
    }
  }

  // 6. Salud declarada solo con contenido significativo; nunca firma revisión.
  if (answers.health && hasMeaningfulHealth(answers.health)) {
    await initializeDeclaredPatientHealth(tx, orgId, created.id, answers.health, actorUserId)
  }

  // 6b. Representante del menor (o de quien declara por otro): persona con su
  // documento, vínculo y responsabilidad de representante legal, en la misma
  // transacción. Si el enlace ya lo vinculó, solo se le asigna el rol.
  const minorPatient =
    !!demographics.birthDate && isRealDate(demographics.birthDate) && isMinor(demographics.birthDate, today)
  if (answers.representative && minorPatient) {
    const linkedGuardian = links.find((l) => l.relationship === "guardian")
    let representativeId = linkedGuardian?.contactId ?? null
    if (!representativeId) {
      const rep = answers.representative
      const [person] = await tx
        .insert(contact)
        .values({
          organizationId: orgId,
          displayName: rep.displayName,
          phone: rep.phone ? normalizePhone(rep.phone, countryCode) : null,
          email: rep.email || null,
          docType: rep.docType ?? null,
          docNumber: rep.docNumber || null,
          docCountry: rep.docCountry?.toUpperCase() || null,
        })
        .returning({ id: contact.id })
      if (!person) throw new Error("No se pudo crear al representante")
      representativeId = person.id
      await tx.insert(patientContact).values({
        organizationId: orgId,
        patientId: created.id,
        contactId: person.id,
        relationship: "guardian",
        relationshipDetail: rep.relationshipDetail || null,
        isPreferred: false,
        createdBy: actorUserId,
      })
    }
    await grantResponsibility(tx, orgId, actorUserId, created.id, {
      contactId: representativeId,
      kind: "representante_legal",
      startsAt: today,
    })
  }

  // 7. Consentimiento de datos (Ley 29733) con la versión del aviso aceptada y
  // quién lo otorga; se atribuye en servidor (operador interno o null público).
  if (answers.privacyAccepted) {
    // Los permisos de mensajes son finalidades de este mismo consentimiento:
    // cuentan solo las que el registro de la clínica pregunta.
    const asked = [
      ...(config.askReminders && answers.acceptsReminders !== undefined ? ["recordatorios"] : []),
      ...(config.askMessages && answers.acceptsMessages !== undefined ? ["comunicaciones"] : []),
    ]
    const purposes = [
      "atencion",
      ...(asked.includes("recordatorios") && answers.acceptsReminders ? ["recordatorios"] : []),
      ...(asked.includes("comunicaciones") && answers.acceptsMessages ? ["comunicaciones"] : []),
    ]
    const grantorId = await registrationGrantor(tx, orgId, created.id, answers.respondent === "representative")
    if (grantorId && asked.length > 0) {
      await applyMessagePermissions(tx, orgId, actorUserId, grantorId, {
        accepted: purposes,
        asked,
        channel: isPublic ? "formulario_publico" : "presencial",
      })
    }
    await tx
      .update(patient)
      .set({ dataConsentAt: new Date(), dataConsentBy: actorUserId, updatedAt: new Date() })
      .where(and(eq(patient.id, created.id), eq(patient.organizationId, orgId)))
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
  return requirePatient(tx, orgId, created.id)
}
