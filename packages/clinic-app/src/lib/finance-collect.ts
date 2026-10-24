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
import { currencyFractionDigits } from "@odentia/clinical"
import { apiFetch } from "./api"
import { amountFromCents } from "./workspace"

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

/**
 * Día en palabras, en la zona de la clínica: «28 de septiembre». El año solo
 * se escribe cuando no es el actual.
 */
export function formatDayLongLocale(
  value: string | null | undefined,
  locale: string,
  timeZone?: string,
): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  const zone = timeZone ? { timeZone } : {}
  const year = (at: Date) => at.toLocaleDateString("en", { year: "numeric", ...zone })
  return date.toLocaleDateString(locale, {
    day: "numeric",
    month: "long",
    ...(year(date) === year(new Date()) ? {} : { year: "numeric" }),
    ...zone,
  })
}

/** Hora corta en la zona de la clínica. */
export function formatTimeShortLocale(
  value: string | null | undefined,
  locale: string,
  timeZone?: string,
): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  })
}

/** Símbolo de la moneda tal como lo escribe el formato de la clínica (prefijo de los campos de importe). */
export function currencySymbol(currency: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0)
    return parts.find((part) => part.type === "currency")?.value ?? currency
  } catch {
    return currency
  }
}

/**
 * Importe sin símbolo de moneda, con el formato de la clínica: para las cifras
 * secundarias (filas de conceptos, «costó… pagó…»), que acompañan a un total
 * que sí lo lleva.
 */
export function formatAmountPlain(cents: number, currency: string, locale: string): string {
  const digits = currencyFractionDigits(currency)
  return amountFromCents(String(cents), currency).toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
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

/** Línea del ticket congelada al cobrar (`TicketFrozen.lines` en el servidor). */
export interface CollectSnapshotLine {
  /** `null` = adelanto sin concepto. */
  chargeId?: string | null
  description: string
  /** Precio completo del concepto (o el importe del adelanto). */
  amountCents: number
  /** Lo que este cobro pagó de él; los tickets anteriores a congelarlo no lo traen. */
  appliedCents?: number
  promotion: string | null
}

export interface CollectSnapshotMethod {
  paymentMethodId: string
  name: string
  typeCode: string
  amountCents: number
  reference: string | null
}

/**
 * Lo que el ticket congela al cobrar (`payment_ticket.snapshot`): con esto se
 * arma el ticket en pantalla, igual que el PDF del servidor. Los campos
 * opcionales faltan en tickets emitidos antes de congelarlos.
 */
export interface CollectSnapshot {
  patient: { id: string; displayName: string; docType?: string | null; docNumber?: string | null }
  /** Quién pagó, si no fue el propio paciente. */
  payer?: { contactId: string; displayName: string } | null
  /** Quién cobró. */
  issuer: { userId: string; name: string }
  clinic?: {
    legalName: string
    tradeName: string | null
    fiscalAddress: string | null
    locale: string
    currency: string
    timezone: string
  }
  branch: { id: string; name: string }
  lines: CollectSnapshotLine[]
  methods: CollectSnapshotMethod[]
  /** Frase al pie vigente al cobrar. */
  notice: string
  /** Lo que quedó por cobrar de esos conceptos. */
  remainingCents?: number
  /** Lo que falta pagar de cada concepto, con lo que cuesta (`TicketFrozen.pending`). */
  pending?: Array<{ chargeId: string; description: string; amountCents: number; remainingCents: number }>
  /** El impuesto de lo cobrado hoy (`TicketFrozen.taxes`, ADR 0083); nulo si nada lo lleva. */
  taxes?: CollectSnapshotTaxes | null
}

/** Subtotal sin impuesto y una línea por tasa, como el PDF. */
export interface CollectSnapshotTaxes {
  name: string
  subtotalCents: number
  taxCents: number
  groups: Array<{
    category: string
    rateBps: number
    label: string
    amountCents: number
    taxCents: number
    scopes: Array<"servicios" | "productos">
  }>
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

/**
 * El comprobante que sale solo por correo al cobrar (decisión 20 v2). Nulo en
 * un reintento del mismo cobro. Sin correo, el texto es lo que dice Caja.
 */
export type CollectReceipt =
  | { sent: "correo"; email: string }
  | { sent: null; reason: string; text: string }

export interface CollectResultBody {
  ticket: CollectTicketRow
  payments: Array<{ id: string }>
  creditAppliedCents: number
  remainingCents: number
  duplicate: boolean
  account: AccountSummary
  receipt?: CollectReceipt | null
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

export interface VoidTicketResult {
  ticket: CollectTicketRow
  voidedPayments: number
  voidedApplications: number
  /**
   * Lo que este cobro había cubierto en otros tickets (un adelanto ya usado)
   * y vuelve a quedar por cobrar.
   */
  reopenedCents: number
  /** Los productos del ticket que salieron de la cuenta y volvieron a su sede (ADR 0068). */
  returnedProducts?: Array<{ description: string; quantity: number; branchId: string | null }>
  compensated: boolean
  account: AccountSummary
}

export function voidTicketApi(
  patientId: string,
  ticketId: string,
  reason: string,
): Promise<{ data: VoidTicketResult }> {
  return apiFetch<{ data: VoidTicketResult }>(`/api/patients/${patientId}/tickets/${ticketId}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

/**
 * Fila completa de un ticket ya emitido (`GET /patients/:id/receipts/:ticketId`):
 * la cuenta lista cada cobro con su snapshot, pero lo recibido, el vuelto y la
 * fecha de anulación son columnas del ticket.
 */
export function fetchTicketReceipt(
  patientId: string,
  ticketId: string,
): Promise<{ data: { ticket: CollectTicketRow; closedAfter?: boolean } }> {
  return apiFetch<{ data: { ticket: CollectTicketRow; closedAfter?: boolean } }>(
    `/api/patients/${patientId}/receipts/${ticketId}`,
  )
}

// --- Devolver desde un ticket (ADR 0068) ---------------------------------------

/** Un concepto del ticket como está hoy, con lo que este ticket pagó de él. */
export interface ReturnableLine {
  chargeId: string
  description: string
  kind: "producto" | "servicio"
  productName: string | null
  /** Unidades que siguen vendidas (producto). */
  quantity: number | null
  amountCents: number
  /** Lo que este ticket pagó y sigue en pie: el tope de lo que se devuelve. */
  paidCents: number
  /** Por qué no se puede devolver desde este ticket; nulo si se puede. */
  blockedReason: string | null
}

export interface TicketReturnSummary {
  id: string
  ticketId: string
  number: number
  totalCents: number
  currency: string
  outcome: "pagado" | "a_favor"
  methodName: string | null
  createdAt: string
}

export interface TicketReturnable {
  ticketId: string
  number: number
  currency: string
  branchId: string
  createdAt: string
  voided: boolean
  lines: ReturnableLine[]
  methods: CollectSnapshotMethod[]
  returns: TicketReturnSummary[]
}

export function fetchTicketReturnable(patientId: string, ticketId: string): Promise<{ data: TicketReturnable }> {
  return apiFetch<{ data: TicketReturnable }>(`/api/patients/${patientId}/tickets/${ticketId}/returnable`)
}

export interface ReturnLineBody {
  chargeId: string
  quantity?: number
  amountCents?: number
  backToStock?: boolean
}

export interface ReturnBody {
  branchId: string
  lines: ReturnLineBody[]
  /** Con qué medio se le paga; null = queda a favor en su cuenta. */
  paymentMethodId: string | null
  reason: string
  requestId: string
}

/** Lo que la devolución congeló al hacerse: con esto se ve, se imprime y se envía. */
export interface ReturnSnapshot {
  patient: { id: string; displayName: string; docType: string | null; docNumber: string | null }
  issuer: { userId: string; name: string }
  branch: { id: string; name: string }
  ticket: { id: string; number: number; createdAt: string }
  lines: Array<{
    chargeId: string
    description: string
    quantity: number | null
    amountCents: number
    kind: "producto" | "servicio"
    backToStock: boolean | null
  }>
  payout: { kind: "pagado"; methodName: string; typeCode: string | null } | { kind: "a_favor" }
  reason: string
}

export interface PaymentReturnRow {
  id: string
  patientId: string
  ticketId: string
  returnNumber: number
  totalCents: number
  currency: string
  outcome: "pagado" | "a_favor"
  methodName: string | null
  methodTypeCode: string | null
  createdAt: string
  snapshot: ReturnSnapshot
}

export function createTicketReturnApi(
  patientId: string,
  ticketId: string,
  body: ReturnBody,
): Promise<{ data: { paymentReturn: PaymentReturnRow; duplicate: boolean; account: AccountSummary } }> {
  return apiFetch<{ data: { paymentReturn: PaymentReturnRow; duplicate: boolean; account: AccountSummary } }>(
    `/api/patients/${patientId}/tickets/${ticketId}/returns`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

/** PDF del servidor de una devolución: el mismo que se envía. */
export function returnPdfPath(patientId: string, returnId: string): string {
  const params = new URLSearchParams({ documentType: "return", documentId: returnId })
  return `/api/patients/${patientId}/financial-document-pdf?${params}`
}

export interface RefundResult {
  refunds: Array<{ id: string }>
  /** Con este id se pide la constancia en PDF. */
  receiptId: string
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
  /** Debe. */
  porCobrar: number
  pagado: number
  aFavor: number
  /** Lo que debe menos lo que tiene a favor (decisión 22); nunca baja de cero. */
  saldo: number
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
  /** Quién atendió el acto que originó el concepto (solo el nombre). */
  attendedBy?: string | null
  attendedAt?: string | null
  /** En lo que se cobra por sesión: qué visita es y cuántas se previeron. */
  visitNumber?: number | null
  visitsPlanned?: number | null
  /** Servicio del concepto (su acto o su línea): con él se ofrece la promoción vigente. */
  serviceId: string | null
  /** Sede donde se originó el concepto. */
  branchId: string | null
  promotionId: string | null
  promotionName: string | null
  /** Producto vendido desde «Cobrar» y cuántas unidades: ya salió de la sede. */
  productId?: string | null
  productQuantity?: number | null
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
  branchId?: string
  cashReceivedCents?: number | null
  changeCents?: number | null
  payerContactId?: string | null
  status: "vigente" | "anulado"
  voidedAt?: string | null
  voidReason: string | null
  /** La caja de su sede ya cerró después de este cobro: solo administración lo anula. */
  closedAfter?: boolean
  createdAt: string
  snapshot: CollectSnapshot
  payments: AccountCobroPayment[]
  /** Devoluciones de este ticket (ADR 0068): con alguna, ya no se anula. */
  returns?: TicketReturnSummary[]
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

/** De qué cobro viene el saldo a favor. */
export interface AccountCreditSource {
  paymentId: string
  ticketId: string | null
  ticketNumber: number | null
  currency: string
  paidAt: string
  availableCents: number
  /** El cobro fue un adelanto (sin concepto). */
  advance: boolean
}

export interface AccountSummary {
  patientId: string
  /** Identidad mínima para la cabecera de caja. */
  patient?: { displayName: string; docType: string | null; docNumber: string | null; sex: string | null }
  aFavorOrigen?: AccountCreditSource[]
  /** Visitas atendidas por tratamiento (id del tratamiento del plan). */
  visitasPorTratamiento?: Record<string, number>
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

/** Lo que se vende en «Cobrar» (ADR 0067), con su precio y lo que hay en la sede del cobro; nunca el costo. */
export interface SaleProduct {
  productId: string
  name: string
  /** Unidad de uso, en singular: se vende por ella («1 frasco»). */
  unit: string
  /** Precio de venta por unidad; null si aún no tiene (no se puede agregar). */
  salePriceCents: number | null
  currency: string | null
  /** Lo que hay en la sede (lotes − faltante; puede ser negativo). */
  onHand: number
  /** «4 frascos»; null si no hay. */
  onHandText: string | null
}

export function fetchSaleProducts(query: {
  branchId: string
  q?: string
  limit?: number
}): Promise<{ data: { branch: { id: string; name: string }; items: SaleProduct[] } }> {
  const search = new URLSearchParams({ branchId: query.branchId })
  if (query.q?.trim()) search.set("q", query.q.trim())
  if (query.limit) search.set("limit", String(query.limit))
  return apiFetch<{ data: { branch: { id: string; name: string }; items: SaleProduct[] } }>(
    `/api/finance/sale-products?${search}`,
  )
}

/** El concepto que deja un producto vendido: nombre y precio de venta × cantidad, de la sede del cobro. */
export interface ProductCharge {
  id: string
  /** «Cepillo dental suave × 2». */
  description: string
  amountCents: number
  currency: string
  productId: string | null
  productQuantity: number | null
}

/** «+ Agregar producto»: el concepto se crea y el producto sale de la sede en ese momento. */
export function createProductChargeApi(
  patientId: string,
  /** `requestId`: la clave del bloque abierto; un reintento no vende dos veces. */
  body: { productId: string; quantity: number; branchId: string; requestId: string },
): Promise<{ data: ProductCharge }> {
  return apiFetch<{ data: ProductCharge }>(`/api/patients/${patientId}/charges`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/**
 * Corrige un concepto por cobrar. `reason` es obligatorio al cambiar importe o
 * descripción; aplicar una promoción ya es el motivo (con «desde», solo se pide
 * si el precio final baja del mínimo). `promotionId: null` quita la promoción
 * y devuelve el precio de origen. Una promoción sin costo retira el concepto.
 */
export function editChargeConceptApi(
  patientId: string,
  chargeId: string,
  body: {
    amountCents?: number
    description?: string
    promotionId?: string | null
    reason?: string
  },
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
  /** La lista de pacientes ya trae el documento y el sexo registrados. */
  docType?: string | null
  docNumber?: string | null
  sex?: string | null
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
