import { createHash, randomBytes } from "node:crypto"
import { isWhatsAppAccountFailure, type NormalizedTemplateStatus } from "@odentia/channels"
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
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm"
import { adminLineOf, DEFAULT_HOURS_BEFORE, type LineTiming, lineOfJobKind } from "./admin-lines.js"
import { confirmationReply, type ConfirmedItem } from "./appointment-confirm-words.js"
import { APPOINTMENT_CALENDAR_FILENAME, APPOINTMENT_CALENDAR_MIME, appointmentCalendarInvite } from "./appointment-calendar.js"
import { setAppointmentStatus } from "./appointments.js"
import {
  APPOINTMENT_DATA_NOTICE_KEY,
  REMINDER_DATA_KEY,
  APPOINTMENT_NOTICE_KEYS,
  type AppointmentNoticeKey,
  type AutomationMessage,
  automationMessageOf,
  CHOOSE_MESSAGES_LINK,
  isStopWord,
  optInReply,
  optOutReply,
  SWITCHABLE_PURPOSES,
  GENERAL_PERMISSION_NO,
  GENERAL_PERMISSION_QUESTION,
  GENERAL_PERMISSION_YES,
  generalPermissionButtons,
  isAppointmentNotice,
  parseReplyId,
  withLinkLine,
} from "./automation-messages.js"
import { type ComposedMessage, composeJobMessage, routeMessage } from "./automation-routing.js"
import { permissionRefusal, writingTimeFor } from "./message-gate.js"
import { consentStatusOf, mayWriteFirst } from "./message-permission.js"
import { issuePersonalLink } from "./booking-links.js"
import { answerBudgetButton } from "./budget-send.js"
import { applyTemplateStatuses, reviewConnectionTemplates, type TemplateDeps } from "./channel-templates.js"
import {
  currentAutomationMessage,
  currentAutomationMessageOf,
  MESSAGES_HREF,
  messageOfTemplate,
  requestMissingTemplates,
  settleMessageTexts,
  templateReasonWords,
} from "./clinic-messages.js"
import { deliverHeldReplies, sendOutbound, sendTemplateOutbound } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { patientCreditSql } from "./payments.js"
import { findOrgLocale, NEUTRAL_TIMEZONE } from "./locale.js"
import { lapsedToInvite, recordInvitation } from "./return-invites.js"
import { updateOpportunity } from "./opportunities.js"
import { getPatientMissingData } from "./patient-registration.js"
import { personalLinkRef } from "./personal-link-token.js"
import { listDecisionRecipients, patientAge } from "./responsibilities.js"
import { clinicOriginOf, personalLinkMessageUrl, personalLinkUrl, publicLinksConfigured } from "./public-links.js"
import { createTask, settleTask } from "./tasks.js"
import { upsertWorkspaceNotification } from "./workspace.js"
import { NOT_RECOVERY_KINDS, patientHasItsAppointment } from "./saas-actions.js"
import { getAgentSpendGate } from "./saas-terms.js"
import { nextWritingDay, sendTimeFor, writingScheduleOf } from "./writing-hours.js"
import type { Storage } from "./storage.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { productHooks } from "./products.js"

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

/** Los tipos de trabajo: los de cada línea y los avisos de cita de «Recordar la cita». */
const JOB_KINDS: readonly string[] = [...AUTOMATION_KINDS, ...APPOINTMENT_NOTICE_KEYS]

function assertJobKind(kind: string): string {
  if (!JOB_KINDS.includes(kind)) throw notFound("Línea del administrador")
  return kind
}

function assertPurpose(purpose: string): ConsentPurpose {
  if (!(CONSENT_PURPOSES as readonly string[]).includes(purpose))
    throw validation("Finalidad inválida")
  return purpose as ConsentPurpose
}

/**
 * El tipo de mensaje de un trabajo: el que declara su mensaje del catálogo (un
 * aviso de cita es `avisos` aunque sea de «Recordar la cita») y, sin mensaje,
 * el de su línea (ADR 0040).
 */
export function purposeOfKind(kind: string): ConsentPurpose {
  return automationMessageOf(kind)?.purpose ?? lineOfJobKind(kind)?.agent?.purpose ?? "seguimiento"
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
   * El vencimiento de la tarea que originó el caso (ISO). Si se atiende o se
   * reprograma antes de escribir, el caso ya no aplica.
   */
  dueAt?: string
  /** La tarea de la oportunidad que se retoma: la misma que queda si el agente no puede escribir. */
  taskId?: string
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
  if ("taskId" in value && typeof value.taskId === "string") payload.taskId = value.taskId
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
      throw validation("Elige al menos una parte: que Sofi escriba o que quede una tarea para el equipo")
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
 * si él y Recepción están encendidos. A qué hora escribe lo dice el «Horario
 * para escribir» (`writing-hours.ts`), el mismo para todo lo que sale solo.
 */
export interface AdminRuntime {
  adminOn: boolean
  receptionOn: boolean
  /** Se usó todo el saldo de prueba: los agentes no escriben y el caso queda para el equipo (ADR 0031). */
  agentsPaused: boolean
  /** La clínica llegó a su presupuesto del mes: Argos no escribe para recuperar; el mensaje espera (ADR 0085). */
  recoveryPaused: boolean
}

/** Por qué espera un mensaje para recuperar: la clínica llegó a su presupuesto del mes (ADR 0085). */
export const BUDGET_HOLD = "Espera: la clínica llegó a su presupuesto del mes"
/** Cada cuánto se mira otra vez si la clínica subió su presupuesto o empezó otro mes. */
const BUDGET_HOLD_MS = 60 * 60_000

export async function adminRuntime(tx: Db, orgId: string): Promise<AdminRuntime> {
  const [row] = await tx
    .select({ enabled: agentConfig.enabled, advisor: agentConfig.advisor })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  const gate = await getAgentSpendGate(tx, orgId)
  return {
    adminOn: row?.advisor?.enabled === true,
    receptionOn: row?.enabled === true,
    agentsPaused: gate.trialExhausted,
    recoveryPaused: gate.capReached,
  }
}

// ----------------------------------------------------- permiso de mensajes ---

export type ConsentRow = typeof automationConsent.$inferSelect

/**
 * Lo que la persona dijo de cada tipo de mensaje (ADR 0030, precisado por
 * 0040). Los tres primeros son los interruptores de «Tus mensajes»:
 * recordatorios y seguimiento no piden permiso (solo cuenta si los apagó) y
 * novedades pide su sí. «avisos» es la fila fija de lo que pasó con su cita y
 * sus papeles: solo se apaga con «No quiero ningún mensaje de la clínica».
 */
export const MESSAGE_PERMISSIONS = ["recordatorio", "seguimiento", "novedades", "avisos"] as const
export type MessagePermissionKey = (typeof MESSAGE_PERMISSIONS)[number]

/** Lo que deja de recibir quien se da de baja, dicho a la persona: qué es y qué incluye. */
export interface UnsubscribeWords {
  /** «los recordatorios de tus citas»: completa «Dejar de recibir…» y «Ya no recibirás…». */
  what: string
  detail: string
  /** Lo que sigue llegando; null si la baja apaga todo lo que la clínica envía. */
  keeps: string | null
}

/**
 * Cómo se nombra cada tipo de mensaje cuando la persona se da de baja. La baja
 * apaga el tipo del mensaje del que salió el enlace, y no los demás: la página
 * dice cuál, sin hablar de autorizaciones ni de campañas (ADR 0030 y 0040).
 */
export const UNSUBSCRIBE_WORDS: Record<MessagePermissionKey, UnsubscribeWords> = {
  recordatorio: {
    what: "los recordatorios de tus citas",
    detail: "Son los recordatorios de un día antes y unas horas antes de tu cita.",
    keeps: "Si tu cita se reserva, cambia o se cancela, te avisamos igual.",
  },
  seguimiento: {
    what: "los mensajes de controles y seguimiento",
    detail: "Son los avisos de tu próximo control y los mensajes cuando faltaste a una cita o se canceló.",
    keeps: "Los recordatorios y los avisos de tus citas siguen llegando.",
  },
  novedades: {
    what: "las novedades y promociones",
    detail: "Son las campañas y ofertas de la clínica, y los mensajes para retomar un presupuesto o una consulta.",
    keeps: "Los recordatorios y los avisos de tus citas siguen llegando.",
  },
  avisos: {
    what: "todos los mensajes de la clínica",
    detail: "También los avisos de tus citas y de tus papeles.",
    keeps: null,
  },
}

/** Un enlace de baja que no viene de un mensaje concreto apaga los tres interruptores; los avisos siguen. */
const UNSUBSCRIBE_ALL_WORDS: UnsubscribeWords = {
  what: "los mensajes que la clínica te envía por su cuenta",
  detail: "Son los recordatorios de tus citas, los controles y el seguimiento, y las novedades y promociones.",
  keeps: "Si tu cita se reserva, cambia o se cancela, te avisamos igual.",
}

export function unsubscribeWords(purposes: readonly ConsentPurpose[]): UnsubscribeWords {
  return purposes.length === 1 && purposes[0] ? UNSUBSCRIBE_WORDS[purposes[0]] : UNSUBSCRIBE_ALL_WORDS
}

export interface MessagePermission {
  purpose: MessagePermissionKey
  /** null: nunca se le preguntó ni lo cambió. */
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
 * Lo que la persona dijo de cada tipo de mensaje, para su página y para «Tus
 * mensajes»: siempre las cuatro filas, con cómo y cuándo quedó cada una.
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

/** Los tipos de trabajo que escriben un mensaje de ese tipo: los que deja de recibir quien lo apaga. */
function messageKindsOf(purpose: ConsentPurpose): string[] {
  return JOB_KINDS.filter((kind) => (automationMessageOf(kind) || lineOfJobKind(kind)?.agent) && purposeOfKind(kind) === purpose)
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
          inArray(automationJob.kind, messageKindsOf(purpose)),
        ),
      )
  }
  return row
}

/** Qué tipo de mensaje elige la persona: uno de los tres interruptores o «ningún mensaje». */
export const MESSAGE_CHOICES = [...SWITCHABLE_PURPOSES, "ninguno"] as const
export type MessageChoice = (typeof MESSAGE_CHOICES)[number]

/**
 * «Tus mensajes» (ADR 0040): la única operación que cambia lo que una persona
 * recibe, venga de su página en «Su enlace», de recepción (Datos › Mensajes),
 * del agente o de «BAJA». Apagar un interruptor apaga ese tipo; encender uno
 * vuelve a encender los avisos si había pedido «ningún mensaje». «Ninguno»
 * apaga los cuatro (también los avisos de sus citas y papeles) y, al
 * deshacerlo, vuelven los avisos, los recordatorios y el seguimiento: las
 * novedades solo con su sí. Devuelve los tipos que cambió.
 */
export async function setMessageChoice(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { choice: string; receive: boolean; source: string },
): Promise<{ purposes: ConsentPurpose[] }> {
  if (!(MESSAGE_CHOICES as readonly string[]).includes(input.choice)) throw validation("Tipo de mensaje inválido")
  const choice = input.choice as MessageChoice
  const set = (purpose: ConsentPurpose, granted: boolean) =>
    setConsent(tx, orgId, actorUserId, contactId, { purpose, granted, source: input.source })
  const purposes: ConsentPurpose[] =
    choice === "ninguno"
      ? input.receive
        ? ["avisos", "recordatorio", "seguimiento"]
        : ["recordatorio", "seguimiento", "novedades", "avisos"]
      : [choice]
  for (const purpose of purposes) await set(purpose, input.receive)
  // Quien pidió no recibir nada y enciende un tipo vuelve a recibir los avisos de su cita.
  if (choice !== "ninguno" && input.receive && (await consentStatusOf(tx, orgId, contactId, "avisos")) === "revoked") {
    await set("avisos", true)
    purposes.push("avisos")
  }
  return { purposes }
}

export { mayWriteFirst } from "./message-permission.js"

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

// ------------------------------ novedades y promociones: la pregunta tras reservar ---

/**
 * ¿Ya se le preguntó si acepta novedades y promociones? Lo dice su historia: un mensaje con
 * los botones de la pregunta en cualquiera de sus conversaciones.
 */
async function generalPermissionAsked(tx: Db, orgId: string, contactId: string): Promise<boolean> {
  const [row] = await tx.execute<{ asked: boolean }>(sql`
    select exists (
      select 1 from message m join conversation c on c.id = m.conversation_id and c.organization_id = m.organization_id
      where m.organization_id = ${orgId} and c.contact_id = ${contactId} and m.direction = 'out'
        and m.reply_buttons is not null
        and exists (select 1 from jsonb_array_elements(m.reply_buttons) b where b->>'id' like 'odentia:permiso_%')
    ) as asked`)
  return row?.asked === true
}

/**
 * Tras reservar en la conversación, el agente pregunta una sola vez por persona
 * si se le pueden enviar novedades y promociones (`novedades`, el único tipo de
 * mensaje que pide permiso; ADR 0030). No pregunta si ya lo dio o lo negó, ni si ya se le
 * preguntó: sin respuesta tampoco se vuelve a preguntar. Solo si en esta
 * conversación se reservó una cita desde `since`. Devuelve si la preguntó.
 */
export async function askGeneralPermissionAfterBooking(
  tx: Db,
  orgId: string,
  input: { conversationId: string; since: Date },
): Promise<boolean> {
  const [thread] = await tx
    .select({ contactId: conversation.contactId, status: conversation.status })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!thread || thread.status !== "open") return false
  const [booked] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.conversationId, input.conversationId),
        gte(appointment.createdAt, input.since),
        inArray(appointment.status, ["programada", "confirmada"]),
      ),
    )
    .limit(1)
  if (!booked) return false
  if ((await consentStatusOf(tx, orgId, thread.contactId, "novedades")) !== null) return false
  if (await generalPermissionAsked(tx, orgId, thread.contactId)) return false
  await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "agent",
    content: { type: "text", text: GENERAL_PERMISSION_QUESTION, buttons: generalPermissionButtons(thread.contactId) },
  })
  await audit(tx, orgId, null, "automation_consent.asked", thread.contactId, { purpose: "novedades", conversationId: input.conversationId })
  return true
}

/**
 * La persona responde a la pregunta de novedades y promociones, con su botón o por
 * escrito (la herramienta del agente). Solo vale si se le preguntó y aún no
 * lo dio ni lo negó: queda con origen «conversación» y su fecha (`setConsent`).
 */
export async function answerGeneralPermission(
  tx: Db,
  orgId: string,
  input: { conversationId: string; granted: boolean },
): Promise<"guardado" | "ya_respondio" | "no_preguntado"> {
  const [thread] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!thread) throw notFound("Conversación")
  if (!(await generalPermissionAsked(tx, orgId, thread.contactId))) return "no_preguntado"
  if ((await consentStatusOf(tx, orgId, thread.contactId, "novedades")) !== null) return "ya_respondio"
  await setConsent(tx, orgId, null, thread.contactId, { purpose: "novedades", granted: input.granted, source: "conversacion" })
  return "guardado"
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
 * A quienes administran la clínica (dueña y administradores): un aviso de WhatsApp
 * llega a todos, no a uno elegido sin orden, porque quien lo corrige puede ser cualquiera.
 */
export async function failureRecipients(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .orderBy(asc(member.createdAt), asc(member.userId))
  return [...new Set(rows.map((row) => row.userId))]
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
 * Lo de una persona de prueba no sale hacia afuera (ADR 0094): ni recordatorios,
 * ni avisos, ni seguimientos. Es el único filtro de todas las líneas: cada una
 * anota sus casos con `enqueueJob`.
 */
async function jobForTestPerson(tx: Db, orgId: string, input: EnqueueInput): Promise<boolean> {
  if (!input.contactId && !input.appointmentId && !input.patientId && !input.opportunityId && !input.budgetId) return false
  const rows = (await tx.execute(sql`select (
       exists (select 1 from contact c where c.organization_id = ${orgId} and c.id = ${input.contactId ?? null}::uuid and c.is_test)
    or exists (select 1 from appointment a where a.organization_id = ${orgId} and a.id = ${input.appointmentId ?? null}::uuid and a.is_test)
    or exists (select 1 from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
               where p.organization_id = ${orgId} and p.id = ${input.patientId ?? null}::uuid and pp.is_test)
    or exists (select 1 from opportunity o join contact oc on oc.organization_id = o.organization_id and oc.id = o.contact_id
               where o.organization_id = ${orgId} and o.id = ${input.opportunityId ?? null}::uuid and oc.is_test)
  ) as test`)) as unknown as Array<{ test: boolean }>
  return rows[0]?.test === true
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
  assertJobKind(input.kind)
  if (await jobForTestPerson(tx, orgId, input)) return null
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
 * A quién se le escribe lo de un paciente (recordatorios, avisos de la cita y
 * recontactos), siempre la misma para el mismo paciente:
 * 1. otra persona que el equipo marcó como preferida (la abuela que lo trae);
 * 2. siendo menor de edad, su representante legal vigente, el mismo de sus
 *    presupuestos y recetas (`listDecisionRecipients`): un niño no confirma ni
 *    lleva a nadie a la cita, y sus datos de salud los gestiona su
 *    representante (Ley 29733). Su propio vínculo «preferido» no le gana: lo
 *    pone el registro solo. Al cumplir 18 la representación termina y le
 *    escribe a él;
 * 3. el propio paciente;
 * 4. si no, el primero vinculado.
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
  const chosen = rows.find((r) => r.isPreferred && r.relationship !== "self")
  if (chosen) return chosen.contactId
  if ((await patientAge(tx, orgId, patientId)).isMinor) {
    const [representative] = await listDecisionRecipients(tx, orgId, patientId)
    if (representative) return representative.contactId
  }
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

/** Lo que queda anotado cuando un recordatorio ya no tiene momento para salir dentro del horario. */
const OUTSIDE_WRITING_HOURS_LATE = "Fuera del horario de recontacto y ya sin una hora de margen antes de la cita"

/** Cuándo empieza la cita de un trabajo, para no recordarla con menos de una hora de margen. */
async function appointmentStartOf(tx: Db, orgId: string, appointmentId: string | null): Promise<Date | null> {
  if (!appointmentId) return null
  const [row] = await tx
    .select({ startsAt: appointment.startsAt })
    .from(appointment)
    .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
    .limit(1)
  return row?.startsAt ?? null
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
 * Cita que sigue sin confirmar después del primer recordatorio de «Recordar la
 * cita»: en pie, por venir, sin confirmar y con un recordatorio que ya salió.
 * La insistencia del agente es el aviso siguiente (tres horas antes); además
 * la cita aparece en «Te espera» como «<Nombre> no confirmó · llamar», para
 * que alguien llame con tiempo. `appt` es la tabla o el alias de `appointment`.
 */
export function remindedUnconfirmedSql(appt: SQL): SQL {
  return sql`(${appt}.status = 'programada' and ${appt}.starts_at > now() and exists (select 1 from automation_job j_rem
    where j_rem.organization_id = ${appt}.organization_id and j_rem.appointment_id = ${appt}.id
      and j_rem.kind = 'recordatorio_cita' and j_rem.status = 'enviado'))`
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
  // tenga más citas que el tope. «Todos» son los que aún caben: a una cita de
  // mañana ya no le toca el de 24 horas, y no por eso se vuelve a elegir cada ciclo.
  const fitting = sql.join(hoursList.map((hours) => sql`(${hours}::numeric)`), sql`, `)
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
          where j.organization_id = ${orgId} and j.rule_id = ${rule.id} and j.kind = 'recordatorio_cita'
            and j.appointment_id = ${appointment.id})
          < (select count(*) from (values ${fitting}) as hh(h)
              where ${appointment.startsAt} - hh.h * interval '1 hour' >= ${now.toISOString()}::timestamptz - interval '30 minutes')`,
      ),
    )
    .orderBy(asc(appointment.startsAt), asc(appointment.id))
    .limit(BATCH_LIMIT)
  for (const appt of upcoming) {
    const contactId = await preferredContact(tx, orgId, appt.patientId)
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
    // El «Horario de recontacto» se mide con la hora de la sede de la cita.
    const timeZone = await timezoneOf(tx, orgId, appt.branchId)
    const schedule = await writingScheduleOf(tx, orgId, timeZone)
    for (const h of hoursList) {
      const target = new Date(appt.startsAt.getTime() - h * 3_600_000)
      if (target.getTime() < now.getTime() - 30 * 60_000) continue
      // Fuera del horario sale en el último momento permitido antes; si no hay,
      // en el primero después con una hora de margen antes de la cita.
      const scheduledFor = sendTimeFor(target, now, schedule, appt.startsAt)
      if (!scheduledFor) continue
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "recordatorio_cita",
        dedupeKey: `recordatorio_cita:${appt.id}:${h}`,
        scheduledFor,
        contactId,
        appointmentId: appt.id,
        patientId: appt.patientId,
        payload: { timeZone },
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
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
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
 * oportunidad y el vencimiento de su tarea, en milisegundos. Si se reprograma y
 * vuelve a vencer, es otro caso.
 */
const OPPORTUNITY_DUE_KEY = sql<string>`(${opportunity.id}::text || ':' || floor(extract(epoch from ${crmTask.dueAt}) * 1000)::bigint::text)`

/**
 * Casos de «Retomar una oportunidad»: oportunidades abiertas cuya tarea (su
 * próxima acción, una sola) venció con la línea ya prendida. A quien tenía la
 * tarea vencida desde antes de prenderla no se le escribe.
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
      taskId: crmTask.id,
      dueAt: crmTask.dueAt,
    })
    .from(opportunity)
    .innerJoin(
      crmTask,
      and(
        eq(crmTask.organizationId, opportunity.organizationId),
        eq(crmTask.opportunityId, opportunity.id),
        eq(crmTask.status, "open"),
      ),
    )
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.status, "open"),
        lte(crmTask.dueAt, now),
        gte(crmTask.dueAt, activeSince(rule)),
        notYetQueued(orgId, "seguimiento_comercial", OPPORTUNITY_DUE_KEY),
      ),
    )
    .orderBy(asc(crmTask.dueAt), asc(opportunity.id))
    .limit(BATCH_LIMIT)
  for (const opp of due) {
    if (!opp.dueAt) continue
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "seguimiento_comercial",
      dedupeKey: `seguimiento_comercial:${opp.key}`,
      scheduledFor: now,
      contactId: opp.contactId,
      opportunityId: opp.id,
      payload: {
        dueAt: opp.dueAt.toISOString(),
        taskId: opp.taskId,
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
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
    const timeZone = await timezoneOf(tx, orgId, appt.branchId)
    const at = hour === undefined ? now : nextDayAt(appt.endsAt, timeZone, hour)
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "seguimiento_no_asistencia",
      dedupeKey: `seguimiento_no_asistencia:${appt.id}`,
      scheduledFor: sendTimeFor(at, now, await writingScheduleOf(tx, orgId, timeZone)) ?? (at < now ? now : at),
      contactId,
      appointmentId: appt.id,
      patientId: appt.patientId,
      payload: { timeZone },
    })
    if (job) programados++
  }
  return { programados, omitidos }
}

/**
 * Casos de «Invitar a volver» (decisión 15): quien no viene hace 6 meses, sin
 * cita ni pendientes y sin invitación reciente. Un caso por ciclo: la clave
 * cambia con la última visita y con cuántas veces se la invitó.
 */
export async function syncLapsedInvites(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rule = await enabledLine(tx, orgId, "invitar_a_volver")
  let programados = 0
  let omitidos = 0
  if (!rule) return { programados, omitidos }
  const { timezone } = await findOrgLocale(tx, orgId)
  // Solo quienes cumplieron los meses sin venir desde que se prendió: lo anterior no cuenta (como en las demás líneas).
  for (const row of await lapsedToInvite(tx, orgId, timezone, now, { limit: BATCH_LIMIT, since: activeSince(rule) })) {
    const contactId = await preferredContact(tx, orgId, row.patientId)
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
    const job = await enqueueJob(tx, orgId, {
      ruleId: rule.id,
      kind: "invitar_a_volver",
      dedupeKey: `invitar_a_volver:${row.patientId}:${row.appointmentId}:${row.invites}`,
      scheduledFor: sendTimeFor(now, now, await writingScheduleOf(tx, orgId, timezone)) ?? now,
      contactId,
      appointmentId: row.appointmentId,
      patientId: row.patientId,
      payload: { timeZone: timezone },
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
        // «Recordar la cita» ya le avisó la cancelación con la misma pregunta: no se repite.
        sql`not exists (select 1 from automation_job a where a.organization_id = ${orgId}
          and a.appointment_id = ${appointment.id} and a.kind = 'aviso_cita_cancelada' and a.status = 'enviado')`,
      ),
    )
    .orderBy(asc(appointment.updatedAt), asc(appointment.id))
    .limit(BATCH_LIMIT)
  for (const appt of cancelled) {
    const contactId = await preferredContact(tx, orgId, appt.patientId)
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
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
    // Sin a quién escribirle el caso se anota igual: al atenderlo queda como «no pude» (sin_destino)
    // con su tarea, y no vuelve a ocupar el lote en cada ciclo.
    if (!contactId) omitidos++
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

/** Estados de una cita, de un presupuesto y de un control con palabras: nunca su código. */
const APPOINTMENT_STATUS_WORDS: Record<string, string> = {
  programada: "programada",
  confirmada: "confirmada",
  atendida: "atendida",
  no_asistio: "marcada como «no vino»",
  cancelada: "cancelada",
}
const BUDGET_STATUS_WORDS: Record<string, string> = {
  aceptado: "aceptado",
  parcial: "aceptado en parte",
  rechazado: "rechazado",
  pospuesto: "pospuesto",
  sustituido: "reemplazado por otro",
  cancelado: "anulado",
  borrador: "por enviar",
}
const CONTROL_STATUS_WORDS: Record<string, string> = {
  realizado: "hecho",
  cancelado: "cancelado",
  pendiente: "pendiente",
  programado: "agendado",
}

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
      return { valid: false, reason: `La cita ya está ${APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status}` }
    }
    if (appt.startsAt.getTime() < now.getTime() - 60_000) {
      return { valid: false, reason: "La cita ya pasó" }
    }
    return { valid: true }
  }
  if (isAppointmentNotice(job.kind) && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    if (appt.startsAt.getTime() < now.getTime()) return { valid: false, reason: "La cita ya pasó" }
    if (job.kind === "aviso_cita_cancelada") {
      if (appt.status !== "cancelada") return { valid: false, reason: `La cita ya está ${APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status}` }
      if (job.patientId && (await hasFutureAppointment(tx, orgId, job.patientId, now))) {
        return { valid: false, reason: "Ya tiene otra cita reservada" }
      }
      return { valid: true }
    }
    if (!["programada", "confirmada"].includes(appt.status)) {
      return { valid: false, reason: `La cita ya está ${APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status}` }
    }
    return { valid: true }
  }
  if (job.kind === "invitar_a_volver" && job.patientId) {
    const { timezone } = await findOrgLocale(tx, orgId)
    const [still] = await lapsedToInvite(tx, orgId, timezone, now, { patientId: job.patientId, limit: 1 })
    if (!still) return { valid: false, reason: "Ya no toca invitarla: volvió, tiene una cita o ya la invitaron" }
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
      return { valid: false, reason: `El presupuesto ya está ${BUDGET_STATUS_WORDS[budget.status] ?? budget.status}` }
    }
    return { valid: true }
  }
  if (job.kind === "seguimiento_no_asistencia" && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    // Llegó tarde y se recuperó la cita: ya no está «no vino».
    if (appt.status !== "no_asistio") return { valid: false, reason: `La cita ya está ${APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status}` }
    // Vino a la clínica por otra cita ese día o después: no se le escribe que no la vimos (ADR 0032).
    if (job.patientId && (await arrivedSince(tx, orgId, job.patientId, new Date(appt.startsAt.getTime() - ARRIVAL_SAME_VISIT_MS)))) {
      return { valid: false, reason: "Vino a la clínica por otra cita" }
    }
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
    if (appt.status !== "cancelada") return { valid: false, reason: `La cita ya está ${APPOINTMENT_STATUS_WORDS[appt.status] ?? appt.status}` }
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
        return { valid: false, reason: `El control ya está ${CONTROL_STATUS_WORDS[control.status] ?? control.status}` }
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
      .select({ status: opportunity.status, contactActive: contact.isActive })
      .from(opportunity)
      .innerJoin(contact, and(eq(contact.id, opportunity.contactId), eq(contact.organizationId, opportunity.organizationId)))
      .where(and(eq(opportunity.id, job.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (!opp || opp.status !== "open") return { valid: false, reason: "La oportunidad ya se cerró" }
    if (!opp.contactActive) return { valid: false, reason: "El contacto está archivado" }
    // Su tarea ya se hizo o se reprogramó antes de escribir: lo decidió una persona.
    const { dueAt, taskId } = jobPayloadOf(job.payload)
    const [task] = await tx
      .select({ status: crmTask.status, dueAt: crmTask.dueAt })
      .from(crmTask)
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.opportunityId, job.opportunityId),
          taskId ? eq(crmTask.id, taskId) : eq(crmTask.status, "open"),
        ),
      )
      .limit(1)
    const stillDue = !!task && task.status === "open" && !!task.dueAt &&
      (dueAt ? task.dueAt.getTime() === Date.parse(dueAt) : task.dueAt.getTime() <= now.getTime())
    if (!stillDue) return { valid: false, reason: "La tarea de la oportunidad ya se hizo o se reprogramó" }
    return { valid: true }
  }
  if (job.kind === "atenciones_sin_firmar") {
    const encounterId = job.dedupeKey.split(":")[1] ?? ""
    if (/^[0-9a-f-]{36}$/i.test(encounterId)) {
      const [row] = await tx.execute<{ status: string }>(sql`
        select status from encounter where id = ${encounterId} and organization_id = ${orgId}`)
      if (!row) return { valid: false, reason: "La atención ya no existe" }
      if (row.status !== "borrador") return { valid: false, reason: "La atención ya se firmó" }
    }
    return { valid: true }
  }
  if (job.kind === "cobranza_vencida" && job.patientId) {
    const currency = job.dedupeKey.split(":")[2] ?? ""
    // Lo que debe, por moneda, menos lo que tiene a favor en esa moneda
    // (decisión 22): si lo que tiene a favor alcanza, ya no hay saldo vencido.
    const [row] = await tx.execute<{ owed: number }>(sql`
      select coalesce(max(d.owed), 0)::int as owed from (
        select sum(c.amount_cents - coalesce((select sum(a.amount_cents) from patient_payment_application a
          where a.charge_id = c.id and a.organization_id = c.organization_id and a.voided_at is null), 0))
          - greatest(${patientCreditSql(orgId, sql`c.patient_id`, sql`c.currency`)}, 0) as owed
        from patient_charge c
        where c.organization_id = ${orgId} and c.patient_id = ${job.patientId} and c.voided_at is null
          and (${currency} = '' or c.currency = ${currency})
        group by c.patient_id, c.currency
      ) d`)
    if (Number(row?.owed ?? 0) <= 0) return { valid: false, reason: "Ya pagó lo que debía" }
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

/** Una llegada hasta 12 horas antes de la cita perdida es de la misma jornada. */
const ARRIVAL_SAME_VISIT_MS = 12 * 3_600_000

/** La persona llegó a alguna cita desde ese momento («Llegó», ADR 0032). */
async function arrivedSince(tx: Db, orgId: string, patientId: string, since: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        gte(appointment.arrivedAt, since),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Los mensajes para recuperar que esperan porque la clínica llegó a su
 * presupuesto del mes (ADR 0085), por línea: lo que dice el panel de Argos.
 */
export async function listBudgetHeldJobs(tx: Db, orgId: string): Promise<Array<{ kind: string; count: number }>> {
  return tx
    .select({ kind: automationJob.kind, count: sql<number>`count(*)::int` })
    .from(automationJob)
    .where(and(eq(automationJob.organizationId, orgId), eq(automationJob.status, "pendiente"), eq(automationJob.lastError, BUDGET_HOLD)))
    .groupBy(automationJob.kind)
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

/**
 * El aviso de reserva (o el recordatorio) con «Su enlace» cuando al paciente
 * de la cita le faltan datos para atenderlo: el enlace de quien recibe el
 * aviso, con esa cita. Sin dirección pública configurada sale el de siempre.
 */
async function dataNoticeFor(
  tx: Db,
  orgId: string,
  job: typeof automationJob.$inferSelect,
  contactId: string,
  deps: DeliverDeps,
  key: typeof APPOINTMENT_DATA_NOTICE_KEY | typeof REMINDER_DATA_KEY = APPOINTMENT_DATA_NOTICE_KEY,
): Promise<{ spec: AutomationMessage; link: { token: string; url: string } } | null> {
  if (!job.appointmentId || !publicLinksConfigured()) return null
  const [row] = await tx
    .select({ patientId: appointment.patientId })
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, job.appointmentId)))
    .limit(1)
  if (!row) return null
  if ((await getPatientMissingData(tx, orgId, row.patientId)).length === 0) return null
  const issued = await issuePersonalLink(
    tx,
    orgId,
    { contactId, patientId: row.patientId, appointmentId: job.appointmentId },
    { secretsKey: deps.secretsKey },
  )
  // En el mensaje no queda el token: lo pone el worker al enviarlo.
  const url = await personalLinkMessageUrl(tx, orgId, issued.linkId)
  if (!url) return null
  return {
    spec: await currentAutomationMessage(tx, orgId, key),
    link: { token: personalLinkRef(issued.linkId), url },
  }
}

export interface DeliverDeps {
  secretsKey: Buffer
  /** Para adjuntar la invitación de calendario a los avisos de cita por correo; sin él, va solo el texto. */
  storage?: Storage
  /**
   * Origen de los enlaces del correo cuando no hay dirección pública de la
   * clínica configurada (`configurePublicLinks`); con ella, van en la clínica.
   */
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
const DEFINITIVE_CODES = new Set(["WINDOW_CLOSED", "CHANNEL_REQUIRES_INBOUND", "VALIDATION", "TEMPLATE_IS_PROMOTION"])

function isDefinitiveCode(code: string | undefined): boolean {
  return !!code && DEFINITIVE_CODES.has(code)
}

/**
 * Por qué no se le pudo escribir a una persona y cómo se habilita, dicho de
 * una persona (`one`) y de varias (`many`). Lo usan el aviso al equipo, la
 * tarea de respaldo y la lista de «no pude» de Inicio.
 */
export const CAUSE_WORDS: Record<AutomationCause, { one: string; many: string; fix: string; fixMany: string }> = {
  // Lo de su atención no pide permiso (ADR 0030): este motivo es su baja de ese
  // tipo de mensaje (o, en una línea de novedades, que no las aceptó).
  sin_permiso: {
    one: "pidió no recibir este tipo de mensaje",
    many: "pidieron no recibir este tipo de mensaje",
    fix: "Si cambia de opinión, anótalo en su página, en Datos › Mensajes.",
    fixMany: "Si cambian de opinión, anótalo en su página, en Datos › Mensajes.",
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
    fix: "Sale cuando WhatsApp apruebe el mensaje: míralo en Configuración › Integraciones › WhatsApp. Agregar su correo también lo habilita.",
    fixMany: "Empieza a salir cuando WhatsApp apruebe el mensaje: míralo en Configuración › Integraciones › WhatsApp. Agregar su correo también lo habilita.",
  },
  promocion: {
    one: "WhatsApp cuenta el mensaje como promoción y no aceptó novedades",
    many: "WhatsApp cuenta el mensaje como promoción y no aceptaron novedades",
    fix: "Cambia el texto para que sea solo el aviso, o agrega su correo.",
    fixMany: "Para habilitarlo, cambia el texto del mensaje para que sea solo el aviso, o agrega su correo.",
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

/**
 * Las palabras de un motivo según el tipo de mensaje. En las novedades y promociones
 * «sin permiso» casi siempre es que nunca las aceptó, no que pidió no recibirlas.
 */
export function causeWordsFor(cause: AutomationCause, purpose: ConsentPurpose): (typeof CAUSE_WORDS)[AutomationCause] {
  if (cause === "sin_permiso" && purpose === "novedades") {
    return {
      one: "no aceptó novedades y promociones",
      many: "no aceptaron novedades y promociones",
      fix: "Si acepta, anótalo en su página, en Datos › Mensajes.",
      fixMany: "Si aceptan, anótalo en sus páginas, en Datos › Mensajes.",
    }
  }
  return CAUSE_WORDS[cause]
}

/** Motivo de un fallo definitivo según el código que devuelve el envío. */
function causeOfCode(code: string | undefined): AutomationCause {
  if (code === "TEMPLATE_IS_PROMOTION") return "promocion"
  return code === "WINDOW_CLOSED" || code === "CHANNEL_REQUIRES_INBOUND" || code === "VALIDATION"
    ? "sin_plantilla"
    : "proveedor"
}

/** Margen para juntar recordatorios que vencen casi a la vez. */
const GROUP_WINDOW_MS = 30 * 60_000

/**
 * El correo no tiene botones: lleva el mismo texto y, en su lugar, enlaces.
 * Un recordatorio trae los de confirmar y cancelar cada cita. Al pie va «Elegir
 * mis mensajes» (su página «Tus mensajes», ADR 0040) y, si no hay dirección
 * para ella, el de darse de baja de ese tipo de mensaje; la baja de un toque va
 * además en la cabecera `List-Unsubscribe`. La primera línea es el asunto.
 */
function emailBody(
  message: ComposedMessage,
  clinic: string,
  links: { appointments: { confirm: string; cancel: string }[]; optOut: string | null; choose: string | null },
): string {
  const lines = links.appointments.map((link, index) => {
    const which = links.appointments.length > 1 ? `Cita ${index + 1}. ` : ""
    return `${which}Para confirmar: ${link.confirm}\n${which}Si no podrás ir: ${link.cancel}`
  })
  const actions = lines.length > 0 ? `\n\n${lines.join("\n")}` : ""
  const footer = links.choose
    ? `\n\n${CHOOSE_MESSAGES_LINK.title}: ${links.choose}`
    : links.optOut
      ? `\n\nSi no quieres recibir más estos mensajes: ${links.optOut}`
      : ""
  return `${message.subject}\n\n${message.text}${actions}\n\nPuedes responder a este correo.\n\n${clinic}${footer}`
}

/** Fin del día siguiente en la zona dada: el plazo de una tarea que deja el Administrador. */
function endOfTomorrow(now: Date, timeZone: string): Date {
  const hourNow = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  )
  return new Date(now.getTime() + (48 - hourNow) * 3_600_000 - (now.getMinutes() * 60_000 + now.getSeconds() * 1000))
}

/**
 * Las tareas se cierran solas cuando su motivo desaparece (ADR 0028), con una
 * sola regla para todas: la de una oportunidad que ya se cerró, y la que dejó
 * el Administrador cuando su caso ya no aplica (`stillValid`: la cita pasó o se
 * confirmó, el presupuesto se decidió, ya tiene otra cita, ya pagó, la
 * atención se firmó). La tarea de «Retomar una oportunidad» es la de la
 * oportunidad: sigue mientras la oportunidad siga abierta. No toca las tareas
 * de un caso del agente ni las que dejó una persona. Corre en cada ciclo del
 * worker, aunque el Administrador esté apagado. Devuelve cuántas cerró.
 */
export async function settleTasks(
  tx: Db,
  orgId: string,
  now: Date,
  opts: { batch?: number; perCycle?: number } = {},
): Promise<number> {
  const batch = opts.batch ?? BATCH_LIMIT
  const perCycle = opts.perCycle ?? SETTLE_PER_CYCLE
  let settled = 0
  const ofClosed = await tx
    .select({ id: crmTask.id, status: opportunity.status })
    .from(crmTask)
    .innerJoin(opportunity, and(eq(opportunity.id, crmTask.opportunityId), eq(opportunity.organizationId, crmTask.organizationId)))
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.status, "open"), sql`${opportunity.status} <> 'open'`))
    .limit(BATCH_LIMIT)
  for (const row of ofClosed) {
    if (await settleTask(tx, orgId, row.id, row.status === "won" ? "la oportunidad se ganó" : "la oportunidad se perdió")) settled++
  }
  // Las que dejó el Administrador se revisan avanzando con un cursor: las que
  // siguen en pie no tapan a las siguientes. Cada ciclo sigue donde quedó el
  // anterior y, al llegar al final, vuelve a empezar.
  let cursor = settleCursors.get(orgId) ?? null
  let checked = 0
  let wrapped = false
  while (checked < perCycle) {
    const size = Math.min(batch, perCycle - checked)
    const left = await tx
      .select({
        job: automationJob,
        taskId: crmTask.id,
        // Con sus microsegundos: el cursor no vuelve a tomar la misma tarea.
        createdAt: sql<string>`${crmTask.createdAt}::text`,
        name: sql<string | null>`coalesce(${patientPerson.displayName}, ${contact.displayName})`,
      })
      .from(crmTask)
      .innerJoin(automationJob, and(eq(automationJob.organizationId, crmTask.organizationId), eq(automationJob.taskId, crmTask.id)))
      .leftJoin(patient, and(eq(patient.id, crmTask.patientId), eq(patient.organizationId, crmTask.organizationId)))
      .leftJoin(patientPerson, joinPatientPerson(patientPerson))
      .leftJoin(contact, and(eq(contact.id, crmTask.contactId), eq(contact.organizationId, crmTask.organizationId)))
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.status, "open"),
          eq(crmTask.createdBy, "admin"),
          sql`${automationJob.kind} <> 'seguimiento_comercial'`,
          cursor ? sql`(${crmTask.createdAt}, ${crmTask.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
        ),
      )
      .orderBy(asc(crmTask.createdAt), asc(crmTask.id))
      .limit(size)
    for (const row of left) {
      const validity = await stillValid(tx, orgId, row.job, now)
      if (!validity.valid && (await settleTask(tx, orgId, row.taskId, settledWords(validity.reason, row.name)))) settled++
    }
    checked += left.length
    const last = left.at(-1)
    if (!last && cursor && !wrapped) {
      // El ciclo anterior terminó justo en la última: se vuelve a empezar ahora.
      cursor = null
      wrapped = true
      continue
    }
    if (!last || left.length < size) {
      // Se llegó al final: el próximo ciclo empieza otra vez desde la más vieja.
      cursor = null
      break
    }
    cursor = { createdAt: last.createdAt, id: last.taskId }
  }
  if (cursor) settleCursors.set(orgId, cursor)
  else settleCursors.delete(orgId)
  return settled
}

/** Tareas del Administrador que se revisan como mucho en un ciclo del worker. */
const SETTLE_PER_CYCLE = 1000
/** Dónde quedó la revisión de cada clínica: el ciclo siguiente continúa desde ahí. */
const settleCursors = new Map<string, { createdAt: string; id: string }>()

/** Por qué se cerró sola, en palabras: «Rosa confirmó su cita», «la cita ya pasó». */
function settledWords(reason: string | undefined, name: string | null): string {
  const who = name?.trim() || "La persona"
  if (reason === "La cita ya está confirmada") return `${who} confirmó su cita`
  if (reason === "Ya tiene otra cita reservada" || reason === "Ya tiene una cita reservada") return `${who} ya tiene otra cita reservada`
  if (reason === "Ya pagó lo que debía") return `${who} ya pagó lo que debía`
  const text = reason ?? "ya no hacía falta"
  // Un nombre de agente se queda con su mayúscula: «Sofi le escribió…».
  if (/^(Sofi|Clío|Argos)\b/.test(text)) return text
  return text.charAt(0).toLowerCase() + text.slice(1)
}

/** La tarea de un aviso de cita que no pudo salir: avisarle lo que cambió. */
const NOTICE_TASK_TITLE: Record<string, (name: string) => string> = {
  aviso_cita_reservada: (name) => `Avisarle a ${name} que su cita quedó reservada`,
  aviso_cita_movida: (name) => `Avisarle a ${name} que su cita cambió de fecha`,
  aviso_cita_cancelada: (name) => `Avisarle a ${name} que su cita se canceló`,
}

/**
 * Cuando un aviso de cita no sale, ¿alguien más se lo diría? El recordatorio de una cita reservada
 * o movida sale después y dice la fecha; una cita cancelada no tiene recordatorio: sin tarea,
 * la persona llega a una cita que ya no existe.
 */
function needsCallWhenMissed(kind: string): boolean {
  return !isAppointmentNotice(kind) || kind === "aviso_cita_cancelada"
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
  // Un aviso de cita es de «Recordar la cita»: su tarea es la de esa línea, dicha para lo que cambió.
  const line = lineOfJobKind(job.kind)
  if (!line) return null
  const payload = jobPayloadOf(job.payload)
  let name: string | null = null
  if (job.patientId) {
    const [row] = await tx
      .select({ name: patientPerson.displayName })
      .from(patient)
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
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
  const reason = `${input.reason}${input.note ? ` Indicación de la clínica: ${input.note}` : ""}`.slice(0, 480)
  // «Retomar una oportunidad» no deja otra tarea: la misma tarea de la
  // oportunidad queda para quien la lleva (sin responsable, Recepción), con el
  // motivo de por qué el agente no pudo.
  if (job.kind === "seguimiento_comercial" && job.opportunityId) {
    const [own] = await tx
      .select({ id: crmTask.id, assigneeUserId: crmTask.assigneeUserId })
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, job.opportunityId), eq(crmTask.status, "open")))
      .limit(1)
      .for("update")
    if (own) {
      const owner = assignee ?? own.assigneeUserId
      await tx
        .update(crmTask)
        .set({ assigneeUserId: owner, area: owner ? null : "recepcion", reason, updatedAt: input.now })
        .where(and(eq(crmTask.id, own.id), eq(crmTask.organizationId, orgId)))
      await notify(tx, { orgId, kind: "task.updated", at: input.now.toISOString() })
      return own.id
    }
  }
  // Una tarea de un paciente sin otro vínculo queda de su propia persona (`createTask`).
  const who = name ?? "esta persona"
  const task = await createTask(tx, orgId, {
    title: (NOTICE_TASK_TITLE[job.kind]?.(who) ?? line.team.taskTitle(who)).slice(0, 200),
    patientId: job.patientId,
    contactId: job.patientId ? null : job.contactId,
    opportunityId: job.opportunityId,
    assigneeUserId: assignee,
    dueAt: (input.dueAt ?? endOfTomorrow(input.now, input.timeZone)).toISOString(),
    createdBy: "admin",
    area: line.team.area,
    reason,
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
  if ((job.kind !== "recordatorio_cita" && !isAppointmentNotice(job.kind)) || !job.appointmentId) return undefined
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
 * motivo (que «Te espera» muestra con cómo habilitarlo) y, si la línea tiene
 * prendida su tarea, queda la tarea para una persona.
 *
 * Como mucho un mensaje al día por persona: los recordatorios de cita que
 * vencen juntos salen en uno solo y los demás tipos esperan al día siguiente
 * si esa persona ya recibió algo hoy o tiene un recordatorio por salir. Los
 * avisos de un cambio de cita no esperan, pero cuentan como el mensaje del día.
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
  const line = lineOfJobKind(job.kind)
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
  // Lo que esperó por el presupuesto sale si sigue teniendo sentido (D5 del cobro por tipo):
  // si la persona ya tiene su cita, se descarta solo.
  if (job.lastError === BUDGET_HOLD && job.patientId && (await hasFutureAppointment(tx, orgId, job.patientId, now))) {
    const reason = "Ya tiene su cita: el mensaje esperaba por el presupuesto y dejó de hacer falta"
    await close([job.id], "cancelado", reason)
    return { jobId: job.id, outcome: "cancelado", detail: reason }
  }

  // Un aviso de cita es solo un mensaje: sin «el agente le escribe» no queda nada.
  if (isAppointmentNotice(job.kind) && !rule.agentPart) {
    await close([job.id], "cancelado", "Sofi no escribe en esta línea")
    return { jobId: job.id, outcome: "cancelado", detail: "Sofi no escribe en esta línea" }
  }
  // Si el recordatorio de la misma cita sale ahora (o acaba de salir), ese mensaje ya dice la fecha.
  if (isAppointmentNotice(job.kind) && job.kind !== "aviso_cita_cancelada" && job.appointmentId) {
    const [reminder] = await tx
      .select({ id: automationJob.id })
      .from(automationJob)
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.appointmentId, job.appointmentId),
          eq(automationJob.kind, "recordatorio_cita"),
          or(
            and(
              eq(automationJob.status, "pendiente"),
              lte(automationJob.scheduledFor, new Date(now.getTime() + GROUP_WINDOW_MS)),
            ),
            and(
              eq(automationJob.status, "enviado"),
              gte(automationJob.updatedAt, new Date(now.getTime() - GROUP_WINDOW_MS)),
            ),
          ),
        ),
      )
      .limit(1)
    if (reminder) {
      await close([job.id], "cancelado", "Cubierto por el recordatorio de la misma cita")
      return { jobId: job.id, outcome: "cancelado", detail: "Cubierto por el recordatorio" }
    }
  }

  // ---- le toca a una persona -------------------------------------------------
  // También mientras los agentes están en pausa por el saldo de prueba: nada se pierde.
  if (!line.agent || !rule.agentPart || runtime.agentsPaused) {
    const taskId = await leaveTask(tx, orgId, job, {
      reason: payload.detail ?? line.trigger(lineDays(rule, job.kind), (await productHooks(tx, orgId)).recallMonths),
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
    await close([job.id], "cancelado", "Sofi no atiende")
    return { jobId: job.id, outcome: "cancelado", detail: "Sofi no atiende" }
  }
  // Al llegar al presupuesto del mes, Argos no escribe para recuperar (ADR 0085): el mensaje
  // espera a que la clínica lo suba o empiece otro mes. Los recordatorios, los avisos de cita,
  // el saldo vencido y lo de quien ya tiene su cita (un control con cita, un presupuesto de
  // alguien que vuelve la semana que viene) siguen: no recuperan a nadie.
  if (
    runtime.recoveryPaused &&
    !NOT_RECOVERY_KINDS.includes(job.kind) &&
    !(job.patientId && (await patientHasItsAppointment(tx, orgId, job.patientId, now)))
  ) {
    await tx
      .update(automationJob)
      .set({ scheduledFor: new Date(now.getTime() + BUDGET_HOLD_MS), lastError: BUDGET_HOLD, updatedAt: now })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "pospuesto", detail: BUDGET_HOLD }
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
    // Sin aviso en la campana: quien puede habilitarlo lo ve en «Te espera»
    // («el agente no pudo escribirle a N personas», ADR 0025). Un aviso de
    // cita reservada o movida no deja tarea: la llamada la pide su recordatorio, si tampoco sale;
    // la cancelación sí, porque nada más le diría a la persona que no vaya.
    if (rule.teamPart && needsCallWhenMissed(job.kind)) {
      const words = causeWordsFor(cause, purpose)
      for (const item of group) {
        const taskId = await leaveTask(tx, orgId, item, {
          reason: `Sofi no pudo escribirle: ${words.one}. ${words.fix}`,
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
  // El tipo es el del mensaje: un aviso de cita es un aviso aunque sea de «Recordar la cita» (ADR 0040).
  const purpose = purposeOfKind(job.kind)
  // La hora (ADR 0042): fuera del «Horario de recontacto» espera al primer
  // momento permitido; un recordatorio que ya no llega con una hora de margen
  // antes de la cita no sale. Los avisos de lo que pasó salen al momento.
  const timing = await writingTimeFor(tx, orgId, {
    purpose,
    now,
    timeZone: tz,
    appointmentAt: job.kind === "recordatorio_cita" ? await appointmentStartOf(tx, orgId, job.appointmentId) : null,
  })
  if ("never" in timing) {
    await close(ids(), "cancelado", OUTSIDE_WRITING_HOURS_LATE)
    return { jobId: job.id, outcome: "cancelado", detail: OUTSIDE_WRITING_HOURS_LATE }
  }
  if ("later" in timing) {
    await tx
      .update(automationJob)
      .set({ scheduledFor: timing.later, updatedAt: now })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "pospuesto", detail: "Fuera del horario de recontacto" }
  }
  if (!job.contactId) return cannot("Sin persona a quien escribirle", "sin_destino")
  const contactId = job.contactId
  if (!(await mayWriteFirst(tx, orgId, contactId, purpose))) {
    return cannot(permissionRefusal(purpose), "sin_permiso", { status: "omitido" })
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
  } else if (!isAppointmentNotice(job.kind)) {
    // Un aviso de cita no espera a mañana: la cita cambió hoy. Sí cuenta como el
    // mensaje del día de la persona, así que lo demás espera.
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
        .set({ scheduledFor: nextWritingDay(now, await writingScheduleOf(tx, orgId, tz)), updatedAt: now })
        .where(eq(automationJob.id, job.id))
      return { jobId: job.id, outcome: "pospuesto", detail: "Ya recibió un mensaje hoy" }
    }
  }

  // Recepción no escribe encima de lo que la persona ya dijo. Lo que una persona
  // pidió «solo esta vez» sale igual: ya lo decidió alguien.
  // No aplica a recordatorios de la cita o del control ni a los avisos de lo que pasó.
  if (deps.alreadyTold && purpose !== "recordatorio" && purpose !== "avisos" && job.kind !== "recordatorio_control" && !payload.once) {
    const written = await recentlyWritten(tx, orgId, contactId, now)
    let told = false
    if (written.length > 0) {
      try {
        told = await deps.alreadyTold(orgId, { kind: job.kind, reason: line.trigger(lineDays(rule, job.kind), (await productHooks(tx, orgId)).recallMonths), messages: written })
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
  let spec = await currentAutomationMessageOf(tx, orgId, job.kind)
  // A quien le faltan datos, el aviso de reserva lleva «Su enlace» para
  // completarlos antes de venir (ADR 0037): el mismo aviso, no un segundo mensaje.
  // Igual el recordatorio de la cita: lleva «Completar mis datos» mientras falten (fase 3).
  const withData =
    spec && job.kind === "aviso_cita_reservada"
      ? await dataNoticeFor(tx, orgId, job, contactId, deps)
      : spec && job.kind === "recordatorio_cita"
        ? await dataNoticeFor(tx, orgId, job, contactId, deps, REMINDER_DATA_KEY)
        : null
  let link = withData?.link ?? null
  // El título de la línea con su enlace, cuando el texto es el de siempre (respuesta o correo del recordatorio).
  let linkTitle: { title: string } | undefined
  if (spec && withData) {
    const dataRoute = await routeMessage(tx, orgId, contactId, withData.spec)
    if ("cause" in dataRoute) {
      // Mientras WhatsApp no aprueba el mensaje con su enlace, sale el de siempre, sin él.
      link = null
    } else if (job.kind === "recordatorio_cita" && dataRoute.via !== "plantilla") {
      // El botón «Completar mis datos» es de la plantilla: por respuesta o correo sale el
      // recordatorio con el texto de la clínica y una línea más con su enlace.
      linkTitle = withData.spec.link
    } else {
      spec = withData.spec
    }
  }
  const composed = spec ? await composeJobMessage(tx, orgId, spec, group, now) : null
  if (!spec || !composed) {
    await close(ids(), "cancelado", "Ya no existe lo que originó el mensaje")
    return { jobId: job.id, outcome: "cancelado", detail: "Sin datos para el mensaje" }
  }
  const route = await routeMessage(tx, orgId, contactId, spec)
  if ("cause" in route) return cannot(route.detail, route.cause)
  const linkedText = link ? withLinkLine(composed.text, linkTitle ?? spec.link, link.url) : composed.text
  try {
    let sent: { id: string }
    if (route.via === "plantilla" && route.template) {
      sent = await sendTemplateOutbound(tx, orgId, deps.secretsKey, {
        conversationId: route.conversationId,
        senderKind: "agent",
        name: route.template.name,
        language: route.template.language,
        params: composed.params,
        category: spec.category,
        buttons: composed.buttons,
        ...(link ? { link: link.token } : {}),
        preview: composed.text,
      })
    } else if (route.via === "correo") {
      const [profile] = await tx
        .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
        .from(orgProfile)
        .where(eq(orgProfile.organizationId, orgId))
        .limit(1)
      const links: Parameters<typeof emailBody>[2] = {
        appointments: [],
        optOut: null,
        choose: await messageChoicesUrl(tx, orgId, contactId, job.patientId, deps),
      }
      // «Confirmar», «Cancelar» y la baja viven en la página de la clínica
      // (`/c/` y `/baja/`), en el dominio de su producto; el panel no las tiene.
      const base = (await clinicOriginOf(tx, orgId)) ?? deps.publicBaseUrl
      if (base) {
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
        // Un aviso de lo que pasó no tiene baja de un toque: solo «Elegir mis mensajes».
        if (purpose !== "avisos") links.optOut = await createUnsubscribeLink(tx, orgId, contactId, base, { jobId: job.id })
      }
      const clinic = profile?.tradeName?.trim() || profile?.legalName || ""
      const text = emailBody({ ...composed, text: linkedText }, clinic, links)
      // El aviso de una cita reservada, movida o cancelada lleva la invitación
      // de calendario (issue 46, ADR 0081): el mismo evento se actualiza o se borra.
      const invite =
        deps.storage && route.addresses && job.appointmentId && APPOINTMENT_NOTICE_KINDS.has(job.kind)
          ? await appointmentCalendarInvite(
              tx,
              orgId,
              job.appointmentId,
              { organizer: { email: route.addresses.from, name: clinic || null }, attendee: { email: route.addresses.to } },
              now,
            )
          : null
      if (invite && deps.storage) {
        const mimeType = `${APPOINTMENT_CALENDAR_MIME}; charset=utf-8; method=${invite.method}`
        const ref = await deps.storage.putAttachment({
          orgId,
          conversationId: route.conversationId,
          bytes: new TextEncoder().encode(invite.text),
          contentType: mimeType,
          ext: "ics",
        })
        sent = await sendOutbound(tx, orgId, {
          conversationId: route.conversationId,
          senderKind: "agent",
          content: { type: "media", attachment: { ...ref, mimeType, filename: APPOINTMENT_CALENDAR_FILENAME }, caption: text },
        })
      } else {
        sent = await sendOutbound(tx, orgId, {
          conversationId: route.conversationId,
          senderKind: "agent",
          content: { type: "text", text, ...(links.optOut ? { listUnsubscribe: links.optOut } : {}) },
        })
      }
    } else {
      sent = await sendOutbound(tx, orgId, {
        conversationId: route.conversationId,
        senderKind: "agent",
        content: {
          type: "text",
          text: linkedText,
          ...(composed.buttons.length ? { buttons: composed.buttons } : {}),
        },
      })
    }
    if (job.kind === "invitar_a_volver" && job.patientId) await recordInvitation(tx, orgId, null, job.patientId, "agente")
    await linkOpportunityThread(tx, orgId, job, route.conversationId)
    // El agente ya le escribió: la tarea de la oportunidad se da por hecha.
    if (job.kind === "seguimiento_comercial") {
      const { taskId } = jobPayloadOf(job.payload)
      if (taskId) await settleTask(tx, orgId, taskId, "Sofi le escribió para retomarla")
    }
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
 * proveedor lo rechaza, el caso pasa a `fallido` con su motivo (lo muestra
 * «Te espera») y, si la línea tiene prendida su tarea, queda para una
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
    // Un rechazo por la cuenta de la clínica (pago, clave vencida) se arregla
    // una vez en la conexión: no es del número de la persona ni deja su tarea.
    const account = isWhatsAppAccountFailure(error)
    await tx
      .update(automationJob)
      .set({
        status: "fallido",
        cause: account ? "proveedor" : "no_entregado",
        lastError: error ?? "El canal no entregó el mensaje",
        updatedAt: now,
      })
      .where(eq(automationJob.id, job.id))
    if (!job.ruleId || account) continue
    if (!rules.has(job.ruleId)) {
      const [rule] = await tx
        .select()
        .from(automationRule)
        .where(and(eq(automationRule.id, job.ruleId), eq(automationRule.organizationId, orgId)))
        .limit(1)
      rules.set(job.ruleId, rule ?? null)
    }
    const rule = rules.get(job.ruleId)
    if (rule?.teamPart && !job.taskId && needsCallWhenMissed(job.kind)) {
      const taskId = await leaveTask(tx, orgId, job, {
        reason: `Sofi no pudo escribirle: ${words.one}. ${words.fix}`,
        dueAt: await reminderDue(tx, orgId, job),
        timeZone: jobPayloadOf(job.payload).timeZone ?? timeZone,
        now,
      })
      await tx.update(automationJob).set({ taskId }).where(eq(automationJob.id, job.id))
    }
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
    // Cada caso en su propio punto de guardado: uno que falla no deshace lo que ya salió
    // ni deja a los demás sin atender (un caso que siempre falla no bloquea la cola).
    try {
      results.push(await tx.transaction((inner) => deliverJob(inner as Db, orgId, r.id, now, deps)))
    } catch (error) {
      results.push(await markCrashedJob(tx, orgId, r.id, now, error))
    }
  }
  return results
}

/**
 * Un caso que lanzó un error inesperado (no un motivo de «no pude» conocido):
 * se reintenta pasados 15 minutos y, tras `MAX_ATTEMPTS`, se cierra como
 * fallido con el motivo «proveedor» para que aparezca en «Te espera» en vez
 * de repetirse cada minuto sin que nadie lo vea.
 */
async function markCrashedJob(tx: Db, orgId: string, jobId: string, now: Date, error: unknown): Promise<DeliverResult> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
  console.warn(`[ciclo] el caso ${jobId} de ${orgId} falló: ${detail}`)
  const [job] = await tx
    .select({ attempts: automationJob.attempts })
    .from(automationJob)
    .where(and(eq(automationJob.id, jobId), eq(automationJob.organizationId, orgId), eq(automationJob.status, "pendiente")))
    .limit(1)
  if (!job) return { jobId, outcome: "omitido", detail: "Ya procesado" }
  const attempts = job.attempts + 1
  if (attempts < MAX_ATTEMPTS) {
    await tx
      .update(automationJob)
      .set({ attempts, lastError: detail, scheduledFor: new Date(now.getTime() + 15 * 60_000), updatedAt: now })
      .where(eq(automationJob.id, jobId))
    return { jobId, outcome: "pospuesto", detail }
  }
  await tx
    .update(automationJob)
    .set({ attempts, status: "fallido", cause: "proveedor", lastError: detail, updatedAt: now })
    .where(eq(automationJob.id, jobId))
  await audit(tx, orgId, null, "automation_job.failed", jobId, { cause: "proveedor", detail })
  await notify(tx, { orgId, kind: "automation.job.failed", jobId, at: now.toISOString() })
  return { jobId, outcome: "fallido", detail }
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

// ------------------------------------------------- avisos de la cita ---

/** Qué le pasó a la cita: se reservó, se movió o se canceló. */
export type AppointmentChange = "reservada" | "movida" | "cancelada"

const NOTICE_OF: Record<AppointmentChange, AppointmentNoticeKey> = {
  reservada: "aviso_cita_reservada",
  movida: "aviso_cita_movida",
  cancelada: "aviso_cita_cancelada",
}

/** Los avisos de un cambio de cita: por correo llevan la invitación de calendario. */
const APPOINTMENT_NOTICE_KINDS: ReadonlySet<string> = new Set(Object.values(NOTICE_OF))

/**
 * Lo que «Recordar la cita» hace cuando la cita cambia: el agente le avisa a la
 * persona que la cita quedó reservada, que cambió de fecha o que se canceló
 * (con la opción de reservar otra). Venga de recepción, de la Agenda, de la
 * ficha o del portal. No avisa lo que el agente hizo en la conversación ni lo
 * que la persona hizo desde su enlace de reserva: ahí ya se le dijo.
 *
 * Es un caso más de la línea (`automation_job`), con su permiso de
 * recordatorios, el horario de silencio y la vía que corresponda (respuesta,
 * mensaje aprobado o correo). No espera al día siguiente por el tope de un
 * mensaje al día, porque la cita cambió hoy, pero cuenta como el mensaje del
 * día de esa persona (ADR 0027). Devuelve si quedó en camino.
 */
export async function enqueueAppointmentNotice(
  tx: Db,
  orgId: string,
  appointmentId: string,
  change: AppointmentChange,
): Promise<{ queued: boolean }> {
  const rule = await enabledLine(tx, orgId, "recordatorio_cita")
  if (!rule?.agentPart) return { queued: false }
  const runtime = await adminRuntime(tx, orgId)
  if (!runtime.adminOn || !runtime.receptionOn) return { queued: false }
  const [appt] = await tx
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
    .limit(1)
  const now = new Date()
  // De una cita que ya pasó no hay nada que avisar.
  if (!appt || appt.startsAt.getTime() <= now.getTime()) return { queued: false }
  const standing = appt.status === "programada" || appt.status === "confirmada"
  if (change === "cancelada" ? appt.status !== "cancelada" : !standing) return { queued: false }
  const contactId = await preferredContact(tx, orgId, appt.patientId)
  if (!contactId) return { queued: false }
  if (change === "movida") {
    // Un aviso que aún no sale dice la fecha nueva al salir: no hace falta otro.
    const [waiting] = await tx
      .select({ id: automationJob.id })
      .from(automationJob)
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.appointmentId, appt.id),
          inArray(automationJob.kind, ["aviso_cita_reservada", "aviso_cita_movida"]),
          eq(automationJob.status, "pendiente"),
        ),
      )
      .limit(1)
    if (waiting) return { queued: true }
  }
  const kind = NOTICE_OF[change]
  const job = await enqueueJob(tx, orgId, {
    ruleId: rule.id,
    kind,
    dedupeKey: change === "movida" ? `${kind}:${appt.id}:${appt.version}` : `${kind}:${appt.id}`,
    scheduledFor: now,
    contactId,
    appointmentId: appt.id,
    patientId: appt.patientId,
    payload: { timeZone: await timezoneOf(tx, orgId, appt.branchId) },
  })
  return { queued: !!job }
}

/**
 * Al mover una cita, sus recordatorios pendientes pasan a contar desde la hora
 * nueva. El que ya no llega a tiempo se da por cubierto: el aviso del cambio
 * dice la fecha.
 */
export async function rescheduleAppointmentReminders(
  tx: Db,
  orgId: string,
  appointmentId: string,
  startsAt: Date,
): Promise<void> {
  const pending = await tx
    .select({ id: automationJob.id, dedupeKey: automationJob.dedupeKey, payload: automationJob.payload })
    .from(automationJob)
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.appointmentId, appointmentId),
        eq(automationJob.kind, "recordatorio_cita"),
        eq(automationJob.status, "pendiente"),
      ),
    )
  const now = new Date()
  for (const job of pending) {
    const hours = Number(job.dedupeKey.split(":").at(-1))
    if (!Number.isFinite(hours)) continue
    const target = new Date(startsAt.getTime() - hours * 3_600_000)
    // La misma regla que al programarlo: dentro del «Horario de recontacto».
    const schedule = await writingScheduleOf(tx, orgId, jobPayloadOf(job.payload).timeZone)
    const at = target.getTime() < now.getTime() ? null : sendTimeFor(target, now, schedule, startsAt)
    await tx
      .update(automationJob)
      .set(
        at === null
          ? { status: "cancelado", lastError: "La cita se movió y este recordatorio ya no llega a tiempo", updatedAt: now }
          : { scheduledFor: at, updatedAt: now },
      )
      .where(eq(automationJob.id, job.id))
  }
}

/** Cuándo pide el agente que la persona confirme su cita: lo que muestra la cita en la Agenda. */
export interface ConfirmationPlan {
  /** Cuándo saldrá el primer recordatorio que pide confirmar. */
  askAt: string | null
  /** Cuándo salió, si ya se le pidió y aún no confirma. */
  askedAt: string | null
}

/**
 * Si «Recordar la cita» está prendida (y Recepción y el Administrador
 * encendidos) y la persona no pidió dejar de recibir recordatorios, cuándo le pedirá el agente
 * confirmar una cita por confirmar, o cuándo se lo pidió. Null si el agente no
 * se lo va a pedir: entonces se confirma a mano.
 */
export async function appointmentConfirmationPlan(
  tx: Db,
  orgId: string,
  appointmentId: string,
): Promise<ConfirmationPlan | null> {
  const [appt] = await tx
    .select()
    .from(appointment)
    .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
    .limit(1)
  const now = new Date()
  if (!appt || appt.status !== "programada" || appt.startsAt.getTime() <= now.getTime()) return null
  const rule = await enabledLine(tx, orgId, "recordatorio_cita")
  if (!rule?.agentPart) return null
  const runtime = await adminRuntime(tx, orgId)
  if (!runtime.adminOn || !runtime.receptionOn) return null
  const contactId = await preferredContact(tx, orgId, appt.patientId)
  if (!contactId || !(await mayWriteFirst(tx, orgId, contactId, "recordatorio"))) return null
  const jobs = await tx
    .select({ status: automationJob.status, scheduledFor: automationJob.scheduledFor, updatedAt: automationJob.updatedAt })
    .from(automationJob)
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.appointmentId, appt.id),
        eq(automationJob.kind, "recordatorio_cita"),
      ),
    )
    .orderBy(asc(automationJob.scheduledFor))
  const sent = jobs.find((job) => job.status === "enviado")
  if (sent) return { askAt: null, askedAt: sent.updatedAt.toISOString() }
  const pending = jobs.find((job) => job.status === "pendiente")
  if (pending) return { askAt: pending.scheduledFor.toISOString(), askedAt: null }
  // Aún sin programar (falta para la cita): el primero que llegue a tiempo.
  const hoursList = lineConfigOf(rule.config).hoursBefore ?? [...DEFAULT_HOURS_BEFORE]
  const next = hoursList
    .map((hours) => appt.startsAt.getTime() - hours * 3_600_000)
    .filter((at) => at >= now.getTime())
    .sort((a, b) => a - b)[0]
  return next === undefined ? null : { askAt: new Date(next).toISOString(), askedAt: null }
}

/**
 * Lo que una clínica nueva trae prendido: solo «Recordar la cita». Confirmar
 * las citas es lo básico y una clínica mediana no debería tener que buscarlo
 * (ADR 0026). Se prende con `setLine`, a nombre de quien crea la clínica y
 * con su registro; nunca toca una línea que ya existe ni una clínica que ya
 * estaba: se llama solo al crear el perfil de una clínica.
 */
export const NEW_CLINIC_LINES = ["recordatorio_cita"] as const

export async function turnOnNewClinicLines(tx: Db, orgId: string, actorUserId: string): Promise<void> {
  for (const key of NEW_CLINIC_LINES) {
    if (await findLineRule(tx, orgId, key)) continue
    const rule = await setLine(tx, orgId, actorUserId, key, { enabled: true })
    await audit(tx, orgId, actorUserId, "admin_line.default_on", rule.id, { key })
  }
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
  /** En una baja, lo que deja de recibir (`UNSUBSCRIBE_WORDS`); null en los enlaces de una cita. */
  stops: UnsubscribeWords | null
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
  const stops = purpose === "baja" ? unsubscribeWords(await unsubscribePurposes(tx, link)) : null
  return { purpose, when, timeZone, expired, used: link.usedAt !== null, stops }
}

/**
 * Los tipos de mensaje que apaga un enlace de baja: el del mensaje del que salió
 * (quien se da de baja de un seguimiento sigue recibiendo el recordatorio de su
 * cita) o, si no viene de un mensaje concreto, los tres.
 */
async function unsubscribePurposes(
  tx: Db,
  link: typeof automationLinkToken.$inferSelect,
): Promise<readonly ConsentPurpose[]> {
  const [origin] = link.jobId
    ? await tx
        .select({ kind: automationJob.kind })
        .from(automationJob)
        .where(and(eq(automationJob.id, link.jobId), eq(automationJob.organizationId, link.organizationId)))
        .limit(1)
    : []
  return origin ? [purposeOfKind(origin.kind)] : SWITCHABLE_PURPOSES
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
 * enlace que no viene de un mensaje concreto apaga los tres interruptores. Los
 * avisos de sus citas y papeles siguen (ADR 0040).
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
  const purposes = await unsubscribePurposes(tx, link)
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

// -------------------------------------------------------- «Tus mensajes» ---

/** El paciente que es la propia persona, si lo es: su enlace se emite para él. */
async function ownPatientOf(tx: Db, orgId: string, contactId: string): Promise<string | null> {
  const [row] = await tx
    .select({ patientId: patientContact.patientId })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return row?.patientId ?? null
}

/**
 * La dirección de «Tus mensajes» de una persona, dentro de su enlace (ADR
 * 0040). Se guarda en el mensaje con la referencia de su enlace: el worker
 * pone el token al enviarlo. Nula sin dirección pública.
 */
export async function messageChoicesUrl(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string | null,
  deps: { secretsKey: Buffer },
  /** Con el token escrito, para un texto que no pasa por el worker (lo que redacta el agente). */
  options: { raw?: boolean } = {},
): Promise<string | null> {
  if (!publicLinksConfigured()) return null
  const link = await issuePersonalLink(
    tx,
    orgId,
    { contactId, patientId: patientId ?? (await ownPatientOf(tx, orgId, contactId)) },
    deps,
  )
  const url = options.raw
    ? await personalLinkUrl(tx, orgId, link.token)
    : await personalLinkMessageUrl(tx, orgId, link.linkId)
  return url ? `${url}#mensajes` : null
}

async function contactFirstName(tx: Db, orgId: string, contactId: string): Promise<string | null> {
  const [row] = await tx
    .select({ givenNames: contact.givenNames, displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!row) return null
  return row.givenNames?.trim().split(/\s+/)[0] || row.displayName.trim().split(/\s+/)[0] || null
}

/**
 * La respuesta a una baja, la misma por botón, por el chat y con «BAJA»: el
 * texto fijo y, si hay dirección pública, «Elegir mis mensajes» para ver los
 * tres interruptores. Sale como respuesta: la persona acaba de escribir.
 */
export async function optOutReplyText(
  tx: Db,
  orgId: string,
  contactId: string,
  purposes: readonly ConsentPurpose[],
  options: { patientId?: string | null; secretsKey?: Buffer } = {},
): Promise<string> {
  const text = optOutReply(await contactFirstName(tx, orgId, contactId), purposes)
  if (!options.secretsKey || purposes.includes("avisos")) return text
  const url = await messageChoicesUrl(tx, orgId, contactId, options.patientId ?? null, { secretsKey: options.secretsKey })
  return withLinkLine(text, CHOOSE_MESSAGES_LINK, url)
}

/**
 * Lo que la persona pide por el chat sobre sus mensajes (G2; ADR 0040), con la
 * misma operación que el botón y que «Tus mensajes»: dejar de recibir un tipo,
 * volver a recibirlo o ningún mensaje. Sin tipo, solo se le da «Elegir mis
 * mensajes» para que elija ella. Devuelve la frase fija para decírselo, con la
 * dirección de su página si la clínica tiene dirección pública.
 */
export async function chooseMessagesInConversation(
  tx: Db,
  orgId: string,
  input: { conversationId: string; choice: string | null; receive: boolean },
  deps: { secretsKey: Buffer },
): Promise<{ reply: string; changed: ConsentPurpose[] }> {
  const [thread] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!thread) throw notFound("Conversación")
  const name = await contactFirstName(tx, orgId, thread.contactId)
  const url = await messageChoicesUrl(tx, orgId, thread.contactId, null, deps, { raw: true })
  if (!input.choice) {
    return {
      reply: url
        ? withLinkLine(`${name ? `${name}, aquí` : "Aquí"} puedes elegir qué mensajes recibes de la clínica.`, CHOOSE_MESSAGES_LINK, url)
        : "Dime qué mensajes ya no quieres recibir: los recordatorios de tus citas, los de controles y seguimiento, las novedades y promociones o ningún mensaje.",
      changed: [],
    }
  }
  const { purposes } = await setMessageChoice(tx, orgId, null, thread.contactId, {
    choice: input.choice,
    receive: input.receive,
    source: "conversacion",
  })
  const text = input.receive ? optInReply(name, purposes) : optOutReply(name, purposes)
  return {
    reply: input.choice === "ninguno" && !input.receive ? text : withLinkLine(text, CHOOSE_MESSAGES_LINK, url),
    changed: purposes,
  }
}

/** Cuánto vale «BAJA» para el último mensaje automático de la conversación. */
const STOP_WORD_WINDOW_MS = 72 * 3_600_000

/**
 * «BAJA» o «STOP», solos en el mensaje (ADR 0040): se resuelven sin modelo. Si
 * en esa conversación salió hace poco un mensaje automático que se puede
 * apagar, se apaga su tipo; si no, los tres interruptores. Los avisos de su
 * cita y sus papeles siguen. «Cancelar» nunca es una baja (`isStopWord`).
 */
async function stopByWord(
  tx: Db,
  orgId: string,
  input: { conversationId: string; contactId: string },
  deps: { secretsKey?: Buffer; silent?: boolean },
): Promise<void> {
  const [last] = await tx
    .select({ kind: automationJob.kind, patientId: automationJob.patientId })
    .from(automationJob)
    .innerJoin(message, and(eq(message.id, automationJob.sentMessageId), eq(message.organizationId, automationJob.organizationId)))
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.contactId, input.contactId),
        eq(message.conversationId, input.conversationId),
        gte(message.createdAt, new Date(Date.now() - STOP_WORD_WINDOW_MS)),
      ),
    )
    .orderBy(desc(message.createdAt))
    .limit(1)
  const kind = last ? purposeOfKind(last.kind) : null
  const purposes: ConsentPurpose[] = kind && kind !== "avisos" ? [kind] : [...SWITCHABLE_PURPOSES]
  for (const purpose of purposes) {
    await setMessageChoice(tx, orgId, null, input.contactId, { choice: purpose, receive: false, source: "conversacion" })
  }
  await audit(tx, orgId, null, "automation_consent.stop_word", input.contactId, {
    purposes,
    conversationId: input.conversationId,
  })
  // A quien está en Spam o bloqueado no se le responde (ADR 0054): la baja queda igual.
  if (deps.silent) return
  await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "agent",
    content: {
      type: "text",
      text: await optOutReplyText(tx, orgId, input.contactId, purposes, { patientId: last?.patientId ?? null, ...deps }),
    },
  })
}

// ------------------------------------------------ respuestas con botón ---

/**
 * La persona tocó un botón de un mensaje automático, o escribió «BAJA». Lo
 * resuelve el sistema, sin modelo y con un texto fijo de respuesta:
 * «Confirmar» confirma por la operación de la agenda cada cita de ese mensaje;
 * «No más recordatorios» o «No enviar más» apaga ese tipo de mensaje y ofrece
 * «Elegir mis mensajes»; «BAJA» o «STOP» apagan el tipo del último mensaje
 * automático (o los tres interruptores). Devuelve true si quedó resuelto; con
 * false la conversación sigue su curso normal (el agente o una persona), que
 * es lo que pasa con cualquier otro botón o texto.
 *
 * El botón solo vale en la conversación de la persona a la que se le envió.
 */
export async function handleAutomationReply(
  tx: Db,
  orgId: string,
  input: { conversationId: string; replyId: string | null | undefined; text?: string | null },
  /**
   * `storage`, para «Ver y responder» de «Presupuesto listo»; `secretsKey`, para
   * el enlace de «Tus mensajes»; `silent`, anota la baja sin responder (Spam y
   * bloqueados, ADR 0054).
   */
  deps?: { storage: Storage; secretsKey?: Buffer; silent?: boolean },
): Promise<boolean> {
  const reply = parseReplyId(input.replyId)
  if (!reply && isStopWord(input.text)) {
    const [writer] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (!writer) return false
    await stopByWord(
      tx,
      orgId,
      { conversationId: input.conversationId, contactId: writer.contactId },
      { ...(deps?.secretsKey ? { secretsKey: deps.secretsKey } : {}), ...(deps?.silent ? { silent: true } : {}) },
    )
    return true
  }
  if (!reply || reply.action === "responder") return false
  const [thread] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  // «Ver y responder»: su id lleva el presupuesto. Le llega el PDF; lo que
  // responda lo sigue Recepción en la conversación.
  if (reply.action === "presupuesto") {
    if (!thread || !deps) return false
    return answerBudgetButton(
      tx,
      orgId,
      { conversationId: input.conversationId, contactId: thread.contactId, budgetId: reply.jobId },
      deps,
    )
  }
  // «Ver respuesta» (R1): le llegan las respuestas del equipo que esperaban. El
  // botón lleva su conversación y solo vale ahí; tocarlo no es una pregunta.
  if (reply.action === "ver_respuesta") {
    if (reply.jobId !== input.conversationId) return false
    await deliverHeldReplies(tx, orgId, input.conversationId)
    return true
  }
  // La pregunta de novedades y promociones: su botón lleva la persona y solo vale en su conversación.
  if (reply.action === "permiso_si" || reply.action === "permiso_no") {
    if (!thread || thread.contactId !== reply.jobId) return false
    const granted = reply.action === "permiso_si"
    const outcome = await answerGeneralPermission(tx, orgId, { conversationId: input.conversationId, granted })
    if (outcome === "no_preguntado") return false
    if (outcome === "guardado") {
      await sendOutbound(tx, orgId, {
        conversationId: input.conversationId,
        senderKind: "agent",
        content: { type: "text", text: granted ? GENERAL_PERMISSION_YES : GENERAL_PERMISSION_NO },
      })
    }
    return true
  }
  const [origin] = await tx
    .select()
    .from(automationJob)
    .where(and(eq(automationJob.id, reply.jobId), eq(automationJob.organizationId, orgId)))
    .limit(1)
  if (!thread || !origin?.sentMessageId || origin.contactId !== thread.contactId) return false
  if (reply.action === "baja") {
    // Apaga solo el tipo de ese mensaje: «No más recordatorios» deja los avisos de su cita (ADR 0040).
    const purpose = purposeOfKind(origin.kind)
    if (purpose === "avisos") return false
    await setMessageChoice(tx, orgId, null, thread.contactId, { choice: purpose, receive: false, source: "baja" })
    await sendOutbound(tx, orgId, {
      conversationId: input.conversationId,
      senderKind: "agent",
      content: {
        type: "text",
        text: await optOutReplyText(tx, orgId, thread.contactId, [purpose], {
          patientId: origin.patientId,
          ...(deps?.secretsKey ? { secretsKey: deps.secretsKey } : {}),
        }),
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
  const items: ConfirmedItem[] = []
  for (const appointmentId of appointmentIds) {
    const [appt] = await tx
      .select({
        status: appointment.status,
        startsAt: appointment.startsAt,
        patientName: patientPerson.displayName,
        self: sql<boolean>`${patient.personId} = ${thread.contactId}`,
      })
      .from(appointment)
      .innerJoin(patient, and(eq(patient.id, appointment.patientId), eq(patient.organizationId, orgId)))
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .where(and(eq(appointment.id, appointmentId), eq(appointment.organizationId, orgId)))
      .for("update", { of: appointment })
      .limit(1)
    if (!appt || appt.startsAt.getTime() < Date.now()) continue
    if (appt.status === "confirmada") items.push({ patientName: appt.patientName, self: appt.self, was: "ya_confirmada", startsAt: appt.startsAt })
    if (appt.status !== "programada") continue
    await setAppointmentStatus(tx, orgId, null, appointmentId, "confirmada", { via: "respuesta" })
    items.push({ patientName: appt.patientName, self: appt.self, was: "confirmada", startsAt: appt.startsAt })
  }
  // Cita cancelada, atendida o ya pasada: no hay nada que confirmar y lo
  // correcto es que alguien lea la conversación.
  if (items.length === 0) return false
  const confirmed = items.filter((item) => item.was === "confirmada").length
  // Un padre confirma las citas de quienes lleva: la respuesta dice de quiénes son.
  await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "agent",
    content: { type: "text", text: confirmationReply(items) },
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
  const line = lineOfJobKind(origin.kind)
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
    hint: `El interlocutor tocó el botón «${tapped.title}» del mensaje automático de la clínica${line ? ` por «${line.trigger(lineDays(null, origin.kind), (await productHooks(tx, orgId)).recallMonths)}»` : ""}. ${wants}`,
  }
}

// ------------------------------------------------- mensajes aprobados ---

/**
 * Pide a WhatsApp, en cada conexión activa, los mensajes de la clínica que aún
 * no tiene: los diez con los que viene y los que haya creado, sin esperar a que
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
    // Una vez al día se lee la cuenta: estados y categorías al día aunque se haya perdido un aviso.
    await reviewConnectionTemplates(tx, orgId, connection.id, secretsKey, now, deps)
    const outcome = await requestMissingTemplates(tx, orgId, connection.id, secretsKey, now, deps)
    requested += outcome.requested
    const [first] = outcome.failed
    if (!first) continue
    const many = outcome.failed.length
    for (const recipient of await failureRecipients(tx, orgId)) {
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
    const recipients = await failureRecipients(tx, orgId)
    if (recipients.length === 0) continue
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
        body += ` ${n === 1 ? "1 persona lo tiene" : `${n} personas lo tienen`} por salir en las próximas 24 horas: a quien no le llegue lo verás con su motivo en Agente › Argos.`
      }
    }
    for (const recipient of recipients) {
      await upsertWorkspaceNotification(tx, orgId, {
        userId: recipient,
        dedupeKey: `template-status:${template.id}:${template.status}`,
        title,
        body,
        href: MESSAGES_HREF,
        permission: "settings.write",
      })
    }
  }
  return changes.length
}
