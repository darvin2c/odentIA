import { withOrgContext } from "@odentia/db"
import { listPipelines, renameStage } from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const renameInput = z.strictObject({ name: z.string().min(1).max(120) })

/** Quien no trabaja con ventas recibe siempre el mismo mensaje. */
function notForYou(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para cambiar las etapas de venta"), 403)
}

/**
 * Etapas de venta: los cuatro pasos fijos (ADR 0028). Leerlas es de quien
 * trabaja con oportunidades (las ve en el tablero) y de quien configura;
 * cambiarles el nombre también es de quien trabaja con oportunidades
 * (`crm.write`), la misma regla que abre su apartado en Configuración. No se
 * crean, ordenan ni eliminan pasos, ni embudos: así la oportunidad puede
 * avanzar sola.
 */
export function createPipelinesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read") && !canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver las etapas de venta"), 403)
    }
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listPipelines(tx, orgId)))
  })

  app.patch("/stages/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) return notForYou(c)
    const parsed = renameInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => renameStage(tx, orgId, c.req.param("id"), parsed.data)),
    )
  })

  return app
}
