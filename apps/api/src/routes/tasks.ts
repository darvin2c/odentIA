import { withOrgContext } from "@odentia/db"
import { createTask, listTasks, updateTask } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const listQuery = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assignee: z.string().optional(),
})

const createInput = z.object({
  title: z.string().min(1).max(200),
  contactId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  assigneeUserId: z.string().nullable().optional(),
  dueAt: z.string().optional(),
})

const patchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  dueAt: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  status: z.enum(["open", "done", "cancelled"]).optional(),
})

export function createTasksRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listTasks(tx, orgId, parsed.data)),
    )
  })

  app.post("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createTask(tx, orgId, { ...parsed.data, createdBy: "user" }),
      ),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateTask(tx, orgId, c.req.param("id"), parsed.data)),
    )
  })

  return app
}
