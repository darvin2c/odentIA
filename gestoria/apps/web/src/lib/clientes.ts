import { normalizeCountry, toE164 } from "@odentia/ui-patterns"
import {
  type Balance,
  CHANNELS,
  dayName,
  type OrderChannel,
  type OrderState,
  storeToday,
} from "./pedidos"
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
  /** El país de la tienda (ISO 3166-1): un teléfono sin su código se lee como de ese país. */
  country: string | null
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
    /** El saldo de la compra, el mismo que en Pedidos: con él se dice su estado. */
    balance: Balance
    createdAt: string
    text: string
  }[]
  addresses: { address: string; deliveryName: string; zone: string | null }[]
  /** Las fichas que se le unieron, con su «Lo que sabemos» (unir no lo mueve ni lo borra). */
  members: {
    id: string
    name: string
    phone: string | null
    channels: OrderChannel[]
    note: string
  }[]
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

/**
 * El día de una fecha y hora con la hora de la tienda, como en Pedidos: «hoy», «ayer», «jue 20
 * nov», el mismo para todo el equipo aunque alguien esté en otro país.
 */
export function dayOf(iso: string, timeZone: string, today = storeToday(timeZone)): string {
  return dayName(storeToday(timeZone, new Date(iso)), today)
}

/** «2 compras · la última hoy», o «Sin compras». */
export function purchasesText(
  purchases: number,
  lastPurchaseAt: string | null,
  timeZone: string,
  today = storeToday(timeZone),
): string {
  if (purchases === 0) return "Sin compras"
  const count = purchases === 1 ? "1 compra" : `${purchases} compras`
  return lastPurchaseAt ? `${count} · la última ${dayOf(lastPurchaseAt, timeZone, today)}` : count
}

/** «clienta desde oct 2026» */
export function sinceText(iso: string): string {
  const month = new Intl.DateTimeFormat("es-PE", { month: "short", year: "numeric" }).format(
    new Date(iso),
  )
  return `clienta desde ${month.replace(/\.|de /g, "")}`
}

/**
 * El enlace para escribirle por WhatsApp desde el celular (lo envía la persona). Cada teléfono se
 * lee en E.164 con los metadatos estándar: el que tiene su código («+51 …») vale siempre; el que se
 * anotó sin él, como del país de la tienda. Sin ninguno que sea un número posible, no hay enlace:
 * no se adivina el país.
 */
export function whatsappLink(phones: string[], country?: string | null): string | null {
  const region = normalizeCountry(country)
  for (const phone of phones) {
    const e164 = phone.trim().startsWith("+") || region ? toE164(phone, region) : null
    if (e164) return `https://wa.me/${e164.slice(1)}`
  }
  return null
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
