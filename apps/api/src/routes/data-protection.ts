import { withOrgContext } from "@odentia/db"
import { getDataProtectionView, loadDocumentClinic, recordDataProtectionDownload, renderDataProtectionPdf } from "@odentia/services"
import { Hono } from "hono"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse } from "./helpers.js"

/**
 * Configuración › Protección de datos (ADR 0080): el registro de actividades
 * de tratamiento de la clínica y su PDF para la autoridad. Solo Propietario y
 * Administración (`settings.read`), como el resto de Configuración.
 */
export function createDataProtectionRoute(deps: CrmDeps) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.read"))
      return c.json(errorBody(c, "FORBIDDEN", "Solo Administración ve la protección de datos"), 403)
    await next()
  })

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getDataProtectionView(tx, orgId)))
  })

  // «Descargar para la autoridad»: con la fecha del día y sin guardar copia; la descarga queda en la auditoría.
  app.get("/pdf", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    try {
      const pdf = await withOrgContext(deps.db, orgId, async (tx) => {
        await recordDataProtectionDownload(tx, orgId, userId)
        return renderDataProtectionPdf(await getDataProtectionView(tx, orgId), await loadDocumentClinic(tx, orgId))
      })
      return c.body(Buffer.from(pdf), 200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="registro-de-actividades-de-tratamiento.pdf"`,
      })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })
  return app
}
