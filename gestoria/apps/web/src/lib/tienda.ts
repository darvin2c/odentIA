/**
 * Lo que la pantalla sabe de la configuración de una tienda (paso B3): sus tipos, como los dice
 * el servidor, y sus nombres para la persona. Qué vale y qué no lo decide el servidor.
 */

export type PaymentTypeCode = "68" | "30" | "48" | "10" | "1"
export type PaymentCollection = "link" | "comprobante" | "al_recibir"

export interface PaymentMethod {
  id: string
  name: string
  typeCode: PaymentTypeCode
  collection: PaymentCollection
  details: string
  isActive: boolean
}

export type DeliveryType =
  | "DeliveryModeOwnFleet"
  | "OnSitePickup"
  | "ParcelService"
  | "DeliveryModeMail"
  | "LockerDelivery"
export type DeliveryCost = "gratis" | "fijo" | "por_zona" | "se_acuerda"

export interface DeliveryZone {
  name: string
  priceCents: number
}

export interface DeliveryMethod {
  id: string
  name: string
  type: DeliveryType
  details: string
  cost: DeliveryCost
  priceCents: number | null
  zones: DeliveryZone[]
  eta: string
  acceptsPayOnDelivery: boolean
  maxDiscountCents: number | null
  freeFromCents: number | null
  isActive: boolean
}

/** Los tipos de UN/CEFACT 4461, con su nombre. */
export const PAYMENT_TYPES: Record<PaymentTypeCode, string> = {
  "68": "Billetera o pago en línea",
  "30": "Transferencia",
  "48": "Tarjeta",
  "10": "Efectivo",
  "1": "Otro",
}

/** Cómo se confirma el pago, en el orden en que cobra Sofi. */
export const COLLECTIONS: Record<PaymentCollection, { name: string; hint: string }> = {
  link: {
    name: "Link de pago",
    hint: "Paga en línea y se confirma solo. La cuenta del proveedor se conecta en «Link de pago».",
  },
  comprobante: {
    name: "Pide comprobante",
    hint: "Sofi pide la captura y alguien del equipo confirma el pago.",
  },
  al_recibir: {
    name: "Se cobra al entregar",
    hint: "Solo con las formas de entrega que aceptan pago al recibir.",
  },
}

/** La lista `DeliveryMethod` de Schema.org, con su nombre. */
export const DELIVERY_TYPES: Record<DeliveryType, string> = {
  DeliveryModeOwnFleet: "Reparto propio",
  OnSitePickup: "Recojo en tienda",
  ParcelService: "Por agencia o courier",
  DeliveryModeMail: "Por correo",
  LockerDelivery: "Casillero o punto de recojo",
}

export const DELIVERY_COSTS: Record<DeliveryCost, string> = {
  gratis: "Gratis",
  fijo: "Precio fijo",
  por_zona: "Por zona",
  se_acuerda: "Se acuerda en el chat",
}

export interface ProductOption {
  name: string
  values: string[]
}

export interface CatalogItem {
  id: string
  name: string
  category: string | null
  listPriceCents: number
  minPriceCents: number | null
  options: ProductOption[]
  variantCount: number
  stock: number
  fromCents: number
  toCents: number
  photoId: string | null
}

export interface Variant {
  id: string
  optionValues: string[]
  sku: string
  priceCents: number | null
  photoId: string | null
  stock: number
}

export type CostWarning =
  | { kind: "perdida"; costCents: number; lossCents: number }
  | { kind: "cerca"; costCents: number; marginCents: number }

export interface QuantityPrice {
  minQuantity: number
  unitPriceCents: number
}

export interface Promotion {
  name: string
  percentOff: number
  startsOn: string
  endsOn: string
}

export type Relation = "parecido" | "combina"

export interface ProductDetail {
  id: string
  name: string
  category: string | null
  description: string
  listPriceCents: number
  minPriceCents: number | null
  options: ProductOption[]
  variants: Variant[]
  photos: { id: string; position: number }[]
  quantityPrices: QuantityPrice[]
  promotions: Promotion[]
  links: { productId: string; kind: Relation; name: string }[]
  fromCents: number
  toCents: number
  lastCostCents: number | null
  costWarning: CostWarning | null
}

export interface Movement {
  id: string
  kind: "entrada" | "venta" | "anulacion" | "ajuste"
  quantity: number
  balance: number
  unitCostCents: number | null
  reason: string | null
  reference: string | null
  createdAt: string
  actorName: string | null
}

export const MOVEMENT_NAMES: Record<Movement["kind"], string> = {
  entrada: "Entrada",
  venta: "Venta",
  anulacion: "Venta anulada",
  ajuste: "Ajuste",
}

/** Los formatos de cada moneda se arman una vez: una lista larga los pide fila a fila. */
const digitsOf = new Map<string, number>()
const formats = new Map<string, Intl.NumberFormat>()

/** Cuántos decimales tiene la moneda (ISO 4217): dos en PEN, cero en CLP. */
export function fractionDigits(currency: string): number {
  let digits = digitsOf.get(currency)
  if (digits === undefined) {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    digitsOf.set(currency, digits)
  }
  return digits
}

/** «S/ 129» o «S/ 129.90»: sin decimales cuando no los tiene. */
export function money(cents: number, currency: string): string {
  const digits = fractionDigits(currency)
  const shown = cents % 10 ** digits === 0 ? 0 : digits
  const key = `${currency}:${shown}`
  let format = formats.get(key)
  if (!format) {
    format = new Intl.NumberFormat("es-PE", {
      style: "currency",
      currency,
      minimumFractionDigits: shown,
      maximumFractionDigits: shown,
    })
    formats.set(key, format)
  }
  return format.format(cents / 10 ** digits)
}

/** El precio como lo dirá Sofi: el exacto, o «desde» si las variantes cuestan distinto. */
export function priceRange(from: number, to: number, currency: string): string {
  return from === to ? money(from, currency) : `Desde ${money(from, currency)}`
}

/** Lo que escribe la persona en un campo de monto («129», «129,90»); null si no se lee. */
export function readMoney(text: string, currency: string): number | null {
  const match = /^(\d{1,9})(?:[.,](\d+))?$/.exec(text.trim().replace(/\s+/g, ""))
  const digits = fractionDigits(currency)
  if (!match || (match[2] ?? "").length > digits) return null
  return Number(match[1]) * 10 ** digits + Number((match[2] ?? "").padEnd(digits, "0") || "0")
}

/** Un monto guardado, para ponerlo en un campo. */
export function moneyInput(cents: number | null, currency: string): string {
  if (cents === null) return ""
  const digits = fractionDigits(currency)
  const value = cents / 10 ** digits
  return cents % 10 ** digits === 0 ? String(value) : value.toFixed(digits)
}

/** El símbolo de la moneda, para poner junto al campo. */
export function currencySymbol(currency: string): string {
  return (
    new Intl.NumberFormat("es-PE", { style: "currency", currency })
      .formatToParts(0)
      .find((part) => part.type === "currency")?.value ?? currency
  )
}

/** «35 a 42» si son números seguidos; si no, separados por comas. */
export function valuesSummary(values: string[]): string {
  // Solo números de hasta tres cifras y sin ceros delante, los que «35 a 42» vuelve a armar igual.
  const numbers = values.map((v) => (/^(0|[1-9]\d{0,2})$/.test(v) ? Number(v) : Number.NaN))
  const consecutive =
    values.length > 2 &&
    numbers.every((n, i) => Number.isInteger(n) && (i === 0 || n === numbers[i - 1]! + 1))
  return consecutive ? `${values[0]} a ${values.at(-1)}` : values.join(", ")
}

/** «Color: blanca, negra · Talla: 35 a 42». */
export function optionsSummary(options: ProductOption[]): string {
  return options.map((option) => `${option.name}: ${valuesSummary(option.values)}`).join(" · ")
}

export function variantName(variant: { optionValues: string[] }): string {
  return variant.optionValues.join(" · ") || "Única"
}

/** Los países de ISO 3166-1 alfa-2 (el entorno no los lista, como sí las monedas). */
const COUNTRY_CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " ",
  )

/** Los países con su nombre en español, de la A a la Z. */
export function countryOptions(): { code: string; label: string }[] {
  const names = new Intl.DisplayNames(["es"], { type: "region" })
  return COUNTRY_CODES.map((code) => ({ code, label: names.of(code) ?? code })).sort((a, b) =>
    a.label.localeCompare(b.label, "es"),
  )
}

/** El país del navegador («es-PE» → PE), si es uno de la lista; si no, ninguno. */
export function browserCountry(): string {
  const region = /^[a-z]{2,3}-([A-Z]{2})\b/.exec(navigator.language)?.[1] ?? ""
  return COUNTRY_CODES.includes(region) ? region : ""
}
