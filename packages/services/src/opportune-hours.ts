/**
 * Horas de un horario semanal: si un instante cae dentro, el primero y el
 * último momento permitido. Sirve al «Horario para escribir» (decisión 18 v3,
 * `writing-hours.ts`): cuándo odentIA le escribe a alguien por su cuenta, por
 * día y con la hora de cada sede; un día sin tramos no se escribe. También al
 * horario propio del agente («A qué horas responde»), que va aparte.
 *
 * Funciones puras: reciben el horario ya leído y el instante; nunca la hora real.
 */

/** Tramo del día en minutos locales, semiabierto: [inicio, fin). */
export type MinuteRange = [number, number]

export interface OpportuneSchedule {
  timeZone: string
  /** Por día de la semana (0 = domingo), los tramos permitidos; vacío = ese día no. */
  week: MinuteRange[][]
  /** Horario del agente (`activeFromMin`/`activeUntilMin`) que lo acota; puede cruzar la medianoche. Nulo = sin acotar. */
  agent?: { fromMin: number; untilMin: number } | null
}

/** Cuántos días se busca hacia adelante o atrás antes de rendirse (un horario sin tramos). */
const SEARCH_DAYS = 9

const DAY_MS = 86_400_000

/** Suma de tramos que se tocan o se pisan. */
export function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  return merge(ranges)
}

function merge(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = [...ranges].filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  const out: MinuteRange[] = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

function intersect(a: MinuteRange[], b: MinuteRange[]): MinuteRange[] {
  const out: MinuteRange[] = []
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart)
      const end = Math.min(aEnd, bEnd)
      if (end > start) out.push([start, end])
    }
  }
  return merge(out)
}

/** Los tramos permitidos de un día de la semana, ya recortados por el horario del agente. */
export function opportuneRangesOn(schedule: OpportuneSchedule, weekday: number): MinuteRange[] {
  const day = merge(schedule.week[weekday] ?? [])
  const agent = schedule.agent
  if (!agent) return day
  const agentRanges: MinuteRange[] =
    agent.fromMin < agent.untilMin
      ? [[agent.fromMin, agent.untilMin]]
      : [
          [0, agent.untilMin],
          [agent.fromMin, 1440],
        ]
  return intersect(day, agentRanges)
}

interface LocalDay {
  year: number
  month: number
  day: number
  weekday: number
  minute: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Fecha, día de la semana y minuto del día de un instante en la zona dada. */
export function localDayOf(at: Date, timeZone: string): LocalDay {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0"
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: WEEKDAYS[get("weekday")] ?? 0,
    minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  }
}

function offsetMinutes(timeZone: string, utc: number): number {
  const local = localDayOf(new Date(utc), timeZone)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, Math.floor(local.minute / 60), local.minute % 60)
  // Los segundos del instante no cuentan: el reloj local se compara al minuto.
  return Math.round((asUtc - Math.floor(utc / 60_000) * 60_000) / 60_000)
}

/** El instante en que el reloj de la zona marca ese día y ese minuto. */
export function localToInstant(timeZone: string, year: number, month: number, day: number, minute: number): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minute)
  let utc = wall
  for (let i = 0; i < 3; i++) utc = wall - offsetMinutes(timeZone, utc) * 60_000
  return new Date(utc)
}

/** El día local `offset` días después (o antes) del de `at`. */
function shiftedDay(at: Date, timeZone: string, offset: number): LocalDay {
  const base = localDayOf(at, timeZone)
  const noon = Date.UTC(base.year, base.month - 1, base.day, 12) + offset * DAY_MS
  const date = new Date(noon)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    minute: 0,
  }
}

/** Las 0:00 del día local siguiente al de `at`. */
export function startOfNextLocalDay(at: Date, timeZone: string): Date {
  const next = shiftedDay(at, timeZone, 1)
  return localToInstant(timeZone, next.year, next.month, next.day, 0)
}

/** Tramos oportunos de un día local, como instantes. */
function windowsOf(schedule: OpportuneSchedule, day: LocalDay): Array<{ start: Date; end: Date }> {
  return opportuneRangesOn(schedule, day.weekday).map(([start, end]) => ({
    start: localToInstant(schedule.timeZone, day.year, day.month, day.day, start),
    end: localToInstant(schedule.timeZone, day.year, day.month, day.day, end),
  }))
}

export function isOpportune(at: Date, schedule: OpportuneSchedule): boolean {
  const day = localDayOf(at, schedule.timeZone)
  return opportuneRangesOn(schedule, day.weekday).some(([start, end]) => day.minute >= start && day.minute < end)
}

/** El primer momento oportuno desde `at` (el mismo `at` si ya lo es). Nulo si no hay ninguno en nueve días. */
export function nextOpportuneFrom(at: Date, schedule: OpportuneSchedule): Date | null {
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    for (const window of windowsOf(schedule, shiftedDay(at, schedule.timeZone, offset))) {
      if (at.getTime() < window.start.getTime()) return window.start
      if (at.getTime() < window.end.getTime()) return at
    }
  }
  return null
}

/**
 * El último momento oportuno hasta `at` (el mismo `at` si ya lo es; si no, el
 * último minuto del tramo anterior). Nulo si no hay ninguno en nueve días.
 */
export function lastOpportuneAtOrBefore(at: Date, schedule: OpportuneSchedule): Date | null {
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const windows = windowsOf(schedule, shiftedDay(at, schedule.timeZone, -offset)).reverse()
    for (const window of windows) {
      if (at.getTime() >= window.end.getTime()) return new Date(window.end.getTime() - 60_000)
      if (at.getTime() >= window.start.getTime()) return at
    }
  }
  return null
}

/**
 * Cuándo vuelve a responder el agente con su horario propio: el próximo inicio
 * de su franja desde `at`, o `at` si ya está dentro. Sin horario, `at`.
 */
export function nextAgentOpening(at: Date, timeZone: string, agent: OpportuneSchedule["agent"] = null): Date {
  if (!agent) return at
  const always: OpportuneSchedule = { timeZone, week: Array.from({ length: 7 }, () => [[0, 1440]]), agent }
  return nextOpportuneFrom(at, always) ?? at
}

/** ¿Está el agente dentro de su horario propio en `at`? Sin horario, siempre. */
export function insideAgentHours(at: Date, timeZone: string, agent: OpportuneSchedule["agent"] = null): boolean {
  if (!agent) return true
  const { minute } = localDayOf(at, timeZone)
  return agent.fromMin < agent.untilMin
    ? minute >= agent.fromMin && minute < agent.untilMin
    : minute >= agent.fromMin || minute < agent.untilMin
}
