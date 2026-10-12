/**
 * Comisiones de los profesionales y resultado del mes: cliente tipado de
 * `/api/commissions`. Los tipos replican las respuestas del servidor (fechas
 * serializadas como ISO). La moneda no se pide: es la de la clínica y viene en
 * cada respuesta; el servidor decide permisos, importes y estados.
 */
import { currencyFractionDigits } from "@odentia/clinical"
import { apiFetch } from "./api"
import { amountFromCents } from "./workspace"

// --- Mes y porcentaje: presentación -------------------------------------------

export interface YearMonth {
  year: number
  month: number
}

/** Primer año que acepta el servidor para un mes. */
export const FIRST_YEAR = 2000

/** Mes en curso en la zona horaria de la clínica (no la del navegador). */
export function currentMonthIn(timeZone: string | undefined, at: Date = new Date()): YearMonth {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(at)
    const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
    const year = get("year")
    const month = get("month")
    if (Number.isInteger(year) && Number.isInteger(month)) return { year, month }
  } catch {
    // Zona desconocida para el navegador: se usa la del equipo.
  }
  return { year: at.getFullYear(), month: at.getMonth() + 1 }
}

/** Negativo si `a` es anterior a `b`, cero si son el mismo mes. */
export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a.year - b.year || a.month - b.month
}

function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
}

/** Un día a mitad de mes en UTC: ninguna zona lo mueve a otro mes. */
function midMonth(value: YearMonth): Date {
  return new Date(Date.UTC(value.year, value.month - 1, 15))
}

/** «Septiembre de 2026», con el formato de la clínica. */
export function monthLabel(value: YearMonth, locale: string): string {
  return capitalize(
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      midMonth(value),
    ),
    locale,
  )
}

/** «Septiembre» (largo) o «sept» (corto). */
export function monthName(month: number, locale: string, width: "long" | "short" = "long"): string {
  const name = new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" })
    .format(midMonth({ year: 2024, month }))
    .replace(/\.$/, "")
  return capitalize(name, locale)
}

/** «2 de septiembre» en la zona de la clínica; con año si no es el del mes que se mira. */
export function dayLabel(
  iso: string | null | undefined,
  locale: string,
  timeZone: string | undefined,
  referenceYear?: number,
): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const zone = timeZone || undefined
  const year = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric" }).format(date),
  )
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    ...(referenceYear !== undefined && year !== referenceYear ? { year: "numeric" as const } : {}),
    timeZone: zone,
  }).format(date)
}

/** Puntos básicos a «40 %» o «37,5 %» según el formato de la clínica. */
export function percentLabel(rateBps: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(rateBps / 100)} %`
}

/** Texto editable de un porcentaje, compatible con `rateBpsFromPercent`. */
export function percentInput(rateBps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, useGrouping: false }).format(
    rateBps / 100,
  )
}

/** «40» o «40,5» a puntos básicos; null si no es un porcentaje entre 0 y 100 con hasta dos decimales. */
export function rateBpsFromPercent(value: string): number | null {
  const text = value.trim().replace(/\s*%$/, "").replace(",", ".")
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null
  const [whole = "0", fraction = ""] = text.split(".")
  const rateBps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return rateBps >= 0 && rateBps <= 10000 ? rateBps : null
}

/**
 * Importe sin símbolo de moneda («17 800.00»), con el formato de la clínica.
 * Para importes secundarios: el principal de cada bloque lleva su símbolo.
 */
export function plainAmount(cents: number, currency: string, locale: string): string {
  const digits = currencyFractionDigits(currency)
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountFromCents(String(cents), currency))
}

/** Parte de un total como porcentaje entero (0–100); cero si no hay total. */
export function shareOf(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0
  return Math.min(100, Math.round((part * 100) / total))
}

// --- Comisiones -----------------------------------------------------------------

export type CommissionStatus = "por_pagar" | "pagado" | "sin_cobros" | "por_descontar"

/** Estado con palabras. Hay cobros sin comisión cuando el porcentaje es cero. */
export function commissionStatusLabel(status: CommissionStatus, baseCents = 0): string {
  if (status === "por_pagar") return "Por pagar"
  if (status === "pagado") return "Pagado"
  if (status === "por_descontar") return "Por descontar"
  return baseCents > 0 ? "Sin comisión" : "Sin cobros"
}

/** Resumen del mes de un profesional: filas de la lista y meses anteriores. */
export interface CommissionSummary {
  professionalUserId: string
  professionalName: string | null
  year: number
  month: number
  currency: string
  /** Porcentaje vigente en puntos básicos (4000 = 40 %). */
  rateBps: number
  /** Cobros del mes de lo que atendió (sin lo anulado). */
  collections: number
  /** Lo cobrado en el mes de lo que atendió. */
  baseCents: number
  /** Lo que le corresponde por el mes. */
  commissionCents: number
  paidCents: number
  /** Lo que falta pagarle hoy; negativo si queda por descontar. */
  pendingCents: number
  lastPaidAt: string | null
  status: CommissionStatus
}

export interface CommissionLine {
  applicationId: string
  patientId: string
  patientName: string
  description: string
  /** Lo cobrado de ese concepto en ese cobro. */
  baseCents: number
  rateBps: number
  commissionCents: number
  occurredAt: string
  promotionName: string | null
  /** Ya entró en un pago registrado. */
  settled: boolean
  paidAt: string | null
  /** El cobro se anuló después de pagada su comisión: se descuenta del siguiente pago. */
  voidedAfterPaid: boolean
}

/** Comisión ya pagada por un cobro que después se anuló. */
export interface CommissionAdjustment {
  applicationId: string
  patientName: string
  description: string
  commissionCents: number
  paidAt: string | null
}

/** Mes de un profesional con cada cobro. */
export interface MonthlyCommissions extends Omit<CommissionSummary, "collections"> {
  timezone: string
  locale: string
  lines: CommissionLine[]
  adjustments: CommissionAdjustment[]
  adjustmentCents: number
}

/** Lo propio: el mes pedido y hasta tres meses anteriores con cobros. */
export interface MyCommissions extends MonthlyCommissions {
  previous: CommissionSummary[]
}

export interface CommissionRate {
  id: string
  professionalUserId: string
  professionalName: string | null
  rateBps: number
}

/** Pago registrado de una comisión; con `voidedAt`, anulado. */
export interface CommissionPayment {
  id: string
  professionalUserId: string
  professionalName: string | null
  periodYear: number | null
  periodMonth: number | null
  currency: string
  rateBps: number | null
  baseCents: number
  commissionCents: number
  expenseId: string | null
  notes: string | null
  settledAt: string | null
  voidedAt: string | null
  voidReason: string | null
  /** Quién lo anuló; solo llega con `includeVoided`. */
  voidedByName?: string | null
}

function monthParams(query: YearMonth): URLSearchParams {
  return new URLSearchParams({ year: String(query.year), month: String(query.month) })
}

/** El mes de toda la clínica: una fila por profesional (solo administración). */
export function fetchMonthCommissions(query: YearMonth): Promise<{ data: CommissionSummary[] }> {
  return apiFetch<{ data: CommissionSummary[] }>(`/api/commissions/month?${monthParams(query)}`)
}

/** El mes de un profesional con cada cobro. */
export function fetchProfessionalCommissions(
  query: YearMonth & { professionalUserId: string },
): Promise<{ data: MonthlyCommissions }> {
  const params = monthParams(query)
  params.set("professionalUserId", query.professionalUserId)
  return apiFetch<{ data: MonthlyCommissions }>(`/api/commissions/monthly?${params}`)
}

/** Lo de quien está en sesión, con sus meses anteriores. */
export function fetchMyCommissions(query: YearMonth): Promise<{ data: MyCommissions }> {
  return apiFetch<{ data: MyCommissions }>(`/api/commissions/my?${monthParams(query)}`)
}

export function fetchCommissionRates(): Promise<{ data: CommissionRate[] }> {
  return apiFetch<{ data: CommissionRate[] }>("/api/commissions/rates")
}

export function setCommissionRateApi(body: {
  professionalUserId: string
  rateBps: number
}): Promise<{ data: CommissionRate }> {
  return apiFetch<{ data: CommissionRate }>("/api/commissions/rates", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

/**
 * Registra el pago de lo pendiente del mes en un solo paso: congela los cobros,
 * descuenta lo anulado después de pagado y deja el gasto de Personal en la sede.
 */
export function payMonthCommissionApi(
  body: YearMonth & {
    professionalUserId: string
    branchId: string
    notes?: string
    /** Lo que se le mostró a quien confirma; si cambió, el servidor no paga otra cifra. */
    expectedCents?: number
  },
): Promise<{ data: { settlement: CommissionPayment; expense: { id: string } } }> {
  return apiFetch("/api/commissions/pay", { method: "POST", body: JSON.stringify(body) })
}

export function fetchCommissionPayments(
  query: Partial<YearMonth> & { professionalUserId?: string; includeVoided?: boolean },
): Promise<{ data: CommissionPayment[] }> {
  const params = new URLSearchParams()
  if (query.professionalUserId) params.set("professionalUserId", query.professionalUserId)
  if (query.year) params.set("year", String(query.year))
  if (query.month) params.set("month", String(query.month))
  if (query.includeVoided) params.set("includeVoided", "1")
  const suffix = params.size > 0 ? `?${params}` : ""
  return apiFetch<{ data: CommissionPayment[] }>(`/api/commissions/payments${suffix}`)
}

/** Anula un pago y su gasto; sus cobros vuelven a quedar por pagar. */
export function voidCommissionPaymentApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/commissions/payments/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// --- Resultado del mes ------------------------------------------------------------

export interface MonthlyResultBucket {
  currency: string
  /** Cobrado bruto del mes. */
  cobradoCents: number
  devolucionesCents: number
  anulacionesCents: number
  /** Cobrado ya descontadas devoluciones y anulaciones: lo que la pantalla llama «Cobrado». */
  netoCents: number
  gastadoCents: number
  quedaCents: number
  /** Efectivo neto del mes (cobros en efectivo menos lo devuelto o anulado). */
  efectivoCents: number
  byMethod: Array<{ key: string; label: string; cash: boolean; cents: number }>
  byCategory: Array<{ category: string; cents: number }>
}

export interface MonthlyFinanceResult {
  year: number
  month: number
  timezone: string
  locale: string
  branchId: string | null
  branchName: string | null
  byCurrency: MonthlyResultBucket[]
  byProfessional: Array<{
    professionalUserId: string
    name: string | null
    currency: string
    cobradoCents: number
  }>
  byPromotion: Array<{
    promotionId: string
    name: string
    currency: string
    veces: number
    cobradoCents: number
    /** «from»: promoción «desde», con precio distinto en cada caso. */
    mode?: "fixed" | "from" | null
    /** Precio promedio pactado; el servidor lo calcula. */
    averageCents?: number | null
  }>
  outstanding: Array<{ currency: string; pendienteCents: number; pacientes: number }>
  /** Cierres de caja hechos en el mes, sumados por moneda. */
  closures: Array<{
    currency: string
    cierres: number
    /** Cobros en efectivo de esas ventanas. */
    efectivoCents: number
    /** Efectivo devuelto a pacientes en esas ventanas. */
    efectivoDevueltoCents: number
    gastosCajaCents: number
    diferenciasCents: number
  }>
}

export function fetchMonthlyFinanceResult(
  query: YearMonth & { branchId?: string },
): Promise<{ data: MonthlyFinanceResult }> {
  const params = monthParams(query)
  if (query.branchId) params.set("branchId", query.branchId)
  return apiFetch<{ data: MonthlyFinanceResult }>(`/api/commissions/monthly-result?${params}`)
}
