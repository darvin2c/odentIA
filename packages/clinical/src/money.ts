/** Importes enteros en la unidad menor ISO 4217; formato y entrada según la clínica. */
const CURRENCY_NAMES = new Intl.DisplayNames("en", { type: "currency", fallback: "none" })

/** Los decimales de cada moneda ya vista: solo guarda códigos válidos. */
const FRACTION_DIGITS = new Map<string, number>()

function assertCurrency(currency: string): string {
  if (FRACTION_DIGITS.has(currency)) return currency
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code) || !CURRENCY_NAMES.of(code)) {
    throw new Error("La moneda debe ser un código ISO 4217 válido")
  }
  return code
}

/** ICU mantiene los dígitos ISO, incluidas monedas con cero, tres o cuatro decimales. */
export function currencyFractionDigits(currency: string): number {
  const code = assertCurrency(currency)
  let digits = FRACTION_DIGITS.get(code)
  if (digits === undefined) {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
      .maximumFractionDigits
    if (digits === undefined) throw new Error("No se pudo resolver la unidad menor de la moneda")
    FRACTION_DIGITS.set(code, digits)
  }
  return digits
}

const FORMATS = new Map<string, Intl.NumberFormat>()

/**
 * Crear un `Intl.NumberFormat` cuesta unas 70 veces lo que usarlo, y una lista
 * escribe decenas de importes por render: se guarda uno por idioma, moneda y decimales.
 */
function moneyFormat(locale: string, digits: number, currency?: string): Intl.NumberFormat {
  const key = `${locale}|${currency ?? ""}|${digits}`
  let format = FORMATS.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      ...(currency ? { style: "currency", currency } : {}),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
    FORMATS.set(key, format)
  }
  return format
}

function inputFormat(locale: string, digits = 0): Intl.NumberFormat {
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  const key = `latn|${locale}|${digits}`
  let format = FORMATS.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      numberingSystem: "latn",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
    FORMATS.set(key, format)
  }
  return format
}

/** `whole`: sin decimales, para lo aproximado, que con céntimos parecería exacto. */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: string,
  options: { whole?: boolean } = {},
): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("El importe debe ser un entero")
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  const code = assertCurrency(currency)
  const digits = currencyFractionDigits(code)
  return moneyFormat(locale, options.whole ? 0 : digits, code).format(amountMinor / 10 ** digits)
}

/**
 * No adivina separadores: «1.500» significa algo distinto en es-CL y es-PE.
 * Valida los grupos antes de quitarlos y separa por dígitos, sin redondeo binario.
 */
function readDecimal(
  raw: string,
  locale: string,
  words: { empty: string; invalid: string },
): { integer: string; fraction: string } {
  const parts = inputFormat(locale, 1).formatToParts(123456789.1)
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? "."
  const group = parts.find((part) => part.type === "group")?.value
  let text = raw.trim()
  if (!text) throw new Error(words.empty)
  if (group && /^\s+$/.test(group)) text = text.replace(/[\u00a0\u202f ]/g, group)
  const split = text.split(decimal)
  if (split.length > 2) throw new Error(words.invalid)
  let integer = split[0] ?? ""
  const fraction = split[1] ?? ""
  if (group && integer.includes(group)) {
    const groups = integer.split(group)
    const widths = parts.filter((part) => part.type === "integer").map((part) => part.value.length)
    const primary = widths.at(-1) ?? 0
    const secondary = widths.at(-2) ?? primary
    if (
      !groups[0] || groups[0].length > secondary ||
      groups.at(-1)?.length !== primary ||
      groups.slice(1, -1).some((value) => value.length !== secondary)
    ) throw new Error("Agrupación de miles inválida para el formato de la clínica")
    integer = groups.join("")
  }
  if (!/^\d+$/.test(integer) || !/^\d*$/.test(fraction) || (split.length === 2 && !fraction)) {
    throw new Error(words.invalid)
  }
  return { integer, fraction }
}

export function parseMoney(raw: string, currency: string, locale: string): number {
  const digits = currencyFractionDigits(currency)
  const { integer, fraction } = readDecimal(raw, locale, {
    empty: "Ingresa el importe",
    invalid: "Importe inválido",
  })
  if (fraction.length > digits) {
    throw new Error(digits === 0 ? "Esta moneda no admite decimales" : `Esta moneda admite hasta ${digits} decimales`)
  }
  const minor = BigInt(integer + fraction.padEnd(digits, "0"))
  if (minor > 2147483647n) throw new Error("Importe demasiado alto")
  return Number(minor)
}

/** Texto editable compatible con parseMoney y los separadores de la misma clínica. */
export function formatMoneyInput(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("El importe debe ser un entero mayor o igual a 0")
  }
  const digits = currencyFractionDigits(currency)
  const options = inputFormat(locale, digits).resolvedOptions()
  return new Intl.NumberFormat(locale, { ...options, useGrouping: false }).format(amountMinor / 10 ** digits)
}

/**
 * Importe aceptado de un presupuesto, por moneda: suma el total de cada línea
 * cuya respuesta es «aceptado». Es la única regla, la misma para el servidor (lo
 * guardado) y para la vista previa de la interfaz (lo que se está marcando); solo
 * salen las monedas con algo aceptado y, en una, `null` si alguna línea aceptada
 * aún no tiene precio. Entre monedas nunca se suma ni se convierte.
 */
export function sumAcceptedByCurrency(
  lines: ReadonlyArray<{
    lineTotalCents: number | null
    decision: string | null | undefined
    currency: string
  }>,
): Array<{ currency: string; totalCents: number | null }> {
  const totals = new Map<string, number | null>()
  for (const line of lines) {
    if (line.decision !== "aceptado") continue
    const sofar = totals.has(line.currency) ? (totals.get(line.currency) ?? null) : 0
    totals.set(
      line.currency,
      sofar == null || line.lineTotalCents == null ? null : sofar + line.lineTotalCents,
    )
  }
  return [...totals]
    .map(([currency, totalCents]) => ({ currency, totalCents }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * Lo mismo para quien tiene una sola moneda: `null` si alguna línea aceptada aún
 * no tiene precio y también si lo aceptado va en dos monedas, porque no hay una
 * cifra que lo diga: eso lo dice `sumAcceptedByCurrency`.
 */
export function sumAcceptedCents(
  lines: ReadonlyArray<{
    lineTotalCents: number | null
    decision: string | null | undefined
    currency?: string
  }>,
): number | null {
  const totals = sumAcceptedByCurrency(
    lines.map((line) => ({ ...line, currency: line.currency ?? "" })),
  )
  if (totals.length === 0) return 0
  return totals.length === 1 ? (totals[0]?.totalCents ?? null) : null
}

/**
 * «S/ 300.00 + USD 1,000.00»: un total por moneda, con el formato que pida cada
 * pantalla. Sin el precio de alguna, `missing`, como un total al que le falta algo.
 */
export function moneyTotalsText(
  totals: ReadonlyArray<
    { currency: string; totalCents: number | null } | { currency: string; cents: number }
  >,
  format: (cents: number, currency: string) => string,
  missing = "",
): string {
  const parts: string[] = []
  for (const total of totals) {
    const cents = "cents" in total ? total.cents : total.totalCents
    if (cents == null) return missing
    parts.push(format(cents, total.currency))
  }
  return parts.join(" + ")
}

/** Una suma por moneda, con cuántas filas lleva, en orden de moneda: entre ellas nunca se suma. */
export function sumByCurrency(
  rows: Iterable<{ currency: string; cents: number }>,
): Array<{ currency: string; cents: number; count: number }> {
  const totals = new Map<string, { currency: string; cents: number; count: number }>()
  for (const { currency, cents } of rows) {
    const total = totals.get(currency) ?? { currency, cents: 0, count: 0 }
    total.cents += cents
    total.count += 1
    totals.set(currency, total)
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}

/**
 * El mismo importe que `formatMoney`, sin el símbolo de la moneda: para las
 * cifras secundarias de una lista cuyo total ya dice la moneda.
 */
export function formatMoneyAmount(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("El importe debe ser un entero")
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  const digits = currencyFractionDigits(currency)
  return moneyFormat(locale, digits).format(amountMinor / 10 ** digits)
}

// --- Dos monedas: el cambio y la cuenta única del valor ------------------------
//
// El cambio viaja y se guarda como texto decimal («3.75»), nunca como un número
// de coma flotante. Todas las cuentas van con BigInt para coincidir con el
// `numeric` de la base: `moneyValue` es el espejo de la función SQL `money_value`.

/** Una fracción exacta: nada se redondea hasta mostrar o congelar. */
export interface MoneyFraction {
  num: bigint
  den: bigint
}

const RATE_MAX_INTEGER_DIGITS = 9
const RATE_MAX_DECIMALS = 10

/** Mitad hacia arriba, como `round(numeric)` de PostgreSQL (se aleja del cero). */
function roundHalfUp(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("División entre cero")
  const negative = num < 0n !== den < 0n
  const top = num < 0n ? -num : num
  const bottom = den < 0n ? -den : den
  const rounded = (2n * top + bottom) / (2n * bottom)
  return negative ? -rounded : rounded
}

function asSafeCents(value: bigint): number {
  const cents = Number(value)
  if (!Number.isSafeInteger(cents)) throw new Error("El importe excede el rango exacto admitido")
  return cents
}

function asCents(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new Error("El importe debe ser un entero")
  return BigInt(value)
}

/** «3.75» → 375/100. Solo para un decimal ya normalizado. */
function decimalFraction(text: string): MoneyFraction {
  const [integer = "0", fraction = ""] = text.split(".")
  return { num: BigInt(integer + fraction), den: 10n ** BigInt(fraction.length) }
}

/**
 * La forma única de un cambio: dígitos con punto, sin ceros de sobra («3.750» es
 * «3.75»), mayor que cero. Es la que se guarda y la que entra en la huella de un cobro.
 */
export function normalizeExchangeRate(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) throw new Error("Escribe el cambio con números, por ejemplo 3.75")
  const integer = (match[1] ?? "").replace(/^0+(?=\d)/, "")
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  if (integer.length > RATE_MAX_INTEGER_DIGITS || fraction.length > RATE_MAX_DECIMALS) {
    throw new Error(`El cambio admite hasta ${RATE_MAX_DECIMALS} decimales y no pasa de 9 cifras`)
  }
  if (/^0*$/.test(integer + fraction)) throw new Error("El cambio debe ser mayor que 0")
  return fraction ? `${integer}.${fraction}` : integer
}

/** Lo que se escribe en pantalla, con el formato de la clínica, en su forma única. */
export function parseExchangeRate(raw: string, locale: string): string {
  const { integer, fraction } = readDecimal(raw, locale, {
    empty: "Escribe el cambio",
    invalid: "Escribe el cambio con números, por ejemplo 3.75",
  })
  return normalizeExchangeRate(fraction ? `${integer}.${fraction}` : integer)
}

/** Lo mismo, para un formulario: el cambio o lo que hay que corregir, sin excepción. */
export function readExchangeRate(
  raw: string,
  locale: string,
): { rate: string; error?: undefined } | { rate?: undefined; error: string } {
  try {
    return { rate: parseExchangeRate(raw, locale) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Revisa el cambio" }
  }
}

/** Texto editable compatible con parseExchangeRate y el formato de la clínica. */
export function formatExchangeRateInput(rate: string, locale: string): string {
  const decimal =
    inputFormat(locale, 1)
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? "."
  return normalizeExchangeRate(rate).replace(".", decimal)
}

/** Símbolo de la moneda tal como lo escribe el formato de la clínica: el prefijo de un importe, nunca uno fijo. */
export function currencySymbol(currency: string, locale: string): string {
  try {
    return (
      moneyFormat(locale, 0, currency)
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currency
    )
  } catch {
    return currency
  }
}

/** «S/ 3.75 por USD 1»: así se dice un cambio en una pantalla o en un papel. */
export function exchangeRateWords(
  rate: string,
  businessCurrency: string,
  otherCurrency: string,
  locale: string,
): string {
  const business = currencySymbol(businessCurrency, locale)
  const other = currencySymbol(otherCurrency, locale)
  return `${business} ${formatExchangeRateInput(rate, locale)} por ${other} 1`
}

/** «soles», «dólares», «pesos»: la moneda como se nombra al hablar, en el idioma de la clínica. */
export function currencyWord(currency: string, locale: string): string {
  const name = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "name",
  })
    .formatToParts(2)
    .find((part) => part.type === "currency")?.value
  return name?.split(" ")[0]?.toLocaleLowerCase(locale) || currency
}

/**
 * El cambio por unidad menor de cada moneda, para las cuentas en SQL:
 * `rate × 10^(dígitos negocio − dígitos otra)`. 950 pesos chilenos (sin
 * decimales) por USD 1 son 9.5 por centavo. Es exacto: solo corre el punto.
 */
export function exchangeFactor(rate: string, businessCurrency: string, otherCurrency: string): string {
  const shift = currencyFractionDigits(businessCurrency) - currencyFractionDigits(otherCurrency)
  const [integer = "0", fraction = ""] = normalizeExchangeRate(rate).split(".")
  const digits = integer + fraction
  const point = integer.length + shift
  const whole = point > 0 ? digits.slice(0, point).padEnd(point, "0") : "0"
  const rest = point > 0 ? digits.slice(point) : "0".repeat(-point) + digits
  const cleanWhole = whole.replace(/^0+(?=\d)/, "")
  const cleanRest = rest.replace(/0+$/, "")
  return cleanRest ? `${cleanWhole}.${cleanRest}` : cleanWhole
}

/**
 * Pasa un importe a otra moneda, con redondeo half-up: una sola conversión por
 * cobro. Siempre cruza con la moneda del negocio, porque en ella está el cambio.
 */
export function convertCents(input: {
  amountCents: number
  from: string
  to: string
  businessCurrency: string
  factor: string
}): number {
  const { from, to, businessCurrency } = input
  if (from === to) return input.amountCents
  const amount = asCents(input.amountCents)
  const factor = decimalFraction(input.factor)
  if (to === businessCurrency) return asSafeCents(roundHalfUp(amount * factor.num, factor.den))
  if (from === businessCurrency) return asSafeCents(roundHalfUp(amount * factor.den, factor.num))
  throw new Error("Una de las dos monedas debe ser la del negocio")
}

/**
 * Cuadrar a cero: si lo convertido queda a una unidad menor o menos de lo que se
 * debe, cancela justo lo que se debe y la cuenta queda al día.
 */
function settleToDue(convertedCents: number, dueCents: number): number {
  return convertedCents < dueCents && dueCents - convertedCents <= 1 ? dueCents : convertedCents
}

/**
 * Cuánto cancela lo pagado, en la moneda de la deuda: una sola conversión por
 * cobro. Pagar justo lo que se propuso para lo que se debe deja la cuenta al día,
 * aunque de vuelta no dé exacto: un centavo de dólar son casi cuatro de sol, y
 * S/ 301.03 propone USD 80.27, que de vuelta son S/ 301.01. Por lo demás, cuadra a cero.
 */
export function cancelledCents(input: {
  paidCents: number
  paidCurrency: string
  dueCents: number
  currency: string
  businessCurrency: string
  factor: string
}): number {
  const { paidCents, paidCurrency, dueCents, currency, businessCurrency, factor } = input
  if (paidCurrency === currency) return paidCents
  const to = { businessCurrency, factor }
  if (
    dueCents > 0 &&
    convertCents({ amountCents: dueCents, from: currency, to: paidCurrency, ...to }) === paidCents
  )
    return dueCents
  return settleToDue(
    convertCents({ amountCents: paidCents, from: paidCurrency, to: currency, ...to }),
    dueCents,
  )
}

/**
 * Cuánto vale un cobro en moneda del negocio, al congelarlo: si cancela moneda
 * del negocio, lo que cancela; si se paga en ella, lo pagado (es exacto); si es
 * otra moneda de punta a punta, el importe por el cambio.
 */
export function frozenValueCents(input: {
  /** Lo que cancela, en la moneda de la deuda. */
  amountCents: number
  currency: string
  /** Lo que entró, en la moneda en que se pagó. */
  paidCents: number
  paidCurrency: string
  businessCurrency: string
  factor: string
}): number {
  const { amountCents, currency, paidCents, paidCurrency, businessCurrency, factor } = input
  if (currency === businessCurrency) return amountCents
  if (paidCurrency === businessCurrency) return paidCents
  if (paidCurrency !== currency) throw new Error("Una de las dos monedas debe ser la del negocio")
  return convertCents({ amountCents, from: currency, to: businessCurrency, businessCurrency, factor })
}

/**
 * La cuenta de un cobro, la misma en el servidor y en lo que muestra la pantalla:
 * cuánto cancela lo pagado, cuánto vale y, si el vuelto se da en otra moneda, cuánto
 * se queda del billete y cuánto sale. Sin cambio (`rate` nulo) no hay nada que
 * convertir ni que valorar: lo pagado en la moneda de la deuda cancela lo que dice;
 * en otra, aún no se sabe cuánto cancela (`cancels` nulo).
 */
export function collectExchange(input: {
  /** Lo que entró, en `paidCurrency`. */
  paidCents: number
  paidCurrency: string
  /** Lo que falta de lo que se paga, en `currency`, la moneda de la deuda. */
  dueCents: number
  currency: string
  businessCurrency: string
  /** Solo si alguna de las dos monedas no es la del negocio. */
  rate: string | null
  /** Lo recibido de más, en `paidCurrency`; nulo si no se dijo lo recibido. */
  changeCents: number | null
  /** Moneda en que se da el vuelto. */
  changeIn: string
}): {
  factor: string | null
  cancels: number | null
  /** El exceso del billete, si el vuelto sale en otra moneda. */
  crossChange: number | null
  /** El vuelto que se da, en `changeIn`. */
  changeGiven: number | null
  valueCents: number | null
} {
  const {
    paidCents,
    paidCurrency,
    dueCents,
    currency,
    businessCurrency,
    rate,
    changeCents,
    changeIn,
  } = input
  if (rate === null)
    return {
      factor: null,
      cancels: paidCurrency === currency ? paidCents : null,
      crossChange: null,
      changeGiven: changeCents,
      valueCents: null,
    }
  const other = currency === businessCurrency ? paidCurrency : currency
  const factor = exchangeFactor(rate, businessCurrency, other)
  const cancels = cancelledCents({
    paidCents,
    paidCurrency,
    dueCents,
    currency,
    businessCurrency,
    factor,
  })
  const crossChange =
    changeCents !== null && changeCents > 0 && changeIn !== paidCurrency ? changeCents : null
  return {
    factor,
    cancels,
    crossChange,
    changeGiven:
      crossChange === null
        ? changeCents
        : convertCents({
            amountCents: crossChange,
            from: paidCurrency,
            to: changeIn,
            businessCurrency,
            factor,
          }),
    valueCents: frozenValueCents({
      amountCents: cancels,
      currency,
      paidCents,
      paidCurrency,
      businessCurrency,
      factor,
    }),
  }
}

/** Con cuántos decimales se dice un cambio que no se escribió: el valor congelado no depende de él. */
const IMPLIED_RATE_DECIMALS = 6

/**
 * El cambio que resulta de lo pagado en cada moneda: USD 1,500 pagados con S/ 5,640
 * son S/ 3.76 por USD 1. Se dice como todo cambio (moneda del negocio por 1 de la
 * otra), y es solo para mostrarlo: lo que vale es lo pagado, exacto.
 */
function impliedExchangeRate(input: {
  amountCents: number
  currency: string
  tenderCents: number
  tenderCurrency: string
  businessCurrency: string
}): string {
  const { amountCents, currency, tenderCents, tenderCurrency, businessCurrency } = input
  if (currency !== businessCurrency && tenderCurrency !== businessCurrency) {
    throw new Error("Una de las dos monedas debe ser la del negocio")
  }
  const inBusiness = tenderCurrency === businessCurrency ? tenderCents : amountCents
  const inOther = tenderCurrency === businessCurrency ? amountCents : tenderCents
  const other = tenderCurrency === businessCurrency ? currency : tenderCurrency
  const businessDigits = BigInt(currencyFractionDigits(businessCurrency))
  const otherDigits = BigInt(currencyFractionDigits(other))
  const scale = 10n ** BigInt(IMPLIED_RATE_DECIMALS)
  const scaled = roundHalfUp(
    asCents(inBusiness) * 10n ** otherDigits * scale,
    asCents(inOther) * 10n ** businessDigits,
  )
  const text = scaled.toString().padStart(IMPLIED_RATE_DECIMALS + 1, "0")
  const point = text.length - IMPLIED_RATE_DECIMALS
  return normalizeExchangeRate(`${text.slice(0, point)}.${text.slice(point)}`)
}

/** Lo que congela un gasto en dos monedas. */
export interface ExpenseExchange {
  /** Lo que salió, solo si salió en otra moneda que la que cancela. */
  tender: { cents: number; currency: string } | null
  /** El cambio usado, en palabras. */
  exchangeRate: string
  /** Cuánto vale en moneda del negocio. */
  businessCents: number
}

/**
 * Cuánto vale un gasto, la misma regla en el servidor y en lo que muestra la
 * pantalla antes de guardar. Si salió en otra moneda (el cruce al pagar una
 * compra) el cambio es el que resulta y lo que está en moneda del negocio es exacto;
 * si cancela y sale en la otra moneda, el importe por el cambio que se dijo. En
 * moneda del negocio de punta a punta no hay nada que congelar (`null`).
 */
export function expenseExchange(input: {
  amountCents: number
  currency: string
  businessCurrency: string
  tender?: { cents: number; currency: string } | null
  rate?: string | null
}): ExpenseExchange | null {
  const { amountCents, currency, businessCurrency, tender, rate } = input
  if (tender) {
    return {
      tender,
      exchangeRate: impliedExchangeRate({
        amountCents,
        currency,
        tenderCents: tender.cents,
        tenderCurrency: tender.currency,
        businessCurrency,
      }),
      businessCents: currency === businessCurrency ? amountCents : tender.cents,
    }
  }
  if (currency === businessCurrency) return null
  if (!rate) throw new Error("Escribe el cambio")
  const exchangeRate = normalizeExchangeRate(rate)
  return {
    tender: null,
    exchangeRate,
    businessCents: convertCents({
      amountCents,
      from: currency,
      to: businessCurrency,
      businessCurrency,
      factor: exchangeFactor(exchangeRate, businessCurrency, currency),
    }),
  }
}

/**
 * Espejo de la función SQL `money_value`: cuánto vale una parte de un importe en
 * moneda del negocio. Con el valor congelado reparte en proporción; sin él, la
 * moneda del negocio vale lo que dice y otra sale del factor de hoy. Sin factor
 * no hay valor (`null`): no entra en las sumas. Sirve para aplicación, devolución,
 * impuesto, saldo a favor y reposición tras devolución.
 */
export function moneyValue(input: {
  partCents: number
  amountCents: number
  /** `business_cents`: el valor congelado del importe entero. */
  valueCents: number | null
  currency: string
  businessCurrency: string
  /** `exchange_factor` de la clínica, por unidad menor. */
  factor: string | null
}): MoneyFraction | null {
  const part = asCents(input.partCents)
  if (input.valueCents !== null) {
    if (input.amountCents === 0) return { num: 0n, den: 1n }
    return { num: part * asCents(input.valueCents), den: asCents(input.amountCents) }
  }
  if (input.currency === input.businessCurrency) return { num: part, den: 1n }
  if (input.factor === null) return null
  const factor = decimalFraction(input.factor)
  return { num: part * factor.num, den: factor.den }
}

function greatestDivisor(a: bigint, b: bigint): bigint {
  let [x, y] = [a, b]
  while (y !== 0n) [x, y] = [y, x % y]
  return x
}

/**
 * Suma exacta; lo que no tiene valor (`null`) no entra, igual que en `sum()`. Por
 * denominador: multiplicarlos todos hacía crecer los números con cada fila.
 */
export function sumMoneyValues(values: ReadonlyArray<MoneyFraction | null>): MoneyFraction {
  const byDen = new Map<bigint, bigint>()
  for (const value of values)
    if (value) byDen.set(value.den, (byDen.get(value.den) ?? 0n) + value.num)
  let total: MoneyFraction = { num: 0n, den: 1n }
  for (const [den, num] of byDen) {
    const shared = greatestDivisor(total.den, den)
    total = {
      num: total.num * (den / shared) + num * (total.den / shared),
      den: (total.den / shared) * den,
    }
  }
  return total
}

/** El único redondeo del valor: al mostrar o al congelar, nunca fila por fila. */
export function roundMoneyValue(value: MoneyFraction): number {
  return asSafeCents(roundHalfUp(value.num, value.den))
}

/**
 * Cuánto sale de lo que entró al devolver una parte de un pago, en proporción y
 * sin cambio nuevo: `round(T × (previo + r) ÷ A) − round(T × previo ÷ A)`. Devolver
 * por partes o de una vez suma lo mismo.
 */
export function refundTenderCents(input: {
  /** T: `coalesce(tender_cents, amount_cents)`. */
  tenderCents: number
  /** A: `amount_cents`, lo que cancela el pago. */
  amountCents: number
  /** Lo ya devuelto de este pago, en la moneda de `amountCents`. */
  previousCents: number
  /** r: lo que se devuelve ahora, en la moneda de `amountCents`. */
  refundCents: number
}): number {
  const total = asCents(input.tenderCents)
  const amount = asCents(input.amountCents)
  const previous = asCents(input.previousCents)
  const refund = asCents(input.refundCents)
  return asSafeCents(
    roundHalfUp(total * (previous + refund), amount) - roundHalfUp(total * previous, amount),
  )
}

/**
 * Espejo de la función SQL `money_commission`: la comisión del valor de una parte
 * (`moneyValue`), hacia abajo: `floor(a × B × tasa ÷ (A × 10000))`, multiplicando
 * antes de dividir. Sin valor no hay comisión que contar: quien llama no llega aquí.
 */
export function commissionOfValue(value: MoneyFraction, rateBps: number): number {
  return asSafeCents((value.num * asCents(rateBps)) / (value.den * 10_000n))
}

/**
 * Reparte un total entero, mayor o igual a cero, entre varias filas en proporción, por
 * residuo mayor: cada una lleva su parte entera y lo que sobra va de a una unidad a las
 * que más perdieron al truncar (en empate, a las últimas). Suma exacto y ninguna queda
 * negativa.
 */
export function splitCents(totalCents: number, weights: readonly number[]): number[] {
  const total = asCents(totalCents)
  const sum = weights.reduce((acc, weight) => acc + asCents(weight), 0n)
  if (sum === 0n) return weights.map((_, index) => (index === weights.length - 1 ? totalCents : 0))
  const shares = weights.map((weight) => (total * asCents(weight)) / sum)
  let left = total - shares.reduce((acc, share) => acc + share, 0n)
  const lost = weights.map((weight, index) => total * asCents(weight) - (shares[index] ?? 0n) * sum)
  const order = weights
    .map((_, index) => index)
    .sort((a, b) => {
      const diff = (lost[b] ?? 0n) - (lost[a] ?? 0n)
      return diff > 0n ? 1 : diff < 0n ? -1 : b - a
    })
  for (const index of order) {
    if (left <= 0n) break
    shares[index] = (shares[index] ?? 0n) + 1n
    left -= 1n
  }
  return shares.map(asSafeCents)
}
