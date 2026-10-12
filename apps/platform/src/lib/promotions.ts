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

/** En qué momento está, decidido por el servidor con la regla que la ofrece. */
export type PromotionState = "programada" | "vigente" | "terminada"

export interface PromotionMetrics {
  promotionId: string
  /** Veces que se usó: aceptada en un presupuesto o aplicada al cobrar. */
  uses: number
  /** Dinero que ya entró con ella, por moneda. */
  chargedByCurrency: Array<{ currency: string; cents: number }>
  /** Precio promedio acordado (lo que dice algo en un precio «desde»). */
  averageByCurrency: Array<{ currency: string; cents: number }>
}

/**
 * Promoción tal como llega de la lista y del detalle. `metrics` es `null` para
 * quien lee la promoción pero no ve dinero (recepción, odontología).
 */
export type PromotionWithMetrics = Promotion & {
  state: PromotionState
  metrics: PromotionMetrics | null
}

export function fetchPromotions(query: { scope?: "vigentes" | "todas"; serviceId?: string } = {}): Promise<{
  data: PromotionWithMetrics[]
}> {
  const params = new URLSearchParams()
  params.set("scope", query.scope ?? "vigentes")
  if (query.serviceId) params.set("serviceId", query.serviceId)
  return apiFetch<{ data: PromotionWithMetrics[] }>(`/api/promotions?${params.toString()}`)
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
