import type { Db } from "@odentia/db"
import { planItemFinding } from "@odentia/db/schema/dental"
import type { DentalSite } from "@odentia/dental"
import { and, eq, inArray } from "drizzle-orm"
import { type SiteColumns, withDentalSite } from "./site.js"

/**
 * El hallazgo del odontograma que motivó cada tratamiento del plan (ADR 0079):
 * vive en `dental.plan_item_finding`, fuera del plan común. La API lo sigue
 * diciendo en el ítem como `odontogramEntryId`.
 */
export interface PlanItemFinding {
  odontogramEntryId: string | null
}

async function findingsOf(
  tx: Db,
  orgId: string,
  itemIds: readonly string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map()
  const rows = await tx
    .select({ planItemId: planItemFinding.planItemId, entryId: planItemFinding.odontogramEntryId })
    .from(planItemFinding)
    .where(
      and(
        eq(planItemFinding.organizationId, orgId),
        inArray(planItemFinding.planItemId, [...itemIds]),
      ),
    )
  return new Map(rows.map((row) => [row.planItemId, row.entryId]))
}

/** Ítems del plan como los dice la API: con su pieza y caras y su hallazgo de origen. */
export async function withPlanDental<T extends SiteColumns & { id: string }>(
  tx: Db,
  orgId: string,
  rows: readonly T[],
): Promise<Array<T & DentalSite & PlanItemFinding>> {
  const findings = await findingsOf(
    tx,
    orgId,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    ...withDentalSite(row),
    odontogramEntryId: findings.get(row.id) ?? null,
  }))
}

/** Lo mismo para un solo ítem. */
export async function withPlanItemDental<T extends SiteColumns & { id: string }>(
  tx: Db,
  orgId: string,
  row: T,
): Promise<T & DentalSite & PlanItemFinding> {
  const [item] = await withPlanDental(tx, orgId, [row])
  return item!
}

/** Anota el hallazgo que motivó un tratamiento recién indicado; sin hallazgo no anota nada. */
export async function linkPlanItemFinding(
  tx: Db,
  item: { organizationId: string; patientId: string; id: string },
  odontogramEntryId: string | null | undefined,
): Promise<void> {
  if (!odontogramEntryId) return
  await tx.insert(planItemFinding).values({
    planItemId: item.id,
    organizationId: item.organizationId,
    patientId: item.patientId,
    odontogramEntryId,
  })
}
