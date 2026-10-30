import { RESPONSIBILITY_KINDS } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patient, patientContact, patientDocument, patientResponsibility } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, isNull, lte, gte, or } from "drizzle-orm"
import { invalidField, notFound, ServiceError } from "./errors.js"
import { endPairAccess } from "./pair-access.js"
import { patientOrganizationToday, requirePatient } from "./patients.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

export { RESPONSIBILITY_KINDS } from "@odentia/clinical"

/** `field`: el nombre de la fecha en el cuerpo, para decir el rechazo junto a ella. */
function validDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw invalidField(field, "Fecha inválida: usa AAAA-MM-DD")
  return value
}

/** `field`: el nombre del contacto en el cuerpo de la petición, para decir el rechazo junto a él. */
export async function requireLinkedActiveContact(tx: Db, orgId: string, patientId: string, contactId: string, field?: string) {
  const [row] = await tx.select({ contact, relationship: patientContact.relationship }).from(patientContact)
    .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, patientContact.organizationId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, contactId), eq(contact.isActive, true)))
  if (!row) {
    const error = notFound("Contacto activo vinculado al paciente")
    if (field) error.fields = { [field]: error.message }
    throw error
  }
  return row
}

/** El día en que cumple 18 años (AAAA-MM-DD); un 29 de febrero cumple el 1 de marzo. */
function adulthoodDay(birthDate: string): string {
  const year = Number(birthDate.slice(0, 4)) + 18
  const monthDay = birthDate.slice(5, 10)
  if (monthDay === "02-29") {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? `${year}-02-29` : `${year}-03-01`
  }
  return `${year}-${monthDay}`
}

/**
 * La edad y la mayoría de edad de un paciente, con el día de hoy en la zona
 * horaria de la clínica (no la del servidor ni UTC). Sin fecha de nacimiento
 * no se presume menor.
 */
export async function patientAge(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ today: string; birthDate: string | null; adultSince: string | null; isMinor: boolean }> {
  const [subject] = await tx.select({ birthDate: patientPerson.birthDate }).from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId))).limit(1)
  const today = await patientOrganizationToday(tx, orgId)
  const birthDate = subject?.birthDate ? String(subject.birthDate).slice(0, 10) : null
  const adultSince = birthDate ? adulthoodDay(birthDate) : null
  return { today, birthDate, adultSince, isMinor: adultSince !== null && adultSince > today }
}

/** Es menor de edad hoy, en la zona horaria de la clínica. La pantalla recibe esto del servidor. */
export async function patientIsMinor(tx: Db, orgId: string, patientId: string): Promise<boolean> {
  return (await patientAge(tx, orgId, patientId)).isMinor
}

/** Representación legal vigente hoy; si ya es mayor de edad, solo la que se dio siendo adulto. */
function currentRepresentationSql(
  orgId: string,
  patientId: string,
  age: { today: string; adultSince: string | null },
) {
  return and(eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId),
    eq(patientResponsibility.kind, "representante_legal"),
    isNull(patientResponsibility.revokedAt), lte(patientResponsibility.startsAt, age.today),
    or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, age.today)),
    // Ya es mayor de edad: la representación que tuvo de menor terminó.
    ...(age.adultSince && age.adultSince <= age.today ? [gte(patientResponsibility.startsAt, age.adultSince)] : []))
}

/**
 * Quién decide por un paciente (presupuesto, consentimientos, sus datos, su
 * portal): la propia persona si es mayor de edad, o su representante legal
 * vigente. Sin fecha de nacimiento no se presume menor. La representación de
 * un menor termina al cumplir 18: después solo cuenta la que se registró
 * siendo ya mayor de edad (la de un adulto que la necesita). Un familiar, un
 * autorizado de información o «otro» nunca deciden. La edad se cuenta con el
 * día de la clínica. `field`: el nombre del dato en el cuerpo de la petición,
 * para que la pantalla diga el rechazo junto a quien se eligió.
 */
export async function requireDecisionContact(tx: Db, orgId: string, patientId: string, contactId: string, field?: string) {
  const notAuthorized = (message: string) =>
    new ServiceError("DECISION_CONTACT_NOT_AUTHORIZED", 409, message, field ? { [field]: message } : undefined)
  const linked = await requireLinkedActiveContact(tx, orgId, patientId, contactId, field)
  const age = await patientAge(tx, orgId, patientId)
  if (linked.relationship === "self") {
    if (age.isMinor) throw notAuthorized("Es menor de edad: decide su representante legal vigente")
    return linked.contact
  }
  const [responsibility] = await tx.select({ id: patientResponsibility.id }).from(patientResponsibility)
    .where(and(currentRepresentationSql(orgId, patientId, age), eq(patientResponsibility.contactId, contactId))).for("share")
  if (!responsibility) throw notAuthorized("El contacto no es paciente ni representante legal vigente")
  return linked.contact
}

/** A quién se le puede mandar algo de un paciente. */
export interface DecisionRecipient {
  contactId: string
  displayName: string
  relation: "paciente" | "representante_legal"
  email: string | null
  phone: string | null
  /** El primero: la propia persona si es mayor de edad; si no, su representante. */
  isDefault: boolean
}

/**
 * A quién se le manda algo de un paciente: una sola regla para recetas,
 * órdenes y consentimientos, presupuestos, «Su enlace» y el portal. Es la de
 * `requireDecisionContact`: la propia persona si es mayor de edad y sus
 * representantes legales vigentes (al cumplir 18, la representación de su
 * infancia termina). Nunca un familiar, un autorizado de información ni el
 * responsable económico: son cosas de su salud y de sus decisiones.
 */
export async function listDecisionRecipients(tx: Db, orgId: string, patientId: string): Promise<DecisionRecipient[]> {
  await requirePatient(tx, orgId, patientId)
  const age = await patientAge(tx, orgId, patientId)
  const out: DecisionRecipient[] = []
  const push = (row: typeof contact.$inferSelect, relation: DecisionRecipient["relation"]) => {
    if (out.some((item) => item.contactId === row.id)) return
    out.push({ contactId: row.id, displayName: row.displayName, relation, email: row.email, phone: row.phone, isDefault: false })
  }
  if (!age.isMinor) {
    const [self] = await tx.select({ contact }).from(patientContact)
      .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)))
      .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId),
        eq(patientContact.relationship, "self"), eq(contact.isActive, true)))
      .limit(1)
    if (self) push(self.contact, "paciente")
  }
  const representatives = await tx.select({ contact }).from(patientResponsibility)
    .innerJoin(contact, and(eq(contact.id, patientResponsibility.contactId), eq(contact.organizationId, orgId)))
    .where(and(currentRepresentationSql(orgId, patientId, age), eq(contact.isActive, true)))
    .orderBy(asc(patientResponsibility.startsAt), asc(patientResponsibility.id))
  for (const row of representatives) push(row.contact, "representante_legal")
  if (out[0]) out[0].isDefault = true
  return out
}

/** Igual que `requireDecisionContact`, como sí o no: para decidir qué se muestra. */
export async function contactDecides(tx: Db, orgId: string, patientId: string, contactId: string): Promise<boolean> {
  try {
    await requireDecisionContact(tx, orgId, patientId, contactId)
    return true
  } catch (error) {
    if (error instanceof ServiceError) return false
    throw error
  }
}

export interface GrantResponsibilityInput {
  contactId: string
  kind: (typeof RESPONSIBILITY_KINDS)[number]
  startsAt: string
  endsAt?: string | null
  evidenceDocumentId?: string | null
  notes?: string | null
}

export async function grantResponsibility(tx: Db, orgId: string, actorUserId: string | null, patientId: string, input: GrantResponsibilityInput) {
  await requirePatient(tx, orgId, patientId)
  // Serializa asignaciones concurrentes con la misma persona y rol.
  const linked = await requireLinkedActiveContact(tx, orgId, patientId, input.contactId, "contactId")
  if (linked.relationship === "self" && input.kind === "representante_legal") throw invalidField("contactId", "El propio paciente no puede ser su representante legal")
  await tx.select({ id: patientContact.id }).from(patientContact).where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, linked.contact.id))).for("update")
  if (!(RESPONSIBILITY_KINDS as readonly string[]).includes(input.kind)) throw invalidField("kind", "Responsabilidad inválida")
  const startsAt = validDate(input.startsAt, "startsAt")
  const endsAt = input.endsAt ? validDate(input.endsAt, "endsAt") : null
  if (endsAt && endsAt < startsAt) throw invalidField("endsAt", "La fecha final no puede preceder a la inicial")
  if (input.evidenceDocumentId) {
    const [doc] = await tx.select({ id: patientDocument.id }).from(patientDocument).where(and(eq(patientDocument.id, input.evidenceDocumentId), eq(patientDocument.organizationId, orgId), eq(patientDocument.patientId, patientId)))
    if (!doc) {
      const error = notFound("Documento del paciente")
      error.fields = { evidenceDocumentId: error.message }
      throw error
    }
  }
  const [existing] = await tx.select({ id: patientResponsibility.id }).from(patientResponsibility).where(and(eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId), eq(patientResponsibility.contactId, input.contactId), eq(patientResponsibility.kind, input.kind), isNull(patientResponsibility.revokedAt)))
  if (existing) {
    const message = "La responsabilidad ya está asignada; revócala antes de sustituirla"
    throw new ServiceError("RESPONSIBILITY_EXISTS", 409, message, { kind: message })
  }
  const [row] = await tx.insert(patientResponsibility).values({ ...input, startsAt, endsAt, organizationId: orgId, patientId, createdBy: actorUserId }).returning()
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.responsibility_granted", entity: "patient_responsibility", entityId: row.id, metadata: { patientId, contactId: input.contactId, kind: input.kind } })
  return row
}

export async function revokeResponsibility(tx: Db, orgId: string, actorUserId: string, patientId: string, id: string, input: { reason: string }) {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw invalidField("reason", "El motivo debe tener 1–2000 caracteres")
  const where = and(eq(patientResponsibility.id, id), eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId))
  const [current] = await tx.select().from(patientResponsibility).where(where).for("update")
  if (!current) throw notFound("Responsabilidad")
  if (current.revokedAt) throw new ServiceError("RESPONSIBILITY_REVOKED", 409, "La responsabilidad ya fue revocada")
  const [row] = await tx.update(patientResponsibility).set({ revokedAt: new Date(), revokedBy: actorUserId, revokeReason: reason, updatedAt: new Date() }).where(where).returning()
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.responsibility_revoked", entity: "patient_responsibility", entityId: id, metadata: { patientId, reason } })
  // Sin la representación, su enlace y su portal de ese paciente dejan de servir.
  if (current.kind === "representante_legal") {
    await endPairAccess(tx, orgId, actorUserId, { patientId, contactId: current.contactId, reason: "Se revocó su representación legal" })
  }
  return row
}

export async function listResponsibilities(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx.select({ responsibility: patientResponsibility, contact, evidenceDocument: patientDocument }).from(patientResponsibility)
    .innerJoin(contact, and(eq(contact.id, patientResponsibility.contactId), eq(contact.organizationId, orgId)))
    .leftJoin(patientDocument, and(eq(patientDocument.id, patientResponsibility.evidenceDocumentId), eq(patientDocument.organizationId, orgId), eq(patientDocument.patientId, patientId)))
    .where(and(eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId))).orderBy(asc(patientResponsibility.startsAt), asc(patientResponsibility.id))
  // Vigente hoy, con el día de la clínica (la misma cuenta que `listDecisionRecipients`).
  const today = await patientOrganizationToday(tx, orgId)
  return rows.map(({ responsibility: r, ...rest }) => ({ ...r, ...rest, isCurrent: !r.revokedAt && r.startsAt <= today && (!r.endsAt || r.endsAt >= today) && rest.contact.isActive }))
}
