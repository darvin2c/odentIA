/**
 * Reportes › Agenda: cuántas citas hubo y cómo terminaron, cuánto de la agenda
 * de cada profesional se ocupó y cuándo queda libre (decisión 4).
 *
 * «Agenda ocupada» son los minutos de citas no canceladas dentro del horario
 * de cada profesional, menos sus ausencias y los bloqueos de su sede (los
 * feriados), entre esos minutos de horario. Una cancelada libera su tiempo; lo
 * que se atendió fuera del horario no suma. Cada día usa el horario que valía
 * ese día (ADR 0060); antes del primer horario guardado se usa el de hoy y la
 * respuesta lo dice (`map.assumed`). La ocupación por unidad dental queda
 * para después: las unidades no tienen horario.
 *
 * Solo lecturas; ninguna cifra sale de un modelo.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { lastMonths, type ReportBucket } from "./report-periods.js"
import {
  at,
  hullOf,
  type ReportQuery,
  reportHead,
  reportScope,
  scopeBuckets,
  serializeBucket,
  type Span,
} from "./report-scope.js"
import { intersectSpans, subtractSpans } from "./availability.js"
import { appointmentTotalsMany, waitInRoom } from "./reports.js"

/** Minutos de horario libres de bloqueos (`availMin`) y los ocupados por citas, en una hora de un día. */
export interface AgendaSlot {
  branchId: string
  dentistUserId: string
  /** Día de la sede, `YYYY-MM-DD`. */
  day: string
  /** 0 domingo … 6 sábado. */
  weekday: number
  hour: number
  /** Inicio de la hora: para repartirla en tramos. */
  at: Date
  availMin: number
  occMin: number
}

/** Un día de horario de un profesional: lo que tenía de horario, para decir «cerrado» si un bloqueo lo tapó todo. */
export interface AgendaDay {
  branchId: string
  dentistUserId: string
  day: string
  weekday: number
  start: Date
  scheduledMin: number
  availMin: number
  occMin: number
  /** Antes del primer horario guardado: se usó el de hoy. */
  assumed: boolean
}

export interface AgendaMinutes {
  slots: AgendaSlot[]
  days: AgendaDay[]
}

const DAY_MS = 86_400_000

/** Un formateador por zona: crearlo es lo caro de Intl. */
const clocks = new Map<string, Intl.DateTimeFormat>()
function clockOf(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone)
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    clocks.set(timeZone, clock)
  }
  return clock
}

/** Diferencia entre la hora local y UTC en un instante, en milisegundos. */
function offsetAt(timeZone: string, instant: number): number {
  const parts = clockOf(timeZone).formatToParts(new Date(instant))
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value)
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant
}

/**
 * El reloj de un día civil de una sede: a qué instante corresponde cada minuto
 * del día. Un día sin cambio de hora es una suma; el día del cambio, se
 * calcula minuto a minuto.
 */
function dayClock(timeZone: string, day: string): (minute: number) => number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const base = Date.UTC(year, month - 1, date)
  const exact = (minute: number): number => {
    const guess = base + minute * 60_000
    const once = guess - offsetAt(timeZone, guess)
    return guess - offsetAt(timeZone, once)
  }
  const start = exact(0)
  const end = exact(1440)
  if (end - start === DAY_MS) return (minute) => start + minute * 60_000
  return exact
}

function addDay(day: string, delta: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, date + delta)).toISOString().slice(0, 10)
}

function localDay(timeZone: string, instant: number): string {
  const parts = clockOf(timeZone).formatToParts(new Date(instant))
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}

function length(spans: Array<[number, number]>): number {
  return spans.reduce((total, [start, end]) => total + (end - start), 0)
}

type ScheduleRow = {
  branchId: string
  dentistUserId: string
  weekday: number
  startMin: number
  endMin: number
  isActive: boolean
  validFrom: string
  validUntil: string | null
}

/**
 * Los minutos de horario y de citas de cada profesional, día por día y hora
 * por hora, en el tramo: el horario que valía cada día (o el de hoy antes del
 * primero guardado), menos los bloqueos que lo alcanzan (de su sede entera o
 * suyos), y lo que de eso ocuparon citas no canceladas. Se traen las filas
 * (horarios, bloqueos, citas) y las cuentas se hacen aquí, con las mismas
 * operaciones de tramos que la agenda (`availability.ts`).
 */
export async function agendaMinutes(tx: Db, orgId: string, span: Span, options: { branchId?: string; dentistUserId?: string } = {}): Promise<AgendaMinutes> {
  const from = span.start.getTime()
  const to = span.end.getTime()
  if (to <= from) return { slots: [], days: [] }
  const branchFilter = (column: string) => (options.branchId ? sql`and ${sql.raw(column)} = ${options.branchId}` : sql``)
  const dentistFilter = (column: string) => (options.dentistUserId ? sql`and ${sql.raw(column)} = ${options.dentistUserId}` : sql``)
  const branches = await tx.execute<{ id: string; tz: string }>(sql`
    select b.id, coalesce(b.timezone, op.timezone, 'UTC') as tz
    from branch b left join org_profile op on op.organization_id = b.organization_id
    where b.organization_id = ${orgId} ${branchFilter("b.id")}`)
  const schedules = await tx.execute<ScheduleRow>(sql`
    select s.branch_id as "branchId", s.dentist_user_id as "dentistUserId", s.weekday, s.start_min as "startMin", s.end_min as "endMin",
      s.is_active as "isActive", s.valid_from::text as "validFrom", s.valid_until::text as "validUntil"
    from professional_schedule s where s.organization_id = ${orgId} ${branchFilter("s.branch_id")} ${dentistFilter("s.dentist_user_id")}`)
  const blocks = await tx.execute<{ branchId: string; dentistUserId: string | null; start: Date | string; end: Date | string }>(sql`
    select k.branch_id as "branchId", k.dentist_user_id as "dentistUserId", k.starts_at as start, k.ends_at as end
    from schedule_block k
    where k.organization_id = ${orgId} and k.starts_at < ${at(span.end)} and k.ends_at > ${at(span.start)}
      and (k.dentist_user_id is not null or k.chair_id is null) ${branchFilter("k.branch_id")}`)
  const booked = await tx.execute<{ branchId: string; dentistUserId: string; start: Date | string; end: Date | string }>(sql`
    select a.branch_id as "branchId", a.dentist_user_id as "dentistUserId", a.starts_at as start, a.ends_at as end
    from appointment a
    where a.organization_id = ${orgId} and a.starts_at < ${at(span.end)} and a.ends_at > ${at(span.start)} and a.status <> 'cancelada'
      ${branchFilter("a.branch_id")} ${dentistFilter("a.dentist_user_id")}
    order by a.starts_at`)

  const pairKey = (branchId: string, dentistUserId: string): string => `${branchId}|${dentistUserId}`
  const byPair = new Map<string, ScheduleRow[]>()
  for (const row of schedules) {
    const key = pairKey(row.branchId, row.dentistUserId)
    const list = byPair.get(key) ?? []
    list.push(row)
    byPair.set(key, list)
  }
  const visits = new Map<string, Array<[number, number]>>()
  for (const row of booked) {
    const key = pairKey(row.branchId, row.dentistUserId)
    const list = visits.get(key) ?? []
    list.push([new Date(row.start).getTime(), new Date(row.end).getTime()])
    visits.set(key, list)
  }
  const closures = blocks.map((row) => ({ branchId: row.branchId, dentistUserId: row.dentistUserId, span: [new Date(row.start).getTime(), new Date(row.end).getTime()] as [number, number] }))

  const slots: AgendaSlot[] = []
  const days: AgendaDay[] = []
  for (const { id: branchId, tz } of branches) {
    const pairs = [...byPair.entries()].filter(([key]) => key.startsWith(`${branchId}|`))
    if (pairs.length === 0) continue
    const cursors = new Map<string, number>()
    const lastDay = localDay(tz, to - 1)
    for (let day = localDay(tz, from); day <= lastDay; day = addDay(day, 1)) {
      const clock = dayClock(tz, day)
      const dayStart = clock(0)
      const dayEnd = clock(1440)
      const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
      const hours = Array.from({ length: 25 }, (_, hour) => clock(hour * 60))
      for (const [key, rows] of pairs) {
        const dentistUserId = key.slice(branchId.length + 1)
        const first = rows.reduce((min, row) => (row.validFrom < min ? row.validFrom : min), rows[0]?.validFrom ?? day)
        const assumed = day < first
        const rules = rows.filter(
          (row) => row.weekday === weekday && (assumed ? row.isActive : row.validFrom <= day && (row.validUntil === null || row.validUntil > day)),
        )
        if (rules.length === 0) continue
        const scheduled = intersectSpans(
          rules.map((rule): [number, number] => [clock(rule.startMin), clock(rule.endMin)]),
          [[from, to]],
        )
        if (scheduled.length === 0) continue
        const cuts = closures
          .filter((block) => block.branchId === branchId && (block.dentistUserId === null || block.dentistUserId === dentistUserId))
          .map((block) => block.span)
        const free = subtractSpans(scheduled, cuts)
        // Las citas van ordenadas: cada profesional avanza su cursor día a día.
        const list = visits.get(key) ?? []
        let cursor = cursors.get(key) ?? 0
        while (cursor < list.length && (list[cursor] as [number, number])[1] <= dayStart) cursor += 1
        cursors.set(key, cursor)
        const today: Array<[number, number]> = []
        for (let index = cursor; index < list.length && (list[index] as [number, number])[0] < dayEnd; index += 1) today.push(list[index] as [number, number])
        const busy = intersectSpans(free, today)
        days.push({
          branchId,
          dentistUserId,
          day,
          weekday,
          start: new Date(dayStart),
          scheduledMin: Math.round(length(scheduled) / 60_000),
          availMin: Math.round(length(free) / 60_000),
          occMin: Math.round(length(busy) / 60_000),
          assumed,
        })
        for (let hour = 0; hour < 24; hour += 1) {
          const window: Array<[number, number]> = [[hours[hour] as number, hours[hour + 1] as number]]
          const availMs = length(intersectSpans(free, window))
          if (availMs <= 0) continue
          slots.push({
            branchId,
            dentistUserId,
            day,
            weekday,
            hour,
            at: new Date(hours[hour] as number),
            availMin: availMs / 60_000,
            occMin: length(intersectSpans(busy, window)) / 60_000,
          })
        }
      }
    }
  }
  return { slots, days }
}

/** Minutos de agenda y de citas, por profesional, en un tramo. */
export interface Occupancy {
  availMin: number
  occMin: number
  byProfessional: Array<{ userId: string; availMin: number; occMin: number }>
}

/** «Agenda ocupada» de cada tramo, a partir de los días de `agendaMinutes`. */
export function occupancyBySpan(days: AgendaDay[], spans: Span[]): Occupancy[] {
  return spans.map((span) => {
    const inside = days.filter((day) => day.start.getTime() >= span.start.getTime() && day.start.getTime() < span.end.getTime())
    const byUser = new Map<string, { availMin: number; occMin: number }>()
    for (const day of inside) {
      const entry = byUser.get(day.dentistUserId) ?? { availMin: 0, occMin: 0 }
      entry.availMin += day.availMin
      entry.occMin += day.occMin
      byUser.set(day.dentistUserId, entry)
    }
    const all = [...byUser.values()]
    return {
      availMin: all.reduce((total, item) => total + item.availMin, 0),
      occMin: all.reduce((total, item) => total + item.occMin, 0),
      byProfessional: [...byUser].map(([userId, item]) => ({ userId, ...item })),
    }
  })
}

/**
 * «Agenda ocupada» de varios tramos en una sola consulta: los minutos de
 * horario y de citas de cada profesional (`agendaMinutes`) repartidos por tramo.
 * Los días se reparten por su primer instante.
 */
export async function occupancyMany(tx: Db, orgId: string, spans: Span[], options: { branchId?: string } = {}): Promise<Occupancy[]> {
  const { days } = await agendaMinutes(tx, orgId, hullOf(spans), options)
  return occupancyBySpan(days, spans)
}

/** Primer día con horario guardado, por profesional y sede: antes de él, el mapa usa el de hoy. */
async function firstScheduleDays(tx: Db, orgId: string, branchId: string | undefined) {
  const rows = await tx.execute<{ userId: string; first: string }>(sql`
    select dentist_user_id as "userId", min(valid_from)::text as first from professional_schedule
    where organization_id = ${orgId} ${branchId ? sql`and branch_id = ${branchId}` : sql``}
    group by dentist_user_id`)
  return [...rows]
}

/** Citas del periodo de cada profesional, por cómo terminaron (la misma regla de `appointmentTotalsMany`). */
async function appointmentsByProfessional(tx: Db, orgId: string, span: Span, now: Date, branchId: string | undefined) {
  const rows = await tx.execute<{ userId: string; name: string; attended: number; noShow: number; cancelled: number; unmarked: number }>(sql`
    select a.dentist_user_id as "userId", u.name,
      count(*) filter (where a.status = 'atendida')::int as attended,
      count(*) filter (where a.status = 'no_asistio')::int as "noShow",
      count(*) filter (where a.status = 'cancelada')::int as cancelled,
      count(*) filter (where a.status in ('programada','confirmada'))::int as unmarked
    from appointment a join "user" u on u.id = a.dentist_user_id
    where a.organization_id = ${orgId} and a.starts_at >= ${at(span.start)} and a.starts_at < ${at(span.end)}
      and (a.status in ('atendida','no_asistio','cancelada') or (a.status in ('programada','confirmada') and a.ends_at < ${at(now)}))
      ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    group by a.dentist_user_id, u.name`)
  return [...rows]
}

/**
 * Reportes › Agenda: cuatro cifras (atendidas, no vinieron, canceladas, agenda
 * ocupada) con el periodo anterior y su línea de 12 meses, las citas por tramo
 * y cómo terminaron, los mapas de horas libres y una fila por profesional.
 */
export async function getAgendaReport(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const branchId = scope.branch?.id
  const months: ReportBucket[] = lastMonths(scope.timezone, window.to, 12, window.end)
  const spans: Span[] = [window, window.previous, ...months]
  const buckets = scopeBuckets(scope)
  const totals = await appointmentTotalsMany(tx, orgId, scope, [...spans, ...buckets])
  // Los mapas miran los 12 meses que terminan en el periodo; la comparación, el anterior.
  const minutes = await agendaMinutes(tx, orgId, hullOf([...spans, ...buckets]), { branchId })
  const occupancy = occupancyBySpan(minutes.days, spans)
  const byProfessional = await appointmentsByProfessional(tx, orgId, window, now, branchId)
  const wait = await waitInRoom(tx, orgId, scope, window)
  const names = new Map<string, string>()
  for (const row of byProfessional) names.set(row.userId, row.name)
  const people = [...new Set([...minutes.days.map((day) => day.dentistUserId), ...byProfessional.map((row) => row.userId)])]
  const missing = people.filter((id) => !names.has(id))
  if (missing.length > 0) {
    const rows = await tx.execute<{ id: string; name: string }>(sql`select id, name from "user" where id in (${sql.join(missing.map((id) => sql`${id}`), sql`, `)})`)
    for (const row of rows) names.set(row.id, row.name)
  }
  const firsts = await firstScheduleDays(tx, orgId, branchId)
  const twelve = { start: months[0]?.start ?? window.start, end: window.end }
  const inTwelve = (day: { start: Date }) => day.start.getTime() >= twelve.start.getTime() && day.start.getTime() < twelve.end.getTime()
  const inWindow = (instant: Date) => instant.getTime() >= window.start.getTime() && instant.getTime() < window.end.getTime()
  const nth = <T>(list: T[], index: number): T => list[index] as T
  const occupancyOf = (item: Occupancy) => ({ availMin: item.availMin, occMin: item.occMin })
  const periodOcc = nth(occupancy, 0)
  return {
    ...reportHead(scope),
    months: months.map(serializeBucket),
    appointments: {
      current: nth(totals, 0),
      previous: nth(totals, 1),
      months: totals.slice(2, 14),
    },
    occupancy: {
      current: occupancyOf(periodOcc),
      previous: occupancyOf(nth(occupancy, 1)),
      months: occupancy.slice(2).map(occupancyOf),
    },
    /** Las citas por tramo del periodo y cómo terminaron. */
    chart: buckets.map((bucket, index) => ({ ...serializeBucket(bucket), ...nth(totals, spans.length + index) })),
    /** Lo de cada profesional en el periodo: citas, agenda y espera en sala. */
    professionals: people
      .map((userId) => {
        const appointments = byProfessional.find((row) => row.userId === userId)
        const own = periodOcc.byProfessional.find((row) => row.userId === userId)
        const waited = wait.byProfessional.find((row) => row.userId === userId)
        return {
          userId,
          name: names.get(userId) ?? "",
          attended: appointments?.attended ?? 0,
          noShow: appointments?.noShow ?? 0,
          cancelled: appointments?.cancelled ?? 0,
          unmarked: appointments?.unmarked ?? 0,
          availMin: own?.availMin ?? 0,
          occMin: own?.occMin ?? 0,
          waitMinutes: waited?.medianMinutes ?? null,
        }
      })
      .filter((row) => row.attended + row.noShow + row.cancelled + row.unmarked + row.availMin > 0)
      .sort((a, b) => (b.availMin > 0 ? b.occMin / b.availMin : -1) - (a.availMin > 0 ? a.occMin / a.availMin : -1) || a.name.localeCompare(b.name)),
    waitInRoom: { medianMinutes: wait.medianMinutes, measured: wait.measured },
    /**
     * Los mapas de horas libres, por profesional para que la pantalla elija sin
     * volver a preguntar: cada día de los 12 meses, cada hora de cada mes y la
     * semana tipo del periodo.
     */
    map: {
      days: minutes.days.filter(inTwelve).map((day) => ({
        day: day.day,
        weekday: day.weekday,
        userId: day.dentistUserId,
        scheduledMin: day.scheduledMin,
        availMin: day.availMin,
        occMin: day.occMin,
        assumed: day.assumed,
      })),
      hours: aggregate(
        minutes.slots.filter((slot) => slot.at.getTime() >= twelve.start.getTime() && slot.at.getTime() < twelve.end.getTime()),
        (slot) => `${slot.day.slice(0, 7)}|${slot.hour}|${slot.dentistUserId}`,
      ).map(([key, item]) => {
        const [month, hour, userId] = key.split("|") as [string, string, string]
        return { month, hour: Number(hour), userId, ...item }
      }),
      week: aggregate(
        minutes.slots.filter((slot) => inWindow(slot.at)),
        (slot) => `${slot.weekday}|${slot.hour}|${slot.dentistUserId}`,
      ).map(([key, item]) => {
        const [weekday, hour, userId] = key.split("|") as [string, string, string]
        return { weekday: Number(weekday), hour: Number(hour), userId, ...item }
      }),
      /** Antes de este día no hay horario guardado de ese profesional: se usó el de hoy. */
      firstSchedule: firsts.map((row) => ({ userId: row.userId, day: row.first })),
      assumed: minutes.days.some((day) => day.assumed && inTwelve(day)),
    },
  }
}

function aggregate(slots: AgendaSlot[], keyOf: (slot: AgendaSlot) => string): Array<[string, { availMin: number; occMin: number }]> {
  const out = new Map<string, { availMin: number; occMin: number }>()
  for (const slot of slots) {
    const key = keyOf(slot)
    const entry = out.get(key) ?? { availMin: 0, occMin: 0 }
    entry.availMin += slot.availMin
    entry.occMin += slot.occMin
    out.set(key, entry)
  }
  return [...out].map(([key, item]) => [key, { availMin: Math.round(item.availMin), occMin: Math.round(item.occMin) }])
}
