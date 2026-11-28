import type { SaleState } from "./ficha"
import type { OrderState } from "./pedidos"

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
  promotion: { name: string; percentOff: number; endsOn: string } | null
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
    quantityPrices: { minQuantity: number; unitPriceCents: number }[]
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

/** El día de una fecha ISO como se dice («el 7»). */
const dayOf = (iso: string) => Number(iso.split("-")[2] ?? 0)

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
  const promoted = product.variants.find(
    (v) =>
      v.promotion && (choice.color === null || v.color === null || same(v.color, choice.color)),
  )
  if (promoted?.promotion) {
    const { name, percentOff, endsOn } = promoted.promotion
    return { text: `${name}: ${percentOff} % menos hasta el ${dayOf(endsOn)}.`, action: null }
  }
  const fact = product.facts[0]
  if (fact) return { text: `${fact.label}: ${fact.value.toLowerCase()}.`, action: null }
  return { text: `Pregúntame lo que quieras de ${product.name.toLowerCase()}.`, action: null }
}

/** Lo que cuesta llegar con una forma de entrega, antes de saber la zona: el menor. */
export function deliveryFrom(d: ShowcaseDelivery): number | null {
  if (d.cost === "gratis") return 0
  if (d.cost === "fijo") return d.priceCents ?? 0
  if (d.cost === "por_zona" && d.zones.length) return Math.min(...d.zones.map((z) => z.priceCents))
  return null
}

/** Las cuentas del carrito de la vitrina, antes de que haya pedido (el servidor cobra lo suyo). */
export function localTotals(page: Showcase, lines: CartLine[], delivery: ShowcaseDelivery | null) {
  const priced = lines.flatMap((line) => {
    const variant = page.product.variants.find((v) => v.id === line.variantId)
    return variant ? [{ line, variant, cents: variant.priceCents * line.quantity }] : []
  })
  const subtotal = priced.reduce((n, p) => n + p.cents, 0)
  const base = delivery ? deliveryFrom(delivery) : null
  const free = delivery?.freeFromCents != null && subtotal >= delivery.freeFromCents
  const shipping = free ? 0 : (base ?? 0)
  return {
    priced,
    subtotal,
    shipping,
    /** El envío se acuerda en el chat: no se suma. */
    shippingKnown: base !== null,
    free,
    total: subtotal + shipping,
    missingForFree:
      delivery?.freeFromCents != null && subtotal < delivery.freeFromCents
        ? delivery.freeFromCents - subtotal
        : null,
    count: lines.reduce((n, l) => n + l.quantity, 0),
  }
}

/** Lo que falta para que venza lo acordado, como un reloj («23:59:55»). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":")
}
