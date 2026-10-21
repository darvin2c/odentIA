import type { Db } from "@odentia/db"
import { channelConnection, contact, contactIdentity, conversation, message } from "@odentia/db/schema/crm"
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm"
import { ANSWER_READY_MESSAGE_KEY, NOTICE_PURPOSE, renderMessage, replyId } from "./automation-messages.js"
import { clinicName, firstName } from "./automation-routing.js"
import { currentCatalogMessage, findMessageTemplate } from "./clinic-messages.js"
import { sendTemplateOutbound } from "./conversations.js"
import { ServiceError } from "./errors.js"
import { mayWriteFirst } from "./message-permission.js"
import { windowOpen } from "./message-window.js"
import { isWritingTime, writingScheduleOf } from "./writing-hours.js"

/**
 * Responder pasadas las 24 horas (R1 del pulido de la Bandeja). La respuesta
 * del equipo a un tema queda «Por entregar» (`message.status` 'held', la deja
 * `sendOutbound` con `holdIfClosed`) y a la persona le llega «Ver respuesta»,
 * un mensaje aprobado del catálogo. Al tocarlo, o al volver a escribir, salen
 * las respuestas guardadas (`deliverHeldReplies`). Es la respuesta a lo que
 * preguntó: un aviso que solo frena «No quiero ningún mensaje» (ADR 0040).
 */

export type HeldOffer =
  /** Salió «Ver respuesta». */
  | "enviado"
  /** Ya salió uno después de la primera respuesta guardada: varias salen con un solo aviso. */
  | "ya_ofrecido"
  | "sin_pendientes"
  /** Pidió no recibir ningún mensaje de la clínica: la respuesta sale cuando vuelva a escribir. */
  | "sin_permiso"
  /** Meta todavía no aprueba «Ver respuesta»: el ciclo lo envía cuando lo apruebe. */
  | "sin_aprobar"
  /** Lo envía el ciclo, fuera del «Horario para escribir»: espera a que abra. */
  | "fuera_de_horario"

/**
 * Envía «Ver respuesta» si hay respuestas por entregar y todavía no se le
 * ofreció. Lo llama quien responde (al momento: lo manda el equipo, ADR 0042)
 * y el ciclo del worker (`systemTurn`), que solo escribe dentro del «Horario
 * para escribir»: así sale cuando Meta lo aprueba.
 */
export async function offerHeldReplies(
  tx: Db,
  orgId: string,
  conversationId: string,
  opts: { now?: Date; systemTurn?: boolean } = {},
): Promise<HeldOffer> {
  const now = opts.now ?? new Date()
  const [first] = await tx
    .select({ createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.conversationId, conversationId), eq(message.status, "held")))
    .orderBy(asc(message.createdAt))
    .limit(1)
  if (!first) return "sin_pendientes"
  // El botón lleva la conversación: así se sabe si ya se ofreció desde la primera respuesta guardada.
  const button = replyId("ver_respuesta", conversationId)
  const [offered] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.conversationId, conversationId),
        eq(message.direction, "out"),
        eq(message.contentType, "template"),
        ne(message.status, "failed"),
        gt(message.createdAt, first.createdAt),
        sql`${message.replyButtons} @> ${JSON.stringify([{ id: button }])}::jsonb`,
      ),
    )
    .limit(1)
  if (offered) return "ya_ofrecido"
  const [person] = await tx
    .select({
      contactId: contact.id,
      givenNames: contact.givenNames,
      displayName: contact.displayName,
      connectionId: conversation.channelConnectionId,
    })
    .from(conversation)
    .innerJoin(contact, eq(contact.id, conversation.contactId))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!person) return "sin_pendientes"
  if (!(await mayWriteFirst(tx, orgId, person.contactId, NOTICE_PURPOSE))) return "sin_permiso"
  if (opts.systemTurn && !isWritingTime(now, await writingScheduleOf(tx, orgId))) return "fuera_de_horario"
  const template = await findMessageTemplate(tx, orgId, person.connectionId, ANSWER_READY_MESSAGE_KEY)
  if (template?.status !== "aprobada") return "sin_aprobar"
  const spec = await currentCatalogMessage(tx, orgId, ANSWER_READY_MESSAGE_KEY)
  const { params, text } = renderMessage(spec, {
    persona: firstName(person),
    clinica: await clinicName(tx, orgId),
  })
  await sendTemplateOutbound(tx, orgId, Buffer.alloc(0), {
    conversationId,
    senderKind: "agent",
    name: template.name,
    language: template.language,
    params,
    category: spec.category,
    buttons: spec.buttons.map((item) => ({ id: replyId(item.action, conversationId), title: item.title })),
    preview: text,
  })
  return "enviado"
}

/**
 * El ciclo del worker: ofrece «Ver respuesta» donde quedó alguna respuesta
 * por entregar sin ofrecer (Meta no lo había aprobado, o se respondió fuera
 * del horario). Cada conversación va en su punto de guardado: una que no
 * puede salir no frena a las demás.
 */
export async function offerPendingHeldReplies(tx: Db, orgId: string, now: Date): Promise<number> {
  const rows = await tx
    .selectDistinct({ conversationId: message.conversationId })
    .from(message)
    .where(and(eq(message.organizationId, orgId), eq(message.status, "held")))
    .limit(50)
  let sent = 0
  for (const row of rows) {
    const outcome = await tx
      .transaction((inner) => offerHeldReplies(inner, orgId, row.conversationId, { now, systemTurn: true }))
      .catch((error: unknown) => {
        if (error instanceof ServiceError) return null
        throw error
      })
    if (outcome === "enviado") sent++
  }
  return sent
}

/** Lo que dice la zona de escritura antes de responder pasadas las 24 horas (R1 y tablero 4b). */
export interface LateReply {
  /** WhatsApp: Meta aprobó «Ver respuesta»; si no, la respuesta espera a que lo apruebe o a que vuelva a escribir. */
  answerReady: boolean
  /**
   * Instagram y Messenger: la ventana de 24 horas, que no admite mensajes
   * aprobados, y si la persona tiene un WhatsApp marcado como suyo para
   * «Escribirle por WhatsApp» (`whatsappOpen`: escribió por ahí en las últimas
   * 24 horas y la respuesta sale directa, sin «Ver respuesta»). Nulo en los
   * demás canales.
   */
  metaWindow: { open: boolean; lastInboundAt: string | null; whatsapp: boolean; whatsappOpen: boolean } | null
}

export async function lateReplyOf(tx: Db, orgId: string, conversationId: string): Promise<LateReply> {
  const [row] = await tx
    .select({
      contactId: conversation.contactId,
      lastInboundAt: conversation.lastInboundAt,
      connectionId: channelConnection.id,
      provider: channelConnection.provider,
    })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.id, conversationId), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) return { answerReady: false, metaWindow: null }
  if (row.provider === "whatsapp_cloud_api") {
    const template = await findMessageTemplate(tx, orgId, row.connectionId, ANSWER_READY_MESSAGE_KEY)
    return { answerReady: template?.status === "aprobada", metaWindow: null }
  }
  if (row.provider !== "instagram" && row.provider !== "messenger") return { answerReady: false, metaWindow: null }
  const open = windowOpen(row.lastInboundAt)
  const whatsapp = open ? null : await whatsappOf(tx, orgId, row.contactId)
  const [thread] = whatsapp
    ? await tx
        .select({ lastInboundAt: conversation.lastInboundAt })
        .from(conversation)
        .where(
          and(
            eq(conversation.organizationId, orgId),
            eq(conversation.contactIdentityId, whatsapp.identityId),
            eq(conversation.channelConnectionId, whatsapp.connectionId),
          ),
        )
        .limit(1)
    : []
  return {
    answerReady: false,
    metaWindow: {
      open,
      lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
      whatsapp: whatsapp !== null,
      whatsappOpen: windowOpen(thread?.lastInboundAt ?? null),
    },
  }
}

/**
 * El WhatsApp marcado como suyo y la conexión por la que se le escribe; nulo
 * si no tiene o la clínica no tiene WhatsApp. Un número solo es suyo por la
 * decisión de una persona del equipo (ADR 0027): aquí no se marca ninguno.
 */
export async function whatsappOf(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<{ identityId: string; connectionId: string } | null> {
  const [connection] = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, "whatsapp"),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
    .limit(1)
  if (!connection) return null
  const [identity] = await tx
    .select({ id: contactIdentity.id })
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.contactId, contactId),
        eq(contactIdentity.channel, "whatsapp"),
        isNull(contactIdentity.noWhatsappAt),
      ),
    )
    .orderBy(sql`${contactIdentity.isPrimary} desc`, asc(contactIdentity.createdAt), asc(contactIdentity.id))
    .limit(1)
  return identity ? { identityId: identity.id, connectionId: connection.id } : null
}
