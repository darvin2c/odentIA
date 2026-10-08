/**
 * Diagnósticos de la atención (ADR 0002): CIE-10 con tipo HIS y sitio dental.
 * Se registran y se anulan con motivo mientras la atención está en borrador;
 * su estado clínico (activo o resuelto) sigue al paciente y forma su lista de
 * problemas.
 */
import { isValidTooth, surfacesForTooth } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { cie10Code, encounter, encounterDiagnosis } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { DIAGNOSIS_TYPES } from "./clinical.js"
import { assertOpenDraft, type EncounterDiagnosisRow, lockEncounter } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"

export const DIAGNOSIS_STATUSES = ["activo", "resuelto"] as const

export interface AddDiagnosisInput {
  cie10Code: string
  diagnosisType: string
  toothNumber?: number | null
  surfaces?: string[] | null
  note?: string | null
}

export interface PatientDiagnosis extends EncounterDiagnosisRow {
  description: string
  encounterStartedAt: Date | null
  authorName: string | null
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "encounter_diagnosis",
    entityId,
    metadata,
  })
}

function cleanSurfaces(
  surfaces: string[] | null | undefined,
  toothNumber: number | null,
): string[] {
  const list = [...new Set((surfaces ?? []).map((s) => s.trim()).filter(Boolean))]
  if (list.length === 0) return []
  if (toothNumber === null) throw validation("Las superficies exigen una pieza")
  const allowed = new Set<string>(surfacesForTooth(toothNumber))
  for (const surface of list) {
    if (!allowed.has(surface)) throw validation(`Superficie inválida para la pieza ${toothNumber}`)
  }
  return list.sort()
}

export async function addEncounterDiagnosis(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: AddDiagnosisInput,
): Promise<EncounterDiagnosisRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const code = input.cie10Code?.trim()
  if (!code) throw validation("El código CIE-10 es obligatorio")
  const [known] = await tx
    .select({ code: cie10Code.code })
    .from(cie10Code)
    .where(eq(cie10Code.code, code))
    .limit(1)
  if (!known) throw validation(`Código CIE-10 inexistente: ${code}`)
  if (!(DIAGNOSIS_TYPES as readonly string[]).includes(input.diagnosisType))
    throw validation("Tipo de diagnóstico inválido: presuntivo, definitivo o repetido")
  const toothNumber = input.toothNumber ?? null
  if (toothNumber !== null && (!Number.isInteger(toothNumber) || !isValidTooth(toothNumber)))
    throw validation("Pieza FDI inválida")
  const surfaces = cleanSurfaces(input.surfaces, toothNumber)
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw validation("La nota admite hasta 2000 caracteres")
  const [row] = await tx
    .insert(encounterDiagnosis)
    .values({
      organizationId: orgId,
      patientId,
      encounterId,
      cie10Code: code,
      diagnosisType: input.diagnosisType,
      toothNumber,
      surfaces,
      note,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el diagnóstico")
  await audit(tx, orgId, actorUserId, "encounter.diagnosis_added", row.id, {
    patientId,
    encounterId,
    cie10Code: code,
  })
  return row
}

export async function voidEncounterDiagnosis(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  diagnosisId: string,
  input: { reason: string },
): Promise<EncounterDiagnosisRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const reason = input.reason?.trim() ?? ""
  if (reason.length < 1 || reason.length > 2000)
    throw validation("El motivo debe tener 1–2000 caracteres")
  const [current] = await tx
    .select()
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.id, diagnosisId),
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, encounterId),
      ),
    )
    .limit(1)
  if (!current) throw notFound("Diagnóstico")
  if (current.voidedAt)
    throw new ServiceError("ALREADY_VOIDED", 409, "El diagnóstico ya está anulado")
  const now = new Date()
  const [row] = await tx
    .update(encounterDiagnosis)
    .set({ voidedAt: now, voidedBy: actorUserId, voidReason: reason, updatedAt: now })
    .where(and(eq(encounterDiagnosis.id, diagnosisId), isNull(encounterDiagnosis.voidedAt)))
    .returning()
  if (!row) throw new ServiceError("ALREADY_VOIDED", 409, "El diagnóstico ya está anulado")
  await audit(tx, orgId, actorUserId, "encounter.diagnosis_voided", row.id, {
    patientId,
    encounterId,
    reason,
  })
  return row
}

/** Marca un diagnóstico como resuelto o lo reactiva; vale también en atenciones cerradas. */
export async function setDiagnosisStatus(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  diagnosisId: string,
  status: string,
): Promise<EncounterDiagnosisRow> {
  await requirePatient(tx, orgId, patientId)
  if (!(DIAGNOSIS_STATUSES as readonly string[]).includes(status))
    throw validation("Estado inválido: activo o resuelto")
  const [current] = await tx
    .select()
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.id, diagnosisId),
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
      ),
    )
    .for("update")
    .limit(1)
  if (!current) throw notFound("Diagnóstico")
  if (current.voidedAt) throw new ServiceError("ALREADY_VOIDED", 409, "El diagnóstico está anulado")
  if (current.status === status) return current
  const now = new Date()
  const [row] = await tx
    .update(encounterDiagnosis)
    .set({ status, resolvedAt: status === "resuelto" ? now : null, updatedAt: now })
    .where(eq(encounterDiagnosis.id, diagnosisId))
    .returning()
  if (!row) throw notFound("Diagnóstico")
  await audit(tx, orgId, actorUserId, "encounter.diagnosis_status", row.id, {
    patientId,
    from: current.status,
    to: status,
  })
  return row
}

/**
 * Lista de problemas del paciente: diagnósticos no anulados de atenciones no
 * anuladas, con su descripción CIE-10, primero los activos y los más recientes.
 */
export async function listPatientDiagnoses(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { status?: string } = {},
): Promise<PatientDiagnosis[]> {
  await requirePatient(tx, orgId, patientId)
  if (input.status && !(DIAGNOSIS_STATUSES as readonly string[]).includes(input.status))
    throw validation("Estado inválido: activo o resuelto")
  const rows = await tx
    .select({
      diagnosis: encounterDiagnosis,
      description: cie10Code.description,
      encounterStatus: encounter.status,
      encounterStartedAt: encounter.startedAt,
      authorName: user.name,
    })
    .from(encounterDiagnosis)
    .innerJoin(cie10Code, eq(cie10Code.code, encounterDiagnosis.cie10Code))
    .leftJoin(
      encounter,
      and(
        eq(encounter.id, encounterDiagnosis.encounterId),
        eq(encounter.organizationId, encounterDiagnosis.organizationId),
      ),
    )
    .leftJoin(user, eq(user.id, encounterDiagnosis.createdBy))
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        isNull(encounterDiagnosis.voidedAt),
        ...(input.status ? [eq(encounterDiagnosis.status, input.status)] : []),
      ),
    )
    .orderBy(asc(encounterDiagnosis.status), desc(encounterDiagnosis.createdAt))
  return rows
    .filter((row) => row.encounterStatus !== "anulada")
    .map((row) => ({
      ...row.diagnosis,
      description: row.description,
      encounterStartedAt: row.encounterStartedAt,
      authorName: row.authorName,
    }))
}
