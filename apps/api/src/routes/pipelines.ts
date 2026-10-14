import { withOrgContext } from "@odentia/db"
import {
  createPipeline,
  createStage,
  deleteStage,
  listPipelines,
  renamePipeline,
  reorderStages,
  updateStage,
} from "@odentia/services"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const nameInput = z.object({ name: z.string().min(1).max(120) })
const stageInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["open", "won", "lost"]).optional(),
})
const stagePatch = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.enum(["open", "won", "lost"]).optional(),
})
const reorderInput = z.object({ stageIds: z.array(z.string().uuid()).min(1) })

/** Quien no configura la clínica recibe siempre el mismo mensaje. */
function notForYou(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "Las etapas de venta las configura quien administra la clínica"), 403)
}

/**
 * Etapas de venta. Leerlas es de quien trabaja con oportunidades (las ve en el
 * tablero) y de quien configura; definirlas —crear, editar, ordenar, eliminar—
 * es configurar la clínica, la misma regla que abre su apartado en Configuración.
 */
export function createPipelinesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read") && !canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver las etapas de venta"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPipelines(tx, orgId)),
    )
  })

  app.post("/", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    const parsed = nameInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createPipeline(tx, orgId, parsed.data)),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    const parsed = nameInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        renamePipeline(tx, orgId, c.req.param("id"), parsed.data),
      ).then(() => ({
        ok: true,
      })),
    )
  })

  app.post("/:id/stages", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    const parsed = stageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createStage(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/reorder", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    const parsed = reorderInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reorderStages(tx, orgId, c.req.param("id"), parsed.data.stageIds),
      ),
    )
  })

  app.patch("/stages/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    const parsed = stagePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateStage(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.delete("/stages/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "settings.write")) return notForYou(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => deleteStage(tx, orgId, c.req.param("id"))).then(
        () => ({ ok: true }),
      ),
    )
  })

  return app
}
