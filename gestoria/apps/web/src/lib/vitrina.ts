import type { SaleState } from "./ficha"
import type { OrderState } from "./pedidos"

/** El tipo de un medio de pago de la tienda (`PAYMENT_KINDS` de la base). */
export type PaymentKind = "yape" | "plin" | "transferencia" | "efectivo" | "pos" | "link" | "otro"

/**
 * La página de un producto en la vitrina (`apps/api/src/vitrina.ts`): solo lo vendible, como lo
 * da el servidor (la vista previa de la ficha y la página pública dan lo mismo). La pantalla
 * elige la foto del color, la talla y lo que diría Sofi junto a la foto: nada se calcula aquí
 * que no esté en la ficha.
 */

export interface ShowcaseVariant {
  id: string
  color: string | null
  size: string | null
  priceCents: number
  listCents: number
  available: boolean
  left: number | null
  /** La promoción de esta variante; `until` es su último día en palabras («8 de diciembre»). */
  promotion: { name: string; percentOff: number; endsOn: string; until: string } | null
  /** El precio por cantidad de esta variante (lo calcula el servidor con la regla del pedido). */
  tiers: { minQuantity: number; unitCents: number }[]
}

export interface ShowcasePhoto {
  id: string
  color: string | null
  width: number | null
  height: number | null
  miniatura: string
  vitrina: string
}

export interface ShowcaseVideo {
  id: string
  color: string | null
  label: string
  durationMs: number
  video: string
  poster: string
}

export interface ShowcaseDelivery {
  id: string
  name: string
  eta: string
  cost: "gratis" | "fijo" | "por_zona" | "se_acuerda"
  priceCents: number | null
  zones: { name: string; priceCents: number }[]
  freeFromCents: number | null
}

export interface Showcase {
  store: {
    name: string
    color: string | null
    currency: string
    link: string | null
    deliveries: ShowcaseDelivery[]
    payments: string[]
    /** Con qué se paga ya al tocar «Pagar ahora», en el orden de la tienda. */
    payNow: { id: string; name: string; kind: PaymentKind }[]
  }
  product: {
    id: string
    name: string
    category: string | null
    description: string
    slug: string | null
    visible: boolean
    state: SaleState
    stateText: string | null
    rowLabel: string
    columnLabel: string | null
    colors: { value: string; hex: string | null; hex2: string | null }[]
    sizes: string[]
    variants: ShowcaseVariant[]
    answers: { question: string; answer: string }[]
    facts: { label: string; value: string }[]
    combina: {
      id: string
      name: string
      slug: string | null
      priceCents: number
      photo: string | null
    }[]
  }
  media: { photos: ShowcasePhoto[]; videos: ShowcaseVideo[]; expiresAt: string | null }
}

/** Lo que se elige en la página: el color y la talla (null: todavía no la eligió). */
export interface Choice {
  color: string | null
  size: string | null
}

/** Una línea del carrito de la vitrina, antes de que haya pedido. */
export interface CartLine {
  variantId: string
  quantity: number
}

/**
 * Lo que cuesta el carrito de la vitrina antes de pagar, como lo cotiza el servidor
 * (`POST /api/tiendas/:id/vitrina/carrito/calcular`, la misma cuenta de «Pagar ahora»). Sin zona
 * elegida, el envío y el total son null: la pantalla no los adivina.
 */
export interface CartQuote {
  lines: { variantId: string; quantity: number; unitCents: number; listUnitCents: number }[]
  subtotalCents: number
  deliveryCents: number | null
  totalCents: number | null
  freeFromCents: number | null
}

/** El carrito de la prueba en el servidor: el pedido de la conversación (Sofi o la vitrina). */
export interface TestCart {
  id: string
  number: string
  state: OrderState
  bySofi: boolean
  paid: boolean
  lines: {
    productId: string
    variantId: string
    productName: string
    variantName: string
    quantity: number
    unitCents: number
    autoUnitCents: number
    gift: boolean
    photoId: string | null
  }[]
  subtotalCents: number
  discountCents: number
  deliveryName: string
  deliveryCents: number
  deliveryListCents: number
  totalCents: number
  deal: {
    expiresAt: string
    expired: boolean
    until: string
    freeDelivery: boolean
    discountCents: number
  } | null
  paymentName: string
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? "").localeCompare(b ?? "", "es", { sensitivity: "base" }) === 0

/** El color que se muestra al abrir: el primero que tiene algo para vender. */
export function firstChoice(page: Showcase): Choice {
  const color =
    page.product.colors.find((c) =>
      page.product.variants.some((v) => same(v.color, c.value) && v.available),
    )?.value ??
    page.product.colors[0]?.value ??
    null
  return { color, size: null }
}

/** La variante elegida: el color y la talla (sin talla, si el producto no la tiene). */
export function variantOf(page: Showcase, choice: Choice): ShowcaseVariant | null {
  const needsSize = page.product.sizes.length > 1
  if (needsSize && !choice.size) return null
  return (
    page.product.variants.find(
      (v) =>
        (choice.color === null || v.color === null || same(v.color, choice.color)) &&
        (!needsSize || same(v.size, choice.size)),
    ) ?? null
  )
}

/** El precio que se muestra: el de la variante elegida o, sin talla, el de su color. */
export function shownPrice(page: Showcase, choice: Choice) {
  const exact = variantOf(page, choice)
  if (exact) return exact
  const ofColor = page.product.variants.filter(
    (v) => choice.color === null || v.color === null || same(v.color, choice.color),
  )
  // Sin talla elegida: el precio de siempre, no el de una promoción de una sola talla.
  return ofColor.find((v) => !v.promotion) ?? ofColor[0] ?? page.product.variants[0] ?? null
}

/** Las fotos y el video, con los del color elegido primero (así entra su foto al cambiarlo). */
export function mediaFor(page: Showcase, color: string | null) {
  const mine = <T extends { color: string | null }>(items: T[]) => [
    ...items.filter((m) => color !== null && same(m.color, color)),
    ...items.filter((m) => color === null || !same(m.color, color)),
  ]
  return { photos: mine(page.media.photos), videos: mine(page.media.videos) }
}

/** El fondo de una muestra de color: uno, o dos en diagonal si es bicolor. */
export function swatch(hex: string | null, hex2: string | null): string {
  const one = hex ?? "#d4d4d4"
  return hex2 ? `linear-gradient(135deg, ${one} 50%, ${hex2} 50%)` : one
}

/** El fondo de la foto, teñido apenas con el color elegido (el blanco queda blanco). */
export function tint(hex: string | null): string | undefined {
  if (!hex) return undefined
  const pct = hex.toLowerCase() === "#ffffff" ? 0 : 18
  return `color-mix(in oklab, ${hex} ${pct}%, white)`
}

/** Las iniciales de la tienda para su logo («CR»). */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

/** Las variantes del color elegido (todas, si no hay color). */
const ofColor = (page: Showcase, color: string | null) =>
  page.product.variants.filter((v) => color === null || v.color === null || same(v.color, color))

/**
 * La promoción que vale para lo elegido: la de la variante, si ya eligió la talla; sin talla, solo
 * si todo el color la tiene. `sizes` dice en qué tallas vale cuando no es de todo el color (para
 * decirlo sin prometerla en las demás); la insignia sobre la foto va solo si vale para todo.
 */
export function promotionFor(
  page: Showcase,
  choice: Choice,
): { promotion: NonNullable<ShowcaseVariant["promotion"]>; sizes: string[] | null } | null {
  const exact = variantOf(page, choice)
  if (exact) return exact.promotion ? { promotion: exact.promotion, sizes: null } : null
  const mine = ofColor(page, choice.color)
  const promoted = mine.filter((v) => v.promotion)
  const first = promoted[0]?.promotion
  if (!first) return null
  const all =
    promoted.length === mine.length && promoted.every((v) => v.promotion?.name === first.name)
  if (all) return { promotion: first, sizes: null }
  const sizes = promoted
    .filter((v) => v.promotion?.name === first.name && v.size)
    .map((v) => v.size as string)
  return { promotion: first, sizes: [...new Set(sizes)] }
}

/** «2 o más: S/ 110 cada uno»: el primer escalón de la variante elegida (o del precio que se ve). */
export function tierFor(page: Showcase, choice: Choice) {
  return shownPrice(page, choice)?.tiers[0] ?? null
}

/**
 * Lo que dice Sofi junto a la foto, en la vitrina: lo que hay en su talla, la promoción o un dato
 * de la ficha. Sale solo de la ficha: si no hay qué decir, invita a preguntarle.
 */
export function bubble(
  page: Showcase,
  choice: Choice,
): { text: string; action: { label: string; color: string } | null } {
  const { product } = page
  if (choice.size) {
    const here = variantOf(page, choice)
    if (here && !here.available) {
      const other = product.variants.find(
        (v) => same(v.size, choice.size) && v.available && !same(v.color, choice.color),
      )
      if (other?.color)
        return {
          text: `En ${other.color} sí hay ${choice.size}.`,
          action: { label: `Ver en ${other.color}`, color: other.color },
        }
      return {
        text: `Se agotó la ${choice.size}. Pregúntame y te aviso cuando vuelva.`,
        action: null,
      }
    }
    if (here?.left)
      return {
        text: `${here.left === 1 ? "Queda 1" : `Quedan ${here.left}`} en tu ${choice.size}${choice.color && product.colors.length > 1 ? ` en ${choice.color}` : ""}.`,
        action: null,
      }
  }
  if (product.stateText) return { text: `${product.stateText}.`, action: null }
  const promo = promotionFor(page, choice)
  if (promo) {
    const { name, percentOff, until } = promo.promotion
    const where = promo.sizes?.length
      ? ` en ${promo.sizes.length === 1 ? "la" : "las"} ${listOf(promo.sizes)}`
      : ""
    return { text: `${name}: ${percentOff} % menos${where} hasta el ${until}.`, action: null }
  }
  const fact = product.facts[0]
  if (fact) return { text: `${fact.label}: ${fact.value.toLowerCase()}.`, action: null }
  return { text: `Pregúntame lo que quieras de ${product.name.toLowerCase()}.`, action: null }
}

/** «35, 36 y 37». */
const listOf = (items: string[]) =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`

/** Lo que cuesta llegar con una forma de entrega, antes de saber la zona: el menor. */
export function deliveryFrom(d: ShowcaseDelivery): number | null {
  if (d.cost === "gratis") return 0
  if (d.cost === "fijo") return d.priceCents ?? 0
  if (d.cost === "por_zona" && d.zones.length) return Math.min(...d.zones.map((z) => z.priceCents))
  return null
}

/** Lo que falta para que venza lo acordado, como un reloj («23:59:55»). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":")
}
