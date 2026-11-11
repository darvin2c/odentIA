import type { Db } from "@odentia/db"
import { message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { notFound, ServiceError } from "./errors.js"
import { reopenTopicOfFailedReplySafely } from "./topic-reply.js"

/** Lo que la persona del equipo sabe de un mensaje del que el canal no confirmó si salió. */
export type UncertainOutcome = "sent" | "failed"

/**
 * Resuelve un mensaje `unknown` («no se sabe si salió»): el canal no confirmó
 * si lo aceptó y el sistema no lo reenvía solo, para no mandarlo dos veces.
 * Una persona del equipo, que lo comprobó por otra vía (el celular de la
 * clínica, la persona), dice si salió o no. «Salió» lo deja enviado; «No
 * salió» lo deja como no entregado y, si era la respuesta que resolvió un tema,
 * el tema vuelve a quedar pendiente. Reenviarlo lo decide la persona escribiendo
 * de nuevo. Solo cambia un mensaje que sigue sin saberse: dos personas a la vez
 * no se pisan.
 */
export async function resolveUncertainMessage(
  tx: Db,
  orgId: string,
  input: { conversationId: string; messageId: string; userId: string; outcome: UncertainOutcome },
): Promise<{ status: UncertainOutcome }> {
  const [row] = await tx
    .select({ status: message.status, direction: message.direction })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.conversationId, input.conversationId), eq(message.id, input.messageId)))
    .limit(1)
  if (!row || row.direction !== "out") throw notFound("Mensaje")
  if (row.status === input.outcome) return { status: input.outcome }
  const [updated] = await tx
    .update(message)
    .set(
      input.outcome === "sent"
        ? { status: "sent", error: null }
        : { status: "failed", error: "confirmado por el equipo: no salió" },
    )
    .where(and(eq(message.organizationId, orgId), eq(message.id, input.messageId), eq(message.status, "unknown")))
    .returning({ id: message.id })
  if (!updated) {
    throw new ServiceError("MESSAGE_NOT_UNCERTAIN", 409, "Este mensaje ya no está sin confirmar: actualiza la conversación.")
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.userId,
    action: "message.updated",
    entity: "message",
    entityId: input.messageId,
    metadata: { op: input.outcome === "sent" ? "send-confirmed-by-team" : "send-denied-by-team" },
  })
  if (input.outcome === "failed") await reopenTopicOfFailedReplySafely(tx, orgId, input.messageId)
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({
      orgId,
      kind: "message.updated",
      conversationId: input.conversationId,
      messageId: input.messageId,
      at: new Date().toISOString(),
    })})`,
  )
  return { status: input.outcome }
}
