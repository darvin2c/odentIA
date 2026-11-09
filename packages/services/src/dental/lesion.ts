/**
 * Una lesión de varias caras (una caries DO) se guarda como una fila por cara,
 * todas en la misma anotación: misma atención, pieza, hallazgo, autor y momento
 * (`insertOdontogramFinding` las inserta juntas). El tratamiento que nació de
 * ella se vincula a una sola (`plan_item_finding`); al terminarlo se trata la
 * lesión entera, no solo esa cara (QA del 9 nov: quedaba «Oclusal · Tratado» y
 * «Distal · Vigente» tras la endodoncia).
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"

/** Una cara de la lesión, sin anular. */
export interface LesionRow {
  id: string
  surface: string | null
  resolvedAt: Date | null
  resolvedByPlanItemId: string | null
}

/** Las caras de la misma anotación que `entryId` (ella incluida), sin las anuladas. */
export async function lesionRowsOf(tx: Db, orgId: string, entryId: string): Promise<LesionRow[]> {
  const rows = await tx.execute<{
    id: string
    surface: string | null
    resolved_at: string | Date | null
    resolved_by_plan_item_id: string | null
  }>(sql`
    select sib.id, sib.surface, sib.resolved_at, sib.resolved_by_plan_item_id
    from odontogram_entry linked
    join odontogram_entry sib
      on sib.organization_id = linked.organization_id and sib.patient_id = linked.patient_id
      and sib.tooth_number = linked.tooth_number and sib.condition = linked.condition
      and sib.created_at = linked.created_at
      and sib.created_by is not distinct from linked.created_by
      and sib.encounter_id is not distinct from linked.encounter_id
    where linked.organization_id = ${orgId} and linked.id = ${entryId}
      and sib.voided_at is null and sib.status <> 'voided'
    order by sib.surface nulls first, sib.id`)
  return rows.map((row) => ({
    id: row.id,
    surface: row.surface,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    resolvedByPlanItemId: row.resolved_by_plan_item_id,
  }))
}

/**
 * Lo que un tratamiento terminado deja tratado de su lesión: si es de la pieza
 * entera (endodoncia, corona, exodoncia), todas sus caras; si es de caras (una
 * resina), solo las que cubre: una resina O sobre una caries MO deja la M
 * vigente. Si no cubre ninguna, la cara vinculada, como antes.
 */
export function treatedByItem(
  lesion: readonly LesionRow[],
  linkedId: string,
  itemSurfaces: readonly string[],
): LesionRow[] {
  if (itemSurfaces.length === 0) return [...lesion]
  const covered = lesion.filter((row) => row.surface !== null && itemSurfaces.includes(row.surface))
  return covered.length ? covered : lesion.filter((row) => row.id === linkedId)
}
