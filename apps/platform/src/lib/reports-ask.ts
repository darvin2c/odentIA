/**
 * Lo que la pantalla de Reportes le pide a Argos (ADR 0070) y lo de la fase 6
 * (ADR 0071): las respuestas fijadas, las metas, el resumen del lunes y
 * «Descargar». Las frases, las cifras y lo que se puede tocar los entrega el
 * servidor; la pantalla solo los dibuja.
 */
import { apiDownload, apiFetch } from "./api"
import type { ReportAdvice, ReportQuery } from "./reports"

export type FigureGroup = "total" | "mes" | "sede" | "profesional" | "canal" | "medio" | "tratamiento" | "categoria" | "como_nos_conocio" | "antiguedad"
export type FigureUnit = "money" | "count" | "rate" | "minutes" | "hours"

/** Una pregunta ya entendida: la que manda una opción de la respuesta o una respuesta fijada. */
export interface ReportAskQuery extends ReportQuery {
  figure: string
  group: FigureGroup
  focus?: string | null
}

export type ReportSentence = Array<{ text: string; strong?: boolean }>

export type ReportAnswerChart =
  | {
      kind: "bars"
      rows: Array<{ key: string; label: string; value: number; part?: number; valueText: string; note?: string; highlight: boolean }>
      legend: { value: string; part: string } | null
    }
  | { kind: "months"; points: Array<{ key: string; label: string; short: string; partial: boolean; value: number | null }> }

export type ReportFollowUp = { label: string; query: ReportAskQuery } | { label: string; list: string }

export interface ReportAnswer {
  query: ReportAskQuery
  title: string
  sentence: ReportSentence
  how: string
  scope: string
  unit: FigureUnit
  currency: string
  locale: string
  chart: ReportAnswerChart | null
  list: { key: string; label: string } | null
  tab: { key: string; label: string }
  followUps: ReportFollowUp[]
  advice: ReportAdvice | null
  downloadable: boolean
}

export type ReportAskResult =
  | { kind: "respuesta"; answer: ReportAnswer }
  | { kind: "pregunta"; message: string; options: Array<{ label: string; query: ReportAskQuery }> }
  | { kind: "no_sabe"; message: string; closest: Array<{ label: string; query: ReportAskQuery }> }
  | { kind: "accion"; message: string; line: { key: string; name: string } | null }
  | { kind: "clinico" | "otro" | "tope" | "sin_modelo" | "apagado"; message: string }

export function askReport(body: (ReportQuery & { text: string }) | { query: ReportAskQuery }): Promise<{ data: ReportAskResult }> {
  return apiFetch("/api/reports/ask", { method: "POST", body: JSON.stringify(body) })
}

export interface PinnedAnswer {
  id: string
  pinnedBy: string
  pinnedOn: string
  answer: ReportAnswer | null
}

export function reportParams(query: ReportQuery & Record<string, string | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== "") search.set(key, value)
  return search.toString()
}

export function fetchPins(query: ReportQuery): Promise<{ data: { limit: number; pins: PinnedAnswer[] } }> {
  return apiFetch(`/api/reports/pins?${reportParams({ period: query.period, branchId: query.branchId })}`)
}

export function pinAnswer(query: Pick<ReportAskQuery, "figure" | "group" | "focus">): Promise<{ data: { id: string } }> {
  return apiFetch("/api/reports/pins", { method: "POST", body: JSON.stringify({ figure: query.figure, group: query.group, focus: query.focus ?? null }) })
}

export function unpinAnswer(id: string): Promise<unknown> {
  return apiFetch(`/api/reports/pins/${id}`, { method: "DELETE" })
}

export const PINS_KEY = ["report", "pins"] as const

// --- Metas ---------------------------------------------------------------------------

export type ReportGoalMetric = "cobrado" | "pacientes_nuevos"

export interface GoalProgress {
  amount: number
  currency: string | null
  value: number
  percent: number
  remaining: number
}

export interface ReportGoals {
  month: string | null
  editable: boolean
  elapsedPercent: number | null
  daysLeft: number | null
  cobrado: GoalProgress | null
  pacientesNuevos: GoalProgress | null
  best: { cobrado: { month: string; cents: number } | null; pacientesNuevos: { month: string; count: number } | null }
}

export function setGoal(metric: ReportGoalMetric, amount: number | null): Promise<unknown> {
  return apiFetch(`/api/reports/goals/${metric}`, { method: "PUT", body: JSON.stringify({ amount }) })
}

// --- El resumen del lunes --------------------------------------------------------------

export const DIGEST_KEY = ["report", "digest"] as const

export function fetchDigest(): Promise<{ data: { enabled: boolean } }> {
  return apiFetch("/api/reports/digest")
}

export function setDigest(enabled: boolean): Promise<{ data: { enabled: boolean } }> {
  return apiFetch("/api/reports/digest", { method: "PUT", body: JSON.stringify({ enabled }) })
}

// --- Descargar -----------------------------------------------------------------------

/** Una lista de Reportes entera, en CSV. */
export function downloadReportList(list: string, query: ReportQuery): Promise<void> {
  return apiDownload(`/api/reports/download/list/${list}?${reportParams({ period: query.period, branchId: query.branchId })}`, `${list}.csv`)
}

export function downloadReportTable(table: "professionals" | "commissions", query: ReportQuery): Promise<void> {
  return apiDownload(`/api/reports/download/${table}?${reportParams({ period: query.period, branchId: query.branchId })}`, `${table}.csv`)
}

export function downloadReportAnswer(query: ReportAskQuery): Promise<void> {
  return apiDownload(
    `/api/reports/download/answer?${reportParams({ period: query.period, branchId: query.branchId, figure: query.figure, group: query.group, focus: query.focus })}`,
    `${query.figure}.csv`,
  )
}
