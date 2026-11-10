import { isTooth } from "./site.js"
import { DIAGNOSIS_VERIFICATION_LABELS, diagnosisCodeLabel, doneSessionWords, isDiagnosisVerification } from "@odentia/clinical"
import { isValidTooth } from "@odentia/dental"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  clinicalFollowUp,
  diagnosisCatalog,
  encounter,
  encounterDiagnosis,
  encounterProcedure,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { odontogramEntry } from "@odentia/db/schema/dental"
import { and, eq, inArray, or } from "drizzle-orm"
import { listPatientDocuments } from "../clinical.js"
import { validation } from "../errors.js"
import { requirePatient } from "../patients.js"
import { encounterSessionKey, encounterSessionsOf } from "../to-schedule.js"

export type ToothEventKind = "hallazgo" | "diagnostico" | "procedimiento" | "control" | "documento"

/**
 * Un hecho de la pieza, tal como ocurrió. No es un registro nuevo: se arma con
 * el odontograma, las atenciones, los controles y los documentos existentes.
 */
export interface ToothEvent {
  kind: ToothEventKind
  id: string
  at: Date
  title: string
  /** Código del hallazgo (NTS 188), CIE-10 o categoría del documento. */
  code: string | null
  surfaces: string[]
  /** Estado propio del hecho: vigente, tratado, anulado, en curso, realizado… */
  status: string
  /**
   * El estado dicho, cuando la clave sola no alcanza: la sesión de un
   * tratamiento de varias («Sesión 1 de 2 · hecha»), nunca «Realizado» con el
   * tratamiento en curso (tercer repaso del 9 nov, E12). Nulo: el de `status`.
   */
  statusText: string | null
  detail: string | null
  encounterId: string | null
  /** La atención de origen sigue abierta: el hecho aún puede corregirse. */
  encounterOpen: boolean
  authorName: string | null
  voidReason: string | null
}

/**
 * Historia de una pieza, del hecho más reciente al más antiguo: hallazgos,
 * diagnósticos, procedimientos, controles y documentos con su profesional y
 * su atención. Una pieza que no existe en la notación FDI se rechaza.
 */
export async function getToothHistory(
  tx: Db,
  orgId: string,
  patientId: string,
  toothNumber: number,
): Promise<ToothEvent[]> {
  if (!Number.isInteger(toothNumber) || !isValidTooth(toothNumber))
    throw validation("Pieza FDI inválida")
  await requirePatient(tx, orgId, patientId)

  const [findings, diagnoses, procedures, items, docs] = await Promise.all([
    tx
      .select({ row: odontogramEntry, author: user.name })
      .from(odontogramEntry)
      .leftJoin(user, eq(user.id, odontogramEntry.createdBy))
      .where(
        and(
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          eq(odontogramEntry.toothNumber, toothNumber),
        ),
      ),
    tx
      .select({
        row: encounterDiagnosis,
        author: user.name,
        description: diagnosisCatalog.title,
        encounterStatus: encounter.status,
      })
      .from(encounterDiagnosis)
      .leftJoin(user, eq(user.id, encounterDiagnosis.createdBy))
      .leftJoin(
        diagnosisCatalog,
        and(
          eq(diagnosisCatalog.systemKey, encounterDiagnosis.diagnosisSystem),
          eq(diagnosisCatalog.code, encounterDiagnosis.diagnosisCode),
        ),
      )
      .leftJoin(encounter, eq(encounter.id, encounterDiagnosis.encounterId))
      .where(
        and(
          eq(encounterDiagnosis.organizationId, orgId),
          eq(encounterDiagnosis.patientId, patientId),
          isTooth(encounterDiagnosis, toothNumber),
        ),
      ),
    tx
      .select({ row: encounterProcedure, author: user.name, encounterStatus: encounter.status })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterProcedure.encounterId),
          eq(encounter.organizationId, encounterProcedure.organizationId),
        ),
      )
      .leftJoin(user, eq(user.id, encounter.professionalUserId))
      .where(
        and(
          eq(encounterProcedure.organizationId, orgId),
          eq(encounter.patientId, patientId),
          isTooth(encounterProcedure, toothNumber),
        ),
      ),
    tx
      .select({ id: treatmentPlanItem.id })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          isTooth(treatmentPlanItem, toothNumber),
        ),
      ),
    listPatientDocuments(tx, orgId, patientId),
  ])

  // La sesión de cada procedimiento de un tratamiento, en las atenciones firmadas.
  const sessions = await encounterSessionsOf(
    tx,
    orgId,
    procedures.filter((p) => p.encounterStatus === "finalizada" && p.row.planItemId).map((p) => p.row.encounterId),
  )
  const itemIds = items.map((item) => item.id)
  const procedureIds = procedures.map((p) => p.row.id)
  const followUps =
    itemIds.length + procedureIds.length > 0
      ? await tx
          .select({ row: clinicalFollowUp, author: user.name })
          .from(clinicalFollowUp)
          .leftJoin(user, eq(user.id, clinicalFollowUp.createdBy))
          .where(
            and(
              eq(clinicalFollowUp.organizationId, orgId),
              eq(clinicalFollowUp.patientId, patientId),
              or(
                itemIds.length ? inArray(clinicalFollowUp.planItemId, itemIds) : undefined,
                procedureIds.length
                  ? inArray(clinicalFollowUp.encounterProcedureId, procedureIds)
                  : undefined,
              ),
            ),
          )
      : []

  const events: ToothEvent[] = []
  // Una lesión de varias caras (una caries DO) es una fila por cara de la misma
  // anotación: se dice en una sola línea, «(Oclusal, Distal)», por estado.
  const lesions = new Map<string, ToothEvent>()
  for (const { row, author } of findings) {
    const status = row.voidedAt ? "anulado" : row.resolvedAt ? "tratado" : "vigente"
    const key = [row.encounterId, row.toothNumber, row.condition, row.createdAt.getTime(), row.createdBy, status].join("|")
    const same = lesions.get(key)
    if (same) {
      if (row.surface && !same.surfaces.includes(row.surface)) same.surfaces.push(row.surface)
      continue
    }
    const event: ToothEvent = {
      kind: "hallazgo",
      id: row.id,
      at: row.createdAt,
      title: row.condition,
      code: row.condition,
      surfaces: row.surface ? [row.surface] : [],
      status,
      statusText: null,
      detail: row.note,
      encounterId: row.encounterId,
      encounterOpen: false,
      authorName: author,
      voidReason: row.voidReason,
    }
    lesions.set(key, event)
    events.push(event)
  }
  for (const { row, author, description, encounterStatus } of diagnoses) {
    events.push({
      kind: "diagnostico",
      id: row.id,
      at: row.createdAt,
      title: description ?? row.diagnosisCode,
      code: diagnosisCodeLabel(row.diagnosisSystem, row.diagnosisCode),
      surfaces: row.siteQualifiers,
      status: row.voidedAt ? "anulado" : row.status,
      statusText: null,
      detail:
        [
          isDiagnosisVerification(row.diagnosisType) ? DIAGNOSIS_VERIFICATION_LABELS[row.diagnosisType] : null,
          row.previouslyDiagnosed ? "Ya diagnosticado antes" : null,
          row.note,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      encounterId: row.encounterId,
      encounterOpen: encounterStatus === "borrador",
      authorName: author,
      voidReason: row.voidReason,
    })
  }
  for (const { row, author, encounterStatus } of procedures) {
    const session =
      !row.voidedAt && encounterStatus === "finalizada" && row.planItemId
        ? sessions.get(encounterSessionKey(row.encounterId, row.planItemId))
        : undefined
    const words = session ? doneSessionWords(session.n, session.m, session.finished) : null
    events.push({
      kind: "procedimiento",
      id: row.id,
      at: row.createdAt,
      title: row.description,
      code: row.diagnosisCode ? diagnosisCodeLabel(row.diagnosisSystem, row.diagnosisCode) : null,
      surfaces: row.siteQualifiers,
      status: row.voidedAt ? "anulado" : encounterStatus === "borrador" ? "en_curso" : "realizado",
      // «Sesión 1 de 2 · hecha» mientras sigue; «Sesión 2 de 2 · tratamiento terminado» en la última.
      statusText: words
        ? `${words.charAt(0).toUpperCase()}${words.slice(1)}${session?.finished ? "" : " · hecha"}`
        : null,
      detail: null,
      encounterId: row.encounterId,
      encounterOpen: encounterStatus === "borrador",
      authorName: author,
      voidReason: row.voidReason,
    })
  }
  for (const { row, author } of followUps) {
    events.push({
      kind: "control",
      id: row.id,
      at: row.completedAt ?? row.cancelledAt ?? row.dueAt,
      title: row.title,
      code: null,
      surfaces: [],
      status: row.status,
      statusText: null,
      detail: row.outcome ?? row.cancelledReason ?? row.instructions,
      encounterId: row.completedEncounterId ?? row.originEncounterId,
      encounterOpen: false,
      authorName: author,
      voidReason: null,
    })
  }
  for (const doc of docs) {
    if (!doc.toothNumbers.includes(toothNumber)) continue
    events.push({
      kind: "documento",
      id: doc.id,
      at: doc.createdAt,
      title: doc.label,
      code: doc.category,
      surfaces: [],
      status: "vigente",
      statusText: null,
      detail: doc.contentType,
      encounterId: doc.encounterId,
      encounterOpen: false,
      authorName: null,
      voidReason: null,
    })
  }
  return events.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
}
