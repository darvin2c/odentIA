/**
 * Cliente del periodontograma (issue 49, ADR 0054). Uno por atención, escrito
 * en el borrador de quien la lleva y fijo al firmarla. Las reglas (sitios,
 * índices, propuesta de 2017 y comparación) son las de `@odentia/clinical`: la
 * pantalla las usa para dibujar y recalcular, nunca escribe otras.
 */
import type {
  FurcationRecord,
  PeriImplantCondition,
  PeriodontalClassification,
  PeriodontalProposal,
  PeriodontalSiteChange,
  PeriodontalSummary,
  PeriodontalToothRecord,
  PeriodontitisStatus,
  PreviousPeriodontitis,
} from "@odentia/dental"
import { apiFetch } from "../api"
import { activeOrgLocale, activeOrgTimeZone } from "../locale"

/** «Inicial» para la primera visita de la persona; «Reevaluación» para las siguientes. */
export function visitName(index: number): string {
  return index === 0 ? "Inicial" : "Reevaluación"
}

/** «10 ago 2026», en el idioma y la zona de la clínica: cómo se nombra una visita. */
export function visitDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date
    .toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric", timeZone: activeOrgTimeZone() })
    .replace(".", "")
}

/** «10 ago»: la visita en corto, para los botones y las medidas del sitio. */
export function visitDay(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", timeZone: activeOrgTimeZone() }).replace(".", "")
}

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
  status: PeriodontitisStatus | null
  classifiedBy: string | null
  classifiedAt: string | null
}

export interface PeriodontalChart {
  id: string
  patientId: string
  encounterId: string
  /** Fecha de la atención en que se sondeó. */
  date: string
  encounterStatus: string
  professionalName: string | null
  expectedTeeth: number[]
  implantTeeth: number[]
  teeth: PeriodontalToothRecord[]
  summary: PeriodontalSummary
  /** Lo que falta sondear en palabras; null si está completo. */
  pending: string | null
  proposal: PeriodontalProposal
  /** Con qué recalcular la propuesta mientras el odontólogo agrega datos. */
  proposalBasis: { ageYears: number | null; remainingTeeth: number; previous: PreviousPeriodontitis | null }
  classification: PeriodontalChartClassification | null
  createdBy: string
  updatedAt: string
}

export interface PeriodontalChartListItem {
  id: string
  encounterId: string
  date: string
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

export interface PeriodontalComparison {
  before: { id: string; date: string; summary: PeriodontalSummary }
  after: { id: string; date: string; summary: PeriodontalSummary }
  compared: number
  improved: PeriodontalSiteChange[]
  worsened: PeriodontalSiteChange[]
}

/** Lo que se guarda de una pieza: la pieza entera, como la devuelve el servidor. */
export interface PeriodontalToothSave {
  skipped?: boolean
  probingDepth?: (number | null)[]
  recession?: (number | null)[]
  bleeding?: boolean[]
  suppuration?: boolean[]
  mobility?: number | null
  furcation?: FurcationRecord
  plaque?: boolean[] | null
  periImplant?: PeriImplantCondition | null
}

export interface PeriodontalClassifyInput {
  diagnosis: PeriodontalClassification["diagnosis"]
  stage?: number | null
  grade?: string | null
  extent?: string | null
  status?: PeriodontitisStatus | null
  boneLossPercent?: number | null
  teethLostToPeriodontitis?: number | null
  cigarettesPerDay?: number | null
  diabetes?: boolean | null
  hba1c?: number | null
  implants?: Array<{ toothNumber: number; condition: PeriImplantCondition }>
}

function base(patientId: string): string {
  return `/api/patients/${patientId}/periodontal`
}

export const periodontalKeys = {
  list: (patientId: string) => ["periodontal", patientId] as const,
  chart: (patientId: string, chartId: string) => ["periodontal", patientId, chartId] as const,
  compare: (patientId: string, before: string, after: string) => ["periodontal", patientId, "compare", before, after] as const,
}

export function fetchPeriodontalCharts(patientId: string) {
  return apiFetch<{ data: PeriodontalChartListItem[] }>(base(patientId))
}

export function fetchPeriodontalChart(patientId: string, chartId: string) {
  return apiFetch<{ data: PeriodontalChart }>(`${base(patientId)}/${chartId}`)
}

export function fetchPeriodontalComparison(patientId: string, before: string, after: string) {
  const query = new URLSearchParams({ before, after })
  return apiFetch<{ data: PeriodontalComparison }>(`${base(patientId)}/compare?${query}`)
}

/** «Empezar»: uno por atención; si ya existe, lo devuelve. */
export function startPeriodontalChart(patientId: string, encounterId: string) {
  return apiFetch<{ data: PeriodontalChart }>(base(patientId), {
    method: "POST",
    body: JSON.stringify({ encounterId }),
  })
}

export function savePeriodontalTooth(patientId: string, chartId: string, toothNumber: number, body: PeriodontalToothSave) {
  return apiFetch<{ data: PeriodontalToothRecord }>(`${base(patientId)}/${chartId}/teeth/${toothNumber}`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/** «Confirmar diagnóstico»: guarda lo que confirma el odontólogo y deja el código en la atención. */
export function classifyPeriodontalChart(patientId: string, chartId: string, body: PeriodontalClassifyInput) {
  return apiFetch<{ data: PeriodontalChart }>(`${base(patientId)}/${chartId}/classification`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** El cuerpo que se envía para guardar una pieza tal como está en pantalla. */
export function toothSaveBody(tooth: PeriodontalToothRecord): PeriodontalToothSave {
  return {
    skipped: tooth.skipped,
    probingDepth: tooth.probingDepth,
    recession: tooth.recession,
    bleeding: tooth.bleeding,
    suppuration: tooth.suppuration,
    mobility: tooth.mobility,
    furcation: tooth.furcation,
    plaque: tooth.plaque,
    periImplant: tooth.periImplant,
  }
}
