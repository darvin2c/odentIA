/**
 * Lo que nace junto se corrige junto (QA del 16 nov, E2): el hallazgo de la pieza, su
 * diagnóstico de la atención y lo indicado desde él nacen juntos en el panel de la pieza
 * (`registerToothFinding`). Aquí, lo dental de esa corrección: el vínculo hallazgo ↔
 * diagnóstico (`dental.diagnosis_finding`), los hallazgos de la atención con lo que nació con
 * ellos y cómo se anulan. La regla de qué cae con qué es común (`encounter-correction.ts`).
 *
 * Y el aviso suave de una cara con caries y restauración a la vez (C41), que no frena.
 */
import type { Db } from "@odentia/db"
import { encounterDiagnosis } from "@odentia/db/schema/clinical"
import { diagnosisFinding, odontogramEntry, planItemFinding } from "@odentia/db/schema/dental"
import {
  cariesOnRestoredFaces,
  findingDefinition,
  ISO_3950,
  type SameFaceFinding,
  surfaceLabel,
  toothSiteCode,
} from "@odentia/dental"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"
import type { CorrectionFinding, EncounterMoment } from "../product-hooks.js"
import { voidOdontogramEntry } from "./odontogram.js"

/** El hallazgo y su diagnóstico nacieron juntos: queda dicho, una vez. */
export async function linkDiagnosisFinding(
  tx: Db,
  scope: { orgId: string; patientId: string; diagnosisId: string; entryIds: readonly string[] },
): Promise<void> {
  if (scope.entryIds.length === 0) return
  await tx
    .insert(diagnosisFinding)
    .values(
      scope.entryIds.map((entryId) => ({
        organizationId: scope.orgId,
        patientId: scope.patientId,
        diagnosisId: scope.diagnosisId,
        odontogramEntryId: entryId,
      })),
    )
    .onConflictDoNothing()
}

/** «Lesión de caries dental · Oclusal, Mesial · 47». */
function findingLabel(condition: string, toothNumber: number, surfaces: readonly string[]): string {
  const name = findingDefinition(condition)?.label ?? condition
  return [name, surfaces.map((surface) => surfaceLabel(surface)).join(", "), String(toothNumber)]
    .filter(Boolean)
    .join(" · ")
}

/**
 * Los hallazgos vigentes registrados en esta atención, cada uno con su diagnóstico de la
 * atención (el del vínculo, solo si sigue vigente) y lo indicado desde él. Las caras de una
 * caries son filas de un solo hallazgo: van en el mismo `group`, como en la pantalla.
 */
export async function correctionFindings(
  tx: Db,
  { orgId, patientId, encounterId }: Omit<EncounterMoment, "actorUserId">,
): Promise<CorrectionFinding[]> {
  const entries = await tx
    .select()
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.encounterId, encounterId),
        isNull(odontogramEntry.voidedAt),
      ),
    )
    .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id))
  if (entries.length === 0) return []
  const ids = entries.map((entry) => entry.id)
  const diagnoses = await tx
    .select({ entryId: diagnosisFinding.odontogramEntryId, diagnosisId: diagnosisFinding.diagnosisId })
    .from(diagnosisFinding)
    .innerJoin(
      encounterDiagnosis,
      and(
        eq(encounterDiagnosis.organizationId, diagnosisFinding.organizationId),
        eq(encounterDiagnosis.id, diagnosisFinding.diagnosisId),
      ),
    )
    .where(
      and(
        eq(diagnosisFinding.organizationId, orgId),
        inArray(diagnosisFinding.odontogramEntryId, ids),
        eq(encounterDiagnosis.encounterId, encounterId),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
  const items = await tx
    .select({ entryId: planItemFinding.odontogramEntryId, planItemId: planItemFinding.planItemId })
    .from(planItemFinding)
    .where(and(eq(planItemFinding.organizationId, orgId), inArray(planItemFinding.odontogramEntryId, ids)))
  // Un hallazgo es lo que la pantalla agrupa: su pieza, su tipo, su código y su momento.
  const groupOf = (entry: (typeof entries)[number]) =>
    [entry.toothNumber, entry.condition, entry.diagnosisCode ?? "", entry.createdAt.getTime()].join("|")
  const surfacesOf = new Map<string, string[]>()
  for (const entry of entries) {
    const key = groupOf(entry)
    const surfaces = surfacesOf.get(key) ?? []
    if (entry.surface && !surfaces.includes(entry.surface)) surfaces.push(entry.surface)
    surfacesOf.set(key, surfaces)
  }
  return entries.map((entry) => {
    const group = groupOf(entry)
    return {
      id: entry.id,
      group,
      label: findingLabel(entry.condition, entry.toothNumber, surfacesOf.get(group) ?? []),
      siteSystem: ISO_3950,
      siteCode: toothSiteCode(entry.toothNumber),
      diagnosisIds: diagnoses.filter((row) => row.entryId === entry.id).map((row) => row.diagnosisId),
      planItemIds: items.filter((row) => row.entryId === entry.id).map((row) => row.planItemId),
    }
  })
}

/** Anula esos hallazgos con su motivo, como «Anular» en la pieza (`voidOdontogramEntry`). */
export async function voidCorrectionFindings(
  tx: Db,
  { orgId, actorUserId, patientId, ids, reason }: EncounterMoment & { ids: string[]; reason: string },
): Promise<void> {
  for (const id of ids) await voidOdontogramEntry(tx, orgId, actorUserId, id, patientId, reason)
}

/**
 * Las caras con caries y restauración definitiva vigentes a la vez, si alguna de las dos se
 * registró en esta atención (QA del 16 nov, C41). Clínicamente suele ser caries bajo la
 * restauración: el cierre lo avisa y propone registrarla como restauración en mal estado.
 * Las dos puertas son a propósito (el hallazgo es lo que se ve; lo tratado lo dibuja el
 * servicio): por eso avisa y no frena.
 */
export async function sameFaceFindings(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<SameFaceFinding[]> {
  const rows = await tx
    .select({
      toothNumber: odontogramEntry.toothNumber,
      surface: odontogramEntry.surface,
      condition: odontogramEntry.condition,
      details: odontogramEntry.details,
      encounterId: odontogramEntry.encounterId,
    })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        isNull(odontogramEntry.voidedAt),
        isNull(odontogramEntry.resolvedAt),
        eq(odontogramEntry.needsReview, false),
        inArray(odontogramEntry.condition, ["caries", "definitive_restoration"]),
      ),
    )
  return cariesOnRestoredFaces(rows, encounterId)
}
