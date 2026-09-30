import { withOrgContext } from "@odentia/db"
import {
  closeOpportunity,
  createOpportunity,
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
  q: z.string().optional(),
  contactId: uuid.optional(),
  patientId: uuid.optional(),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  assignedUserId: z.string().optional(),
  nextActionDue: z.enum(["true", "false"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const moneyFields = {
  amountCents: z.number().int().min(0).nullable().optional(),
  currency: z.string().min(3).max(3).optional(),
}

const createInput = z.object({
  contactId: uuid,
  patientId: uuid.nullable().optional(),
  pipelineId: uuid.optional(),
  stageId: uuid.optional(),
  title: z.string().min(1).max(200),
  serviceId: uuid.nullable().optional(),
  interestText: z.string().max(500).nullable().optional(),
  ...moneyFields,
  assignedUserId: z.string().nullable().optional(),
  nextActionAt: z.string().nullable().optional(),
  nextActionNote: z.string().max(500).nullable().optional(),
  budgetId: uuid.nullable().optional(),
  conversationId: uuid.nullable().optional(),
})

const patchInput = z.object({
  contactId: uuid.optional(),
  patientId: uuid.nullable().optional(),
  title: z.string().min(1).max(200).optional(),
  serviceId: uuid.nullable().optional(),
  interestText: z.string().max(500).nullable().optional(),
  ...moneyFields,
  assignedUserId: z.string().nullable().optional(),
  nextActionAt: z.string().nullable().optional(),
  nextActionNote: z.string().max(500).nullable().optional(),
  budgetId: uuid.nullable().optional(),
  conversationId: uuid.nullable().optional(),
})

const moveInput = z.object({ stageId: uuid })

const closeInput = z.object({
  outcome: z.enum(["won", "lost"]),
  reason: z.string().min(1).max(500),
})

export function createOpportunitiesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { nextActionDue, ...rest } = parsed.data
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, orgId, (tx) =>
        listOpportunities(tx, orgId, {
          ...rest,
          nextActionDue: nextActionDue === "true",
        }),
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
      withOrgContext(deps.db, orgId, (tx) => createOpportunity(tx, orgId, parsed.data, { userId })),
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
    const { nextActionDue, ...rest } = parsed.data
    try {
      const summary = await withOrgContext(deps.db, orgId, (tx) =>
        getOpportunitySummary(tx, orgId, {
          ...rest,
          nextActionDue: nextActionDue === "true",
        }),
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
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getOpportunity(tx, orgId, c.req.param("id"))),
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
        moveOpportunity(tx, orgId, c.req.param("id"), parsed.data.stageId, { userId }).then(
          ({ detail }) => detail,
        ),
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
        closeOpportunity(tx, orgId, c.req.param("id"), parsed.data, { userId }),
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
