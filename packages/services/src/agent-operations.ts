import { canAccess } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import {
  agentHandoff,
  agentProposal,
  agentRunLedger,
  AGENT_RUN_STATUSES,
  DEFAULT_AUTONOMY_MODES,
  HANDOFF_PRIORITIES,
  PROPOSAL_ACTIONS,
  PROPOSAL_STATUSES,
  type AgentPatientContext,
  type AgentRunStatus,
  type AutonomyAction,
  type AutonomyMode,
  type HandoffPriority,
  type ProposalAction,
  type ProposalStatus,
} from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import {
  agentConfig,
  channelConnection,
  contact,
  conversation,
  crmTask,
  message as conversationMessage,
  pipelineStage,
} from "@odentia/db/schema/crm"
import { patient, patientResponsibility, treatmentBudget } from "@odentia/db/schema/clinical"
import { appointment, scheduleRoom } from "@odentia/db/schema/agenda"
import { opportunity } from "@odentia/db/schema/opportunities"
import { and, asc, avg, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, type SQL, sql, sum } from "drizzle-orm"
import { type TopicKind, topicIsUrgent, topicKindOf, topicUrgentAt } from "./topic-urgency.js"
import { listAvailableSlots, validateAvailability, zonedTimeToUtc } from "./availability.js"
import { professionalRef, resolveProfessionalRef } from "./agent-clinic-info.js"
import {
  createAppointment,
  getAppointment,
  moveAppointment,
  setAppointmentStatus,
} from "./appointments.js"
import {
  listMessages,
  sendOutbound,
} from "./conversations.js"
import { type AiUsageEntry, knownCostMicros, recordAiUsage } from "./ai-usage.js"
import { AGENDA_ACTIONS, countConversationAction, refreshConversationTier } from "./saas-actions.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import {
  CHOOSABLE_LOST_REASONS,
  closeOpportunity,
  createOpportunity,
  getOpportunity,
  moveOpportunity,
  setOpportunityTask,
} from "./opportunities.js"
import { confirmationReply } from "./appointment-confirm-words.js"
import { firstName } from "./automation-routing.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { type SendBudgetDeps, sendBudget } from "./budget-send.js"
import { type BudgetLineWithStatus, type BudgetWithTotals, decideBudget, getBudgetDetail, listBudgets } from "./budgets.js"
import { OPERATIONS } from "./operation-fields.js"
import { listPatientsByContact, requirePatient } from "./patients.js"
import { requireDecisionContact, requireLinkedActiveContact } from "./responsibilities.js"
import { createTask, getTask, updateTask } from "./tasks.js"
import { createWorkspaceNotification, upsertWorkspaceNotification } from "./workspace.js"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { getAccountSummary } from "./payments.js"
import { cancelOwnAppointment, confirmOwnAppointment, moveOwnAppointment } from "./own-appointment.js"
import { handoffOpenSql } from "./handoff-state.js"
import { CONFIRM_TTL_HOURS, proposalPendingSql } from "./proposal-state.js"
import {
  formatOrgMoney,
  formatZoned,
  formatZonedShort,
  getOrgLocale,
  type OrgLocale,
} from "./locale.js"

export { CONFIRM_TTL_HOURS }
/** Ventana en ms derivada del plazo (una sola fuente de verdad). */
const CONFIRM_TTL_MS = CONFIRM_TTL_HOURS * 60 * 60 * 1000

/**
 * Caducidad perezosa y persistente: marca `expirada` toda propuesta pendiente
 * anterior al umbral. Se llama antes de bloquear (crear), listar, ver,
 * decidir, confirmar y ejecutar —sin job propio—: la primera
 * lectura/escritura que consolida (sin error posterior) persiste la
 * caducidad, y el filtro por tiempo (`createdAt` reciente) impide que una
 * propuesta vieja bloquee aunque su fila aún no se haya marcado.
 */
export async function expireDueProposals(tx: Db, orgId: string, conversationId?: string): Promise<void> {
  const conditions = [
    eq(agentProposal.organizationId, orgId),
    eq(agentProposal.status, "propuesta"),
    lt(agentProposal.createdAt, new Date(Date.now() - CONFIRM_TTL_MS)),
  ]
  if (conversationId) conditions.push(eq(agentProposal.conversationId, conversationId))
  await tx
    .update(agentProposal)
    .set({ status: "expirada", updatedAt: new Date() })
    .where(and(...conditions))
}

async function expireProposalById(tx: Db, orgId: string, id: string): Promise<void> {
  await tx
    .update(agentProposal)
    .set({ status: "expirada", updatedAt: new Date() })
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        eq(agentProposal.id, id),
        eq(agentProposal.status, "propuesta"),
        lt(agentProposal.createdAt, new Date(Date.now() - CONFIRM_TTL_MS)),
      ),
    )
}
/** Aviso en vivo para el stream del home (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

function assertAction(action: string): asserts action is ProposalAction {
  if (!(PROPOSAL_ACTIONS as readonly string[]).includes(action)) {
    throw validation(
      "Acción inválida (reservar_cita|reprogramar_cita|cancelar_cita|enviar_mensaje|mover_oportunidad|crear_oportunidad|actualizar_seguimiento|cerrar_oportunidad|decidir_presupuesto)",
    )
  }
}

function cleanReason(value: unknown, max = 2000): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (!text) return null
  if (text.length > max) throw validation(`El motivo supera ${max} caracteres`)
  return text
}

/**
 * Permiso que debe tener el operador además de `agent.write` para decidir,
 * confirmar o ejecutar cada acto. `agent.write` solo no autoriza actos de
 * agenda, CRM o conversaciones.
 */
export function requiredPermissionForAction(action: string): string {
  assertAction(action)
  if (action === "enviar_mensaje") return "conversations.write"
  // Registrar el sí de la persona a su respuesta es anotarla: lo de quien anota respuestas.
  if (action === "decidir_presupuesto") return "budgets.decide"
  if (
    action === "mover_oportunidad" ||
    action === "crear_oportunidad" ||
    action === "actualizar_seguimiento" ||
    action === "cerrar_oportunidad"
  ) {
    return "crm.write"
  }
  return "appointments.write"
}

/** Serializa un payload con claves ordenadas para claves estables. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
}

/** Huella corta del payload para la clave de idempotencia. */
function payloadFingerprint(payload: Record<string, unknown>): string {
  const text = stableStringify(payload)
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * Clave de idempotencia estable por evento durable + herramienta + payload:
 * reaprobar o reintentar no reenvía ni duplica el acto.
 */
export function buildAgentProposalKey(input: {
  conversationId: string
  triggerId?: string | null
  tool: string
  payload: Record<string, unknown>
}): string {
  const trigger = input.triggerId?.trim() ? input.triggerId.trim().slice(0, 40) : "sim"
  return `agent:${input.conversationId}:${trigger}:${input.tool}:${payloadFingerprint(input.payload)}`.slice(0, 120)
}

/* ---------- Política de autonomía ---------- */

/**
 * Quién dice que sí a cada acción del agente. Es la misma para todas las
 * clínicas (ADR 0021) y no se guarda: la cita la confirma el interlocutor y lo
 * demás va directo. Ninguna propuesta espera al equipo (ADR 0023).
 */
export function autonomyModeOf(action: AutonomyAction): AutonomyMode {
  return DEFAULT_AUTONOMY_MODES[action]
}

/* ---------- Contexto mínimo verificado del paciente ---------- */

/**
 * Resuelve el contexto que el agente puede ver de un paciente: exige
 * vinculación activa contacto↔paciente y autorización del interlocutor
 * (es el paciente, su representante legal o autorizado de información
 * vigente). Nunca devuelve historia clínica, solo filiación mínima.
 */
export async function resolveAgentPatientContext(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
): Promise<AgentPatientContext> {
  const { relationship } = await requireLinkedActiveContact(tx, orgId, patientId, contactId)
  let authorization: AgentPatientContext["authorization"]
  if (relationship === "self") {
    authorization = "self"
  } else {
    const today = new Date().toISOString().slice(0, 10)
    const [grant] = await tx
      .select({ kind: patientResponsibility.kind })
      .from(patientResponsibility)
      .where(
        and(
          eq(patientResponsibility.organizationId, orgId),
          eq(patientResponsibility.patientId, patientId),
          eq(patientResponsibility.contactId, contactId),
          inArray(patientResponsibility.kind, ["representante_legal", "autorizado_informacion"]),
          isNull(patientResponsibility.revokedAt),
          lte(patientResponsibility.startsAt, today),
          or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
        ),
      )
      .limit(1)
    if (!grant) {
      throw new ServiceError(
        "PATIENT_CONTEXT_FORBIDDEN",
        409,
        "El interlocutor no está autorizado a recibir información de este paciente",
      )
    }
    authorization = grant.kind as AgentPatientContext["authorization"]
  }
  const row = await requirePatient(tx, orgId, patientId)
  return {
    patientId: row.id,
    patientNumber: row.patientNumber,
    displayName: row.displayName,
    relationship,
    authorization,
  }
}

/** Pacientes vinculados al contacto (para que el agente pregunte de quién habla). */
export async function listAgentContextCandidates(tx: Db, orgId: string, contactId: string) {
  const links = await listPatientsByContact(tx, orgId, contactId)
  return links.map((l) => ({
    patientId: l.id,
    patientNumber: l.patientNumber,
    displayName: l.displayName,
    relationship: l.relationship,
  }))
}

export interface AgentPatientSummary {
  context: AgentPatientContext
  upcomingAppointments: Array<{
    appointmentId: string
    version: number
    startsAt: string
    endsAt: string
    status: string
    branchName: string
    branchTimezone: string | null
    professionalName: string
  }>
  budgets: Array<{ number: number; title: string; status: string }>
  /** Citas por venir que no caben en `upcomingAppointments`: se dicen con su número. */
  moreAppointments: number
  /** Presupuestos más antiguos que no caben en `budgets`. */
  moreBudgets: number
  /** null = el interlocutor no tiene facultad económica. */
  balance: Array<{ currency: string; outstandingCents: number }> | null
}

/**
 * Citas por venir que ve el agente de un paciente: todas las de una persona
 * en la práctica (un tratamiento con controles mensuales tiene unas pocas). Si
 * hay más, el resumen dice cuántas y desde qué fecha pedirlas.
 */
export const AGENT_APPOINTMENTS_SHOWN = 12
/** Presupuestos (estado y número) en el resumen; los anteriores se cuentan. */
export const AGENT_SUMMARY_BUDGETS_SHOWN = 5

/**
 * Resumen mínimo del paciente según la facultad del interlocutor, sin leer
 * historia clínica: próximas citas y estado de presupuestos presentados o
 * decididos (nunca borradores) para self/representante/autorizado; saldo
 * solo para self, representante legal o responsable económico vigente.
 * Siempre del paciente verificado, nunca de otro.
 */
export async function getAgentPatientSummary(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
  options: { from?: Date } = {},
): Promise<AgentPatientSummary> {
  const context = await resolveAgentPatientContext(tx, orgId, contactId, patientId)
  // Desde cuándo: por defecto ahora; el agente puede pedir las de más adelante.
  const now = options.from && options.from.getTime() > Date.now() ? options.from : new Date()
  const appointments = await tx
    .select({
      appointmentId: appointment.id,
      version: appointment.version,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      branchName: branch.name,
      branchTimezone: branch.timezone,
      professionalName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(AGENT_APPOINTMENTS_SHOWN + 1)
  const budgetRows = await tx
    .select({
      number: treatmentBudget.budgetNumber,
      title: treatmentBudget.title,
      status: treatmentBudget.status,
    })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId), ne(treatmentBudget.status, "borrador")))
    .orderBy(desc(treatmentBudget.budgetNumber))
    .limit(AGENT_SUMMARY_BUDGETS_SHOWN + 1)
  // Si algo no cupo, se cuenta entero: el agente dice «y N más», nunca calla.
  const countMore = async (shown: number, rows: number, total: () => Promise<number>) => (rows > shown ? (await total()) - shown : 0)
  const moreAppointments = await countMore(AGENT_APPOINTMENTS_SHOWN, appointments.length, async () => {
    const [row] = await tx
      .select({ total: count() })
      .from(appointment)
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, patientId),
          inArray(appointment.status, ["programada", "confirmada"]),
          gte(appointment.startsAt, now),
        ),
      )
    return row?.total ?? 0
  })
  const moreBudgets = await countMore(AGENT_SUMMARY_BUDGETS_SHOWN, budgetRows.length, async () => {
    const [row] = await tx
      .select({ total: count() })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId), ne(treatmentBudget.status, "borrador")))
    return row?.total ?? 0
  })
  let balance: AgentPatientSummary["balance"] = null
  const maySeeBalance =
    context.authorization === "self" ||
    context.authorization === "representante_legal" ||
    (await hasEconomicRole(tx, orgId, patientId, contactId))
  if (maySeeBalance) {
    // La misma cuenta que ve caja: una sola operación para pantalla, portal y
    // agente. Lo que dice es el saldo, ya descontado lo que tiene a favor
    // (`accountBalances`, decisión 22): nunca «debe» a quien no debe nada.
    const account = await getAccountSummary(tx, orgId, patientId)
    balance = account.byCurrency.map((b) => ({ currency: b.currency, outstandingCents: b.saldo }))
  }
  return {
    context,
    upcomingAppointments: appointments.slice(0, AGENT_APPOINTMENTS_SHOWN).map((a) => ({
      appointmentId: a.appointmentId,
      version: a.version,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      branchName: a.branchName,
      branchTimezone: a.branchTimezone,
      professionalName: a.professionalName,
    })),
    budgets: budgetRows.slice(0, AGENT_SUMMARY_BUDGETS_SHOWN),
    moreAppointments,
    moreBudgets,
    balance,
  }
}

/** Una cita que el interlocutor puede confirmar, dicha para el agente. */
export interface ContactAppointmentOption {
  appointmentId: string
  patientName: string
  startsAt: string
  branchName: string
  branchTimezone: string | null
  professionalName: string
}

/** Una cita de las que quedaron confirmadas, con si ya lo estaba. */
export type ContactConfirmedAppointment = ContactAppointmentOption & { was: "confirmada" | "ya_confirmada" }

export type ContactConfirmOutcome =
  | {
      outcome: "confirmada" | "ya_confirmada"
      /** La primera de las confirmadas; `appointments` las trae todas. */
      appointment: ContactAppointmentOption
      appointments: ContactConfirmedAppointment[]
      /** Lo que se le contesta, la misma frase que el botón: «¡Listo! Confirmé las citas de Sofía y Pedro…». */
      reply: string
    }
  | { outcome: "ninguna" }
  | { outcome: "varias"; options: ContactAppointmentOption[] }

/** Cuánto tiempo un «sí» sin decir cuál responde al último recordatorio. */
const REMINDER_REPLY_HOURS = 72

/**
 * Las citas del último recordatorio que se le envió por esta conversación
 * (todas las de un mismo mensaje: un padre recibe juntas las de sus hijos),
 * si salió en las últimas `REMINDER_REPLY_HOURS` horas.
 */
async function lastReminderAppointments(tx: Db, orgId: string, contactId: string, conversationId: string): Promise<string[]> {
  const rows = await tx.execute<{ appointment_id: string }>(sql`
    with last as (
      select j.sent_message_id from automation_job j
      join message m on m.id = j.sent_message_id and m.organization_id = j.organization_id
      where j.organization_id = ${orgId} and j.contact_id = ${contactId} and j.kind = 'recordatorio_cita'
        and j.status = 'enviado' and m.conversation_id = ${conversationId}
        and m.created_at > now() - make_interval(hours => ${REMINDER_REPLY_HOURS})
      order by m.created_at desc limit 1)
    select j.appointment_id from automation_job j join last on last.sent_message_id = j.sent_message_id
    where j.organization_id = ${orgId} and j.contact_id = ${contactId} and j.appointment_id is not null`)
  return [...new Set(rows.map((row) => row.appointment_id))]
}

/**
 * El interlocutor confirma por escrito («sí, ahí estaré») una cita que ya
 * existe. Es la misma operación que el botón «Confirmar» del recordatorio
 * (`setAppointmentStatus`), sin propuesta: confirmar su propia cita no cambia
 * nada más y se deshace en la Agenda. Solo citas por venir de los pacientes
 * que el interlocutor está autorizado a ver (`resolveAgentPatientContext`):
 * nunca la de otra persona. Sin `appointmentId`, como el botón, confirma las
 * citas del último recordatorio que recibió (un padre, las de quienes lleva);
 * si no hay, la única que espera su sí, y con varias devuelve las opciones para
 * que el agente pregunte. La respuesta dice de quiénes son (`confirmationReply`).
 * Queda auditado con `via: "conversacion"` y la conversación.
 */
export async function confirmAppointmentByContact(
  tx: Db,
  orgId: string,
  input: { contactId: string; conversationId: string; appointmentId?: string },
): Promise<ContactConfirmOutcome> {
  const now = new Date()
  const options: Array<ContactAppointmentOption & { status: string; self: boolean }> = []
  for (const candidate of await listPatientsByContact(tx, orgId, input.contactId)) {
    try {
      await resolveAgentPatientContext(tx, orgId, input.contactId, candidate.id)
    } catch (error) {
      if (error instanceof ServiceError && error.code === "PATIENT_CONTEXT_FORBIDDEN") continue
      throw error
    }
    const rows = await tx
      .select({
        appointmentId: appointment.id,
        status: appointment.status,
        startsAt: appointment.startsAt,
        branchName: branch.name,
        branchTimezone: branch.timezone,
        professionalName: user.name,
      })
      .from(appointment)
      .innerJoin(branch, eq(branch.id, appointment.branchId))
      .innerJoin(user, eq(user.id, appointment.professionalUserId))
      .where(
        and(
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, candidate.id),
          inArray(appointment.status, ["programada", "confirmada"]),
          gt(appointment.startsAt, now),
        ),
      )
      .orderBy(asc(appointment.startsAt))
    for (const row of rows) {
      options.push({
        ...row,
        startsAt: row.startsAt.toISOString(),
        patientName: candidate.displayName,
        self: candidate.relationship === "self",
      })
    }
  }
  const strip = ({ status: _status, self: _self, ...option }: (typeof options)[number]): ContactAppointmentOption => option
  let chosen: Array<(typeof options)[number]>
  if (input.appointmentId) {
    const found = options.find((option) => option.appointmentId === input.appointmentId)
    if (!found) {
      throw new ServiceError(
        "APPOINTMENT_NOT_CONFIRMABLE",
        409,
        "Esa cita no es una cita por venir de alguien que esta persona puede confirmar",
      )
    }
    chosen = [found]
  } else {
    const reminded = await lastReminderAppointments(tx, orgId, input.contactId, input.conversationId)
    const together = options.filter((option) => reminded.includes(option.appointmentId))
    const waiting = options.filter((option) => option.status === "programada")
    if (together.length > 0) chosen = together
    else if (waiting.length > 1) return { outcome: "varias", options: waiting.map(strip) }
    else {
      const one = waiting[0] ?? (options.length === 1 ? options[0] : undefined)
      if (!one) return options.length === 0 ? { outcome: "ninguna" } : { outcome: "varias", options: options.map(strip) }
      chosen = [one]
    }
  }
  const appointments: ContactConfirmedAppointment[] = []
  for (const item of chosen) {
    // La regla de la cita propia (`own-appointment.ts`), la del enlace y el
    // portal: confirmar una ya confirmada la deja como está.
    await confirmOwnAppointment(
      tx,
      orgId,
      // Sin autora del equipo: quién confirmó consta en `via` y la conversación.
      null,
      { id: item.appointmentId, status: item.status, startsAt: new Date(item.startsAt) },
      "conversacion",
      { conversationId: input.conversationId },
    )
    appointments.push({ ...strip(item), was: item.status === "programada" ? "confirmada" : "ya_confirmada" })
  }
  const reply = confirmationReply(
    chosen.map((item) => ({
      patientName: item.patientName,
      self: item.self,
      was: item.status === "programada" ? "confirmada" : "ya_confirmada",
      startsAt: item.startsAt,
    })),
  )
  return {
    outcome: appointments.some((item) => item.was === "confirmada") ? "confirmada" : "ya_confirmada",
    appointment: strip(chosen[0]!),
    appointments,
    reply,
  }
}

async function hasEconomicRole(tx: Db, orgId: string, patientId: string, contactId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)
  const [grant] = await tx
    .select({ id: patientResponsibility.id })
    .from(patientResponsibility)
    .where(
      and(
        eq(patientResponsibility.organizationId, orgId),
        eq(patientResponsibility.patientId, patientId),
        eq(patientResponsibility.contactId, contactId),
        eq(patientResponsibility.kind, "responsable_economico"),
        isNull(patientResponsibility.revokedAt),
        lte(patientResponsibility.startsAt, today),
        or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
      ),
    )
    .limit(1)
  return !!grant
}

/* ---------- Presupuestos de la persona (Recepción, fase 3: decisiones 4 y 5) ---------- */

/** Lo que se responde por cada tratamiento: la lista la declara su operación. */
const BUDGET_ANSWER_DECISIONS = OPERATIONS["presupuesto.respuesta"].fields.decisions.values
type BudgetAnswerDecision = (typeof BUDGET_ANSWER_DECISIONS)[number]

/** Estados en los que se anota una respuesta: enviado, o con algo que dejó para después. */
const BUDGET_ANSWERABLE = ["presentado", "parcial", "pospuesto"]
/** Lo que la persona no recibe como suyo: lo que aún se prepara y lo que se anuló o reemplazó. */
const BUDGET_NOT_DELIVERED = ["borrador", "cancelado", "sustituido"]
/** Lo que se puede reenviar (o, en borrador, lo que todavía no está listo). */
const BUDGET_RESENDABLE = ["borrador", "presentado", "pospuesto", "parcial", "aceptado"]
/** Presupuestos entregados que ve el agente, del más reciente al más antiguo. */
const AGENT_BUDGETS_SHOWN = 3
/** Plazo de la tarea que deja el agente cuando no puede enviarlo: el de un caso de prioridad media. */
const BUDGET_TASK_DUE_HOURS = 24

/** Una línea tal como la ve la persona en su presupuesto: nunca diagnósticos ni notas clínicas. */
export interface AgentBudgetLine {
  planItemId: string
  title: string
  /** «pieza 16», como en el PDF; nulo si no es de una pieza. */
  piece: string | null
  lineTotalCents: number | null
  /** Se cobra por sesión: cuántas visitas y a cuánto cada una. */
  sessions: { count: number; unitCents: number | null } | null
  promotionName: string | null
  /** `pendiente`, `aceptado`, `pospuesto`, `rechazado` o `no_elegida`. */
  decision: string
}

export interface AgentBudgetOption {
  id: string
  /** «Opción A». */
  label: string
  isRecommended: boolean
  decision: string
  totalCents: number | null
  lines: AgentBudgetLine[]
}

export interface AgentBudgetView {
  budgetId: string
  budgetNumber: number
  status: string
  /** El estado con el nombre de toda la aplicación («Enviado · espera respuesta»). */
  stateText: string
  currency: string
  /** Se le puede anotar una respuesta. */
  answerable: boolean
  /** El de la opción elegida o, mientras decide, el de la recomendada. */
  totalCents: number | null
  options: AgentBudgetOption[]
}

export interface AgentPatientBudgets {
  context: AgentPatientContext
  /** Los entregados, del más reciente al más antiguo (como mucho `AGENT_BUDGETS_SHOWN`). */
  budgets: AgentBudgetView[]
  /** Entregados más antiguos que no van: se dicen con su número. */
  olderBudgets: number
  /** Hay uno que la clínica aún prepara: se dice que existe, nunca qué lleva. */
  inPreparation: boolean
}

function agentBudgetLine(line: BudgetLineWithStatus): AgentBudgetLine {
  return {
    planItemId: line.planItemId,
    title: line.title,
    piece: line.toothNumber != null ? `pieza ${line.toothNumber}` : null,
    lineTotalCents: line.lineTotalCents,
    sessions: line.billingMode === "session" ? { count: Math.max(line.sessionsPlanned ?? 1, 1), unitCents: line.priceCents } : null,
    promotionName: line.promotionName,
    decision: line.decision,
  }
}

function agentBudgetView(budget: BudgetWithTotals): AgentBudgetView {
  return {
    budgetId: budget.id,
    budgetNumber: budget.budgetNumber,
    status: budget.status,
    stateText: budget.stateText,
    currency: budget.currency,
    answerable: BUDGET_ANSWERABLE.includes(budget.status),
    totalCents: budget.totalCents,
    options: budget.options.map((option) => ({
      id: option.id,
      label: option.label,
      isRecommended: option.isRecommended,
      decision: option.decision,
      totalCents: option.totalCents,
      lines: budget.items.filter((line) => line.optionId === option.id).map(agentBudgetLine),
    })),
  }
}

/** «N.º 0012», como en el documento. */
export function budgetNumberText(budgetNumber: number): string {
  return `N.º ${String(budgetNumber).padStart(4, "0")}`
}

/**
 * Los presupuestos de un paciente que el interlocutor está autorizado a ver
 * (`resolveAgentPatientContext`: la persona, su representante o quien ella
 * autorizó; nunca por coincidencia de teléfono), tal como los recibe la
 * persona: tratamientos, pieza, precios y opciones. Sin diagnósticos ni notas.
 * Del que aún se prepara solo se dice que existe.
 */
export async function getAgentPatientBudgets(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
): Promise<AgentPatientBudgets> {
  const context = await resolveAgentPatientContext(tx, orgId, contactId, patientId)
  const all = await listBudgets(tx, orgId, patientId)
  const newest = [...all].reverse()
  const delivered = newest.filter((budget) => !BUDGET_NOT_DELIVERED.includes(budget.status))
  return {
    context,
    budgets: delivered.slice(0, AGENT_BUDGETS_SHOWN).map(agentBudgetView),
    olderBudgets: Math.max(0, delivered.length - AGENT_BUDGETS_SHOWN),
    inPreparation: all.some((budget) => budget.status === "borrador"),
  }
}

export type AgentBudgetResend =
  | {
      outcome: "enviado"
      budgetNumber: number
      recipientName: string
      /** Le llegó a quien escribe; si no, a su representante legal (paciente menor). */
      toInterlocutor: boolean
      channel: "whatsapp" | "email"
      via: "respuesta" | "plantilla" | "correo"
      /** Salió en esta misma conversación. */
      here: boolean
    }
  | {
      /** `no_listo`: aún en borrador; `ninguno`: no hay presupuesto; `sin_via`: no hubo por dónde enviarlo. */
      outcome: "no_listo" | "ninguno" | "sin_via"
      /** Por qué no salió, para el equipo. */
      detail: string | null
      /** La tarea que quedó a recepción. */
      taskId: string
    }

/**
 * La persona pide su presupuesto por la conversación: se le reenvía el que la
 * clínica ya preparó y entregó, por la misma operación que la pantalla
 * (`sendBudget` con `by: "agente"`: WhatsApp primero, a la persona o, si es
 * menor, a su representante legal). Nunca entrega un borrador ni arma uno.
 * Solo para pacientes que el interlocutor está autorizado a ver. Sin
 * `budgetId`, el último que la clínica preparó para ese paciente.
 *
 * Si aún no está listo, no hay ninguno o no hay por dónde enviarlo, no se
 * intenta otra vía: queda una tarea a recepción («Lucía pidió su presupuesto:
 * enviarlo») con el motivo, y el agente sigue atendiendo. `requestId` hace que
 * reintentar el mismo pedido no lo envíe ni deje la tarea dos veces.
 */
export async function resendBudgetByContact(
  tx: Db,
  orgId: string,
  input: { contactId: string; conversationId: string; patientId: string; budgetId?: string | null; requestId: string },
  deps: { storage?: SendBudgetDeps["storage"] | null; secretsKey?: Buffer },
): Promise<AgentBudgetResend> {
  const context = await resolveAgentPatientContext(tx, orgId, input.contactId, input.patientId)
  const budgets = await listBudgets(tx, orgId, input.patientId)
  let target: BudgetWithTotals | undefined
  if (input.budgetId) {
    target = budgets.find((budget) => budget.id === input.budgetId)
    if (!target) throw notFound("Presupuesto")
  } else {
    target = [...budgets].reverse().find((budget) => BUDGET_RESENDABLE.includes(budget.status))
  }
  const leaveTask = async (outcome: "no_listo" | "ninguno" | "sin_via", detail: string | null): Promise<AgentBudgetResend> => {
    const [asker] = await tx
      .select({ givenNames: contact.givenNames, displayName: contact.displayName })
      .from(contact)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId)))
      .limit(1)
    const [person] = await tx
      .select({ givenNames: patientPerson.givenNames, displayName: patientPerson.displayName })
      .from(patient)
      .innerJoin(patientPerson, joinPatientPerson(patientPerson))
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, input.patientId)))
      .limit(1)
    const who = asker ? firstName(asker) : "La persona"
    const whose = context.relationship === "self" || !person ? "su presupuesto" : `el presupuesto de ${firstName(person)}`
    const reason =
      outcome === "no_listo"
        ? "Aún no está listo: revísalo y envíaselo."
        : outcome === "ninguno"
          ? "No tiene un presupuesto preparado."
          : `No se pudo enviar: ${detail ?? "no hubo por dónde"}`
    const task = await createTask(tx, orgId, {
      title: `${who} pidió ${whose}: enviarlo`,
      contactId: input.contactId,
      conversationId: input.conversationId,
      patientId: input.patientId,
      dueAt: new Date(Date.now() + BUDGET_TASK_DUE_HOURS * 3_600_000).toISOString(),
      area: "recepcion",
      reason,
      createdBy: "agent",
      idempotencyKey: `${input.requestId}:tarea`,
    })
    return { outcome, detail, taskId: task.id }
  }
  if (!target) return leaveTask("ninguno", null)
  if (target.status === "borrador") return leaveTask("no_listo", null)
  if (!deps.storage) return leaveTask("sin_via", "el envío de documentos no está disponible desde el agente")
  // Lo que el envío alcanzó a escribir antes de fallar no queda a medias.
  await tx.execute(sql.raw("SAVEPOINT sp_budget_resend"))
  try {
    const sent = await sendBudget(
      tx,
      orgId,
      { userId: null, by: "agente" },
      { patientId: input.patientId, budgetId: target.id, requestId: input.requestId },
      { storage: deps.storage, ...(deps.secretsKey ? { secretsKey: deps.secretsKey } : {}) },
    )
    await tx.execute(sql.raw("RELEASE SAVEPOINT sp_budget_resend"))
    const [thread] = await tx
      .select({ contactId: conversation.contactId })
      .from(conversation)
      .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, sent.conversationId)))
      .limit(1)
    return {
      outcome: "enviado",
      budgetNumber: target.budgetNumber,
      recipientName: sent.recipientName,
      toInterlocutor: thread?.contactId === input.contactId,
      channel: sent.channel,
      via: sent.via,
      here: sent.conversationId === input.conversationId,
    }
  } catch (error) {
    await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT sp_budget_resend"))
    await tx.execute(sql.raw("RELEASE SAVEPOINT sp_budget_resend"))
    if (!(error instanceof ServiceError)) throw error
    if (error.code === "BUDGET_NOT_READY") return leaveTask("no_listo", null)
    if (error.code === "BUDGET_NO_ROUTE" || error.code === "BUDGET_OPTED_OUT" || error.code === "BUDGET_NO_RECIPIENT") {
      return leaveTask("sin_via", error.message)
    }
    throw error
  }
}

/** La respuesta de la persona, leída contra el presupuesto vivo. */
export interface BudgetAnswer {
  budget: BudgetWithTotals
  option: { id: string; label: string; /** Elige ahora entre varias. */ choosing: boolean }
  accepted: AgentBudgetLine[]
  postponed: AgentBudgetLine[]
  rejected: AgentBudgetLine[]
  /** Lo que suma lo que acepta ahora; nulo si algún precio no se conoce. */
  acceptedCents: number | null
  /** Una por cada línea de la opción: lo que dijo y, de lo ya decidido, lo que había. */
  decisions: Array<{ planItemId: string; decision: BudgetAnswerDecision }>
}

export interface BudgetAnswerInput {
  patientId: string
  budgetId: string
  optionId?: string | null
  decisions: Array<{ planItemId: string; decision: BudgetAnswerDecision }>
}

/**
 * Valida lo que respondió contra el presupuesto, sin escribir: la opción (si
 * hay varias y aún no eligió, debe decir cuál), que cada tratamiento esté en
 * ella y que responda todo lo que sigue abierto (lo pendiente, o lo que dejó
 * para después). Lo ya decidido se conserva tal cual; nunca se reescribe.
 */
async function budgetAnswerOf(tx: Db, orgId: string, input: BudgetAnswerInput): Promise<BudgetAnswer> {
  const budget = await getBudgetDetail(tx, orgId, input.patientId, input.budgetId)
  if (!BUDGET_ANSWERABLE.includes(budget.status)) {
    throw new ServiceError("BUDGET_STATUS", 409, `Ese presupuesto no espera respuesta (${budget.stateText})`)
  }
  const chosen = budget.options.find((option) => option.decision === "elegida") ?? null
  let option: BudgetWithTotals["options"][number] | undefined
  if (chosen) {
    if (input.optionId && input.optionId !== chosen.id) {
      throw new ServiceError("BUDGET_DECISION_FINAL", 409, `Ya eligió la ${chosen.label}: esa elección no cambia por aquí`)
    }
    option = chosen
  } else if (budget.options.length === 1) {
    option = budget.options[0]
  } else {
    option = budget.options.find((item) => item.id === input.optionId)
    if (!option) {
      throw new ServiceError(
        "BUDGET_OPTION_REQUIRED",
        409,
        `Tiene ${budget.options.length} opciones (${budget.options.map((item) => item.label).join(", ")}): pregunta cuál elige`,
      )
    }
  }
  if (!option) throw notFound("Opción del presupuesto")
  const lines = budget.items.filter((line) => line.optionId === option.id)
  const said = new Map(input.decisions.map((item) => [item.planItemId, item.decision]))
  if (said.size !== input.decisions.length) throw validation("Un tratamiento aparece dos veces en la respuesta")
  if (input.decisions.some((item) => !lines.some((line) => line.planItemId === item.planItemId))) {
    throw new ServiceError("BUDGET_ANSWER_UNKNOWN", 409, `Hay tratamientos que no están en la ${option.label}: usa los ids de ver_presupuesto`)
  }
  const open = lines.filter((line) => line.decision === "pendiente" || line.decision === "pospuesto")
  if (open.length === 0) throw new ServiceError("BUDGET_STATUS", 409, "Ya respondió todo ese presupuesto")
  for (const line of lines) {
    if (open.includes(line)) continue
    const next = said.get(line.planItemId)
    if (next && next !== line.decision) {
      throw new ServiceError("BUDGET_DECISION_FINAL", 409, `Lo que ya decidió no cambia: ${budgetLineWords(agentBudgetLine(line))} ya está ${line.decision}`)
    }
  }
  const missing = open.filter((line) => !said.has(line.planItemId))
  if (missing.length > 0) {
    throw new ServiceError(
      "BUDGET_ANSWER_INCOMPLETE",
      409,
      `Falta saber qué hace con ${joinWords(missing.map((line) => budgetLineWords(agentBudgetLine(line))))}: pregúntaselo`,
    )
  }
  const answered = open.map((line) => ({ line: agentBudgetLine(line), decision: said.get(line.planItemId)! }))
  const accepted = answered.filter((item) => item.decision === "aceptado").map((item) => item.line)
  let acceptedCents: number | null = 0
  for (const line of accepted) {
    if (line.lineTotalCents == null || acceptedCents == null) acceptedCents = null
    else acceptedCents += line.lineTotalCents
  }
  return {
    budget,
    option: { id: option.id, label: option.label, choosing: !chosen && budget.options.length > 1 },
    accepted,
    postponed: answered.filter((item) => item.decision === "pospuesto").map((item) => item.line),
    rejected: answered.filter((item) => item.decision === "rechazado").map((item) => item.line),
    acceptedCents,
    decisions: lines.map((line) => ({
      planItemId: line.planItemId,
      decision: said.get(line.planItemId) ?? (line.decision as BudgetAnswerDecision),
    })),
  }
}

/** La respuesta de una propuesta ya guardada; nula si el presupuesto ya no la admite. */
async function readBudgetAnswer(tx: Db, orgId: string, payload: Record<string, unknown>): Promise<BudgetAnswer | null> {
  if (!isUuid(payload.patientId) || !isUuid(payload.budgetId) || !Array.isArray(payload.decisions)) return null
  try {
    return await budgetAnswerOf(tx, orgId, {
      patientId: payload.patientId,
      budgetId: payload.budgetId,
      optionId: isUuid(payload.optionId) ? payload.optionId : null,
      decisions: payload.decisions as BudgetAnswerInput["decisions"],
    })
  } catch (error) {
    if (error instanceof ServiceError) return null
    throw error
  }
}

/**
 * Antes de proponer la respuesta: quien escribe debe poder decidir (la
 * persona o su representante legal vigente; un autorizado de información, no)
 * y, si ya respondió antes otra persona, solo ella completa lo que quedó para
 * después. Devuelve lo que se repetirá a la persona y la propuesta a crear.
 */
export async function planBudgetAnswer(
  tx: Db,
  orgId: string,
  contactId: string,
  input: BudgetAnswerInput,
): Promise<{ answer: BudgetAnswer; payload: Record<string, unknown> }> {
  await requireDecisionContact(tx, orgId, input.patientId, contactId)
  const answer = await budgetAnswerOf(tx, orgId, input)
  if (answer.budget.decisionContactId && answer.budget.decisionContactId !== contactId) {
    throw new ServiceError("BUDGET_DECISION_OWNER", 409, "Lo respondió otra persona: solo ella completa lo que dejó para después")
  }
  return {
    answer,
    payload: { patientId: input.patientId, budgetId: input.budgetId, optionId: answer.option.id, decisions: answer.decisions },
  }
}

/** «Resina compuesta de la pieza 16». */
export function budgetLineWords(line: Pick<AgentBudgetLine, "title" | "piece">): string {
  return line.piece ? `${line.title} de la ${line.piece}` : line.title
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`
}

function acceptedMoney(answer: BudgetAnswer, zone: Pick<OrgLocale, "locale">): string {
  return answer.accepted.length > 0 && answer.acceptedCents != null
    ? ` (${formatOrgMoney(answer.acceptedCents, answer.budget.currency, zone)})`
    : ""
}

/** Lo que se anotará, dicho para el equipo y para el propio agente en el estado del caso. */
export function budgetAnswerSummary(answer: BudgetAnswer, zone: Pick<OrgLocale, "locale">): string {
  const parts = [
    answer.accepted.length ? `acepta ${joinWords(answer.accepted.map(budgetLineWords))}${acceptedMoney(answer, zone)}` : null,
    answer.postponed.length ? `deja para después ${joinWords(answer.postponed.map(budgetLineWords))}` : null,
    answer.rejected.length ? `no acepta ${joinWords(answer.rejected.map(budgetLineWords))}` : null,
  ].filter((part): part is string => part !== null)
  const head = `Presupuesto ${budgetNumberText(answer.budget.budgetNumber)}${answer.option.choosing ? `, ${answer.option.label}` : ""}`
  return `${head}: ${parts.join("; ")}`
}

/**
 * La pregunta que confirma la lista antes de anotarla, en el trato de la
 * clínica: «Entonces anoto que aceptas … (S/ 360.00) y dejas para después ….
 * ¿Es correcto?». El importe es la suma de lo que acepta ahora.
 */
export function budgetAnswerQuestion(
  answer: BudgetAnswer,
  zone: Pick<OrgLocale, "locale">,
  treatment: "tu" | "usted" | null,
): string {
  const say = (tu: string, usted: string) => (treatment === "usted" ? usted : tu)
  const clauses = [
    answer.option.choosing ? `${say("eliges", "elige")} la ${answer.option.label}` : null,
    answer.accepted.length ? `${say("aceptas", "acepta")} ${joinWords(answer.accepted.map(budgetLineWords))}${acceptedMoney(answer, zone)}` : null,
    answer.postponed.length ? `${say("dejas", "deja")} para después ${joinWords(answer.postponed.map(budgetLineWords))}` : null,
    answer.rejected.length ? `no ${say("aceptas", "acepta")} ${joinWords(answer.rejected.map(budgetLineWords))}` : null,
  ].filter((part): part is string => part !== null)
  return `Entonces anoto que ${joinWords(clauses)}. ¿Es correcto?`
}

/**
 * «Sí» / «No» bajo la pregunta que espera confirmar una propuesta. No son
 * botones del sistema (no empiezan por `odentia:`): tocarlos es escribirlo, y
 * el sí lo confirma el agente como cualquier otro (`confirmProposalByContact`).
 */
export function proposalConfirmButtons(proposalId: string): Array<{ id: string; title: string }> {
  return [
    { id: `agente:si:${proposalId}`, title: "Sí" },
    { id: `agente:no:${proposalId}`, title: "No" },
  ]
}

/** Botones de un mensaje del agente, si son válidos: de uno a tres, con id y título breve. */
function replyButtonsOf(value: unknown): Array<{ id: string; title: string }> | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null
  const buttons: Array<{ id: string; title: string }> = []
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null
    const { id, title } = item as Record<string, unknown>
    if (typeof id !== "string" || !id.trim() || id.length > 200) return null
    if (typeof title !== "string" || !title.trim() || title.length > 20) return null
    buttons.push({ id, title })
  }
  return buttons
}

/* ---------- Disponibilidad (delegada en Agenda) ---------- */

export interface FreeGapInput {
  from: string
  to: string
  /** Sin indicar, la del servicio y, si no hay servicio, la de una cita regular en la sede. */
  durationMin?: number
  branchId?: string
  professionalUserId?: string
  /**
   * El identificador del profesional que recibe el agente (`professionalRef`):
   * «quiero cita con la Dra. Rojas». Solo sirve para pedir sus huecos.
   */
  professionalRef?: string
  roomId?: string
  serviceId?: string
}

export interface FreeGap {
  startsAt: string
  endsAt: string
  professionalUserId: string
  /** Lo que ve el agente en lugar del usuario (`professionalRef`): nunca recibe ids de usuario. */
  professionalRef: string
  /** Nombre del profesional, para decirlo a la persona. */
  professionalName: string | null
  roomId: string | null
}

/**
 * Un límite del rango: «2026-10-16» o «2026-10-16T08:00» sin zona es hora
 * local de la sede (así piensa quien pide «el viernes en la mañana»); con
 * zona (`Z`, `-05:00`) es un instante.
 */
function rangeBound(value: string, timeZone: string): Date {
  const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(value.trim())
  if (local) return zonedTimeToUtc(local[1]!, Number(local[2] ?? 0) * 60 + Number(local[3] ?? 0), timeZone)
  return new Date(value)
}

export interface FreeGapResult {
  gaps: FreeGap[]
  truncated: boolean
  timeZone: string
  /** Si el servicio tiene quien lo atienda en la sede: su especialidad y sus nombres. */
  attending: { specialtyName: string; names: string[] } | null
  /** Se pidió un profesional que no atiende ese servicio en la sede. */
  professionalNotAttending: boolean
}

/** Huecos que ofrece el agente por profesional y día (decisión 16 de la fase 4). */
export const GAPS_PER_PROFESSIONAL_PER_DAY = 2
/** Huecos que caben en una respuesta de `buscar_huecos`. */
export const GAPS_SHOWN = 20

/**
 * Huecos libres según Agenda (`listAvailableSlots`): respeta horario semanal
 * del profesional, bloqueos y citas ocupantes, y con servicio ofrece solo a
 * quien lo atiende (la misma regla que recepción y el enlace). Dos huecos por
 * profesional y día, ordenados por hora: una sola persona no se queda con la
 * lista. Sin horario configurado no hay huecos (el agente debe decirlo, no
 * inventarlos). Si `truncated`, acota el rango o pagina por días.
 */
export async function findFreeGaps(tx: Db, orgId: string, input: FreeGapInput): Promise<FreeGapResult> {
  if (!input.branchId?.trim()) throw validation("branchId es obligatoria para buscar huecos")
  const [place] = await tx
    .select({ timezone: branch.timezone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, input.branchId)))
    .limit(1)
  const zone = place?.timezone || (await getOrgLocale(tx, orgId)).timezone
  const from = rangeBound(input.from, zone)
  const to = rangeBound(input.to, zone)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw validation("Rango de búsqueda inválido")
  }
  if (to.getTime() - from.getTime() > 8 * 24 * 60 * 60 * 1000) {
    throw validation("El rango máximo de búsqueda es 8 días")
  }
  const durationMin = input.durationMin === undefined ? undefined : Math.floor(input.durationMin)
  if (durationMin !== undefined && (!Number.isInteger(durationMin) || durationMin < 10 || durationMin > 480)) {
    throw validation("durationMin debe ser entero entre 10 y 480")
  }
  let professionalUserId = input.professionalUserId
  if (input.professionalRef?.trim()) {
    const resolved = await resolveProfessionalRef(tx, orgId, input.professionalRef)
    if (!resolved) throw validation("Ese profesional no existe en la clínica: usa el identificador de la lista de profesionales")
    professionalUserId = resolved
  }
  const { slots, truncated, timeZone, attending } = await listAvailableSlots(tx, orgId, {
    branchId: input.branchId,
    professionalUserId,
    roomId: input.roomId,
    serviceId: input.serviceId,
    from: from.toISOString(),
    to: to.toISOString(),
    ...(durationMin === undefined ? {} : { durationMin }),
    // El agente nunca ofrece una hora que ya pasó.
    notBefore: new Date().toISOString(),
    perProfessionalPerDay: GAPS_PER_PROFESSIONAL_PER_DAY,
  })
  const shown = slots.slice(0, GAPS_SHOWN)
  const ids = [...new Set([...shown.map((s) => s.professionalUserId), ...(attending?.professionalUserIds ?? [])])]
  const names = ids.length
    ? new Map(
        (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))).map((row) => [row.id, row.name]),
      )
    : new Map<string, string>()
  return {
    gaps: shown.map((s) => ({
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      professionalUserId: s.professionalUserId,
      professionalRef: professionalRef(orgId, s.professionalUserId),
      professionalName: names.get(s.professionalUserId) ?? null,
      roomId: s.roomId,
    })),
    truncated: truncated || slots.length > GAPS_SHOWN,
    timeZone,
    attending: attending
      ? {
          specialtyName: attending.specialtyName,
          names: attending.professionalUserIds.map((id) => names.get(id)).filter((name): name is string => Boolean(name)),
        }
      : null,
    professionalNotAttending: Boolean(attending && professionalUserId && !attending.professionalUserIds.includes(professionalUserId)),
  }
}

/* ---------- Propuestas y aprobaciones ---------- */

export interface ProposalContext {
  contactName: string | null
  patientName: string | null
  channel: string | null
  branchName: string | null
  professionalName: string | null
  opportunityTitle: string | null
  beforeSummary: string | null
  /** Siempre string: etiqueta del acto si el legado no trae evidencia. */
  afterSummary: string
  /** true si lo vivo cambió desde la evidencia congelada: revisar antes de aprobar. */
  isStale: boolean
  /** Estado vivo resumido para comparar con la evidencia; nulo si no aplica. */
  currentSummary: string | null
}

export interface ProposalItem {
  id: string
  /** Toda propuesta vive en una conversación: el agente no abre hilos por su cuenta (ADR 0023). */
  conversationId: string
  contactId: string | null
  action: ProposalAction
  /** Quién dice que sí: nadie (directo) o el interlocutor en el hilo. Ninguna espera al equipo. */
  mode: AutonomyMode
  status: ProposalStatus
  payload: Record<string, unknown>
  reason: string | null
  idempotencyKey: string
  result: Record<string, unknown> | null
  error: string | null
  proposedBy: string
  decidedBy: string | null
  decidedAt: string | null
  executedAt: string | null
  createdAt: string
  /** Nombres y antes/después autorizados; nunca historia clínica. */
  context: ProposalContext
}

type ProposalRow = typeof agentProposal.$inferSelect

function baseProposal(row: ProposalRow, mode: AutonomyMode, context: ProposalContext): ProposalItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    contactId: row.contactId,
    action: row.action as ProposalAction,
    mode,
    status: row.status as ProposalStatus,
    payload: row.payload,
    reason: row.reason,
    idempotencyKey: row.idempotencyKey,
    result: row.result,
    error: row.error,
    proposedBy: row.proposedBy,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    context,
  }
}

function payloadText(value: unknown, max = 140): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function payloadDate(value: unknown, zone: Pick<OrgLocale, "timezone" | "locale">): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : formatZoned(value, zone)
  }
  if (typeof value !== "string" || !value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return formatZoned(date, zone)
}

/** El día y la hora de una cita como se dicen («lun 19 oct, 3:00 p. m.»). */
function payloadWhen(value: unknown, zone: Pick<OrgLocale, "timezone" | "locale">): string | null {
  const date =
    value instanceof Date ? value : typeof value === "string" && value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return null
  return formatZonedShort(date, zone)
}

/** Cómo se dice el estado de una oportunidad o de una cita, sin su código. */
const STATUS_WORDS: Record<string, string> = {
  open: "abierta",
  won: "ganada",
  lost: "perdida",
  programada: "programada",
  confirmada: "confirmada",
  atendida: "atendida",
  no_asistio: "no vino",
  cancelada: "cancelada",
}
const statusWords = (status: string): string => STATUS_WORDS[status] ?? status.replace(/_/g, " ")

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
}

/** Etiqueta operativa del acto: fallback de afterSummary si el legado no trae evidencia. */
export const PROPOSAL_ACTION_LABEL: Record<ProposalAction, string> = {
  reservar_cita: "Reservar cita",
  reprogramar_cita: "Reprogramar cita",
  cancelar_cita: "Cancelar cita",
  enviar_mensaje: "Enviar mensaje",
  mover_oportunidad: "Mover oportunidad",
  crear_oportunidad: "Crear oportunidad",
  actualizar_seguimiento: "Dejar la tarea de una oportunidad",
  cerrar_oportunidad: "Cerrar oportunidad",
  decidir_presupuesto: "Anotar la respuesta a un presupuesto",
}

async function stageNamesById(tx: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const stages = await tx
    .select({ id: pipelineStage.id, name: pipelineStage.name })
    .from(pipelineStage)
    .where(inArray(pipelineStage.id, ids))
  return new Map(stages.map((s) => [s.id, s.name]))
}

/** La próxima acción de una oportunidad es su tarea abierta: su vencimiento y su título. */
const OPP_TASK_DUE = sql<Date | null>`(select t.due_at from task t where t.organization_id = ${opportunity.organizationId}
  and t.opportunity_id = ${opportunity.id} and t.status = 'open' limit 1)`.mapWith((value: unknown) =>
  value ? new Date(value as string) : null,
)
const OPP_TASK_TITLE = sql<string | null>`(select t.title from task t where t.organization_id = ${opportunity.organizationId}
  and t.opportunity_id = ${opportunity.id} and t.status = 'open' limit 1)`

/** Oportunidad del contacto o nulo (nunca la de otro interlocutor). */
async function contactOpportunityOrNull(tx: Db, orgId: string, contactId: string, opportunityId: unknown) {
  if (!isUuid(opportunityId)) return null
  const detail = await nullIfNotFound(getOpportunity(tx, orgId, opportunityId))
  if (!detail || detail.contactId !== contactId) return null
  return detail
}

/**
 * Cambio previsto del acto a partir del payload (intención, sin leer estado
 * previo: sirve al crear y como fallback del legado). Nunca nulo.
 */
async function summarizeAfter(
  tx: Db,
  orgId: string,
  action: ProposalAction,
  payload: Record<string, unknown>,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): Promise<string> {
  const label = PROPOSAL_ACTION_LABEL[action]
  if (action === "enviar_mensaje") {
    const text = payload.kind === "text" || payload.text ? payloadText(payload.text) : null
    const name = typeof payload.name === "string" ? payload.name : null
    return text ?? (name ? `Plantilla ${name}` : label)
  }
  if (action === "mover_oportunidad") {
    const stages = await stageNamesById(tx, isUuid(payload.stageId) ? [payload.stageId] : [])
    const to = typeof payload.stageId === "string" ? stages.get(payload.stageId) : undefined
    return to ? `Etapa destino: ${to}` : label
  }
  if (action === "crear_oportunidad") {
    const title = payloadText(payload.title, 80)
    return title ? `Nueva oportunidad: ${title}` : label
  }
  if (action === "actualizar_seguimiento") {
    const line = [payloadText(payload.nextActionNote), payloadDate(payload.nextActionAt, zone)]
      .filter(Boolean)
      .join(" · ")
    return line ? `Nueva tarea: ${line}` : label
  }
  if (action === "cerrar_oportunidad") {
    const outcome = payload.outcome === "won" ? "Ganada" : payload.outcome === "lost" ? "Perdida" : null
    const reasonText = payloadText(payload.reason, 80)
    return outcome ? `${outcome}${reasonText ? `: ${reasonText}` : ""}` : label
  }
  if (action === "decidir_presupuesto") {
    // Lo que se le repitió a la persona, sin el trato: lo lee el equipo y el propio agente.
    const answer = await readBudgetAnswer(tx, orgId, payload)
    return answer ? budgetAnswerSummary(answer, zone) : label
  }
  // La cita se dice con su día y su hora, nunca con su identificador.
  const startsAt = payloadWhen(payload.startsAt, zone)
  return startsAt ? `Cita: ${startsAt}` : label
}

/**
 * Estado previo al acto leído en vivo. Solo se calcula al crear la
 * propuesta; jamás se reconstruye desde el estado actual para el legado.
 */
async function summarizeBefore(
  tx: Db,
  orgId: string,
  action: ProposalAction,
  payload: Record<string, unknown>,
  contactId: string,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): Promise<string | null> {
  if (action === "decidir_presupuesto") {
    const answer = await readBudgetAnswer(tx, orgId, payload)
    return answer ? `Presupuesto ${budgetNumberText(answer.budget.budgetNumber)}: ${answer.budget.stateText}` : null
  }
  if (action !== "mover_oportunidad" && action !== "actualizar_seguimiento" && action !== "cerrar_oportunidad") {
    return null
  }
  const opp = await contactOpportunityOrNull(tx, orgId, contactId, payload.opportunityId)
  if (!opp) return null
  if (action === "mover_oportunidad" || action === "cerrar_oportunidad") {
    const stages = await stageNamesById(tx, [opp.stageId])
    const name = stages.get(opp.stageId)
    if (!name) return null
    return action === "mover_oportunidad" ? `Etapa actual: ${name}` : `Abierta en etapa: ${name}`
  }
  const line = [payloadText(opp.nextTask?.title), payloadDate(opp.nextTask?.dueAt, zone)].filter(Boolean).join(" · ")
  return line ? `Tarea actual: ${line}` : null
}

/**
 * Estado vivo congelado al crear para el control de obsolescencia al
 * ejecutar. Solo los actos que pisan estado previo (mover/cerrar/seguimiento
 * de oportunidad, reprogramar/cancelar cita); el resto no congela nada.
 */
export type ExpectedProposalState = {
  opportunityId?: string
  stageId?: string | null
  status?: string | null
  nextActionAt?: string | null
  nextActionNote?: string | null
  appointmentId?: string
  appointmentVersion?: number | null
  appointmentStatus?: string | null
  /** La respuesta a un presupuesto: su estado y su última modificación al proponer. */
  budgetId?: string
  budgetStatus?: string | null
  budgetUpdatedAt?: string | null
}

function expectedOf(row: ProposalRow): ExpectedProposalState | null {
  const raw: unknown = row.expectedState
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const textKeys = ["opportunityId", "appointmentId", "budgetId"] as const
  const nullableTextKeys = ["stageId", "status", "nextActionAt", "nextActionNote", "appointmentStatus", "budgetStatus", "budgetUpdatedAt"] as const
  for (const key of Object.keys(candidate)) {
    if (
      !(textKeys as readonly string[]).includes(key) &&
      !(nullableTextKeys as readonly string[]).includes(key) &&
      key !== "appointmentVersion"
    ) {
      return null
    }
  }
  for (const key of textKeys) {
    const value = candidate[key]
    if (value !== undefined && typeof value !== "string") return null
  }
  for (const key of nullableTextKeys) {
    const value = candidate[key]
    if (value !== undefined && value !== null && typeof value !== "string") return null
  }
  const version = candidate.appointmentVersion
  if (version !== undefined && version !== null && typeof version !== "number") return null
  return candidate as ExpectedProposalState
}

/** Solo NOT_FOUND se absorbe al congelar; cualquier otro fallo de lectura propaga. */
async function nullIfNotFound<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch (error) {
    if (error instanceof ServiceError && error.code === "NOT_FOUND") return null
    throw error
  }
}

async function captureExpectedState(
  tx: Db,
  orgId: string,
  action: ProposalAction,
  payload: Record<string, unknown>,
  contactId: string | null,
): Promise<ExpectedProposalState | null> {
  if (
    (action === "mover_oportunidad" || action === "actualizar_seguimiento" || action === "cerrar_oportunidad") &&
    contactId
  ) {
    const opp = await nullIfNotFound(getOpportunity(tx, orgId, payload.opportunityId as string))
    if (!opp || opp.contactId !== contactId) return null
    // Sin 'Abierta' fija en la evidencia: el estado ya cerrado se rechaza al
    // crear en vez de congelar un antes falso.
    if (opp.status !== "open") throw validation(`La oportunidad ya está ${statusWords(opp.status)}`)
    return {
      opportunityId: opp.id,
      stageId: opp.stageId,
      status: opp.status,
      nextActionAt: opp.nextTask?.dueAt ?? null,
      nextActionNote: opp.nextTask?.title ?? null,
    }
  }
  if ((action === "reprogramar_cita" || action === "cancelar_cita") && typeof payload.appointmentId === "string") {
    const current = await nullIfNotFound(getAppointment(tx, orgId, payload.appointmentId as string))
    if (!current) return null
    return { appointmentId: current.id, appointmentVersion: current.version, appointmentStatus: current.status }
  }
  if (action === "decidir_presupuesto") {
    const live = await liveBudgetOf(tx, orgId, payload)
    if (!live) return null
    return { budgetId: live.id, budgetStatus: live.status, budgetUpdatedAt: live.updatedAt.toISOString() }
  }
  return null
}

/** Cabecera viva del presupuesto de una propuesta (estado y última modificación). */
async function liveBudgetOf(tx: Db, orgId: string, payload: Record<string, unknown>) {
  if (!isUuid(payload.budgetId) || !isUuid(payload.patientId)) return null
  const [row] = await tx
    .select({ id: treatmentBudget.id, number: treatmentBudget.budgetNumber, status: treatmentBudget.status, updatedAt: treatmentBudget.updatedAt })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.id, payload.budgetId),
        eq(treatmentBudget.patientId, payload.patientId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Error de obsolescencia: lo vivo cambió desde la evidencia congelada. */
function staleError(reason: string, currentSummary: string | null): ServiceError {
  return new ServiceError(
    "PROPOSAL_STALE",
    409,
    `La propuesta quedó obsoleta (${reason}); estado actual: ${currentSummary ?? "no disponible"}. Revisa antes de reintentarla`,
  )
}

interface LiveOppState {
  stageId: string
  status: string
  nextActionAt: string | null
  nextActionNote: string | null
}

interface LiveApptState {
  version: number
  status: string
  startsAt: Date
}

function oppCurrentSummary(
  action: ProposalAction,
  live: LiveOppState | null,
  stageName: string | null,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): string | null {
  if (!live) return "La oportunidad ya no está disponible"
  if (action === "actualizar_seguimiento") {
    const line = [payloadText(live.nextActionNote), payloadDate(live.nextActionAt, zone)].filter(Boolean).join(" · ")
    return line ? `Tarea actual: ${line}` : "Sin tarea"
  }
  const stage = stageName ?? "una etapa que ya no existe"
  return live.status === "open"
    ? `Etapa actual: ${stage}`
    : `${statusWords(live.status).charAt(0).toUpperCase()}${statusWords(live.status).slice(1)}: ${stage}`
}

function oppFreshness(
  action: ProposalAction,
  expected: ExpectedProposalState | null,
  live: LiveOppState | null,
  stageName: string | null,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): { isStale: boolean; currentSummary: string | null; reason: string } {
  const currentSummary = oppCurrentSummary(action, live, stageName, zone)
  if (!expected?.opportunityId) return { isStale: false, currentSummary, reason: "" }
  if (!live) return { isStale: true, currentSummary, reason: "la oportunidad ya no existe" }
  if (live.status !== "open")
    return {
      isStale: true,
      currentSummary,
      reason: `la oportunidad ya está ${statusWords(live.status)}`,
    }
  if (
    (action === "mover_oportunidad" || action === "cerrar_oportunidad") &&
    expected.stageId != null &&
    live.stageId !== expected.stageId
  ) {
    return { isStale: true, currentSummary, reason: "la etapa cambió desde la propuesta" }
  }
  if (
    action === "actualizar_seguimiento" &&
    (live.nextActionAt !== (expected.nextActionAt ?? null) || live.nextActionNote !== (expected.nextActionNote ?? null))
  ) {
    return { isStale: true, currentSummary, reason: "la tarea de la oportunidad cambió desde la propuesta" }
  }
  return { isStale: false, currentSummary, reason: "" }
}

function apptFreshness(
  expected: ExpectedProposalState | null,
  payloadExpectedVersion: number | null,
  live: LiveApptState | null,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): { isStale: boolean; currentSummary: string | null; reason: string } {
  if (!live) {
    return { isStale: true, currentSummary: "La cita ya no está disponible", reason: "la cita ya no existe" }
  }
  const currentSummary = apptSummary(live, zone)
  const version = expected?.appointmentVersion ?? payloadExpectedVersion
  if (version != null && live.version !== version) {
    return { isStale: true, currentSummary, reason: "la cita cambió desde la propuesta" }
  }
  if (live.status !== "programada" && live.status !== "confirmada") {
    return { isStale: true, currentSummary, reason: `la cita ya está ${statusWords(live.status)}` }
  }
  return { isStale: false, currentSummary, reason: "" }
}

/** La cita como está hoy: «Cita actual: lun 19 oct, 3:00 p. m.» y, si ya no está en pie, cómo quedó. */
function apptSummary(
  live: { startsAt: Date; status: string },
  zone: Pick<OrgLocale, "timezone" | "locale">,
): string {
  const when = payloadWhen(live.startsAt, zone) ?? live.startsAt.toISOString()
  return live.status === "programada" || live.status === "confirmada"
    ? `Cita actual: ${when}`
    : `Cita actual: ${when} · ${statusWords(live.status)}`
}

/**
 * La respuesta propuesta vale para el presupuesto tal como estaba al
 * proponerla: si alguien lo decidió, lo revisó o lo anuló después, ya no.
 */
function budgetFreshness(
  expected: ExpectedProposalState | null,
  live: { status: string; updatedAt: Date } | null,
  number: number | null,
): { isStale: boolean; currentSummary: string | null; reason: string } {
  if (!live)
    return {
      isStale: true,
      currentSummary: "El presupuesto ya no está disponible",
      reason: "el presupuesto ya no existe",
    }
  const currentSummary = `Presupuesto ${number === null ? "" : `${budgetNumberText(number)} `}· ${statusWords(live.status)}`
  if (!expected?.budgetId) return { isStale: false, currentSummary, reason: "" }
  if (live.status !== expected.budgetStatus || live.updatedAt.toISOString() !== expected.budgetUpdatedAt) {
    return { isStale: true, currentSummary, reason: "el presupuesto cambió desde la propuesta" }
  }
  return { isStale: false, currentSummary, reason: "" }
}


/**
 * Enriquece propuestas con el mismo contexto en todos los caminos
 * (listar, ver, crear, decidir, ejecutar, confirmar). Consultas por lote en
 * la misma tx: sin anidar contextos RLS y sin cortes mudos.
 */
async function enrichProposals(tx: Db, orgId: string, rows: ProposalRow[]): Promise<ProposalItem[]> {
  const zone = await getOrgLocale(tx, orgId)
  const contactIds = new Set<string>()
  const conversationIds = new Set<string>()
  const opportunityIds = new Set<string>()
  const patientIds = new Set<string>()
  const branchIds = new Set<string>()
  const userIds = new Set<string>()
  const appointmentIds = new Set<string>()
  const budgetIds = new Set<string>()
  for (const row of rows) {
    if (row.contactId) contactIds.add(row.contactId)
    if (row.conversationId) conversationIds.add(row.conversationId)
    const payload = row.payload as Record<string, unknown>
    const result = (row.result ?? {}) as Record<string, unknown>
    for (const key of ["opportunityId", "createdOpportunityId"] as const) {
      const id = payload[key] ?? result[key]
      if (isUuid(id)) opportunityIds.add(id)
    }
    const expected = expectedOf(row)
    if (expected?.opportunityId && isUuid(expected.opportunityId)) opportunityIds.add(expected.opportunityId)
    const apptId = payload.appointmentId ?? expected?.appointmentId
    if (isUuid(apptId)) appointmentIds.add(apptId)
    for (const key of ["patientId"] as const) {
      const id = payload[key] ?? result[key]
      if (isUuid(id)) patientIds.add(id)
    }
    if (isUuid(payload.branchId)) branchIds.add(payload.branchId)
    // Los ids de usuario no son UUID (los pone el proveedor de identidad).
    if (typeof payload.professionalUserId === "string" && payload.professionalUserId) userIds.add(payload.professionalUserId)
    if (row.action === "decidir_presupuesto" && isUuid(payload.budgetId)) budgetIds.add(payload.budgetId)
  }
  const [contacts, convs, opps, appts, patients, branches, users, budgets] = await Promise.all([
    contactIds.size
      ? tx.select({ id: contact.id, displayName: contact.displayName }).from(contact).where(inArray(contact.id, [...contactIds]))
      : [],
    conversationIds.size
      ? tx
          .select({ id: conversation.id, connectionId: conversation.channelConnectionId })
          .from(conversation)
          .where(inArray(conversation.id, [...conversationIds]))
      : [],
    opportunityIds.size
      ? tx
          .select({
            id: opportunity.id,
            title: opportunity.title,
            patientId: opportunity.patientId,
            stageId: opportunity.stageId,
            status: opportunity.status,
            nextActionAt: OPP_TASK_DUE,
            nextActionNote: OPP_TASK_TITLE,
          })
          .from(opportunity)
          .where(inArray(opportunity.id, [...opportunityIds]))
      : [],
    appointmentIds.size
      ? tx
          .select({ id: appointment.id, version: appointment.version, status: appointment.status, startsAt: appointment.startsAt })
          .from(appointment)
          .where(inArray(appointment.id, [...appointmentIds]))
      : [],
    patientIds.size
      ? tx.select({ id: patient.id, displayName: patientPerson.displayName }).from(patient).innerJoin(patientPerson, joinPatientPerson(patientPerson)).where(inArray(patient.id, [...patientIds]))
      : [],
    branchIds.size
      ? tx.select({ id: branch.id, name: branch.name }).from(branch).where(inArray(branch.id, [...branchIds]))
      : [],
    userIds.size
      ? tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...userIds]))
      : [],
    budgetIds.size
      ? tx
          .select({ id: treatmentBudget.id, number: treatmentBudget.budgetNumber, status: treatmentBudget.status, updatedAt: treatmentBudget.updatedAt })
          .from(treatmentBudget)
          .where(and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.id, [...budgetIds])))
      : [],
  ])
  const budgetById = new Map(budgets.map((b) => [b.id, b]))
  const contactById = new Map(contacts.map((c) => [c.id, c.displayName]))
  const connectionByConv = new Map(convs.map((c) => [c.id, c.connectionId]))
  const oppById = new Map(opps.map((o) => [o.id, o]))
  const apptById = new Map(appts.map((a) => [a.id, a]))
  const patientById = new Map(patients.map((p) => [p.id, p.displayName]))
  const branchById = new Map(branches.map((b) => [b.id, b.name]))
  const userById = new Map(users.map((u) => [u.id, u.name]))
  const liveStageIds = [...new Set(opps.map((o) => o.stageId).filter((v): v is string => typeof v === "string" && !!v))]
  const liveStageNames = await stageNamesById(tx, liveStageIds)
  let channelByConnection = new Map<string, string>()
  if (connectionByConv.size) {
    const connIds = [...new Set(connectionByConv.values())].filter(Boolean) as string[]
    if (connIds.length) {
      const conns = await tx
        .select({ id: channelConnection.id, channel: channelConnection.channel })
        .from(channelConnection)
        .where(inArray(channelConnection.id, connIds))
      channelByConnection = new Map(conns.map((c) => [c.id, c.channel]))
    }
  }
  // Legado sin snapshot: el antes NO se reconstruye (null); el después deriva
  // la intención del payload con etiqueta del acto como fallback (nunca null).
  const legacyAfter = new Map<string, string>()
  await Promise.all(
    rows
      .filter((row) => !row.afterSummary)
      .map(async (row) => {
        legacyAfter.set(
          row.id,
          await summarizeAfter(tx, orgId, row.action as ProposalAction, row.payload as Record<string, unknown>, zone),
        )
      }),
  )
  return rows.map((row) => {
    const action = row.action as ProposalAction
    const payload = row.payload as Record<string, unknown>
    const result = (row.result ?? {}) as Record<string, unknown>
    const oppId = [payload.opportunityId, result.opportunityId, result.createdOpportunityId].find(
      (v): v is string => typeof v === "string" && !!v,
    )
    const opp = oppId ? oppById.get(oppId) : undefined
    const patientId = [payload.patientId, result.patientId, opp?.patientId].find(
      (v): v is string => typeof v === "string" && !!v,
    )
    const connectionId = connectionByConv.get(row.conversationId)
    const expected = expectedOf(row)
    let isStale = false
    let currentSummary: string | null = null
    const touchesState =
      action === "mover_oportunidad" ||
      action === "actualizar_seguimiento" ||
      action === "cerrar_oportunidad" ||
      action === "reprogramar_cita" ||
      action === "cancelar_cita" ||
      action === "decidir_presupuesto"
    if (action === "mover_oportunidad" || action === "actualizar_seguimiento" || action === "cerrar_oportunidad") {
      const live = opp
        ? {
            stageId: opp.stageId,
            status: opp.status,
            nextActionAt: opp.nextActionAt?.toISOString() ?? null,
            nextActionNote: opp.nextActionNote,
          }
        : null
      const fresh = oppFreshness(action, expected, live, live ? (liveStageNames.get(live.stageId) ?? null) : null, zone)
      isStale = fresh.isStale
      currentSummary = fresh.currentSummary
    } else if (action === "reprogramar_cita" || action === "cancelar_cita") {
      const apptId = payload.appointmentId ?? expected?.appointmentId
      const live = typeof apptId === "string" ? apptById.get(apptId) : undefined
      const payloadVersion = typeof payload.expectedVersion === "number" ? (payload.expectedVersion as number) : null
      const fresh = apptFreshness(expected, payloadVersion, live ?? null, zone)
      isStale = fresh.isStale
      currentSummary = fresh.currentSummary
    } else if (action === "decidir_presupuesto") {
      const live = typeof payload.budgetId === "string" ? budgetById.get(payload.budgetId) : undefined
      const fresh = budgetFreshness(expected, live ? { status: live.status, updatedAt: live.updatedAt } : null, live?.number ?? null)
      isStale = fresh.isStale
      currentSummary = fresh.currentSummary
    }
    // Sin evidencia congelada una pendiente/aprobada que pisa estado no es
    // ejecutable: se marca para que nadie la apruebe a ciegas (el historial
    // ya ejecutado no se alarma).
    if (
      touchesState &&
      (row.status === "propuesta" || row.status === "aprobada") &&
      !expected?.opportunityId &&
      !expected?.appointmentId &&
      !expected?.budgetId
    ) {
      isStale = true
    }
    return baseProposal(row, autonomyModeOf(action), {
      contactName: row.contactId ? (contactById.get(row.contactId) ?? null) : null,
      patientName: patientId ? (patientById.get(patientId) ?? null) : null,
      channel: connectionId ? (channelByConnection.get(connectionId) ?? null) : null,
      branchName:
        typeof payload.branchId === "string" ? (branchById.get(payload.branchId as string) ?? null) : null,
      professionalName:
        typeof result.professionalName === "string"
          ? (result.professionalName as string)
          : typeof payload.professionalUserId === "string"
            ? (userById.get(payload.professionalUserId as string) ?? null)
            : null,
      opportunityTitle: opp?.title ?? null,
      beforeSummary: row.beforeSummary ?? null,
      afterSummary: row.afterSummary ?? legacyAfter.get(row.id) ?? PROPOSAL_ACTION_LABEL[action],
      isStale,
      currentSummary,
    })
  })
}

async function enrichProposal(tx: Db, orgId: string, row: ProposalRow): Promise<ProposalItem> {
  const [item] = await enrichProposals(tx, orgId, [row])
  if (!item) throw new Error("No se pudo enriquecer la propuesta")
  return item
}

function requireConversationInOrg(tx: Db, orgId: string, conversationId: string) {
  return tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, conversationId)))
    .limit(1)
    .then((rows) => {
      if (!rows[0]) throw notFound("Conversación")
      return rows[0]
    })
}

function uuidField(payload: Record<string, unknown>, key: string, label: string, optional = false): void {
  const value = payload[key]
  if (value === undefined && optional) return
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw validation(`${label} inválido`)
}

function validatePayload(action: ProposalAction, payload: Record<string, unknown>): void {
  if (action === "reservar_cita") {
    if (typeof payload.patientId !== "string" || !payload.patientId) throw validation("patientId es obligatorio")
    if (typeof payload.professionalUserId !== "string" || !payload.professionalUserId) throw validation("professionalUserId es obligatorio")
    if (typeof payload.roomId !== "string" || !payload.roomId) throw validation("roomId es obligatorio")
    if (typeof payload.startsAt !== "string" || Number.isNaN(Date.parse(payload.startsAt))) throw validation("startsAt inválido")
    return
  }
  if (action === "reprogramar_cita" || action === "cancelar_cita") {
    if (typeof payload.appointmentId !== "string" || !payload.appointmentId) throw validation("appointmentId es obligatorio")
    if (action === "reprogramar_cita") {
      if (typeof payload.startsAt !== "string" || Number.isNaN(Date.parse(payload.startsAt))) throw validation("startsAt inválido")
      if (typeof payload.expectedVersion !== "number") throw validation("expectedVersion es obligatorio")
    }
    return
  }
  if (action === "enviar_mensaje") {
    // Secretos del proveedor NUNCA en el payload: solo texto o plantilla validada.
    if (payload.secretsKey !== undefined || payload.accessToken !== undefined || payload.botToken !== undefined) {
      throw validation("El payload no debe incluir secretos del proveedor")
    }
    const kind = payload.kind
    if (kind === "text" || (kind === undefined && typeof payload.text === "string")) {
      if (typeof payload.text !== "string" || !payload.text.trim() || payload.text.length > 4000) {
        throw validation("text debe tener 1–4000 caracteres")
      }
      if (payload.buttons !== undefined && !replyButtonsOf(payload.buttons)) {
        throw validation("buttons debe tener de 1 a 3 botones con id y título breve")
      }
      return
    }
    if (kind === "template") {
      if (typeof payload.name !== "string" || !payload.name.trim() || payload.name.length > 120) {
        throw validation("name de plantilla inválido")
      }
      if (typeof payload.language !== "string" || !payload.language.trim() || payload.language.length > 20) {
        throw validation("language de plantilla inválido")
      }
      if (payload.params !== undefined) {
        if (!Array.isArray(payload.params) || payload.params.some((p) => typeof p !== "string" || p.length > 500)) {
          throw validation("params de plantilla inválidos")
        }
      }
      return
    }
    throw validation("kind debe ser text o template")
  }
  if (action === "mover_oportunidad") {
    uuidField(payload, "opportunityId", "opportunityId")
    uuidField(payload, "stageId", "stageId")
    return
  }
  if (action === "crear_oportunidad") {
    if (typeof payload.title !== "string" || !payload.title.trim() || payload.title.length > 200) {
      throw validation("title debe tener 1–200 caracteres")
    }
    uuidField(payload, "patientId", "patientId", true)
    if (payload.interestText !== undefined && (typeof payload.interestText !== "string" || payload.interestText.length > 500)) {
      throw validation("interestText supera 500 caracteres")
    }
    if (payload.amountCents !== undefined && (typeof payload.amountCents !== "number" || payload.amountCents < 0)) {
      throw validation("amountCents inválido")
    }
    if (payload.nextActionAt !== undefined && payload.nextActionAt !== null) {
      if (typeof payload.nextActionAt !== "string" || Number.isNaN(Date.parse(payload.nextActionAt))) {
        throw validation("nextActionAt inválido")
      }
    }
    if (payload.nextActionNote !== undefined && payload.nextActionNote !== null) {
      if (typeof payload.nextActionNote !== "string" || payload.nextActionNote.length > 500) {
        throw validation("nextActionNote supera 500 caracteres")
      }
    }
    return
  }
  if (action === "actualizar_seguimiento") {
    uuidField(payload, "opportunityId", "opportunityId")
    if (payload.nextActionAt === undefined && payload.nextActionNote === undefined) {
      throw validation("Indica nextActionAt o nextActionNote para el seguimiento")
    }
    if (payload.nextActionAt !== undefined && payload.nextActionAt !== null) {
      if (typeof payload.nextActionAt !== "string" || Number.isNaN(Date.parse(payload.nextActionAt))) {
        throw validation("nextActionAt inválido")
      }
    }
    if (payload.nextActionNote !== undefined && payload.nextActionNote !== null) {
      if (typeof payload.nextActionNote !== "string" || payload.nextActionNote.length > 500) {
        throw validation("nextActionNote supera 500 caracteres")
      }
    }
    return
  }
  if (action === "decidir_presupuesto") {
    uuidField(payload, "patientId", "patientId")
    uuidField(payload, "budgetId", "budgetId")
    uuidField(payload, "optionId", "optionId", true)
    const decisions = payload.decisions
    if (
      !Array.isArray(decisions) ||
      decisions.length < 1 ||
      decisions.length > 200 ||
      decisions.some(
        (item) =>
          typeof item !== "object" ||
          item === null ||
          !isUuid((item as Record<string, unknown>).planItemId) ||
          !(BUDGET_ANSWER_DECISIONS as readonly unknown[]).includes((item as Record<string, unknown>).decision),
      )
    ) {
      throw validation("decisions debe traer una respuesta válida por tratamiento")
    }
    return
  }
  uuidField(payload, "opportunityId", "opportunityId")
  if (payload.outcome !== "won" && payload.outcome !== "lost") throw validation("outcome debe ser won|lost")
  if (typeof payload.reason !== "string" || !payload.reason.trim() || payload.reason.length > 500) {
    throw validation("Elige el motivo del cierre de la lista")
  }
  if (payload.note !== undefined && payload.note !== null && (typeof payload.note !== "string" || payload.note.length > 500)) {
    throw validation("La nota del cierre supera 500 caracteres")
  }
}

/**
 * Crea una propuesta idempotente por clave, siempre en una conversación. Si el
 * acto es `directo`, se ejecuta en el mismo acto; si lo confirma el
 * interlocutor (citas), queda en `propuesta` hasta su sí. Ninguna espera al
 * equipo (ADR 0023).
 * Congela la evidencia (before/after) y el estado vivo esperado tras validar
 * el payload: ningún camino posterior los reescribe. Solo una propuesta
 * comercial pendiente por conversación; los mensajes (`enviar_mensaje`)
 * fluyen siempre por su propio camino y confirmación inequívoca (sin
 * bypass): una cita pendiente nunca silencia al agente. La caducidad se
 * consolida antes de bloquear y las propuestas viejas no frenan el hilo.
 * El replay nunca consulta tras unique violation (la tx queda abortada):
 * pre-chequeo antes de insertar y 409 reintentable en carrera.
 */
export async function createProposal(
  tx: Db,
  orgId: string,
  input: {
    conversationId: string
    action: string
    payload: Record<string, unknown>
    reason?: unknown
    idempotencyKey: string
    proposedBy?: string
    actorUserId?: string | null
    /** Clave de secretos para ejecutar plantillas en modo directo. */
    secretsKey?: Buffer
  },
): Promise<ProposalItem> {
  assertAction(input.action)
  const key = input.idempotencyKey.trim()
  if (!key || key.length > 120) throw validation("idempotencyKey es obligatoria (máx 120)")
  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
    throw validation("payload debe ser un objeto")
  }
  validatePayload(input.action, input.payload)
  const reason = cleanReason(input.reason)
  const proposedBy = input.proposedBy === "user" ? "user" : "agent"
  let finalKey = key
  if (!input.conversationId) throw validation("conversationId es obligatorio")
  const [conv] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .for("update")
    .limit(1)
  if (!conv) throw notFound("Conversación")
  // Caducidad perezosa antes de bloquear: las propuestas viejas no frenan el hilo.
  await expireDueProposals(tx, orgId, conv.id)
  const [sameKey] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.idempotencyKey, key)))
    .limit(1)
  if (sameKey) {
    if (sameKey.status !== "fallida" && sameKey.status !== "expirada") {
      return enrichProposal(tx, orgId, sameKey)
    }
    finalKey = `${key.slice(0, 100)}:r${Date.now().toString(36)}`
  }
  const mode = autonomyModeOf(input.action)
  if (!sameKey) {
    // Lo único que queda pendiente es lo que confirma el interlocutor (las
    // citas): mientras espera su «sí», ningún otro acto que no sea un mensaje
    // entra en el hilo, porque un mismo «sí» no puede autorizar dos cosas. Los
    // mensajes coexisten siempre.
    const pending = await tx
      .select({ id: agentProposal.id, action: agentProposal.action })
      .from(agentProposal)
      .where(
        and(
          eq(agentProposal.organizationId, orgId),
          eq(agentProposal.conversationId, conv.id),
          eq(agentProposal.status, "propuesta"),
          gt(agentProposal.createdAt, new Date(Date.now() - CONFIRM_TTL_MS)),
        ),
      )
    // La persona corrige la lista de su respuesta («no, la 36 también»): la
    // nueva reemplaza a la anterior, que nunca recibió su sí. Sigue habiendo
    // una sola esperando confirmación.
    const replaces =
      input.action === "decidir_presupuesto" && pending.length > 0 && pending.every((row) => row.action === "decidir_presupuesto")
    if (replaces) {
      for (const row of pending) {
        await tx
          .update(agentProposal)
          .set({ status: "expirada", updatedAt: new Date() })
          .where(and(eq(agentProposal.id, row.id), eq(agentProposal.status, "propuesta")))
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          actorUserId: input.actorUserId ?? null,
          action: "agent.proposal_expired",
          entity: "agent_proposal",
          entityId: row.id,
          metadata: { replaced: true },
        })
      }
    } else if (pending.length > 0 && input.action !== "enviar_mensaje") {
      throw new ServiceError(
        "PROPOSAL_PENDING_CONFIRM",
        409,
        "Hay una propuesta esperando la confirmación del interlocutor en este hilo; resuélvela primero",
      )
    }
  }
  // Evidencia de lo aprobado: se congela al crear (tras validar el payload)
  // y ningún camino posterior la reescribe. El estado vivo esperado sirve al
  // control de obsolescencia al ejecutar (no pisa decisiones humanas).
  const zone = await getOrgLocale(tx, orgId)
  const beforeSnapshot = conv.contactId
    ? await summarizeBefore(tx, orgId, input.action, input.payload, conv.contactId, zone)
    : null
  const afterSnapshot = await summarizeAfter(tx, orgId, input.action, input.payload, zone)
  const expectedSnapshot = conv.contactId
    ? await captureExpectedState(tx, orgId, input.action, input.payload, conv.contactId)
    : null
  const direct = mode === "directo"
  try {
    const [row] = await tx
      .insert(agentProposal)
      .values({
        organizationId: orgId,
        conversationId: conv.id,
        contactId: conv.contactId,
        patientId: await proposalPatientId(tx, orgId, input.payload),
        action: input.action,
        payload: input.payload,
        reason,
        beforeSummary: beforeSnapshot,
        afterSummary: afterSnapshot,
        expectedState: expectedSnapshot ?? undefined,
        idempotencyKey: finalKey,
        proposedBy,
        status: direct ? "aprobada" : "propuesta",
        decidedBy: direct ? input.actorUserId ?? "agent" : null,
        decidedAt: direct ? new Date() : null,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear la propuesta")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: input.actorUserId ?? null,
      action: "agent.proposal_created",
      entity: "agent_proposal",
      entityId: row.id,
      metadata: { action: input.action, conversationId: conv.id, reason },
    })
    await notify(tx, { orgId, kind: "agent.proposal.created", at: new Date().toISOString() })
    if (direct) {
      return executeProposal(tx, orgId, input.actorUserId ?? "agent", row.id, { secretsKey: input.secretsKey })
    }
    return enrichProposal(tx, orgId, row)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError("PROPOSAL_CONFLICT", 409, "Propuesta duplicada; reintenta")
    }
    throw error
  }
}

async function requireProposal(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.id, id)))
    .limit(1)
  if (!row) throw notFound("Propuesta")
  return row
}

/**
 * Paciente sobre el que actúa la propuesta: el del payload o el de la cita que
 * se reprograma o cancela. Nulo en actos comerciales sin ficha.
 */
async function proposalPatientId(
  tx: Db,
  orgId: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const uuid = (value: unknown): string | null =>
    typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null
  const direct = uuid(payload.patientId)
  if (direct) {
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.organizationId, orgId), eq(patient.id, direct)))
      .limit(1)
    return row?.id ?? null
  }
  const appointmentId = uuid(payload.appointmentId)
  if (!appointmentId) return null
  const [row] = await tx
    .select({ patientId: appointment.patientId })
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  return row?.patientId ?? null
}

export async function getProposal(tx: Db, orgId: string, id: string): Promise<ProposalItem> {
  await expireProposalById(tx, orgId, id)
  return enrichProposal(tx, orgId, await requireProposal(tx, orgId, id))
}

export async function listProposals(
  tx: Db,
  orgId: string,
  input: {
    status?: string
    conversationId?: string
    contactId?: string
    /** Propuestas que actúan sobre este paciente (ficha). */
    patientId?: string
    limit?: number
  } = {},
): Promise<ProposalItem[]> {
  // La lista consolida la caducidad (esta tx normalmente confirma): el home
  // y la bandeja muestran `expirada` sin jobs.
  await expireDueProposals(tx, orgId, input.conversationId)
  const conditions = [eq(agentProposal.organizationId, orgId)]
  if (input.status) {
    if (!(PROPOSAL_STATUSES as readonly string[]).includes(input.status)) {
      throw validation("status inválido")
    }
    conditions.push(eq(agentProposal.status, input.status))
  }
  if (input.conversationId) conditions.push(eq(agentProposal.conversationId, input.conversationId))
  if (input.contactId) conditions.push(eq(agentProposal.contactId, input.contactId))
  if (input.patientId) {
    if (!/^[0-9a-f-]{36}$/i.test(input.patientId)) throw validation("patientId inválido")
    conditions.push(eq(agentProposal.patientId, input.patientId))
  }
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const rows = await tx
    .select()
    .from(agentProposal)
    .where(and(...conditions))
    .orderBy(desc(agentProposal.createdAt), asc(agentProposal.id))
    .limit(limit)
  return enrichProposals(tx, orgId, rows)
}

/**
 * Caducidad observada al decidir/confirmar: si la propuesta venció, la marca
 * `expirada` (audita la transición) y devuelve el estado real con HTTP 200
 * para que la UI lo muestre sin reintentar. Nunca update+throw en la misma
 * tx: el rollback anularía la marca. Nulo si sigue vigente o ya se movió.
 */
async function takeExpiredProposal(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
): Promise<ProposalItem | null> {
  const [expired] = await tx
    .update(agentProposal)
    .set({ status: "expirada", updatedAt: new Date() })
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        eq(agentProposal.id, id),
        eq(agentProposal.status, "propuesta"),
        lt(agentProposal.createdAt, new Date(Date.now() - CONFIRM_TTL_MS)),
      ),
    )
    .returning()
  if (!expired) {
    const current = await requireProposal(tx, orgId, id)
    if (current.status !== "expirada") return null
    return enrichProposal(tx, orgId, current)
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.proposal_expired",
    entity: "agent_proposal",
    entityId: id,
    metadata: {},
  })
  return enrichProposal(tx, orgId, expired)
}

async function pendingConflict(tx: Db, orgId: string, id: string): Promise<ServiceError> {
  const fresh = await requireProposal(tx, orgId, id)
  return new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${fresh.status}`)
}

/**
 * Confirmación del interlocutor en el chat (solo actos `confirmar_usuario`
 * con hilo). Evidencia estricta y ligada a la propuesta: un mensaje entrante
 * posterior a ESTA propuesta cuyo texto completo sea una afirmación (sin
 * negaciones ni preguntas). El mensaje que confirma queda en la auditoría.
 * Los actos directos no aceptan confirmación del contacto.
 * Vencida a las 48h: se devuelve `expirada` (HTTP 200, sin
 * reintento), nunca update+throw. El staff que confirma desde consola queda
 * auditado. Devuelve `ejecutada`, `fallida` o `expirada` (HTTP 200: la UI
 * distingue por `status`).
 */
const AFFIRMATIVE_PHRASES = new Set([
  "si",
  "confirmo",
  "confirmado",
  "de acuerdo",
  "vale",
  "ok",
  "adelante",
  "dale",
  "acepto",
  "quiero",
  "si quiero",
  "si confirmo",
  // La respuesta natural a «¿Es correcto?» al repetirle una lista.
  "correcto",
  "es correcto",
  "si correcto",
  "si es correcto",
  "asi es",
  "si asi es",
  "exacto",
  "si exacto",
  "esta bien",
  "si esta bien",
])

export function isAffirmative(text: string | null): boolean {
  if (!text || text.includes("?")) return false
  const normal = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¡!¿?.,;:()"'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!normal || normal.length > 40) return false
  if (/(^| )no( |$)/.test(normal)) return false
  return AFFIRMATIVE_PHRASES.has(normal)
}

export async function confirmProposalByContact(
  tx: Db,
  orgId: string,
  contactId: string,
  id: string,
  opts: { staffUserId?: string | null; secretsKey?: Buffer } = {},
): Promise<ProposalItem> {
  const current = await requireProposal(tx, orgId, id)
  if (current.contactId !== contactId) throw notFound("Propuesta")
  const expired = await takeExpiredProposal(tx, orgId, opts.staffUserId ?? null, id)
  if (expired) return expired
  if (current.status !== "propuesta") {
    throw new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${current.status}`)
  }
  // Solo las citas esperan el sí del interlocutor; lo demás va directo.
  if (autonomyModeOf(current.action as ProposalAction) !== "confirmar_usuario") {
    throw new ServiceError(
      "PROPOSAL_NOT_CONTACT_CONFIRMABLE",
      409,
      "Esta propuesta es de ejecución directa; no se confirma con el sí del interlocutor",
    )
  }
  const { items } = await listMessages(tx, orgId, current.conversationId, { limit: 10 })
  const confirmation = items.find(
    (m) =>
      m.direction === "in" &&
      new Date(m.createdAt).getTime() >= current.createdAt.getTime() &&
      isAffirmative(m.body),
  )
  if (!confirmation) {
    throw new ServiceError(
      "PROPOSAL_NOT_CONFIRMED",
      409,
      "No hay confirmación explícita del paciente tras la propuesta",
    )
  }
  const confirmationId = confirmation.id
  const decidedBy = opts.staffUserId ? `staff:${opts.staffUserId}` : `contact:${contactId}`
  const [row] = await tx
    .update(agentProposal)
    .set({ status: "aprobada", decidedBy, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentProposal.id, id), eq(agentProposal.status, "propuesta")))
    .returning()
  if (!row) throw await pendingConflict(tx, orgId, id)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: opts.staffUserId ?? null,
    action: "agent.proposal_confirmed",
    entity: "agent_proposal",
    entityId: id,
    metadata: { via: opts.staffUserId ? "staff" : "contact", messageId: confirmationId },
  })
  return executeProposal(tx, orgId, decidedBy, id, { secretsKey: opts.secretsKey })
}

/* ------------------------------ «Esperan su sí» ------------------------------ */

/** Las propuestas que esperan el sí de la persona: las citas. */
export const APPOINTMENT_PROPOSAL_ACTIONS = ["reservar_cita", "reprogramar_cita", "cancelar_cita"] as const
type AppointmentProposalAction = (typeof APPOINTMENT_PROPOSAL_ACTIONS)[number]

/** Lo que dice recepción cuando el horario propuesto ya no está libre. */
export const SLOT_TAKEN_WORDS = "Ese horario ya no está libre: elige otro en la Agenda"

export interface AwaitingAnswerItem {
  id: string
  conversationId: string
  contactId: string | null
  contactName: string | null
  channel: string | null
  action: AppointmentProposalAction
  /** «Le propuse el jueves 22 a las 16:30 con la Dra. Rojas». */
  text: string
  createdAt: string
  /** El horario propuesto se ocupó (o la cita cambió) mientras esperaba. */
  taken: boolean
}

export interface AwaitingAnswerList {
  items: AwaitingAnswerItem[]
  /** Todas las abiertas, también las que no caben en la lista. */
  total: number
}

/** «jueves 22 a las 16:30», en la zona de la clínica. */
function dayAndHour(value: unknown, zone: Pick<OrgLocale, "timezone" | "locale">): string | null {
  if (typeof value !== "string") return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const day = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, weekday: "long", day: "numeric" })
    .format(date)
    .replace(",", "")
  const hour = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)
  return `${day} a las ${hour}`
}

/**
 * ¿Sigue libre el horario de una cita propuesta? La misma regla que al
 * reservar (`validateAvailability`, la que aplica `createAppointment`): solo
 * lee, no reserva nada.
 */
async function proposedSlotFree(tx: Db, orgId: string, payload: Record<string, unknown>): Promise<boolean> {
  if (typeof payload.startsAt !== "string" || typeof payload.professionalUserId !== "string" || typeof payload.roomId !== "string") {
    return false
  }
  const startsAt = new Date(payload.startsAt)
  if (Number.isNaN(startsAt.getTime())) return false
  const minutes = typeof payload.durationMin === "number" ? payload.durationMin : 30
  const endsAt = typeof payload.endsAt === "string" ? new Date(payload.endsAt) : new Date(startsAt.getTime() + minutes * 60_000)
  let branchId = typeof payload.branchId === "string" ? payload.branchId : null
  if (!branchId) {
    const [room] = await tx
      .select({ branchId: scheduleRoom.branchId })
      .from(scheduleRoom)
      .where(and(eq(scheduleRoom.organizationId, orgId), eq(scheduleRoom.id, payload.roomId)))
      .limit(1)
    branchId = room?.branchId ?? null
  }
  if (!branchId) return false
  try {
    await validateAvailability(tx, orgId, {
      branchId,
      professionalUserId: payload.professionalUserId,
      roomId: payload.roomId,
      startsAt,
      endsAt,
    })
    return true
  } catch (error) {
    if (error instanceof ServiceError) return false
    throw error
  }
}

/**
 * Agente › «Esperan su sí» (decisión 21, tablero 2c): solo las citas que el
 * agente propuso y esperan respuesta de la persona. Para saber, no para hacer:
 * lo ya hecho se ve en la conversación y en la cita. Cada fila dice lo que se
 * le propuso y si ese horario se ocupó mientras esperaba.
 */
export async function listAwaitingAnswer(
  tx: Db,
  orgId: string,
  input: { limit?: number } = {},
): Promise<AwaitingAnswerList> {
  await expireDueProposals(tx, orgId)
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200)
  const open = and(
    eq(agentProposal.organizationId, orgId),
    inArray(agentProposal.action, [...APPOINTMENT_PROPOSAL_ACTIONS]),
    proposalPendingSql(sql.raw('"agent_proposal"')),
  )
  const [counted] = await tx.select({ total: count() }).from(agentProposal).where(open)
  // Las más viejas primero: llevan más tiempo esperando.
  const rows = await tx.select().from(agentProposal).where(open).orderBy(asc(agentProposal.createdAt), asc(agentProposal.id)).limit(limit)
  const zone = await getOrgLocale(tx, orgId)
  const enriched = await enrichProposals(tx, orgId, rows)
  const items: AwaitingAnswerItem[] = []
  for (const proposal of enriched) {
    const action = proposal.action as AppointmentProposalAction
    const when = dayAndHour(proposal.payload.startsAt, zone)
    const professional = proposal.context.professionalName
    let text: string
    let taken: boolean
    if (action === "reservar_cita") {
      text = `Le propuse el ${when ?? "horario que eligió"}${professional ? ` con ${professional}` : ""}`
      taken = !(await proposedSlotFree(tx, orgId, proposal.payload))
    } else if (action === "reprogramar_cita") {
      text = `Le propuse mover su cita al ${when ?? "nuevo horario"}`
      taken = proposal.context.isStale === true
    } else {
      text = `Le propuse cancelar su cita${proposal.context.currentSummary ? ` (${proposal.context.currentSummary.replace(/^Cita actual: /, "")})` : ""}`
      taken = proposal.context.isStale === true
    }
    items.push({
      id: proposal.id,
      conversationId: proposal.conversationId,
      contactId: proposal.contactId,
      contactName: proposal.context.contactName,
      channel: proposal.context.channel,
      action,
      text,
      createdAt: proposal.createdAt,
      taken,
    })
  }
  return { items, total: Number(counted?.total ?? 0) }
}

/** Cuántas citas esperan el sí de la persona: el número junto a la pestaña «Esperan su sí». */
export async function countAwaitingAnswer(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from agent_proposal p
    where p.organization_id = ${orgId}
      and p.action in (${sql.join(APPOINTMENT_PROPOSAL_ACTIONS.map((action) => sql`${action}`), sql`, `)})
      and ${proposalPendingSql(sql.raw("p"))}`)
  return row?.n ?? 0
}

/**
 * «Confirmó por teléfono»: la persona dijo que sí por otra vía y recepción lo
 * anota con un clic. La cita se reserva, se mueve o se cancela con la misma
 * operación que cuando confirma en el chat (`executeProposal`, la del agente).
 * Si el horario ya no está libre, no se hace nada y se dice: «Ese horario ya
 * no está libre: elige otro en la Agenda». Quién lo anotó queda auditado.
 */
export async function confirmProposalByPhone(
  tx: Db,
  orgId: string,
  staffUserId: string,
  id: string,
  opts: { secretsKey?: Buffer } = {},
): Promise<ProposalItem> {
  const current = await requireProposal(tx, orgId, id)
  const expired = await takeExpiredProposal(tx, orgId, staffUserId, id)
  if (expired) return expired
  if (current.status !== "propuesta") {
    throw new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${current.status}`)
  }
  if (!(APPOINTMENT_PROPOSAL_ACTIONS as readonly string[]).includes(current.action)) {
    throw new ServiceError("PROPOSAL_NOT_APPOINTMENT", 409, "Solo una cita propuesta se confirma por teléfono")
  }
  if (current.action === "reservar_cita" && !(await proposedSlotFree(tx, orgId, current.payload))) {
    throw new ServiceError("SLOT_TAKEN", 409, SLOT_TAKEN_WORDS)
  }
  const decidedBy = `staff:${staffUserId}`
  const [row] = await tx
    .update(agentProposal)
    .set({ status: "aprobada", decidedBy, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentProposal.id, id), eq(agentProposal.organizationId, orgId), eq(agentProposal.status, "propuesta")))
    .returning()
  if (!row) throw await pendingConflict(tx, orgId, id)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: staffUserId,
    action: "agent.proposal_confirmed",
    entity: "agent_proposal",
    entityId: id,
    metadata: { via: "telefono" },
  })
  const executed = await executeProposal(tx, orgId, decidedBy, id, { secretsKey: opts.secretsKey })
  // Se ocupó entre la comprobación y la reserva: nada queda hecho y la fila sigue esperando.
  if (executed.status === "fallida" && current.action === "reservar_cita") {
    throw new ServiceError("SLOT_TAKEN", 409, SLOT_TAKEN_WORDS)
  }
  return executed
}

/**
 * Oportunidad del interlocutor bloqueada para ejecutar: la herramienta
 * comercial opera sobre el contacto de ctx/conversación y nunca sobre la
 * oportunidad de otro interlocutor. El bloqueo (`FOR UPDATE`) sostiene la
 * revalidación de obsolescencia hasta aplicar el cambio en la misma tx.
 */
async function lockContactOpportunity(tx: Db, orgId: string, contactId: string, opportunityId: string) {
  const [live] = await tx
    .select()
    .from(opportunity)
    .where(and(eq(opportunity.organizationId, orgId), eq(opportunity.id, opportunityId)))
    .for("update")
    .limit(1)
  if (!live) throw validation("La oportunidad ya no existe")
  if (live.contactId !== contactId) throw validation("La oportunidad no pertenece a este interlocutor")
  // Su próxima acción es su tarea abierta (una sola).
  const [task] = await tx
    .select({ dueAt: crmTask.dueAt, title: crmTask.title })
    .from(crmTask)
    .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, opportunityId), eq(crmTask.status, "open")))
    .limit(1)
  return { ...live, nextActionAt: task?.dueAt ?? null, nextActionNote: task?.title ?? null }
}

/**
 * Ejecuta una propuesta aprobada. Idempotente: bloquea la fila y si ya está
 * `ejecutada` devuelve el resultado guardado sin volver a actuar (nunca
 * reenvía un mensaje al reaprobar o reintentar). Revalida vínculos, autoridad
 * y obsolescencia bajo lock: una propuesta stale no pisa la decisión humana
 * (queda `fallida` con `PROPOSAL_STALE`). Los efectos corren tras un
 * savepoint: cualquier error de dominio deshace los parciales y deja la
 * propuesta `fallida` de forma transaccional (HTTP 200, la UI distingue por
 * `status`). Solo la ventana de mensajería y los 429/5xx se relanzan para
 * reintentar. El ejecutor queda auditado como user/team que aprobó.
 */
export async function executeProposal(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  opts: { secretsKey?: Buffer } = {},
): Promise<ProposalItem> {
  const [locked] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.id, id)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Propuesta")
  if (locked.status === "ejecutada") return enrichProposal(tx, orgId, locked)
  if (locked.status !== "aprobada") {
    throw new ServiceError("PROPOSAL_NOT_APPROVED", 409, "La propuesta no está aprobada")
  }
  // En una prueba del chat web Sofi responde de verdad (`enviar_mensaje`), pero
  // no reserva, cambia ni anota nada en la clínica (fase 6 del pulido de la Bandeja).
  if (locked.conversationId && locked.action !== "enviar_mensaje") {
    const [thread] = await tx
      .select({ isTest: conversation.isTest })
      .from(conversation)
      .where(and(eq(conversation.id, locked.conversationId), eq(conversation.organizationId, orgId)))
      .limit(1)
    if (thread?.isTest) {
      throw new ServiceError(
        "TEST_CONVERSATION",
        409,
        "Es una prueba del chat web: no se reserva, cambia ni anota nada de verdad. Díselo así: en la prueba no queda nada hecho.",
      )
    }
  }
  const action = locked.action as ProposalAction
  const payload = locked.payload
  const expected = expectedOf(locked)
  const zone = await getOrgLocale(tx, orgId)
  // Solo un userId real va a las auditorías de negocio; el resto de la
  // autoridad (agent/contact/staff) queda en decidedBy y en el audit del acto.
  // Persona que decide: el id de sesión. `agent` y los prefijos `staff:`/
  // `contact:` (confirmación registrada) no son usuarios del equipo.
  const teamUserId = actorUserId === "agent" || actorUserId.includes(":") ? null : actorUserId
  // Los efectos corren tras un savepoint: si fallan, se deshacen los
  // parciales pero la marca `fallida` sí persiste en la tx exterior.
  await tx.execute(sql.raw("SAVEPOINT sp_proposal_exec"))
  let executed: ProposalRow
  try {
    let result: Record<string, unknown>
    if (action === "reservar_cita") {
      const patientId = payload.patientId as string
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, patientId)
      } else {
        await requirePatient(tx, orgId, patientId)
      }
      const created = await createAppointment(tx, orgId, actorUserId, {
        branchId: typeof payload.branchId === "string" ? (payload.branchId as string) : undefined,
        patientId,
        professionalUserId: payload.professionalUserId as string,
        roomId: payload.roomId as string,
        serviceId: typeof payload.serviceId === "string" ? (payload.serviceId as string) : undefined,
        startsAt: payload.startsAt as string,
        endsAt: typeof payload.endsAt === "string" ? (payload.endsAt as string) : undefined,
        durationMin: typeof payload.durationMin === "number" ? (payload.durationMin as number) : undefined,
        reason: typeof payload.reason === "string" ? (payload.reason as string) : undefined,
        source: "agent",
        conversationId: locked.conversationId ?? undefined,
        // El agente y el interlocutor que confirma no son usuarios: la cita
        // queda sin autora y quién la decidió consta en la auditoría.
        createdByUserId: teamUserId,
        // Se le dijo en la misma conversación: «Recordar la cita» no repite el aviso.
        notice: false,
      })
      result = { appointmentId: created.id, startsAt: created.startsAt, professionalName: created.professionalName }
    } else if (action === "reprogramar_cita") {
      const appointmentId = payload.appointmentId as string
      const [liveAppt] = await tx
        .select()
        .from(appointment)
        .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
        .for("update")
        .limit(1)
      if (!liveAppt) throw staleError("la cita ya no existe", "La cita ya no está disponible")
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, liveAppt.patientId)
      }
      if (!expected?.appointmentId) {
        throw staleError(
          "la propuesta no trae evidencia de estado; pide una nueva",
          apptSummary(liveAppt, zone),
        )
      }
      const fresh = apptFreshness(
        expected,
        typeof payload.expectedVersion === "number" ? (payload.expectedVersion as number) : null,
        { version: liveAppt.version, status: liveAppt.status, startsAt: liveAppt.startsAt },
        zone,
      )
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      const move = {
        expectedVersion: payload.expectedVersion as number,
        startsAt: payload.startsAt as string,
        endsAt: typeof payload.endsAt === "string" ? (payload.endsAt as string) : undefined,
        professionalUserId: typeof payload.professionalUserId === "string" ? (payload.professionalUserId as string) : undefined,
        roomId: typeof payload.roomId === "string" ? (payload.roomId as string) : undefined,
      }
      // Lo pide la persona en la conversación: la regla de la cita propia,
      // la misma del enlace y el portal (no empezó, hora futura, horizonte).
      const moved = locked.contactId
        ? await moveOwnAppointment(tx, orgId, actorUserId, liveAppt, move)
        : await moveAppointment(tx, orgId, actorUserId, appointmentId, move, { notice: false })
      result = { appointmentId: moved.id, startsAt: moved.startsAt }
    } else if (action === "cancelar_cita") {
      const appointmentId = payload.appointmentId as string
      const [liveAppt] = await tx
        .select()
        .from(appointment)
        .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
        .for("update")
        .limit(1)
      if (!liveAppt) throw staleError("la cita ya no existe", "La cita ya no está disponible")
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, liveAppt.patientId)
      }
      if (!expected?.appointmentId) {
        throw staleError(
          "la propuesta no trae evidencia de estado; pide una nueva",
          apptSummary(liveAppt, zone),
        )
      }
      const fresh = apptFreshness(expected, null, {
        version: liveAppt.version,
        status: liveAppt.status,
        startsAt: liveAppt.startsAt,
      }, zone)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      // La pide la persona en la conversación: cancelar su cita deja el
      // motivo «paciente», como desde su enlace o el portal.
      const cancelled = locked.contactId
        ? await cancelOwnAppointment(tx, orgId, actorUserId, liveAppt, "La canceló la persona en la conversación")
        : await setAppointmentStatus(tx, orgId, actorUserId, appointmentId, "cancelada", { notice: false })
      result = { appointmentId: cancelled.id, status: cancelled.status }
    } else if (action === "decidir_presupuesto") {
      // Decide quien escribe en la conversación (la persona o su representante
      // legal vigente, lo comprueba `decideBudget`), con su sí a la lista. Es la
      // misma operación que la pantalla y el portal; nadie del equipo firma.
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const patientId = payload.patientId as string
      const budgetId = payload.budgetId as string
      const live = await liveBudgetOf(tx, orgId, payload)
      if (!expected?.budgetId) {
        throw staleError("la propuesta no trae evidencia de estado; pide una nueva", live ? `Presupuesto (${live.status})` : null)
      }
      const fresh = budgetFreshness(expected, live, live?.number ?? null)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      const decided = await decideBudget(
        tx,
        orgId,
        null,
        patientId,
        budgetId,
        {
          optionId: typeof payload.optionId === "string" ? (payload.optionId as string) : null,
          decisions: payload.decisions as Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>,
          decidedByContactId: locked.contactId,
        },
        { skipOwnPlan: true, via: "conversacion" },
      )
      result = { patientId, budgetId, status: decided.status, stateText: decided.stateText, acceptedCents: decided.acceptedCents }
    } else if (action === "enviar_mensaje") {
      const conversationId = locked.conversationId
      // El agente no elige plantillas (ADR 0040): fuera de las 24 horas el
      // sistema envía «Retomar la conversación» (`resumeConversationBySystem`).
      if (payload.kind === "template") {
        throw validation("El agente no envía plantillas: fuera de las 24 horas el sistema retoma la conversación")
      } else {
        // «Sí» / «No» bajo la pregunta que pide confirmar una lista: tocarlos es
        // escribirlo, y el sí llega al agente como cualquier otro.
        const buttons = replyButtonsOf(payload.buttons)
        const sent = await sendOutbound(tx, orgId, {
          conversationId,
          senderKind: "agent",
          senderUserId: teamUserId,
          content: { type: "text", text: payload.text as string, ...(buttons ? { buttons } : {}) },
        })
        result = { messageId: sent.id, kind: "text" }
      }
    } else if (action === "mover_oportunidad") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload.opportunityId as string
      const live = await lockContactOpportunity(tx, orgId, locked.contactId, opportunityId)
      const stageName = (await stageNamesById(tx, [live.stageId])).get(live.stageId) ?? null
      const liveOpp = {
        stageId: live.stageId,
        status: live.status,
        nextActionAt: live.nextActionAt?.toISOString() ?? null,
        nextActionNote: live.nextActionNote,
      }
      if (!expected?.opportunityId) {
        throw staleError(
          "la propuesta no trae evidencia de estado; pide una nueva",
          oppCurrentSummary("mover_oportunidad", liveOpp, stageName, zone),
        )
      }
      const fresh = oppFreshness("mover_oportunidad", expected, liveOpp, stageName, zone)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      const detail = await moveOpportunity(tx, orgId, opportunityId, payload.stageId as string, {
        userId: teamUserId,
        origin: "agente",
      })
      result = { opportunityId, stageId: detail.stageId, stageName: detail.stageName }
    } else if (action === "crear_oportunidad") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      // Nace en «Interesado» y, sin responsable, es de Recepción. Si la persona
      // ya tiene abierta la del mismo interés, el agente sigue con esa.
      const created = await createOpportunity(
        tx,
        orgId,
        {
          contactId: locked.contactId,
          title: payload.title as string,
          ...(typeof payload.patientId === "string" ? { patientId: payload.patientId as string } : {}),
          ...(typeof payload.serviceId === "string" ? { serviceId: payload.serviceId as string } : {}),
          ...(typeof payload.interestText === "string" ? { interestText: payload.interestText as string } : {}),
          ...(typeof payload.assignedUserId === "string" ? { assignedUserId: payload.assignedUserId as string } : {}),
          ...(typeof payload.budgetId === "string" ? { budgetId: payload.budgetId as string } : {}),
          ...(locked.conversationId ? { conversationId: locked.conversationId } : {}),
        },
        { userId: teamUserId, origin: "agente" },
        { reuseOpen: true },
      )
      // Propuestas anteriores podían traer la próxima acción: ahora es su tarea.
      if (typeof payload.nextActionAt === "string" || typeof payload.nextActionNote === "string") {
        await setOpportunityTask(
          tx,
          orgId,
          created.id,
          {
            title: typeof payload.nextActionNote === "string" ? (payload.nextActionNote as string) : null,
            dueAt: typeof payload.nextActionAt === "string" ? (payload.nextActionAt as string) : null,
          },
          { userId: teamUserId, createdBy: "agent" },
        )
      }
      result = {
        opportunityId: created.id,
        createdOpportunityId: created.id,
        title: created.title,
        stageId: created.stageId,
        ...(created.reused ? { reused: true } : {}),
      }
    } else if (action === "actualizar_seguimiento") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload.opportunityId as string
      const live = await lockContactOpportunity(tx, orgId, locked.contactId, opportunityId)
      const liveOpp = {
        stageId: live.stageId,
        status: live.status,
        nextActionAt: live.nextActionAt?.toISOString() ?? null,
        nextActionNote: live.nextActionNote,
      }
      if (!expected?.opportunityId) {
        throw staleError(
          "la propuesta no trae evidencia de estado; pide una nueva",
          oppCurrentSummary("actualizar_seguimiento", liveOpp, null, zone),
        )
      }
      const fresh = oppFreshness("actualizar_seguimiento", expected, liveOpp, null, zone)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      // La próxima acción es la tarea de la oportunidad: se crea o se cambia, nunca otra.
      const task = await setOpportunityTask(
        tx,
        orgId,
        opportunityId,
        {
          ...(typeof payload.nextActionNote === "string" ? { title: payload.nextActionNote as string } : {}),
          ...(payload.nextActionAt !== undefined ? { dueAt: payload.nextActionAt as string | null } : {}),
        },
        { userId: teamUserId, createdBy: "agent" },
      )
      result = {
        opportunityId,
        taskId: task.taskId,
        nextActionAt: task.dueAt,
        nextActionNote: task.title,
      }
    } else {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload.opportunityId as string
      const live = await lockContactOpportunity(tx, orgId, locked.contactId, opportunityId)
      const stageName = (await stageNamesById(tx, [live.stageId])).get(live.stageId) ?? null
      const liveOpp = {
        stageId: live.stageId,
        status: live.status,
        nextActionAt: live.nextActionAt?.toISOString() ?? null,
        nextActionNote: live.nextActionNote,
      }
      if (!expected?.opportunityId) {
        throw staleError(
          "la propuesta no trae evidencia de estado; pide una nueva",
          oppCurrentSummary("cerrar_oportunidad", liveOpp, stageName, zone),
        )
      }
      const fresh = oppFreshness("cerrar_oportunidad", expected, liveOpp, stageName, zone)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      // Los motivos son de la lista; una propuesta antigua con texto libre queda como «Otro» con su nota.
      const outcome = payload.outcome as "won" | "lost"
      const raw = typeof payload.reason === "string" ? (payload.reason as string) : ""
      const listed = outcome === "won" ? raw === "acepto" : (CHOOSABLE_LOST_REASONS as readonly string[]).includes(raw)
      const closed = await closeOpportunity(
        tx,
        orgId,
        opportunityId,
        {
          outcome,
          reason: listed ? raw : outcome === "won" ? "acepto" : "otro",
          note: typeof payload.note === "string" ? (payload.note as string) : listed ? null : raw.slice(0, 500) || null,
        },
        { userId: teamUserId, origin: "agente" },
      )
      result = { opportunityId, outcome: payload.outcome, closedAt: closed.closedAt }
    }
    const [row] = await tx
      .update(agentProposal)
      .set({ status: "ejecutada", result, executedAt: new Date(), updatedAt: new Date() })
      .where(eq(agentProposal.id, id))
      .returning()
    if (!row) throw new Error("No se pudo guardar el resultado")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "agent.proposal_executed",
      entity: "agent_proposal",
      entityId: id,
      metadata: { action },
    })
    await tx.execute(sql.raw("RELEASE SAVEPOINT sp_proposal_exec"))
    executed = row
  } catch (error) {
    try {
      await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT sp_proposal_exec"))
      await tx.execute(sql.raw("RELEASE SAVEPOINT sp_proposal_exec"))
    } catch (rollbackError) {
      // Sin deshacer parciales no se continúa en una tx quizá abortada: el
      // error original queda como causa del fallo transaccional.
      throw new Error("No se pudo deshacer la ejecución parcial de la propuesta", { cause: rollbackError })
    }
    // Solo infraestructura reintentable (429/5xx) se relanza; la ventana
    // cerrada es fallo de dominio y persiste `fallida` con código estable
    // para que el agente tome la ruta `outside_window` sin throw especial.
    if (error instanceof ServiceError && (error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503)) {
      throw error
    }
    const code = error instanceof ServiceError ? error.code : "EXECUTION_FAILED"
    const detail = error instanceof Error ? error.message : String(error)
    const coded = code === "EXECUTION_FAILED" ? detail : `${code}: ${detail}`
    const [row] = await tx
      .update(agentProposal)
      .set({ status: "fallida", error: coded.slice(0, 500), result: { errorCode: code }, updatedAt: new Date() })
      .where(eq(agentProposal.id, id))
      .returning()
    if (!row) throw error
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "agent.proposal_failed",
      entity: "agent_proposal",
      entityId: id,
      metadata: { error: coded.slice(0, 300), errorCode: code },
    })
    return enrichProposal(tx, orgId, row)
  }
  // Sofi movió la agenda: su conversación de esa ventana pasa a «Gestiona» (ADR 0085).
  if (executed.contactId && executed.executedAt && AGENDA_ACTIONS.includes(executed.action)) {
    await refreshConversationTier(tx, orgId, { contactId: executed.contactId, at: executed.executedAt })
  }
  await notify(tx, { orgId, kind: "agent.proposal.executed", at: new Date().toISOString() })
  return enrichProposal(tx, orgId, executed)
}

/* ---------- Derivación a humano ---------- */

export interface HandoffItem {
  id: string
  conversationId: string | null
  contactId: string | null
  contactName: string | null
  channel: string | null
  reason: string
  summary: string
  priority: HandoffPriority
  /** Qué pide la persona, en una frase; nulo si quien derivó no lo dejó escrito. */
  asks: string | null
  /** Lo que falta preguntar o hacer; nulo si no se dejó escrito. */
  pending: string | null
  /** El aviso que recibió la persona; nulo si no salió ninguno. */
  notice: string | null
  assigneeUserId: string | null
  taskId: string | null
  /** Plazo de la tarea de seguimiento según la prioridad (visible en la cola). */
  dueAt: string | null
  /**
   * abierta: nadie la tomó; tomada: con responsable; resuelta: su tarea se
   * completó o canceló. Se deriva de la tarea vinculada, sin estado propio.
   */
  status: HandoffStatus
  createdBy: string
  createdAt: string
  /** De qué trata: dice a quién le llega (R3 de la Bandeja). */
  kind: TopicKind
  /** El mensaje de la persona que originó el tema; nulo si no hay uno. */
  sourceMessageId: string | null
  /**
   * «Ahora»: prioridad alta o ya pasaron dos horas de clínica abierta
   * esperando al equipo (`urgent_at`; decisión 1 del pulido). La misma regla
   * en la Bandeja, Inicio y el panel.
   */
  urgent: boolean
}

export type HandoffStatus = "abierta" | "tomada" | "resuelta"

type HandoffRow = typeof agentHandoff.$inferSelect

async function enrichHandoffs(tx: Db, rows: HandoffRow[]): Promise<HandoffItem[]> {
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((v): v is string => !!v))]
  const conversationIds = [...new Set(rows.map((r) => r.conversationId).filter((v): v is string => !!v))]
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((v): v is string => !!v))]
  const [contacts, convs] = await Promise.all([
    contactIds.length
      ? tx.select({ id: contact.id, displayName: contact.displayName }).from(contact).where(inArray(contact.id, contactIds))
      : [],
    conversationIds.length
      ? tx
          .select({ id: conversation.id, connectionId: conversation.channelConnectionId })
          .from(conversation)
          .where(inArray(conversation.id, conversationIds))
      : [],
  ])
  const contactById = new Map(contacts.map((c) => [c.id, c.displayName]))
  const dueByTask = new Map<string, Date>()
  const statusByTask = new Map<string, string>()
  if (taskIds.length) {
    const tasks = await tx
      .select({ id: crmTask.id, dueAt: crmTask.dueAt, status: crmTask.status })
      .from(crmTask)
      .where(inArray(crmTask.id, taskIds))
    for (const t of tasks) {
      if (t.dueAt) dueByTask.set(t.id, t.dueAt)
      statusByTask.set(t.id, t.status)
    }
  }
  const connectionByConv = new Map(convs.map((c) => [c.id, c.connectionId]))
  const connIds = [...new Set(connectionByConv.values())].filter((v): v is string => !!v)
  const channelByConnection = new Map<string, string>()
  if (connIds.length) {
    const conns = await tx
      .select({ id: channelConnection.id, channel: channelConnection.channel })
      .from(channelConnection)
      .where(inArray(channelConnection.id, connIds))
    for (const c of conns) channelByConnection.set(c.id, c.channel)
  }
  return rows.map((row) => {
    const connectionId = row.conversationId ? connectionByConv.get(row.conversationId) : undefined
    return {
      id: row.id,
      conversationId: row.conversationId,
      contactId: row.contactId,
      contactName: row.contactId ? (contactById.get(row.contactId) ?? null) : null,
      channel: connectionId ? (channelByConnection.get(connectionId) ?? null) : null,
      reason: row.reason,
      summary: row.summary,
      priority: row.priority as HandoffPriority,
      asks: row.asks,
      pending: row.pending,
      notice: row.notice,
      assigneeUserId: row.assigneeUserId,
      taskId: row.taskId,
      dueAt: row.taskId ? (dueByTask.get(row.taskId)?.toISOString() ?? null) : null,
      status:
        row.taskId &&
        statusByTask.get(row.taskId) !== undefined &&
        statusByTask.get(row.taskId) !== "open"
          ? "resuelta"
          : row.assigneeUserId
            ? "tomada"
            : "abierta",
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      kind: topicKindOf(row.kind),
      sourceMessageId: row.sourceMessageId,
      urgent: topicIsUrgent(row),
    }
  })
}

/**
 * Casos que pasó el agente y siguen sin resolver. Con `forUserId`, el único
 * contador de la aplicación (el del menú del Agente): lo que nadie ha tomado
 * más lo que es de esa persona; lo que tomó otra no la espera.
 */
export async function countOpenHandoffs(tx: Db, orgId: string, opts: { forUserId?: string } = {}): Promise<number> {
  const [row] = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
    from agent_handoff h
    where h.organization_id = ${orgId} and ${handoffOpenSql(sql.raw("h"))}
      ${opts.forUserId ? sql`and (h.assignee_user_id is null or h.assignee_user_id = ${opts.forUserId})` : sql``}`)
  return row?.count ?? 0
}

export interface AgentRunsToday {
  /** Corridas que hicieron algo; las omitidas (ráfaga ya atendida, agente apagado) no cuentan. */
  runs: number
  ok: number
  handoff: number
  error: number
  omitida: number
  sinRespuesta: number
}

/** Corridas de hoy por estado; «hoy» es el día civil en la zona de la organización. */
export async function countAgentRunsToday(tx: Db, orgId: string, timezone: string): Promise<AgentRunsToday> {
  const [row] = await tx.execute<{
    runs: number
    ok: number
    handoff: number
    error: number
    omitida: number
    sin_respuesta: number
  }>(sql`
    select count(*) filter (where status <> 'omitida')::int as runs,
      count(*) filter (where status = 'ok')::int as ok,
      count(*) filter (where status = 'handoff')::int as handoff,
      count(*) filter (where status = 'error')::int as error,
      count(*) filter (where status = 'omitida')::int as omitida,
      count(*) filter (where status = 'sin_respuesta')::int as sin_respuesta
    from agent_run_ledger
    where organization_id = ${orgId}
      and (started_at at time zone ${timezone})::date = (now() at time zone ${timezone})::date`)
  return {
    runs: row?.runs ?? 0,
    ok: row?.ok ?? 0,
    handoff: row?.handoff ?? 0,
    error: row?.error ?? 0,
    omitida: row?.omitida ?? 0,
    sinRespuesta: row?.sin_respuesta ?? 0,
  }
}

/**
 * Propuestas que esperan el sí del interlocutor (las citas). Es lo único que
 * queda pendiente: el equipo no decide ninguna (ADR 0023).
 */
export async function countAwaitingContact(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from agent_proposal p
    where p.organization_id = ${orgId} and ${proposalPendingSql(sql.raw("p"))}`)
  return row?.count ?? 0
}

export interface AgentPanelSummary {
  enabled: boolean
  /** Propuestas que esperan el sí del interlocutor; se ven, el equipo no las decide. */
  awaitingContact: number
  /** Citas propuestas que esperan el sí de la persona: el número de la pestaña «Esperan su sí». */
  awaitingAnswer: number
  /**
   * Casos que pasó el agente y esperan a quien mira: sin tomar o suyos. Es el
   * único contador (el del menú del Agente); ninguna otra parte lo repite.
   */
  openHandoffs: number
  /** Corridas de hoy que respondieron o derivaron (zona de la organización). */
  interventionsToday: number
  /** Corridas de hoy con error o sin respuesta: no se presentan como intervenciones. */
  failedToday: number
  locale: string
  timezone: string
}

/**
 * Resumen ligero para el botón y la cabecera del panel del agente: legible
 * con `agent.decide` (recepción) sin exponer configuración ni modelo.
 */
export async function getAgentPanelSummary(tx: Db, orgId: string, userId: string): Promise<AgentPanelSummary> {
  await expireDueProposals(tx, orgId)
  const { locale, timezone } = await getOrgLocale(tx, orgId)
  const [cfg] = await tx
    .select({ enabled: agentConfig.enabled })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  const today = await countAgentRunsToday(tx, orgId, timezone)
  return {
    enabled: cfg?.enabled ?? false,
    awaitingContact: await countAwaitingContact(tx, orgId),
    awaitingAnswer: await countAwaitingAnswer(tx, orgId),
    openHandoffs: await countOpenHandoffs(tx, orgId, { forUserId: userId }),
    interventionsToday: today.ok + today.handoff,
    failedToday: today.error + today.sinRespuesta,
    locale,
    timezone,
  }
}

async function enrichHandoff(tx: Db, row: HandoffRow): Promise<HandoffItem> {
  const [item] = await enrichHandoffs(tx, [row])
  if (!item) throw new Error("No se pudo enriquecer la derivación")
  return item
}

async function notifyUsers(
  tx: Db,
  orgId: string,
  userIds: string[],
  input: { dedupeKey: string; title: string; body: string; href: string; permission: string; subject?: string },
) {
  for (const userId of [...new Set(userIds)]) {
    await createWorkspaceNotification(tx, orgId, { ...input, userId, dedupeKey: `${input.dedupeKey}:${userId}` })
  }
}

/**
 * ¿Hubo hoy (zona de la clínica), en las conversaciones de una persona, una
 * corrida que terminó con este estado y este motivo? Así el mensaje fijo del
 * presupuesto le llega una sola vez por día (ADR 0085).
 */
export async function contactHadRunToday(
  tx: Db,
  orgId: string,
  contactId: string,
  input: { status: AgentRunStatus; error: string },
): Promise<boolean> {
  const { timezone } = await getOrgLocale(tx, orgId)
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from agent_run_ledger l
      join conversation c on c.id = l.conversation_id and c.organization_id = l.organization_id
      where l.organization_id = ${orgId} and c.contact_id = ${contactId}
        and l.status = ${input.status} and l.error = ${input.error}
        and (l.started_at at time zone ${timezone})::date = (now() at time zone ${timezone})::date
    ) as found`)
  return row?.found === true
}

/**
 * ¿La persona ya recibió hoy (zona de la clínica) este mismo texto del agente,
 * en cualquiera de sus conversaciones? Lo que el canal rechazó no cuenta: no
 * le llegó. Con esto un texto fijo sale como mucho una vez por persona y día.
 */
export async function contactGotAgentTextToday(tx: Db, orgId: string, contactId: string, text: string): Promise<boolean> {
  const { timezone } = await getOrgLocale(tx, orgId)
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from message m
      join conversation c on c.id = m.conversation_id and c.organization_id = m.organization_id
      where m.organization_id = ${orgId} and c.contact_id = ${contactId}
        and m.direction = 'out' and m.sender_kind = 'agent' and m.status <> 'failed' and m.body = ${text}
        and (m.created_at at time zone ${timezone})::date = (now() at time zone ${timezone})::date
    ) as found`)
  return row?.found === true
}

/**
 * El proveedor del modelo no sirve (configuración, credencial rechazada, sin
 * saldo): aviso a quien administra el agente, uno por problema y día. El del modelo no nombra claves ni variables: la cuenta
 * es de odentIA, la clínica no puede arreglarla y odentIA ya recibió el caso
 * en Soporte. El enlace lleva a la página de Sofi. No lleva datos del interlocutor.
 */
export async function notifyAgentProviderProblem(
  tx: Db,
  orgId: string,
  problem: { code: string; detail: string },
): Promise<void> {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(20)
  const { timezone } = await getOrgLocale(tx, orgId)
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date())
  await notifyUsers(
    tx,
    orgId,
    rows.map((r) => r.userId),
    {
      dedupeKey: `agent-provider:${problem.code}:${day}`,
      title: "Sofi no puede usar el modelo",
      body: AGENT_MODEL_DOWN_NOTICE,
      href: "/agent/recepcion",
      permission: "agent.write",
      // Se retira solo cuando el agente vuelve a responder.
      subject: "modelo-del-agente",
    },
  )
}

/** Lo que dicen la página de Sofi y la campana cuando el modelo deja de responder. */
export const AGENT_MODEL_DOWN_NOTICE = "Sofi no puede responder ahora: los mensajes pasan a tu equipo. Ya avisamos a odentIA."

/**
 * La corrida por un mensaje entrante terminó sin responder ni derivar.
 * Devuelve si el hilo quedó de verdad sin respuesta: no lo está cuando ya
 * hay un envío posterior al disparador, o uno a la espera de decisión
 * (reentrega del mismo trabajo, o una corrida previa que contestó varios
 * mensajes seguidos). Si quedó sin respuesta, el agente sigue activo en el
 * hilo y la conversación espera respuesta: así la muestra «Te espera», no la
 * campana. No deriva ni apaga el agente.
 */
export async function reportAgentNoReply(
  tx: Db,
  orgId: string,
  input: { conversationId: string; triggerMessageId: string },
): Promise<boolean> {
  const [trigger] = await tx
    .select({ createdAt: conversationMessage.createdAt })
    .from(conversationMessage)
    .where(
      and(
        eq(conversationMessage.id, input.triggerMessageId),
        eq(conversationMessage.organizationId, orgId),
        eq(conversationMessage.conversationId, input.conversationId),
      ),
    )
    .limit(1)
  if (trigger) {
    const [sent] = await tx
      .select({ id: conversationMessage.id })
      .from(conversationMessage)
      .where(
        and(
          eq(conversationMessage.organizationId, orgId),
          eq(conversationMessage.conversationId, input.conversationId),
          eq(conversationMessage.direction, "out"),
          ne(conversationMessage.status, "failed"),
          gt(conversationMessage.createdAt, trigger.createdAt),
        ),
      )
      .limit(1)
    if (sent) return false
    const [pending] = await tx
      .select({ id: agentProposal.id })
      .from(agentProposal)
      .where(
        and(
          eq(agentProposal.organizationId, orgId),
          eq(agentProposal.conversationId, input.conversationId),
          eq(agentProposal.action, "enviar_mensaje"),
          inArray(agentProposal.status, ["propuesta", "aprobada"]),
          gt(agentProposal.createdAt, trigger.createdAt),
        ),
      )
      .limit(1)
    if (pending) return false
  }
  // Sin aviso en la campana: la conversación espera respuesta y así la muestra «Te espera».
  return true
}

/**
 * Plazo de recogida/resolución de una derivación por prioridad (política
 * explícita de recepción). Vencida sigue en «Te espera»; la campana no avisa.
 */
const HANDOFF_DUE_HOURS: Record<HandoffPriority, number> = { alta: 4, media: 24, baja: 72 }

/**
 * Tema para el equipo (ADR 0050): resumen factual, motivo, prioridad,
 * responsable, tarea de seguimiento y el mensaje de la persona que lo originó
 * (por defecto, su último entrante). No apaga al agente: el agente sigue con
 * lo demás. Una duda clínica sin responsable va al profesional que atiende al
 * paciente. Aparece en «Por atender» y en «Te espera» (no en la campana).
 */
export async function createHandoff(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: {
    conversationId: string
    reason: string
    summary: string
    priority?: string
    assigneeUserId?: string | null
    /** Reutiliza el pendiente origen; no crea una segunda tarea. */
    taskId?: string
    createdBy?: string
    asks?: string | null
    pending?: string | null
    /** El mensaje de la persona que se responde; por defecto, su último entrante. */
    sourceMessageId?: string | null
    /** Duda clínica: sin responsable, va al profesional que atiende al paciente. Es lo mismo que `kind: "clinico"`. */
    clinical?: boolean
    /** De qué trata (R3): decide a quién le llega si no se dice el responsable. */
    kind?: TopicKind | null
  },
): Promise<HandoffItem> {
  const conv = await requireConversationInOrg(tx, orgId, input.conversationId)
  const sourceMessageId = await topicSourceMessage(tx, orgId, input.conversationId, input.sourceMessageId ?? null)
  const reason = cleanReason(input.reason, 500)
  if (!reason) throw validation("El motivo es obligatorio")
  const summary = cleanReason(input.summary, 2000)
  if (!summary) throw validation("El resumen es obligatorio")
  const priority = (input.priority ?? "media") as HandoffPriority
  if (!(HANDOFF_PRIORITIES as readonly string[]).includes(priority)) {
    throw validation("priority debe ser alta|media|baja")
  }
  let assigneeUserId = input.assigneeUserId ?? null
  let task = input.taskId ? await getTask(tx, orgId, input.taskId) : null
  if (task) {
    if (task.status !== "open") throw validation("La tarea de la derivación ya no está abierta")
    if (task.conversationId !== input.conversationId || task.contactId !== conv.contactId) {
      throw validation("La tarea no corresponde a la conversación de la derivación")
    }
    if (assigneeUserId && task.assigneeUserId && assigneeUserId !== task.assigneeUserId) {
      throw validation("La derivación no puede cambiar el responsable del seguimiento vinculado")
    }
    assigneeUserId ??= task.assigneeUserId
  }
  const kind: TopicKind = input.clinical ? "clinico" : topicKindOf(input.kind)
  // Una duda clínica va al odontólogo que atiende a la persona; si no tiene o
  // está ausente, queda para recepción (R3 de la Bandeja).
  if (!assigneeUserId && kind === "clinico" && conv.contactId) {
    assigneeUserId = await treatingProfessional(tx, orgId, conv.contactId)
  }
  if (assigneeUserId) {
    const [membership] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, assigneeUserId)))
      .limit(1)
    if (!membership) throw validation("El responsable no es miembro de la organización")
  }
  const createdBy = input.createdBy === "user" ? "user" : "agent"
  task ??= await createTask(tx, orgId, {
    // Un solo nombre en toda la aplicación (decisión 1): la prioridad la dice la fila, no el título.
    // «Sofi» se dice con el nombre que le puso la clínica al mostrarlo (`withReceptionName`).
    title: (createdBy === "user"
      ? `Tema pendiente: ${reason}`
      : `Te lo pasó Sofi: ${reason}`
    ).slice(0, 200),
    contactId: conv.contactId,
    conversationId: input.conversationId,
    assigneeUserId,
    // Sin área nadie la vería en «Mías y de mi área» (M5): un pago es de caja,
    // una duda clínica del equipo clínico y lo demás de recepción (R3).
    area: kind === "pago" ? "caja" : kind === "clinico" ? "clinico" : "recepcion",
    dueAt: new Date(Date.now() + HANDOFF_DUE_HOURS[priority] * 3_600_000).toISOString(),
    createdBy,
    actorUserId,
  })
  const [row] = await tx
    .insert(agentHandoff)
    .values({
      organizationId: orgId,
      conversationId: input.conversationId,
      contactId: conv.contactId,
      reason,
      summary,
      priority,
      asks: cleanReason(input.asks ?? "", HANDOFF_BRIEF_CHARS) || null,
      pending: cleanReason(input.pending ?? "", HANDOFF_BRIEF_CHARS) || null,
      assigneeUserId,
      taskId: task.id,
      createdBy,
      sourceMessageId,
      kind,
      // Pasa a «Ahora» a las dos horas de clínica abierta (decisión 1 del pulido).
      urgentAt: await topicUrgentAt(tx, orgId, new Date()),
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar la derivación")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.handoff_created",
    entity: "agent_handoff",
    entityId: row.id,
    metadata: { priority, taskId: task.id, assigneeUserId },
  })
  // Sin aviso en la campana: el caso aparece en «Te espera», una sola vez.
  await notify(tx, { orgId, kind: "agent.handoff.created", at: new Date().toISOString() })
  return enrichHandoff(tx, row)
}

/**
 * El mensaje de la persona que origina un tema: el pedido, si es un entrante
 * de esa conversación; si no, su último entrante. Nulo si nunca escribió.
 */
async function topicSourceMessage(tx: Db, orgId: string, conversationId: string, requested: string | null): Promise<string | null> {
  if (requested) {
    const [found] = await tx
      .select({ id: conversationMessage.id })
      .from(conversationMessage)
      .where(and(eq(conversationMessage.id, requested), eq(conversationMessage.organizationId, orgId), eq(conversationMessage.conversationId, conversationId)))
      .limit(1)
    if (!found) throw validation("El mensaje citado no es de esta conversación")
    return found.id
  }
  const [last] = await tx
    .select({ id: conversationMessage.id })
    .from(conversationMessage)
    .where(and(eq(conversationMessage.organizationId, orgId), eq(conversationMessage.conversationId, conversationId), eq(conversationMessage.direction, "in")))
    .orderBy(desc(conversationMessage.createdAt), desc(conversationMessage.id))
    .limit(1)
  return last?.id ?? null
}

/**
 * El odontólogo que atiende a esta persona (R3 de la Bandeja): el que la
 * atendió por última vez; si nunca la atendieron, el de su próxima cita. Si
 * ese profesional está ausente hoy (Horarios y ausencias) o ya no es del
 * equipo, nulo: el tema queda para recepción.
 */
async function treatingProfessional(tx: Db, orgId: string, contactId: string): Promise<string | null> {
  const rows = await tx.execute<{ professional_user_id: string }>(sql`
    select who.professional_user_id from (
      (select a.professional_user_id, 0 as rank, a.starts_at as at from appointment a
        join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
        where a.organization_id = ${orgId} and p.person_id = ${contactId}
          and a.status = 'atendida' and a.starts_at <= now()
        order by a.starts_at desc limit 1)
      union all
      (select a.professional_user_id, 1 as rank, a.starts_at as at from appointment a
        join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
        where a.organization_id = ${orgId} and p.person_id = ${contactId}
          and a.status in ('programada', 'confirmada') and a.starts_at > now()
        order by a.starts_at asc limit 1)
    ) who
    join member mb on mb.organization_id = ${orgId} and mb.user_id = who.professional_user_id
    where not exists (
      select 1 from schedule_block b
      where b.organization_id = ${orgId} and b.professional_user_id = who.professional_user_id
        and b.starts_at <= now() and b.ends_at > now())
    order by who.rank
    limit 1`)
  return rows[0]?.professional_user_id ?? null
}

const HANDOFF_BRIEF_CHARS = 400
const HANDOFF_NOTICE_CHARS = 4000

/**
 * Completa una derivación ya registrada con lo que se sabe después de crearla:
 * qué pide la persona, qué falta y el aviso que recibió. Solo escribe lo que
 * llega con texto; no cambia motivo, prioridad ni responsable.
 */
export async function annotateHandoff(
  tx: Db,
  orgId: string,
  handoffId: string,
  input: { asks?: string | null; pending?: string | null; notice?: string | null },
): Promise<void> {
  const patch: { asks?: string; pending?: string; notice?: string } = {}
  const asks = cleanReason(input.asks ?? "", HANDOFF_BRIEF_CHARS)
  if (asks) patch.asks = asks
  const pending = cleanReason(input.pending ?? "", HANDOFF_BRIEF_CHARS)
  if (pending) patch.pending = pending
  const notice = (input.notice ?? "").trim().slice(0, HANDOFF_NOTICE_CHARS)
  if (notice) patch.notice = notice
  if (Object.keys(patch).length === 0) return
  await tx
    .update(agentHandoff)
    .set(patch)
    .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
}

/**
 * Casos que pasó el agente. Por defecto, del más nuevo al más viejo; con
 * `order: "urgencia"`, primero «Ahora», después «Hoy» y «Sin apuro», y en cada
 * una el que más lleva esperando: así el corte del tope nunca deja fuera a los
 * más viejos ni a los urgentes. `visibleTo`: solo los sin tomar y los de esa
 * persona (la misma regla que `countOpenHandoffs`).
 */
export async function listHandoffs(
  tx: Db,
  orgId: string,
  input: {
    conversationId?: string
    limit?: number
    open?: boolean
    order?: "reciente" | "urgencia"
    visibleTo?: string
    /** Solo los de esta persona o de estos tipos (Inicio de caja y del odontólogo), antes del límite. */
    only?: { assignee?: string; kinds?: string[] }
  } = {},
): Promise<HandoffItem[]> {
  const conditions = [eq(agentHandoff.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentHandoff.conversationId, input.conversationId))
  if (input.only) {
    const either = [
      ...(input.only.assignee ? [eq(agentHandoff.assigneeUserId, input.only.assignee)] : []),
      ...(input.only.kinds?.length ? [inArray(agentHandoff.kind, input.only.kinds)] : []),
    ]
    if (either.length > 0) conditions.push(or(...either)!)
  }
  if (input.open) conditions.push(handoffStillOpen())
  if (input.visibleTo) {
    conditions.push(or(isNull(agentHandoff.assigneeUserId), eq(agentHandoff.assigneeUserId, input.visibleTo))!)
  }
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const order =
    input.order === "urgencia"
      ? [
          sql`case when ${agentHandoff.priority} = 'alta' or ${agentHandoff.urgentAt} <= now() then 0 when ${agentHandoff.priority} = 'media' then 1 else 2 end`,
          asc(agentHandoff.createdAt),
          asc(agentHandoff.id),
        ]
      : [desc(agentHandoff.createdAt), asc(agentHandoff.id)]
  const rows = await tx
    .select()
    .from(agentHandoff)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit)
  return enrichHandoffs(tx, rows)
}

/**
 * Toma una derivación de la cola (sin responsable) de forma atómica: dos
 * miembros no pueden tomar el mismo caso (UPDATE condicional). La tarea
 * vinculada pasa al mismo responsable. Resolverla registra actor y resultado
 * por la vía de tareas; no reactiva el agente implícitamente.
 */
/**
 * Derivación sin resolver: sin tarea, o con su tarea aún abierta (resuelta =
 * tarea completada o cancelada). Misma regla para listar, contar y tomar.
 */
function handoffStillOpen(): SQL {
  return handoffOpenSql(sql.raw('"agent_handoff"'))
}

export async function claimHandoff(
  tx: Db,
  orgId: string,
  userId: string,
  handoffId: string,
  /**
   * `takeOver`: «Tomar este tema» aunque lo tenga otra persona (sin
   * confirmación; a ella se le avisa). `toUserId`: «Pasar este tema a…»; por
   * defecto, quien actúa. Ninguna de las dos apaga al agente (ADR 0050).
   */
  opts: { takeOver?: boolean; toUserId?: string } = {},
): Promise<HandoffItem> {
  const target = opts.toUserId ?? userId
  const [membership] = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, target)))
    .limit(1)
  if (!membership) throw validation("Solo un miembro de la organización puede tener el tema")
  const [before] = await tx
    .select({ assigneeUserId: agentHandoff.assigneeUserId, kind: agentHandoff.kind })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
    .limit(1)
  // Un tema se contesta en la conversación: lo recibe quien escribe en ella, o
  // caja si es un pago (lo responde desde Inicio; decisión 3 del pulido).
  const allowed =
    canAccess(membership.role, "conversations.write") ||
    (before?.kind === "pago" && canAccess(membership.role, "conversations.topics"))
  if (!allowed) {
    throw validation("Esa persona no atiende conversaciones: elige a alguien de recepción o del equipo clínico")
  }
  const passing = opts.toUserId !== undefined && opts.toUserId !== userId
  const [claimed] = await tx
    .update(agentHandoff)
    .set({ assigneeUserId: target })
    .where(
      and(
        eq(agentHandoff.id, handoffId),
        eq(agentHandoff.organizationId, orgId),
        ...(opts.takeOver || passing ? [] : [isNull(agentHandoff.assigneeUserId)]),
        handoffStillOpen(),
      ),
    )
    .returning()
  if (!claimed) {
    const [existing] = await tx
      .select({ assigneeUserId: agentHandoff.assigneeUserId, taskId: agentHandoff.taskId })
      .from(agentHandoff)
      .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
      .limit(1)
    if (!existing) throw notFound("Derivación")
    if (existing.taskId && (await getTask(tx, orgId, existing.taskId)).status !== "open") {
      throw new ServiceError("HANDOFF_RESOLVED", 409, "Este tema ya se resolvió: no se puede tomar")
    }
    if (existing.assigneeUserId === target) {
      const [row] = await tx
        .select()
        .from(agentHandoff)
        .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
        .limit(1)
      return enrichHandoff(tx, row!)
    }
    throw new ServiceError("HANDOFF_ALREADY_CLAIMED", 409, "Otra persona ya tomó este tema")
  }
  if (claimed.taskId) {
    await updateTask(tx, orgId, claimed.taskId, { assigneeUserId: target, actorUserId: userId })
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action: passing ? "agent.handoff_passed" : "agent.handoff_claimed",
    entity: "agent_handoff",
    entityId: claimed.id,
    metadata: { taskId: claimed.taskId, from: before?.assigneeUserId ?? null, to: target },
  })
  // Se avisa a quien lo tenía y, si se lo pasan, a quien lo recibe.
  const [actor] = await tx.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1)
  const who = await topicPersonName(tx, orgId, claimed.contactId)
  const href = claimed.conversationId ? `/inbox?conversation=${claimed.conversationId}` : "/inbox"
  if (before?.assigneeUserId && before.assigneeUserId !== target) {
    await createWorkspaceNotification(tx, orgId, {
      userId: before.assigneeUserId,
      dedupeKey: `tema:${claimed.id}:tomado:${target}`,
      title: `${actor?.name ?? "Alguien"} tomó el tema de ${who}`,
      body: claimed.reason,
      href,
      permission: "conversations.read",
      actorUserId: userId,
    })
  }
  if (passing) {
    await createWorkspaceNotification(tx, orgId, {
      userId: target,
      dedupeKey: `tema:${claimed.id}:pasado:${target}`,
      title: `${actor?.name ?? "Alguien"} te pasó el tema de ${who}`,
      body: claimed.reason,
      href,
      permission: "conversations.read",
      actorUserId: userId,
    })
  }
  return enrichHandoff(tx, claimed)
}

/** Nombre de la persona de un tema, para los avisos. */
async function topicPersonName(tx: Db, orgId: string, contactId: string | null): Promise<string> {
  if (!contactId) return "una persona"
  const [row] = await tx
    .select({ name: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  return row?.name ?? "una persona"
}

/**
 * La persona volvió a preguntar por un tema que tiene una persona del equipo
 * (ADR 0050): el agente no lo responde; se anota el mensaje en el tema y se
 * avisa a su responsable (o, sin responsable, queda resaltado en «Por atender»).
 */
export async function recordTopicAskedAgain(
  tx: Db,
  orgId: string,
  input: { handoffId: string; messageId: string | null },
): Promise<{ assigneeName: string | null; reason: string }> {
  const [row] = await tx
    .select()
    .from(agentHandoff)
    .where(and(eq(agentHandoff.id, input.handoffId), eq(agentHandoff.organizationId, orgId), handoffStillOpen()))
    .limit(1)
  if (!row) throw notFound("Tema")
  const asked = new Set(row.askedMessageIds ?? [])
  if (input.messageId) {
    const [msg] = await tx
      .select({ id: conversationMessage.id })
      .from(conversationMessage)
      .where(and(eq(conversationMessage.id, input.messageId), eq(conversationMessage.organizationId, orgId),
        eq(conversationMessage.conversationId, row.conversationId ?? "00000000-0000-0000-0000-000000000000")))
      .limit(1)
    if (msg) asked.add(msg.id)
  }
  await tx
    .update(agentHandoff)
    .set({ askedMessageIds: [...asked].slice(-20), askedAgainAt: new Date() })
    .where(eq(agentHandoff.id, row.id))
  let assigneeName: string | null = null
  if (row.assigneeUserId) {
    const [assignee] = await tx.select({ name: user.name }).from(user).where(eq(user.id, row.assigneeUserId)).limit(1)
    assigneeName = assignee?.name ?? null
    const who = await topicPersonName(tx, orgId, row.contactId)
    await upsertWorkspaceNotification(tx, orgId, {
      userId: row.assigneeUserId,
      dedupeKey: `tema:${row.id}:pregunta`,
      title: `${who} volvió a preguntar por su tema`,
      body: row.reason,
      href: row.conversationId ? `/inbox?conversation=${row.conversationId}` : "/inbox",
      permission: "conversations.read",
    })
  }
  return { assigneeName, reason: row.reason }
}

/* ---------- Supervisión: libro de corridas reales ---------- */

export interface RecordRunInput {
  conversationId?: string | null
  triggerMessageId?: string | null
  model: string
  status: AgentRunStatus
  startedAt: Date
  endedAt?: Date | null
  latencyMs?: number | null
  /** Solo si el proveedor los entrega. */
  inputTokens?: number | null
  outputTokens?: number | null
  /** Parte de la entrada servida desde caché; solo si el proveedor la entrega. */
  cachedInputTokens?: number | null
  /** Parte de la entrada escrita en la caché; solo si el proveedor la entrega. */
  cacheWriteTokens?: number | null
  /** Llamadas al modelo hechas en la corrida. */
  llmCalls?: number | null
  /**
   * Lo que la corrida gastó en cada proveedor (modelo que escribe, modelo de
   * decisión, vectores): queda en `ai_usage` con origen `recepcion` y su
   * suma es el costo de la fila, en millonésimas de USD.
   */
  usage?: readonly AiUsageEntry[]
  toolsUsed?: string[]
  error?: string | null
}

export async function recordAgentRun(tx: Db, orgId: string, input: RecordRunInput): Promise<void> {
  const cleanInt = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
  await tx.insert(agentRunLedger).values({
    organizationId: orgId,
    conversationId: input.conversationId ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    model: input.model.slice(0, 120),
    status: input.status,
    startedAt: input.startedAt,
    endedAt: input.endedAt ?? null,
    latencyMs: cleanInt(input.latencyMs),
    inputTokens: cleanInt(input.inputTokens),
    outputTokens: cleanInt(input.outputTokens),
    cachedInputTokens: cleanInt(input.cachedInputTokens),
    cacheWriteTokens: cleanInt(input.cacheWriteTokens),
    llmCalls: cleanInt(input.llmCalls),
    costMicros: cleanInt(knownCostMicros(input.usage ?? [])),
    toolsUsed: (input.toolsUsed ?? []).filter((t) => typeof t === "string").slice(0, 30),
    error: input.error?.slice(0, 500) ?? null,
  })
  if (input.usage?.length) {
    // Lo que gasta Sofi en una prueba del chat web cuenta como probar, con su tope (fase 6 del pulido).
    const [thread] = input.conversationId
      ? await tx.select({ isTest: conversation.isTest }).from(conversation).where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId))).limit(1)
      : []
    await recordAiUsage(tx, orgId, { origin: thread?.isTest ? "probar" : "recepcion", conversationId: input.conversationId ?? null, entries: input.usage })
  }
  // Recepción atendió con IA: cuenta la conversación de esa persona (ADR 0031).
  if (input.status === "ok" && (input.llmCalls ?? 0) > 0 && input.conversationId) {
    await countConversationAction(tx, orgId, { conversationId: input.conversationId, at: input.startedAt })
  }
  // La fila se escribe después de los efectos de la corrida: sin este aviso
  // la supervisión no se entera de las que no envían ni cambian el hilo.
  await notify(tx, { orgId, kind: "agent.run.recorded", at: new Date().toISOString() })
}

export async function listAgentRuns(
  tx: Db,
  orgId: string,
  input: { conversationId?: string; status?: string; limit?: number } = {},
) {
  const conditions = [eq(agentRunLedger.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentRunLedger.conversationId, input.conversationId))
  if (input.status) {
    if (!(AGENT_RUN_STATUSES as readonly string[]).includes(input.status)) throw validation("status inválido")
    conditions.push(eq(agentRunLedger.status, input.status))
  }
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const rows = await tx
    .select()
    .from(agentRunLedger)
    .where(and(...conditions))
    .orderBy(desc(agentRunLedger.startedAt), asc(agentRunLedger.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversationId,
    triggerMessageId: r.triggerMessageId,
    model: r.model,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens,
    llmCalls: r.llmCalls,
    toolsUsed: r.toolsUsed,
    error: r.error,
  }))
}

export interface AgentRunStats {
  total: number
  byStatus: Record<string, number>
  avgLatencyMs: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  totalCachedInputTokens: number | null
  totalLlmCalls: number | null
  /** Corridas con `llm_calls` registrado: el denominador de `totalLlmCalls`. */
  runsWithLlmCalls: number
  /**
   * Conversaciones con al menos una llamada al modelo en el rango: el
   * denominador del gasto por conversación (llamadas y tokens entre este valor).
   */
  conversationsWithLlmCalls: number
  topTools: Array<{ tool: string; uses: number }>
  /**
   * Llamadas al modelo que escribe según el camino que eligió el modelo de
   * decisión antes del turno (`sin_camino`: corridas sin esa elección). Sirve
   * para comparar el gasto antes y después de activarlo.
   */
  byRoute: Array<{ path: string; runs: number; avgLlmCalls: number | null; avgInputTokens: number | null }>
}

/**
 * Métricas reales desde el libro (rango opcional ISO), para la clínica. El
 * costo de cada corrida no va: es lo que odentIA paga a los proveedores y lo
 * ve su administración (ADR 0031).
 */
export async function getAgentRunStats(tx: Db, orgId: string, input: { from?: string; to?: string } = {}): Promise<AgentRunStats> {
  const conditions = [eq(agentRunLedger.organizationId, orgId)]
  if (input.from) {
    const from = new Date(input.from)
    if (Number.isNaN(from.getTime())) throw validation("from inválido")
    conditions.push(gte(agentRunLedger.startedAt, from))
  }
  if (input.to) {
    const to = new Date(input.to)
    if (Number.isNaN(to.getTime())) throw validation("to inválido")
    conditions.push(lte(agentRunLedger.startedAt, to))
  }
  const where = and(...conditions)
  const [totals] = await tx
    .select({
      total: count(),
      avgLatency: avg(agentRunLedger.latencyMs),
      inputTokens: sum(agentRunLedger.inputTokens),
      outputTokens: sum(agentRunLedger.outputTokens),
      cachedInputTokens: sum(agentRunLedger.cachedInputTokens),
      llmCalls: sum(agentRunLedger.llmCalls),
      runsWithLlmCalls: count(agentRunLedger.llmCalls),
      conversationsWithLlmCalls: sql<number>`count(distinct ${agentRunLedger.conversationId}) filter (where ${agentRunLedger.llmCalls} > 0)`,
    })
    .from(agentRunLedger)
    .where(where)
  const byStatusRows = await tx
    .select({ status: agentRunLedger.status, total: count() })
    .from(agentRunLedger)
    .where(where)
    .groupBy(agentRunLedger.status)
  const toolRows = await tx.execute<{ tool: string; uses: number }>(
    sql`select t as tool, count(*)::int as uses from ${agentRunLedger}, lateral unnest(${agentRunLedger.toolsUsed}) as t where ${where} group by t order by uses desc limit 10`,
  )
  const routeRows = await tx.execute<{ path: string; runs: number; calls: string | null; input: string | null }>(sql`
    select coalesce(d.path, 'sin_camino') as path, count(*)::int as runs,
           avg(${agentRunLedger.llmCalls})::text as calls, avg(${agentRunLedger.inputTokens})::text as input
    from ${agentRunLedger}
    left join lateral (
      select dl.outcome->>'path' as path from agent_decision_log dl
      where dl.organization_id = ${agentRunLedger.organizationId}
        and dl.trigger_message_id = ${agentRunLedger.triggerMessageId}
        and dl.mode = 'route' and dl.error is null
      order by dl.created_at desc limit 1
    ) d on true
    where ${where} and ${agentRunLedger.status} in ('ok', 'handoff', 'sin_respuesta')
    group by 1 order by 2 desc`)
  const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const toAvg = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
  }
  const byStatus: Record<string, number> = {}
  for (const row of byStatusRows) byStatus[row.status] = Number(row.total)
  return {
    total: Number(totals?.total ?? 0),
    byStatus,
    avgLatencyMs: totals?.avgLatency === null || totals?.avgLatency === undefined ? null : Math.round(Number(totals.avgLatency)),
    totalInputTokens: toNum(totals?.inputTokens),
    totalOutputTokens: toNum(totals?.outputTokens),
    totalCachedInputTokens: toNum(totals?.cachedInputTokens),
    totalLlmCalls: toNum(totals?.llmCalls),
    runsWithLlmCalls: Number(totals?.runsWithLlmCalls ?? 0),
    conversationsWithLlmCalls: Number(totals?.conversationsWithLlmCalls ?? 0),
    topTools: (toolRows as unknown as Array<{ tool: string; uses: number }>).map((r) => ({
      tool: r.tool,
      uses: Number(r.uses),
    })),
    byRoute: (routeRows as unknown as Array<{ path: string; runs: number; calls: string | null; input: string | null }>).map((r) => ({
      path: r.path,
      runs: Number(r.runs),
      avgLlmCalls: toAvg(r.calls),
      avgInputTokens: toNum(r.input),
    })),
  }
}
