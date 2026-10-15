import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { agentAnswerTrace, agentProposal } from "@odentia/db/schema/agent"
import { conversation, message } from "@odentia/db/schema/crm"
import * as schema from "@odentia/db/schema/index"
import { and, desc, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

export function openFixtureDb(url: string): { db: Db; close(): Promise<void> } {
  const client = postgres(url, { max: 1 })
  return { db: drizzle(client, { schema }), close: () => client.end() }
}

/**
 * Un borrador de texto del agente esperando la aprobación del equipo, con la
 * traza de respuesta que lo acompaña. Quién confirma cada acción es fijo
 * (ADR 0021) y en un hilo los mensajes salen directo: ningún recorrido deja
 * hoy un borrador así. La prueba deja las filas como las dejaría el agente
 * para ejercitar Aprobaciones y el cajón «Aprobar un mensaje».
 */
export async function insertPendingReply(
  db: Db,
  input: { orgId: string; conversationId: string; text: string },
): Promise<string> {
  const [thread] = await db
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(eq(conversation.id, input.conversationId))
  const [asked] = await db
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.conversationId, input.conversationId), eq(message.direction, "in")))
    .orderBy(desc(message.createdAt))
    .limit(1)
  const [row] = await db
    .insert(agentProposal)
    .values({
      organizationId: input.orgId,
      conversationId: input.conversationId,
      contactId: thread?.contactId ?? null,
      action: "enviar_mensaje",
      payload: { kind: "text", text: input.text },
      afterSummary: input.text,
      reason: "El interlocutor escribió",
      idempotencyKey: randomUUID(),
    })
    .returning({ id: agentProposal.id })
  if (!row) throw new Error("No se pudo sembrar el borrador")
  await db.insert(agentAnswerTrace).values({
    organizationId: input.orgId,
    conversationId: input.conversationId,
    triggerMessageId: asked?.id ?? null,
    proposalId: row.id,
    outcome: "pendiente",
    replyText: input.text,
    basis: [],
    checks: [],
  })
  return row.id
}
