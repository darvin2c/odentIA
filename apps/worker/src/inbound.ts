import { channelAdapters } from "@odentia/channels"
import {
  type Db,
  type InboundMessageJob,
  type QueueMessage,
  sendAgentRun,
  withOrgContext,
} from "@odentia/db"
import { agentConfig, channelConnection, conversation } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import {
  handleAutomationReply,
  ingestInbound,
  ServiceError,
  type Storage,
  type TranscribeFn,
} from "@odentia/services"
import { and, eq, sql } from "drizzle-orm"
import { meterAiUse } from "@odentia/agent"

export interface IngestDeps {
  storage: Storage
  fetch: typeof fetch
  secretsKey: Buffer
  transcribe?: TranscribeFn
  /** Ventana de ráfaga: retardo de la corrida del agente tras cada entrante. */
  agentBurstWindowSeconds?: number
}

/** Máximo de entregas pgmq antes de declarar el mensaje venenoso. */
export const MAX_DELIVERIES = 5

async function auditError(
  tx: Db,
  orgId: string,
  action: string,
  entityId: string,
  error: string,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    action,
    entity: "message",
    entityId,
    metadata: { error },
  })
}

/**
 * Procesa un inbound: ingesta (idempotente) y, si corresponde, encola la
 * corrida del agente. Devuelve "done" (ack) o "retry" (sin ack, reaparece
 * tras el vt). Todo corre bajo el RLS de la org del job.
 */
export async function processInbound(
  db: Db,
  deps: IngestDeps,
  msg: QueueMessage<InboundMessageJob>,
): Promise<"done" | "retry"> {
  const { orgId } = msg.message
  try {
    // Lo único que gasta IA aquí es transcribir una nota de voz: queda con su origen.
    await meterAiUse(db, orgId, "transcripcion", () => withOrgContext(db, orgId, async (tx) => {
      const [conn] = await tx
        .select()
        .from(channelConnection)
        .where(
          and(
            eq(channelConnection.id, msg.message.connectionId),
            eq(channelConnection.organizationId, orgId),
          ),
        )
        .limit(1)
      if (!conn) throw new ServiceError("CONNECTION_NOT_FOUND", 404, "Conexión no encontrada")
      const adapter = channelAdapters[conn.provider as keyof typeof channelAdapters]
      if (!adapter)
        throw new ServiceError("VALIDATION", 400, `Proveedor desconocido: ${conn.provider}`)
      const result = await ingestInbound(tx, msg.message, adapter, {
        storage: deps.storage,
        fetch: deps.fetch,
        secretsKey: deps.secretsKey,
        ...(deps.transcribe ? { transcribe: deps.transcribe } : {}),
      })
      if (!result.created) return
      // Un botón de un mensaje automático («Confirmar», «No enviar más») lo
      // resuelve el sistema: no llega al modelo ni gasta una corrida. Va en su
      // propio punto de guardado: si su respuesta no puede salir, el mensaje
      // ya ingresado no se pierde y la conversación sigue su curso normal.
      const content = msg.message.event.content
      if (content.type === "text") {
        const handled = await tx
          .transaction((inner) =>
            handleAutomationReply(
              inner,
              orgId,
              { conversationId: result.conversationId, replyId: content.replyId },
              { storage: deps.storage },
            ),
          )
          .catch((error: unknown) => {
            if (error instanceof ServiceError) return false
            throw error
          })
        if (handled) return
      }
      const [conv] = await tx
        .select({ agentStatus: conversation.agentStatus, status: conversation.status })
        .from(conversation)
        .where(eq(conversation.id, result.conversationId))
        .limit(1)
      const [cfg] = await tx
        .select({ enabled: agentConfig.enabled })
        .from(agentConfig)
        .where(eq(agentConfig.organizationId, orgId))
        .limit(1)
      // El agente nunca responde en una conversación cerrada (ADR 0024); la ingesta ya la reabrió.
      // Un correo que escribió una máquina queda en la bandeja sin gastar una corrida (ADR 0031).
      if (conv?.status === "open" && conv.agentStatus === "on" && cfg?.enabled && !msg.message.event.automated) {
        await sendAgentRun(
          tx,
          {
            kind: "inbound_message",
            orgId,
            conversationId: result.conversationId,
            messageId: result.messageId,
          },
          { delaySeconds: deps.agentBurstWindowSeconds ?? 0 },
        )
      }
    }))
    return "done"
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const skip =
      (error instanceof ServiceError &&
        (error.code === "CONNECTION_NOT_FOUND" ||
          error.code === "CONNECTION_DISABLED" ||
          error.code === "VALIDATION")) ||
      msg.read_ct >= MAX_DELIVERIES
    if (skip) {
      // Basura o veneno: auditar y ack para no bloquear la cola.
      await withOrgContext(db, orgId, (tx) =>
        auditError(tx, orgId, "message.error", msg.message.event.externalEventId, message),
      ).catch(() => {})
      return "done"
    }
    return "retry"
  }
}

/** Ciclo completo: procesa y recién entonces hace ack (delete) del mensaje. */
export async function consumeInbound(
  db: Db,
  deps: IngestDeps,
  msg: QueueMessage<InboundMessageJob>,
): Promise<void> {
  const verdict = await processInbound(db, deps, msg)
  if (verdict === "done") {
    await db.execute(sql`select pgmq.delete('inbound_messages', ${Number(msg.msg_id)}::bigint)`)
  }
}
