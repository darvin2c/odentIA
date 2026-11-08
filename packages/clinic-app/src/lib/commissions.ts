/**
 * Comisiones de los profesionales: cliente tipado de
 * `/api/commissions`. Los tipos replican las respuestas del servidor (fechas
 * serializadas como ISO). La comisión va en la moneda de lo cobrado: cada
 * respuesta viene en la moneda del negocio, con las otras monedas en `others`;
 * el servidor decide permisos, importes y estados.
 */
import { currencyFractionDigits, formatMoney } from "@odentia/clinical"
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
  /** Sigue en el equipo. Quien salió aparece si tiene cobros del mes, y se le paga igual. */
  inTeam: boolean
  year: number
  month: number
  currency: string
  /** Porcentaje vigente en puntos básicos (4000 = 40 %). */
  rateBps: number
  /** Cuántos servicios tienen otro porcentaje o un monto fijo. */
  exceptionCount?: number
  /** Los porcentajes generales que usaron los cobros del mes (más de uno: «varios porcentajes»). */
  ratesUsed?: number[]
  /** Cobros del mes de lo que atendió (sin lo anulado). */
  collections: number
  /** Lo cobrado en el mes de lo que atendió. */
  baseCents: number
  /** Lo que le corresponde por el mes. */
  commissionCents: number
  paidCents: number
  /** Lo que falta pagarle hoy; negativo si queda por descontar. */
  pendingCents: number
  /**
   * Lo que el próximo pago de este mes descuenta de comisiones ya pagadas de cobros que después se
   * anularon: no es dinero pagado.
   */
  discountCents?: number
  /** De qué pago se descuenta lo que debe después de este mes (ver `MonthlyCommissions`). */
  discountFrom?: DiscountFrom | null
  /**
   * Lo que le debe a la clínica después del próximo pago: comisiones ya pagadas de cobros que
   * después se anularon, sin cobros nuevos en esta moneda de donde descontarlas.
   */
  owedCents?: number
  lastPaidAt: string | null
  status: CommissionStatus
  /** Lo mismo en cada otra moneda con algo del mes (solo en la de la clínica). */
  others?: CommissionSummary[]
}

export interface CommissionLine {
  applicationId: string
  patientId: string
  patientName: string
  description: string
  /** Lo cobrado de ese concepto en ese cobro (su parte, si se reparte por sesiones). */
  baseCents: number
  /** El porcentaje que usó; nulo si fue un monto fijo. */
  rateBps: number | null
  commissionCents: number
  occurredAt: string
  promotionName: string | null
  /** Sesión `slice` de `sessions` de un tratamiento compartido; nulas si es una sola parte. */
  slice: number | null
  sessions: number | null
  /** El monto fijo por procedimiento que usó, si fue una excepción con monto. */
  fixedCents: number | null
  /** El porcentaje o el monto fue una excepción para ese servicio. */
  forService: boolean
  /** Ya entró en un pago registrado. */
  settled: boolean
  paidAt: string | null
  /** El cobro se anuló después de pagada su comisión: se descuenta del siguiente pago. */
  voidedAfterPaid: boolean
  /** Anulado después de pagado: lo que de su comisión aún debe (0 si ya no debe nada). */
  owedLeftCents?: number
  /**
   * Anulado después de pagado y ya sin deuda: cómo se cerró. `pago`, descontado de un pago;
   * `devuelto`, lo devolvió; `saldado`, la clínica lo dio por saldado. Nulo mientras deba.
   */
  owedClosedBy?: "pago" | "devuelto" | "saldado" | null
  /** Lo devuelto o saldado cerró solo lo que quedaba: antes, una parte se descontó de un pago. */
  owedPartlyDiscounted?: boolean
}

/**
 * El mes más antiguo con cobros por pagar de donde se descuenta lo que debe, y cuánto alcanza a
 * descontar ese pago (`cents`): si es menos de lo que debe, el resto espera a los siguientes.
 */
export interface DiscountFrom extends YearMonth {
  cents: number
}

/**
 * Lo que debe, dicho con el pago de donde se descuenta: «Se descuenta del pago de octubre de 2026»
 * o, si ese pago no alcanza, «Se descuentan S/ 150.00 del pago de octubre de 2026 y el resto, de los
 * próximos pagos». Sin mes, del próximo pago.
 */
export function discountFromWords(
  view: { owedCents?: number; currency: string; discountFrom?: DiscountFrom | null },
  locale: string,
): string {
  const from = view.discountFrom
  if (!from) return "Se descuenta del próximo pago."
  const month = monthLabel(from, locale).toLocaleLowerCase(locale)
  return from.cents >= (view.owedCents ?? 0)
    ? `Se descuenta del pago de ${month}, que tiene cobros por pagar.`
    : `Se descuentan ${formatMoney(from.cents, view.currency, locale)} del pago de ${month}, que tiene cobros por pagar, y el resto, de los próximos pagos.`
}

/**
 * La fila de un mes en una moneda: con un pago a cuenta o un descuento, lo que falta pagar; si no, lo que
 * le corresponde. La misma cifra en la lista de la clínica y en «Mis honorarios › Meses anteriores».
 */
export function summaryAmountWords(
  view: Pick<CommissionSummary, "status" | "paidCents" | "discountCents" | "pendingCents" | "commissionCents" | "currency">,
  locale: string,
): string {
  return view.status === "por_pagar" && (view.paidCents > 0 || (view.discountCents ?? 0) > 0)
    ? `Falta ${formatMoney(view.pendingCents, view.currency, locale)}`
    : formatMoney(view.commissionCents, view.currency, locale)
}

/**
 * Lo que se descuenta en una moneda de comisiones ya pagadas, en una frase: «S/ 210.00 por descontar»,
 * con lo que queda para los próximos pagos o de qué pago se descuenta. Nulo si no hay nada.
 */
export function summaryDiscountWords(
  view: Pick<CommissionSummary, "discountCents" | "owedCents" | "pendingCents" | "currency" | "discountFrom">,
  locale: string,
): string | null {
  const discount = view.discountCents ?? 0
  const owed = view.owedCents ?? 0
  const money = (cents: number) => formatMoney(cents, view.currency, locale)
  if (discount > 0) return `${money(discount)} por descontar${owed > 0 ? ` este mes y ${money(owed)} en los próximos pagos` : ""}`
  if (owed <= 0 || view.pendingCents > 0) return null
  const from = view.discountFrom
  return from
    ? `${money(owed)} por descontar, desde el pago de ${monthLabel(from, locale).toLocaleLowerCase(locale)}`
    : `${money(owed)} por descontar del próximo pago`
}

/** Lo que cerró, en un mes, la deuda de sus cobros anulados después de pagados (ver el servidor). */
export interface CommissionDebtClosure {
  settlementId: string
  kind: "devuelto" | "saldado"
  cents: number
  settledAt: string | null
  notes: string | null
}

/**
 * Por qué «Ya pagado» supera la comisión del mes: «Devolvió S/ 210.00 el 8 de noviembre» o «Se dio por
 * saldado S/ 210.00 el 8 de noviembre: <motivo>».
 */
export function debtClosureWords(
  closure: CommissionDebtClosure,
  currency: string,
  locale: string,
  day: (iso: string) => string,
): string {
  const amount = formatMoney(closure.cents, currency, locale)
  const on = closure.settledAt ? ` el ${day(closure.settledAt)}` : ""
  if (closure.kind === "devuelto") return `Devolvió ${amount}${on}`
  return `Se dio por saldado ${amount}${on}${closure.notes ? `: ${closure.notes}` : ""}`
}

/** Comisión ya pagada por un cobro que después se anuló. */
export interface CommissionAdjustment {
  applicationId: string
  patientName: string
  description: string
  commissionCents: number
  paidAt: string | null
}

/** Mes de un profesional con cada cobro, en una moneda. */
export interface MonthlyCommissions extends Omit<CommissionSummary, "collections" | "others"> {
  timezone: string
  locale: string
  lines: CommissionLine[]
  adjustments: CommissionAdjustment[]
  /** Lo que queda por descontarle de cobros anulados después de pagados, de cualquier mes. */
  adjustmentCents: number
  /** Lo que el próximo pago de este mes descuenta. */
  discountCents: number
  /** Lo que los pagos de este mes ya descontaron de cobros anulados. */
  discountedCents: number
  /** Lo devuelto o saldado de los cobros anulados de este mes: por qué «Ya pagado» supera la comisión. */
  debtClosures?: CommissionDebtClosure[]
  /** Con algo que deber después de este mes: el pago de otro mes de donde se descuenta. */
  discountFrom?: DiscountFrom | null
  /**
   * Su sueldo del mes, si tiene uno anotado como gasto que se repite (`null` si no): se paga en
   * Gastos y va aparte de la comisión.
   */
  salary?: {
    cents: number
    paidCents: number
    dueCents: number
    paidAt: string | null
    /** Cuándo vence lo que falta (`YYYY-MM-DD`) y en qué sede se paga. */
    dueOn?: string | null
    dueBranchId?: string | null
  } | null
  /** Desde cuándo vale el porcentaje general (nulo si desde siempre) y el anterior. */
  rateSince?: string | null
  /** Ya tiene un porcentaje general (cambiarlo vale desde hoy; el primero, también para lo ya cobrado). */
  hasRate?: boolean
  previousRateBps?: number | null
  /** Otro porcentaje o un monto fijo para un servicio, lo que rige hoy. */
  exceptions?: CommissionException[]
  /** El mismo mes en cada otra moneda con algo que mirar (solo en la de la clínica). */
  others?: MonthlyCommissions[]
}

export interface CommissionException {
  serviceId: string
  serviceName: string
  rateBps: number | null
  fixedCents: number | null
  /** La moneda del monto fijo; si ya no es la del servicio, no vale hasta escribirlo de nuevo. */
  fixedCurrency?: string | null
  servicePriceCents?: number
  serviceCurrency?: string
  billingMode?: string
  effectiveFrom: string | null
}

/** Lo propio: el mes pedido y hasta tres meses anteriores con cobros. */
export interface MyCommissions extends MonthlyCommissions {
  previous: CommissionSummary[]
  /**
   * Lo atendido en el mes que aún no se cobra (su parte llega al cobrarse): lo que falta en cada
   * moneda y cada servicio con su día, sin paciente ni importe.
   */
  attended?: {
    currencies: Array<{ currency: string; unpaidCents: number }>
    items: Array<{ id: string; description: string; attendedAt: string; currency: string }>
  }
}

/** Lo que falta pagar de todos los meses: el total de hoy y cada mes con cobros sin pagar. */
export interface CommissionsOwed {
  currency: string
  owedCents: number
  months: Array<YearMonth & { cents: number; professionals: number }>
  /** Lo mismo en cada otra moneda con algo por pagar. */
  others?: Array<Omit<CommissionsOwed, "others">>
}

/** Lo cobrado de sesiones que aún nadie hizo, por moneda: hoy no es de nadie. */
export interface UnassignedCommissionSessions {
  currency: string
  /** De tratamientos que siguen: será de quien haga cada sesión. */
  pendingCents: number
  /** De tratamientos cancelados o reemplazados: no se le paga a nadie. */
  stoppedCents: number
}

export function fetchUnassignedCommissionSessions(): Promise<{ data: UnassignedCommissionSessions[] }> {
  return apiFetch("/api/commissions/unassigned")
}

export function fetchCommissionsOwed(): Promise<{ data: CommissionsOwed }> {
  return apiFetch("/api/commissions/owed")
}

export interface CommissionRate {
  id: string
  professionalUserId: string
  professionalName: string | null
  rateBps: number
}

/**
 * Qué registra cada fila de los pagos: un pago (o un descuento sin pago), o lo que cerró lo que el
 * profesional debía: `devuelto` (lo devolvió) o `saldado` (la clínica lo perdonó).
 */
export type CommissionPaymentKind = "pago" | "devuelto" | "saldado"

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
  /** Sin él (respuestas de antes), un pago. */
  kind?: CommissionPaymentKind
  /** Lo devuelto: su medio, UN/CEFACT 4461 (10 efectivo, 30 transferencia, 48 tarjeta). */
  methodTypeCode?: string | null
  /** De lo que se dio por saldado, su motivo. */
  notes: string | null
  settledAt: string | null
  /** Quién lo registró. */
  settledByName?: string | null
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

/** Otro porcentaje o un monto fijo para un servicio; sin los dos, se quita. */
export function setCommissionExceptionApi(body: {
  professionalUserId: string
  serviceId: string
  rateBps?: number | null
  fixedCents?: number | null
}): Promise<{ data: unknown }> {
  return apiFetch("/api/commissions/exceptions", { method: "PUT", body: JSON.stringify(body) })
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
 * descuenta lo anulado después de pagado y deja el pago de comisiones en Gastos, en la sede.
 */
export function payMonthCommissionApi(
  body: YearMonth & {
    professionalUserId: string
    branchId: string
    /** La moneda que se paga; sin ella, la de la clínica. */
    currency?: string
    notes?: string
    /** Lo que se le mostró a quien confirma; si cambió, el servidor no paga otra cifra. */
    expectedCents?: number
    /** Salió del efectivo de la caja de la sede. */
    fromCash?: boolean
  },
): Promise<{ data: { settlement: CommissionPayment; expense: { id: string } | null } }> {
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

/** Cómo devolvió el profesional lo que debía (UN/CEFACT 4461). */
export const RETURN_METHODS = [
  { value: "10", label: "En efectivo" },
  { value: "30", label: "Transferencia" },
  { value: "48", label: "Tarjeta" },
] as const
export type ReturnMethod = (typeof RETURN_METHODS)[number]["value"]

/** «en efectivo», «por transferencia», «con tarjeta»: el medio de lo devuelto, para una frase. */
export function returnMethodWords(typeCode: string | null | undefined): string {
  if (typeCode === "10") return "en efectivo"
  if (typeCode === "30") return "por transferencia"
  if (typeCode === "48") return "con tarjeta"
  return ""
}

/** Los mismos límites que `POST /api/commissions/debt`: el motivo de darlo por saldado es corto. */
export const FORGIVE_REASON_MAX = 200

/**
 * Cierra lo que el profesional debe en una moneda: lo devolvió (con su medio; en efectivo, a la caja
 * de una sede) o la clínica lo da por saldado (con su motivo). La deuda queda en cero.
 */
export function settleCommissionDebtApi(
  body: YearMonth & {
    professionalUserId: string
    currency?: string
    kind: "devuelto" | "saldado"
    methodTypeCode?: ReturnMethod
    branchId?: string
    notes?: string
    /** Lo que se le mostró a quien confirma; si cambió, el servidor no registra otra cifra. */
    expectedCents?: number
  },
): Promise<{ data: { settlement: CommissionPayment; movementId: string | null } }> {
  return apiFetch("/api/commissions/debt", { method: "POST", body: JSON.stringify(body) })
}

/**
 * «Ver los 16 cobros», o con anulados después de pagados, «Ver los 15 cobros y el anulado»: el mismo
 * número que el encabezado, que no cuenta lo anulado.
 */
export function showAllLabel(lines: ReadonlyArray<Pick<CommissionLine, "voidedAfterPaid">>): string {
  const voided = lines.filter((line) => line.voidedAfterPaid).length
  const counted = lines.length - voided
  const cobros = counted === 1 ? "el cobro" : `los ${counted} cobros`
  if (voided === 0) return `Ver ${cobros}`
  if (counted === 0) return voided === 1 ? "Ver el anulado" : `Ver los ${voided} anulados`
  return `Ver ${cobros} y ${voided === 1 ? "el anulado" : `los ${voided} anulados`}`
}

/** Anula un pago y su gasto; sus cobros vuelven a quedar por pagar. */
export function voidCommissionPaymentApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/commissions/payments/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}
