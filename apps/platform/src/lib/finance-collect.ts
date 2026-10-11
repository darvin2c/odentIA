/**
 * Finanzas fases 2-3: cliente tipado de las rutas reales (`patient-payments`,
 * `finance`, `org-profile`, `org/payment-methods`, `promotions`). Los tipos
 * replican las respuestas del servidor (filas Drizzle serializadas y
 * envoltorios de servicio); el servidor valida permisos, moneda, precios de
 * promoción e idempotencia. Aquí solo presentación y validación de forma.
 *
 * Dinero con el módulo compartido `@odentia/clinical`; moneda, locale y zona
 * horaria siempre del perfil/sede. Nada fijo.
 */
import { useQuery } from "@tanstack/react-query"
import { apiFetch } from "./api"

/** Fecha y hora cortas en la zona de la sede cuando se indica. */
export function formatDateTimeShortLocale(
  value: string | null | undefined,
  locale: string,
  timeZone?: string,
): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  })
}

/** Día local YYYY-MM-DD en una zona horaria IANA. */
export function dayInTimezone(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

/** Días entre una fecha ISO y hoy ( zona local, solo fecha). */
export function daysSince(value: string | null | undefined): number | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.max(0, Math.round((today - start) / 86_400_000))
}

// --- Perfil y medios (Configuración) ---------------------------------------

export interface OrgFinanceProfile {
  countryCode: string
  currency: string
  locale: string
  timezone: string
  receiptWidth: "58" | "80"
  sheetSize: "A4" | "Letter"
  ticketFooter: string | null
}

/** Fila real de `org_profile` (puede no existir hasta que se configure). */
export function fetchOrgFinanceProfile(): Promise<{ data: OrgFinanceProfile | null }> {
  return apiFetch<{ data: OrgFinanceProfile | null }>("/api/org-profile")
}

/** Medio de pago activo: el tipo decide arqueo (10 = efectivo) y referencia. */
export interface PaymentMethodOption {
  id: string
  name: string
  /** UN/CEFACT 4461: 10 efectivo, 68 billetera, 48 tarjeta, 30 transferencia… */
  typeCode: string
}

/** Efectivo (UN/CEFACT 10) es lo único que entra al arqueo de cierre. */
export const CASH_TYPE_CODE = "10"

/** Sin lista fija: el error se muestra con reintento. */
export function fetchPaymentMethods(): Promise<{ data: PaymentMethodOption[] }> {
  return apiFetch<{ data: PaymentMethodOption[] }>("/api/org/payment-methods?activeOnly=1")
}

// --- Cobro atómico: POST /patients/:id/collect ----------------------------------

export interface CollectSnapshotLine {
  chargeId?: string
  description: string
  amountCents: number
  promotion: string | null
}

export interface CollectSnapshotMethod {
  paymentMethodId: string
  name: string
  typeCode: string
  amountCents: number
  reference: string | null
}

export interface CollectSnapshot {
  patient: { id: string; displayName: string }
  issuer: { userId: string; name: string }
  branch: { id: string; name: string }
  lines: CollectSnapshotLine[]
  methods: CollectSnapshotMethod[]
  notice: string
}

/** Fila real de `payment_ticket` con su snapshot inmutable. */
export interface CollectTicketRow {
  id: string
  patientId: string
  branchId: string
  ticketNumber: number
  currency: string
  totalCents: number
  creditAppliedCents: number
  cashReceivedCents: number | null
  changeCents: number | null
  payerContactId: string | null
  requestId: string | null
  snapshot: CollectSnapshot
  createdBy: string | null
  createdAt: string
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
}

export interface CollectResultBody {
  ticket: CollectTicketRow
  payments: Array<{ id: string }>
  creditAppliedCents: number
  remainingCents: number
  duplicate: boolean
  account: AccountSummary
}

export interface CollectInput {
  branchId: string
  payerContactId?: string | null
  /** Conceptos a pagar; omitido = FIFO desde lo más antiguo (servidor). */
  chargeIds?: string[]
  /** Adelanto puro, sin chargeIds. Excluyente con chargeIds. */
  advanceCents?: number
  /** Omitido = solo crédito (el servidor consume el saldo a favor). */
  payments?: Array<{ paymentMethodId: string; amountCents: number; reference?: string }>
  cashReceivedCents?: number
  requestId: string
}

export function collectApi(patientId: string, body: CollectInput): Promise<{ data: CollectResultBody }> {
  return apiFetch<{ data: CollectResultBody }>(`/api/patients/${patientId}/collect`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidTicketApi(patientId: string, ticketId: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/patients/${patientId}/tickets/${ticketId}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export interface RefundResult {
  refunds: Array<{ id: string }>
  amountCents: number
  currency: string
  branchId: string
  methodName: string
  refundedAt: string
  account: AccountSummary
}

export function refundApi(
  patientId: string,
  body: { branchId: string; amountCents: number; paymentMethodId?: string; reason: string },
): Promise<{ data: RefundResult }> {
  return apiFetch<{ data: RefundResult }>(`/api/patients/${patientId}/refunds`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// --- Cuenta: GET /patients/:id/account → { patientId, byCurrency, pendiente, cobros } ---

export interface AccountCurrency {
  currency: string
  porCobrar: number
  pagado: number
  aFavor: number
}

export interface AccountPendingItem {
  chargeId: string
  description: string
  currency: string
  totalCents: number
  paidCents: number
  saldoCents: number
  since: string | null
  budgetItemId: string | null
  planItemId: string | null
  encounterProcedureId: string | null
  promotionName: string | null
}

export interface AccountCobroPayment {
  id: string
  methodName: string
  amountCents: number
  voidedAt: string | null
}

export interface AccountCobro {
  ticketId: string
  number: number
  currency: string
  totalCents: number
  creditAppliedCents: number
  status: "vigente" | "anulado"
  voidReason: string | null
  createdAt: string
  snapshot: CollectSnapshot
  payments: AccountCobroPayment[]
}

/** Pagos pre-ticket (origen histórico): solo lectura, no imprimibles. */
export interface AccountHistoric {
  paymentId: string
  currency: string
  methodName: string
  methodTypeCode: string | null
  amountCents: number
  appliedCents: number
  refundedCents: number
  paidAt: string
  status: "vigente" | "anulado"
  voidReason: string | null
  origin: "historico"
}

export interface AccountSummary {
  patientId: string
  byCurrency: AccountCurrency[]
  pendiente: AccountPendingItem[]
  cobros: AccountCobro[]
  historico: AccountHistoric[]
  /** Tratamientos con cargo vivo (cobrado o no): una sola tarifa por tratamiento. */
  conCargo: string[]
}

export function fetchPatientAccount3(patientId: string): Promise<{ data: AccountSummary }> {
  return apiFetch<{ data: AccountSummary }>(`/api/patients/${patientId}/account`)
}


export function createManualChargeApi(
  patientId: string,
  body: { branchId?: string; description: string; amountCents: number; notes?: string },
): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(`/api/patients/${patientId}/charges`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface ResponsibilityRow {
  contactId: string
  kind: string
  isCurrent: boolean
  contact: { id: string; displayName: string; isActive: boolean }
}

/** Responsables del paciente (económico, representante…): payer real del cobro. */
export function fetchResponsibilities(patientId: string): Promise<{ data: ResponsibilityRow[] }> {
  return apiFetch<{ data: ResponsibilityRow[] }>(`/api/patients/${patientId}/responsibilities`)
}
export function editChargeConceptApi(
  patientId: string,
  chargeId: string,
  body: { amountCents?: number; description?: string; promotionId?: string; reason: string },
): Promise<unknown> {
  return apiFetch(`/api/patients/${patientId}/charges/${chargeId}/update`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidChargeApi(patientId: string, chargeId: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/patients/${patientId}/charges/${chargeId}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// --- Caja por sede: GET /finance/cash → { branchId, currency, openedAt, cashOnHandCents, byMethod, tickets } ---

export interface CashByMethod {
  name: string
  typeCode: string | null
  count: number
  amountCents: number
}

export interface CashState {
  branchId: string
  currency: string
  openedAt: string | null
  cashOnHandCents: number
  byMethod: CashByMethod[]
  tickets: number
}

export function fetchCashState(branchId: string, currency?: string): Promise<{ data: CashState }> {
  const params = new URLSearchParams({ branchId })
  if (currency) params.set("currency", currency)
  return apiFetch<{ data: CashState }>(`/api/finance/cash?${params}`)
}

export interface CashShiftRow {
  id: string
  branchId: string
  currency: string
  openingCents: number
  status: "abierta" | "cerrada"
  openedAt: string
  closedAt: string | null
}

export function fetchOpenShifts(branchId: string): Promise<{ data: CashShiftRow[] }> {
  const params = new URLSearchParams({ branchId, status: "abierta" })
  return apiFetch<{ data: CashShiftRow[] }>(`/api/finance/shifts?${params}`)
}

export interface CashMovementRow {
  id: string
  shiftId: string
  direction: "ingreso" | "egreso"
  kind: string
  amountCents: number
  currency: string
  method: string | null
  methodTypeCode: string | null
  concept: string
  patientPaymentId: string | null
  expenseId: string | null
  createdAt: string
  voidedAt: string | null
}

export interface ShiftDetailBody {
  shift: CashShiftRow
  movements: CashMovementRow[]
  ingresosCents: number
  electronicosCents: number
  egresosCents: number
  esperadoCents: number
}

export function fetchShiftDetail(shiftId: string): Promise<{ data: ShiftDetailBody }> {
  return apiFetch<{ data: ShiftDetailBody }>(`/api/finance/shifts/${shiftId}`)
}

/** Ventana abierta con su arqueo en vivo; null si la sede aún no tiene caja. */
export async function fetchOpenShiftDetail(
  branchId: string,
  currency: string,
): Promise<ShiftDetailBody | null> {
  const shifts = await fetchOpenShifts(branchId)
  const open = shifts.data.find((row) => row.currency === currency) ?? null
  if (!open) return null
  const detail = await fetchShiftDetail(open.id)
  return detail.data
}

export interface DebtRow {
  patientId: string
  displayName: string
  branchId: string | null
  currency: string
  totalCents: number
  /** Serializado ISO (el servicio devuelve Date). */
  oldestSince: string | null
  chargesCount: number
}

export function fetchDebts(branchId?: string): Promise<{ data: DebtRow[] }> {
  const query = branchId ? `?branchId=${encodeURIComponent(branchId)}` : ""
  return apiFetch<{ data: DebtRow[] }>(`/api/finance/debts${query}`)
}

export interface DayMovementsBody {
  branchId: string
  day: string
  timezone: string
  movements: CashMovementRow[]
}

export function fetchDayMovements(query: {
  branchId: string
  currency?: string
  day: string
  timezone?: string
}): Promise<{ data: DayMovementsBody }> {
  const params = new URLSearchParams({ branchId: query.branchId, day: query.day })
  if (query.currency) params.set("currency", query.currency)
  if (query.timezone) params.set("timezone", query.timezone)
  return apiFetch<{ data: DayMovementsBody }>(`/api/finance/movements?${params}`)
}

/** Único movimiento manual (aporte/retiro) sobre la ventana abierta de la sede. */
export async function appendCashMovementApi(body: {
  branchId: string
  currency: string
  direction: "ingreso" | "egreso"
  kind: "aporte" | "retiro"
  amountCents: number
  concept: string
}): Promise<unknown> {
  const shifts = await fetchOpenShifts(body.branchId)
  const open = shifts.data.find((row) => row.currency === body.currency) ?? null
  if (!open) throw new Error("La sede aún no tiene caja: cobra o registra un gasto para abrirla.")
  return apiFetch(`/api/finance/shifts/${open.id}/movements`, {
    method: "POST",
    body: JSON.stringify({
      direction: body.direction,
      kind: body.kind,
      amountCents: body.amountCents,
      concept: body.concept,
    }),
  })
}

// --- Gastos cortos por categoría (filas reales de `expense`) ---------------------

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

export interface ExpenseRow {
  id: string
  branchId: string
  supplierId: string | null
  shiftId: string | null
  concept: string
  category: string
  amountCents: number
  currency: string
  spentAt: string
  receiptKind: string
  receiptNumber: string | null
  notes: string | null
}

/** Salió del efectivo de la caja = el gasto quedó atado a un turno. */
export function expenseFromCash(row: Pick<ExpenseRow, "shiftId">): boolean {
  return row.shiftId !== null
}

export function fetchShortExpenses(query: {
  branchId?: string
  category?: ExpenseCategory
  limit?: number
}): Promise<{ data: ExpenseRow[] }> {
  const params = new URLSearchParams()
  if (query.branchId) params.set("branchId", query.branchId)
  if (query.category) params.set("category", query.category)
  if (query.limit) params.set("limit", String(query.limit))
  const suffix = params.size > 0 ? `?${params}` : ""
  return apiFetch<{ data: ExpenseRow[] }>(`/api/finance/expenses${suffix}`)
}

export function createShortExpenseApi(body: {
  branchId: string
  category: ExpenseCategory
  concept: string
  amountCents: number
  currency?: string
  spentAt?: string
  receiptKind?: string
  receiptNumber?: string
  notes?: string
  fromCash?: boolean
}): Promise<unknown> {
  return apiFetch("/api/finance/expenses", { method: "POST", body: JSON.stringify(body) })
}

export function voidShortExpenseApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/expenses/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

// --- Cierres: POST /closures devuelve el turno; la hoja sale de /closures/:id ---

export interface CashClosureMethodTotal {
  name: string
  count: number
  amountCents: number
}

/** Fila real de `cash_closure` (inmutable). */
export interface CashClosureRow {
  id: string
  branchId: string
  currency: string
  shiftId: string
  windowFrom: string
  windowTo: string
  openingRetainedCents: number
  cashCollectedCents: number | null
  expenseCashCents: number
  expectedCents: number
  countedCents: number
  differenceCents: number
  retainedCents: number | null
  deliveredCents: number | null
  notes: string | null
  closedBy: string | null
  closedAt: string
}

export function createClosureApi(body: {
  branchId: string
  currency?: string
  countedCents: number
  retainedCents: number
  deliveredCents: number
  notes?: string
}): Promise<{ data: CashShiftRow }> {
  return apiFetch<{ data: CashShiftRow }>("/api/finance/closures", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Item de historial: cierres nuevos y turnos viejos unidos. */
export interface ClosureListItem {
  id: string
  source: "cierre" | "turno"
  branchId: string
  currency: string
  closedAt: string
  closedBy: string | null
  expectedCents: number
  countedCents: number
  differenceCents: number
  /** Nulo en turnos viejos: desconocido, nunca 0. */
  retainedCents: number | null
  deliveredCents: number | null
  notes: string | null
}

export function fetchClosures(branchId: string): Promise<{ data: ClosureListItem[] }> {
  return apiFetch<{ data: ClosureListItem[] }>(
    `/api/finance/closures?branchId=${encodeURIComponent(branchId)}`,
  )
}

export interface ClosureSheetEnvelope {
  legacy: boolean
  closure: CashClosureRow
  /** Nulo en turnos viejos: sin desglose por medio. */
  totalsByMethod: CashClosureMethodTotal[] | null
  branch: { id: string; name: string } | null
  orgProfile: {
    receiptWidth: string
    sheetSize: string
    ticketFooter: string
    tradeName?: string | null
    legalName?: string | null
    fiscalAddress?: string | null
  } | null
  closedByName: string | null
}

export function fetchClosureSheet(id: string): Promise<{ data: ClosureSheetEnvelope }> {
  return apiFetch<{ data: ClosureSheetEnvelope }>(`/api/finance/closures/${id}`)
}

// --- Promociones vigentes (PresupuestosPromociones) ------------------------------

export interface PromotionItem {
  serviceId: string
  serviceName: string
  mode: "fixed" | "from"
  priceCents: number | null
  currency: string
  tariffCents: number | null
}

export interface PromotionOption {
  id: string
  name: string
  endsAt: string | null
  conditions?: string | null
  items: PromotionItem[]
}

/** Solo vigentes hoy. El error se muestra con reintento, nunca se oculta. */
export async function fetchActivePromotions(serviceId?: string): Promise<PromotionOption[]> {
  const params = new URLSearchParams({ scope: "vigentes" })
  if (serviceId) params.set("serviceId", serviceId)
  const result = await apiFetch<{ data: PromotionOption[] }>(`/api/promotions?${params}`)
  return result.data
}

// --- Búsqueda de pacientes para cobrar -------------------------------------------

export interface PatientSearchRow {
  id: string
  displayName: string
}

export function searchPatientsApi(query: string): Promise<{ data: PatientSearchRow[] }> {
  return apiFetch<{ data: PatientSearchRow[] }>(
    `/api/patients?q=${encodeURIComponent(query.trim())}&limit=10`,
  )
}

// --- Hooks compartidos -----------------------------------------------------------

export function useOrgFinanceProfile() {
  return useQuery({ queryKey: ["org-finance-profile"], queryFn: fetchOrgFinanceProfile })
}

export function usePaymentMethodsOptions() {
  return useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods })
}

export function useBranchesOptions() {
  return useQuery({
    queryKey: ["branches"],
    queryFn: () => apiFetch<{ data: Array<{ id: string; name: string }> }>("/api/branches"),
  })
}
