import type { Db } from "@odentia/db"
import {
  orgCounter,
  patient,
  patientAllergy,
  patientCondition,
  patientMedication,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm"
import { createContact, requireContact, updateContact } from "./contacts.js"
import { decodeCursor } from "./cursors.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"

const PAGE_DEFAULT = 30
const PATIENT_SEXES = ["M", "F"] as const
const PATIENT_DOC_TYPES = ["DNI", "CE", "PASAPORTE", "OTRO"] as const

/** Upsert atómico del correlativo de historia clínica por organización. */
export async function nextPatientNumber(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "patient", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`"org_counter"."value" + 1` },
    })
    .returning({ value: orgCounter.value })
  if (!row) throw new Error("No se pudo generar el número de historia clínica")
  return row.value
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function uniqueConstraintOf(error: unknown): string {
  const chain = [error, (error as { cause?: unknown })?.cause]
  for (const e of chain) {
    const r = e as Record<string, unknown> | null | undefined
    const found = r?.constraint_name ?? r?.constraint ?? r?.detail
    if (found) return String(found)
  }
  return String((error as Error)?.message ?? "")
}

export interface CreatePatientInput {
  contactId?: string
  displayName?: string
  docType?: string | null
  docNumber?: string | null
  birthDate?: string | null
  sex?: string | null
  phone?: string | null
  email?: string | null
  maritalStatus?: string | null
  educationLevel?: string | null
  occupation?: string | null
  address?: string | null
  origin?: string | null
  emergencyContactName?: string | null
  emergencyContactPhone?: string | null
  insuranceType?: string | null
  insuranceDetail?: string | null
  referralSource?: string | null
  guardianContactId?: string | null
  registeredBranchId?: string | null
}

export type PatientRow = typeof patient.$inferSelect

export async function requirePatient(tx: Db, orgId: string, id: string): Promise<PatientRow> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return row
}

export async function createPatient(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreatePatientInput,
): Promise<PatientRow> {
  let contactId = input.contactId
  if (contactId) {
    await requireContact(tx, orgId, contactId)
  } else {
    if (!input.displayName?.trim())
      throw validation("displayName es obligatorio si no se indica contactId")
    const created = await createContact(tx, orgId, { displayName: input.displayName.trim() })
    contactId = created.id
  }
  if (input.guardianContactId)
    await assertTenantContact(tx, orgId, input.guardianContactId, "Contacto tutor")
  if (input.registeredBranchId) await assertTenantBranch(tx, orgId, input.registeredBranchId)
  assertDocNumber(input.docType, input.docNumber?.trim() ? input.docNumber.trim() : null)
  const number = await nextPatientNumber(tx, orgId)
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
      .returning()
    if (!row) throw new Error("No se pudo crear el paciente")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.created",
      entity: "patient",
      entityId: row.id,
      metadata: { contactId: row.contactId, patientNumber: row.patientNumber },
    })
    return row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    const c = uniqueConstraintOf(e)
    if (c.includes("patient_org_contact_uidx"))
      throw conflict("ALREADY_PATIENT", "El contacto ya es paciente")
    if (c.includes("patient_org_doc_uidx"))
      throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento")
    // Fallback sin nombre de índice: distinguir por lookup.
    const [byContact] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.organizationId, orgId), eq(patient.contactId, contactId!)))
      .limit(1)
    if (byContact) throw conflict("ALREADY_PATIENT", "El contacto ya es paciente")
    throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento")
  }
}

export const PATIENT_LIST_SORTS = [
  "name",
  "-name",
  "created",
  "-created",
  "number",
  "-number",
] as const
export type PatientListSort = (typeof PATIENT_LIST_SORTS)[number]

export interface PatientListItem {
  id: string
  patientNumber: number
  contactId: string
  displayName: string
  docType: string | null
  docNumber: string | null
  phone: string | null
  birthDate: string | null
  sex: string | null
  isActive: boolean
  createdAt: string
}

export interface PatientListInput {
  q?: string
  cursor?: string
  limit?: number
  isActive?: boolean
  sex?: string
  docType?: string
  sort?: string
}

/** Huella de filtros+orden: el cursor solo es válido con los mismos parámetros. */
function listingFingerprint(
  input: Required<Pick<PatientListInput, "q" | "sort">> &
    Pick<PatientListInput, "isActive" | "sex" | "docType">,
): string {
  return JSON.stringify({
    q: input.q ?? "",
    isActive: input.isActive ?? null,
    sex: input.sex ?? "",
    docType: input.docType ?? "",
    sort: input.sort,
  })
}

function encodeListingCursor(key: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ ts: key, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeListingCursor(cursor: string): { key: string; id: string; f: string } | null {
  const base = decodeCursor(cursor)
  if (!base) return null
  try {
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
    if (!raw || typeof raw !== "object" || !("f" in raw)) return null
    const f: unknown = raw.f
    if (typeof f !== "string") return null
    return { key: base.ts, id: base.id, f }
  } catch {
    return null
  }
}

export async function listPatients(
  tx: Db,
  orgId: string,
  input: PatientListInput,
): Promise<{ items: PatientListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  const requestedSort = input.sort == null || input.sort === "" ? "-created" : input.sort
  const sort = PATIENT_LIST_SORTS.find((candidate) => candidate === requestedSort)
  if (!sort) throw validation("Orden inválido")
  const descending = sort.startsWith("-")
  const sortField = descending ? sort.slice(1) : sort
  if (
    input.sex != null &&
    input.sex !== "" &&
    !(PATIENT_SEXES as readonly string[]).includes(input.sex)
  ) {
    throw validation("Sexo inválido")
  }
  if (
    input.docType != null &&
    input.docType !== "" &&
    !(PATIENT_DOC_TYPES as readonly string[]).includes(input.docType)
  ) {
    throw validation("Tipo de documento inválido")
  }
  const q = input.q?.trim() ? input.q.trim() : ""
  const fingerprint = listingFingerprint({
    q,
    isActive: input.isActive,
    sex: input.sex,
    docType: input.docType,
    sort,
  })
  const conditions = [eq(patient.organizationId, orgId)]
  if (q) {
    const like = `%${q}%`
    conditions.push(
      or(
        ilike(contact.displayName, like),
        ilike(patient.docNumber, like),
        ilike(patient.phone, like),
        ilike(patient.email, like),
      )!,
    )
  }
  if (input.isActive !== undefined) conditions.push(eq(patient.isActive, input.isActive))
  if (input.sex) conditions.push(eq(patient.sex, input.sex))
  if (input.docType) conditions.push(eq(patient.docType, input.docType))
  if (input.cursor) {
    const decoded = decodeListingCursor(input.cursor)
    if (!decoded || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint)
      throw validation("El cursor no corresponde a los filtros u orden actuales")
    const cmp = descending ? sql`<` : sql`>`
    if (sortField === "created") {
      if (Number.isNaN(Date.parse(decoded.key))) throw validation("Cursor inválido")
      // Conservar microsegundos de PostgreSQL; Date truncaría el cursor.
      conditions.push(
        sql`(${patient.createdAt}, ${patient.id}) ${cmp} (${decoded.key}::timestamptz, ${decoded.id}::uuid)`,
      )
    } else if (sortField === "number") {
      const num = Number(decoded.key)
      if (!Number.isInteger(num)) throw validation("Cursor inválido")
      conditions.push(
        or(
          sql`${patient.patientNumber} ${cmp} ${num}`,
          and(eq(patient.patientNumber, num), sql`${patient.id} ${cmp} ${decoded.id}`),
        )!,
      )
    } else {
      if (!decoded.key) throw validation("Cursor inválido")
      conditions.push(
        or(sql`(${contact.displayName}, ${patient.id}) ${cmp} (${decoded.key}, ${decoded.id})`)!,
      )
    }
  }
  const order =
    sortField === "name" && !descending
      ? [asc(contact.displayName), asc(patient.id)]
      : sortField === "name"
        ? [desc(contact.displayName), desc(patient.id)]
        : sortField === "created" && !descending
          ? [asc(patient.createdAt), asc(patient.id)]
          : sortField === "number" && !descending
            ? [asc(patient.patientNumber), asc(patient.id)]
            : sortField === "number"
              ? [desc(patient.patientNumber), desc(patient.id)]
              : [desc(patient.createdAt), desc(patient.id)]
  const rows = await tx
    .select({
      patient,
      displayName: contact.displayName,
      cursorTimestamp: sql<string>`${patient.createdAt}::text`,
    })
    .from(patient)
    .innerJoin(contact, eq(patient.contactId, contact.id))
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const items: PatientListItem[] = page.map((r) => ({
    id: r.patient.id,
    patientNumber: r.patient.patientNumber,
    contactId: r.patient.contactId,
    displayName: r.displayName,
    docType: r.patient.docType,
    docNumber: r.patient.docNumber,
    phone: r.patient.phone,
    birthDate: r.patient.birthDate,
    sex: r.patient.sex,
    isActive: r.patient.isActive,
    createdAt: r.patient.createdAt.toISOString(),
  }))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeListingCursor(
          sortField === "number"
            ? String(last.patient.patientNumber)
            : sortField === "name"
              ? last.displayName
              : last.cursorTimestamp,
          last.patient.id,
          fingerprint,
        )
      : null
  return { items, nextCursor }
}

export interface PatientFull {
  patient: PatientRow
  displayName: string
  guardian: { id: string; displayName: string } | null
  activeAllergies: (typeof patientAllergy.$inferSelect)[]
  activeConditions: (typeof patientCondition.$inferSelect)[]
  currentMedications: (typeof patientMedication.$inferSelect)[]
}

export async function getPatient(tx: Db, orgId: string, id: string): Promise<PatientFull> {
  const row = await requirePatient(tx, orgId, id)
  const [contactRow] = await tx
    .select({ id: contact.id, displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, row.contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  let guardian: PatientFull["guardian"] = null
  if (row.guardianContactId) {
    const [g] = await tx
      .select({ id: contact.id, displayName: contact.displayName })
      .from(contact)
      .where(and(eq(contact.id, row.guardianContactId), eq(contact.organizationId, orgId)))
      .limit(1)
    if (g) guardian = g
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
  ])
  return {
    patient: row,
    displayName: contactRow?.displayName ?? "",
    guardian,
    activeAllergies,
    activeConditions,
    currentMedications,
  }
}

export async function getPatientByContact(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<PatientRow | null> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.contactId, contactId), eq(patient.organizationId, orgId)))
    .limit(1)
  return row ?? null
}

export interface UpdatePatientPatch {
  displayName?: string
  docType?: string | null
  docNumber?: string | null
  birthDate?: string | null
  sex?: string | null
  maritalStatus?: string | null
  phone?: string | null
  email?: string | null
  educationLevel?: string | null
  occupation?: string | null
  address?: string | null
  origin?: string | null
  emergencyContactName?: string | null
  emergencyContactPhone?: string | null
  insuranceType?: string | null
  insuranceDetail?: string | null
  referralSource?: string | null
  guardianContactId?: string | null
  registeredBranchId?: string | null
  isActive?: boolean
  /** true registra el consentimiento (fecha+autor); false se ignora. */
  dataConsent?: boolean
}
/**
 * Regla documental vigente por tipo: solo el DNI exige formato exacto (8
 * dígitos). Ninguna regla peruana se aplica a pasaporte u otros tipos.
 */
function assertDocNumber(
  docType: string | null | undefined,
  docNumber: string | null | undefined,
): void {
  if (
    docType === "DNI" &&
    docNumber != null &&
    docNumber !== "" &&
    !/^\d{8}$/.test(docNumber.trim())
  ) {
    throw validation("El DNI tiene exactamente 8 dígitos")
  }
}

async function assertTenantContact(
  tx: Db,
  orgId: string,
  contactId: string,
  name: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound(name)
}

async function assertTenantBranch(tx: Db, orgId: string, branchId: string): Promise<void> {
  const [row] = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Sucursal")
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
] as const

export async function updatePatient(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  patch: UpdatePatientPatch,
): Promise<PatientRow> {
  const current = await requirePatient(tx, orgId, id)
  if (patch.displayName !== undefined) {
    const displayName = patch.displayName.trim()
    if (!displayName || displayName.length > 200)
      throw validation("displayName debe tener 1–200 caracteres")
    // Misma transacción: el nombre vive en el contacto, sin crear otra identidad
    // ni alterar el teléfono compartido del CRM.
    await updateContact(tx, orgId, current.contactId, { displayName })
  }
  if (patch.guardianContactId !== undefined && patch.guardianContactId !== null) {
    await assertTenantContact(tx, orgId, patch.guardianContactId, "Contacto tutor")
  }
  if (patch.registeredBranchId !== undefined && patch.registeredBranchId !== null) {
    await assertTenantBranch(tx, orgId, patch.registeredBranchId)
  }
  assertDocNumber(
    patch.docType !== undefined ? patch.docType : current.docType,
    patch.docNumber !== undefined ? patch.docNumber : current.docNumber,
  )
  const set: Partial<typeof patient.$inferInsert> = { updatedAt: new Date() }
  for (const key of PATCH_FIELDS) {
    if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key] as unknown
  }
  // Consentimiento: write-once. dataConsent:false se ignora.
  if (patch.dataConsent === true && !current.dataConsentAt) {
    set.dataConsentAt = new Date()
    set.dataConsentBy = actorUserId
  }
  const touched = Object.keys(set).filter((k) => k !== "updatedAt")
  try {
    const [updated] = await tx
      .update(patient)
      .set(set)
      .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
      .returning()
    if (!updated) throw notFound("Paciente")
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.updated",
      entity: "patient",
      entityId: id,
      metadata: { fields: touched },
    })
    return updated
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    const c = uniqueConstraintOf(e)
    if (c.includes("patient_org_doc_uidx") || !c.includes("patient_org_contact_uidx")) {
      throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento")
    }
    throw e
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
  const [current] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  if (!current) throw notFound("Paciente")
  const [updated] = await tx
    .update(patient)
    .set({ avatarStorageKey: storageKey, updatedAt: new Date() })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Paciente")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.avatar_updated",
    entity: "patient",
    entityId: patientId,
    metadata: { storageKey },
  })
  return { patient: updated, previousStorageKey: current.avatarStorageKey }
}
