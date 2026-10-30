import { ADMINISTRATION_ROUTES, allergyWarnings, findMedication } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  diagnosisCatalog,
  encounter,
  orgCounter,
  patient,
  patientAllergy,
  prescription,
  prescriptionItem,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, sql } from "drizzle-orm"
import { resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { requirePatient } from "./patients.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { productHooks } from "./products.js"

/**
 * Medicamento de la receta con los datos de la Guía de la buena prescripción
 * de la OMS: DCI, concentración, forma farmacéutica, vía, dosis, frecuencia,
 * duración y cantidad. Son también los que piden las normas de cada país (en
 * Perú, el Manual de Buenas Prácticas de Prescripción del MINSA).
 */
export interface PrescriptionMedicationInput {
  /** Denominación Común Internacional: obligatoria. */
  genericName: string
  brandName?: string | null
  /** Concentración, p. ej. «500 mg» o «5 mg/mL». */
  strength: string
  dosageForm: string
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
  diagnosisCode?: string | null
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  /** Fecha (AAAA-MM-DD) hasta la que la receta es válida. */
  validUntil?: string | null
  /** La persona que prescribe vio el aviso de alergia y prescribe igual. */
  acknowledgeAllergies?: boolean
  /** Con aviso de alergia, por qué se receta igual (decisión 10): obligatorio y queda en la receta. */
  allergyOverrideReason?: string | null
  /** El peso (kg) con que se receta: latidIA lo pide a un menor de 12 años (issue 229). */
  patientWeightKg?: number | null
  items: PrescriptionMedicationInput[]
}
function field(value: string | null | undefined, name: string, max = 200) {
  const text = value?.trim()
  if (!text || text.length > max) throw validation(`${name} debe tener 1–${max} caracteres`)
  return text
}
function optional(value: string | null | undefined, name: string, max = 200) {
  const text = value?.trim()
  if (!text) return null
  if (text.length > max) throw validation(`${name} debe tener hasta ${max} caracteres`)
  return text
}
function scoped(orgId: string, patientId: string, id: string) {
  return and(
    eq(prescription.organizationId, orgId),
    eq(prescription.patientId, patientId),
    eq(prescription.id, id),
  )
}
export async function createPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreatePrescriptionInput,
) {
  await requirePatient(tx, orgId, patientId)
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20)
    throw validation("La receta debe contener entre 1 y 20 medicamentos")
  if (input.encounterId) {
    const [enc] = await tx
      .select()
      .from(encounter)
      .where(
        and(
          eq(encounter.id, input.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .for("update")
    if (!enc) throw notFound("Atención")
    if (enc.status === "anulada") throw new ServiceError("VOIDED", 409, "La atención está anulada")
    if (enc.status !== "borrador")
      throw new ServiceError("FINALIZED", 409, "La atención está finalizada")
  }
  if (input.planItemId) {
    const [item] = await tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, input.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
    if (!item) throw notFound("Tratamiento")
  }
  const diagnosis = await resolveOptionalDiagnosisCode(tx, orgId, {
    code: optional(input.diagnosisCode, "El diagnóstico", 10),
    system: input.diagnosisSystem,
  })
  // La lista y las reglas de la receta son las del producto de la clínica (issue 229).
  const prescribing = (await productHooks(tx, orgId)).prescribing
  let weightKg: number | null = null
  if (input.patientWeightKg != null) {
    if (typeof input.patientWeightKg !== "number" || !(input.patientWeightKg >= 0.5 && input.patientWeightKg <= 400))
      throw validation("El peso va en kilos, de 0,5 a 400")
    weightKg = Math.round(input.patientWeightKg * 10) / 10
  }
  let validUntil: string | null = null
  if (input.validUntil) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.validUntil) || Number.isNaN(Date.parse(input.validUntil)))
      throw validation("La vigencia debe ser una fecha AAAA-MM-DD")
    if (input.validUntil < new Date().toISOString().slice(0, 10))
      throw validation("La vigencia no puede ser anterior a hoy")
    validUntil = input.validUntil
  }
  const items = input.items.map((item) => {
    if (
      item.quantity != null &&
      (!Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 9999)
    )
      throw validation("La cantidad debe ser un entero entre 1 y 9999")
    const genericName = field(item.genericName, "La DCI del medicamento")
    const strength = field(item.strength, "La concentración", 60)
    const dosageForm = field(item.dosageForm, "La forma farmacéutica", 60)
    const route = field(item.route, "La vía")
    if (!(ADMINISTRATION_ROUTES as readonly string[]).includes(route))
      throw validation(`Vía no reconocida: ${route}`)
    return {
      genericName,
      brandName: optional(item.brandName, "El nombre comercial"),
      strength,
      dosageForm,
      atcCode: findMedication(genericName, prescribing.catalog.medications)?.atc ?? null,
      medicationName: `${genericName} ${strength} ${dosageForm}`,
      dose: field(item.dose, "La dosis"),
      route,
      frequency: field(item.frequency, "La frecuencia"),
      duration: field(item.duration, "La duración"),
      quantity: item.quantity ?? null,
      instructions: optional(item.instructions, "Las indicaciones", 2000),
    }
  })
  // Alergias vigentes del paciente frente a cada DCI, todas por igual (las que
  // dijo el paciente también): con aviso, recetar igual pide un motivo escrito
  // que queda en la receta; nunca se prescribe a ciegas.
  const allergies = await tx
    .select({
      substance: patientAllergy.substance,
      substanceSystem: patientAllergy.substanceSystem,
      substanceCode: patientAllergy.substanceCode,
      severity: patientAllergy.severity,
      verification: patientAllergy.verification,
    })
    .from(patientAllergy)
    .where(
      and(
        eq(patientAllergy.organizationId, orgId),
        eq(patientAllergy.patientId, patientId),
        eq(patientAllergy.isActive, true),
      ),
    )
  // Lo que impide emitir (un controlado, el peso de un niño) va antes que los avisos.
  const review = await prescribing.review(tx, { orgId, patientId, items, weightKg })
  if (review.errors.length > 0) throw new ServiceError("PRESCRIPTION_BLOCKED", 400, review.errors.join(" "))
  // Lo contraindicado en el embarazo se receta como una alergia: con motivo.
  const conflicts = [
    ...items.flatMap((item) => allergyWarnings(item.genericName, allergies, prescribing.catalog)),
    ...review.warnings,
  ]
  const overrideReason = conflicts.length > 0 ? input.allergyOverrideReason?.trim() || null : null
  if (conflicts.length > 0 && (!input.acknowledgeAllergies || !overrideReason))
    throw new ServiceError(
      "ALLERGY_CONFLICT",
      409,
      `${review.warnings.length > 0 ? "Aviso" : "Aviso de alergia"}: ${conflicts.join(" ")} Para recetar igual, escribe por qué.`,
    )
  if (overrideReason && overrideReason.length > 500)
    throw validation("El motivo para recetar igual debe tener hasta 500 caracteres")
  const signer = await requireProfessionalSignature(tx, orgId, actorUserId)
  const [counter] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "prescription", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`${orgCounter.value} + 1` },
    })
    .returning()
  const [row] = await tx
    .insert(prescription)
    .values({
      organizationId: orgId,
      patientId,
      encounterId: input.encounterId,
      planItemId: input.planItemId,
      notes: optional(input.notes, "Las notas", 2000),
      ...diagnosis,
      validUntil,
      allergyOverrideReason: overrideReason,
      patientWeightKg: weightKg === null ? null : String(weightKg),
      prescriberName: signer.name,
      prescriberTitle: signer.title,
      prescriberRegistration: signer.registration,
      prescriptionNumber: counter.value,
      issuedBy: actorUserId,
    })
    .returning()
  const medications = await tx
    .insert(prescriptionItem)
    .values(
      items.map((item) => ({ ...item, organizationId: orgId, patientId, prescriptionId: row.id })),
    )
    .returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "prescription.issued",
    entity: "prescription",
    entityId: row.id,
    // Sin copiar el motivo: la auditoría dice que se recetó igual, el motivo queda en la receta.
    metadata: {
      patientId,
      allergyWarnings: conflicts.length,
      allergyOverride: Boolean(overrideReason),
    },
  })
  return { ...row, items: medications }
}
export async function listPrescriptions(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  return tx
    .select()
    .from(prescription)
    .where(and(eq(prescription.organizationId, orgId), eq(prescription.patientId, patientId)))
    .orderBy(desc(prescription.issuedAt), desc(prescription.id))
}
export async function getPrescriptionDetail(tx: Db, orgId: string, patientId: string, id: string) {
  const [row] = await tx
    .select()
    .from(prescription)
    .where(scoped(orgId, patientId, id))
  if (!row) throw notFound("Receta")
  const items = await tx
    .select()
    .from(prescriptionItem)
    .where(
      and(
        eq(prescriptionItem.organizationId, orgId),
        eq(prescriptionItem.patientId, patientId),
        eq(prescriptionItem.prescriptionId, id),
      ),
    )
    .orderBy(asc(prescriptionItem.createdAt), asc(prescriptionItem.id))
  return { ...row, items }
}
export async function cancelPrescription(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
) {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [current] = await tx
    .select()
    .from(prescription)
    .where(scoped(orgId, patientId, id))
    .for("update")
  if (!current) throw notFound("Receta")
  if (current.status !== "emitida")
    throw new ServiceError("PRESCRIPTION_STATUS", 409, "La receta ya está anulada")
  await tx
    .update(prescription)
    .set({
      status: "anulada",
      cancelledAt: new Date(),
      cancelledBy: actorUserId,
      cancelReason: reason,
      updatedAt: new Date(),
    })
    .where(scoped(orgId, patientId, id))
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "prescription.cancelled",
    entity: "prescription",
    entityId: id,
    metadata: { patientId, reason },
  })
  return getPrescriptionDetail(tx, orgId, patientId, id)
}

/** Datos de la hoja impresa de la receta: establecimiento, paciente, prescriptor y medicamentos. */
export async function getPrescriptionPrint(tx: Db, orgId: string, patientId: string, id: string) {
  const detail = await getPrescriptionDetail(tx, orgId, patientId, id)
  const [person] = await tx
    .select({
      displayName: patientPerson.displayName,
      patientNumber: patient.patientNumber,
      docType: patientPerson.docType,
      docNumber: patientPerson.docNumber,
      birthDate: patientPerson.birthDate,
    })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  if (!person) throw notFound("Paciente")
  const [org] = await tx
    .select({
      legalName: orgProfile.legalName,
      tradeName: orgProfile.tradeName,
      fiscalDocType: orgProfile.fiscalDocType,
      fiscalDocNumber: orgProfile.fiscalDocNumber,
      address: orgProfile.fiscalAddress,
      // Con qué formato y en qué zona se escriben las fechas del PDF que se envía.
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const [dx] =
    detail.diagnosisCode && detail.diagnosisSystem
      ? await tx
          .select({ description: diagnosisCatalog.title })
          .from(diagnosisCatalog)
          .where(
            and(
              eq(diagnosisCatalog.systemKey, detail.diagnosisSystem),
              eq(diagnosisCatalog.code, detail.diagnosisCode),
            ),
          )
      : []
  // Las alergias activas van a la vista en la receta: es lo que evita un error al dispensar.
  const allergies = await tx
    .select({ substance: patientAllergy.substance })
    .from(patientAllergy)
    .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId), eq(patientAllergy.isActive, true)))
  return {
    prescription: detail,
    diagnosisDescription: dx?.description ?? null,
    patient: person,
    establishment: org ?? null,
    allergies: allergies.map((row) => row.substance),
  }
}
