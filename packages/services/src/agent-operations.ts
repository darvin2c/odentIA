import type { Db } from "@odentia/db"
import {
  agentHandoff,
  agentPolicy,
  agentProposal,
  agentRunLedger,
  AUTONOMY_ACTIONS,
  AUTONOMY_MODES,
  DEFAULT_AUTONOMY_MODES,
  HANDOFF_PRIORITIES,
  PROPOSAL_ACTIONS,
  type AgentPatientContext,
  type AgentRunStatus,
  type AutonomyAction,
  type AutonomyMode,
  type HandoffPriority,
  type ProposalAction,
  type ProposalStatus,
} from "@odentia/db/schema/agent"
import { member, user } from "@odentia/db/schema/auth"
import { channelConnection, contact, conversation, crmTask, pipelineStage } from "@odentia/db/schema/crm"
import { patient, patientResponsibility, treatmentBudget } from "@odentia/db/schema/clinical"
import { appointment } from "@odentia/db/schema/agenda"
import { opportunity } from "@odentia/db/schema/opportunities"
import { and, asc, avg, count, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql, sum } from "drizzle-orm"
import { listAvailableSlots } from "./availability.js"
import {
  createAppointment,
  getAppointment,
  moveAppointment,
  setAppointmentStatus,
} from "./appointments.js"
import { listMessages, sendOutbound, sendTemplateOutbound, setAgentStatus } from "./conversations.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import {
  closeOpportunity,
  createOpportunity,
  getOpportunity,
  moveOpportunity,
  updateOpportunity,
} from "./opportunities.js"
import { listPatientsByContact, requirePatient } from "./patients.js"
import { requireLinkedActiveContact } from "./responsibilities.js"
import { createTask, getTask, updateTask } from "./tasks.js"
import { createWorkspaceNotification } from "./workspace.js"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { getPatientBalanceForPortal } from "./finance.js"
import { formatZoned, getOrgLocale, type OrgLocale } from "./locale.js"

/** Plazo de confirmación por el interlocutor antes de expirar la propuesta. */
const CONFIRM_TTL_HOURS = 48
/** Ventana en ms derivada del plazo (una sola fuente de verdad). */
const CONFIRM_TTL_MS = CONFIRM_TTL_HOURS * 60 * 60 * 1000

/**
 * Caducidad perezosa y persistente: marca `expirada` toda propuesta pendiente
 * anterior al umbral. Se llama antes de bloquear (crear), listar, ver,
 * decidir, confirmar y ejecutar —sin jobs ni cron—: la primera
 * lectura/escritura que consolida (sin error posterior) persiste la
 * caducidad, y el filtro por tiempo (`createdAt` reciente) impide que una
 * propuesta vieja bloquee aunque su fila aún no se haya marcado.
 */
async function expireDueProposals(tx: Db, orgId: string, conversationId?: string): Promise<void> {
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
      "Acción inválida (reservar_cita|reprogramar_cita|cancelar_cita|enviar_mensaje|mover_oportunidad|crear_oportunidad|actualizar_seguimiento|cerrar_oportunidad)",
    )
  }
}

function assertAutonomyAction(action: string): asserts action is AutonomyAction {
  if (!(AUTONOMY_ACTIONS as readonly string[]).includes(action)) {
    throw validation("Acción de autonomía inválida")
  }
}

function assertMode(mode: string): asserts mode is AutonomyMode {
  if (!(AUTONOMY_MODES as readonly string[]).includes(mode)) {
    throw validation("Modo inválido (directo|confirmar_usuario|aprobar_equipo)")
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

export type AutonomyPolicy = Record<AutonomyAction, AutonomyMode>

export async function getAutonomyPolicy(tx: Db, orgId: string): Promise<AutonomyPolicy> {
  const [row] = await tx.select().from(agentPolicy).where(eq(agentPolicy.organizationId, orgId)).limit(1)
  const modes = (row?.modes ?? {}) as Partial<Record<AutonomyAction, AutonomyMode>>
  const out = { ...DEFAULT_AUTONOMY_MODES }
  for (const action of AUTONOMY_ACTIONS) {
    const mode = modes[action]
    if (mode !== undefined) {
      assertMode(mode)
      out[action] = mode
    }
  }
  return out
}

export async function updateAutonomyPolicy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: Partial<Record<AutonomyAction, AutonomyMode>>,
): Promise<AutonomyPolicy> {
  const patch: Partial<Record<AutonomyAction, AutonomyMode>> = {}
  for (const [rawAction, mode] of Object.entries(input)) {
    assertAutonomyAction(rawAction)
    if (mode === undefined) continue
    assertMode(mode)
    patch[rawAction as AutonomyAction] = mode
  }
  const current = await getAutonomyPolicy(tx, orgId)
  const merged = { ...current, ...patch }
  await tx
    .insert(agentPolicy)
    .values({ organizationId: orgId, modes: merged, updatedBy: actorUserId })
    .onConflictDoUpdate({ target: agentPolicy.organizationId, set: { modes: merged, updatedBy: actorUserId, updatedAt: new Date() } })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.policy_updated",
    entity: "agent_policy",
    entityId: orgId,
    metadata: patch,
  })
  return merged
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
    dentistName: string
  }>
  budgets: Array<{ number: number; title: string; status: string }>
  /** null = el interlocutor no tiene facultad económica. */
  balance: Array<{ currency: string; outstandingCents: number }> | null
}

/**
 * Resumen mínimo del paciente según la facultad del interlocutor, sin leer
 * historia clínica: próximas citas y estado de presupuestos para
 * self/representante/autorizado; saldo solo para self, representante legal o
 * responsable económico vigente. Siempre del paciente verificado, nunca de
 * otro.
 */
export async function getAgentPatientSummary(
  tx: Db,
  orgId: string,
  contactId: string,
  patientId: string,
): Promise<AgentPatientSummary> {
  const context = await resolveAgentPatientContext(tx, orgId, contactId, patientId)
  const now = new Date()
  const appointments = await tx
    .select({
      appointmentId: appointment.id,
      version: appointment.version,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      branchName: branch.name,
      branchTimezone: branch.timezone,
      dentistName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.dentistUserId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(3)
  const budgetRows = await tx
    .select({
      number: treatmentBudget.budgetNumber,
      title: treatmentBudget.title,
      status: treatmentBudget.status,
    })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.patientId, patientId)))
    .orderBy(desc(treatmentBudget.budgetNumber))
    .limit(3)
  let balance: AgentPatientSummary["balance"] = null
  const maySeeBalance =
    context.authorization === "self" ||
    context.authorization === "representante_legal" ||
    (await hasEconomicRole(tx, orgId, patientId, contactId))
  if (maySeeBalance) {
    const full = await getPatientBalanceForPortal(tx, orgId, patientId)
    balance = full.byCurrency.map((b) => ({ currency: b.currency, outstandingCents: b.outstandingCents }))
  }
  return {
    context,
    upcomingAppointments: appointments.map((a) => ({
      appointmentId: a.appointmentId,
      version: a.version,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      branchName: a.branchName,
      branchTimezone: a.branchTimezone,
      dentistName: a.dentistName,
    })),
    budgets: budgetRows,
    balance,
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

/* ---------- Disponibilidad (delegada en Agenda) ---------- */

export interface FreeGapInput {
  from: string
  to: string
  durationMin: number
  branchId?: string
  dentistUserId?: string
  chairId?: string
  serviceId?: string
}

export interface FreeGap {
  startsAt: string
  endsAt: string
  dentistUserId: string
  chairId: string | null
}

export interface FreeGapResult {
  gaps: FreeGap[]
  truncated: boolean
  timeZone: string
}

/**
 * Huecos libres según Agenda (`listAvailableSlots`): respeta horario semanal
 * del profesional, bloqueos y citas ocupantes. Sin horario configurado no hay
 * huecos (el agente debe decirlo, no inventarlos). Si `truncated`, acota el
 * rango o pagina por días.
 */
export async function findFreeGaps(tx: Db, orgId: string, input: FreeGapInput): Promise<FreeGapResult> {
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw validation("Rango de búsqueda inválido")
  }
  if (to.getTime() - from.getTime() > 8 * 24 * 60 * 60 * 1000) {
    throw validation("El rango máximo de búsqueda es 8 días")
  }
  const durationMin = Math.floor(input.durationMin)
  if (!Number.isInteger(durationMin) || durationMin < 10 || durationMin > 480) {
    throw validation("durationMin debe ser entero entre 10 y 480")
  }
  if (!input.branchId?.trim()) throw validation("branchId es obligatoria para buscar huecos")
  const { slots, truncated, timeZone } = await listAvailableSlots(tx, orgId, {
    branchId: input.branchId,
    dentistUserId: input.dentistUserId,
    chairId: input.chairId,
    serviceId: input.serviceId,
    from: from.toISOString(),
    to: to.toISOString(),
    durationMin,
  })
  return {
    gaps: slots.slice(0, 20).map((s) => ({
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      dentistUserId: s.dentistUserId,
      chairId: s.chairId,
    })),
    truncated: truncated || slots.length > 20,
    timeZone,
  }
}

/* ---------- Propuestas y aprobaciones ---------- */

export interface ProposalContext {
  contactName: string | null
  patientName: string | null
  channel: string | null
  branchName: string | null
  dentistName: string | null
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
  conversationId: string | null
  contactId: string | null
  action: ProposalAction
  /** Modo vigente de la política para este acto (lo que la UI puede ofrecer). */
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

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value)
}

/** Etiqueta operativa del acto: fallback de afterSummary si el legado no trae evidencia. */
const PROPOSAL_ACTION_LABEL: Record<ProposalAction, string> = {
  reservar_cita: "Reservar cita",
  reprogramar_cita: "Reprogramar cita",
  cancelar_cita: "Cancelar cita",
  enviar_mensaje: "Enviar mensaje",
  mover_oportunidad: "Mover oportunidad",
  crear_oportunidad: "Crear oportunidad",
  actualizar_seguimiento: "Actualizar seguimiento",
  cerrar_oportunidad: "Cerrar oportunidad",
}

async function stageNamesById(tx: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const stages = await tx
    .select({ id: pipelineStage.id, name: pipelineStage.name })
    .from(pipelineStage)
    .where(inArray(pipelineStage.id, ids))
  return new Map(stages.map((s) => [s.id, s.name]))
}

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
  action: ProposalAction,
  payload: Record<string, unknown>,
  zone: Pick<OrgLocale, "timezone" | "locale">,
): Promise<string> {
  const label = PROPOSAL_ACTION_LABEL[action]
  if (action === "enviar_mensaje") {
    const text = payload["kind"] === "text" || payload["text"] ? payloadText(payload["text"]) : null
    const name = typeof payload["name"] === "string" ? payload["name"] : null
    return text ?? (name ? `Plantilla ${name}` : label)
  }
  if (action === "mover_oportunidad") {
    const stages = await stageNamesById(tx, isUuid(payload["stageId"]) ? [payload["stageId"]] : [])
    const to = typeof payload["stageId"] === "string" ? stages.get(payload["stageId"]) : undefined
    return to ? `Etapa destino: ${to}` : label
  }
  if (action === "crear_oportunidad") {
    const title = payloadText(payload["title"], 80)
    return title ? `Nueva oportunidad: ${title}` : label
  }
  if (action === "actualizar_seguimiento") {
    const line = [payloadText(payload["nextActionNote"]), payloadDate(payload["nextActionAt"], zone)]
      .filter(Boolean)
      .join(" · ")
    return line ? `Nuevo seguimiento: ${line}` : label
  }
  if (action === "cerrar_oportunidad") {
    const outcome = payload["outcome"] === "won" ? "Ganada" : payload["outcome"] === "lost" ? "Perdida" : null
    const reasonText = payloadText(payload["reason"], 80)
    return outcome ? `${outcome}${reasonText ? `: ${reasonText}` : ""}` : label
  }
  const startsAt = payloadDate(payload["startsAt"], zone)
  const appointmentId = typeof payload["appointmentId"] === "string" ? payload["appointmentId"].slice(0, 8) : null
  const line = [startsAt, appointmentId ? `cita ${appointmentId}…` : null].filter(Boolean).join(" · ")
  return line || label
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
  if (action !== "mover_oportunidad" && action !== "actualizar_seguimiento" && action !== "cerrar_oportunidad") {
    return null
  }
  const opp = await contactOpportunityOrNull(tx, orgId, contactId, payload["opportunityId"])
  if (!opp) return null
  if (action === "mover_oportunidad" || action === "cerrar_oportunidad") {
    const stages = await stageNamesById(tx, [opp.stageId])
    const name = stages.get(opp.stageId)
    if (!name) return null
    return action === "mover_oportunidad" ? `Etapa actual: ${name}` : `Abierta en etapa: ${name}`
  }
  const line = [payloadText(opp.nextActionNote), payloadDate(opp.nextActionAt, zone)].filter(Boolean).join(" · ")
  return line ? `Seguimiento actual: ${line}` : null
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
}

function expectedOf(row: ProposalRow): ExpectedProposalState | null {
  const raw: unknown = row.expectedState
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const textKeys = ["opportunityId", "appointmentId"] as const
  const nullableTextKeys = ["stageId", "status", "nextActionAt", "nextActionNote", "appointmentStatus"] as const
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
  const version = candidate["appointmentVersion"]
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
    const opp = await nullIfNotFound(getOpportunity(tx, orgId, payload["opportunityId"] as string))
    if (!opp || opp.contactId !== contactId) return null
    // Sin 'Abierta' fija en la evidencia: el estado ya cerrado se rechaza al
    // crear en vez de congelar un antes falso.
    if (opp.status !== "open") throw validation(`La oportunidad ya está ${opp.status}`)
    return {
      opportunityId: opp.id,
      stageId: opp.stageId,
      status: opp.status,
      nextActionAt: opp.nextActionAt,
      nextActionNote: opp.nextActionNote,
    }
  }
  if ((action === "reprogramar_cita" || action === "cancelar_cita") && typeof payload["appointmentId"] === "string") {
    const current = await nullIfNotFound(getAppointment(tx, orgId, payload["appointmentId"] as string))
    if (!current) return null
    return { appointmentId: current.id, appointmentVersion: current.version, appointmentStatus: current.status }
  }
  return null
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
    return line ? `Seguimiento actual: ${line}` : "Sin seguimiento programado"
  }
  const stage = stageName ?? `etapa ${live.stageId.slice(0, 8)}…`
  return live.status === "open" ? `Etapa actual: ${stage}` : `Cerrada (${live.status}): ${stage}`
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
  if (live.status !== "open") return { isStale: true, currentSummary, reason: `la oportunidad ya está ${live.status}` }
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
    return { isStale: true, currentSummary, reason: "el seguimiento cambió desde la propuesta" }
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
  const currentSummary = `Cita actual: ${payloadDate(live.startsAt, zone) ?? live.startsAt.toISOString()} (${live.status})`
  const version = expected?.appointmentVersion ?? payloadExpectedVersion
  if (version != null && live.version !== version) {
    return { isStale: true, currentSummary, reason: "la cita cambió desde la propuesta" }
  }
  if (live.status !== "programada" && live.status !== "confirmada") {
    return { isStale: true, currentSummary, reason: `la cita ya está ${live.status}` }
  }
  return { isStale: false, currentSummary, reason: "" }
}


/**
 * Enriquece propuestas con el mismo contexto en todos los caminos
 * (listar, ver, crear, decidir, ejecutar, confirmar). Consultas por lote en
 * la misma tx: sin anidar contextos RLS y sin cortes mudos.
 */
async function enrichProposals(tx: Db, orgId: string, rows: ProposalRow[]): Promise<ProposalItem[]> {
  const policy = await getAutonomyPolicy(tx, orgId)
  const zone = await getOrgLocale(tx, orgId)
  const contactIds = new Set<string>()
  const conversationIds = new Set<string>()
  const opportunityIds = new Set<string>()
  const patientIds = new Set<string>()
  const branchIds = new Set<string>()
  const userIds = new Set<string>()
  const appointmentIds = new Set<string>()
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
    const apptId = payload["appointmentId"] ?? expected?.appointmentId
    if (isUuid(apptId)) appointmentIds.add(apptId)
    for (const key of ["patientId"] as const) {
      const id = payload[key] ?? result[key]
      if (isUuid(id)) patientIds.add(id)
    }
    if (isUuid(payload["branchId"])) branchIds.add(payload["branchId"])
    if (isUuid(payload["dentistUserId"])) userIds.add(payload["dentistUserId"])
  }
  const [contacts, convs, opps, appts, patients, branches, users] = await Promise.all([
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
            nextActionAt: opportunity.nextActionAt,
            nextActionNote: opportunity.nextActionNote,
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
      ? tx.select({ id: patient.id, displayName: patient.displayName }).from(patient).where(inArray(patient.id, [...patientIds]))
      : [],
    branchIds.size
      ? tx.select({ id: branch.id, name: branch.name }).from(branch).where(inArray(branch.id, [...branchIds]))
      : [],
    userIds.size
      ? tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, [...userIds]))
      : [],
  ])
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
          await summarizeAfter(tx, row.action as ProposalAction, row.payload as Record<string, unknown>, zone),
        )
      }),
  )
  return rows.map((row) => {
    const action = row.action as ProposalAction
    const payload = row.payload as Record<string, unknown>
    const result = (row.result ?? {}) as Record<string, unknown>
    const oppId = [payload["opportunityId"], result["opportunityId"], result["createdOpportunityId"]].find(
      (v): v is string => typeof v === "string" && !!v,
    )
    const opp = oppId ? oppById.get(oppId) : undefined
    const patientId = [payload["patientId"], result["patientId"], opp?.patientId].find(
      (v): v is string => typeof v === "string" && !!v,
    )
    const connectionId = row.conversationId ? connectionByConv.get(row.conversationId) : undefined
    const expected = expectedOf(row)
    let isStale = false
    let currentSummary: string | null = null
    const touchesState =
      action === "mover_oportunidad" ||
      action === "actualizar_seguimiento" ||
      action === "cerrar_oportunidad" ||
      action === "reprogramar_cita" ||
      action === "cancelar_cita"
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
      const apptId = payload["appointmentId"] ?? expected?.appointmentId
      const live = typeof apptId === "string" ? apptById.get(apptId) : undefined
      const payloadVersion = typeof payload["expectedVersion"] === "number" ? (payload["expectedVersion"] as number) : null
      const fresh = apptFreshness(expected, payloadVersion, live ?? null, zone)
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
      !expected?.appointmentId
    ) {
      isStale = true
    }
    return baseProposal(row, policy[action] ?? "aprobar_equipo", {
      contactName: row.contactId ? (contactById.get(row.contactId) ?? null) : null,
      patientName: patientId ? (patientById.get(patientId) ?? null) : null,
      channel: connectionId ? (channelByConnection.get(connectionId) ?? null) : null,
      branchName:
        typeof payload["branchId"] === "string" ? (branchById.get(payload["branchId"] as string) ?? null) : null,
      dentistName:
        typeof result["dentistName"] === "string"
          ? (result["dentistName"] as string)
          : typeof payload["dentistUserId"] === "string"
            ? (userById.get(payload["dentistUserId"] as string) ?? null)
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
    if (typeof payload["patientId"] !== "string" || !payload["patientId"]) throw validation("patientId es obligatorio")
    if (typeof payload["dentistUserId"] !== "string" || !payload["dentistUserId"]) throw validation("dentistUserId es obligatorio")
    if (typeof payload["chairId"] !== "string" || !payload["chairId"]) throw validation("chairId es obligatorio")
    if (typeof payload["startsAt"] !== "string" || Number.isNaN(Date.parse(payload["startsAt"]))) throw validation("startsAt inválido")
    return
  }
  if (action === "reprogramar_cita" || action === "cancelar_cita") {
    if (typeof payload["appointmentId"] !== "string" || !payload["appointmentId"]) throw validation("appointmentId es obligatorio")
    if (action === "reprogramar_cita") {
      if (typeof payload["startsAt"] !== "string" || Number.isNaN(Date.parse(payload["startsAt"]))) throw validation("startsAt inválido")
      if (typeof payload["expectedVersion"] !== "number") throw validation("expectedVersion es obligatorio")
    }
    return
  }
  if (action === "enviar_mensaje") {
    // Secretos del proveedor NUNCA en el payload: solo texto o plantilla validada.
    if (payload["secretsKey"] !== undefined || payload["accessToken"] !== undefined || payload["botToken"] !== undefined) {
      throw validation("El payload no debe incluir secretos del proveedor")
    }
    const kind = payload["kind"]
    if (kind === "text" || (kind === undefined && typeof payload["text"] === "string")) {
      if (typeof payload["text"] !== "string" || !payload["text"].trim() || payload["text"].length > 4000) {
        throw validation("text debe tener 1–4000 caracteres")
      }
      return
    }
    if (kind === "template") {
      if (typeof payload["name"] !== "string" || !payload["name"].trim() || payload["name"].length > 120) {
        throw validation("name de plantilla inválido")
      }
      if (typeof payload["language"] !== "string" || !payload["language"].trim() || payload["language"].length > 20) {
        throw validation("language de plantilla inválido")
      }
      if (payload["params"] !== undefined) {
        if (!Array.isArray(payload["params"]) || payload["params"].some((p) => typeof p !== "string" || p.length > 500)) {
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
    if (typeof payload["title"] !== "string" || !payload["title"].trim() || payload["title"].length > 200) {
      throw validation("title debe tener 1–200 caracteres")
    }
    uuidField(payload, "stageId", "stageId", true)
    uuidField(payload, "pipelineId", "pipelineId", true)
    uuidField(payload, "patientId", "patientId", true)
    if (payload["interestText"] !== undefined && (typeof payload["interestText"] !== "string" || payload["interestText"].length > 500)) {
      throw validation("interestText supera 500 caracteres")
    }
    if (payload["amountCents"] !== undefined && (typeof payload["amountCents"] !== "number" || payload["amountCents"] < 0)) {
      throw validation("amountCents inválido")
    }
    if (payload["nextActionAt"] !== undefined && payload["nextActionAt"] !== null) {
      if (typeof payload["nextActionAt"] !== "string" || Number.isNaN(Date.parse(payload["nextActionAt"]))) {
        throw validation("nextActionAt inválido")
      }
    }
    if (payload["nextActionNote"] !== undefined && payload["nextActionNote"] !== null) {
      if (typeof payload["nextActionNote"] !== "string" || payload["nextActionNote"].length > 500) {
        throw validation("nextActionNote supera 500 caracteres")
      }
    }
    return
  }
  if (action === "actualizar_seguimiento") {
    uuidField(payload, "opportunityId", "opportunityId")
    if (payload["nextActionAt"] === undefined && payload["nextActionNote"] === undefined) {
      throw validation("Indica nextActionAt o nextActionNote para el seguimiento")
    }
    if (payload["nextActionAt"] !== undefined && payload["nextActionAt"] !== null) {
      if (typeof payload["nextActionAt"] !== "string" || Number.isNaN(Date.parse(payload["nextActionAt"]))) {
        throw validation("nextActionAt inválido")
      }
    }
    if (payload["nextActionNote"] !== undefined && payload["nextActionNote"] !== null) {
      if (typeof payload["nextActionNote"] !== "string" || payload["nextActionNote"].length > 500) {
        throw validation("nextActionNote supera 500 caracteres")
      }
    }
    return
  }
  uuidField(payload, "opportunityId", "opportunityId")
  if (payload["outcome"] !== "won" && payload["outcome"] !== "lost") throw validation("outcome debe ser won|lost")
  if (typeof payload["reason"] !== "string" || !payload["reason"].trim() || payload["reason"].length > 500) {
    throw validation("reason debe tener 1–500 caracteres")
  }
}

/**
 * Crea una propuesta idempotente por clave. Si la política del acto es
 * `directo`, se ejecuta en el mismo acto; si exige confirmación o
 * aprobación, queda en `propuesta` y avisa al equipo cuando corresponde.
 * Congela la evidencia (before/after) y el estado vivo esperado tras validar
 * el payload: ningún camino posterior los reescribe. Solo una propuesta
 * comercial pendiente por conversación; los mensajes (`enviar_mensaje`)
 * fluyen siempre bajo su propia política y confirmación inequívoca (sin
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
  const [lockedConv] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .for("update")
    .limit(1)
  if (!lockedConv) throw notFound("Conversación")
  const conv = lockedConv
  // Caducidad perezosa antes de bloquear: las propuestas viejas no frenan el hilo.
  await expireDueProposals(tx, orgId, input.conversationId)
  const [sameKey] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.idempotencyKey, key)))
    .limit(1)
  if (sameKey) {
    if (sameKey.status !== "rechazada" && sameKey.status !== "fallida" && sameKey.status !== "expirada") {
      return enrichProposal(tx, orgId, sameKey)
    }
    finalKey = `${key.slice(0, 100)}:r${Date.now().toString(36)}`
  }
  const policy = await getAutonomyPolicy(tx, orgId)
  const mode = policy[input.action]
  if (!sameKey) {
    // Solo una propuesta comercial pendiente y vigente por conversación, y
    // solo una esperando confirmación del interlocutor por hilo: un mismo
    // «sí» no puede autorizar dos propuestas distintas. Los mensajes en modo
    // directo o con aprobación del equipo coexisten siempre.
    const pendings = await tx
      .select({ action: agentProposal.action })
      .from(agentProposal)
      .where(
        and(
          eq(agentProposal.organizationId, orgId),
          eq(agentProposal.conversationId, input.conversationId),
          eq(agentProposal.status, "propuesta"),
          gt(agentProposal.createdAt, new Date(Date.now() - CONFIRM_TTL_MS)),
        ),
      )
      .limit(100)
    const pendingModes = pendings.map((p) => policy[p.action as ProposalAction] ?? "aprobar_equipo")
    if (mode === "confirmar_usuario" && pendingModes.includes("confirmar_usuario")) {
      throw new ServiceError(
        "PROPOSAL_PENDING_CONFIRM",
        409,
        "Hay una propuesta esperando la confirmación del interlocutor en este hilo; resuélvela primero",
      )
    }
    const pendingCommercial = pendings.find((p) => p.action !== "enviar_mensaje")
    if (input.action !== "enviar_mensaje" && pendingCommercial) {
      const awaitingContact = policy[pendingCommercial.action as ProposalAction] === "confirmar_usuario"
      throw new ServiceError(
        awaitingContact ? "PROPOSAL_PENDING_CONFIRM" : "PROPOSAL_PENDING_APPROVAL",
        409,
        awaitingContact
          ? "Hay una propuesta esperando la confirmación del interlocutor en este hilo; resuélvela primero"
          : "Hay una propuesta pendiente de decisión del equipo en esta conversación; el equipo debe decidirla antes de crear otra",
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
  const afterSnapshot = await summarizeAfter(tx, input.action, input.payload, zone)
  const expectedSnapshot = conv.contactId
    ? await captureExpectedState(tx, orgId, input.action, input.payload, conv.contactId)
    : null
  try {
    const [row] = await tx
      .insert(agentProposal)
      .values({
        organizationId: orgId,
        conversationId: input.conversationId,
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
        status: mode === "directo" ? "aprobada" : "propuesta",
        decidedBy: mode === "directo" ? input.actorUserId ?? "agent" : null,
        decidedAt: mode === "directo" ? new Date() : null,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear la propuesta")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: input.actorUserId ?? null,
      action: "agent.proposal_created",
      entity: "agent_proposal",
      entityId: row.id,
      metadata: { action: input.action, conversationId: input.conversationId, reason },
    })
    await notify(tx, { orgId, kind: "agent.proposal.created", at: new Date().toISOString() })
    if (mode === "directo") {
      return executeProposal(tx, orgId, input.actorUserId ?? "agent", row.id, { secretsKey: input.secretsKey })
    }
    const created = await enrichProposal(tx, orgId, row)
    if (mode === "aprobar_equipo") {
      await notifyApprovers(tx, orgId, created)
    }
    return created
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
    if (!["propuesta", "aprobada", "rechazada", "ejecutada", "fallida", "expirada"].includes(input.status)) {
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

/**
 * Decisión del equipo. Aprobar ejecuta el acto (idempotente) y devuelve el
 * resultado real: `ejecutada` o `fallida` (HTTP 200; la UI distingue por
 * `status` y muestra `error`/`context.currentSummary`). Rechazar la cierra
 * con motivo. Una propuesta vencida se devuelve `expirada` (HTTP 200, sin
 * reintento), nunca ejecuta. En modo `confirmar_usuario` el equipo no
 * aprueba y ejecuta: la confirmación explícita del paciente va por
 * `/confirm` con su evidencia en el chat. El UPDATE es condicional al estado
 * `propuesta`: si otra vía ya la movió (incluso a `ejecutada`), se responde
 * 409 sin reescribir.
 */
export async function decideProposal(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { decision: "aprobada" | "rechazada"; reason?: unknown },
  opts: { secretsKey?: Buffer } = {},
): Promise<ProposalItem> {
  const expired = await takeExpiredProposal(tx, orgId, actorUserId, id)
  if (expired) return expired
  const current = await requireProposal(tx, orgId, id)
  if (current.status !== "propuesta") {
    throw new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${current.status}`)
  }
  const reason = cleanReason(input.reason)
  if (input.decision === "rechazada") {
    const [row] = await tx
      .update(agentProposal)
      .set({ status: "rechazada", reason: reason ?? current.reason, decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(agentProposal.id, id), eq(agentProposal.status, "propuesta")))
      .returning()
    if (!row) throw await pendingConflict(tx, orgId, id)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "agent.proposal_rejected",
      entity: "agent_proposal",
      entityId: id,
      metadata: { reason: reason ?? current.reason },
    })
    await notify(tx, { orgId, kind: "agent.proposal.decided", at: new Date().toISOString() })
    return enrichProposal(tx, orgId, row)
  }
  const policy = await getAutonomyPolicy(tx, orgId)
  if (policy[current.action as ProposalAction] === "confirmar_usuario") {
    throw new ServiceError(
      "PROPOSAL_NEEDS_CONTACT_CONFIRM",
      409,
      "Esta propuesta exige confirmación explícita del paciente en el chat; usa el registro de confirmación, no la aprobación del equipo",
    )
  }
  const [row] = await tx
    .update(agentProposal)
    .set({ status: "aprobada", reason: reason ?? current.reason, decidedBy: actorUserId, decidedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentProposal.id, id), eq(agentProposal.status, "propuesta")))
    .returning()
  if (!row) throw await pendingConflict(tx, orgId, id)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.proposal_approved",
    entity: "agent_proposal",
    entityId: id,
    metadata: { reason: reason ?? current.reason },
  })
  await notify(tx, { orgId, kind: "agent.proposal.decided", at: new Date().toISOString() })
  return executeProposal(tx, orgId, actorUserId, id, opts)
}

async function pendingConflict(tx: Db, orgId: string, id: string): Promise<ServiceError> {
  const fresh = await requireProposal(tx, orgId, id)
  return new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${fresh.status}`)
}

/**
 * Confirmación del interlocutor en el chat (solo modo `confirmar_usuario`
 * vigente). Evidencia estricta y ligada a la propuesta: un mensaje entrante
 * posterior a ESTA propuesta cuyo texto completo sea una afirmación (sin
 * negaciones ni preguntas). El mensaje que confirma queda en la auditoría.
 * Los modos `aprobar_equipo` y `directo` no aceptan confirmación del contacto:
 * el sí del interlocutor jamás autoriza un acto del equipo. Si la política
 * se endureció tras crear la propuesta, la vigente manda.
 * Vencida a las 48h: se devuelve `expirada` (HTTP 200, sin
 * reintento), nunca update+throw. El staff que confirma desde consola queda
 * auditado. Devuelve `ejecutada`, `fallida` o `expirada` (HTTP 200; ver
 * `decideProposal`).
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
  const policy = await getAutonomyPolicy(tx, orgId)
  const effectiveMode = policy[current.action as ProposalAction] ?? "aprobar_equipo"
  if (effectiveMode !== "confirmar_usuario") {
    throw new ServiceError(
      effectiveMode === "aprobar_equipo" ? "PROPOSAL_NEEDS_TEAM_APPROVAL" : "PROPOSAL_NOT_CONTACT_CONFIRMABLE",
      409,
      effectiveMode === "directo"
        ? "Esta propuesta es de ejecución directa; no se confirma con el sí del interlocutor"
        : "Esta propuesta exige aprobación del equipo; el sí del interlocutor no la ejecuta",
    )
  }
  let confirmationId: string | null = null
  if (current.conversationId) {
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
    confirmationId = confirmation.id
  }
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
  return live
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
  const action = locked.action as ProposalAction
  const payload = locked.payload
  const expected = expectedOf(locked)
  const zone = await getOrgLocale(tx, orgId)
  // Solo un userId real va a las auditorías de negocio; el resto de la
  // autoridad (agent/contact/staff) queda en decidedBy y en el audit del acto.
  const teamUserId = /^[0-9a-f-]{36}$/i.test(actorUserId) ? actorUserId : null
  // Los efectos corren tras un savepoint: si fallan, se deshacen los
  // parciales pero la marca `fallida` sí persiste en la tx exterior.
  await tx.execute(sql.raw("SAVEPOINT sp_proposal_exec"))
  let executed: ProposalRow
  try {
    let result: Record<string, unknown>
    if (action === "reservar_cita") {
      const patientId = payload["patientId"] as string
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, patientId)
      } else {
        await requirePatient(tx, orgId, patientId)
      }
      const created = await createAppointment(tx, orgId, actorUserId, {
        branchId: typeof payload["branchId"] === "string" ? (payload["branchId"] as string) : undefined,
        patientId,
        dentistUserId: payload["dentistUserId"] as string,
        chairId: payload["chairId"] as string,
        serviceId: typeof payload["serviceId"] === "string" ? (payload["serviceId"] as string) : undefined,
        startsAt: payload["startsAt"] as string,
        endsAt: typeof payload["endsAt"] === "string" ? (payload["endsAt"] as string) : undefined,
        durationMin: typeof payload["durationMin"] === "number" ? (payload["durationMin"] as number) : undefined,
        reason: typeof payload["reason"] === "string" ? (payload["reason"] as string) : undefined,
        source: "agent",
        conversationId: locked.conversationId ?? undefined,
      })
      result = { appointmentId: created.id, startsAt: created.startsAt, dentistName: created.dentistName }
    } else if (action === "reprogramar_cita") {
      const appointmentId = payload["appointmentId"] as string
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
          `Cita actual: ${payloadDate(liveAppt.startsAt, zone) ?? liveAppt.startsAt.toISOString()} (${liveAppt.status})`,
        )
      }
      const fresh = apptFreshness(
        expected,
        typeof payload["expectedVersion"] === "number" ? (payload["expectedVersion"] as number) : null,
        { version: liveAppt.version, status: liveAppt.status, startsAt: liveAppt.startsAt },
        zone,
      )
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      const moved = await moveAppointment(tx, orgId, actorUserId, appointmentId, {
        expectedVersion: payload["expectedVersion"] as number,
        startsAt: payload["startsAt"] as string,
        endsAt: typeof payload["endsAt"] === "string" ? (payload["endsAt"] as string) : undefined,
        dentistUserId: typeof payload["dentistUserId"] === "string" ? (payload["dentistUserId"] as string) : undefined,
        chairId: typeof payload["chairId"] === "string" ? (payload["chairId"] as string) : undefined,
      })
      result = { appointmentId: moved.id, startsAt: moved.startsAt }
    } else if (action === "cancelar_cita") {
      const appointmentId = payload["appointmentId"] as string
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
          `Cita actual: ${payloadDate(liveAppt.startsAt, zone) ?? liveAppt.startsAt.toISOString()} (${liveAppt.status})`,
        )
      }
      const fresh = apptFreshness(expected, null, {
        version: liveAppt.version,
        status: liveAppt.status,
        startsAt: liveAppt.startsAt,
      }, zone)
      if (fresh.isStale) throw staleError(fresh.reason, fresh.currentSummary)
      const cancelled = await setAppointmentStatus(tx, orgId, actorUserId, appointmentId, "cancelada")
      result = { appointmentId: cancelled.id, status: cancelled.status }
    } else if (action === "enviar_mensaje") {
      if (!locked.conversationId) throw validation("La propuesta no tiene conversación asociada")
      if (payload["kind"] === "template") {
        if (!opts.secretsKey) throw validation("Falta la clave de secretos para ejecutar la plantilla")
        const sent = await sendTemplateOutbound(tx, orgId, opts.secretsKey, {
          conversationId: locked.conversationId,
          senderKind: "agent",
          senderUserId: teamUserId,
          name: payload["name"] as string,
          language: payload["language"] as string,
          params: Array.isArray(payload["params"]) ? (payload["params"] as string[]) : [],
        })
        result = { messageId: sent.id, kind: "template", name: payload["name"], language: payload["language"] }
      } else {
        const sent = await sendOutbound(tx, orgId, {
          conversationId: locked.conversationId,
          senderKind: "agent",
          senderUserId: teamUserId,
          content: { type: "text", text: payload["text"] as string },
        })
        result = { messageId: sent.id, kind: "text" }
      }
    } else if (action === "mover_oportunidad") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload["opportunityId"] as string
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
      const { detail } = await moveOpportunity(tx, orgId, opportunityId, payload["stageId"] as string, {
        userId: teamUserId,
      })
      result = { opportunityId, stageId: detail.stageId, stageName: detail.stageName }
    } else if (action === "crear_oportunidad") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const created = await createOpportunity(
        tx,
        orgId,
        {
          contactId: locked.contactId,
          title: payload["title"] as string,
          ...(typeof payload["pipelineId"] === "string" ? { pipelineId: payload["pipelineId"] as string } : {}),
          ...(typeof payload["stageId"] === "string" ? { stageId: payload["stageId"] as string } : {}),
          ...(typeof payload["patientId"] === "string" ? { patientId: payload["patientId"] as string } : {}),
          ...(typeof payload["serviceId"] === "string" ? { serviceId: payload["serviceId"] as string } : {}),
          ...(typeof payload["interestText"] === "string" ? { interestText: payload["interestText"] as string } : {}),
          ...(typeof payload["amountCents"] === "number" ? { amountCents: payload["amountCents"] as number } : {}),
          ...(typeof payload["currency"] === "string" ? { currency: payload["currency"] as string } : {}),
          ...(typeof payload["assignedUserId"] === "string" ? { assignedUserId: payload["assignedUserId"] as string } : {}),
          ...(payload["nextActionAt"] !== undefined ? { nextActionAt: payload["nextActionAt"] as string | null } : {}),
          ...(payload["nextActionNote"] !== undefined ? { nextActionNote: payload["nextActionNote"] as string | null } : {}),
          ...(typeof payload["budgetId"] === "string" ? { budgetId: payload["budgetId"] as string } : {}),
          ...(locked.conversationId ? { conversationId: locked.conversationId } : {}),
        },
        { userId: teamUserId },
      )
      result = {
        opportunityId: created.id,
        createdOpportunityId: created.id,
        title: created.title,
        stageId: created.stageId,
      }
    } else if (action === "actualizar_seguimiento") {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload["opportunityId"] as string
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
      const updated = await updateOpportunity(
        tx,
        orgId,
        opportunityId,
        {
          ...(payload["nextActionAt"] !== undefined ? { nextActionAt: payload["nextActionAt"] as string | null } : {}),
          ...(payload["nextActionNote"] !== undefined ? { nextActionNote: payload["nextActionNote"] as string | null } : {}),
        },
        { userId: teamUserId },
      )
      result = {
        opportunityId,
        nextActionAt: updated.nextActionAt,
        nextActionNote: updated.nextActionNote,
      }
    } else {
      if (!locked.contactId) throw validation("La propuesta no tiene contacto asociado")
      const opportunityId = payload["opportunityId"] as string
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
      const closed = await closeOpportunity(
        tx,
        orgId,
        opportunityId,
        { outcome: payload["outcome"] as "won" | "lost", reason: payload["reason"] as string },
        { userId: teamUserId },
      )
      result = { opportunityId, outcome: payload["outcome"], closedAt: closed.closedAt }
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
  assigneeUserId: string | null
  taskId: string | null
  /** Plazo de la tarea de seguimiento según la prioridad (visible en la cola). */
  dueAt: string | null
  createdBy: string
  createdAt: string
}

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
  if (taskIds.length) {
    const tasks = await tx
      .select({ id: crmTask.id, dueAt: crmTask.dueAt })
      .from(crmTask)
      .where(inArray(crmTask.id, taskIds))
    for (const t of tasks) if (t.dueAt) dueByTask.set(t.id, t.dueAt)
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
      assigneeUserId: row.assigneeUserId,
      taskId: row.taskId,
      dueAt: row.taskId ? (dueByTask.get(row.taskId)?.toISOString() ?? null) : null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

async function enrichHandoff(tx: Db, row: HandoffRow): Promise<HandoffItem> {
  const [item] = await enrichHandoffs(tx, [row])
  if (!item) throw new Error("No se pudo enriquecer la derivación")
  return item
}

async function teamUserIds(tx: Db, orgId: string): Promise<string[]> {
  // Quienes deciden propuestas (`agent.decide`): owner/admin más recepción
  // operativa. El aviso no lleva datos clínicos; solo título, acto y ruta.
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin", "reception"])))
    .limit(20)
  return rows.map((r) => r.userId)
}

async function notifyUsers(
  tx: Db,
  orgId: string,
  userIds: string[],
  input: { dedupeKey: string; title: string; body: string; href: string; permission: string },
) {
  for (const userId of [...new Set(userIds)]) {
    await createWorkspaceNotification(tx, orgId, {
      userId,
      dedupeKey: `${input.dedupeKey}:${userId}`,
      title: input.title,
      body: input.body,
      href: input.href,
      permission: input.permission,
    })
  }
}

async function notifyApprovers(tx: Db, orgId: string, proposal: ProposalItem) {
  const team = await teamUserIds(tx, orgId)
  if (!team.length) return
  await notifyUsers(tx, orgId, team, {
    dedupeKey: `agent-approval:${proposal.id}`,
    title: "El agente pide aprobación",
    body: `Acto ${proposal.action} pendiente de aprobación del equipo.`,
    href: "/agent/approvals",
    // Visible para quien decide (`agent.decide`, incl. recepción): la ruta
    // de avisos ya expone este permiso sin lectura general del agente.
    permission: "agent.decide",
  })
}

/**
 * Plazo de recogida/resolución de una derivación por prioridad (política
 * explícita de recepción): vencida, avisa al responsable o escala al equipo.
 */
const HANDOFF_DUE_HOURS: Record<HandoffPriority, number> = { alta: 4, media: 24, baja: 72 }

/**
 * Derivación con resumen factual, motivo, prioridad, responsable y tarea de
 * seguimiento. Apaga el agente en la conversación y avisa al responsable o
 * al equipo. Sin datos clínicos en el aviso.
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
  },
): Promise<HandoffItem> {
  const conv = await requireConversationInOrg(tx, orgId, input.conversationId)
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
    title: `Derivación (${priority}): ${reason}`.slice(0, 200),
    contactId: conv.contactId,
    conversationId: input.conversationId,
    assigneeUserId,
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
      assigneeUserId,
      taskId: task.id,
      createdBy,
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar la derivación")
  await setAgentStatus(tx, orgId, input.conversationId, false, actorUserId ?? undefined)
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "agent.handoff_created",
    entity: "agent_handoff",
    entityId: row.id,
    metadata: { priority, taskId: task.id, assigneeUserId },
  })
  const recipients = assigneeUserId ? [assigneeUserId] : await teamUserIds(tx, orgId)
  if (recipients.length) {
    await notifyUsers(tx, orgId, recipients, {
      dedupeKey: `agent-handoff:${row.id}`,
      title: "Derivación del agente",
      body: `Prioridad ${priority}: ${reason}`.slice(0, 200),
      href: `/inbox?conversation=${input.conversationId}&fallbackTask=${task.id}`,
      permission: "tasks.read",
    })
  }
  await notify(tx, { orgId, kind: "agent.handoff.created", at: new Date().toISOString() })
  return enrichHandoff(tx, row)
}

export async function listHandoffs(tx: Db, orgId: string, input: { conversationId?: string; limit?: number } = {}): Promise<HandoffItem[]> {
  // Escalamiento perezoso (mismo patrón que la caducidad de propuestas):
  // la primera lectura consolida el aviso de vencidas, sin jobs ni duplicados.
  await escalateOverdueHandoffs(tx, orgId)
  const conditions = [eq(agentHandoff.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentHandoff.conversationId, input.conversationId))
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const rows = await tx
    .select()
    .from(agentHandoff)
    .where(and(...conditions))
    .orderBy(desc(agentHandoff.createdAt), asc(agentHandoff.id))
    .limit(limit)
  return enrichHandoffs(tx, rows)
}

/**
 * Toma una derivación de la cola (sin responsable) de forma atómica: dos
 * miembros no pueden tomar el mismo caso (UPDATE condicional). La tarea
 * vinculada pasa al mismo responsable. Resolverla registra actor y resultado
 * por la vía de tareas; no reactiva el agente implícitamente.
 */
export async function claimHandoff(tx: Db, orgId: string, userId: string, handoffId: string): Promise<HandoffItem> {
  const [membership] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!membership) throw validation("Solo un miembro de la organización puede tomar la derivación")
  const [claimed] = await tx
    .update(agentHandoff)
    .set({ assigneeUserId: userId })
    .where(
      and(
        eq(agentHandoff.id, handoffId),
        eq(agentHandoff.organizationId, orgId),
        isNull(agentHandoff.assigneeUserId),
      ),
    )
    .returning()
  if (!claimed) {
    const [existing] = await tx
      .select({ assigneeUserId: agentHandoff.assigneeUserId })
      .from(agentHandoff)
      .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
      .limit(1)
    if (!existing) throw notFound("Derivación")
    if (existing.assigneeUserId === userId) {
      const [row] = await tx
        .select()
        .from(agentHandoff)
        .where(and(eq(agentHandoff.id, handoffId), eq(agentHandoff.organizationId, orgId)))
        .limit(1)
      return enrichHandoff(tx, row!)
    }
    throw new ServiceError("HANDOFF_ALREADY_CLAIMED", 409, "Otro miembro ya tomó esta derivación")
  }
  if (claimed.taskId) {
    await updateTask(tx, orgId, claimed.taskId, { assigneeUserId: userId, actorUserId: userId })
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: userId,
    action: "agent.handoff_claimed",
    entity: "agent_handoff",
    entityId: claimed.id,
    metadata: { taskId: claimed.taskId },
  })
  return enrichHandoff(tx, claimed)
}

/**
 * Vencimiento según el plazo por prioridad: avisa al responsable o escala al
 * equipo cuando la tarea de la derivación sigue abierta pasado su plazo. La
 * clave de dedupe hace el aviso una sola vez (no duplica tareas ni avisos).
 */
async function escalateOverdueHandoffs(tx: Db, orgId: string): Promise<void> {
  const overdue = await tx
    .select({
      id: agentHandoff.id,
      conversationId: agentHandoff.conversationId,
      reason: agentHandoff.reason,
      priority: agentHandoff.priority,
      assigneeUserId: agentHandoff.assigneeUserId,
      taskId: crmTask.id,
    })
    .from(agentHandoff)
    .innerJoin(crmTask, eq(crmTask.id, agentHandoff.taskId))
    .where(
      and(
        eq(agentHandoff.organizationId, orgId),
        eq(crmTask.status, "open"),
        lt(crmTask.dueAt, new Date()),
      ),
    )
    .limit(50)
  for (const row of overdue) {
    const recipients = row.assigneeUserId ? [row.assigneeUserId] : await teamUserIds(tx, orgId)
    if (!recipients.length) continue
    await notifyUsers(tx, orgId, recipients, {
      dedupeKey: `agent-handoff-overdue:${row.id}`,
      title: "Derivación vencida",
      body: `La derivación (prioridad ${row.priority}) superó su plazo sin resolverse: ${row.reason}`.slice(0, 200),
      href: row.conversationId
        ? `/inbox?conversation=${row.conversationId}&fallbackTask=${row.taskId}`
        : `/tasks?task=${row.taskId}`,
      permission: "tasks.read",
    })
  }
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
  /** Solo si el proveedor lo entrega, en micro-unidades enteras. */
  costMicros?: number | null
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
    costMicros: cleanInt(input.costMicros),
    toolsUsed: (input.toolsUsed ?? []).filter((t) => typeof t === "string").slice(0, 30),
    error: input.error?.slice(0, 500) ?? null,
  })
}

export async function listAgentRuns(
  tx: Db,
  orgId: string,
  input: { conversationId?: string; status?: string; limit?: number } = {},
) {
  const conditions = [eq(agentRunLedger.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentRunLedger.conversationId, input.conversationId))
  if (input.status) {
    if (!["ok", "handoff", "error", "omitida"].includes(input.status)) throw validation("status inválido")
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
    costMicros: r.costMicros,
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
  totalCostMicros: number | null
  topTools: Array<{ tool: string; uses: number }>
}

/** Métricas reales desde el libro (rango opcional ISO). */
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
      cost: sum(agentRunLedger.costMicros),
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
  const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : null
  }
  const byStatus: Record<string, number> = {}
  for (const row of byStatusRows) byStatus[row.status] = Number(row.total)
  return {
    total: Number(totals?.total ?? 0),
    byStatus,
    avgLatencyMs: totals?.avgLatency === null || totals?.avgLatency === undefined ? null : Math.round(Number(totals.avgLatency)),
    totalInputTokens: toNum(totals?.inputTokens),
    totalOutputTokens: toNum(totals?.outputTokens),
    totalCostMicros: toNum(totals?.cost),
    topTools: (toolRows as unknown as Array<{ tool: string; uses: number }>).map((r) => ({
      tool: r.tool,
      uses: Number(r.uses),
    })),
  }
}
