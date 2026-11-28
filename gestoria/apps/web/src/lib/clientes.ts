import { normalizeCountry, toE164 } from "@odentia/ui-patterns"
import {
  type Balance,
  CHANNELS,
  dayName,
  type OrderChannel,
  type OrderState,
  storeToday,
} from "./pedidos"
import type { ConsentState, CustomerProfile } from "./perfil"
import { money, type PaymentCollection } from "./tienda"

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
  /** Lo que debe: la suma de lo que falta cobrar de sus compras, del saldo de cada una. */
  dueCents: number
  /** Todo lo que debe se cobra al entregar. */
  dueOnDelivery: boolean
  /*
   * Lo que Argos calcula cada noche con sus pedidos pagados (entrega «lo calculado y los grupos»).
   * Opcional: una respuesta sin ello no tumba la lista.
   */
  segment?: Segment
  segmentWhy?: string
  totalCents?: number
  ordersCount?: number
  /** Días desde su última compra pagada, con el día de la tienda; null sin compras. */
  lastBoughtDays?: number | null
  /** Su medida («38»), la que dice «Lo que Argos sabe de ella». */
  measure?: string | null
  district?: string | null
  consent?: ConsentState
  /** «compra zapatillas blancas en talla 38 · Surco», si el servidor la arma. */
  whoLine?: string
}

/** Los grupos que Argos calcula, del más valioso al que todavía no compra. */
export type Segment =
  | "vip"
  | "frecuente"
  | "nueva"
  | "riesgo"
  | "dormida"
  | "perdida"
  | "sin_compras"

export const SEGMENT_IDS: Segment[] = [
  "vip",
  "frecuente",
  "nueva",
  "riesgo",
  "dormida",
  "perdida",
  "sin_compras",
]

/**
 * Cada grupo con su nombre y su color (el del lienzo aprobado). VIP y Nueva no tienen un tono
 * semántico propio: llevan el suyo, con su versión oscura. El nombre va siempre escrito: el color
 * nunca es la única señal.
 */
export const SEGMENTS: Record<Segment, { label: string; className: string }> = {
  vip: {
    label: "VIP",
    className: "bg-[#f1e8ff] text-[#6d28d9] dark:bg-[#2e2148] dark:text-[#c4b5fd]",
  },
  frecuente: { label: "Frecuente", className: "bg-success-soft text-success" },
  nueva: {
    label: "Nueva",
    className: "bg-[#e3ecff] text-[#1d4ed8] dark:bg-[#1c2a4a] dark:text-[#93b4ff]",
  },
  riesgo: { label: "En riesgo", className: "bg-warning-soft text-warning" },
  dormida: { label: "Dormida", className: "bg-secondary text-secondary-foreground" },
  perdida: { label: "Perdida", className: "bg-danger-soft text-destructive" },
  sin_compras: { label: "Sin compras", className: "border-border text-muted-foreground" },
}

export function isSegment(value: unknown): value is Segment {
  return typeof value === "string" && (SEGMENT_IDS as string[]).includes(value)
}

export interface CustomerFacets {
  segments: Partial<Record<Segment, number>>
  measures: string[]
  categories: string[]
  districts: string[]
}

export interface CustomerList {
  customers: CustomerSummary[]
  /** Cuántas parejas de fichas podrían ser la misma clienta (sin buscar). */
  similar: number | null
  /** Hay más de las que se ven: se busca. */
  limited: boolean
  /** Lo que se puede elegir en los filtros, y cuántas hay en cada grupo. */
  facets?: CustomerFacets
  /** «Talla de calzado», «Talla», «Tono»…: lo que mide la tienda. */
  measureLabel?: string
}

/* ------------------------------------------------------------- filtros y grupos */

/** Lo que se filtra en la lista; vive en la dirección («?grupo=riesgo&medida=38»). */
export interface CustomerFilters {
  grupo?: Segment
  medida?: string
  categoria?: string
  distrito?: string
  promociones?: "si" | "no"
  /** Con «-», al revés, como la flecha del menú: «gasto» de menos a más, «-gasto» de más a menos. */
  orden?: CustomerOrder
}

export type CustomerOrder = "reciente" | "-reciente" | "gasto" | "-gasto"

/** La dirección de Clientes: lo que se busca, los filtros y el orden (`sort`, el de `FilterBar`). */
export type CustomerSearch = Omit<CustomerFilters, "orden"> & { q?: string; sort?: string }

const ORDERS = ["reciente", "gasto"]
const isOrder = (value: string | undefined): value is CustomerOrder =>
  Boolean(value && ORDERS.includes(value.replace(/^-/, "")))

// La dirección lee «?medida=37» como el número 37: una talla es texto igual.
const text = (value: unknown) => {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 120) : undefined
}

/** Lo que vale de la dirección: lo demás se descarta sin romper la pantalla. */
export function customerSearch(search: Record<string, unknown>): CustomerSearch {
  const out: CustomerSearch = {}
  const q = text(search.q)
  if (q) out.q = q
  if (isSegment(search.grupo)) out.grupo = search.grupo
  const medida = text(search.medida)
  if (medida) out.medida = medida
  const categoria = text(search.categoria)
  if (categoria) out.categoria = categoria
  const distrito = text(search.distrito)
  if (distrito) out.distrito = distrito
  if (search.promociones === "si" || search.promociones === "no")
    out.promociones = search.promociones
  const sort = text(search.sort)
  if (isOrder(sort)) out.sort = sort
  return out
}

/** Los filtros de la dirección, como los pide el servidor y como se guardan en un grupo. */
export function filtersOf(search: CustomerSearch): CustomerFilters {
  // Con su dirección: lo que muestra la flecha es lo que ordena el servidor.
  const orden = isOrder(search.sort) ? search.sort : undefined
  return Object.fromEntries(
    Object.entries({
      grupo: search.grupo,
      medida: search.medida,
      categoria: search.categoria,
      distrito: search.distrito,
      promociones: search.promociones,
      orden,
    }).filter(([, value]) => value),
  ) as CustomerFilters
}

/** Hay algo elegido que se puede guardar como grupo (el orden solo no es un grupo). */
export function hasFilters(filters: CustomerFilters): boolean {
  return Boolean(
    filters.grupo || filters.medida || filters.categoria || filters.distrito || filters.promociones,
  )
}

/** «?grupo=riesgo&medida=38&q=ana», para `GET /api/tiendas/:id/clientes`. */
export function listQuery(filters: CustomerFilters, q?: string): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  if (q) params.set("q", q)
  const query = params.toString()
  return query ? `?${query}` : ""
}

/** Lo que un grupo guardado pone en la dirección: reemplaza todo lo elegido antes. */
export function searchOfGroup(
  filters: CustomerFilters & { q?: string },
): Record<string, string | undefined> {
  return {
    q: filters.q,
    grupo: filters.grupo,
    medida: filters.medida,
    categoria: filters.categoria,
    distrito: filters.distrito,
    promociones: filters.promociones,
    sort: filters.orden,
  }
}

/** Lo elegido es exactamente lo de ese grupo. */
export function sameFilters(a: CustomerFilters, b: CustomerFilters): boolean {
  const keys = ["grupo", "medida", "categoria", "distrito", "promociones"] as const
  return (
    keys.every((key) => (a[key] ?? "") === (b[key] ?? "")) && (a.orden ?? "") === (b.orden ?? "")
  )
}

/** El nombre que se propone al guardar: lo elegido, en palabras. */
export function groupNameOf(filters: CustomerFilters): string {
  return (
    [
      filters.grupo ? SEGMENTS[filters.grupo].label : null,
      filters.categoria,
      filters.medida,
      filters.distrito,
      filters.promociones === "si" ? "aceptan promociones" : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Mi grupo"
  )
}

/**
 * Lo que dice «Guardar como grupo»: que Argos lo pone al día y cuántas son hoy con lo que se guarda
 * (los filtros, sin la búsqueda). Con una búsqueda escrita, avisa que no se guarda. Sin la cuenta
 * todavía, no da un número.
 */
export function saveGroupDescription(input: {
  searching: boolean
  count?: number | undefined
  limited?: boolean | undefined
}): string {
  const parts = input.searching ? ["La búsqueda no se guarda: el grupo son los filtros."] : []
  parts.push("Argos lo pone al día solo: entra quien cumpla, sale quien no.")
  if (input.count !== undefined)
    parts.push(
      `Hoy ${input.count === 1 && !input.limited ? "es" : "son"} ${input.limited ? `más de ${input.count} clientas` : plural(input.count, "clienta", "clientas")}.`,
    )
  return parts.join(" ")
}

export interface SavedGroup {
  id: string
  name: string
  /** Un grupo guardado desde otro lugar puede llevar también lo buscado. */
  filters: CustomerFilters & { q?: string }
}

export const GROUPS_KEY = (storeId: string) => ["clientes-grupos", storeId]

/** «Hoy», «Ayer», «Hace 12 días» o «Sin compras». */
export function lastBoughtText(days: number | null | undefined): string {
  if (days === null || days === undefined) return "Sin compras"
  if (days <= 0) return "Hoy"
  if (days === 1) return "Ayer"
  return `Hace ${days} días`
}

/** «1 clienta», «3 compras». */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
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
  /** Lo que debe: la suma de lo que falta cobrar de sus compras, del saldo de cada una. */
  dueCents: number
  /** Todo lo que debe se cobra al entregar. */
  dueOnDelivery: boolean
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
    /** Si se vendió con rebaja o en liquidación, cuando el servidor lo dice. */
    priceNote?: "rebaja" | "liquidacion" | null
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
  /** Lo que Argos sabe de ella y cuándo se le puede escribir (ADR 0240). */
  profile?: CustomerProfile | null
  /** «compra zapatillas blancas en talla 37 · San Isidro». */
  whoLine?: string
  /** Lo que Argos calcula cada noche con sus pedidos pagados. Nadie la mueve a mano. */
  computed?: CustomerComputed | null
}

export interface CustomerComputed {
  segment: Segment
  why: string
  ordersCount: number
  totalCents: number
  avgCents: number
  /** Cada cuántos días compra; null con una sola compra. */
  rhythmDays: number | null
  lastBoughtDays: number | null
  /** [lo que compra, cuántas veces], de lo más a lo menos. */
  categories: [string, number][]
  colors: [string, number][]
  measures: [string, number][]
  priceSensitivity: "rebaja" | "liquidacion" | null
  sensitivityWhy: string | null
  wanted: {
    kind: "agotado" | "cotizo" | "carrito"
    text: string
    at: string
    orderNumber?: string
  }[]
}

/** «Pide rebaja», «Compra en liquidación» o «Paga el precio normal», con su porqué. */
export function priceText(
  computed: Pick<CustomerComputed, "priceSensitivity" | "sensitivityWhy">,
): { value: string; why: string } {
  if (computed.priceSensitivity === "rebaja")
    return { value: "Pide rebaja", why: computed.sensitivityWhy ?? "" }
  if (computed.priceSensitivity === "liquidacion")
    return { value: "Compra en liquidación", why: computed.sensitivityWhy ?? "" }
  return {
    value: "Paga el precio normal",
    why: computed.sensitivityWhy ?? "sin rebaja en sus compras",
  }
}

/** Por qué no lo compró, en palabras. */
export const WANTED_KIND: Record<CustomerComputed["wanted"][number]["kind"], string> = {
  agotado: "estaba agotado",
  cotizo: "lo cotizó y no cerró",
  carrito: "carrito sin pagar",
}

/** «Sandalias ×3», de lo que compra: categorías, y sus dos colores y medidas más compradas. */
export function boughtBadges(
  computed: Pick<CustomerComputed, "categories" | "colors" | "measures">,
) {
  return [
    ...(computed.categories ?? []).map(([name, n]) => ({
      key: `c-${name}`,
      text: `${name} ×${n}`,
    })),
    ...(computed.colors ?? [])
      .slice(0, 2)
      .map(([name, n]) => ({ key: `o-${name}`, text: `${name} ×${n}` })),
    ...(computed.measures ?? [])
      .slice(0, 2)
      .map(([name, n]) => ({ key: `m-${name}`, text: `${name} ×${n}` })),
  ]
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

/**
 * «Debe S/ 204 · contra entrega», o null si no debe nada. La cifra la dice el servidor con el
 * saldo de cada compra; aquí solo se dice.
 */
export function owedText(
  owed: { dueCents: number; dueOnDelivery: boolean },
  currency: string,
): string | null {
  if (owed.dueCents <= 0) return null
  const amount = `Debe ${money(owed.dueCents, currency)}`
  return owed.dueOnDelivery ? `${amount} · contra entrega` : amount
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
