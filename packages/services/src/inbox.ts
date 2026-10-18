import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import type { ConversationCloseReason } from "./conversation-close.js"
import {
  agentAttendingSql,
  awaitingPatientSinceSql,
  type ConversationView,
  teamLiveSql,
  unansweredSql,
} from "./conversation-state.js"
import {
  type ConversationFilters,
  type ConversationListItem,
  countConversationViews,
  getConversationDetail,
  listConversations,
} from "./conversations.js"
import { handoffOpenSql } from "./handoff-state.js"
import { findOrgLocale } from "./locale.js"
import { insideAgentHours } from "./opportune-hours.js"
import { proposalPendingSql } from "./proposal-state.js"

/**
 * Bandeja: el listado de conversaciones con lo que cada una espera del equipo,
 * del agente o del paciente, cómo se cerró, y los totales de sus vistas. No
 * decide nada: reúne, con las reglas de `conversation-state.ts`, el estado que
 * la lista, el hilo y los chips necesitan.
 */

const PRIORITY_ORDER = ["alta", "media", "baja"] as const
export type HandoffPriorityLevel = (typeof PRIORITY_ORDER)[number]

export interface ConversationAttention {
  /** El agente atiende hoy el hilo: abierto, encendido en el hilo y en la organización, en un canal que atiende. */
  agentAttending: boolean
  /** Propuestas pendientes que esperan la confirmación del interlocutor: las únicas que quedan pendientes. */
  pendingContact: number
  /** Prioridad más alta entre las derivaciones sin resolver del hilo; null si no hay. */
  handoffPriority: HandoffPriorityLevel | null
  /** Espera respuesta de la clínica: la misma regla que la vista `unanswered`. */
  unanswered: boolean
  /**
   * Se espera al paciente desde este momento: abierta, lo último es un
   * saliente aceptado y no hay derivación abierta. Nulo si no.
   */
  awaitingPatientSince: string | null
  /** El agente ya insistió en esta atención, y cuándo. */
  nudgedAt: string | null
  /** Hay un entrante sin responder fuera del horario del agente: la respuesta sale cuando abra. */
  outOfHours: boolean
  /** Quién tiene la conversación asignada, si alguien. */
  assignedName: string | null
  /** Una persona del equipo conversa en vivo: el agente espera (ADR 0049). */
  teamLive: boolean
  /** Temas sin resolver del hilo, el más urgente primero (ADR 0049). */
  topics: InboxTopic[]
}

/** Horas tras las que un tema sin resolver pasa a «Ahora» (ADR 0049). */
export const TOPIC_URGENT_AFTER_HOURS = 2

/** Un tema sin resolver: lo que una persona del equipo tiene que contestar. */
export interface InboxTopic {
  id: string
  reason: string
  priority: HandoffPriorityLevel
  /** Ahora: prioridad alta o lleva más de `TOPIC_URGENT_AFTER_HOURS` sin resolverse. */
  urgent: boolean
  assigneeUserId: string | null
  assigneeName: string | null
  /** Lo creó el agente o una persona del equipo al escribir. */
  createdBy: "agent" | "user"
  createdAt: string
  dueAt: string | null
  taskId: string | null
  /** El mensaje de la persona que se responde, citado. */
  source: { id: string; body: string | null; createdAt: string } | null
  /** Mensajes en que volvió a preguntar por el tema. */
  askedMessageIds: string[]
  askedAgainAt: string | null
}

/** Cómo se cerró: null si está abierta. `byName` es quien la cerró; nulo si fue el agente. */
export interface ConversationClosure {
  reason: ConversationCloseReason
  at: string
  byName: string | null
}

export interface InboxConversationItem extends ConversationListItem {
  attention: ConversationAttention
  closure: ConversationClosure | null
}

const NO_ATTENTION: ConversationAttention = {
  agentAttending: false,
  pendingContact: 0,
  handoffPriority: null,
  unanswered: false,
  awaitingPatientSince: null,
  nudgedAt: null,
  outOfHours: false,
  assignedName: null,
  teamLive: false,
  topics: [],
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

async function conversationAttention(
  tx: Db,
  orgId: string,
  ids: string[],
  now: Date,
): Promise<{ attention: Map<string, ConversationAttention>; closure: Map<string, ConversationClosure | null> }> {
  const attention = new Map<string, ConversationAttention>()
  const closure = new Map<string, ConversationClosure | null>()
  if (ids.length === 0) return { attention, closure }
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )
  const c = sql.raw("c")
  const rows = await tx.execute<{
    id: string
    agent_attending: boolean
    unanswered: boolean
    awaiting_since: Date | string | null
    nudged_at: Date | string | null
    assigned_name: string | null
    close_reason: string | null
    closed_at: Date | string | null
    closed_by_name: string | null
    team_live: boolean
  }>(sql`
    select c.id, ${agentAttendingSql(c)} as agent_attending, ${unansweredSql(c)} as unanswered, ${teamLiveSql(c)} as team_live,
      ${awaitingPatientSinceSql(c)} as awaiting_since, c.nudged_at,
      ua.name as assigned_name, c.close_reason, c.closed_at, uc.name as closed_by_name
    from conversation c
    left join "user" ua on ua.id = c.assigned_user_id
    left join "user" uc on uc.id = c.closed_by_user_id
    where c.organization_id = ${orgId} and c.id in (${list})`)
  // Fuera del horario del agente lo que entra espera a que abra; se dice con la hora de la clínica.
  const cfg = await getAgentConfig(tx, orgId)
  const agentHours =
    cfg.activeFromMin !== null && cfg.activeUntilMin !== null ? { fromMin: cfg.activeFromMin, untilMin: cfg.activeUntilMin } : null
  const closedNow = agentHours ? !insideAgentHours(now, (await findOrgLocale(tx, orgId)).timezone, agentHours) : false
  for (const row of rows) {
    attention.set(row.id, {
      agentAttending: row.agent_attending === true,
      pendingContact: 0,
      handoffPriority: null,
      unanswered: row.unanswered === true,
      awaitingPatientSince: iso(row.awaiting_since),
      nudgedAt: iso(row.nudged_at),
      outOfHours: row.agent_attending === true && row.unanswered === true && closedNow,
      assignedName: row.assigned_name,
      teamLive: row.team_live === true,
      topics: [],
    })
    closure.set(
      row.id,
      row.close_reason && row.closed_at
        ? { reason: row.close_reason as ConversationCloseReason, at: iso(row.closed_at) ?? "", byName: row.closed_by_name }
        : null,
    )
  }
  // Las pendientes vencidas dejan de contar aunque su fila aún no se marcó
  // `expirada` (la caducidad es perezosa); no se escribe en una lectura.
  const proposals = await tx.execute<{ conversation_id: string; count: number }>(sql`
    select p.conversation_id, count(*)::int as count from agent_proposal p
    where p.organization_id = ${orgId} and p.conversation_id in (${list}) and ${proposalPendingSql(sql.raw("p"))}
    group by p.conversation_id`)
  for (const row of proposals) {
    const item = attention.get(row.conversation_id)
    if (item) item.pendingContact += row.count
  }
  const handoffs = await tx.execute<{
    id: string
    conversation_id: string
    priority: string
    reason: string
    assignee_user_id: string | null
    assignee_name: string | null
    created_by: string
    created_at: Date | string
    due_at: Date | string | null
    task_id: string | null
    source_id: string | null
    source_body: string | null
    source_at: Date | string | null
    asked_message_ids: string[] | null
    asked_again_at: Date | string | null
  }>(sql`
    select h.id, h.conversation_id, h.priority, h.reason, h.assignee_user_id, ua.name as assignee_name,
      h.created_by, h.created_at, t.due_at, h.task_id, h.asked_message_ids, h.asked_again_at,
      ms.id as source_id, ms.body as source_body, ms.created_at as source_at
    from agent_handoff h
    left join "user" ua on ua.id = h.assignee_user_id
    left join task t on t.id = h.task_id and t.organization_id = h.organization_id
    left join message ms on ms.id = h.source_message_id and ms.conversation_id = h.conversation_id
    where h.organization_id = ${orgId} and h.conversation_id in (${list}) and ${handoffOpenSql(sql.raw("h"))}
    order by h.created_at`)
  const urgentBefore = now.getTime() - TOPIC_URGENT_AFTER_HOURS * 3_600_000
  for (const row of handoffs) {
    const item = attention.get(row.conversation_id)
    const priority = PRIORITY_ORDER.find((p) => p === row.priority)
    if (!item || !priority) continue
    if (item.handoffPriority === null || PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(item.handoffPriority)) {
      item.handoffPriority = priority
    }
    const createdAt = iso(row.created_at) ?? ""
    item.topics.push({
      id: row.id,
      reason: row.reason,
      priority,
      urgent: priority === "alta" || new Date(createdAt).getTime() <= urgentBefore,
      assigneeUserId: row.assignee_user_id,
      assigneeName: row.assignee_name,
      createdBy: row.created_by === "user" ? "user" : "agent",
      createdAt,
      dueAt: iso(row.due_at),
      taskId: row.task_id,
      source: row.source_id ? { id: row.source_id, body: row.source_body, createdAt: iso(row.source_at) ?? "" } : null,
      askedMessageIds: Array.isArray(row.asked_message_ids) ? row.asked_message_ids : [],
      askedAgainAt: iso(row.asked_again_at),
    })
  }
  // El más urgente primero; entre iguales, el que más lleva esperando.
  for (const item of attention.values()) {
    item.topics.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.createdAt.localeCompare(b.createdAt))
  }
  return { attention, closure }
}

export async function listInboxConversations(
  tx: Db,
  orgId: string,
  input: ConversationFilters & { view?: ConversationView; cursor?: string; limit?: number; now?: Date },
): Promise<{ items: InboxConversationItem[]; nextCursor: string | null }> {
  const { now, ...filters } = input
  const page = await listConversations(tx, orgId, filters)
  const state = await conversationAttention(
    tx,
    orgId,
    page.items.map((item) => item.id),
    now ?? new Date(),
  )
  return {
    items: page.items.map((item) => ({
      ...item,
      attention: state.attention.get(item.id) ?? NO_ATTENTION,
      closure: state.closure.get(item.id) ?? null,
    })),
    nextCursor: page.nextCursor,
  }
}

/**
 * Detalle del hilo con su atención y su cierre: el hilo abierto no depende de
 * que su fila esté en la página cargada de la lista (enlace directo, otra
 * vista o filtro).
 */
export async function getInboxConversationDetail(tx: Db, orgId: string, id: string, now = new Date()) {
  const detail = await getConversationDetail(tx, orgId, id)
  const state = await conversationAttention(tx, orgId, [detail.conversation.id], now)
  return {
    ...detail,
    attention: state.attention.get(detail.conversation.id) ?? NO_ATTENTION,
    closure: state.closure.get(detail.conversation.id) ?? null,
  }
}

export interface InboxSummary {
  /** Abiertas con los filtros dados. */
  open: number
  /** «Por atender»: piden a una persona (un tema o un mensaje que el agente no atiende). */
  attend: number
  /** Las atiende el agente. */
  agent: number
  /** Esperan al paciente: se le respondió o una propuesta espera su sí. */
  awaitingPatient: number
  /** Cerradas. */
  closed: number
}

/**
 * Totales de las pestañas de la Bandeja con los mismos filtros que la lista,
 * salvo el estado: cada pestaña ya dice si cuenta abiertas o cerradas. Las
 * vistas no se superponen: `attend + agent + awaitingPatient = open`.
 */
export async function summarizeInbox(tx: Db, orgId: string, input: ConversationFilters): Promise<InboxSummary> {
  const { status: _status, ...filters } = input
  const totals = await countConversationViews(tx, orgId, filters, ["attend", "agent", "awaiting_patient", "closed"])
  return {
    open: totals.all - totals.closed,
    attend: totals.attend,
    agent: totals.agent,
    awaitingPatient: totals.awaiting_patient,
    closed: totals.closed,
  }
}
