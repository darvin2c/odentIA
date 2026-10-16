import type { Db } from "@odentia/db"
import { patient, patientContact, patientDocument, patientResponsibility } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, isNull, lte, gte, or } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { endPairAccess } from "./pair-access.js"
import { requirePatient } from "./patients.js"

export const RESPONSIBILITY_KINDS = ["representante_legal", "autorizado_informacion", "responsable_economico"] as const

function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw validation("Fecha inválida: usa AAAA-MM-DD")
  return value
}

export async function requireLinkedActiveContact(tx: Db, orgId: string, patientId: string, contactId: string) {
  const [row] = await tx.select({ contact, relationship: patientContact.relationship }).from(patientContact)
    .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, patientContact.organizationId)))
    .where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, contactId), eq(contact.isActive, true)))
  if (!row) throw notFound("Contacto activo vinculado al paciente")
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
 * Quién decide por un paciente (presupuesto, consentimientos, sus datos, su
 * portal): la propia persona si es mayor de edad, o su representante legal
 * vigente. Sin fecha de nacimiento no se presume menor. La representación de
 * un menor termina al cumplir 18: después solo cuenta la que se registró
 * siendo ya mayor de edad (la de un adulto que la necesita). Un familiar, un
 * autorizado de información o «otro» nunca deciden.
 */
export async function requireDecisionContact(tx: Db, orgId: string, patientId: string, contactId: string) {
  const linked = await requireLinkedActiveContact(tx, orgId, patientId, contactId)
  const [subject] = await tx.select({ birthDate: patient.birthDate }).from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId))).limit(1)
  const today = new Date().toISOString().slice(0, 10)
  const birth = subject?.birthDate ? String(subject.birthDate).slice(0, 10) : null
  const adultSince = birth ? adulthoodDay(birth) : null
  if (linked.relationship === "self") {
    if (adultSince && adultSince > today) {
      throw new ServiceError("DECISION_CONTACT_NOT_AUTHORIZED", 409, "Es menor de edad: decide su representante legal vigente")
    }
    return linked.contact
  }
  const [responsibility] = await tx.select({ id: patientResponsibility.id }).from(patientResponsibility)
    .where(and(eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId),
      eq(patientResponsibility.contactId, contactId), eq(patientResponsibility.kind, "representante_legal"),
      isNull(patientResponsibility.revokedAt), lte(patientResponsibility.startsAt, today),
      or(isNull(patientResponsibility.endsAt), gte(patientResponsibility.endsAt, today)),
      // Ya es mayor de edad: la representación que tuvo de menor terminó.
      ...(adultSince && adultSince <= today ? [gte(patientResponsibility.startsAt, adultSince)] : []))).for("share")
  if (!responsibility) throw new ServiceError("DECISION_CONTACT_NOT_AUTHORIZED", 409, "El contacto no es paciente ni representante legal vigente")
  return linked.contact
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
  const linked = await requireLinkedActiveContact(tx, orgId, patientId, input.contactId)
  if (linked.relationship === "self" && input.kind === "representante_legal") throw validation("El propio paciente no puede ser su representante legal")
  await tx.select({ id: patientContact.id }).from(patientContact).where(and(eq(patientContact.organizationId, orgId), eq(patientContact.patientId, patientId), eq(patientContact.contactId, linked.contact.id))).for("update")
  if (!(RESPONSIBILITY_KINDS as readonly string[]).includes(input.kind)) throw validation("Responsabilidad inválida")
  const startsAt = validDate(input.startsAt)
  const endsAt = input.endsAt ? validDate(input.endsAt) : null
  if (endsAt && endsAt < startsAt) throw validation("La fecha final no puede preceder a la inicial")
  if (input.evidenceDocumentId) {
    const [doc] = await tx.select({ id: patientDocument.id }).from(patientDocument).where(and(eq(patientDocument.id, input.evidenceDocumentId), eq(patientDocument.organizationId, orgId), eq(patientDocument.patientId, patientId)))
    if (!doc) throw notFound("Documento del paciente")
  }
  const [existing] = await tx.select({ id: patientResponsibility.id }).from(patientResponsibility).where(and(eq(patientResponsibility.organizationId, orgId), eq(patientResponsibility.patientId, patientId), eq(patientResponsibility.contactId, input.contactId), eq(patientResponsibility.kind, input.kind), isNull(patientResponsibility.revokedAt)))
  if (existing) throw new ServiceError("RESPONSIBILITY_EXISTS", 409, "La responsabilidad ya está asignada; revócala antes de sustituirla")
  const [row] = await tx.insert(patientResponsibility).values({ ...input, startsAt, endsAt, organizationId: orgId, patientId, createdBy: actorUserId }).returning()
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "patient.responsibility_granted", entity: "patient_responsibility", entityId: row.id, metadata: { patientId, contactId: input.contactId, kind: input.kind } })
  return row
}

export async function revokeResponsibility(tx: Db, orgId: string, actorUserId: string, patientId: string, id: string, input: { reason: string }) {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
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
  const today = new Date().toISOString().slice(0, 10)
  return rows.map(({ responsibility: r, ...rest }) => ({ ...r, ...rest, isCurrent: !r.revokedAt && r.startsAt <= today && (!r.endsAt || r.endsAt >= today) && rest.contact.isActive }))
}
