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
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm"
import { foldedWordsMatch } from "./search-text.js"
import { CHANNEL_NAME } from "./agent-person-memory.js"
import { requireContact } from "./contacts.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgCurrency, findOrgLocale, NO_CURRENCY, requireOrgCurrency } from "./locale.js"
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
  if (last.action === "opportunity.reopened") return `La reabrió ${last.actorName ?? "el equipo"} ${when}`
  if (last.action === "opportunity.created") {
    if (last.origin === "agente") {
      const channel = last.channel ? CHANNEL_NAME[last.channel] ?? null : null
      return `Lo pidió${channel ? ` por ${channel}` : ""} ${when}`
    }
    if (last.origin === "persona") return `La creó ${last.actorName ?? "el equipo"} ${when}`
  }
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
): string {
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
  if (!membership) throw validation("El asignado no es miembro de esta organización")
  return membership.userId
}

function cleanTitle(title: string): string {
  const value = title.trim()
  if (!value || value.length > 200) throw validation("El título debe tener 1–200 caracteres")
  return value
}

function cleanAmount(amountCents: number | null | undefined): number | null | undefined {
  if (amountCents === undefined || amountCents === null) return amountCents ?? null
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw validation("El valor debe ser un entero de céntimos >= 0")
  }
  return amountCents
}

function cleanNote(note: string | null | undefined, max: number, field: string) {
  if (note === undefined) return undefined
  if (note === null) return null
  const value = note.trim()
  if (!value) return null
  if (value.length > max) throw validation(`${field} no puede superar ${max} caracteres`)
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
  if (!service) throw validation("Servicio inválido para esta organización")
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
  if (!budget) throw validation("Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
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

/** El paciente debe estar vinculado al contacto (patient_contact), sin duplicar fichas. */
async function requirePatientLink(tx: Db, orgId: string, patientId: string, contactId: string): Promise<void> {
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
  if (!link) throw validation("El paciente no está vinculado a este contacto")
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
  if (!budget) throw validation("Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
  }
  if (!patientId && budget.patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
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
  await createWorkspaceNotification(tx, orgId, {
    userId: assignedUserId,
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
  const conditions: SQL[] = [eq(opportunity.organizationId, orgId)]
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
      .select({ startsAt: appointment.startsAt, dentistName: user.name, serviceName: appointment.serviceName })
      .from(appointment)
      .leftJoin(user, eq(user.id, appointment.dentistUserId))
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
        text: [next.serviceName ?? "Cita", dayAndTime(next.startsAt, zone), next.dentistName].filter(Boolean).join(" · "),
      }
    }
  }
  return {
    ...item,
    contactPhone: contactRow?.phone ?? null,
    contactEmail: contactRow?.email ?? null,
    amountFromPriceList:
      !!service && row.opp.amountCents === service.priceCents && row.opp.currency === service.currency,
    amountFromBudget:
      !!budget && budget.status !== "borrador" && row.opp.amountCents !== null &&
      !(!!service && row.opp.amountCents === service.priceCents && row.opp.currency === service.currency),
    budgetTitle: budget?.title ?? null,
    budgetNumber: budget?.number ?? null,
    budgetStatus: budget?.status ?? null,
    nextAppointment,
    after: item.status === "open" ? AFTER_WORDS[item.moment] : null,
    history: events.map(({ event, actorName, toStageName }) => ({
      id: event.id,
      action: event.action,
      origin: (["persona", "agente", "automatico"].includes(event.origin) ? event.origin : "persona") as OpportunityEventOrigin,
      who: whoOf(event.origin, actorName),
      what: historyWhat(event, toStageName, now, zone),
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
 * contacto y paciente, y mismo servicio (o, sin servicio, mismo título).
 */
async function sameOpenInterest(
  tx: Db,
  orgId: string,
  input: { contactId: string; patientId: string | null; serviceId: string | null; title: string },
) {
  const [found] = await tx
    .select({ id: opportunity.id, title: opportunity.title })
    .from(opportunity)
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.contactId, input.contactId),
        eq(opportunity.status, "open"),
        input.patientId ? eq(opportunity.patientId, input.patientId) : isNull(opportunity.patientId),
        input.serviceId
          ? eq(opportunity.serviceId, input.serviceId)
          : sql`lower(btrim(${opportunity.title})) = lower(btrim(${input.title}))`,
      ),
    )
    .orderBy(desc(opportunity.createdAt))
    .limit(1)
  return found ?? null
}

/**
 * Crea una oportunidad: siempre en «Interesado». La crea el agente cuando la
 * persona pide algo concreto o el equipo; nunca nace de un «hola». No se
 * duplica una abierta del mismo interés: el agente recibe la que ya existe
 * (`reuseOpen`) y el equipo, el aviso de que ya está. Con servicio, el valor
 * sale de su precio en la lista de precios. Sin responsable es de Recepción.
 */
export async function createOpportunity(
  tx: Db,
  orgId: string,
  input: CreateOpportunityInput,
  actor?: OpportunityActor,
  options: { reuseOpen?: boolean } = {},
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
    if (!pipe) throw validation("Embudo inválido para esta organización")
  }
  const stage = await stageOfMoment(tx, orgId, pipelineId, "interesado")
  const title = cleanTitle(input.title)
  const service = await resolveService(tx, orgId, input.serviceId)
  const budgetId = await resolveBudget(tx, orgId, input.budgetId, patientId)
  // Si el presupuesto trae paciente y no se declaró, se adopta (sin duplicar ficha).
  const effectivePatientId = patientId ?? (await budgetPatient(tx, orgId, budgetId))
  if (effectivePatientId) await requirePatientLink(tx, orgId, effectivePatientId, input.contactId)
  const existing = await sameOpenInterest(tx, orgId, {
    contactId: input.contactId,
    patientId: effectivePatientId,
    serviceId: service?.id ?? null,
    title,
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
  const interestText = cleanNote(input.interestText ?? null, 500, "El interés") ?? null
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
  await recordEvent(tx, orgId, created.id, "opportunity.created", null, stage.id, actor)
  await auditOpportunity(tx, orgId, actor, "opportunity.created", created.id, {
    contactId: input.contactId,
    stageId: stage.id,
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
 * - si ya tiene abierta una oportunidad de ese servicio, la actualiza con lo
 *   que dijo ahora;
 * - si no, la crea en «Interesado» y sin responsable, que es de Recepción.
 */
export async function noteServiceInterest(
  tx: Db,
  orgId: string,
  input: { contactId: string; conversationId: string | null; serviceId: string; said: string },
): Promise<{ outcome: ServiceInterestOutcome; opportunityId: string | null }> {
  await requireContact(tx, orgId, input.contactId)
  // Una prueba del chat web no crea oportunidades (fase 6 del pulido de la Bandeja).
  if (input.conversationId) {
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
  // Cualquier oportunidad abierta de ese servicio, sea para quien sea de los suyos: es el mismo interés.
  const [open] = await tx
    .select({ id: opportunity.id, conversationId: opportunity.conversationId })
    .from(opportunity)
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.contactId, input.contactId),
        eq(opportunity.status, "open"),
        eq(opportunity.serviceId, service.id),
      ),
    )
    .orderBy(desc(opportunity.createdAt))
    .limit(1)
  if (open) {
    await updateOpportunity(
      tx,
      orgId,
      open.id,
      {
        interestText,
        ...(open.conversationId === null && input.conversationId ? { conversationId: input.conversationId } : {}),
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
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    },
    { userId: null, origin: "agente" },
    { reuseOpen: true },
  )
  return { outcome: created.reused ? "actualizada" : "creada", opportunityId: created.id }
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
    patch.interestText = cleanNote(input.interestText, 500, "El interés") ?? null
    changed.push("interestText")
  }
  const hasService = input.serviceId !== undefined ? !!service : !!current.serviceId
  if (input.amountCents !== undefined && !hasService) {
    patch.amountCents = cleanAmount(input.amountCents) ?? null
    // Un valor escrito a mano va en la moneda de la clínica.
    if (patch.amountCents !== null) patch.currency = await requireOrgCurrency(tx, orgId)
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
 * «Decidió» y su tarea abierta se cierra sola.
 */
export async function closeOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  input: { outcome: "won" | "lost"; reason: string; note?: string | null },
  actor?: OpportunityActor,
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad ya está cerrada")
  if (input.outcome !== "won" && input.outcome !== "lost") throw validation("Elige si se ganó o se perdió")
  const origin = originOf(actor)
  const allowed: readonly string[] =
    input.outcome === "won"
      ? origin === "automatico" ? OPPORTUNITY_WON_REASONS : ["acepto"]
      : origin === "automatico" ? OPPORTUNITY_LOST_REASONS : CHOOSABLE_LOST_REASONS
  if (!allowed.includes(input.reason)) {
    throw validation(
      input.outcome === "won" ? "Motivo de cierre inválido" : "Elige el motivo: precio, eligió otra clínica, no responde, ya no lo necesita u otro",
    )
  }
  const reason = input.reason as OpportunityCloseReason
  const note = cleanNote(input.note ?? null, NOTE_MAX, "La nota") ?? null
  const decided = await stageOfMoment(tx, orgId, current.pipelineId, "decidio")
  const now = new Date()
  await tx
    .update(opportunity)
    .set({ stageId: decided.id, status: input.outcome, closedAt: now, closeReason: reason, closeNote: note, updatedAt: now })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  const words = CLOSE_REASON_WORDS[reason]
  await recordEvent(tx, orgId, id, input.outcome === "won" ? "opportunity.won" : "opportunity.lost", current.stageId, decided.id, actor, {
    note: note ? `${words} · ${note}` : words,
    cause: reason === "acepto_presupuesto" ? "presupuesto_aceptado" : reason === "rechazo_presupuesto" ? "presupuesto_rechazado" : null,
  })
  await auditOpportunity(tx, orgId, actor, "opportunity.closed", id, { outcome: input.outcome, reason, toStageId: decided.id })
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
  return getOpportunity(tx, orgId, id)
}

/** Reabrir la devuelve al paso en que estaba antes de cerrarse. */
export async function reopenOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  actor?: OpportunityActor,
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
  await recordEvent(tx, orgId, id, "opportunity.reopened", current.stageId, target, actor)
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
 * La oportunidad abierta que corresponde a algo que pasó: la del mismo
 * tratamiento o, si no hay, la más reciente. `moments` acota en qué pasos se
 * busca.
 */
async function pickOpportunity(
  tx: Db,
  orgId: string,
  input: { patientId: string; serviceIds: string[]; moments?: SaleMoment[] },
) {
  const rows = await tx
    .select({ opp: opportunity, moment: pipelineStage.moment })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.status, "open"),
        ofPerson(orgId, input.patientId),
        input.moments ? inArray(pipelineStage.moment, input.moments) : undefined,
      ),
    )
    .orderBy(desc(opportunity.createdAt), desc(opportunity.id))
  const sameService = rows.find((row) => row.opp.serviceId && input.serviceIds.includes(row.opp.serviceId))
  return sameService ?? rows[0] ?? null
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

/**
 * Al presentar un presupuesto, se une solo a la oportunidad abierta del mismo
 * tratamiento o, si no hay, a la más reciente; la oportunidad adopta al
 * paciente, su valor pasa a ser el total del presupuesto y, si aún no llegaba
 * ahí, pasa sola a «Presupuesto enviado».
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
  },
): Promise<string | null> {
  const picked = await pickOpportunity(tx, orgId, { patientId: input.patientId, serviceIds: input.serviceIds })
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

/**
 * La persona decidió su presupuesto: aceptarlo, aunque sea en parte, gana la
 * oportunidad con lo aceptado como valor; rechazarlo la pierde con «Rechazó el
 * presupuesto». Pospuesto no cambia nada.
 */
export async function decideBudgetOpportunity(
  tx: Db,
  orgId: string,
  input: {
    patientId: string
    budgetId: string
    status: string
    serviceIds: string[]
    /** Lo aceptado, en la moneda del presupuesto: el valor de la oportunidad ganada. */
    accepted?: { cents: number | null; currency: string }
  },
): Promise<string | null> {
  const outcome = input.status === "aceptado" || input.status === "parcial" ? "won" : input.status === "rechazado" ? "lost" : null
  if (!outcome) return null
  const linked = await tx
    .select({ id: opportunity.id, status: opportunity.status })
    .from(opportunity)
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.budgetId, input.budgetId)))
    .orderBy(desc(opportunity.createdAt))
  const open = linked.find((row) => row.status === "open")
  // Completar una respuesta (lo pospuesto de un parcial) no vuelve a decidir una
  // oportunidad que ya se cerró con este presupuesto, ni busca otra.
  if (!open && linked.length > 0) return null
  const id = open?.id ?? (await linkPresentedBudget(tx, orgId, input))
  if (!id) return null
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

/** Las oportunidades abiertas del contacto, para que el agente sepa en qué punto está cada una. */
export async function openOpportunitiesOf(tx: Db, orgId: string, contactId: string) {
  return tx
    .select({ id: opportunity.id, title: opportunity.title, stageName: pipelineStage.name, moment: pipelineStage.moment })
    .from(opportunity)
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.contactId, contactId), eq(opportunity.status, "open")))
    .orderBy(desc(opportunity.createdAt))
}
