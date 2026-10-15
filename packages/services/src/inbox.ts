import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { pendingProposalDecider } from "./agent-operations.js"
import {
  type ConversationFilters,
  type ConversationListItem,
  type ConversationView,
  countConversationViews,
  getConversationDetail,
  listConversations,
} from "./conversations.js"
import { handoffOpenSql } from "./handoff-state.js"
import { proposalPendingSql } from "./proposal-state.js"

/**
 * Bandeja: el listado de conversaciones con lo que cada una espera del equipo
 * o del agente, y los totales de sus vistas. No decide nada: reúne, con las
 * reglas de sus dueños, el estado que la lista necesita para priorizar.
 */

const PRIORITY_ORDER = ["alta", "media", "baja"] as const
export type HandoffPriorityLevel = (typeof PRIORITY_ORDER)[number]

export interface ConversationAttention {
  /** El agente atiende hoy el hilo: abierto, encendido en el hilo y en la organización. */
  agentAttending: boolean
  /** Propuestas pendientes del hilo que decide el equipo. */
  pendingTeam: number
  /** Propuestas pendientes que esperan la confirmación del interlocutor. */
  pendingContact: number
  /** Prioridad más alta entre las derivaciones sin resolver del hilo; null si no hay. */
  handoffPriority: HandoffPriorityLevel | null
}

export interface InboxConversationItem extends ConversationListItem {
  attention: ConversationAttention
}

async function conversationAttention(
  tx: Db,
  orgId: string,
  items: Pick<ConversationListItem, "id" | "status" | "agentStatus">[],
): Promise<Map<string, ConversationAttention>> {
  const out = new Map<string, ConversationAttention>()
  if (items.length === 0) return out
  const ids = sql.join(
    items.map((item) => sql`${item.id}::uuid`),
    sql`, `,
  )
  const [cfg] = await tx.execute<{ enabled: boolean }>(
    sql`select enabled from agent_config where organization_id = ${orgId} limit 1`,
  )
  const agentEnabled = cfg?.enabled === true
  for (const item of items) {
    out.set(item.id, {
      agentAttending: agentEnabled && item.status === "open" && item.agentStatus === "on",
      pendingTeam: 0,
      pendingContact: 0,
      handoffPriority: null,
    })
  }
  // Las pendientes vencidas dejan de contar aunque su fila aún no se marcó
  // `expirada` (la caducidad es perezosa); no se escribe en una lectura.
  const proposals = await tx.execute<{ conversation_id: string; action: string; count: number }>(sql`
    select p.conversation_id, p.action, count(*)::int as count from agent_proposal p
    where p.organization_id = ${orgId} and p.conversation_id in (${ids}) and ${proposalPendingSql(sql.raw("p"))}
    group by p.conversation_id, p.action`)
  for (const row of proposals) {
    const attention = out.get(row.conversation_id)
    if (!attention) continue
    if (pendingProposalDecider(row.action, true) === "team") attention.pendingTeam += row.count
    else attention.pendingContact += row.count
  }
  const handoffs = await tx.execute<{ conversation_id: string; priority: string }>(sql`
    select h.conversation_id, h.priority from agent_handoff h
    where h.organization_id = ${orgId} and h.conversation_id in (${ids}) and ${handoffOpenSql(sql.raw("h"))}`)
  for (const row of handoffs) {
    const attention = out.get(row.conversation_id)
    const priority = PRIORITY_ORDER.find((p) => p === row.priority)
    if (!attention || !priority) continue
    if (
      attention.handoffPriority === null ||
      PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(attention.handoffPriority)
    ) {
      attention.handoffPriority = priority
    }
  }
  return out
}

export async function listInboxConversations(
  tx: Db,
  orgId: string,
  input: ConversationFilters & { view?: ConversationView; cursor?: string; limit?: number },
): Promise<{ items: InboxConversationItem[]; nextCursor: string | null }> {
  const page = await listConversations(tx, orgId, input)
  const attention = await conversationAttention(tx, orgId, page.items)
  return {
    items: page.items.map((item) => ({ ...item, attention: attention.get(item.id) ?? NO_ATTENTION })),
    nextCursor: page.nextCursor,
  }
}

const NO_ATTENTION: ConversationAttention = {
  agentAttending: false,
  pendingTeam: 0,
  pendingContact: 0,
  handoffPriority: null,
}

/**
 * Detalle del hilo con su atención: el hilo abierto no depende de que su fila
 * esté en la página cargada de la lista (enlace directo, otra vista o filtro).
 */
export async function getInboxConversationDetail(tx: Db, orgId: string, id: string) {
  const detail = await getConversationDetail(tx, orgId, id)
  const attention = await conversationAttention(tx, orgId, [detail.conversation])
  return { ...detail, attention: attention.get(detail.conversation.id) ?? NO_ATTENTION }
}

export interface InboxSummary {
  /** Conversaciones que cumplen los filtros. */
  all: number
  /** De ellas, las que esperan respuesta de la clínica. */
  waiting: number
  /** Las que atiende el agente. */
  withAgent: number
  /** Las que tienen una derivación sin resolver. */
  handoffs: number
}

/** Totales de las vistas de la bandeja para los mismos filtros que la lista. */
export async function summarizeInbox(
  tx: Db,
  orgId: string,
  input: ConversationFilters,
): Promise<InboxSummary> {
  const totals = await countConversationViews(tx, orgId, input, ["unanswered", "agent", "handoff"])
  return { all: totals.all, waiting: totals.unanswered, withAgent: totals.agent, handoffs: totals.handoff }
}
