import { apiFetch } from "./api"

export interface CommissionRate {
  id: string
  professionalUserId: string
  professionalName: string | null
  rateBps: number
}

export interface CommissionLine {
  applicationId: string
  chargeId: string
  paymentId: string
  patientId: string
  description: string
  grossCents: number
  refundChargeCents: number
  baseCents: number
  rateBps: number
  commissionCents: number
  occurredAt: string
  paidAt: string
  methodLabel: string
  cashMethod: boolean
  promotionId: string | null
  promotionName: string | null
  settled: boolean
}

export interface CommissionSettlement {
  id: string
  professionalUserId: string
  professionalName?: string | null
  periodFrom: string | null
  periodTo: string | null
  periodYear: number | null
  periodMonth: number | null
  base: string
  currency: string
  rateBps: number | null
  baseCents: number
  commissionCents: number
  expenseId: string | null
  status: string
  notes: string | null
  settledBy: string | null
  settledAt: string | null
  voidedAt: string | null
}

export interface MonthlyCommissions {
  professionalUserId: string
  professionalName: string | null
  year: number
  month: number
  currency: string
  timezone: string
  locale: string
  rateBps: number
  lines: CommissionLine[]
  baseCents: number
  commissionCents: number
  pendingCents: number
  settlement: CommissionSettlement | null
  paidExpenseId: string | null
}

export interface SettlementDetail {
  settlement: CommissionSettlement
  lines: CommissionLine[]
  expense: { id: string; concept: string; amountCents: number; currency: string } | null
}

export interface MonthlyResultBucket {
  currency: string
  cobradoCents: number
  devolucionesCents: number
  anulacionesCents: number
  netoCents: number
  gastadoCents: number
  quedaCents: number
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
  }>
  outstanding: Array<{ currency: string; pendienteCents: number; pacientes: number }>
  closures: Array<{
    currency: string
    cierres: number
    efectivoCents: number
    gastosCajaCents: number
    diferenciasCents: number
  }>
}

/** "40" o "40,5" a puntos básicos; null si no es un porcentaje válido. */
export function rateBpsFromPercent(value: string): number | null {
  const percent = Number(value.replace(",", "."))
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null
  return Math.round(percent * 100)
}

export function fetchCommissionRates(
  professionalUserId?: string,
): Promise<{ data: CommissionRate[] }> {
  const params = professionalUserId ? `?professionalUserId=${encodeURIComponent(professionalUserId)}` : ""
  return apiFetch<{ data: CommissionRate[] }>(`/api/commissions/rates${params}`)
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

export function fetchMonthlyCommissions(query: {
  professionalUserId?: string
  year: number
  month: number
  currency: string
}): Promise<{ data: MonthlyCommissions }> {
  const params = new URLSearchParams({
    year: String(query.year),
    month: String(query.month),
    currency: query.currency,
  })
  if (query.professionalUserId) params.set("professionalUserId", query.professionalUserId)
  return apiFetch<{ data: MonthlyCommissions }>(`/api/commissions/monthly?${params.toString()}`)
}

export function fetchMyCommissions(query: {
  year: number
  month: number
  currency: string
}): Promise<{ data: MonthlyCommissions }> {
  const params = new URLSearchParams({
    year: String(query.year),
    month: String(query.month),
    currency: query.currency,
  })
  return apiFetch<{ data: MonthlyCommissions }>(`/api/commissions/my?${params.toString()}`)
}

export function settleMonthCommissionsApi(body: {
  professionalUserId: string
  year: number
  month: number
  currency: string
  notes?: string
}): Promise<{ data: CommissionSettlement }> {
  return apiFetch<{ data: CommissionSettlement }>("/api/commissions/settle", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function fetchCommissionSettlements(query: {
  professionalUserId?: string
  year?: number
  month?: number
}): Promise<{ data: CommissionSettlement[] }> {
  const params = new URLSearchParams()
  if (query.professionalUserId) params.set("professionalUserId", query.professionalUserId)
  if (query.year) params.set("year", String(query.year))
  if (query.month) params.set("month", String(query.month))
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return apiFetch<{ data: CommissionSettlement[] }>(`/api/commissions/settlements${suffix}`)
}

export function fetchCommissionSettlementDetail(id: string): Promise<{ data: SettlementDetail }> {
  return apiFetch(`/api/commissions/settlements/${id}`)
}

export function payCommissionSettlementApi(
  id: string,
  branchId: string,
): Promise<{ data: { settlement: CommissionSettlement; expense: { id: string } } }> {
  return apiFetch(`/api/commissions/settlements/${id}/pay`, {
    method: "POST",
    body: JSON.stringify({ branchId }),
  })
}

export function voidCommissionSettlementApi(id: string, reason: string): Promise<unknown> {
  return apiFetch(`/api/commissions/settlements/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function fetchMonthlyFinanceResult(query: {
  year: number
  month: number
  branchId?: string
  currency?: string
}): Promise<{ data: MonthlyFinanceResult }> {
  const params = new URLSearchParams({ year: String(query.year), month: String(query.month) })
  if (query.branchId) params.set("branchId", query.branchId)
  if (query.currency) params.set("currency", query.currency)
  return apiFetch<{ data: MonthlyFinanceResult }>(
    `/api/commissions/monthly-result?${params.toString()}`,
  )
}
