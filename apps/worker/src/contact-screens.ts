import { channelAdapters } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import { channelConnection } from "@odentia/db/schema/crm"
import {
  decryptConfig,
  orgsWithOldSpam,
  pendingProviderBlocks,
  recordProviderBlock,
  redactOldSpam,
  type Storage,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"

export interface ContactScreensDeps {
  appDb: Db
  ownerDb: Db
  storage: Storage
  fetch: typeof fetch
  secretsKey: Buffer
  /** En demostración no se llama a WhatsApp: el bloqueo queda solo en odentIA. */
  senderMode: "mock" | "live"
}

/**
 * Lo que Spam y Bloquear dejan para el trabajador (ADR 0054), una vez por
 * minuto:
 * - Bloquear o desbloquear en WhatsApp lo que el proveedor aún no sabe
 *   (decisión 13). Bloquear y desbloquear dos veces deja lo mismo, así que un
 *   intento fallido se repite en el ciclo siguiente.
 * - Borrar el texto y los adjuntos de lo que sigue en Spam pasados 90 días
 *   (decisión 16); los adjuntos se quitan del almacenamiento después de
 *   confirmar, y si uno falla queda huérfano, nunca a la vista.
 */
export async function runContactScreensTick(deps: ContactScreensDeps): Promise<{ blocks: number; redacted: number }> {
  let blocks = 0
  if (deps.senderMode === "live") {
    for (const work of await pendingProviderBlocks(deps.ownerDb)) {
      try {
        const done = await withOrgContext(deps.appDb, work.organizationId, async (tx) => {
          const [conn] = await tx
            .select()
            .from(channelConnection)
            .where(and(eq(channelConnection.organizationId, work.organizationId), eq(channelConnection.id, work.connectionId)))
            .limit(1)
          const adapter = conn ? channelAdapters[conn.provider as keyof typeof channelAdapters] : undefined
          if (!conn || !adapter?.setBlocked) return false
          const result = await adapter.setBlocked(
            decryptConfig(deps.secretsKey, conn.configEncrypted),
            { users: [work.externalUserId], blocked: work.block },
            { fetch: deps.fetch },
          )
          if (!result.done.includes(work.externalUserId)) return false
          await recordProviderBlock(tx, work.organizationId, work.identityId, work.block)
          return true
        })
        if (done) blocks += 1
      } catch (error) {
        console.error(
          `worker: ${work.block ? "bloqueo" : "desbloqueo"} en WhatsApp`,
          error instanceof Error ? error.message : error,
        )
      }
    }
  }
  let redacted = 0
  for (const orgId of await orgsWithOldSpam(deps.ownerDb)) {
    const result = await withOrgContext(deps.appDb, orgId, (tx) => redactOldSpam(tx, orgId))
    redacted += result.redacted
    for (const key of result.objectKeys) {
      await deps.storage.deleteAttachment(key).catch((error: unknown) => {
        console.error("worker: adjunto de spam sin borrar", error instanceof Error ? error.message : error)
      })
    }
  }
  return { blocks, redacted }
}
