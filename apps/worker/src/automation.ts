import type { Db } from "@odentia/db"
import { tickAutomations } from "@odentia/services"
import { sql } from "drizzle-orm"

export interface AutomationWorkerDeps {
  /** Handles compartidos del padre (sin pools nuevos ni cierres aquí). */
  appDb: Db
  ownerDb: Db
  secretsKey: Buffer
  /** Origen público de la plataforma para los enlaces amables /c/ y /baja/. */
  publicBaseUrl: string
}

const MAX_DRAIN = 50

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
  const { appDb, ownerDb, secretsKey, publicBaseUrl } = deps
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
  const summary = await tickAutomations(ownerDb, appDb, now, { secretsKey, publicBaseUrl })
  console.log(
    `worker: automations despertadores=${pending} orgs=${summary.orgs} ` +
      `programados=${summary.programados} entregados=${summary.entregados} fallidos=${summary.fallidos}`,
  )
  return true
}
