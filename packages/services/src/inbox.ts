import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { type LastAgentAction, lastAgentActions } from "./agent-actions.js"
import { onlyCourtesy } from "./agent-operations.js"
import type { ConversationCloseReason } from "./conversation-close.js"
import {
  agentAttendingSql,
  awaitingPatientSinceSql,
  type ConversationView,
  lastIsFailedOutSql,
  teamLiveSql,
  unansweredSql,
} from "./conversation-state.js"
import { type ConversationFilters, type ConversationListItem, conversationListItems, getConversationDetail } from "./conversations.js"
import { handoffOpenSql } from "./handoff-state.js"
import { lateReplyOf } from "./held-replies.js"
import { countPersonViews, listPersonRows, personChannels } from "./inbox-person.js"
import { proposalPendingSql } from "./proposal-state.js"
import { TOPIC_KINDS, type TopicKind, topicIsUrgent } from "./topic-urgency.js"
import { webchatReplyRoutes } from "./webchat-reply.js"

/**
 * Bandeja: una fila por persona (fase 4 del pulido, `inbox-person.ts`) con lo
 * que su conversación más urgente espera del equipo, del agente o del
 * paciente, cómo se cerró, y los totales de sus vistas. No decide nada: reúne,
 * con las reglas de `conversation-state.ts`, el estado que la lista, el hilo y
 * los chips necesitan.
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
  /** El último mensaje del hilo no salió: pide a una persona aunque el agente la atienda (`needsPersonSql`). */
  sendFailed: boolean
  /**
   * Se espera al paciente desde este momento: abierta, lo último es un
   * saliente aceptado y no hay derivación abierta. Nulo si no.
   */
  awaitingPatientSince: string | null
  /** El agente ya insistió en esta atención, y cuándo. */
  nudgedAt: string | null
  /** Quién tiene la conversación asignada, si alguien. */
  assignedName: string | null
  /** Una persona del equipo conversa en vivo: el agente espera (ADR 0050). */
  teamLive: boolean
  /** Temas sin resolver del hilo, el más urgente primero (ADR 0050). */
  topics: InboxTopic[]
  /**
   * Chat web con un tema y sin dónde avisarle (R4, decisión 10): si cierra la
   * pestaña, la respuesta no le llega. «Sin forma de avisarle».
   */
  unreachable: boolean
  /**
   * El WhatsApp que dejó ya es de otra persona de la clínica (`othersPhone`):
   * no se usa hasta que el equipo confirme quién es. Al visitante no se le dijo.
   */
  othersPhone: string | null
}

/** Un tema sin resolver: lo que una persona del equipo tiene que contestar. */
export interface InboxTopic {
  id: string
  reason: string
  priority: HandoffPriorityLevel
  /** Ahora: prioridad alta o ya pasaron dos horas de clínica abierta esperando al equipo (`urgent_at`, decisión 1). */
  urgent: boolean
  /** De qué trata: dice a quién le llega (R3). */
  kind: TopicKind
  assigneeUserId: string | null
  assigneeName: string | null
  /** Lo creó el agente o una persona del equipo al escribir. */
  createdBy: "agent" | "user"
  createdAt: string
  dueAt: string | null
  taskId: string | null
  /** El mensaje de la persona que se responde, citado. `onlyCourtesy`: un «Si» no dice de qué trata; lo dice el motivo. */
  source: { id: string; body: string | null; createdAt: string; onlyCourtesy: boolean } | null
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

/**
 * Una fila de la Bandeja: la persona, mostrada con su conversación más urgente
 * (`id`). `unreadCount` y `lastMessageAt` son de todos sus canales.
 */
export interface InboxConversationItem extends ConversationListItem {
  attention: ConversationAttention
  closure: ConversationClosure | null
  /** Sus canales, primero el de esta conversación. */
  channels: string[]
  /** Sus conversaciones: abrir cualquiera es abrir esta fila. */
  conversationIds: string[]
  /** Lo último que hizo el agente, si la persona no volvió a escribir después. */
  lastAction: LastAgentAction | null
}

const NO_ATTENTION: ConversationAttention = {
  agentAttending: false,
  pendingContact: 0,
  handoffPriority: null,
  unanswered: false,
  sendFailed: false,
  awaitingPatientSince: null,
  nudgedAt: null,
  assignedName: null,
  teamLive: false,
  topics: [],
  unreachable: false,
  othersPhone: null,
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
    send_failed: boolean
    awaiting_since: Date | string | null
    nudged_at: Date | string | null
    assigned_name: string | null
    close_reason: string | null
    closed_at: Date | string | null
    closed_by_name: string | null
    team_live: boolean
    webchat_contact: string | null
  }>(sql`
    select c.id, ${agentAttendingSql(c)} as agent_attending, ${unansweredSql(c)} as unanswered, ${teamLiveSql(c)} as team_live,
      (c.status = 'open' and ${lastIsFailedOutSql(c)}) as send_failed,
      ${awaitingPatientSinceSql(c)} as awaiting_since, c.nudged_at,
      ua.name as assigned_name, c.close_reason, c.closed_at, uc.name as closed_by_name,
      (case when cn.provider = 'web_chat' and not c.is_test then c.contact_id end) as webchat_contact
    from conversation c
    join channel_connection cn on cn.id = c.channel_connection_id
    join contact p on p.id = c.contact_id
    left join "user" ua on ua.id = c.assigned_user_id
    left join "user" uc on uc.id = c.closed_by_user_id
    where c.organization_id = ${orgId} and c.id in (${list})`)
  for (const row of rows) {
    attention.set(row.id, {
      agentAttending: row.agent_attending === true,
      pendingContact: 0,
      handoffPriority: null,
      unanswered: row.unanswered === true,
      sendFailed: row.send_failed === true,
      awaitingPatientSince: iso(row.awaiting_since),
      nudgedAt: iso(row.nudged_at),
      assignedName: row.assigned_name,
      teamLive: row.team_live === true,
      topics: [],
      unreachable: false,
      othersPhone: null,
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
    kind: string
    urgent_at: Date | string | null
  }>(sql`
    select h.id, h.conversation_id, h.priority, h.reason, h.assignee_user_id, ua.name as assignee_name,
      h.created_by, h.created_at, t.due_at, h.task_id, h.asked_message_ids, h.asked_again_at, h.kind, h.urgent_at,
      ms.id as source_id, ms.body as source_body, ms.created_at as source_at
    from agent_handoff h
    left join "user" ua on ua.id = h.assignee_user_id
    left join task t on t.id = h.task_id and t.organization_id = h.organization_id
    left join message ms on ms.id = h.source_message_id and ms.conversation_id = h.conversation_id
    where h.organization_id = ${orgId} and h.conversation_id in (${list}) and ${handoffOpenSql(sql.raw("h"))}
    order by h.created_at`)
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
      urgent: topicIsUrgent({ priority, urgentAt: row.urgent_at === null ? null : new Date(row.urgent_at) }, now),
      kind: (TOPIC_KINDS as readonly string[]).includes(row.kind) ? (row.kind as TopicKind) : "otro",
      assigneeUserId: row.assignee_user_id,
      assigneeName: row.assignee_name,
      createdBy: row.created_by === "user" ? "user" : "agent",
      createdAt,
      dueAt: iso(row.due_at),
      taskId: row.task_id,
      source: row.source_id ? { id: row.source_id, body: row.source_body, createdAt: iso(row.source_at) ?? "", onlyCourtesy: onlyCourtesy(row.source_body) } : null,
      askedMessageIds: Array.isArray(row.asked_message_ids) ? row.asked_message_ids : [],
      askedAgainAt: iso(row.asked_again_at),
    })
  }
  // El más urgente primero; entre iguales, el que más lleva esperando.
  for (const item of attention.values()) {
    item.topics.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.createdAt.localeCompare(b.createdAt))
  }
  // Chat web con un tema: «Sin forma de avisarle» si no hay por dónde, con la misma regla que el reenvío (R4).
  for (const row of rows) {
    const item = attention.get(row.id)
    if (!item || !row.webchat_contact || item.topics.length === 0) continue
    const routes = await webchatReplyRoutes(tx, orgId, row.webchat_contact)
    item.unreachable = !routes.whatsapp && !routes.correo
    item.othersPhone = routes.othersPhone
  }
  return { attention, closure }
}

export async function listInboxConversations(
  tx: Db,
  orgId: string,
  input: ConversationFilters & { view?: ConversationView; cursor?: string; limit?: number; now?: Date },
): Promise<{ items: InboxConversationItem[]; nextCursor: string | null }> {
  const { now, ...filters } = input
  const { rows, nextCursor } = await listPersonRows(tx, orgId, filters)
  const ids = rows.map((row) => row.id)
  const listed = new Map((await conversationListItems(tx, orgId, ids)).map((item) => [item.id, item]))
  const state = await conversationAttention(tx, orgId, ids, now ?? new Date())
  const actions = await lastAgentActions(tx, orgId, rows.flatMap((row) => row.conversationIds))
  const items: InboxConversationItem[] = []
  for (const row of rows) {
    const item = listed.get(row.id)
    if (!item) continue
    items.push({
      ...item,
      unreadCount: row.unreadCount,
      lastMessageAt: row.lastAt,
      attention: state.attention.get(item.id) ?? NO_ATTENTION,
      closure: state.closure.get(item.id) ?? null,
      channels: row.channels,
      conversationIds: row.conversationIds,
      lastAction: row.conversationIds.reduce<LastAgentAction | null>((latest, id) => {
        const action = actions.get(id)
        return action && (!latest || latest.at < action.at) ? action : latest
      }, null),
    })
  }
  return { items, nextCursor }
}

/**
 * Detalle del hilo con su atención y su cierre: el hilo abierto no depende de
 * que su fila esté en la página cargada de la lista (enlace directo, otra
 * vista o filtro). Los mensajes son los de todos los canales de la persona y
 * `person` dice por cuáles se le puede responder (fase 4 del pulido); lo
 * demás es de esta conversación, la que responde.
 */
export async function getInboxConversationDetail(tx: Db, orgId: string, id: string, now = new Date()) {
  const detail = await getConversationDetail(tx, orgId, id, "person")
  const state = await conversationAttention(tx, orgId, [detail.conversation.id], now)
  return {
    ...detail,
    person: await personChannels(tx, orgId, detail.conversation.id, now),
    attention: state.attention.get(detail.conversation.id) ?? NO_ATTENTION,
    closure: state.closure.get(detail.conversation.id) ?? null,
    // Responder pasadas las 24 horas: «Ver respuesta» en WhatsApp, la ventana de Instagram y Messenger.
    lateReply: await lateReplyOf(tx, orgId, detail.conversation.id),
  }
}

export interface InboxSummary {
  /** Abiertas con los filtros dados. */
  open: number
  /** «Por atender»: piden a una persona (un tema, un mensaje que el agente no atiende o lo último que no salió). */
  attend: number
  /** Las atiende el agente. */
  agent: number
  /** Esperan al paciente: se le respondió o una propuesta espera su sí. */
  awaitingPatient: number
  /** Cerradas. */
  closed: number
  /** En Spam, de los últimos 30 días: el número junto a «Spam» (ADR 0054). Bloqueados no lleva número. */
  spam: number
}

/**
 * Totales de las pestañas de la Bandeja con los mismos filtros que la lista,
 * salvo el estado: cada pestaña ya dice si cuenta abiertas o cerradas. Cuentan
 * personas (fase 4 del pulido) y no se superponen: cada persona está en la
 * vista más urgente de sus conversaciones, así `attend + agent +
 * awaitingPatient = open`; Spam y bloqueados no entran en ninguna.
 */
export async function summarizeInbox(tx: Db, orgId: string, input: ConversationFilters): Promise<InboxSummary> {
  const totals = await countPersonViews(tx, orgId, input)
  return {
    open: totals.attend + totals.agent + totals.awaiting_patient,
    attend: totals.attend,
    agent: totals.agent,
    awaitingPatient: totals.awaiting_patient,
    closed: totals.closed,
    spam: totals.spam,
  }
}
