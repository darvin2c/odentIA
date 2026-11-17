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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { addEncounterDiagnosis, voidEncounterDiagnosis } from "../encounter-diagnoses.js"
import type { CorrectionFinding, EncounterMoment } from "../product-hooks.js"
import { voidOdontogramEntry } from "./odontogram.js"
import { toothOfRow } from "./site.js"

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

/**
 * El tratamiento se indicó desde un hallazgo (`dental.plan_item_finding`) y todos esos hallazgos
 * están anulados (QA del 16 nov, Q19): cayó con la corrección de la pieza equivocada.
 */
export async function planItemLostItsFinding(
  tx: Db,
  { orgId, patientId, planItemId }: { orgId: string; patientId: string; planItemId: string },
): Promise<boolean> {
  const rows = await tx
    .select({ voidedAt: odontogramEntry.voidedAt })
    .from(planItemFinding)
    .innerJoin(
      odontogramEntry,
      and(
        eq(odontogramEntry.organizationId, planItemFinding.organizationId),
        eq(odontogramEntry.id, planItemFinding.odontogramEntryId),
      ),
    )
    .where(
      and(
        eq(planItemFinding.organizationId, orgId),
        eq(planItemFinding.planItemId, planItemId),
        eq(odontogramEntry.patientId, patientId),
      ),
    )
  return rows.length > 0 && rows.every((row) => row.voidedAt !== null)
}

/**
 * El diagnóstico que sigue porque lo usa otro hallazgo no conserva la cara del que se anuló (QA
 * del 16 nov, Q5). Dos caries de la 47 (oclusal y mesial) con el mismo K02.1 comparten un
 * diagnóstico, que nació con la cara de la primera: al anular la oclusal seguía diciendo «47 ·
 * Oclusal», la cara anulada, y eso es lo que se firma.
 *
 * Un diagnóstico registrado no se reescribe (lo impide la base, `guard_draft_encounter_child`):
 * se anula, diciendo por qué, y se registra de nuevo con las caras de los hallazgos que quedan,
 * unido a ellos. El de la pieza (la pulpitis junto a una caries: sin caras) no se toca, ni el que
 * ya decía bien lo que queda.
 */
async function refaceSharedDiagnoses(
  tx: Db,
  {
    orgId,
    actorUserId,
    patientId,
    encounterId,
    diagnosisIds,
    reason,
  }: EncounterMoment & { diagnosisIds: readonly string[]; reason: string },
): Promise<void> {
  const ids = [...new Set(diagnosisIds)]
  if (ids.length === 0) return
  const diagnoses = await tx
    .select()
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.patientId, patientId),
        eq(encounterDiagnosis.encounterId, encounterId),
        inArray(encounterDiagnosis.id, ids),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
  for (const diagnosis of diagnoses) {
    const tooth = toothOfRow(diagnosis)
    if (tooth == null || diagnosis.siteQualifiers.length === 0) continue
    const live = await tx
      .select({ id: odontogramEntry.id, surface: odontogramEntry.surface })
      .from(diagnosisFinding)
      .innerJoin(
        odontogramEntry,
        and(
          eq(odontogramEntry.organizationId, diagnosisFinding.organizationId),
          eq(odontogramEntry.id, diagnosisFinding.odontogramEntryId),
        ),
      )
      .where(
        and(
          eq(diagnosisFinding.organizationId, orgId),
          eq(diagnosisFinding.diagnosisId, diagnosis.id),
          eq(odontogramEntry.encounterId, encounterId),
          isNull(odontogramEntry.voidedAt),
        ),
      )
      .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id))
    // Sin ningún hallazgo vigente no hay de dónde decir la cara: queda como se registró.
    if (live.length === 0) continue
    const faces = [...new Set(live.flatMap((row) => (row.surface ? [row.surface] : [])))]
    // Sigue diciendo solo caras con hallazgo vigente: no hay nada falso que corregir.
    if (diagnosis.siteQualifiers.every((face) => faces.includes(face))) continue
    await voidEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, diagnosis.id, {
      reason: `Se anuló el hallazgo de esa cara (${reason.slice(0, 1800)}): el diagnóstico sigue, con la cara que queda.`,
    })
    const next = await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
      diagnosisCode: diagnosis.diagnosisCode,
      diagnosisSystem: diagnosis.diagnosisSystem,
      diagnosisType: diagnosis.diagnosisType,
      toothNumber: tooth,
      surfaces: faces,
      note: diagnosis.note,
    })
    await linkDiagnosisFinding(tx, { orgId, patientId, diagnosisId: next.id, entryIds: live.map((row) => row.id) })
  }
}

/**
 * Anula esos hallazgos con su motivo, como «Anular» en la pieza (`voidOdontogramEntry`). El
 * diagnóstico que sigue porque lo usa otro hallazgo deja de decir la cara del que se anuló; los
 * que caen en la misma corrección (`voidingDiagnosisIds`) no se tocan: se anulan enseguida.
 */
export async function voidCorrectionFindings(
  tx: Db,
  {
    orgId,
    actorUserId,
    patientId,
    encounterId,
    ids,
    reason,
    voidingDiagnosisIds = [],
  }: EncounterMoment & { ids: string[]; reason: string; voidingDiagnosisIds?: readonly string[] },
): Promise<void> {
  const linked =
    ids.length === 0
      ? []
      : await tx
          .select({ diagnosisId: diagnosisFinding.diagnosisId })
          .from(diagnosisFinding)
          .where(and(eq(diagnosisFinding.organizationId, orgId), inArray(diagnosisFinding.odontogramEntryId, ids)))
  for (const id of ids) await voidOdontogramEntry(tx, orgId, actorUserId, id, patientId, reason)
  await refaceSharedDiagnoses(tx, {
    orgId,
    actorUserId,
    patientId,
    encounterId,
    diagnosisIds: linked.map((row) => row.diagnosisId).filter((id) => !voidingDiagnosisIds.includes(id)),
    reason,
  })
}

/**
 * Las caras con caries y restauración definitiva vigentes a la vez, si alguna de las dos se
 * registró en esta atención (QA del 16 nov, C41). Clínicamente suele ser caries bajo la
 * restauración: el cierre lo avisa y propone registrarla como restauración en mal estado.
 * Las dos puertas son a propósito (el hallazgo es lo que se ve; lo tratado lo dibuja el
 * servicio): por eso avisa y no frena.
 *
 * Lo que se trata en esta atención no cuenta (revisión del 16 nov, R4): la caries O de la 16 y la
 * resina O hecha hoy son la caries y su tratamiento, no caries bajo la restauración. Ni la caries
 * unida a un tratamiento registrado hoy (se resuelve al firmar), ni la restauración que dibujó un
 * tratamiento registrado hoy.
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
      treatedHere: sql<boolean>`(
        exists (select 1 from dental.plan_item_finding link
          join encounter_procedure today on today.organization_id = link.organization_id
            and today.plan_item_id = link.plan_item_id
          where link.organization_id = dental.odontogram_entry.organization_id
            and link.odontogram_entry_id = dental.odontogram_entry.id
            and today.encounter_id = ${encounterId}::uuid and today.voided_at is null)
        or (dental.odontogram_entry.left_by_plan_item_id is not null and exists (select 1 from encounter_procedure today
          where today.organization_id = dental.odontogram_entry.organization_id
            and today.plan_item_id = dental.odontogram_entry.left_by_plan_item_id
            and today.encounter_id = ${encounterId}::uuid and today.voided_at is null)))`,
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
  return cariesOnRestoredFaces(
    rows.filter((row) => !row.treatedHere),
    encounterId,
  )
}
