import { withOrgContext } from "@odentia/db"
import { applyClinicImportBatch, clinicImportPlanSchema, previewClinicImport } from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { AppDeps } from "../app.js"
import { adminContextOf } from "../lib/admin-context.js"
import { errorBody } from "../lib/error.js"
import { runService, validationError } from "./helpers.js"

/**
 * Cargar los datos de una clínica (ADR 0104): el ensayo y la carga por tandas
 * del plan que prepara la skill de carga. Solo administración (lo exige el
 * servicio), con la conexión owner y el contexto de la clínica abierto. Cada
 * tanda es una transacción corta: si se corta, se sigue desde `next`.
 */
const applyInput = z.object({ plan: clinicImportPlanSchema, from: z.number().int().min(0) }).strict()

export function createAdminImportsRoute(deps: Pick<AppDeps, "ownerDb">) {
  const app = new Hono()
  const tooLarge = (c: Context) =>
    c.json(errorBody(c, "BODY_TOO_LARGE", "El plan pesa más de 8 MB: divídelo en dos planes"), 413)
  // Un plan de 10 000 personas pesa unos 4 MB.
  app.use("*", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge }))

  app.post("/:orgId/preview", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = clinicImportPlanSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.ownerDb, orgId, (tx) => previewClinicImport(tx, orgId, actor, parsed.data)))
  })

  app.post("/:orgId/apply", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    const parsed = applyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.ownerDb, orgId, (tx) => applyClinicImportBatch(tx, orgId, actor, parsed.data.plan, parsed.data.from)),
    )
  })

  return app
}
