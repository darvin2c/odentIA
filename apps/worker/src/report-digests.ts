import { type Db, withOrgContext } from "@odentia/db"
import { claimReportDigest, completeReportDigest, composeReportDigest, dueReportDigests, noticeMissedReportDigest } from "@odentia/services"
import { sql } from "drizzle-orm"
import { shouldSkipSaasOrg } from "./saas-billing.js"

/** Envío mínimo compatible con el Mailer de `@odentia/mail`. */
export interface ReportDigestMailSender {
  send(message: { to: string; subject: string; html: string; text: string }): Promise<void>
}

export interface ReportDigestWorkerDeps {
  ownerDb: Db
  appDb: Db
  mailer: ReportDigestMailSender
  secretsKey: Buffer
  /** La hora de la base, para que todas las réplicas decidan lo mismo; las pruebas la fijan. */
  now?: Date
}

export interface ReportDigestTickResult {
  mailed: number
  skipped: number
  uncertain: number
}

/** Avisar sin romper el ciclo: que no se pueda avisar no cambia lo que ya quedó anotado. */
async function tell(
  deps: ReportDigestWorkerDeps,
  due: { orgId: string; userId: string; week: string },
  why: "incierto" | "no_se_pudo_armar",
): Promise<void> {
  try {
    await withOrgContext(deps.appDb, due.orgId, (tx) => noticeMissedReportDigest(tx, due.orgId, due.userId, due.week, why))
  } catch (error) {
    console.error(`worker: aviso del resumen del lunes sin crear (${due.orgId})`, error)
  }
}

/**
 * Una vuelta del resumen del lunes (ADR 0071): a quien le toca ahora (lunes
 * desde las 8:00 en la zona de su clínica), se reserva su semana antes de
 * armarlo y enviarlo. Si el envío falla queda incierto y no se repite; si no
 * hubo movimientos o la persona ya no ve Reportes, queda omitido con su motivo.
 * Una clínica en pausa comercial no recibe correos de Argos.
 */
export async function runReportDigestTick(deps: ReportDigestWorkerDeps): Promise<ReportDigestTickResult> {
  const now = deps.now ?? new Date(((await deps.ownerDb.execute<{ now: string }>(sql`select now()::text as now`))[0]?.now ?? new Date().toISOString()))
  const result: ReportDigestTickResult = { mailed: 0, skipped: 0, uncertain: 0 }
  for (const due of await dueReportDigests(deps.ownerDb, now)) {
    const claimed = await withOrgContext(deps.appDb, due.orgId, (tx) => claimReportDigest(tx, due.orgId, due.userId, due.week))
    if (!claimed) continue
    const finish = (state: "enviado" | "incierto" | "omitido", detail: string | null = null) =>
      withOrgContext(deps.appDb, due.orgId, (tx) => completeReportDigest(tx, due.orgId, claimed, state, detail, now))
    // En pausa queda omitida esa semana: así no vuelve a la lista ni tapa a las demás clínicas.
    if (await shouldSkipSaasOrg(deps.ownerDb, due.orgId)) {
      await finish("omitido", "pausa_comercial")
      result.skipped += 1
      continue
    }
    let composed: Awaited<ReturnType<typeof composeReportDigest>>
    try {
      composed = await withOrgContext(deps.appDb, due.orgId, (tx) => composeReportDigest(tx, due.orgId, due.userId, due.week, { secretsKey: deps.secretsKey, now }))
    } catch (error) {
      console.error(`worker: resumen del lunes sin armar (${due.orgId})`, error)
      await finish("omitido", "no_se_pudo_armar")
      await tell(deps, due, "no_se_pudo_armar")
      result.skipped += 1
      continue
    }
    if ("skip" in composed) {
      await finish("omitido", composed.skip)
      result.skipped += 1
      continue
    }
    try {
      await deps.mailer.send({ to: composed.to, ...composed.mail })
      await finish("enviado")
      result.mailed += 1
    } catch (error) {
      await finish("incierto", error instanceof Error ? error.message : String(error))
      await tell(deps, due, "incierto")
      result.uncertain += 1
    }
  }
  return result
}
