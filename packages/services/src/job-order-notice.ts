import type { Db } from "@odentia/db"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { jobOrder } from "@odentia/db/schema/orders"
import { and, eq, ne, sql } from "drizzle-orm"
import { NOTICE_PURPOSE, ORDER_READY_MESSAGE_KEY, orderReadySubjectOf, renderMessage } from "./automation-messages.js"
import { orgProduct } from "./locale.js"
import { clinicName, firstName } from "./automation-routing.js"
import { serviceRecipient } from "./budget-send.js"
import { currentCatalogMessage } from "./clinic-messages.js"
import { deliveryNoteOf, sendOutbound, sendTemplateOutbound } from "./conversations.js"
import { ServiceError } from "./errors.js"
import { openRoute } from "./message-gate.js"

/**
 * «Pedido listo» (ADR 0171): al marcar «Listo» un pedido, a quien recibe los
 * avisos de la persona, por la vía que haya (la plantilla aprobada, la respuesta
 * dentro de las 24 horas o el correo). El pedido guarda su mensaje: la pantalla
 * dice si salió, si llegó, si falló o si no se sabe, y un aviso dudoso no se
 * reenvía solo ni a ciegas.
 */

export type OrderNoticeStatus = "sin_enviar" | "no_salio" | "en_cola" | "enviado" | "entregado" | "leido" | "fallo" | "dudoso"

export interface OrderNotice {
  status: OrderNoticeStatus
  /** «Enviado por WhatsApp», «No se entregó: …», «No sabemos si llegó…». */
  words: string
  channel: "whatsapp" | "email" | null
  at: string | null
  /** Se puede volver a enviar sin preguntar (no salió o falló); dudoso pide confirmarlo. */
  canResend: boolean
}

const STATUS_OF: Record<string, OrderNoticeStatus> = {
  held: "en_cola",
  queued: "en_cola",
  sent: "enviado",
  delivered: "entregado",
  read: "leido",
  failed: "fallo",
  unknown: "dudoso",
}

/** Cómo va el aviso de un pedido, en palabras; sin aviso, que no salió y por qué. */
export async function orderNoticeOf(tx: Db, orgId: string, order: { readyMessageId: string | null; readyNoticeNote: string | null }): Promise<OrderNotice | null> {
  if (!order.readyMessageId) {
    if (!order.readyNoticeNote) return null
    return { status: "no_salio", words: order.readyNoticeNote, channel: null, at: null, canResend: true }
  }
  const [row] = await tx
    .select({ status: message.status, error: message.error, sentAt: message.sentAt, createdAt: message.createdAt, channel: channelConnection.channel })
    .from(message)
    .innerJoin(conversation, and(eq(conversation.organizationId, message.organizationId), eq(conversation.id, message.conversationId)))
    .leftJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(message.organizationId, orgId), eq(message.id, order.readyMessageId)))
  if (!row) return { status: "dudoso", words: "No encontramos el mensaje del aviso: confirma con la persona antes de volver a enviarlo.", channel: null, at: null, canResend: false }
  const status = STATUS_OF[row.status] ?? "dudoso"
  const channel = row.channel === "email" ? "email" : "whatsapp"
  const by = channel === "email" ? "por correo" : "por WhatsApp"
  const words =
    status === "en_cola"
      ? `Saliendo ${by}.`
      : status === "enviado"
        ? `Enviado ${by}.`
        : status === "entregado"
          ? `Entregado ${by}.`
          : status === "leido"
            ? `Leído ${by}.`
            : (deliveryNoteOf(row.status, row.error) ?? "No sabemos si llegó.")
  return {
    status,
    words,
    channel,
    at: (row.sentAt ?? row.createdAt).toISOString(),
    canResend: status === "fallo",
  }
}

/**
 * Envía «Pedido listo». No deshace lo que pasó si no sale: dice por qué y lo deja
 * anotado en el pedido para que el equipo avise por otra vía. `resend`: un aviso
 * que falló se puede volver a enviar; uno dudoso, solo si quien envía lo confirma.
 */
export async function sendOrderReadyNotice(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  orderId: string,
  options: { resend?: boolean; confirmDoubtful?: boolean } = {},
): Promise<OrderNotice | null> {
  // Al marcar «Listo» el aviso es del sistema: a quien pidió no recibir ningún
  // mensaje no le sale, aunque haya escrito hace poco. Reenviarlo a mano es del
  // equipo: si escribió en las últimas 24 horas, se le responde.
  const initiative = options.resend ? "equipo" : "propia"
  // Dos marcas a la vez no envían dos avisos.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`pedido-listo:${orgId}:${orderId}`}))`)
  const [order] = await tx
    .select({ id: jobOrder.id, patientId: jobOrder.patientId, status: jobOrder.status, readyMessageId: jobOrder.readyMessageId, readyNoticeNote: jobOrder.readyNoticeNote })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.id, orderId)))
  if (!order) throw new ServiceError("NOT_FOUND", 404, "Pedido no encontrado")
  if (order.status !== "listo") throw new ServiceError("JOB_ORDER_NOT_READY", 409, "El aviso sale cuando el pedido está listo")
  // Un pedido que se rehízo sigue en el nuevo: avisar que el original está listo diría algo falso.
  const [remade] = await tx
    .select({ id: jobOrder.id })
    .from(jobOrder)
    .where(and(eq(jobOrder.organizationId, orgId), eq(jobOrder.remakeOf, orderId), ne(jobOrder.status, "anulado")))
    .limit(1)
  if (remade) throw new ServiceError("JOB_ORDER_REMADE", 409, "Este pedido se rehízo: el aviso sale cuando el nuevo esté listo")
  const before = await orderNoticeOf(tx, orgId, order)
  if (before && !options.resend) return before
  if (before?.status === "dudoso" && !options.confirmDoubtful)
    throw new ServiceError("NOTICE_DOUBTFUL", 409, "No sabemos si el aviso anterior llegó: confírmalo con la persona antes de enviarlo otra vez")
  if (before && before.status !== "fallo" && before.status !== "no_salio" && before.status !== "dudoso")
    throw new ServiceError("NOTICE_ALREADY_SENT", 409, "El aviso ya salió")

  const note = async (text: string): Promise<OrderNotice> => {
    await tx.update(jobOrder).set({ readyNoticeNote: text, readyMessageId: null, updatedAt: new Date() }).where(eq(jobOrder.id, orderId))
    return { status: "no_salio", words: text, channel: null, at: null, canResend: true }
  }
  let recipient: Awaited<ReturnType<typeof serviceRecipient>>
  try {
    recipient = await serviceRecipient(tx, orgId, order.patientId)
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    return note("No salió el aviso: no hay a quién avisarle. Llámalo para decirle que puede recogerlo.")
  }
  const spec = await currentCatalogMessage(tx, orgId, ORDER_READY_MESSAGE_KEY)
  const clinic = await clinicName(tx, orgId)
  const { params, text } = renderMessage(spec, { persona: firstName({ givenNames: null, displayName: recipient.displayName }), clinica: clinic })
  const route = await openRoute(tx, orgId, recipient.contactId, spec, { purpose: NOTICE_PURPOSE, initiative })
  if ("cause" in route) return note(`No salió el aviso: ${route.detail}. Llámalo para decirle que puede recogerlo.`)
  let sentId: string
  try {
    // Punto de retorno: que el aviso no salga no deshace el paso del pedido.
    sentId = await tx.transaction(async (inner) => {
      if (route.via === "plantilla" && route.template) {
        // Lo envía el sistema, no quien marcó el paso: la conversación no se da por leída ni pasa a su nombre.
        const sent = await sendTemplateOutbound(inner, orgId, Buffer.alloc(0), {
          conversationId: route.conversationId,
          senderKind: "agent",
          fromAction: true,
          name: route.template.name,
          language: route.template.language,
          params,
          category: spec.category,
          preview: text,
        })
        return sent.id
      }
      const body = route.via === "correo" ? `${orderReadySubjectOf(await orgProduct(tx, orgId))}\n\n${text}\n\nPuedes responder a este correo.\n\n${clinic}` : text
      const sent = await sendOutbound(inner, orgId, {
        conversationId: route.conversationId,
        senderKind: "agent",
        fromAction: true,
        content: { type: "text", text: body },
      })
      return sent.id
    })
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error
    return note(`No salió el aviso: ${error.message}. Llámalo para decirle que puede recogerlo.`)
  }
  await tx.update(jobOrder).set({ readyMessageId: sentId, readyNoticeNote: null, updatedAt: new Date() }).where(eq(jobOrder.id, orderId))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "job_order.ready_notice",
    entity: "job_order",
    entityId: orderId,
    metadata: { messageId: sentId, via: route.via, resend: options.resend === true },
  })
  return orderNoticeOf(tx, orgId, { readyMessageId: sentId, readyNoticeNote: null })
}
