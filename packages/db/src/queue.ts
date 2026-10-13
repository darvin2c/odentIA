import type { NormalizedInbound } from "@odentia/channels"
import { sql } from "drizzle-orm"
import type { Db } from "./client.js"

export interface DemoTaskPayload {
  orgId: string
  userId: string
  message: string
  requestedAt: string
}

/**
 * Encola la tarea de comprobación del worker (cola `demo_tasks`); devuelve msg_id
 * como string. No tiene pantalla ni operación HTTP: la usa el supervisor e2e para
 * saber que el worker ya consume colas y escribe en auditoría.
 */
export async function sendDemoTask(db: Db, payload: DemoTaskPayload): Promise<string> {
  const rows = await db.execute<{ send: number | string }>(
    sql`select pgmq.send('demo_tasks', ${JSON.stringify(payload)}::jsonb)`,
  )
  const first = Array.isArray(rows) ? rows[0] : (rows as unknown as { send: number | string }[])[0]
  return String(first.send)
}

export interface InboundMessageJob {
  orgId: string
  connectionId: string
  event: NormalizedInbound
}

export interface OutboundMessageJob {
  orgId: string
  messageId: string
}

export type AgentRunJob =
  | {
      kind: "inbound_message"
      orgId: string
      conversationId: string
      messageId: string
    }
  | {
      kind: "overdue_opportunity_follow_up"
      orgId: string
      conversationId: string
      coordinationId: string
    }

async function sendTo(db: Db, queue: string, payload: unknown, delaySeconds = 0): Promise<string> {
  const delay = Math.max(0, Math.floor(delaySeconds))
  const rows = await db.execute<{ send: number | string }>(
    sql`select pgmq.send(${queue}, ${JSON.stringify(payload)}::jsonb, ${delay}::integer)`,
  )
  const first = Array.isArray(rows) ? rows[0] : (rows as unknown as { send: number | string }[])[0]
  return String(first.send)
}
/** Sobre pgmq.read: msg_id para ack, read_ct para veneno, message tipado. */
export interface QueueMessage<T> {
  msg_id: number
  read_ct: number
  message: T
}

/** Encola un inbound normalizado para su ingesta en el worker. */
export function sendInboundMessage(db: Db, payload: InboundMessageJob): Promise<string> {
  return sendTo(db, "inbound_messages", payload)
}
/** Encola un mensaje out pendiente de envío al proveedor. */
export function sendOutboundMessage(db: Db, payload: OutboundMessageJob): Promise<string> {
  return sendTo(db, "outbound_messages", payload)
}

/**
 * Encola una corrida del agente sobre una conversación. `delaySeconds` la
 * hace visible más tarde: es la ventana para que una ráfaga de mensajes del
 * interlocutor llegue completa antes de que el agente la lea.
 */
export function sendAgentRun(
  db: Db,
  payload: AgentRunJob,
  options: { delaySeconds?: number } = {},
): Promise<string> {
  return sendTo(db, "agent_runs", payload, options.delaySeconds)
}
