/**
 * Los caminos de un presupuesto: «conservar o extraer la 46» se marca donde el
 * odontólogo lo decide, en la atención (ADR 0150). No es otro registro: cada
 * camino es una opción del borrador de la persona, como las arma Clío al dictar
 * «resina, o si no corona», y lo común va en todas. Un presupuesto lleva un solo
 * grupo de caminos (hasta tres opciones): con dos piezas dudosas saldrían
 * combinaciones que nadie arma.
 */
import type { Db } from "@odentia/db"
import { treatmentPlanItem } from "@odentia/db/schema/clinical"
import { and, eq } from "drizzle-orm"
import {
  addBudgetItems,
  assembleEncounterBudget,
  type BudgetActorOpts,
  type BudgetWithTotals,
  commonPlanItems,
  duplicateBudgetOption,
  findDraftBudget,
  getBudgetDetail,
  removeBudgetItems,
  removeBudgetOption,
} from "./budgets.js"
import { notFound, ServiceError } from "./errors.js"
import { lockDraftEncounter } from "./plan.js"
import { productHooks } from "./products.js"
import { BUDGET_OPTIONS_MAX } from "@odentia/clinical"

/** «nuevo»: otro camino con este tratamiento; un número: solo en ese camino; «todos»: va en todos. */
export type BudgetPathTarget = "nuevo" | "todos" | 1 | 2 | 3

function conflict(code: string, message: string, field = "path"): ServiceError {
  return new ServiceError(code, 409, message, { [field]: message })
}

/** El sitio de una línea, para saber si dos tratamientos son de la misma pieza. */
function siteKey(line: { siteSystem: string | null; siteCode: string | null }): string | null {
  return line.siteSystem && line.siteCode ? `${line.siteSystem}:${line.siteCode}` : null
}

/**
 * Pone un tratamiento indicado en esta atención en un camino del borrador de la
 * persona. Solo quien lleva la atención en borrador y solo donde lo indicado
 * espera respuesta (odentIA; en latidIA lo indicado nace aceptado).
 */
export async function placeBudgetPath(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { planItemId: string; path: BudgetPathTarget },
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  if (!(await productHooks(tx, orgId)).budgetRequired) {
    throw conflict("BUDGET_PATHS_OFF", "Aquí lo indicado nace aceptado: los caminos se arman en el presupuesto")
  }
  const [item] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.id, input.planItemId),
      ),
    )
    .limit(1)
  if (!item) throw notFound("Tratamiento")
  if (item.sourceEncounterId !== encounterId) {
    throw conflict("PATH_NOT_HERE", "Solo lo indicado en esta atención se pone en un camino", "planItemId")
  }
  if (item.decisionStatus !== "pendiente") {
    throw conflict("PATH_DECIDED", "Ya tiene respuesta: su camino no cambia", "planItemId")
  }
  if (item.priceCents == null) {
    throw conflict("ITEM_UNPRICED", "Sin precio no entra al presupuesto", "planItemId")
  }
  const path = input.path
  if (!(path === "nuevo" || path === "todos" || path === 1 || path === 2 || path === 3)) {
    throw conflict("PATH_INVALID", "Elige otro camino, uno de los que hay o todos")
  }
  // Lo indicado hoy entra al borrador de la persona (en todos sus caminos), como
  // al firmar: así se ve con qué compite.
  await assembleEncounterBudget(tx, orgId, actorUserId, patientId, encounterId)
  const draft = await findDraftBudget(tx, orgId, patientId)
  if (!draft) throw conflict("PATH_NO_BUDGET", "Este tratamiento no entra al presupuesto en borrador", "planItemId")
  let budget = await getBudgetDetail(tx, orgId, patientId, draft.id)
  if (!budget.items.some((line) => line.planItemId === item.id)) {
    throw conflict("PATH_NO_BUDGET", "Este tratamiento no entra al presupuesto en borrador: es de otro plan o ya tiene otro presupuesto", "planItemId")
  }
  const options = [...budget.options].sort((a, b) => a.position - b.position)
  const linesOf = (optionId: string) => budget.items.filter((line) => line.optionId === optionId)
  const has = (optionId: string, planItemId: string) =>
    budget.items.some((line) => line.optionId === optionId && line.planItemId === planItemId)
  const mine = budget.items.find((line) => line.planItemId === item.id)!
  const remove = async (optionId: string, planItemIds: string[]) => {
    if (planItemIds.length === 0) return
    budget = await removeBudgetItems(tx, orgId, actorUserId, patientId, budget.id, { itemIds: planItemIds, optionId }, opts)
  }
  const add = async (optionId: string) => {
    if (has(optionId, item.id)) return
    budget = await addBudgetItems(tx, orgId, actorUserId, patientId, budget.id, { itemIds: [item.id], optionId }, opts)
  }

  if (path === "todos") {
    for (const option of options) await add(option.id)
  } else if (path === "nuevo") {
    if (options.length >= BUDGET_OPTIONS_MAX) {
      throw conflict("PATH_LIMIT", `Un presupuesto lleva hasta ${BUDGET_OPTIONS_MAX} caminos`)
    }
    const first = options[0]!
    // Lo que compite: con una sola opción, lo demás de la misma pieza indicado
    // hoy; con caminos, lo que ya es de algún camino (y tiene que ser la misma pieza).
    let rivals: string[]
    if (options.length === 1) {
      const site = siteKey(mine)
      rivals = site
        ? linesOf(first.id)
            .filter((line) => line.planItemId !== item.id && line.decision === "pendiente" && siteKey(line) === site)
            .map((line) => line.planItemId)
        : []
      if (rivals.length === 0) {
        throw conflict("PATH_NO_RIVAL", "No hay otro tratamiento de esa pieza con el que compita")
      }
      const sameEncounter = await tx
        .select({ id: treatmentPlanItem.id, sourceEncounterId: treatmentPlanItem.sourceEncounterId })
        .from(treatmentPlanItem)
        .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId)))
      const here = new Set(sameEncounter.filter((row) => row.sourceEncounterId === encounterId).map((row) => row.id))
      rivals = rivals.filter((id) => here.has(id))
      if (rivals.length === 0) {
        throw conflict("PATH_NO_RIVAL", "No hay otro tratamiento de esa pieza indicado hoy con el que compita")
      }
    } else {
      const common = commonPlanItems(budget.items, options.length)
      const exclusive = budget.items.filter((line) => !common.has(line.planItemId) && line.planItemId !== item.id)
      const site = siteKey(mine)
      if (!site || !exclusive.some((line) => siteKey(line) === site)) {
        throw conflict("PATH_OTHER_SITE", "Este presupuesto ya tiene caminos para otra pieza: esta se decide aparte")
      }
      rivals = [...new Set(exclusive.map((line) => line.planItemId))]
    }
    budget = await duplicateBudgetOption(tx, orgId, actorUserId, patientId, budget.id, first.id, opts)
    const created = [...budget.options].sort((a, b) => a.position - b.position).at(-1)!
    // El camino nuevo: lo común y este tratamiento.
    await remove(created.id, rivals.filter((id) => has(created.id, id)))
    for (const option of options) if (has(option.id, item.id)) await remove(option.id, [item.id])
    await add(created.id)
  } else {
    const target = options.find((option) => option.position === path)
    if (!target || options.length < 2) throw conflict("PATH_INVALID", "Ese camino no existe")
    await add(target.id)
    for (const option of options) if (option.id !== target.id && has(option.id, item.id)) await remove(option.id, [item.id])
  }
  // Un camino que se quedó sin nada propio deja de ser camino.
  const now = [...budget.options].sort((a, b) => a.position - b.position)
  if (now.length > 1) {
    const common = commonPlanItems(budget.items, now.length)
    for (const option of now) {
      const own = linesOf(option.id).filter((line) => !common.has(line.planItemId))
      if (own.length === 0 && budget.options.length > 1) {
        budget = await removeBudgetOption(tx, orgId, actorUserId, patientId, budget.id, option.id, opts)
      }
    }
  }
  return getBudgetDetail(tx, orgId, patientId, budget.id)
}
