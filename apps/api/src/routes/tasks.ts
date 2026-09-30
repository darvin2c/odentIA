import { withOrgContext } from "@odentia/db"
import { createTask, getTask, listTasks, updateTask, type TaskItem } from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const listQuery = z.object({
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assignee: z.string().optional(),
  contactId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  overdue: z.enum(["true", "false"]).optional(),
})

const createInput = z.object({
  title: z.string().min(1).max(200),
  contactId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  assigneeUserId: z.string().nullable().optional(),
  dueAt: z.string().optional(),
})

const patchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  dueAt: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  status: z.enum(["open", "done", "cancelled"]).optional(),
  contactId: z.string().uuid().nullable().optional(),
  conversationId: z.string().uuid().nullable().optional(),
  opportunityId: z.string().uuid().nullable().optional(),
})

/**
 * Sin crm.read (member/cashier) no se exponen datos CRM: se nulan los nombres
 * comerciales manteniendo los IDs operativos de la tarea.
 */
function stripCrmNames(item: TaskItem): TaskItem {
  return { ...item, contactName: null, opportunityTitle: null }
}

export function createTasksRoute(deps: CrmDeps) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method)
    if (!canAccess(memberRole, write ? "tasks.write" : "tasks.read")) {
      return c.json(
        errorBody(
          c,
          "FORBIDDEN",
          write ? "No tienes permiso para gestionar tareas" : "No tienes permiso para ver tareas",
        ),
        403,
      )
    }
    await next()
  })

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const hasCrmFilter = Boolean(
      parsed.data.contactId ?? parsed.data.conversationId ?? parsed.data.opportunityId,
    )
    if (hasCrmFilter && !canAccess(memberRole, "crm.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM para filtrar tareas"),
        403,
      )
    }
    const { overdue, ...rest } = parsed.data
    try {
      const items = await withOrgContext(deps.db, orgId, (tx) =>
        listTasks(tx, orgId, {
          ...rest,
          overdue: overdue === undefined ? undefined : overdue === "true",
        }),
      )
      const data = canAccess(memberRole, "crm.read") ? items : items.map(stripCrmNames)
      return c.json({ data, nextCursor: null }, 200)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, async () => {
      const item = await withOrgContext(deps.db, orgId, tx => getTask(tx, orgId, c.req.param("id")))
      return canAccess(memberRole, "crm.read") ? item : stripCrmNames(item)
    })
  })

  app.post("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const hasCrmLink = Boolean(
      parsed.data.contactId ?? parsed.data.conversationId ?? parsed.data.opportunityId,
    )
    if (hasCrmLink && !canAccess(memberRole, "crm.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM para vincular tareas"),
        403,
      )
    }
    return runService(c, 201, async () => {
      const created = await withOrgContext(deps.db, orgId, (tx) =>
        createTask(tx, orgId, { ...parsed.data, createdBy: "user" }),
      )
      return canAccess(memberRole, "crm.read") ? created : stripCrmNames(created)
    })
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const hasCrmLink = Boolean(
      parsed.data.contactId ?? parsed.data.conversationId ?? parsed.data.opportunityId,
    )
    if (hasCrmLink && !canAccess(memberRole, "crm.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM para vincular tareas"),
        403,
      )
    }
    return runService(c, 200, async () => {
      const updated = await withOrgContext(deps.db, orgId, (tx) =>
        updateTask(tx, orgId, c.req.param("id"), { ...parsed.data, actorUserId: userId }),
      )
      return canAccess(memberRole, "crm.read") ? updated : stripCrmNames(updated)
    })
  })

  return app
}
