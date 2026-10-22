/**
 * Periodontograma (issue 49, ADR 0054): uno por atención, escrito por quien la
 * lleva mientras está en borrador y fijo al firmarla. Las reglas clínicas
 * (sitios, índices, propuesta de 2017, comparación) viven en
 * `@odentia/clinical`; aquí se guardan y se leen.
 */
import {
  activeFindingsAsOf,
  comparePeriodontal,
  emptyPeriodontalTooth,
  type FindingRecord,
  type FurcationRecord,
  normalizePeriodontalTooth,
  pendingProbingWords,
  type PeriImplantCondition,
  type PeriodontalClassification,
  type PeriodontitisStatus,
  type PreviousPeriodontitis,
  periodontalClassificationShort,
  periodontalDiagnosisCode,
  periodontalDiagnosisLabel,
  type PeriodontalProposal,
  type PeriodontalSiteChange,
  type PeriodontalSummary,
  type PeriodontalToothInput,
  type PeriodontalToothRecord,
  PERI_IMPLANT_CONDITIONS,
  periodontalDentition,
  proposePeriodontalClassification,
  summarizePeriodontal,
  validatePeriodontalClassification,
  validatePeriodontalTooth,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  encounter,
  encounterDiagnosis,
  odontogramEntry,
  periodontalChart,
  periodontalTooth,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm"
import { insertOdontogramFinding, orgStrictVariants, voidOdontogramEntry } from "./clinical.js"
import { findDiagnosisCode, orgDiagnosisSystem } from "./diagnosis-codes.js"
import { addEncounterDiagnosis } from "./encounter-diagnoses.js"
import { assertOpenDraft, lockEncounter } from "./encounters.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgLocale } from "./locale.js"
import { requirePatient } from "./patients.js"

type ChartRow = typeof periodontalChart.$inferSelect
type ToothRow = typeof periodontalTooth.$inferSelect

export interface PeriodontalChartClassification {
  diagnosis: PeriodontalClassification["diagnosis"]
  stage: number | null
  grade: string | null
  extent: string | null
  boneLossPercent: number | null
  teethLostToPeriodontitis: number | null
  cigarettesPerDay: number | null
  diabetes: boolean | null
  hba1c: number | null
  /** Solo periodontitis ya diagnosticada antes: estable, en remisión o inestable. */
  status: PeriodontitisStatus | null
  classifiedBy: string | null
  classifiedAt: Date | null
}

export interface PeriodontalChartView {
  id: string
  patientId: string
  encounterId: string
  /** Fecha de la atención en que se sondeó. */
  date: Date
  encounterStatus: string
  professionalName: string | null
  expectedTeeth: number[]
  implantTeeth: number[]
  /** Una pieza por cada una que se debía sondear, medida o no. */
  teeth: PeriodontalToothRecord[]
  summary: PeriodontalSummary
  /** Lo que falta sondear en palabras («abajo por fuera, de la 43 a la 47»); null si está completo. */
  pending: string | null
  /** Lo que propone odentIA con lo medido y lo que agregó el odontólogo. */
  proposal: PeriodontalProposal
  /**
   * Con qué calcula la propuesta, para que la pantalla la recalcule con la
   * misma regla mientras el odontólogo agrega datos: edad ese día, piezas
   * naturales y la periodontitis confirmada antes.
   */
  proposalBasis: { ageYears: number | null; remainingTeeth: number; previous: PreviousPeriodontitis | null }
  classification: PeriodontalChartClassification | null
  createdBy: string
  updatedAt: Date
}

export interface PeriodontalChartListItem {
  id: string
  encounterId: string
  date: Date
  encounterStatus: string
  professionalName: string | null
  bleedingPercent: number | null
  plaquePercent: number | null
  sitesFrom4mm: number
  sitesFrom6mm: number
  pendingTeeth: number
  /** Lo que falta sondear en palabras (también caras a medias); null si está completo. */
  pending: string | null
  classification: Pick<PeriodontalChartClassification, "diagnosis" | "stage" | "grade" | "extent" | "status"> | null
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
    entity: "periodontal_chart",
    entityId,
    metadata,
  })
}

function toothRecord(row: ToothRow): PeriodontalToothRecord {
  return {
    toothNumber: row.toothNumber,
    skipped: row.skipped,
    probingDepth: row.probingDepth,
    recession: row.recession,
    bleeding: row.bleeding,
    suppuration: row.suppuration,
    mobility: row.mobility,
    furcation: (row.furcation ?? {}) as FurcationRecord,
    plaque: row.plaque,
    periImplant: (row.periImplant as PeriImplantCondition | null) ?? null,
  }
}

function classificationOf(row: ChartRow): PeriodontalChartClassification | null {
  if (!row.diagnosis) return null
  return {
    diagnosis: row.diagnosis as PeriodontalClassification["diagnosis"],
    stage: row.stage,
    grade: row.grade,
    extent: row.extent,
    boneLossPercent: row.boneLossPercent,
    teethLostToPeriodontitis: row.teethLostToPeriodontitis,
    cigarettesPerDay: row.cigarettesPerDay,
    diabetes: row.diabetes,
    hba1c: row.hba1c,
    status: (row.periodontitisStatus as PeriodontitisStatus | null) ?? null,
    classifiedBy: row.classifiedBy,
    classifiedAt: row.classifiedAt,
  }
}

/** Años cumplidos a una fecha; null sin fecha de nacimiento. */
function ageAt(birthDate: string | null | undefined, at: Date): number | null {
  if (!birthDate) return null
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number]
  let age = at.getUTCFullYear() - y
  const month = at.getUTCMonth() + 1
  if (month < m || (month === m && at.getUTCDate() < d)) age--
  return age >= 0 ? age : null
}

/** Las piezas en el orden de las que se debían sondear, con las no medidas vacías. */
function fullTeeth(chart: ChartRow, rows: ToothRow[]): PeriodontalToothRecord[] {
  const stored = new Map(rows.map((row) => [row.toothNumber, toothRecord(row)]))
  return chart.expectedTeeth.map((tooth) => stored.get(tooth) ?? emptyPeriodontalTooth(tooth))
}

async function requireChart(tx: Db, orgId: string, patientId: string, chartId: string, lock = false): Promise<ChartRow> {
  const query = tx
    .select()
    .from(periodontalChart)
    .where(
      and(
        eq(periodontalChart.id, chartId),
        eq(periodontalChart.organizationId, orgId),
        eq(periodontalChart.patientId, patientId),
      ),
    )
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw notFound("Periodontograma")
  return row
}

/** Bloquea la atención del periodontograma y exige que siga en borrador y la lleve quien escribe. */
async function requireWritable(tx: Db, orgId: string, actorUserId: string, chart: ChartRow): Promise<void> {
  const row = await lockEncounter(tx, orgId, chart.patientId, chart.encounterId)
  assertOpenDraft(row, actorUserId)
}

/**
 * La periodontitis confirmada en la visita anterior más reciente de la misma
 * persona (sin las de atenciones anuladas): de ahí parte la reevaluación,
 * porque el diagnóstico no baja con el tratamiento.
 */
async function previousPeriodontitis(
  tx: Db,
  orgId: string,
  chart: ChartRow,
  before: Date,
): Promise<PreviousPeriodontitis | null> {
  const [row] = await tx
    .select({ stage: periodontalChart.stage, grade: periodontalChart.grade, extent: periodontalChart.extent, date: encounter.startedAt })
    .from(periodontalChart)
    .innerJoin(
      encounter,
      and(eq(encounter.organizationId, periodontalChart.organizationId), eq(encounter.id, periodontalChart.encounterId)),
    )
    .where(
      and(
        eq(periodontalChart.organizationId, orgId),
        eq(periodontalChart.patientId, chart.patientId),
        ne(periodontalChart.id, chart.id),
        eq(periodontalChart.diagnosis, "periodontitis"),
        isNotNull(periodontalChart.stage),
        ne(encounter.status, "anulada"),
        lt(encounter.startedAt, before),
      ),
    )
    .orderBy(desc(encounter.startedAt))
    .limit(1)
  if (!row || row.stage === null || !row.grade || !row.extent) return null
  const zone = await findOrgLocale(tx, orgId)
  const date = row.date.toLocaleDateString(zone.locale, { timeZone: zone.timezone, day: "numeric", month: "short", year: "numeric" })
  return {
    stage: row.stage as PreviousPeriodontitis["stage"],
    grade: row.grade as PreviousPeriodontitis["grade"],
    extent: row.extent as PreviousPeriodontitis["extent"],
    date,
  }
}

async function chartView(tx: Db, orgId: string, chart: ChartRow, birthDate: string | null | undefined): Promise<PeriodontalChartView> {
  const [visit] = await tx
    .select({ startedAt: encounter.startedAt, status: encounter.status, professionalName: user.name })
    .from(encounter)
    .leftJoin(user, eq(user.id, encounter.professionalUserId))
    .where(and(eq(encounter.id, chart.encounterId), eq(encounter.organizationId, orgId)))
    .limit(1)
  if (!visit) throw notFound("Atención")
  const rows = await tx
    .select()
    .from(periodontalTooth)
    .where(and(eq(periodontalTooth.organizationId, orgId), eq(periodontalTooth.chartId, chart.id)))
  const teeth = fullTeeth(chart, rows)
  const summary = summarizePeriodontal(teeth, chart.implantTeeth, chart.expectedTeeth)
  const previous = await previousPeriodontitis(tx, orgId, chart, visit.startedAt)
  const ageYears = ageAt(birthDate, visit.startedAt)
  const remainingTeeth = chart.expectedTeeth.length - chart.implantTeeth.length
  const proposal = proposePeriodontalClassification(
    teeth,
    chart.implantTeeth,
    {
      boneLossPercent: chart.boneLossPercent,
      teethLostToPeriodontitis: chart.teethLostToPeriodontitis,
      cigarettesPerDay: chart.cigarettesPerDay,
      diabetes: chart.diabetes,
      hba1c: chart.hba1c,
    },
    ageYears,
    remainingTeeth,
    previous,
  )
  return {
    id: chart.id,
    patientId: chart.patientId,
    encounterId: chart.encounterId,
    date: visit.startedAt,
    encounterStatus: visit.status,
    professionalName: visit.professionalName ?? null,
    expectedTeeth: chart.expectedTeeth,
    implantTeeth: chart.implantTeeth,
    teeth,
    summary,
    pending: pendingProbingWords(teeth, chart.expectedTeeth),
    proposal,
    proposalBasis: { ageYears, remainingTeeth, previous },
    classification: classificationOf(chart),
    createdBy: chart.createdBy,
    updatedAt: chart.updatedAt,
  }
}

/** Los hallazgos del odontograma de la persona, con lo necesario para saber cuáles siguen vigentes. */
async function patientFindings(tx: Db, orgId: string, patientId: string, toothNumber?: number): Promise<FindingRecord[]> {
  const rows = await tx
    .select({
      id: odontogramEntry.id,
      toothNumber: odontogramEntry.toothNumber,
      condition: odontogramEntry.condition,
      surface: odontogramEntry.surface,
      status: odontogramEntry.status,
      details: odontogramEntry.details,
      needsReview: odontogramEntry.needsReview,
      createdAt: odontogramEntry.createdAt,
      voidedAt: odontogramEntry.voidedAt,
      resolvedAt: odontogramEntry.resolvedAt,
      encounterId: odontogramEntry.encounterId,
    })
    .from(odontogramEntry)
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        toothNumber === undefined ? undefined : eq(odontogramEntry.toothNumber, toothNumber),
      ),
    )
  return rows as FindingRecord[]
}

const MOBILITY_CORRECTED = "Movilidad corregida en el periodontograma"

/**
 * La movilidad se anota en el periodontograma y el odontograma la muestra como
 * «Movilidad patológica» M1–M3 (decisión 4: un dato, un lugar). Deja en la
 * atención el hallazgo con el grado anotado, anula el que dejó antes en la
 * misma atención si cambió y no repite el grado que ya está vigente de una
 * atención anterior. Una movilidad 0 solo corrige lo de esta atención: lo de
 * antes lo resuelve su tratamiento o se anula en el odontograma.
 */
async function syncMobilityFinding(
  tx: Db,
  orgId: string,
  actorUserId: string,
  chart: ChartRow,
  toothNumber: number,
  mobility: number | null,
): Promise<void> {
  if (chart.implantTeeth.includes(toothNumber)) return
  const grade = mobility !== null && mobility >= 1 ? mobility : null
  const gradeOf = (finding: FindingRecord) => (finding.details as { grade?: number } | undefined)?.grade ?? null
  const active = activeFindingsAsOf(await patientFindings(tx, orgId, chart.patientId, toothNumber)).filter(
    (finding) => finding.condition === "pathological_mobility",
  ) as Array<FindingRecord & { encounterId: string | null }>
  const own = active.filter((finding) => finding.encounterId === chart.encounterId)
  for (const finding of own) {
    if (gradeOf(finding) !== grade) {
      await voidOdontogramEntry(tx, orgId, actorUserId, finding.id, chart.patientId, MOBILITY_CORRECTED)
    }
  }
  if (grade === null || own.some((finding) => gradeOf(finding) === grade)) return
  const before = active.filter((finding) => finding.encounterId !== chart.encounterId).at(-1)
  if (before && gradeOf(before) === grade) return
  await insertOdontogramFinding(
    tx,
    orgId,
    actorUserId,
    chart.patientId,
    chart.encounterId,
    { toothNumber, condition: "pathological_mobility", details: { grade } },
    { strictVariants: await orgStrictVariants(tx, orgId) },
  )
}

/**
 * Empieza el periodontograma de la atención en borrador de quien la lleva. Las
 * piezas a sondear y los implantes salen del odontograma vigente (decisión 4).
 * Si la atención ya tiene uno, lo devuelve: uno por atención.
 */
export async function startPeriodontalChart(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { encounterId: string },
): Promise<PeriodontalChartView> {
  const person = await requirePatient(tx, orgId, patientId)
  const visit = await lockEncounter(tx, orgId, patientId, input.encounterId)
  assertOpenDraft(visit, actorUserId)
  const [existing] = await tx
    .select()
    .from(periodontalChart)
    .where(and(eq(periodontalChart.organizationId, orgId), eq(periodontalChart.encounterId, visit.id)))
    .limit(1)
  if (existing) return chartView(tx, orgId, existing, person.birthDate)
  const { teeth, implants } = periodontalDentition(activeFindingsAsOf(await patientFindings(tx, orgId, patientId)))
  if (!teeth.length) {
    throw validation("El odontograma no tiene piezas ni implantes que sondear")
  }
  const [chart] = await tx
    .insert(periodontalChart)
    .values({
      organizationId: orgId,
      patientId,
      encounterId: visit.id,
      expectedTeeth: teeth,
      implantTeeth: implants,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, "periodontal.chart_started", chart!.id, {
    patientId,
    encounterId: visit.id,
    teeth: teeth.length,
    implants,
  })
  return chartView(tx, orgId, chart!, person.birthDate)
}

/**
 * Guarda una pieza entera (lo que no se envía queda sin medir). Solo las piezas
 * que se debían sondear y solo en el borrador de quien lleva la atención.
 */
export async function savePeriodontalTooth(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  chartId: string,
  input: PeriodontalToothInput,
): Promise<PeriodontalToothRecord> {
  const chart = await requireChart(tx, orgId, patientId, chartId, true)
  await requireWritable(tx, orgId, actorUserId, chart)
  if (!chart.expectedTeeth.includes(input.toothNumber)) {
    throw validation(`La pieza ${input.toothNumber} no se sondea: el odontograma de esta atención la tiene ausente`)
  }
  const errors = validatePeriodontalTooth(input, { implant: chart.implantTeeth.includes(input.toothNumber) })
  if (errors.length) throw validation(errors.join("; "))
  const record = normalizePeriodontalTooth(input)
  const values = {
    skipped: record.skipped,
    probingDepth: record.probingDepth,
    recession: record.recession,
    bleeding: record.bleeding,
    suppuration: record.suppuration,
    mobility: record.mobility,
    furcation: record.furcation,
    plaque: record.plaque,
    periImplant: record.periImplant,
    updatedBy: actorUserId,
    updatedAt: new Date(),
  }
  const [row] = await tx
    .insert(periodontalTooth)
    .values({ organizationId: orgId, chartId: chart.id, toothNumber: input.toothNumber, ...values })
    .onConflictDoUpdate({ target: [periodontalTooth.chartId, periodontalTooth.toothNumber], set: values })
    .returning()
  await tx.update(periodontalChart).set({ updatedAt: new Date() }).where(eq(periodontalChart.id, chart.id))
  await syncMobilityFinding(tx, orgId, actorUserId, chart, input.toothNumber, record.mobility)
  await audit(tx, orgId, actorUserId, "periodontal.tooth_saved", chart.id, {
    patientId,
    encounterId: chart.encounterId,
    toothNumber: input.toothNumber,
  })
  return toothRecord(row!)
}

export interface ClassifyPeriodontalInput extends PeriodontalClassification {
  /** Estado de cada implante que confirma el odontólogo. */
  implants?: Array<{ toothNumber: number; condition: PeriImplantCondition }>
}

/**
 * Guarda la clasificación que confirma el odontólogo, con lo que agregó para
 * decidirla. Puede diferir de la propuesta: se guarda lo suyo (decisión 5).
 */
export async function classifyPeriodontalChart(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  chartId: string,
  input: ClassifyPeriodontalInput,
): Promise<PeriodontalChartView> {
  const person = await requirePatient(tx, orgId, patientId)
  const chart = await requireChart(tx, orgId, patientId, chartId, true)
  await requireWritable(tx, orgId, actorUserId, chart)
  const errors = validatePeriodontalClassification(input)
  for (const implant of input.implants ?? []) {
    if (!chart.implantTeeth.includes(implant.toothNumber)) errors.push(`La pieza ${implant.toothNumber} no es un implante`)
    if (!(PERI_IMPLANT_CONDITIONS as readonly string[]).includes(implant.condition)) errors.push("Estado periimplantario inválido")
  }
  if (errors.length) throw validation(errors.join("; "))
  const periodontitis = input.diagnosis === "periodontitis"
  const [updated] = await tx
    .update(periodontalChart)
    .set({
      diagnosis: input.diagnosis,
      stage: periodontitis ? (input.stage ?? null) : null,
      grade: periodontitis ? (input.grade ?? null) : null,
      extent: input.diagnosis === "health" ? null : (input.extent ?? null),
      boneLossPercent: input.boneLossPercent ?? null,
      teethLostToPeriodontitis: input.teethLostToPeriodontitis ?? null,
      cigarettesPerDay: input.cigarettesPerDay ?? null,
      diabetes: input.diabetes ?? null,
      hba1c: input.diabetes ? (input.hba1c ?? null) : null,
      periodontitisStatus: periodontitis ? (input.status ?? null) : null,
      classifiedBy: actorUserId,
      classifiedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(periodontalChart.id, chart.id))
    .returning()
  for (const implant of input.implants ?? []) {
    const empty = emptyPeriodontalTooth(implant.toothNumber)
    await tx
      .insert(periodontalTooth)
      .values({
        organizationId: orgId,
        chartId: chart.id,
        toothNumber: implant.toothNumber,
        probingDepth: empty.probingDepth,
        recession: empty.recession,
        bleeding: empty.bleeding,
        suppuration: empty.suppuration,
        periImplant: implant.condition,
        updatedBy: actorUserId,
      })
      .onConflictDoUpdate({
        target: [periodontalTooth.chartId, periodontalTooth.toothNumber],
        set: { periImplant: implant.condition, updatedBy: actorUserId, updatedAt: new Date() },
      })
  }
  // El mismo «Confirmar diagnóstico» deja el diagnóstico de la atención con el
  // código de la lista de la clínica, que es lo que pide el cierre (decisión 5).
  const diagnosisCode = await recordEncounterDiagnosis(tx, orgId, actorUserId, patientId, chart.encounterId, input)
  await audit(tx, orgId, actorUserId, "periodontal.classified", chart.id, {
    diagnosisCode,
    patientId,
    encounterId: chart.encounterId,
    diagnosis: input.diagnosis,
    stage: updated!.stage,
    grade: updated!.grade,
    extent: updated!.extent,
  })
  return chartView(tx, orgId, updated!, person.birthDate)
}

/**
 * Deja en la atención el diagnóstico con el código de la lista de la clínica
 * (`periodontalDiagnosisCode`) y la clasificación en palabras como nota. No lo
 * repite si ya está; si la lista no tiene ese código, no deja nada y el
 * odontólogo lo elige en el buscador. La salud no lleva código.
 */
async function recordEncounterDiagnosis(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: ClassifyPeriodontalInput,
): Promise<string | null> {
  const system = await orgDiagnosisSystem(tx, orgId)
  const code = periodontalDiagnosisCode(system, input.diagnosis)
  if (!code || !(await findDiagnosisCode(tx, system, code))) return null
  const [existing] = await tx
    .select({ id: encounterDiagnosis.id })
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, encounterId),
        eq(encounterDiagnosis.diagnosisSystem, system),
        eq(encounterDiagnosis.diagnosisCode, code),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
    .limit(1)
  if (existing) return code
  await addEncounterDiagnosis(tx, orgId, actorUserId, patientId, encounterId, {
    diagnosisCode: code,
    diagnosisSystem: system,
    diagnosisType: "confirmed",
    note: periodontalDiagnosisLabel(input),
  })
  return code
}

/** Un periodontograma con sus piezas, índices, propuesta y clasificación. */
export async function getPeriodontalChart(
  tx: Db,
  orgId: string,
  patientId: string,
  chartId: string,
): Promise<PeriodontalChartView> {
  const person = await requirePatient(tx, orgId, patientId)
  const chart = await requireChart(tx, orgId, patientId, chartId)
  return chartView(tx, orgId, chart, person.birthDate)
}

/** Los periodontogramas de la persona, del más reciente al más antiguo; sin los de atenciones anuladas. */
export async function listPeriodontalCharts(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<PeriodontalChartListItem[]> {
  await requirePatient(tx, orgId, patientId)
  const charts = await tx
    .select({ chart: periodontalChart, date: encounter.startedAt, status: encounter.status, professionalName: user.name })
    .from(periodontalChart)
    .innerJoin(
      encounter,
      and(eq(encounter.organizationId, periodontalChart.organizationId), eq(encounter.id, periodontalChart.encounterId)),
    )
    .leftJoin(user, eq(user.id, encounter.professionalUserId))
    .where(
      and(
        eq(periodontalChart.organizationId, orgId),
        eq(periodontalChart.patientId, patientId),
        ne(encounter.status, "anulada"),
      ),
    )
    .orderBy(desc(encounter.startedAt))
  if (!charts.length) return []
  const rows = await tx
    .select()
    .from(periodontalTooth)
    .where(
      and(
        eq(periodontalTooth.organizationId, orgId),
        inArray(
          periodontalTooth.chartId,
          charts.map((item) => item.chart.id),
        ),
      ),
    )
  return charts.map(({ chart, date, status, professionalName }) => {
    const teeth = fullTeeth(chart, rows.filter((row) => row.chartId === chart.id))
    const summary = summarizePeriodontal(teeth, chart.implantTeeth, chart.expectedTeeth)
    const classification = classificationOf(chart)
    return {
      id: chart.id,
      encounterId: chart.encounterId,
      date,
      encounterStatus: status,
      professionalName: professionalName ?? null,
      bleedingPercent: summary.bleedingPercent,
      plaquePercent: summary.plaque?.percent ?? null,
      sitesFrom4mm: summary.sitesFrom4mm,
      sitesFrom6mm: summary.sitesFrom6mm,
      pendingTeeth: summary.pendingTeeth.length,
      pending: pendingProbingWords(teeth, chart.expectedTeeth),
      classification: classification
        ? {
            diagnosis: classification.diagnosis,
            stage: classification.stage,
            grade: classification.grade,
            extent: classification.extent,
            status: classification.status,
          }
        : null,
    }
  })
}

export interface PeriodontalComparison {
  before: { id: string; date: Date; summary: PeriodontalSummary }
  after: { id: string; date: Date; summary: PeriodontalSummary }
  /** Sitios comparados: medidos en las dos visitas. */
  compared: number
  improved: PeriodontalSiteChange[]
  worsened: PeriodontalSiteChange[]
}

/** Dos visitas de la misma persona: qué sitios mejoraron y cuáles empeoraron 2 mm o más. */
export async function comparePeriodontalCharts(
  tx: Db,
  orgId: string,
  patientId: string,
  beforeId: string,
  afterId: string,
): Promise<PeriodontalComparison> {
  if (beforeId === afterId) throw new ServiceError("SAME_CHART", 400, "Elige dos periodontogramas distintos")
  const before = await getPeriodontalChart(tx, orgId, patientId, beforeId)
  const after = await getPeriodontalChart(tx, orgId, patientId, afterId)
  // Los implantes se comparan aparte: no entran en los sitios de las piezas.
  const natural = (view: PeriodontalChartView) => view.teeth.filter((tooth) => !view.implantTeeth.includes(tooth.toothNumber))
  const result = comparePeriodontal(natural(before), natural(after))
  return {
    before: { id: before.id, date: before.date, summary: before.summary },
    after: { id: after.id, date: after.date, summary: after.summary },
    ...result,
  }
}

/** El periodontograma de una atención, para nombrarlo donde aparece la atención. */
export interface PeriodontalBrief {
  chartId: string
  encounterId: string
  date: Date
  /** «Estadio III · Grado B · Generalizada»; null si no se confirmó un diagnóstico. */
  classification: string | null
  bleedingPercent: number | null
  /** Quedó a medias: se firmó como parcial o sigue en curso. */
  partial: boolean
}

async function briefsOf(
  tx: Db,
  orgId: string,
  charts: Array<{ chart: ChartRow; date: Date }>,
): Promise<Map<string, PeriodontalBrief>> {
  const result = new Map<string, PeriodontalBrief>()
  if (!charts.length) return result
  const rows = await tx
    .select()
    .from(periodontalTooth)
    .where(
      and(
        eq(periodontalTooth.organizationId, orgId),
        inArray(
          periodontalTooth.chartId,
          charts.map((item) => item.chart.id),
        ),
      ),
    )
  for (const { chart, date } of charts) {
    const teeth = fullTeeth(chart, rows.filter((row) => row.chartId === chart.id))
    const summary = summarizePeriodontal(teeth, chart.implantTeeth, chart.expectedTeeth)
    const classification = classificationOf(chart)
    result.set(chart.encounterId, {
      chartId: chart.id,
      encounterId: chart.encounterId,
      date,
      classification: classification
        ? periodontalClassificationShort(classification as PeriodontalClassification)
        : null,
      bleedingPercent: summary.bleedingPercent,
      partial: pendingProbingWords(teeth, chart.expectedTeeth) !== null,
    })
  }
  return result
}

const chartWithDate = (tx: Db) =>
  tx
    .select({ chart: periodontalChart, date: encounter.startedAt })
    .from(periodontalChart)
    .innerJoin(
      encounter,
      and(eq(encounter.organizationId, periodontalChart.organizationId), eq(encounter.id, periodontalChart.encounterId)),
    )

/** Los periodontogramas de varias atenciones, por atención (Historia). */
export async function periodontalBriefsByEncounter(
  tx: Db,
  orgId: string,
  encounterIds: readonly string[],
): Promise<Map<string, PeriodontalBrief>> {
  if (!encounterIds.length) return new Map()
  const charts = await chartWithDate(tx).where(
    and(eq(periodontalChart.organizationId, orgId), inArray(periodontalChart.encounterId, [...encounterIds])),
  )
  return briefsOf(tx, orgId, charts)
}

/**
 * Lo último de las encías para el Resumen: el sangrado del periodontograma
 * firmado más reciente y el último diagnóstico confirmado, con su fecha. Null
 * sin ninguno firmado.
 */
export async function latestPeriodontalBrief(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<(PeriodontalBrief & { classifiedOn: Date | null }) | null> {
  const charts = await chartWithDate(tx)
    .where(
      and(
        eq(periodontalChart.organizationId, orgId),
        eq(periodontalChart.patientId, patientId),
        eq(encounter.status, "finalizada"),
      ),
    )
    .orderBy(desc(encounter.startedAt))
    .limit(10)
  const latest = charts[0]
  if (!latest) return null
  const classified = charts.find((item) => item.chart.diagnosis !== null) ?? null
  const briefs = await briefsOf(tx, orgId, classified && classified !== latest ? [latest, classified] : [latest])
  return {
    ...briefs.get(latest.chart.encounterId)!,
    classification: classified ? (briefs.get(classified.chart.encounterId)?.classification ?? null) : null,
    classifiedOn: classified?.date ?? null,
  }
}
