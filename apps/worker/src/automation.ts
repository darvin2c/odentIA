import type { Db } from "@odentia/db"
import { formatForChannel, meterAiUse } from "@odentia/agent"
import { refreshAgentSearch, type SearchEmbedder, tickAutomations, type TickDeps } from "@odentia/services"
import { sql } from "drizzle-orm"

export interface AutomationWorkerDeps {
  /** Handles compartidos del padre (sin pools nuevos ni cierres aquí). */
  appDb: Db
  ownerDb: Db
  secretsKey: Buffer
  /** Origen público de la plataforma para los enlaces amables /c/ y /baja/. */
  publicBaseUrl: string
  /**
   * Con envío real, el tick pide a WhatsApp las plantillas que faltan. En
   * demostración las deja «en revisión» sin llamar a nadie.
   */
  senderMode: "mock" | "live"
  /** Lee lo último que escribió la persona antes de escribirle por un seguimiento. */
  alreadyTold?: TickDeps["alreadyTold"]
  /** Vectoriza el índice de búsqueda del agente en cada ciclo; sin él, no se toca. */
  embedder?: SearchEmbedder
}

const MAX_DRAIN = 50
/** Cada cuánto se concilia y vectoriza el índice de búsqueda del agente. */
const SEARCH_EVERY_MS = 5 * 60_000
let searchRunning = false
let searchLastStart = 0

/**
 * El índice se refresca aparte y sin esperarlo: el trabajador atiende todas
 * las colas en un solo bucle, y un proveedor de vectores lento no puede
 * demorar los mensajes de los pacientes. Nunca hay dos refrescos a la vez.
 */
function refreshSearchInBackground(deps: AutomationWorkerDeps, embedder: SearchEmbedder): void {
  if (searchRunning || Date.now() - searchLastStart < SEARCH_EVERY_MS) return
  searchRunning = true
  searchLastStart = Date.now()
  refreshAgentSearch(deps.ownerDb, deps.appDb, embedder, {
    meter: (orgId, run) => meterAiUse(deps.appDb, orgId, "vectores", run),
  })
    .then((search) => {
      if (search.embedded || search.failed) {
        console.log(`worker: búsqueda del agente vectorizados=${search.embedded} sin_vector=${search.failed}`)
      }
    })
    .catch((error) => console.error("worker: búsqueda del agente", error instanceof Error ? error.message : error))
    .finally(() => {
      searchRunning = false
    })
}

/**
 * Despertador durable `automation_ticks` (pg_cron cada minuto, sin PII):
 * drena todos los mensajes pendientes (coalescing: si el worker estuvo
 * parado no se acumulan escaneos duplicados), ejecuta un único tick con la
 * hora de la DB (idempotencia) y devuelve si hubo trabajo.
 * QueueDef { name: "automation_ticks", poll } sin readOne/ack propios.
 * `publicBaseUrl` lo aporta el padre desde WEB_URL (origen de plataforma;
 * nunca el origen webhook/API) para los enlaces /c/ y /baja/.
 */
export async function runAutomationTick(deps: AutomationWorkerDeps): Promise<boolean> {
  const { appDb, ownerDb, secretsKey, publicBaseUrl, senderMode, alreadyTold, embedder } = deps
  let pending = 0
  for (let i = 0; i < MAX_DRAIN; i++) {
    const rows = (await appDb.execute(
      sql`select msg_id from pgmq.read('automation_ticks', 30, 1)`,
    )) as unknown as Array<{ msg_id: number | string }>
    const list = Array.isArray(rows) ? rows : []
    if (list.length === 0) break
    const id = Number(list[0]?.msg_id)
    if (!Number.isFinite(id)) break
    pending++
    await appDb.execute(sql`select pgmq.delete('automation_ticks', ${id}::bigint)`)
  }
  if (pending === 0) return false
  const nowRows = (await ownerDb.execute(sql`select now() as now`)) as unknown as Array<{
    now: Date | string
  }>
  const raw = Array.isArray(nowRows) ? nowRows[0]?.now : undefined
  const now = raw instanceof Date ? raw : new Date(typeof raw === "string" ? raw : Date.now())
  const summary = await tickAutomations(ownerDb, appDb, now, {
    secretsKey,
    publicBaseUrl,
    templates: { fetch, validateExternal: senderMode === "live" },
    alreadyTold,
    // Lo que el agente escribe por su cuenta (insistir, despedirse) sale con el formato del canal.
    format: (text, channel, opts) => formatForChannel(text, channel, opts),
  })
  console.log(
    `worker: automations despertadores=${pending} orgs=${summary.orgs} ` +
      `programados=${summary.programados} ` +
      `entregados=${summary.entregados} fallidos=${summary.fallidos} ` +
      `conversaciones insistidas=${summary.insistidas} cerradas=${summary.cerradas} ` +
      `tareas cerradas solas=${summary.tareasCerradas}`,
  )
  // El índice del agente se refresca aparte, sin esperarlo (`refreshSearchInBackground`).
  if (embedder) refreshSearchInBackground(deps, embedder)
  return true
}
