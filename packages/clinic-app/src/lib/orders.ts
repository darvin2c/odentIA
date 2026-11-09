/**
 * Los pedidos al taller o al laboratorio (ADR 0168): el cliente de `/api/orders`.
 * Los tipos replican lo que entrega el servidor (`listJobOrders`, `getJobOrder`);
 * lo que se puede hacer y lo que falta pagar lo decide el servidor, aquí solo
 * se dice.
 */
import type { QueryClient } from "@tanstack/react-query"
import type { OrderLineKind } from "../product/product-ui"
import { apiFetch } from "./api"

export type OrderStep = "por_enviar" | "en_laboratorio" | "por_revisar" | "listo" | "entregado"
export type OrderStatus = OrderStep | "anulado"

/** Los pasos en su orden: solo se avanza (se puede saltar uno), nunca se vuelve. */
export const ORDER_STEPS: readonly OrderStep[] = [
  "por_enviar",
  "en_laboratorio",
  "por_revisar",
  "listo",
  "entregado",
]

export interface OrderRow {
  id: string
  orderNumber: number
  status: OrderStatus
  statusLabel: string
  patientId: string
  patientName: string
  title: string
  maker: string
  /** El día prometido (AAAA-MM-DD). */
  promisedOn: string
  /** Pasó el día prometido y todavía no está listo. */
  overdue: boolean
  remakeOf: string | null
  /** El pedido que lo rehízo, si sigue vivo: este ya no es el que se trabaja. */
  remadeAs: string | null
  /** Lo que falta pagar, en `currency`; null para quien no ve la caja. */
  dueCents: number | null
  /** La moneda de lo que se cobra (ISO 4217). */
  currency: string | null
  createdAt: string
}

/** Otro pedido nombrado por su número: el original de uno rehecho, o el que lo rehízo. */
export interface OrderLink {
  id: string
  orderNumber: number | null
}

export interface OrderDetail extends Omit<OrderRow, "remadeAs"> {
  /**
   * La copia de lo que se copió al vender (vistIA: la receta, con sus `notices`);
   * null si se vendió sin ella o si quien mira no la lee (`prescriptionHidden`).
   */
  prescription: Record<string, unknown> | null
  /** Lleva la copia, pero no es para quien mira. */
  prescriptionHidden: boolean
  remakeOfOrder: OrderLink | null
  /** Se rehízo en otro pedido: este ya no avanza ni se anula; sigue en ese. */
  remadeAs: OrderLink | null
  fitting: Record<string, unknown> | null
  notes: string | null
  remakeReason: string | null
  voidReason: string | null
  lines: Array<{
    id: string
    kind: OrderLineKind
    description: string
    quantity: number
    chargeId: string | null
    /** null para quien no ve la caja o si la línea no se cobra (un pedido rehecho). */
    amountCents: number | null
  }>
  events: Array<{
    status: OrderStatus
    statusLabel: string
    note: string | null
    at: string
    actorName: string | null
  }>
}

/** Lo que se ofrece copiar al vender (vistIA: sus recetas vigentes), con lo que dice y sus avisos. */
export interface SaleReference {
  id: string
  label: string
  lines: string[]
  notices: string[]
}

/** Las vistas de la página, como van en la dirección (`?vista=`), y lo que pide cada una al servidor. */
export const ORDER_VIEWS = [
  { value: "abiertos", label: "Abiertos", status: "abiertos" },
  { value: "atrasados", label: "Atrasados", status: "atrasados" },
  { value: "listos", label: "Listos", status: "listo" },
  { value: "entregados", label: "Entregados", status: "entregado" },
  { value: "anulados", label: "Anulados", status: "anulado" },
] as const

export type OrderView = (typeof ORDER_VIEWS)[number]

export function orderViewOf(value: string | undefined): OrderView {
  return ORDER_VIEWS.find((view) => view.value === value) ?? ORDER_VIEWS[0]
}

export const orderKeys = {
  all: ["orders"] as const,
  list: (status: string) => ["orders", "list", status] as const,
  detail: (id: string) => ["orders", "detail", id] as const,
  references: (patientId: string) => ["orders", "references", patientId] as const,
}

export function fetchOrders(status: string): Promise<OrderRow[]> {
  return apiFetch<{ data: OrderRow[] }>(`/api/orders?status=${encodeURIComponent(status)}`).then(
    (body) => body.data,
  )
}

export function fetchOrder(id: string): Promise<OrderDetail> {
  return apiFetch<{ data: OrderDetail }>(`/api/orders/${id}`).then((body) => body.data)
}

export function fetchSaleReferences(patientId: string): Promise<SaleReference[]> {
  return apiFetch<{ data: SaleReference[] }>(
    `/api/orders/references?patientId=${encodeURIComponent(patientId)}`,
  ).then((body) => body.data)
}

export interface OrderSaleBody {
  patientId: string
  branchId: string
  requestId: string
  title: string
  maker: string
  promisedOn: string
  lines: Array<
    | { kind: OrderLineKind; productId: string }
    | { kind: OrderLineKind; description: string; amountCents: number }
  >
  referenceId?: string
  fitting?: Record<string, number>
  notes?: string
  payments?: Array<{ paymentMethodId: string; amountCents: number }>
  cashReceivedCents?: number
}

export function sellOrder(
  body: OrderSaleBody,
): Promise<{ order: OrderDetail; ticketId: string | null }> {
  return apiFetch<{ data: { order: OrderDetail; ticketId: string | null } }>("/api/orders/sale", {
    method: "POST",
    body: JSON.stringify(body),
  }).then((result) => result.data)
}

export function advanceOrder(id: string, status: OrderStep): Promise<OrderDetail> {
  return apiFetch<{ data: OrderDetail }>(`/api/orders/${id}/advance`, {
    method: "POST",
    body: JSON.stringify({ status }),
  }).then((body) => body.data)
}

export function voidOrder(id: string, reason: string): Promise<OrderDetail> {
  return apiFetch<{ data: OrderDetail }>(`/api/orders/${id}/void`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  }).then((body) => body.data)
}

/**
 * Rehacer crea otro pedido: la respuesta es el nuevo. `requestId`, la clave del
 * cajón abierto: un reintento tras un corte no lo rehace dos veces.
 */
export function remakeOrder(
  id: string,
  body: { reason: string; promisedOn: string; requestId: string },
): Promise<OrderDetail> {
  return apiFetch<{ data: OrderDetail }>(`/api/orders/${id}/remake`, {
    method: "POST",
    body: JSON.stringify(body),
  }).then((result) => result.data)
}

/**
 * El paso siguiente de un pedido, con el nombre del botón que lo marca: un hecho
 * de la clínica. Entregado y anulado no tienen siguiente.
 */
const NEXT_STEP: Partial<Record<OrderStatus, { status: OrderStep; label: string }>> = {
  por_enviar: { status: "en_laboratorio", label: "Enviado al laboratorio" },
  en_laboratorio: { status: "por_revisar", label: "Llegó del laboratorio" },
  por_revisar: { status: "listo", label: "Revisado: está listo" },
  listo: { status: "entregado", label: "Entregar" },
}

export function nextStepOf(status: OrderStatus): { status: OrderStep; label: string } | null {
  return NEXT_STEP[status] ?? null
}

/** «Marcar listo» salta los pasos del medio: solo tiene sentido antes de «Por revisar», cuyo paso ya es ese. */
export function canSkipToReady(status: OrderStatus): boolean {
  return status === "por_enviar" || status === "en_laboratorio"
}

/** Anular es de lo que no se entregó ni se anuló (y, como rehacer, de quien lleva la caja: anula sus cargos). */
export function canVoid(status: OrderStatus): boolean {
  return status !== "entregado" && status !== "anulado"
}

/** «N.º 12», o «anterior» si no se sabe su número. */
export function orderNumberWords(link: OrderLink): string {
  return link.orderNumber !== null ? `N.º ${link.orderNumber}` : "anterior"
}

/** Lo que cambia con un pedido: las listas y los detalles. */
export function invalidateOrders(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: orderKeys.all })
}
