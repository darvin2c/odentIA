import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { getAgentConfig } from "./agentConfig.js"
import type { ConversationCloseReason } from "./conversation-close.js"
import {
  agentAttendingSql,
  awaitingPatientSinceSql,
  type ConversationView,
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
  }>(sql`
    select c.id, ${agentAttendingSql(c)} as agent_attending, ${unansweredSql(c)} as unanswered,
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
  const handoffs = await tx.execute<{ conversation_id: string; priority: string }>(sql`
    select h.conversation_id, h.priority from agent_handoff h
    where h.organization_id = ${orgId} and h.conversation_id in (${list}) and ${handoffOpenSql(sql.raw("h"))}`)
  for (const row of handoffs) {
    const item = attention.get(row.conversation_id)
    const priority = PRIORITY_ORDER.find((p) => p === row.priority)
    if (!item || !priority) continue
    if (item.handoffPriority === null || PRIORITY_ORDER.indexOf(priority) < PRIORITY_ORDER.indexOf(item.handoffPriority)) {
      item.handoffPriority = priority
    }
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
  /** Esperan respuesta de la clínica. */
  unanswered: number
  /** Con el equipo: derivación abierta o una persona a cargo. */
  team: number
  /** Esperan al paciente: se le respondió o una propuesta espera su sí. */
  awaitingPatient: number
  /** Cerradas. */
  closed: number
}

/**
 * Totales de los chips de la Bandeja con los mismos filtros que la lista,
 * salvo el estado: cada chip ya dice si cuenta abiertas o cerradas.
 */
export async function summarizeInbox(tx: Db, orgId: string, input: ConversationFilters): Promise<InboxSummary> {
  const { status: _status, ...filters } = input
  const totals = await countConversationViews(tx, orgId, filters, ["unanswered", "team", "awaiting_patient", "closed"])
  return {
    open: totals.all - totals.closed,
    unanswered: totals.unanswered,
    team: totals.team,
    awaitingPatient: totals.awaiting_patient,
    closed: totals.closed,
  }
}
