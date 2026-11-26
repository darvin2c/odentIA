import { AGREEMENT_VERSION, LEGAL_VERSION } from "@odentia/auth"
import type { Db } from "@odentia/db"
import { getPublicTrialOffer } from "@odentia/services"
import type { ClinicalProduct } from "@odentia/clinical"
import { type Context, Hono } from "hono"

/**
 * Lo que necesita la pantalla de crear cuenta del panel: el crédito y los
 * días de prueba del plan por defecto (`offer`, null sin plan) y la versión
 * vigente de los documentos que se aceptan (`legalVersion`). El alta es libre
 * (ADR 0221): ya no dice si abrir una clínica pide invitación.
 * Pública y terminal: nunca sigue hacia `requireSession`.
 */
export function createPublicSignUpRoute(deps: { ownerDb: Db; productOf?: (c: Context) => ClinicalProduct }) {
  const app = new Hono()
  app.get("/", async (c) => {
    c.header("Cache-Control", "public, max-age=60")
    // La oferta es la del producto del dominio (ADR 0093).
    const product = deps.productOf?.(c) ?? "dental"
    const offer = await getPublicTrialOffer(deps.ownerDb, product)
    return c.json({ offer, legalVersion: LEGAL_VERSION, agreementVersion: AGREEMENT_VERSION })
  })
  return app
}
