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
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { issuedPaper } from "@odentia/db/schema/clinical-forms"
import {
  dentalTemplateRule,
  odontogramAssessment,
  odontogramEntry,
  periodontalChart,
  periodontalTooth,
  planItemFinding,
  serviceFinding,
} from "@odentia/db/schema/dental"
import { auditEvent } from "@odentia/db/schema/org"
import {
  dentalDiagnosisPattern,
  emptyPeriodontalTooth,
  findingDefinition,
  type PeriodontalToothRecord,
  pendingProbingWords,
  isSurgicalLibraryKey,
  phaseForTreatment,
  type SameFaceFinding,
  SIGNED_ODONTOGRAM_PURPOSE_LABELS,
  SIGNED_ODONTOGRAM_PURPOSE_SHORT,
  type SignedOdontogramPurpose,
  TREATMENT_PHASE_LABELS,
  TREATMENT_PHASES,
} from "@odentia/dental"
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"
import { notFound } from "../errors.js"
import { serviceKindOf } from "../specialties.js"
import type { TimelineItem } from "../patient-history.js"
import {
  DENTAL_PRESCRIBING,
  type DiagnosisCandidate,
  type ProductHooks,
  type RecordPaper,
} from "../product-hooks.js"
import { DENTAL_FORMS } from "./forms.js"
import { dentalRecordSections } from "./record-sections.js"
import { dentalCatalog } from "./catalog.js"
import { DENTAL_DICTATION } from "./dictation.js"
import { dentalExamination } from "./examination.js"
import { dentalInterview } from "./interview.js"
import {
  type ClosingOdontogram,
  closingOdontogramOf,
  getOdontogram,
  hasSignedOdontogram,
  listOdontogramAssessments,
  type OdontogramAssessmentRow,
  odontogramLines,
  signClosingOdontogram,
} from "./odontogram.js"
import {
  odontogramSignerWords,
  signedOdontogramLabel,
  signedOdontogramPaper,
  todayOdontogramPaper,
} from "./odontogram-pdf.js"
import { latestPeriodontalBrief, periodontalBriefsByEncounter } from "./periodontal.js"
import {
  correctionFindings,
  planItemLostItsFinding,
  sameFaceFindings,
  voidCorrectionFindings,
} from "./finding-correction.js"
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
  /**
   * Ya tiene su odontograma firmado en curso (`hasSignedOdontogram`): lo que hoy solo trata no
   * pide registrar el odontograma. En la primera atención, sí.
   */
  odontogramSignedBefore: boolean
  periodontal: ClosingPeriodontal | null
  /** Caras con caries y restauración a la vez, alguna de hoy: un aviso suave (C41). */
  sameFace: SameFaceFinding[]
}

/** Lo que odentIA agrega a lo que informa el cierre: el odontograma que firmó. */
export interface DentalFinalizeParts {
  odontogram: Pick<OdontogramAssessmentRow, "id" | "purpose"> | null
}

/** Lo que odentIA agrega al detalle de la atención. */
export interface DentalEncounterDetailParts {
  odontogramEntries: Array<typeof odontogramEntry.$inferSelect>
}

/**
 * Los tipos de la biblioteca que son cirugía sobre el hueso de los maxilares: la cirugía oral y el
 * implante. Con la exodoncia, son lo que avisa de lo que toma (anticoagulante, medicina para los
 * huesos) en la fila del plan.
 */
const SURGICAL_KINDS: ReadonlySet<string | null> = new Set(["cirugia", "implantologia"])

export const dentalHooks: ProductHooks = {
  site: dentalProductSite,
  prescribing: DENTAL_PRESCRIBING,
  imaging: DENTAL_IMAGING_TYPES,
  imagingStudy: "tomografia",
  consentSuggestions: SUGGESTED_CONSENT_TEMPLATES,
  forms: DENTAL_FORMS,
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
      odontogramSignedBefore: await hasSignedOdontogram(tx, orgId, patientId),
      // A medias no bloquea: se firma como parcial (ADR 0054).
      periodontal: await closingPeriodontalOf(tx, orgId, encounterId),
      sameFace: await sameFaceFindings(tx, orgId, patientId, encounterId),
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
    // En Perú, la atención que llega a un momento de la norma (inicio, hallazgos
    // observados hoy o culminación) firma el odontograma con el mismo perfil y en
    // el mismo paso (NTS 188, 5.3 y 5.10). La que solo trata, no.
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

  correction: {
    findings: correctionFindings,
    voidFindings: voidCorrectionFindings,
    itemLostItsFinding: planItemLostItsFinding,
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
    // Los controles que dejó al terminar los retira `undoFinishControls`, en lo común (B5).
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

  // El odontograma de hoy por pieza (FDI en FHIR) y cada periodontograma como tabla (mesa del 18 nov).
  recordSections: (tx, { orgId, patientId }) => dentalRecordSections(tx, orgId, patientId),

  // Cada odontograma firmado es su papel emitido (el mismo que se ve y se imprime), del
  // más antiguo al más reciente, con su momento; después, el de hoy, marcado «sin firmar»
  // y sin guardar, porque cambia con cada atención; sin hallazgos ni firmados, no va.
  // Fuera de Perú no se firma: solo va el de hoy, en la hoja neutra, si tiene hallazgos.
  async recordPapers(tx, { orgId, patientId }, storage) {
    const signed = (await listOdontogramAssessments(tx, orgId, patientId)).reverse()
    // Lo ya guardado dice cuánto pesa: contar lo que trae la copia no dibuja ni guarda nada.
    const stored = signed.length
      ? await tx
          .select({ id: issuedPaper.documentId, size: issuedPaper.sizeBytes })
          .from(issuedPaper)
          .where(
            and(
              eq(issuedPaper.organizationId, orgId),
              eq(issuedPaper.documentType, "signed_odontogram"),
              inArray(
                issuedPaper.documentId,
                signed.map((row) => row.id),
              ),
            ),
          )
      : []
    const sizes = new Map(stored.map((row) => [row.id, row.size]))
    const papers: RecordPaper[] = signed.map((row) => {
      const purpose = row.purpose as SignedOdontogramPurpose
      return {
        kind: "signed_odontogram",
        id: row.id,
        label: signedOdontogramLabel(purpose),
        at: new Date(row.createdAt),
        fileName: `Odontograma firmado - ${SIGNED_ODONTOGRAM_PURPOSE_SHORT[purpose]} (${row.id.slice(0, 8)}).pdf`,
        mark: null,
        signer: odontogramSignerWords(row),
        size: sizes.get(row.id) ?? null,
        // El papel emitido (con su huella): se lee, o se dibuja y se guarda la primera vez.
        render: async (sp) =>
          (await signedOdontogramPaper(sp, orgId, patientId, row.id, storage, { viewing: true })).bytes,
      }
    })
    const today = await todayOdontogramPaper(tx, orgId, patientId, { always: signed.length > 0 })
    if (today)
      papers.push({
        kind: "odontogram_today",
        id: `hoy-${patientId}`,
        label: `Odontograma · Estado al ${today.dayWords}`,
        at: today.at,
        fileName: `Odontograma de hoy - sin firmar (${today.isoDay}).pdf`,
        mark: "sin firmar",
        signer: null,
        size: null,
        render: () => today.render(),
      })
    return papers
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
  phaseFor: (kind, diagnoses, libraryKey) => phaseForTreatment(kind, diagnoses, libraryKey),
  async treatmentFamiliesOf(tx, templateIds) {
    if (templateIds.length === 0) return new Map()
    const rows = await tx
      .select({
        templateId: dentalTemplateRule.templateId,
        leaves: dentalTemplateRule.leavesCondition,
        family: dentalTemplateRule.family,
      })
      .from(dentalTemplateRule)
      .where(inArray(dentalTemplateRule.templateId, [...templateIds]))
    return new Map(
      rows.map((row) => [
        row.templateId,
        [row.leaves, row.family].filter((tag): tag is string => !!tag),
      ]),
    )
  },
  // La cirugía que cambia lo que toma: la exodoncia, el servicio que deja la pieza ausente
  // (`dental.service_finding`), y el implante y la cirugía oral, por su tipo en la biblioteca
  // (`SURGICAL_KINDS`). AAOMS 2022: el riesgo de osteonecrosis es de la cirugía dentoalveolar que
  // expone hueso, no solo de la extracción; SDCEP 2022: el implante y el colgajo sangran más.
  async extractionServiceIds(tx, orgId, serviceIds) {
    if (serviceIds.length === 0) return new Set()
    const rows = await tx
      .select({ serviceId: serviceFinding.serviceId })
      .from(serviceFinding)
      .where(
        and(
          eq(serviceFinding.organizationId, orgId),
          inArray(serviceFinding.serviceId, [...serviceIds]),
          eq(serviceFinding.condition, "missing_tooth"),
        ),
      )
    const out = new Set(rows.map((row) => row.serviceId))
    const services = await tx
      .select({
        id: serviceCatalog.id,
        templateId: serviceCatalog.templateId,
        specialtyId: serviceCatalog.specialtyId,
        libraryKey: treatmentTemplate.key,
      })
      .from(serviceCatalog)
      .leftJoin(treatmentTemplate, eq(treatmentTemplate.id, serviceCatalog.templateId))
      .where(and(eq(serviceCatalog.organizationId, orgId), inArray(serviceCatalog.id, [...serviceIds])))
    for (const service of services) {
      if (out.has(service.id)) continue
      const key = service.libraryKey
      // La cirugía que la biblioteca pone en otra especialidad (`isSurgicalLibraryKey`).
      if (isSurgicalLibraryKey(key)) out.add(service.id)
      else if (SURGICAL_KINDS.has(await serviceKindOf(tx, orgId, service))) out.add(service.id)
    }
    return out
  },
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
          // Firmado al cerrar sin colegiatura (ADR 0200): solo el nombre.
          detail: [row.examinerName, row.registrationNumber].filter(Boolean).join(" · "),
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
