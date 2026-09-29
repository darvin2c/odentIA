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
import { conversation } from "@odentia/db/schema/crm"
import { patientResponsibility, treatmentBudget } from "@odentia/db/schema/clinical"
import { appointment } from "@odentia/db/schema/agenda"
import { and, asc, avg, count, desc, eq, gte, inArray, isNull, lte, or, sql, sum } from "drizzle-orm"
import { listAvailableSlots } from "./availability.js"
import {
  createAppointment,
  getAppointment,
  moveAppointment,
  setAppointmentStatus,
} from "./appointments.js"
import { listMessages, setAgentStatus } from "./conversations.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { listPatientsByContact, requirePatient } from "./patients.js"
import { requireLinkedActiveContact } from "./responsibilities.js"
import { createTask } from "./tasks.js"
import { createWorkspaceNotification } from "./workspace.js"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { getPatientBalanceForPortal } from "./finance.js"

/** Plazo de confirmación por el interlocutor antes de expirar la propuesta. */
const CONFIRM_TTL_HOURS = 48
/** Aviso en vivo para el stream del home (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

/**
 * Resumen corto del payload para las tarjetas del home.
 * Misma lógica que `payloadSummary` del frontend de aprobaciones.
 */
export function proposalPayloadSummary(payload: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof payload["startsAt"] === "string") {
    const date = new Date(payload["startsAt"])
    if (!Number.isNaN(date.getTime())) parts.push(date.toLocaleString("es-PE"))
  }
  if (typeof payload["appointmentId"] === "string") parts.push(`cita ${String(payload["appointmentId"]).slice(0, 8)}…`)
  return parts.join(" · ")
}

function assertAction(action: string): asserts action is ProposalAction {
  if (!(PROPOSAL_ACTIONS as readonly string[]).includes(action)) {
    throw validation("Acción inválida (reservar_cita|reprogramar_cita|cancelar_cita)")
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
    startsAt: string
    endsAt: string
    status: string
    branchName: string
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
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      branchName: branch.name,
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
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      branchName: a.branchName,
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

export interface ProposalItem {
  id: string
  conversationId: string | null
  contactId: string | null
  action: ProposalAction
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
}

function toProposal(row: typeof agentProposal.$inferSelect): ProposalItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    contactId: row.contactId,
    action: row.action as ProposalAction,
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
  }
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

function validatePayload(action: ProposalAction, payload: Record<string, unknown>): void {
  if (action === "reservar_cita") {
    if (typeof payload["patientId"] !== "string" || !payload["patientId"]) throw validation("patientId es obligatorio")
    if (typeof payload["dentistUserId"] !== "string" || !payload["dentistUserId"]) throw validation("dentistUserId es obligatorio")
    if (typeof payload["chairId"] !== "string" || !payload["chairId"]) throw validation("chairId es obligatorio")
    if (typeof payload["startsAt"] !== "string" || Number.isNaN(Date.parse(payload["startsAt"]))) throw validation("startsAt inválido")
  } else {
    if (typeof payload["appointmentId"] !== "string" || !payload["appointmentId"]) throw validation("appointmentId es obligatorio")
    if (action === "reprogramar_cita") {
      if (typeof payload["startsAt"] !== "string" || Number.isNaN(Date.parse(payload["startsAt"]))) throw validation("startsAt inválido")
      if (typeof payload["expectedVersion"] !== "number") throw validation("expectedVersion es obligatorio")
    }
  }
}

/**
 * Crea una propuesta idempotente por clave. Si la política del acto es
 * `directo`, se ejecuta en el mismo acto; si exige confirmación o
 * aprobación, queda en `propuesta` y avisa al equipo cuando corresponde.
 * Una sola propuesta pendiente por conversación (así la evidencia de
 * confirmación queda ligada a ella). El replay nunca consulta tras unique
 * violation (la tx queda abortada): pre-chequeo antes de insertar y 409
 * reintentable en carrera.
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
  const [sameKey] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.idempotencyKey, key)))
    .limit(1)
  if (sameKey) {
    if (sameKey.status !== "rechazada" && sameKey.status !== "fallida" && sameKey.status !== "expirada") {
      return toProposal(sameKey)
    }
    finalKey = `${key.slice(0, 100)}:r${Date.now().toString(36)}`
  }
  if (!sameKey) {
    const [pending] = await tx
      .select({ id: agentProposal.id })
      .from(agentProposal)
      .where(
        and(
          eq(agentProposal.organizationId, orgId),
          eq(agentProposal.conversationId, input.conversationId),
          eq(agentProposal.status, "propuesta"),
        ),
      )
      .limit(1)
    if (pending) {
      throw new ServiceError(
        "PROPOSAL_PENDING",
        409,
        "Hay una propuesta pendiente en esta conversación; confírmala o recházala primero",
      )
    }
  }
  try {
    const [row] = await tx
      .insert(agentProposal)
      .values({
        organizationId: orgId,
        conversationId: input.conversationId,
        contactId: conv.contactId,
        action: input.action,
        payload: input.payload,
        reason,
        idempotencyKey: finalKey,
        proposedBy,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear la propuesta")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: input.actorUserId ?? null,
      action: "agent.proposal_created",
      entity: "agent_proposal",
      entityId: row.id,
      metadata: { action: input.action, conversationId: input.conversationId },
    })
    await notify(tx, { orgId, kind: "agent.proposal.created", at: new Date().toISOString() })
    const policy = await getAutonomyPolicy(tx, orgId)
    const mode = policy[input.action]
    if (mode === "directo") {
      return executeProposal(tx, orgId, input.actorUserId ?? "agent", row.id)
    }
    if (mode === "aprobar_equipo") {
      await notifyApprovers(tx, orgId, toProposal(row))
    }
    return toProposal(row)
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

export async function getProposal(tx: Db, orgId: string, id: string): Promise<ProposalItem> {
  return toProposal(await requireProposal(tx, orgId, id))
}

export async function listProposals(
  tx: Db,
  orgId: string,
  input: { status?: string; conversationId?: string; limit?: number } = {},
): Promise<ProposalItem[]> {
  const conditions = [eq(agentProposal.organizationId, orgId)]
  if (input.status) {
    if (!["propuesta", "aprobada", "rechazada", "ejecutada", "fallida", "expirada"].includes(input.status)) {
      throw validation("status inválido")
    }
    conditions.push(eq(agentProposal.status, input.status))
  }
  if (input.conversationId) conditions.push(eq(agentProposal.conversationId, input.conversationId))
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const rows = await tx
    .select()
    .from(agentProposal)
    .where(and(...conditions))
    .orderBy(desc(agentProposal.createdAt), asc(agentProposal.id))
    .limit(limit)
  return rows.map(toProposal)
}

/**
 * Decisión del equipo. Aprobar ejecuta el acto (idempotente); rechazar la
 * cierra con motivo. El UPDATE es condicional al estado `propuesta`: si otra
 * vía ya la movió (incluso a `ejecutada`), se responde 409 sin reescribir.
 */
export async function decideProposal(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { decision: "aprobada" | "rechazada"; reason?: unknown },
): Promise<ProposalItem> {
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
      metadata: {},
    })
    await notify(tx, { orgId, kind: "agent.proposal.decided", at: new Date().toISOString() })
    return toProposal(row)
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
    metadata: {},
  })
  await notify(tx, { orgId, kind: "agent.proposal.decided", at: new Date().toISOString() })
  return executeProposal(tx, orgId, actorUserId, id)
}

async function pendingConflict(tx: Db, orgId: string, id: string): Promise<ServiceError> {
  const fresh = await requireProposal(tx, orgId, id)
  return new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${fresh.status}`)
}

/**
 * Confirmación del interlocutor en el chat (modo `confirmar_usuario`).
 * Evidencia estricta y ligada a la propuesta: como hay una sola propuesta
 * pendiente por conversación, basta un mensaje entrante posterior a ella cuyo
 * texto completo sea una afirmación (sin negaciones ni preguntas).
 * Expirada a las 48h. El staff que confirma desde consola queda auditado.
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
  opts: { staffUserId?: string | null } = {},
): Promise<ProposalItem> {
  const current = await requireProposal(tx, orgId, id)
  if (current.contactId !== contactId) throw notFound("Propuesta")
  if (current.status !== "propuesta") {
    throw new ServiceError("PROPOSAL_NOT_PENDING", 409, `La propuesta ya está ${current.status}`)
  }
  const ageMs = Date.now() - current.createdAt.getTime()
  if (ageMs > CONFIRM_TTL_HOURS * 60 * 60 * 1000) {
    await tx
      .update(agentProposal)
      .set({ status: "expirada", updatedAt: new Date() })
      .where(and(eq(agentProposal.id, id), eq(agentProposal.status, "propuesta")))
    throw new ServiceError("PROPOSAL_EXPIRED", 409, "La propuesta expiró; pide una nueva")
  }
  if (current.conversationId) {
    const { items } = await listMessages(tx, orgId, current.conversationId, { limit: 10 })
    const confirmed = items.some(
      (m) =>
        m.direction === "in" &&
        new Date(m.createdAt).getTime() >= current.createdAt.getTime() &&
        isAffirmative(m.body),
    )
    if (!confirmed) {
      throw new ServiceError(
        "PROPOSAL_NOT_CONFIRMED",
        409,
        "No hay confirmación explícita del paciente tras la propuesta",
      )
    }
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
    metadata: { via: opts.staffUserId ? "staff" : "contact" },
  })
  return executeProposal(tx, orgId, decidedBy, id)
}

/**
 * Ejecuta una propuesta aprobada. Idempotente: bloquea la fila y si ya está
 * `ejecutada` devuelve el resultado guardado sin volver a actuar.
 */
export async function executeProposal(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
): Promise<ProposalItem> {
  const [locked] = await tx
    .select()
    .from(agentProposal)
    .where(and(eq(agentProposal.organizationId, orgId), eq(agentProposal.id, id)))
    .for("update")
    .limit(1)
  if (!locked) throw notFound("Propuesta")
  if (locked.status === "ejecutada") return toProposal(locked)
  if (locked.status !== "aprobada") {
    throw new ServiceError("PROPOSAL_NOT_APPROVED", 409, "La propuesta no está aprobada")
  }
  const action = locked.action as ProposalAction
  const payload = locked.payload
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
      const current = await getAppointment(tx, orgId, appointmentId)
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, current.patientId)
      }
      const moved = await moveAppointment(tx, orgId, actorUserId, appointmentId, {
        expectedVersion: payload["expectedVersion"] as number,
        startsAt: payload["startsAt"] as string,
        endsAt: typeof payload["endsAt"] === "string" ? (payload["endsAt"] as string) : undefined,
        dentistUserId: typeof payload["dentistUserId"] === "string" ? (payload["dentistUserId"] as string) : undefined,
        chairId: typeof payload["chairId"] === "string" ? (payload["chairId"] as string) : undefined,
      })
      result = { appointmentId: moved.id, startsAt: moved.startsAt }
    } else {
      const appointmentId = payload["appointmentId"] as string
      const current = await getAppointment(tx, orgId, appointmentId)
      if (locked.contactId) {
        await resolveAgentPatientContext(tx, orgId, locked.contactId, current.patientId)
      }
      const cancelled = await setAppointmentStatus(tx, orgId, actorUserId, appointmentId, "cancelada")
      result = { appointmentId: cancelled.id, status: cancelled.status }
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
    await notify(tx, { orgId, kind: "agent.proposal.executed", at: new Date().toISOString() })
    return toProposal(row)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (error instanceof ServiceError) throw error
    const [row] = await tx
      .update(agentProposal)
      .set({ status: "fallida", error: detail.slice(0, 500), updatedAt: new Date() })
      .where(eq(agentProposal.id, id))
      .returning()
    if (!row) throw error
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "agent.proposal_failed",
      entity: "agent_proposal",
      entityId: id,
      metadata: { error: detail.slice(0, 300) },
    })
    return toProposal(row)
  }
}

/* ---------- Derivación a humano ---------- */

export interface HandoffItem {
  id: string
  conversationId: string | null
  contactId: string | null
  reason: string
  summary: string
  priority: HandoffPriority
  assigneeUserId: string | null
  taskId: string | null
  createdBy: string
  createdAt: string
}

function toHandoff(row: typeof agentHandoff.$inferSelect): HandoffItem {
  return {
    id: row.id,
    conversationId: row.conversationId,
    contactId: row.contactId,
    reason: row.reason,
    summary: row.summary,
    priority: row.priority as HandoffPriority,
    assigneeUserId: row.assigneeUserId,
    taskId: row.taskId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  }
}

async function teamUserIds(tx: Db, orgId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
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
    permission: "agent.write",
  })
}

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
  const assigneeUserId = input.assigneeUserId ?? null
  if (assigneeUserId) {
    const [membership] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, assigneeUserId)))
      .limit(1)
    if (!membership) throw validation("El responsable no es miembro de la organización")
  }
  const createdBy = input.createdBy === "user" ? "user" : "agent"
  const task = await createTask(tx, orgId, {
    title: `Derivación (${priority}): ${reason}`.slice(0, 200),
    contactId: conv.contactId,
    conversationId: input.conversationId,
    assigneeUserId,
    createdBy,
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
    metadata: { priority, taskId: task.id },
  })
  const recipients = assigneeUserId ? [assigneeUserId] : await teamUserIds(tx, orgId)
  if (recipients.length) {
    await notifyUsers(tx, orgId, recipients, {
      dedupeKey: `agent-handoff:${row.id}`,
      title: "Derivación del agente",
      body: `Prioridad ${priority}: ${reason}`.slice(0, 200),
      href: "/inbox",
      permission: "tasks.read",
    })
  }
  await notify(tx, { orgId, kind: "agent.handoff.created", at: new Date().toISOString() })
  return toHandoff(row)
}

export async function listHandoffs(tx: Db, orgId: string, input: { conversationId?: string; limit?: number } = {}): Promise<HandoffItem[]> {
  const conditions = [eq(agentHandoff.organizationId, orgId)]
  if (input.conversationId) conditions.push(eq(agentHandoff.conversationId, input.conversationId))
  const limit = input.limit === undefined ? 50 : Math.min(Math.max(input.limit, 1), 100)
  const rows = await tx
    .select()
    .from(agentHandoff)
    .where(and(...conditions))
    .orderBy(desc(agentHandoff.createdAt), asc(agentHandoff.id))
    .limit(limit)
  return rows.map(toHandoff)
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
