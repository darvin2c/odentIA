/**
 * Cómo se dicen las cifras de Reportes fuera de la pantalla: en las respuestas
 * de Argos y en el resumen del lunes. Son las mismas frases que escribe la
 * plataforma junto a cada tarjeta («8 % más que en agosto», «septiembre de
 * 2026», «del 10 al 25 de septiembre»), para que la respuesta y la pantalla
 * digan lo mismo con las mismas palabras.
 */
import { formatMoney } from "@odentia/clinical"
import type { ReportSpan, YearMonth } from "./report-periods.js"

function lower(text: string, locale: string): string {
  return text.toLocaleLowerCase(locale)
}

function monthName(month: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, month - 1, 15)))
}

function monthLabel(value: YearMonth, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(value.year, value.month - 1, 15)))
}

function sameMonth(a: YearMonth, b: YearMonth): boolean {
  return a.year === b.year && a.month === b.month
}

/** Una fecha civil (`YYYY-MM-DD`) sin moverla de día: «14 de septiembre de 2026». */
export function civilDayWords(day: string, locale: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" }): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`))
}

/** «del 10 al 25 de septiembre de 2026», «del 28 de agosto al 3 de septiembre de 2026». */
export function civilDaysWords(days: { from: string; to: string }, locale: string): string {
  const [fromYear, fromMonth] = days.from.split("-")
  const [toYear, toMonth] = days.to.split("-")
  if (days.from === days.to) return `el ${civilDayWords(days.to, locale)}`
  const from =
    fromYear !== toYear
      ? civilDayWords(days.from, locale)
      : fromMonth !== toMonth
        ? civilDayWords(days.from, locale, { day: "numeric", month: "long" })
        : civilDayWords(days.from, locale, { day: "numeric" })
  return `del ${from} al ${civilDayWords(days.to, locale)}`
}

/** «septiembre de 2026», «julio a septiembre de 2026», «del 10 al 25 de septiembre de 2026». */
export function spanWords(span: Pick<ReportSpan, "from" | "to" | "days">, locale: string): string {
  if (span.days) return civilDaysWords(span.days, locale)
  if (sameMonth(span.from, span.to)) return lower(monthLabel(span.from, locale), locale)
  const from = span.from.year === span.to.year ? monthName(span.from.month, locale) : monthLabel(span.from, locale)
  return `${lower(from, locale)} a ${lower(monthLabel(span.to, locale), locale)}`
}

/** Un mes suelto, para los meses de una línea: «agosto», o «agosto de 2025» si no es del año de `year`. */
export function monthWords(value: YearMonth, locale: string, year?: number): string {
  return lower(year === value.year ? monthName(value.month, locale) : monthLabel(value, locale), locale)
}

/** Cierre de toda comparación: «que en agosto», «que en los mismos días de septiembre», «que en los 7 días anteriores». */
export function previousWords(previous: Pick<ReportSpan, "from" | "to" | "days" | "partial">, locale: string): string {
  if (previous.days) {
    const count = Math.round((Date.parse(`${previous.days.to}T00:00:00Z`) - Date.parse(`${previous.days.from}T00:00:00Z`)) / 86_400_000) + 1
    return count === 1 ? "que el día anterior" : `que en los ${count} días anteriores`
  }
  if (sameMonth(previous.from, previous.to)) {
    const month = lower(monthName(previous.from.month, locale), locale)
    return previous.partial ? `que en los mismos días de ${month}` : `que en ${month}`
  }
  const months = (previous.to.year - previous.from.year) * 12 + (previous.to.month - previous.from.month) + 1
  return previous.partial ? `que en el mismo tramo de ${previous.to.year}` : `que en los ${months} meses anteriores`
}

export function whole(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)
}

export function moneyWords(cents: number, currency: string, locale: string): string {
  return formatMoney(cents, currency, locale)
}

/** «14 %», con el espacio de la norma (como en la pantalla). */
export function percentWords(value: number, locale: string): string {
  return `${whole(value, locale)} %`
}

/** «45 min», «1 h 20 min». */
export function minutesWords(minutes: number, locale: string): string {
  const rounded = Math.round(minutes)
  if (rounded < 60) return `${whole(rounded, locale)} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `${whole(hours, locale)} h` : `${whole(hours, locale)} h ${rest} min`
}

/** Horas enteras de unos minutos: «62 horas», «1 hora». */
export function hoursWords(minutes: number, locale: string): string {
  const hours = Math.round(minutes / 60)
  return `${whole(hours, locale)} ${hours === 1 ? "hora" : "horas"}`
}

export function countWords(value: number, noun: { one: string; many: string }, locale: string): string {
  return `${whole(value, locale)} ${value === 1 ? noun.one : noun.many}`
}

/** Parte de un total como porcentaje entero; null si no hay total (nunca 0 % ni 100 % inventados). */
export function rateOf(part: number, total: number): number | null {
  return total > 0 ? Math.round((part * 100) / total) : null
}

export type ChangeDirection = "up" | "down" | "same"

/** «8 % más que en agosto»: sin base con qué comparar no hay frase. */
export function relativeChangeWords(current: number, previous: number | null, phrase: string, locale: string): { text: string; direction: ChangeDirection } | null {
  if (previous === null || previous === 0) return null
  const percent = Math.round(((current - previous) / Math.abs(previous)) * 100)
  if (percent === 0) return { text: `igual ${phrase}`, direction: "same" }
  return { text: `${whole(Math.abs(percent), locale)} % ${percent > 0 ? "más" : "menos"} ${phrase}`, direction: percent > 0 ? "up" : "down" }
}

/** «5 más que en agosto», «2 puntos menos que en agosto», «S/ 620 más que en agosto». */
export function absoluteChangeWords(
  current: number,
  previous: number | null,
  phrase: string,
  locale: string,
  format: (value: number) => string = (value) => whole(value, locale),
): { text: string; direction: ChangeDirection } | null {
  if (previous === null) return null
  const difference = Math.round(current - previous)
  if (difference === 0) return { text: `igual ${phrase}`, direction: "same" }
  return { text: `${format(Math.abs(difference))} ${difference > 0 ? "más" : "menos"} ${phrase}`, direction: difference > 0 ? "up" : "down" }
}

export const POINT_WORDS = { one: "punto", many: "puntos" }

/** La primera letra en mayúscula, para empezar una frase. */
export function capitalize(text: string, locale: string): string {
  return text ? `${text.charAt(0).toLocaleUpperCase(locale)}${text.slice(1)}` : text
}
