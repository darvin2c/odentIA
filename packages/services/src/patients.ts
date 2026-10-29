import {
  clinicalProfileFor,
  demographicsSchema,
  IDENTITY_DOC_TYPES,
  isMinor,
  KINSHIP,
  normalizePersonData,
  normalizePhone,
  registrationContactInputSchema,
  SEX_CODES,
  validateDemographics,
  type RegistrationContactInput,
} from "@odentia/clinical"
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
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { crmNote } from "@odentia/db/schema/crm-workspace"
import { user } from "@odentia/db/schema/auth"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm"
import { screenBeforePatient } from "./contact-screen.js"
import { requireContact } from "./contacts.js"
import { endPairAccess } from "./pair-access.js"
import { createPerson, findPersonByDocument, setPersonArchived } from "./people.js"
import {
  joinPatientPerson,
  PATIENT_IDENTITY_KEYS,
  patientPerson,
  patientRowColumns,
  type PatientRow,
} from "./patient-identity.js"
import { personSearchCondition } from "./person-search.js"
import { decodeCursor } from "./cursors.js"
import {
  branchNotFound,
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { findOrgCountry, NEUTRAL_TIMEZONE } from "./locale.js"

const PAGE_DEFAULT = 30

/** Upsert atómico del correlativo de historia clínica por organización. */
export async function nextPatientNumber(tx: Db, orgId: string, options: { test?: boolean } = {}): Promise<number> {
  // La ficha de una persona de prueba no gasta un número de historia (ADR 0094):
  // lleva el suyo, negativo, de otro contador.
  const key = options.test ? "patient_test" : "patient"
  const [row] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key, value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`"org_counter"."value" + 1` },
    })
    .returning({ value: orgCounter.value })
  if (!row) throw new Error("No se pudo generar el número de historia clínica")
  return options.test ? -row.value : row.value
}

/** Persona de prueba (ADR 0094): nace así y no cambia. */
export async function personIsTest(tx: Db, orgId: string, personId: string): Promise<boolean> {
  const [row] = await tx
    .select({ isTest: contact.isTest })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, personId)))
    .limit(1)
  return row?.isTest ?? false
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
  familyName?: string | null
  docCountry?: string | null
  nationality?: string | null
  birthCountry?: string | null
  birthPlace?: string | null
  addressCity?: string | null
  addressDistrict?: string | null
  addressRegion?: string | null
  addressPostalCode?: string | null
  addressCountry?: string | null
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
  insuranceScheme?: string | null
  referralKind?: string | null
  referralSource?: string | null
  registeredBranchId?: string | null
}

export type { PatientRow } from "./patient-identity.js"

export type RegistrationProvenance = Pick<typeof patientRegistration.$inferInsert,
  "submissionId" | "payloadHash" | "entryPoint" | "respondent" | "contextContactId" |
  "conversationId" | "linkId" | "formVersion" | "answers" | "privacyNotice">

/** Fecha de referencia del tenant, calculada exclusivamente en servidor. */
export async function patientOrganizationToday(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx.select({ timezone: orgProfile.timezone }).from(orgProfile).where(eq(orgProfile.organizationId, orgId)).limit(1)
  return new Intl.DateTimeFormat("en-CA", { timeZone: profile?.timezone ?? NEUTRAL_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

/** La ficha con la identidad de su persona (ADR 0044). */
export async function requirePatient(tx: Db, orgId: string, id: string): Promise<PatientRow> {
  const [row] = await tx
    .select(patientRowColumns())
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
    .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return row
}

/**
 * Filiación lista para guardar: vacíos como null, teléfonos en E.164 (un
 * número nacional se completa con el país de la clínica) y lo que depende del
 * país (`normalizePersonData`: documento con su país emisor, dirección con su
 * país, seguro con su tipo general). Recibe la filiación completa (lo guardado
 * más lo que cambia): el país emisor depende del tipo aunque solo cambie el número.
 */
function normalizeDemographics<T extends object>(data: T, countryCode: string | null): T {
  const out = { ...data } as Record<string, unknown>
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && value.trim() === "" && key !== "displayName") out[key] = null
  }
  for (const key of ["phone", "emergencyContactPhone"]) {
    if (typeof out[key] === "string") out[key] = normalizePhone(out[key] as string, countryCode)
  }
  return normalizePersonData(out, clinicalProfileFor(countryCode)) as T
}

/** Separa de la filiación lo que es identidad (va a la persona) de lo que es de la ficha. */
function splitIdentity(data: Record<string, unknown>): { identity: Record<string, unknown>; record: Record<string, unknown> } {
  const identity: Record<string, unknown> = {}
  const record: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if ((PATIENT_IDENTITY_KEYS as readonly string[]).includes(key)) identity[key] = value
    else record[key] = value
  }
  return { identity, record }
}

type IdentityInput = {
  displayName: string
  givenNames?: string | null
  familyName?: string | null
  docType?: string | null
  docNumber?: string | null
  docCountry?: string | null
  birthDate?: string | null
  sex?: string | null
  phone?: string | null
  email?: string | null
}

/**
 * Una persona que ya existía pasa a ser la de una ficha (su vínculo propio al
 * crearla, la que ya tenía el documento o la que sustituye a una provisional):
 * manda lo que trae la ficha (nombre y documento que verificó el equipo) y se
 * completa con lo que solo la persona conocía. Un teléfono o correo distinto
 * de la persona no se pierde: queda en sus notas.
 *
 * `onlyFill` es lo que escribe alguien desde fuera (el registro en línea con
 * el enlace de su conversación): nunca reemplaza un dato que la persona ya
 * tenía, solo completa los vacíos, y lo distinto queda en sus notas para que
 * recepción lo revise. El nombre visible solo se cambia si la persona aún no
 * tenía identidad registrada (ni nombres ni documento: la creó un canal).
 */
async function adoptIdentity(
  tx: Db,
  orgId: string,
  personId: string,
  identity: IdentityInput,
  options: { onlyFill?: boolean } = {},
): Promise<void> {
  const [current] = await tx.select().from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, personId))).for("update")
  if (!current) throw notFound("Contacto")
  const withDocument = Boolean(identity.docNumber)
  const otherPhone = !!identity.phone && !!current.phone && identity.phone !== current.phone
  const otherEmail = !!identity.email && !!current.email && identity.email.toLowerCase() !== current.email.toLowerCase()
  if (options.onlyFill) {
    const told: string[] = []
    if (otherPhone) told.push(`teléfono ${identity.phone}`)
    if (otherEmail) told.push(`correo ${identity.email}`)
    if (identity.docNumber && current.docNumber && identity.docNumber !== current.docNumber) told.push(`documento ${identity.docNumber}`)
    if (identity.birthDate && current.birthDate && identity.birthDate !== current.birthDate) told.push(`fecha de nacimiento ${identity.birthDate}`)
    const provisional = !current.givenNames && !current.docNumber
    if (!provisional && identity.displayName && identity.displayName !== current.displayName) told.push(`nombre ${identity.displayName}`)
    const takesDocument = !current.docNumber && withDocument
    await tx
      .update(contact)
      .set({
        displayName: provisional ? identity.displayName : current.displayName,
        givenNames: current.givenNames ?? identity.givenNames ?? null,
        familyName: current.familyName ?? identity.familyName ?? null,
        docType: takesDocument ? (identity.docType ?? null) : current.docType,
        docNumber: takesDocument ? (identity.docNumber ?? null) : current.docNumber,
        docCountry: takesDocument ? (identity.docCountry ?? null) : current.docCountry,
        birthDate: current.birthDate ?? identity.birthDate ?? null,
        sex: current.sex ?? identity.sex ?? null,
        phone: current.phone ?? identity.phone ?? null,
        email: current.email ?? identity.email ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, personId)))
    if (told.length) {
      await tx.insert(crmNote).values({
        organizationId: orgId,
        contactId: personId,
        body: `En el registro en línea escribió otros datos, que no se guardaron: ${told.join(", ")}. Revisa cuáles valen.`,
      })
    }
    return
  }
  const kept: string[] = []
  if (otherPhone) kept.push(`Teléfono anterior del contacto: ${current.phone}`)
  if (otherEmail) kept.push(`Correo anterior del contacto: ${current.email}`)
  await tx
    .update(contact)
    .set({
      displayName: identity.displayName,
      givenNames: identity.givenNames ?? current.givenNames,
      familyName: identity.familyName ?? current.familyName,
      docType: withDocument ? (identity.docType ?? null) : current.docType,
      docNumber: withDocument ? (identity.docNumber ?? null) : current.docNumber,
      docCountry: withDocument ? (identity.docCountry ?? null) : current.docCountry,
      birthDate: identity.birthDate ?? current.birthDate,
      sex: identity.sex ?? current.sex,
      phone: identity.phone ?? current.phone,
      email: identity.email ?? current.email,
      updatedAt: new Date(),
    })
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, personId)))
  if (kept.length) await tx.insert(crmNote).values({ organizationId: orgId, contactId: personId, body: kept.join("\n") })
}

/**
 * Lo que queda para recepción cuando un alta desde fuera (registro en línea,
 * enlace de reserva) escribe el documento de una persona que ya está en la
 * clínica: no se adopta ni se cambia nada de ella (ADR 0001: un dato que
 * escribe el propio interesado no verifica identidad).
 */
export interface RegistrationHold {
  /** La persona que ya tenía ese documento. */
  ownerId: string
  ownerName: string
  /** Su ficha, si ya es paciente. */
  ownerPatientId: string | null
  /** Lo que escribió quien se registró, para comparar. */
  declared: { displayName: string; phone: string | null; email: string | null }
  /** Por qué se parece: el mismo documento o el mismo celular (nunca solo el nombre). */
  match: "documento" | "celular"
  /**
   * Todas sus respuestas, si vino del registro en línea: recepción decide con
   * ellas si es la misma persona («¿Es la misma persona?»).
   */
  answers?: unknown
}

/** Texto neutro para quien se registra: no confirma que el documento exista. */
export const REGISTRATION_NOT_COMPLETED_TEXT = "No pudimos completar el registro. Comunícate con recepción."

/**
 * El alta desde fuera no se completó porque el documento ya es de otra
 * persona. Lleva lo que debe quedar para recepción: la ruta lo deja con
 * `leaveRegistrationHold` en otra transacción (esta se revierte entera) y
 * responde el texto neutro.
 */
export class RegistrationHeld extends ServiceError {
  declare readonly hold: RegistrationHold
  constructor(hold: RegistrationHold) {
    super("REGISTRATION_NOT_COMPLETED", 409, REGISTRATION_NOT_COMPLETED_TEXT)
    // No enumerable: si algo serializa el error, no sale de quién era el documento.
    Object.defineProperty(this, "hold", { value: hold, enumerable: false })
  }
}

/**
 * Alta de un paciente: la identidad se escribe en su persona (ADR 0044) y la
 * ficha guarda lo clínico y administrativo. La persona es la que se indica
 * como propia; si no, la que ya tiene su documento (identificador fuerte;
 * nunca el teléfono) y, si no hay, una nueva (`createPerson`).
 */
export async function createPatient(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  input: CreatePatientInput,
  provenance?: RegistrationProvenance,
): Promise<PatientRow> {
  if (!provenance && !actorUserId) throw validation("El alta interna requiere operador")
  const { contacts = [], registeredBranchId, ...demographics } = input
  const countryCode = await findOrgCountry(tx, orgId)
  const errors = validateDemographics(demographics, await patientOrganizationToday(tx, orgId), countryCode)
  if (Object.keys(errors).length) throw validation(Object.values(errors)[0]!)
  const {
    emergencyContactName,
    emergencyContactPhone,
    emergencyContactRelationship,
    ...clean
  } = normalizeDemographics(demographicsSchema.parse(demographics), countryCode)
  if (registeredBranchId) await assertTenantBranch(tx, orgId, registeredBranchId)
  const links = contacts.map(c => registrationContactInputSchema.parse(c)).sort((a, b) => a.contactId.localeCompare(b.contactId))
  if (new Set(links.map(c => c.contactId)).size !== links.length) throw validation("No repitas un contacto")
  if (links.filter(c => c.isPreferred).length > 1 || links.filter(c => c.relationship === "self").length > 1) throw validation("Solo puede haber un contacto propio y un preferente")
  for (const link of links) {
    const [row] = await tx.select().from(contact).where(and(eq(contact.id, link.contactId), eq(contact.organizationId, orgId))).for("update")
    if (!row) throw notFound("Contacto")
    if (!row.isActive) throw conflict("CONTACT_ARCHIVED", "Reactiva el contacto antes de vincularlo")
  }
  const { identity: rawIdentity, record } = splitIdentity(clean as Record<string, unknown>)
  const identity: IdentityInput = {
    ...(rawIdentity as IdentityInput),
    docType: (rawIdentity.docType as string | null | undefined) || null,
    docNumber: (rawIdentity.docNumber as string | null | undefined) || null,
    birthDate: (rawIdentity.birthDate as string | null | undefined) || null,
    sex: (rawIdentity.sex as string | null | undefined) || null,
  }
  const selfLink = links.find((link) => link.relationship === "self")
  const others = links.filter((link) => link.relationship !== "self")
  // Desde fuera (sin una persona del equipo: registro en línea, enlace de
  // reserva) nunca se adopta ni se cambia a quien ya tiene ese documento,
  // sea o no paciente: queda para recepción.
  const fromOutside = actorUserId === null
  if (fromOutside) {
    const owner = await findPersonByDocument(tx, orgId, identity)
    if (owner && owner !== selfLink?.contactId) {
      const [row] = await tx
        .select({ displayName: contact.displayName, patientId: patient.id })
        .from(contact)
        .leftJoin(patient, and(eq(patient.organizationId, contact.organizationId), eq(patient.personId, contact.id)))
        .where(and(eq(contact.organizationId, orgId), eq(contact.id, owner)))
        .limit(1)
      throw new RegistrationHeld({
        ownerId: owner,
        ownerName: row?.displayName ?? "otra persona",
        ownerPatientId: row?.patientId ?? null,
        declared: { displayName: identity.displayName, phone: identity.phone ?? null, email: identity.email ?? null },
        match: "documento",
      })
    }
  }
  // El documento con su país: si ya es de otra ficha se dice de quién.
  await assertDocumentFree(tx, orgId, identity, { patientsOnly: true })
  try {
    // Una persona sin ficha con ese documento es la misma persona (ADR 0001),
    // pero solo cuando registra el equipo: desde fuera ya se cortó arriba.
    const documentOwner = await findPersonByDocument(tx, orgId, identity)
    if (documentOwner && selfLink && documentOwner !== selfLink.contactId) {
      const [owner] = await tx.select({ displayName: contact.displayName }).from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, documentOwner)))
      throw duplicateDocument(identity.docType, owner?.displayName)
    }
    const existing = selfLink?.contactId ?? documentOwner
    let personId: string
    if (existing) {
      const [already] = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.organizationId, orgId), eq(patient.personId, existing))).limit(1)
      if (already) throw conflict("ALREADY_PATIENT", "El contacto ya tiene una ficha propia")
      // Un paciente no está en Spam ni bloqueado (ADR 0054).
      await screenBeforePatient(tx, orgId, existing, actorUserId)
      // Desde fuera solo puede ser su propio contacto (el de su conversación): se completa, no se reemplaza.
      await adoptIdentity(tx, orgId, existing, identity, { onlyFill: fromOutside })
      personId = existing
    } else {
      personId = (await createPerson(tx, orgId, { userId: actorUserId }, identity)).id
    }
    const [row] = await tx.insert(patient).values({
      ...(record as Partial<typeof patient.$inferInsert>),
      organizationId: orgId, personId, patientNumber: await nextPatientNumber(tx, orgId, { test: await personIsTest(tx, orgId, personId) }),
      registeredBranchId: registeredBranchId || null,
    }).returning({ id: patient.id, patientNumber: patient.patientNumber })
    if (!row) throw new Error("No se pudo crear el paciente")
    // El vínculo propio lo crea la base desde `person_id`; aquí se le pone lo que se indicó.
    await tx
      .update(patientContact)
      .set({
        isPreferred: selfLink ? selfLink.isPreferred : !others.some((link) => link.isPreferred),
        relationshipDetail: selfLink?.relationshipDetail ?? null,
        createdBy: actorUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, row.id), eq(patientContact.relationship, "self")))
    if (others.length) await tx.insert(patientContact).values(others.map(link => ({ ...link, organizationId: orgId, patientId: row.id, createdBy: actorUserId })))
    // El contacto de emergencia declarado es una persona vinculada con la marca (decisión 25).
    await declareEmergencyContact(tx, orgId, actorUserId, row.id, {
      name: emergencyContactName,
      phone: emergencyContactPhone,
      kinship: emergencyContactRelationship,
    })
    await tx.insert(patientRegistration).values({
      ...(provenance ?? {
        entryPoint: "platform",
        respondent: "staff",
        answers: {
          demographics: { ...clean, emergencyContactName, emergencyContactPhone, emergencyContactRelationship },
          respondent: "staff",
          privacyAccepted: false,
        },
      }),
      organizationId: orgId, patientId: row.id, actorUserId,
    })
    await tx.insert(auditEvent).values({
      organizationId: orgId, actorUserId, action: "patient.created", entity: "patient", entityId: row.id,
      metadata: { patientNumber: row.patientNumber, contactIds: links.map(c => c.contactId) },
    })
    return requirePatient(tx, orgId, row.id)
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    const constraint = uniqueConstraintOf(e)
    if (constraint.includes("patient_contact_self_") || constraint.includes("patient_org_person_uidx"))
      throw conflict("ALREADY_PATIENT", "El contacto ya tiene una ficha propia")
    if (constraint.includes("contact_org_doc_uidx")) throw duplicateDocument(identity.docType)
    throw e
  }
}

/** Los parentescos de HL7 RoleCode que no son familia: el vínculo queda como «otro». */
const NOT_FAMILY_KINSHIP = new Set(["FRND", "NBOR"])

/**
 * Lo que alguien declara como contacto de emergencia (el registro, «Tus
 * datos») se vuelve una persona vinculada con la marca «Contacto de
 * emergencia» (decisión 25): se crea con la operación de personas
 * (`createPerson`) y se vincula a la ficha. Nunca se busca por su teléfono
 * para unirla con otra persona (ADR 0027). Si la persona marcada ya es la que
 * se declara (mismo nombre), queda como está; si es otra, la marca pasa a la
 * nueva y la anterior sigue vinculada.
 */
export async function declareEmergencyContact(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  input: { name?: string | null; phone?: string | null; kinship?: string | null },
): Promise<string | null> {
  const name = input.name?.trim().replace(/\s+/g, " ") || null
  const phone = input.phone?.trim() || null
  if (!name && !phone) return null
  const kinship = input.kinship && (KINSHIP as readonly string[]).includes(input.kinship) ? input.kinship : null
  const marked = await tx
    .select({ contactId: contact.id, displayName: contact.displayName })
    .from(patientContact)
    .innerJoin(contact, and(eq(contact.organizationId, orgId), eq(contact.id, patientContact.contactId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.isEmergency, true)))
  const same = name ? marked.find((row) => row.displayName.trim().toLowerCase() === name.toLowerCase()) : undefined
  if (same) return same.contactId
  const created = await createPerson(tx, orgId, { userId: actorUserId }, { displayName: name ?? phone, phone })
  await tx
    .update(patientContact)
    .set({ isEmergency: false, updatedAt: new Date() })
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.isEmergency, true)))
  await tx.insert(patientContact).values({
    organizationId: orgId,
    patientId,
    contactId: created.id,
    relationship: kinship && !NOT_FAMILY_KINSHIP.has(kinship) ? "family" : "other",
    kinship,
    isPreferred: false,
    isEmergency: true,
    createdBy: actorUserId,
  })
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.contact_set",
    entity: "patient",
    entityId: patientId,
    metadata: { contactId: created.id, relationship: kinship ? "family" : "other", isEmergency: true },
  })
  return created.id
}

/** Ese documento ya es de otra persona: nunca se unen solas. */
function duplicateDocument(docType: string | null | undefined, ownerName?: string): ServiceError {
  const label = docType === "DNI" ? "Ese DNI" : "Ese documento"
  return conflict(
    "DUPLICATE_DOCUMENT",
    ownerName ? `${label} ya está en la página de ${ownerName}` : `${label} ya es de otra persona`,
  )
}

/**
 * Antes de guardar un documento se mira si ya es de otra persona, para decir
 * de quién («Ese DNI ya está en la página de Lucía Paredes»): la pantalla
 * ofrece abrirla y nunca se unen solas. La unicidad de la base sigue siendo
 * la garantía (documento con su país emisor). En el alta solo choca con otra
 * ficha (`patientsOnly`): una persona sin ficha con ese documento es la misma
 * persona y la base la toma como propia (persona única, ADR 0001).
 */
export async function assertDocumentFree(
  tx: Db,
  orgId: string,
  doc: { docType?: string | null; docNumber?: string | null; docCountry?: string | null },
  options: { exceptContactId?: string | null; patientsOnly?: boolean } = {},
): Promise<void> {
  if (!doc.docNumber) return
  // El documento vive en la persona (ADR 0044): en el alta solo choca si esa persona ya es paciente.
  const [owner] = await tx
    .select({ displayName: contact.displayName })
    .from(contact)
    .where(
      and(
        eq(contact.organizationId, orgId),
        eq(contact.docNumber, doc.docNumber),
        doc.docType ? eq(contact.docType, doc.docType) : isNull(contact.docType),
        doc.docCountry ? eq(contact.docCountry, doc.docCountry) : isNull(contact.docCountry),
        ...(options.exceptContactId ? [sql`${contact.id} <> ${options.exceptContactId}`] : []),
        ...(options.patientsOnly
          ? [sql`exists (select 1 from patient p where p.organization_id = ${contact.organizationId} and p.person_id = ${contact.id})`]
          : []),
      ),
    )
    .limit(1)
  if (owner) throw duplicateDocument(doc.docType, owner.displayName)
}

/** Persona del paciente (`person_id`), o null si la ficha no existe. */
export async function patientPersonId(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [row] = await tx.select({ personId: patient.personId }).from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId))).limit(1)
  return row?.personId ?? null
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
    !(SEX_CODES as readonly string[]).includes(input.sex)
  ) {
    throw validation("Sexo inválido")
  }
  if (
    input.docType != null &&
    input.docType !== "" &&
    !(IDENTITY_DOC_TYPES as readonly string[]).includes(input.docType)
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
  // El mismo buscador que la lista de personas: el teléfono, por sus dígitos.
  if (q)
    conditions.push(
      personSearchCondition(q, {
        displayName: contact.displayName,
        docNumber: contact.docNumber,
        email: contact.email,
        phone: contact.phone,
        contactId: contact.id,
      }),
    )
  if (input.isActive !== undefined) conditions.push(eq(contact.isActive, input.isActive))
  // Una historia bloqueada no sale en ninguna lista (ADR 0080), ni una de prueba (ADR 0094).
  conditions.push(isNull(contact.recordLockedAt), eq(contact.isTest, false))
  if (input.sex) conditions.push(eq(contact.sex, input.sex))
  if (input.docType) conditions.push(eq(contact.docType, input.docType))
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
      patient: patientRowColumns(),
      displayName: contact.displayName,
      cursorTimestamp: sql<string>`${patient.createdAt}::text`,
    })
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
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
  contacts: { contactId: string; displayName: string; phone: string | null; email: string | null; isActive: boolean; relationship: RegistrationContactInput["relationship"]; relationshipDetail: string | null; kinship: string | null; isPreferred: boolean; isEmergency: boolean }[]
  registration: (Pick<typeof patientRegistration.$inferSelect, "entryPoint" | "respondent" | "createdAt" | "contextContactId" | "conversationId" | "formVersion" | "answers" | "privacyNotice"> & { actor: { id: string; name: string } | null }) | null
  activeAllergies: (typeof patientAllergy.$inferSelect)[]
  activeConditions: (typeof patientCondition.$inferSelect)[]
  currentMedications: (typeof patientMedication.$inferSelect)[]
  /**
   * Es menor de edad hoy, con el día de la clínica: la pantalla no calcula la
   * edad por su cuenta para decidir quién firma o quién decide.
   */
  isMinor: boolean
}

/** Menor de edad hoy, con el día de la clínica (la misma cuenta que `patientAge`). */
export async function birthDateIsMinor(tx: Db, orgId: string, birthDate: string | null): Promise<boolean> {
  if (!birthDate) return false
  return isMinor(String(birthDate).slice(0, 10), await patientOrganizationToday(tx, orgId))
}

export async function getPatient(tx: Db, orgId: string, id: string): Promise<PatientFull> {
  const row = await requirePatient(tx, orgId, id)
  const contacts = await tx.select({
    contactId: contact.id, displayName: contact.displayName, phone: contact.phone, email: contact.email, isActive: contact.isActive,
    relationship: patientContact.relationship, relationshipDetail: patientContact.relationshipDetail, kinship: patientContact.kinship, isPreferred: patientContact.isPreferred,
    isEmergency: patientContact.isEmergency,
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
    isMinor: await birthDateIsMinor(tx, orgId, row.birthDate),
  }
}

export async function listPatientsByContact(tx: Db, orgId: string, contactId: string) {
  await requireContact(tx, orgId, contactId)
  return tx.select({
    id: patient.id, patientNumber: patient.patientNumber, displayName: patientPerson.displayName, isActive: patientPerson.isActive,
    relationship: patientContact.relationship, relationshipDetail: patientContact.relationshipDetail, kinship: patientContact.kinship, isPreferred: patientContact.isPreferred,
    isEmergency: patientContact.isEmergency,
  }).from(patientContact).innerJoin(patient, and(eq(patient.id, patientContact.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    // Ni el agente ni la página de quien la acompaña ven una historia bloqueada (ADR 0080).
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.contactId, contactId), isNull(patientPerson.recordLockedAt)))
    .orderBy(asc(patientPerson.displayName), asc(patient.id))
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
    const [already] = await tx.select({ id: patient.id }).from(patient).where(and(eq(patient.organizationId, orgId), eq(patient.personId, link.contactId))).limit(1)
    if (already) throw conflict("ALREADY_PATIENT", "El contacto o paciente ya tiene una relación propia")
    // La ficha pasa a la persona real (la base mueve su vínculo propio), la
    // provisional se elimina —nada más la referencia— y la persona real recibe
    // la identidad que tenía la ficha.
    const [previous] = await tx.select().from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, currentPerson))).for("update")
    await tx.update(patient).set({ personId: link.contactId, updatedAt: new Date() }).where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    await tx.delete(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, currentPerson)))
    if (previous) await adoptIdentity(tx, orgId, link.contactId, previous)
    await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.person_replaced", entity: "patient", entityId: patientId, metadata: { fromContactId: currentPerson, toContactId: link.contactId } })
  }
  if (link.isEmergency && link.relationship === "self")
    throw validation("La propia persona no es su contacto de emergencia: marca a alguien vinculado")
  const [before] = await tx.select({ relationship: patientContact.relationship }).from(patientContact)
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, link.contactId)))
  try {
    if (link.isPreferred) await tx.update(patientContact).set({ isPreferred: false, updatedAt: new Date() }).where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.isPreferred, true)))
    await tx.insert(patientContact).values({ ...link, organizationId: orgId, patientId, createdBy: actorUserId })
      .onConflictDoUpdate({
        target: [patientContact.organizationId, patientContact.patientId, patientContact.contactId],
        set: {
          relationship: link.relationship, relationshipDetail: link.relationshipDetail ?? null, kinship: link.kinship ?? null, isPreferred: link.isPreferred,
          // Sin indicar, la marca de contacto de emergencia queda como estaba.
          ...(link.isEmergency === undefined ? {} : { isEmergency: link.isEmergency }),
          updatedAt: new Date(),
        },
      })
    await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.contact_set", entity: "patient", entityId: patientId, metadata: { contactId: link.contactId, relationship: link.relationship, isPreferred: link.isPreferred, ...(link.isEmergency === undefined ? {} : { isEmergency: link.isEmergency }) } })
  } catch (error) {
    if (isUniqueViolation(error) && uniqueConstraintOf(error).includes("patient_contact_self_")) throw conflict("ALREADY_PATIENT", "El contacto o paciente ya tiene una relación propia")
    if (isUniqueViolation(error) && uniqueConstraintOf(error).includes("contact_org_doc_uidx")) throw conflict("DUPLICATE_DOCUMENT", "Ya existe otra persona con el documento del paciente")
    throw error
  }
  // Cambió lo que es para el paciente: lo que tenía con el vínculo anterior deja de servir.
  if (before && before.relationship !== link.relationship) {
    await endPairAccess(tx, orgId, actorUserId, { patientId, contactId: link.contactId, reason: "Cambió su vínculo con el paciente" })
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
  // Desvinculada, su enlace y su portal de ese paciente dejan de servir.
  if (deleted.length) await endPairAccess(tx, orgId, actorUserId, { patientId, contactId, reason: "Se desvinculó del paciente" })
}

export async function findPatientDuplicates(tx: Db, orgId: string, input: { displayName?: string; birthDate?: string; docType?: string; docNumber?: string; docCountry?: string; phone?: string }) {
  const name = input.displayName?.trim().replace(/\s+/g, " ").toLowerCase()
  const phone = input.phone?.replace(/\D/g, "")
  // El documento se compara junto con su país emisor (el del tipo o el de la clínica).
  const docType = input.docType?.trim()
  const docNumber = input.docNumber?.trim()
  const docCountry = docType && docNumber
    ? normalizePersonData({ docType: docType as never, docNumber, docCountry: input.docCountry ?? null }, clinicalProfileFor(await findOrgCountry(tx, orgId))).docCountry
    : null
  const document = docType && docNumber
    ? and(eq(contact.docType, docType), eq(contact.docNumber, docNumber), docCountry ? eq(contact.docCountry, docCountry) : isNull(contact.docCountry))! : sql`false`
  const nameAndDate = name && input.birthDate
    ? and(sql`lower(regexp_replace(btrim(${contact.displayName}), '\\s+', ' ', 'g')) = ${name}`, eq(contact.birthDate, input.birthDate))! : sql`false`
  const phoneMatch = phone ? sql`regexp_replace(${contact.phone}, '[^0-9]', '', 'g') = ${phone}` : sql`false`
  const rank = sql<number>`case when ${document} then 1 when ${nameAndDate} then 2 else 3 end`
  const rows = await tx.select({ id: patient.id, patientNumber: patient.patientNumber, displayName: contact.displayName, isActive: contact.isActive, rank })
    .from(patient).innerJoin(contact, joinPatientPerson()).where(and(eq(patient.organizationId, orgId), or(document, nameAndDate, phoneMatch)))
    .orderBy(rank, asc(patient.id)).limit(10)
  return rows.map(({ rank: priority, ...row }) => ({ ...row, reason: priority === 1 ? "document" as const : priority === 2 ? "name_birthDate" as const : "phone" as const }))
}

export interface UpdatePatientPatch {
  displayName?: string
  givenNames?: string | null
  familyName?: string | null
  docCountry?: string | null
  nationality?: string | null
  birthCountry?: string | null
  birthPlace?: string | null
  addressCity?: string | null
  addressDistrict?: string | null
  addressRegion?: string | null
  addressPostalCode?: string | null
  addressCountry?: string | null
  addressReference?: string | null
  emergencyContactRelationship?: string | null
  insurerName?: string | null
  affiliationNumber?: string | null
  /** Guardar los datos de la persona confirma su nombre separado. */
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
  insuranceScheme?: string | null
  referralKind?: string | null
  referralSource?: string | null
  registeredBranchId?: string | null
  isActive?: boolean
}

async function assertTenantBranch(tx: Db, orgId: string, branchId: string): Promise<void> {
  const [row] = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
    .limit(1)
  if (!row) throw branchNotFound()
}
const PATCH_FIELDS = [
  "displayName",
  "givenNames",
  "familyName",
  "docCountry",
  "nationality",
  "birthCountry",
  "birthPlace",
  "addressCity",
  "addressDistrict",
  "addressRegion",
  "addressPostalCode",
  "addressCountry",
  "addressReference",
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
  "insuranceType",
  "insuranceScheme",
  "referralKind",
  "referralSource",
  "registeredBranchId",
] as const

export async function updatePatient(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  id: string,
  patch: UpdatePatientPatch,
): Promise<PatientRow> {
  // Archivar es de la persona entera (`setPersonArchived`): la ficha no se
  // archiva sola. Va antes que el resto para respetar su orden de bloqueo.
  if (patch.isActive !== undefined) {
    const { isActive, ...rest } = patch
    const owner = await patientPersonId(tx, orgId, id)
    if (!owner) throw notFound("Paciente")
    await setPersonArchived(tx, orgId, { userId: actorUserId }, owner, !isActive)
    patch = rest
    if (Object.keys(rest).length === 0) return requirePatient(tx, orgId, id)
  }
  // Mismo orden de bloqueo en todas las escrituras: persona y después ficha.
  const personId = await patientPersonId(tx, orgId, id)
  if (!personId) throw notFound("Paciente")
  await tx.select({ id: contact.id }).from(contact).where(and(eq(contact.organizationId, orgId), eq(contact.id, personId))).for("update")
  const current = await requirePatient(tx, orgId, id)
  const { registeredBranchId: _branch, isActive: _active, identityConfirmed: _confirmed, ...demographicPatch } = patch
  const demographics = Object.fromEntries(Object.keys(demographicsSchema.shape).map(key => [key, current[key as keyof PatientRow]]))
  const countryCode = await findOrgCountry(tx, orgId)
  // Lo guardado que no cambia no se vuelve a juzgar por el país de la clínica.
  const errors = validateDemographics({ ...demographics, ...demographicPatch }, await patientOrganizationToday(tx, orgId), countryCode, demographics)
  if (Object.keys(errors).length) throw validation(Object.values(errors)[0]!)
  if (patch.registeredBranchId !== undefined && patch.registeredBranchId !== null) {
    await assertTenantBranch(tx, orgId, patch.registeredBranchId)
  }
  if (patch.displayName !== undefined) patch = { ...patch, displayName: patch.displayName.trim() }
  // Lo que depende del país se calcula sobre la filiación completa y se guarda
  // solo si cambia (el país emisor cuando cambia el documento, el tipo general
  // cuando cambia el régimen del seguro, el país de la dirección); «Cómo nos
  // conoció» deja su texto solo en «Otro».
  const merged = normalizeDemographics({ ...demographics, ...demographicPatch }, countryCode) as Record<string, unknown>
  const derived: Record<string, unknown> = {}
  for (const key of Object.keys(demographicPatch)) derived[key] = merged[key]
  for (const key of ["docCountry", "insuranceType", "addressCountry", "referralKind", "referralSource"])
    if ((merged[key] ?? null) !== (demographics[key] ?? null)) derived[key] = merged[key]
  patch = { ...patch, ...derived }
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
  const set: Record<string, unknown> = {}
  for (const key of PATCH_FIELDS) {
    if (patch[key] !== undefined) set[key] = patch[key] as unknown
  }
  if (patch.identityConfirmed === true) set.identityNeedsReview = false
  const touched = Object.keys(set)
  if (touched.some((key) => key === "docType" || key === "docNumber" || key === "docCountry"))
    await assertDocumentFree(tx, orgId, { docType: merged.docType as string, docNumber: merged.docNumber as string, docCountry: merged.docCountry as string }, { exceptContactId: personId })
  // La identidad se escribe en la persona; lo clínico y administrativo, en la ficha (ADR 0044).
  const { identity: personSet, record: recordSet } = splitIdentity(set)
  try {
    if (Object.keys(personSet).length)
      await tx
        .update(contact)
        .set({ ...(personSet as Partial<typeof contact.$inferInsert>), updatedAt: new Date() })
        .where(and(eq(contact.organizationId, orgId), eq(contact.id, personId)))
    const [changed] = await tx
      .update(patient)
      .set({ ...(recordSet as Partial<typeof patient.$inferInsert>), updatedAt: new Date() })
      .where(and(eq(patient.id, id), eq(patient.organizationId, orgId)))
      .returning({ id: patient.id })
    if (!changed) throw notFound("Paciente")
    const updated = await requirePatient(tx, orgId, id)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.updated",
      entity: "patient",
      entityId: id,
      metadata: { fields: touched },
    })
    // El contacto de emergencia no es un dato de la ficha: es una persona vinculada (decisión 25).
    if (patch.emergencyContactName !== undefined || patch.emergencyContactPhone !== undefined) {
      await declareEmergencyContact(tx, orgId, actorUserId, id, {
        name: (merged.emergencyContactName as string | null | undefined) ?? null,
        phone: (merged.emergencyContactPhone as string | null | undefined) ?? null,
        kinship: (merged.emergencyContactRelationship as string | null | undefined) ?? null,
      })
    }
    return updated
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    const c = uniqueConstraintOf(e)
    if (c.includes("contact_org_doc_uidx")) {
      throw duplicateDocument(merged.docType as string)
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
    .select({ avatarStorageKey: patient.avatarStorageKey })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  if (!current) throw notFound("Paciente")
  await tx
    .update(patient)
    .set({ avatarStorageKey: storageKey, updatedAt: new Date() })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  const updated = await requirePatient(tx, orgId, patientId)
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
