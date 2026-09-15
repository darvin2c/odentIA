import type { Db } from "@odentia/db";
import { contact } from "@odentia/db/schema/crm";
import { orgCounter, patient, patientAllergy, patientCondition, patientMedication } from "@odentia/db/schema/clinical";
import { auditEvent } from "@odentia/db/schema/org";
import { and, desc, eq, ilike, lt, or, sql } from "drizzle-orm";
import { decodeCursor, encodeCursor } from "./cursors.js";
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js";
import { createContact, requireContact } from "./contacts.js";

const PAGE_DEFAULT = 30;

/** Upsert atómico del correlativo de historia clínica por organización. */
export async function nextPatientNumber(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "patient", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`"org_counter"."value" + 1` },
    })
    .returning({ value: orgCounter.value });
  if (!row) throw new Error("No se pudo generar el número de historia clínica");
  return row.value;
}

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

export interface CreatePatientInput {
  contactId?: string;
  displayName?: string;
  docType?: string | null;
  docNumber?: string | null;
  birthDate?: string | null;
  sex?: string | null;
  phone?: string | null;
  email?: string | null;
  maritalStatus?: string | null;
  educationLevel?: string | null;
  occupation?: string | null;
  address?: string | null;
  origin?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  insuranceType?: string | null;
  insuranceDetail?: string | null;
  referralSource?: string | null;
  guardianContactId?: string | null;
  registeredBranchId?: string | null;
}

export type PatientRow = typeof patient.$inferSelect;

export async function requirePatient(tx: Db, orgId: string, id: string): Promise<PatientRow> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound("Paciente");
  return row;
}

export async function createPatient(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreatePatientInput,
): Promise<PatientRow> {
  let contactId = input.contactId;
  if (contactId) {
    await requireContact(tx, orgId, contactId);
  } else {
    if (!input.displayName?.trim()) throw validation("displayName es obligatorio si no se indica contactId");
    const created = await createContact(tx, orgId, { displayName: input.displayName.trim() });
    contactId = created.id;
  }
  const number = await nextPatientNumber(tx, orgId);
  try {
    const [row] = await tx
      .insert(patient)
      .values({
        organizationId: orgId,
        contactId: contactId!,
        patientNumber: number,
        docType: input.docType ?? null,
        docNumber: input.docNumber?.trim() ? input.docNumber.trim() : null,
        birthDate: input.birthDate ?? null,
        sex: input.sex ?? null,
        phone: input.phone?.trim() ? input.phone.trim() : null,
        email: input.email?.trim() ? input.email.trim() : null,
        maritalStatus: input.maritalStatus ?? null,
        educationLevel: input.educationLevel ?? null,
        occupation: input.occupation ?? null,
        address: input.address ?? null,
        origin: input.origin ?? null,
        emergencyContactName: input.emergencyContactName ?? null,
        emergencyContactPhone: input.emergencyContactPhone ?? null,
        insuranceType: input.insuranceType ?? null,
        insuranceDetail: input.insuranceDetail ?? null,
        referralSource: input.referralSource ?? null,
        guardianContactId: input.guardianContactId ?? null,
        registeredBranchId: input.registeredBranchId ?? null,
      })
      .returning();
    if (!row) throw new Error("No se pudo crear el paciente");
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.created",
      entity: "patient",
      entityId: row.id,
      metadata: { contactId: row.contactId, patientNumber: row.patientNumber },
    });
    return row;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const c = uniqueConstraintOf(e);
    if (c.includes("patient_org_contact_uidx")) throw conflict("ALREADY_PATIENT", "El contacto ya es paciente");
    if (c.includes("patient_org_doc_uidx")) throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento");
    // Fallback sin nombre de índice: distinguir por lookup.
    const [byContact] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.organizationId, orgId), eq(patient.contactId, contactId!)))
      .limit(1);
    if (byContact) throw conflict("ALREADY_PATIENT", "El contacto ya es paciente");
    throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento");
  }
}

export interface PatientListItem {
  id: string;
  patientNumber: number;
  contactId: string;
  displayName: string;
  docType: string | null;
  docNumber: string | null;
  birthDate: string | null;
  sex: string | null;
  isActive: boolean;
  createdAt: string;
}

export async function listPatients(
  tx: Db,
  orgId: string,
  input: { q?: string; cursor?: string; limit?: number },
): Promise<{ items: PatientListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100);
  const conditions = [eq(patient.organizationId, orgId)];
  if (input.q) {
    const like = `%${input.q}%`;
    conditions.push(or(ilike(contact.displayName, like), ilike(patient.docNumber, like))!);
  }
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded) throw validation("Cursor inválido");
    const ts = new Date(decoded.ts);
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido");
    conditions.push(
      or(
        lt(patient.createdAt, ts),
        and(eq(patient.createdAt, ts), lt(patient.id, decoded.id)),
      )!,
    );
  }
  const rows = await tx
    .select({ patient, displayName: contact.displayName })
    .from(patient)
    .innerJoin(contact, eq(patient.contactId, contact.id))
    .where(and(...conditions))
    .orderBy(desc(patient.createdAt), desc(patient.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const items: PatientListItem[] = page.map((r) => ({
    id: r.patient.id,
    patientNumber: r.patient.patientNumber,
    contactId: r.patient.contactId,
    displayName: r.displayName,
    docType: r.patient.docType,
    docNumber: r.patient.docNumber,
    birthDate: r.patient.birthDate,
    sex: r.patient.sex,
    isActive: r.patient.isActive,
    createdAt: r.patient.createdAt.toISOString(),
  }));
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(last.patient.createdAt.toISOString(), last.patient.id)
      : null;
  return { items, nextCursor };
}

export interface PatientFull {
  patient: PatientRow;
  displayName: string;
  guardian: { id: string; displayName: string } | null;
  activeAllergies: (typeof patientAllergy.$inferSelect)[];
  activeConditions: (typeof patientCondition.$inferSelect)[];
  currentMedications: (typeof patientMedication.$inferSelect)[];
}

export async function getPatient(tx: Db, orgId: string, id: string): Promise<PatientFull> {
  const row = await requirePatient(tx, orgId, id);
  const [contactRow] = await tx
    .select({ id: contact.id, displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.organizationId, orgId)))
    .limit(1);
  let guardian: PatientFull["guardian"] = null;
  if (row.guardianContactId) {
    const [g] = await tx
      .select({ id: contact.id, displayName: contact.displayName })
      .from(contact)
      .where(and(eq(contact.id, row.guardianContactId), eq(contact.organizationId, orgId)))
      .limit(1);
    if (g) guardian = g;
  }
  const [activeAllergies, activeConditions, currentMedications] = await Promise.all([
    tx
      .select()
      .from(patientAllergy)
      .where(
        and(
          eq(patientAllergy.patientId, id),
          eq(patientAllergy.organizationId, orgId),
          eq(patientAllergy.isActive, true),
        ),
      ),
    tx
      .select()
      .from(patientCondition)
      .where(
        and(
          eq(patientCondition.patientId, id),
          eq(patientCondition.organizationId, orgId),
          eq(patientCondition.status, "activa"),
        ),
      ),
    tx
      .select()
      .from(patientMedication)
      .where(
        and(
          eq(patientMedication.patientId, id),
          eq(patientMedication.organizationId, orgId),
          sql`"end_date" is null`,
        ),
      ),
  ]);
  return {
    patient: row,
    displayName: contactRow?.displayName ?? "",
    guardian,
    activeAllergies,
    activeConditions,
    currentMedications,
  };
}

export async function getPatientByContact(tx: Db, orgId: string, contactId: string): Promise<PatientRow | null> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.contactId, contactId), eq(patient.organizationId, orgId)))
    .limit(1);
  return row ?? null;
}

export interface UpdatePatientPatch {
  docType?: string | null;
  docNumber?: string | null;
  birthDate?: string | null;
  sex?: string | null;
  maritalStatus?: string | null;
  phone?: string | null;
  email?: string | null;
  educationLevel?: string | null;
  occupation?: string | null;
  address?: string | null;
  origin?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  insuranceType?: string | null;
  insuranceDetail?: string | null;
  referralSource?: string | null;
  guardianContactId?: string | null;
  registeredBranchId?: string | null;
  isActive?: boolean;
  /** true registra el consentimiento (fecha+autor); false se ignora. */
  dataConsent?: boolean;
}

const PATCH_FIELDS = [
  "docType",
  "docNumber",
  "birthDate",
  "sex",
  "maritalStatus",
  "phone",
  "email",
  "educationLevel",
  "occupation",
  "address",
  "origin",
  "emergencyContactName",
  "emergencyContactPhone",
  "insuranceType",
  "insuranceDetail",
  "referralSource",
  "guardianContactId",
  "registeredBranchId",
  "isActive",
] as const;

export async function updatePatient(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: UpdatePatientPatch,
): Promise<PatientRow> {
  const current = await requirePatient(tx, orgId, id);
  const set: Partial<typeof patient.$inferInsert> = { updatedAt: new Date() };
  for (const key of PATCH_FIELDS) {
    if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key] as unknown;
  }
  // Consentimiento: write-once. dataConsent:false se ignora.
  if (patch.dataConsent === true && !current.dataConsentAt) {
    set.dataConsentAt = new Date();
    set.dataConsentBy = actorUserId;
  }
  const touched = Object.keys(set).filter((k) => k !== "updatedAt");
  try {
    const [updated] = await tx
      .update(patient)
      .set(set)
      .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
      .returning();
    if (!updated) throw notFound("Paciente");
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.updated",
      entity: "patient",
      entityId: id,
      metadata: { fields: touched },
    });
    return updated;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const c = uniqueConstraintOf(e);
    if (c.includes("patient_org_doc_uidx") || !c.includes("patient_org_contact_uidx")) {
      throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento");
    }
    throw e;
  }
}

/** Registra la clave de avatar (privado S3) tras subida exitosa; audita. */
export async function setPatientAvatar(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  storageKey: string,
): Promise<{ patient: PatientRow; previousStorageKey: string | null }> {
  const [current] = await tx.select().from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId))).for("update");
  if (!current) throw notFound("Paciente");
  const [updated] = await tx
    .update(patient)
    .set({ avatarStorageKey: storageKey, updatedAt: new Date() })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .returning();
  if (!updated) throw notFound("Paciente");
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.avatar_updated",
    entity: "patient",
    entityId: patientId,
    metadata: { storageKey },
  });
  return { patient: updated, previousStorageKey: current.avatarStorageKey };
}
