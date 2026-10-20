import { withOrgContext } from "@odentia/db"
import { getReportDigest, readReportDigestToken, setReportDigest } from "@odentia/services"
import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService } from "./helpers.js"

/**
 * «Dejar de recibirlo» del resumen del lunes, sin entrar (ADR 0071): el enlace
 * del correo lleva la clínica y la persona firmadas con la clave del servidor,
 * así que nadie puede apagar el de otra persona. Solo apaga: prenderlo de nuevo
 * es desde Reportes. El padre monta en `/api/public/report-digest`.
 */
export function createPublicReportDigestRoute(deps: { db: CrmDeps["db"]; secretsKey: Buffer }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  async function clinicOf(tx: CrmDeps["db"], orgId: string): Promise<string> {
    const [row] = await tx.execute<{ name: string }>(sql`
      select coalesce(op.trade_name, o.name) as name from organization o
      left join org_profile op on op.organization_id = o.id where o.id = ${orgId}`)
    return row?.name ?? ""
  }

  app.get("/:token", async (c) => {
    const who = readReportDigestToken(deps.secretsKey, c.req.param("token"))
    if (!who) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () =>
      withOrgContext(deps.db, who.orgId, async (tx) => ({ clinic: await clinicOf(tx, who.orgId), ...(await getReportDigest(tx, who.orgId, who.userId)) })),
    )
  })

  app.post("/:token", async (c) => {
    const who = readReportDigestToken(deps.secretsKey, c.req.param("token"))
    if (!who) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () =>
      withOrgContext(deps.db, who.orgId, async (tx) => ({ clinic: await clinicOf(tx, who.orgId), ...(await setReportDigest(tx, who.orgId, who.userId, false)) })),
    )
  })

  return app
}
