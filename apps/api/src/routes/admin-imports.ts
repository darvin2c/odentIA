import type { ClinicalProduct } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { listClinicLoads } from "@odentia/services"
import { Hono } from "hono"
import type { AppDeps } from "../app.js"
import { adminContextOf } from "../lib/admin-context.js"
import { createClinicLoad } from "../lib/clinic-load.js"
import { runService } from "./helpers.js"

/**
 * El registro de la carga de una clínica (ADR 0104) en la administración: qué se cargó,
 * cuándo y quién, y los informes enviados con su PDF tal como salió. La carga la hace la
 * skill en el servidor (`cli/carga.ts`), con la misma lógica (`lib/clinic-load.ts`); aquí
 * no se carga nada. Solo administración: lo exige `createClinicLoad`.
 */
type ImportDeps = Pick<AppDeps, "ownerDb" | "storage" | "mailer" | "webURL"> & {
  panelUrlOf?: (product: ClinicalProduct) => string
}

export function createAdminImportsRoute(deps: ImportDeps) {
  const app = new Hono()
  const load = createClinicLoad(deps)

  app.get("/:orgId/record", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, async () => {
      // La lista de informes comprueba el rol antes de leer nada.
      const reports = await load.listReports(orgId, actor)
      const loads = await withOrgContext(deps.ownerDb, orgId, (tx) => listClinicLoads(tx, orgId))
      return { loads, reports }
    })
  })

  app.get("/:orgId/reports/:number/pdf", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, () => load.reportPdfUrl(orgId, actor, Number(c.req.param("number"))))
  })

  return app
}
