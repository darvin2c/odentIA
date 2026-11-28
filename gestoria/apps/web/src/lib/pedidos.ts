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
 * una persona, lo devuelto y lo que falta cobrar (total − pagado − por confirmar). «Pagado» es no
 * deber nada con todo confirmado; lo que sobra es lo que falta devolver. La pantalla no lo
 * recalcula.
 */
export interface Balance {
  confirmedCents: number
  pendingCents: number
  dueCents: number
  overCents: number
  paid: boolean
  /** Lo que la tienda ya devolvió (tablero 17). */
  refundedCents: number
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
  /** «Cambio del 0147»: el número del pedido entregado del que sale; null si no es un cambio. */
  exchangeOf: string | null
}

export interface OrderList {
  /** Qué día es en la tienda, con su hora. */
  today: string
  orders: OrderRow[]
  counts: Record<OrderFilter, number>
}

export interface OrderLine {
  id: string
  variantId: string
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
    | "cambiado"
    | "no_entregado"
    | "reprogramado"
    | "pago_deshecho"
    | "repartidor"
    | "envio"
    | "cambio"
    | "dinero_devuelto"
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
  /** La forma de entrega de la tienda con que se armó: con ella se abre «Cambiar». */
  deliveryMethodId: string | null
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
  /** Su franja (Despachos); null: sin franja. */
  slot: { start: number; end: number; label: string } | null
  /** Quién lo lleva. */
  courierId: string | null
  courierName: string | null
  /** Por agencia: con cuál va. */
  agency: string | null
  tracking: string | null
  linkUrl: string | null
  linkConnected: boolean
  /** La pasarela está en modo prueba: este pedido no se cobra por link (Cobros). */
  linkTestMode: boolean
  /** Conectada, pero ya no deja cobrar: venció su permiso o se quitó. */
  linkBroken: boolean
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
  /** «Cambio del 0147»: el pedido entregado del que sale este cambio. */
  exchangeOf: { id: string; number: string } | null
  /** «Cambio en el 0171»: los cambios que salieron de este pedido. */
  exchanges: { id: string; number: string; state: OrderState }[]
  /** Lo que vuelve en este cambio, a lo que se pagó, con su motivo. */
  returns: OrderReturn[]
  /** Lo que vuelve, a lo que se pagó: se descuenta del total. */
  returnCreditCents: number
  /** Lo que todavía puede volver de este pedido entregado, por variante. */
  returnable: { variantId: string; quantity: number }[]
  /** El dinero que la tienda devolvió de lo que sobra. */
  refunds: OrderRefund[]
}

export interface OrderReturn {
  variantId: string
  productName: string
  variantName: string
  sku: string
  quantity: number
  unitCents: number
  reason: string
  /** Cuándo volvió a la tienda; null mientras no llega. */
  returnedAt: string | null
}

export interface OrderRefund {
  id: string
  amountCents: number
  methodName: string
  createdAt: string
  createdByName: string | null
}

/**
 * El resumen de un cambio antes de crearlo, con las cifras que guardaría el servidor: lo que vuelve,
 * lo que se lleva, el envío, lo que falta cobrar o lo que la tienda devuelve.
 */
export interface ExchangeSummary {
  backCents: number
  takesCents: number
  deliveryCents: number
  deliveryListCents: number
  totalCents: number
  dueCents: number
  refundCents: number
  paymentName: string
  payOnDelivery: boolean
  takes: { variantId: string; unitCents: number; stock: number; short: boolean }[]
}

/** Por qué vuelve (tablero 17); si es otro, se escribe. */
export const RETURN_REASONS = [
  "Le quedó chica",
  "Le quedó grande",
  "No le gustó",
  "Llegó fallado",
] as const

/** «Sandalia beige 38», «Medias × 2». */
export function itemText(line: { productName: string; variantName: string; quantity: number }) {
  return `${line.productName}${line.variantName === "Única" ? "" : ` ${line.variantName}`}${line.quantity > 1 ? ` × ${line.quantity}` : ""}`
}

/** El enlace de WhatsApp con el aviso ya escrito (decisión 4): lo envía la persona. */
export function whatsappWithText(link: string | null, text: string): string | null {
  return link ? `${link}?text=${encodeURIComponent(text)}` : null
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

/**
 * Cómo quedaría un pedido con «Cambiar», sin guardarlo: lo calcula el servidor con la misma
 * operación que al guardar (el total, el saldo con sus pagos y si alcanza el stock).
 */
export interface ChangePreview {
  changes: string[]
  fields: Record<string, string>
  totalCents: number | null
  balance: Balance | null
  stockPending: boolean
}

/** Lo que todavía no salió: se cambia o se pasa a otro día. */
export const NOT_SHIPPED: OrderState[] = ["por_pagar", "por_confirmar", "por_salir"]

/** Los motivos de «No se entregó»; si es otro, se escribe. */
export const MISSED_REASONS = ["No contestó", "Dirección errada", "No lo quiso"] as const

/** El día siguiente a `date` («2026-11-26» → «2026-11-27»), en el calendario. */
export function nextDay(date: string): string {
  const day = new Date(`${date}T12:00:00Z`)
  day.setUTCDate(day.getUTCDate() + 1)
  return day.toISOString().slice(0, 10)
}

/**
 * Si volvió sin entregar y todavía no sale otra vez: el motivo de la última vez, o null. Sale de su
 * historia («No se entregó» después del último «Salió»).
 */
export function missedReason(order: Pick<OrderDetail, "state" | "events">): string | null {
  if (order.state !== "por_salir") return null
  const last = order.events.findLast((e) => e.action === "salio" || e.action === "no_entregado")
  return last?.action === "no_entregado" ? String(last.detail.motivo ?? "") : null
}

/** Cuántas veces ya volvió sin entregar (cada «No se entregó» de su historia). */
export function missedTrips(order: Pick<OrderDetail, "events">): number {
  return order.events.filter((e) => e.action === "no_entregado").length
}

/** Lo que se dice al anotar otro «No se entregó»: si es la primera vez en este pedido. */
export function missedTripsText(before: number): string {
  if (before === 0) return "Es la primera vez que este pedido no se entrega."
  return `Este pedido ya no se entregó ${before === 1 ? "1 vez" : `${before} veces`}: este es el viaje ${before + 1}.`
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
  /** Por encargo, con cupo o en preventa: se vende sin stock y el pedido espera a que entre. */
  sellsWithoutStock: boolean
  status: "encargo" | "cupo" | "preventa" | "liquidacion" | "no_se_vende" | null
}

const WITHOUT_STOCK: Record<string, string> = {
  encargo: "por encargo",
  cupo: "con cupo",
  preventa: "preventa",
}

/**
 * Cómo se lee una variante en la lista para anotar o cambiar un pedido: su precio de hoy y lo que
 * queda. Sin stock, «agotado», salvo lo que se vende sin stock (por encargo, con cupo o en
 * preventa), que dice eso y se puede elegir.
 */
export function sellableLabel(v: SellableVariant, price: string): string {
  const name = `${v.productName}${v.variantName === "Única" ? "" : ` · ${v.variantName}`}`
  return `${name} — ${price} · ${stockWord(v)}`
}

/** Lo que queda, en palabras: «quedan 3», «por encargo» o «agotado». */
export function stockWord(v: Pick<SellableVariant, "stock" | "sellsWithoutStock" | "status">) {
  if (v.stock > 0) return `quedan ${v.stock}`
  if (v.sellsWithoutStock) return WITHOUT_STOCK[v.status ?? ""] ?? "se vende sin stock"
  return "agotado"
}

/** Si se puede elegir para un pedido nuevo: hay stock o se vende sin él. */
export const canPick = (v: SellableVariant) => v.stock > 0 || v.sellsWithoutStock

/**
 * El nombre de cada estado. «Pago por confirmar» nunca se dice como pagado, y «Pagado» solo si no
 * falta cobrar nada con todo confirmado (el saldo del servidor).
 */
export function stateName(order: {
  state: OrderState
  paymentCollection: PaymentCollection
  balance: Balance
  /** Bajo cero: un cambio que cuesta menos o una devolución (tablero 17). */
  totalCents?: number
}): string {
  const { balance } = order
  const nothingYet = balance.confirmedCents + balance.pendingCents === 0
  // Lo que la tienda devuelve de un cambio no es «Pagado»: falta devolverlo.
  const toRefund = (order.totalCents ?? 0) < 0 && balance.overCents > 0
  if (toRefund && (order.state === "por_salir" || order.state === "en_camino"))
    return order.state === "por_salir" ? "Por salir · falta devolver" : "En camino · falta devolver"
  if (toRefund && order.state === "entregado") return "Entregado · falta devolver"
  // Ya devuelto, tampoco: no se cobró nada en el cambio.
  if ((order.totalCents ?? 0) < 0 && order.state === "por_salir") return "Por salir"
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
