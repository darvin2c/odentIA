import { AGREEMENT_VERSION, LEGAL } from "@odentia/auth"
import { withOrgContext } from "@odentia/db"
import { acceptClinicAgreement, clinicAgreementAccepted } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * El Contrato de encargo de tratamiento de la clínica (lienzo «Términos con
 * Google», decisión 2): lo acepta quien la administra (`settings.write`). Los
 * términos y el aviso de cada persona van por el servidor de acceso
 * (`/api/auth/legal/*`).
 */
export function createLegalRoute(deps: CrmDeps) {
  const app = new Hono()
  app.get("/clinic", (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const accepted = await clinicAgreementAccepted(tx, orgId, AGREEMENT_VERSION)
        return {
          needed: !accepted && canAccess(memberRole, "settings.write"),
          version: LEGAL.agreement.version,
          effectiveAt: LEGAL.agreement.effectiveAt,
          changes: LEGAL.agreement.changes,
          // Primera vez (clínica sin ninguna aceptación) o versión nueva.
          first: !accepted && LEGAL.agreement.changes.length === 0,
        }
      }),
    )
  })
  app.post("/clinic/accept", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write"))
      return c.json(
        errorBody(c, "FORBIDDEN", "Solo quien administra la clínica acepta el contrato de encargo"),
        403,
      )
    const parsed = z
      .object({ version: z.literal(AGREEMENT_VERSION) })
      .safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        await acceptClinicAgreement(tx, orgId, userId, AGREEMENT_VERSION)
        return { accepted: true }
      }),
    )
  })
  return app
}
