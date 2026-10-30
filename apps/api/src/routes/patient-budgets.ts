import { patientGuideSchema } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import {
  addBudgetItems,
  adjustBudgetLines,
  BUDGET_OPTION_NAME_MAX,
  BUDGET_OPTION_TEXT_MAX,
  BUDGET_TEXT_MAX,
  type BudgetLineWithStatus,
  budgetsSeenInPortal,
  cancelBudget,
  createBudget,
  decideBudget,
  deliverBudget,
  duplicateBudgetOption,
  getBudgetDetail,
  getBudgetPresentation,
  listBudgets,
  operationBodySchema,
  previewBudgetSend,
  recommendBudgetOption,
  removeBudgetItems,
  removeBudgetOption,
  reviseBudget,
  sendBudget,
  updateBudgetDraft,
  updateBudgetPresentation,
} from "@odentia/services"
import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a presupuestos"), 403)
}
/**
 * Documentos económicos de un plan clínico (propiedad PresupuestosPromociones).
 * - GET /:id/budgets?planId= → presupuestos con líneas snapshot + totales
 * - POST /:id/budgets { planId, itemIds, title?, notes? } → 201
 * - GET /:id/budgets/:budgetId → detalle con líneas + totales
 * - PATCH /:id/budgets/:budgetId { title?, notes? } (solo borrador)
 * - GET /:id/budgets/:budgetId/presentation → lo que explica el presupuesto (`findings`
 *   solo con `clinical.read`; si no, null y `hasFindings`)
 * - PATCH /:id/budgets/:budgetId/presentation { findings?, proposal?, validUntil?,
 *   options?: [{ optionId, name?, pros?, cons? }], lines?: [{ lineId, patientGuide }] }
 *   con `budgets.write`; solo borrador
 * - POST /:id/budgets/:budgetId/lines { lines: [{ planItemId, priceCents?, reason?, promotionId?|null, promotionFinalPriceCents? }] } (solo borrador)
 * - POST /:id/budgets/:budgetId/items { itemIds } (añade tratamientos del plan; solo borrador)
 * - POST /:id/budgets/:budgetId/items/remove { itemIds } (quita tratamientos; solo borrador)
 * - POST /:id/budgets/:budgetId/deliver {} (borrador→presentado; imprimir entrega)
 * - GET /:id/budgets/:budgetId/send-preview → a quién y por dónde saldría
 * - POST /:id/budgets/:budgetId/send { requestId?, recipientContactId? } (WhatsApp primero;
 *   si era borrador, lo entrega)
 * - POST /:id/budgets/:budgetId/options/:optionId/duplicate | recommend | remove (solo borrador)
 * - POST /:id/budgets/:budgetId/decision { optionId?, decisions, decidedByContactId?, decisionNote? }
 * - POST /:id/budgets/:budgetId/cancel {}
 * - POST /:id/budgets/:budgetId/revise { itemIds, title?, notes?, reason }
 * Permisos (decisión 4): lectura `budgets.read`; armar y cambiar precios
 * `budgets.write`; entregar y enviar `budgets.send`; anotar la respuesta
 * `budgets.decide`. El odontólogo, solo lo que él indicó (servicio).
 * Dinero solo en centavos enteros; estados/transiciones según servicio.
 */
const budgetItemsInput = z
  .object({ itemIds: z.array(z.uuid()).min(1).max(200), optionId: z.uuid().nullish() })
  .strict()

const budgetCreateInput = z
  .object({
    planId: z.uuid().nullish(),
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

// La respuesta se declara una vez para la pantalla y para el agente
// (`anotar_respuesta_presupuesto`): opción, una respuesta por tratamiento,
// quién decidió y la nota.
const budgetDecisionInput = operationBodySchema("presupuesto.respuesta")

// Una sola declaración para la pantalla y el agente (`reenviar_presupuesto`).
const budgetSendInput = operationBodySchema("presupuesto.reenviar")

const budgetRevisionInput = budgetCreateInput
  .omit({ planId: true })
  .extend({
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()

const budgetPresentationInput = z
  .object({
    findings: z.string().max(BUDGET_TEXT_MAX).nullish(),
    proposal: z.string().max(BUDGET_TEXT_MAX).nullish(),
    validUntil: z.iso.date().nullish(),
    options: z
      .array(
        z
          .object({
            optionId: z.uuid(),
            name: z.string().max(BUDGET_OPTION_NAME_MAX).nullish(),
            pros: z.string().max(BUDGET_OPTION_TEXT_MAX).nullish(),
            cons: z.string().max(BUDGET_OPTION_TEXT_MAX).nullish(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    lines: z
      .array(z.object({ lineId: z.uuid(), patientGuide: patientGuideSchema.nullable() }).strict())
      .max(200)
      .optional(),
  })
  .strict()

const budgetLinesInput = z
  .object({
    lines: z
      .array(
        z
          .object({
            planItemId: z.uuid(),
            // La opción de la línea; sin ella, vale para ese tratamiento en todas.
            optionId: z.uuid().nullish(),
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
 * Quien no lee la parte clínica no recibe la ficha dentro del presupuesto. La
 * frontera se aplica aquí, en el servidor, no ocultando columnas en la
 * pantalla:
 * - recepción (`budgets.send`, decisión 4 de la fase 3) lo ve como lo recibe
 *   la persona en su hoja y en el portal: cada tratamiento con su sitio
 *   («Resina · pieza 16», un cuadrante, una arcada), precio, decisión y
 *   estado; sin superficies ni códigos de procedimiento;
 * - caja, como documento económico: tratamiento, precio, decisión y estado,
 *   sin pieza, superficies, cuadrante, arcada ni códigos.
 */
function economicView<T extends { items: BudgetLineWithStatus[] }>(
  memberRole: string,
  budget: T,
): T {
  if (canAccess(memberRole, "clinical.read")) return budget
  const asPerson = canAccess(memberRole, "budgets.send")
  return {
    ...budget,
    items: budget.items.map((line) => ({
      ...line,
      toothNumber: asPerson ? line.toothNumber : null,
      surfaces: [],
      quadrant: asPerson ? line.quadrant : null,
      arch: asPerson ? line.arch : null,
      codings: [],
    })),
  }
}

export function createPatientBudgetsRoute(deps: Pick<CrmDeps, "db" | "storage" | "secretsKey">) {
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
    return runService(c, 200, async () => {
      const { budgets, seen } = await withOrgContext(deps.db, orgId, async (tx) => {
        const list = await listBudgets(tx, orgId, patientId, planId, {
          memberRole,
          actorUserId: userId,
        })
        // «Lo vio en el portal el …», del registro de accesos (decisión 9).
        return {
          budgets: list,
          seen: await budgetsSeenInPortal(
            tx,
            orgId,
            list.map((budget) => budget.id),
          ),
        }
      })
      return budgets.map((budget) => ({
        ...economicView(memberRole, budget),
        seenInPortalAt: seen.get(budget.id)?.toISOString() ?? null,
      }))
    })
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
    return runService(c, 200, async () => {
      const { budget, seen } = await withOrgContext(deps.db, orgId, async (tx) => {
        const detail = await getBudgetDetail(
          tx,
          orgId,
          c.req.param("id"),
          c.req.param("budgetId"),
          {
            memberRole,
            actorUserId: userId,
          },
        )
        return { budget: detail, seen: await budgetsSeenInPortal(tx, orgId, [detail.id]) }
      })
      return {
        ...economicView(memberRole, budget),
        seenInPortalAt: seen.get(budget.id)?.toISOString() ?? null,
      }
    })
  })

  app.get("/:id/budgets/:budgetId/presentation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getBudgetPresentation(tx, orgId, c.req.param("id"), c.req.param("budgetId"), {
          memberRole,
          actorUserId: userId,
          clinicalAccess: canAccess(memberRole, "clinical.read"),
        }),
      ),
    )
  })

  app.patch("/:id/budgets/:budgetId/presentation", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetPresentationInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateBudgetPresentation(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("budgetId"),
          parsed.data,
          {
            memberRole,
            clinicalAccess: canAccess(memberRole, "clinical.read"),
          },
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
        adjustBudgetLines(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("budgetId"),
          parsed.data,
          {
            memberRole,
          },
        ),
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
        removeBudgetItems(
          tx,
          orgId,
          userId,
          c.req.param("id"),
          c.req.param("budgetId"),
          parsed.data,
          {
            memberRole,
          },
        ),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/deliver", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.send")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        deliverBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), {
          memberRole,
        }),
      ),
    )
  })

  // Enviar por la regla de siempre (WhatsApp primero): antes, a quién y por dónde.
  app.get("/:id/budgets/:budgetId/send-preview", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.send")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        previewBudgetSend(tx, orgId, c.req.param("id"), c.req.param("budgetId"), {
          actorUserId: userId,
          memberRole,
        }),
      ),
    )
  })

  app.post("/:id/budgets/:budgetId/send", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.send")) return forbid(c)
    const parsed = budgetSendInput.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        sendBudget(
          tx,
          orgId,
          { userId, memberRole },
          {
            patientId: c.req.param("id"),
            budgetId: c.req.param("budgetId"),
            requestId: parsed.data.requestId ?? null,
            recipientContactId: parsed.data.recipientContactId ?? null,
          },
          { storage: deps.storage, secretsKey: deps.secretsKey },
        ),
      ),
    )
  })

  // Opciones del borrador (decisión 13): duplicar, recomendar y quitar.
  for (const [action, operation] of [
    ["duplicate", duplicateBudgetOption],
    ["recommend", recommendBudgetOption],
    ["remove", removeBudgetOption],
  ] as const) {
    app.post(`/:id/budgets/:budgetId/options/:optionId/${action}`, async (c) => {
      const { orgId, userId, memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "budgets.write")) return forbid(c)
      return runService(c, 200, () =>
        withOrgContext(deps.db, orgId, (tx) =>
          operation(
            tx,
            orgId,
            userId,
            c.req.param("id"),
            c.req.param("budgetId"),
            c.req.param("optionId"),
            {
              memberRole,
            },
          ),
        ),
      )
    })
  }

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

  app.post("/:id/budgets/:budgetId/revise", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "budgets.write")) return forbid(c)
    const parsed = budgetRevisionInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        reviseBudget(tx, orgId, userId, c.req.param("id"), c.req.param("budgetId"), parsed.data, {
          memberRole,
        }),
      ),
    )
  })

  return app
}
