import { withOrgContext } from "@odentia/db"
import {
  cancelBudget,
  createBudget,
  decideBudget,
  getBudgetDetail,
  listBudgets,
  presentBudget,
  updateBudgetDraft,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { orgContextOf } from "../lib/context.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * Documentos económicos de un plan clínico (propiedad BudgetData).
 * Main la monta bajo /patients, por eso los paths son /:id/...
 * - GET /:id/budgets?planId= → presupuestos con líneas snapshot + totalCents/acceptedCents
 * - POST /:id/budgets { planId, itemIds, title?, notes? } → 201 (rechaza cuerpo viejo sin plan)
 * - GET /:id/budgets/:budgetId → detalle con líneas + totales
 * - PATCH /:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /:id/budgets/:budgetId/present {} (borrador→presentado)
 * - POST /:id/budgets/:budgetId/decision { acceptedItemIds, acceptedByName, decisionNote? }
 * - POST /:id/budgets/:budgetId/cancel {}
 * Dinero solo en centavos enteros; estados/transiciones según servicio.
 */
const budgetCreateInput = z
  .object({
    planId: z.uuid(),
    itemIds: z.array(z.uuid()).min(1).max(200),
    title: z.string().trim().min(1).max(200).nullish(),
    notes: z.string().max(4000).nullish(),
  })
  .strict()

const budgetPatchInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(4000).nullish(),
  })
  .strict()

const budgetDecisionInput = z
  .object({
    acceptedItemIds: z.array(z.uuid()),
    acceptedByName: z.string().trim().min(1).max(200),
    decisionNote: z.string().max(4000).nullish(),
  })
  .strict()

export function createPatientBudgetsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.get("/:id/budgets", async (c) => {
    const { orgId } = orgContextOf(c)
    const patientId = c.req.param("id")
    const planId = c.req.query("planId") || undefined
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listBudgets(tx, orgId, patientId, planId)),
    )
  })

  app.post("/:id/budgets", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const patientId = c.req.param("id")
    const parsed = budgetCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createBudget(tx, orgId, userId, patientId, parsed.data),
      ),
    )
  })

  app.get("/:id/budgets/:budgetId", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getBudgetDetail(tx, orgId, c.req.param("id"), c.req.param("budgetId")),
      ),
    )
  })

  app.patch("/:id/budgets/:budgetId", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = budgetPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateBudgetDraft(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("budgetId"),
          parsed.data,
        ),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/present", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        presentBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId")),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/decision", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    const parsed = budgetDecisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        decideBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/cancel", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId")),
      ),
    )
  })

  return app
}
