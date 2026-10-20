/**
 * Reportes: cliente tipado de `/api/reports` y las frases con que la pantalla
 * dice un periodo y lo compara con el anterior. Los tipos replican las
 * respuestas del servidor; él decide el tramo, la moneda y los permisos.
 */
import { apiFetch } from "./api"
import { channelLabel } from "./channels"
import { monthLabel, monthName, type YearMonth } from "./commissions"
import type { ReportGoals } from "./reports-ask"

// --- Periodo ------------------------------------------------------------------------

export const REPORT_PRESETS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"] as const
export type ReportPreset = (typeof REPORT_PRESETS)[number]

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  este_mes: "Este mes",
  mes_pasado: "Mes pasado",
  ultimos_3_meses: "Últimos 3 meses",
  este_ano: "Este año",
}

/** Un rango de días: `2026-09-10..2026-09-25`, ambos incluidos. */
const RANGE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

/** `este_mes`, `mes_pasado`, `ultimos_3_meses`, `este_ano`, `YYYY-MM` o un rango; lo demás no es un periodo. */
export function isReportPeriod(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ((REPORT_PRESETS as readonly string[]).includes(value) || /^\d{4}-(0[1-9]|1[0-2])$/.test(value) || RANGE.test(value))
  )
}

/** Los días de un periodo de rango; `null` si es de meses. */
export function rangeOfPeriod(value: string): { from: string; to: string } | null {
  const match = RANGE.exec(value)
  return match ? { from: match[1] as string, to: match[2] as string } : null
}

export function rangePeriod(from: string, to: string): string {
  return `${from}..${to}`
}

export function monthKey(value: YearMonth): string {
  return `${value.year}-${String(value.month).padStart(2, "0")}`
}

export interface ReportSpan {
  from: YearMonth
  to: YearMonth
  /** Termina ahora y no al final del mes o del día. */
  partial: boolean
  start: string
  end: string
  /** En un rango, sus días (fecha local, ambos incluidos). */
  days?: { from: string; to: string }
}

/** Cómo se agrupan los gráficos del periodo. */
export type ReportGrain = "month" | "week" | "day"

/** Lo que toda respuesta dice de sí misma. */
export interface ReportHead {
  period: ReportSpan & { key: string; kind: "months" | "range"; grain: ReportGrain }
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

/** Una fecha civil (`YYYY-MM-DD`) escrita sin moverla de día: «14 de septiembre de 2026». */
export function dayText(day: string, locale: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" }): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))
}

/** «del 10 al 25 de septiembre de 2026», «del 28 de agosto al 3 de septiembre de 2026». */
export function daysLabel(days: { from: string; to: string }, locale: string): string {
  const [fromYear, fromMonth] = days.from.split("-")
  const [toYear, toMonth] = days.to.split("-")
  if (days.from === days.to) return `el ${dayText(days.to, locale)}`
  const from =
    fromYear !== toYear
      ? dayText(days.from, locale)
      : fromMonth !== toMonth
        ? dayText(days.from, locale, { day: "numeric", month: "long" })
        : dayText(days.from, locale, { day: "numeric" })
  return `del ${from} al ${dayText(days.to, locale)}`
}

/** «septiembre de 2026», «julio a septiembre de 2026», «del 10 al 25 de septiembre de 2026». */
export function spanLabel(span: Pick<ReportSpan, "from" | "to" | "days">, locale: string): string {
  if (span.days) return daysLabel(span.days, locale)
  if (sameMonth(span.from, span.to)) return lower(monthLabel(span.from, locale), locale)
  const from = span.from.year === span.to.year ? monthName(span.from.month, locale) : monthLabel(span.from, locale)
  return `${lower(from, locale)} a ${lower(monthLabel(span.to, locale), locale)}`
}

/** Rótulo del botón del periodo: «Septiembre de 2026», «Octubre de 2026, hasta hoy», «Del 10 al 25 de septiembre de 2026». */
export function periodLabel(span: Pick<ReportSpan, "from" | "to" | "partial" | "days">, locale: string): string {
  const text = spanLabel(span, locale)
  return `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}${span.partial ? ", hasta hoy" : ""}`
}

/** Contra qué se compara, para la línea bajo el título. */
export function comparedWith(head: Pick<ReportHead, "previous">, locale: string): string {
  const { previous } = head
  if (previous.days) return `los mismos días justo antes: ${daysLabel(previous.days, locale)}`
  if (!previous.partial) return spanLabel(previous, locale)
  return sameMonth(previous.from, previous.to)
    ? `los mismos días de ${spanLabel(previous, locale)}`
    : `el mismo tramo de ${spanLabel(previous, locale)}`
}

/** Cierre de toda comparación: «que en agosto», «que en los mismos días de septiembre». */
export function previousPhrase(head: Pick<ReportHead, "previous">, locale: string): string {
  const { previous } = head
  if (previous.days) {
    const count = Math.round((Date.parse(`${previous.days.to}T00:00:00Z`) - Date.parse(`${previous.days.from}T00:00:00Z`)) / 86_400_000) + 1
    return count === 1 ? "que el día anterior" : `que en los ${count} días anteriores`
  }
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

export const REPORT_LISTS = [
  "no_show",
  "cancelled",
  "unmarked",
  "new_patients",
  // Pacientes: las personas de cada paso del embudo, las que se cayeron en él y las de «Si vuelven».
  "funnel_sought",
  "funnel_booked",
  "funnel_came",
  "funnel_budget",
  "funnel_accepted",
  "funnel_paid",
  "funnel_lost_booked",
  "funnel_lost_came",
  "funnel_lost_budget",
  "funnel_lost_accepted",
  "funnel_lost_paid",
  "funnel_stopped",
  "controls_missed",
  "lapsed",
  "debts_overdue",
  "agent_booked",
  "agent_handoffs",
  "debts_age_0_30",
  "debts_age_31_60",
  "debts_age_61_90",
  "debts_age_90_plus",
  "upcoming_unbooked",
] as const
export type ReportListKey = (typeof REPORT_LISTS)[number]

export function isReportList(value: unknown): value is ReportListKey {
  return typeof value === "string" && (REPORT_LISTS as readonly string[]).includes(value)
}

export interface ReportListRow {
  id: string
  at: string
  /** Null: la persona escribió pero aún no es paciente. */
  patientId: string | null
  personName: string
  /** Canal por el que nos buscó: solo viaja en las listas del embudo. */
  channel?: string | null
  title: string | null
  professionalName: string | null
  branchName: string | null
  hasNextAppointment: boolean
  cents: number | null
  currency: string | null
  /** La fila lleva a su conversación en la Bandeja. */
  conversationId?: string | null
}

export interface ReportList extends ReportHead {
  list: ReportListKey
  /** Con una sede elegida, la lista no es de una sede (personas del embudo, controles): es de toda la clínica. */
  wholeClinic?: boolean
  /** Los plazos de las listas de Pacientes, para decirlos en «Cómo se calcula». */
  rules?: { stoppedDays: number; lapsedMonths: number }
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

export type ReportSection =
  | "summary"
  | "professionals"
  | "agenda"
  | "agent"
  | "finance"
  | "finance/commissions"
  | "finance/outlook"
  | "finance/promotions"

// --- Resumen ------------------------------------------------------------------------

/** Un tramo de gráfico: un mes, una semana o un día, con sus días. */
export interface ReportBucket {
  key: string
  firstDay: string
  lastDay: string
  /** No está completo: el periodo lo corta o todavía corre. */
  partial: boolean
}

export interface ReportSummary extends ReportHead {
  /** Los 12 meses de cada línea pequeña. */
  months: ReportBucket[]
  collected: {
    currency: string
    current: number
    previous: number
    months: number[]
    others: Array<{ currency: string; current: number; previous: number }>
  }
  newPatients: { current: number; previous: number; months: number[] }
  acceptance: {
    current: { presented: number; accepted: number }
    previous: { presented: number; accepted: number }
    months: Array<{ presented: number; accepted: number }>
  }
  noShow: {
    current: { noShow: number; total: number }
    previous: { noShow: number; total: number }
    months: Array<{ noShow: number; total: number }>
  }
  agent: {
    /** `collectedCents`: lo cobrado en esas citas, en la moneda de la clínica (Reportes › Agente). */
    current: { booked: number; recovered: number; collectedCents: number }
    previous: { booked: number; recovered: number }
    months: number[]
  }
  overdue: {
    currency: string
    days: number
    current: { cents: number; people: number }
    previous: { cents: number; people: number }
    months: number[]
  }
  chart: Array<ReportBucket & { cents: number; previousCents: number }>
  wholeClinic: string[]
  /** Las metas del mes y su avance (ADR 0071); null con una sede elegida: son de toda la clínica. */
  goals: ReportGoals | null
}

/** Resumen › Por profesional: va aparte porque es la consulta más pesada. */
export interface ReportProfessionals extends ReportHead {
  rows: Array<{
    userId: string
    name: string
    attended: number
    noShow: number
    total: number
    presented: number
    accepted: number
    collectedCents: number
    /** Minutos de su horario y de citas en el periodo: «Ocupado». */
    availMin: number
    occMin: number
  }>
}

// --- Pacientes ----------------------------------------------------------------------

/** Los pasos del embudo, en orden: cada uno cuenta a quien dio también los anteriores. */
export const FUNNEL_STEPS = ["sought", "booked", "came", "budget", "accepted", "paid"] as const
export type FunnelStep = (typeof FUNNEL_STEPS)[number]
export type FunnelCounts = Record<FunnelStep, number>

/** Reportes › Pacientes y la tarjeta del embudo del Resumen. */
export function fetchPatientsReport<T>(section: "patients" | "funnel", query: ReportQuery): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(`/api/reports/${section}?${params(query)}`)
}

/** Por dónde nos buscó: el canal de su primera conversación, «Recepción» si lo registró el equipo. */
export function firstContactChannel(channel: string | null): string {
  if (channel === "recepcion") return "Recepción"
  if (channel === "registro_en_linea") return "Registro en línea"
  return channel ? channelLabel(channel) : "Canal retirado"
}

/** Resumen › «Dónde se caen los pacientes»: el embudo del periodo y del anterior. */
export interface ReportFunnel extends ReportHead {
  funnel: {
    current: FunnelCounts
    previous: FunnelCounts
    /** El periodo terminó hace menos de `openDays` días: sus personas aún pueden agendar. */
    open: boolean
    openDays: number
  }
  wholeClinic: string[]
}

export interface ReportPatients extends ReportHead {
  /** Los 12 meses de la línea de «Volvieron en el año». */
  months: ReportBucket[]
  funnel: ReportFunnel["funnel"] & {
    /** De las que no agendaron, cuántas preguntaron algo y dejaron de escribir hace más de `stoppedDays` días. */
    stopped: number
    stoppedDays: number
  }
  /** Canal de la primera conversación (`recepcion` y `registro_en_linea` sin conversación; nulo si el canal ya no existe). */
  channels: Array<{ channel: string | null; sought: number; came: number }>
  newPatients: { current: number; previous: number }
  acceptance: { current: { presented: number; accepted: number }; previous: { presented: number; accepted: number } }
  active: { current: number; previous: number; months: number }
  /** Cómo nos conocieron los pacientes nuevos; `kind` nulo: no lo dijeron. */
  referral: Array<{ kind: string | null; count: number }>
  controls: { current: ControlTotals; previous: ControlTotals }
  returned: {
    current: { cohort: number; returned: number }
    previous: { cohort: number; returned: number }
    months: Array<{ cohort: number; returned: number }>
  }
  lapsed: { count: number; months: number }
  wholeClinic: string[]
}

/** Rótulo corto de un tramo bajo su columna: «sep», «14 sep», «14». */
export function bucketShort(bucket: ReportBucket, grain: ReportGrain, locale: string): string {
  if (grain === "month") return monthName(Number(bucket.firstDay.slice(5, 7)), locale, "short").toLocaleLowerCase(locale).replace(/\./g, "")
  if (grain === "week") return dayText(bucket.firstDay, locale, { day: "numeric", month: "short" }).replace(/\./g, "")
  return dayText(bucket.firstDay, locale, { day: "numeric" })
}

/** Nombre entero de un tramo: «Septiembre de 2026», «Semana del 14 al 20 de septiembre de 2026», «Lunes 14 de septiembre de 2026». */
export function bucketLabel(bucket: ReportBucket, grain: ReportGrain, locale: string): string {
  const upper = (text: string): string => text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
  if (grain === "month") return monthLabel({ year: Number(bucket.firstDay.slice(0, 4)), month: Number(bucket.firstDay.slice(5, 7)) }, locale)
  if (grain === "week") return `Semana ${daysLabel({ from: bucket.firstDay, to: bucket.lastDay }, locale)}`
  return upper(dayText(bucket.firstDay, locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))
}

/** «por mes», «por semana», «por día». */
export const GRAIN_WORD: Record<ReportGrain, string> = { month: "por mes", week: "por semana", day: "por día" }

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

// --- Agente -------------------------------------------------------------------------

export interface AgentFirstResponses {
  conversations: number
  responded: number
  byAgent: number
  byTeam: number
  /** Mediana hasta la primera respuesta, en segundos; null sin respuestas medidas. */
  agentMedianSeconds: number | null
  teamMedianSeconds: number | null
}

export interface AgentBillingLine {
  kind: "conversacion" | "consulta" | "cita"
  count: number
  /** Precio de cada una si todas lo comparten. */
  unitMicros: number | null
  amountCents: number
}

/** Lo pagado a odentIA por el agente: las cuentas de Facturación, en la moneda del plan. */
export interface AgentBilling {
  /** Null sin plan: no hay importe que mostrar. */
  currency: string | null
  /** Si se factura: `no` es «así sería tu factura» (demo, prueba o sin plan, `notCharged`); `en_parte`, `uncharged` queda fuera. */
  charging: "si" | "no" | "en_parte"
  notCharged: "demo" | "prueba" | "sin_plan" | null
  lines: AgentBillingLine[]
  refunds: { count: number; amountCents: number }
  totalCents: number
  coveredCents: number
  overCents: number
  /** De lo que pasó del crédito, lo del mes que corre: se cobrará al cerrarlo. */
  pendingCents: number
  uncharged: { count: number; amountCents: number }
  trial: { count: number; amountCents: number }
  unpriced: number
  /** Cuántos meses del plan toca el periodo: cada uno trae su crédito. */
  planMonths: number
  /** Cuándo empieza el primero de esos meses (ISO): de ahí el día en que se renueva el crédito. */
  planStart: string | null
  /** Crédito de cada mes del periodo; null si no todos traen el mismo. */
  planCreditCents: number | null
  tax: { label: string; rateBps: number } | null
}

export interface ReportAgent extends ReportHead {
  months: ReportBucket[]
  conversations: { current: { attended: number; alone: number }; previous: { attended: number; alone: number }; months: number[] }
  booked: { current: { booked: number; attended: number }; previous: { booked: number; attended: number }; months: number[] }
  recovered: { current: number; previous: number; months: number[] }
  dictated: { current: number; previous: number; months: number[] }
  /** Lo cobrado en sus citas, hasta hoy, en la moneda de la clínica; otras monedas aparte. */
  collected: {
    currency: string
    booked: { visits: number; cents: number }
    recovered: { visits: number; cents: number }
    others: Array<{ currency: string; cents: number }>
  }
  /** Null: quien mira no ve Facturación. */
  paid: AgentBilling | null
  /** Citas que agendó por tramo (null antes de que empezara) y todas las reservadas. */
  chart: Array<ReportBucket & { booked: number | null; all: number }>
  since: string | null
  responses: {
    current: AgentFirstResponses
    previous: AgentFirstResponses
    handedOff: number
    previousHandedOff: number
    byChannel: Array<{ channel: string | null; count: number }>
  }
  wholeClinic: string[]
}
// --- Finanzas (fase 3) ----------------------------------------------------------------

/** Un tramo de Finanzas: lo cobrado, la comisión que generó, los demás gastos y lo que deja. */
export interface FinanceSpan {
  cobradoCents: number
  commissionCents: number
  otherExpensesCents: number
  leavesCents: number
  /** Lo cobrado menos todo lo gastado, también el pago de comisiones. */
  cashLeftCents: number
}

export type DebtAgeKey = "0_30" | "31_60" | "61_90" | "90_plus"

export interface ReportFinance extends ReportHead {
  months: ReportBucket[]
  totals: { current: FinanceSpan; previous: FinanceSpan }
  trend: FinanceSpan[]
  otherCurrencies: Array<{ currency: string; cobradoCents: number }>
  commissions: { generatedCents: number; paidCents: number; pendingCents: number; professionals: number }
  cascade: {
    cobradoCents: number
    commissionCents: number
    categories: Array<{ category: string; cents: number }>
    purchasePaidCents: number
    commissionPaidCents: number
    leavesCents: number
  }
  chart: Array<ReportBucket & FinanceSpan>
  debts: {
    current: { totalCents: number; people: number; ages: Array<{ key: DebtAgeKey; cents: number; people: number }> }
    previousOverdueCents: number
    overdueCents: number
  }
  payables: {
    commissions: { cents: number; professionals: number }
    purchases: { cents: number; orders: number; oldestReceivedAt: string | null }
  }
  missing: Array<{
    category: string
    branch: { id: string; name: string }
    previous: Array<{ month: string; cents: number }>
    copy: { month: string; concept: string; amountCents: number; day: number }
  }>
  byMethod: { methods: Array<{ label: string; cash: boolean; cents: number }>; closures: { count: number; cashCents: number } }
  byTreatment: { rows: Array<{ name: string; cents: number }>; others: { count: number; cents: number } | null }
}

export interface ReportCommissions extends ReportHead {
  rows: Array<{
    userId: string
    name: string
    attendedCents: number
    unpaidCents: number
    collectedCents: number
    rateBps: number
    commissionCents: number
    paidCents: number
    pendingCents: number
    discountCents: number
  }>
}

export interface ReportOutlook extends ReportHead {
  upcoming: { cents: number; patients: number; unbooked: { cents: number; patients: number } }
  patientValue: { patients: number; averageCents: number | null }
  wholeClinic: string[]
}

export type PromotionVerdict = "solo_bajo_precio" | "trajo_nuevos" | "volvieron" | "aceptaron"

export interface ReportPromotions extends ReportHead {
  promotions: Array<{
    promotionId: string
    name: string
    startsAt: string | null
    endsAt: string | null
    people: number
    fresh: number
    accepted: number
    paidSome: number
    returned: number
    discountCents: number
    collectedCents: number
    verdict: PromotionVerdict
  }>
  people: number
  fresh: number
  discountCents: number
  collectedCents: number
  loose: { count: number; cents: number }
  wholeClinic: string[]
}

// --- Agenda (fase 3) ------------------------------------------------------------------

export interface AgendaOccupancy {
  availMin: number
  occMin: number
}

export interface AgendaReport extends ReportHead {
  months: ReportBucket[]
  appointments: { current: AppointmentTotals; previous: AppointmentTotals; months: AppointmentTotals[] }
  occupancy: { current: AgendaOccupancy; previous: AgendaOccupancy; months: AgendaOccupancy[] }
  chart: Array<ReportBucket & AppointmentTotals>
  professionals: Array<{
    userId: string
    name: string
    attended: number
    noShow: number
    cancelled: number
    unmarked: number
    availMin: number
    occMin: number
    waitMinutes: number | null
  }>
  waitInRoom: { medianMinutes: number | null; measured: number }
  map: {
    days: Array<{ day: string; weekday: number; userId: string; scheduledMin: number; availMin: number; occMin: number; assumed: boolean }>
    hours: Array<{ month: string; hour: number; userId: string; availMin: number; occMin: number }>
    week: Array<{ weekday: number; hour: number; userId: string; availMin: number; occMin: number }>
    firstSchedule: Array<{ userId: string; day: string }>
    assumed: boolean
  }
}

/** Compras de Inventario por pagar (Finanzas › Gastos y «¿Es el pago de una compra?»). */
export interface PurchaseBalance {
  orderId: string
  orderNumber: number
  supplierId: string
  supplierName: string
  status: string
  currency: string
  branchId: string
  branchName: string
  orderedCents: number
  receivedCents: number
  cashCents: number
  creditCents: number
  paidCents: number
  dueCents: number
  aheadCents: number
  firstReceivedAt: string | null
  createdAt: string
}

export interface PurchasesToPay {
  currency: string
  /** En la moneda de la clínica; otra moneda va aparte, nunca se suma. */
  unpaid: {
    orders: number
    cents: number
    oldest: PurchaseBalance | null
    otherCurrencies: Array<{ currency: string; orders: number; cents: number }>
  }
  orders: PurchaseBalance[]
  credits: Array<{ supplierId: string; supplierName: string; currency: string; cents: number }>
}

/** «OC-0012». */
export function purchaseOrderLabel(orderNumber: number): string {
  return `OC-${String(orderNumber).padStart(4, "0")}`
}

/** Minutos a horas enteras: «62 h». */
export function hoursLabel(minutes: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(minutes / 60))} h`
}
