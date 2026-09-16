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
import { Hono } from "hono"
import { z } from "zod"
import { canWrite, orgContextOf } from "../lib/context.js"
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

export function createPipelinesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listPipelines(tx, orgId)),
    )
  })

  app.post("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = nameInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createPipeline(tx, orgId, parsed.data)),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
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
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = stageInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createStage(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/reorder", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = reorderInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reorderStages(tx, orgId, c.req.param("id"), parsed.data.stageIds),
      ),
    )
  })

  app.patch("/stages/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    const parsed = stagePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateStage(tx, orgId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.delete("/stages/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => deleteStage(tx, orgId, c.req.param("id"))).then(
        () => ({ ok: true }),
      ),
    )
  })

  return app
}
