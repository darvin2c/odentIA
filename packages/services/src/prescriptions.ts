import type { Db } from "@odentia/db"
import { encounter, orgCounter, prescription, prescriptionItem, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"

export interface PrescriptionMedicationInput {
  medicationName: string
  dose: string
  route: string
  frequency: string
  duration: string
  quantity?: number | null
  instructions?: string | null
}
export interface CreatePrescriptionInput {
  encounterId?: string | null
  planItemId?: string | null
  notes?: string | null
  items: PrescriptionMedicationInput[]
}
function field(value: string, name: string) {
  const text = value?.trim()
  if (!text || text.length > 200) throw validation(`${name} debe tener 1–200 caracteres`)
  return text
}
function scoped(orgId: string, patientId: string, id: string) {
  return and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId), eq(prescription.id, id))
}
export async function createPrescription(tx: Db, orgId: string, actorUserId: string, patientId: string, input: CreatePrescriptionInput) {
  await requirePatient(tx, orgId, patientId)
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw validation("La receta debe contener entre 1 y 20 medicamentos")
  if (input.encounterId) {
    const [enc] = await tx.select().from(encounter).where(and(eq(encounter.id, input.encounterId), eq(encounter.organizationId, orgId), eq(encounter.patientId, patientId))).for("update")
    if (!enc) throw notFound("Atención")
    if (enc.status === "anulada") throw new ServiceError("VOIDED", 409, "La atención está anulada")
    if (enc.status !== "borrador") throw new ServiceError("FINALIZED", 409, "La atención está finalizada")
  }
  if (input.planItemId) {
    const [item] = await tx.select({ id: treatmentPlanItem.id }).from(treatmentPlanItem).where(and(eq(treatmentPlanItem.id, input.planItemId), eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId)))
    if (!item) throw notFound("Tratamiento")
  }
  const items = input.items.map(item => {
    if (item.quantity != null && (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 2147483647)) throw validation("La cantidad debe ser un entero positivo")
    return { ...item, medicationName: field(item.medicationName, "Medicamento"), dose: field(item.dose, "Dosis"), route: field(item.route, "Vía"), frequency: field(item.frequency, "Frecuencia"), duration: field(item.duration, "Duración") }
  })
  const [counter] = await tx.insert(orgCounter).values({ organizationId: orgId, key: "prescription", value: 1 }).onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`${orgCounter.value} + 1` } }).returning()
  const [row] = await tx.insert(prescription).values({ organizationId: orgId, patientId, encounterId: input.encounterId, planItemId: input.planItemId, notes: input.notes, prescriptionNumber: counter.value, issuedBy: actorUserId }).returning()
  const medications = await tx.insert(prescriptionItem).values(items.map(item => ({ ...item, organizationId: orgId, patientId, prescriptionId: row.id }))).returning()
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "prescription.issued", entity: "prescription", entityId: row.id, metadata: { patientId } })
  return { ...row, items: medications }
}
export async function listPrescriptions(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  return tx.select().from(prescription).where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId))).orderBy(desc(prescription.issuedAt), desc(prescription.id))
}
export async function getPrescriptionDetail(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx.select().from(prescription).where(scoped(orgId, patientId, id))
  if (!row) throw notFound("Receta")
  const items = await tx.select().from(prescriptionItem).where(and(eq(prescriptionItem.organizationId, orgId), eq(prescriptionItem.patientId, patientId), eq(prescriptionItem.prescriptionId, id))).orderBy(asc(prescriptionItem.createdAt), asc(prescriptionItem.id))
  return { ...row, items }
}
export async function cancelPrescription(tx: Db, orgId: string, actorUserId: string, patientId: string, id: string, input: { reason: string }) {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [current] = await tx.select().from(prescription).where(scoped(orgId, patientId, id)).for("update")
  if (!current) throw notFound("Receta")
  if (current.status !== "emitida") throw new ServiceError("PRESCRIPTION_STATUS", 409, "La receta ya está anulada")
  await tx.update(prescription).set({ status: "anulada", cancelledAt: new Date(), cancelledBy: actorUserId, cancelReason: reason, updatedAt: new Date() }).where(scoped(orgId, patientId, id))
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, action: "prescription.cancelled", entity: "prescription", entityId: id, metadata: { patientId, reason } })
  return getPrescriptionDetail(tx, orgId, patientId, id)
}
