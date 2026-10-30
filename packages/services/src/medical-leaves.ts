import { MEDICAL_LEAVE_MAX_DAYS, medicalLeaveEnd } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { diagnosisCatalog, encounter, orgCounter, patient } from "@odentia/db/schema/clinical"
import { medicalLeave } from "@odentia/db/schema/clinical-forms"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, desc, eq, sql } from "drizzle-orm"
import { resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { requirePatient } from "./patients.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { listDecisionRecipients, patientAge } from "./responsibilities.js"

/**
 * El descanso médico (issue 229, decisión 8): la constancia de reposo, como la
 * receta. Se emite firmada con el perfil profesional, numerada por clínica, y
 * no se corrige: se anula con motivo. El diagnóstico va solo si la persona lo
 * autoriza; sin su permiso ni siquiera se guarda en la constancia.
 */
export interface CreateMedicalLeaveInput {
  encounterId?: string | null
  /** Primer día del reposo (AAAA-MM-DD); por omisión, hoy en la clínica. */
  startsOn?: string | null
  days: number
  /** La persona autorizó que el diagnóstico figure. */
  showDiagnosis?: boolean
  diagnosisCode?: string | null
  diagnosisSystem?: string | null
  /** Indicaciones del reposo. */
  notes?: string | null
}

export type MedicalLeaveRow = typeof medicalLeave.$inferSelect

function scoped(orgId: string, patientId: string, id: string) {
  return and(
    eq(medicalLeave.organizationId, orgId),
    eq(medicalLeave.patientId, patientId),
    eq(medicalLeave.id, id),
  )
}

export async function createMedicalLeave(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateMedicalLeaveInput,
): Promise<MedicalLeaveRow> {
  await requirePatient(tx, orgId, patientId)
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MEDICAL_LEAVE_MAX_DAYS)
    throw validation(`Los días de descanso van de 1 a ${MEDICAL_LEAVE_MAX_DAYS}`)
  const today = await clinicToday(tx, orgId)
  const startsOn = input.startsOn ?? today
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startsOn) || Number.isNaN(Date.parse(startsOn)))
    throw validation("El primer día va como fecha AAAA-MM-DD")
  if (input.encounterId) {
    const [visit] = await tx
      .select({ status: encounter.status })
      .from(encounter)
      .where(
        and(
          eq(encounter.id, input.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
    if (!visit) throw notFound("Atención")
    if (visit.status === "anulada")
      throw new ServiceError("VOIDED", 409, "La atención está anulada")
  }
  // Sin la autorización de la persona, el diagnóstico no se guarda: no hay nada que filtrar después.
  const diagnosis = input.showDiagnosis
    ? await resolveOptionalDiagnosisCode(tx, orgId, {
        code: input.diagnosisCode?.trim() || null,
        system: input.diagnosisSystem,
      })
    : { diagnosisSystem: null, diagnosisCode: null }
  const notes = input.notes?.trim() || null
  if (notes && notes.length > 2000)
    throw validation("Las indicaciones tienen hasta 2000 caracteres")
  const signer = await requireProfessionalSignature(tx, orgId, actorUserId)
  const [counter] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "medical_leave", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`${orgCounter.value} + 1` },
    })
    .returning()
  if (!counter) throw new ServiceError("COUNTER", 500, "No se pudo numerar el descanso médico")
  const [row] = await tx
    .insert(medicalLeave)
    .values({
      organizationId: orgId,
      patientId,
      encounterId: input.encounterId ?? null,
      leaveNumber: counter.value,
      startsOn,
      days: input.days,
      endsOn: medicalLeaveEnd(startsOn, input.days),
      showDiagnosis: Boolean(input.showDiagnosis),
      ...diagnosis,
      notes,
      signerName: signer.name,
      signerTitle: signer.title,
      signerRegistration: signer.registration,
      issuedBy: actorUserId,
    })
    .returning()
  if (!row) throw new ServiceError("MEDICAL_LEAVE", 500, "No se pudo emitir el descanso médico")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "medical_leave.issued",
    entity: "medical_leave",
    entityId: row.id,
    // Sin el diagnóstico: la auditoría dice si se autorizó, el código queda en la constancia.
    metadata: { patientId, days: row.days, showDiagnosis: row.showDiagnosis },
  })
  return row
}

export async function listMedicalLeaves(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<MedicalLeaveRow[]> {
  await requirePatient(tx, orgId, patientId)
  return tx
    .select()
    .from(medicalLeave)
    .where(and(eq(medicalLeave.organizationId, orgId), eq(medicalLeave.patientId, patientId)))
    .orderBy(desc(medicalLeave.issuedAt), desc(medicalLeave.id))
}

export async function getMedicalLeave(
  tx: Db,
  orgId: string,
  patientId: string,
  id: string,
): Promise<MedicalLeaveRow> {
  const [row] = await tx
    .select()
    .from(medicalLeave)
    .where(scoped(orgId, patientId, id))
  if (!row) throw notFound("Descanso médico")
  return row
}

export async function cancelMedicalLeave(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  id: string,
  input: { reason: string },
): Promise<MedicalLeaveRow> {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  const [current] = await tx
    .select()
    .from(medicalLeave)
    .where(scoped(orgId, patientId, id))
    .for("update")
  if (!current) throw notFound("Descanso médico")
  if (current.status !== "emitido")
    throw new ServiceError("MEDICAL_LEAVE_STATUS", 409, "El descanso médico ya está anulado")
  const [row] = await tx
    .update(medicalLeave)
    .set({
      status: "anulado",
      cancelledAt: new Date(),
      cancelledBy: actorUserId,
      cancelReason: reason,
      updatedAt: new Date(),
    })
    .where(scoped(orgId, patientId, id))
    .returning()
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "medical_leave.cancelled",
    entity: "medical_leave",
    entityId: id,
    metadata: { patientId, reason },
  })
  if (!row) throw notFound("Descanso médico")
  return row
}

/** Lo que va en la hoja: el establecimiento, la persona, el reposo y, si se autorizó, el diagnóstico. */
export async function getMedicalLeavePrint(tx: Db, orgId: string, patientId: string, id: string) {
  const leave = await getMedicalLeave(tx, orgId, patientId, id)
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
      locale: orgProfile.locale,
      timezone: orgProfile.timezone,
    })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
  const [dx] =
    leave.showDiagnosis && leave.diagnosisCode && leave.diagnosisSystem
      ? await tx
          .select({ description: diagnosisCatalog.title })
          .from(diagnosisCatalog)
          .where(
            and(
              eq(diagnosisCatalog.systemKey, leave.diagnosisSystem),
              eq(diagnosisCatalog.code, leave.diagnosisCode),
            ),
          )
      : []
  // «Evaluado el»: la hora de la atención que dio el descanso, si salió de una.
  const [visit] = leave.encounterId
    ? await tx
        .select({ startedAt: encounter.startedAt })
        .from(encounter)
        .where(and(eq(encounter.id, leave.encounterId), eq(encounter.organizationId, orgId)))
        .limit(1)
    : []
  // Un menor no se representa solo: el papel nombra a quien lo representa hoy.
  const age = await patientAge(tx, orgId, patientId)
  const guardian = age.isMinor
    ? (await listDecisionRecipients(tx, orgId, patientId)).find((row) => row.relation === "representante_legal")
    : null
  return {
    leave,
    diagnosisDescription: dx?.description ?? null,
    patient: person,
    establishment: org ?? null,
    evaluatedAt: visit?.startedAt ?? null,
    guardianName: guardian?.displayName ?? null,
  }
}
