import { randomUUID } from "node:crypto"
import { channelAdapters } from "@odentia/channels"
import { type Db, type OutboundMessageJob, type QueueMessage, withOrgContext } from "@odentia/db"
import { channelConnection, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { decryptConfig, type Storage } from "@odentia/services"
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

/**
 * Envía un mensaje `queued` al proveedor. Reintenta vía pgmq (sin ack);
 * tras MAX_DELIVERIES lo marca `failed` con auditoría y hace ack.
 */
export async function processOutbound(
  db: Db,
  deps: SendDeps,
  msg: QueueMessage<OutboundMessageJob>,
): Promise<"done" | "retry"> {
  const { orgId, messageId } = msg.message
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
      if (!row || row.message.status !== "queued") return
      if (row.conversation.status !== "open" || row.connection.status !== "active") {
        await tx
          .update(message)
          .set({ status: "failed", error: "conversation-closed-or-disabled" })
          .where(eq(message.id, messageId))
        return
      }
      const outbound =
        row.message.contentType === "template"
          ? {
              to: row.conversation.externalThreadId,
              kind: {
                type: "template" as const,
                name: row.message.templateName ?? "",
                language: row.message.templateLanguage ?? "",
                params:
                  Array.isArray(row.message.templateParams) &&
                  row.message.templateParams.every((p): p is string => typeof p === "string")
                    ? row.message.templateParams
                    : [],
              },
            }
          : {
              to: row.conversation.externalThreadId,
              kind: { type: "text" as const, text: row.message.body ?? "" },
            }
      let externalId: string
      if (deps.senderMode === "mock") {
        externalId = `mock-${randomUUID()}`
      } else {
        const config = decryptConfig(deps.secretsKey, row.connection.configEncrypted)
        const adapter = channelAdapters[row.connection.provider as keyof typeof channelAdapters]
        if (!adapter) throw new Error(`Proveedor desconocido: ${row.connection.provider}`)
        externalId = (await adapter.sendMessage(config, outbound, { fetch: deps.fetch })).externalId
      }
      await tx
        .update(message)
        .set({ status: "sent", externalId, error: null })
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
    if (msg.read_ct >= MAX_DELIVERIES) {
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
  }
}
