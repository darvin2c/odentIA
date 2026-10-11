import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import {
  adjustBudgetLines,
  cancelBudget,
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
  getBudgetPrintPayload,
  listBudgets,
  reviseBudget,
  updateBudgetDraft,
} from "@odentia/services"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import type { Context } from "hono"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a presupuestos"), 403)
}
/**
 * Documentos económicos de un plan clínico (propiedad PresupuestosPromociones).
 * - GET /:id/budgets?planId= → presupuestos con líneas snapshot + totales
 * - POST /:id/budgets { planId, itemIds, title?, notes? } → 201
 * - GET /:id/budgets/:budgetId → detalle con líneas + totales
 * - PATCH /:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - POST /:id/budgets/:budgetId/lines { lines: [{ planItemId, priceCents?, reason?, promotionId?|null, promotionFinalPriceCents? }] } (solo borrador)
 * - POST /:id/budgets/:budgetId/deliver {} (borrador→presentado; imprimir/enviar entrega)
 * - GET /:id/budgets/:budgetId/print → payload A4 con código 310 y precios finales
 * - POST /:id/budgets/:budgetId/decision { decisions, decidedByContactId?, decisionNote? }
 * - POST /:id/budgets/:budgetId/cancel {}
 * - POST /:id/budgets/:budgetId/revise { itemIds, title?, notes?, reason }
 * Permisos: lectura `budgets.read`, escritura `budgets.write`, decisión
 * `budgets.decide` (caja decide sin clínica; odontólogo solo su plan, objeto).
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
    decisions: z.array(z.object({ planItemId: z.uuid(), decision: z.enum(["aceptado", "rechazado", "pospuesto"]) }).strict()).min(1).max(200),
    decidedByContactId: z.uuid().nullish(),
    decisionNote: z.string().max(4000).nullish(),
  })
  .strict()

const budgetRevisionInput = budgetCreateInput.omit({ planId: true }).extend({
  reason: z.string().trim().min(1).max(2000),
}).strict()

const budgetLinesInput = z
  .object({
    lines: z
      .array(
        z
          .object({
            planItemId: z.uuid(),
            priceCents: z.number().int().min(0).max(2147483647).nullish(),
            reason: z.string().trim().min(1).max(500).nullish(),
            promotionId: z.uuid().nullish(),
            promotionFinalPriceCents: z.number().int().min(0).max(2147483647).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()

export function createPatientBudgetsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  // Documentos económicos: lectura budgets.read, mutaciones budgets.write,
  // decisión budgets.decide. El guarda se acota a sus rutas: esta app se monta
  // en "/" junto a las demás subrutas del paciente y un `use("*")` exigiría
  // presupuestos también a controles, recetas, tratamientos y responsables.
  for (const path of ["/:id/budgets", "/:id/budgets/*"]) {
    app.use(path, async (c, next) => {
      const { memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "budgets.read")) return forbid(c)
      await next()
    })
  }
  app.get("/:id/budgets", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    const patientId = c.req.param("id")
    const planId = c.req.query("planId") || undefined
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listBudgets(tx, orgId, patientId, planId, { memberRole, actorUserId: userId }),
      ),
    )
  })

  app.post("/:id/budgets", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const patientId = c.req.param("id")
    const parsed = budgetCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createBudget(tx, orgId, userId, patientId, parsed.data, { memberRole }),
      ),
    )
  })

  app.get("/:id/budgets/:budgetId", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getBudgetDetail(tx, orgId, c.req.param("id"), c.req.param("budgetId"), {
          memberRole,
          actorUserId: userId,
        }),
      ),
    )
  })

  app.get("/:id/budgets/:budgetId/print", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getBudgetPrintPayload(tx, orgId, c.req.param("id"), c.req.param("budgetId"), {
          memberRole,
          actorUserId: userId,
        }),
      ),
    )
  })

  app.patch("/:id/budgets/:budgetId", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
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
          { memberRole },
        ),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/lines", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetLinesInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        adjustBudgetLines(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
          memberRole,
        }),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/deliver", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        deliverBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), { memberRole }),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/decision", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.decide")) return forbid(c)
    const parsed = budgetDecisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        decideBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
          memberRole,
        }),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        cancelBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), { memberRole }),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/revise", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetRevisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      reviseBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, { memberRole })))
  })

  return app
}
