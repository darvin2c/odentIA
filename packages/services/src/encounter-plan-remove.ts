/**
 * «Quitar» un renglón indicado hoy, en la misma atención (QA de la atención del
 * 8 nov, propuesta 4.2): corregir el borrador antes de que la persona responda.
 * Sale de su presupuesto en borrador (y la opción que queda vacía, con él) y se
 * cancela con un motivo fijo que el Plan no lista (`REMOVED_IN_ENCOUNTER`). Lo
 * que ya tiene respuesta, se hizo o se entregó no se quita aquí: se cambia en el
 * Plan con una revisión.
 */
import type { Db } from "@odentia/db"
import {
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, sql } from "drizzle-orm"
import { type BudgetActorOpts, removeBudgetItems, removeBudgetOption } from "./budgets.js"
import { notFound, ServiceError } from "./errors.js"

import { requirePatient } from "./patients.js"
import { lockDraftEncounter, REMOVED_IN_ENCOUNTER, setPlanItemStatus } from "./plan.js"

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
  if (item.budgetId) {
    await removeBudgetItems(
      tx,
      orgId,
      actorUserId,
      patientId,
      item.budgetId,
      { itemIds: [planItemId] },
      opts,
    )
    // La opción que quedó sin nada se va con él: un camino vacío no es una opción.
    const empty = await tx
      .select({ id: treatmentBudgetOption.id })
      .from(treatmentBudgetOption)
      .where(
        and(
          eq(treatmentBudgetOption.organizationId, orgId),
          eq(treatmentBudgetOption.budgetId, item.budgetId),
          sql`not exists (select 1 from ${treatmentBudgetItem} line where line.organization_id = ${treatmentBudgetOption.organizationId}
            and line.option_id = ${treatmentBudgetOption.id})`,
        ),
      )
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(treatmentBudgetOption)
      .where(
        and(
          eq(treatmentBudgetOption.organizationId, orgId),
          eq(treatmentBudgetOption.budgetId, item.budgetId),
        ),
      )
    let left = Number(count)
    for (const option of empty) {
      if (left <= 1) break
      await removeBudgetOption(tx, orgId, actorUserId, patientId, item.budgetId, option.id, opts)
      left -= 1
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
    metadata: { patientId, encounterId },
  })
}
