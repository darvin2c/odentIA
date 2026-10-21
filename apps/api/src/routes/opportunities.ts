import { withOrgContext } from "@odentia/db"
import {
  closeOpportunity,
  createOpportunity,
  operationBodySchema,
  getOpportunity,
  getOpportunitySummary,
  listOpportunities,
  moveOpportunity,
  reopenOpportunity,
  updateOpportunity,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"
// Lectura: cualquier miembro de la org (igual que contactos).

const uuid = z.string().uuid()

const listQuery = z.object({
  q: z.string().max(200).optional(),
  contactId: uuid.optional(),
  patientId: uuid.optional(),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  // Un miembro, o `none` para las que nadie tomó (las de Recepción).
  assignedUserId: z.string().max(200).optional(),
  // Solo las que tienen su tarea vencida.
  taskDue: z.enum(["true", "false"]).optional(),
  // Solo las que el agente creó o movió alguna vez.
  byAgent: z.enum(["true", "false"]).optional(),
  // El tablero: lo abierto y lo cerrado de los últimos 30 días.
  recent: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

function filtersOf(query: z.infer<typeof listQuery>) {
  const { taskDue, byAgent, recent, ...rest } = query
  return { ...rest, taskDue: taskDue === "true", byAgent: byAgent === "true", recent: recent === "true" }
}

// Crear, mover y cerrar una oportunidad declaran sus campos una vez, para la pantalla y para el agente.
const createInput = operationBodySchema("oportunidad.crear")

// Editar: los mismos campos que crear, todos opcionales (el valor sale de la
// lista de precios cuando hay servicio; la moneda es la de la clínica).
const patchInput = z.object({
  contactId: uuid.optional(),
  patientId: uuid.nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  serviceId: uuid.nullable().optional(),
  interestText: z.string().max(500).nullable().optional(),
  amountCents: z.number().int().min(0).nullable().optional(),
  assignedUserId: z.string().nullable().optional(),
  budgetId: uuid.nullable().optional(),
  conversationId: uuid.nullable().optional(),
})

const moveInput = operationBodySchema("oportunidad.mover")

const closeInput = operationBodySchema("oportunidad.cerrar")

export function createOpportunitiesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listOpportunities(tx, orgId, filtersOf(parsed.data)),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createOpportunity(tx, orgId, parsed.data, { userId, origin: "persona" })),
    )
  })

  // Resumen agregado por filtros; registrado ANTES de /:id para no colisionar.
  app.get("/summary", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = listQuery.omit({ cursor: true, limit: true }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const summary = await withOrgContext(deps.db, orgId, (tx) =>
        getOpportunitySummary(tx, orgId, filtersOf(parsed.data)),
      )
      return c.json({ data: summary })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    // La próxima cita de la persona solo viaja a quien ve la agenda.
    const appointments = canAccess(orgContextOf(c).memberRole, "appointments.read")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOpportunity(tx, orgId, c.req.param("id"), { appointments })),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateOpportunity(tx, orgId, c.req.param("id"), parsed.data, { userId }),
      ),
    )
  })

  app.post("/:id/move", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = moveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        moveOpportunity(tx, orgId, c.req.param("id"), parsed.data.stageId, { userId, origin: "persona" }),
      ),
    )
  })

  app.post("/:id/close", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = closeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        closeOpportunity(tx, orgId, c.req.param("id"), parsed.data, { userId, origin: "persona" }),
      ),
    )
  })

  app.post("/:id/reopen", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reopenOpportunity(tx, orgId, c.req.param("id"), { userId }),
      ),
    )
  })

  return app
}
