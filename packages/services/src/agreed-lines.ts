import type { Db } from "@odentia/db"
import { treatmentBudget, treatmentBudgetItem } from "@odentia/db/schema/clinical"
import { and, desc, eq, inArray, sql } from "drizzle-orm"

type BudgetLine = typeof treatmentBudgetItem.$inferSelect

/**
 * La línea aceptada vigente de cada tratamiento: la de un presupuesto aceptado
 * o parcial con decisión aceptada, con el precio final acordado y su modo de
 * cobro. Mientras una revisión ya entregada espera respuesta, lo último
 * aceptado sigue valiendo: lo que se atienda en ese intervalo se cobra a lo
 * acordado, no a tarifa. Deja de valer cuando la revisión se decide.
 *
 * Es lo que cobra la atención (`encounters.ts`) y lo que muestra como precio
 * (QA de la ficha del 8 nov: la atención decía S/ 120 de lista con S/ 90
 * acordado). De muchos tratamientos a la vez, con dos consultas.
 */
export async function acceptedBudgetLines(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemIds: readonly string[],
): Promise<Map<string, BudgetLine>> {
  const out = new Map<string, BudgetLine>()
  const ids = [...new Set(planItemIds)]
  if (ids.length === 0) return out
  const found = await tx
    .select({ line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, eq(treatmentBudget.id, treatmentBudgetItem.budgetId))
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        inArray(treatmentBudgetItem.planItemId, ids),
        eq(treatmentBudgetItem.decision, "aceptado"),
        sql`${treatmentBudget.status} IN ('aceptado','parcial')`,
      ),
    )
    .orderBy(desc(treatmentBudget.decidedAt), desc(treatmentBudget.createdAt))
  for (const { line } of found) if (!out.has(line.planItemId)) out.set(line.planItemId, line)
  const missing = ids.filter((id) => !out.has(id))
  if (missing.length === 0) return out
  const previous = await tx
    .select({ line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, eq(treatmentBudget.id, treatmentBudgetItem.budgetId))
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        inArray(treatmentBudgetItem.planItemId, missing),
        eq(treatmentBudgetItem.decision, "aceptado"),
        eq(treatmentBudget.status, "sustituido"),
        sql`exists (
          select 1 from "treatment_budget" next
          where next."supersedes_budget_id" = ${treatmentBudget.id}
            and next."organization_id" = ${orgId}
            and next."status" in ('presentado','pospuesto')
        )`,
      ),
    )
    .orderBy(desc(treatmentBudget.decidedAt), desc(treatmentBudget.createdAt))
  for (const { line } of previous) if (!out.has(line.planItemId)) out.set(line.planItemId, line)
  return out
}
