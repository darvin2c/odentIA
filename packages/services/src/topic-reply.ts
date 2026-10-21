import type { Db } from "@odentia/db"
import { agentHandoff } from "@odentia/db/schema/agent"
import { message } from "@odentia/db/schema/crm"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { and, eq, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { claimHandoff, createHandoff, recordTopicAskedAgain } from "./agent-operations.js"
import { type MessageItem, type OutboundContent, sendOutbound, startContactConversation } from "./conversations.js"
import { handoffOpenSql } from "./handoff-state.js"
import { offerHeldReplies, whatsappOf } from "./held-replies.js"
import { clinicName } from "./automation-routing.js"
import { claimWhatsAppNumber } from "./contacts.js"
import { openEmailThread } from "./financial-documents.js"
import { updateTask } from "./tasks.js"
import { topicUrgentAt } from "./topic-urgency.js"

/**
 * Una persona del equipo responde en la Bandeja (ADR 0050). Si cita un mensaje
 * de la persona, la respuesta sale citada y responde su tema (pasadas las 24
 * horas de WhatsApp queda «Por entregar» y sale «Ver respuesta», R1):
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
    holdIfClosed: replyTo !== null,
  })
  if (sent.held) await offerInSavepoint(tx, orgId, input.conversationId)
  // En el chat web, la respuesta a su pregunta sale también por donde pidió que le avisen (R4).
  if (replyTo !== null && input.content.type === "text") {
    await forwardWebchatReply(tx, orgId, { conversationId: input.conversationId, userId: input.userId, text: input.content.text })
  }
  if (topic) {
    if (!input.keepPending && topic.taskId) {
      await updateTask(tx, orgId, topic.taskId, { status: "done", actorUserId: input.userId })
      return { ...sent, topicId: topic.id, topicResolved: true }
    }
    // «Enviar, sigue pendiente»: la persona ya tiene una respuesta; las dos horas para «Ahora» vuelven a contar.
    await tx
      .update(agentHandoff)
      .set({ urgentAt: await topicUrgentAt(tx, orgId, new Date()) })
      .where(and(eq(agentHandoff.id, topic.id), eq(agentHandoff.organizationId, orgId)))
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

/**
 * R4 (decisión 10 del pulido de la Bandeja): en el chat web la respuesta del
 * equipo a una pregunta sale también por donde el visitante pidió que le
 * avisen. Por su WhatsApp, «Por entregar» y con «Ver respuesta» si pasaron 24
 * horas; si no dejó WhatsApp, por correo desde la clínica. Si la pestaña sigue
 * abierta, también la ve en el chat. Un número que ya es de otra persona no se
 * usa: nunca se une otra ficha por el número. Una prueba no sale del chat.
 * Va en su punto de guardado: si no sale, la respuesta del chat queda igual.
 */
async function forwardWebchatReply(
  tx: Db,
  orgId: string,
  input: { conversationId: string; userId: string; text: string },
): Promise<"whatsapp" | "correo" | null> {
  const [thread] = await tx
    .select({ provider: channelConnection.provider, isTest: conversation.isTest, contactId: contact.id, phone: contact.phone, email: contact.email })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!thread || thread.provider !== "web_chat" || thread.isTest || (!thread.phone && !thread.email)) return null
  return tx
    .transaction(async (inner): Promise<"whatsapp" | "correo" | null> => {
      if (thread.phone) {
        let whatsapp = await whatsappOf(inner, orgId, thread.contactId)
        if (!whatsapp) {
          // Lo dejó para que le respondan y quien responde lo usa: pasa a ser su
          // WhatsApp, salvo que ya sea de otra persona (ADR 0027).
          const claimed = await claimWhatsAppNumber(inner, orgId, input.userId, thread.contactId, thread.phone).catch((error: unknown) => {
            if (error instanceof ServiceError && error.code === "IDENTITY_IN_USE") return null
            throw error
          })
          if (claimed) whatsapp = await whatsappOf(inner, orgId, thread.contactId)
        }
        if (whatsapp) {
          const started = await startContactConversation(inner, orgId, input.userId, thread.contactId, whatsapp)
          const sent = await sendOutbound(inner, orgId, {
            conversationId: started.id,
            senderKind: "user",
            senderUserId: input.userId,
            content: { type: "text", text: input.text },
            holdIfClosed: true,
          })
          if (sent.held) await offerInSavepoint(inner, orgId, started.id)
          return "whatsapp"
        }
      }
      if (thread.email) {
        const [mailbox] = await inner
          .select({ id: channelConnection.id })
          .from(channelConnection)
          .where(and(eq(channelConnection.organizationId, orgId), eq(channelConnection.channel, "email"), eq(channelConnection.status, "active")))
          .limit(1)
        if (!mailbox) return null
        const mail = await openEmailThread(inner, orgId, input.userId, { contactId: thread.contactId, email: thread.email }, mailbox)
        await sendOutbound(inner, orgId, {
          conversationId: mail.id,
          senderKind: "user",
          senderUserId: input.userId,
          content: { type: "text", text: `${await clinicName(inner, orgId)} respondió tu consulta del chat:\n\n${input.text}` },
        })
        return "correo"
      }
      return null
    })
    .catch((error: unknown) => {
      if (error instanceof ServiceError) return null
      throw error
    })
}

/**
 * «Ver respuesta» al momento, en su punto de guardado: si no sale (Meta lo
 * recategorizó, por ejemplo), la respuesta queda guardada igual y el ciclo lo
 * vuelve a intentar.
 */
async function offerInSavepoint(tx: Db, orgId: string, conversationId: string): Promise<void> {
  await tx
    .transaction((inner) => offerHeldReplies(inner, orgId, conversationId))
    .catch((error: unknown) => {
      if (!(error instanceof ServiceError)) throw error
    })
}

/**
 * «Escribirle por WhatsApp» (tablero 4b del pulido de la Bandeja): en
 * Instagram o Messenger pasaron las 24 horas y esos canales no admiten
 * mensajes aprobados. La respuesta va a su WhatsApp marcado como suyo, «Por
 * entregar» y con «Ver respuesta» (R1): un WhatsApp en el que nunca escribió
 * no admite «Retomar la conversación». El tema que respondía queda resuelto en
 * su conversación, salvo «sigue pendiente» (decisión 4).
 */
export async function replyByWhatsApp(
  tx: Db,
  orgId: string,
  input: { conversationId: string; userId: string; text: string; replyToMessageId?: string | null; keepPending?: boolean },
): Promise<MessageItem & { conversationId: string; topicResolved: boolean }> {
  const [source] = await tx
    .select({ contactId: conversation.contactId, provider: channelConnection.provider })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.id, input.conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!source) throw notFound("Conversación")
  if (source.provider !== "instagram" && source.provider !== "messenger") {
    throw validation("Escribirle por WhatsApp es para una conversación de Instagram o Messenger")
  }
  const whatsapp = await whatsappOf(tx, orgId, source.contactId)
  if (!whatsapp) {
    throw new ServiceError(
      "NO_WHATSAPP",
      409,
      "No tiene un WhatsApp marcado como suyo: márcalo en su página para escribirle por ahí.",
    )
  }
  const replyTo = input.replyToMessageId ?? null
  const topic = replyTo ? await openTopicOf(tx, orgId, input.conversationId, replyTo) : null
  if (topic && topic.assigneeUserId !== input.userId) {
    await claimHandoff(tx, orgId, input.userId, topic.id, { takeOver: true })
  }
  const thread = await startContactConversation(tx, orgId, input.userId, source.contactId, whatsapp)
  const sent = await sendOutbound(tx, orgId, {
    conversationId: thread.id,
    senderKind: "user",
    senderUserId: input.userId,
    content: { type: "text", text: input.text },
    holdIfClosed: true,
  })
  if (sent.held) await offerInSavepoint(tx, orgId, thread.id)
  const resolved = topic !== null && !input.keepPending && topic.taskId !== null
  if (resolved && topic?.taskId) await updateTask(tx, orgId, topic.taskId, { status: "done", actorUserId: input.userId })
  return { ...sent, conversationId: thread.id, topicResolved: resolved }
}

/**
 * «Responder» desde Inicio (R3 y decisión 3 del pulido de la Bandeja): el
 * odontólogo responde la duda clínica que le pasaron y caja el tema de un
 * pago, sin entrar a la Bandeja. Es la misma respuesta de la Bandeja
 * (`sendTeamReply`): cita la pregunta, toma el tema y lo resuelve. Se responde
 * lo propio o lo que nadie tomó; quién puede tenerlo lo decide `claimHandoff`.
 */
export async function replyToTopic(
  tx: Db,
  orgId: string,
  input: { topicId: string; userId: string; text: string },
): Promise<MessageItem & { topicId: string | null; topicResolved: boolean }> {
  const [topic] = await tx
    .select({
      id: agentHandoff.id,
      conversationId: agentHandoff.conversationId,
      sourceMessageId: agentHandoff.sourceMessageId,
      assigneeUserId: agentHandoff.assigneeUserId,
      taskId: agentHandoff.taskId,
    })
    .from(agentHandoff)
    .where(and(eq(agentHandoff.id, input.topicId), eq(agentHandoff.organizationId, orgId), handoffOpenSql(sql.raw('"agent_handoff"'))))
    .limit(1)
  if (!topic?.conversationId) throw notFound("Tema")
  if (topic.assigneeUserId !== null && topic.assigneeUserId !== input.userId) {
    throw new ServiceError("TOPIC_TAKEN", 409, "Este tema ya lo tiene otra persona del equipo.")
  }
  // Primero se toma este tema: `claimHandoff` dice si quien responde puede tenerlo.
  if (topic.assigneeUserId !== input.userId) await claimHandoff(tx, orgId, input.userId, topic.id, { takeOver: true })
  if (topic.sourceMessageId) {
    return sendTeamReply(tx, orgId, {
      conversationId: topic.conversationId,
      userId: input.userId,
      content: { type: "text", text: input.text },
      replyToMessageId: topic.sourceMessageId,
    })
  }
  // Sin mensaje que citar: se responde sin cita y el tema se resuelve igual.
  const sent = await sendOutbound(tx, orgId, {
    conversationId: topic.conversationId,
    senderKind: "user",
    senderUserId: input.userId,
    content: { type: "text", text: input.text },
  })
  if (topic.taskId) await updateTask(tx, orgId, topic.taskId, { status: "done", actorUserId: input.userId })
  return { ...sent, topicId: topic.id, topicResolved: topic.taskId !== null }
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
