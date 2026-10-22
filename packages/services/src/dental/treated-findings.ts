/**
 * Lo tratado queda dibujado (fase 3, tablero 4; ADR 0036). Al completar un
 * tratamiento —«Completar» en «Hecho hoy» o el servicio directo, que nace
 * realizado— su servicio dice qué deja en la pieza (`dental.service_finding`) y ese
 * hallazgo se registra en la atención, con el tratamiento que lo dejó
 * (`left_by_plan_item_id`). Una sola vez por tratamiento: completar otra vez
 * no lo duplica, y si el tratamiento deja de estar realizado (se anula su
 * procedimiento) lo dibujado se anula con él.
 */
import { findingLeftByTreatment, type LeavesFinding } from "@odentia/dental"
import type { Db } from "@odentia/db"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { auditEvent } from "@odentia/db/schema/org"
import { and, eq, isNull, ne } from "drizzle-orm"
import { insertOdontogramFinding, orgStrictVariants } from "../clinical.js"
import { serviceLeavesFinding } from "./service-finding.js"

/** Lo del tratamiento que hace falta para dibujarlo. */
export interface TreatedItem {
  id: string
  serviceId: string | null
  toothNumber: number | null
  surfaces: readonly string[] | null
  odontogramEntryId: string | null
}

/** Hallazgos vigentes (no anulados, no tratados) de una pieza, sus códigos. */
async function toothConditionsOf(
  tx: Db,
  orgId: string,
  patientId: string,
  toothNumber: number,
): Promise<string[]> {
  const rows = await tx
    .select({ condition: odontogramEntry.condition })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.toothNumber, toothNumber),
        isNull(odontogramEntry.voidedAt),
        isNull(odontogramEntry.resolvedAt),
        ne(odontogramEntry.status, "voided"),
        eq(odontogramEntry.needsReview, false),
      ),
    )
  return rows.map((row) => row.condition)
}

/**
 * Registra en la atención lo que deja el tratamiento completado, si su
 * servicio lo dice y aún no está dibujado. Devuelve el hallazgo o null (el
 * servicio no deja nada, ya estaba, o no hay dónde dibujarlo: sin pieza, o lo
 * que va en caras sin superficies). No bloquea completar: un tratamiento que
 * no se puede dibujar se completa igual.
 */
export async function drawTreatedFinding(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  item: TreatedItem,
) {
  if (!item.serviceId || item.toothNumber == null) return null
  const [service] = await tx
    .select({ leaves: serviceLeavesFinding })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, item.serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  const leaves = service?.leaves as LeavesFinding | null | undefined
  if (!leaves) return null
  const [already] = await tx
    .select({ id: odontogramEntry.id })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.leftByPlanItemId, item.id),
        isNull(odontogramEntry.voidedAt),
        ne(odontogramEntry.status, "voided"),
      ),
    )
    .limit(1)
  if (already) return null
  const strictVariants = await orgStrictVariants(tx, orgId)
  const [origin] = item.odontogramEntryId
    ? await tx
        .select({ condition: odontogramEntry.condition })
        .from(odontogramEntry)
        .where(
          and(
            eq(odontogramEntry.id, item.odontogramEntryId),
            eq(odontogramEntry.organizationId, orgId),
          ),
        )
        .limit(1)
    : []
  const finding = findingLeftByTreatment(
    leaves,
    { toothNumber: item.toothNumber, surfaces: item.surfaces },
    {
      strictVariants,
      originCondition: origin?.condition ?? null,
      toothConditions: await toothConditionsOf(tx, orgId, patientId, item.toothNumber),
    },
  )
  if (!finding) return null
  const [row] = await insertOdontogramFinding(tx, orgId, actorUserId, patientId, encounterId, finding, {
    strictVariants,
    leftByPlanItemId: item.id,
  })
  return row ?? null
}

/**
 * El tratamiento dejó de estar realizado en esta atención (se anuló su
 * procedimiento): lo que dejó dibujado se anula con el mismo motivo.
 */
export async function voidLeftFindings(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planItemId: string,
  reason: string,
  at: Date,
): Promise<number> {
  const voided = await tx
    .update(odontogramEntry)
    .set({
      status: "voided",
      voidedAt: at,
      voidedBy: actorUserId,
      voidReason: `Tratamiento anulado: ${reason}`.slice(0, 2000),
      updatedAt: at,
    })
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.encounterId, encounterId),
        eq(odontogramEntry.leftByPlanItemId, planItemId),
        isNull(odontogramEntry.voidedAt),
        ne(odontogramEntry.status, "voided"),
      ),
    )
    .returning({ id: odontogramEntry.id })
  for (const entry of voided) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "odontogram.entry_voided",
      entity: "odontogram_entry",
      entityId: entry.id,
      metadata: { patientId, encounterId, planItemId, reason },
    })
  }
  return voided.length
}
