import type { Db } from "@odentia/db";
import { cie10Code, encounter, treatmentPlanItem } from "@odentia/db/schema/clinical";
import { auditEvent } from "@odentia/db/schema/org";
import { and, asc, eq, sql } from "drizzle-orm";
import { VALID_FDI_TEETH } from "@odentia/clinical";
import { notFound, ServiceError, validation } from "./errors.js";
import { requirePatient } from "./patients.js";

/**
 * Plan de tratamiento: lista de ítems por paciente (sin cabecera).
 * Convención: `tx` ya corre dentro de `withOrgContext`; nunca abrir contexto aquí.
 * Dependencia plan -> @odentia/clinical (solo VALID_FDI_TEETH); clinical
 * nunca importa este módulo. El encounter se toca vía schema directo (lock),
 * nunca vía el servicio de encounters (evita ciclo).
 */

export const PLAN_ITEM_STATUSES = ["pendiente", "programado", "realizado", "cancelado"] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

const CLOSED_STATUSES: readonly string[] = ["realizado", "cancelado"];

export type PlanItemRow = typeof treatmentPlanItem.$inferSelect;

export interface AddPlanItemInput {
  toothNumber?: number | null;
  title: string;
  detail?: string | null;
  diagnosisCode?: string | null;
  priceCents?: number | null;
  /** ISO-4217; default 'PEN'. Se congela al crear: no existe en el patch de edición. */
  currency?: string;
}

export interface UpdatePlanItemPatch {
  title?: string;
  detail?: string | null;
  toothNumber?: number | null;
  diagnosisCode?: string | null;
  priceCents?: number | null;
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message);
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity,
    entityId,
    metadata: metadata ?? null,
  });
}

async function assertDiagnosisCode(tx: Db, code: string): Promise<void> {
  const [row] = await tx.select({ code: cie10Code.code }).from(cie10Code).where(eq(cie10Code.code, code)).limit(1);
  if (!row) throw validation(`Código CIE-10 inexistente: ${code}`);
}

function assertTooth(toothNumber: number | null | undefined): number | null {
  if (toothNumber === null || toothNumber === undefined) return null;
  if (!VALID_FDI_TEETH.includes(toothNumber)) throw validation("Pieza FDI inválida");
  return toothNumber;
}

function assertTitle(title: string): string {
  const trimmed = title?.trim() ?? "";
  if (!trimmed || trimmed.length > 300) throw validation("title debe tener 1–300 caracteres");
  return trimmed;
}

function assertDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null;
  if (detail.length > 4000) throw validation("detail debe tener hasta 4000 caracteres");
  const trimmed = detail.trim();
  return trimmed ? trimmed : null;
}

function assertPrice(priceCents: number | null | undefined): number | null {
  if (priceCents === null || priceCents === undefined) return null;
  // int4 en DB: acotar aquí para devolver 400 en vez de un 500 de Postgres.
  if (!Number.isInteger(priceCents) || priceCents < 0 || priceCents > 2147483647) {
    throw validation("priceCents debe ser un entero >= 0");
  }
  return priceCents;
}

function assertCurrency(currency: string | undefined): string {
  const value = currency ?? "PEN";
  if (!/^[A-Z]{3}$/.test(value)) throw validation("currency debe ser ISO-4217 de 3 letras mayúsculas");
  return value;
}

function normalizeDiagnosisCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/** Bloqueo de escritura de la fila del ítem dentro de la tx (serializa updates). */
async function lockPlanItemRow(tx: Db, orgId: string, patientId: string, itemId: string): Promise<void> {
  await tx.execute(
    sql`select "id" from "treatment_plan_item" where "id" = ${itemId} and "organization_id" = ${orgId} and "patient_id" = ${patientId} for update`,
  );
}

/**
 * Bloqueo de escritura de la fila del encounter. En setPlanItemStatus se toma
 * ANTES que el lock del ítem, igual que en addEncounterProcedure (mismo orden
 * de locks => sin deadlock entre ambas rutas).
 */
async function lockEncounterRow(tx: Db, orgId: string, patientId: string, encounterId: string): Promise<void> {
  await tx.execute(
    sql`select "id" from "encounter" where "id" = ${encounterId} and "organization_id" = ${orgId} and "patient_id" = ${patientId} for update`,
  );
}

/** Lookup del ítem siempre acotado a org + paciente + ítem (anti-traversal). */
async function requirePlanItem(tx: Db, orgId: string, patientId: string, itemId: string): Promise<PlanItemRow> {
  const [row] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Ítem del plan");
  return row;
}

export async function listPlanItems(tx: Db, orgId: string, patientId: string): Promise<PlanItemRow[]> {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.patientId, patientId), eq(treatmentPlanItem.organizationId, orgId)))
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id));
}

export async function addPlanItem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddPlanItemInput,
): Promise<PlanItemRow> {
  await requirePatient(tx, orgId, patientId);
  const title = assertTitle(input.title);
  const detail = assertDetail(input.detail);
  const toothNumber = assertTooth(input.toothNumber);
  const diagnosisCode = normalizeDiagnosisCode(input.diagnosisCode);
  if (diagnosisCode) await assertDiagnosisCode(tx, diagnosisCode);
  const priceCents = assertPrice(input.priceCents);
  const currency = assertCurrency(input.currency);
  const [row] = await tx
    .insert(treatmentPlanItem)
    .values({
      organizationId: orgId,
      patientId,
      toothNumber,
      title,
      detail,
      diagnosisCode,
      priceCents,
      currency,
      status: "pendiente",
      createdBy: actorUserId,
    })
    .returning();
  if (!row) throw new Error("No se pudo crear el ítem del plan");
  await audit(tx, orgId, actorUserId, "plan.item_added", "treatment_plan_item", row.id, {
    patientId,
    status: row.status,
    toothNumber,
    priceCents,
    currency,
  });
  return row;
}

export async function updatePlanItem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  patch: UpdatePlanItemPatch,
): Promise<PlanItemRow> {
  await requirePatient(tx, orgId, patientId);
  await lockPlanItemRow(tx, orgId, patientId, itemId);
  const current = await requirePlanItem(tx, orgId, patientId, itemId);
  if (CLOSED_STATUSES.includes(current.status)) {
    throw conflict("ITEM_CLOSED", "El ítem está cerrado y no puede editarse");
  }
  const set: Partial<typeof treatmentPlanItem.$inferInsert> = {};
  const fields: string[] = [];
  if (patch.title !== undefined) {
    set.title = assertTitle(patch.title);
    fields.push("title");
  }
  if (patch.detail !== undefined) {
    set.detail = assertDetail(patch.detail);
    fields.push("detail");
  }
  if (patch.toothNumber !== undefined) {
    set.toothNumber = assertTooth(patch.toothNumber);
    fields.push("toothNumber");
  }
  if (patch.diagnosisCode !== undefined) {
    const code = normalizeDiagnosisCode(patch.diagnosisCode);
    if (code) await assertDiagnosisCode(tx, code);
    set.diagnosisCode = code;
    fields.push("diagnosisCode");
  }
  if (patch.priceCents !== undefined) {
    set.priceCents = assertPrice(patch.priceCents);
    fields.push("priceCents");
  }
  // currency y status fuera del patch: inmutables por esta vía (currency se
  // congela al crear; status solo vía setPlanItemStatus).
  if (fields.length === 0) throw validation("Sin cambios: patch vacío");
  const [updated] = await tx
    .update(treatmentPlanItem)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .returning();
  if (!updated) throw notFound("Ítem del plan");
  await audit(tx, orgId, actorUserId, "plan.item_updated", "treatment_plan_item", itemId, {
    patientId,
    fields,
  });
  return updated;
}

export async function setPlanItemStatus(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  input: { status: string; encounterId?: string | null },
): Promise<PlanItemRow> {
  if (!(PLAN_ITEM_STATUSES as readonly string[]).includes(input.status)) throw validation("status inválido");
  await requirePatient(tx, orgId, patientId);
  // Transiciones libres (sin máquina de estados); el vínculo a atención solo
  // vive mientras el estado es realizado.
  let linkedEncounterId: string | null = null;
  if (input.encounterId) {
    await lockEncounterRow(tx, orgId, patientId, input.encounterId);
    const [enc] = await tx
      .select()
      .from(encounter)
      .where(
        and(
          eq(encounter.id, input.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .limit(1);
    if (!enc) throw notFound("Atención");
    if (enc.status !== "borrador") throw conflict("FINALIZED", "La atención está finalizada");
    linkedEncounterId = enc.id;
  }
  await lockPlanItemRow(tx, orgId, patientId, itemId);
  const current = await requirePlanItem(tx, orgId, patientId, itemId);
  // Realizado manual (sin encounterId) => NULL ("hecho fuera del sistema").
  // Cualquier otro estado limpia el vínculo aunque se haya pasado encounterId.
  const encounterId = input.status === "realizado" ? linkedEncounterId : null;
  const [updated] = await tx
    .update(treatmentPlanItem)
    .set({ status: input.status, encounterId, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .returning();
  if (!updated) throw notFound("Ítem del plan");
  await audit(tx, orgId, actorUserId, "plan.item_status_changed", "treatment_plan_item", itemId, {
    patientId,
    from: current.status,
    to: input.status,
    encounterId,
  });
  return updated;
}
