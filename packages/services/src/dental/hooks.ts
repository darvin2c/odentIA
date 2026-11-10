import {
  CORE_VITAL_KEYS,
  DENTAL_IMAGING_TYPES,
  diagnosisCodeLabel,
  findingDiagnosisCode,
  isDiagnosisSystem,
  SUGGESTED_CONSENT_TEMPLATES,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  encounterPlanItem,
  serviceCatalog,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import {
  dentalTemplateRule,
  odontogramAssessment,
  odontogramEntry,
  periodontalChart,
  periodontalTooth,
  planItemFinding,
} from "@odentia/db/schema/dental"
import { auditEvent } from "@odentia/db/schema/org"
import {
  dentalDiagnosisPattern,
  emptyPeriodontalTooth,
  findingDefinition,
  type PeriodontalToothRecord,
  pendingProbingWords,
  phaseForKind,
  SIGNED_ODONTOGRAM_PURPOSE_LABELS,
  TREATMENT_PHASE_LABELS,
  TREATMENT_PHASES,
} from "@odentia/dental"
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import { notFound } from "../errors.js"
import type { TimelineItem } from "../patient-history.js"
import { DENTAL_PRESCRIBING, type DiagnosisCandidate, type ProductHooks } from "../product-hooks.js"
import { dentalCatalog } from "./catalog.js"
import { DENTAL_DICTATION } from "./dictation.js"
import { dentalExamination } from "./examination.js"
import { dentalInterview } from "./interview.js"
import {
  type ClosingOdontogram,
  closingOdontogramOf,
  getOdontogram,
  type OdontogramAssessmentRow,
  odontogramLines,
  signClosingOdontogram,
} from "./odontogram.js"
import { latestPeriodontalBrief, periodontalBriefsByEncounter } from "./periodontal.js"
import { findingsOf, linkPlanItemFinding, withPlanItemDental } from "./plan-finding.js"
import { lesionRowsOf, treatedByItem } from "./lesion.js"
import { dentalProductSite, dentalSiteOfRow, siteColumns, surfaceWords } from "./site.js"
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
 * nació de un hallazgo deja esa lesión como tratada (sigue en la historia,
 * pero ya no es un problema por tratar). Una caries de dos caras es una
 * lesión: se tratan sus caras juntas, o solo las que cubre una resina
 * (`treatedByItem`).
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
    .select({
      id: treatmentPlanItem.id,
      entryId: planItemFinding.odontogramEntryId,
      siteSystem: treatmentPlanItem.siteSystem,
      siteCode: treatmentPlanItem.siteCode,
      siteQualifiers: treatmentPlanItem.siteQualifiers,
    })
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
    const lesion = await lesionRowsOf(tx, orgId, item.entryId)
    const rows = treatedByItem(lesion, item.entryId, dentalSiteOfRow(item).surfaces)
    const open = rows.filter((row) => row.resolvedAt === null).map((row) => row.id)
    if (open.length === 0) continue
    const resolved = await tx
      .update(odontogramEntry)
      .set({ resolvedAt: at, resolvedBy: actorUserId, resolvedByPlanItemId: item.id })
      .where(
        and(
          inArray(odontogramEntry.id, open),
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          isNull(odontogramEntry.resolvedAt),
          isNull(odontogramEntry.voidedAt),
        ),
      )
      .returning({ id: odontogramEntry.id })
    for (const entry of resolved)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "odontogram.entry_resolved",
        entity: "odontogram_entry",
        entityId: entry.id,
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
  site: dentalProductSite,
  prescribing: DENTAL_PRESCRIBING,
  imaging: DENTAL_IMAGING_TYPES,
  imagingStudy: "tomografia",
  consentSuggestions: SUGGESTED_CONSENT_TEMPLATES,
  interview: dentalInterview,
  examination: dentalExamination,
  vitals: CORE_VITAL_KEYS,
  catalog: dentalCatalog,
  dictation: DENTAL_DICTATION,
  budgetRequired: true,
  asksAsa: true,
  recallMonths: 6,
  recallControlTitle: "Control de mantenimiento",

  async closingParts(tx, { orgId, patientId, encounterId, finishingPlanItemIds }) {
    const parts: DentalClosingParts = {
      // En clínicas de Perú, el odontograma que firmará este cierre, con lo que se termina al firmar.
      odontogram: await closingOdontogramOf(tx, orgId, patientId, encounterId, finishingPlanItemIds),
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
    await yearlyRadiographicControl(tx, { orgId, actorUserId, patientId, encounterId, item: row })
  },

  async treatmentUndone(
    tx,
    { orgId, actorUserId, patientId, encounterId, planItemId, reason, at },
  ) {
    await voidLeftFindings(tx, orgId, actorUserId, patientId, encounterId, planItemId, reason, at)
    // Sin endodoncia terminada no hay cicatrización que controlar: el control del año se cancela.
    const cancelled = await tx
      .update(clinicalFollowUp)
      .set({ status: "cancelado", cancelledReason: reason.slice(0, 2000), cancelledAt: at, updatedAt: at })
      .where(
        and(
          eq(clinicalFollowUp.organizationId, orgId),
          eq(clinicalFollowUp.planItemId, planItemId),
          sql`${clinicalFollowUp.title} like ${`${radiographicControlTitle()}%`}`,
          eq(clinicalFollowUp.status, "pendiente"),
        ),
      )
      .returning({ id: clinicalFollowUp.id })
    for (const control of cancelled)
      await tx.insert(auditEvent).values({
        organizationId: orgId,
        actorUserId,
        action: "follow_up.cancelled",
        entity: "clinical_follow_up",
        entityId: control.id,
        metadata: { patientId, planItemId, reason },
      })
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
        `Pieza ${t.tooth}: ${t.label}${t.surfaces.length ? ` (${surfaceWords(t.surfaces)})` : ""}`,
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

  planPhases: TREATMENT_PHASES,
  phaseFor: (kind) => phaseForKind(kind),
  // Entre sesiones de una endodoncia se deja la medicación intraconducto (hidróxido de calcio) al
  // menos una semana: con 7 días el conducto quedó sin bacterias y con 10 minutos no (Sjögren y
  // col., Int Endod J 1991;24:119-125). La AAE y la ESE no fijan un plazo; es un mínimo que se
  // propone, no que se exige: la reserva deja elegir antes si hace falta (QA del 9 nov, repaso 3).
  sessionGapDays: (kind) => (kind === "endodoncia" ? 7 : null),
  // Una consulta, una evaluación o una radiografía no piden «Falta otra sesión».
  oneOffKinds: ["diagnostico"],
  phaseWords: (phase) =>
    TREATMENT_PHASE_LABELS[phase as keyof typeof TREATMENT_PHASE_LABELS] ?? null,

  // El odontograma firmado no cambia ni se anula: si existe, está vigente.
  async documentCheck(tx, orgId, type, id) {
    if (type !== "signed_odontogram") return null
    const [row] = await tx
      .select()
      .from(odontogramAssessment)
      .where(and(eq(odontogramAssessment.id, id), eq(odontogramAssessment.organizationId, orgId)))
      .limit(1)
    if (!row) return null
    return {
      patientId: row.patientId,
      patientName: row.patientName,
      state: "vigente",
      label: "Odontograma firmado",
      issuedAt: row.createdAt,
      validUntil: null,
      voidedAt: null,
      signer: {
        name: row.examinerName,
        title: row.examinerTitle,
        registration: row.registrationNumber,
      },
    }
  },

  async templateSurfaceLimits(tx, templateId) {
    const [rule] = await tx
      .select({ min: dentalTemplateRule.surfaceCountMin, max: dentalTemplateRule.surfaceCountMax })
      .from(dentalTemplateRule)
      .where(eq(dentalTemplateRule.templateId, templateId))
      .limit(1)
    return rule ?? { min: null, max: null }
  },

  async planItemCreated(tx, { orgId, patientId, item, input }) {
    // Trazabilidad clínica: la indicación responde a un hallazgo real del paciente.
    const entryId = typeof input.odontogramEntryId === "string" ? input.odontogramEntryId : null
    if (!entryId) return
    const [entry] = await tx
      .select({ id: odontogramEntry.id })
      .from(odontogramEntry)
      .where(
        and(
          eq(odontogramEntry.id, entryId),
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          isNull(odontogramEntry.voidedAt),
        ),
      )
    if (!entry) throw notFound("Hallazgo del odontograma")
    await linkPlanItemFinding(tx, item, entryId)
  },

  async planItemParts(tx, orgId, itemIds) {
    const findings = await findingsOf(tx, orgId, itemIds)
    return new Map(itemIds.map((id) => [id, { odontogramEntryId: findings.get(id) ?? null }]))
  },

  async journeyParts(tx, { orgId, patientId, planItemId }) {
    const entryId = (await findingsOf(tx, orgId, [planItemId])).get(planItemId)
    const [originFinding] = entryId
      ? await tx
          .select()
          .from(odontogramEntry)
          .where(
            and(
              eq(odontogramEntry.id, entryId),
              eq(odontogramEntry.organizationId, orgId),
              eq(odontogramEntry.patientId, patientId),
            ),
          )
      : []
    return { originFinding: originFinding ?? null }
  },

  async diagnosisCandidates(tx, { orgId, system, patientId, encounterId, finding }) {
    if (!isDiagnosisSystem(system)) return []
    const candidates: DiagnosisCandidate[] = []
    const add = (
      condition: string,
      variant: string | null,
      toothNumber: number | null,
      surfaces: string[],
    ) => {
      const code = findingDiagnosisCode(system, condition, variant)
      if (code)
        candidates.push({
          code,
          finding: findingDefinition(condition)?.label ?? condition,
          site: siteColumns({ toothNumber, surfaces }),
        })
    }
    // Lo que se está marcando en la pieza.
    if (finding && typeof finding.condition === "string")
      add(
        finding.condition,
        typeof finding.variant === "string" ? finding.variant : null,
        typeof finding.toothNumber === "number" ? finding.toothNumber : null,
        Array.isArray(finding.surfaces) ? finding.surfaces.map(String) : [],
      )
    // Los hallazgos de esta atención.
    if (patientId && encounterId)
      for (const entry of await tx
        .select({
          condition: odontogramEntry.condition,
          details: odontogramEntry.details,
          toothNumber: odontogramEntry.toothNumber,
          surface: odontogramEntry.surface,
        })
        .from(odontogramEntry)
        .where(
          and(
            eq(odontogramEntry.organizationId, orgId),
            eq(odontogramEntry.patientId, patientId),
            eq(odontogramEntry.encounterId, encounterId),
            isNull(odontogramEntry.voidedAt),
          ),
        )
        .orderBy(asc(odontogramEntry.createdAt))) {
        const variant = (entry.details as { variant?: unknown } | null)?.variant
        add(
          entry.condition,
          typeof variant === "string" ? variant : null,
          entry.toothNumber,
          entry.surface ? [entry.surface] : [],
        )
      }
    return candidates
  },

  preferredDiagnoses(system) {
    // Lo odontológico primero: la boca, sus tumores, fisuras y las urgencias dentales.
    return isDiagnosisSystem(system) ? dentalDiagnosisPattern(system) : null
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

/** Las familias de la biblioteca que son un tratamiento de conductos (`seeds/biblioteca_piezas.csv`). */
const ROOT_CANAL_FAMILIES = new Set([
  "endodoncia-vital",
  "endodoncia-no-vital",
  "endodoncia-bicuspide-raices",
  "retratamiento",
  "pulpectomia-deciduo",
])

/** El título del control de cicatrización de la endodoncia: el mismo al crearlo y al cancelarlo. */
function radiographicControlTitle(): string {
  return "Control radiográfico de la endodoncia"
}

/**
 * Al terminar una endodoncia (o una pulpectomía) queda, además del control corto que se indique,
 * su control clínico y radiográfico al año: la lesión periapical se da por sanada recién ahí
 * (ESE, Quality guidelines for endodontic treatment, Int Endod J 2006;39:921-930; QA del 9 nov,
 * repaso 3, M2). Uno solo por tratamiento; quien atienda ese control decide si hacen falta más.
 */
async function yearlyRadiographicControl(
  tx: Db,
  scope: { orgId: string; actorUserId: string; patientId: string; encounterId: string; item: typeof treatmentPlanItem.$inferSelect },
): Promise<void> {
  const { orgId, actorUserId, patientId, encounterId, item } = scope
  if (!item.serviceId) return
  // Solo la endodoncia de verdad (con su familia en la biblioteca: vital, no vital, retratamiento,
  // pulpectomía): un recubrimiento pulpar o una pulpotomía son del mismo tipo y no llevan este control.
  const [service] = await tx
    .select({ family: dentalTemplateRule.family })
    .from(serviceCatalog)
    .innerJoin(dentalTemplateRule, eq(dentalTemplateRule.templateId, serviceCatalog.templateId))
    .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, item.serviceId)))
    .limit(1)
  if (!service?.family || !ROOT_CANAL_FAMILIES.has(service.family)) return
  // Con la pieza: dos endodoncias del mismo día dejaban dos controles iguales (QA antes de entregar).
  const title = item.siteCode ? `${radiographicControlTitle()} · pieza ${item.siteCode}` : radiographicControlTitle()
  const [already] = await tx
    .select({ id: clinicalFollowUp.id })
    .from(clinicalFollowUp)
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.planItemId, item.id),
        eq(clinicalFollowUp.title, title),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
    .limit(1)
  if (already) return
  const dueAt = new Date()
  dueAt.setUTCFullYear(dueAt.getUTCFullYear() + 1)
  const [row] = await tx
    .insert(clinicalFollowUp)
    .values({
      organizationId: orgId,
      patientId,
      kind: "tratamiento",
      title,
      dueAt,
      planItemId: item.id,
      originEncounterId: encounterId,
      createdBy: actorUserId,
    })
    .returning({ id: clinicalFollowUp.id })
  if (row)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "follow_up.created",
      entity: "clinical_follow_up",
      entityId: row.id,
      metadata: { patientId, planItemId: item.id, by: "endodoncia_terminada" },
    })
}
