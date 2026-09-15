import type { Db } from "@odentia/db";
import {
  cie10Code,
  clinicalNote,
  encounter,
  encounterProcedure,
  encounterTooth,
  odontogramEntry,
  patientDocument,
} from "@odentia/db/schema/clinical";
import { auditEvent, branch } from "@odentia/db/schema/org";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { VALID_FDI_TEETH } from "./clinical.js";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";
import { requirePatient } from "./patients.js";
import { setPlanItemStatus } from "./plan.js";

export type EncounterRow = typeof encounter.$inferSelect;
export type EncounterProcedureRow = typeof encounterProcedure.$inferSelect;
export type EncounterNoteRow = typeof clinicalNote.$inferSelect;
export type EncounterOdontogramRow = typeof odontogramEntry.$inferSelect;
export type EncounterDocumentRow = typeof patientDocument.$inferSelect;

export interface CreateEncounterInput {
  reason?: string | null;
  branchId?: string | null;
  teeth?: number[];
}

export interface UpdateEncounterDraftPatch {
  reason?: string | null;
  evolution?: string | null;
  indications?: string | null;
  nextStep?: string | null;
  /** ISO-8601; null la limpia; undefined = sin cambio. */
  nextAppointmentAt?: string | null;
  /** Reemplaza el set completo de piezas (vacío = sin piezas). */
  teeth?: number[];
}

export interface AddEncounterProcedureInput {
  description: string;
  toothNumber?: number | null;
  diagnosisCode?: string | null;
  planItemId?: string | null;
}

export interface ListEncountersInput {
  cursor?: string;
  limit?: number;
  status?: string;
}

export interface EncounterDetail {
  encounter: EncounterRow;
  teeth: number[];
  procedures: EncounterProcedureRow[];
  /** clinical_note con kind='evolucion', orden ascendente determinista. */
  notes: EncounterNoteRow[];
  odontogramEntries: EncounterOdontogramRow[];
  documents: EncounterDocumentRow[];
  /** clinical_note con kind='adenda', orden ascendente determinista. */
  addenda: EncounterNoteRow[];
}

const PAGE_DEFAULT = 30;
const ENCOUNTER_STATUSES = ["borrador", "finalizada"] as const;

const TEXT_LIMITS = {
  reason: 2000,
  evolution: 10000,
  indications: 5000,
  nextStep: 2000,
  procedureDescription: 2000,
} as const;

const FDI_SET: ReadonlySet<number> = new Set(VALID_FDI_TEETH);

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message);
}

function uniqueConstraintOf(error: unknown): string {
  const chain = [error, (error as { cause?: unknown })?.cause];
  for (const e of chain) {
    const r = e as Record<string, unknown> | null | undefined;
    const found = r?.constraint_name ?? r?.constraint ?? r?.detail;
    if (found) return String(found);
  }
  return String((error as Error)?.message ?? "");
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

function assertFdi(tooth: number): void {
  if (!Number.isInteger(tooth) || !FDI_SET.has(tooth)) throw validation(`Pieza dental inválida: ${tooth}`);
}

/** Valida FDI y elimina duplicados preservando el orden de llegada. */
function dedupeTeeth(teeth: number[]): number[] {
  if (!Array.isArray(teeth)) throw validation("teeth debe ser un arreglo de piezas FDI");
  const out: number[] = [];
  const seen = new Set<number>();
  for (const t of teeth) {
    assertFdi(t);
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Trim + cota; null/undefined/vacío → null (limpia el campo). */
function cleanText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const t = value.trim();
  if (!t) return null;
  if (t.length > max) throw validation(`${field} supera ${max} caracteres`);
  return t;
}

/** Fila del encounter validando tenancy org + pertenencia al paciente. */
export async function requireEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)),
    )
    .limit(1);
  if (!row) throw notFound("Atención");
  return row;
}

/**
 * Igual que requireEncounter pero bloqueando la fila FOR UPDATE: serializa
 * edición concurrente vs finalización (update/finalize/procedure/addenda
 * verifican el estado solo después de tomar el lock).
 */
async function lockEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)),
    )
    .for("update")
    .limit(1);
  if (!row) throw notFound("Atención");
  return row;
}

export async function createEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateEncounterInput,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId);
  const teeth = input.teeth === undefined ? [] : dedupeTeeth(input.teeth);
  let branchId: string | null = null;
  if (input.branchId) {
    const [found] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.organizationId, orgId)))
      .limit(1);
    if (!found) throw notFound("Sucursal");
    branchId = found.id;
  }
  const reason = input.reason == null ? null : cleanText(input.reason, "reason", TEXT_LIMITS.reason);
  try {
    const [row] = await tx
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId,
        branchId,
        dentistUserId: actorUserId,
        status: "borrador",
        reason,
      })
      .returning();
    if (!row) throw new Error("No se pudo crear la atención");
    if (teeth.length > 0) {
      await tx.insert(encounterTooth).values(
        teeth.map((toothNumber) => ({ organizationId: orgId, encounterId: row.id, toothNumber })),
      );
    }
    await audit(tx, orgId, actorUserId, "encounter.created", "encounter", row.id, { patientId, teeth });
    return row;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    if (uniqueConstraintOf(e).includes("encounter_patient_open_uidx")) {
      throw conflict("DRAFT_OPEN", "Ya hay una atención en curso para este paciente");
    }
    throw e;
  }
}

export async function getEncounterDetail(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterDetail> {
  const row = await requireEncounter(tx, orgId, patientId, encounterId);
  const childOf = and(eq(clinicalNote.encounterId, encounterId), eq(clinicalNote.organizationId, orgId));
  const [teethRows, procedures, notes, addenda, entries, documents] = await Promise.all([
    tx
      .select({ toothNumber: encounterTooth.toothNumber })
      .from(encounterTooth)
      .where(and(eq(encounterTooth.encounterId, encounterId), eq(encounterTooth.organizationId, orgId)))
      .orderBy(asc(encounterTooth.toothNumber)),
    tx
      .select()
      .from(encounterProcedure)
      .where(and(eq(encounterProcedure.encounterId, encounterId), eq(encounterProcedure.organizationId, orgId)))
      .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id)),
    tx
      .select()
      .from(clinicalNote)
      .where(and(childOf, eq(clinicalNote.kind, "evolucion")))
      .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
    tx
      .select()
      .from(clinicalNote)
      .where(and(childOf, eq(clinicalNote.kind, "adenda")))
      .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
    tx
      .select()
      .from(odontogramEntry)
      .where(and(eq(odontogramEntry.encounterId, encounterId), eq(odontogramEntry.organizationId, orgId)))
      .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id)),
    tx
      .select()
      .from(patientDocument)
      .where(and(eq(patientDocument.encounterId, encounterId), eq(patientDocument.organizationId, orgId)))
      .orderBy(asc(patientDocument.createdAt), asc(patientDocument.id)),
  ]);
  return {
    encounter: row,
    teeth: teethRows.map((t) => t.toothNumber),
    procedures,
    notes,
    odontogramEntries: entries,
    documents,
    addenda,
  };
}

export async function listEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  input: ListEncountersInput,
): Promise<{ items: EncounterRow[]; nextCursor: string | null }> {
  await requirePatient(tx, orgId, patientId);
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100);
  if (input.status !== undefined && !(ENCOUNTER_STATUSES as readonly string[]).includes(input.status)) {
    throw validation("status debe ser 'borrador' o 'finalizada'");
  }
  const conditions = [eq(encounter.patientId, patientId), eq(encounter.organizationId, orgId)];
  if (input.status) conditions.push(eq(encounter.status, input.status));
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) throw validation("Cursor inválido");
    const ts = new Date(decoded.ts);
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido");
    conditions.push(
      or(lt(encounter.createdAt, ts), and(eq(encounter.createdAt, ts), lt(encounter.id, decoded.id)))!,
    );
  }
  const rows = await tx
    .select()
    .from(encounter)
    .where(and(...conditions))
    .orderBy(desc(encounter.createdAt), desc(encounter.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  };
}

export async function updateEncounterDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  patch: UpdateEncounterDraftPatch,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId);
  const locked = await lockEncounter(tx, orgId, patientId, encounterId);
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada");
  const set: Partial<typeof encounter.$inferInsert> = {};
  if (patch.reason !== undefined) set.reason = cleanText(patch.reason, "reason", TEXT_LIMITS.reason);
  if (patch.evolution !== undefined) set.evolution = cleanText(patch.evolution, "evolution", TEXT_LIMITS.evolution);
  if (patch.indications !== undefined)
    set.indications = cleanText(patch.indications, "indications", TEXT_LIMITS.indications);
  if (patch.nextStep !== undefined) set.nextStep = cleanText(patch.nextStep, "nextStep", TEXT_LIMITS.nextStep);
  if (patch.nextAppointmentAt !== undefined) {
    if (patch.nextAppointmentAt === null) {
      set.nextAppointmentAt = null;
    } else {
      const d = new Date(patch.nextAppointmentAt);
      if (Number.isNaN(d.getTime())) throw validation("nextAppointmentAt debe ser una fecha ISO válida");
      set.nextAppointmentAt = d;
    }
  }
  const teeth = patch.teeth === undefined ? undefined : dedupeTeeth(patch.teeth);
  const [updated] = await tx
    .update(encounter)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(encounter.id, encounterId))
    .returning();
  if (!updated) throw notFound("Atención");
  if (teeth !== undefined) {
    await tx.delete(encounterTooth).where(eq(encounterTooth.encounterId, encounterId));
    if (teeth.length > 0) {
      await tx.insert(encounterTooth).values(
        teeth.map((toothNumber) => ({ organizationId: orgId, encounterId, toothNumber })),
      );
    }
  }
  await audit(tx, orgId, actorUserId, "encounter.updated", "encounter", encounterId, { patientId, teeth });
  return updated;
}

export async function addEncounterProcedure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: AddEncounterProcedureInput,
): Promise<EncounterProcedureRow> {
  await requirePatient(tx, orgId, patientId);
  const locked = await lockEncounter(tx, orgId, patientId, encounterId);
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada");
  const description = input.description?.trim() ?? "";
  if (!description) throw validation("description es obligatoria");
  if (description.length > TEXT_LIMITS.procedureDescription) {
    throw validation(`description supera ${TEXT_LIMITS.procedureDescription} caracteres`);
  }
  let toothNumber: number | null = null;
  if (input.toothNumber !== undefined && input.toothNumber !== null) {
    assertFdi(input.toothNumber);
    toothNumber = input.toothNumber;
  }
  if (input.diagnosisCode) await assertDiagnosisCode(tx, input.diagnosisCode);
  const [row] = await tx
    .insert(encounterProcedure)
    .values({
      organizationId: orgId,
      encounterId,
      toothNumber,
      description,
      diagnosisCode: input.diagnosisCode ?? null,
      planItemId: input.planItemId ?? null,
      createdBy: actorUserId,
    })
    .returning();
  if (!row) throw new Error("No se pudo registrar el procedimiento");
  if (toothNumber !== null) {
    // La pieza tratada entra al set de la atención para que el filtro por
    // pieza del timeline la incluya aunque no estuviera al crear el borrador.
    await tx
      .insert(encounterTooth)
      .values({ organizationId: orgId, encounterId, toothNumber })
      .onConflictDoNothing({ target: [encounterTooth.encounterId, encounterTooth.toothNumber] });
  }
  if (input.planItemId) {
    // setPlanItemStatus valida pertenencia mismo paciente/org + borrador;
    // el lock del encounter ya está tomado en esta tx (re-lock es no-op).
    await setPlanItemStatus(tx, orgId, actorUserId, patientId, input.planItemId, {
      status: "realizado",
      encounterId,
    });
  }
  await audit(tx, orgId, actorUserId, "encounter.procedure_added", "encounter_procedure", row.id, {
    patientId,
    encounterId,
    planItemId: input.planItemId ?? null,
  });
  return row;
}

export async function finalizeEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId);
  const locked = await lockEncounter(tx, orgId, patientId, encounterId);
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención ya está finalizada");
  const now = new Date();
  const [row] = await tx
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: now, finalizedBy: actorUserId, updatedAt: now })
    .where(eq(encounter.id, encounterId))
    .returning();
  if (!row) throw notFound("Atención");
  await audit(tx, orgId, actorUserId, "encounter.finalized", "encounter", encounterId, { patientId });
  return row;
}

export async function addEncounterAddendum(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { text: string },
): Promise<EncounterNoteRow> {
  await requirePatient(tx, orgId, patientId);
  const locked = await lockEncounter(tx, orgId, patientId, encounterId);
  if (locked.status !== "finalizada") {
    throw conflict("NOT_FINALIZED", "Solo se puede agregar una adenda a una atención finalizada");
  }
  const text = input.text?.trim() ?? "";
  if (text.length < 1 || text.length > 4000) throw validation("text debe tener 1–4000 caracteres");
  const [row] = await tx
    .insert(clinicalNote)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      note: text,
      encounterId,
      kind: "adenda",
    })
    .returning();
  if (!row) throw new Error("No se pudo guardar la adenda");
  await audit(tx, orgId, actorUserId, "encounter.addendum_added", "clinical_note", row.id, {
    patientId,
    encounterId,
  });
  return row;
}
