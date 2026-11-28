import type { CustomerSegment, PriceSensitivity } from "@gestoria/db"
import { formatMoney } from "./dinero.js"

/**
 * Lo que Argos calcula de cada clienta (lienzo «Clientas bien perfiladas y Argos que hace el
 * marketing solo»): su grupo, por qué, sus compras y si es sensible al precio. Sin base ni red y
 * sin modelo: son cuentas fijas sobre sus compras, las mismas en la vuelta de cada noche
 * (`clientas-grupos.ts`), en la lista de Clientes y en su ficha.
 *
 * Los grupos, en este orden (la primera regla que cumple gana), con los días contados en la hora
 * de la tienda:
 *
 * - Perdida: más de 365 días sin comprar.
 * - Dormida: de 91 a 365 días sin comprar.
 * - VIP: 5 compras o más en los últimos 365 días y la última hace 90 días o menos.
 * - En riesgo: 2 compras o más y ya pasó vez y media su ritmo (o 45 días, lo que sea más) sin comprar.
 * - Frecuente: 2 compras o más, al día con su ritmo.
 * - Nueva: una compra, hace 90 días o menos.
 * - Sin compras: tiene ficha y ninguna compra.
 *
 * Su ritmo son los días entre la primera y la última compra, divididos entre las compras menos
 * una, redondeado. Con 2 compras o más, si en la mitad o más se cedió algo o compró con una
 * promoción, «pide rebaja» o «compra en liquidación» (la que más pesa; si empatan, rebaja).
 */

export type Segment = CustomerSegment
export const SEGMENTS: readonly Segment[] = [
  "vip",
  "frecuente",
  "nueva",
  "riesgo",
  "dormida",
  "perdida",
  "sin_compras",
]

/** Lo que llevó en una compra: cada producto, sin los regalos. */
export interface PurchaseItem {
  category: string | null
  color: string | null
  /** El valor de la medida de la tienda (la talla, el tono), si el producto la tiene. */
  measure: string | null
}

/** Una compra: un pedido con ficha, que no es de prueba, en un estado que ya es compra. */
export interface Purchase {
  /** El día de la compra en la hora de la tienda: «2026-11-25». */
  day: string
  /** Lo que gastó: el total del pedido menos lo que volvió en sus cambios. */
  spentCents: number
  /** Se cedió algo del margen (descuento, envío o regalo). */
  ceded: boolean
  /** Llevó algo con una promoción aplicada. */
  promo: boolean
  items: PurchaseItem[]
  /** La zona de la entrega, si la tiene. */
  zone?: string | null
}

export interface Computed {
  segment: Segment
  why: string
  ordersCount: number
  totalCents: number
  avgCents: number
  rhythmDays: number | null
  lastBoughtDays: number | null
  /** De lo que más compra a lo que menos: en cuántas compras lo llevó. */
  categories: [string, number][]
  colors: [string, number][]
  measures: [string, number][]
  priceSensitivity: PriceSensitivity | null
  sensitivityWhy: string | null
}

const DAY_MS = 86_400_000

/** Los días del calendario de `from` a `to` («2026-11-01» a «2026-11-27» son 26). */
export function daysBetween(from: string, to: string): number {
  const at = (day: string) => {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((at(to) - at(from)) / DAY_MS)
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Lo que se repite, de lo más a lo menos; si empatan, lo de la compra más reciente primero. */
function tally(purchases: Purchase[], pick: (item: PurchaseItem) => string | null) {
  const seen = new Map<string, number>()
  // Las compras van de la más reciente a la más vieja: el orden de llegada desempata.
  for (const purchase of purchases) {
    const values = new Set(
      purchase.items.map(pick).filter((v): v is string => Boolean(v && v.trim())),
    )
    for (const value of values) seen.set(value, (seen.get(value) ?? 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1])
}

export const SENSITIVITY_TEXT: Record<PriceSensitivity, string> = {
  rebaja: "pide rebaja",
  liquidacion: "compra en liquidación",
}

/**
 * Lo que Argos calcula de una clienta con sus compras, el día de hoy de la tienda y su moneda
 * (para decir cuánto gastó). Una compra con fecha después de hoy cuenta como de hoy.
 */
export function computedOf(purchases: Purchase[], today: string, currency: string): Computed {
  const bought = [...purchases].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
  const n = bought.length
  const ago = (p: Purchase) => Math.max(0, daysBetween(p.day, today))
  const out: Computed = {
    segment: "sin_compras",
    why: "Todavía no compra.",
    ordersCount: n,
    totalCents: 0,
    avgCents: 0,
    rhythmDays: null,
    lastBoughtDays: null,
    categories: [],
    colors: [],
    measures: [],
    priceSensitivity: null,
    sensitivityWhy: null,
  }
  if (n === 0) return out
  out.totalCents = bought.reduce((sum, p) => sum + p.spentCents, 0)
  out.avgCents = Math.round(out.totalCents / n)
  const last = ago(bought[0]!)
  const first = ago(bought[n - 1]!)
  out.lastBoughtDays = last
  out.rhythmDays = n > 1 ? Math.round((first - last) / (n - 1)) : null
  const year = bought.filter((p) => ago(p) <= 365)
  const yearCents = year.reduce((sum, p) => sum + p.spentCents, 0)
  // Con espacios comunes: el porqué se lee y se compara como texto.
  const money = (cents: number) => formatMoney(cents, currency).replace(/[\u00a0\u202f]/g, " ")
  if (last > 365) {
    out.segment = "perdida"
    out.why = `No compra hace ${last} días, más de un año.`
  } else if (last > 90) {
    out.segment = "dormida"
    out.why = `${last} días sin comprar (más de 90).`
  } else if (year.length >= 5) {
    out.segment = "vip"
    // Los meses desde su primera compra del año.
    const months = Math.max(1, Math.round(ago(year[year.length - 1]!) / 30))
    out.why = `${year.length} compras, ${money(yearCents)} en ${plural(months, "mes", "meses")}.`
  } else if (n >= 2 && last > Math.max(45, 1.5 * (out.rhythmDays ?? 0))) {
    out.segment = "riesgo"
    out.why = `Compraba cada ${plural(out.rhythmDays ?? 0, "día", "días")} y ya van ${last}.`
  } else if (n >= 2) {
    out.segment = "frecuente"
    out.why =
      out.rhythmDays === 0
        ? `${n} compras, el mismo día.`
        : `${n} compras, una cada ${plural(out.rhythmDays ?? 0, "día", "días")}.`
  } else {
    out.segment = "nueva"
    out.why =
      last === 0
        ? "Su primera compra fue hoy."
        : `Su primera compra fue hace ${plural(last, "día", "días")}.`
  }
  out.categories = tally(bought, (item) => item.category)
  out.colors = tally(bought, (item) => item.color)
  out.measures = tally(bought, (item) => item.measure)
  if (n >= 2) {
    const ceded = bought.filter((p) => p.ceded).length
    const promo = bought.filter((p) => p.promo).length
    const either = bought.filter((p) => p.ceded || p.promo).length
    if (either * 2 >= n) {
      const kind: PriceSensitivity = ceded >= promo ? "rebaja" : "liquidacion"
      out.priceSensitivity = kind
      out.sensitivityWhy = `${either} de ${n} compras ${kind === "rebaja" ? "con rebaja" : "en liquidación"}`
    }
  }
  return out
}

/** Lo que ella pidió y no compró, para decir por qué preguntó si todavía no compra. */
export interface WantedLike {
  text: string
  /** Lo que quiso, sin el precio. */
  item?: string
}

/**
 * Quién es, en una línea: «compra sandalias beige en talla 37 · San Isidro · pide rebaja». Sin su
 * grupo (la pantalla lo pone como insignia). La medida y el distrito son los de su perfil si los
 * tiene; si no, la medida que más compra y la zona de su última entrega.
 */
export function whoLine(input: {
  purchases: Purchase[]
  computed: Computed
  measureLabel: string
  measure?: string | null
  district?: string | null
  wanted?: WantedLike[]
}): string {
  const { computed } = input
  const recent = [...input.purchases].sort((a, b) => (a.day < b.day ? 1 : -1))
  // El distrito, solo el de su perfil: la zona de reparto de la tienda no es un distrito.
  const district = input.district?.split(",")[0]?.trim() || null
  if (computed.ordersCount === 0) {
    const first = input.wanted?.[0]
    const asked = first?.item ?? first?.text
    return [asked ? `preguntó por ${asked.toLowerCase()}` : "todavía no compra", district]
      .filter(Boolean)
      .join(" · ")
  }
  const category = computed.categories[0]?.[0] ?? null
  // El color que más lleva de lo que más compra.
  const colors = new Map<string, number>()
  for (const p of recent)
    for (const item of p.items)
      if (item.category === category && item.color)
        colors.set(item.color, (colors.get(item.color) ?? 0) + 1)
  const color = [...colors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const measure = input.measure?.trim() || computed.measures[0]?.[0] || null
  const buys = category
    ? `compra ${category.toLowerCase()}${color ? ` ${color.toLowerCase()}` : ""}${
        measure ? ` en ${input.measureLabel.toLowerCase()} ${measure}` : ""
      }`
    : measure
      ? `compra en ${input.measureLabel.toLowerCase()} ${measure}`
      : null
  return [
    buys,
    district,
    computed.priceSensitivity ? SENSITIVITY_TEXT[computed.priceSensitivity] : null,
  ]
    .filter(Boolean)
    .join(" · ")
}
