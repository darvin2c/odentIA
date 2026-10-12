/** Importes enteros en la unidad menor ISO 4217; formato y entrada según la clínica. */
const CURRENCY_NAMES = new Intl.DisplayNames("en", { type: "currency", fallback: "none" })

function assertCurrency(currency: string): string {
  const code = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(code) || !CURRENCY_NAMES.of(code)) {
    throw new Error("La moneda debe ser un código ISO 4217 válido")
  }
  return code
}

/** ICU mantiene los dígitos ISO, incluidas monedas con cero, tres o cuatro decimales. */
export function currencyFractionDigits(currency: string): number {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency: assertCurrency(currency),
  }).resolvedOptions().maximumFractionDigits
  if (digits === undefined) throw new Error("No se pudo resolver la unidad menor de la moneda")
  return digits
}

function inputFormat(locale: string, digits = 0): Intl.NumberFormat {
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  return new Intl.NumberFormat(locale, {
    numberingSystem: "latn",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("El importe debe ser un entero")
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  const code = assertCurrency(currency)
  const digits = currencyFractionDigits(code)
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits)
}

/**
 * No adivina separadores: «1.500» significa algo distinto en es-CL y es-PE.
 * Valida los grupos antes de quitarlos y convierte por dígitos, sin redondeo binario.
 */
export function parseMoney(raw: string, currency: string, locale: string): number {
  const digits = currencyFractionDigits(currency)
  const parts = inputFormat(locale, 1).formatToParts(123456789.1)
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? "."
  const group = parts.find((part) => part.type === "group")?.value
  let text = raw.trim()
  if (!text) throw new Error("Ingresa el importe")
  if (group && /^\s+$/.test(group)) text = text.replace(/[\u00a0\u202f ]/g, group)
  const split = text.split(decimal)
  if (split.length > 2) throw new Error("Importe inválido")
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
    throw new Error("Importe inválido")
  }
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
 * Importe aceptado de un presupuesto: suma el total de cada línea cuya
 * respuesta es «aceptado». Es la única regla, la misma para el servidor (lo
 * guardado) y para la vista previa de la interfaz (lo que se está marcando);
 * `null` si alguna línea aceptada aún no tiene precio.
 */
export function sumAcceptedCents(
  lines: ReadonlyArray<{ lineTotalCents: number | null; decision: string | null | undefined }>,
): number | null {
  let total = 0
  for (const line of lines) {
    if (line.decision !== "aceptado") continue
    if (line.lineTotalCents == null) return null
    total += line.lineTotalCents
  }
  return total
}

/**
 * El mismo importe que `formatMoney`, sin el símbolo de la moneda: para las
 * cifras secundarias de una lista cuyo total ya dice la moneda.
 */
export function formatMoneyAmount(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new Error("El importe debe ser un entero")
  if (!locale.trim()) throw new Error("El idioma y formato es obligatorio")
  const digits = currencyFractionDigits(currency)
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits)
}
