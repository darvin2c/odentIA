/**
 * Aritmética de tiempo de la agenda, pura y sin librería de fechas: todo sale
 * del runtime (`Intl`). La zona de la sede manda; el navegador del usuario no
 * interviene. Fechas como `yyyy-mm-dd`, instantes como ISO con zona.
 *
 * Invariante que sostiene el drag & drop: `dayMinutesIn` y `minutesToInstant`
 * son inversas exactas, incluso en días de 23 o 25 horas, porque ambas miden
 * desde la medianoche local convertida a UTC.
 */

import { formatLocale, formatTimeZone } from "../locale.js"
import type { ScheduleEntry, ScheduleWindow } from "./types.js"

const MINUTE_MS = 60_000

const formatters = new Map<string, Intl.DateTimeFormat>()
function partsOf(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** Medianoche local del día pedido, como instante UTC. */
export function zonedDayStart(dateISO: string, timeZone: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  const asIfUtc = Date.UTC(year, month - 1, day)
  const parts = partsOf(timeZone).formatToParts(new Date(asIfUtc))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value)
  const renderedAsUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
  )
  return new Date(asIfUtc - (renderedAsUtc - asIfUtc))
}

/** Día civil ± N días, sin pasar por Date: «2026-09-21» + 1 = «2026-09-22». */
export function addDays(dateISO: string, days: number): string {
  const [year, month, day] = dateISO.split("-").map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  const iso = shifted.toISOString()
  return iso.slice(0, 10)
}

/** [inicio, fin) del día civil en la zona: 23, 24 o 25 horas según el huso. */
export function dayBounds(dateISO: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedDayStart(dateISO, timeZone),
    end: zonedDayStart(addDays(dateISO, 1), timeZone),
  }
}

/** Minutos del día local para un instante; base del posicionamiento en el eje. */
export function dayMinutesIn(iso: string, timeZone: string): number {
  const bounds = dayBounds(zonedDateOf(iso, timeZone), timeZone)
  return Math.round((Date.parse(iso) - bounds.start.getTime()) / MINUTE_MS)
}

/** Fecha local «yyyy-mm-dd» de un instante en la zona dada. */
export function zonedDateOf(iso: string, timeZone: string): string {
  const parts = partsOf(timeZone).formatToParts(new Date(iso))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00"
  return `${value("year")}-${value("month")}-${value("day")}`
}

/** Zona de la clínica (`setFormatRegion`) o, sin ella, la del entorno. */
export function regionTimeZone(): string {
  return formatTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** «Hoy» como «yyyy-mm-dd» en la zona de la clínica, nunca en la del navegador si hay clínica. */
export function regionToday(now: Date = new Date()): string {
  return zonedDateOf(now.toISOString(), regionTimeZone())
}

/** Inversa de `dayMinutesIn`: minutos del día → instante ISO. */
export function minutesToInstant(dateISO: string, minutes: number, timeZone: string): string {
  return new Date(zonedDayStart(dateISO, timeZone).getTime() + minutes * MINUTE_MS).toISOString()
}

/** Redondea al múltiplo de snap más cercano: 14:07 con snap 15 → 14:00, 14:08 → 14:15. */
export function snapMinutes(minutes: number, snap: number): number {
  return Math.round(minutes / snap) * snap
}

/** Mantiene un rango dentro de la ventana visible sin cambiar su duración. */
export function clampToWindow(
  startMinutes: number,
  durationMinutes: number,
  window: ScheduleWindow,
): number {
  return Math.min(
    Math.max(startMinutes, window.startMinutes),
    window.endMinutes - durationMinutes,
  )
}

/** La cita toca el día civil (cubre citas que cruzan medianoche). */
export function overlapsDay(
  item: { start: string; end: string },
  dateISO: string,
  timeZone: string,
): boolean {
  const bounds = dayBounds(dateISO, timeZone)
  return Date.parse(item.start) < bounds.end.getTime() && Date.parse(item.end) > bounds.start.getTime()
}

export function onDate<T extends { start: string; end: string }>(
  items: T[],
  dateISO: string,
  timeZone: string,
): T[] {
  return items.filter((item) => overlapsDay(item, dateISO, timeZone))
}

/** Los siete días de la semana que contiene la fecha, empezando en lunes. */
export function weekDates(dateISO: string): string[] {
  const [year, month, day] = dateISO.split("-").map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const monday = addDays(dateISO, -((weekday + 6) % 7))
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index))
}

// Los formateadores se crean al formatear, con el formato regional vigente
// (`formatLocale`): a nivel de módulo quedarían fijados antes de conocer la
// clínica. Se guardan por formato para no recrearlos en cada celda.
const dateFormatters = new Map<string, Intl.DateTimeFormat>()
function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = formatLocale()
  const cacheKey = `${locale ?? ""}|${key}`
  let found = dateFormatters.get(cacheKey)
  if (!found) {
    found = new Intl.DateTimeFormat(locale, options)
    dateFormatters.set(cacheKey, found)
  }
  return found
}

const hourFormatter = () =>
  formatter("hour", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** «08:00» para minutos del día; zona UTC porque el valor ya es local de la sede. */
export function hourLabel(minutes: number): string {
  return hourFormatter().format(new Date(Date.UTC(2026, 0, 1, 0, minutes)))
}

/** «08:00 – 09:00» en la zona de la sede. */
export function timeRangeLabel(startISO: string, endISO: string, timeZone: string): string {
  const withZone = new Intl.DateTimeFormat(formatLocale(), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  return `${withZone.format(new Date(startISO))} – ${withZone.format(new Date(endISO))}`
}

const longDateFormatter = () =>
  formatter("long", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
const shortDateFormatter = () =>
  formatter("short", { timeZone: "UTC", weekday: "short", day: "numeric" })
const monthShortFormatter = () => formatter("month", { timeZone: "UTC", month: "short" })
const dayMonthYearFormatter = () =>
  formatter("dmy", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" })

/** Mediodía UTC del día civil: ningún formato lo corre al día anterior o al siguiente. */
function noonOf(dateISO: string): Date {
  const [year, month, day] = dateISO.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day, 12))
}

function dateParts(dateISO: string): Map<string, string> {
  const parts = longDateFormatter().formatToParts(noonOf(dateISO))
  return new Map(parts.map((part) => [part.type, part.value]))
}

/** El año de la fecha, solo si no es el año en curso de la clínica. */
function otherYear(dateISO: string): string | null {
  const year = dateISO.slice(0, 4)
  return year === regionToday().slice(0, 4) ? null : String(Number(year))
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/**
 * Fecha rotulada para barras y nombres accesibles: «Lunes 21 de setiembre».
 * Lleva el año cuando no es el año en curso de la clínica («Lunes 4 de enero
 * de 2027»): sin él, una fecha de otro año se confunde con la de este. Se
 * compone por partes porque algunos formatos regionales meten una coma entre
 * el día de la semana y el del mes.
 */
export function formatDateLong(dateISO: string): string {
  const parts = dateParts(dateISO)
  const said = `${capitalize(parts.get("weekday") ?? "")} ${parts.get("day")} de ${parts.get("month")}`
  const year = otherYear(dateISO)
  return year ? `${said} de ${year}` : said
}

/** «setiembre», o «enero de 2027» si no es el año en curso de la clínica. */
export function formatMonthLong(dateISO: string): string {
  // El mes dentro de una fecha («21 de setiembre»), no el suelto: algunos
  // formatos regionales escriben el suelto con mayúscula.
  const month = dateParts(dateISO).get("month") ?? ""
  const year = otherYear(dateISO)
  return year ? `${month} de ${year}` : month
}

/**
 * «Jue 20 nov 2026»: el día con su año siempre escrito, para el botón que
 * elige un día (`DatePickerButton`). Sin puntos de abreviatura ni comas.
 */
export function formatDayMonthYear(dateISO: string): string {
  const parts = dayMonthYearFormatter().formatToParts(noonOf(dateISO))
  const get = (type: string) => (parts.find((part) => part.type === type)?.value ?? "").replace(".", "")
  return `${capitalize(get("weekday"))} ${get("day")} ${get("month")} ${get("year")}`
}
/** «lun 21» para cabeceras estrechas, sin coma. */
export function formatDayShort(dateISO: string): string {
  const [year, month, day] = dateISO.split("-").map(Number)
  const parts = shortDateFormatter().formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("weekday")} ${get("day")}`.replace(",", "")
}

/** «mar 22 sep»: día y mes siempre visibles en la cabecera del timeline. */
export function formatDayMonthShort(dateISO: string): string {
  const [year, month, day] = dateISO.split("-").map(Number)
  const at = new Date(Date.UTC(year, month - 1, day, 12))
  return `${formatDayShort(dateISO)} ${monthShortFormatter().format(at).replace(".", "")}`
}


/** Duración de una cita en minutos. */
export function durationMinutes(entry: Pick<ScheduleEntry, "start" | "end">): number {
  return Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / MINUTE_MS)
}
