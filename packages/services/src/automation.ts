import { createHash, randomBytes } from "node:crypto"
import type { NormalizedTemplateStatus } from "@odentia/channels"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member } from "@odentia/db/schema/auth"
import type {
  AutomationCause,
  AutomationJobStatus,
  AutomationKind,
  ConsentPurpose,
} from "@odentia/db/schema/automation"
import {
  AUTOMATION_KINDS,
  automationConsent,
  automationJob,
  automationLinkToken,
  automationRule,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  type ConsentSource,
} from "@odentia/db/schema/automation"
import { clinicalFollowUp, patient, patientContact, treatmentBudget } from "@odentia/db/schema/clinical"
import {
  agentConfig,
  channelConnection,
  contact,
  conversation,
  crmTask,
  message,
} from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm"
import { adminLineOf, DEFAULT_HOURS_BEFORE, type LineTiming } from "./admin-lines.js"
import { setAppointmentStatus } from "./appointments.js"
import { automationMessageOf, parseReplyId } from "./automation-messages.js"
import { type ComposedMessage, composeJobMessage, routeMessage } from "./automation-routing.js"
import { applyTemplateStatuses, type TemplateDeps } from "./channel-templates.js"
import {
  currentAutomationMessageOf,
  MESSAGES_HREF,
  messageOfTemplate,
  requestMissingTemplates,
  settleMessageTexts,
  templateReasonWords,
} from "./clinic-messages.js"
import { sendOutbound, sendTemplateOutbound } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgLocale, NEUTRAL_TIMEZONE } from "./locale.js"
import { updateOpportunity } from "./opportunities.js"
import { createTask } from "./tasks.js"
import { upsertWorkspaceNotification } from "./workspace.js"

/**
 * Automatizaciones: reglas, trabajos durables en DB, consentimientos y
 * enlaces públicos seguros. Todo envío automático exige opt-in explícito
 * vigente (finalidad + canal); sin él el trabajo se marca `omitido`.
 *
 * Convención: funciones reciben `tx: Db` ya dentro de `withOrgContext`.
 * El worker (`tickAutomations`) programa (sync) y entrega (deliver) en
 * transacciones separadas: estado + encolado son atómicos en cada paso.
 */

// ---------------------------------------------------------------- líneas ---

/** Estado de una línea del Administrador en una organización. */
export type RuleRow = typeof automationRule.$inferSelect

/** Lo que se puede ajustar de una línea. */
export interface LineConfig {
  /** Cuántas horas antes se recuerda una cita. */
  hoursBefore?: number[]
  /** El plazo, en las líneas que lo tienen. */
  days?: number
  /** Horas de espera, en las líneas que esperan horas. */
  delayHours?: number
  /** Hora del día a la que sale (0–23), con la hora de la sede. */
  hour?: number
  /** Indicación de la clínica para quien reciba la tarea. La lee una persona; el agente nunca la dice. */
  taskNote?: string
}

export const TASK_NOTE_CHARS = 160

/** Los tiempos vigentes de una línea, para decirlos con las palabras del catálogo. */
export function lineTiming(rule: Pick<RuleRow, "config"> | null, extra: LineTiming = {}): LineTiming {
  const { hoursBefore, delayHours, hour } = lineConfigOf(rule?.config)
  return {
    ...(hoursBefore ? { hoursBefore } : {}),
    ...(delayHours !== undefined ? { delayHours } : {}),
    ...(hour !== undefined ? { hour } : {}),
    ...extra,
  }
}

function assertKind(kind: string): AutomationKind {
  if (!(AUTOMATION_KINDS as readonly string[]).includes(kind)) throw notFound("Línea del administrador")
  return kind as AutomationKind
}

function assertPurpose(purpose: string): ConsentPurpose {
  if (!(CONSENT_PURPOSES as readonly string[]).includes(purpose))
    throw validation("Finalidad inválida")
  return purpose as ConsentPurpose
}

/** Permiso que la persona tiene que haber dado para recibir el mensaje de una línea. */
export function purposeOfKind(kind: string): ConsentPurpose {
  return adminLineOf(kind)?.agent?.purpose ?? "seguimiento"
}

/** Lee la config JSONB de una línea campo por campo (sin casts ciegos). */
export function lineConfigOf(value: unknown): LineConfig {
  const config: LineConfig = {}
  if (typeof value !== "object" || value === null) return config
  if ("hoursBefore" in value && Array.isArray(value.hoursBefore)) {
    const hours = value.hoursBefore.filter((h): h is number => typeof h === "number")
    if (hours.length > 0) config.hoursBefore = hours
  }
  if ("days" in value && typeof value.days === "number") config.days = value.days
  if ("delayHours" in value && typeof value.delayHours === "number") config.delayHours = value.delayHours
  if ("hour" in value && typeof value.hour === "number") config.hour = value.hour
  if ("taskNote" in value && typeof value.taskNote === "string" && value.taskNote.trim()) config.taskNote = value.taskNote.trim()
  return config
}

export interface JobPayload {
  /** Zona de la sede del caso: con ella se mide el horario de silencio. */
  timeZone?: string
  controlId?: string
  /** Persona que lleva el caso (el profesional de una atención): a ella va la tarea. */
  ownerUserId?: string
  /** Lo que dice el caso en la lista: «Debe … · desde el 18 de agosto». */
  detail?: string
  /** Lo pidió una persona con «Solo esta vez»: sale aunque la línea esté apagada. */
  once?: boolean
  /**
   * La próxima acción vencida que originó el caso (ISO). Si se atiende o se
   * reprograma antes de escribir, el caso ya no aplica.
   */
  dueAt?: string
}

/** Lee el payload JSONB de un caso campo por campo (sin casts ciegos). */
export function jobPayloadOf(value: unknown): JobPayload {
  const payload: JobPayload = {}
  if (typeof value !== "object" || value === null) return payload
  if ("timeZone" in value && typeof value.timeZone === "string") payload.timeZone = value.timeZone
  if ("controlId" in value && typeof value.controlId === "string") payload.controlId = value.controlId
  if ("ownerUserId" in value && typeof value.ownerUserId === "string") payload.ownerUserId = value.ownerUserId
  if ("detail" in value && typeof value.detail === "string") payload.detail = value.detail
  if ("once" in value && value.once === true) payload.once = true
  if ("dueAt" in value && typeof value.dueAt === "string" && Number.isFinite(Date.parse(value.dueAt))) payload.dueAt = value.dueAt
  return payload
}

/** Las líneas que tienen fila; las que no la tienen están apagadas, con todo por defecto. */
export async function listLineRules(tx: Db, orgId: string): Promise<RuleRow[]> {
  return tx
    .select()
    .from(automationRule)
    .where(eq(automationRule.organizationId, orgId))
    .orderBy(asc(automationRule.kind))
}

export async function findLineRule(tx: Db, orgId: string, kind: string): Promise<RuleRow | null> {
  const [row] = await tx
    .select()
    .from(automationRule)
    .where(and(eq(automationRule.organizationId, orgId), eq(automationRule.kind, kind)))
    .limit(1)
  return row ?? null
}

/** Plazo vigente de una línea: el que ajustó la clínica o el del catálogo. */
export function lineDays(rule: Pick<RuleRow, "config"> | null, kind: string): number | null {
  const line = adminLineOf(kind)
  if (!line || line.defaultDays === null) return null
  return lineConfigOf(rule?.config).days ?? line.defaultDays
}

export interface SetLineInput {
  enabled?: boolean
  /** «El agente le escribe». */
  agentPart?: boolean
  /** «Tarea para el equipo». */
  teamPart?: boolean
  /** null vuelve al plazo del catálogo. */
  days?: number | null
  hoursBefore?: number[]
  /** null vuelve a la espera del catálogo. */
  delayHours?: number | null
  /** null quita la hora fija. */
  hour?: number | null
  /** null o vacío quita la indicación. */
  taskNote?: string | null
  noRecommend?: boolean
}

/**
 * Prende, apaga o ajusta una línea. Es la única operación que cambia lo que el
 * Administrador hace por su cuenta, y siempre la pide una persona.
 *
 * - Prender fija desde cuándo actúa: lo ocurrido antes no cuenta.
 * - Apagar descarta lo que estaba por salir.
 * - Apagar las dos partes es apagar la línea.
 * - El aviso de «no pude» no es una parte: no se puede apagar.
 */
export async function setLine(
  tx: Db,
  orgId: string,
  actorUserId: string,
  key: string,
  input: SetLineInput,
): Promise<RuleRow> {
  const kind = assertKind(key)
  const line = adminLineOf(kind)
  if (!line) throw notFound("Línea del administrador")
  // Serializa cambios simultáneos sobre la misma línea aunque aún no tenga fila.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`admin-line:${orgId}:${kind}`}))`)
  const existing = await findLineRule(tx, orgId, kind)
  const was = {
    enabled: existing?.enabled ?? false,
    agentPart: line.agent ? (existing?.agentPart ?? true) : false,
    teamPart: existing?.teamPart ?? true,
    noRecommend: existing?.noRecommend ?? false,
    config: lineConfigOf(existing?.config),
  }
  const agentPart = line.agent ? (input.agentPart ?? was.agentPart) : false
  const teamPart = input.teamPart ?? was.teamPart
  let enabled = input.enabled ?? was.enabled
  if (!agentPart && !teamPart) {
    if (input.enabled === true) {
      throw validation("Elige al menos una parte: que el agente escriba o que quede una tarea para el equipo")
    }
    enabled = false
  }
  const config: LineConfig = { ...was.config }
  if (input.days !== undefined) {
    if (line.defaultDays === null) throw validation(`«${line.name}» no tiene un plazo en días`)
    if (input.days === null) delete config.days
    else {
      if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) throw validation("El plazo va de 1 a 365 días")
      config.days = input.days
    }
  }
  if (input.hoursBefore !== undefined) {
    if (kind !== "recordatorio_cita") throw validation(`«${line.name}» no se ajusta por horas`)
    const hours = [...new Set(input.hoursBefore)].sort((a, b) => b - a)
    if (hours.length < 1 || hours.length > 3 || hours.some((h) => !Number.isInteger(h) || h < 1 || h > 168)) {
      throw validation("El recordatorio admite de uno a tres avisos, entre 1 y 168 horas antes")
    }
    config.hoursBefore = hours
  }
  if (input.delayHours !== undefined) {
    if (line.delayHours === undefined) throw validation(`«${line.name}» no espera horas`)
    if (input.delayHours === null) delete config.delayHours
    else {
      if (!Number.isInteger(input.delayHours) || input.delayHours < 1 || input.delayHours > 72) throw validation("La espera va de 1 a 72 horas")
      config.delayHours = input.delayHours
    }
  }
  if (input.hour !== undefined) {
    if (!line.hourAdjustable) throw validation(`«${line.name}» no tiene una hora de salida que se pueda fijar`)
    if (input.hour === null) delete config.hour
    else {
      if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23) throw validation("La hora va de 0 a 23")
      config.hour = input.hour
    }
  }
  if (input.taskNote !== undefined) {
    const note = input.taskNote?.replace(/\s+/g, " ").trim() ?? ""
    if (note.length > TASK_NOTE_CHARS) throw validation(`La indicación para la tarea admite hasta ${TASK_NOTE_CHARS} caracteres`)
    if (note) config.taskNote = note
    else delete config.taskNote
  }
  const now = new Date()
  const turnedOn = enabled && !was.enabled
  const values = {
    name: line.name,
    enabled,
    agentPart,
    teamPart,
    noRecommend: input.noRecommend ?? was.noRecommend,
    config,
    updatedAt: now,
    ...(turnedOn ? { enabledAt: now, enabledBy: actorUserId } : {}),
  }
  const [row] = await tx
    .insert(automationRule)
    .values({ organizationId: orgId, kind, createdBy: actorUserId, ...values })
    .onConflictDoUpdate({ target: [automationRule.organizationId, automationRule.kind], set: values })
    .returning()
  if (!row) throw new Error("No se pudo guardar la línea")
  if (was.enabled && !enabled) {
    // Apagar descarta lo que estaba por salir: al volver a prender no se envía
    // lo que quedó atrás. Lo que una persona pidió «solo esta vez» sí sale.
    await tx
      .update(automationJob)
      .set({ status: "cancelado", lastError: "Línea apagada", updatedAt: now })
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.ruleId, row.id),
          eq(automationJob.status, "pendiente"),
          sql`coalesce(${automationJob.payload}->>'once', 'false') <> 'true'`,
        ),
      )
  }
  const changes: Record<string, unknown> = {}
  if (enabled !== was.enabled) changes.enabled = enabled
  if (agentPart !== was.agentPart) changes.agentPart = agentPart
  if (teamPart !== was.teamPart) changes.teamPart = teamPart
  if (config.days !== was.config.days) changes.days = config.days ?? line.defaultDays
  if (input.hoursBefore !== undefined) changes.hoursBefore = config.hoursBefore
  if (config.delayHours !== was.config.delayHours) changes.delayHours = config.delayHours ?? line.delayHours
  if (config.hour !== was.config.hour) changes.hour = config.hour ?? null
  // La auditoría dice que la indicación cambió; no copia su texto.
  if (config.taskNote !== was.config.taskNote) changes.taskNote = !!config.taskNote
  if (input.noRecommend !== undefined && input.noRecommend !== was.noRecommend) changes.noRecommend = input.noRecommend
  if (Object.keys(changes).length > 0) {
    await audit(tx, orgId, actorUserId, "admin_line.updated", row.id, { key: kind, changes })
  }
  return row
}

/**
 * Desde cuándo actúa una línea: el momento en que se prendió por última vez.
 */
export function activeSince(rule: Pick<RuleRow, "enabledAt" | "createdAt">): Date {
  return rule.enabledAt ?? rule.createdAt
}

/**
 * Lo que el Administrador necesita saber antes de hacer algo por su cuenta:
 * si él y Recepción están encendidos y su horario de silencio.
 */
export interface AdminRuntime {
  adminOn: boolean
  receptionOn: boolean
  quietStart: string
  quietEnd: string
}

export const DEFAULT_QUIET_START = "21:00"
export const DEFAULT_QUIET_END = "08:00"

export async function adminRuntime(tx: Db, orgId: string): Promise<AdminRuntime> {
  const [row] = await tx
    .select({ enabled: agentConfig.enabled, advisor: agentConfig.advisor })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  return {
    adminOn: row?.advisor?.enabled === true,
    receptionOn: row?.enabled === true,
    quietStart: row?.advisor?.quietStart ?? DEFAULT_QUIET_START,
    quietEnd: row?.advisor?.quietEnd ?? DEFAULT_QUIET_END,
  }
}

// ----------------------------------------------------- permiso de mensajes ---

export type ConsentRow = typeof automationConsent.$inferSelect

/** Los dos permisos que una persona da para que la clínica le escriba primero. */
export const MESSAGE_PERMISSIONS = ["recordatorio", "seguimiento"] as const
export type MessagePermissionKey = (typeof MESSAGE_PERMISSIONS)[number]

export interface MessagePermission {
  purpose: MessagePermissionKey
  /** null: nunca se le preguntó. */
  granted: boolean | null
  /** Cómo quedó registrado (clave de `CONSENT_SOURCES`). */
  source: string | null
  at: string | null
}

function assertSource(source: string): ConsentSource {
  if (!(CONSENT_SOURCES as readonly string[]).includes(source)) throw validation("Origen del permiso inválido")
  return source as ConsentSource
}

export async function listConsents(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<ConsentRow[]> {
  return tx
    .select()
    .from(automationConsent)
    .where(
      and(eq(automationConsent.organizationId, orgId), eq(automationConsent.contactId, contactId)),
    )
    .orderBy(asc(automationConsent.purpose))
}

/**
 * Lo que la persona aceptó recibir sin haber escrito primero, para su ficha:
 * siempre las dos filas, con cómo y cuándo quedó cada una.
 */
export async function getMessagePermissions(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<MessagePermission[]> {
  const [person] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!person) throw notFound("Contacto")
  const rows = await listConsents(tx, orgId, contactId)
  return MESSAGE_PERMISSIONS.map((purpose) => {
    const row = rows.find((item) => item.purpose === purpose)
    return {
      purpose,
      granted: row ? row.status === "granted" : null,
      source: row?.source ?? null,
      at: row?.updatedAt.toISOString() ?? null,
    }
  })
}

/**
 * Registra que la persona aceptó o dejó de aceptar un tipo de mensaje
 * (idempotente). El permiso es de la persona, no de un canal. Al retirarlo se
 * cancela lo que estaba por salir de ese tipo, y solo de ese tipo.
 */
export async function setConsent(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { purpose: string; granted: boolean; source?: string },
): Promise<ConsentRow> {
  const purpose = assertPurpose(input.purpose)
  const source = assertSource(input.source?.trim() || (actorUserId ? "presencial" : "baja"))
  const [contactRow] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow) throw notFound("Contacto")
  const status = input.granted ? "granted" : "revoked"
  const [row] = await tx
    .insert(automationConsent)
    .values({ organizationId: orgId, contactId, purpose, status, source, createdBy: actorUserId })
    .onConflictDoUpdate({
      target: [automationConsent.organizationId, automationConsent.contactId, automationConsent.purpose],
      set: { status, source, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el permiso")
  await audit(tx, orgId, actorUserId, "automation_consent.set", row.id, {
    contactId,
    purpose,
    status,
    source,
  })
  if (!input.granted) {
    await tx
      .update(automationJob)
      .set({ status: "cancelado", lastError: "La persona retiró el permiso", updatedAt: new Date() })
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.contactId, contactId),
          eq(automationJob.status, "pendiente"),
          // Solo los mensajes de ese tipo; lo que deja trabajo al equipo no depende del permiso.
          inArray(
            automationJob.kind,
            AUTOMATION_KINDS.filter((kind) => adminLineOf(kind)?.agent?.purpose === purpose),
          ),
        ),
      )
  }
  return row
}

/** true solo si la persona aceptó ese tipo de mensaje y no lo retiró después. */
export async function hasConsent(
  tx: Db,
  orgId: string,
  contactId: string,
  purpose: ConsentPurpose,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: automationConsent.status })
    .from(automationConsent)
    .where(
      and(
        eq(automationConsent.organizationId, orgId),
        eq(automationConsent.contactId, contactId),
        eq(automationConsent.purpose, purpose),
      ),
    )
    .limit(1)
  return row?.status === "granted"
}

// ------------------------------------------------------------------ trabajos ---

export type JobRow = typeof automationJob.$inferSelect

/**
 * Qué pasó con el mensaje después de dejarlo en la cola. «enviado» en el
 * trabajo solo significa que salió hacia el canal: `enviando` mientras el
 * proveedor no lo acepta, `aceptado` cuando lo aceptó, `entregado` o `leido`
 * cuando el proveedor lo confirma, y `no_entregado` si lo rechazó.
 */
export type JobDelivery = "enviando" | "aceptado" | "entregado" | "leido" | "no_entregado"

export function deliveryOf(messageStatus: string | null | undefined): JobDelivery | null {
  if (!messageStatus) return null
  if (messageStatus === "queued" || messageStatus === "unknown") return "enviando"
  if (messageStatus === "sent") return "aceptado"
  if (messageStatus === "delivered") return "entregado"
  if (messageStatus === "read") return "leido"
  if (messageStatus === "failed") return "no_entregado"
  return null
}

/**
 * Destinatario del aviso de fallo: creador de la regla si sigue en la
 * organización; si no, el primer owner/admin. Null si nadie califica.
 */
export async function failureRecipient(
  tx: Db,
  orgId: string,
  createdBy: string | null,
): Promise<string | null> {
  if (createdBy) {
    const [creator] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, createdBy)))
      .limit(1)
    if (creator) return creator.userId
  }
  const [admin] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(1)
  return admin?.userId ?? null
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "automation",
    entityId,
    metadata: metadata ?? {},
  })
}

async function notify(tx: Db, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

// ------------------------------------------------- programación (dedupe) ---

export interface EnqueueInput {
  ruleId?: string | null
  kind: string
  dedupeKey: string
  scheduledFor: Date
  contactId?: string | null
  appointmentId?: string | null
  patientId?: string | null
  budgetId?: string | null
  opportunityId?: string | null
  payload?: JobPayload
}

/**
 * Anota un caso de una línea; el unique (org, dedupe_key) evita duplicados
 * aunque el tick o el evento se repitan. Devuelve null si ya existía.
 */
export async function enqueueJob(
  tx: Db,
  orgId: string,
  input: EnqueueInput,
): Promise<JobRow | null> {
  assertKind(input.kind)
  const [row] = await tx
    .insert(automationJob)
    .values({
      organizationId: orgId,
      ruleId: input.ruleId ?? null,
      kind: input.kind,
      status: "pendiente",
      dedupeKey: input.dedupeKey,
      scheduledFor: input.scheduledFor,
      contactId: input.contactId ?? null,
      appointmentId: input.appointmentId ?? null,
      patientId: input.patientId ?? null,
      budgetId: input.budgetId ?? null,
      opportunityId: input.opportunityId ?? null,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({
      target: [automationJob.organizationId, automationJob.dedupeKey],
    })
    .returning()
  return row ?? null
}

/**
 * A quién se le escribe lo de un paciente: su persona preferida y, si no tiene,
 * él mismo. Siempre la misma para el mismo paciente.
 */
export async function preferredContact(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const rows = await tx
    .select({
      contactId: patientContact.contactId,
      isPreferred: patientContact.isPreferred,
      relationship: patientContact.relationship,
    })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(contact.isActive, true),
      ),
    )
    .orderBy(asc(patientContact.createdAt), asc(patientContact.id))
    .limit(20)
  if (rows.length === 0) return null
  return (rows.find((r) => r.isPreferred) ?? rows.find((r) => r.relationship === "self") ?? rows[0])!.contactId
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Crea un enlace seguro de un solo uso lógico (se marca usedAt al usarlo). */
async function createLinkToken(
  tx: Db,
  orgId: string,
  input: {
    purpose: string
    jobId?: string | null
    appointmentId?: string | null
    contactId?: string | null
    ttlHours: number
    now: Date
  },
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await tx.insert(automationLinkToken).values({
    tokenHash: hashToken(token),
    organizationId: orgId,
    purpose: input.purpose,
    jobId: input.jobId ?? null,
    appointmentId: input.appointmentId ?? null,
    contactId: input.contactId ?? null,
    expiresAt: new Date(input.now.getTime() + input.ttlHours * 3_600_000),
  })
  return token
}

/** Enlace amable de la plataforma (origen público, sin sesión): /c/ o /baja/. */
function publicLink(baseUrl: string, path: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path}/${token}`
}

export async function timezoneOf(tx: Db, orgId: string, branchId?: string | null): Promise<string> {
  if (branchId) {
    const [b] = await tx
      .select({ timezone: branch.timezone })
      .from(branch)
      .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    if (b?.timezone) return b.timezone
  }
  const [profile] = await tx
    .select({ timezone: orgProfile.timezone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return profile?.timezone ?? NEUTRAL_TIMEZONE
}

/** true si `now` cae en la ventana de silencio (regla de horarios por sede). */
export function inQuietHours(now: Date, timeZone: string, start?: string, end?: string): boolean {
  const s = start ?? "21:00"
  const e = end ?? "08:00"
  // Lectura técnica de la hora (HH:mm) para comparar, no un texto para personas.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now)
  const [h, m] = parts.split(":").map(Number)
  const cur = (h ?? 0) * 60 + (m ?? 0)
  const toMin = (v: string) => {
    const [hh, mm] = v.split(":").map(Number)
    return (hh ?? 0) * 60 + (mm ?? 0)
  }
  const from = toMin(s)
  const to = toMin(e)
  if (from === to) return false
  if (from < to) return cur >= from && cur < to
  return cur >= from || cur < to
}

/** Pospone al primer instante fuera de la ventana de silencio (pasos de 15 min, máx. 24 h). */
function afterQuietEnd(now: Date, timeZone: string, start?: string, end?: string): Date {
  let candidate = new Date(now.getTime() + 15 * 60_000)
  for (let i = 0; i < 96; i++) {
    if (!inQuietHours(candidate, timeZone, start, end)) return candidate
    candidate = new Date(candidate.getTime() + 15 * 60_000)
  }
  return candidate
}

// ------------------------------------------------------- sincronización ---

export interface SyncSummary {
  programados: number
  omitidos: number
}

/** Casos que una regla revisa por tick; el resto queda para el siguiente. */
export const BATCH_LIMIT = 200

/** Pasado este tiempo desde que venció el plazo, un seguimiento ya no se envía. */
const FOLLOW_UP_MAX_AGE_HOURS = 7 * 24

/** Tras una inasistencia se espera al día siguiente. */
const NO_SHOW_DELAY_HOURS = 24

/**
 * Deja fuera del lote lo que ya tiene su trabajo (enviado, cancelado u omitido).
 * Sin esto, un tope sin orden volvía a traer los mismos casos y los nuevos no
 * entraban nunca.
 */
export function notYetQueued(orgId: string, prefix: string, idColumn: unknown) {
  return sql`not exists (select 1 from automation_job j
    where j.organization_id = ${orgId} and j.dedupe_key = ${prefix + ":"} || ${idColumn}::text)`
}

/** La línea, si está prendida; null si está apagada o nunca se prendió. */
async function enabledLine(tx: Db, orgId: string, kind: AutomationKind): Promise<RuleRow | null> {
  const rule = await findLineRule(tx, orgId, kind)
  return rule?.enabled ? rule : null
}

/**
 * Casos de «Recordar la cita»: uno por cita y por aviso (por defecto, un día y
 * tres horas antes). Idempotente por `recordatorio_cita:<cita>:<horas>`. El
 * mensaje se arma al entregar, con los datos de la agenda de ese momento.
 */
export async function syncAppointmentReminders(
  tx: Db,
  orgId: string,
  now: Date,
): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "recordatorio_cita")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  const hoursList = lineConfigOf(rule.config).hoursBefore ?? [...DEFAULT_HOURS_BEFORE]
  // Solo las citas que entran en el aviso más lejano, las más próximas primero,
  // y sin las que ya tienen todos sus avisos: el lote avanza aunque la clínica
  // tenga más citas que el tope.
  const horizon = new Date(now.getTime() + (Math.max(...hoursList) + 1) * 3_600_000)
  const upcoming = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
        lte(appointment.startsAt, horizon),
        sql`(select count(*) from automation_job j
          where j.organization_id = ${orgId} and j.rule_id = ${rule.id}
            and j.appointment_id = ${appointment.id}) < ${hoursList.length}`,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(BATCH_LIMIT)
  for (const appt of upcoming) {
    const contactId = await preferredContact(tx, orgId, appt.patientId)
    if (!contactId) {
      omitidos++
      continue
    }
    for (const h of hoursList) {
      const scheduledFor = new Date(appt.startsAt.getTime() - h * 3_600_000)
      if (scheduledFor.getTime() < now.getTime() - 30 * 60_000) continue
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "recordatorio_cita",
        dedupeKey: `recordatorio_cita:${appt.id}:${h}`,
        scheduledFor: scheduledFor < now ? now : scheduledFor,
        contactId,
        appointmentId: appt.id,
        patientId: appt.patientId,
        // El horario de silencio se mide con la hora de la sede de la cita.
        payload: { timeZone: await timezoneOf(tx, orgId, appt.branchId) },
      })
      if (job) programados++
    }
  }
  return { programados, omitidos }
}

/** Casos de «Retomar un presupuesto»: presentado y sin decisión al cumplirse el plazo. */
export async function syncBudgetFollowUps(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "seguimiento_presupuesto")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  const delayMs = (lineDays(rule, "seguimiento_presupuesto") ?? 2) * 24 * 3_600_000
  const cutoff = new Date(now.getTime() - delayMs)
  // Solo los que cumplen el plazo con la línea ya prendida: un presupuesto que
  // llevaba semanas sin respuesta cuando se prendió no recibe nada.
  const since = new Date(activeSince(rule).getTime() - delayMs)
  const pending = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.status, "presentado"),
        lte(treatmentBudget.presentedAt, cutoff),
        gte(treatmentBudget.presentedAt, since),
        notYetQueued(orgId, "seguimiento_presupuesto", treatmentBudget.id),
      ),
    )
    .orderBy(asc(treatmentBudget.presentedAt), asc(treatmentBudget.id))
    .limit(BATCH_LIMIT)
  for (const budget of pending) {
    const contactId =
      budget.decisionContactId ?? (await preferredContact(tx, orgId, budget.patientId))
    if (!contactId) {
      omitidos++
      continue
    }
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "seguimiento_presupuesto",
      dedupeKey: `seguimiento_presupuesto:${budget.id}`,
      scheduledFor: now,
      contactId,
      patientId: budget.patientId,
      budgetId: budget.id,
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

/**
 * El vencimiento que identifica un caso de «Retomar una oportunidad»: la
 * oportunidad y su próxima acción, en milisegundos. Si se reprograma y vuelve a
 * vencer, es otro caso.
 */
const OPPORTUNITY_DUE_KEY = sql<string>`(${opportunity.id}::text || ':' || floor(extract(epoch from ${opportunity.nextActionAt}) * 1000)::bigint::text)`

/**
 * Casos de «Retomar una oportunidad»: oportunidades abiertas cuya próxima acción
 * venció con la línea ya prendida y siguen con su seguimiento abierto. A quien
 * tenía la próxima acción vencida desde antes de prenderla no se le escribe.
 */
export async function syncOpportunityFollowUps(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "seguimiento_comercial")
  let programados = 0
  const omitidos = 0
  if (!rule) return { programados, omitidos }
  const due = await tx
    .select({
      key: OPPORTUNITY_DUE_KEY,
      id: opportunity.id,
      contactId: opportunity.contactId,
      ownerUserId: opportunity.assignedUserId,
      nextActionAt: opportunity.nextActionAt,
    })
    .from(opportunity)
    .innerJoin(
      crmTask,
      and(
        eq(crmTask.organizationId, opportunity.organizationId),
        eq(crmTask.opportunityId, opportunity.id),
        eq(crmTask.kind, "opportunity_follow_up"),
        eq(crmTask.status, "open"),
      ),
    )
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.status, "open"),
        lte(opportunity.nextActionAt, now),
        gte(opportunity.nextActionAt, activeSince(rule)),
        sql`${crmTask.dueAt} = ${opportunity.nextActionAt}`,
        notYetQueued(orgId, "seguimiento_comercial", OPPORTUNITY_DUE_KEY),
      ),
    )
    .orderBy(asc(opportunity.nextActionAt), asc(opportunity.id))
    .limit(BATCH_LIMIT)
  for (const opp of due) {
    if (!opp.nextActionAt) continue
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "seguimiento_comercial",
      dedupeKey: `seguimiento_comercial:${opp.key}`,
      scheduledFor: now,
      contactId: opp.contactId,
      opportunityId: opp.id,
      payload: {
        dueAt: opp.nextActionAt.toISOString(),
        ...(opp.ownerUserId ? { ownerUserId: opp.ownerUserId } : {}),
      },
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

/** Casos de «Reprogramar tras una inasistencia»: al día siguiente de la cita a la que no vino. */
export async function syncVisitFollowUps(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "seguimiento_no_asistencia")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  // Con hora fija sale al día siguiente a esa hora de la sede; sin ella, 24
  // horas después de terminar la cita.
  const { hour } = lineConfigOf(rule.config)
  const cutoff = hour === undefined ? new Date(now.getTime() - NO_SHOW_DELAY_HOURS * 3_600_000) : now
  // El plazo corre desde que terminó la cita (no desde su última edición) y
  // solo cuentan las citas que empezaron con la línea ya prendida. Una cita
  // marcada con mucho retraso ya no se sigue: el mensaje llegaría fuera de lugar.
  const oldest = new Date(now.getTime() - (NO_SHOW_DELAY_HOURS + FOLLOW_UP_MAX_AGE_HOURS) * 3_600_000)
  const visits = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.status, "no_asistio"),
        lte(appointment.endsAt, cutoff),
        gte(appointment.endsAt, oldest),
        gte(appointment.startsAt, activeSince(rule)),
        notYetQueued(orgId, "seguimiento_no_asistencia", appointment.id),
      ),
    )
    .orderBy(asc(appointment.endsAt), asc(appointment.id))
    .limit(BATCH_LIMIT)
  for (const appt of visits) {
    const contactId = await preferredContact(tx, orgId, appt.patientId)
    if (!contactId) {
      omitidos++
      continue
    }
    const timeZone = await timezoneOf(tx, orgId, appt.branchId)
    const at = hour === undefined ? now : nextDayAt(appt.endsAt, timeZone, hour)
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "seguimiento_no_asistencia",
      dedupeKey: `seguimiento_no_asistencia:${appt.id}`,
      scheduledFor: at < now ? now : at,
      contactId,
      appointmentId: appt.id,
      patientId: appt.patientId,
      payload: { timeZone },
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

/** El día siguiente a `date`, a la hora dada, en la zona de la sede. */
export function nextDayAt(date: Date, timeZone: string, hour: number): Date {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(date)
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const sinceMidnight = (read("hour") * 3600 + read("minute") * 60 + read("second")) * 1000 + date.getMilliseconds()
  return new Date(date.getTime() - sinceMidnight + (24 + hour) * 3_600_000)
}

/** Cuándo canceló la persona su cita: la propia persona desde su enlace o el equipo con ese motivo. */
const CANCELLED_BY_PERSON = sql`(
  select max(e.created_at) from audit_event e
  where e.organization_id = ${appointment.organizationId} and e.entity = 'appointment'
    and e.entity_id = ${appointment.id}::text and e.action = 'appointment.status_cancelada'
    and (e.actor_user_id is null or e.metadata->>'cancelReason' = 'paciente'))`

/**
 * Casos de «Ofrecer otra fecha tras una cancelación»: citas que canceló la
 * persona (no la clínica) con la línea ya prendida, pasada la espera. Una que
 * se canceló hace más de una semana ya no se sigue.
 */
export async function syncCancelledAppointments(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "cita_cancelada")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  const delayMs = (lineConfigOf(rule.config).delayHours ?? adminLineOf("cita_cancelada")?.delayHours ?? 1) * 3_600_000
  const cutoff = new Date(now.getTime() - delayMs)
  const since = activeSince(rule)
  const oldest = new Date(now.getTime() - FOLLOW_UP_MAX_AGE_HOURS * 3_600_000)
  const cancelled = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.status, "cancelada"),
        sql`${CANCELLED_BY_PERSON} between ${(since > oldest ? since : oldest).toISOString()}::timestamptz and ${cutoff.toISOString()}::timestamptz`,
        notYetQueued(orgId, "cita_cancelada", appointment.id),
      ),
    )
    .orderBy(asc(appointment.updatedAt), asc(appointment.id))
    .limit(BATCH_LIMIT)
  for (const appt of cancelled) {
    const contactId = await preferredContact(tx, orgId, appt.patientId)
    if (!contactId) {
      omitidos++
      continue
    }
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "cita_cancelada",
      dedupeKey: `cita_cancelada:${appt.id}`,
      scheduledFor: now,
      contactId,
      appointmentId: appt.id,
      patientId: appt.patientId,
      payload: { timeZone: await timezoneOf(tx, orgId, appt.branchId) },
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

/** Ventana del recordatorio de control: avisa de los controles que vencen en estas horas. */
export const CHECKUP_REMINDER_WINDOW_HOURS = 48

/** Casos de «Avisar un control»: los controles que vencen en las próximas horas. */
export async function syncCheckupReminders(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "recordatorio_control")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  const horizon = new Date(now.getTime() + CHECKUP_REMINDER_WINDOW_HOURS * 3_600_000)
  const due = await tx
    .select()
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
        gte(clinicalFollowUp.dueAt, now),
        lte(clinicalFollowUp.dueAt, horizon),
        notYetQueued(orgId, "recordatorio_control", clinicalFollowUp.id),
      ),
    )
    .orderBy(asc(clinicalFollowUp.dueAt), asc(clinicalFollowUp.id))
    .limit(BATCH_LIMIT)
  for (const control of due) {
    const contactId = await preferredContact(tx, orgId, control.patientId)
    if (!contactId) {
      omitidos++
      continue
    }
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "recordatorio_control",
      dedupeKey: `recordatorio_control:${control.id}`,
      scheduledFor: now,
      contactId,
      patientId: control.patientId,
      payload: { controlId: control.id },
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

// ------------------------------------------------- resolución y entrega ---

/** Verifica que el motivo del caso siga en pie; si ya se resolvió, no se hace nada. */
async function stillValid(
  tx: Db,
  orgId: string,
  job: JobRow,
  now: Date,
): Promise<{ valid: boolean; reason?: string }> {
  if (job.kind === "recordatorio_cita" && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    if (!["programada", "confirmada"].includes(appt.status)) {
      return { valid: false, reason: `La cita ya está ${appt.status}` }
    }
    if (appt.startsAt.getTime() < now.getTime() - 60_000) {
      return { valid: false, reason: "La cita ya pasó" }
    }
    return { valid: true }
  }
  if (job.kind === "seguimiento_presupuesto" && job.budgetId) {
    const [budget] = await tx
      .select({ status: treatmentBudget.status })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, job.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget) return { valid: false, reason: "El presupuesto ya no existe" }
    if (budget.status !== "presentado") {
      return { valid: false, reason: `El presupuesto ya está ${budget.status}` }
    }
    return { valid: true }
  }
  if (job.kind === "seguimiento_no_asistencia" && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    if (appt.status !== "no_asistio") return { valid: false, reason: `La cita cambió a ${appt.status}` }
    if (job.patientId && (await hasFutureAppointment(tx, orgId, job.patientId, now))) {
      return { valid: false, reason: "Ya tiene otra cita reservada" }
    }
    return { valid: true }
  }
  if (job.kind === "cita_cancelada" && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    if (appt.status !== "cancelada") return { valid: false, reason: `La cita cambió a ${appt.status}` }
    if (job.patientId && (await hasFutureAppointment(tx, orgId, job.patientId, now))) {
      return { valid: false, reason: "Ya tiene otra cita reservada" }
    }
    return { valid: true }
  }
  if (job.kind === "recordatorio_control") {
    const { controlId } = jobPayloadOf(job.payload)
    if (controlId) {
      const [control] = await tx
        .select({ status: clinicalFollowUp.status, appointmentStatus: appointment.status })
        .from(clinicalFollowUp)
        .leftJoin(
          appointment,
          and(
            eq(appointment.id, clinicalFollowUp.appointmentId),
            eq(appointment.organizationId, clinicalFollowUp.organizationId),
          ),
        )
        .where(and(eq(clinicalFollowUp.id, controlId), eq(clinicalFollowUp.organizationId, orgId)))
        .limit(1)
      if (!control) return { valid: false, reason: "El control ya no existe" }
      if (!["pendiente", "programado"].includes(control.status)) {
        return { valid: false, reason: `El control ya está ${control.status}` }
      }
      if (control.appointmentStatus === "atendida")
        return { valid: false, reason: "El control está pendiente de cierre clínico" }
    }
    return { valid: true }
  }
  if (job.kind === "presupuestos_sin_cita" && job.budgetId) {
    const [budget] = await tx
      .select({ status: treatmentBudget.status })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, job.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget || !["aceptado", "parcial"].includes(budget.status)) {
      return { valid: false, reason: "El presupuesto ya no está aceptado" }
    }
    if (job.patientId && (await hasFutureAppointment(tx, orgId, job.patientId, now))) {
      return { valid: false, reason: "Ya tiene una cita reservada" }
    }
    return { valid: true }
  }
  if (job.kind === "seguimiento_comercial" && job.opportunityId) {
    const [opp] = await tx
      .select({ status: opportunity.status, nextActionAt: opportunity.nextActionAt, contactActive: contact.isActive })
      .from(opportunity)
      .innerJoin(contact, and(eq(contact.id, opportunity.contactId), eq(contact.organizationId, opportunity.organizationId)))
      .where(and(eq(opportunity.id, job.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (!opp || opp.status !== "open") return { valid: false, reason: "La oportunidad ya se cerró" }
    if (!opp.contactActive) return { valid: false, reason: "El contacto está archivado" }
    // Atendida o reprogramada antes de escribir: lo decidió una persona.
    const { dueAt } = jobPayloadOf(job.payload)
    const stillDue = dueAt
      ? opp.nextActionAt?.getTime() === Date.parse(dueAt)
      : !!opp.nextActionAt && opp.nextActionAt.getTime() <= now.getTime()
    if (!stillDue) return { valid: false, reason: "La próxima acción ya se atendió o se reprogramó" }
    return { valid: true }
  }
  if (job.kind === "seguimientos_sin_responsable" && job.opportunityId) {
    const [opp] = await tx
      .select({ status: opportunity.status, assignedUserId: opportunity.assignedUserId })
      .from(opportunity)
      .where(and(eq(opportunity.id, job.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (!opp || opp.status !== "open") return { valid: false, reason: "El seguimiento ya se cerró" }
    if (opp.assignedUserId) return { valid: false, reason: "El seguimiento ya tiene responsable" }
    return { valid: true }
  }
  if (job.contactId) {
    const [c] = await tx
      .select({ isActive: contact.isActive })
      .from(contact)
      .where(and(eq(contact.id, job.contactId), eq(contact.organizationId, orgId)))
      .limit(1)
    if (!c) return { valid: false, reason: "El contacto ya no existe" }
    if (!c.isActive) return { valid: false, reason: "El contacto está archivado" }
  }
  return { valid: true }
}

async function hasFutureAppointment(tx: Db, orgId: string, patientId: string, now: Date): Promise<boolean> {
  const [next] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
      ),
    )
    .limit(1)
  return !!next
}

export interface DeliverDeps {
  secretsKey: Buffer
  /** Origen público de la plataforma, para los enlaces que van en el correo. */
  publicBaseUrl?: string
  /**
   * Antes de escribirle a alguien por un seguimiento, lee lo último que esa
   * persona escribió: true si ya avisó algo sobre ese asunto. Lo responde un
   * modelo de decisión; sin él, o si falla, se escribe como siempre.
   */
  alreadyTold?: ((orgId: string, input: { kind: string; reason: string; messages: string[] }) => Promise<boolean>) | undefined
}

/** Cuánto hacia atrás se mira lo que la persona escribió antes de escribirle. */
const ALREADY_TOLD_HOURS = 72

/** Lo último que la persona escribió a la clínica, de lo más reciente a lo más antiguo. */
async function recentlyWritten(tx: Db, orgId: string, contactId: string, now: Date): Promise<string[]> {
  const rows = await tx
    .select({ body: message.body })
    .from(message)
    .innerJoin(conversation, and(eq(conversation.id, message.conversationId), eq(conversation.organizationId, orgId)))
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(conversation.contactId, contactId),
        eq(message.direction, "in"),
        gte(message.createdAt, new Date(now.getTime() - ALREADY_TOLD_HOURS * 3_600_000)),
        sql`coalesce(${message.body}, '') <> ''`,
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(5)
  return rows.map((row) => row.body ?? "")
}

export interface DeliverResult {
  jobId: string
  outcome: "enviado" | "tarea" | "pospuesto" | "omitido" | "cancelado" | "fallido"
  detail?: string
}

const MAX_ATTEMPTS = 5

/**
 * Códigos definitivos (sin reintento): ventana cerrada o inbound requerido y
 * validaciones (p. ej. plantilla no aprobada). Solo los fallos transitorios del
 * proveedor reintentan; como el reintento corre en una transacción que revierte
 * el encolado al fallar, nunca duplica envíos.
 */
const DEFINITIVE_CODES = new Set(["WINDOW_CLOSED", "CHANNEL_REQUIRES_INBOUND", "VALIDATION"])

function isDefinitiveCode(code: string | undefined): boolean {
  return !!code && DEFINITIVE_CODES.has(code)
}

/**
 * Por qué no se le pudo escribir a una persona y cómo se habilita, dicho de
 * una persona (`one`) y de varias (`many`). Lo usan el aviso al equipo, la
 * tarea de respaldo y la lista de «no pude» de Inicio.
 */
export const CAUSE_WORDS: Record<AutomationCause, { one: string; many: string; fix: string; fixMany: string }> = {
  sin_permiso: {
    one: "no aceptó mensajes de la clínica",
    many: "no aceptaron recibir este mensaje",
    fix: "Pídele el permiso la próxima vez que venga o escriba.",
    fixMany: "Para habilitarlo, pídeles el permiso la próxima vez que vengan o escriban.",
  },
  sin_destino: {
    one: "no tiene WhatsApp ni correo registrados",
    many: "no tienen WhatsApp ni correo registrados",
    fix: "Agrega su número o su correo en su ficha.",
    fixMany: "Para habilitarlo, agrega su número o su correo en su ficha.",
  },
  correo_ajeno: {
    one: "su correo está vinculado a otra persona de la clínica",
    many: "su correo está vinculado a otra persona de la clínica",
    fix: "Revisa el correo en su ficha y en la de la otra persona.",
    fixMany: "Para habilitarlo, revisa el correo en sus fichas: está vinculado a otra persona.",
  },
  sin_conexion: {
    one: "la clínica no tiene conectado un canal por el que llegarle",
    many: "la clínica no tiene conectado un canal por el que llegarles",
    fix: "Conecta WhatsApp o el correo en Configuración › Integraciones.",
    fixMany: "Para habilitarlo, conecta WhatsApp o el correo en Configuración › Integraciones.",
  },
  sin_plantilla: {
    one: "no escribió en las últimas 24 horas y WhatsApp aún no aprueba el mensaje",
    many: "no escribieron en las últimas 24 horas y WhatsApp aún no aprueba el mensaje",
    fix: "El mensaje ya se pidió: sale cuando WhatsApp lo apruebe. Agregar su correo también lo habilita.",
    fixMany: "El mensaje ya se pidió: empieza a salir cuando WhatsApp lo apruebe. Agregar su correo también lo habilita.",
  },
  no_entregado: {
    one: "el canal no entregó el mensaje",
    many: "el canal no entregó el mensaje",
    fix: "Revisa su número.",
    fixMany: "Para habilitarlo, revisa su número.",
  },
  proveedor: {
    one: "el envío falló",
    many: "el envío falló",
    fix: "Revisa la conexión en Configuración › Integraciones.",
    fixMany: "Para habilitarlo, revisa la conexión en Configuración › Integraciones.",
  },
}

/** Motivo de un fallo definitivo según el código que devuelve el envío. */
function causeOfCode(code: string | undefined): AutomationCause {
  return code === "WINDOW_CLOSED" || code === "CHANNEL_REQUIRES_INBOUND" || code === "VALIDATION"
    ? "sin_plantilla"
    : "proveedor"
}

/**
 * Un aviso por línea, causa y día, con la cuenta al día: veinte personas sin
 * permiso son un aviso que dice «20», no veinte avisos. Se cuenta sobre los
 * casos, así que repetirlo no suma de más. Abre la línea en la página del
 * Administrador, con las personas a las que no pudo escribir.
 */
async function noticeCause(
  tx: Db,
  orgId: string,
  rule: RuleRow,
  cause: AutomationCause,
  timeZone: string,
  now: Date,
): Promise<void> {
  const recipient = await failureRecipient(tx, orgId, rule.enabledBy ?? rule.createdBy)
  if (!recipient) return
  const rows = await tx.execute<{ n: number | string; day: string }>(sql`
    select count(*) as n, to_char(${now.toISOString()}::timestamptz at time zone ${timeZone}, 'YYYY-MM-DD') as day
    from automation_job j
    where j.organization_id = ${orgId} and j.rule_id = ${rule.id} and j.cause = ${cause}
      and (j.updated_at at time zone ${timeZone})::date
        = (${now.toISOString()}::timestamptz at time zone ${timeZone})::date`)
  const first = Array.isArray(rows) ? rows[0] : undefined
  const total = Math.max(Number(first?.n ?? 0), 1)
  const words = CAUSE_WORDS[cause]
  const name = adminLineOf(rule.kind)?.name ?? rule.name
  await upsertWorkspaceNotification(tx, orgId, {
    userId: recipient,
    dedupeKey: `automation-cause:${rule.id}:${cause}:${first?.day ?? now.toISOString().slice(0, 10)}`,
    title:
      total === 1
        ? `«${name}»: no pude escribirle a 1 persona`
        : `«${name}»: no pude escribirle a ${total} personas`,
    body: `Motivo: ${words.many}. ${words.fixMany}`,
    href: `/agent/administrador?linea=${rule.kind}&ver=no-pudo`,
    permission: "agent.read",
  })
}

/** Margen para juntar recordatorios que vencen casi a la vez. */
const GROUP_WINDOW_MS = 30 * 60_000

/**
 * El correo no tiene botones: lleva el mismo texto y, en su lugar, enlaces.
 * Un recordatorio trae los de confirmar y cancelar cada cita; todos traen el
 * de darse de baja de ese tipo de mensaje. La primera línea es el asunto.
 */
function emailBody(
  message: ComposedMessage,
  clinic: string,
  links: { appointments: { confirm: string; cancel: string }[]; optOut: string | null },
): string {
  const lines = links.appointments.map((link, index) => {
    const which = links.appointments.length > 1 ? `Cita ${index + 1}. ` : ""
    return `${which}Para confirmar: ${link.confirm}\n${which}Si no podrás ir: ${link.cancel}`
  })
  const actions = lines.length > 0 ? `\n\n${lines.join("\n")}` : ""
  const optOut = links.optOut ? `\n\nSi no quieres recibir más estos mensajes: ${links.optOut}` : ""
  return `${message.subject}\n\n${message.text}${actions}\n\nPuedes responder a este correo.\n\n${clinic}${optOut}`
}

/** Primer instante de mañana (en la zona dada) fuera del horario de silencio. */
function tomorrowMorning(now: Date, timeZone: string, quietStart?: string, quietEnd?: string): Date {
  const hourNow = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  )
  const midnight = new Date(now.getTime() + (24 - hourNow) * 3_600_000)
  return afterQuietEnd(midnight, timeZone, quietStart, quietEnd)
}

/** Fin del día siguiente en la zona dada: el plazo de una tarea que deja el Administrador. */
function endOfTomorrow(now: Date, timeZone: string): Date {
  const hourNow = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  )
  return new Date(now.getTime() + (48 - hourNow) * 3_600_000 - (now.getMinutes() * 60_000 + now.getSeconds() * 1000))
}

/**
 * Deja la tarea de un caso para una persona del equipo: a su área o, si el
 * caso tiene quien lo lleva, a esa persona. Dice quién la dejó (el
 * Administrador) y por qué. Una tarea por caso: repetirlo no la duplica.
 */
async function leaveTask(
  tx: Db,
  orgId: string,
  job: JobRow,
  input: { reason: string; note?: string | undefined; dueAt?: Date; timeZone: string; now: Date },
): Promise<string | null> {
  const line = adminLineOf(job.kind)
  if (!line) return null
  const payload = jobPayloadOf(job.payload)
  let name: string | null = null
  if (job.patientId) {
    const [row] = await tx
      .select({ name: patient.displayName })
      .from(patient)
      .where(and(eq(patient.id, job.patientId), eq(patient.organizationId, orgId)))
      .limit(1)
    name = row?.name ?? null
  }
  if (!name && job.contactId) {
    const [row] = await tx
      .select({ name: contact.displayName })
      .from(contact)
      .where(and(eq(contact.id, job.contactId), eq(contact.organizationId, orgId)))
      .limit(1)
    name = row?.name ?? null
  }
  // Una tarea cuyo responsable ya no es del equipo vuelve a su área.
  let assignee: string | null = null
  if (line.team.toOwner && payload.ownerUserId) {
    const [still] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, payload.ownerUserId)))
      .limit(1)
    assignee = still?.userId ?? null
  }
  const task = await createTask(tx, orgId, {
    title: line.team.taskTitle(name ?? "esta persona").slice(0, 200),
    patientId: job.patientId,
    contactId: job.patientId ? null : job.contactId,
    opportunityId: job.opportunityId,
    assigneeUserId: assignee,
    dueAt: (input.dueAt ?? endOfTomorrow(input.now, input.timeZone)).toISOString(),
    createdBy: "admin",
    area: line.team.area,
    reason: `${input.reason}${input.note ? ` Indicación de la clínica: ${input.note}` : ""}`.slice(0, 480),
    idempotencyKey: `admin:${job.id}`,
  })
  return task.id
}

/**
 * La oportunidad que se retoma queda con el hilo por el que se le escribió, si
 * aún no tenía uno: su seguimiento y quien abra la oportunidad llegan a esa
 * conversación. Un hilo que ya tenía no se cambia. Si no se puede vincular, el
 * mensaje que ya salió no se deshace.
 */
async function linkOpportunityThread(tx: Db, orgId: string, job: JobRow, conversationId: string): Promise<void> {
  if (job.kind !== "seguimiento_comercial" || !job.opportunityId) return
  const [opp] = await tx
    .select({ conversationId: opportunity.conversationId })
    .from(opportunity)
    .where(and(eq(opportunity.id, job.opportunityId), eq(opportunity.organizationId, orgId)))
    .limit(1)
  if (!opp || opp.conversationId) return
  try {
    await updateOpportunity(tx, orgId, job.opportunityId, { conversationId }, { userId: null })
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
  }
}

/** Hasta cuándo sirve llamar por el recordatorio de una cita: hasta que empieza. */
async function reminderDue(tx: Db, orgId: string, job: JobRow): Promise<Date | undefined> {
  if (job.kind !== "recordatorio_cita" || !job.appointmentId) return undefined
  const [appt] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
    .limit(1)
  return appt?.startsAt
}

/**
 * Atiende un caso vencido: reclama la fila (FOR UPDATE), comprueba que el
 * motivo siga en pie y hace lo que la línea tiene prendido.
 *
 * - Si la línea solo deja trabajo al equipo (o «el agente le escribe» está
 *   apagado), queda una tarea para una persona.
 * - Si el agente escribe: comprueba el horario de silencio y el permiso de la
 *   persona, elige la vía (respuesta, mensaje aprobado o correo) y deja el
 *   mensaje en la cola.
 *
 * Nunca termina en blanco: si no puede escribir, el caso se cierra con su
 * motivo, el equipo recibe un aviso por causa con cómo habilitarlo y, si la
 * línea tiene prendida su tarea, queda la tarea para una persona.
 *
 * Como mucho un mensaje al día por persona: los recordatorios de cita que
 * vencen juntos salen en uno solo y los demás tipos esperan al día siguiente
 * si esa persona ya recibió algo hoy o tiene un recordatorio por salir.
 */
export async function deliverJob(
  tx: Db,
  orgId: string,
  jobId: string,
  now: Date,
  deps: DeliverDeps,
): Promise<DeliverResult> {
  const [job] = await tx
    .select()
    .from(automationJob)
    .where(
      and(
        eq(automationJob.id, jobId),
        eq(automationJob.organizationId, orgId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .for("update")
    .limit(1)
  if (!job) return { jobId, outcome: "omitido", detail: "Ya procesado" }
  const [rule] = job.ruleId
    ? await tx
        .select()
        .from(automationRule)
        .where(and(eq(automationRule.id, job.ruleId), eq(automationRule.organizationId, orgId)))
        .limit(1)
    : []
  const payload = jobPayloadOf(job.payload)
  const line = adminLineOf(job.kind)
  const close = async (ids: string[], status: AutomationJobStatus, detail: string | undefined) => {
    await tx
      .update(automationJob)
      .set({ status, lastError: detail ?? null, updatedAt: now })
      .where(inArray(automationJob.id, ids))
  }
  // Lo que una persona pidió «solo esta vez» sale aunque la línea esté apagada.
  if (!rule || !line || (!rule.enabled && !payload.once)) {
    await close([job.id], "cancelado", "Línea apagada o retirada")
    return { jobId: job.id, outcome: "cancelado", detail: "Línea apagada" }
  }
  const runtime = await adminRuntime(tx, orgId)
  const tz = payload.timeZone ?? (await timezoneOf(tx, orgId, null))
  const validity = await stillValid(tx, orgId, job, now)
  if (!validity.valid) {
    await close([job.id], "cancelado", validity.reason)
    return { jobId: job.id, outcome: "cancelado", detail: validity.reason }
  }

  // ---- le toca a una persona -------------------------------------------------
  if (!line.agent || !rule.agentPart) {
    const taskId = await leaveTask(tx, orgId, job, {
      reason: payload.detail ?? line.trigger(lineDays(rule, job.kind)),
      note: lineConfigOf(rule.config).taskNote,
      dueAt: await reminderDue(tx, orgId, job),
      timeZone: tz,
      now,
    })
    await tx
      .update(automationJob)
      .set({ status: "tarea", taskId, attempts: job.attempts + 1, updatedAt: now })
      .where(eq(automationJob.id, job.id))
    await audit(tx, orgId, null, "automation_job.task", job.id, { kind: job.kind, taskId })
    return { jobId: job.id, outcome: "tarea" }
  }

  // ---- lo hace el agente -----------------------------------------------------
  if (!runtime.receptionOn) {
    // Recepción es quien escribe: con ella apagada no sale nada, y lo que quedó
    // atrás no se envía al volver a encenderla.
    await close([job.id], "cancelado", "Recepción apagada")
    return { jobId: job.id, outcome: "cancelado", detail: "Recepción apagada" }
  }
  /** Casos que salen en este mismo mensaje; al menos, el reclamado. */
  let group: JobRow[] = [job]
  const ids = () => group.map((item) => item.id)
  /**
   * Cierra el caso (y los que iban con él) porque no se pudo escribir. Un
   * fallo transitorio del proveedor reintenta hasta `MAX_ATTEMPTS`; lo demás
   * es definitivo desde el primer intento.
   */
  const cannot = async (
    detail: string,
    cause: AutomationCause,
    options: { retryable?: boolean; status?: "fallido" | "omitido" } = {},
  ): Promise<DeliverResult> => {
    const attempts = job.attempts + 1
    if (options.retryable && attempts < MAX_ATTEMPTS) {
      await tx
        .update(automationJob)
        .set({ attempts, lastError: detail, scheduledFor: new Date(now.getTime() + 15 * 60_000), updatedAt: now })
        .where(inArray(automationJob.id, ids()))
      return { jobId: job.id, outcome: "pospuesto", detail }
    }
    const status = options.status ?? "fallido"
    await tx
      .update(automationJob)
      .set({ attempts, status, lastError: detail, cause, updatedAt: now })
      .where(inArray(automationJob.id, ids()))
    await audit(tx, orgId, null, status === "omitido" ? "automation_job.skipped" : "automation_job.failed", job.id, {
      kind: job.kind,
      cause,
      detail,
    })
    await notify(tx, { orgId, kind: "automation.job.failed", jobId: job.id, at: now.toISOString() })
    await noticeCause(tx, orgId, rule, cause, tz, now)
    if (rule.teamPart) {
      const words = CAUSE_WORDS[cause]
      for (const item of group) {
        const taskId = await leaveTask(tx, orgId, item, {
          reason: `El agente no pudo escribirle: ${words.one}. ${words.fix}`,
          note: lineConfigOf(rule.config).taskNote,
          dueAt: await reminderDue(tx, orgId, item),
          timeZone: tz,
          now,
        })
        await tx.update(automationJob).set({ taskId }).where(eq(automationJob.id, item.id))
      }
    }
    return { jobId: job.id, outcome: status, detail }
  }
  if (inQuietHours(now, tz, runtime.quietStart, runtime.quietEnd)) {
    const later = afterQuietEnd(now, tz, runtime.quietStart, runtime.quietEnd)
    await tx
      .update(automationJob)
      .set({ scheduledFor: later, updatedAt: now })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "pospuesto", detail: "Fuera del horario de envío" }
  }
  if (!job.contactId) return cannot("Sin persona a quien escribirle", "sin_destino")
  const contactId = job.contactId
  const purpose = line.agent.purpose
  if (!(await hasConsent(tx, orgId, contactId, purpose))) {
    return cannot(`La persona no aceptó mensajes de ${purpose}`, "sin_permiso", { status: "omitido" })
  }

  if (job.kind === "recordatorio_cita") {
    // Varias citas de la misma persona (un padre con tres hijos) son un solo mensaje.
    const siblings = await tx
      .select()
      .from(automationJob)
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.contactId, contactId),
          eq(automationJob.ruleId, rule.id),
          eq(automationJob.kind, "recordatorio_cita"),
          eq(automationJob.status, "pendiente"),
          lte(automationJob.scheduledFor, new Date(now.getTime() + GROUP_WINDOW_MS)),
          sql`${automationJob.id} <> ${job.id}`,
        ),
      )
      .orderBy(asc(automationJob.scheduledFor), asc(automationJob.id))
      .for("update", { skipLocked: true })
    for (const sibling of siblings) {
      const check = await stillValid(tx, orgId, sibling, now)
      if (check.valid) group.push(sibling)
      else await close([sibling.id], "cancelado", check.reason)
    }
    // Un recordatorio por cita en el mensaje: si dos avisos de la misma cita
    // coinciden (uno atrasado), sale el primero y el otro se da por cubierto.
    const seen = new Set<string>()
    const covered: string[] = []
    group = group.filter((item) => {
      const key = item.appointmentId ?? item.id
      if (seen.has(key)) {
        covered.push(item.id)
        return false
      }
      seen.add(key)
      return true
    })
    if (covered.length > 0) await close(covered, "cancelado", "Cubierto por otro recordatorio de la misma cita")
  } else {
    const rows = await tx.execute<{ sent: boolean; reminder: boolean }>(sql`
      select
        exists (select 1 from automation_job j
          where j.organization_id = ${orgId} and j.contact_id = ${contactId} and j.status = 'enviado'
            and (j.updated_at at time zone ${tz})::date = (${now.toISOString()}::timestamptz at time zone ${tz})::date) as sent,
        exists (select 1 from automation_job j
          where j.organization_id = ${orgId} and j.contact_id = ${contactId} and j.status = 'pendiente'
            and j.kind = 'recordatorio_cita'
            and (j.scheduled_for at time zone ${tz})::date = (${now.toISOString()}::timestamptz at time zone ${tz})::date) as reminder`)
    const today = Array.isArray(rows) ? rows[0] : undefined
    if (today?.sent || today?.reminder) {
      await tx
        .update(automationJob)
        .set({ scheduledFor: tomorrowMorning(now, tz, runtime.quietStart, runtime.quietEnd), updatedAt: now })
        .where(eq(automationJob.id, job.id))
      return { jobId: job.id, outcome: "pospuesto", detail: "Ya recibió un mensaje hoy" }
    }
  }

  // Recepción no escribe encima de lo que la persona ya dijo. Lo que una persona
  // pidió «solo esta vez» sale igual: ya lo decidió alguien.
  if (deps.alreadyTold && purpose !== "recordatorio" && !payload.once) {
    const written = await recentlyWritten(tx, orgId, contactId, now)
    let told = false
    if (written.length > 0) {
      try {
        told = await deps.alreadyTold(orgId, { kind: job.kind, reason: line.trigger(lineDays(rule, job.kind)), messages: written })
      } catch {
        // Sin modelo, lo prendido sigue funcionando.
        told = false
      }
    }
    if (told) {
      await close(ids(), "cancelado", "La persona ya había escrito sobre esto")
      await audit(tx, orgId, null, "automation_job.already_told", job.id, { kind: job.kind })
      return { jobId: job.id, outcome: "cancelado", detail: "La persona ya había escrito sobre esto" }
    }
  }

  // El texto y la plantilla son los vigentes de la clínica, iguales para las tres vías.
  const spec = await currentAutomationMessageOf(tx, orgId, job.kind)
  const composed = spec ? await composeJobMessage(tx, orgId, spec, group, now) : null
  if (!spec || !composed) {
    await close(ids(), "cancelado", "Ya no existe lo que originó el mensaje")
    return { jobId: job.id, outcome: "cancelado", detail: "Sin datos para el mensaje" }
  }
  const route = await routeMessage(tx, orgId, contactId, spec)
  if ("cause" in route) return cannot(route.detail, route.cause)
  try {
    let sent: { id: string }
    if (route.via === "plantilla" && route.template) {
      sent = await sendTemplateOutbound(tx, orgId, deps.secretsKey, {
        conversationId: route.conversationId,
        senderKind: "agent",
        name: route.template.name,
        language: route.template.language,
        params: composed.params,
        buttons: composed.buttons,
        preview: composed.text,
      })
    } else if (route.via === "correo") {
      const [profile] = await tx
        .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
        .from(orgProfile)
        .where(eq(orgProfile.organizationId, orgId))
        .limit(1)
      const links: Parameters<typeof emailBody>[2] = { appointments: [], optOut: null }
      if (deps.publicBaseUrl) {
        const base = deps.publicBaseUrl
        if (job.kind === "recordatorio_cita") {
          for (const item of group) {
            if (!item.appointmentId) continue
            const link = { jobId: item.id, appointmentId: item.appointmentId, contactId, ttlHours: 72, now }
            links.appointments.push({
              confirm: publicLink(base, "c", await createLinkToken(tx, orgId, { purpose: "confirm", ...link })),
              cancel: publicLink(base, "c", await createLinkToken(tx, orgId, { purpose: "cancel", ...link })),
            })
          }
        }
        links.optOut = await createUnsubscribeLink(tx, orgId, contactId, base, { jobId: job.id })
      }
      sent = await sendOutbound(tx, orgId, {
        conversationId: route.conversationId,
        senderKind: "agent",
        content: {
          type: "text",
          text: emailBody(composed, profile?.tradeName?.trim() || profile?.legalName || "", links),
        },
      })
    } else {
      sent = await sendOutbound(tx, orgId, {
        conversationId: route.conversationId,
        senderKind: "agent",
        content: {
          type: "text",
          text: composed.text,
          ...(composed.buttons.length ? { buttons: composed.buttons } : {}),
        },
      })
    }
    await linkOpportunityThread(tx, orgId, job, route.conversationId)
    await tx
      .update(automationJob)
      .set({
        status: "enviado",
        sentMessageId: sent.id,
        via: route.via,
        channel: route.channel,
        attempts: job.attempts + 1,
        updatedAt: now,
      })
      .where(inArray(automationJob.id, ids()))
    await audit(tx, orgId, null, "automation_job.sent", job.id, {
      kind: job.kind,
      messageId: sent.id,
      via: route.via,
      ...(group.length > 1 ? { together: group.length } : {}),
    })
    return { jobId: job.id, outcome: "enviado" }
  } catch (e) {
    const code = e instanceof ServiceError ? e.code : undefined
    const detail = e instanceof ServiceError ? e.message : "Error al enviar"
    return cannot(detail, causeOfCode(code), { retryable: !isDefinitiveCode(code) })
  }
}

/**
 * «Enviado» solo dice que el mensaje salió hacia el canal. Si después el
 * proveedor lo rechaza, el caso pasa a `fallido` con su motivo, entra en el
 * aviso del día y, si la línea tiene prendida su tarea, queda para una
 * persona: nadie se queda creyendo que lo recibió.
 */
export async function reconcileDeliveries(tx: Db, orgId: string, now: Date): Promise<number> {
  const recent = new Date(now.getTime() - 3 * 24 * 3_600_000)
  const rows = await tx
    .select({ job: automationJob, error: message.error })
    .from(automationJob)
    .innerJoin(
      message,
      and(
        eq(message.id, automationJob.sentMessageId),
        eq(message.organizationId, automationJob.organizationId),
      ),
    )
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.status, "enviado"),
        gte(automationJob.updatedAt, recent),
        eq(message.status, "failed"),
      ),
    )
    .orderBy(asc(automationJob.updatedAt), asc(automationJob.id))
    .limit(BATCH_LIMIT)
  if (rows.length === 0) return 0
  const timeZone = await timezoneOf(tx, orgId, null)
  const rules = new Map<string, RuleRow | null>()
  const words = CAUSE_WORDS.no_entregado
  for (const { job, error } of rows) {
    await tx
      .update(automationJob)
      .set({
        status: "fallido",
        cause: "no_entregado",
        lastError: error ?? "El canal no entregó el mensaje",
        updatedAt: now,
      })
      .where(eq(automationJob.id, job.id))
    if (!job.ruleId) continue
    if (!rules.has(job.ruleId)) {
      const [rule] = await tx
        .select()
        .from(automationRule)
        .where(and(eq(automationRule.id, job.ruleId), eq(automationRule.organizationId, orgId)))
        .limit(1)
      rules.set(job.ruleId, rule ?? null)
    }
    const rule = rules.get(job.ruleId)
    if (rule?.teamPart && !job.taskId) {
      const taskId = await leaveTask(tx, orgId, job, {
        reason: `El agente no pudo escribirle: ${words.one}. ${words.fix}`,
        dueAt: await reminderDue(tx, orgId, job),
        timeZone: jobPayloadOf(job.payload).timeZone ?? timeZone,
        now,
      })
      await tx.update(automationJob).set({ taskId }).where(eq(automationJob.id, job.id))
    }
  }
  for (const rule of rules.values()) {
    if (rule) await noticeCause(tx, orgId, rule, "no_entregado", timeZone, now)
  }
  return rows.length
}

/** Reclama hasta `limit` trabajos vencidos (SKIP LOCKED) y los entrega. */
export async function deliverDueJobs(
  tx: Db,
  orgId: string,
  now: Date,
  deps: DeliverDeps,
  limit = 25,
): Promise<DeliverResult[]> {
  const due = await tx.execute<{ id: string }>(sql`
    select id from automation_job
    where organization_id = ${orgId}
      and status = 'pendiente'
      and scheduled_for <= ${now.toISOString()}::timestamptz
    order by scheduled_for asc
    limit ${limit}
    for update skip locked`)
  const rows = Array.isArray(due) ? due : []
  const results: DeliverResult[] = []
  for (const r of rows) {
    results.push(await deliverJob(tx, orgId, r.id, now, deps))
  }
  return results
}

/** Cancela lo pendiente de una cita al resolverse (confirmada/atendida/cancelada). */
export async function cancelPendingForAppointment(
  tx: Db,
  orgId: string,
  appointmentId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.appointmentId, appointmentId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .returning({ id: automationJob.id })
  return rows.length
}

// ------------------------------------------------------- enlaces públicos ---

export type LinkPurpose = "confirm" | "cancel" | "baja"

function assertLinkPurpose(purpose: string): LinkPurpose {
  if (purpose !== "confirm" && purpose !== "cancel" && purpose !== "baja") {
    throw validation("Enlace inválido")
  }
  return purpose
}

export interface PublicLinkInfo {
  purpose: LinkPurpose
  /** Fecha/hora de la cita en zona de la sede (sin datos del paciente). */
  when: string | null
  timeZone: string
  expired: boolean
  used: boolean
}

/** Información mínima del enlace: nunca incluye paciente ni contacto. */
export async function getPublicLinkInfo(tx: Db, token: string): Promise<PublicLinkInfo> {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .limit(1)
  if (!link) throw notFound("Enlace")
  const purpose = assertLinkPurpose(link.purpose)
  const expired = link.expiresAt.getTime() < Date.now()
  let when: string | null = null
  let timeZone = NEUTRAL_TIMEZONE
  if (link.appointmentId) {
    const [appt] = await tx
      .select({
        startsAt: appointment.startsAt,
        branchId: appointment.branchId,
        orgId: appointment.organizationId,
      })
      .from(appointment)
      .where(eq(appointment.id, link.appointmentId))
      .limit(1)
    if (appt) {
      timeZone = await timezoneOf(tx, appt.orgId, appt.branchId)
      const { locale } = await findOrgLocale(tx, appt.orgId)
      when = new Intl.DateTimeFormat(locale, {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(appt.startsAt)
    }
  }
  return { purpose, when, timeZone, expired, used: link.usedAt !== null }
}

async function useLinkToken(tx: Db, token: string, expected: LinkPurpose) {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .for("update")
    .limit(1)
  if (!link) throw notFound("Enlace")
  if (link.purpose !== expected) throw validation("Enlace inválido para esta acción")
  if (link.expiresAt.getTime() < Date.now())
    throw new ServiceError("LINK_EXPIRED", 409, "El enlace venció")
  if (link.usedAt) throw new ServiceError("LINK_USED", 409, "El enlace ya fue usado")
  if (!link.appointmentId && expected !== "baja") throw notFound("Cita")
  await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(eq(automationLinkToken.tokenHash, link.tokenHash))
  return link
}

/**
 * Invalida los enlaces de cita pendientes de una cita (hermanos del par
 * confirmar/cancelar y de trabajos anteriores). Gancho para Agenda en
 * mover/cancelar/atender. Devuelve enlaces invalidados.
 */
export async function invalidateAppointmentTokens(
  tx: Db,
  orgId: string,
  appointmentId: string,
): Promise<number> {
  const rows = await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(automationLinkToken.organizationId, orgId),
        eq(automationLinkToken.appointmentId, appointmentId),
        isNull(automationLinkToken.usedAt),
      ),
    )
    .returning({ tokenHash: automationLinkToken.tokenHash })
  return rows.length
}

/**
 * Transición por enlace público con fila bloqueada: solo desde estados
 * pendientes futuros (confirmar: programada; cancelar: programada o
 * confirmada). Nunca reabre canceladas ni toca atendidas/no asistidas.
 * El cambio lo hace la operación de la agenda (`setAppointmentStatus`), la
 * misma que usa recepción: versión, auditoría de la cita, enlaces hermanos,
 * recordatorios pendientes y aviso a las pantallas. El actor es nulo (origen
 * enlace, sin FK inventada).
 */
async function transitionAppointmentByToken(
  tx: Db,
  token: string,
  expected: LinkPurpose,
  toStatus: "confirmada" | "cancelada",
): Promise<{ appointmentId: string; status: string }> {
  const link = await useLinkToken(tx, token, expected)
  const [appt] = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.id, link.appointmentId!),
        eq(appointment.organizationId, link.organizationId),
      ),
    )
    .for("update")
    .limit(1)
  if (!appt) throw notFound("Cita")
  const allowed = toStatus === "confirmada" ? ["programada"] : ["programada", "confirmada"]
  if (!allowed.includes(appt.status)) {
    throw new ServiceError("APPOINTMENT_NOT_PENDING", 409, `La cita ya está ${appt.status}`)
  }
  if (appt.startsAt.getTime() < Date.now()) {
    throw new ServiceError("APPOINTMENT_PAST", 409, "La cita ya pasó")
  }
  const updated = await setAppointmentStatus(tx, link.organizationId, null, appt.id, toStatus, {
    via: "enlace-publico",
    ...(toStatus === "cancelada" ? { cancelReason: "paciente" } : {}),
  })
  return { appointmentId: updated.id, status: updated.status }
}

/** Confirma la cita desde el enlace seguro (solo programada futura). */
export async function confirmAppointmentByToken(
  tx: Db,
  token: string,
): Promise<{ appointmentId: string; status: string }> {
  return transitionAppointmentByToken(tx, token, "confirm", "confirmada")
}

/** Cancela la cita desde el enlace seguro (solo programada/confirmada futura). */
export async function cancelAppointmentByToken(
  tx: Db,
  token: string,
): Promise<{ appointmentId: string; status: string }> {
  return transitionAppointmentByToken(tx, token, "cancel", "cancelada")
}

/**
 * Baja verificable. Apaga el tipo de mensaje del que salió el enlace (quien se
 * da de baja de un seguimiento sigue recibiendo el recordatorio de su cita); un
 * enlace que no viene de un mensaje concreto apaga los tres.
 */
export async function unsubscribeByToken(tx: Db, token: string): Promise<{ contactId: string }> {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .for("update")
    .limit(1)
  if (!link || link.purpose !== "baja") throw notFound("Enlace")
  if (link.expiresAt.getTime() < Date.now())
    throw new ServiceError("LINK_EXPIRED", 409, "El enlace venció")
  if (!link.contactId) throw notFound("Contacto")
  const [origin] = link.jobId
    ? await tx
        .select({ kind: automationJob.kind })
        .from(automationJob)
        .where(and(eq(automationJob.id, link.jobId), eq(automationJob.organizationId, link.organizationId)))
        .limit(1)
    : []
  const purposes = origin ? [purposeOfKind(origin.kind)] : CONSENT_PURPOSES
  for (const purpose of purposes) {
    await setConsent(tx, link.organizationId, null, link.contactId, { purpose, granted: false, source: "baja" })
  }
  await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(eq(automationLinkToken.tokenHash, link.tokenHash))
  await audit(tx, link.organizationId, null, "automation_consent.unsubscribed", link.contactId, {
    purposes: [...purposes],
  })
  return { contactId: link.contactId }
}

/**
 * Crea el enlace de baja de una persona. Con `jobId` la baja es solo del tipo
 * de mensaje de ese trabajo; sin él, de todos.
 */
export async function createUnsubscribeLink(
  tx: Db,
  orgId: string,
  contactId: string,
  publicBaseUrl: string,
  options: { jobId?: string; ttlHours?: number } = {},
): Promise<string> {
  const token = await createLinkToken(tx, orgId, {
    purpose: "baja",
    contactId,
    jobId: options.jobId ?? null,
    ttlHours: options.ttlHours ?? 24 * 30,
    now: new Date(),
  })
  return publicLink(publicBaseUrl, "baja", token)
}

// ------------------------------------------------ respuestas con botón ---

/**
 * La persona tocó un botón de un mensaje automático. Dos los resuelve el
 * sistema, sin modelo y con un texto fijo de respuesta: «Confirmar» confirma
 * por la operación de la agenda cada cita de ese mensaje, y «No enviar más»
 * retira el permiso de ese tipo de mensaje. Devuelve true si quedó resuelto;
 * con false la conversación sigue su curso normal (el agente o una persona),
 * que es lo que pasa con cualquier otro botón.
 *
 * El botón solo vale en la conversación de la persona a la que se le envió.
 */
export async function handleAutomationReply(
  tx: Db,
  orgId: string,
  input: { conversationId: string; replyId: string | null | undefined },
): Promise<boolean> {
  const reply = parseReplyId(input.replyId)
  if (!reply || reply.action === "responder") return false
  const [thread] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  const [origin] = await tx
    .select()
    .from(automationJob)
    .where(and(eq(automationJob.id, reply.jobId), eq(automationJob.organizationId, orgId)))
    .limit(1)
  if (!thread || !origin?.sentMessageId || origin.contactId !== thread.contactId) return false
  if (reply.action === "baja") {
    const purpose = purposeOfKind(origin.kind)
    await setConsent(tx, orgId, null, thread.contactId, { purpose, granted: false, source: "baja" })
    await sendOutbound(tx, orgId, {
      conversationId: input.conversationId,
      senderKind: "agent",
      content: {
        type: "text",
        text:
          purpose === "recordatorio"
            ? "Listo: no te enviaremos más recordatorios. Si cambias de opinión, dínoslo por aquí."
            : "Listo: no te enviaremos más estos mensajes. Si cambias de opinión, dínoslo por aquí.",
      },
    })
    return true
  }
  const together = await tx
    .select({ appointmentId: automationJob.appointmentId })
    .from(automationJob)
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.sentMessageId, origin.sentMessageId),
        eq(automationJob.contactId, thread.contactId),
      ),
    )
  const appointmentIds = [...new Set(together.map((row) => row.appointmentId).filter((id): id is string => !!id))]
  if (appointmentIds.length === 0) return false
  let confirmed = 0
  let already = 0
  for (const appointmentId of appointmentIds) {
    const [appt] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
      .for("update")
      .limit(1)
    if (!appt || appt.startsAt.getTime() < Date.now()) continue
    if (appt.status === "confirmada") already++
    if (appt.status !== "programada") continue
    await setAppointmentStatus(tx, orgId, null, appointmentId, "confirmada", { via: "respuesta" })
    confirmed++
  }
  // Cita cancelada, atendida o ya pasada: no hay nada que confirmar y lo
  // correcto es que alguien lea la conversación.
  if (confirmed + already === 0) return false
  const many = confirmed + already > 1
  await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "agent",
    content: {
      type: "text",
      text:
        confirmed === 0
          ? many
            ? "Tus citas ya estaban confirmadas. ¡Te esperamos!"
            : "Tu cita ya estaba confirmada. ¡Te esperamos!"
          : many
            ? "¡Listo! Tus citas quedaron confirmadas. Te esperamos."
            : "¡Listo! Tu cita quedó confirmada. Te esperamos.",
    },
  })
  await audit(tx, orgId, null, "automation_job.confirmed", origin.id, {
    appointments: appointmentIds.length,
    confirmed,
    via: "respuesta",
  })
  return true
}

/** Lo que se sabe de un mensaje entrante que es el toque de un botón de un mensaje automático. */
export interface AutomationReply {
  kind: string
  /** Texto del botón, tal como lo vio la persona. */
  button: string
  /** Qué pide con ese botón; null si el botón no lo declara. */
  asks: "reservar" | "cambiar" | null
  /** Lo mismo dicho para quien sigue la conversación: de qué mensaje viene y qué quiere la persona. */
  hint: string
}

/**
 * Si el mensaje entrante es el toque de un botón «responder» de un mensaje
 * automático, dice de qué línea venía y qué pide la persona. Se reconoce sin
 * modelo: es la respuesta inmediata a ese mensaje y su texto es el del botón.
 * Así Recepción no tiene que adivinar si «Sí, otro horario» es mover una cita
 * o reservar una nueva: quien faltó o canceló ya no tiene esa cita en pie.
 */
export async function automationReplyOf(
  tx: Db,
  orgId: string,
  input: { conversationId: string; messageId: string },
): Promise<AutomationReply | null> {
  const [trigger] = await tx
    .select({ body: message.body, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.id, input.messageId), eq(message.organizationId, orgId), eq(message.conversationId, input.conversationId), eq(message.direction, "in")))
    .limit(1)
  const text = trigger?.body?.trim()
  if (!trigger || !text) return null
  // El mensaje anterior del hilo, sea de quien sea: si entre el automático y el
  // toque hubo otra cosa, ya no es una respuesta directa a ese botón.
  const [before] = await tx
    .select({ id: message.id, direction: message.direction, replyButtons: message.replyButtons })
    .from(message)
    .where(and(eq(message.conversationId, input.conversationId), eq(message.organizationId, orgId), sql`${message.createdAt} < ${trigger.createdAt.toISOString()}::timestamptz`))
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(1)
  if (!before || before.direction === "in") return null
  const tapped = (before.replyButtons ?? []).find((button) => button.title.trim() === text)
  const reply = tapped ? parseReplyId(tapped.id) : null
  if (!tapped || reply?.action !== "responder") return null
  const [origin] = await tx
    .select({ kind: automationJob.kind, sentMessageId: automationJob.sentMessageId })
    .from(automationJob)
    .where(and(eq(automationJob.id, reply.jobId), eq(automationJob.organizationId, orgId)))
    .limit(1)
  if (!origin || origin.sentMessageId !== before.id) return null
  const line = adminLineOf(origin.kind)
  const asks = automationMessageOf(origin.kind)?.buttons.find((button) => button.action === "responder" && button.title === tapped.title)?.asks ?? null
  const wants =
    asks === "reservar"
      ? "Quiere una cita nueva: lo de ese mensaje ya no está en pie como cita, así que no hay nada que mover. Ofrécele horarios; todavía no eligió ninguno."
      : asks === "cambiar"
        ? "Quiere cambiar o cancelar la cita de ese recordatorio, que sigue en pie."
        : "Sigue la conversación desde ahí."
  return {
    kind: origin.kind,
    button: tapped.title,
    asks,
    hint: `El interlocutor tocó el botón «${tapped.title}» del mensaje automático de la clínica${line ? ` por «${line.trigger(lineDays(null, origin.kind))}»` : ""}. ${wants}`,
  }
}

// ------------------------------------------------- mensajes aprobados ---

/**
 * Pide a WhatsApp, en cada conexión activa, los mensajes de la clínica que aún
 * no tiene: los siete con los que viene y los que haya creado, sin esperar a que
 * una línea se prenda. Al conectar ya se pidieron todos; este ciclo cubre lo
 * que faltó. Una solicitud que el proveedor no acepta se avisa una vez al día,
 * con su motivo, y se reintenta al día siguiente.
 */
export async function requestNeededTemplates(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
  now: Date,
  deps: TemplateDeps,
): Promise<number> {
  const connections = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
  let requested = 0
  for (const connection of connections) {
    const outcome = await requestMissingTemplates(tx, orgId, connection.id, secretsKey, now, deps)
    requested += outcome.requested
    const [first] = outcome.failed
    if (!first) continue
    const recipient = await failureRecipient(tx, orgId, null)
    if (!recipient) continue
    const many = outcome.failed.length
    await upsertWorkspaceNotification(tx, orgId, {
      userId: recipient,
      dedupeKey: `template-request:${connection.id}:${now.toISOString().slice(0, 10)}`,
      title:
        many === 1
          ? "WhatsApp no aceptó la solicitud de un mensaje"
          : `WhatsApp no aceptó la solicitud de ${many} mensajes`,
      body: `${many === 1 ? `«${first.title}». ` : ""}Motivo: ${first.detail}. Revisa en Configuración › Integraciones › WhatsApp que la clave pueda pedir mensajes. Se vuelve a pedir mañana.`,
      href: MESSAGES_HREF,
      permission: "settings.write",
    })
  }
  // Un cambio de texto que ya puede valer (aprobado, o sin WhatsApp) pasa a ser el vigente.
  await settleMessageTexts(tx, orgId)
  return requested
}

interface NoticeWords {
  title: string
  /** Mientras tanto, en un mensaje que envía el agente. */
  agent: string
  /** Mientras tanto, en uno que se envía desde la Bandeja. */
  inbox: string
}

const TEMPLATE_NOTICE: Partial<Record<string, NoticeWords>> = {
  aprobada: {
    title: "WhatsApp aprobó un mensaje",
    agent: "Ya puede salir a quien no escribió en las últimas 24 horas.",
    inbox: "Ya se puede enviar desde la Bandeja cuando pasaron las 24 horas.",
  },
  rechazada: {
    title: "WhatsApp rechazó un mensaje",
    agent: "Mientras tanto solo sale como respuesta o por correo. Cámbiale el texto para pedirlo de nuevo.",
    inbox: "Mientras tanto no se ofrece en la Bandeja. Cámbiale el texto para pedirlo de nuevo.",
  },
  pausada: {
    title: "WhatsApp pausó un mensaje",
    agent: "Mientras tanto solo sale como respuesta o por correo. WhatsApp lo reactiva solo si mejora su calidad.",
    inbox: "Mientras tanto no se ofrece en la Bandeja. WhatsApp lo reactiva solo si mejora su calidad.",
  },
  deshabilitada: {
    title: "WhatsApp retiró un mensaje",
    agent: "Mientras tanto solo sale como respuesta o por correo. Cámbiale el texto para pedirlo de nuevo.",
    inbox: "Mientras tanto no se ofrece en la Bandeja. Cámbiale el texto para pedirlo de nuevo.",
  },
}

/**
 * El proveedor avisó que una plantilla cambió de estado. Se actualiza el
 * catálogo, el cambio de texto que aprobó pasa a ser el vigente y quien
 * administra recibe un aviso por cambio de cualquier mensaje de la clínica (los
 * que envía el agente, «Retomar la conversación» y los que creó): cuál, el
 * motivo que da el proveedor y qué pasa mientras tanto. De un texto que ya fue
 * reemplazado no se avisa.
 */
export async function applyTemplateUpdates(
  tx: Db,
  orgId: string,
  connectionId: string,
  statuses: NormalizedTemplateStatus[],
): Promise<number> {
  const changes = await applyTemplateStatuses(tx, orgId, connectionId, statuses)
  if (changes.length === 0) return 0
  // Antes de dejar vigente lo aprobado: así se sabe si era un cambio en espera.
  const owners = new Map<string, Awaited<ReturnType<typeof messageOfTemplate>>>()
  for (const { template } of changes) owners.set(template.id, await messageOfTemplate(tx, orgId, template.name))
  await settleMessageTexts(tx, orgId)
  for (const { template } of changes) {
    await audit(tx, orgId, null, "channel_template.status", connectionId, {
      name: template.name,
      status: template.status,
      reason: template.reason,
    })
    const notice = TEMPLATE_NOTICE[template.status]
    const owner = owners.get(template.id)
    if (!notice || !owner || (!owner.isCurrent && !owner.isPending)) continue
    const recipient = await failureRecipient(tx, orgId, null)
    if (!recipient) continue
    const reason = templateReasonWords(template.reason)
    const why = reason ? `Motivo: ${reason}. ` : ""
    let title = `${notice.title}: «${owner.title}»`
    let body = `${why}${owner.origin === "agente" ? notice.agent : notice.inbox}`
    if (owner.isPending && !owner.isCurrent) {
      // Un cambio de texto: el anterior sigue saliendo hasta que aprueben el nuevo.
      if (template.status === "aprobada") {
        title = `WhatsApp aprobó tu cambio de texto: «${owner.title}»`
        body = "Desde ahora sale el texto nuevo."
      } else {
        title = `WhatsApp no aceptó tu cambio de texto: «${owner.title}»`
        body = `${why}Sigue saliendo el texto anterior. Puedes cambiarlo y pedirlo de nuevo.`
      }
    } else if (template.status !== "aprobada" && owner.origin === "agente") {
      // A cuántas personas les toca ya: las que tienen ese mensaje por salir en el próximo día.
      const [soon] = await tx.execute<{ n: number }>(sql`
        select count(distinct j.contact_id)::int as n from automation_job j
        where j.organization_id = ${orgId} and j.kind = ${owner.id} and j.status = 'pendiente'
          and j.scheduled_for <= now() + interval '24 hours'`)
      const n = Number(soon?.n ?? 0)
      if (n > 0) {
        body += ` ${n === 1 ? "1 persona lo tiene" : `${n} personas lo tienen`} por salir en las próximas 24 horas: a quien no le llegue lo verás con su motivo en Agente › Administrador.`
      }
    }
    await upsertWorkspaceNotification(tx, orgId, {
      userId: recipient,
      dedupeKey: `template-status:${template.id}:${template.status}`,
      title,
      body,
      href: MESSAGES_HREF,
      permission: "settings.write",
    })
  }
  return changes.length
}
