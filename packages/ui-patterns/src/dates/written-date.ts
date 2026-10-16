import { formatCountry, formatLocale } from "../locale.js"

/**
 * Fecha escrita: la que uno recuerda (nacimiento, el inicio de una enfermedad)
 * se teclea, no se busca mes a mes en un calendario. Se escribe en el orden
 * del formato de la clínica —día/mes/año, mes/día/año o año-mes-día—, que da
 * `Intl` con su formato regional (BCP 47), y se guarda siempre en ISO 8601
 * (`yyyy-mm-dd`). Funciones puras: el campo es `BirthDateInput`.
 */

export type DatePart = "day" | "month" | "year"

export interface WrittenDateFormat {
  /** Orden de las partes en el formato de la clínica. */
  order: DatePart[]
  /** Separador entre partes (`/`, `.`, `-`). */
  separator: string
  /** Lo que se ve en el campo vacío: «dd/mm/aaaa». */
  placeholder: string
}

const PART_LENGTH: Record<DatePart, number> = { day: 2, month: 2, year: 4 }
const PART_HINT: Record<DatePart, string> = { day: "dd", month: "mm", year: "aaaa" }
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const formats = new Map<string, WrittenDateFormat>()

/**
 * Formato probable de un país según CLDR (`PE` → `es-PE`, `US` → `en-US`),
 * para una página que sabe el país de la clínica pero no su formato.
 */
export function likelyLocaleOf(country: string | null | undefined): string | undefined {
  const code = country?.trim().toUpperCase()
  if (!code || !/^[A-Z]{2}$/.test(code) || typeof Intl.Locale !== "function") return undefined
  try {
    return `${new Intl.Locale(`und-${code}`).maximize().language}-${code}`
  } catch {
    return undefined
  }
}

/**
 * Formato con el que se escriben las fechas: el de la clínica
 * (`setFormatRegion`); sin él, el probable del país de la clínica; y sin
 * ninguno, el del entorno.
 */
export function clinicDateLocale(country?: string | null): string | undefined {
  return formatLocale() ?? likelyLocaleOf(country ?? formatCountry())
}

/**
 * Orden y separador del formato regional. Se leen de cómo `Intl` escribe una
 * fecha cualquiera en ese formato (`es-PE` → 22/11/2006, `en-US` → 11/22/2006,
 * `sv-SE` → 2006-11-22): no hay tabla de países.
 */
export function writtenDateFormat(locale: string | undefined = clinicDateLocale()): WrittenDateFormat {
  const key = locale ?? ""
  const cached = formats.get(key)
  if (cached) return cached
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(Date.UTC(2006, 10, 22, 12)))
  const order = parts
    .map((part) => part.type)
    .filter((type): type is DatePart => type === "day" || type === "month" || type === "year")
  const complete = order.length === 3 && new Set(order).size === 3
  const literal = parts.find((part) => part.type === "literal")?.value.trim().charAt(0)
  const separator = literal && !/\d/.test(literal) ? literal : "/"
  const chosen: DatePart[] = complete ? order : ["day", "month", "year"]
  const format = {
    order: chosen,
    separator,
    placeholder: chosen.map((part) => PART_HINT[part]).join(separator),
  }
  formats.set(key, format)
  return format
}

/** Máscara del campo: dígitos de cada parte y el separador fijo entre ellas. */
export function writtenDateMask(format: WrittenDateFormat): Array<RegExp | string> {
  return format.order.flatMap((part, index) => [
    ...(index > 0 ? [format.separator] : []),
    ...Array.from({ length: PART_LENGTH[part] }, () => /\d/),
  ])
}

/** `1995-07-30` → `30/07/1995` en el orden de la clínica; lo que no es ISO queda igual. */
export function writeDate(iso: string, format: WrittenDateFormat = writtenDateFormat()): string {
  const match = ISO_DATE.exec(iso.trim())
  if (!match) return iso
  const [, year = "", month = "", day = ""] = match
  const values: Record<DatePart, string> = { day, month, year }
  return format.order.map((part) => values[part]).join(format.separator)
}

/** ¿Es una fecha ISO (`yyyy-mm-dd`) que existe en el calendario? */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value)
  if (!match) return false
  const [, year, month, day] = match.map(Number) as [number, number, number, number]
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Lo que impide guardar una fecha escrita, dicho para arreglarlo. */
export type WrittenDateProblem =
  | { kind: "incompleta" }
  | { kind: "mes" }
  | { kind: "dia" }
  | { kind: "no-existe"; days: number }
  | { kind: "futura" }
  | { kind: "antigua"; years: number }

export interface WrittenDateReading {
  /** ISO 8601 si lo escrito es una fecha válida; si no, `null`. */
  iso: string | null
  /** Vacío: nada escrito. */
  empty: boolean
  problem: WrittenDateProblem | null
}

/** Una fecha escrita no puede ser de hace más de esto (ni de nacimiento ni de antecedentes). */
export const WRITTEN_DATE_MAX_YEARS = 130

/**
 * Lee lo escrito en el campo: la fecha ISO si existe, no es futura y no es de
 * hace más de `WRITTEN_DATE_MAX_YEARS` años; si no, por qué.
 */
export function readWrittenDate(
  text: string,
  today: string,
  format: WrittenDateFormat = writtenDateFormat(),
): WrittenDateReading {
  const digits = text.replace(/\D/g, "")
  if (digits === "") return { iso: null, empty: true, problem: null }
  if (digits.length < 8) return { iso: null, empty: false, problem: { kind: "incompleta" } }
  const values: Partial<Record<DatePart, string>> = {}
  let offset = 0
  for (const part of format.order) {
    values[part] = digits.slice(offset, offset + PART_LENGTH[part])
    offset += PART_LENGTH[part]
  }
  const year = Number(values.year)
  const month = Number(values.month)
  const day = Number(values.day)
  const fail = (problem: WrittenDateProblem): WrittenDateReading => ({ iso: null, empty: false, problem })
  if (month < 1 || month > 12) return fail({ kind: "mes" })
  if (day < 1 || day > 31) return fail({ kind: "dia" })
  const days = daysInMonth(year, month)
  if (day > days) return fail({ kind: "no-existe", days })
  const iso = `${values.year}-${values.month}-${values.day}`
  if (iso > today) return fail({ kind: "futura" })
  if (year < Number(today.slice(0, 4)) - WRITTEN_DATE_MAX_YEARS)
    return fail({ kind: "antigua", years: WRITTEN_DATE_MAX_YEARS })
  return { iso, empty: false, problem: null }
}

/** El problema en palabras, diciendo qué arreglar (nunca «formato inválido»). */
export function writtenDateProblemText(
  problem: WrittenDateProblem,
  format: WrittenDateFormat = writtenDateFormat(),
): string {
  switch (problem.kind) {
    case "incompleta":
      return `Escribe día, mes y año: ${format.placeholder}`
    case "mes":
      return "El mes va del 01 al 12"
    case "dia":
      return "El día va del 01 al 31"
    case "no-existe":
      return `Ese mes tiene ${problem.days} días: revisa el día`
    case "futura":
      return "Es una fecha que aún no llega: escribe una que ya pasó"
    case "antigua":
      return `Revisa el año: es de hace más de ${problem.years} años`
  }
}

/**
 * Edad cumplida a una fecha: «31 años», «1 año», «8 meses» o «12 días» para
 * un bebé, y «Nació hoy». Vacío si la fecha no es válida o es posterior.
 */
export function ageText(birth: string, today: string): string {
  if (!isIsoDate(birth) || !isIsoDate(today) || birth > today) return ""
  const [by, bm, bd] = birth.split("-").map(Number) as [number, number, number]
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number]
  let months = (ty - by) * 12 + (tm - bm)
  if (td < bd) months -= 1
  const years = Math.floor(months / 12)
  if (years >= 1) return years === 1 ? "1 año" : `${years} años`
  if (months >= 1) return months === 1 ? "1 mes" : `${months} meses`
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000)
  if (days === 0) return "Nació hoy"
  return days === 1 ? "1 día" : `${days} días`
}
