import { randomUUID } from "node:crypto"
import { channelAdapters, type OutboundMessage } from "@odentia/channels"
import { type Db, type OutboundMessageJob, type QueueMessage, withOrgContext } from "@odentia/db"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { decryptConfig, isSaasSendBlocked, resolvePersonalLinkRefs, type Storage } from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { MAX_DELIVERIES } from "./inbound.js"
export interface SendDeps {
  storage: Storage
  fetch: typeof fetch
  secretsKey: Buffer
  /** mock = sin HTTP (dev/e2e); live = envío real al proveedor. */
  senderMode: "mock" | "live"
}

async function notify(tx: Db, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

interface MediaAttachment {
  objectKey: string
  mimeType: string
  filename: string
}

function isMediaAttachment(value: unknown): value is MediaAttachment {
  return (
    !!value &&
    typeof value === "object" &&
    "objectKey" in value &&
    typeof value.objectKey === "string" &&
    "mimeType" in value &&
    typeof value.mimeType === "string" &&
    "filename" in value &&
    typeof value.filename === "string"
  )
}

async function buildOutbound(
  row: {
    message: typeof message.$inferSelect
    conversation: typeof conversation.$inferSelect
  },
  deps: SendDeps,
): Promise<OutboundMessage> {
  const to = row.conversation.externalThreadId
  const m = row.message
  if (m.contentType === "template") {
    return {
      to,
      kind: {
        type: "template",
        name: m.templateName ?? "",
        language: m.templateLanguage ?? "",
        params:
          Array.isArray(m.templateParams) &&
          m.templateParams.every((p): p is string => typeof p === "string")
            ? m.templateParams
            : [],
        ...(replyButtonsOf(m.replyButtons) ? { buttons: replyButtonsOf(m.replyButtons)! } : {}),
        // «Su enlace» no se guarda: el token se pone aquí, al entregarlo.
        ...(m.templateLink ? { link: resolvePersonalLinkRefs(m.templateLink, deps.secretsKey) } : {}),
      },
    }
  }
  if (m.contentType === "image" || m.contentType === "audio" || m.contentType === "document") {
    const [att] = Array.isArray(m.attachments) ? m.attachments : []
    if (!isMediaAttachment(att)) throw new Error("Mensaje media sin adjunto válido")
    // TTL 1h: Meta/Telegram descargan el link al enviar; el default es corto ante reintentos.
    const url = await deps.storage.attachmentUrl(att.objectKey, 3600)
    return {
      to,
      kind: {
        type: "media",
        media: {
          url,
          mimeType: att.mimeType,
          filename: att.filename,
          caption: m.body ? resolvePersonalLinkRefs(m.body, deps.secretsKey) : undefined,
        },
      },
    }
  }
  const buttons = replyButtonsOf(m.replyButtons)
  return {
    to,
    // La baja de un correo automático va también en su cabecera (RFC 2369).
    ...(m.listUnsubscribe ? { listUnsubscribe: m.listUnsubscribe } : {}),
    kind: { type: "text", text: resolvePersonalLinkRefs(m.body ?? "", deps.secretsKey), ...(buttons ? { buttons } : {}) },
  }
}

function replyButtonsOf(value: unknown): { id: string; title: string }[] | null {
  if (!Array.isArray(value)) return null
  const buttons = value.filter(
    (item): item is { id: string; title: string } =>
      !!item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string",
  )
  return buttons.length > 0 ? buttons : null
}

/**
 * Envía un mensaje `queued` al proveedor. Solo reintenta errores anteriores a
 * la llamada externa; una excepción durante `sendMessage` es ambigua y exige
 * conciliación humana para no duplicar el efecto.
 */
export async function processOutbound(
  db: Db,
  deps: SendDeps,
  msg: QueueMessage<OutboundMessageJob>,
): Promise<"done" | "retry" | "deferred"> {
  const { orgId, messageId } = msg.message
  // Restricción/pausa comercial: no se envía, no se pierde, no cuenta como
  // fallo (sale por "deferred" con VT largo; el reintento envenenado tampoco
  // declara fallo mientras siga bloqueada). La ingesta entrante no pasa aquí.
  if (await isSaasSendBlocked(db, orgId)) {
    await withOrgContext(db, orgId, async (tx) => {
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        action: "message.updated",
        entity: "message",
        entityId: messageId,
        metadata: { op: "send-deferred", reason: "saas-restricted" },
      })
    })
    return "deferred"
  }
  let providerAttempted = false
  try {
    await withOrgContext(db, orgId, async (tx) => {
      const [row] = await tx
        .select({ message, conversation, connection: channelConnection })
        .from(message)
        .innerJoin(conversation, eq(message.conversationId, conversation.id))
        .innerJoin(channelConnection, eq(conversation.channelConnectionId, channelConnection.id))
        .where(and(eq(message.id, messageId), eq(message.organizationId, orgId)))
        .limit(1)
      // Mensaje inexistente o ya procesado: ack.
      if (row?.message.status !== "queued") return
      // Una conversación cerrada sí entrega lo que ya estaba en cola: la
      // despedida sale y enseguida se cierra (ADR 0024). Solo una conexión
      // desactivada lo impide.
      if (row.connection.status !== "active") {
        await tx
          .update(message)
          .set({ status: "failed", error: "connection-disabled" })
          .where(eq(message.id, messageId))
        return
      }
      const built: OutboundMessage = await buildOutbound(row, deps)
      // Respuesta citada (ADR 0050): el id del proveedor del mensaje citado.
      let outbound = built
      if (row.message.replyToMessageId) {
        const [quoted] = await tx
          .select({ externalId: message.externalId })
          .from(message)
          .where(and(eq(message.id, row.message.replyToMessageId), eq(message.conversationId, row.message.conversationId)))
          .limit(1)
        if (quoted?.externalId && !quoted.externalId.startsWith("mock-")) {
          outbound = { ...built, replyToExternalId: quoted.externalId }
        }
      }
      let externalId: string
      if (deps.senderMode === "mock") {
        externalId = `mock-${randomUUID()}`
      } else {
        const config = decryptConfig(deps.secretsKey, row.connection.configEncrypted)
        const adapter = channelAdapters[row.connection.provider as keyof typeof channelAdapters]
        if (!adapter) throw new Error(`Proveedor desconocido: ${row.connection.provider}`)
        providerAttempted = true
        externalId = (await adapter.sendMessage(config, outbound, { fetch: deps.fetch })).externalId
      }
      await tx
        .update(message)
        .set({
          status: "sent", externalId, error: null,
          // El envío de demostración no acredita aceptación de un proveedor.
          sentAt: deps.senderMode === "live" ? sql`coalesce(${message.sentAt}, clock_timestamp())` : null,
        })
        .where(eq(message.id, messageId))
      await notify(tx, {
        orgId,
        kind: "message.updated",
        conversationId: row.conversation.id,
        messageId,
        at: new Date().toISOString(),
      })
    })
    return "done"
  } catch (error) {
    if (providerAttempted) {
      const detail = error instanceof Error ? error.message : String(error)
      await withOrgContext(db, orgId, async (tx) => {
        await tx
          .update(message)
          .set({ status: "unknown", error: `ambiguous: ${detail.slice(0, 480)}` })
          .where(and(eq(message.id, messageId), eq(message.organizationId, orgId)))
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "message.updated",
          entity: "message",
          entityId: messageId,
          metadata: { op: "send-uncertain", error: detail.slice(0, 500) },
        })
      }).catch(() => {})
      return "done"
    }
    if (msg.read_ct >= MAX_DELIVERIES) {
      // Bloqueada: el conteo de lecturas no declara fallo (sigue diferida).
      if (await isSaasSendBlocked(db, orgId).catch(() => false)) return "deferred"
      const detail = error instanceof Error ? error.message : String(error)
      await withOrgContext(db, orgId, async (tx) => {
        await tx
          .update(message)
          .set({ status: "failed", error: detail.slice(0, 500) })
          .where(and(eq(message.id, messageId), eq(message.organizationId, orgId)))
        await tx.insert(auditEvent).values({
          organizationId: orgId,
          action: "message.updated",
          entity: "message",
          entityId: messageId,
          metadata: { op: "send-failed", error: detail.slice(0, 500) },
        })
      }).catch(() => {})
      return "done"
    }
    return "retry"
  }
}

/** Ciclo completo: envía y recién entonces hace ack (delete) del mensaje. */
export async function consumeOutbound(
  db: Db,
  deps: SendDeps,
  msg: QueueMessage<OutboundMessageJob>,
): Promise<void> {
  const verdict = await processOutbound(db, deps, msg)
  if (verdict === "done") {
    await db.execute(sql`select pgmq.delete('outbound_messages', ${Number(msg.msg_id)}::bigint)`)
  } else if (verdict === "deferred") {
    // Sin ack y sin contar fallo: reaparece en 6 h para reevaluar (o antes si
    // alguien reanuda y reencola). El mensaje queda `queued` hasta entonces.
    await db.execute(sql`select pgmq.set_vt('outbound_messages', ${Number(msg.msg_id)}::bigint, 21600)`)
  }
}
