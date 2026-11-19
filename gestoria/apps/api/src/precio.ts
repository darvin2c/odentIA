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
  /** El porcentaje de la promoción vigente hoy, si hay. */
  percentOff: number | null
  /** El precio por cantidad del producto: desde N unidades, cada una a X. */
  quantityPrices: { minQuantity: number; unitPriceCents: number }[]
}

/** El mejor precio sin negociar: la lista, la promoción o el precio por cantidad, sin sumarlos. */
export function autoUnitCents(variant: PricedVariant, productQuantity: number): number {
  const options = [variant.listUnitCents]
  if (variant.percentOff)
    options.push(Math.round((variant.listUnitCents * (100 - variant.percentOff)) / 100))
  const tier = variant.quantityPrices
    .filter((q) => q.minQuantity <= productQuantity)
    .sort((a, b) => b.minQuantity - a.minQuantity)[0]
  if (tier) options.push(tier.unitPriceCents)
  return Math.min(...options)
}

/** Lo más bajo a lo que se vende: el mínimo si queda bajo el precio sin negociar; si no, ese precio. */
export function floorUnitCents(auto: number, minPriceCents: number | null): number {
  return minPriceCents !== null && minPriceCents < auto ? minPriceCents : auto
}

export interface QuoteLine {
  quantity: number
  listUnitCents: number
  autoUnitCents: number
  floorUnitCents: number
  /** El acordado; null: el precio sin negociar. Se ignora en un regalo. */
  unitCents: number | null
  gift: boolean
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
    return { ...line, unitCents: unit }
  })
  const sold = priced.filter((line) => !line.gift)
  if (sold.length === 0) fields.lines = "Un pedido no puede ser solo de regalo"
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
