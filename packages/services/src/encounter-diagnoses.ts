/**
 * Diagnósticos de la atención (ADR 0002 y 0041): lista y código (CIE-10 o
 * CIE-11, la de la clínica), su certeza (FHIR verificationStatus) y sitio
 * dental. «Ya diagnosticado antes» lo marca el sistema (decisión 11).
 * Se registran y se anulan con motivo mientras la atención está en borrador;
 * su estado clínico (activo o resuelto) sigue al paciente y forma su lista de
 * problemas.
 */

import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { diagnosisCatalog, encounter, encounterDiagnosis } from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { DIAGNOSIS_TYPES } from "./clinical.js"
import { resolveDiagnosisCode, wasDiagnosedBefore } from "./diagnosis-codes.js"
import { assertOpenDraft, type EncounterDiagnosisRow, lockEncounter } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { withSite } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** El «dónde» del producto de la clínica (odentIA: pieza y caras). */
const siteOf = async (tx: Db, orgId: string) => (await productHooks(tx, orgId)).site

export const DIAGNOSIS_STATUSES = ["activo", "resuelto"] as const

export interface AddDiagnosisInput {
  /** Código de la lista de la clínica: los diagnósticos nuevos se eligen en ella. */
  diagnosisCode: string
  /** Si viene, debe ser la lista de la clínica. */
  diagnosisSystem?: string | null
  /** provisional («Presuntivo») o confirmed («Definitivo»). */
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
  const found = await resolveDiagnosisCode(
    tx,
    orgId,
    { code: input.diagnosisCode, system: input.diagnosisSystem },
    { newDiagnosis: true, codable: true },
  )
  if (!(DIAGNOSIS_TYPES as readonly string[]).includes(input.diagnosisType))
    throw validation("Elige si el diagnóstico es presuntivo o definitivo")
  const previouslyDiagnosed = await wasDiagnosedBefore(tx, orgId, patientId, found, encounterId)
  // Dónde, como lo valida el producto (odentIA: una pieza FDI y sus caras).
  const site = await siteOf(tx, orgId)
  const columns = site.columns({ toothNumber: input.toothNumber ?? null, surfaces: input.surfaces ?? [] })
  const note = input.note?.trim() || null
  if (note && note.length > 2000) throw validation("La nota admite hasta 2000 caracteres")
  const [row] = await tx
    .insert(encounterDiagnosis)
    .values({
      organizationId: orgId,
      patientId,
      encounterId,
      diagnosisSystem: found.system,
      diagnosisCode: found.code,
      diagnosisType: input.diagnosisType,
      previouslyDiagnosed,
      ...columns,
      note,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el diagnóstico")
  await audit(tx, orgId, actorUserId, "encounter.diagnosis_added", row.id, {
    patientId,
    encounterId,
    diagnosisSystem: found.system,
    diagnosisCode: found.code,
  })
  return withSite(await siteOf(tx, orgId), row)
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
  return withSite(await siteOf(tx, orgId), row)
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
  if (current.status === status) return withSite(await siteOf(tx, orgId), current)
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
  return withSite(await siteOf(tx, orgId), row)
}

/**
 * Lista de problemas del paciente: diagnósticos no anulados de atenciones no
 * anuladas, con la descripción de su lista, primero los activos y los más recientes.
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
      description: diagnosisCatalog.title,
      encounterStatus: encounter.status,
      encounterStartedAt: encounter.startedAt,
      authorName: user.name,
    })
    .from(encounterDiagnosis)
    .innerJoin(
      diagnosisCatalog,
      and(
        eq(diagnosisCatalog.systemKey, encounterDiagnosis.diagnosisSystem),
        eq(diagnosisCatalog.code, encounterDiagnosis.diagnosisCode),
      ),
    )
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
  const site = await siteOf(tx, orgId)
  return rows
    .filter((row) => row.encounterStatus !== "anulada")
    .map((row) => ({
      ...withSite(site, row.diagnosis),
      description: row.description,
      encounterStartedAt: row.encounterStartedAt,
      authorName: row.authorName,
    }))
}
