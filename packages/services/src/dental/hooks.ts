import { diagnosisCodeLabel } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { encounterPlanItem, treatmentPlanItem } from "@odentia/db/schema/clinical"
import {
  odontogramAssessment,
  odontogramEntry,
  periodontalChart,
  periodontalTooth,
  planItemFinding,
} from "@odentia/db/schema/dental"
import { auditEvent } from "@odentia/db/schema/org"
import {
  emptyPeriodontalTooth,
  type PeriodontalToothRecord,
  pendingProbingWords,
  SIGNED_ODONTOGRAM_PURPOSE_LABELS,
} from "@odentia/dental"
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import type { TimelineItem } from "../patient-history.js"
import type { ProductHooks } from "../product-hooks.js"
import {
  type ClosingOdontogram,
  closingOdontogramOf,
  getOdontogram,
  type OdontogramAssessmentRow,
  odontogramLines,
  signClosingOdontogram,
} from "./odontogram.js"
import { latestPeriodontalBrief, periodontalBriefsByEncounter } from "./periodontal.js"
import { withPlanItemDental } from "./plan-finding.js"
import { drawTreatedFinding, voidLeftFindings } from "./treated-findings.js"

/**
 * Lo que hace odentIA en los momentos de lo común (ADR 0079): el odontograma,
 * el periodontograma y lo tratado. Lo común lo pide por `products.ts`.
 */

/** El periodontograma de la atención para el cierre: cuántas piezas y qué falta. */
export interface ClosingPeriodontal {
  /** Piezas naturales e implantes que se sondean. */
  teeth: number
  implants: number
  /** Lo que falta sondear en palabras («abajo por fuera, de la 43 a la 47»); null si está completo. */
  pending: string | null
}

async function closingPeriodontalOf(
  tx: Db,
  orgId: string,
  encounterId: string,
): Promise<ClosingPeriodontal | null> {
  const [chart] = await tx
    .select({
      id: periodontalChart.id,
      expectedTeeth: periodontalChart.expectedTeeth,
      implantTeeth: periodontalChart.implantTeeth,
    })
    .from(periodontalChart)
    .where(
      and(
        eq(periodontalChart.organizationId, orgId),
        eq(periodontalChart.encounterId, encounterId),
      ),
    )
    .limit(1)
  if (!chart) return null
  const rows = await tx
    .select({
      toothNumber: periodontalTooth.toothNumber,
      skipped: periodontalTooth.skipped,
      probingDepth: periodontalTooth.probingDepth,
    })
    .from(periodontalTooth)
    .where(and(eq(periodontalTooth.organizationId, orgId), eq(periodontalTooth.chartId, chart.id)))
  const stored = new Map(rows.map((row) => [row.toothNumber, row]))
  const teeth: PeriodontalToothRecord[] = chart.expectedTeeth.map((tooth) => ({
    ...emptyPeriodontalTooth(tooth),
    ...(stored.get(tooth) ?? {}),
  }))
  return {
    teeth: chart.expectedTeeth.length - chart.implantTeeth.length,
    implants: chart.implantTeeth.length,
    pending: pendingProbingWords(teeth, chart.expectedTeeth),
  }
}

/**
 * Hallazgos tratados al cerrar: cada indicación realizada en la atención que
 * nació de un hallazgo deja ese hallazgo como tratado (sigue en la historia,
 * pero ya no es un problema por tratar).
 */
async function resolveTreatedFindings(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  at: Date,
): Promise<void> {
  const items = await tx
    .select({ id: treatmentPlanItem.id, entryId: planItemFinding.odontogramEntryId })
    .from(encounterPlanItem)
    .innerJoin(treatmentPlanItem, eq(treatmentPlanItem.id, encounterPlanItem.planItemId))
    .innerJoin(planItemFinding, eq(planItemFinding.planItemId, treatmentPlanItem.id))
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.status, "realizado"),
      ),
    )
  for (const item of items) {
    const [resolved] = await tx
      .update(odontogramEntry)
      .set({ resolvedAt: at, resolvedBy: actorUserId, resolvedByPlanItemId: item.id })
      .where(
        and(
          eq(odontogramEntry.id, item.entryId),
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          isNull(odontogramEntry.resolvedAt),
          isNull(odontogramEntry.voidedAt),
        ),
      )
      .returning({ id: odontogramEntry.id })
    if (resolved)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "odontogram.entry_resolved",
        entity: "odontogram_entry",
        entityId: resolved.id,
        metadata: { patientId, encounterId, planItemId: item.id },
      })
  }
}

/** Lo que odentIA agrega al «¿se puede cerrar?». */
export interface DentalClosingParts {
  odontogram: ClosingOdontogram | null
  periodontal: ClosingPeriodontal | null
}

/** Lo que odentIA agrega a lo que informa el cierre: el odontograma que firmó. */
export interface DentalFinalizeParts {
  odontogram: Pick<OdontogramAssessmentRow, "id" | "purpose"> | null
}

/** Lo que odentIA agrega al detalle de la atención. */
export interface DentalEncounterDetailParts {
  odontogramEntries: Array<typeof odontogramEntry.$inferSelect>
}

export const dentalHooks: ProductHooks = {
  async closingParts(tx, { orgId, patientId, encounterId }) {
    const parts: DentalClosingParts = {
      // En clínicas de Perú, el odontograma que firmará este cierre.
      odontogram: await closingOdontogramOf(tx, orgId, patientId, encounterId),
      // A medias no bloquea: se firma como parcial (ADR 0054).
      periodontal: await closingPeriodontalOf(tx, orgId, encounterId),
    }
    return { ...parts }
  },

  async encounterDetailParts(tx, { orgId, encounterId }) {
    return {
      odontogramEntries: await tx
        .select()
        .from(odontogramEntry)
        .where(
          and(
            eq(odontogramEntry.encounterId, encounterId),
            eq(odontogramEntry.organizationId, orgId),
          ),
        )
        .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id)),
    }
  },

  async encounterFinalized(tx, { orgId, actorUserId, patientId, encounterId, at, signer }) {
    await resolveTreatedFindings(tx, orgId, actorUserId, patientId, encounterId, at)
    // En Perú, la atención que cambió el gráfico firma el odontograma con el
    // mismo perfil y en el mismo paso (NTS 188, 5.3 y 5.10).
    const odontogram = await signClosingOdontogram(
      tx,
      orgId,
      actorUserId,
      patientId,
      encounterId,
      signer,
    )
    return { odontogram: odontogram ? { id: odontogram.id, purpose: odontogram.purpose } : null }
  },

  async encounterVoided(tx, { orgId, actorUserId, patientId, encounterId, at, reason }) {
    await tx
      .update(odontogramEntry)
      .set({
        status: "voided",
        voidedAt: at,
        voidedBy: actorUserId,
        voidReason: reason,
        updatedAt: at,
      })
      .where(
        and(
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          eq(odontogramEntry.encounterId, encounterId),
          isNull(odontogramEntry.voidedAt),
          ne(odontogramEntry.status, "voided"),
        ),
      )
  },

  async treatmentDone(tx, { orgId, actorUserId, patientId, encounterId, planItemId }) {
    const [row] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
      .limit(1)
    if (!row) return
    await drawTreatedFinding(
      tx,
      orgId,
      actorUserId,
      patientId,
      encounterId,
      await withPlanItemDental(tx, orgId, row),
    )
  },

  async treatmentUndone(
    tx,
    { orgId, actorUserId, patientId, encounterId, planItemId, reason, at },
  ) {
    await voidLeftFindings(tx, orgId, actorUserId, patientId, encounterId, planItemId, reason, at)
  },

  async summaryParts(tx, { orgId, patientId }) {
    const odontogram = await getOdontogram(tx, orgId, patientId)
    const findings = new Map(odontogram.history.map((entry) => [entry.id, entry]))
    return {
      activeDiagnoses: Object.entries(odontogram.teeth)
        .flatMap(([toothNumber, tooth]) =>
          [
            ...new Set(
              tooth.entries
                .map((id) => findings.get(id)?.condition)
                .filter((condition): condition is string => !!condition && condition !== "healthy"),
            ),
          ].map((condition) => ({
            toothNumber: Number(toothNumber),
            condition,
            status: "recorded",
          })),
        )
        .slice(0, 20),
      // «Encías»: el último periodontograma firmado y el último diagnóstico confirmado.
      periodontal: await latestPeriodontalBrief(tx, orgId, patientId),
    }
  },

  async recordSections(tx, { orgId, patientId }) {
    const lines = (await odontogramLines(tx, orgId, patientId)).map(
      (t) =>
        `Pieza ${t.tooth}: ${t.label}${t.surfaces.length ? ` (${t.surfaces.join(", ")})` : ""}`,
    )
    return [{ title: "Odontograma vigente", lines, empty: "Sin hallazgos registrados." }]
  },

  timelineSources({ orgId, patientId, types, outsideEncountersOnly, tooth }) {
    const sources = []
    if (types.includes("odontogram"))
      sources.push(
        sql`select id, 'odontogram'::text as kind, created_at from odontogram_entry where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${outsideEncountersOnly ? sql`and encounter_id is null` : sql``} and voided_at is null and status <> 'voided' ${tooth == null ? sql`` : sql`and (tooth_number = ${tooth} or details->'relatedTeeth' @> ${JSON.stringify([tooth])}::jsonb)`}`,
      )
    if (types.includes("odontogram_signed") && tooth == null)
      sources.push(
        sql`select id, 'odontogram_signed'::text as kind, created_at from odontogram_assessment where organization_id = ${orgId} and patient_id = ${patientId}::uuid ${outsideEncountersOnly ? sql`and encounter_id is null` : sql``}`,
      )
    return sources
  },

  async timelineItems(tx, orgId, idsOf) {
    const items = new Map<string, TimelineItem>()
    const entries = idsOf("odontogram")
    if (entries.length)
      for (const row of await tx
        .select()
        .from(odontogramEntry)
        .where(
          and(eq(odontogramEntry.organizationId, orgId), inArray(odontogramEntry.id, entries)),
        )) {
        const details = row.details as { relatedTeeth?: number[] }
        const teeth = details.relatedTeeth ?? [row.toothNumber]
        items.set(row.id, {
          id: row.id,
          refId: row.id,
          type: "odontogram",
          createdAt: row.createdAt,
          title: `${teeth.length > 1 ? "Piezas" : "Pieza"} ${teeth.join(", ")}`,
          detail: row.note,
          condition: row.condition,
          surface: row.surface,
          status: row.status,
          diagnosisCode: row.diagnosisCode
            ? diagnosisCodeLabel(row.diagnosisSystem, row.diagnosisCode)
            : null,
          toothNumbers: teeth,
          authorId: row.createdBy,
          // El hallazgo se registra dentro de una atención: la historia lo agrupa con ella.
          encounterId: row.encounterId ?? null,
        })
      }
    const signed = idsOf("odontogram_signed")
    if (signed.length)
      for (const row of await tx
        .select()
        .from(odontogramAssessment)
        .where(
          and(
            eq(odontogramAssessment.organizationId, orgId),
            inArray(odontogramAssessment.id, signed),
          ),
        )) {
        const purpose =
          SIGNED_ODONTOGRAM_PURPOSE_LABELS[
            row.purpose as keyof typeof SIGNED_ODONTOGRAM_PURPOSE_LABELS
          ] ?? row.purpose
        items.set(row.id, {
          id: row.id,
          refId: row.id,
          type: "odontogram_signed",
          createdAt: row.createdAt,
          title: `Odontograma firmado · ${purpose}`,
          detail: `${row.examinerName} · ${row.registrationNumber}`,
          toothNumbers: [],
          authorId: row.authorUserId,
          encounterId: row.encounterId ?? null,
        })
      }
    return items
  },

  async encounterParts(tx, orgId, encounterIds) {
    // El periodontograma de la atención: un hecho de ella (ADR 0054).
    const briefs = await periodontalBriefsByEncounter(tx, orgId, encounterIds)
    return new Map(encounterIds.map((id) => [id, { periodontal: briefs.get(id) ?? null }]))
  },
}
