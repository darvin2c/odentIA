import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import {
  type BudgetLineWithStatus,
  addBudgetItems,
  adjustBudgetLines,
  cancelBudget,
  createBudget,
  decideBudget,
  deliverBudget,
  getBudgetDetail,
  listBudgets,
  removeBudgetItems,
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
 * - POST /:id/budgets/:budgetId/items { itemIds } (añade tratamientos del plan; solo borrador)
 * - POST /:id/budgets/:budgetId/items/remove { itemIds } (quita tratamientos; solo borrador)
 * - POST /:id/budgets/:budgetId/deliver {} (borrador→presentado; imprimir/enviar entrega)
 * - POST /:id/budgets/:budgetId/decision { decisions, decidedByContactId?, decisionNote? }
 * - POST /:id/budgets/:budgetId/cancel {}
 * - POST /:id/budgets/:budgetId/revise { itemIds, title?, notes?, reason }
 * Permisos: lectura `budgets.read`, escritura `budgets.write`, decisión
 * `budgets.decide` (caja decide sin clínica; odontólogo solo su plan, objeto).
 * Dinero solo en centavos enteros; estados/transiciones según servicio.
 */
const budgetItemsInput = z.object({ itemIds: z.array(z.uuid()).min(1).max(200) }).strict()

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
            // Visitas previstas de lo que se cobra por sesión.
            sessionsPlanned: z.number().int().min(1).max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict()

/**
 * Quien no lee la parte clínica (caja) recibe el presupuesto como documento
 * económico: tratamiento, precio, decisión y estado, sin pieza, superficies,
 * cuadrante, arcada ni códigos de procedimiento. La frontera se aplica aquí,
 * en el servidor, no ocultando columnas en la pantalla.
 */
function economicView<T extends { items: BudgetLineWithStatus[] }>(memberRole: string, budget: T): T {
  if (canAccess(memberRole, "clinical.read")) return budget
  return {
    ...budget,
    items: budget.items.map((line) => ({
      ...line,
      toothNumber: null,
      surfaces: [],
      quadrant: null,
      arch: null,
      codings: [],
    })),
  }
}

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
    return runService(c, 200, async () =>
      (
        await withOrgContext(deps.db, orgId, (tx) =>
          listBudgets(tx, orgId, patientId, planId, { memberRole, actorUserId: userId }),
        )
      ).map((budget) => economicView(memberRole, budget)),
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
    return runService(c, 200, async () =>
      economicView(
        memberRole,
        await withOrgContext(deps.db, orgId, (tx) =>
          getBudgetDetail(tx, orgId, c.req.param("id"), c.req.param("budgetId"), {
            memberRole,
            actorUserId: userId,
          }),
        ),
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

  // Añadir tratamientos del plan a un borrador (mismas reglas que al prepararlo).
  app.post("/:id/budgets/:budgetId/items", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetItemsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addBudgetItems(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
          memberRole,
        }),
      ),
    )
  })

  // Quitar tratamientos de un borrador: vuelven a quedar sin presupuestar.
  app.post("/:id/budgets/:budgetId/items/remove", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetItemsInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        removeBudgetItems(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
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
    return runService(c, 200, async () =>
      economicView(
        memberRole,
        await withOrgContext(deps.db, orgId, (tx) =>
          decideBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
            memberRole,
          }),
        ),
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
