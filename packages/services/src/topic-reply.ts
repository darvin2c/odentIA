import type { Db } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { message } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
import { notFound } from "./errors.js"
import { claimHandoff, createHandoff, recordTopicAskedAgain } from "./agent-operations.js"
import { type MessageItem, type OutboundContent, sendOutbound } from "./conversations.js"
import { handoffOpenSql } from "./handoff-state.js"
import { updateTask } from "./tasks.js"

/**
 * Una persona del equipo responde en la Bandeja (ADR 0050). Si cita un mensaje
 * de la persona, la respuesta sale citada y responde su tema:
 * - Si el mensaje es de un tema abierto, ese tema pasa a quien responde (si
 *   lo tenía otra persona, se le avisa) y, con «Enviar y resolver», queda
 *   resuelto.
 * - Si no es de ningún tema y quien responde elige «Enviar, sigue pendiente»,
 *   se abre un tema a su nombre con su plazo.
 * Sin cita, es un mensaje sin tema. Escribir nunca apaga al agente: espera
 * mientras la persona conversa en vivo.
 */
export async function sendTeamReply(
  tx: Db,
  orgId: string,
  input: {
    conversationId: string
    userId: string
    content: OutboundContent
    replyToMessageId?: string | null
    /** «Enviar, sigue pendiente»: el tema queda abierto. Por defecto se resuelve. */
    keepPending?: boolean
  },
): Promise<MessageItem & { topicId: string | null; topicResolved: boolean }> {
  const replyTo = input.replyToMessageId ?? null
  const topic = replyTo ? await openTopicOf(tx, orgId, input.conversationId, replyTo) : null
  if (topic && topic.assigneeUserId !== input.userId) {
    await claimHandoff(tx, orgId, input.userId, topic.id, { takeOver: true })
  }
  const sent = await sendOutbound(tx, orgId, {
    conversationId: input.conversationId,
    senderKind: "user",
    senderUserId: input.userId,
    content: input.content,
    replyToMessageId: replyTo,
  })
  if (topic) {
    if (!input.keepPending && topic.taskId) {
      await updateTask(tx, orgId, topic.taskId, { status: "done", actorUserId: input.userId })
      return { ...sent, topicId: topic.id, topicResolved: true }
    }
    return { ...sent, topicId: topic.id, topicResolved: false }
  }
  if (replyTo && input.keepPending) {
    const quoted = await quotedText(tx, orgId, input.conversationId, replyTo)
    const created = await createHandoff(tx, orgId, input.userId, {
      conversationId: input.conversationId,
      reason: shortReason(quoted),
      summary: quoted ? `Escribió: «${quoted}»` : "Respuesta del equipo pendiente de completar",
      priority: "media",
      assigneeUserId: input.userId,
      createdBy: "user",
      sourceMessageId: replyTo,
    })
    return { ...sent, topicId: created.id, topicResolved: false }
  }
  return { ...sent, topicId: null, topicResolved: false }
}

/** El tema abierto al que pertenece un mensaje: lo originó o la persona volvió a preguntar con él. */
async function openTopicOf(
  tx: Db,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<{ id: string; assigneeUserId: string | null; taskId: string | null } | null> {
  const [row] = await tx
    .select({ id: agentHandoff.id, assigneeUserId: agentHandoff.assigneeUserId, taskId: agentHandoff.taskId })
    .from(agentHandoff)
    .where(
      and(
        eq(agentHandoff.organizationId, orgId),
        eq(agentHandoff.conversationId, conversationId),
        handoffOpenSql(sql.raw('"agent_handoff"')),
        sql`(${agentHandoff.sourceMessageId} = ${messageId}::uuid or ${agentHandoff.askedMessageIds} ? ${messageId})`,
      ),
    )
    .orderBy(agentHandoff.createdAt)
    .limit(1)
  return row ?? null
}

async function quotedText(tx: Db, orgId: string, conversationId: string, messageId: string): Promise<string> {
  const [row] = await tx
    .select({ body: message.body })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.organizationId, orgId), eq(message.conversationId, conversationId)))
    .limit(1)
  return (row?.body ?? "").trim()
}

/** Motivo del tema en una línea: la pregunta citada, recortada. */
function shortReason(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (!line) return "Respuesta pendiente"
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** El tema abierto de esta conversación con ese id; si no, 404. */
async function requireOpenTopic(tx: Db, orgId: string, conversationId: string, topicId: string) {
  const [row] = await tx
    .select({ id: agentHandoff.id, taskId: agentHandoff.taskId, assigneeUserId: agentHandoff.assigneeUserId })
    .from(agentHandoff)
    .where(
      and(
        eq(agentHandoff.id, topicId),
        eq(agentHandoff.organizationId, orgId),
        eq(agentHandoff.conversationId, conversationId),
        handoffOpenSql(sql.raw('"agent_handoff"')),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Tema")
  return row
}

/**
 * «Tomar este tema» (sin confirmación; se avisa a quien lo tenía) o «Pasar
 * este tema a…» (`toUserId`). El agente sigue con lo demás (ADR 0050).
 */
export async function takeTopic(
  tx: Db,
  orgId: string,
  input: { conversationId: string; topicId: string; userId: string; toUserId?: string },
) {
  await requireOpenTopic(tx, orgId, input.conversationId, input.topicId)
  return claimHandoff(tx, orgId, input.userId, input.topicId, {
    takeOver: true,
    ...(input.toUserId ? { toUserId: input.toUserId } : {}),
  })
}

/** «Marcar resuelto»: completa la tarea del tema; la conversación sigue con el agente. */
export async function resolveTopic(
  tx: Db,
  orgId: string,
  input: { conversationId: string; topicId: string; userId: string },
): Promise<void> {
  const topic = await requireOpenTopic(tx, orgId, input.conversationId, input.topicId)
  if (topic.taskId) await updateTask(tx, orgId, topic.taskId, { status: "done", actorUserId: input.userId })
}

/**
 * La persona respondió citando un mensaje de alguien del equipo (ADR 0050):
 * va al tema de esa persona. Si tiene uno abierto en el hilo se anota ahí; si
 * no, se le abre uno con este mensaje. El agente no lo responde.
 */
export async function answerToTeamMember(
  tx: Db,
  orgId: string,
  input: { conversationId: string; messageId: string; userId: string },
): Promise<void> {
  const [open] = await tx
    .select({ id: agentHandoff.id })
    .from(agentHandoff)
    .where(
      and(
        eq(agentHandoff.organizationId, orgId),
        eq(agentHandoff.conversationId, input.conversationId),
        eq(agentHandoff.assigneeUserId, input.userId),
        handoffOpenSql(sql.raw('"agent_handoff"')),
      ),
    )
    .orderBy(agentHandoff.createdAt)
    .limit(1)
  if (open) {
    await recordTopicAskedAgain(tx, orgId, { handoffId: open.id, messageId: input.messageId })
    return
  }
  const text = await quotedText(tx, orgId, input.conversationId, input.messageId)
  await createHandoff(tx, orgId, null, {
    conversationId: input.conversationId,
    reason: shortReason(text || "Respondió a tu mensaje"),
    summary: text ? `Respondió a tu mensaje: «${text}»` : "Respondió a tu mensaje",
    priority: "media",
    assigneeUserId: input.userId,
    createdBy: "user",
    sourceMessageId: input.messageId,
  })
}
