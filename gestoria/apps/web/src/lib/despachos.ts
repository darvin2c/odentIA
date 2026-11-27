import { whatsappLink } from "./clientes"
import type { Balance, OrderState } from "./pedidos"
import { dayName } from "./pedidos"
import type { DeliveryType, PaymentCollection } from "./tienda"

/**
 * Lo que la pantalla sabe de Despachos (entrega 3 del lienzo «gestorIA como odentIA», tablero 6):
 * las entregas de un día, como las dice el servidor, y cómo se agrupan y se nombran. Qué se puede
 * hacer con cada una lo deciden las operaciones del pedido en el servidor.
 */

/** Una franja: de `start` a `end`, en minutos desde las 00:00 de la tienda, con su nombre. */
export interface Slot {
  start: number
  end: number
  label: string
}

/** A quién se le puede asignar: una persona del equipo o un nombre externo que la tienda usó. */
export interface Courier {
  id: string | null
  userId: string | null
  name: string
  team: boolean
}

export interface Delivery {
  id: string
  number: string
  state: OrderState
  customerName: string
  customerPhone: string | null
  address: string
  deliveryName: string
  deliveryType: DeliveryType
  deliveryZone: string | null
  deliverOn: string | null
  late: boolean
  slot: Slot | null
  courierId: string | null
  courierName: string | null
  agency: string | null
  tracking: string | null
  totalCents: number
  paymentName: string
  paymentCollection: PaymentCollection
  balance: Balance
  missed: { reason: string; at: string | null; resolved: boolean } | null
}

export interface DispatchDay {
  day: string
  pending: number
  delivered: number
  missed: number
}

export interface DispatchBoard {
  today: string
  day: string
  days: DispatchDay[]
  slots: Slot[]
  couriers: Courier[]
  deliveries: Delivery[]
}

export const DISPATCH_KEY = (storeId: string) => ["despachos", storeId]

/** «Todos», un repartidor o «Sin repartidor». */
export type CourierFilter = "todos" | "sin" | string

export function byCourier(deliveries: Delivery[], filter: CourierFilter): Delivery[] {
  if (filter === "todos") return deliveries
  if (filter === "sin") return deliveries.filter((d) => d.courierId === null)
  return deliveries.filter((d) => d.courierId === filter)
}

/** Los repartidores con entregas ese día, con cuántas lleva cada uno (y cuántas no tienen). */
export function courierCounts(deliveries: Delivery[]) {
  const counts = new Map<string, { id: string; name: string; count: number }>()
  let without = 0
  for (const d of deliveries) {
    if (!d.courierId) {
      without += 1
      continue
    }
    const one = counts.get(d.courierId) ?? { id: d.courierId, name: d.courierName ?? "", count: 0 }
    one.count += 1
    counts.set(d.courierId, one)
  }
  return {
    couriers: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name, "es")),
    without,
  }
}

export interface DispatchSection {
  key: string
  title: string
  /** «No se entregó» sale primero y con su tono. */
  missed: boolean
  deliveries: Delivery[]
}

/**
 * Las secciones del día (tablero 6): primero «No se entregó», después cada franja en su orden y al
 * final «Sin franja». Una franja que la tienda ya quitó sigue saliendo con lo que la tiene. Las
 * secciones vacías no se muestran.
 */
export function sections(deliveries: Delivery[]): DispatchSection[] {
  const missed = deliveries.filter((d) => d.missed)
  const rest = deliveries.filter((d) => !d.missed)
  const bySlot = new Map<string, { slot: Slot; deliveries: Delivery[] }>()
  const withoutSlot: Delivery[] = []
  for (const d of rest) {
    if (!d.slot) {
      withoutSlot.push(d)
      continue
    }
    const key = `${d.slot.start}-${d.slot.end}`
    const group = bySlot.get(key) ?? { slot: d.slot, deliveries: [] }
    group.deliveries.push(d)
    bySlot.set(key, group)
  }
  const ordered = [...bySlot.entries()].sort(
    ([, a], [, b]) => a.slot.start - b.slot.start || a.slot.end - b.slot.end,
  )
  return [
    ...(missed.length
      ? [{ key: "no-se-entrego", title: "No se entregó", missed: true, deliveries: missed }]
      : []),
    ...ordered.map(([key, group]) => ({
      key,
      title: group.slot.label,
      missed: false,
      deliveries: group.deliveries,
    })),
    ...(withoutSlot.length
      ? [{ key: "sin-franja", title: "Sin franja", missed: false, deliveries: withoutSlot }]
      : []),
  ]
}

/** La forma de entrega en la fila: «Callao · Envío», «Recojo en tienda», «Agencia Shalom». */
export function wayText(
  d: Pick<Delivery, "deliveryType" | "deliveryZone" | "agency" | "deliveryName">,
) {
  if (d.deliveryType === "OnSitePickup") return "Recojo en tienda"
  if (d.deliveryType === "ParcelService") return d.agency ? `Agencia ${d.agency}` : "Agencia"
  return d.deliveryZone ? `${d.deliveryZone} · Envío` : "Envío"
}

/** Lo que dice la fila del cobro: «Pagado», «Cobrar S/ 204», «Pago por confirmar». */
export type ChargeTone = "paid" | "charge" | "pending"

export function chargeOf(balance: Balance): { tone: ChargeTone; cents: number } {
  if (balance.dueCents > 0) return { tone: "charge", cents: balance.dueCents }
  if (balance.pendingCents > 0) return { tone: "pending", cents: balance.pendingCents }
  return { tone: "paid", cents: 0 }
}

/** Lo que dice la franja de días de arriba de cada uno. */
export function dayCountText(day: DispatchDay, today: string): string {
  const parts: string[] = []
  if (day.day < today) {
    if (day.delivered > 0)
      parts.push(day.delivered === 1 ? "1 entregado" : `${day.delivered} entregados`)
  } else {
    if (day.pending > 0) parts.push(`${day.pending} por salir`)
    if (day.delivered > 0) parts.push(`${day.delivered} entregados`)
  }
  if (day.missed > 0)
    parts.push(day.missed === 1 ? "1 no se entregó" : `${day.missed} no se entregaron`)
  return parts.join(" · ") || "Nada"
}

/** «9 y 13 h» de «9–13 h»: como se escribe en un mensaje. */
function slotWords(label: string): string {
  return label.replace("–", " y ")
}

/**
 * El aviso de «Avisar» (decisión 4), escrito para la clienta: cuándo sale, quién lo lleva y cuánto
 * paga al recibir. Se ve y se puede cambiar antes de abrir el WhatsApp.
 */
export function noticeText(
  d: Pick<
    Delivery,
    | "customerName"
    | "number"
    | "deliverOn"
    | "slot"
    | "courierName"
    | "deliveryType"
    | "agency"
    | "tracking"
    | "balance"
    | "state"
  >,
  today: string,
  money: (cents: number) => string,
): string {
  const first = d.customerName.trim().split(/\s+/)[0] ?? d.customerName
  const day = d.deliverOn ? dayName(d.deliverOn, today) : null
  const due = d.balance.dueCents > 0 ? ` Al recibir pagas ${money(d.balance.dueCents)}.` : ""
  if (d.deliveryType === "ParcelService" && d.state === "en_camino")
    return `Hola ${first}, tu pedido ${d.number} va en camino${d.agency ? ` por ${d.agency}` : ""}.${d.tracking ? ` Número de envío: ${d.tracking}.` : ""}${due}`
  if (d.deliveryType === "OnSitePickup")
    return `Hola ${first}, tu pedido ${d.number} está listo para recoger${day ? ` ${day}` : ""}${d.slot ? ` entre ${slotWords(d.slot.label)}` : ""}.${due}`
  const when = `${day ? ` ${day}` : ""}${d.slot ? ` entre ${slotWords(d.slot.label)}` : ""}`
  return `Hola ${first}, tu pedido ${d.number} sale${when}.${d.courierName ? ` Te lo lleva ${d.courierName}.` : ""}${due}`
}

/** El WhatsApp del celular con el aviso escrito; null si el teléfono no se puede leer. */
export function noticeLink(phone: string | null, text: string, country: string | null) {
  const base = phone ? whatsappLink([phone], country) : null
  return base ? `${base}?text=${encodeURIComponent(text)}` : null
}
