import type { DeliveryType, PaymentCollection, PaymentTypeCode } from "./tienda"

/**
 * Lo que la pantalla sabe de los pedidos (paso B4): sus tipos, como los dice el servidor, y sus
 * nombres para la persona. Qué se puede hacer con cada uno lo decide el servidor.
 */

export type OrderState =
  | "por_pagar"
  | "por_confirmar"
  | "por_salir"
  | "en_camino"
  | "entregado"
  | "anulado"
export type OrderChannel = "whatsapp" | "instagram" | "messenger" | "otro"
export type OrderFilter =
  | "abiertos"
  | "por_confirmar"
  | "por_pagar"
  | "para_entregar"
  | "hoy"
  | "entregados"
  | "anulados"

/**
 * El saldo de un pedido, como lo calcula el servidor en un solo lugar: lo cobrado, lo que espera a
 * una persona y lo que falta cobrar (total − confirmado − por confirmar). «Pagado» es no deber
 * nada con todo confirmado. La pantalla no lo recalcula.
 */
export interface Balance {
  confirmedCents: number
  pendingCents: number
  dueCents: number
  overCents: number
  paid: boolean
}

export interface OrderRow {
  id: string
  number: string
  state: OrderState
  channel: OrderChannel
  customerName: string
  totalCents: number
  paymentName: string
  paymentCollection: PaymentCollection
  deliveryName: string
  deliveryZone: string | null
  deliverOn: string | null
  priceExpiresAt: string | null
  createdAt: string
  lines: { productName: string; variantName: string; quantity: number; gift: boolean }[]
  confirmedBy: string | null
  /** De «Probar a Sofi»: no mueve stock ni cuenta en Reportes. */
  test: boolean
  bySofi: boolean
  balance: Balance
  paid: boolean
}

export interface OrderList {
  /** Qué día es en la tienda, con su hora. */
  today: string
  orders: OrderRow[]
  counts: Record<OrderFilter, number>
}

export interface OrderLine {
  id: string
  productName: string
  variantName: string
  sku: string
  quantity: number
  listUnitCents: number
  autoUnitCents: number
  floorUnitCents: number
  unitCents: number
  gift: boolean
  photoId: string | null
}

export interface OrderPayment {
  id: string
  kind: PaymentCollection
  status: "por_confirmar" | "confirmado" | "no_coincide"
  amountCents: number
  /** Con qué pagó: el medio de la tienda («Yape», «Efectivo al recibir»). */
  methodName: string
  methodType: PaymentTypeCode
  operation: string | null
  hasPhoto: boolean
  note: string | null
  createdAt: string
  reviewedAt: string | null
  createdByName: string | null
  reviewedByName: string | null
  byLink: boolean
  /** Si se confirma, cuánto pasaría del total: más de 0 es un pago doble. */
  overIfConfirmedCents: number
}

export interface OrderEvent {
  id: string
  action:
    | "creado"
    | "link"
    | "comprobante"
    | "pago_confirmado"
    | "pago_no_coincide"
    | "pago_link"
    | "salio"
    | "entregado"
    | "anulado"
    | "aviso"
  detail: Record<string, unknown>
  createdAt: string
  actorName: string | null
  byLink: boolean
}

export interface OrderDetail {
  id: string
  number: string
  state: OrderState
  channel: OrderChannel
  /** La ficha de la clienta (entrega 4); null en los pedidos de antes y en los de prueba. */
  customerId: string | null
  customerName: string
  customerPhone: string | null
  address: string
  notes: string
  deliveryName: string
  deliveryType: DeliveryType
  deliveryZone: string | null
  deliveryListCents: number
  deliveryCents: number
  deliveryFreeByPolicy: boolean
  paymentName: string
  paymentCollection: PaymentCollection
  paymentDetails: string
  itemsAutoCents: number
  subtotalCents: number
  discountCents: number
  giftCents: number
  totalCents: number
  marginCents: number
  marginUsedCents: number
  priceExpiresAt: string | null
  priceExpired: boolean
  deliverOn: string | null
  tracking: string | null
  linkUrl: string | null
  linkConnected: boolean
  cancelReason: string | null
  createdAt: string
  balance: Balance
  /** «Pagado»: no falta cobrar y todo está confirmado. */
  paid: boolean
  /** Ya entró dinero (un pago confirmado o uno por el link que espera): lo anula quien confirma pagos. */
  moneyIn: boolean
  stockPending: boolean
  test: boolean
  bySofi: boolean
  lines: OrderLine[]
  payments: OrderPayment[]
  events: OrderEvent[]
}

export interface Quote {
  lines: {
    listUnitCents: number
    autoUnitCents: number
    floorUnitCents: number
    unitCents: number
    gift: boolean
    quantity: number
  }[]
  itemsAutoCents: number
  subtotalCents: number
  discountCents: number
  giftCents: number
  deliveryListCents: number
  deliveryCents: number
  deliveryFreeByPolicy: boolean
  marginCents: number
  marginUsedCents: number
  totalCents: number
  negotiated: boolean
}

export interface SellableVariant {
  id: string
  productName: string
  variantName: string
  sku: string
  stock: number
  listUnitCents: number
  autoUnitCents: number
  floorUnitCents: number
  promotion: string | null
}

/**
 * El nombre de cada estado. «Pago por confirmar» nunca se dice como pagado, y «Pagado» solo si no
 * falta cobrar nada con todo confirmado (el saldo del servidor).
 */
export function stateName(order: {
  state: OrderState
  paymentCollection: PaymentCollection
  balance: Balance
}): string {
  const { balance } = order
  const nothingYet = balance.confirmedCents + balance.pendingCents === 0
  switch (order.state) {
    case "por_pagar":
      return "Por pagar"
    case "por_confirmar":
      return "Pago por confirmar"
    case "por_salir":
      if (balance.paid) return "Pagado · por salir"
      if (balance.dueCents === 0) return "Por salir · pago por confirmar"
      return order.paymentCollection === "al_recibir" && nothingYet
        ? "Por salir · cobra al recibir"
        : "Por salir · falta cobrar"
    case "en_camino":
      return balance.dueCents > 0 ? "En camino · falta cobrar" : "En camino"
    case "entregado":
      return balance.dueCents > 0 ? "Entregado · falta cobrar" : "Entregado"
    default:
      return "Anulado"
  }
}

export const STATE_TONE: Record<
  OrderState,
  "warning" | "soft" | "success" | "outline" | "secondary"
> = {
  por_pagar: "outline",
  por_confirmar: "warning",
  por_salir: "soft",
  en_camino: "soft",
  entregado: "success",
  anulado: "secondary",
}

export const CHANNELS: Record<OrderChannel, string> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  otro: "Otro (llamada, tienda)",
}

export const FILTERS: { value: OrderFilter; label: string }[] = [
  { value: "abiertos", label: "Abiertos" },
  { value: "hoy", label: "Para entregar hoy" },
  { value: "por_confirmar", label: "Pago por confirmar" },
  { value: "por_pagar", label: "Por pagar" },
  { value: "para_entregar", label: "Para entregar" },
  { value: "entregados", label: "Entregados" },
  { value: "anulados", label: "Anulados" },
]

/**
 * Qué día es en la tienda («2026-11-19»), con su hora: la misma que usa el servidor para «Para
 * entregar hoy» y Reportes, aunque el equipo de la persona esté en otra.
 */
export function storeToday(timeZone: string, now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now)
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
    return `${part("year")}-${part("month")}-${part("day")}`
  } catch {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }
}

/** «hoy», «mañana», «ayer» o «jue 20 nov», contados desde `today` (el de la tienda). */
export function dayName(date: string, today: string): string {
  const day = (text: string) =>
    Date.UTC(Number(text.slice(0, 4)), Number(text.slice(5, 7)) - 1, Number(text.slice(8, 10)))
  const diff = Math.round((day(date) - day(today)) / 86_400_000)
  if (diff === 0) return "hoy"
  if (diff === 1) return "mañana"
  if (diff === -1) return "ayer"
  return new Intl.DateTimeFormat("es-PE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(day(date))
}

/** «19 nov, 3:42 p. m.» */
export function when(iso: string): string {
  return new Intl.DateTimeFormat("es-PE", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso))
}
