import { CHANNELS, dayName, localToday, type OrderChannel, type OrderState } from "./pedidos"
import type { PaymentCollection } from "./tienda"

/**
 * Lo que la pantalla sabe de las clientas (entrega 4, tablero 8): sus tipos, como los dice el
 * servidor, y cómo se dicen. Quién es quién lo decide una persona; el servidor solo sugiere.
 */

export const CUSTOMERS_KEY = (storeId: string) => ["clientes", storeId]
export const CUSTOMER_KEY = (storeId: string, customerId?: string) =>
  customerId ? ["cliente", storeId, customerId] : ["cliente", storeId]

export interface CustomerSummary {
  id: string
  name: string
  phones: string[]
  channels: OrderChannel[]
  purchases: number
  lastPurchaseAt: string | null
  lastZone: string | null
  lastOrder: { number: string; createdAt: string; text: string } | null
  lastAddress: string | null
  since: string
}

export interface CustomerList {
  customers: CustomerSummary[]
  /** Cuántas parejas de fichas podrían ser la misma clienta (sin buscar). */
  similar: number | null
  /** Hay más de las que se ven: se busca. */
  limited: boolean
}

export interface SimilarPair {
  reason: "telefono" | "nombre"
  a: CustomerSummary
  b: CustomerSummary
}

export interface CustomerHistoryItem {
  id: string
  action: "unida" | "separada" | "distintas"
  createdAt: string
  actorName: string | null
  /** La decisión habla de esta ficha frente a `with` (si no, de `with` frente a esta). */
  self: boolean
  with: { id: string; name: string }
  /** La ficha que «Separar» deja sola; null si ya no se puede. */
  separates: string | null
}

export interface RepeatDraft {
  number: string
  channel: OrderChannel
  lines: { variantId: string; productName: string; variantName: string; quantity: number }[]
  deliveryMethodId: string | null
  zone: string | null
  address: string
  paymentMethodId: string | null
}

export interface CustomerDetail {
  id: string
  name: string
  phone: string | null
  phones: string[]
  channels: OrderChannel[]
  since: string
  note: string
  noteByName: string | null
  noteAt: string | null
  purchases: number
  orders: {
    id: string
    number: string
    state: OrderState
    paymentCollection: PaymentCollection
    channel: OrderChannel
    totalCents: number
    createdAt: string
    text: string
  }[]
  addresses: { address: string; deliveryName: string; zone: string | null }[]
  members: { id: string; name: string; phone: string | null; channels: OrderChannel[] }[]
  history: CustomerHistoryItem[]
  repeat: RepeatDraft | null
  similar: { id: string; name: string; phone: string | null }[]
}

/** «WhatsApp · Instagram», sin «otro». */
export function channelsText(channels: OrderChannel[]): string {
  return channels
    .filter((c) => c !== "otro")
    .map((c) => CHANNELS[c])
    .join(" · ")
}

/** El día de una fecha y hora, en el equipo de la persona: «hoy», «ayer», «jue 20 nov». */
export function dayOf(iso: string, today = localToday()): string {
  return dayName(localToday(new Date(iso)), today)
}

/** «2 compras · la última hoy», o «Sin compras». */
export function purchasesText(
  purchases: number,
  lastPurchaseAt: string | null,
  today = localToday(),
): string {
  if (purchases === 0) return "Sin compras"
  const count = purchases === 1 ? "1 compra" : `${purchases} compras`
  return lastPurchaseAt ? `${count} · la última ${dayOf(lastPurchaseAt, today)}` : count
}

/** «clienta desde oct 2026» */
export function sinceText(iso: string): string {
  const month = new Intl.DateTimeFormat("es-PE", { month: "short", year: "numeric" }).format(
    new Date(iso),
  )
  return `clienta desde ${month.replace(/\.|de /g, "")}`
}

/**
 * El enlace para escribirle por WhatsApp desde el celular, si uno de sus teléfonos está con su
 * código de país («+51 …»): sin él no se sabe a qué país marcar. Lo envía la persona.
 */
export function whatsappLink(phones: string[]): string | null {
  const international = phones.find((p) => p.trim().startsWith("+"))
  const digits = international?.replace(/\D/g, "") ?? ""
  return digits.length >= 8 ? `https://wa.me/${digits}` : null
}

/** Por qué se sugiere que son la misma. */
export function reasonText(reason: SimilarPair["reason"]): string {
  return reason === "telefono" ? "Tienen el mismo teléfono." : "Tienen el mismo nombre."
}

/** Lo que dice cada decisión en la historia de la ficha. */
export function historyText(item: CustomerHistoryItem): string {
  const who = item.actorName ?? "Alguien del equipo"
  const other = `«${item.with.name}»`
  switch (item.action) {
    case "unida":
      return item.self
        ? `${who} dijo que esta ficha es la misma clienta que ${other}.`
        : `${who} dijo que ${other} es la misma clienta: su ficha quedó dentro de esta.`
    case "separada":
      return item.self
        ? `${who} separó esta ficha de ${other}.`
        : `${who} separó ${other}: volvió a ser otra ficha.`
    default:
      return `${who} dijo que ${other} es otra clienta.`
  }
}
