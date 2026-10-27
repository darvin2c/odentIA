import postgres from "postgres"

/** Lo que viaja por `pg_notify('org_events', …)`. Nunca datos clínicos. */
export interface NotifyPayload {
  orgId: string
  kind: string
  taskId?: string | number
  conversationId?: string
  messageId?: string
  /** Solo cambió el acuse (entregado, leído): el hilo lo muestra, las listas no cambian. */
  receipt?: boolean
  at: string
}

type Handler = (payload: NotifyPayload) => void

/**
 * Una sola conexión con `LISTEN org_events` por proceso de la API, repartida
 * en memoria a los streams de cada clínica. Antes cada pestaña abierta tenía
 * su propia conexión a Postgres, y el límite de conexiones de la base se
 * acababa con unas decenas de pestañas. Se abre con el primer stream y queda
 * abierta; postgres.js la reconecta y vuelve a escuchar si se cae.
 */
export function createOrgEventsHub(listenUrl: string) {
  const byOrg = new Map<string, Set<Handler>>()
  let listening: Promise<unknown> | null = null

  function deliver(raw: string) {
    let payload: NotifyPayload
    try {
      payload = JSON.parse(raw) as NotifyPayload
    } catch {
      return
    }
    for (const handler of byOrg.get(payload.orgId) ?? []) handler(payload)
  }

  return {
    /** Recibe los eventos de la clínica hasta llamar a la función que devuelve. */
    async subscribe(orgId: string, handler: Handler): Promise<() => void> {
      const handlers = byOrg.get(orgId) ?? new Set<Handler>()
      byOrg.set(orgId, handlers)
      handlers.add(handler)
      const stop = () => {
        handlers.delete(handler)
        if (handlers.size === 0) byOrg.delete(orgId)
      }
      listening ??= (() => {
        const sql = postgres(listenUrl, { max: 1 })
        return sql.listen("org_events", deliver).catch(async (error: unknown) => {
          // Sin escucha no sirve la conexión: el próximo stream lo vuelve a intentar.
          listening = null
          await sql.end({ timeout: 0 }).catch(() => undefined)
          throw error
        })
      })()
      try {
        await listening
      } catch (error) {
        stop()
        throw error
      }
      return stop
    },
  }
}
