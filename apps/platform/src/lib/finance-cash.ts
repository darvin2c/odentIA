/**
 * Caja del día: cliente tipado de `/api/finance` (estado de la caja, deudas,
 * movimientos, cierres y gastos) y las reglas de presentación que no dependen
 * de React: un renglón por ticket, a quién se atendió hoy, fechas en la zona
 * de la sede. Los tipos replican lo que serializa el servidor
 * (`packages/services/src/finance.ts`); el servidor valida permisos e importes.
 *
 * Dinero con `@odentia/clinical`; moneda, formato y zona siempre de la clínica
 * o la sede. Aquí no hay país, moneda ni medio de pago escritos.
 */
import { parseMoney } from "@odentia/clinical"
import { minutesToInstant, zonedDateOf } from "@odentia/ui-patterns"
import { type QueryClient, useQuery } from "@tanstack/react-query"
import { ApiError, apiFetch } from "./api"
import { financeErrorMessage } from "./finance"
import type { DebtRow } from "./finance-debt"

/** Efectivo según UN/CEFACT 4461: lo único que se cuenta al cerrar. */
export const CASH_TYPE_CODE = "10"

// --- Estado de la caja: GET /finance/cash ------------------------------------

/** De dónde sale el efectivo que debe haber; siempre suma `cashOnHandCents`. */
export interface CashBreakdown {
  openingCents: number
  cashCollectedCents: number
  cashAddedCents: number
  cashExpensesCents: number
  cashWithdrawnCents: number
  cashRefundedCents: number
}

export interface MethodTotal {
  name: string
  typeCode: string | null
  /** Cobros con ese medio (un ticket con dos medios cuenta en cada uno). */
  count: number
  amountCents: number
  refundedCents: number
}

export interface LastClosure {
  id: string
  closedAt: string
  closedByName: string | null
  differenceCents: number
}

export interface CashState {
  branchId: string
  currency: string
  /** Zona de la sede (o de la clínica si no tiene la suya): parte el día de la caja. */
  timezone: string
  /** Ventana abierta de la sede; null si aún no tiene caja. */
  shiftId: string | null
  openedAt: string | null
  cashOnHandCents: number
  breakdown: CashBreakdown
  byMethod: MethodTotal[]
  tickets: number
  lastClosure: LastClosure | null
}

export function fetchCashState(branchId: string): Promise<{ data: CashState }> {
  return apiFetch<{ data: CashState }>(`/api/finance/cash?branchId=${encodeURIComponent(branchId)}`)
}

export type CashTermKey = keyof CashBreakdown

/** Términos del desglose en el orden en que se leen: lo que entra y lo que sale. */
export const CASH_TERMS: ReadonlyArray<{
  key: CashTermKey
  sign: 1 | -1
  /** Renglón del panel de cierre y de la hoja. */
  label: string
  /** Palabra de la línea resumida de Caja. */
  short: string
}> = [
  { key: "openingCents", sign: 1, label: "Quedó del cierre anterior", short: "Quedó" },
  { key: "cashCollectedCents", sign: 1, label: "Cobros en efectivo", short: "cobros" },
  { key: "cashAddedCents", sign: 1, label: "Efectivo ingresado", short: "ingresado" },
  { key: "cashExpensesCents", sign: -1, label: "Gastos pagados con la caja", short: "gastos" },
  { key: "cashWithdrawnCents", sign: -1, label: "Efectivo retirado", short: "retirado" },
  { key: "cashRefundedCents", sign: -1, label: "Devuelto en efectivo", short: "devuelto" },
]

/** Lo que el panel de cierre y la hoja muestran siempre, aunque valga cero. */
export const CASH_TERMS_ALWAYS: ReadonlySet<CashTermKey> = new Set([
  "openingCents",
  "cashCollectedCents",
  "cashExpensesCents",
])

/** Medios que no son efectivo: no se cuentan, se comparan con su reporte. */
export function otherMethods(byMethod: MethodTotal[]): MethodTotal[] {
  return byMethod.filter((row) => row.typeCode !== CASH_TYPE_CODE)
}

// --- Deudas: GET /finance/debts ------------------------------------------------

export type { DebtRow } from "./finance-debt"

export function fetchDebts(branchId: string): Promise<{ data: DebtRow[] }> {
  return apiFetch<{ data: DebtRow[] }>(`/api/finance/debts?branchId=${encodeURIComponent(branchId)}`)
}

/** Lo que toca cobrar una vez descontado el saldo a favor. */
export function debtDue(row: DebtRow): { dueCents: number; creditUsedCents: number } {
  const creditUsedCents = Math.max(0, Math.min(row.creditCents, row.totalCents))
  return { dueCents: row.totalCents - creditUsedCents, creditUsedCents }
}

/** «Resina, pieza 16 · Profilaxis», con «y N más» si el servidor recortó la lista. */
export function debtConcepts(row: DebtRow): string {
  const rest = row.chargesCount - row.concepts.length
  const listed = row.concepts.join(" · ")
  if (rest <= 0) return listed
  return listed ? `${listed} y ${rest} más` : `${row.chargesCount} conceptos`
}

/**
 * Cuándo salió hoy de su atención (o se le anotó algo hoy); null si debe de
 * antes. La regla es del servidor (`getDebts`): la comparten la Caja e Inicio.
 */
export function attendedTodayAt(row: DebtRow): string | null {
  return row.attendedTodayAt
}

/** Días que lleva debiendo, contados por día de calendario en la zona de la sede. */
export function debtAgeDays(row: DebtRow, timeZone: string, today: string): number | null {
  if (!row.oldestSince) return null
  const since = dayKeyOf(row.oldestSince, timeZone)
  return since ? Math.max(0, daysBetween(since, today)) : null
}

/** Totales por moneda: una deuda en otra moneda nunca se suma a la de la clínica. */
export function totalsByCurrency(rows: Array<{ currency: string; cents: number }>): Array<[string, number]> {
  const totals = new Map<string, number>()
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cents)
  return [...totals.entries()]
}

// --- Movimientos del día: GET /finance/movements ------------------------------------

export type MovementKind = "apertura" | "cobro" | "gasto" | "aporte" | "retiro" | "devolucion"

export interface DayMovement {
  id: string
  /** Ventana a la que pertenece: distingue lo de hoy que ya se cerró de lo abierto. */
  shiftId: string
  direction: "ingreso" | "egreso"
  kind: MovementKind
  amountCents: number
  currency: string
  method: string | null
  methodTypeCode: string | null
  concept: string
  patientPaymentId: string | null
  expenseId: string | null
  createdAt: string
  ticketId: string | null
  ticketNumber: number | null
  patientId: string | null
  patientName: string | null
}

/** Ticket cobrado ese día y ya anulado: sigue a la vista, sin sumar. */
export interface VoidedTicket {
  ticketId: string
  ticketNumber: number
  patientId: string
  patientName: string
  currency: string
  totalCents: number
  methods: Array<{ name: string; amountCents: number }>
  createdAt: string
  voidedAt: string
  voidReason: string | null
}

export interface DayMovementsBody {
  branchId: string
  day: string
  timezone: string
  movements: DayMovement[]
  voidedTickets: VoidedTicket[]
}

export function fetchDayMovements(branchId: string, day: string): Promise<{ data: DayMovementsBody }> {
  const params = new URLSearchParams({ branchId, day })
  return apiFetch<{ data: DayMovementsBody }>(`/api/finance/movements?${params}`)
}

/** Un cobro es un ticket: el pago histórico sin ticket o el movimiento suelto cuentan por sí mismos. */
function ticketKey(row: DayMovement): string {
  if (row.ticketId) return `ticket:${row.ticketId}`
  if (row.patientPaymentId) return `pago:${row.patientPaymentId}`
  return `mov:${row.id}`
}

function leavesCash(row: DayMovement): boolean {
  return row.direction === "egreso" && (row.methodTypeCode === null || row.methodTypeCode === CASH_TYPE_CODE)
}

/** Renglón de «Movimientos de hoy»: un ticket con dos medios es un solo renglón. */
export type DayEntry =
  | {
      type: "cobro"
      key: string
      at: string
      /** Con ticket y persona, el renglón abre el ticket. */
      ticketId: string | null
      /** Anulado: se muestra con su motivo y no suma. */
      voided: { reason: string | null } | null
      ticketNumber: number | null
      patientId: string | null
      patientName: string | null
      currency: string
      totalCents: number
      parts: Array<{ method: string | null; amountCents: number }>
    }
  | {
      type: "gasto" | "aporte" | "retiro" | "devolucion"
      key: string
      at: string
      movementId: string
      concept: string
      method: string | null
      /** El dinero salió del efectivo de la caja (y no por otro medio). */
      fromCash: boolean
      currency: string
      amountCents: number
    }

/**
 * Movimientos del día listos para leer, del más reciente al más antiguo. «Quedó
 * del cierre anterior» no entra: se muestra aparte, con el estado de la caja.
 */
export function groupDayMovements(
  movements: DayMovement[],
  voidedTickets: VoidedTicket[] = [],
): DayEntry[] {
  const entries: DayEntry[] = []
  const tickets = new Map<string, Extract<DayEntry, { type: "cobro" }>>()
  // Anulado con la caja aún abierta, su movimiento ya no llega: el renglón
  // sale del ticket. Anulado tras un cierre, el movimiento sigue y se marca.
  for (const ticket of voidedTickets) {
    const entry: Extract<DayEntry, { type: "cobro" }> = {
      type: "cobro",
      key: `ticket:${ticket.ticketId}`,
      at: ticket.createdAt,
      ticketId: ticket.ticketId,
      voided: { reason: ticket.voidReason },
      ticketNumber: ticket.ticketNumber,
      patientId: ticket.patientId,
      patientName: ticket.patientName,
      currency: ticket.currency,
      totalCents: ticket.totalCents,
      parts: ticket.methods.map((method) => ({ method: method.name, amountCents: method.amountCents })),
    }
    tickets.set(entry.key, entry)
    entries.push(entry)
  }
  for (const row of movements) {
    if (row.kind === "apertura") continue
    if (row.kind === "cobro" && row.direction === "ingreso") {
      const key = ticketKey(row)
      let entry = tickets.get(key)
      // El ticket anulado ya trae su total y sus medios congelados.
      if (entry?.voided) continue
      if (!entry) {
        entry = {
          type: "cobro",
          key,
          at: row.createdAt,
          ticketId: row.ticketId,
          voided: null,
          ticketNumber: row.ticketNumber,
          patientId: row.patientId,
          patientName: row.patientName,
          currency: row.currency,
          totalCents: 0,
          parts: [],
        }
        tickets.set(key, entry)
        entries.push(entry)
      }
      entry.totalCents += row.amountCents
      const part = entry.parts.find((item) => item.method === row.method)
      if (part) part.amountCents += row.amountCents
      else entry.parts.push({ method: row.method, amountCents: row.amountCents })
      continue
    }
    entries.push({
      // Un cobro que sale (no lo produce el servidor) se lee como devolución.
      type: row.kind === "cobro" ? "devolucion" : row.kind,
      key: `mov:${row.id}`,
      at: row.createdAt,
      movementId: row.id,
      concept: row.concept,
      method: row.method,
      fromCash: leavesCash(row),
      currency: row.currency,
      amountCents: row.amountCents,
    })
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/**
 * La ventana abierta guarda dinero de días anteriores: sus totales superan lo
 * que se movió hoy en ella. Es lo que distingue «días sin cerrar» de una caja
 * que simplemente se cerró ayer.
 */
export function hasEarlierDaysOpen(state: CashState, today: DayMovement[]): boolean {
  if (!state.shiftId) return false
  const mine = today.filter((row) => row.shiftId === state.shiftId)
  const sum = (keep: (row: DayMovement) => boolean) =>
    mine.filter(keep).reduce((total, row) => total + row.amountCents, 0)
  const tickets = new Set(
    mine.filter((row) => row.kind === "cobro" && row.direction === "ingreso").map(ticketKey),
  ).size
  return (
    state.tickets > tickets ||
    state.breakdown.cashAddedCents > sum((row) => row.kind === "aporte" && row.direction === "ingreso") ||
    state.breakdown.cashExpensesCents > sum((row) => row.kind === "gasto" && leavesCash(row)) ||
    state.breakdown.cashWithdrawnCents > sum((row) => row.kind === "retiro" && leavesCash(row)) ||
    state.breakdown.cashRefundedCents > sum((row) => row.kind === "devolucion" && leavesCash(row))
  )
}

// --- Ingresar o retirar efectivo ---------------------------------------------------

/** La caja nace sola si la sede aún no tenía. */
export function addCashMovementApi(body: {
  branchId: string
  kind: "aporte" | "retiro"
  amountCents: number
  concept: string
}): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>("/api/finance/cash/movements", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Solo ingresos o retiros hechos a mano; lo demás se anula en su ticket o su gasto. */
export function voidCashMovementApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/movements/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// --- Cierres -----------------------------------------------------------------------

/** Ventana cerrada que devuelve el cierre: su id abre la hoja. */
export interface ClosedWindow {
  id: string
  branchId: string
  currency: string
  countedCents: number | null
  retainedCents: number | null
  deliveredCents: number | null
  differenceCents: number | null
}

export function closeCashApi(body: {
  branchId: string
  /** La ventana que se contó; null afirma que la sede aún no tenía caja. */
  shiftId: string | null
  countedCents: number
  retainedCents: number
  deliveredCents: number
  notes?: string
}): Promise<{ data: ClosedWindow }> {
  return apiFetch<{ data: ClosedWindow }>("/api/finance/closures", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface ClosureListItem {
  id: string
  /** `turno`: cierre anterior a la hoja completa (sin lo que quedó ni lo entregado). */
  source: "cierre" | "turno"
  branchId: string
  currency: string
  closedAt: string | null
  closedBy: string | null
  closedByName: string | null
  expectedCents: number | null
  countedCents: number | null
  differenceCents: number | null
  retainedCents: number | null
  deliveredCents: number | null
  notes: string | null
}

/** Cierres por página; hay más mientras una página llegue completa. */
export const CLOSURES_PAGE = 20

/** `before`: `closedAt` del último cierre ya recibido (página siguiente). */
export function fetchClosures(
  branchId: string,
  before?: string | null,
): Promise<{ data: ClosureListItem[] }> {
  const params = new URLSearchParams({ branchId, limit: String(CLOSURES_PAGE) })
  if (before) params.set("before", before)
  return apiFetch<{ data: ClosureListItem[] }>(`/api/finance/closures?${params}`)
}

export interface ClosureSheet {
  /** Cierre anterior a la hoja completa: sin desglose por medio. */
  legacy: boolean
  closure: {
    id: string
    branchId: string
    currency: string
    windowFrom: string
    windowTo: string | null
    openingRetainedCents: number
    cashCollectedCents: number | null
    cashAddedCents?: number
    expenseCashCents: number
    cashWithdrawnCents?: number
    cashRefundedCents?: number
    expectedCents: number | null
    countedCents: number | null
    differenceCents: number | null
    retainedCents: number | null
    deliveredCents: number | null
    notes: string | null
    closedAt: string | null
  }
  totalsByMethod: MethodTotal[] | null
  branch: { id: string; name: string; timezone: string | null } | null
  orgProfile: {
    legalName: string
    tradeName: string | null
    timezone: string
    /** Ancho de la térmica en milímetros. */
    receiptWidth: string
  } | null
  closedByName: string | null
}

/** Acepta el id del cierre o el de su ventana (el que trae el aviso de diferencia). */
export function fetchClosureSheet(id: string): Promise<{ data: ClosureSheet }> {
  return apiFetch<{ data: ClosureSheet }>(`/api/finance/closures/${encodeURIComponent(id)}`)
}

/** «Cuadró», «Faltaron X» o «Sobraron X», con el importe ya formateado. */
export function differenceLabel(
  differenceCents: number,
  money: (cents: number) => string,
): string {
  if (differenceCents === 0) return "Cuadró"
  return differenceCents < 0
    ? `Faltaron ${money(-differenceCents)}`
    : `Sobraron ${money(differenceCents)}`
}

// --- Gastos --------------------------------------------------------------------------

/** Tipos de gasto que acepta el servidor (`EXPENSE_CATEGORIES`); él valida al guardar. */
export const EXPENSE_CATEGORIES = [
  "Personal",
  "Alquiler",
  "Laboratorio",
  "Materiales",
  "Servicios",
  "Impuestos",
  "Otros",
] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

/** Valor con que el servidor guarda «sin comprobante». */
export const NO_RECEIPT = "ninguno"

export interface ExpenseRow {
  id: string
  branchId: string
  concept: string
  category: string
  amountCents: number
  currency: string
  spentAt: string
  receiptKind: string
  receiptNumber: string | null
  notes: string | null
  voidedAt: string | null
  voidReason: string | null
  /** Salió del efectivo de la caja. */
  fromCash: boolean
}

export interface MonthExpenses {
  year: number
  month: number
  currency: string
  timezone: string
  /** Sin los anulados y solo en la moneda de la clínica. */
  totalCents: number
  byCategory: Array<{ category: string; cents: number }>
  /** Incluye los anulados, marcados. */
  expenses: ExpenseRow[]
}

export function fetchMonthExpenses(query: {
  branchId: string
  year: number
  month: number
}): Promise<{ data: MonthExpenses }> {
  const params = new URLSearchParams({
    branchId: query.branchId,
    year: String(query.year),
    month: String(query.month),
  })
  return apiFetch<{ data: MonthExpenses }>(`/api/finance/expenses/month?${params}`)
}

export function createExpenseApi(body: {
  branchId: string
  concept: string
  amountCents: number
  category: ExpenseCategory
  fromCash: boolean
  receiptKind?: string
  receiptNumber?: string
  spentAt?: string
}): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>("/api/finance/expenses", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidExpenseApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/expenses/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export interface MonthRef {
  year: number
  month: number
}

/** Mes en curso en la zona de la clínica. */
export function currentMonthIn(timeZone: string): MonthRef {
  const [year, month] = todayIn(timeZone).split("-").map(Number)
  return { year, month }
}

/** El mes dado y los anteriores, del más reciente al más antiguo. */
export function monthsBack(from: MonthRef, count: number): MonthRef[] {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(Date.UTC(from.year, from.month - 1 - index, 1))
    return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 }
  })
}

export function monthValue(ref: MonthRef): string {
  return `${ref.year}-${String(ref.month).padStart(2, "0")}`
}

export function parseMonthValue(value: string): MonthRef | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]) }
}

/** «Octubre de 2026» con el formato de la clínica. */
export function formatMonth(ref: MonthRef, locale: string): string {
  const text = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(ref.year, ref.month - 1, 1, 12)))
  return capitalize(text)
}

/** «octubre», para frases como «Gastado en octubre». */
export function formatMonthName(ref: MonthRef, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(ref.year, ref.month - 1, 1, 12)),
  )
}

// --- Consultas compartidas -------------------------------------------------------------

/** Claves de React Query: Caja, sus paneles y el cobro invalidan por estos prefijos. */
export const financeKeys = {
  cash: (branchId: string) => ["finance-cash", branchId] as const,
  debts: (branchId: string) => ["finance-debts", branchId] as const,
  movements: (branchId: string, day: string) => ["finance-movements", branchId, day] as const,
  closures: (branchId: string) => ["finance-closures", branchId] as const,
  closure: (id: string) => ["finance-closure", id] as const,
  expenses: (branchId: string, ref: MonthRef) =>
    ["finance-expenses", branchId, ref.year, ref.month] as const,
}

/** Todo lo que cambia cuando entra o sale dinero, o cuando la caja se cierra. */
export function invalidateFinance(queryClient: QueryClient): void {
  for (const key of [
    "finance-cash",
    "finance-debts",
    "finance-movements",
    "finance-closures",
    "finance-expenses",
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/** Estado de la caja de la sede: lo leen Caja, «Cerrar caja» e «Ingresar o retirar». */
export function useCashState(branchId: string, enabled = true) {
  return useQuery({
    queryKey: financeKeys.cash(branchId),
    queryFn: () => fetchCashState(branchId),
    enabled: enabled && branchId !== "",
  })
}

/**
 * Estado de la consulta de sedes que ya hace `useActiveBranch` (misma clave):
 * distingue «cargando» y «falló» de «no hay sedes». La zona de la sede no
 * sale de aquí: la entrega el estado de la caja.
 */
export function useBranchesStatus(): {
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => void
} {
  const query = useQuery({
    queryKey: ["branches", "activas"],
    queryFn: () =>
      apiFetch<{ data: Array<{ id: string; name: string; isActive: boolean }> }>("/api/branches"),
    staleTime: 60_000,
  })
  return {
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  }
}

// --- Errores ------------------------------------------------------------------------------

export function errorCode(err: unknown): string | null {
  return err instanceof ApiError ? (err.shape.code ?? null) : null
}

export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403
}

/** Rechazos conocidos de caja en lenguaje llano; el resto, el mensaje del servidor. */
export function cashErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case "INSUFFICIENT_CASH":
      return "En la caja no hay tanto efectivo. Revisa el importe."
    case "CASH_WINDOW_CHANGED":
      return "La caja tuvo movimientos mientras contabas. Los importes ya están actualizados: revísalos y vuelve a cerrar."
    case "MOVEMENT_NOT_MANUAL":
      return "Ese movimiento viene de un cobro, un gasto o una devolución: se anula desde su ticket o su gasto."
    case "EXPENSE_IS_COMMISSION":
      return "Ese gasto es el pago de una comisión: se anula desde Comisiones."
    default:
      return financeErrorMessage(err)
  }
}

// --- Dinero y fechas ------------------------------------------------------------------------

/** Lectura de formulario: null si el texto no es un importe válido para la clínica. */
export function parseAmount(raw: string, currency: string, locale: string): number | null {
  try {
    return parseMoney(raw, currency, locale)
  } catch {
    return null
  }
}

function capitalize(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text
}

/** Día `yyyy-mm-dd` de un instante en la zona dada; vacío si el instante no es válido. */
export function dayKeyOf(iso: string, timeZone: string): string {
  return Number.isNaN(Date.parse(iso)) ? "" : zonedDateOf(iso, timeZone)
}

/** Hoy en la zona dada. */
export function todayIn(timeZone: string): string {
  return zonedDateOf(new Date().toISOString(), timeZone)
}

/** Días de calendario entre dos días `yyyy-mm-dd` (positivo si `to` es posterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/** Mediodía local de un día: sitúa un gasto en su día sin depender del cambio de hora. */
export function noonOf(day: string, timeZone: string): string {
  return minutesToInstant(day, 12 * 60, timeZone)
}

function partsOf(
  iso: string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Map<string, string> {
  const parts = new Intl.DateTimeFormat(locale, { ...options, timeZone }).formatToParts(new Date(iso))
  return new Map(parts.map((part) => [part.type, part.value]))
}

/** Hora con el formato de la clínica: «11:40». */
export function formatClock(iso: string, locale: string, timeZone: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—"
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(
    new Date(iso),
  )
}

/** «28 de septiembre»; con el año cuando no es el de hoy. */
export function formatDayMonth(iso: string, locale: string, timeZone: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—"
  const sameYear = dayKeyOf(iso, timeZone).slice(0, 4) === todayIn(timeZone).slice(0, 4)
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(new Date(iso))
}

/** «11 oct», para la cabecera de cada día en una lista. */
export function formatDayShort(iso: string, locale: string, timeZone: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—"
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone })
    .format(new Date(iso))
    .replace(".", "")
}

/** «viernes 9 de octubre», compuesto por partes: algunos formatos meten una coma. */
export function formatWeekdayDay(iso: string, locale: string, timeZone: string): string {
  if (Number.isNaN(Date.parse(iso))) return "—"
  const parts = partsOf(iso, locale, timeZone, { weekday: "long", day: "numeric", month: "long" })
  return `${parts.get("weekday") ?? ""} ${parts.get("day") ?? ""} de ${parts.get("month") ?? ""}`.trim()
}

/** «Domingo 11 de octubre, 19:10». */
export function formatDateTimeLong(iso: string | null, locale: string, timeZone: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—"
  return `${capitalize(formatWeekdayDay(iso, locale, timeZone))}, ${formatClock(iso, locale, timeZone)}`
}

/** «11/10/2026 · 19:10», para la hoja impresa. */
export function formatDateTimeSheet(iso: string | null, locale: string, timeZone: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "—"
  const date = new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone,
  }).format(new Date(iso))
  return `${date} · ${formatClock(iso, locale, timeZone)}`
}

/** Fecha sola `yyyy-mm-dd` dicha con palabras: «Hoy, 11 de octubre» o «5 de octubre». */
export function formatDayKey(day: string, locale: string, today: string): string {
  const [year, month, date] = day.split("-").map(Number)
  const text = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date, 12)))
  return day === today ? `Hoy, ${text}` : text
}

/** Un momento dicho como se habla: «hoy», «ayer» o el día con su nombre. */
export interface SpokenMoment {
  /** `hoy` o `ayer`; null cuando es un día anterior. */
  relative: "hoy" | "ayer" | null
  /** «viernes 9 de octubre». */
  day: string
  time: string
}

export function spokenMoment(iso: string, locale: string, timeZone: string): SpokenMoment {
  const gap = daysBetween(dayKeyOf(iso, timeZone), todayIn(timeZone))
  return {
    relative: gap === 0 ? "hoy" : gap === 1 ? "ayer" : null,
    day: formatWeekdayDay(iso, locale, timeZone),
    time: formatClock(iso, locale, timeZone),
  }
}

/** «ayer 19:10» o «viernes 9 de octubre, 19:10». */
export function momentShort(moment: SpokenMoment): string {
  return moment.relative ? `${moment.relative} ${moment.time}` : `${moment.day}, ${moment.time}`
}

/** «ayer» o «el viernes 9 de octubre», para «desde …». */
export function momentDay(moment: SpokenMoment): string {
  return moment.relative ?? `el ${moment.day}`
}

/** «de ayer a las 19:10» o «del viernes 9 de octubre a las 19:10», para «el cierre …». */
export function momentOf(moment: SpokenMoment): string {
  return moment.relative
    ? `de ${moment.relative} a las ${moment.time}`
    : `del ${moment.day} a las ${moment.time}`
}

/** «Efectivo 200.00 y Yape 250.00»: une con la conjunción del formato de la clínica. */
export function joinList(items: string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items)
}
