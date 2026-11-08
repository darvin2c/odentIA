import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import {
  patient,
  patientContact,
  serviceCatalog,
  treatmentBudget,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { contact, conversation, crmTask, pipeline, pipelineStage } from "@odentia/db/schema/crm"
import {
  OPPORTUNITY_LOST_REASONS,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_WON_REASONS,
  opportunity,
  opportunityEvent,
  type OpportunityCloseReason,
  type OpportunityEventOrigin,
  type OpportunityStatus,
} from "@odentia/db/schema/opportunities"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, not, or, type SQL, sql } from "drizzle-orm"
import { budgetAwaitsAnswerSql, budgetValueOptionSql } from "./budget-awaiting.js"
import { orgMoney } from "./report-value.js"
import { foldedWordsMatch } from "./search-text.js"
import { testContactSql } from "./conversation-state.js"
import { CHANNEL_NAME } from "./agent-person-memory.js"
import { requireContact } from "./contacts.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import {
  findOrgCurrency,
  findOrgLocale,
  NO_CURRENCY,
  orgProfileRequired,
  requireOrgCurrency,
} from "./locale.js"
import { requirePatient } from "./patients.js"
import { ensureDefaultPipeline, momentRank, type SaleMoment, stageOfMoment } from "./pipelines.js"
import { createTask, settleTask, updateTask } from "./tasks.js"
import { createWorkspaceNotification } from "./workspace.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

export type { OpportunityStatus }

/**
 * Una oportunidad es un interés concreto de una persona (ADR 0028). Avanza
 * sola por cuatro pasos fijos con lo que pasa de verdad (una cita, un
 * presupuesto, su respuesta), y el equipo puede moverla a mano: las dos vías
 * son la misma operación (`moveOpportunity`, `closeOpportunity`), con su
 * auditoría y quién lo hizo. Su próxima acción es su tarea abierta, una sola.
 */

/** Los motivos de cierre con sus palabras. */
export const CLOSE_REASON_WORDS: Record<OpportunityCloseReason, string> = {
  precio: "Precio",
  otra_clinica: "Eligió otra clínica",
  no_responde: "No responde",
  no_lo_necesita: "Ya no lo necesita",
  otro: "Otro",
  rechazo_presupuesto: "Rechazó el presupuesto",
  acepto: "Aceptó",
  acepto_presupuesto: "Aceptó el presupuesto",
}

/** Los motivos que elige una persona o el agente al perderla, en su orden. */
export const CHOOSABLE_LOST_REASONS = ["precio", "otra_clinica", "no_responde", "no_lo_necesita", "otro"] as const
export type ChoosableLostReason = (typeof CHOOSABLE_LOST_REASONS)[number]

/** Lo que dice cada paso de lo que lo hará avanzar. */
const AFTER_WORDS: Record<SaleMoment, string | null> = {
  interesado: "Cuando agende su evaluación, avanza sola",
  evaluacion_agendada: "Cuando se presente el presupuesto, avanza sola",
  presupuesto_enviado: "Cuando acepte o rechace el presupuesto, se cierra sola",
  decidio: null,
}

/**
 * Lo que pasó de verdad cuando se movió sola. Solo avanza, salvo una
 * excepción: cancelar la evaluación que la llevó a «Evaluación agendada» la
 * devuelve a «Interesado» (`evaluacion_cancelada`).
 */
export type MoveCause =
  | "cita_agendada"
  | "cita_enlace"
  | "cita_recepcion"
  | "evaluacion_cancelada"
  | "presupuesto_presentado"
  | "presupuesto_aceptado"
  | "presupuesto_rechazado"
  /** Su presupuesto venció hace más de 30 días sin respuesta (ADR 0144). */
  | "presupuesto_vencido"
  /** Se reabrió sola: respondió después de darse por perdida (ADR 0144). */
  | "respondio"
  /** Se reabrió sola: le presentaron otra versión del presupuesto (ADR 0144). */
  | "nueva_version"

/** Quién hace algo con la oportunidad: una persona, el agente o el sistema por algo que pasó. */
export interface OpportunityActor {
  userId: string | null
  origin?: OpportunityEventOrigin
}

function originOf(actor: OpportunityActor | undefined): OpportunityEventOrigin {
  return actor?.origin ?? (actor?.userId ? "persona" : "automatico")
}

const NOTE_MAX = 500

/** Aviso mínimo CRM para refresco: solo `{ orgId, kind, at }`, sin PII. */
async function notifyOpp(tx: Db, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "opportunity.updated", at: new Date().toISOString() })})`,
  )
}

/** La tarea abierta de la oportunidad: su próxima acción. */
export interface OpportunityTask {
  id: string
  title: string
  dueAt: string | null
  assigneeUserId: string | null
  /** Sin responsable, a qué parte del equipo va (Recepción). */
  area: string | null
}

export interface OpportunityListItem {
  id: string
  title: string
  contactId: string
  contactName: string
  patientId: string | null
  patientName: string | null
  pipelineId: string
  stageId: string
  stageName: string
  /** El paso fijo en que está (`SALE_MOMENTS`). */
  moment: SaleMoment
  status: OpportunityStatus
  amountCents: number | null
  currency: string
  interestText: string | null
  serviceId: string | null
  serviceName: string | null
  /** Sin responsable es de Recepción hasta que alguien la toma. */
  assignedUserId: string | null
  conversationId: string | null
  budgetId: string | null
  closedAt: string | null
  /** Clave del motivo de cierre. */
  closeReason: OpportunityCloseReason | null
  closeNote: string | null
  /**
   * Por qué está donde está, con palabras y la fecha en la zona de la clínica:
   * «Pasó sola: agendó su evaluación para el jue 17», «Perdida: «Precio»».
   */
  why: string | null
  /** Quién hizo el último movimiento: el agente y lo automático se destacan en el tablero. */
  lastOrigin: OpportunityEventOrigin | null
  nextTask: OpportunityTask | null
  createdAt: string
  updatedAt: string
}

export interface OpportunityHistoryItem {
  id: string
  action: string
  /** Quién lo hizo, dicho con palabras: el nombre, «El agente» o «Automático». */
  who: string
  origin: OpportunityEventOrigin
  /** Qué pasó: «Pasó a «Evaluación agendada»: agendó su evaluación para el jue 17». */
  what: string
  createdAt: string
}

export interface OpportunityDetail extends OpportunityListItem {
  contactPhone: string | null
  contactEmail: string | null
  /** El valor es el precio del servicio en la lista de precios. */
  amountFromPriceList: boolean
  /** El valor es el total del presupuesto que se le presentó. */
  amountFromBudget: boolean
  /**
   * Ese presupuesto va en dos monedas: el valor es un estimado en moneda del negocio
   * al cambio de hoy. El presupuesto sigue en sus monedas y se cobra en ellas.
   */
  amountEstimated: boolean
  budgetTitle: string | null
  budgetNumber: number | null
  budgetStatus: string | null
  /**
   * La próxima cita de la persona, si quien mira puede ver la agenda, dicha
   * con la zona de la clínica: «Evaluación · jue 17 oct, 10:30 · Dra. Ruiz».
   */
  nextAppointment: { startsAt: string; text: string } | null
  /** Lo que la hará avanzar sola: «Cuando se presente el presupuesto, avanza sola». */
  after: string | null
  history: OpportunityHistoryItem[]
}

export interface OpportunityFilters {
  q?: string
  contactId?: string
  patientId?: string
  pipelineId?: string
  stageId?: string
  status?: OpportunityStatus
  /** Un miembro, o `none` para las que nadie tomó (las de Recepción). */
  assignedUserId?: string
  /** Solo las que tienen su tarea vencida. */
  taskDue?: boolean
  /** Solo las que el agente creó o movió alguna vez. */
  byAgent?: boolean
  /** El tablero: lo abierto y lo cerrado de los últimos 30 días. */
  recent?: boolean
  cursor?: string
  limit?: number
}

export interface CreateOpportunityInput {
  contactId: string
  patientId?: string | null
  pipelineId?: string
  title: string
  serviceId?: string | null
  interestText?: string | null
  /** Sin servicio, el valor que escribe el equipo; con servicio sale de su precio. */
  amountCents?: number | null
  assignedUserId?: string | null
  budgetId?: string | null
  conversationId?: string | null
}

export interface UpdateOpportunityInput {
  contactId?: string
  patientId?: string | null
  title?: string
  serviceId?: string | null
  interestText?: string | null
  amountCents?: number | null
  assignedUserId?: string | null
  budgetId?: string | null
  conversationId?: string | null
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

function asOrigin(value: string): OpportunityEventOrigin | null {
  return value === "persona" || value === "agente" || value === "automatico" ? value : null
}

function asStatus(value: string): OpportunityStatus {
  if (value === "won" || value === "lost" || value === "open") return value
  throw validation("Estado de oportunidad inválido")
}

function asMoment(value: string): SaleMoment {
  return value === "evaluacion_agendada" || value === "presupuesto_enviado" || value === "decidio" ? value : "interesado"
}

function asCloseReason(value: string | null): OpportunityCloseReason | null {
  if (!value) return null
  return value in CLOSE_REASON_WORDS ? (value as OpportunityCloseReason) : "otro"
}

// ------------------------------------------------------------- palabras ---

interface Zone {
  timezone: string
  locale: string
}

/** «2026-10-17» en la zona de la clínica. */
function dayKey(date: Date, zone: Zone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

function wordsLocale(zone: Zone): string {
  return zone.locale.toLowerCase().startsWith("es") ? zone.locale : "es"
}

/** «jue 17», en la zona de la clínica. */
function shortDay(date: Date, zone: Zone): string {
  const weekday = new Intl.DateTimeFormat(wordsLocale(zone), { timeZone: zone.timezone, weekday: "short" })
    .format(date)
    .replace(/\.$/, "")
  const day = new Intl.DateTimeFormat("en-US", { timeZone: zone.timezone, day: "numeric" }).format(date)
  return `${weekday} ${day}`
}

/** «hoy», «ayer», «mañana» o «el jue 17», en la zona de la clínica. */
export function dayWords(date: Date, now: Date, zone: Zone): string {
  const diff = Math.round((Date.parse(dayKey(date, zone)) - Date.parse(dayKey(now, zone))) / 86_400_000)
  if (diff === 0) return "hoy"
  if (diff === -1) return "ayer"
  if (diff === 1) return "mañana"
  return `el ${shortDay(date, zone)}`
}

/** «jue 17 oct, 10:30», en la zona de la clínica. */
function dayAndTime(date: Date, zone: Zone): string {
  const month = new Intl.DateTimeFormat(wordsLocale(zone), { timeZone: zone.timezone, month: "short" })
    .format(date)
    .replace(/\.$/, "")
  const time = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, hour: "2-digit", minute: "2-digit" }).format(date)
  return `${shortDay(date, zone)} ${month}, ${time}`
}

/** «6 dic»: un día del calendario (`AAAA-MM-DD`) en el idioma de la clínica. */
function calendarDay(day: string, zone: Zone): string {
  return new Intl.DateTimeFormat(wordsLocale(zone), { timeZone: "UTC", day: "numeric", month: "short" })
    .format(new Date(`${day}T12:00:00Z`))
    .replace(/\./g, "")
}

/**
 * Lo que la hará avanzar sola. En «Presupuesto enviado» sin presupuesto unido
 * (se anuló o se soltó al vencer), nada la cerrará sola. Si nació del
 * presupuesto y nadie la trabaja, avisa cuándo se dará por perdida si no
 * responde (ADR 0144) y cómo evitarlo.
 */
async function afterWords(
  tx: Db,
  orgId: string,
  item: Pick<OpportunityListItem, "id" | "status" | "moment">,
  budgetId: string | null,
  zone: Zone,
): Promise<string | null> {
  if (item.status !== "open") return null
  if (item.moment !== "presupuesto_enviado") return AFTER_WORDS[item.moment]
  if (!budgetId) return null
  const closesOn = await unansweredClosesOn(tx, orgId, item.id)
  if (!closesOn) return AFTER_WORDS[item.moment]
  return `${AFTER_WORDS[item.moment]}. Si no responde, el ${calendarDay(closesOn, zone)} se cierra sola como perdida: tómala o déjale una tarea para seguirla`
}

/** Lo último que le pasó a una oportunidad, para decir por qué está donde está. */
interface LastEvent {
  action: string
  origin: string
  cause: string | null
  causeAt: Date | null
  actorName: string | null
  createdAt: Date
  channel: string | null
}

/** Las causas que son una cita agendada: la evaluación que la llevó a «Evaluación agendada». */
const APPOINTMENT_CAUSES: ReadonlyArray<string> = ["cita_agendada", "cita_enlace", "cita_recepcion"]

/** Lo que hizo el agente, con las mismas palabras en la tarjeta y en el historial. */
function agentWords(cause: string | null, causeAt: Date | null, at: Date, now: Date, zone: Zone): string {
  if (cause === "cita_agendada" && causeAt) return `Sofi le agendó la evaluación para ${dayWords(causeAt, now, zone)}`
  if (cause === "presupuesto_presentado") return `Sofi le presentó el presupuesto ${dayWords(at, now, zone)}`
  return `La movió Sofi ${dayWords(at, now, zone)}`
}

function causeWords(cause: string | null, causeAt: Date | null, at: Date, now: Date, zone: Zone): string | null {
  if (cause === "cita_enlace") return causeAt ? `la agendó desde su enlace para ${dayWords(causeAt, now, zone)}` : "la agendó desde su enlace"
  if (cause === "cita_recepcion") return causeAt ? `el equipo le agendó la evaluación para ${dayWords(causeAt, now, zone)}` : "el equipo le agendó la evaluación"
  if (cause === "cita_agendada") return causeAt ? `agendó su evaluación para ${dayWords(causeAt, now, zone)}` : "agendó su evaluación"
  if (cause === "evaluacion_cancelada") return causeAt ? `canceló su evaluación del ${shortDay(causeAt, zone)}` : "canceló su evaluación"
  if (cause === "presupuesto_presentado") return `el equipo presentó el presupuesto ${dayWords(at, now, zone)}`
  if (cause === "presupuesto_aceptado") return "aceptó el presupuesto"
  if (cause === "presupuesto_rechazado") return "rechazó el presupuesto"
  return null
}

function whyOf(
  row: { status: string; closeReason: string | null },
  last: LastEvent | null,
  now: Date,
  zone: Zone,
): string | null {
  const reason = asCloseReason(row.closeReason)
  if (row.status === "won") return `Ganada: ${reason ? CLOSE_REASON_WORDS[reason].toLowerCase() : "aceptó"}`
  if (row.status === "lost") return `Perdida: «${reason ? CLOSE_REASON_WORDS[reason] : "Otro"}»`
  if (!last) return null
  const when = dayWords(last.createdAt, now, zone)
  if (last.action === "opportunity.moved") {
    if (last.origin === "automatico") {
      const words = causeWords(last.cause, last.causeAt, last.createdAt, now, zone)
      const verb = last.cause === "evaluacion_cancelada" ? "Volvió sola" : "Pasó sola"
      return words ? `${verb}: ${words}` : `${verb} ${when}`
    }
    if (last.origin === "agente") return agentWords(last.cause, last.causeAt, last.createdAt, now, zone)
    return `La movió ${last.actorName ?? "el equipo"} ${when}`
  }
  if (last.action === "opportunity.reopened") return reopenedWords(last.cause) ?? `La reabrió ${last.actorName ?? "el equipo"} ${when}`
  if (last.action === "opportunity.created") {
    // Nació con su presupuesto (ADR 0144): quién se lo presentó.
    if (last.cause === "presupuesto_presentado") {
      if (last.origin === "agente") return agentWords(last.cause, last.causeAt, last.createdAt, now, zone)
      return `Se abrió sola: ${last.actorName ?? "el equipo"} presentó el presupuesto ${when}`
    }
    if (last.origin === "agente") {
      const channel = last.channel ? CHANNEL_NAME[last.channel] ?? null : null
      return `Lo pidió${channel ? ` por ${channel}` : ""} ${when}`
    }
    if (last.origin === "persona") return `La creó ${last.actorName ?? "el equipo"} ${when}`
  }
  return null
}

/** Por qué se reabrió sola (ADR 0144), con las mismas palabras en la tarjeta y en el historial. */
function reopenedWords(cause: string | null): string | null {
  if (cause === "respondio") return "Se reabrió sola: respondió después de darse por perdida"
  if (cause === "nueva_version") return "Se reabrió sola: le presentaron otra versión del presupuesto"
  return null
}

const ACTION_WORDS: Record<string, string> = {
  "opportunity.created": "La creó",
  "opportunity.updated": "Cambió sus datos",
  "opportunity.moved": "La movió",
  "opportunity.won": "La cerró como ganada",
  "opportunity.lost": "La cerró como perdida",
  "opportunity.reopened": "La reabrió",
}

function historyWhat(
  event: { action: string; origin: string; cause: string | null; causeAt: Date | null; note: string | null; createdAt: Date },
  toStageName: string | null,
  now: Date,
  zone: Zone,
  actorName: string | null = null,
): string {
  if (event.action === "opportunity.created" && event.cause === "presupuesto_presentado") {
    const target = toStageName ? ` en «${toStageName}»` : ""
    if (event.origin === "agente") return `${agentWords(event.cause, event.causeAt, event.createdAt, now, zone)}: se abrió${target}`
    return `Se abrió sola${target}: ${actorName ?? "el equipo"} presentó el presupuesto ${dayWords(event.createdAt, now, zone)}`
  }
  if (event.action === "opportunity.moved") {
    const target = toStageName ? ` a «${toStageName}»` : ""
    if (event.origin === "agente") {
      const phrase = agentWords(event.cause, event.causeAt, event.createdAt, now, zone)
      return toStageName ? `${phrase}: pasó a «${toStageName}»` : phrase
    }
    const words = event.origin === "automatico" ? causeWords(event.cause, event.causeAt, event.createdAt, now, zone) : null
    const verb = event.cause === "evaluacion_cancelada" ? "Volvió sola" : "Pasó sola"
    return words ? `${verb}${target}: ${words}` : `La movió${target}`
  }
  if (event.action === "opportunity.won" || event.action === "opportunity.lost") {
    const reason = event.note ? `: ${event.note}` : ""
    return `${ACTION_WORDS[event.action]}${reason}`
  }
  if (event.action === "opportunity.reopened") return reopenedWords(event.cause) ?? ACTION_WORDS[event.action]!
  return ACTION_WORDS[event.action] ?? "Cambió la oportunidad"
}

function whoOf(origin: string, actorName: string | null): string {
  if (origin === "agente") return "Sofi"
  if (origin === "automatico") return "Automático"
  return actorName ?? "Una persona del equipo"
}

// ------------------------------------------------------------ validación ---

async function requireOpportunity(tx: Db, orgId: string, id: string, forUpdate = false) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Oportunidad")
  const query = tx
    .select()
    .from(opportunity)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
    .limit(1)
    .$dynamic()
  const [row] = forUpdate ? await query.for("update") : await query
  if (!row) throw notFound("Oportunidad")
  return row
}

async function requireStageInOrg(tx: Db, orgId: string, stageId: string) {
  const [stage] = await tx
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
    .limit(1)
  if (!stage) throw validation("Etapa inválida para esta organización")
  return stage
}

/** El asignado debe ser miembro de la org; null libera la asignación. */
async function resolveAssignee(
  tx: Db,
  orgId: string,
  assignedUserId: string | null | undefined,
): Promise<string | null | undefined> {
  if (assignedUserId === undefined) return undefined
  if (assignedUserId === null) return null
  const [membership] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, assignedUserId)))
    .limit(1)
  if (!membership) throw invalidField("assignedUserId", "El asignado no es miembro de esta organización")
  return membership.userId
}

function cleanTitle(title: string): string {
  const value = title.trim()
  if (!value || value.length > 200) throw invalidField("title", "El título debe tener 1–200 caracteres")
  return value
}

function cleanAmount(amountCents: number | null | undefined): number | null | undefined {
  if (amountCents === undefined || amountCents === null) return amountCents ?? null
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw invalidField("amountCents", "El valor debe ser un entero de céntimos >= 0")
  }
  return amountCents
}

/** `label` es cómo se nombra en el mensaje; `key`, el nombre del dato en el cuerpo. */
function cleanNote(note: string | null | undefined, max: number, label: string, key: string) {
  if (note === undefined) return undefined
  if (note === null) return null
  const value = note.trim()
  if (!value) return null
  if (value.length > max) throw invalidField(key, `${label} no puede superar ${max} caracteres`)
  return value
}

/** Servicio de la lista de precios de la org, con su precio. */
async function resolveService(
  tx: Db,
  orgId: string,
  serviceId: string | null | undefined,
): Promise<{ id: string; priceCents: number; currency: string } | null | undefined> {
  if (serviceId === undefined) return undefined
  if (serviceId === null) return null
  const [service] = await tx
    .select({ id: serviceCatalog.id, priceCents: serviceCatalog.priceCents, currency: serviceCatalog.currency })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  if (!service) throw invalidField("serviceId", "Servicio inválido para esta organización")
  return service
}

/**
 * Presupuesto de la org; si la oportunidad ya tiene paciente, el presupuesto
 * debe ser del mismo paciente (no mezclar economía de dos fichas clínicas).
 */
async function resolveBudget(
  tx: Db,
  orgId: string,
  budgetId: string | null | undefined,
  patientId: string | null | undefined,
): Promise<string | null | undefined> {
  if (budgetId === undefined) return undefined
  if (budgetId === null) return null
  const [budget] = await tx
    .select({ id: treatmentBudget.id, patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  if (!budget) throw invalidField("budgetId", "Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw invalidField("budgetId", "El presupuesto pertenece a otro paciente")
  }
  return budget.id
}

/** Conversación de la org con su contacto dueño. */
async function requireConversationInOrg(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  return row
}

/**
 * El paciente debe estar vinculado al contacto (patient_contact), sin duplicar
 * fichas. `field`: el dato del cuerpo que lo trajo (el paciente o, si se
 * adoptó del presupuesto, el presupuesto).
 */
async function requirePatientLink(tx: Db, orgId: string, patientId: string, contactId: string, field = "patientId"): Promise<void> {
  const [link] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.contactId, contactId),
      ),
    )
    .limit(1)
  if (!link) throw invalidField(field, "El paciente no está vinculado a este contacto")
}

/** Presupuesto efectivo coherente con el paciente efectivo (también al cambiar patientId). */
async function assertBudgetCoherent(
  tx: Db,
  orgId: string,
  budgetId: string | null,
  patientId: string | null,
): Promise<void> {
  if (!budgetId) return
  const [budget] = await tx
    .select({ id: treatmentBudget.id, patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  if (!budget) throw invalidField("budgetId", "Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw invalidField("budgetId", "El presupuesto pertenece a otro paciente")
  }
  if (!patientId && budget.patientId) {
    throw invalidField("budgetId", "El presupuesto pertenece a otro paciente")
  }
}

/** Valida el hilo origen: debe ser de la org y del mismo contacto de la oportunidad. */
async function resolveOpportunityConversation(
  tx: Db,
  orgId: string,
  conversationId: string | null | undefined,
  effectiveContactId: string,
): Promise<string | null | undefined> {
  if (conversationId === undefined) return undefined
  if (conversationId === null) return null
  const row = await requireConversationInOrg(tx, orgId, conversationId)
  if (row.contactId !== effectiveContactId) {
    throw validation("La conversación pertenece a otro contacto")
  }
  return row.id
}

async function auditOpportunity(
  tx: Db,
  orgId: string,
  actor: OpportunityActor | undefined,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const origin = originOf(actor)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: actor?.userId ?? null,
    action,
    entity: "opportunity",
    entityId,
    metadata: { ...metadata, ...(origin === "agente" ? { origin: "agent" } : origin === "automatico" ? { origin: "system" } : {}) },
  })
}

async function recordEvent(
  tx: Db,
  orgId: string,
  opportunityId: string,
  action: string,
  fromStageId: string | null,
  toStageId: string | null,
  actor: OpportunityActor | undefined,
  extra: { note?: string | null; cause?: MoveCause | null; causeAt?: Date | null } = {},
): Promise<void> {
  await tx.insert(opportunityEvent).values({
    organizationId: orgId,
    opportunityId,
    action,
    fromStageId,
    toStageId,
    actorUserId: actor?.userId ?? null,
    origin: originOf(actor),
    cause: extra.cause ?? null,
    causeAt: extra.causeAt ?? null,
    note: extra.note ?? null,
  })
}

/**
 * Aviso a quien lleva la oportunidad. No le llega si lo hizo él mismo
 * (`actorUserId`). Con asunto, el aviso se retira solo cuando la oportunidad se
 * cierra o pasa a otra persona.
 */
async function notifyAssignee(
  tx: Db,
  orgId: string,
  assignedUserId: string | null,
  dedupeKey: string,
  title: string,
  body: string,
  opts: { actorUserId: string | null; opportunityId?: string; link: string },
): Promise<void> {
  if (!assignedUserId) return
  const [opp] = await tx
    .select({ contactId: opportunity.contactId })
    .from(opportunity)
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.id, opts.link)))
    .limit(1)
  await createWorkspaceNotification(tx, orgId, {
    userId: assignedUserId,
    contactId: opp?.contactId ?? null,
    dedupeKey,
    title,
    body,
    // La oportunidad se abre al lado del tablero.
    href: `/pipeline?oportunidad=${opts.link}`,
    permission: "crm.read",
    actorUserId: opts.actorUserId,
    subject: opts.opportunityId ? `oportunidad:${opts.opportunityId}` : null,
  })
}

// ---------------------------------------------------------------- lista ---

const PAGE_DEFAULT = 30
/** El tablero muestra lo cerrado de los últimos 30 días. */
const RECENT_CLOSED_DAYS = 30

function encodeCursor(ts: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ ts, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeCursor(cursor: string): { ts: string; id: string; f: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { ts: string; id: string; f: string }
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string") return null
    return parsed
  } catch {
    return null
  }
}

/** Las condiciones de los filtros: las mismas para la lista y para su resumen. */
function filterConditions(orgId: string, input: Omit<OpportunityFilters, "cursor" | "limit">): SQL[] {
  // La oportunidad de una persona de prueba se ve en «Probar», no en la lista (ADR 0094).
  const conditions: SQL[] = [eq(opportunity.organizationId, orgId), sql`not ${testContactSql(sql`${opportunity.contactId}`)}`]
  const q = input.q?.trim() ?? ""
  if (input.status && !OPPORTUNITY_STATUSES.includes(input.status)) throw validation("Estado de oportunidad inválido")
  if (q) {
    conditions.push(
      foldedWordsMatch(
        [
          opportunity.title,
          opportunity.interestText,
          sql`(select c.display_name from contact c where c.id = ${opportunity.contactId} and c.organization_id = ${orgId})`,
        ],
        q,
      ),
    )
  }
  if (input.contactId) conditions.push(eq(opportunity.contactId, input.contactId))
  if (input.patientId) conditions.push(eq(opportunity.patientId, input.patientId))
  if (input.pipelineId) conditions.push(eq(opportunity.pipelineId, input.pipelineId))
  if (input.stageId) conditions.push(eq(opportunity.stageId, input.stageId))
  if (input.status) conditions.push(eq(opportunity.status, input.status))
  if (input.assignedUserId === "none") conditions.push(isNull(opportunity.assignedUserId))
  else if (input.assignedUserId) conditions.push(eq(opportunity.assignedUserId, input.assignedUserId))
  if (input.taskDue) {
    conditions.push(sql`exists (select 1 from task t where t.organization_id = ${orgId} and t.opportunity_id = ${opportunity.id}
      and t.status = 'open' and t.due_at is not null and t.due_at <= now())`)
  }
  if (input.byAgent) {
    conditions.push(sql`exists (select 1 from opportunity_event e where e.organization_id = ${orgId} and e.opportunity_id = ${opportunity.id} and e.origin = 'agente')`)
  }
  if (input.recent) {
    conditions.push(
      or(
        eq(opportunity.status, "open"),
        gte(opportunity.closedAt, sql`now() - make_interval(days => ${RECENT_CLOSED_DAYS})`),
      )!,
    )
  }
  return conditions
}

const NEXT_TASK = sql<string | null>`(select json_build_object('id', t.id, 'title', t.title,
    'dueAt', to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'assigneeUserId', t.assignee_user_id, 'area', t.area)::text
  from task t where t.organization_id = ${opportunity.organizationId} and t.opportunity_id = ${opportunity.id}
    and t.status = 'open' limit 1)`

const LAST_EVENT = sql<string | null>`(select json_build_object('action', e.action, 'origin', e.origin, 'cause', e.cause,
    'causeAt', e.cause_at, 'createdAt', e.created_at, 'actorName', u.name, 'channel', cc.channel)::text
  from opportunity_event e
  left join "user" u on u.id = e.actor_user_id
  left join conversation cv on cv.id = ${opportunity.conversationId} and cv.organization_id = e.organization_id
  left join channel_connection cc on cc.id = cv.channel_connection_id and cc.organization_id = e.organization_id
  where e.organization_id = ${opportunity.organizationId} and e.opportunity_id = ${opportunity.id}
    and e.action <> 'opportunity.updated'
  order by e.created_at desc, e.id desc limit 1)`

function parseNextTask(raw: string | null): OpportunityTask | null {
  if (!raw) return null
  const value = JSON.parse(raw) as OpportunityTask
  return { id: value.id, title: value.title, dueAt: value.dueAt ?? null, assigneeUserId: value.assigneeUserId ?? null, area: value.area ?? null }
}

function parseLastEvent(raw: string | null): LastEvent | null {
  if (!raw) return null
  const value = JSON.parse(raw) as {
    action: string
    origin: string
    cause: string | null
    causeAt: string | null
    createdAt: string
    actorName: string | null
    channel: string | null
  }
  return {
    action: value.action,
    origin: value.origin,
    cause: value.cause,
    causeAt: value.causeAt ? new Date(value.causeAt) : null,
    createdAt: new Date(value.createdAt),
    actorName: value.actorName,
    channel: value.channel,
  }
}

const listColumns = {
  opp: opportunity,
  contactName: contact.displayName,
  patientName: patientPerson.displayName,
  stageName: pipelineStage.name,
  moment: pipelineStage.moment,
  serviceName: serviceCatalog.name,
  nextTask: NEXT_TASK,
  lastEvent: LAST_EVENT,
  cursorAt: sql<string>`to_char(${opportunity.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
}

type ListRow = {
  opp: typeof opportunity.$inferSelect
  contactName: string
  patientName: string | null
  stageName: string
  moment: string
  serviceName: string | null
  nextTask: string | null
  lastEvent: string | null
}

function toListItem(r: ListRow, now: Date, zone: Zone): OpportunityListItem {
  const last = parseLastEvent(r.lastEvent)
  return {
    id: r.opp.id,
    title: r.opp.title,
    contactId: r.opp.contactId,
    contactName: r.contactName,
    patientId: r.opp.patientId,
    patientName: r.patientName,
    pipelineId: r.opp.pipelineId,
    stageId: r.opp.stageId,
    stageName: r.stageName,
    moment: asMoment(r.moment),
    status: asStatus(r.opp.status),
    amountCents: r.opp.amountCents,
    currency: r.opp.currency,
    interestText: r.opp.interestText,
    serviceId: r.opp.serviceId,
    serviceName: r.serviceName,
    assignedUserId: r.opp.assignedUserId,
    conversationId: r.opp.conversationId,
    budgetId: r.opp.budgetId,
    closedAt: iso(r.opp.closedAt),
    closeReason: asCloseReason(r.opp.closeReason),
    closeNote: r.opp.closeNote,
    why: whyOf(r.opp, last, now, zone),
    lastOrigin: last ? asOrigin(last.origin) : null,
    nextTask: parseNextTask(r.nextTask),
    createdAt: r.opp.createdAt.toISOString(),
    updatedAt: r.opp.updatedAt.toISOString(),
  }
}

function baseListQuery(tx: Db, orgId: string) {
  return tx
    .select(listColumns)
    .from(opportunity)
    .innerJoin(contact, and(eq(contact.id, opportunity.contactId), eq(contact.organizationId, orgId)))
    .leftJoin(patient, and(eq(patient.id, opportunity.patientId), eq(patient.organizationId, orgId)))
    .leftJoin(patientPerson, joinPatientPerson(patientPerson))
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, opportunity.serviceId))
}

export async function listOpportunities(
  tx: Db,
  orgId: string,
  input: OpportunityFilters,
  now: Date = new Date(),
): Promise<{ items: OpportunityListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  const { cursor, limit: _limit, ...filters } = input
  const fingerprint = JSON.stringify({ ...filters, q: filters.q?.trim() ?? "" })
  const conditions = filterConditions(orgId, filters)
  if (cursor) {
    const decoded = decodeCursor(cursor)
    if (!decoded || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint) throw validation("El cursor no corresponde a los filtros actuales")
    if (Number.isNaN(new Date(decoded.ts).getTime())) throw validation("Cursor inválido")
    conditions.push(
      or(
        lt(opportunity.updatedAt, sql`${decoded.ts}::timestamptz`),
        and(eq(opportunity.updatedAt, sql`${decoded.ts}::timestamptz`), lt(opportunity.id, decoded.id)),
      )!,
    )
  }
  const rows = await baseListQuery(tx, orgId)
    .where(and(...conditions))
    .orderBy(desc(opportunity.updatedAt), desc(opportunity.id))
    .limit(limit + 1)
  const zone = await findOrgLocale(tx, orgId)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    items: page.map((r) => toListItem(r, now, zone)),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursorAt, last.opp.id, fingerprint) : null,
  }
}

export interface OpportunitySummaryStage {
  stageId: string
  count: number
  /** Valor de lo abierto en ese paso (lo cerrado no suma). */
  amounts: Array<{ currency: string; amountCents: string }>
  /** Cuántas se ganaron y cuántas se perdieron en ese paso (con los mismos filtros). */
  won: number
  lost: number
  /** Valor de lo ganado en ese paso: la columna «Ganadas» lo muestra. */
  wonAmounts: Array<{ currency: string; amountCents: string }>
}

export interface OpportunitySummary {
  total: number
  /** Cuántas siguen abiertas: el subtítulo habla de ellas. */
  open: number
  won: number
  lost: number
  /** Valor de lo abierto, por moneda: el total del tablero solo suma lo abierto. */
  openAmounts: Array<{ currency: string; amountCents: string }>
  stages: OpportunitySummaryStage[]
}

/** Resumen agregado por filtros (mismos filtros de lista, sin cursor/limit). */
export async function getOpportunitySummary(
  tx: Db,
  orgId: string,
  input: Omit<OpportunityFilters, "cursor" | "limit">,
): Promise<OpportunitySummary> {
  const where = and(...filterConditions(orgId, input))
  const grouped = await tx
    .select({
      stageId: opportunity.stageId,
      position: pipelineStage.position,
      currency: opportunity.currency,
      count: sql<number>`count(*)::int`,
      open: sql<number>`(count(*) filter (where ${opportunity.status} = 'open'))::int`,
      openCents: sql<string>`coalesce(sum(${opportunity.amountCents}) filter (where ${opportunity.status} = 'open'), 0)::text`,
      openWithAmount: sql<number>`(count(${opportunity.amountCents}) filter (where ${opportunity.status} = 'open'))::int`,
      won: sql<number>`(count(*) filter (where ${opportunity.status} = 'won'))::int`,
      lost: sql<number>`(count(*) filter (where ${opportunity.status} = 'lost'))::int`,
      wonCents: sql<string>`coalesce(sum(${opportunity.amountCents}) filter (where ${opportunity.status} = 'won'), 0)::text`,
      wonWithAmount: sql<number>`(count(${opportunity.amountCents}) filter (where ${opportunity.status} = 'won'))::int`,
    })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(where)
    .groupBy(opportunity.stageId, pipelineStage.position, opportunity.currency)
  const byStage = new Map<string, OpportunitySummaryStage & { position: number }>()
  const openAmounts = new Map<string, bigint>()
  let total = 0
  let open = 0
  let won = 0
  let lost = 0
  for (const row of grouped) {
    total += row.count
    open += row.open
    won += row.won
    lost += row.lost
    const entry = byStage.get(row.stageId) ?? { stageId: row.stageId, count: 0, amounts: [], won: 0, lost: 0, wonAmounts: [], position: row.position }
    entry.count += row.count
    entry.won += row.won
    entry.lost += row.lost
    if (row.wonWithAmount > 0) entry.wonAmounts.push({ currency: row.currency, amountCents: row.wonCents })
    if (row.openWithAmount > 0) {
      entry.amounts.push({ currency: row.currency, amountCents: row.openCents })
      openAmounts.set(row.currency, (openAmounts.get(row.currency) ?? 0n) + BigInt(row.openCents))
    }
    byStage.set(row.stageId, entry)
  }
  const stages = [...byStage.values()]
    .sort((a, b) => a.position - b.position)
    .map(({ position: _position, ...stage }) => ({
      ...stage,
      amounts: stage.amounts.sort((a, b) => (a.currency < b.currency ? -1 : 1)),
      wonAmounts: stage.wonAmounts.sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    }))
  return {
    total,
    open,
    won,
    lost,
    openAmounts: [...openAmounts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, cents]) => ({ currency, amountCents: cents.toString() })),
    stages,
  }
}

// --------------------------------------------------------------- detalle ---

export async function getOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  options: { appointments?: boolean; now?: Date } = {},
): Promise<OpportunityDetail> {
  await requireOpportunity(tx, orgId, id)
  const now = options.now ?? new Date()
  const zone = await findOrgLocale(tx, orgId)
  const [row] = await baseListQuery(tx, orgId)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Contacto")
  const item = toListItem(row, now, zone)
  const [[contactRow], [service], [budget], events] = await Promise.all([
    tx
      .select({ phone: contact.phone, email: contact.email })
      .from(contact)
      .where(and(eq(contact.id, row.opp.contactId), eq(contact.organizationId, orgId)))
      .limit(1),
    row.opp.serviceId
      ? tx
          .select({ priceCents: serviceCatalog.priceCents, currency: serviceCatalog.currency })
          .from(serviceCatalog)
          .where(and(eq(serviceCatalog.id, row.opp.serviceId), eq(serviceCatalog.organizationId, orgId)))
          .limit(1)
      : Promise.resolve([]),
    row.opp.budgetId
      ? tx
          .select({ title: treatmentBudget.title, status: treatmentBudget.status, number: treatmentBudget.budgetNumber })
          .from(treatmentBudget)
          .where(and(eq(treatmentBudget.id, row.opp.budgetId), eq(treatmentBudget.organizationId, orgId)))
          .limit(1)
      : Promise.resolve([]),
    tx
      .select({
        event: opportunityEvent,
        actorName: user.name,
        toStageName: pipelineStage.name,
      })
      .from(opportunityEvent)
      .leftJoin(user, eq(user.id, opportunityEvent.actorUserId))
      .leftJoin(pipelineStage, eq(pipelineStage.id, opportunityEvent.toStageId))
      .where(and(eq(opportunityEvent.opportunityId, id), eq(opportunityEvent.organizationId, orgId)))
      .orderBy(asc(opportunityEvent.createdAt), asc(opportunityEvent.id)),
  ])
  let nextAppointment: OpportunityDetail["nextAppointment"] = null
  const patientId = row.opp.patientId ?? (await selfPatientOf(tx, orgId, row.opp.contactId))
  if (options.appointments && patientId && item.status === "open") {
    const [next] = await tx
      .select({ startsAt: appointment.startsAt, professionalName: user.name, serviceName: appointment.serviceName })
      .from(appointment)
      .leftJoin(user, eq(user.id, appointment.professionalUserId))
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, patientId),
          inArray(appointment.status, ["programada", "confirmada"]),
          gte(appointment.startsAt, now),
        ),
      )
      .orderBy(asc(appointment.startsAt))
      .limit(1)
    if (next) {
      nextAppointment = {
        startsAt: next.startsAt.toISOString(),
        text: [next.serviceName ?? "Cita", dayAndTime(next.startsAt, zone), next.professionalName].filter(Boolean).join(" · "),
      }
    }
  }
  const amountFromBudget =
    !!budget && budget.status !== "borrador" && row.opp.amountCents !== null &&
    !(!!service && row.opp.amountCents === service.priceCents && row.opp.currency === service.currency)
  return {
    ...item,
    contactPhone: contactRow?.phone ?? null,
    contactEmail: contactRow?.email ?? null,
    amountFromPriceList:
      !!service && row.opp.amountCents === service.priceCents && row.opp.currency === service.currency,
    amountFromBudget,
    amountEstimated: amountFromBudget && row.opp.budgetId ? await budgetValueInTwoCurrencies(tx, orgId, row.opp.budgetId) : false,
    budgetTitle: budget?.title ?? null,
    budgetNumber: budget?.number ?? null,
    budgetStatus: budget?.status ?? null,
    nextAppointment,
    after: await afterWords(tx, orgId, item, row.opp.budgetId, zone),
    history: events.map(({ event, actorName, toStageName }) => ({
      id: event.id,
      action: event.action,
      origin: (["persona", "agente", "automatico"].includes(event.origin) ? event.origin : "persona") as OpportunityEventOrigin,
      who: whoOf(event.origin, actorName),
      what: historyWhat(event, toStageName, now, zone, actorName),
      createdAt: event.createdAt.toISOString(),
    })),
  }
}

/** El paciente que es la propia persona del contacto, si lo es. */
async function selfPatientOf(tx: Db, orgId: string, contactId: string): Promise<string | null> {
  const [own] = await tx
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
  return own?.patientId ?? null
}

// ---------------------------------------------------------------- crear ---

/**
 * La oportunidad abierta de la misma persona y el mismo interés: mismo
 * contacto y paciente, y mismo servicio (o, sin servicio, mismo título). Sin
 * paciente, también la de su propia ficha y, cuando la crea el agente
 * (`widen`), la de los pacientes que lleva como apoderada sin ficha propia; el
 * equipo no se amplía a otros pacientes. El servicio cuenta también si está en
 * su presupuesto pendiente (ADR 0144). Con un presupuesto de por medio, la que
 * espera la respuesta a otro no es el mismo interés.
 */
async function sameOpenInterest(
  tx: Db,
  orgId: string,
  input: {
    contactId: string
    patientId: string | null
    serviceId: string | null
    title: string
    budgetId?: string | null
    widen?: boolean
  },
) {
  const family = input.budgetId ? await budgetFamily(tx, orgId, input.budgetId) : null
  const ownRecord = sql`${opportunity.patientId} in (select pc.patient_id from patient_contact pc
    where pc.organization_id = ${orgId} and pc.contact_id = ${input.contactId} and pc.relationship = 'self')`
  const [found] = await tx
    .select({ id: opportunity.id, title: opportunity.title })
    .from(opportunity)
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.status, "open"),
        input.patientId
          ? and(eq(opportunity.contactId, input.contactId), eq(opportunity.patientId, input.patientId))
          : input.widen
            ? carriedBy(orgId, input.contactId)
            : and(eq(opportunity.contactId, input.contactId), or(isNull(opportunity.patientId), ownRecord)),
        input.serviceId
          ? includesService(orgId, input.serviceId)
          : sql`lower(btrim(${opportunity.title})) = lower(btrim(${input.title}))`,
        family ? not(waitsOnOtherBudget(orgId, family.ids)) : undefined,
      ),
    )
    // Primero la de la propia persona, después la de quien lleva.
    .orderBy(sql`(${opportunity.contactId} = ${input.contactId}) desc`, desc(opportunity.createdAt))
    .limit(1)
  return found ?? null
}

/**
 * Crea una oportunidad: en «Interesado». La crea el agente cuando la persona
 * pide algo concreto o el equipo; nunca nace de un «hola». No se duplica una
 * abierta del mismo interés: el agente recibe la que ya existe (`reuseOpen`) y
 * el equipo, el aviso de que ya está. Con servicio, el valor sale de su precio
 * en la lista de precios. Sin responsable es de Recepción.
 *
 * La única que nace más adelante es la de un presupuesto entregado sin otra
 * que le corresponda (`presentedBudget`, ADR 0144): nace en «Presupuesto
 * enviado», unida a él, con esa causa en el historial y su propio registro.
 */
export async function createOpportunity(
  tx: Db,
  orgId: string,
  input: CreateOpportunityInput,
  actor?: OpportunityActor,
  options: { reuseOpen?: boolean; presentedBudget?: boolean } = {},
): Promise<OpportunityDetail & { reused?: boolean }> {
  await requireContact(tx, orgId, input.contactId)
  let patientId: string | null = null
  if (input.patientId) {
    const found = await requirePatient(tx, orgId, input.patientId)
    patientId = found.id
    await requirePatientLink(tx, orgId, patientId, input.contactId)
  }
  const pipelineId = input.pipelineId ?? (await ensureDefaultPipeline(tx, orgId)).pipelineId
  if (input.pipelineId) {
    const [pipe] = await tx
      .select({ id: pipeline.id })
      .from(pipeline)
      .where(and(eq(pipeline.id, input.pipelineId), eq(pipeline.organizationId, orgId)))
      .limit(1)
    if (!pipe) throw invalidField("pipelineId", "Embudo inválido para esta organización")
  }
  const presented = options.presentedBudget === true && !!input.budgetId
  const stage = await stageOfMoment(tx, orgId, pipelineId, presented ? "presupuesto_enviado" : "interesado")
  const title = cleanTitle(input.title)
  const service = await resolveService(tx, orgId, input.serviceId)
  const budgetId = await resolveBudget(tx, orgId, input.budgetId, patientId)
  // Si el presupuesto trae paciente y no se declaró, se adopta (sin duplicar ficha).
  const effectivePatientId = patientId ?? (await budgetPatient(tx, orgId, budgetId))
  if (effectivePatientId) await requirePatientLink(tx, orgId, effectivePatientId, input.contactId, patientId ? "patientId" : "budgetId")
  // Una persona a la vez, también al crearla (el equipo, `crear_oportunidad` del agente, un presupuesto).
  const recordPerson = effectivePatientId ? await personOfPatient(tx, orgId, effectivePatientId) : null
  await lockPeople(tx, orgId, [input.contactId, ...(recordPerson ? [recordPerson] : [])])
  const existing = await sameOpenInterest(tx, orgId, {
    contactId: input.contactId,
    patientId: effectivePatientId,
    serviceId: service?.id ?? null,
    title,
    budgetId,
    widen: originOf(actor) === "agente",
  })
  if (existing) {
    if (options.reuseOpen) return { ...(await getOpportunity(tx, orgId, existing.id)), reused: true }
    throw new ServiceError(
      "OPPORTUNITY_EXISTS",
      409,
      `Esta persona ya tiene abierta la oportunidad «${existing.title}»: ábrela en vez de crear otra`,
    )
  }
  const conversationId = await resolveOpportunityConversation(tx, orgId, input.conversationId ?? null, input.contactId)
  // Con servicio, el valor es su precio en la lista de precios, en su moneda.
  const typed = cleanAmount(input.amountCents) ?? null
  const amountCents = service ? service.priceCents : typed
  // Moneda del servicio o la de la clínica. Sin importe puede nacer antes de que
  // la clínica configure su moneda: entonces «sin moneda» (ISO 4217 XXX).
  const currency =
    service?.currency ??
    (await findOrgCurrency(tx, orgId)) ??
    (amountCents === null ? NO_CURRENCY : await requireOrgCurrency(tx, orgId))
  const assignedUserId = (await resolveAssignee(tx, orgId, input.assignedUserId)) ?? null
  const interestText = cleanNote(input.interestText ?? null, 500, "El interés", "interestText") ?? null
  const [created] = await tx
    .insert(opportunity)
    .values({
      organizationId: orgId,
      contactId: input.contactId,
      patientId: effectivePatientId,
      pipelineId,
      stageId: stage.id,
      title,
      serviceId: service?.id ?? null,
      interestText,
      amountCents,
      currency,
      assignedUserId,
      status: "open",
      budgetId: budgetId ?? null,
      conversationId: conversationId ?? null,
    })
    .returning()
  if (!created) throw new Error("No se pudo crear la oportunidad")
  await recordEvent(
    tx,
    orgId,
    created.id,
    "opportunity.created",
    null,
    stage.id,
    actor,
    presented ? { cause: "presupuesto_presentado" } : {},
  )
  await auditOpportunity(tx, orgId, actor, presented ? "opportunity.created_from_budget" : "opportunity.created", created.id, {
    contactId: input.contactId,
    stageId: stage.id,
    ...(presented ? { budgetId } : {}),
  })
  await notifyOpp(tx, orgId)
  await notifyAssignee(tx, orgId, assignedUserId, `opportunity:${created.id}:assigned`, "Nueva oportunidad asignada", title, {
    actorUserId: actor?.userId ?? null,
    opportunityId: created.id,
    link: created.id,
  })
  return getOpportunity(tx, orgId, created.id)
}

export type ServiceInterestOutcome = "creada" | "actualizada" | "ya_aceptado" | "prueba"

/**
 * La persona preguntó por un servicio concreto y muestra interés (decisión 15
 * de la fase 4): lo anota el sistema, no un modelo. Sin duplicar:
 * - si quien escribe, o alguien que lleva, ya aceptó un presupuesto con ese
 *   servicio, no hace nada (ya no es un interesado);
 * - si ya tiene abierta una oportunidad de ese servicio, suya o de un paciente
 *   que lleva como apoderada sin ficha propia (también la de un presupuesto
 *   pendiente que lo incluye), la actualiza con lo que dijo ahora; con
 *   `patientId` (el agente sabe de quién es), solo la de ese paciente;
 * - si la de ese presupuesto se cerró sola porque venció sin respuesta y el
 *   presupuesto sigue esperando, la reabre: respondió (ADR 0144);
 * - si no, la crea en «Interesado» y sin responsable, que es de Recepción.
 */
export async function noteServiceInterest(
  tx: Db,
  orgId: string,
  input: { contactId: string; conversationId: string | null; serviceId: string; said: string; patientId?: string | null },
): Promise<{ outcome: ServiceInterestOutcome; opportunityId: string | null }> {
  const person = await requireContact(tx, orgId, input.contactId)
  if (input.patientId) await requirePatientLink(tx, orgId, input.patientId, input.contactId)
  // En una prueba se anota de verdad, para su persona de prueba (ADR 0094); nunca para una real.
  if (input.conversationId && !person.isTest) {
    const [thread] = await tx
      .select({ isTest: conversation.isTest })
      .from(conversation)
      .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (thread?.isTest) return { outcome: "prueba", opportunityId: null }
  }
  const [service] = await tx
    .select({ id: serviceCatalog.id, name: serviceCatalog.name })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, input.serviceId), eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.isActive, true)))
    .limit(1)
  if (!service) throw notFound("Servicio del catálogo")
  // Los pacientes de quien escribe: ella misma y quienes lleva (la misma relación explícita de siempre).
  const linked = await tx
    .select({ patientId: patientContact.patientId })
    .from(patientContact)
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.contactId, input.contactId)))
  if (linked.length) {
    const [accepted] = await tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          inArray(
            treatmentPlanItem.patientId,
            linked.map((row) => row.patientId),
          ),
          eq(treatmentPlanItem.serviceId, service.id),
          eq(treatmentPlanItem.decisionStatus, "aceptado"),
        ),
      )
      .limit(1)
    if (accepted) return { outcome: "ya_aceptado", opportunityId: null }
  }
  const interestText = input.said.replace(/\s+/g, " ").trim().slice(0, 500) || null
  // Una persona a la vez: quien escribe y quienes lleva, como al entregarles un presupuesto.
  const people = linked.length
    ? await tx
        .select({ personId: patient.personId })
        .from(patient)
        .where(and(eq(patient.organizationId, orgId), inArray(patient.id, linked.map((row) => row.patientId))))
    : []
  await lockPeople(tx, orgId, [input.contactId, ...people.map((row) => row.personId)])
  // Cualquier oportunidad abierta de ese servicio, sea para quien sea de los suyos (también la
  // de un presupuesto suyo que espera respuesta y lo incluye): es el mismo interés (ADR 0144).
  const scope = input.patientId
    ? or(eq(opportunity.patientId, input.patientId), and(eq(opportunity.contactId, input.contactId), isNull(opportunity.patientId)))!
    : carriedBy(orgId, input.contactId)
  const sameInterest = (status: "open" | "lost") =>
    tx
      .select({ id: opportunity.id, contactId: opportunity.contactId, conversationId: opportunity.conversationId })
      .from(opportunity)
      .where(
        and(
          eq(opportunity.organizationId, orgId),
          eq(opportunity.status, status),
          scope,
          includesService(orgId, service.id),
          status === "lost" ? budgetStillWaits(orgId) : undefined,
        ),
      )
      .orderBy(sql`(${opportunity.contactId} = ${input.contactId}) desc`, desc(opportunity.createdAt))
  let [open] = await sameInterest("open").limit(1)
  if (!open) {
    // Escribió por lo de un presupuesto que se dio por perdido al vencer y que sigue esperando: respondió.
    const lost = await sameInterest("lost")
    const expired = await closedForExpiry(tx, orgId, lost.map((row) => row.id))
    const back = lost.find((row) => row.id === expired)
    if (back) {
      await reopenOpportunity(tx, orgId, back.id, { userId: null, origin: "agente", cause: "respondio" })
      open = back
    }
  }
  if (open) {
    await updateOpportunity(
      tx,
      orgId,
      open.id,
      {
        interestText,
        // El hilo es de quien escribe: solo va en la oportunidad que es suya.
        ...(open.conversationId === null && input.conversationId && open.contactId === input.contactId
          ? { conversationId: input.conversationId }
          : {}),
      },
      { userId: null, origin: "agente" },
    )
    return { outcome: "actualizada", opportunityId: open.id }
  }
  const created = await createOpportunity(
    tx,
    orgId,
    {
      contactId: input.contactId,
      title: service.name,
      serviceId: service.id,
      interestText,
      ...(input.patientId ? { patientId: input.patientId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    { userId: null, origin: "agente" },
    { reuseOpen: true },
  )
  return { outcome: created.reused ? "actualizada" : "creada", opportunityId: created.id }
}

/**
 * Lo que da el valor de la oportunidad va en dos monedas: lo aceptado si ya
 * respondió con algo aceptado (solo esa parte) y, si no, la opción que vale. Sin
 * otra moneda no hay cambio de hoy con que estimar y termina en el perfil.
 */
async function budgetValueInTwoCurrencies(tx: Db, orgId: string, budgetId: string): Promise<boolean> {
  const [row] = await tx.execute<{ currencies: number }>(sql`
    select count(distinct i.currency)::int as currencies
    from treatment_budget b
    join org_profile op on op.organization_id = b.organization_id and op.second_currency is not null
    join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
      and i.option_id = ${budgetValueOptionSql({ id: sql`b.id`, organizationId: sql`b.organization_id` })}
    where b.organization_id = ${orgId} and b.id = ${budgetId}
      and (b.status not in ('aceptado', 'parcial') or i.decision = 'aceptado')`)
  return (row?.currencies ?? 0) > 1
}

async function budgetPatient(tx: Db, orgId: string, budgetId: string | null | undefined): Promise<string | null> {
  if (!budgetId) return null
  const [budget] = await tx
    .select({ patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  return budget?.patientId ?? null
}

// --------------------------------------------------------------- editar ---

export async function updateOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  input: UpdateOpportunityInput,
  actor?: OpportunityActor,
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad cerrada no se edita; reábrela primero")
  const patch: Partial<typeof opportunity.$inferInsert> = { updatedAt: new Date() }
  const changed: string[] = []
  const effectiveContactId = input.contactId ?? current.contactId
  if (input.contactId !== undefined && input.contactId !== current.contactId) {
    await requireContact(tx, orgId, input.contactId)
    patch.contactId = input.contactId
    changed.push("contactId")
  }
  let effectivePatientId: string | null = input.patientId !== undefined ? input.patientId : current.patientId
  if (input.patientId !== undefined) {
    if (input.patientId === null) {
      patch.patientId = null
      effectivePatientId = null
    } else {
      const found = await requirePatient(tx, orgId, input.patientId)
      patch.patientId = found.id
      effectivePatientId = found.id
    }
    changed.push("patientId")
  }
  if (input.title !== undefined) {
    patch.title = cleanTitle(input.title)
    changed.push("title")
  }
  let service: Awaited<ReturnType<typeof resolveService>>
  if (input.serviceId !== undefined) {
    service = await resolveService(tx, orgId, input.serviceId)
    patch.serviceId = service?.id ?? null
    changed.push("serviceId")
    // Con servicio, el valor vuelve a salir de su precio en la lista de precios.
    if (service) {
      patch.amountCents = service.priceCents
      patch.currency = service.currency
      changed.push("amountCents")
    }
  }
  if (input.interestText !== undefined) {
    patch.interestText = cleanNote(input.interestText, 500, "El interés", "interestText") ?? null
    changed.push("interestText")
  }
  const hasService = input.serviceId !== undefined ? !!service : !!current.serviceId
  if (input.amountCents !== undefined && !hasService) {
    patch.amountCents = cleanAmount(input.amountCents) ?? null
    // Un valor escrito a mano va en la moneda de la clínica, salvo que la oportunidad
    // ya esté en su otra moneda: el número se escribió mirando esa.
    if (patch.amountCents !== null) {
      const money = await orgMoney(tx, orgId)
      if (!money.currency) throw orgProfileRequired()
      patch.currency =
        current.amountCents !== null && current.currency === money.secondCurrency
          ? current.currency
          : money.currency
    }
    changed.push("amountCents")
  }
  const previousAssignee = current.assignedUserId
  let assigneeChanged = false
  if (input.assignedUserId !== undefined) {
    patch.assignedUserId = (await resolveAssignee(tx, orgId, input.assignedUserId)) ?? null
    assigneeChanged = patch.assignedUserId !== previousAssignee
    if (assigneeChanged) changed.push("assignedUserId")
  }
  const effectiveBudgetId: string | null = input.budgetId !== undefined ? input.budgetId : current.budgetId
  if (input.budgetId !== undefined) {
    patch.budgetId = (await resolveBudget(tx, orgId, input.budgetId, effectivePatientId)) ?? null
    changed.push("budgetId")
  }
  await assertBudgetCoherent(tx, orgId, effectiveBudgetId, effectivePatientId)
  // Cualquier cambio de persona, paciente o presupuesto exige la relación explícita vigente.
  const relationshipChanged =
    effectiveContactId !== current.contactId || effectivePatientId !== current.patientId || effectiveBudgetId !== current.budgetId
  if (effectivePatientId && relationshipChanged) {
    await requirePatientLink(tx, orgId, effectivePatientId, effectiveContactId)
  }
  if (input.conversationId !== undefined) {
    patch.conversationId = (await resolveOpportunityConversation(tx, orgId, input.conversationId, effectiveContactId)) ?? null
    changed.push("conversationId")
  } else if (effectiveContactId !== current.contactId && current.conversationId) {
    const conv = await requireConversationInOrg(tx, orgId, current.conversationId)
    if (conv.contactId !== effectiveContactId) throw validation("La conversación pertenece a otro contacto")
  }
  if (changed.length === 0) return getOpportunity(tx, orgId, id)
  await tx
    .update(opportunity)
    .set(patch)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.updated", null, null, actor)
  await auditOpportunity(tx, orgId, actor, "opportunity.updated", id, { fields: changed })
  // La tarea de la oportunidad sigue a la persona y a quien la lleva.
  await syncOpportunityTask(tx, orgId, id, { previousAssignee, assigneeChanged, actor })
  await notifyOpp(tx, orgId)
  if (assigneeChanged && patch.assignedUserId) {
    await notifyAssignee(tx, orgId, patch.assignedUserId, `opportunity:${id}:assigned`, "Oportunidad asignada", current.title, {
      actorUserId: actor?.userId ?? null,
      opportunityId: id,
      link: id,
    })
  }
  return getOpportunity(tx, orgId, id)
}

/**
 * La tarea abierta de la oportunidad acompaña sus cambios: el mismo contacto,
 * y quien la lleva si la tarea era de quien la llevaba antes o de nadie (sin
 * responsable, va a Recepción).
 */
async function syncOpportunityTask(
  tx: Db,
  orgId: string,
  opportunityId: string,
  input: { previousAssignee: string | null; assigneeChanged: boolean; actor?: OpportunityActor },
): Promise<void> {
  const [opp] = await tx
    .select({ contactId: opportunity.contactId, conversationId: opportunity.conversationId, assignedUserId: opportunity.assignedUserId })
    .from(opportunity)
    .where(and(eq(opportunity.id, opportunityId), eq(opportunity.organizationId, orgId)))
    .limit(1)
  if (!opp) return
  const [task] = await tx
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, opportunityId), eq(crmTask.status, "open")))
    .limit(1)
    .for("update")
  if (!task) return
  const patch: Partial<typeof crmTask.$inferInsert> = {}
  if (task.contactId !== opp.contactId) {
    patch.contactId = opp.contactId
    if (task.conversationId && task.conversationId !== opp.conversationId) patch.conversationId = opp.conversationId
  } else if (!task.conversationId && opp.conversationId) {
    // La oportunidad ganó su hilo (se le escribió por él): su tarea llega ahí también.
    patch.conversationId = opp.conversationId
  }
  if (input.assigneeChanged && (task.assigneeUserId === null || task.assigneeUserId === input.previousAssignee)) {
    patch.assigneeUserId = opp.assignedUserId
    patch.area = opp.assignedUserId ? task.area : "recepcion"
  }
  if (Object.keys(patch).length === 0) return
  await tx
    .update(crmTask)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(crmTask.id, task.id), eq(crmTask.organizationId, orgId)))
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "task.updated", at: new Date().toISOString() })})`)
}

/**
 * La próxima acción de la oportunidad: crea su tarea o, si ya tiene una
 * abierta, la cambia. Una sola tarea abierta por oportunidad.
 */
export async function setOpportunityTask(
  tx: Db,
  orgId: string,
  opportunityId: string,
  input: { title?: string | null; dueAt?: string | null },
  actor: { userId: string | null; createdBy: "user" | "agent" | "admin" },
): Promise<{ taskId: string; title: string; dueAt: string | null }> {
  const opp = await requireOpportunity(tx, orgId, opportunityId, true)
  if (opp.status !== "open") throw validation("La oportunidad ya se cerró")
  const [open] = await tx
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, opportunityId), eq(crmTask.status, "open")))
    .limit(1)
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : null
  if (open) {
    const updated = await updateTask(tx, orgId, open.id, {
      ...(title ? { title } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      actorUserId: actor.userId,
    })
    return { taskId: updated.id, title: updated.title, dueAt: updated.dueAt }
  }
  const [contactRow] = await tx
    .select({ name: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, opp.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  const created = await createTask(tx, orgId, {
    title: title ?? `Llamar a ${contactRow?.name ?? "la persona"} por ${opp.title}`.slice(0, 200),
    opportunityId,
    contactId: opp.contactId,
    conversationId: opp.conversationId,
    dueAt: input.dueAt ?? null,
    assigneeUserId: opp.assignedUserId,
    createdBy: actor.createdBy,
    actorUserId: actor.userId,
  })
  return { taskId: created.id, title: created.title, dueAt: created.dueAt }
}

// ---------------------------------------------------------------- mover ---

/**
 * Mueve la oportunidad a otro paso. Es la misma operación para el equipo
 * (arrastrar o «Mover a…»), el agente y lo que pasa solo (una cita, un
 * presupuesto): queda en el historial con quién lo hizo y, si pasó sola, por
 * qué. «Decidió» no se alcanza moviendo: se cierra con su motivo.
 */
export async function moveOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  stageId: string,
  actor?: OpportunityActor & { cause?: MoveCause; causeAt?: Date | null },
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad cerrada no se mueve; reábrela primero")
  const stage = await requireStageInOrg(tx, orgId, stageId)
  if (stage.pipelineId !== current.pipelineId) throw validation("La etapa es de otro embudo")
  if (stage.moment === "decidio") throw validation("Para cerrarla elige Ganada o Perdida, con su motivo")
  if (stage.id === current.stageId) return getOpportunity(tx, orgId, id)
  await tx
    .update(opportunity)
    .set({ stageId: stage.id, updatedAt: new Date() })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.moved", current.stageId, stage.id, actor, {
    cause: actor?.cause ?? null,
    causeAt: actor?.causeAt ?? null,
  })
  await auditOpportunity(tx, orgId, actor, "opportunity.stage_changed", id, {
    fromStageId: current.stageId,
    toStageId: stage.id,
    moment: stage.moment,
    ...(actor?.cause ? { cause: actor.cause } : {}),
  })
  await notifyOpp(tx, orgId)
  return getOpportunity(tx, orgId, id)
}

// ---------------------------------------------------------------- cerrar ---

/**
 * Cierra como ganada o perdida con un motivo de la lista: una sola forma de
 * cerrar para el equipo, el agente y la respuesta a un presupuesto. Va a
 * «Decidió» y su tarea abierta se cierra sola. `because`: la cerró algo que
 * pasó, con su propio registro (anular su presupuesto o que venciera sin
 * respuesta, ADR 0144).
 */
export async function closeOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  input: { outcome: "won" | "lost"; reason: string; note?: string | null },
  actor?: OpportunityActor,
  options: { because?: "presupuesto_anulado" | "presupuesto_vencido" } = {},
): Promise<OpportunityDetail> {
  await closeOpportunityRow(tx, orgId, id, input, actor, options)
  return getOpportunity(tx, orgId, id)
}

/** Lo mismo que `closeOpportunity`, sin armar el detalle: para cerrar muchas en un ciclo. */
async function closeOpportunityRow(
  tx: Db,
  orgId: string,
  id: string,
  input: { outcome: "won" | "lost"; reason: string; note?: string | null },
  actor?: OpportunityActor,
  options: { because?: "presupuesto_anulado" | "presupuesto_vencido" } = {},
): Promise<void> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad ya está cerrada")
  if (input.outcome !== "won" && input.outcome !== "lost") throw invalidField("outcome", "Elige si se ganó o se perdió")
  const origin = originOf(actor)
  const allowed: readonly string[] =
    input.outcome === "won"
      ? origin === "automatico" ? OPPORTUNITY_WON_REASONS : ["acepto"]
      : origin === "automatico" ? OPPORTUNITY_LOST_REASONS : CHOOSABLE_LOST_REASONS
  if (!allowed.includes(input.reason)) {
    throw invalidField(
      "reason",
      input.outcome === "won" ? "Motivo de cierre inválido" : "Elige el motivo: precio, eligió otra clínica, no responde, ya no lo necesita u otro",
    )
  }
  const reason = input.reason as OpportunityCloseReason
  const note = cleanNote(input.note ?? null, NOTE_MAX, "La nota", "note") ?? null
  const decided = await stageOfMoment(tx, orgId, current.pipelineId, "decidio")
  const now = new Date()
  await tx
    .update(opportunity)
    .set({ stageId: decided.id, status: input.outcome, closedAt: now, closeReason: reason, closeNote: note, updatedAt: now })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  const words = CLOSE_REASON_WORDS[reason]
  await recordEvent(tx, orgId, id, input.outcome === "won" ? "opportunity.won" : "opportunity.lost", current.stageId, decided.id, actor, {
    note: note ? `${words} · ${note}` : words,
    cause:
      reason === "acepto_presupuesto"
        ? "presupuesto_aceptado"
        : reason === "rechazo_presupuesto"
          ? "presupuesto_rechazado"
          : options.because === "presupuesto_vencido"
            ? "presupuesto_vencido"
            : null,
  })
  await auditOpportunity(
    tx,
    orgId,
    actor,
    options.because === "presupuesto_anulado"
      ? "opportunity.closed_budget_cancelled"
      : options.because === "presupuesto_vencido"
        ? "opportunity.closed_budget_expired"
        : "opportunity.closed",
    id,
    { outcome: input.outcome, reason, toStageId: decided.id },
  )
  // Su tarea ya no hace falta: se cierra sola, diciendo por qué.
  const [task] = await tx
    .select({ id: crmTask.id })
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, id), eq(crmTask.status, "open")))
    .limit(1)
  if (task) await settleTask(tx, orgId, task.id, input.outcome === "won" ? "la oportunidad se ganó" : "la oportunidad se perdió")
  await notifyOpp(tx, orgId)
  if (current.assignedUserId && current.assignedUserId !== (actor?.userId ?? null)) {
    await notifyAssignee(
      tx,
      orgId,
      current.assignedUserId,
      `opportunity:${id}:closed`,
      input.outcome === "won" ? "Oportunidad ganada" : "Oportunidad perdida",
      `${current.title} · ${words}`,
      { actorUserId: actor?.userId ?? null, link: id },
    )
  }
}

/**
 * Reabrir la devuelve al paso en que estaba antes de cerrarse. Cuando se
 * reabre sola (ADR 0144), `cause` dice por qué: respondió después de darse por
 * perdida o le presentaron otra versión del presupuesto.
 */
export async function reopenOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  actor?: OpportunityActor & { cause?: MoveCause },
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status === "open") throw validation("La oportunidad ya está abierta")
  const [closing] = await tx
    .select({ fromStageId: opportunityEvent.fromStageId, moment: pipelineStage.moment })
    .from(opportunityEvent)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunityEvent.fromStageId))
    .where(
      and(
        eq(opportunityEvent.organizationId, orgId),
        eq(opportunityEvent.opportunityId, id),
        inArray(opportunityEvent.action, ["opportunity.won", "opportunity.lost"]),
        ne(pipelineStage.moment, "decidio"),
        eq(pipelineStage.pipelineId, current.pipelineId),
      ),
    )
    .orderBy(desc(opportunityEvent.createdAt))
    .limit(1)
  const target = closing?.fromStageId ?? (await stageOfMoment(tx, orgId, current.pipelineId, "interesado")).id
  await tx
    .update(opportunity)
    .set({ stageId: target, status: "open", closedAt: null, closeReason: null, closeNote: null, updatedAt: new Date() })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.reopened", current.stageId, target, actor, { cause: actor?.cause ?? null })
  await auditOpportunity(tx, orgId, actor, "opportunity.reopened", id, { fromStageId: current.stageId, toStageId: target })
  await notifyOpp(tx, orgId)
  return getOpportunity(tx, orgId, id)
}

// ------------------------------------------------- lo que la mueve sola ---

/**
 * Oportunidades abiertas de una persona: las del paciente y las de su propia
 * persona (contacto `self`) que aún no tienen paciente.
 */
function ofPerson(orgId: string, patientId: string): SQL {
  return or(
    eq(opportunity.patientId, patientId),
    and(
      isNull(opportunity.patientId),
      sql`${opportunity.contactId} in (select pc.contact_id from patient_contact pc
        where pc.organization_id = ${orgId} and pc.patient_id = ${patientId} and pc.relationship = 'self')`,
    ),
  )!
}

/**
 * La oportunidad espera la respuesta a otro presupuesto (ADR 0144): ese
 * presupuesto es su interés, y otro no se le une ni la cuenta como el mismo.
 * `budgetIds`: el presupuesto de que se trata y, si es una revisión, el que
 * reemplaza. Espera respuesta con la regla de siempre (`budgetAwaitsAnswerSql`).
 */
function waitsOnOtherBudget(orgId: string, budgetIds: string[]): SQL {
  const own = sql.join(
    budgetIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const awaiting = budgetAwaitsAnswerSql({
    id: sql`waiting_budget.id`,
    status: sql`waiting_budget.status`,
    organizationId: sql`waiting_budget.organization_id`,
  })
  return sql`(${opportunity.budgetId} is not null and ${opportunity.budgetId} not in (${own}) and exists (
    select 1 from treatment_budget waiting_budget
    where waiting_budget.organization_id = ${orgId} and waiting_budget.id = ${opportunity.budgetId} and ${awaiting}))`
}

/**
 * La familia de un presupuesto (ADR 0144): él y el que reemplaza, si es una
 * revisión, con el número que comparten todas sus versiones. La usan
 * `sameOpenInterest` y `pickOpportunity`.
 */
interface BudgetFamily {
  ids: string[]
  replaces: string | null
  number: number | null
}

async function budgetFamily(tx: Db, orgId: string, budgetId: string): Promise<BudgetFamily> {
  const [row] = await tx
    .select({ replaces: treatmentBudget.supersedesBudgetId, number: treatmentBudget.budgetNumber })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.id, budgetId)))
    .limit(1)
  const replaces = row?.replaces ?? null
  return { ids: replaces ? [budgetId, replaces] : [budgetId], replaces, number: row?.number ?? null }
}

/**
 * El vínculo `pc` es de quien lleva al paciente sin ser paciente ella misma
 * (ADR 0144): su apoderada (`guardian`) sin ficha propia. Solo por ella se
 * juntan dos identidades; paciente ≠ interlocutor ≠ responsable, y una madre
 * que también es paciente pregunta por lo suyo.
 */
const GUARDIAN_WITHOUT_RECORD = sql`(pc.relationship = 'guardian' and not exists (
  select 1 from patient_contact own where own.organization_id = pc.organization_id
    and own.contact_id = pc.contact_id and own.relationship = 'self'))`

/**
 * Las oportunidades de una persona y, si es apoderada sin ficha propia, las de
 * los pacientes que lleva (`patient_contact`).
 */
function carriedBy(orgId: string, contactId: string): SQL {
  return or(
    eq(opportunity.contactId, contactId),
    sql`${opportunity.patientId} in (select pc.patient_id from patient_contact pc
      where pc.organization_id = ${orgId} and pc.contact_id = ${contactId} and ${GUARDIAN_WITHOUT_RECORD})`,
  )!
}

/** La persona (contacto) de un paciente: su identidad (ADR 0001). */
async function personOfPatient(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: patient.personId })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return row?.id ?? null
}

/**
 * La oportunidad es de ese servicio: es el suyo o está en su presupuesto que
 * espera respuesta (ADR 0144; la venta de varios tratamientos no lleva uno solo).
 */
function includesService(orgId: string, serviceId: string): SQL {
  const awaiting = budgetAwaitsAnswerSql({
    id: sql`pending_budget.id`,
    status: sql`pending_budget.status`,
    organizationId: sql`pending_budget.organization_id`,
  })
  return or(
    eq(opportunity.serviceId, serviceId),
    sql`exists (select 1 from treatment_budget pending_budget
      join treatment_budget_item pending_line on pending_line.organization_id = pending_budget.organization_id
        and pending_line.budget_id = pending_budget.id
      where pending_budget.organization_id = ${orgId} and pending_budget.id = ${opportunity.budgetId}
        and pending_line.service_id = ${serviceId} and ${awaiting})`,
  )!
}

/** Su presupuesto sigue esperando respuesta (`budgetAwaitsAnswerSql`). */
function budgetStillWaits(orgId: string): SQL {
  const awaiting = budgetAwaitsAnswerSql({
    id: sql`still_budget.id`,
    status: sql`still_budget.status`,
    organizationId: sql`still_budget.organization_id`,
  })
  return sql`exists (select 1 from treatment_budget still_budget
    where still_budget.organization_id = ${orgId} and still_budget.id = ${opportunity.budgetId} and ${awaiting})`
}

/**
 * Una persona a la vez (ADR 0144): entregar dos presupuestos, anotar un interés
 * o crear una oportunidad al mismo tiempo no abre dos por lo mismo. Se toman
 * en el orden de la misma clave que se bloquea (`hashtext`), para no
 * esperarse en cruz.
 */
async function lockPeople(tx: Db, orgId: string, contactIds: string[]): Promise<void> {
  const keys = [...new Set(contactIds)].map((id) => sql`${`oportunidad:${orgId}:${id}`}`)
  if (keys.length === 0) return
  const locks = await tx.execute<{ key: number }>(
    sql`select distinct hashtext(k) as key from unnest(array[${sql.join(keys, sql`, `)}]::text[]) as k order by key`,
  )
  for (const { key } of locks) await tx.execute(sql`select pg_advisory_xact_lock(${key}::int)`)
}

/**
 * La oportunidad abierta que corresponde a algo que pasó: la del mismo
 * tratamiento o, si no hay, la más reciente. `moments` acota en qué pasos se
 * busca. Con un presupuesto (`budget`), primero la que ya está unida a él o al
 * que reemplaza, y nunca una que espera la respuesta a otro; con `onlyOwn`,
 * solo esa. Del mismo tratamiento cuenta también la que anotó sin paciente su
 * apoderada sin ficha propia (`GUARDIAN_WITHOUT_RECORD`), nunca como «la más
 * reciente».
 */
async function pickOpportunity(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    serviceIds: string[]
    moments?: SaleMoment[]
    budget?: BudgetFamily
    onlyOwn?: boolean
  },
) {
  const budgetIds = input.budget?.ids ?? []
  const shared = and(
    eq(opportunity.organizationId, orgId),
    eq(opportunity.status, "open"),
    input.moments ? inArray(pipelineStage.moment, input.moments) : undefined,
    input.budget ? not(waitsOnOtherBudget(orgId, budgetIds)) : undefined,
  )
  const rows = await tx
    .select({ opp: opportunity, moment: pipelineStage.moment })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(and(shared, ofPerson(orgId, input.patientId)))
    .orderBy(desc(opportunity.createdAt), desc(opportunity.id))
  const own = rows.find((row) => row.opp.budgetId && budgetIds.includes(row.opp.budgetId))
  if (input.onlyOwn) return own ?? null
  const sameService = rows.find((row) => row.opp.serviceId && input.serviceIds.includes(row.opp.serviceId))
  if (own ?? sameService) return own ?? sameService ?? null
  const [ofCarer] = input.serviceIds.length
    ? await tx
        .select({ opp: opportunity, moment: pipelineStage.moment })
        .from(opportunity)
        .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
        .where(
          and(
            shared,
            isNull(opportunity.patientId),
            inArray(opportunity.serviceId, input.serviceIds),
            sql`${opportunity.contactId} in (select pc.contact_id from patient_contact pc
              where pc.organization_id = ${orgId} and pc.patient_id = ${input.patientId} and ${GUARDIAN_WITHOUT_RECORD})`,
          ),
        )
        .orderBy(desc(opportunity.createdAt), desc(opportunity.id))
        .limit(1)
    : []
  if (ofCarer) return { ...ofCarer, ofCarer: true }
  // Con un presupuesto, «la más reciente» solo si no es de otro interés: sin
  // servicio y sin otro presupuesto. Una de otro tratamiento («Blanqueamiento»)
  // no se gana con el dinero de una endodoncia (QA del 6 nov, X7).
  if (input.budget) return rows.find((row) => !row.opp.serviceId && !row.opp.budgetId) ?? null
  return rows[0] ?? null
}

/** La que anotó quien lleva al paciente pasa a llevarlo: desde ahí es de su historia. */
async function adoptPatient(tx: Db, orgId: string, opportunityId: string, patientId: string): Promise<void> {
  await tx
    .update(opportunity)
    .set({ patientId, updatedAt: new Date() })
    .where(and(eq(opportunity.id, opportunityId), eq(opportunity.organizationId, orgId), isNull(opportunity.patientId)))
}

/**
 * Al agendar una cita para una persona, su oportunidad «Interesado» (la del
 * mismo servicio o, si no hay, la más reciente) pasa sola a «Evaluación
 * agendada». Devuelve la que movió.
 */
export async function advanceForAppointment(
  tx: Db,
  orgId: string,
  input: { patientId: string; serviceId: string | null; startsAt: Date; source?: string },
): Promise<string | null> {
  const picked = await pickOpportunity(tx, orgId, {
    patientId: input.patientId,
    serviceIds: input.serviceId ? [input.serviceId] : [],
    moments: ["interesado"],
  })
  if (!picked) return null
  if ("ofCarer" in picked) await adoptPatient(tx, orgId, picked.opp.id, input.patientId)
  const target = await stageOfMoment(tx, orgId, picked.opp.pipelineId, "evaluacion_agendada")
  await moveOpportunity(tx, orgId, picked.opp.id, target.id, {
    userId: null,
    // Quién agendó la cita: el agente (su movimiento), la persona desde su enlace o el equipo.
    origin: input.source === "agente" ? "agente" : "automatico",
    cause: input.source === "agente" ? "cita_agendada" : input.source === "enlace" ? "cita_enlace" : "cita_recepcion",
    causeAt: input.startsAt,
  })
  return picked.opp.id
}

/**
 * La única vuelta atrás que da sola (ADR 0028): si se cancela la evaluación
 * que la llevó a «Evaluación agendada» y no le queda otra cita por venir,
 * vuelve a «Interesado» y la tarjeta dice por qué («Volvió sola: canceló su
 * evaluación del jue 17»). Solo la que llegó ahí sola por una cita y cuya
 * evaluación no se atendió después. Misma `moveOpportunity`, con `origin` y
 * `cause`. Devuelve las que volvieron.
 */
export async function returnForCancelledAppointment(
  tx: Db,
  orgId: string,
  input: { patientId: string; startsAt: Date },
): Promise<string[]> {
  const now = new Date()
  const [upcoming] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, input.patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
      ),
    )
    .limit(1)
  if (upcoming) return []
  const rows = await tx
    .select({ opp: opportunity })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.status, "open"),
        eq(pipelineStage.moment, "evaluacion_agendada"),
        ofPerson(orgId, input.patientId),
      ),
    )
  const returned: string[] = []
  for (const { opp } of rows) {
    // Cómo llegó a su paso actual: sola, por una cita.
    const [arrival] = await tx
      .select({ origin: opportunityEvent.origin, cause: opportunityEvent.cause, createdAt: opportunityEvent.createdAt })
      .from(opportunityEvent)
      .where(
        and(
          eq(opportunityEvent.organizationId, orgId),
          eq(opportunityEvent.opportunityId, opp.id),
          eq(opportunityEvent.action, "opportunity.moved"),
          eq(opportunityEvent.toStageId, opp.stageId),
        ),
      )
      .orderBy(desc(opportunityEvent.createdAt), desc(opportunityEvent.id))
      .limit(1)
    if (!arrival || (arrival.origin !== "automatico" && arrival.origin !== "agente") || !APPOINTMENT_CAUSES.includes(arrival.cause ?? "")) continue
    // Si la evaluación ya se atendió, cancelar otra cita no la devuelve.
    const [attended] = await tx
      .select({ id: appointment.id })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, input.patientId),
          eq(appointment.status, "atendida"),
          gte(appointment.startsAt, arrival.createdAt),
        ),
      )
      .limit(1)
    if (attended) continue
    const target = await stageOfMoment(tx, orgId, opp.pipelineId, "interesado")
    await moveOpportunity(tx, orgId, opp.id, target.id, {
      userId: null,
      origin: "automatico",
      cause: "evaluacion_cancelada",
      causeAt: input.startsAt,
    })
    returned.push(opp.id)
  }
  return returned
}

/** Lo que necesita la oportunidad propia de un presupuesto entregado (ADR 0144). */
export interface BudgetOpportunityOpening {
  /** Quién lo entregó: la oportunidad se abre a su nombre (nulo: el equipo). */
  userId: string | null
  /** Los tratamientos de la opción que vale, en una línea. */
  title: string
  /** El servicio, si la opción que vale tiene uno solo. */
  serviceId: string | null
}

/**
 * Alguna versión de ese presupuesto (las revisiones conservan su número) ya
 * tuvo su oportunidad, abierta o decidida.
 */
async function versionHadOpportunity(tx: Db, orgId: string, budgetNumber: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: opportunity.id })
    .from(opportunity)
    .innerJoin(
      treatmentBudget,
      and(eq(treatmentBudget.organizationId, opportunity.organizationId), eq(treatmentBudget.id, opportunity.budgetId)),
    )
    .where(and(eq(opportunity.organizationId, orgId), eq(treatmentBudget.budgetNumber, budgetNumber)))
    .limit(1)
  return !!row
}

/**
 * La marca en el registro de la entrega (`budget.delivered`) que pone un
 * presupuesto bajo «lo que nadie respondió» (ADR 0144). La lleva toda entrega
 * desde el despliegue de este cambio: es la fecha de corte, guardada en cada
 * entrega. Lo entregado antes no la tiene y nunca se cierra por vencido.
 */
export const UNANSWERED_RULE_MARK = "unansweredCloses"

/** La oportunidad con su paso, como la devuelve `pickOpportunity`. */
async function opportunityRow(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ opp: opportunity, moment: pipelineStage.moment })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.id, id)))
    .limit(1)
  return row ?? null
}

/**
 * La oportunidad perdida de alguna versión de ese presupuesto, si ninguna se
 * ganó: la que vuelve a abrirse cuando la clínica presenta otra versión.
 */
async function lostOfVersion(tx: Db, orgId: string, budgetNumber: number): Promise<string | null> {
  const rows = await tx
    .select({ id: opportunity.id, status: opportunity.status })
    .from(opportunity)
    .innerJoin(
      treatmentBudget,
      and(eq(treatmentBudget.organizationId, opportunity.organizationId), eq(treatmentBudget.id, opportunity.budgetId)),
    )
    .where(and(eq(opportunity.organizationId, orgId), eq(treatmentBudget.budgetNumber, budgetNumber)))
    .orderBy(desc(opportunity.closedAt), desc(opportunity.id))
  if (rows.some((row) => row.status === "won")) return null
  return rows.find((row) => row.status === "lost")?.id ?? null
}

/**
 * La oportunidad propia de un presupuesto entregado sin otra que le
 * corresponda (ADR 0144): de la persona del paciente, en «Presupuesto
 * enviado», unida a él y sin responsable (Recepción). Es un paso del sistema
 * (`automatico`) que lleva el nombre de quien lo entregó, para el historial y
 * la Actividad del equipo.
 */
async function openForBudget(
  tx: Db,
  orgId: string,
  input: { patientId: string; budgetId: string; by?: "agente" | "persona" },
  personId: string,
  opening: BudgetOpportunityOpening,
) {
  const created = await createOpportunity(
    tx,
    orgId,
    {
      contactId: personId,
      patientId: input.patientId,
      title: opening.title,
      serviceId: opening.serviceId,
      budgetId: input.budgetId,
    },
    input.by === "agente" ? { userId: null, origin: "agente" } : { userId: opening.userId, origin: "automatico" },
    // Nunca frena la entrega: si ya hubiera una del mismo interés, sigue con esa.
    { reuseOpen: true, presentedBudget: true },
  )
  return opportunityRow(tx, orgId, created.id)
}

/**
 * Al presentar un presupuesto, se une solo a la oportunidad abierta que ya es
 * suya (o del que reemplaza), a la del mismo tratamiento (también la que anotó
 * su apoderada sin ficha propia) o, si no hay, a la más reciente de la
 * persona que no es de otro interés (sin servicio ni otro presupuesto), nunca
 * a una que espera la respuesta a otro presupuesto. La
 * oportunidad adopta al paciente, su valor pasa a ser el total del presupuesto
 * y, si aún no llegaba ahí, pasa sola a «Presupuesto enviado».
 *
 * Al entregarlo (`opens`), si no hay ninguna, abre la suya (ADR 0144). Una
 * revisión de lo que ya tuvo su oportunidad es la misma venta: sigue con la
 * suya si está abierta; si se perdió (no respondió, el precio, la rechazó), la
 * reabre, porque es otra oportunidad de cerrarla; si se ganó, no toma otra ni
 * abre una. Al decidir uno entregado antes que no la tiene, no se abre ninguna.
 */
export async function linkPresentedBudget(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    budgetId: string
    serviceIds: string[]
    /** Quién lo presentó: el agente o el equipo. Sin indicar, el equipo. */
    by?: "agente" | "persona"
    /** Total del presupuesto presentado, en su moneda: pasa a ser el valor de la oportunidad. */
    total?: { cents: number | null; currency: string }
    /** Al entregarlo: con qué se abre la suya si no hay ninguna que le corresponda. */
    opens?: BudgetOpportunityOpening
  },
): Promise<string | null> {
  const family = await budgetFamily(tx, orgId, input.budgetId)
  const personId = await personOfPatient(tx, orgId, input.patientId)
  if (personId) await lockPeople(tx, orgId, [personId])
  const sold = !!family.replaces && family.number !== null && (await versionHadOpportunity(tx, orgId, family.number))
  let picked = await pickOpportunity(tx, orgId, {
    patientId: input.patientId,
    serviceIds: input.serviceIds,
    budget: family,
    onlyOwn: sold,
  })
  if (!picked && sold && family.number !== null) {
    const lost = await lostOfVersion(tx, orgId, family.number)
    if (lost) {
      await reopenOpportunity(tx, orgId, lost, { userId: null, origin: "automatico", cause: "nueva_version" })
      picked = await opportunityRow(tx, orgId, lost)
    }
  }
  if (!picked && input.opens && !sold && personId) picked = await openForBudget(tx, orgId, input, personId, input.opens)
  if (!picked) return null
  // El valor de la oportunidad pasa a ser lo que de verdad se le presentó.
  const value = input.total && input.total.cents !== null ? { amountCents: input.total.cents, currency: input.total.currency } : {}
  await tx
    .update(opportunity)
    .set({ budgetId: input.budgetId, patientId: picked.opp.patientId ?? input.patientId, ...value, updatedAt: new Date() })
    .where(and(eq(opportunity.id, picked.opp.id), eq(opportunity.organizationId, orgId)))
  if (momentRank(picked.moment) < momentRank("presupuesto_enviado")) {
    const target = await stageOfMoment(tx, orgId, picked.opp.pipelineId, "presupuesto_enviado")
    await moveOpportunity(tx, orgId, picked.opp.id, target.id, {
      userId: null,
      origin: input.by === "agente" ? "agente" : "automatico",
      cause: "presupuesto_presentado",
    })
  } else {
    await notifyOpp(tx, orgId)
  }
  return picked.opp.id
}

/** Una persona del equipo le cambió el nombre: el sistema ya no lo pisa. */
async function titleChangedByPerson(tx: Db, orgId: string, opportunityId: string): Promise<boolean> {
  const [row] = await tx.execute<{ found: number }>(sql`
    select 1 as found from audit_event a
    where a.organization_id = ${orgId} and a.entity = 'opportunity' and a.entity_id = ${opportunityId}
      and a.action = 'opportunity.updated' and a.metadata->'fields' @> '["title"]'::jsonb
      and a.metadata->>'origin' is null
    limit 1`)
  return !!row
}

/**
 * La persona decidió su presupuesto: aceptarlo, aunque sea en parte, gana la
 * oportunidad con lo aceptado como valor; rechazarlo la pierde con «Rechazó el
 * presupuesto». Pospuesto no cambia nada. La oportunidad es la de su familia
 * (él o el que reemplaza). Si se había cerrado sola porque venció sin
 * respuesta (ADR 0144), responder la reabre: aceptarlo o rechazarlo la decide
 * como siempre y «lo pienso» la deja abierta.
 */
export async function decideBudgetOpportunity(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    budgetId: string
    status: string
    serviceIds: string[]
    /**
     * Le queda algo por responder (`budgetAwaitsAnswer`): aceptó una parte y lo
     * demás lo está pensando. Entonces no se decide todavía y sigue abierta.
     */
    awaitsAnswer?: boolean
    /** Lo aceptado, en la moneda del presupuesto: el valor de la oportunidad ganada. */
    accepted?: { cents: number | null; currency: string }
    /** Lo que sigue esperando respuesta: el valor de la que queda abierta. */
    waiting?: { cents: number | null; currency: string }
    /** Los tratamientos de la opción elegida: el nombre de la que nació del presupuesto (ADR 0144). */
    title?: string
  },
): Promise<string | null> {
  // Mientras quede algo por responder no se gana ni se pierde: se decide al final.
  const waits = input.awaitsAnswer ?? input.status === "pospuesto"
  const outcome = waits
    ? null
    : input.status === "aceptado" || input.status === "parcial"
      ? "won"
      : input.status === "rechazado"
        ? "lost"
        : null
  if (!outcome && !waits) return null
  const family = await budgetFamily(tx, orgId, input.budgetId)
  // Con su fila tomada: si el ciclo de «lo que nadie respondió» la está cerrando, se espera y se ve cerrada.
  const linked = await tx
    .select({ id: opportunity.id, status: opportunity.status })
    .from(opportunity)
    .where(and(eq(opportunity.organizationId, orgId), inArray(opportunity.budgetId, family.ids)))
    .orderBy(desc(opportunity.createdAt))
    .for("update")
  let open = linked.find((row) => row.status === "open")
  if (!open) {
    const expired = await closedForExpiry(tx, orgId, linked.filter((row) => row.status === "lost").map((row) => row.id))
    if (expired) {
      await reopenOpportunity(tx, orgId, expired, { userId: null, origin: "automatico", cause: "respondio" })
      open = { id: expired, status: "open" }
    }
  }
  if (!outcome) {
    // Sigue abierta por lo que falta: vale lo que sigue esperando respuesta.
    if (open && input.waiting && input.waiting.cents !== null && input.status === "parcial") {
      await tx
        .update(opportunity)
        .set({ amountCents: input.waiting.cents, currency: input.waiting.currency, updatedAt: new Date() })
        .where(and(eq(opportunity.id, open.id), eq(opportunity.organizationId, orgId)))
    }
    return open?.id ?? null
  }
  // Completar una respuesta no vuelve a decidir una oportunidad que ya se cerró
  // con este presupuesto (las de antes de esperar a lo pendiente), ni busca otra.
  if (!open && linked.length > 0) return null
  const id = open?.id ?? (await linkPresentedBudget(tx, orgId, input))
  if (!id) return null
  // La que nació del presupuesto se llama como lo que eligió, salvo que una persona le cambiara el nombre.
  const title = input.title?.trim().slice(0, 200)
  if (title && (await bornFromBudget(tx, orgId, id)) && !(await titleChangedByPerson(tx, orgId, id))) {
    const [current] = await tx
      .select({ title: opportunity.title })
      .from(opportunity)
      .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (current && current.title !== title) await updateOpportunity(tx, orgId, id, { title }, { userId: null, origin: "automatico" })
  }
  // Ganada, su valor es lo que aceptó (aceptado en parte, solo esa parte).
  if (outcome === "won" && input.accepted && input.accepted.cents !== null) {
    await tx
      .update(opportunity)
      .set({ amountCents: input.accepted.cents, currency: input.accepted.currency, updatedAt: new Date() })
      .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  }
  await closeOpportunity(
    tx,
    orgId,
    id,
    { outcome, reason: outcome === "won" ? "acepto_presupuesto" : "rechazo_presupuesto" },
    { userId: null, origin: "automatico" },
  )
  return id
}

/** Nació de un presupuesto entregado (ADR 0144): su alta lleva esa causa. */
async function bornFromBudget(tx: Db, orgId: string, opportunityId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: opportunityEvent.id })
    .from(opportunityEvent)
    .where(
      and(
        eq(opportunityEvent.organizationId, orgId),
        eq(opportunityEvent.opportunityId, opportunityId),
        eq(opportunityEvent.action, "opportunity.created"),
        eq(opportunityEvent.cause, "presupuesto_presentado"),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * Le suelta el presupuesto a una oportunidad que sigue abierta (ADR 0144):
 * deja de decir que se cierra sola al responderlo. Queda en su historial.
 */
async function detachBudget(tx: Db, orgId: string, id: string, actor: OpportunityActor): Promise<void> {
  await tx
    .update(opportunity)
    .set({ budgetId: null, updatedAt: new Date() })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.updated", null, null, actor)
  await auditOpportunity(tx, orgId, actor, "opportunity.updated", id, { fields: ["budgetId"] })
  await notifyOpp(tx, orgId)
}

/**
 * Se anuló un presupuesto (ADR 0144): su oportunidad ya no puede cerrarse sola
 * al responderlo. La que nació de él y nadie trabajó (sin tareas ni notas) se
 * cierra como perdida, «Otro» con la nota «Se anuló el presupuesto», a nombre
 * de quien lo anuló. La que ya era de otro interés, o tiene trabajo encima,
 * sigue abierta y solo se suelta del presupuesto. Devuelve las que tocó.
 */
export async function releaseCancelledBudget(
  tx: Db,
  orgId: string,
  input: { budgetId: string; userId: string | null },
): Promise<string[]> {
  const linked = await tx
    .select({ id: opportunity.id })
    .from(opportunity)
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.budgetId, input.budgetId), eq(opportunity.status, "open")))
    .for("update")
  const actor: OpportunityActor = { userId: input.userId, origin: "automatico" }
  for (const { id } of linked) {
    const [task] = await tx
      .select({ id: crmTask.id })
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, id)))
      .limit(1)
    const [note] = await tx
      .select({ id: crmNote.id })
      .from(crmNote)
      .where(and(eq(crmNote.organizationId, orgId), eq(crmNote.opportunityId, id)))
      .limit(1)
    if (!task && !note && (await bornFromBudget(tx, orgId, id))) {
      await closeOpportunityRow(
        tx,
        orgId,
        id,
        { outcome: "lost", reason: "otro", note: "Se anuló el presupuesto" },
        actor,
        { because: "presupuesto_anulado" },
      )
    } else {
      await detachBudget(tx, orgId, id, actor)
    }
  }
  return linked.map((row) => row.id)
}

/** Días después del fin de su vigencia en que la oportunidad de un presupuesto sin respuesta se da por perdida. */
export const UNANSWERED_BUDGET_DAYS = 30

/** La oportunidad perdida que se cerró sola porque su presupuesto venció sin respuesta, si es una de estas. */
async function closedForExpiry(tx: Db, orgId: string, ids: string[]): Promise<string | undefined> {
  for (const id of ids) {
    const [last] = await tx
      .select({ cause: opportunityEvent.cause })
      .from(opportunityEvent)
      .where(
        and(
          eq(opportunityEvent.organizationId, orgId),
          eq(opportunityEvent.opportunityId, id),
          inArray(opportunityEvent.action, ["opportunity.won", "opportunity.lost"]),
        ),
      )
      .orderBy(desc(opportunityEvent.createdAt), desc(opportunityEvent.id))
      .limit(1)
    if (last?.cause === "presupuesto_vencido") return id
  }
  return undefined
}

/**
 * Lo que decide si «lo que nadie respondió» alcanza a la oportunidad `o` de su
 * presupuesto `b`, salvo la fecha (ADR 0144). La misma regla para el ciclo y
 * para lo que la tarjeta avisa. Fuera: lo entregado antes del despliegue (sin
 * `UNANSWERED_RULE_MARK`), lo que tiene una nueva versión en borrador y lo que
 * alguien trabaja (responsable, tarea, nota o un cambio a mano o de Sofi
 * después de entregarlo).
 */
function unansweredRuleSql(): SQL {
  return sql`o.status = 'open' and o.assigned_user_id is null
    and b.status = 'presentado' and b.valid_until is not null
    and exists (select 1 from audit_event delivered where delivered.organization_id = b.organization_id
      and delivered.action = 'budget.delivered' and delivered.entity_id = b.id::text
      and delivered.metadata->>${UNANSWERED_RULE_MARK} = 'true')
    and not exists (select 1 from treatment_budget draft where draft.organization_id = b.organization_id
      and draft.supersedes_budget_id = b.id and draft.status = 'borrador')
    and not exists (select 1 from task t where t.organization_id = o.organization_id and t.opportunity_id = o.id)
    and not exists (select 1 from crm_note n where n.organization_id = o.organization_id and n.opportunity_id = o.id)
    and not exists (select 1 from opportunity_event e where e.organization_id = o.organization_id and e.opportunity_id = o.id
      and e.origin in ('persona', 'agente') and e.created_at > coalesce(b.presented_at, o.created_at))`
}

/** El día de hoy en la zona de la clínica, `AAAA-MM-DD`. */
function clinicDay(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}

/**
 * Cuándo se cerraría sola como perdida, si su presupuesto sigue sin respuesta
 * (`AAAA-MM-DD`), para avisarlo en la tarjeta; nulo si la regla no la alcanza.
 */
async function unansweredClosesOn(tx: Db, orgId: string, opportunityId: string): Promise<string | null> {
  const [row] = await tx.execute<{ closesOn: string }>(sql`
    select to_char(b.valid_until + ${sql.raw(String(UNANSWERED_BUDGET_DAYS + 1))}, 'YYYY-MM-DD') as "closesOn"
    from opportunity o join treatment_budget b on b.organization_id = o.organization_id and b.id = o.budget_id
    where o.organization_id = ${orgId} and o.id = ${opportunityId} and ${unansweredRuleSql()}
      and exists (select 1 from opportunity_event c where c.organization_id = o.organization_id and c.opportunity_id = o.id
        and c.action = 'opportunity.created' and c.cause = 'presupuesto_presentado')`)
  return row?.closesOn ?? null
}

/**
 * Lo que nadie respondió (ADR 0144): pasados 30 días del fin de su vigencia,
 * el presupuesto entregado que sigue sin respuesta deja de esperar. Su
 * oportunidad, si nació de él, se cierra sola como perdida, «No responde», a
 * nombre del sistema; si era de otro interés, solo se suelta del presupuesto.
 * La regla es `unansweredRuleSql`: no toca lo que alguien trabaja, lo
 * entregado antes del despliegue ni lo que tiene otra versión en borrador. Si
 * la persona responde después, se reabre (`decideBudgetOpportunity`,
 * `noteServiceInterest`). Corre en el ciclo del worker, junto a `settleTasks`,
 * aunque el Administrador esté apagado. Cada una va en su propio punto de
 * guardado y salta la que otra transacción tiene tomada (la respuesta que
 * llega a la vez): un choque no deshace las demás. Devuelve cuántas cerró.
 */
export async function closeUnansweredBudgetOpportunities(
  tx: Db,
  orgId: string,
  now: Date,
  options: { batch?: number } = {},
): Promise<number> {
  const zone = await findOrgLocale(tx, orgId)
  const rows = await tx.execute<{ id: string; born: boolean }>(sql`
    select o.id, exists (select 1 from opportunity_event c where c.organization_id = o.organization_id
      and c.opportunity_id = o.id and c.action = 'opportunity.created' and c.cause = 'presupuesto_presentado') as born
    from opportunity o join treatment_budget b on b.organization_id = o.organization_id and b.id = o.budget_id
    where o.organization_id = ${orgId} and ${unansweredRuleSql()}
      and b.valid_until < ${clinicDay(zone.timezone, now)}::date - ${sql.raw(String(UNANSWERED_BUDGET_DAYS))}
    order by b.valid_until, o.id
    limit ${options.batch ?? 200}
    for update of o skip locked`)
  const actor: OpportunityActor = { userId: null, origin: "automatico" }
  let closed = 0
  for (const row of rows) {
    try {
      const done = await tx.transaction(async (point) => {
        const inner = point as unknown as Db
        const [still] = await inner
          .select({ status: opportunity.status })
          .from(opportunity)
          .where(and(eq(opportunity.id, row.id), eq(opportunity.organizationId, orgId)))
          .limit(1)
        if (still?.status !== "open") return false
        if (!row.born) {
          await detachBudget(inner, orgId, row.id, actor)
          return false
        }
        await closeOpportunityRow(
          inner,
          orgId,
          row.id,
          { outcome: "lost", reason: "no_responde", note: `Su presupuesto venció hace más de ${UNANSWERED_BUDGET_DAYS} días sin respuesta` },
          actor,
          { because: "presupuesto_vencido" },
        )
        return true
      })
      if (done) closed++
    } catch (error) {
      // Un choque deshace solo su punto de guardado: queda para el próximo ciclo.
      console.error(`[oportunidades] org=${orgId} no se pudo cerrar ${row.id} por vencido:`, error instanceof Error ? error.message : error)
    }
  }
  return closed
}

/** El último día local en que cada clínica corrió «lo que nadie respondió» en este proceso. */
const unansweredRunDay = new Map<string, string>()

/**
 * «Lo que nadie respondió» una vez por día local de la clínica (ADR 0144): el
 * ciclo del worker corre cada minuto y la regla solo cambia de un día al otro.
 * Si el proceso se reinicia, vuelve a correr ese día; no cierra dos veces.
 */
export async function closeUnansweredOncePerDay(tx: Db, orgId: string, now: Date): Promise<number> {
  const day = clinicDay((await findOrgLocale(tx, orgId)).timezone, now)
  if (unansweredRunDay.get(orgId) === day) return 0
  const closed = await closeUnansweredBudgetOpportunities(tx, orgId, now)
  unansweredRunDay.set(orgId, day)
  return closed
}

/** Las oportunidades abiertas del contacto, para que el agente sepa en qué punto está cada una. */
export async function openOpportunitiesOf(tx: Db, orgId: string, contactId: string) {
  return tx
    .select({ id: opportunity.id, title: opportunity.title, stageName: pipelineStage.name, moment: pipelineStage.moment })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.contactId, contactId), eq(opportunity.status, "open")))
    .orderBy(desc(opportunity.createdAt))
}
