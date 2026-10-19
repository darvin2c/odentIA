import { AGREEMENT_VERSION, LEGAL_VERSION } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { getPublicTrialOffer, getSignupMode } from "@odentia/services"
import { Hono } from "hono"

/**
 * Lo que necesita la pantalla de crear cuenta del panel: el crédito y los
 * días de prueba del plan por defecto (`offer`, null sin plan) y la versión
 * vigente de los documentos que se aceptan (`legalVersion`) y si abrir una
 * clínica pide invitación (`signupMode`, Fundadores). Pública y terminal:
 * nunca sigue hacia `requireSession`.
 */
export function createPublicSignUpRoute(deps: { ownerDb: Db }) {
  const app = new Hono()
  app.get("/", async (c) => {
    c.header("Cache-Control", "public, max-age=60")
    const offer = await getPublicTrialOffer(deps.ownerDb)
    const signupMode = await getSignupMode(deps.ownerDb)
    return c.json({ offer, legalVersion: LEGAL_VERSION, agreementVersion: AGREEMENT_VERSION, signupMode })
  })
  return app
}
