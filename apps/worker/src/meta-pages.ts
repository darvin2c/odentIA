import { channelAdapters, ConnectionRejectedError, refreshInstagramLoginToken } from "@odentia/channels"
import { type Db, withOrgContext } from "@odentia/db"
import {
  getConnectionSecrets,
  listInstagramTokensDue,
  listPageConnections,
  noteInstagramRenewFailed,
  notePageTokenState,
  saveRenewedInstagramToken,
} from "@odentia/services"

/**
 * Una vez al día: ¿Facebook sigue aceptando la clave de cada página (Messenger
 * y su Instagram) conectada con el botón? La clave no vence, pero deja de
 * servir si se quita el permiso o cambia quien administra la página, y Meta no
 * siempre lo avisa. Si la rechaza, la fila dice «Necesita atención» y la
 * campana avisa; si vuelve a aceptarla, se borra. Si Facebook no contesta, no se
 * concluye nada.
 */
export async function runPageTokenTick(
  ownerDb: Db,
  appDb: Db,
  opts: { secretsKey: Buffer; fetch: typeof fetch },
): Promise<{ checked: number; changed: number; errors: string[] }> {
  const result = { checked: 0, changed: 0, errors: [] as string[] }
  for (const { orgId, connectionId } of await listPageConnections(ownerDb)) {
    try {
      const { row, config } = await withOrgContext(appDb, orgId, (tx) => getConnectionSecrets(tx, orgId, connectionId, opts.secretsKey))
      const adapter = channelAdapters[row.provider as keyof typeof channelAdapters]
      if (!adapter) continue
      let dead: boolean
      try {
        await adapter.validateConnection(config, { fetch: opts.fetch })
        dead = false
      } catch (error) {
        if (!(error instanceof ConnectionRejectedError)) throw error
        dead = true
      }
      result.checked += 1
      if (await withOrgContext(appDb, orgId, (tx) => notePageTokenState(tx, orgId, connectionId, dead))) result.changed += 1
    } catch (error) {
      result.errors.push(`Página ${connectionId}: ${error instanceof Error ? error.message : "sin detalle"}`)
    }
  }
  return result
}

/**
 * Una vez al día: renueva la clave de cada Instagram conectado a mano antes de
 * que venza (cada 7 días; vence a los 60). Si Instagram ya no la acepta, avisa
 * en la campana; si no contesta, lo intenta al día siguiente.
 */
export async function runInstagramTokenTick(
  ownerDb: Db,
  appDb: Db,
  opts: { secretsKey: Buffer; fetch: typeof fetch },
): Promise<{ renewed: number; failed: number; errors: string[] }> {
  const result = { renewed: 0, failed: 0, errors: [] as string[] }
  for (const due of await listInstagramTokensDue(ownerDb, opts.secretsKey)) {
    try {
      const fresh = await refreshInstagramLoginToken(due.token, { fetch: opts.fetch })
      const saved = await withOrgContext(appDb, due.orgId, (tx) =>
        saveRenewedInstagramToken(tx, due.orgId, due.connectionId, opts.secretsKey, due.token, fresh.accessToken),
      )
      if (saved) result.renewed += 1
    } catch (error) {
      if (error instanceof ConnectionRejectedError) {
        await withOrgContext(appDb, due.orgId, (tx) => noteInstagramRenewFailed(tx, due.orgId, due.connectionId))
        result.failed += 1
        continue
      }
      result.errors.push(`Instagram ${due.connectionId}: ${error instanceof Error ? error.message : "sin detalle"}`)
    }
  }
  return result
}
