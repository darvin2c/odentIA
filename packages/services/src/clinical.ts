import type { Db } from "@odentia/db";
import {
  cie10Code,
  clinicalNote,
  odontogramEntry,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientDocument,
  patientMedication,
} from "@odentia/db/schema/clinical";
import { auditEvent } from "@odentia/db/schema/org";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";
import { requirePatient } from "./patients.js";

/** Piezas FDI válidas: adulto 11–18/21–28/31–38/41–48, temporal 51–55/61–65/71–75/81–85. */
export const VALID_FDI_TEETH: readonly number[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75,
  81, 82, 83, 84, 85,
] as const;

export const ODONTOGRAM_SURFACES = [
  "mesial",
  "distal",
  "vestibular",
  "lingual",
  "palatina",
  "oclusal",
  "incisal",
] as const;

export const ODONTOGRAM_CONDITIONS = [
  "sano",
  "caries",
  "obturacion",
  "corona",
  "ausente",
  "extraccion_indicada",
  "endodoncia",
  "implante",
  "fractura",
  "sellante",
  "protesis",
  "desgaste",
  "otro",
] as const;

export const ODONTOGRAM_STATUSES = ["registrado", "realizado", "planificado", "anulado"] as const;
export const ENTRY_STATUSES = ["registrado", "realizado", "planificado"] as const;

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
  input: { note: string; diagnosisCode?: string | null },
) {
  await requirePatient(tx, orgId, patientId);
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

// --- Odontograma ---

export interface AddOdontogramInput {
  toothNumber: number;
  condition: string;
  surfaces?: string[];
  status?: string;
  note?: string | null;
  diagnosisCode?: string | null;
}

export async function addOdontogramEntries(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddOdontogramInput,
) {
  await requirePatient(tx, orgId, patientId);
  if (!VALID_FDI_TEETH.includes(input.toothNumber)) throw validation("Pieza FDI inválida");
  if (!(ODONTOGRAM_CONDITIONS as readonly string[]).includes(input.condition)) throw validation("condition inválida");
  const status = input.status ?? "registrado";
  if (!(ENTRY_STATUSES as readonly string[]).includes(status)) throw validation("status inválido");
  const surfaces = input.surfaces ?? [];
  for (const s of surfaces) {
    if (!(ODONTOGRAM_SURFACES as readonly string[]).includes(s)) throw validation(`Superficie inválida: ${s}`);
  }
  if (input.diagnosisCode) await assertDiagnosisCode(tx, input.diagnosisCode);
  const toInsert = (surfaces.length ? surfaces : [null]).map((surface) => ({
    organizationId: orgId,
    patientId,
    toothNumber: input.toothNumber,
    surface,
    condition: input.condition,
    status,
    diagnosisCode: input.diagnosisCode ?? null,
    note: input.note ?? null,
    createdBy: actorUserId,
  }));
  const rows = await tx.insert(odontogramEntry).values(toInsert).returning();
  await audit(tx, orgId, actorUserId, "odontogram.entry_added", "odontogram_entry", rows[0]?.id ?? patientId, {
    patientId,
    toothNumber: input.toothNumber,
    count: rows.length,
  });
  return rows;
}

export async function voidOdontogramEntry(tx: Db, orgId: string, actorUserId: string, entryId: string) {
  const [current] = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.id, entryId), eq(odontogramEntry.organizationId, orgId)))
    .limit(1);
  if (!current) throw notFound("Entrada de odontograma");
  if (current.status === "anulado") throw conflict("ALREADY_VOIDED", "La entrada ya está anulada");
  const [updated] = await tx
    .update(odontogramEntry)
    .set({ status: "anulado", updatedAt: new Date() })
    .where(eq(odontogramEntry.id, entryId))
    .returning();
  if (!updated) throw notFound("Entrada de odontograma");
  await audit(tx, orgId, actorUserId, "odontogram.entry_voided", "odontogram_entry", entryId, {
    patientId: current.patientId,
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
  const history = await tx
    .select()
    .from(odontogramEntry)
    .where(and(eq(odontogramEntry.patientId, patientId), eq(odontogramEntry.organizationId, orgId)))
    .orderBy(desc(odontogramEntry.createdAt), desc(odontogramEntry.id));
  // Estado: gana la más reciente por pieza+superficie (anuladas excluidas).
  const winners = new Map<string, typeof history[number]>();
  for (const entry of [...history].reverse()) {
    if (entry.status === "anulado") continue;
    winners.set(`${entry.toothNumber}:${entry.surface ?? ""}`, entry);
  }
  const byTooth = new Map<number, typeof history[number][]>();
  for (const entry of winners.values()) {
    const list = byTooth.get(entry.toothNumber) ?? [];
    list.push(entry);
    byTooth.set(entry.toothNumber, list);
  }
  const teeth: Record<string, ToothState> = {};
  for (const [tooth, entries] of byTooth) {
    entries.sort((a, b) => +b.createdAt - +a.createdAt);
    const latest = entries[0]!;
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: entries
        .map((e) => e.surface)
        .filter((s): s is string => !!s)
        .sort(),
      entries: entries.map((e) => e.id),
    };
  }
  return { teeth, history };
}

// --- Documentos ---

export async function registerPatientDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { category: string; label: string; storageKey: string; contentType: string; sizeBytes: number },
) {
  await requirePatient(tx, orgId, patientId);
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
    })
    .returning();
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
