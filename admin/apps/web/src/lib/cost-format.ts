/** Cómo se dicen los importes y los costos en la administración (ADR 0085). */
const LOCALE = "es-PE"

/** Lo cobrado, en centavos: «USD 46,70». */
export const money = (cents: number, currency = "USD") =>
  new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(cents / 100)

/** Un precio en millonésimas, con los decimales que tenga: «USD 0,50», «USD 0,085». */
export const priceOf = (micros: number, currency = "USD") =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(micros / 1_000_000)

/** Lo que nos cuesta, con los centavos que hacen falta: «USD 0,0031». */
export const cost = (micros: number, currency = "USD") =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000)

/** Lo mismo sin la moneda, para las columnas: «0,0031». */
export const costNumber = (micros: number) =>
  new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000)

export const priceNumber = (micros: number) =>
  new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(
    micros / 1_000_000,
  )

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
