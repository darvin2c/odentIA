import { withOrgContext } from "@odentia/db"
import {
  createContactNote,
  getContactWorkspace,
  listBudgetOptionsForContactPatient,
  listBudgetOptionsForOpportunity,
  listContactActivity,
  type CrmCapabilities,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

/**
 * Superficie operativa del CRM (paso P1). El coordinador monta este router
 * en `/api/crm`; las rutas aquí son relativas a ese punto de montaje.
 *
 * Permisos servidor: crm.read para contexto/actividad/presupuestos,
 * crm.write para notas. Las capacidades (conversations/tasks/agent) se
 * derivan del memberRole, jamás del cliente.
 */

const uuid = z.string().uuid()

const contextQuery = z.object({
  conversationId: uuid.optional(),
})

const activityQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

const noteInput = z.object({
  body: z.string().min(1).max(2000),
  conversationId: uuid.nullable().optional(),
  opportunityId: uuid.nullable().optional(),
})

const contactBudgetQuery = z.object({
  patientId: uuid,
})

function capabilitiesOf(memberRole: string): CrmCapabilities {
  return {
    conversations: canAccess(memberRole, "conversations.read"),
    tasks: canAccess(memberRole, "tasks.read"),
    // El caso muestra decisiones pendientes a quien supervisa o decide;
    // nunca clínica ni finanzas completas (ver servicios crm-workspace).
    agent: canAccessAny(memberRole, ["agent.read", "agent.decide"]),
    // La próxima cita de la persona, solo para quien ve la agenda.
    appointments: canAccess(memberRole, "appointments.read"),
  }
}

export function createCrmWorkspaceRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/contacts/:id/context", async (c) => {
    const ctx = orgContextOf(c)
    if (!canAccess(ctx.memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = contextQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const caps = capabilitiesOf(ctx.memberRole)
    try {
      const data = await withOrgContext(deps.db, ctx.orgId, (tx) =>
        getContactWorkspace(tx, ctx.orgId, c.req.param("id"), {
          conversationId: parsed.data.conversationId ?? null,
          capabilities: caps,
        }),
      )
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/contacts/:id/activity", async (c) => {
    const ctx = orgContextOf(c)
    if (!canAccess(ctx.memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = activityQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const caps = capabilitiesOf(ctx.memberRole)
    try {
      const { items, nextCursor } = await withOrgContext(deps.db, ctx.orgId, (tx) =>
        listContactActivity(tx, ctx.orgId, c.req.param("id"), {
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
          capabilities: caps,
        }),
      )
      return c.json({ data: items, nextCursor })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/contacts/:id/notes", async (c) => {
    const ctx = orgContextOf(c)
    if (!canAccess(ctx.memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de escritura del CRM"), 403)
    }
    const parsed = noteInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, ctx.orgId, (tx) =>
        createContactNote(
          tx,
          ctx.orgId,
          c.req.param("id"),
          {
            body: parsed.data.body,
            conversationId: parsed.data.conversationId ?? null,
            opportunityId: parsed.data.opportunityId ?? null,
          },
          { userId: ctx.userId },
        ),
      ),
    )
  })

  app.get("/opportunities/:id/budget-options", async (c) => {
    const ctx = orgContextOf(c)
    if (!canAccess(ctx.memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    // Solo cabecera mínima (id/título/estado); borradores solo con finance.read.
    const includeDrafts = canAccess(ctx.memberRole, "finance.read")
    try {
      const data = await withOrgContext(deps.db, ctx.orgId, (tx) =>
        listBudgetOptionsForOpportunity(tx, ctx.orgId, c.req.param("id"), { includeDrafts }),
      )
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/contacts/:id/budget-options", async (c) => {
    const ctx = orgContextOf(c)
    if (!canAccess(ctx.memberRole, "crm.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de lectura del CRM"), 403)
    }
    const parsed = contactBudgetQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const includeDrafts = canAccess(ctx.memberRole, "finance.read")
    try {
      const data = await withOrgContext(deps.db, ctx.orgId, (tx) =>
        listBudgetOptionsForContactPatient(tx, ctx.orgId, c.req.param("id"), parsed.data.patientId, {
          includeDrafts,
        }),
      )
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  return app
}
