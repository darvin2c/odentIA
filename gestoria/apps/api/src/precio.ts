import { formatMoney } from "./dinero.js"

/**
 * El precio de un pedido (lienzo B, tablero 14), sin base ni red: lo usan «Anotar un pedido» y,
 * con B5, Sofi. Es la única regla del precio; la pantalla solo la muestra.
 *
 * - Cada línea tiene su precio de lista, el mejor sin negociar (la promoción o el precio por
 *   cantidad, el que sea mejor para el cliente: nunca se suman) y su mínimo. Sin precio mínimo
 *   el producto no se negocia: su mínimo es el precio sin negociar.
 * - Lo que se cede sale de un solo margen, el que hay entre el precio sin negociar y el mínimo de
 *   cada línea: el descuento, el envío que pone la tienda y lo que vale un regalo (a su mínimo).
 *   Así lo que entra por cada producto nunca queda bajo su mínimo.
 * - El envío se rebaja hasta lo que permite su forma de entrega. Si la compra llega al monto de
 *   «gratis desde», es gratis por regla de la tienda y no gasta margen.
 */

export interface PricedVariant {
  /** El precio de la variante (o el del producto, si no tiene propio). */
  listUnitCents: number
  minPriceCents: number | null
  /** El porcentaje de la mejor promoción vigente hoy para esta variante (de todo el producto, de su color o de su talla). */
  percentOff: number | null
  /** El precio por cantidad del producto: desde N unidades, cada una a X. */
  quantityPrices: { minQuantity: number; unitPriceCents: number }[]
  /** El precio para revendedoras: desde N unidades del producto, cada una a X. */
  wholesale?: { minQuantity: number; unitPriceCents: number } | null
  /** El combo: cuánto menos cuesta si va junto con lo que combina (lo pone el pedido que lo lleva). */
  comboPercentOff?: number | null
  /** En liquidación: su precio es el final, no se negocia (decisión 8). */
  clearance?: boolean
}

/** De dónde sale el precio sin negociar. */
export type AutoReason = "lista" | "promocion" | "cantidad" | "mayor" | "combo"

/**
 * El mejor precio sin negociar y de dónde sale: la lista, la promoción, el precio por cantidad, el
 * de revendedora o el del combo, el que sea mejor para el cliente, sin sumarlos.
 */
export function autoUnit(
  variant: PricedVariant,
  productQuantity: number,
): { cents: number; reason: AutoReason } {
  const off = (percent: number) => Math.round((variant.listUnitCents * (100 - percent)) / 100)
  const options: { cents: number; reason: AutoReason }[] = [
    { cents: variant.listUnitCents, reason: "lista" },
  ]
  if (variant.percentOff) options.push({ cents: off(variant.percentOff), reason: "promocion" })
  const tier = variant.quantityPrices
    .filter((q) => q.minQuantity <= productQuantity)
    .sort((a, b) => b.minQuantity - a.minQuantity)[0]
  if (tier) options.push({ cents: tier.unitPriceCents, reason: "cantidad" })
  if (variant.wholesale && productQuantity >= variant.wholesale.minQuantity)
    options.push({ cents: variant.wholesale.unitPriceCents, reason: "mayor" })
  if (variant.comboPercentOff)
    options.push({ cents: off(variant.comboPercentOff), reason: "combo" })
  // Con el mismo precio, el primero: así «lista» gana cuando nada baja.
  return options.reduce((best, o) => (o.cents < best.cents ? o : best))
}

/** El mejor precio sin negociar (`autoUnit`), solo el importe. */
export function autoUnitCents(variant: PricedVariant, productQuantity: number): number {
  return autoUnit(variant, productQuantity).cents
}

/** Lo más bajo a lo que se vende: el mínimo si queda bajo el precio sin negociar; si no, ese precio. */
export function floorUnitCents(auto: number, minPriceCents: number | null): number {
  return minPriceCents !== null && minPriceCents < auto ? minPriceCents : auto
}

/** Lo más bajo a lo que se vende una variante: en liquidación, su precio sin negociar. */
export function floorOf(variant: PricedVariant, auto: number): number {
  return floorUnitCents(auto, variant.clearance ? null : variant.minPriceCents)
}

/**
 * Lo que Sofi puede ofrecer de un producto (tablero 21 del lienzo «gestorIA como odentIA»): poner
 * el envío, unos soles menos, el precio de la 2.ª unidad (una rebaja cuando lleva dos o más) y un
 * regalo. Siempre del mismo margen y una sola vez (ADR 0224). El equipo negocia como siempre.
 */
export interface SofiOffers {
  delivery: boolean
  discount: boolean
  secondUnit: boolean
  gift: boolean
}

export interface QuoteLine {
  quantity: number
  listUnitCents: number
  autoUnitCents: number
  floorUnitCents: number
  /** El acordado; null: el precio sin negociar. Se ignora en un regalo. */
  unitCents: number | null
  gift: boolean
  /** Lo que Sofi puede ofrecer de su producto; sin él, todo (como antes). */
  offers?: SofiOffers
}

/**
 * Lo más bajo que Sofi puede dejar cada unidad de una línea: el mínimo con «unos soles»; con solo
 * la 2.ª unidad, la rebaja de una unidad hasta su mínimo por cada dos, repartida en la línea; sin
 * ninguna, el precio sin negociar.
 */
export function agentFloorUnit(line: Omit<QuoteLine, "unitCents" | "gift">): number {
  if (!line.offers || line.offers.discount) return line.floorUnitCents
  if (!line.offers.secondUnit || line.quantity < 2) return line.autoUnitCents
  const pairs = Math.floor(line.quantity / 2)
  const off = Math.floor(((line.autoUnitCents - line.floorUnitCents) * pairs) / line.quantity)
  return line.autoUnitCents - off
}

export interface QuoteDelivery {
  listCents: number
  /** Lo más que se rebaja el envío; null: no se rebaja. */
  maxDiscountCents: number | null
  /** Gratis desde este monto de compra. */
  freeFromCents: number | null
  /** Lo que paga el cliente; null: lo que corresponde. */
  chargedCents: number | null
}

export interface Quote {
  lines: (QuoteLine & { unitCents: number })[]
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
  /** Se cedió algo: el precio vale 24 horas. */
  negotiated: boolean
}

/** Cuánto vale un precio negociado (tablero 14). */
export const NEGOTIATED_PRICE_MS = 24 * 3_600_000

/**
 * Hasta cuándo vale un precio negociado: 24 horas, o antes si ya se le prometió otra hora (la de
 * la oferta de Sofi). Null si esa hora ya pasó: el trato venció y no se renueva solo.
 */
export function negotiatedUntil(now: Date, promised?: Date | null): Date | null {
  const limit = now.getTime() + NEGOTIATED_PRICE_MS
  if (!promised) return new Date(limit)
  if (promised.getTime() <= now.getTime()) return null
  return new Date(Math.min(limit, promised.getTime()))
}

/** Lo más que suma un pedido (la base guarda enteros de 32 bits): diez millones en soles. */
export const MAX_ORDER_CENTS = 1_000_000_000

/**
 * Arma el precio de un pedido o dice qué no se puede, campo por campo (`lines.0.unitCents`,
 * `deliveryCents`), con el monto en palabras de la persona.
 */
export function quote(
  lines: QuoteLine[],
  delivery: QuoteDelivery,
  currency: string,
  /** Lo cotiza Sofi: solo cede lo que cada producto deja ofrecer (`SofiOffers`). */
  options: { byAgent?: boolean } = {},
): { ok: true; quote: Quote } | { ok: false; fields: Record<string, string> } {
  const money = (cents: number) => formatMoney(cents, currency)
  const fields: Record<string, string> = {}
  const priced = lines.map((line, i) => {
    if (line.gift) return { ...line, unitCents: 0 }
    const unit = line.unitCents ?? line.autoUnitCents
    if (unit > line.autoUnitCents)
      fields[`lines.${i}.unitCents`] = `Su precio es ${money(line.autoUnitCents)}`
    else if (unit < line.floorUnitCents)
      fields[`lines.${i}.unitCents`] =
        line.floorUnitCents === line.autoUnitCents
          ? `No se negocia: va a ${money(line.autoUnitCents)}`
          : `No puede bajar de ${money(line.floorUnitCents)}, el mínimo`
    else if (options.byAgent && unit < agentFloorUnit(line)) {
      const agentFloor = agentFloorUnit(line)
      fields[`lines.${i}.unitCents`] =
        agentFloor === line.autoUnitCents
          ? `De este producto no se ofrece rebaja: va a ${money(line.autoUnitCents)}`
          : `Con la 2.ª unidad baja hasta ${money(agentFloor)} cada una`
    }
    return { ...line, unitCents: unit }
  })
  const sold = priced.filter((line) => !line.gift)
  if (sold.length === 0) fields.lines = "Un pedido no puede ser solo de regalo"
  if (
    options.byAgent &&
    priced.some((line) => line.gift) &&
    !sold.some((l) => !l.offers || l.offers.gift)
  )
    fields.lines = "Con estos productos no se ofrece un regalo"
  const sum = (list: typeof priced, of: (line: (typeof priced)[number]) => number) =>
    list.reduce((total, line) => total + of(line) * line.quantity, 0)
  const subtotalCents = sum(sold, (l) => l.unitCents)
  const itemsAutoCents = sum(sold, (l) => l.autoUnitCents)
  const discountCents = itemsAutoCents - subtotalCents
  const giftCents = sum(
    priced.filter((line) => line.gift),
    (l) => l.floorUnitCents,
  )
  const marginCents = sum(sold, (l) => l.autoUnitCents - l.floorUnitCents)

  const free =
    delivery.listCents > 0 &&
    delivery.freeFromCents !== null &&
    subtotalCents >= delivery.freeFromCents
  const deliveryCents = delivery.chargedCents ?? (free ? 0 : delivery.listCents)
  const absorbed = delivery.listCents - deliveryCents
  if (deliveryCents < 0 || absorbed < 0)
    fields.deliveryCents = `El envío cuesta ${money(delivery.listCents)}`
  else if (!free && absorbed > 0 && absorbed > (delivery.maxDiscountCents ?? 0))
    fields.deliveryCents = delivery.maxDiscountCents
      ? `Este envío se rebaja hasta ${money(delivery.maxDiscountCents)}`
      : "Este envío no se rebaja"
  else if (
    options.byAgent &&
    !free &&
    absorbed > 0 &&
    !sold.some((line) => !line.offers || line.offers.delivery)
  )
    fields.deliveryCents = "Con estos productos no se ofrece el envío"
  const fromMargin = free ? 0 : Math.max(0, absorbed)
  const marginUsedCents = discountCents + fromMargin + giftCents
  if (Object.keys(fields).length === 0 && marginUsedCents > marginCents) {
    const message =
      marginCents === discountCents
        ? "No queda margen para ceder más: los precios ya están en su mínimo"
        : `Lo que cedes (${money(marginUsedCents)}) pasa el margen hasta los mínimos (${money(marginCents)})`
    if (fromMargin > 0) fields.deliveryCents = message
    else fields.lines = message
  }
  if (subtotalCents + deliveryCents > MAX_ORDER_CENTS)
    fields.lines = "El pedido es demasiado grande: divídelo en dos"
  if (Object.keys(fields).length > 0) return { ok: false, fields }
  return {
    ok: true,
    quote: {
      lines: priced,
      itemsAutoCents,
      subtotalCents,
      discountCents,
      giftCents,
      deliveryListCents: delivery.listCents,
      deliveryCents,
      // Gratis por la regla de la tienda solo si de verdad no paga envío.
      deliveryFreeByPolicy: free && deliveryCents === 0,
      marginCents,
      marginUsedCents,
      totalCents: subtotalCents + deliveryCents,
      negotiated: marginUsedCents > 0,
    },
  }
}

/**
 * Lo menos que cobraría Sofi por una línea con su envío («Probar cuánto cobraría Sofi», tablero 15
 * del lienzo «La ficha del producto»): la misma cotización de los pedidos, con todo lo que Sofi
 * puede ceder. Primero baja el precio hasta el mínimo, si el producto deja rebajarlo; con lo que
 * queda del margen pone el envío, hasta lo que su forma de entrega deja rebajar. Como el margen es
 * uno solo, ceder el envío no baja el total más allá del mínimo: solo cambia qué se cede.
 */
export function lowestQuote(
  line: Omit<QuoteLine, "unitCents" | "gift">,
  delivery: Omit<QuoteDelivery, "chargedCents">,
  currency: string,
) {
  const sell = { ...line, gift: false }
  const mayDeliver = !line.offers || line.offers.delivery
  // Con el precio más bajo que puede dejar, o sin rebajarlo (así no pierde el envío gratis desde un
  // monto): va la cotización que sale menos.
  const tries = [...new Set([agentFloorUnit(line), line.autoUnitCents])].map((unitCents) => {
    const left = (unitCents - line.floorUnitCents) * line.quantity
    const free =
      delivery.listCents > 0 &&
      delivery.freeFromCents !== null &&
      unitCents * line.quantity >= delivery.freeFromCents
    const absorbed =
      free || !mayDeliver ? 0 : Math.min(delivery.maxDiscountCents ?? 0, left, delivery.listCents)
    return quote(
      [{ ...sell, unitCents }],
      { ...delivery, chargedCents: free ? null : delivery.listCents - absorbed },
      currency,
      { byAgent: true },
    )
  })
  const ok = tries.filter((t) => t.ok)
  if (ok.length === 0) return tries[0]!
  return ok.reduce((best, t) => (t.quote.totalCents < best.quote.totalCents ? t : best))
}
