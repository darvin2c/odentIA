import type { Db } from "@odentia/db";
import {
  ODONTOGRAM_STANDARD,
  activeFindingsAsOf,
  isValidTooth,
  validateFinding,
  type FindingDetails,
  type FindingInput,
  type FindingRecord,
} from "@odentia/clinical";
import {
  cie10Code,
  clinicalNote,
  encounter,
  encounterTooth,
  odontogramAssessment,
  odontogramEntry,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientDocument,
  patientMedication,
} from "@odentia/db/schema/clinical";
import { contact } from "@odentia/db/schema/crm";
import { auditEvent } from "@odentia/db/schema/org";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";
import { requirePatient } from "./patients.js";

async function requireDraftLink(tx: Db, orgId: string, patientId: string, encounterId: string) {
  const [row] = await tx.select().from(encounter)
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId)))
    .for("update");
  if (!row) throw notFound("Atención");
  if (row.status !== "borrador") throw conflict("FINALIZED", "La atención está finalizada");
}

const ALLERGY_SEVERITIES = ["leve", "moderada", "severa"] as const;
const CONDITION_STATUSES = ["activa", "resuelta", "inactiva"] as const;
const DOCUMENT_CATEGORIES = ["consentimiento", "radiografia", "foto_clinica", "informe", "otro"] as const;

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

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Alergias ---

export async function addAllergy(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { substance: string; reaction?: string | null; severity?: string },
) {
  await requirePatient(tx, orgId, patientId);
  const substance = input.substance?.trim() ?? "";
  if (substance.length < 1 || substance.length > 200) throw validation("substance debe tener 1–200 caracteres");
  const severity = input.severity ?? "moderada";
  if (!(ALLERGY_SEVERITIES as readonly string[]).includes(severity)) throw validation("severity inválida");
  const [row] = await tx
    .insert(patientAllergy)
    .values({
      organizationId: orgId,
      patientId,
      substance,
      reaction: input.reaction ?? null,
      severity,
      createdBy: actorUserId,
    })
    .returning();
  if (!row) throw new Error("No se pudo registrar la alergia");
  await audit(tx, orgId, actorUserId, "allergy.added", "patient_allergy", row.id, { patientId });
  return row;
}

export async function setAllergyActive(
  tx: Db,
  orgId: string,
  actorUserId: string,
  allergyId: string,
  isActive: boolean,
) {
  const [current] = await tx
    .select()
    .from(patientAllergy)
    .where(and(eq(patientAllergy.id, allergyId), eq(patientAllergy.organizationId, orgId)))
    .limit(1);
  if (!current) throw notFound("Alergia");
  const [updated] = await tx
    .update(patientAllergy)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(patientAllergy.id, allergyId))
    .returning();
  if (!updated) throw notFound("Alergia");
  await audit(tx, orgId, actorUserId, isActive ? "allergy.reactivated" : "allergy.deactivated", "patient_allergy", allergyId, {
    patientId: current.patientId,
  });
  return updated;
}

export async function listAllergies(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(patientAllergy)
    .where(and(eq(patientAllergy.patientId, patientId), eq(patientAllergy.organizationId, orgId)))
    .orderBy(sql`"is_active" desc`, desc(patientAllergy.createdAt));
}

// --- Condiciones ---

export async function addCondition(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { name: string; status?: string; startDate?: string | null; endDate?: string | null; notes?: string | null },
) {
  await requirePatient(tx, orgId, patientId);
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 200) throw validation("name debe tener 1–200 caracteres");
  const status = input.status ?? "activa";
  if (!(CONDITION_STATUSES as readonly string[]).includes(status)) throw validation("status inválido");
  const endDate = input.endDate ?? (status === "resuelta" ? todayDate() : null);
  const [row] = await tx
    .insert(patientCondition)
    .values({
      organizationId: orgId,
      patientId,
      name,
      status,
      startDate: input.startDate ?? null,
      endDate,
      notes: input.notes ?? null,
      createdBy: actorUserId,
    })
    .returning();
  if (!row) throw new Error("No se pudo registrar la condición");
  await audit(tx, orgId, actorUserId, "condition.added", "patient_condition", row.id, { patientId });
  return row;
}

export async function setConditionStatus(
  tx: Db,
  orgId: string,
  actorUserId: string,
  conditionId: string,
  status: string,
  endDate?: string | null,
) {
  if (!(CONDITION_STATUSES as readonly string[]).includes(status)) throw validation("status inválido");
  const [current] = await tx
    .select()
    .from(patientCondition)
    .where(and(eq(patientCondition.id, conditionId), eq(patientCondition.organizationId, orgId)))
    .limit(1);
  if (!current) throw notFound("Condición");
  const resolvedEnd = endDate ?? current.endDate ?? (status === "resuelta" ? todayDate() : current.endDate);
  const [updated] = await tx
    .update(patientCondition)
    .set({ status, endDate: resolvedEnd, updatedAt: new Date() })
    .where(eq(patientCondition.id, conditionId))
    .returning();
  if (!updated) throw notFound("Condición");
  await audit(tx, orgId, actorUserId, "condition.updated", "patient_condition", conditionId, {
    patientId: current.patientId,
    fields: ["status", "endDate"],
  });
  return updated;
}

export async function listConditions(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(patientCondition)
    .where(and(eq(patientCondition.patientId, patientId), eq(patientCondition.organizationId, orgId)))
    .orderBy(sql`case "status" when 'activa' then 0 when 'inactiva' then 1 else 2 end`, desc(patientCondition.createdAt));
}

// --- Medicamentos ---

export async function addMedication(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: {
    name: string;
    dose?: string | null;
    frequency?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    notes?: string | null;
  },
) {
  await requirePatient(tx, orgId, patientId);
  const name = input.name?.trim() ?? "";
  if (name.length < 1 || name.length > 200) throw validation("name debe tener 1–200 caracteres");
  const [row] = await tx
    .insert(patientMedication)
    .values({
      organizationId: orgId,
      patientId,
      name,
      dose: input.dose ?? null,
      frequency: input.frequency ?? null,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      notes: input.notes ?? null,
      createdBy: actorUserId,
    })
    .returning();
  if (!row) throw new Error("No se pudo registrar el medicamento");
  await audit(tx, orgId, actorUserId, "medication.added", "patient_medication", row.id, { patientId });
  return row;
}

export async function discontinueMedication(
  tx: Db,
  orgId: string,
  actorUserId: string,
  medicationId: string,
  endDate?: string | null,
) {
  const [current] = await tx
    .select()
    .from(patientMedication)
    .where(and(eq(patientMedication.id, medicationId), eq(patientMedication.organizationId, orgId)))
    .limit(1);
  if (!current) throw notFound("Medicamento");
  if (current.endDate) throw conflict("ALREADY_DISCONTINUED", "El medicamento ya está suspendido");
  const [updated] = await tx
    .update(patientMedication)
    .set({ endDate: endDate ?? todayDate(), updatedAt: new Date() })
    .where(eq(patientMedication.id, medicationId))
    .returning();
  if (!updated) throw notFound("Medicamento");
  await audit(tx, orgId, actorUserId, "medication.discontinued", "patient_medication", medicationId, {
    patientId: current.patientId,
  });
  return updated;
}

export async function listMedications(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(patientMedication)
    .where(and(eq(patientMedication.patientId, patientId), eq(patientMedication.organizationId, orgId)))
    .orderBy(sql`"end_date" nulls first`, desc(patientMedication.createdAt));
}

// --- Anamnesis ---

export async function addAnamnesis(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  answers: Record<string, unknown>,
) {
  await requirePatient(tx, orgId, patientId);
  const diagCodes = (answers as { diagnosticoCie10?: unknown })?.diagnosticoCie10;
  if (diagCodes !== undefined) {
    if (!Array.isArray(diagCodes) || diagCodes.length > 10)
      throw validation("diagnosticoCie10 debe ser un arreglo de hasta 10 códigos");
    for (const code of diagCodes) {
      if (typeof code !== "string" || !code) throw validation("diagnosticoCie10 contiene un código inválido");
      await assertDiagnosisCode(tx, code);
    }
  }
  const [maxRow] = await tx
    .select({ version: sql<number | null>`coalesce(max("version"), 0)`.as("max_version") })
    .from(patientAnamnesis)
    .where(eq(patientAnamnesis.patientId, patientId));
  const version = (maxRow?.version ?? 0) + 1;
  const insert = async (v: number) =>
    tx
      .insert(patientAnamnesis)
      .values({ organizationId: orgId, patientId, version: v, answers, createdBy: actorUserId })
      .returning();
  try {
    const [row] = await insert(version);
    if (!row) throw new Error("No se pudo guardar la anamnesis");
    await audit(tx, orgId, actorUserId, "anamnesis.created", "patient_anamnesis", row.id, { patientId, version });
    return row;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Carrera de versión: un reintento con max+1.
    const [retry] = await tx
      .select({ version: sql<number | null>`coalesce(max("version"), 0)`.as("max_version") })
      .from(patientAnamnesis)
      .where(eq(patientAnamnesis.patientId, patientId));
    const [row] = await insert((retry?.version ?? version) + 1);
    if (!row) throw new Error("No se pudo guardar la anamnesis");
    await audit(tx, orgId, actorUserId, "anamnesis.created", "patient_anamnesis", row.id, {
      patientId,
      version: row.version,
    });
    return row;
  }
}

export async function getLatestAnamnesis(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  const [row] = await tx
    .select()
    .from(patientAnamnesis)
    .where(and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)))
    .orderBy(desc(patientAnamnesis.version))
    .limit(1);
  return row ?? null;
}

export async function listAnamnesisVersions(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select({
      id: patientAnamnesis.id,
      version: patientAnamnesis.version,
      createdAt: patientAnamnesis.createdAt,
      createdBy: patientAnamnesis.createdBy,
    })
    .from(patientAnamnesis)
    .where(and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)))
    .orderBy(desc(patientAnamnesis.version));
}

export async function getAnamnesisVersion(tx: Db, orgId: string, patientId: string, versionId: string) {
  await requirePatient(tx, orgId, patientId);
  const [row] = await tx
    .select()
    .from(patientAnamnesis)
    .where(
      and(
        eq(patientAnamnesis.id, versionId),
        eq(patientAnamnesis.patientId, patientId),
        eq(patientAnamnesis.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Anamnesis");
  return row;
}

// --- Notas de evolución ---

export async function addClinicalNote(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { note: string; diagnosisCode?: string | null; encounterId?: string },
) {
  await requirePatient(tx, orgId, patientId);
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId);
  const note = input.note?.trim() ?? "";
  if (note.length < 1 || note.length > 4000) throw validation("note debe tener 1–4000 caracteres");
  if (input.diagnosisCode) await assertDiagnosisCode(tx, input.diagnosisCode);
  const [row] = await tx
    .insert(clinicalNote)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      note,
      diagnosisCode: input.diagnosisCode ?? null,
      encounterId: input.encounterId ?? null,
      kind: "evolucion",
    })
    .returning();
  if (!row) throw new Error("No se pudo guardar la nota");
  await audit(tx, orgId, actorUserId, "note.created", "clinical_note", row.id, { patientId });
  return row;
}

export async function listClinicalNotes(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { cursor?: string; limit?: number },
) {
  await requirePatient(tx, orgId, patientId);
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
  const conditions = [eq(clinicalNote.patientId, patientId), eq(clinicalNote.organizationId, orgId)];
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) throw validation("Cursor inválido");
    const ts = new Date(decoded.ts);
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido");
    conditions.push(
      or(lt(clinicalNote.createdAt, ts), and(eq(clinicalNote.createdAt, ts), lt(clinicalNote.id, decoded.id)))!,
    );
  }
  const rows = await tx
    .select()
    .from(clinicalNote)
    .where(and(...conditions))
    .orderBy(desc(clinicalNote.createdAt), desc(clinicalNote.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  };
}

// --- Odontograma NTS 188-MINSA/DGIESP-2022 ---
//
// La validación normativa real vive en `@odentia/clinical` (fail closed:
// condición desconocida, anatomía incompatible o datos faltantes = error).
// El servicio solo añade controles de tenant/paciente/encuentro y CIE-10.

export interface AddOdontogramInput {
  toothNumber: number;
  condition: string;
  surfaces?: string[];
  details?: FindingDetails;
  note?: string | null;
  diagnosisCode?: string | null;
  encounterId?: string;
}

type OdontogramRow = typeof odontogramEntry.$inferSelect;

/** Normaliza relatedTeeth: enteros únicos ordenados incluyendo la principal. */
function normalizeRelatedTeeth(toothNumber: number, related?: unknown): number[] | null {
  if (!Array.isArray(related) || !related.length) return null;
  const set = new Set<number>([toothNumber]);
  for (const t of related) {
    if (typeof t === "number" && Number.isInteger(t)) set.add(t);
  }
  if (set.size < 2) return null;
  return [...set].sort((a, b) => a - b);
}

function rowDetails(row: OdontogramRow): FindingDetails {
  const details = row.details as FindingDetails | null | undefined;
  return { ...(details ?? {}) };
}

/** Proyección de estado de corrección sin mutar la fila original. */
function projectedStatus(row: OdontogramRow): string {
  if (row.voidedAt || row.status === "voided") return "voided";
  return row.status;
}

function isVoidedRow(row: OdontogramRow): boolean {
  return row.voidedAt != null || row.status === "voided";
}

function toFindingRecord(row: OdontogramRow) {
  return { ...row, status: projectedStatus(row), details: rowDetails(row) };
}

/** Piezas cubiertas por un hallazgo (proyección multi-pieza vía relatedTeeth). */
function coveredTeeth(record: FindingRecord): number[] {
  const related = record.details?.relatedTeeth;
  if (Array.isArray(related) && related.length > 1) return [...new Set(related)].sort((a, b) => a - b);
  return [record.toothNumber];
}

export async function addOdontogramEntries(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddOdontogramInput,
) {
  await requirePatient(tx, orgId, patientId);
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId);
  const finding: FindingInput = {
    toothNumber: input.toothNumber,
    condition: input.condition,
    surfaces: input.surfaces ?? [],
    details: input.details ?? {},
    note: input.note ?? null,
    diagnosisCode: input.diagnosisCode ?? null,
    encounterId: input.encounterId,
  };
  const errors = validateFinding(finding);
  if (errors.length) throw validation(errors.join("; "));
  if (input.diagnosisCode) await assertDiagnosisCode(tx, input.diagnosisCode);
  // Hallazgo de grupo/tramo (puente, dentadura, supernumerario): UNA sola fila
  // con relatedTeeth incluyendo la principal; se proyecta a cada participante.
  const related = normalizeRelatedTeeth(input.toothNumber, (input.details as { relatedTeeth?: unknown } | undefined)?.relatedTeeth);
  const details: FindingDetails = { ...(input.details ?? {}) };
  if (related) details.relatedTeeth = related;
  const surfaces = related ? [null] : ((input.surfaces ?? []).length ? input.surfaces! : [null]);
  const toInsert = surfaces.map((surface) => ({
    organizationId: orgId,
    patientId,
    toothNumber: input.toothNumber,
    surface,
    condition: input.condition,
    status: "recorded",
    diagnosisCode: input.diagnosisCode ?? null,
    note: input.note ?? null,
    details,
    needsReview: false,
    createdBy: actorUserId,
    encounterId: input.encounterId ?? null,
  }));
  const rows = await tx.insert(odontogramEntry).values(toInsert).returning();
  const teethTouched = related ?? [input.toothNumber];
  if (input.encounterId) {
    for (const tooth of teethTouched) {
      await tx.insert(encounterTooth).values({
        organizationId: orgId, encounterId: input.encounterId, toothNumber: tooth,
      }).onConflictDoNothing();
    }
  }
  await audit(tx, orgId, actorUserId, "odontogram.entry_added", "odontogram_entry", rows[0]?.id ?? patientId, {
    patientId,
    toothNumber: input.toothNumber,
    relatedTeeth: teethTouched,
    count: rows.length,
  });
  return rows;
}

export async function voidOdontogramEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  entryId: string,
  patientId: string,
  reason: string,
) {
  const trimmed = reason?.trim() ?? "";
  if (!patientId) throw validation("patientId es obligatorio");
  if (!trimmed || trimmed.length > 2000) throw validation("El motivo de anulación es obligatorio (1–2000 caracteres)");
  const [current] = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.organizationId, orgId)))
    .limit(1);
  if (!current || current.patientId !== patientId) throw notFound("Entrada de odontograma");
  if (current.encounterId) await requireDraftLink(tx, orgId, current.patientId, current.encounterId);
  if (isVoidedRow(current)) throw conflict("ALREADY_VOIDED", "La entrada ya está anulada");
  // Corrección auditable: solo estado de corrección; condition/surface/note
  // originales se preservan intactos.
  const [updated] = await tx
    .update(odontogramEntry)
    .set({ status: "voided", voidedAt: new Date(), voidedBy: actorUserId, voidReason: trimmed, updatedAt: new Date() })
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.status, "recorded"), sql`${odontogramEntry.voidedAt} is null`))
    .returning();
  if (!updated) throw conflict("ALREADY_VOIDED", "La entrada ya está anulada");
  await audit(tx, orgId, actorUserId, "odontogram.entry_voided", "odontogram_entry", entryId, {
    patientId: current.patientId,
    reason: trimmed,
  });
  return { ...updated, status: projectedStatus(updated) };
}

/**
 * Revisión de legado migrado: solo puede anularse con motivo (sin inventar
 * datos); el registro corregido se crea aparte con addOdontogramEntries.
 */
export async function reviewLegacyEntry(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  entryId: string,
  reason: string,
) {
  const [current] = await tx
    .select({ id: odontogramEntry.id, patientId: odontogramEntry.patientId, needsReview: odontogramEntry.needsReview })
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.organizationId, orgId)))
    .limit(1);
  if (!current || current.patientId !== patientId) throw notFound("Entrada de odontograma");
  if (!current.needsReview) throw conflict("NOT_LEGACY", "La entrada no requiere revisión de legado");
  const updated = await voidOdontogramEntry(tx, orgId, actorUserId, entryId, patientId, reason);
  await audit(tx, orgId, actorUserId, "odontogram.legacy_reviewed", "odontogram_entry", entryId, {
    patientId,
  });
  return updated;
}

export interface ToothState {
  condition: string;
  status: string;
  surfaces: string[];
  entries: string[];
}

export async function getOdontogram(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  const rows = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.patientId, patientId), eq(odontogramEntry.organizationId, orgId)))
    .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id));
  const history = rows.map((row) => ({ ...row, status: projectedStatus(row) }));
  // Activos: append-only, coexisten todas las condiciones registradas;
  // Excluye registros pendientes de revisión y correcciones vigentes.
  const candidates = rows.filter((row) => !row.needsReview && !isVoidedRow(row));
  const active = activeFindingsAsOf(candidates.map(toFindingRecord));
  const byTooth = new Map<number, FindingRecord[]>();
  for (const entry of active) {
    for (const tooth of coveredTeeth(entry)) {
      const list = byTooth.get(tooth) ?? [];
      list.push(entry);
      byTooth.set(tooth, list);
    }
  }
  const teeth: Record<string, ToothState> = {};
  for (const [tooth, entries] of byTooth) {
    const latest = entries[entries.length - 1]!;
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: [...new Set(entries.map((e) => e.surface).filter((s): s is string => !!s))].sort(),
      entries: entries.map((e) => e.id),
    };
  }
  return { teeth, history };
}

// --- Actas de odontograma (snapshot inmutable) ---

export const ASSESSMENT_PURPOSES = ["initial", "new_findings", "completion", "reentry", "legal", "personal"] as const;

export interface CreateAssessmentInput {
  purpose: string;
  specifications: string;
  observations: string;
  examinerName: string;
  registrationNumber: string;
  signature: number[][][];
}

function assertSignature(signature: unknown): asserts signature is number[][][] {
  if (!Array.isArray(signature) || !signature.length || signature.length > 50) {
    throw validation("La firma manuscrita es obligatoria (1–50 trazos capturados)");
  }
  for (const stroke of signature) {
    if (!Array.isArray(stroke) || stroke.length < 2 || stroke.length > 500) {
      throw validation("Cada trazo de la firma requiere 2–500 puntos");
    }
    for (const point of stroke) {
      if (
        !Array.isArray(point) || point.length !== 2
        || typeof point[0] !== "number" || typeof point[1] !== "number"
        || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
        || point[0] < 0 || point[0] > 100 || point[1] < 0 || point[1] > 100
      ) {
        throw validation("Firma inválida: puntos [x, y] normalizados 0–100");
      }
    }
  }
}

export async function createOdontogramAssessment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateAssessmentInput,
) {
  const patientRow = await requirePatient(tx, orgId, patientId);
  if (!(ASSESSMENT_PURPOSES as readonly string[]).includes(input.purpose)) throw validation("purpose inválido");
  const specifications = input.specifications?.trim() ?? "";
  const observations = input.observations?.trim() ?? "";
  const examinerName = input.examinerName?.trim() ?? "";
  const registrationNumber = input.registrationNumber?.trim() ?? "";
  if (specifications.length > 4000) throw validation("specifications admite hasta 4000 caracteres");
  if (observations.length > 4000) throw validation("observations admite hasta 4000 caracteres");
  if (!examinerName || examinerName.length > 200) throw validation("examinerName es obligatorio (1–200 caracteres)");
  if (!registrationNumber || registrationNumber.length > 40) throw validation("registrationNumber es obligatorio (1–40 caracteres)");
  assertSignature(input.signature);
  // Sin firma sobre revisión pendiente: primero se revisan los legados.
  const [pending] = await tx
    .select({ id: odontogramEntry.id })
    .from(odontogramEntry)
    .where(and(
      eq(odontogramEntry.organizationId, orgId),
      eq(odontogramEntry.patientId, patientId),
      eq(odontogramEntry.needsReview, true),
      sql`${odontogramEntry.voidedAt} IS NULL`,
      sql`${odontogramEntry.status} <> 'voided'`,
    ))
    .limit(1);
  if (pending) throw conflict("NEEDS_REVIEW", "Existen hallazgos pendientes de revisión; revísalos antes de firmar el acta");
  // Identidad firmada desde el servidor (nunca del body del cliente).
  const [contactRow] = await tx
    .select({ displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, patientRow.contactId), eq(contact.organizationId, orgId)))
    .limit(1);
  const patientName = contactRow?.displayName?.trim() ?? "";
  if (!patientName) throw validation("El paciente no tiene nombre registrado para firmar el acta");
  // Snapshot calculado en el servidor; nunca se acepta del cliente.
  const { history } = await getOdontogram(tx, orgId, patientId);
  const candidates = history.filter((row) => !row.needsReview && !isVoidedRow(row));
  const entries = activeFindingsAsOf(candidates.map(toFindingRecord));
  const [row] = await tx.insert(odontogramAssessment).values({
    organizationId: orgId,
    patientId,
    authorUserId: actorUserId,
    purpose: input.purpose,
    specifications,
    observations,
    examinerName,
    registrationNumber,
    patientName,
    patientNumber: patientRow.patientNumber,
    signature: input.signature,
    entries,
    standard: ODONTOGRAM_STANDARD,
  }).returning();
  if (!row) throw notFound("Acta de odontograma");
  await audit(tx, orgId, actorUserId, "odontogram.assessment_sealed", "odontogram_assessment", row.id, {
    patientId,
    purpose: input.purpose,
    entriesCount: entries.length,
  });
  return row;
}

export async function listOdontogramAssessments(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(odontogramAssessment)
    .where(and(eq(odontogramAssessment.patientId, patientId), eq(odontogramAssessment.organizationId, orgId)))
    .orderBy(desc(odontogramAssessment.createdAt), desc(odontogramAssessment.id));
}

// --- Documentos ---

export async function registerPatientDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { category: string; label: string; storageKey: string; contentType: string; sizeBytes: number; encounterId?: string; toothNumber?: number | null },
) {
  await requirePatient(tx, orgId, patientId);
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId);
  if (input.toothNumber != null && !isValidTooth(input.toothNumber)) throw validation("Pieza FDI inválida");
  if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(input.category)) throw validation("category inválida");
  const label = input.label?.trim() ?? "";
  if (!label || label.length > 200) throw validation("label debe tener 1–200 caracteres");
  if (!input.storageKey) throw validation("storageKey es obligatorio");
  const [row] = await tx
    .insert(patientDocument)
    .values({
      organizationId: orgId,
      patientId,
      category: input.category,
      label,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadedBy: actorUserId,
      encounterId: input.encounterId ?? null,
      toothNumber: input.toothNumber ?? null,
    })
    .returning();
  if (input.encounterId && input.toothNumber != null) await tx.insert(encounterTooth).values({
    organizationId: orgId, encounterId: input.encounterId, toothNumber: input.toothNumber,
  }).onConflictDoNothing();
  if (!row) throw new Error("No se pudo registrar el documento");
  await audit(tx, orgId, actorUserId, "document.uploaded", "patient_document", row.id, {
    patientId,
    category: input.category,
  });
  return row;
}

export async function listPatientDocuments(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId);
  return tx
    .select()
    .from(patientDocument)
    .where(and(eq(patientDocument.patientId, patientId), eq(patientDocument.organizationId, orgId)))
    .orderBy(desc(patientDocument.createdAt));
}

export async function getPatientDocument(tx: Db, orgId: string, patientId: string, documentId: string) {
  await requirePatient(tx, orgId, patientId);
  const [row] = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.id, documentId),
        eq(patientDocument.patientId, patientId),
        eq(patientDocument.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Documento");
  return row;
}

export async function searchCie10(tx: Db, q: string, limit = 20) {
  const like = `%${q}%`;
  return tx
    .select()
    .from(cie10Code)
    .where(sql`${cie10Code.code} ilike ${like} or ${cie10Code.description} ilike ${like}`)
    .orderBy(asc(cie10Code.code))
    .limit(Math.min(Math.max(limit, 1), 50));
}
