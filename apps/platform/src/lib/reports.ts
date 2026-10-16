/**
 * Reportes: cliente tipado de `/api/reports` y las frases con que la pantalla
 * dice un periodo y lo compara con el anterior. Los tipos replican las
 * respuestas del servidor; él decide el tramo, la moneda y los permisos.
 */
import { apiFetch } from "./api"
import { monthLabel, monthName, type YearMonth } from "./commissions"

// --- Periodo ------------------------------------------------------------------------

export const REPORT_PRESETS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"] as const
export type ReportPreset = (typeof REPORT_PRESETS)[number]

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  este_mes: "Este mes",
  mes_pasado: "Mes pasado",
  ultimos_3_meses: "Últimos 3 meses",
  este_ano: "Este año",
}

/** `este_mes`, `mes_pasado`, `ultimos_3_meses`, `este_ano` o `YYYY-MM`; lo demás no es un periodo. */
export function isReportPeriod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ((REPORT_PRESETS as readonly string[]).includes(value) || /^\d{4}-(0[1-9]|1[0-2])$/.test(value))
  )
}

export function monthKey(value: YearMonth): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`
}

export interface ReportSpan {
  from: YearMonth
  to: YearMonth
  /** Termina ahora y no al final del mes. */
  partial: boolean
  start: string
  end: string
}

/** Lo que toda respuesta dice de sí misma. */
export interface ReportHead {
  period: ReportSpan & { key: string }
  previous: ReportSpan
  timezone: string
  locale: string
  currency: string
  branch: { id: string; name: string } | null
}

export interface ReportQuery {
  period: string
  branchId?: string
}

function lower(text: string, locale: string): string {
  return text.charAt(0).toLocaleLowerCase(locale) + text.slice(1)
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month
}

function monthCount(span: Pick<ReportSpan, "from" | "to">): number {
  return (span.to.year - span.from.year) * 12 + (span.to.month - span.from.month) + 1
}

/** «septiembre de 2026», «julio a septiembre de 2026». */
export function spanLabel(span: Pick<ReportSpan, "from" | "to">, locale: string): string {
  if (sameMonth(span.from, span.to)) return lower(monthLabel(span.from, locale), locale)
  const from = span.from.year === span.to.year ? monthName(span.from.month, locale) : monthLabel(span.from, locale)
  return `${lower(from, locale)} a ${lower(monthLabel(span.to, locale), locale)}`
}

/** Rótulo del botón del periodo: «Septiembre de 2026», «Octubre de 2026, hasta hoy». */
export function periodLabel(span: Pick<ReportSpan, "from" | "to" | "partial">, locale: string): string {
  const text = spanLabel(span, locale)
  return `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}${span.partial ? ", hasta hoy" : ""}`
}

/** Contra qué se compara, para la línea bajo el título. */
export function comparedWith(head: Pick<ReportHead, "previous">, locale: string): string {
  const { previous } = head
  if (!previous.partial) return spanLabel(previous, locale)
  return sameMonth(previous.from, previous.to)
    ? `los mismos días de ${spanLabel(previous, locale)}`
    : `el mismo tramo de ${spanLabel(previous, locale)}`
}

/** Cierre de toda comparación: «que en agosto», «que en los mismos días de septiembre». */
export function previousPhrase(head: Pick<ReportHead, "previous">, locale: string): string {
  const { previous } = head
  if (sameMonth(previous.from, previous.to)) {
    const month = lower(monthName(previous.from.month, locale), locale)
    return previous.partial ? `que en los mismos días de ${month}` : `que en ${month}`
  }
  return previous.partial
    ? `que en el mismo tramo de ${previous.to.year}`
    : `que en los ${monthCount(previous)} meses anteriores`
}

// --- Comparación --------------------------------------------------------------------

export interface Comparison {
  text: string
  direction: "up" | "down" | "same"
}

function whole(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

/** «8 % más que en agosto». Sin base con qué comparar no hay frase. */
export function relativeChange(
  current: number,
  previous: number | null | undefined,
  phrase: string,
  locale: string,
): Comparison | null {
  if (previous == null || previous === 0) return null
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 100)
  if (percent === 0) return { text: `Igual ${phrase}`, direction: "same" }
  return {
    text: `${whole(Math.abs(percent), locale)} % ${percent > 0 ? "más" : "menos"} ${phrase}`,
    direction: percent > 0 ? "up" : "down",
  }
}

/** «5 más que en agosto», «2 puntos menos que en agosto», «2 min menos que en agosto». */
export function absoluteChange(
  current: number,
  previous: number | null | undefined,
  phrase: string,
  locale: string,
  unit?: { one: string; many: string },
): Comparison | null {
  if (previous == null) return null
  const difference = Math.round(current - previous)
  if (difference === 0) return { text: `Igual ${phrase}`, direction: "same" }
  const amount = Math.abs(difference)
  const noun = unit ? ` ${amount === 1 ? unit.one : unit.many}` : ""
  return {
    text: `${whole(amount, locale)}${noun} ${difference > 0 ? "más" : "menos"} ${phrase}`,
    direction: difference > 0 ? "up" : "down",
  }
}

export const POINTS = { one: "punto", many: "puntos" }
export const MINUTES = { one: "min", many: "min" }

/** Parte de un total como porcentaje entero; `null` si no hay total (nunca 0 % ni 100 % inventados). */
export function rateOf(part: number, total: number): number | null {
  return total > 0 ? Math.round((part * 100) / total) : null
}

/** «4 min», «40 s», «1 h 20 min». */
export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`
}

// --- Respuestas ---------------------------------------------------------------------

export interface FinanceTotals {
  currency: string
  netoCents: number
  gastadoCents: number
  quedaCents: number
}

export interface MoneyBucket extends FinanceTotals {
  /** Cobrado bruto del tramo. */
  cobradoCents: number
  devolucionesCents: number
  anulacionesCents: number
  /** Efectivo neto del tramo (cobros en efectivo menos lo devuelto o anulado). */
  efectivoCents: number
  byMethod: Array<{ key: string; label: string; cash: boolean; cents: number }>
  byCategory: Array<{ category: string; cents: number }>
}

export interface ReportMoney extends ReportHead {
  byCurrency: MoneyBucket[]
  byProfessional: Array<{ professionalUserId: string; name: string | null; currency: string; cobradoCents: number }>
  byPromotion: Array<{
    promotionId: string
    name: string
    currency: string
    veces: number
    cobradoCents: number
    /** «from»: promoción «desde», con precio distinto en cada caso. */
    mode: "fixed" | "from" | null
    averageCents: number | null
  }>
  /** Lo que se debía al cierre del tramo. */
  outstanding: Array<{ currency: string; pendienteCents: number; pacientes: number }>
  /** Cierres de caja hechos en el tramo, sumados por moneda. */
  closures: Array<{
    currency: string
    cierres: number
    efectivoCents: number
    efectivoDevueltoCents: number
    gastosCajaCents: number
    diferenciasCents: number
  }>
  previousTotals: FinanceTotals[]
  series: Array<YearMonth & { partial: boolean; totals: FinanceTotals[] }>
}

export interface AppointmentTotals {
  total: number
  attended: number
  noShow: number
  cancelled: number
  /** Citas que ya pasaron y nadie marcó. */
  unmarked: number
}

export interface ControlTotals {
  due: number
  came: number
  pending: number
  cancelled: number
  unknown: number
}

export interface ReportAgenda extends ReportHead {
  appointments: AppointmentTotals
  previousAppointments: AppointmentTotals
  byProfessional: Array<{ userId: string; name: string; total: number; attended: number; noShow: number }>
  bySource: Array<{ source: string; count: number }>
  controls: ControlTotals
  previousControls: ControlTotals
  /** «Espera en sala»: mediana de minutos entre «Llegó» y el inicio de la atención; null sin datos. */
  waitInRoom: { medianMinutes: number | null; measured: number; byProfessional: Array<{ userId: string; name: string; medianMinutes: number; measured: number }> }
  previousWaitInRoom: number | null
  wholeClinic: string[]
  series: Array<YearMonth & { partial: boolean } & AppointmentTotals>
}

export interface BudgetTotals {
  currency: string
  accepted: { count: number; cents: number }
  waiting: { count: number; cents: number }
  rejected: { count: number; cents: number }
}

export interface ReportSales extends ReportHead {
  newPatients: number
  previousNewPatients: number
  budgets: BudgetTotals[]
  previousBudgets: BudgetTotals[]
  procedures: Array<{ name: string; currency: string | null; count: number; cents: number }>
  previousProcedureCount: number
  opportunities: Array<{ status: string; count: number }>
  /** Por qué se perdieron las del periodo: clave del motivo y cuántas. */
  lostReasons?: Array<{ reason: string; count: number }>
  wholeClinic: string[]
  series: Array<YearMonth & { partial: boolean; newPatients: number }>
}

export interface ResponseTotals {
  conversations: number
  responded: number
  timedResponses: number
  avgFirstResponseSeconds: number | null
  byAgent: number
  byTeam: number
  handedOff: number
}

export interface ReportService extends ReportHead {
  responses: ResponseTotals
  previousResponses: ResponseTotals
  byChannel: Array<{ channel: string | null; count: number }>
  wholeClinic: string[]
  series: Array<YearMonth & { partial: boolean; conversations: number; responded: number }>
}

export interface ReportOverview extends ReportHead {
  money: Array<{ currency: string; quedaCents: number; previousQuedaCents: number | null }>
  agenda: { attended: number; previousAttended: number }
  sales: { newPatients: number; previousNewPatients: number }
  service: { avgFirstResponseSeconds: number | null; previousAvgFirstResponseSeconds: number | null }
}

export const REPORT_LISTS = [
  "no_show",
  "cancelled",
  "unmarked",
  "controls_pending",
  "budgets_waiting",
  "new_patients",
] as const
export type ReportListKey = (typeof REPORT_LISTS)[number]

export function isReportList(value: unknown): value is ReportListKey {
  return typeof value === "string" && (REPORT_LISTS as readonly string[]).includes(value)
}

export interface ReportListRow {
  id: string
  at: string
  patientId: string
  personName: string
  title: string | null
  professionalName: string | null
  branchName: string | null
  hasNextAppointment: boolean
  cents: number | null
  currency: string | null
}

export interface ReportList extends ReportHead {
  list: ReportListKey
  /** Filas que existen; la respuesta trae como mucho 200. */
  total: number
  rows: ReportListRow[]
}

function params(query: ReportQuery): URLSearchParams {
  const search = new URLSearchParams({ period: query.period })
  if (query.branchId) search.set("branchId", query.branchId)
  return search
}

export type ReportAdviceTab = "dinero" | "agenda" | "ventas"

/** Aviso del administrador junto a una pregunta: una línea suya apagada que hoy tiene casos. */
export interface ReportAdvice {
  tab: ReportAdviceTab
  /** Clave de la recomendación: con ella se abre su lista y su acción. */
  key: string
  title: string
  total: number
  /** Solo en la inasistencia: la cifra del periodo y la del anterior. */
  rate: number | null
  previousRate: number | null
  /** La línea que lo atendería, que hoy está apagada. */
  line: string
}

export function fetchReportAdvice(query: ReportQuery): Promise<{ data: { enabled: boolean; notices: ReportAdvice[] } }> {
  return apiFetch(`/api/reports/advice?${params(query)}`)
}

export type ReportSection = "overview" | "money" | "agenda" | "sales" | "service"

export function fetchReport<T>(section: ReportSection, query: ReportQuery): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(`/api/reports/${section}?${params(query)}`)
}

export function fetchReportList(list: ReportListKey, query: ReportQuery): Promise<{ data: ReportList }> {
  return apiFetch<{ data: ReportList }>(`/api/reports/list/${list}?${params(query)}`)
}

/** Clave de caché de una sección: cambia con el periodo y la sede, que valen para toda la pantalla. */
export function reportKey(section: string, query: ReportQuery): readonly unknown[] {
  return ["report", section, query.period, query.branchId ?? null]
}
