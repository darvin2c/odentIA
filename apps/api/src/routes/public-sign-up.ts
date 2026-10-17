import { AGREEMENT_VERSION, LEGAL_VERSION } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { getPublicTrialOffer } from "@odentia/services"
import { Hono } from "hono"

/**
 * Lo que necesita la pantalla de crear cuenta del panel: el crédito y los
 * días de prueba del plan por defecto (`offer`, null sin plan) y la versión
 * vigente de los documentos que se aceptan (`legalVersion`). Pública y
 * terminal: nunca sigue hacia `requireSession`.
 */
export function createPublicSignUpRoute(deps: { ownerDb: Db }) {
  const app = new Hono()
  app.get("/", async (c) => {
    c.header("Cache-Control", "public, max-age=300")
    const offer = await getPublicTrialOffer(deps.ownerDb)
    return c.json({ offer, legalVersion: LEGAL_VERSION, agreementVersion: AGREEMENT_VERSION })
  })
  return app
}
