import { ApiError, apiFetch } from "./api"
import { formatMoney } from "./services"

/** Mensaje de error en español para mutaciones de caja y finanzas. */
export function financeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/** "120", "120.50" o "120,50" a centavos; null si no es un positivo válido. */
export function centsFromSoles(value: string): number | null {
  const normalized = value.trim().replace(",", ".")
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ""] = normalized.split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

export function formatCents(cents: number, currency: string): string {
  return formatMoney(cents, currency)
}

export function formatDateTimeShort(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export interface CashShift {
  id: string
  branchId: string
  currency: string
  openingCents: number
  status: "abierta" | "cerrada"
  openedBy: string | null
  openedAt: string
  openNotes: string | null
  closedBy: string | null
  closedAt: string | null
  expectedCents: number | null
  electronicCents: number | null
  countedCents: number | null
  differenceCents: number | null
  closeNotes: string | null
}

export interface CashMovement {
  id: string
  shiftId: string
  direction: "ingreso" | "egreso"
  kind: string
  amountCents: number
  currency: string
  method: string | null
  concept: string
  patientPaymentId: string | null
  expenseId: string | null
  createdAt: string
  voidedAt: string | null
}

export interface ShiftDetail {
  shift: CashShift
  movements: CashMovement[]
  ingresosCents: number
  electronicosCents: number
  egresosCents: number
  esperadoCents: number
}

export interface Supplier {
  id: string
  name: string
  docType: string
  docNumber: string | null
  email: string | null
  phone: string | null
}

export interface ExpenseItem {
  id: string
  branchId: string
  supplierId: string | null
  shiftId: string | null
  concept: string
  amountCents: number
  currency: string
  spentAt: string
  receiptKind: string
  receiptNumber: string | null
  notes: string | null
}

export interface ReceivableRow {
  charge: {
    id: string
    patientId: string
    description: string
    amountCents: number
    currency: string
    dueAt: string | null
    createdAt: string
  }
  appliedCents: number
  outstandingCents: number
}

export interface InstallmentQuota {
  id: string
  nro: number
  dueAt: string
  amountCents: number
  status: string
  paidCents: number
}

export interface InstallmentPlanWithQuotas {
  plan: {
    id: string
    patientId: string
    chargeId: string
    currency: string
    totalCents: number
    installments: number
    status: string
    notes: string | null
  }
  quotas: InstallmentQuota[]
}

export interface CommissionRule {
  id: string
  professionalUserId: string
  base: string
  rateBps: number
  serviceId: string | null
  branchId: string | null
  isActive: boolean
  validFrom: string | null
  validTo: string | null
}

export interface CommissionPreview {
  lines: Array<{
    sourceKey: string
    applicationId: string | null
    chargeId: string | null
    paymentId: string | null
    patientId: string | null
    description: string
    baseCents: number
    occurredAt: string
    rateBps: number
    commissionCents: number
  }>
  baseCents: number
  commissionCents: number
}

export interface Settlement {
  id: string
  professionalUserId: string
  periodFrom: string
  periodTo: string
  base: string
  currency: string
  baseCents: number
  commissionCents: number
  status: string
  notes: string | null
}

export interface Overview {
  byCurrency: Array<{
    currency: string
    ingresosCents: number
    egresosCents: number
    gastosCents: number
    porCobrarCents: number
    balanceCents: number
  }>
  openShifts: number
  shifts: number
}

export const MOVEMENT_KIND_LABELS: Record<string, string> = {
  apertura: "Apertura",
  cobro: "Cobro",
  gasto: "Gasto",
  aporte: "Aporte",
  retiro: "Retiro",
  devolucion: "Devolución",
  ajuste: "Ajuste",
}

export const QUOTA_STATUS_LABELS: Record<string, string> = {
  pendiente: "Pendiente",
  parcial: "Parcial",
  pagada: "Pagada",
  vencida: "Vencida",
}


export function fetchShifts(status?: "abierta" | "cerrada"): Promise<{ data: CashShift[] }> {
  const query = status ? `?status=${status}` : ""
  return apiFetch<{ data: CashShift[] }>(`/api/finance/shifts${query}`)
}

export function fetchShiftDetail(id: string): Promise<{ data: ShiftDetail }> {
  return apiFetch<{ data: ShiftDetail }>(`/api/finance/shifts/${id}`)
}

export function openShiftApi(body: {
  branchId: string
  currency: string
  openingCents?: number
  notes?: string
}): Promise<{ data: CashShift }> {
  return apiFetch<{ data: CashShift }>("/api/finance/shifts", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function addMovementApi(
  shiftId: string,
  body: { direction: "ingreso" | "egreso"; kind: string; amountCents: number; concept: string },
): Promise<{ data: CashMovement }> {
  return apiFetch<{ data: CashMovement }>(`/api/finance/shifts/${shiftId}/movements`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function registerPaymentApi(
  shiftId: string,
  paymentId: string,
): Promise<{ data: CashMovement }> {
  return apiFetch<{ data: CashMovement }>(`/api/finance/shifts/${shiftId}/payments`, {
    method: "POST",
    body: JSON.stringify({ paymentId }),
  })
}

export function closeShiftApi(
  shiftId: string,
  body: { countedCents: number; notes?: string },
): Promise<{ data: CashShift }> {
  return apiFetch<{ data: CashShift }>(`/api/finance/shifts/${shiftId}/close`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidMovementApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/movements/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function fetchSuppliers(): Promise<{ data: Supplier[] }> {
  return apiFetch<{ data: Supplier[] }>("/api/finance/suppliers")
}

export function createSupplierApi(body: {
  name: string
  docType?: string
  docNumber?: string
  email?: string
  phone?: string
}): Promise<{ data: Supplier }> {
  return apiFetch<{ data: Supplier }>("/api/finance/suppliers", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function fetchExpenses(): Promise<{ data: ExpenseItem[] }> {
  return apiFetch<{ data: ExpenseItem[] }>("/api/finance/expenses?limit=100")
}

export function createExpenseApi(body: {
  branchId: string
  supplierId?: string | null
  concept: string
  amountCents: number
  currency: string
  receiptKind?: string
  receiptNumber?: string
  shiftId?: string | null
}): Promise<{ data: ExpenseItem }> {
  return apiFetch<{ data: ExpenseItem }>("/api/finance/expenses", {
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

export function fetchReceivables(): Promise<{ data: ReceivableRow[] }> {
  return apiFetch<{ data: ReceivableRow[] }>("/api/finance/receivables")
}

export function fetchPlans(): Promise<{ data: InstallmentPlanWithQuotas[] }> {
  return apiFetch<{ data: InstallmentPlanWithQuotas[] }>("/api/finance/installment-plans")
}

export function createPlanApi(body: {
  patientId: string
  chargeId: string
  installments: number
  firstDueAt: string
  notes?: string
}): Promise<unknown> {
  return apiFetch("/api/finance/installment-plans", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function refreshPlanApi(id: string): Promise<unknown> {
  return apiFetch(`/api/finance/installment-plans/${id}/refresh`, { method: "POST" })
}

export function voidPlanApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/installment-plans/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function fetchCommissionRules(): Promise<{ data: CommissionRule[] }> {
  return apiFetch<{ data: CommissionRule[] }>("/api/finance/commission-rules")
}

export function upsertRuleApi(body: {
  professionalUserId: string
  base: "cobrado" | "produccion"
  rateBps: number
}): Promise<{ data: CommissionRule }> {
  return apiFetch<{ data: CommissionRule }>("/api/finance/commission-rules", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function previewCommissionsApi(query: {
  professionalUserId: string
  base: string
  from: string
  to: string
  currency: string
}): Promise<{ data: CommissionPreview }> {
  const params = new URLSearchParams(query).toString()
  return apiFetch<{ data: CommissionPreview }>(`/api/finance/commissions/preview?${params}`)
}

export function settleCommissionsApi(body: {
  professionalUserId: string
  base: "cobrado" | "produccion"
  from: string
  to: string
  currency: string
}): Promise<{ data: Settlement }> {
  return apiFetch<{ data: Settlement }>("/api/finance/commissions/settle", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function fetchSettlements(): Promise<{ data: Settlement[] }> {
  return apiFetch<{ data: Settlement[] }>("/api/finance/settlements")
}

export function fetchSettlementDetail(id: string): Promise<{
  data: { settlement: Settlement; lines: CommissionPreview["lines"] }
}> {
  return apiFetch(`/api/finance/settlements/${id}`)
}

export function fetchFinanceOverview(): Promise<{ data: Overview }> {
  return apiFetch<{ data: Overview }>("/api/finance/overview")
}

export function voidSettlementApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/finance/settlements/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}
