/**
 * El periodo de una respuesta de Argos (ADR 0075, decisiones D8 a D16): el
 * modelo elige qué periodo pide la pregunta y contra qué compara; las fechas
 * las pone odentIA. La consulta filtra con `:desde` y `:hasta` (y lo de antes
 * con `:desde_antes` y `:hasta_antes`), la frase dice el periodo con
 * `{periodo}` y `{periodo_antes}`, y la pantalla lo muestra y lo cambia sin
 * volver a llamar al modelo.
 *
 * Los periodos de meses y de fechas son los de Reportes (`resolveReportWindow`):
 * el mismo tramo y el mismo «antes», cortado a la misma hora cuando llega a
 * hoy. A eso se suman los días, las semanas, los últimos N días (que se mueven
 * con el día) y los últimos N meses completos.
 */
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { and, asc, eq } from "drizzle-orm"
import { validation } from "./errors.js"
import {
  addDays,
  addMonths,
  currentMonthIn,
  dayStart,
  monthStart,
  REPORT_PERIOD_PATTERN,
  REPORT_RANGE_MAX_DAYS,
  reportDayOf,
  resolveReportWindow,
  type YearMonth,
} from "./report-periods.js"

/** Qué opciones ofrece el selector (D16): las de un día, las de una semana o las de Reportes. */
export type ArgosGrain = "dia" | "semana" | "mes"

/** Contra qué compara (D14 y D15): nada, el periodo anterior, el mismo del año pasado u otro que nombra la pregunta. */
export const ARGOS_COMPARES = ["no", "anterior", "año_anterior", "otro"] as const
export type ArgosCompare = (typeof ARGOS_COMPARES)[number]

/** Lo que el modelo elige y se guarda con la respuesta; `a_hoy` es lo que solo existe hoy (D12). */
export interface ArgosPeriodSpec {
  periodo: string
  compara: ArgosCompare
  /** Con `compara: "otro"`, el segundo periodo. */
  otro?: string | null
}

/** Los periodos que no son de Reportes: un día, una semana, los últimos N días o meses y «a hoy». */
const ARGOS_ONLY_PERIOD = /^(a_hoy|hoy|ayer|esta_semana|semana_pasada|ultimos_([1-9]\d{0,2})_dias|ultimos_([1-9]|1\d|2[0-4])_meses|\d{4}-\d{2}-\d{2})$/

export function isArgosPeriod(value: string): boolean {
  return ARGOS_ONLY_PERIOD.test(value) || REPORT_PERIOD_PATTERN.test(value)
}

/** Un tramo [start, end) con sus días locales, ambos incluidos. */
export interface ArgosSpan {
  start: Date
  end: Date
  /** Termina ahora: el de antes se corta a la misma hora. */
  partial: boolean
  firstDay: string
  lastDay: string
}

type SpanKind = "dia" | "semana" | "meses" | "fechas"

interface Resolved {
  key: string
  kind: SpanKind
  grain: ArgosGrain
  span: ArgosSpan
  previous: ArgosSpan
  /** Se mueve con el día (los últimos N días). */
  rolling: boolean
}

/** El periodo ya calculado, con lo que dice la pantalla y lo que llena la frase. */
export interface ArgosResolvedPeriod {
  spec: ArgosPeriodSpec
  grain: ArgosGrain
  span: ArgosSpan
  before: ArgosSpan | null
  rolling: boolean
  /** El botón: «Octubre de 2026, hasta hoy». */
  label: string
  /** Lo que sigue a «Comparado con»: «los mismos días de setiembre de 2026». Nulo si no compara o si son dos periodos (D15). */
  compareLabel: string | null
  /** El segundo botón cuando la pregunta nombra dos periodos (D15). */
  otherLabel: string | null
  /** `{periodo}` y `{periodo_antes}` de la frase: «del 1 al 21 de octubre», «en los mismos días de setiembre». */
  words: { periodo: string; periodo_antes?: string }
}

interface Zone {
  timezone: string
  locale: string
}

const DAY_MS = 86_400_000

function startOfDay(timezone: string, day: string): Date {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return dayStart(timezone, year, month, date)
}

function validDay(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const parsed = new Date(Date.UTC(year, month - 1, date))
  return year >= 2000 && year <= 2100 && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date
}

function spanOfInstants(timezone: string, start: Date, end: Date, partial: boolean): ArgosSpan {
  return { start, end, partial, firstDay: reportDayOf(timezone, start), lastDay: reportDayOf(timezone, new Date(end.getTime() - 1)) }
}

/** Un día entero, o hasta ahora si es hoy. */
function daySpan(timezone: string, day: string, now: Date): ArgosSpan {
  const start = startOfDay(timezone, day)
  const today = reportDayOf(timezone, now)
  return day === today ? spanOfInstants(timezone, start, now, true) : spanOfInstants(timezone, start, startOfDay(timezone, addDays(day, 1)), false)
}

/** El mismo largo, `days` días antes; si el tramo llega a ahora, hasta la misma hora. */
function shiftDays(timezone: string, span: ArgosSpan, days: number): ArgosSpan {
  const start = startOfDay(timezone, addDays(span.firstDay, -days))
  const end = span.partial ? new Date(start.getTime() + (span.end.getTime() - span.start.getTime())) : startOfDay(timezone, addDays(span.lastDay, 1 - days))
  return spanOfInstants(timezone, start, end, span.partial)
}

function weekday(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  // Lunes 0 … domingo 6.
  return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7
}

function resolveSpan(key: string, zone: Zone, now: Date): Resolved {
  const { timezone } = zone
  const today = reportDayOf(timezone, now)
  if (key === "hoy" || key === "ayer" || /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const day = key === "hoy" ? today : key === "ayer" ? addDays(today, -1) : key
    if (!validDay(day)) throw validation("Periodo no reconocido")
    if (day > today) throw validation("Ese día todavía no pasa")
    const span = daySpan(timezone, day, now)
    return { key, kind: "dia", grain: "dia", span, previous: shiftDays(timezone, span, 1), rolling: false }
  }
  if (key === "esta_semana" || key === "semana_pasada") {
    const monday = addDays(today, -weekday(today))
    const first = key === "esta_semana" ? monday : addDays(monday, -7)
    const start = startOfDay(timezone, first)
    const span = key === "esta_semana" ? spanOfInstants(timezone, start, now, true) : spanOfInstants(timezone, start, startOfDay(timezone, monday), false)
    return { key, kind: "semana", grain: "semana", span, previous: shiftDays(timezone, span, 7), rolling: false }
  }
  const days = /^ultimos_(\d+)_dias$/.exec(key)
  if (days) {
    const count = Number(days[1])
    if (count > REPORT_RANGE_MAX_DAYS) throw validation("Un rango abarca como mucho dos años")
    const window = resolveReportWindow(timezone, `${addDays(today, 1 - count)}..${today}`, now)
    return {
      key,
      kind: "fechas",
      grain: "mes",
      span: spanOfInstants(timezone, window.start, window.end, window.partial),
      previous: spanOfInstants(timezone, window.previous.start, window.previous.end, window.previous.partial),
      rolling: true,
    }
  }
  const months = /^ultimos_(\d+)_meses$/.exec(key)
  if (months) {
    const count = Number(months[1])
    const current = currentMonthIn(timezone, now)
    const start = (value: YearMonth) => monthStart(timezone, value.year, value.month)
    return {
      key,
      kind: "meses",
      grain: "mes",
      span: spanOfInstants(timezone, start(addMonths(current, -count)), start(current), false),
      previous: spanOfInstants(timezone, start(addMonths(current, -2 * count)), start(addMonths(current, -count)), false),
      rolling: false,
    }
  }
  if (!REPORT_PERIOD_PATTERN.test(key)) throw validation("Periodo no reconocido")
  // Los de Reportes: el mismo tramo y el mismo «antes» que la pantalla.
  const window = resolveReportWindow(timezone, key, now)
  return {
    key,
    kind: window.kind === "range" ? "fechas" : "meses",
    grain: "mes",
    span: spanOfInstants(timezone, window.start, window.end, window.partial),
    previous: spanOfInstants(timezone, window.previous.start, window.previous.end, window.previous.partial),
    rolling: false,
  }
}

/** El mismo tramo un año antes; si llega a ahora, hasta la misma hora de ese día. */
function yearBefore(timezone: string, span: ArgosSpan): ArgosSpan {
  const back = (day: string) => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    // El 29 de febrero pasa al 28.
    const last = new Date(Date.UTC(year - 1, month, 0)).getUTCDate()
    return `${year - 1}-${String(month).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`
  }
  const start = startOfDay(timezone, back(span.firstDay))
  const end = span.partial
    ? new Date(startOfDay(timezone, back(span.lastDay)).getTime() + (span.end.getTime() - startOfDay(timezone, span.lastDay).getTime()))
    : startOfDay(timezone, addDays(back(span.lastDay), 1))
  return spanOfInstants(timezone, start, end, span.partial)
}

// --- Cómo se dice ----------------------------------------------------------------------

function capitalize(text: string, locale: string): string {
  return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1)
}

function partsOf(day: string): { year: number; month: number; date: number } {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return { year, month, date }
}

function monthWords(locale: string, year: number, month: number, withYear: boolean): string {
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "long", ...(withYear ? { year: "numeric" } : {}) })
    .format(new Date(Date.UTC(year, month - 1, 15)))
    .toLocaleLowerCase(locale)
}

function dayWords(locale: string, day: string, withYear: boolean): string {
  const { year, month, date } = partsOf(day)
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "long", ...(withYear ? { year: "numeric" } : {}) })
    .format(new Date(Date.UTC(year, month - 1, date)))
    .toLocaleLowerCase(locale)
}

function lastDayOfMonth(day: string): boolean {
  const { year, month, date } = partsOf(day)
  return new Date(Date.UTC(year, month, 0)).getUTCDate() === date
}

/** Empieza el 1 y termina el último día de un mes (o hoy, si es el mes en curso hasta ahora). */
function monthAligned(span: ArgosSpan): boolean {
  return partsOf(span.firstDay).date === 1 && (lastDayOfMonth(span.lastDay) || span.partial)
}

/** «1 al 15 de octubre», «24 de julio al 21 de octubre», con el año si no es este o si cruza de año. */
function rangeWords(locale: string, span: ArgosSpan, thisYear: number, forceYear = false): string {
  const a = partsOf(span.firstDay)
  const b = partsOf(span.lastDay)
  const year = forceYear || b.year !== thisYear || a.year !== b.year
  if (span.firstDay === span.lastDay) return dayWords(locale, span.firstDay, year)
  if (a.year !== b.year) return `${dayWords(locale, span.firstDay, true)} al ${dayWords(locale, span.lastDay, true)}`
  if (a.month === b.month) return `${a.date} al ${dayWords(locale, span.lastDay, year)}`
  return `${dayWords(locale, span.firstDay, false)} al ${dayWords(locale, span.lastDay, year)}`
}

/** «setiembre», «julio a setiembre», «octubre de 2025 a setiembre de 2026». */
function monthsWords(locale: string, span: ArgosSpan, thisYear: number, forceYear = false): string {
  const a = partsOf(span.firstDay)
  const b = partsOf(span.lastDay)
  const year = forceYear || b.year !== thisYear || a.year !== b.year
  if (a.year === b.year && a.month === b.month) return monthWords(locale, b.year, b.month, year)
  if (a.year !== b.year) return `${monthWords(locale, a.year, a.month, true)} a ${monthWords(locale, b.year, b.month, true)}`
  return `${monthWords(locale, a.year, a.month, false)} a ${monthWords(locale, b.year, b.month, year)}`
}

function timeWords(locale: string, timezone: string, at: Date): string {
  return new Intl.DateTimeFormat(locale, { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)
}

/** El botón del periodo, con las palabras de Reportes. */
function labelOf(resolved: Resolved, zone: Zone, now: Date): string {
  const { locale, timezone } = zone
  const { span } = resolved
  const today = reportDayOf(timezone, now)
  if (resolved.kind === "dia") {
    if (span.firstDay === today) return `Hoy, hasta las ${timeWords(locale, timezone, now)}`
    if (span.firstDay === addDays(today, -1)) return `Ayer, ${dayWords(locale, span.firstDay, false)}`
    return capitalize(dayWords(locale, span.firstDay, true), locale)
  }
  if (resolved.kind === "semana")
    return span.partial ? "Esta semana, hasta hoy" : `La semana pasada, del ${rangeWords(locale, span, partsOf(today).year)}`
  const until = span.partial ? ", hasta hoy" : ""
  if (resolved.kind === "meses" && monthAligned(span)) return `${capitalize(monthsWords(locale, span, -1, true), locale)}${until}`
  if (span.firstDay === span.lastDay) return `${capitalize(dayWords(locale, span.firstDay, true), locale)}${until}`
  return `Del ${rangeWords(locale, span, -1, true)}${until}`
}

/** Lo que sigue a «Comparado con», como en Reportes. */
function compareLabelOf(resolved: Resolved, compare: ArgosCompare, before: ArgosSpan, zone: Zone): string | null {
  const { locale } = zone
  const { span } = resolved
  if (compare === "no" || compare === "otro") return null
  const sameMonth = (s: ArgosSpan) => s.firstDay.slice(0, 7) === s.lastDay.slice(0, 7)
  if (resolved.kind === "dia") return compare === "anterior" ? (span.partial ? "el día anterior, hasta la misma hora" : "el día anterior") : dayWords(locale, before.firstDay, true)
  if (resolved.kind === "semana")
    return compare === "anterior"
      ? span.partial
        ? "los mismos días de la semana anterior"
        : "la semana anterior"
      : `la misma semana de ${partsOf(before.lastDay).year}`
  if (resolved.kind === "meses" && monthAligned(span)) {
    if (!before.partial) return monthsWords(locale, before, -1, true)
    const b = partsOf(before.lastDay)
    return sameMonth(before) ? `los mismos días de ${monthWords(locale, b.year, b.month, true)}` : `el mismo tramo de ${monthsWords(locale, before, -1, true)}`
  }
  if (compare === "año_anterior") return rangeWords(locale, before, -1, true)
  const days = Math.round((before.end.getTime() - before.start.getTime()) / DAY_MS)
  return days <= 1 && before.firstDay === before.lastDay ? `el día anterior: ${dayWords(locale, before.firstDay, true)}` : `los mismos días justo antes: ${rangeWords(locale, before, -1, true)}`
}

/** `{periodo}`: «del 1 al 21 de octubre», «en setiembre», «hoy», «esta semana». */
function phraseOf(resolved: Pick<Resolved, "kind" | "span">, zone: Zone, now: Date, forceYear = false): string {
  const { locale, timezone } = zone
  const { span } = resolved
  const today = reportDayOf(timezone, now)
  const thisYear = partsOf(today).year
  if (resolved.kind === "dia" || span.firstDay === span.lastDay) {
    if (!forceYear && span.firstDay === today) return "hoy"
    if (!forceYear && span.firstDay === addDays(today, -1)) return "ayer"
    return `el ${dayWords(locale, span.firstDay, forceYear || partsOf(span.firstDay).year !== thisYear)}`
  }
  if (resolved.kind === "semana" && !forceYear) return span.partial ? "esta semana" : "la semana pasada"
  if (monthAligned(span) && !span.partial) {
    const single = span.firstDay.slice(0, 7) === span.lastDay.slice(0, 7)
    return `${single ? "en" : "de"} ${monthsWords(locale, span, thisYear, forceYear)}`
  }
  return `del ${rangeWords(locale, span, thisYear, forceYear)}`
}

/** `{periodo_antes}`: «en los mismos días de setiembre», «en agosto», «en los 15 días anteriores». */
function beforePhraseOf(resolved: Resolved, compare: ArgosCompare, before: ArgosSpan, other: Resolved | null, zone: Zone, now: Date): string {
  const { locale } = zone
  if (compare === "otro" && other) return phraseOf(other, zone, now)
  const b = partsOf(before.lastDay)
  const sameMonth = before.firstDay.slice(0, 7) === before.lastDay.slice(0, 7)
  if (compare === "año_anterior") {
    if (resolved.kind === "semana") return `en la misma semana de ${b.year}`
    if (before.partial && monthAligned(resolved.span))
      return sameMonth ? `en los mismos días de ${monthWords(locale, b.year, b.month, true)}` : `en el mismo tramo de ${b.year}`
    return phraseOf({ kind: resolved.kind, span: before }, zone, now, true)
  }
  if (resolved.kind === "dia") return "el día anterior"
  if (resolved.kind === "semana") return resolved.span.partial ? "en los mismos días de la semana anterior" : "la semana anterior"
  if (resolved.kind === "meses" && monthAligned(resolved.span)) {
    if (!before.partial) return phraseOf({ kind: "meses", span: before }, zone, now)
    return sameMonth ? `en los mismos días de ${monthWords(locale, b.year, b.month, b.year !== partsOf(reportDayOf(zone.timezone, now)).year)}` : `en el mismo tramo de ${b.year}`
  }
  const days = Math.round((startOfDay(zone.timezone, addDays(before.lastDay, 1)).getTime() - startOfDay(zone.timezone, before.firstDay).getTime()) / DAY_MS)
  return days === 1 ? "el día anterior" : `en los ${days} días anteriores`
}

/**
 * Calcula el periodo de una respuesta: el tramo, lo de antes según `compara` y
 * cómo se dice cada cosa. Un periodo que no se reconoce, que aún no pasa o
 * más largo que dos años es un error de validación (el modelo lo corrige o la
 * pantalla lo dice). `a_hoy` no tiene periodo: null.
 */
export function resolveArgosPeriod(spec: ArgosPeriodSpec, zone: Zone, now: Date = new Date()): ArgosResolvedPeriod | null {
  if (spec.periodo === "a_hoy") return null
  if (!isArgosPeriod(spec.periodo)) throw validation("Periodo no reconocido")
  const resolved = resolveSpan(spec.periodo, zone, now)
  let before: ArgosSpan | null = null
  let other: Resolved | null = null
  if (spec.compara === "anterior") before = resolved.previous
  else if (spec.compara === "año_anterior") before = yearBefore(zone.timezone, resolved.span)
  else if (spec.compara === "otro") {
    if (!spec.otro || spec.otro === "a_hoy" || !isArgosPeriod(spec.otro)) throw validation("Falta el segundo periodo")
    other = resolveSpan(spec.otro, zone, now)
    before = other.span
  }
  return {
    spec: { periodo: spec.periodo, compara: spec.compara, ...(spec.compara === "otro" ? { otro: spec.otro ?? null } : {}) },
    grain: resolved.grain,
    span: resolved.span,
    before,
    rolling: resolved.rolling,
    label: labelOf(resolved, zone, now),
    compareLabel: before ? compareLabelOf(resolved, spec.compara, before, zone) : null,
    otherLabel: other ? labelOf(other, zone, now) : null,
    words: {
      periodo: phraseOf(resolved, zone, now),
      ...(before ? { periodo_antes: beforePhraseOf(resolved, spec.compara, before, other, zone, now) } : {}),
    },
  }
}

/** «A hoy, 21 de octubre, 15:40»: lo que no lleva periodo (D12). */
export function argosTodayLabel(zone: Zone, now: Date = new Date()): string {
  return `A hoy, ${dayWords(zone.locale, reportDayOf(zone.timezone, now), false)}, ${timeWords(zone.locale, zone.timezone, now)}`
}

// --- La consulta con el periodo y la sede -----------------------------------------------

/** Los nombres que el modelo escribe en la consulta; odentIA pone su valor. */
const PLACEHOLDER = /(?<![:\w]):(dia_desde_antes|dia_hasta_antes|desde_antes|hasta_antes|dia_desde|dia_hasta|desde|hasta|sede)\b/g
const LITERAL_SPLIT = /('(?:[^']|'')*')/

/** Los nombres de periodo y sede que usa una consulta, fuera de los textos entre comillas. */
export function argosPlaceholders(query: string): Set<string> {
  const used = new Set<string>()
  query.split(LITERAL_SPLIT).forEach((part, index) => {
    if (index % 2 === 1) return
    for (const match of part.matchAll(PLACEHOLDER)) used.add(match[1] ?? "")
  })
  return used
}

/** La consulta usa la sede elegida (`:sede`): la pantalla ofrece cambiarla (D13). */
export function argosUsesBranch(query: string): boolean {
  return argosPlaceholders(query).has("sede")
}

/**
 * Pone las fechas y la sede en la consulta. Un instante va como `timestamptz`
 * y un día como `date`, ambos del servidor; la sede, como texto entre comillas
 * (con sus comillas dobladas) o nulo para todas. Devuelve el problema para el
 * modelo si la consulta no usa el periodo que eligió o usa lo de antes sin
 * comparar.
 */
export function bindArgosPeriod(
  query: string,
  period: ArgosResolvedPeriod | null,
  sede: string | null,
): { sql: string } | { problem: string } {
  const used = argosPlaceholders(query)
  const usesNow = ["desde", "hasta", "dia_desde", "dia_hasta"].some((name) => used.has(name))
  const usesBefore = ["desde_antes", "hasta_antes", "dia_desde_antes", "dia_hasta_antes"].some((name) => used.has(name))
  if (!period && (usesNow || usesBefore)) return { problem: "el periodo es a_hoy: la consulta no usa :desde ni :hasta (o elige el periodo que pide la pregunta)" }
  if (period && !usesNow) return { problem: "la consulta no usa el periodo: filtra con :desde y :hasta (o :dia_desde y :dia_hasta si la vista solo tiene dia); nunca fechas escritas ni current_date" }
  if (period && !period.before && usesBefore) return { problem: "la consulta usa lo de antes (:desde_antes), pero compara es «no»" }
  if (period?.before && !usesBefore) return { problem: "compara pide lo de antes: fíltralo con :desde_antes y :hasta_antes" }
  const instant = (at: Date) => `timestamptz '${at.toISOString()}'`
  const day = (value: string) => `date '${value}'`
  const values: Record<string, string> = { sede: sede === null ? "null::text" : `'${sede.replace(/'/g, "''")}'` }
  if (period) {
    values.desde = instant(period.span.start)
    values.hasta = instant(period.span.end)
    values.dia_desde = day(period.span.firstDay)
    values.dia_hasta = day(addDays(period.span.lastDay, 1))
    if (period.before) {
      values.desde_antes = instant(period.before.start)
      values.hasta_antes = instant(period.before.end)
      values.dia_desde_antes = day(period.before.firstDay)
      values.dia_hasta_antes = day(addDays(period.before.lastDay, 1))
    }
  }
  const sql = query
    .split(LITERAL_SPLIT)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? `:${name}`)))
    .join("")
  return { sql }
}

/** Las sedes activas de la clínica, para elegir una en la respuesta (D13). */
export async function listArgosBranches(tx: Db, orgId: string): Promise<Array<{ id: string; name: string }>> {
  return tx
    .select({ id: branch.id, name: branch.name })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.name))
}

/** Lo que la pantalla necesita para mostrar y cambiar el periodo de una respuesta. */
export interface ArgosPeriodView {
  /** El periodo elegido (`este_mes`, `hoy`, `2026-10`…) o `a_hoy`. */
  value: string
  /** Qué opciones ofrece el selector (D16); nulo en «a hoy». */
  grain: ArgosGrain | null
  /** El botón («Octubre de 2026, hasta hoy») o, a hoy, el texto («A hoy, 21 de octubre, 15:40»). */
  label: string
  compare: ArgosCompare
  /** Lo que sigue a «Comparado con»; nulo si no compara o si son dos periodos. */
  compareLabel: string | null
  /** El segundo periodo cuando la pregunta nombra dos (D15). */
  other: { value: string; label: string } | null
  /** Se mueve con el día (los últimos N días). */
  rolling: boolean
  /** Hoy en la clínica (`AAAA-MM-DD`): el último día que se puede elegir. */
  today: string
  /** La sede elegida (null: todas) y las de la clínica, solo si la consulta la usa y hay más de una (D13). */
  branch: { id: string | null; options: Array<{ id: string; name: string }> } | null
}

/** Las opciones que ofrece el selector según el periodo que pidió la pregunta (D16): se quedan aunque se elijan otras fechas. */
export function argosGrainOf(periodo: string): ArgosGrain {
  if (periodo === "hoy" || periodo === "ayer" || /^\d{4}-\d{2}-\d{2}$/.test(periodo)) return "dia"
  if (periodo === "esta_semana" || periodo === "semana_pasada") return "semana"
  return "mes"
}

export function argosPeriodView(
  period: ArgosResolvedPeriod | null,
  zone: Zone,
  now: Date,
  branch: { chosen: { id: string; name: string } | null; options: Array<{ id: string; name: string }>; used: boolean },
  /** Las opciones de la pregunta; sin ella, las del periodo que se ve. */
  grain?: ArgosGrain,
): ArgosPeriodView {
  const today = reportDayOf(zone.timezone, now)
  const branchView = branch.used && branch.options.length > 1 ? { id: branch.chosen?.id ?? null, options: branch.options } : null
  if (!period) return { value: "a_hoy", grain: null, label: argosTodayLabel(zone, now), compare: "no", compareLabel: null, other: null, rolling: false, today, branch: branchView }
  return {
    value: period.spec.periodo,
    grain: grain ?? period.grain,
    label: period.label,
    compare: period.spec.compara,
    compareLabel: period.compareLabel,
    other: period.spec.compara === "otro" && period.spec.otro && period.otherLabel ? { value: period.spec.otro, label: period.otherLabel } : null,
    rolling: period.rolling,
    today,
    branch: branchView,
  }
}

/** La sede por su nombre, sin mayúsculas ni tildes: «surco» es «Surco». */
export function findArgosBranch<T extends { name: string }>(branches: T[], name: string): T | null {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase()
  const wanted = fold(name)
  return branches.find((item) => fold(item.name) === wanted) ?? branches.find((item) => fold(item.name).includes(wanted) && wanted.length >= 3) ?? null
}
