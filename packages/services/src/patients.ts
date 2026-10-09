import { demographicsSchema, isMinor, normalizePhone, registrationContactInputSchema, validateDemographics, type RegistrationContactInput } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  orgCounter,
  patient,
  patientAllergy,
  patientCondition,
  patientMedication,
  patientContact,
  patientRegistration,
  patientResponsibility,
  ubigeo,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm"
import { requireContact } from "./contacts.js"
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
  displayName: string
  givenNames?: string | null
  paternalSurname?: string | null
  maternalSurname?: string | null
  docCountry?: string | null
  nationality?: string | null
  birthPlaceUbigeo?: string | null
  addressUbigeo?: string | null
  addressReference?: string | null
  emergencyContactRelationship?: string | null
  insurerName?: string | null
  affiliationNumber?: string | null
  contacts?: RegistrationContactInput[]
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
  registeredBranchId?: string | null
}

export type PatientRow = typeof patient.$inferSelect

export type RegistrationProvenance = Pick<typeof patientRegistration.$inferInsert,
  "submissionId" | "payloadHash" | "entryPoint" | "respondent" | "contextContactId" |
  "conversationId" | "linkId" | "formVersion" | "answers" | "privacyNotice">

/** Fecha de referencia del tenant, calculada exclusivamente en servidor. */
export async function patientOrganizationToday(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx.select({ timezone: orgProfile.timezone }).from(orgProfile).where(eq(orgProfile.organizationId, orgId)).limit(1)
  return new Intl.DateTimeFormat("en-CA", { timeZone: profile?.timezone ?? "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

export async function requirePatient(tx: Db, orgId: string, id: string): Promise<PatientRow> {
  const [row] = await tx
    .select()
    .from(patient)
    .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return row
}

/**
 * Filiación lista para guardar: vacíos como null, países en mayúsculas,
 * teléfonos en E.164 y ubigeos que existan en el catálogo del INEI.
 */
async function normalizeDemographics<T extends object>(tx: Db, data: T): Promise<T> {
  const out = { ...data } as Record<string, unknown>
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && value.trim() === "" && key !== "displayName") out[key] = null
  }
  for (const key of ["docCountry", "nationality"]) {
    if (typeof out[key] === "string") out[key] = (out[key] as string).toUpperCase()
  }
  for (const key of ["phone", "emergencyContactPhone"]) {
    if (typeof out[key] === "string") out[key] = normalizePhone(out[key] as string)
  }
  for (const key of ["birthPlaceUbigeo", "addressUbigeo"]) {
    const code = out[key]
    if (typeof code !== "string") continue
    const [known] = await tx.select({ code: ubigeo.code }).from(ubigeo).where(eq(ubigeo.code, code)).limit(1)
    if (!known) throw validation(`Ubigeo inexistente: ${code}`)
  }
  return out as T
}

export async function createPatient(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: CreatePatientInput,
  provenance?: RegistrationProvenance,
): Promise<PatientRow> {
  if (!provenance && !actorUserId) throw validation("El alta interna requiere operador")
  const { contacts = [], registeredBranchId, ...demographics } = input
  const errors = validateDemographics(demographics, await patientOrganizationToday(tx, orgId))
  if (Object.keys(errors).length) throw validation(Object.values(errors)[0]!)
  const clean = await normalizeDemographics(tx, demographicsSchema.parse(demographics))
  if (registeredBranchId) await assertTenantBranch(tx, orgId, registeredBranchId)
  const links = contacts.map(c => registrationContactInputSchema.parse(c)).sort((a, b) => a.contactId.localeCompare(b.contactId))
  if (new Set(links.map(c => c.contactId)).size !== links.length) throw validation("No repitas un contacto")
  if (links.filter(c => c.isPreferred).length > 1 || links.filter(c => c.relationship === "self").length > 1) throw validation("Solo puede haber un contacto propio y un preferente")
  for (const link of links) {
    const [row] = await tx.select().from(contact).where(and(eq(contact.id, link.contactId), eq(contact.organizationId, orgId))).for("update")
    if (!row) throw notFound("Contacto")
    if (!row.isActive) throw conflict("CONTACT_ARCHIVED", "Reactiva el contacto antes de vincularlo")
  }
  try {
    const [row] = await tx.insert(patient).values({
      ...clean,
      docType: clean.docType || null, docNumber: clean.docNumber || null,
      birthDate: clean.birthDate || null, sex: clean.sex || null,
      organizationId: orgId, patientNumber: await nextPatientNumber(tx, orgId),
      registeredBranchId: registeredBranchId || null,
    }).returning()
    if (!row) throw new Error("No se pudo crear el paciente")
    if (links.length) await tx.insert(patientContact).values(links.map(link => ({ ...link, organizationId: orgId, patientId: row.id, createdBy: actorUserId })))
    await tx.insert(patientRegistration).values({
      ...(provenance ?? { entryPoint: "platform", respondent: "staff", answers: { demographics: clean, respondent: "staff", privacyAccepted: false } }),
      organizationId: orgId, patientId: row.id, actorUserId,
    })
    await tx.insert(auditEvent).values({
      organizationId: orgId, actorUserId, action: "patient.created", entity: "patient", entityId: row.id,
      metadata: { patientNumber: row.patientNumber, contactIds: links.map(c => c.contactId) },
    })
    return row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    const constraint = uniqueConstraintOf(e)
    if (constraint.includes("patient_contact_self_")) throw conflict("ALREADY_PATIENT", "El contacto ya tiene una ficha propia")
    if (constraint.includes("patient_org_doc_uidx")) throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento")
    if (constraint.includes("contact_org_doc_uidx")) throw conflict("DUPLICATE_DOCUMENT", "Ya existe otra persona con ese documento")
    throw e
  }
}

/** Persona propia del paciente (su vínculo `self`), o null antes de confirmar el alta. */
export async function patientPersonId(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [row] = await tx.select({ contactId: patientContact.contactId }).from(patientContact)
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.relationship, "self"))).limit(1)
  return row?.contactId ?? null
}

/**
 * Una persona creada solo para dar identidad a la ficha, sin canales ni
 * actividad propia, puede sustituirse por el contacto real de la misma persona.
 */
async function isPlaceholderPerson(tx: Db, orgId: string, contactId: string, patientId: string): Promise<boolean> {
  // La definición vive en la base (`is_placeholder_person`), que también la aplica
  // a escrituras directas: nada referencia a la persona fuera de esta ficha.
  const [row] = await tx.execute<{ placeholder: boolean }>(
    sql`select is_placeholder_person(${orgId}, ${contactId}::uuid, ${patientId}::uuid) as placeholder`,
  )
  return row?.placeholder === true
}

export const PATIENT_LIST_SORTS = [
  "name",
  "-name",
  "created",
  "-created",
  "number",
  "-number",
] as const

export interface PatientListItem {
  id: string
  patientNumber: number
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
        ilike(patient.displayName, like),
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
        or(sql`(${patient.displayName}, ${patient.id}) ${cmp} (${decoded.key}, ${decoded.id})`)!,
      )
    }
  }
  const order =
    sortField === "name" && !descending
      ? [asc(patient.displayName), asc(patient.id)]
      : sortField === "name"
        ? [desc(patient.displayName), desc(patient.id)]
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
      displayName: patient.displayName,
      cursorTimestamp: sql<string>`${patient.createdAt}::text`,
    })
    .from(patient)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const items: PatientListItem[] = page.map((r) => ({
    id: r.patient.id,
    patientNumber: r.patient.patientNumber,
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
  contacts: { contactId: string; displayName: string; phone: string | null; email: string | null; isActive: boolean; relationship: RegistrationContactInput["relationship"]; relationshipDetail: string | null; isPreferred: boolean }[]
  registration: (Pick<typeof patientRegistration.$inferSelect, "entryPoint" | "respondent" | "createdAt" | "contextContactId" | "conversationId" | "formVersion" | "answers" | "privacyNotice"> & { actor: { id: string; name: string } | null }) | null
  activeAllergies: (typeof patientAllergy.$inferSelect)[]
  activeConditions: (typeof patientCondition.$inferSelect)[]
  currentMedications: (typeof patientMedication.$inferSelect)[]
}

export async function getPatient(tx: Db, orgId: string, id: string): Promise<PatientFull> {
  const row = await requirePatient(tx, orgId, id)
  const contacts = await tx.select({
    contactId: contact.id, displayName: contact.displayName, phone: contact.phone, email: contact.email, isActive: contact.isActive,
    relationship: patientContact.relationship, relationshipDetail: patientContact.relationshipDetail, isPreferred: patientContact.isPreferred,
  }).from(patientContact).innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, id)))
    .orderBy(desc(patientContact.isPreferred), asc(contact.displayName), asc(contact.id))
  const [registration] = await tx.select({
    entryPoint: patientRegistration.entryPoint, respondent: patientRegistration.respondent, createdAt: patientRegistration.createdAt,
    actor: { id: user.id, name: user.name }, contextContactId: patientRegistration.contextContactId,
    conversationId: patientRegistration.conversationId, formVersion: patientRegistration.formVersion,
    answers: patientRegistration.answers, privacyNotice: patientRegistration.privacyNotice,
  }).from(patientRegistration).leftJoin(user, eq(user.id, patientRegistration.actorUserId))
    .where(and(eq(patientRegistration.organizationId, orgId), eq(patientRegistration.patientId, id))).limit(1)
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
    contacts,
    registration: registration ?? null,
    activeAllergies,
    activeConditions,
    currentMedications,
  }
}

export async function listPatientsByContact(tx: Db, orgId: string, contactId: string) {
  await requireContact(tx, orgId, contactId)
  return tx.select({
    id: patient.id, patientNumber: patient.patientNumber, displayName: patient.displayName, isActive: patient.isActive,
    relationship: patientContact.relationship, relationshipDetail: patientContact.relationshipDetail, isPreferred: patientContact.isPreferred,
  }).from(patientContact).innerJoin(patient, and(eq(patient.id, patientContact.patientId), eq(patient.organizationId, orgId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.contactId, contactId)))
    .orderBy(asc(patient.displayName), asc(patient.id))
}

export async function setPatientContact(tx: Db, orgId: string, actorUserId: string, patientId: string, input: RegistrationContactInput): Promise<void> {
  const parsed = registrationContactInputSchema.safeParse(input)
  if (!parsed.success) throw validation("Relación inválida")
  const link = parsed.data
  const [person] = await tx.select().from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, link.contactId))).for("update")
  if (!person) throw notFound("Contacto")
  if (!person.isActive) throw conflict("CONTACT_ARCHIVED", "Reactiva el contacto antes de vincularlo")
  const [record] = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId))).for("update")
  if (!record) throw notFound("Paciente")
  const currentPerson = await patientPersonId(tx, orgId, patientId)
  // La propia persona no se degrada a otro vínculo: es la identidad de la ficha.
  if (currentPerson === link.contactId && link.relationship !== "self")
    throw conflict("PATIENT_PERSON_REQUIRED", "Esta es la propia persona del paciente; su vínculo no se puede cambiar")
  // Identificar al paciente con un contacto real sustituye a la persona creada
  // solo para la ficha; si esta ya tiene actividad, no se fusiona en silencio.
  if (link.relationship === "self" && currentPerson && currentPerson !== link.contactId) {
    if (!(await isPlaceholderPerson(tx, orgId, currentPerson, patientId)))
      throw conflict("PATIENT_PERSON_IN_USE", "El paciente ya está identificado con una persona que tiene canales o actividad. Reasigna el canal desde Contactos en lugar de vincular otra persona.")
    // La sustitución la hace la base al insertar el nuevo vínculo (trigger
    // `patient_contact_person_adopt`): aquí solo se valida y se deja traza.
    await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.person_replaced", entity: "patient", entityId: patientId, metadata: { fromContactId: currentPerson, toContactId: link.contactId } })
  }
  try {
    if (link.isPreferred) await tx.update(patientContact).set({ isPreferred: false, updatedAt: new Date() }).where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.isPreferred, true)))
    await tx.insert(patientContact).values({ ...link, organizationId: orgId, patientId, createdBy: actorUserId })
      .onConflictDoUpdate({
        target: [patientContact.organizationId, patientContact.patientId, patientContact.contactId],
        set: { relationship: link.relationship, relationshipDetail: link.relationshipDetail ?? null, isPreferred: link.isPreferred, updatedAt: new Date() },
      })
    await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.contact_set", entity: "patient", entityId: patientId, metadata: { contactId: link.contactId, relationship: link.relationship, isPreferred: link.isPreferred } })
  } catch (error) {
    if (isUniqueViolation(error) && uniqueConstraintOf(error).includes("patient_contact_self_")) throw conflict("ALREADY_PATIENT", "El contacto o paciente ya tiene una relación propia")
    if (isUniqueViolation(error) && uniqueConstraintOf(error).includes("contact_org_doc_uidx")) throw conflict("DUPLICATE_DOCUMENT", "Ya existe otra persona con el documento del paciente")
    throw error
  }
}

export async function removePatientContact(tx: Db, orgId: string, actorUserId: string, patientId: string, contactId: string): Promise<void> {
  const [person] = await tx.select({ id: contact.id }).from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId))).for("update")
  if (!person) throw notFound("Contacto")
  const [record] = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId))).for("update")
  if (!record) throw notFound("Paciente")
  if ((await patientPersonId(tx, orgId, patientId)) === contactId)
    throw conflict("PATIENT_PERSON_REQUIRED", "Esta es la propia persona del paciente y no se puede desvincular")
  const deleted = await tx.delete(patientContact).where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, contactId))).returning({ id: patientContact.id })
  if (deleted.length) await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.contact_removed", entity: "patient", entityId: patientId, metadata: { contactId } })
}

export async function findPatientDuplicates(tx: Db, orgId: string, input: { displayName?: string; birthDate?: string; docType?: string; docNumber?: string; phone?: string }) {
  const name = input.displayName?.trim().replace(/\s+/g, " ").toLowerCase()
  const phone = input.phone?.replace(/\D/g, "")
  const document = input.docType?.trim() && input.docNumber?.trim()
    ? and(eq(patient.docType, input.docType.trim()), eq(patient.docNumber, input.docNumber.trim()))! : sql`false`
  const nameAndDate = name && input.birthDate
    ? and(sql`lower(regexp_replace(btrim(${patient.displayName}), '\\s+', ' ', 'g')) = ${name}`, eq(patient.birthDate, input.birthDate))! : sql`false`
  const phoneMatch = phone ? sql`regexp_replace(${patient.phone}, '[^0-9]', '', 'g') = ${phone}` : sql`false`
  const rank = sql<number>`case when ${document} then 1 when ${nameAndDate} then 2 else 3 end`
  const rows = await tx.select({ id: patient.id, patientNumber: patient.patientNumber, displayName: patient.displayName, isActive: patient.isActive, rank })
    .from(patient).where(and(eq(patient.organizationId, orgId), or(document, nameAndDate, phoneMatch)))
    .orderBy(rank, asc(patient.id)).limit(10)
  return rows.map(({ rank: priority, ...row }) => ({ ...row, reason: priority === 1 ? "document" as const : priority === 2 ? "name_birthDate" as const : "phone" as const }))
}

export interface UpdatePatientPatch {
  displayName?: string
  givenNames?: string | null
  paternalSurname?: string | null
  maternalSurname?: string | null
  docCountry?: string | null
  nationality?: string | null
  birthPlaceUbigeo?: string | null
  addressUbigeo?: string | null
  addressReference?: string | null
  emergencyContactRelationship?: string | null
  insurerName?: string | null
  affiliationNumber?: string | null
  /** Recepción confirma el nombre separado tras la migración. */
  identityConfirmed?: boolean
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
  registeredBranchId?: string | null
  isActive?: boolean
  /** true registra el consentimiento (fecha+autor); false se ignora. */
  dataConsent?: boolean
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
  "displayName",
  "givenNames",
  "paternalSurname",
  "maternalSurname",
  "docCountry",
  "nationality",
  "birthPlaceUbigeo",
  "addressUbigeo",
  "addressReference",
  "emergencyContactRelationship",
  "insurerName",
  "affiliationNumber",
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
  // Mismo orden de bloqueo que la conciliación de identidad: persona y después ficha.
  const personId = await patientPersonId(tx, orgId, id)
  if (personId) await tx.select({ id: contact.id }).from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, personId))).for("update")
  const current = await requirePatient(tx, orgId, id)
  const { registeredBranchId: _branch, isActive: _active, dataConsent: _consent, identityConfirmed: _confirmed, ...demographicPatch } = patch
  const demographics = Object.fromEntries(Object.keys(demographicsSchema.shape).map(key => [key, current[key as keyof PatientRow]]))
  const errors = validateDemographics({ ...demographics, ...demographicPatch }, await patientOrganizationToday(tx, orgId))
  if (Object.keys(errors).length) throw validation(Object.values(errors)[0]!)
  if (patch.registeredBranchId !== undefined && patch.registeredBranchId !== null) {
    await assertTenantBranch(tx, orgId, patch.registeredBranchId)
  }
  if (patch.displayName !== undefined) patch = { ...patch, displayName: patch.displayName.trim() }
  patch = await normalizeDemographics(tx, patch)
  // Un paciente que pasa a ser menor necesita a su representante legal vigente.
  if (patch.birthDate && patch.birthDate !== current.birthDate) {
    const today = await patientOrganizationToday(tx, orgId)
    if (isMinor(patch.birthDate, today)) {
      const [representative] = await tx
        .select({ id: patientResponsibility.id })
        .from(patientResponsibility)
        .where(
          and(
            eq(patientResponsibility.organizationId, orgId),
            eq(patientResponsibility.patientId, id),
            eq(patientResponsibility.kind, "representante_legal"),
            isNull(patientResponsibility.revokedAt),
            lte(patientResponsibility.startsAt, today),
            or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
          ),
        )
        .limit(1)
      if (!representative)
        throw conflict(
          "REPRESENTATIVE_REQUIRED",
          "Con esa fecha es menor de edad: registra primero a su representante legal",
        )
    }
  }
  const set: Partial<typeof patient.$inferInsert> = { updatedAt: new Date() }
  for (const key of PATCH_FIELDS) {
    if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key] as unknown
  }
  if (patch.identityConfirmed === true) set.identityNeedsReview = false
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
    if (c.includes("patient_org_doc_uidx")) {
      throw conflict("DUPLICATE_DOCUMENT", "Ya existe un paciente con ese documento")
    }
    if (c.includes("contact_org_doc_uidx")) {
      throw conflict("DUPLICATE_DOCUMENT", "Ya existe otra persona con ese documento")
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
