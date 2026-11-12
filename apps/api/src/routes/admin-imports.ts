import type { ClinicalProduct } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { listClinicLoads, ServiceError, settleReportTasks } from "@odentia/services"
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
 *
 * Un informe que quedó «no se sabe si salió» tiene dos salidas, de una persona después de
 * mirar en Zoho: «Revisé en Zoho: salió» (lo cierra sin reenviar, como `informe-salio` de
 * la skill) y «No salió: reenviar» (el mismo informe, una vez por pulsación). Al quedar
 * enviado, las tareas de Kairós de ese informe se cierran.
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

  /** Después de quedar enviado: cierra lo que Kairós puso por ese informe (no frena si falla). */
  const settle = (orgId: string) =>
    deps.ownerDb
      .transaction((tx) => settleReportTasks(tx, orgId, new Date()))
      .catch((error) => console.error("Kairós: no se cerraron las tareas del informe", error))

  app.post("/:orgId/reports/:number/confirm-sent", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, async () => {
      const done = await load.confirmReportSent(orgId, actor, reportNumber(c.req.param("number")))
      await settle(orgId)
      return done
    })
  })

  app.post("/:orgId/reports/:number/resend", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, async () => {
      const done = await load.resendReport(orgId, actor, reportNumber(c.req.param("number")))
      await settle(orgId)
      return done
    })
  })

  app.get("/:orgId/reports/:number/pdf", async (c) => {
    const actor = adminContextOf(c)
    const orgId = c.req.param("orgId")
    return runService(c, 200, () => load.reportPdfUrl(orgId, actor, Number(c.req.param("number"))))
  })

  return app
}

/** El número de un informe en la dirección: entero positivo, o 404 como cualquier otro que no está. */
function reportNumber(raw: string): number {
  const number = Number(raw)
  if (!Number.isInteger(number) || number < 1)
    throw new ServiceError("NOT_FOUND", 404, "Ese informe no está en el registro")
  return number
}
