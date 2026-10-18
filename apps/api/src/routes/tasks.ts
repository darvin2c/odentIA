import { withOrgContext } from "@odentia/db"
import {
  createTask,
  discardRegistrationTask,
  getRegistrationHold,
  resolveRegistrationHold,
  getTask,
  getTaskResolvePreview,
  listTasks,
  operationBodySchema,
  pageTasks,
  TASK_SORTS,
  TASK_VIEWS,
  taskAreasOfRole,
  updateTask,
  type TaskItem,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const listQuery = z.object({
  // Tareas de una persona o de un caso (ficha, contexto, agente): sin páginas.
  status: z.enum(["open", "done", "cancelled"]).optional(),
  assignee: z.string().optional(),
  contactId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  opportunityId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  overdue: z.enum(["true", "false"]).optional(),
  // La página de Tareas: vista, alcance, búsqueda, orden y páginas en el servidor.
  view: z.enum(TASK_VIEWS).optional(),
  scope: z.enum(["mias", "clinica"]).optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(TASK_SORTS).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

// Los campos de crear una tarea se declaran una vez, para la pantalla y para el agente.
const createInput = operationBodySchema("tarea.crear")

const patchInput = z.object({
  title: z.string().min(1).max(200).optional(),
  dueAt: z.string().nullable().optional(),
  assigneeUserId: z.string().nullable().optional(),
  status: z.enum(["open", "done", "cancelled"]).optional(),
  area: z.enum(["recepcion", "caja", "clinico", "administracion"]).nullable().optional(),
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

/** Nombres según permisos: CRM y filiación se exponen por separado. */
function visibleTask(memberRole: string, item: TaskItem): TaskItem {
  const base = canAccess(memberRole, "crm.read") ? item : stripCrmNames(item)
  return canAccess(memberRole, "patients.read") ? base : { ...base, patientName: null }
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

  /**
   * Con una persona o un caso (`contactId`, `conversationId`, `opportunityId`,
   * `patientId`): todas sus tareas, sin páginas. Sin ellos es la página de
   * Tareas: «Mías y de mi área» (las propias y las sin responsable del área del
   * rol), o «Toda la clínica» (`scope=clinica`), que solo es de quien tiene
   * `tasks.all`; con páginas, búsqueda y orden en el servidor.
   */
  app.get("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const query = parsed.data
    const hasCrmFilter = Boolean(query.contactId ?? query.conversationId ?? query.opportunityId)
    if (hasCrmFilter && !canAccess(memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM para filtrar tareas"), 403)
    }
    if (query.patientId && !canAccess(memberRole, "patients.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura de pacientes para filtrar tareas"), 403)
    }
    if (query.scope === "clinica" && !canAccess(memberRole, "tasks.all")) {
      return c.json(errorBody(c, "FORBIDDEN", "Las tareas de toda la clínica las ve quien administra la clínica"), 403)
    }
    try {
      if (hasCrmFilter || query.patientId) {
        const items = await withOrgContext(deps.db, orgId, (tx) =>
          listTasks(tx, orgId, {
            ...(query.status ? { status: query.status } : {}),
            ...(query.assignee ? { assignee: query.assignee } : {}),
            ...(query.contactId ? { contactId: query.contactId } : {}),
            ...(query.conversationId ? { conversationId: query.conversationId } : {}),
            ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
            ...(query.patientId ? { patientId: query.patientId } : {}),
            ...(query.overdue ? { overdue: query.overdue === "true" } : {}),
          }),
        )
        return c.json({ data: items.map((item) => visibleTask(memberRole, item)), nextCursor: null, total: items.length }, 200)
      }
      const view = query.view ?? (query.status === "done" ? "hechas" : query.overdue === "true" ? "vencidas" : "abiertas")
      const page = await withOrgContext(deps.db, orgId, (tx) =>
        pageTasks(tx, orgId, {
          viewer: { userId, areas: taskAreasOfRole(memberRole), all: query.scope === "clinica" },
          view,
          ...(query.sort ? { sort: query.sort } : {}),
          ...(query.q ? { q: query.q } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit ? { limit: query.limit } : {}),
        }),
      )
      return c.json({ data: page.items.map((item) => visibleTask(memberRole, item)), nextCursor: page.nextCursor, total: page.total }, 200)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  /**
   * Lo que pasará al completar la tarea de un caso que pasó el agente: lo mismo
   * que «Resolver» en la Bandeja (despedida y cierre). `null` si completarla no
   * cierra ninguna conversación. El nombre solo viaja a quien puede ver a la persona.
   */
  app.get("/:id/resolve-preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    const id = z.string().uuid().safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, id.error.issues)
    const seesPerson = canAccess(memberRole, "conversations.read") || canAccess(memberRole, "crm.read")
    return runService(c, 200, async () => {
      const result = await withOrgContext(deps.db, orgId, (tx) => getTaskResolvePreview(tx, orgId, id.data))
      return result && !seesPerson ? { ...result, contactName: "la persona" } : result
    })
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    return runService(c, 200, async () => {
      const item = await withOrgContext(deps.db, orgId, tx => getTask(tx, orgId, c.req.param("id")))
      return visibleTask(memberRole, item)
    })
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
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
    if (parsed.data.patientId && !canAccess(memberRole, "patients.read")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Sin permiso de lectura de pacientes para vincular tareas"),
        403,
      )
    }
    return runService(c, 201, async () => {
      const created = await withOrgContext(deps.db, orgId, (tx) =>
        createTask(tx, orgId, { ...parsed.data, createdBy: "user", actorUserId: userId }),
      )
      return visibleTask(memberRole, created)
    })
  })

  // «No es ella» y «Descartar» en «Te espera»: lo que dejó un registro en línea queda cerrado con su motivo (tasks.write).
  app.post("/:id/discard", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => discardRegistrationTask(tx, orgId, userId, params.data.id)),
    )
  })

  // «¿Es la misma persona?»: lo que escribió quien se registró por el código QR, al lado de lo que ya estaba.
  app.get("/:id/registration", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Revisar un registro es de quien edita los datos de las personas"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    c.header("Cache-Control", "no-store")
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getRegistrationHold(tx, orgId, params.data.id)))
  })

  app.post("/:id/registration", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Revisar un registro es de quien edita los datos de las personas"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    const body = z.strictObject({ same: z.boolean(), familyName: z.enum(["saved", "declared"]).optional() }).safeParse(await c.req.json().catch(() => null))
    if (!params.success) return validationError(c, params.error.issues)
    if (!body.success) return validationError(c, body.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => resolveRegistrationHold(tx, orgId, userId, params.data.id, body.data)),
    )
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
      return visibleTask(memberRole, updated)
    })
  })

  return app
}
