import { createHash } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { automationLinkToken } from "@odentia/db/schema/automation"
import { getPublicLinkInfo, personalLinkForEmailToken, unsubscribeByToken } from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService } from "./helpers.js"

/**
 * Enlaces públicos seguros (los de la cita, que llevan a «Su enlace», y la baja). Sin sesión: el
 * token opaco (hash en DB) resuelve el tenant; las respuestas nunca incluyen
 * paciente ni contacto. El padre monta en `/api/public/automations`.
 */
export function createPublicAutomationsRoute(deps: { db: CrmDeps["db"]; ownerDb: CrmDeps["db"]; secretsKey: Buffer }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  async function orgIdOf(token: string): Promise<string | null> {
    const hash = createHash("sha256").update(token).digest("hex")
    const [link] = await deps.ownerDb
      .select({ organizationId: automationLinkToken.organizationId })
      .from(automationLinkToken)
      .where(eq(automationLinkToken.tokenHash, hash))
      .limit(1)
    return link?.organizationId ?? null
  }

  // Confirmar o cancelar desde un correo solo lleva a «Su enlace» (ADR 0037):
  // con el token del correo, aún vigente, se da el enlace de esa persona con
  // esa cita, y ahí la confirma, la cambia o la cancela.
  app.post("/cita/:token/enlace", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => personalLinkForEmailToken(tx, orgId, token, { secretsKey: deps.secretsKey })),
    )
  })

  app.get("/baja/:token", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPublicLinkInfo(tx, token)))
  })

  app.post("/baja/:token", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => unsubscribeByToken(tx, token)))
  })

  return app
}
