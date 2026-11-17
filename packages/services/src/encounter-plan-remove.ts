/**
 * «Quitar» un renglón indicado hoy, en la misma atención (QA de la atención del
 * 8 nov, propuesta 4.2): corregir el borrador antes de que la persona responda.
 * Sale de su presupuesto en borrador (y la opción que queda sin nada suyo, con él) y se
 * cancela con un motivo fijo que el Plan no lista (`REMOVED_IN_ENCOUNTER`). Lo
 * que ya tiene respuesta, se hizo o se entregó no se quita aquí: se cambia en el
 * Plan con una revisión.
 */
import type { Db } from "@odentia/db"
import { treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, sql } from "drizzle-orm"
import { dropPathsWithoutOwn } from "./budget-paths.js"
import {
  type BudgetActorOpts,
  type BudgetRemovalSnapshot,
  draftBudgetSnapshot,
  getBudgetDetail,
  removeBudgetItems,
  restoreDraftBudget,
} from "./budgets.js"
import { notFound, ServiceError } from "./errors.js"

import { requirePatient } from "./patients.js"
import { lockDraftEncounter, REMOVED_IN_ENCOUNTER, setPlanItemStatus } from "./plan.js"
import { productHooks } from "./products.js"

const conflict = (code: string, message: string): ServiceError =>
  new ServiceError(code, 409, message)

/** Lo indicado en esta atención que todavía se puede quitar desde ella. */
function removableSql(encounterId: string, userId: string) {
  return sql`i.source_encounter_id = ${encounterId} and i.status = 'pendiente' and i.decision_status = 'pendiente'
    and (i.budget_id is null or (i.created_by = ${userId} and exists (select 1 from treatment_budget b where b.id = i.budget_id
      and b.organization_id = i.organization_id and b.status = 'borrador' and b.supersedes_budget_id is null)))`
}

/**
 * Los tratamientos indicados en esta atención que quien la lleva (`userId`) todavía puede
 * quitar: lo que está en un presupuesto, solo si lo indicó él (el presupuesto es de quien lo
 * preparó; tras un relevo, lo del colega se cambia en el Plan).
 */
export async function removableFromEncounter(
  tx: Db,
  orgId: string,
  encounterId: string,
  userId: string,
): Promise<Set<string>> {
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from treatment_plan_item i where i.organization_id = ${orgId} and ${removableSql(encounterId, userId)}`)
  return new Set(rows.map((row) => row.id))
}

export async function removeIndicatedFromEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planItemId: string,
  opts: BudgetActorOpts = {},
): Promise<void> {
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  const [item] = await tx
    .select({ id: treatmentPlanItem.id, budgetId: treatmentPlanItem.budgetId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.id, planItemId),
      ),
    )
    .limit(1)
  if (!item) throw notFound("Ítem del plan")
  const removable = await removableFromEncounter(tx, orgId, encounterId, actorUserId)
  if (!removable.has(planItemId))
    throw conflict(
      "NOT_REMOVABLE",
      "Ya tiene respuesta, se empezó o su presupuesto se entregó: cámbialo desde el Plan con una revisión",
    )
  // Lo que sale del borrador queda anotado tal como estaba: «Deshacer» lo devuelve igual.
  let budget: BudgetRemovalSnapshot | null = null
  if (item.budgetId) {
    const before = await draftBudgetSnapshot(tx, orgId, item.budgetId)
    const left = await removeBudgetItems(
      tx,
      orgId,
      actorUserId,
      patientId,
      item.budgetId,
      { itemIds: [planItemId] },
      opts,
    )
    // La opción que quedó sin nada suyo se va con él: un camino vacío, o solo con lo común, no
    // es una opción (la regla de los caminos).
    await dropPathsWithoutOwn(tx, orgId, actorUserId, patientId, left, opts)
    const afterSnapshot = await draftBudgetSnapshot(tx, orgId, item.budgetId)
    const after = new Set(afterSnapshot.lines.map((line) => line.id))
    const afterOptions = new Set(afterSnapshot.options.map((option) => option.id))
    budget = {
      budgetId: item.budgetId,
      options: before.options,
      lines: before.lines.filter((line) => !after.has(line.id)),
      removedOptionIds: before.options.filter((option) => !afterOptions.has(option.id)).map((option) => option.id),
    }
  }
  await setPlanItemStatus(tx, orgId, actorUserId, patientId, planItemId, {
    status: "cancelado",
    statusReason: REMOVED_IN_ENCOUNTER,
    encounterId,
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "plan_item.removed_in_encounter",
    entity: "treatment_plan_item",
    entityId: planItemId,
    metadata: { patientId, encounterId, ...(budget ? { budget } : {}) },
  })
}

/**
 * «Deshacer» de «Quitar» (QA del 16 nov, B1e): lo quitado vuelve a ser el mismo tratamiento,
 * no una indicación nueva. Vuelve por decidir, con su hallazgo y su consentimiento, y a su
 * presupuesto en borrador como estaba: en su opción, con su precio y su orden (lo dice la
 * auditoría del «Quitar»). Antes volvía con la tarifa y fuera de su opción, y lo de la otra
 * opción pasaba a «va después» de él. Solo quien lleva la atención, mientras está en borrador.
 */
export async function restoreRemovedInEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planItemId: string,
  opts: BudgetActorOpts = {},
): Promise<void> {
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  const [item] = await tx
    .select({
      id: treatmentPlanItem.id,
      status: treatmentPlanItem.status,
      statusReason: treatmentPlanItem.statusReason,
      sourceEncounterId: treatmentPlanItem.sourceEncounterId,
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.id, planItemId),
      ),
    )
    .limit(1)
    .for("update")
  if (!item) throw notFound("Ítem del plan")
  if (
    item.sourceEncounterId !== encounterId ||
    item.status !== "cancelado" ||
    item.statusReason !== REMOVED_IN_ENCOUNTER
  )
    throw conflict("NOT_RESTORABLE", "Solo vuelve lo que se quitó en esta atención")
  // Lo que cayó con la anulación de su hallazgo (la pieza equivocada) no vuelve con «Deshacer»:
  // volvería con la pieza y el diagnóstico de un hallazgo anulado (QA del 16 nov, Q19).
  const hooks = await productHooks(tx, orgId)
  if (await hooks.correction?.itemLostItsFinding(tx, { orgId, patientId, planItemId }))
    throw conflict("FINDING_VOIDED", "Su hallazgo se anuló: no se puede deshacer. Vuelve a indicarlo en la pieza correcta.")
  const [removal] = await tx
    .select({ metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.entity, "treatment_plan_item"),
        eq(auditEvent.entityId, planItemId),
        eq(auditEvent.action, "plan_item.removed_in_encounter"),
      ),
    )
    .orderBy(desc(auditEvent.createdAt))
    .limit(1)
  const budget = (removal?.metadata as { budget?: BudgetRemovalSnapshot } | null)?.budget ?? null
  // Quitar solo se ofrece a lo que estaba por empezar y por decidir: vuelve a eso.
  await tx
    .update(treatmentPlanItem)
    .set({ status: "pendiente", statusReason: null, updatedAt: new Date() })
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
  if (budget && budget.lines.length > 0) {
    await restoreDraftBudget(tx, orgId, actorUserId, patientId, budget, opts)
    // Lo que volvió pudo dejar un camino sin nada suyo (otro «Quitar» se llevó lo que lo sostenía):
    // no es una opción (R8, la regla de los caminos).
    const restored = await getBudgetDetail(tx, orgId, patientId, budget.budgetId)
    await dropPathsWithoutOwn(tx, orgId, actorUserId, patientId, restored, opts)
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "plan_item.restored_in_encounter",
    entity: "treatment_plan_item",
    entityId: planItemId,
    metadata: { patientId, encounterId, budgetId: budget?.budgetId ?? null },
  })
}
