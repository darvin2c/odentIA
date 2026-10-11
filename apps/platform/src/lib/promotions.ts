import { apiFetch } from "./api"

export type PromotionMode = "fixed" | "from"

export interface PromotionServiceItem {
  id: string
  serviceId: string
  mode: PromotionMode
  priceCents: number
  currency: string
  serviceName: string
  tariffCents: number
  tariffCurrency: string
}

export interface Promotion {
  id: string
  name: string
  startsAt: string
  endsAt: string | null
  conditions: string | null
  isActive: boolean
  items: PromotionServiceItem[]
}

export interface PromotionMetrics {
  promotionId: string
  uses: number
  chargedByCurrency: Array<{ currency: string; cents: number }>
}

export type PromotionWithMetrics = Promotion & { metrics: PromotionMetrics }

export function fetchPromotions(query: { scope?: "vigentes" | "todas"; serviceId?: string } = {}): Promise<{
  data: Promotion[]
}> {
  const params = new URLSearchParams()
  params.set("scope", query.scope ?? "vigentes")
  if (query.serviceId) params.set("serviceId", query.serviceId)
  return apiFetch<{ data: Promotion[] }>(`/api/promotions?${params.toString()}`)
}

export function fetchPromotionDetail(id: string): Promise<{ data: PromotionWithMetrics }> {
  return apiFetch<{ data: PromotionWithMetrics }>(`/api/promotions/${id}`)
}

export interface PromotionItemBody {
  serviceId: string
  mode: PromotionMode
  priceCents: number
}

export interface CreatePromotionBody {
  name: string
  startsAt: string
  endsAt?: string | null
  conditions?: string | null
  items: PromotionItemBody[]
}

export function createPromotionApi(body: CreatePromotionBody): Promise<{ data: Promotion }> {
  return apiFetch<{ data: Promotion }>("/api/promotions", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export interface UpdatePromotionBody {
  name?: string
  startsAt?: string
  endsAt?: string | null
  conditions?: string | null
  isActive?: boolean
  items?: PromotionItemBody[]
}

export function updatePromotionApi(id: string, body: UpdatePromotionBody): Promise<{ data: Promotion }> {
  return apiFetch<{ data: Promotion }>(`/api/promotions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export function endPromotionApi(id: string): Promise<{ data: Promotion }> {
  return apiFetch<{ data: Promotion }>(`/api/promotions/${id}/end`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}
