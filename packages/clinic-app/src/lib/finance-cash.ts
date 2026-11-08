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
import type { PurchaseBalance, PurchasesToPay } from "./reports"
import { currencyWord, parseMoney, upperFirst } from "@odentia/clinical"
import { minutesToInstant, zonedDateOf } from "@odentia/ui-patterns"
import { type QueryClient, useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { ApiError, apiFetch } from "./api"
import { financeErrorMessage, financeFormMessage } from "./finance"
import type { DebtRow } from "./finance-debt"
import { useOrgSecondCurrency } from "./org"

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
  /** Vuelto en otra moneda, con signo: entra el exceso del billete, sale el vuelto. */
  cashChangeCents: number
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
  /** Los cambios con que se movió dinero en esta ventana; vacío sin otra moneda. */
  ratesUsed?: CashRateUsed[]
  lastClosure: LastClosure | null
}

export interface CashRateUsed {
  rate: string
  cobros: number
  vueltos: number
  byName: string | null
}

/** Sin moneda, la caja de la moneda de la clínica. */
export function fetchCashState(branchId: string, currency?: string): Promise<{ data: CashState }> {
  const params = new URLSearchParams({ branchId })
  if (currency) params.set("currency", currency)
  return apiFetch<{ data: CashState }>(`/api/finance/cash?${params}`)
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
  { key: "cashChangeCents", sign: 1, label: "Vuelto en otra moneda", short: "vuelto" },
]

/**
 * El vuelto va con signo, y los gastos también: lo que vuelve de un gasto (su anulación tras un
 * cierre, o la comisión que un profesional devolvió) puede ser más que lo gastado, y entonces entra.
 * Los demás términos, con el signo de su renglón.
 */
export function cashTermLeaves(term: { sign: 1 | -1 }, cents: number): boolean {
  return term.sign < 0 ? cents >= 0 : cents < 0
}

/** Los gastos de la ventana, cuando volvió más de lo que se gastó: entra a la caja. */
const EXPENSES_BACK_LABEL = "Volvió de gastos y comisiones"

/** Las dos monedas del vuelto cruzado: la de esta caja y la otra, si se sabe. */
export interface ChangeBoxes {
  box: string
  other: string | null
  locale: string
}

/**
 * Dicho según lo que hizo en esta caja: el vuelto salió de aquí o se quedó el exceso
 * del billete. Con las monedas, cada una por su nombre: «Vuelto en soles de cobros en
 * dólares», «Dólares que quedaron por vueltos dados en soles».
 */
export function cashTermLabel(
  term: { key: CashTermKey; label: string },
  cents: number,
  boxes?: ChangeBoxes,
): string {
  if (term.key === "cashExpensesCents" && cents < 0) return EXPENSES_BACK_LABEL
  if (term.key !== "cashChangeCents") return term.label
  if (!boxes) return cents < 0 ? "Vuelto de cobros en otra moneda" : "De más por un vuelto dado en otra moneda"
  const box = currencyWord(boxes.box, boxes.locale)
  const other = boxes.other ? currencyWord(boxes.other, boxes.locale) : "otra moneda"
  return cents < 0
    ? `Vuelto en ${box} de cobros en ${other}`
    : `${upperFirst(box)} que quedaron por vueltos dados en ${other}`
}

/**
 * Lo que se dice al cerrar: con varias cajas, cuál se cerró y cuál queda con movimientos
 * por cerrar. `closed` nulo es la única caja de la clínica.
 */
export function cashClosedWords(closed: string | null, pending: string | null, locale: string): string {
  if (!closed) return "Caja cerrada."
  const done = `Caja de ${currencyWord(closed, locale)} cerrada.`
  return pending ? `${done} Falta cerrar la de ${currencyWord(pending, locale)}.` : done
}

/** La palabra de la línea resumida de Caja; el vuelto, con la frase del cierre. */
export function cashTermShort(
  term: { key: CashTermKey; label: string; short: string },
  cents: number,
  boxes?: ChangeBoxes,
): string {
  if (term.key === "cashExpensesCents" && cents < 0) return "volvió de gastos"
  if (term.key !== "cashChangeCents" || !boxes) return term.short
  const label = cashTermLabel(term, cents, boxes)
  return label.charAt(0).toLocaleLowerCase(boxes.locale) + label.slice(1)
}

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

// --- Deudas ------------------------------------------------------------------------

export type { DebtRow } from "./finance-debt"

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

// --- Deudas por páginas: GET /finance/debts/list -------------------------------------

/** El orden de Deudas; sin `sort` en la dirección, lo que más se debe primero. */
export const DEBT_SORT_OPTIONS = [
  { value: "monto", label: "Mayor monto" },
  { value: "antigua", label: "Más antigua" },
  { value: "reciente", label: "Atendido hace poco" },
] as const

export interface DebtListRow extends DebtRow {
  /** Lo que debe ya descontado su saldo a favor. */
  dueCents: number
  creditUsedCents: number
  /** Días de calendario en la zona de la sede desde lo más antiguo que debe. */
  ageDays: number | null
  docType: string | null
  docNumber: string | null
  nextAppointmentAt: string | null
}

export interface DebtTotals {
  people: number
  totals: Array<{ currency: string; cents: number }>
}

export interface DebtListBody {
  timezone: string
  /** Filas: quien debe en dos monedas tiene una por moneda. */
  total: number
  /** Personas distintas de esas filas. */
  people: number
  nextCursor: string | null
  /** De la sede entera, sin la búsqueda ni la antigüedad. */
  summary: DebtTotals & { over30: DebtTotals; over90: DebtTotals; earlier: DebtTotals }
  data: DebtListRow[]
}

export interface DebtListParams {
  q?: string
  age?: "30" | "90"
  /** `hoy`: quienes salieron hoy de su atención (la Caja). */
  when?: "hoy"
  sort?: string
}

export function fetchDebtList(
  branchId: string,
  params: DebtListParams,
  cursor: string | null,
  limit = 30,
): Promise<{ data: DebtListBody }> {
  const search = new URLSearchParams({ branchId, limit: String(limit) })
  if (params.q?.trim()) search.set("q", params.q.trim())
  if (params.age) search.set("age", params.age)
  if (params.when) search.set("when", params.when)
  if (params.sort) search.set("sort", params.sort)
  if (cursor) search.set("cursor", cursor)
  return apiFetch<{ data: DebtListBody }>(`/api/finance/debts/list?${search}`)
}

// --- Cobros: GET /finance/tickets ------------------------------------------------------

/** El orden de Cobros; sin `sort` en la dirección, los más recientes primero. */
export const TICKET_SORT_OPTIONS = [
  { value: "recientes", label: "Más recientes" },
  { value: "antiguos", label: "Más antiguos" },
  { value: "monto", label: "Mayor monto" },
] as const

export const TICKET_STATE_OPTIONS = [
  { value: "vigentes", label: "Vigentes" },
  { value: "anulados", label: "Anulados" },
  { value: "devolucion", label: "Con devolución" },
] as const

/** Un ticket en la lista de Cobros: lo que congeló al cobrar y lo que pasó después. */
export interface TicketListRow {
  id: string
  number: number
  patientId: string
  displayName: string
  docType: string | null
  docNumber: string | null
  createdAt: string
  currency: string
  totalCents: number
  creditAppliedCents: number
  lines: Array<{ description: string; appliedCents: number }>
  /** `tenderCents` y `tenderCurrency`, solo si entró en otra moneda que la que canceló. */
  methods: Array<{
    name: string
    amountCents: number
    tenderCents?: number
    tenderCurrency?: string
  }>
  cashierName: string | null
  remainingCents: number
  voided: { at: string; reason: string | null; byName: string | null } | null
  returnedCents: number
}

export interface TicketTotals {
  currency: string
  tickets: number
  cobradoCents: number
  refundedCents: number
  byMethod: Array<{ name: string; cents: number }>
}

export interface TicketListBody {
  timezone: string
  /** La búsqueda fue un número: se buscó en todas las fechas. */
  allDates: boolean
  /** Solo en la primera página: lo que suma la lista entera no cambia al pedir más. */
  total: number | null
  totals: TicketTotals[] | null
  nextCursor: string | null
  /** Solo en la primera página: quiénes cobraron en la sede. */
  cashiers: Array<{ id: string; name: string }> | null
  data: TicketListRow[]
}

export interface TicketListParams {
  q?: string
  from?: string
  to?: string
  methods?: string
  cashiers?: string
  state?: string
  sort?: string
}

export function fetchTickets(
  branchId: string,
  params: TicketListParams,
  cursor: string | null,
  limit = 30,
): Promise<{ data: TicketListBody }> {
  const search = new URLSearchParams({ branchId, limit: String(limit) })
  for (const [key, value] of Object.entries(params)) if (value?.trim()) search.set(key, value.trim())
  if (cursor) search.set("cursor", cursor)
  return apiFetch<{ data: TicketListBody }>(`/api/finance/tickets?${search}`)
}

// --- Movimientos del día: GET /finance/movements ------------------------------------

export type MovementKind =
  | "apertura"
  | "cobro"
  | "gasto"
  | "aporte"
  | "retiro"
  | "devolucion"
  | "vuelto"

/** Lo que canceló un cobro con otra moneda de por medio. */
export interface MovementCancels {
  currency: string
  totalCents: number
  rate: string
  cashReceivedCents: number | null
  changeCents: number | null
  changeCurrency: string | null
}

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
  /** Lo que canceló y con qué cambio; nulo si no hubo otra moneda. */
  cancels?: MovementCancels | null
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
      /** Lo que canceló y con qué cambio, si hubo otra moneda de por medio. */
      cancels: MovementCancels | null
    }
  | {
      type: "gasto" | "aporte" | "retiro" | "devolucion" | "vuelto"
      key: string
      at: string
      movementId: string
      concept: string
      method: string | null
      /** El dinero salió del efectivo de la caja (y no por otro medio). */
      fromCash: boolean
      /** Sale de la caja; la compensación de un vuelto puede entrar. */
      leaves: boolean
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
      cancels: null,
    }
    tickets.set(entry.key, entry)
    entries.push(entry)
  }
  for (const row of movements) {
    if (row.kind === "apertura") continue
    // El vuelto de un cobro no es otro renglón: lo dice el renglón de su ticket.
    if (row.kind === "vuelto" && row.patientPaymentId) continue
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
          cancels: row.cancels ?? null,
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
      leaves: row.direction === "egreso",
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
  /** La caja de esa moneda; sin ella, la de la moneda de la clínica. */
  currency?: string
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
  /** La caja de esa moneda; sin ella, la de la moneda de la clínica. */
  currency?: string
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

/**
 * `before`: `closedAt` del último cierre ya recibido (página siguiente).
 * `result`: `descuadre` deja solo los que no cuadraron.
 */
export function fetchClosures(
  branchId: string,
  before?: string | null,
  result?: "descuadre",
): Promise<{ data: ClosureListItem[] }> {
  const params = new URLSearchParams({ branchId, limit: String(CLOSURES_PAGE) })
  if (before) params.set("before", before)
  if (result) params.set("result", result)
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
    cashChangeCents?: number
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
  /** Lo que contó: los movimientos de la ventana que mueven el efectivo. */
  counted: DayMovement[]
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
/** Los tipos con que se filtra Gastos: los de un gasto y el pago de comisiones (`EXPENSE_FILTER_TYPES`). */
export const EXPENSE_FILTER_TYPES = [...EXPENSE_CATEGORIES, "Pago de comisiones"] as const

/** Valor con que el servidor guarda «sin comprobante». */
export const NO_RECEIPT = "ninguno"

export interface ExpenseRow {
  id: string
  branchId: string
  concept: string
  category: string
  /** Lo que cancela. */
  amountCents: number
  currency: string
  /** Lo que salió, si fue en otra moneda. */
  tenderCents?: number | null
  tenderCurrency?: string | null
  /** El cambio usado y lo que vale en moneda del negocio, si no es todo en ella. */
  exchangeRate?: string | null
  businessCents?: number | null
  spentAt: string
  receiptKind: string
  receiptNumber: string | null
  notes: string | null
  voidedAt: string | null
  voidReason: string | null
  /** Salió del efectivo de la caja. */
  fromCash: boolean
  /** El mes de un gasto que se repite del que es el pago (`YYYY-MM`); anularlo lo deja otra vez por pagar. */
  recurringMonth?: string | null
  /** Es el pago de una compra de Inventario (ADR 0061). */
  purchaseOrderId: string | null
  purchaseOrderNumber: number | null
  /** El proveedor de esa compra. */
  supplierName: string | null
  /**
   * Es el pago de una comisión. Quien no administra comisiones recibe una sola
   * fila «Pago de comisiones» por sede, sin nombres.
   */
  commission: boolean
  /** El pago de comisión al que lleva la fila (solo para quien administra comisiones). */
  commissionPayment?: { professionalUserId: string; year: number | null; month: number | null } | null
}

export interface MonthExpenses {
  year: number
  month: number
  currency: string
  timezone: string
  /** Del mes entero, sin los anulados y solo en la moneda de la clínica. */
  totalCents: number
  byCategory: Array<{ category: string; cents: number }>
  /** Lo que queda a la vista con la búsqueda y el tipo. */
  shown: { count: number; totalCents: number }
  /** Incluye los anulados, marcados. */
  expenses: ExpenseRow[]
}

export function fetchMonthExpenses(query: {
  branchId: string
  year: number
  month: number
  q?: string
  category?: string
}): Promise<{ data: MonthExpenses }> {
  const params = new URLSearchParams({
    branchId: query.branchId,
    year: String(query.year),
    month: String(query.month),
  })
  if (query.q?.trim()) params.set("q", query.q.trim())
  if (query.category) params.set("category", query.category)
  return apiFetch<{ data: MonthExpenses }>(`/api/finance/expenses/month?${params}`)
}

export function createExpenseApi(body: {
  branchId: string
  concept: string
  amountCents: number
  /** Solo si no es en moneda del negocio, con su cambio. */
  currency?: string
  exchangeRate?: string
  category: ExpenseCategory
  fromCash: boolean
  /** El pago del impuesto de lo cobrado (solo con «Impuestos», ADR 0083). */
  salesTax?: boolean
  receiptKind?: string
  receiptNumber?: string
  spentAt?: string
  /** «Se repite»: queda la plantilla y este gasto es su primera ocurrencia. */
  /** `month`: el mes que paga (`YYYY-MM`), este o el anterior. */
  repeat?: {
    everyMonths: 1 | 6 | 12
    day: number
    memberUserId?: string | null
    month?: string
    /** `false`: se anota sin pagar, sin ningún gasto. */
    paid?: boolean
    /** Se paga al mes siguiente (el sueldo de noviembre, el 2 de diciembre). */
    dueNextMonth?: boolean
  }
}): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>("/api/finance/expenses", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// --- Gastos que se repiten ------------------------------------------------------------------

/** Una ocurrencia por pagar: la de este mes o una vencida de meses anteriores. */
export interface RecurringDue {
  recurringId: string
  /** `YYYY-MM`. */
  month: string
  /** El día de la plantilla (puede ser 31); `dueDay` es el de este mes. */
  day: number
  dueDay: number
  dueOn: string
  overdue: boolean
  concept: string
  category: string
  memberUserId: string | null
  memberName: string | null
  amountCents: number
  currency: string
  fromCash: boolean
  everyMonths: number
}

export interface RecurringTemplate {
  id: string
  branchId: string
  category: string
  concept: string
  amountCents: number
  currency: string
  everyMonths: number
  day: number
  firstMonth: string
  lastMonth: string | null
  memberUserId: string | null
  memberName: string | null
  fromCash: boolean
  nextMonth: string | null
}

export interface RecurringMonth {
  year: number
  month: number
  currency: string
  timezone: string
  today: string
  /** «Lo fijo del mes»: lo que cae en el mes, lo pagado y lo que falta. */
  fixed: { totalCents: number; paidCents: number; dueCents: number; count: number }
  due: RecurringDue[]
  templates: RecurringTemplate[]
}

export function fetchRecurringMonth(query: { year: number; month: number; branchId?: string }): Promise<{ data: RecurringMonth }> {
  const params = new URLSearchParams({ year: String(query.year), month: String(query.month) })
  if (query.branchId) params.set("branchId", query.branchId)
  return apiFetch<{ data: RecurringMonth }>(`/api/finance/expenses/recurring?${params}`)
}

export function fetchRecurringPeople(): Promise<{ data: Array<{ userId: string; name: string }> }> {
  return apiFetch<{ data: Array<{ userId: string; name: string }> }>("/api/finance/expenses/recurring/people")
}

export function payRecurringApi(
  id: string,
  body: { month: string; amountCents?: number; fromCash?: boolean },
): Promise<{ data: { id: string; amountCents: number; currency: string; fromCash: boolean } }> {
  return apiFetch(`/api/finance/expenses/recurring/${id}/pay`, { method: "POST", body: JSON.stringify(body) })
}

export function skipRecurringApi(id: string, month: string, undo = false): Promise<unknown> {
  return apiFetch(`/api/finance/expenses/recurring/${id}/${undo ? "unskip" : "skip"}`, {
    method: "POST",
    body: JSON.stringify({ month }),
  })
}

export function updateRecurringApi(
  id: string,
  body: { concept?: string; amountCents?: number; day?: number; memberUserId?: string | null; fromCash?: boolean; lastMonth?: string | null },
): Promise<unknown> {
  return apiFetch(`/api/finance/expenses/recurring/${id}`, { method: "PATCH", body: JSON.stringify(body) })
}

/** `stillDue`: los meses de antes del fin que quedaron sin pagar y siguen por pagar. */
export function endRecurringApi(
  id: string,
): Promise<{ data: { previousLastMonth: string | null; stillDue: string[] } }> {
  return apiFetch(`/api/finance/expenses/recurring/${id}/end`, { method: "POST" })
}

/** Compras por pagar, lo que aún no llega y lo que se tiene a favor con cada proveedor. */
export function fetchPurchasesToPay(branchId?: string): Promise<{ data: PurchasesToPay }> {
  return apiFetch<{ data: PurchasesToPay }>(`/api/finance/purchases${branchId ? `?branchId=${branchId}` : ""}`)
}

/** Registrar el pago (o un adelanto, o una parte) de una compra: la misma operación desde Inventario y Finanzas. */
export function payPurchaseApi(
  orderId: string,
  body: {
    amountCents: number
    creditCents?: number
    /** Lo que salió, si se pagó en la otra moneda; el cambio se calcula solo. */
    tenderCents?: number
    tenderCurrency?: string
    exchangeRate?: string
    fromCash: boolean
    spentAt?: string
    receiptKind?: string
    receiptNumber?: string
    expectedDueCents?: number
    /** Lo pagado que mostró la pantalla: un envío repetido no paga dos veces. */
    expectedPaidCents?: number
  },
): Promise<{ data: { balance: PurchaseBalance } }> {
  return apiFetch(`/api/finance/purchases/${orderId}/payments`, { method: "POST", body: JSON.stringify(body) })
}

/** «No hubo ese gasto» en Reportes › Finanzas. */
export function dismissExpenseGapApi(body: { category: string; month: string; branchId?: string | null }): Promise<unknown> {
  return apiFetch("/api/finance/expense-gaps", { method: "POST", body: JSON.stringify(body) })
}

export function voidSupplierCreditUseApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/supplier-credit-uses/${id}/void`, { method: "POST", body: JSON.stringify({ reason }) })
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
  cash: (branchId: string, currency?: string) =>
    (currency
      ? ["finance-cash", branchId, currency]
      : ["finance-cash", branchId]) as readonly string[],
  debtList: (branchId: string, params: DebtListParams) =>
    ["finance-debts", "list", branchId, params] as const,
  movements: (branchId: string, day: string) => ["finance-movements", branchId, day] as const,
  closures: (branchId: string, result?: string) => ["finance-closures", branchId, result ?? "todos"] as const,
  closure: (id: string) => ["finance-closure", id] as const,
  expenses: (branchId: string, ref: MonthRef, q = "", category = "") =>
    ["finance-expenses", branchId, ref.year, ref.month, q, category] as const,
  purchases: (branchId: string | null) => ["finance-purchases", branchId] as const,
  tickets: (branchId: string, params: TicketListParams) => ["finance-tickets", branchId, params] as const,
  ticket: (id: string) => ["finance-ticket", id] as const,
}

/** Todo lo que cambia cuando entra o sale dinero, o cuando la caja se cierra. */
export function invalidateFinance(queryClient: QueryClient): void {
  for (const key of [
    "finance-cash",
    "finance-debts",
    "finance-movements",
    "finance-closures",
    "finance-expenses",
    "finance-purchases",
    "finance-tickets",
    "finance-ticket",
    // Un gasto o el pago de una compra cambian Inventario y Reportes.
    "inventory",
    "report",
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] })
  }
}

/** Estado de la caja de la sede: lo leen Caja, «Cerrar caja» e «Ingresar o retirar». Una por moneda. */
export function useCashState(branchId: string, enabled = true, currency?: string) {
  return useQuery({
    queryKey: financeKeys.cash(branchId, currency),
    queryFn: () => fetchCashState(branchId, currency),
    enabled: enabled && branchId !== "",
  })
}

/** Una caja de la sede: su moneda, su consulta y si arrastra días sin cerrar. */
export interface CashBox {
  code: string
  query: ReturnType<typeof useCashState>
  state: CashState | null
  earlierOpen: boolean
}

function useCashBox(
  branchId: string,
  code: string,
  /** Sin decirla, la caja de la clínica. */
  currency: string | undefined,
  enabled: boolean,
  today?: { movements: DayMovement[] | null; isFetching: boolean },
): CashBox {
  const query = useCashState(branchId, enabled, currency)
  const state = query.data?.data ?? null
  const [earlierOpen, setEarlierOpen] = useState(false)
  // «Días sin cerrar» compara dos consultas: se decide solo con ambas quietas,
  // para que una a medio recargar no encienda el aviso por un instante.
  const movements = today && !today.isFetching ? today.movements : null
  const isFetching = query.isFetching
  useEffect(() => {
    if (state && movements && !isFetching) setEarlierOpen(hasEarlierDaysOpen(state, movements))
  }, [state, movements, isFetching])
  return { code, query, state, earlierOpen }
}

/**
 * Las cajas de una sede, una por moneda y la de la clínica primero: su efectivo y su
 * arqueo, nunca sumados. Sin otra moneda hay una sola. `today`, los movimientos de
 * hoy, para saber si alguna arrastra días sin cerrar.
 */
export function useCashBoxes(
  branchId: string,
  business: string,
  enabled = true,
  today?: { movements: DayMovement[] | null; isFetching: boolean },
): readonly [CashBox, ...CashBox[]] {
  const second = useOrgSecondCurrency()
  const main = useCashBox(branchId, business, undefined, enabled, today)
  const other = useCashBox(
    branchId,
    second?.currency ?? business,
    second?.currency,
    enabled && second !== null,
    today,
  )
  return second ? [main, other] : [main]
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

/** Códigos de caja que el servidor dice con palabras técnicas: se explican en lenguaje llano. */
const CASH_PLAIN_BY_CODE: Record<string, string> = {
  CASH_WINDOW_CHANGED:
    "La caja tuvo movimientos mientras contabas. Los importes ya están actualizados: revísalos y vuelve a cerrar.",
  MOVEMENT_NOT_MANUAL:
    "Ese movimiento viene de un cobro, un gasto o una devolución: se anula desde su ticket o su gasto.",
  EXPENSE_IS_COMMISSION: "Ese gasto es el pago de una comisión: se anula desde Comisiones.",
}

/**
 * `formMessage` de un formulario de caja: los códigos de caja en lenguaje
 * llano; `null` deja el mensaje del servidor. `INSUFFICIENT_CASH` se deja tal
 * cual: el servidor dice qué pasó («Anularlo dejaría la caja en negativo») y,
 * si es del importe, lo señala en ese campo.
 */
export function cashFormMessage(err: unknown): string | null {
  const code = errorCode(err)
  return (code ? CASH_PLAIN_BY_CODE[code] : undefined) ?? financeFormMessage(err)
}

/** Rechazos de caja fuera de un formulario (una consulta, una acción suelta). */
export function cashErrorMessage(err: unknown): string {
  const code = errorCode(err)
  return (code ? CASH_PLAIN_BY_CODE[code] : undefined) ?? financeErrorMessage(err)
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
