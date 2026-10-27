import { AGREEMENT_VERSION, LEGAL_VERSION } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { currentSaasTerms, getPublicTrialOffer, getSignupMode } from "@odentia/services"
import type { ClinicalProduct } from "@odentia/clinical"
import { type Context, Hono } from "hono"

/**
 * Lo que necesita la pantalla de crear cuenta del panel: el crédito y los
 * días de prueba del plan por defecto (`offer`, null sin plan) y la versión
 * vigente de los documentos que se aceptan (`legalVersion`), si abrir una
 * clínica pide invitación (`signupMode`, Fundadores) y en cuántos días hábiles
 * se responde una solicitud (`waitlistAnswerDays`, condiciones comerciales).
 * Pública y terminal: nunca sigue hacia `requireSession`.
 */
export function createPublicSignUpRoute(deps: { ownerDb: Db; productOf?: (c: Context) => ClinicalProduct }) {
  const app = new Hono()
  app.get("/", async (c) => {
    c.header("Cache-Control", "public, max-age=60")
    // La oferta y cómo se entra son los del producto del dominio (ADR 0093).
    const product = deps.productOf?.(c) ?? "dental"
    const offer = await getPublicTrialOffer(deps.ownerDb, product)
    const signupMode = await getSignupMode(deps.ownerDb, product)
    const { waitlistAnswerDays } = await currentSaasTerms(deps.ownerDb)
    return c.json({ offer, legalVersion: LEGAL_VERSION, agreementVersion: AGREEMENT_VERSION, signupMode, waitlistAnswerDays })
  })
  return app
}
