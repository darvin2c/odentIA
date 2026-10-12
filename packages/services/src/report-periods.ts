/**
 * Periodos de Reportes: meses completos (o el mes en curso hasta ahora) en la
 * zona horaria de la clínica, cada uno con el tramo contra el que se compara.
 * Sin rangos libres: así toda cifra de la pantalla comparte el mismo tramo.
 */
import { validation } from "./errors.js"

export interface YearMonth {
  year: number
  month: number
}

export const REPORT_PERIOD_PRESETS = ["este_mes", "mes_pasado", "ultimos_3_meses", "este_ano"] as const
export type ReportPeriodPreset = (typeof REPORT_PERIOD_PRESETS)[number]

/** Tramo semiabierto [start, end) y los meses civiles que toca. */
export interface ReportSpan {
  from: YearMonth
  to: YearMonth
  start: Date
  end: Date
  /** Termina ahora y no al final del mes. */
  partial: boolean
}

export interface ReportWindow extends ReportSpan {
  /** La opción pedida: un preajuste o `YYYY-MM`. */
  key: string
  previous: ReportSpan
}

const FIRST_YEAR = 2000
const LAST_YEAR = 2100

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

/** Primer instante de un mes civil en la zona horaria indicada. */
export function monthStart(timezone: string, year: number, month: number): Date {
  if (!Number.isInteger(year) || year < FIRST_YEAR || year > LAST_YEAR + 1) throw validation("Año inválido")
  if (!Number.isInteger(month) || month < 1 || month > 12) throw validation("Mes inválido")
  let utc = Date.UTC(year, month - 1, 1, 0, 0, 0)
  for (let i = 0; i < 3; i += 1)
    utc = Date.UTC(year, month - 1, 1, 0, 0, 0) - offsetMinutesAt(timezone, new Date(utc)) * 60000
  return new Date(utc)
}

/** Mes civil que corre en la zona horaria indicada. */
export function currentMonthIn(timezone: string, now: Date = new Date()): YearMonth {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).formatToParts(now)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month") }
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

/**
 * Tramo de una opción de periodo y el tramo anterior con el que se compara:
 * el mismo número de meses justo antes; un tramo que termina ahora se compara
 * con el mismo tiempo transcurrido del tramo anterior, no con el tramo entero.
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
  const untilNow = (from: YearMonth, previousFrom: YearMonth, previousTo: YearMonth): ReportWindow => {
    const start = startOf(from)
    const previousStart = startOf(previousFrom)
    const previousLimit = startOf(addMonths(previousTo, 1)).getTime()
    const previousEnd = Math.min(previousStart.getTime() + (now.getTime() - start.getTime()), previousLimit)
    return {
      key,
      from,
      to: current,
      start,
      end: now,
      partial: true,
      previous: { from: previousFrom, to: previousTo, start: previousStart, end: new Date(previousEnd), partial: true },
    }
  }
  const monthsBack = (count: number): ReportWindow => {
    const to = addMonths(current, -1)
    const from = addMonths(current, -count)
    return { key, ...full(from, to), previous: full(addMonths(from, -count), addMonths(to, -count)) }
  }

  if (key === "este_mes") return untilNow(current, addMonths(current, -1), addMonths(current, -1))
  if (key === "mes_pasado") return monthsBack(1)
  if (key === "ultimos_3_meses") return monthsBack(3)
  if (key === "este_ano")
    return untilNow({ year: current.year, month: 1 }, { year: current.year - 1, month: 1 }, { year: current.year - 1, month: current.month })

  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key)
  if (!match) throw validation("Periodo no reconocido")
  const chosen = { year: Number(match[1]), month: Number(match[2]) }
  if (chosen.year < FIRST_YEAR || chosen.year > LAST_YEAR) throw validation("Año inválido")
  const order = compareMonths(chosen, current)
  if (order > 0) throw validation("Ese mes todavía no empieza")
  if (order === 0) return untilNow(current, addMonths(current, -1), addMonths(current, -1))
  return { key, ...full(chosen, chosen), previous: full(addMonths(chosen, -1), addMonths(chosen, -1)) }
}
