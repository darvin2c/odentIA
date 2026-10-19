/**
 * Periodos de Reportes en la zona horaria de la clínica: meses completos (o el
 * mes en curso hasta ahora) o un rango de días (decisión 15), cada uno con el
 * tramo contra el que se compara. Toda cifra de la pantalla comparte el mismo
 * tramo, sea un mes o un rango.
 */
import { validation } from "./errors.js"

export interface YearMonth {
  year: number
  month: number
}

export const REPORT_PERIOD_PRESETS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"] as const
export type ReportPeriodPreset = (typeof REPORT_PERIOD_PRESETS)[number]

/** Un mes: `2026-09`. Un rango de días: `2026-09-10..2026-09-25` (ambos incluidos). */
export const REPORT_PERIOD_PATTERN = /^(este_mes|mes_pasado|ultimos_3_meses|este_ano|\d{4}-(0[1-9]|1[0-2])|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/

/** Un rango abarca como mucho dos años. */
export const REPORT_RANGE_MAX_DAYS = 731

/** Tramo semiabierto [start, end) y los meses civiles que toca. */
export interface ReportSpan {
  from: YearMonth
  to: YearMonth
  start: Date
  end: Date
  /** Termina ahora y no al final de su último día o mes. */
  partial: boolean
  /** En un rango, sus días (fecha local, ambos incluidos). */
  days?: { from: string; to: string }
}

/** Cómo se agrupan los gráficos del periodo: por mes, por semana o por día. */
export type ReportGrain = "month" | "week" | "day"

export interface ReportWindow extends ReportSpan {
  /** La opción pedida: un preajuste, `YYYY-MM` o un rango. */
  key: string
  kind: "months" | "range"
  grain: ReportGrain
  previous: ReportSpan
}

const FIRST_YEAR = 2000
const LAST_YEAR = 2100
const DAY_MS = 86_400_000

function offsetMinutesAt(timezone: string, utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utc)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return (
    (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second")) -
      utc.getTime()) /
    60000
  )
}

/** Primer instante de un día civil en la zona horaria indicada. */
export function dayStart(timezone: string, year: number, month: number, day: number): Date {
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR + 1) throw validation("Año inválido")
  if (!Number.isInteger(month) || month < 1 || month > 12) throw validation("Mes inválido")
  let utc = Date.UTC(year, month - 1, day, 0, 0, 0)
  for (let i = 0; i < 3; i += 1) utc = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutesAt(timezone, new Date(utc)) * 60000
  return new Date(utc)
}

/** Primer instante de un mes civil en la zona horaria indicada. */
export function monthStart(timezone: string, year: number, month: number): Date {
  return dayStart(timezone, year, month, 1)
}

/** Mes civil que corre en la zona horaria indicada. */
export function currentMonthIn(timezone: string, now: Date = new Date()): YearMonth {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
}

/** Día civil (`YYYY-MM-DD`) de un instante en la zona horaria indicada. */
export function reportDayOf(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
}

/** Suma días a una fecha civil `YYYY-MM-DD`. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10)
}

function startOfDay(timezone: string, day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return dayStart(timezone, year, month, date)
}

function monthOfDay(day: string): YearMonth {
  const [year, month] = day.split("-").map(Number) as [number, number]
  return { year, month }
}

/** Días de `from` a `to`, ambos incluidos. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1
}

export function addMonths(value: YearMonth, delta: number): YearMonth {
  const index = value.year * 12 + (value.month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

export function compareMonths(a: YearMonth, b: YearMonth): number {
  return a.year - b.year || a.month - b.month
}

/** Meses civiles de un tramo, en orden. */
export function monthsOf(span: Pick<ReportSpan, "from" | "to">): YearMonth[] {
  const months: YearMonth[] = []
  for (let cursor = span.from; compareMonths(cursor, span.to) <= 0; cursor = addMonths(cursor, 1)) months.push(cursor)
  return months
}

/** Un rango de hasta 31 días se mira por día; hasta 6 meses, por semana; más, por mes. */
export function grainOfDays(days: number): ReportGrain {
  return days <= 31 ? "day" : days <= 183 ? "week" : "month"
}

/**
 * Tramo de una opción de periodo y el tramo anterior con el que se compara:
 * el mismo número de meses (o de días, en un rango) justo antes; un tramo que
 * termina ahora se compara con el mismo tiempo transcurrido del anterior, no
 * con el tramo entero.
 */
export function resolveReportWindow(timezone: string, key: string, now: Date = new Date()): ReportWindow {
  const current = currentMonthIn(timezone, now)
  const startOf = (value: YearMonth): Date => monthStart(timezone, value.year, value.month)
  const full = (from: YearMonth, to: YearMonth): ReportSpan => ({
    from,
    to,
    start: startOf(from),
    end: startOf(addMonths(to, 1)),
    partial: false,
  })
  const months = (window: Omit<ReportWindow, "kind" | "grain">): ReportWindow => ({ ...window, kind: "months", grain: "month" })
  const untilNow = (from: YearMonth, previousFrom: YearMonth, previousTo: YearMonth): ReportWindow => {
    const start = startOf(from)
    const previousStart = startOf(previousFrom)
    const previousLimit = startOf(addMonths(previousTo, 1)).getTime()
    const previousEnd = Math.min(previousStart.getTime() + (now.getTime() - start.getTime()), previousLimit)
    return months({
      key,
      from,
      to: current,
      start,
      end: now,
      partial: true,
      previous: { from: previousFrom, to: previousTo, start: previousStart, end: new Date(previousEnd), partial: true },
    })
  }
  const monthsBack = (count: number): ReportWindow => {
    const to = addMonths(current, -1)
    const from = addMonths(current, -count)
    return months({ key, ...full(from, to), previous: full(addMonths(from, -count), addMonths(to, -count)) })
  }

  if (key === "este_mes") return untilNow(current, addMonths(current, -1), addMonths(current, -1))
  if (key === "mes_pasado") return monthsBack(1)
  if (key === "ultimos_3_meses") return monthsBack(3)
  if (key === "este_ano")
    return untilNow({ year: current.year, month: 1 }, { year: current.year - 1, month: 1 }, { year: current.year - 1, month: current.month })

  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (range) return resolveRange(timezone, key, range[1] as string, range[2] as string, now)

  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key)
  if (!match) throw validation("Periodo no reconocido")
  const chosen = { year: Number(match[1]), month: Number(match[2]) }
  if (chosen.year < FIRST_YEAR || chosen.year > LAST_YEAR) throw validation("Año inválido")
  const order = compareMonths(chosen, current)
  if (order > 0) throw validation("Ese mes todavía no empieza")
  if (order === 0) return untilNow(current, addMonths(current, -1), addMonths(current, -1))
  return months({ key, ...full(chosen, chosen), previous: full(addMonths(chosen, -1), addMonths(chosen, -1)) })
}

/**
 * Un rango de días: del primer instante de `from` al final de `to` (o hasta
 * ahora si `to` es hoy), comparado con los mismos días justo antes: del 10 al
 * 25 de septiembre contra el 25 de agosto al 9 de septiembre.
 */
function resolveRange(timezone: string, key: string, from: string, to: string, now: Date): ReportWindow {
  const valid = (day: string): boolean => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    const parsed = new Date(Date.UTC(year, month - 1, date))
    return year >= FIRST_YEAR && year <= LAST_YEAR && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date
  }
  if (!valid(from) || !valid(to)) throw validation("Periodo no reconocido")
  if (from > to) throw validation("El rango empieza después de terminar")
  const today = reportDayOf(timezone, now)
  if (to > today) throw validation("Ese día todavía no pasa")
  const count = daysBetween(from, to)
  if (count > REPORT_RANGE_MAX_DAYS) throw validation("Un rango abarca como mucho dos años")
  const start = startOfDay(timezone, from)
  const partial = to === today
  const end = partial ? now : startOfDay(timezone, addDays(to, 1))
  const previousFrom = addDays(from, -count)
  const previousTo = addDays(from, -1)
  const previousStart = startOfDay(timezone, previousFrom)
  const previousEnd = partial ? new Date(previousStart.getTime() + (now.getTime() - start.getTime())) : start
  return {
    key,
    kind: "range",
    grain: grainOfDays(count),
    from: monthOfDay(from),
    to: monthOfDay(to),
    start,
    end,
    partial,
    days: { from, to },
    previous: {
      from: monthOfDay(previousFrom),
      to: monthOfDay(previousTo),
      start: previousStart,
      end: previousEnd,
      partial,
      days: { from: previousFrom, to: previousTo },
    },
  }
}

/** Un tramo del gráfico: un mes, una semana o un día, recortado al periodo. */
export interface ReportBucket {
  key: string
  start: Date
  end: Date
  /** No está completo: el periodo lo corta o todavía corre. */
  partial: boolean
  /** Primer y último día del tramo (fecha local). */
  firstDay: string
  lastDay: string
}

/**
 * Tramos del gráfico de un periodo. Meses: los 12 que terminan en el último
 * mes del periodo, como hoy. Rango: por día, por semana (de lunes a domingo)
 * o por mes según su largo, recortados al rango.
 */
export function reportBuckets(timezone: string, window: ReportWindow): ReportBucket[] {
  if (window.kind === "months") return lastMonths(timezone, window.to, 12, window.end)
  const days = window.days as { from: string; to: string }
  const out: ReportBucket[] = []
  let cursor = days.from
  while (cursor <= days.to) {
    let last: string
    if (window.grain === "day") last = cursor
    else if (window.grain === "week") {
      const weekday = (new Date(`${cursor}T00:00:00Z`).getUTCDay() + 6) % 7
      last = addDays(cursor, 6 - weekday)
    } else {
      const month = monthOfDay(cursor)
      last = addDays(`${addMonths(month, 1).year}-${String(addMonths(month, 1).month).padStart(2, "0")}-01`, -1)
    }
    if (last > days.to) last = days.to
    const start = startOfDay(timezone, cursor)
    const naturalEnd = startOfDay(timezone, addDays(last, 1))
    const end = naturalEnd.getTime() > window.end.getTime() ? window.end : naturalEnd
    const whole = window.grain === "day" || (window.grain === "week" ? daysBetween(cursor, last) === 7 : cursor.endsWith("-01") && addDays(last, 1).endsWith("-01"))
    out.push({ key: cursor, start, end, partial: !whole || end.getTime() < naturalEnd.getTime(), firstDay: cursor, lastDay: last })
    cursor = addDays(last, 1)
  }
  return out
}

/** Los `count` meses que terminan en `to`; el último se corta en `until` si todavía corre. */
export function lastMonths(timezone: string, to: YearMonth, count: number, until: Date): ReportBucket[] {
  return Array.from({ length: count }, (_, index) => {
    const month = addMonths(to, index - count + 1)
    const start = monthStart(timezone, month.year, month.month)
    const next = addMonths(month, 1)
    const naturalEnd = monthStart(timezone, next.year, next.month)
    const end = naturalEnd.getTime() > until.getTime() ? until : naturalEnd
    const first = `${month.year}-${String(month.month).padStart(2, "0")}-01`
    return {
      key: `${month.year}-${String(month.month).padStart(2, "0")}`,
      start,
      end,
      partial: end.getTime() < naturalEnd.getTime(),
      firstDay: first,
      lastDay: reportDayOf(timezone, new Date(end.getTime() - 1)),
    }
  })
}

/** El mismo tramo un año antes (para la línea «Un año antes»). */
export function yearBefore(timezone: string, bucket: ReportBucket): ReportBucket {
  const shift = (day: string): string => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`
  const firstDay = shift(bucket.firstDay)
  // Un 29 de febrero un año antes es el 28.
  const lastDay = bucket.lastDay.endsWith("-02-29") ? `${Number(bucket.lastDay.slice(0, 4)) - 1}-02-28` : shift(bucket.lastDay)
  const start = startOfDay(timezone, firstDay)
  const naturalEnd = startOfDay(timezone, addDays(lastDay, 1))
  const end = bucket.partial ? new Date(start.getTime() + (bucket.end.getTime() - bucket.start.getTime())) : naturalEnd
  return { key: `${bucket.key}-antes`, start, end: end.getTime() > naturalEnd.getTime() ? naturalEnd : end, partial: bucket.partial, firstDay, lastDay }
}
