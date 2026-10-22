/**
 * Las respuestas correctas del segundo banco escrito a ciegas (`eval/argos-blind-2.json`),
 * parte 1: y01 a y25. Se calculan sobre las tablas y con las cifras de Reportes,
 * nunca con las vistas `argos` ni las cifras de Argos: así no heredan un error suyo.
 *
 * Las reglas son las de los bancos anteriores: lo cobrado es «Lo cobrado» de
 * Reportes (pagos menos anulaciones y devoluciones, en el día de la clínica);
 * sin periodo, el mes en curso hasta ahora; «esta semana», del lunes a hoy;
 * «la semana pasada», de lunes a domingo; un mes nombrado, el más reciente con
 * ese nombre que ya empezó; lo pendiente (deudas), a hoy; lo que viene (mañana,
 * la próxima semana, el viernes), ese periodo entero. Quien pregunta es la
 * dueña, la Dra. Ana Torres, que también atiende: «yo» es ella. Las preguntas
 * iguales a una del primer banco (y04 = x13, y15 = x26, y17 = x34) usan su
 * mismo cálculo.
 */
import {
  addDays,
  agendaMinutes,
  collectedByMethod,
  computeFigure,
  dayStart,
  expensesMany,
  type FigureGroup,
  type FigureResult,
  type FigureRow,
  getPatientReportList,
  getReportList,
  reportScope,
  subtractSpans,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { blindSolvers1 } from "./blind-1.js"
import { blindSolvers2 } from "./blind-2.js"
import { goldenWords, NO_INVOICES } from "./finance.js"
import type { GoldenAnswer, GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel, sameDaysWords } from "./trends.js"

/** Las listas de «Te deben» por antigüedad: juntas son todos los que deben hoy. */
const DEBT_LISTS = [
  "debts_age_0_30",
  "debts_age_31_60",
  "debts_age_61_90",
  "debts_age_90_plus",
] as const

/** «La tarde» empieza a mediodía. */
const AFTERNOON_MIN = 12 * 60

const NUMBER_WORDS: Record<number, string> = { 2: "dos", 3: "tres", 4: "cuatro", 5: "cinco" }

/** Un bloqueo o una ausencia de la agenda, con sus días y horas de la sede (como `blind-2.ts`). */
type Block = {
  dentist: string | null
  dentistId: string | null
  branch: string
  branchId: string
  chair: string | null
  kind: string
  reason: string | null
  fromDay: string
  fromTime: string
  lastDay: string
  toTime: string
  startMs: number
  endMs: number
}

/** La misma pregunta que una del primer banco: su mismo cálculo, diciendo de cuál viene. */
function sameAs(solvers: GoldenSolvers, id: string): () => Promise<GoldenAnswer> {
  return async () => {
    const run = solvers[id]
    if (!run) throw new Error(`Falta el cálculo de la pregunta ${id}`)
    const answer = await run()
    return {
      ...answer,
      criterio: `${answer.criterio} Es la misma pregunta que ${id}: el mismo cálculo.`,
    }
  }
}

export function blindSolvers3(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { tx, org, tz, money, show, listOf } = h
  const { locale, currency, window } = h.scope
  const nowIso = h.now.toISOString()
  const nowMs = h.now.getTime()
  const today = w.todayKey
  const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
  /** El lunes de esta semana (día de la clínica). */
  const monday = addDays(today, -((weekdayOf(today) + 6) % 7))
  const year = window.from.year
  const thisMonthNumber = window.from.month
  const startOf = (key: string): Date => {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number]
    return dayStart(tz, y, m, d)
  }
  const isoStart = (key: string): string => startOf(key).toISOString()
  const between = (column: SQL, start: string, end: string) =>
    sql`${column} >= ${start}::timestamptz and ${column} < ${end}::timestamptz`
  /** Un instante como texto ISO que `new Date` lee siempre. */
  const isoOf = (column: SQL) => sql`(to_json(${column}) #>> '{}')`
  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const lower = (text: string): string => text.charAt(0).toLocaleLowerCase(locale) + text.slice(1)
  const hoursOf = (minutes: number): string =>
    `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(locale)} h`
  const per = (cents: number, count: number): string =>
    count > 0 ? money(Math.round(cents / count)) : "sin dato"
  const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | number): number =>
    rows.reduce((total, row) => total + Number(pick(row)), 0)
  const pad = (value: number): string => String(value).padStart(2, "0")
  /** «este mes (del 1 al 21 de octubre de 2026)». */
  const thisMonth = `este mes (${w.monthSoFar})`
  const ThisMonth = capital(thisMonth)
  /** «del lunes 12 al domingo 18 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «21 de octubre de 2026» de un día de la clínica. */
  const dateWords = (key: string): string =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${key.slice(0, 10)}T12:00:00Z`))
  const shortDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: tz,
    }).format(new Date(value))
  /** «14:00» de un instante, en la hora de la clínica. */
  const clockOf = (ms: number): string =>
    new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    }).format(new Date(ms))
  /** «del 1 de enero al 21 de octubre de 2026». */
  const yearSoFar = `del 1 de enero al ${dateWords(today)}`
  /** «la Dra. Ana Torres», «el Dr. Diego Salas»; sin título, el nombre solo. */
  const the = (name: string): string =>
    /^Dra\.?\s/.test(name) ? `la ${name}` : /^Dr\.?\s/.test(name) ? `el ${name}` : name
  /** Quien pregunta es la Dra. Ana Torres. */
  const isAsker = (name: string | null | undefined): boolean => !!name && /ana torres/i.test(name)
  const youToo = (name: string): string => (isAsker(name) ? " (tú)" : "")
  const whoIs = (name: string | null): string => (isAsker(name) ? `tú (${name})` : (name ?? "—"))
  /** «de los tuyos», «de la Dra. Elena Rojas», «del Dr. Diego Salas». */
  const ofThe = (name: string): string =>
    isAsker(name) ? "de los tuyos" : /^Dr\.?\s/.test(name) ? `del ${name}` : `de ${the(name)}`
  /** «contigo», «con el Dr. Diego Salas». */
  const withWho = (name: string): string => (isAsker(name) ? "contigo" : `con ${the(name)}`)
  /** El último mes con ese número que ya empezó. */
  const monthKey = (month: number): string =>
    `${month <= thisMonthNumber ? year : year - 1}-${pad(month)}`
  const monthOfKey = (key: string) => ({
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
  })
  const centsOf = (row: FigureRow | undefined): number => row?.value.value ?? 0
  const rowNamed = (result: FigureResult, pattern: RegExp): FigureRow | undefined =>
    result.rows.find((row) => pattern.test(row.label))
  const ofWords = (value: { part?: number; whole?: number } | null | undefined): string =>
    `${value?.part ?? 0} de ${value?.whole ?? 0}`
  /** «a, 1; b, 2»: para listas cuyos elementos ya llevan comas. */
  const listSemi = (rows: Array<{ name: string; value: string }>): string =>
    rows.map((row) => `${row.name} (${row.value})`).join("; ")
  const noteOf = (parts: Array<string | false | null | undefined>): string | undefined =>
    parts.filter((part): part is string => !!part).join(" ") || undefined

  // --- La clínica ---------------------------------------------------------------------------
  const branches = async () => [
    ...(await tx.execute<{ id: string; name: string }>(
      sql`select id, name from branch where organization_id = ${org} and is_active order by name`,
    )),
  ]
  /** La sede que nombra la pregunta, por una palabra de su nombre. */
  const branchNamed = async (word: string) =>
    (await branches()).find((row) => row.name.toLowerCase().includes(word.toLowerCase())) ?? null
  const noBranch = async (word: string): Promise<GoldenAnswer> => {
    const all = await branches()
    return {
      respuesta: `No hay una sede ${word} en la clínica; las sedes son ${all.map((row) => row.name).join(", ")}.`,
      criterio: `La sede ${word} no existe entre las sedes activas.`,
      datos: { sedes: all },
    }
  }
  /** Lo registrado alguna vez en una sede: citas, cobros, horarios, unidades y gastos. */
  const branchFacts = async (branchId: string) => {
    const [row] = await tx.execute<{
      appointments: number
      payments: number
      schedules: number
      chairs: number
      expenses: number
    }>(sql`
      select (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${branchId})::int as appointments,
        (select count(*) from patient_payment p where p.organization_id = ${org} and p.branch_id = ${branchId} and p.voided_at is null)::int as payments,
        (select count(*) from professional_schedule s where s.organization_id = ${org} and s.branch_id = ${branchId} and s.is_active)::int as schedules,
        (select count(*) from schedule_chair c where c.organization_id = ${org} and c.branch_id = ${branchId} and c.is_active)::int as chairs,
        (select count(*) from expense e where e.organization_id = ${org} and e.branch_id = ${branchId} and e.voided_at is null)::int as expenses`)
    return row ?? { appointments: 0, payments: 0, schedules: 0, chairs: 0, expenses: 0 }
  }
  /** Una cifra de Reportes con una sede elegida en la pantalla: la misma cuenta, solo de esa sede. */
  const figIn = async (
    figure: string,
    group: FigureGroup,
    period: string,
    branchId: string,
  ): Promise<FigureResult> =>
    computeFigure(
      { ...h.ctx, scope: await reportScope(tx, org, { period, branchId }, h.now) },
      { figure, group },
    )
  /** Un miembro de la clínica por su nombre. */
  const userNamed = async (pattern: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${pattern} and exists (select 1 from member m where m.organization_id = ${org} and m.user_id = u.id)
      order by u.name limit 1`)
    return row ?? null
  }
  const nameOf = async (ids: string[]) => {
    if (!ids.length) return new Map<string, string>()
    const rows = await tx.execute<{ id: string; name: string }>(
      sql`select id, name from "user" where id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )
    return new Map(rows.map((row) => [row.id, row.name]))
  }

  // --- El dinero ----------------------------------------------------------------------------
  /** Quién debe hoy y cuánto: las listas de «Te deben» por antigüedad juntas, de mayor a menor. */
  const debtors = async () => {
    const lists = await Promise.all(
      DEBT_LISTS.map((list) =>
        getReportList(tx, org, { period: "este_mes", list, limit: 5000 }, h.now),
      ),
    )
    return lists
      .flatMap((list) => list.rows)
      .map((row) => ({
        patientId: row.patientId,
        name: row.personName,
        cents: row.cents ?? 0,
        since: row.at,
      }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  }
  /** Tickets de pago emitidos en [start, end), por sede (los anulados aparte). */
  const ticketsIn = async (start: string, end: string) => [
    ...(await tx.execute<{ branchId: string; count: number; cents: string; voided: number }>(sql`
      select t.branch_id as "branchId", count(*) filter (where t.voided_at is null)::int as count,
        coalesce(sum(t.total_cents) filter (where t.voided_at is null), 0)::text as cents,
        count(*) filter (where t.voided_at is not null)::int as voided
      from payment_ticket t
      where t.organization_id = ${org} and t.currency = ${currency} and ${between(sql`t.created_at`, start, end)}
      group by 1`)),
  ]
  /** Pagos de [start, end) que siguen en pie al cerrarlo, por sede, y cuántos llevan ticket. */
  const paymentsIn = async (start: string, end: string, where: SQL = sql``) => [
    ...(await tx.execute<{
      branchId: string | null
      count: number
      cents: string
      withTicket: number
      payers: number
    }>(sql`
      select p.branch_id as "branchId", count(*)::int as count, sum(p.amount_cents)::text as cents, count(p.ticket_id)::int as "withTicket",
        count(distinct p.patient_id)::int as payers
      from patient_payment p
      where p.organization_id = ${org} and p.currency = ${currency} and ${between(sql`p.paid_at`, start, end)}
        and (p.voided_at is null or p.voided_at >= ${end}::timestamptz) ${where}
      group by 1`)),
  ]

  // --- La agenda ----------------------------------------------------------------------------
  /** Bloqueos y ausencias que tocan un tramo, con los días y horas de su sede. */
  const blocksIn = async (start: Date, end: Date): Promise<Block[]> => [
    ...(await tx.execute<Block>(sql`
      select u.name as dentist, k.dentist_user_id as "dentistId", b.name as branch, b.id as "branchId", c.name as chair, k.kind, k.reason,
        to_char(k.starts_at at time zone coalesce(b.timezone, ${tz}), 'YYYY-MM-DD') as "fromDay",
        to_char(k.starts_at at time zone coalesce(b.timezone, ${tz}), 'HH24:MI') as "fromTime",
        to_char((k.ends_at - interval '1 second') at time zone coalesce(b.timezone, ${tz}), 'YYYY-MM-DD') as "lastDay",
        to_char(k.ends_at at time zone coalesce(b.timezone, ${tz}), 'HH24:MI') as "toTime",
        (extract(epoch from k.starts_at) * 1000)::float8 as "startMs", (extract(epoch from k.ends_at) * 1000)::float8 as "endMs"
      from schedule_block k
      join branch b on b.organization_id = k.organization_id and b.id = k.branch_id
      left join "user" u on u.id = k.dentist_user_id
      left join schedule_chair c on c.organization_id = k.organization_id and c.id = k.chair_id
      where k.organization_id = ${org} and k.starts_at < ${end.toISOString()}::timestamptz and k.ends_at > ${start.toISOString()}::timestamptz
      order by k.starts_at, b.name`)),
  ]
  /** «del lunes 26 al miércoles 28 de octubre», «el sábado 24 de octubre de 15:00 a 18:00». */
  const blockWhen = (block: Block): string => {
    if (block.fromTime === "00:00" && block.toTime === "00:00")
      return spanWords(block.fromDay, block.lastDay)
    if (block.fromDay === block.lastDay)
      return `el ${w.dayWords(block.fromDay)} de ${block.fromTime} a ${block.toTime}`
    return `del ${w.dayWords(block.fromDay)} a las ${block.fromTime} al ${w.dayWords(block.lastDay)} a las ${block.toTime}`
  }
  const blockWhy = (block: Block): string =>
    lower(block.reason ?? (block.kind === "ausencia" ? "ausencia" : "bloqueo"))
  /**
   * Los tramos libres de un profesional un día desde `fromMin` (minutos del día), con las mismas
   * reglas que `agendaMinutes`: el horario vigente ese día, menos los bloqueos suyos o de toda su
   * sede, menos sus citas no canceladas y menos lo que ya pasó.
   */
  const freeOn = async (personId: string, day: string, fromMin: number) => {
    const shifts = await tx.execute<{
      branchId: string
      branch: string
      start: number
      end: number
    }>(sql`
      select s.branch_id as "branchId", b.name as branch,
        (extract(epoch from ((${day}::date::timestamp + make_interval(mins => greatest(s.start_min, ${fromMin}))) at time zone coalesce(b.timezone, ${tz}))) * 1000)::float8 as start,
        (extract(epoch from ((${day}::date::timestamp + make_interval(mins => s.end_min)) at time zone coalesce(b.timezone, ${tz}))) * 1000)::float8 as end
      from professional_schedule s
      join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
      where s.organization_id = ${org} and s.dentist_user_id = ${personId} and s.weekday = extract(dow from ${day}::date)::int
        and s.valid_from <= ${day}::date and (s.valid_until is null or s.valid_until > ${day}::date) and s.end_min > ${fromMin}
      order by s.start_min`)
    const dayStartIso = isoStart(day)
    const dayEndIso = isoStart(addDays(day, 1))
    const cuts = await tx.execute<{
      branchId: string | null
      start: number
      end: number
      kind: string
    }>(sql`
      select k.branch_id as "branchId", (extract(epoch from k.starts_at) * 1000)::float8 as start, (extract(epoch from k.ends_at) * 1000)::float8 as end, 'bloqueo' as kind
      from schedule_block k where k.organization_id = ${org} and k.starts_at < ${dayEndIso}::timestamptz and k.ends_at > ${dayStartIso}::timestamptz
        and (k.dentist_user_id = ${personId} or (k.dentist_user_id is null and k.chair_id is null))
      union all
      select null, (extract(epoch from a.starts_at) * 1000)::float8, (extract(epoch from a.ends_at) * 1000)::float8, 'cita' from appointment a
      where a.organization_id = ${org} and a.dentist_user_id = ${personId} and a.status <> 'cancelada'
        and a.starts_at < ${dayEndIso}::timestamptz and a.ends_at > ${dayStartIso}::timestamptz`)
    const byBranch = new Map<string, { branch: string; spans: Array<[number, number]> }>()
    for (const shift of shifts) {
      const entry = byBranch.get(shift.branchId) ?? { branch: shift.branch, spans: [] }
      entry.spans.push([shift.start, shift.end])
      byBranch.set(shift.branchId, entry)
    }
    const length = (spans: Array<[number, number]>) =>
      spans.reduce((total, [a, b]) => total + (b - a), 0) / 60_000
    const ranges = [...byBranch.entries()].map(([branchId, entry]) => {
      const mine = cuts.filter((cut) => cut.branchId === null || cut.branchId === branchId)
      const free = subtractSpans(entry.spans, [
        ...mine.map((cut): [number, number] => [cut.start, cut.end]),
        [0, nowMs],
      ])
      const unblocked = subtractSpans(
        entry.spans,
        mine
          .filter((cut) => cut.kind === "bloqueo")
          .map((cut): [number, number] => [cut.start, cut.end]),
      )
      return {
        branch: entry.branch,
        scheduledMin: length(entry.spans),
        unblockedMin: length(unblocked),
        freeMin: length(free),
        free,
      }
    })
    return {
      ranges,
      scheduledMin: sumOf(ranges, (row) => row.scheduledMin),
      unblockedMin: sumOf(ranges, (row) => row.unblockedMin),
      freeMin: sumOf(ranges, (row) => row.freeMin),
      words: ranges
        .filter((row) => row.free.length)
        .map(
          (row) =>
            `${row.free.map(([a, b]) => `de ${clockOf(a)} a ${clockOf(b)}`).join(" y ")} en la ${row.branch}`,
        )
        .join("; "),
    }
  }
  /** El horario vigente de un profesional: «los martes y jueves de 14:00 a 18:00 en la Sede Miraflores». */
  const scheduleWords = async (personId: string): Promise<string> => {
    const rows = await tx.execute<{
      weekday: number
      start: number
      end: number
      branch: string
    }>(sql`
      select s.weekday, s.start_min as start, s.end_min as end, b.name as branch from professional_schedule s
      join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
      where s.organization_id = ${org} and s.dentist_user_id = ${personId} and s.valid_from <= ${today}::date and (s.valid_until is null or s.valid_until > ${today}::date)
      order by b.name, ((s.weekday + 6) % 7), s.start_min`)
    const names = ["domingos", "lunes", "martes", "miércoles", "jueves", "viernes", "sábados"]
    const time = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
    // Los días con el mismo horario en la misma sede se dicen juntos.
    const groups = new Map<string, { branch: string; hours: string; days: number[] }>()
    const byDay = new Map<string, Array<{ start: number; end: number }>>()
    for (const row of rows)
      byDay.set(`${row.branch}|${row.weekday}`, [
        ...(byDay.get(`${row.branch}|${row.weekday}`) ?? []),
        row,
      ])
    for (const [key, list] of byDay) {
      const [branch, weekday] = key.split("|") as [string, string]
      const hours = list.map((row) => `de ${time(row.start)} a ${time(row.end)}`).join(" y ")
      const group = groups.get(`${branch}|${hours}`) ?? { branch, hours, days: [] }
      group.days.push(Number(weekday))
      groups.set(`${branch}|${hours}`, group)
    }
    const join = (items: string[]) =>
      items.length > 1 ? `${items.slice(0, -1).join(", ")} y ${items.at(-1)}` : (items[0] ?? "")
    return join(
      [...groups.values()].map(
        (group) =>
          `los ${join(group.days.map((day) => names[day] ?? ""))} ${group.hours} en la ${group.branch}`,
      ),
    )
  }

  const b1 = blindSolvers1(h)
  const b2 = blindSolvers2(h)

  return {
    // --- Dinero ---------------------------------------------------------------------------
    y01: async () => {
      const list = await branches()
      const count = NUMBER_WORDS[list.length] ?? String(list.length)
      const day = async (key: string, end: string) => {
        const collected = await h.fig("cobrado", "sede", `${key}..${key}`)
        const tickets = await ticketsIn(isoStart(key), end)
        const payments = await paymentsIn(isoStart(key), end)
        const [back] = await tx.execute<{ refunded: string; voided: string }>(sql`
          select (select coalesce(sum(r.amount_cents), 0) from patient_payment_refund r
              join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
              where r.organization_id = ${org} and p.currency = ${currency} and ${between(sql`r.refunded_at`, isoStart(key), end)})::text as refunded,
            (select coalesce(sum(p.amount_cents), 0) from patient_payment p where p.organization_id = ${org} and p.currency = ${currency}
              and p.paid_at < ${isoStart(key)}::timestamptz and ${between(sql`p.voided_at`, isoStart(key), end)})::text as voided`)
        const rows = list.map((branch) => ({
          name: branch.name,
          cents: centsOf(collected.rows.find((row) => row.key === branch.id)),
          tickets: tickets.find((row) => row.branchId === branch.id)?.count ?? 0,
          ticketCents: Number(tickets.find((row) => row.branchId === branch.id)?.cents ?? 0),
        }))
        return {
          collected,
          rows,
          tickets: sumOf(rows, (row) => row.tickets),
          ticketCents: sumOf(rows, (row) => row.ticketCents),
          voided: sumOf(tickets, (row) => row.voided),
          payments: sumOf(payments, (row) => row.count),
          paidCents: sumOf(payments, (row) => row.cents),
          withTicket: sumOf(payments, (row) => row.withTicket),
          refunded: Number(back?.refunded ?? 0),
          voidedCents: Number(back?.voided ?? 0),
        }
      }
      const now = await day(today, nowIso)
      const [last] = await tx.execute<{ day: string | null }>(sql`
        select to_char(max(${h.dayOf(sql`p.paid_at`)}), 'YYYY-MM-DD') as day from patient_payment p
        where p.organization_id = ${org} and p.voided_at is null and p.currency = ${currency} and ${h.dayOf(sql`p.paid_at`)} < ${today}::date`)
      const before = last?.day ? await day(last.day, isoStart(addDays(last.day, 1))) : null
      const bySede = (result: Awaited<ReturnType<typeof day>>) =>
        listOf(result.rows.map((row) => ({ name: row.name, value: money(row.cents) })))
      const lastWords = last?.day
        ? last.day === addDays(today, -1)
          ? `ayer, ${w.dayWords(last.day)}`
          : `el ${w.dayWords(last.day)}, el último día con cobros`
        : ""
      const backWords = (result: Awaited<ReturnType<typeof day>>) =>
        [
          result.refunded ? `se devolvieron ${money(result.refunded)}` : null,
          result.voidedCents
            ? `se anularon ${money(result.voidedCents)} de pagos de días anteriores`
            : null,
        ]
          .filter(Boolean)
          .join(" y ")
      const ticketWords = (result: Awaited<ReturnType<typeof day>>) =>
        result.tickets
          ? `${plural(result.tickets, "ticket de pago", "tickets de pago")} por ${money(result.ticketCents)}`
          : "ningún ticket de pago"
      const empty = !now.tickets && !now.payments && !(now.collected.total.value ?? 0)
      return {
        respuesta: empty
          ? `Hoy (${w.dayWords(today)}, hasta ahora) todavía no se ha hecho ningún ticket de pago ni ha entrado plata en ninguna de las ${count} sedes: no hay pagos registrados hoy.${before && last?.day ? ` Lo más cercano es ${lastWords}: ${ticketWords(before)} y ${show(before.collected)} cobrados entre las ${count} sedes, sin lo anulado ni lo devuelto; por sede, ${bySede(before)}.` : ""}`
          : `Hoy (${w.dayWords(today)}, hasta ahora) se ${now.tickets === 1 ? "hizo" : "hicieron"} ${ticketWords(now)} y entraron ${show(now.collected)} entre las ${count} sedes, sin lo anulado ni lo devuelto: ${bySede(now)}.`,
        criterio:
          "Tickets de pago emitidos hoy (día de la clínica, sin anulados) y «Lo cobrado» de Reportes de hoy por sede: pagos de hoy menos lo anulado y lo devuelto hoy. Sin nada hoy, lo mismo del último día con cobros.",
        nota: noteOf([
          empty && before
            ? `Ese día se registraron ${plural(before.payments, "pago", "pagos")} por ${money(before.paidCents)}${backWords(before) ? ` (y ${backWords(before)})` : ""}: ${before.withTicket} van en esos tickets y ${before.payments - before.withTicket} no tienen ticket (la historia de prueba guarda pagos sin él).`
            : now.payments
              ? `Hoy se registraron ${plural(now.payments, "pago", "pagos")}: ${now.withTicket} con ticket y ${now.payments - now.withTicket} sin ticket.`
              : null,
          now.voided ? `Hoy se anularon ${plural(now.voided, "ticket", "tickets")}.` : null,
        ]),
        datos: {
          hoy: {
            cobrado: now.collected.total,
            sedes: now.rows,
            tickets: now.tickets,
            pagos: now.payments,
          },
          ultimoDia: last?.day ?? null,
          ultimo: before
            ? {
                cobrado: before.collected.total,
                sedes: before.rows,
                tickets: before.tickets,
                pagos: before.payments,
                conTicket: before.withTicket,
              }
            : null,
        },
      }
    },

    y02: async () => {
      const month = await h.fig("cobrado", "medio")
      const yape = rowNamed(month, /yape/i)
      const total = month.total.value ?? 0
      const payments = await paymentsIn(h.monthStart, nowIso, sql`and p.method_name ilike '%yape%'`)
      const gross = {
        count: sumOf(payments, (row) => row.count),
        cents: sumOf(payments, (row) => row.cents),
      }
      const before = await collectedByMethod(tx, org, window.previous, { currency })
      const beforeYape = before.methods.find((row) => /yape/i.test(row.label))?.cents ?? 0
      const beforeTotal = sumOf(before.methods, (row) => row.cents)
      return {
        respuesta: yape
          ? `${ThisMonth} se cobraron ${show(month, yape.value.value)} por Yape, sin lo anulado ni lo devuelto: ${plural(gross.count, "pago", "pagos")}, el ${w.pct(centsOf(yape), total)} de lo cobrado en el mes (${show(month)}).`
          : `${ThisMonth} no se cobró nada por Yape; lo cobrado en el mes va en ${show(month)}.`,
        criterio:
          "«Lo cobrado» de Reportes por medio de pago, fila Yape, del mes en curso hasta ahora: pagos menos anulaciones y devoluciones.",
        nota: noteOf([
          gross.cents !== centsOf(yape)
            ? `Sin restar lo devuelto ni lo anulado de pagos anteriores, los pagos por Yape suman ${money(gross.cents)}.`
            : null,
          `En ${w.previousSameDays}: ${money(beforeYape)} por Yape, el ${w.pct(beforeYape, beforeTotal)} de lo cobrado.`,
          `Todos los medios este mes: ${listOf(month.rows.map((row) => ({ name: row.label, value: show(month, row.value.value) })))}.`,
        ]),
        datos: {
          yape: yape?.value ?? null,
          pagos: gross,
          total: month.total,
          medios: month.rows,
          mismosDiasMesAnterior: beforeYape,
        },
      }
    },

    y03: async () => {
      const last = await reportScope(tx, org, { period: "mes_pasado" }, h.now)
      const name = monthLabel(h, last.window.from)
      const spent = await h.fig("gastos", "categoria", "mes_pasado")
      const commissions = await h.fig("comisiones", "total", "mes_pasado")
      const [list] = await expensesMany(tx, org, [last.window])
      const entry = list?.find((item) => item.currency === currency)
      const commissionPaid = entry?.commissionPaidCents ?? 0
      const purchases = entry?.purchasePaidCents ?? 0
      const total = spent.total.value ?? 0
      const rows = spent.rows
        .filter((row) => centsOf(row) !== 0)
        .sort((a, b) => centsOf(b) - centsOf(a))
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${name} gastaste ${show(spent)} en gastos registrados. Donde más se fue la plata: ${top.label}, ${show(spent, top.value.value)} (el ${w.pct(centsOf(top), total)}).${rows.length > 1 ? ` Le siguen ${listOf(rows.slice(1).map((row) => ({ name: row.label, value: `${show(spent, row.value.value)}, ${w.pct(centsOf(row), total)}` })))}.` : ""}`
          : `En ${name} no hay gastos registrados.`,
        criterio:
          "«Lo gastado» de Reportes › Finanzas por tipo, del mes pasado completo: gastos registrados sin anulados y sin el pago de comisiones, que va aparte.",
        nota: `Aparte van las comisiones de los odontólogos: en ${name} se generaron ${show(commissions)} y se pagaron ${money(commissionPaid)} (registrados en Gastos). Contando también ese pago de comisiones, salió ${money(total + commissionPaid)}.${purchases ? ` De los gastos, ${money(purchases)} son pagos de compras de Inventario.` : ""}`,
        datos: {
          mes: `${last.window.from.year}-${pad(last.window.from.month)}`,
          total: spent.total,
          porTipo: spent.rows,
          comisionesGeneradas: commissions.total,
          pagoDeComisiones: commissionPaid,
          pagoDeCompras: purchases,
        },
      }
    },

    y04: sameAs(b1, "x13"),

    y05: async () => {
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const rows = await debtors()
      const words = (list: typeof rows) =>
        listOf(
          list.map((row) => ({
            name: row.name,
            value: `${money(row.cents)}, desde el ${shortDate(row.since)}`,
          })),
        )
      const top = rows.slice(0, 5)
      const tied = (list: typeof rows) =>
        list.filter((row) => list[4] !== undefined && row.cents === list[4].cents).length
      return {
        respuesta: rows.length
          ? `Hoy te deben ${show(owed)} entre ${plural(rows.length, "persona", "personas")}. Los que más deben: ${words(top)}. Entre esos ${top.length} suman ${money(sumOf(top, (row) => row.cents))}.`
          : "Hoy nadie te debe nada.",
        criterio:
          "Las listas de «Te deben» de Reportes (todas las antigüedades) juntas, a hoy: lo que debe cada persona descontando lo que tiene a favor, de mayor a menor; «desde» es el día de su cargo sin pagar más antiguo.",
        nota: noteOf([
          rows.length > 5 ? `Les siguen ${words(rows.slice(5, 10))}.` : null,
          // Con empates en el quinto lugar, el corte entre los que salen y los que no es por nombre.
          tied(rows) > 1
            ? `En total ${tied(rows)} personas deben exactamente ${money(rows[4]?.cents ?? 0)}.`
            : null,
          `Desde hace más de 30 días te deben ${show(overdue)} (${plural(overdue.total.part ?? 0, "persona", "personas")}).`,
        ]),
        datos: {
          total: owed.total,
          deudores: rows.length,
          primeros: rows.slice(0, 10),
          vencida: overdue.total,
        },
      }
    },

    y06: async () => {
      const isidro = await branchNamed("san isidro")
      const miraflores = await branchNamed("miraflores")
      if (!isidro) return noBranch("San Isidro")
      if (!miraflores) return noBranch("Miraflores")
      const collected = await h.fig("cobrado", "sede")
      const payers = await paymentsIn(h.monthStart, nowIso)
      const tickets = await ticketsIn(h.monthStart, nowIso)
      const of = (branch: { id: string; name: string }) => {
        const paid = payers.find((row) => row.branchId === branch.id)
        const ticket = tickets.find((row) => row.branchId === branch.id)
        return {
          name: branch.name,
          cents: centsOf(collected.rows.find((row) => row.key === branch.id)),
          payers: paid?.payers ?? 0,
          payments: paid?.count ?? 0,
          tickets: ticket?.count ?? 0,
          ticketCents: Number(ticket?.cents ?? 0),
        }
      }
      const s = of(isidro)
      const m = of(miraflores)
      const ticket = (row: typeof s) => (row.payers > 0 ? Math.round(row.cents / row.payers) : 0)
      const ts = ticket(s)
      const tm = ticket(m)
      const words = (row: typeof s) =>
        `${per(row.cents, row.payers)} por paciente (${money(row.cents)} cobrados de ${plural(row.payers, "paciente", "pacientes")} que pagaron)`
      return {
        respuesta:
          !s.payers || !m.payers
            ? `No se puede comparar: ${!s.payers ? `la ${s.name}` : `la ${m.name}`} no tiene cobros este mes. ${s.payers ? `El ticket promedio de la ${s.name} es ${words(s)}.` : ""}${m.payers ? `El de la ${m.name} es ${words(m)}.` : ""}`
            : `${ThisMonth} el ticket promedio de la ${s.name} es ${words(s)}, ${ts === tm ? "igual que" : `${money(Math.abs(ts - tm))} ${ts > tm ? "más alto" : "más bajo"} que`} el de la ${m.name}: ${words(m)}.`,
        criterio:
          "Ticket promedio = «Lo cobrado» de Reportes de cada sede ÷ pacientes distintos con un pago vigente en esa sede, del mes en curso (como g031, f9 y d6).",
        nota: `Por pago recibido: ${s.name} ${per(s.cents, s.payments)} en ${plural(s.payments, "pago", "pagos")}; ${m.name} ${per(m.cents, m.payments)} en ${plural(m.payments, "pago", "pagos")}. Por ticket de pago emitido este mes: ${s.name} ${s.tickets ? `${per(s.ticketCents, s.tickets)} en ${plural(s.tickets, "ticket", "tickets")}` : "ninguno"}; ${m.name} ${m.tickets ? `${per(m.ticketCents, m.tickets)} en ${plural(m.tickets, "ticket", "tickets")}` : "ninguno"} (la historia de prueba guarda casi todos los pagos sin ticket).`,
        datos: { sanIsidro: s, miraflores: m },
      }
    },

    y07: async () => {
      const from = addDays(monday, -7)
      const to = addDays(monday, -1)
      const start = isoStart(from)
      const end = isoStart(monday)
      const tickets = await ticketsIn(start, end)
      const count = sumOf(tickets, (row) => row.count)
      const cents = sumOf(tickets, (row) => row.cents)
      const collected = await h.fig("cobrado", "total", `${from}..${to}`)
      const payments = await paymentsIn(start, end)
      const paid = sumOf(payments, (row) => row.count)
      const withTicket = sumOf(payments, (row) => row.withTicket)
      const [first] = await tx.execute<{ at: string | null }>(sql`
        select ${isoOf(sql`min(t.created_at)`)} as at from payment_ticket t where t.organization_id = ${org} and t.voided_at is null`)
      const week = await ticketsIn(isoStart(monday), nowIso)
      return {
        respuesta: `${NO_INVOICES}. La semana pasada (${spanWords(from, to)}) ${count ? `se ${count === 1 ? "emitió 1 ticket" : `emitieron ${count} tickets`} de pago por ${money(cents)}` : "no se emitió ningún ticket de pago"}; lo cobrado esa semana, sin lo anulado ni lo devuelto, fue ${show(collected)} en ${plural(paid, "pago", "pagos")}.`,
        criterio:
          "Trampa: odentIA no emite boletas ni facturas. Se ofrecen los tickets de pago de la semana pasada (de lunes a domingo, día de la clínica, sin anulados) y «Lo cobrado» de Reportes de esa semana.",
        nota: noteOf([
          paid > withTicket
            ? `${withTicket === 0 ? `Ninguno de los ${paid} pagos de esa semana tiene ticket` : `${paid - withTicket} de los ${paid} pagos de esa semana no tienen ticket`}: la historia de prueba los guarda sin él. Contar tickets da otra cifra; contar lo cobrado, no.`
            : null,
          first?.at
            ? `El primer ticket de pago es del ${dateWords(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(first.at)))}; esta semana van ${plural(
                sumOf(week, (row) => row.count),
                "ticket",
                "tickets",
              )} por ${money(sumOf(week, (row) => row.cents))}.`
            : "Todavía no se ha emitido ningún ticket de pago.",
        ]),
        datos: {
          semana: { desde: from, hasta: to },
          tickets: count,
          ticketsCents: cents,
          cobrado: collected.total,
          pagos: paid,
          conTicket: withTicket,
          primerTicket: first?.at ?? null,
        },
      }
    },

    y08: async () => {
      const result = await h.fig("cobrado", "medio", "este_ano")
      const total = result.total.value ?? 0
      const rows = [...result.rows].sort((a, b) => centsOf(b) - centsOf(a))
      const asked = [
        { name: "efectivo", pattern: /efectivo/i },
        { name: "tarjeta", pattern: /tarjeta/i },
        { name: "Yape", pattern: /yape/i },
        { name: "transferencia", pattern: /transfer/i },
      ]
      const missing = asked.filter(
        (item) => !rows.some((row) => item.pattern.test(row.label) && centsOf(row) !== 0),
      )
      const others = rows.filter((row) => !asked.some((item) => item.pattern.test(row.label)))
      const yearScope = await reportScope(tx, org, { period: "este_ano" }, h.now)
      const before = await collectedByMethod(tx, org, yearScope.window.previous, { currency })
      const beforeTotal = sumOf(before.methods, (row) => row.cents)
      return {
        respuesta: `En lo que va del año (${yearSoFar}) cobraste ${show(result)}, sin lo anulado ni lo devuelto: ${listOf(rows.map((row) => ({ name: row.label, value: `${w.pct(centsOf(row), total)}, ${show(result, row.value.value)}` })))}.${missing.length ? ` No hay cobros con ${missing.map((item) => item.name).join(" ni ")}.` : ""}`,
        criterio:
          "«Lo cobrado» de Reportes por medio de pago, de este año (del 1 de enero a hoy): pagos menos anulaciones y devoluciones; el porcentaje es cada medio sobre el total.",
        nota: noteOf([
          others.length
            ? `Además de los cuatro medios que nombras: ${listOf(others.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`
            : null,
          `En el mismo tramo de ${year - 1}: ${listOf(before.methods.map((row) => ({ name: row.label, value: w.pct(row.cents, beforeTotal) })))}.`,
        ]),
        datos: { total: result.total, medios: result.rows, anoAnterior: before.methods },
      }
    },

    // --- Pacientes ------------------------------------------------------------------------
    y09: async () => {
      const from = addDays(monday, -7)
      const to = addDays(monday, -1)
      const result = await h.fig("pacientes_nuevos", "sede", `${from}..${to}`)
      const before = await h.fig(
        "pacientes_nuevos",
        "total",
        `${addDays(from, -7)}..${addDays(to, -7)}`,
      )
      const sought = await h.fig("nos_buscaron", "canal", `${from}..${to}`)
      const fresh = result.total.value ?? 0
      const sedes = result.rows.filter((row) => (row.value.value ?? 0) > 0)
      return {
        respuesta: `La semana pasada (${spanWords(from, to)}) ${fresh === 1 ? "llegó 1 paciente nuevo" : `llegaron ${fresh} pacientes nuevos`} (su primera cita atendida en la clínica)${sedes.length ? `: ${listOf(sedes.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}` : ""}.`,
        criterio:
          "«Pacientes nuevos» de Reportes de la semana pasada, de lunes a domingo (día de la clínica): personas cuya primera cita atendida cae en esa semana, por sede.",
        nota: `La semana anterior (${spanWords(addDays(from, -7), addDays(to, -7))}): ${show(before)}. Si «nuevos» son las personas que nos buscaron por primera vez esa semana (escribieron o se registraron, aunque no hayan venido): ${sought.total.value ?? 0}, de ellas ${sought.total.part ?? 0} ya vinieron${sought.rows.length ? `; por canal, ${listOf(sought.rows.filter((row) => (row.value.value ?? 0) > 0).map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })))}` : ""}.`,
        datos: {
          semana: { desde: from, hasta: to },
          nuevos: result.total,
          porSede: result.rows,
          semanaAnterior: before.total,
          nosBuscaron: sought.total,
          canales: sought.rows,
        },
      }
    },

    y10: async () => {
      const base = await b1.x15?.()
      const result = await h.fig("sin_venir")
      const lapsed = await getPatientReportList(
        tx,
        org,
        { period: "este_mes", list: "lapsed", limit: 5000 },
        h.now,
      )
      const recent = [...lapsed.rows].sort((a, b) => b.at.localeCompare(a.at))
      const shown = recent.slice(0, 5)
      return {
        respuesta: `Hoy ${show(result)} pacientes no regresan hace más de 6 meses: su última cita atendida fue hace más de 6 meses y no tienen cita por venir, presupuesto esperando respuesta ni control pendiente. Los que se fueron más recientemente: ${listOf(shown.map((row) => ({ name: row.personName, value: `última cita el ${shortDate(row.at)}${row.branchName ? ` en la ${row.branchName}` : ""}` })))}${lapsed.total > shown.length ? ` y ${lapsed.total - shown.length} más` : ""}.`,
        criterio:
          "«Sin venir hace más de 6 meses» de Reportes, a hoy (sin archivados), con su lista ordenada de la última cita más reciente a la más antigua.",
        nota: base?.nota,
        datos: {
          total: result.total,
          lista: recent.slice(0, 20).map((row) => ({
            name: row.personName,
            at: row.at,
            sede: row.branchName,
            profesional: row.professionalName,
          })),
          comoX15: base?.datos ?? null,
        },
      }
    },

    y11: async () => {
      const result = await h.fig("como_nos_conocieron", "como_nos_conocio", "este_ano")
      const total = result.total.value ?? 0
      const rows = [...result.rows].sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const referral = result.rows.find((row) => row.key === "recomendacion")?.value.value ?? 0
      const social = result.rows.find((row) => row.key === "redes_sociales")?.value.value ?? 0
      const channels = await h.fig("nos_buscaron", "canal", "este_ano")
      const instagram = channels.rows.find((row) => row.key === "instagram")
      const winner =
        referral === social
          ? `Por recomendación y por redes sociales llegaron los mismos (${referral})`
          : `Vienen más por ${referral > social ? "recomendación" : "redes sociales"}: ${referral} por recomendación contra ${social} por redes sociales`
      return {
        respuesta: `En lo que va del año (${yearSoFar}) llegaron ${plural(total, "paciente nuevo", "pacientes nuevos")}. Por cómo nos conocieron: ${listOf(rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${w.pct(row.value.value ?? 0, total)}` })))}. ${winner} (el registro no separa Instagram de las demás redes sociales).`,
        criterio:
          "«Cómo nos conocieron» de Reportes › Pacientes de este año (del 1 de enero a hoy): lo que eligió en su registro cada paciente nuevo (su primera cita atendida en el periodo). «Instagram» cae en Redes sociales.",
        nota: `Por el canal por el que nos buscaron por primera vez este año: por Instagram, ${plural(instagram?.value.value ?? 0, "persona", "personas")}, y ${instagram?.value.part ?? 0} ya ${(instagram?.value.part ?? 0) === 1 ? "vino" : "vinieron"} a atenderse. Todos los canales: ${listOf(channels.rows.filter((row) => (row.value.value ?? 0) > 0).map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${row.value.part ?? 0} vinieron` })))}.`,
        datos: { total: result.total, comoNosConocieron: result.rows, canales: channels.rows },
      }
    },

    y12: async () => {
      const top = (since: string | null) =>
        tx.execute<{ person: string; cents: string; payments: number; first: string }>(sql`
          with paid as (
            select p.patient_id, sum(p.amount_cents)::bigint as cents, count(*)::int as payments, min(p.paid_at) as first from patient_payment p
            where p.organization_id = ${org} and p.currency = ${currency} and p.voided_at is null and p.paid_at < ${nowIso}::timestamptz
              ${since ? sql`and p.paid_at >= ${since}::timestamptz` : sql``}
            group by 1),
          back as (
            select p.patient_id, sum(r.amount_cents)::bigint as cents from patient_payment_refund r
            join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id and p.voided_at is null and p.currency = ${currency}
            where r.organization_id = ${org} and r.refunded_at < ${nowIso}::timestamptz ${since ? sql`and r.refunded_at >= ${since}::timestamptz` : sql``}
            group by 1)
          select pp.display_name as person, (paid.cents - coalesce(back.cents, 0))::text as cents, paid.payments, ${isoOf(sql`paid.first`)} as first
          from paid left join back on back.patient_id = paid.patient_id
          ${h.joinPerson(sql`paid.patient_id`)}
          order by paid.cents - coalesce(back.cents, 0) desc, pp.display_name limit 10`)
      const ever = [...(await top(null))]
      const yearRows = [...(await top(new Date(nowMs - 365 * 86_400_000).toISOString()))]
      const [all] = await tx.execute<{ cents: string; first: string | null }>(sql`
        select (coalesce((select sum(p.amount_cents) from patient_payment p where p.organization_id = ${org} and p.currency = ${currency} and p.voided_at is null and p.paid_at < ${nowIso}::timestamptz), 0)
          - coalesce((select sum(r.amount_cents) from patient_payment_refund r join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
              and p.voided_at is null and p.currency = ${currency} where r.organization_id = ${org} and r.refunded_at < ${nowIso}::timestamptz), 0))::text as cents,
          (select ${isoOf(sql`min(p.paid_at)`)} from patient_payment p where p.organization_id = ${org} and p.voided_at is null) as first`)
      const sum = sumOf(ever, (row) => row.cents)
      return {
        respuesta: ever.length
          ? `Los ${ever.length} pacientes que más han pagado en la clínica${all?.first ? ` (desde el primer cobro registrado, el ${shortDate(all.first)})` : ""} son: ${ever.map((row, index) => `${index + 1}. ${row.person}, ${money(Number(row.cents))}`).join("; ")}. Entre los ${ever.length} suman ${money(sum)}, el ${w.pct(sum, Number(all?.cents ?? 0))} de todo lo cobrado.`
          : "Todavía no hay pagos registrados.",
        criterio:
          "Lo pagado por cada paciente desde siempre, con la regla de «Lo cobrado»: sus pagos vigentes menos lo devuelto, en la moneda de la clínica, de mayor a menor. «Gastado» es lo que pagó.",
        nota: `En los últimos 12 meses: ${yearRows
          .slice(0, 5)
          .map((row, index) => `${index + 1}. ${row.person}, ${money(Number(row.cents))}`)
          .join("; ")}.`,
        datos: {
          desdeSiempre: ever,
          ultimos12Meses: yearRows,
          cobradoTotal: Number(all?.cents ?? 0),
        },
      }
    },

    y13: async () => {
      const surco = await branchNamed("surco")
      if (!surco) return noBranch("Surco")
      const facts = await branchFacts(surco.id)
      const list = await branches()
      const rows: Array<{ id: string; name: string; current: number; previous: number }> = []
      for (const branch of list) {
        const result = await figIn("atendidas", "total", "este_mes", branch.id)
        rows.push({
          id: branch.id,
          name: branch.name,
          current: result.total.value ?? 0,
          previous: result.previous?.value ?? 0,
        })
      }
      const people = await tx.execute<{ branchId: string; current: number; previous: number }>(sql`
        select a.branch_id as "branchId",
          count(distinct a.patient_id) filter (where ${between(sql`a.starts_at`, h.monthStart, nowIso)})::int as current,
          count(distinct a.patient_id) filter (where ${between(sql`a.starts_at`, window.previous.start.toISOString(), window.previous.end.toISOString())})::int as previous
        from appointment a where a.organization_id = ${org} and a.status = 'atendida' group by 1`)
      const own = rows.find((row) => row.id === surco.id)
      const others = rows.filter((row) => row.id !== surco.id)
      const words = (items: typeof rows) =>
        listOf(
          items.map((row) => ({ name: row.name, value: `${row.current} contra ${row.previous}` })),
        )
      const peopleOf = (id: string) =>
        people.find((row) => row.branchId === id) ?? { current: 0, previous: 0 }
      const empty = facts.appointments === 0
      return {
        respuesta: empty
          ? `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Y en la ${surco.name} no es que esté viniendo menos gente: ahí no hay nada registrado, ni este mes ni antes (ninguna cita${facts.payments === 0 ? ", ningún cobro" : ""}${facts.schedules === 0 ? " y ningún profesional con horario en esa sede" : ""}). Lo registrado en las otras sedes, citas atendidas ${days.current} contra ${days.sameAs}: ${words(others)}.`
          : `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Lo registrado: en la ${surco.name} se atendieron ${own?.current ?? 0} citas ${days.current} contra ${own?.previous ?? 0} en ${days.sameAs}; en las otras sedes, ${words(others)}.`,
        criterio:
          "Trampa: odentIA no sabe causas. Se ofrecen «Citas atendidas» de Reportes por sede del mes en curso contra los mismos días del mes anterior, y lo registrado en Surco desde siempre (citas, cobros, horarios).",
        nota: `Pacientes distintos atendidos, este mes contra los mismos días del mes anterior: ${listOf(list.map((branch) => ({ name: branch.name, value: `${peopleOf(branch.id).current} contra ${peopleOf(branch.id).previous}` })))}. En la ${surco.name}, desde siempre: ${facts.appointments} citas, ${facts.payments} cobros, ${facts.schedules} horarios, ${facts.chairs} unidades dentales y ${facts.expenses} gastos registrados.`,
        datos: { sede: surco, hechos: facts, atendidasPorSede: rows, pacientesPorSede: people },
      }
    },

    // --- Agenda ---------------------------------------------------------------------------
    y14: async () => {
      const branch = await branchNamed("miraflores")
      if (!branch) return noBranch("Miraflores")
      const tomorrow = addDays(today, 1)
      const status = await tx.execute<{ status: string; day: string; total: number }>(sql`
        select a.status, case when ${h.dayOf(sql`a.starts_at`)} = ${h.today} then 'hoy' else 'manana' end as day, count(*)::int as total
        from appointment a where a.organization_id = ${org} and a.branch_id = ${branch.id}
          and ${h.dayOf(sql`a.starts_at`)} in (${h.today}, ${h.today} + 1)
        group by 1, 2`)
      const count = (day: string, list: string[]) =>
        status
          .filter((row) => row.day === day && list.includes(row.status))
          .reduce((sum, row) => sum + row.total, 0)
      const total = count("manana", ["programada", "confirmada"])
      const confirmed = count("manana", ["confirmada"])
      // Quién atiende mañana en la sede y cuánto tiene libre (la cuenta de Reportes › Agenda).
      const agenda = await agendaMinutes(
        tx,
        org,
        { start: startOf(tomorrow), end: startOf(addDays(tomorrow, 1)) },
        { branchId: branch.id },
      )
      const working = agenda.days.filter((day) => day.availMin > 0)
      const names = await nameOf(working.map((day) => day.dentistUserId))
      const scheduled = sumOf(working, (day) => day.availMin)
      const booked = sumOf(working, (day) => day.occMin)
      const blocks = (await blocksIn(startOf(tomorrow), startOf(addDays(tomorrow, 1)))).filter(
        (block) => block.branchId === branch.id,
      )
      const [next] = await tx.execute<{ day: string | null; all: number }>(sql`
        select to_char(min(${h.dayOf(sql`a.starts_at`)}) filter (where a.branch_id = ${branch.id} and ${h.dayOf(sql`a.starts_at`)} > ${h.today} + 1), 'YYYY-MM-DD') as day,
          count(*)::int as all
        from appointment a where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz`)
      const todayTotal = status
        .filter((row) => row.day === "hoy")
        .reduce((sum, row) => sum + row.total, 0)
      const todayWords = [
        [count("hoy", ["atendida"]), "atendida", "atendidas"],
        [count("hoy", ["no_asistio"]), "en que no vino el paciente", "en que no vino el paciente"],
        [count("hoy", ["cancelada"]), "cancelada", "canceladas"],
        [count("hoy", ["programada", "confirmada"]), "sin marcar", "sin marcar"],
      ]
        .filter(([value]) => Number(value) > 0)
        .map(([value, one, many]) => plural(Number(value), String(one), String(many)))
        .join(", ")
      const people = working.map(
        (day) =>
          `${the(names.get(day.dentistUserId) ?? "—")}${youToo(names.get(day.dentistUserId) ?? "")}, ${hoursOf(day.availMin - day.occMin)} libres de ${hoursOf(day.availMin)}`,
      )
      return {
        respuesta: total
          ? `Mañana (${w.dayWords(tomorrow)}) en la ${branch.name} hay ${plural(total, "cita", "citas")}: ${confirmed} ${confirmed === 1 ? "confirmada" : "confirmadas"} y ${total - confirmed} por confirmar. La agenda está ocupada al ${w.pct(booked, scheduled)} (${hoursOf(booked)} con citas de ${hoursOf(scheduled)} de horario).`
          : `Mañana (${w.dayWords(tomorrow)}) la agenda de la ${branch.name} está vacía: no hay ninguna cita${count("manana", ["cancelada"]) ? ` (${plural(count("manana", ["cancelada"]), "se canceló", "se cancelaron")})` : ""}.${working.length ? ` Atienden ${people.join("; ")}: ${hoursOf(scheduled)} de horario, todas libres.` : ` Mañana nadie tiene horario en la ${branch.name}.`}${todayTotal ? ` Lo más cercano: hoy en la ${branch.name} hubo ${plural(todayTotal, "cita", "citas")} (${todayWords}).` : ""}`,
        criterio:
          "Citas de mañana (día de la clínica) programadas o confirmadas en la sede, con el horario de mañana de cada profesional de la sede menos sus ausencias y bloqueos (la cuenta de Reportes › Agenda); si no hay citas, lo más cercano: las de hoy en la sede.",
        nota: noteOf([
          blocks.length
            ? `Mañana en la sede: ${blocks.map((block) => `${block.chair ?? whoIs(block.dentist) ?? "la sede"} ${blockWhen(block)} (${blockWhy(block)})`).join("; ")}.`
            : "Mañana no hay bloqueos ni ausencias en la sede.",
          next?.day
            ? `La siguiente fecha con citas en la ${branch.name} es el ${w.dayWords(next.day)}.`
            : (next?.all ?? 0) === 0
              ? "No queda ninguna cita por venir en ninguna sede."
              : `En la ${branch.name} no hay ninguna cita por venir; en toda la clínica, ${plural(next?.all ?? 0, "cita", "citas")}.`,
        ]),
        datos: {
          sede: branch,
          manana: tomorrow,
          porEstado: status,
          horario: working.map((day) => ({
            name: names.get(day.dentistUserId),
            availMin: day.availMin,
            occMin: day.occMin,
          })),
          bloqueos: blocks,
          siguiente: next ?? null,
        },
      }
    },

    y15: sameAs(b2, "x26"),

    y16: async () => {
      const key = monthKey(8)
      const name = monthLabel(h, monthOfKey(key))
      const scope = await reportScope(tx, org, { period: key }, h.now)
      const result = await h.fig("no_vinieron", "total", key)
      const bySede = await h.fig("no_vinieron", "sede", key)
      const cancelled = await h.fig("canceladas", "total", key)
      const julyKey = monthKey(7)
      const july = await h.fig("no_vinieron", "total", julyKey)
      const [row] = await tx.execute<{ people: number }>(sql`
        select count(distinct a.patient_id)::int as people from appointment a
        where a.organization_id = ${org} and a.status = 'no_asistio' and ${between(sql`a.starts_at`, scope.window.start.toISOString(), scope.window.end.toISOString())}`)
      const missed = result.total.part ?? 0
      return {
        respuesta: `En ${name} faltaron a su cita ${plural(row?.people ?? 0, "paciente", "pacientes")}: ${plural(missed, "cita", "citas")} en que el paciente no vino, el ${show(result)} de las ${result.total.whole ?? 0} citas que ya pasaron.${bySede.rows.some((item) => (item.value.part ?? 0) > 0) ? ` Por sede: ${listOf(bySede.rows.filter((item) => (item.value.whole ?? 0) > 0).map((item) => ({ name: item.label, value: `${ofWords(item.value)}, ${show(bySede, item.value.value)}` })))}.` : ""}`,
        criterio:
          "«No vinieron» de Reportes de agosto completo (citas en que el paciente no vino ÷ citas que ya pasaron), con las personas distintas de esas citas, como x08.",
        nota: `Si cuentas también las canceladas: en ${name} se cancelaron ${plural(cancelled.total.part ?? 0, "cita", "citas")} más (${show(cancelled)}). En ${monthLabel(h, monthOfKey(julyKey))} no vinieron ${july.total.part ?? 0} citas, el ${show(july)}.`,
        datos: {
          mes: key,
          total: result.total,
          personas: row?.people ?? 0,
          porSede: bySede.rows,
          canceladas: cancelled.total,
          julio: july.total,
        },
      }
    },

    y17: sameAs(b2, "x34"),

    y18: async () => {
      const person = await userNamed("%elena rojas%")
      if (!person)
        return {
          respuesta: "No hay una Dra. Elena Rojas en el equipo de la clínica.",
          criterio: "La profesional no existe.",
          datos: {},
        }
      // El viernes que viene (hoy, si hoy es viernes).
      const friday = addDays(today, (5 - weekdayOf(today) + 7) % 7)
      const fri = await freeOn(person.id, friday, AFTERNOON_MIN)
      const schedule = await scheduleWords(person.id)
      const absent = (await blocksIn(startOf(friday), startOf(addDays(friday, 1)))).filter(
        (block) => block.dentistId === person.id,
      )
      // Lo más cercano: la primera tarde con horas libres desde hoy.
      let nearest: { day: string; free: Awaited<ReturnType<typeof freeOn>> } | null = null
      for (let offset = 0; offset <= 14 && !nearest; offset += 1) {
        const day = addDays(today, offset)
        if (day === friday) continue
        const free = await freeOn(person.id, day, AFTERNOON_MIN)
        if (free.freeMin > 0) nearest = { day, free }
      }
      // Quién sí tiene la tarde del viernes libre.
      const agenda = await agendaMinutes(tx, org, {
        start: new Date(startOf(friday).getTime() + AFTERNOON_MIN * 60_000),
        end: startOf(addDays(friday, 1)),
      })
      const others = agenda.days.filter(
        (day) => day.dentistUserId !== person.id && day.availMin > day.occMin,
      )
      const names = await nameOf(others.map((day) => day.dentistUserId))
      const otherFree: Array<{ name: string; words: string; freeMin: number }> = []
      for (const id of new Set(others.map((day) => day.dentistUserId))) {
        const free = await freeOn(id, friday, AFTERNOON_MIN)
        if (free.freeMin > 0)
          otherFree.push({ name: names.get(id) ?? "—", words: free.words, freeMin: free.freeMin })
      }
      const nearestWords = nearest
        ? ` Lo más cercano: el ${w.dayWords(nearest.day)} en la tarde tiene libre ${nearest.free.words} (${hoursOf(nearest.free.freeMin)}).`
        : ""
      return {
        respuesta: !fri.scheduledMin
          ? `No: ${the(person.name)} no atiende el viernes ${w.dayWords(friday).replace(/^viernes /, "")} en la tarde; su horario es ${schedule || "ninguno"}.${nearestWords}`
          : fri.freeMin > 0
            ? `Sí: el ${w.dayWords(friday)} en la tarde ${the(person.name)} tiene libre ${fri.words} (${hoursOf(fri.freeMin)}).`
            : `No: el ${w.dayWords(friday)} en la tarde ${the(person.name)} no tiene horas libres: ${fri.unblockedMin < fri.scheduledMin ? "su horario está bloqueado" : "su horario está lleno de citas"}.${nearestWords}`,
        criterio:
          "El viernes que viene, desde las 12:00: su horario vigente ese día, menos sus ausencias y los cierres de su sede, menos sus citas no canceladas (la cuenta de Reportes › Agenda). Sin horario ese día, la primera tarde con horas libres desde hoy.",
        nota: noteOf([
          absent.length
            ? `Ese día tiene registrado: ${absent.map((block) => `${blockWhy(block)} ${blockWhen(block)}`).join("; ")}.`
            : null,
          otherFree.length
            ? `El viernes en la tarde sí tienen horas libres ${otherFree.map((row) => `${the(row.name)}${youToo(row.name)}, ${row.words} (${hoursOf(row.freeMin)})`).join("; ")}.`
            : "El viernes en la tarde nadie del equipo tiene horas libres.",
        ]),
        datos: {
          profesional: person,
          viernes: friday,
          tarde: fri,
          horario: schedule,
          ausencias: absent,
          masCercano: nearest,
          otros: otherFree,
        },
      }
    },

    y19: async () => {
      const branch = await branchNamed("san isidro")
      if (!branch) return noBranch("San Isidro")
      const result = await figIn("espera_en_sala", "total", "este_mes", branch.id)
      const clinic = await h.fig("espera_en_sala", "sede")
      // El promedio simple con la misma regla de Reportes (`waitInRoom`): la llegada marcada antes de empezar la atención.
      const [row] = await tx.execute<{
        average: number | null
        measured: number
        over30: number
      }>(sql`
        select avg(extract(epoch from (e.started_at - a.arrived_at)) / 60)::float as average, count(*)::int as measured,
          count(*) filter (where e.started_at - a.arrived_at > interval '30 minutes')::int as over30
        from appointment a
        join encounter e on e.organization_id = a.organization_id and e.appointment_id = a.id and e.status <> 'anulada'
        where a.organization_id = ${org} and a.branch_id = ${branch.id}
          and a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
          and a.arrived_at is not null and a.arrived_at < e.started_at`)
      const average =
        row?.average === null || row?.average === undefined ? null : Math.round(row.average)
      const byProfessional = await figIn("espera_en_sala", "profesional", "este_mes", branch.id)
      return {
        respuesta:
          result.total.value === null
            ? `${ThisMonth} en la ${branch.name} no hay llegadas marcadas con que medir la espera en sala.`
            : `${ThisMonth} en la ${branch.name} los pacientes esperan en sala ${show(result)} (la mediana de Reportes, en ${plural(row?.measured ?? 0, "cita", "citas")} con la llegada marcada); en promedio simple, ${average ?? 0} minutos.`,
        criterio:
          "«Espera en sala» de Reportes con la sede elegida, del mes en curso: mediana de minutos entre «Llegó» y el inicio de la atención (solo la llegada marcada antes de empezar). El promedio simple sale de las mismas citas, como x09.",
        nota: `En los mismos días del mes anterior en la ${branch.name}: ${show(result, result.previous?.value ?? null)} (mediana). Esperaron más de 30 minutos ${plural(row?.over30 ?? 0, "vez", "veces")} este mes. Por sede este mes: ${listOf(clinic.rows.map((item) => ({ name: item.label, value: show(clinic, item.value.value) })))}; por profesional en la ${branch.name}: ${listOf(byProfessional.rows.map((item) => ({ name: item.label, value: show(byProfessional, item.value.value) })))}.`,
        datos: {
          sede: branch,
          mediana: result.total,
          anterior: result.previous,
          promedio: average,
          medidas: row?.measured ?? 0,
          masDe30: row?.over30 ?? 0,
          porSede: clinic.rows,
          porProfesional: byProfessional.rows,
        },
      }
    },

    y20: async () => {
      type Today = {
        time: string
        patient: string
        dentist: string
        branch: string
        status: string
        arrived: boolean
        started: boolean
      }
      const rows: Today[] = await tx.execute<Today>(sql`
        select to_char(a.starts_at at time zone ${tz}, 'HH24:MI') as time, pp.display_name as patient, u.name as dentist, b.name as branch, a.status,
          a.arrived_at is not null as arrived, a.starts_at <= ${nowIso}::timestamptz as started
        from appointment a
        join "user" u on u.id = a.dentist_user_id
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        ${h.joinPerson(sql`a.patient_id`)}
        where a.organization_id = ${org} and ${h.dayOf(sql`a.starts_at`)} = ${h.today}
        order by a.starts_at, pp.display_name`)
      const open = rows.filter((row) => row.status === "programada" || row.status === "confirmada")
      const waiting = open.filter((row) => !row.arrived)
      const inRoom = open.filter((row) => row.arrived)
      const late = waiting.filter((row) => row.started)
      const coming = waiting.filter((row) => !row.started)
      const words = (list: typeof rows) =>
        listSemi(
          list.map((row) => ({
            name: `${row.patient}, a las ${row.time}`,
            value: `${withWho(row.dentist)}, ${row.branch}${row.status === "confirmada" ? ", confirmada" : ", sin confirmar"}`,
          })),
        )
      const counts = [
        [rows.filter((row) => row.status === "atendida").length, "atendida", "atendidas"],
        [
          rows.filter((row) => row.status === "no_asistio").length,
          "en que no vino el paciente",
          "en que no vino el paciente",
        ],
        [rows.filter((row) => row.status === "cancelada").length, "cancelada", "canceladas"],
        [inRoom.length, "en sala", "en sala"],
        [waiting.length, "sin llegar", "sin llegar"],
      ]
        .filter(([value]) => Number(value) > 0)
        .map(([value, one, many]) => plural(Number(value), String(one), String(many)))
        .join(", ")
      return {
        respuesta: waiting.length
          ? `Hoy (${w.dayWords(today)}) ${waiting.length === 1 ? "1 paciente tiene cita y todavía no se marcó su llegada" : `${waiting.length} pacientes tienen cita y todavía no se marcó su llegada`}: ${words(waiting)}.${late.length ? ` ${late.length === waiting.length ? (late.length === 1 ? "Su hora ya pasó" : `Las ${NUMBER_WORDS[late.length] ?? late.length} horas ya pasaron`) : `A ${late.length} ya ${late.length === 1 ? "se le pasó la hora" : "se les pasó la hora"}`}: o ${late.length === 1 ? "no vino" : "no vinieron"} o no se marcó en la agenda.` : ""}${coming.length && late.length ? ` ${coming.length} todavía no llega a su hora.` : ""}`
          : open.length
            ? `Hoy (${w.dayWords(today)}) todos los pacientes con cita pendiente ya llegaron: ${plural(inRoom.length, "está en sala", "están en sala")}.`
            : `Hoy (${w.dayWords(today)}) no queda nadie por llegar${rows.length ? "" : ": no hay citas hoy"}.`,
        criterio:
          "Citas de hoy (día de la clínica) programadas o confirmadas sin la llegada marcada («Llegó»), con su hora, el profesional y la sede; se dice si su hora ya pasó.",
        nota: rows.length
          ? `Hoy hay ${plural(rows.length, "cita", "citas")} en total: ${counts}.`
          : undefined,
        datos: { hoy: today, citas: rows, sinLlegar: waiting, enSala: inRoom },
      }
    },

    y21: async () => {
      const rojas = await userNamed("%rojas%")
      const salas = await userNamed("%salas%")
      const people = [rojas, salas].filter(
        (person): person is { id: string; name: string } => person !== null,
      )
      const last = await reportScope(tx, org, { period: "mes_pasado" }, h.now)
      const name = monthLabel(h, last.window.from)
      const counts = [
        ...(await tx.execute<{ id: string; patients: number; appointments: number }>(sql`
          select a.dentist_user_id as id, count(distinct a.patient_id)::int as patients, count(*)::int as appointments
          from appointment a
          where a.organization_id = ${org} and a.status = 'atendida' and ${between(sql`a.starts_at`, last.window.start.toISOString(), last.window.end.toISOString())}
          group by 1`)),
      ]
      const of = (person: { id: string }) =>
        counts.find((row) => row.id === person.id) ?? {
          id: person.id,
          patients: 0,
          appointments: 0,
        }
      const attended = await h.fig("atendidas", "profesional", "mes_pasado")
      const [first, second] = [...people].sort((a, b) => of(b).patients - of(a).patients)
      if (!first || !second)
        return {
          respuesta: `En el equipo no hay ${!rojas ? "una Dra. Rojas" : "un Dr. Salas"}.`,
          criterio: "Miembros de la clínica por nombre.",
          datos: { profesionales: people },
        }
      return {
        respuesta:
          of(first).patients === of(second).patients
            ? `En ${name} ${the(first.name)} y ${the(second.name)} atendieron a los mismos pacientes: ${plural(of(first).patients, "paciente", "pacientes")} cada uno.`
            : `En ${name} atendió más pacientes ${the(first.name)}: ${plural(of(first).patients, "paciente", "pacientes")}, contra ${of(second).patients} de ${the(second.name)}.`,
        criterio:
          "Pacientes distintos con al menos una cita atendida en el mes pasado completo, por el profesional de la cita (como x27). La Dra. Rojas es la Dra. Elena Rojas y el Dr. Salas, el Dr. Diego Salas: los únicos con ese apellido.",
        nota: `Contando citas atendidas en vez de pacientes («Citas atendidas» de Reportes por profesional): ${listOf(people.map((person) => ({ name: person.name, value: show(attended, attended.rows.find((row) => row.key === person.id)?.value.value ?? of(person).appointments) })))}.`,
        datos: {
          mes: `${last.window.from.year}-${pad(last.window.from.month)}`,
          profesionales: people.map((person) => ({ ...person, ...of(person) })),
          atendidas: attended.rows,
        },
      }
    },

    y22: async () => {
      const ana = await userNamed("%ana torres%")
      if (!ana)
        return {
          respuesta: "No hay nadie llamado Ana Torres en el equipo.",
          criterio: "Miembros de la clínica por nombre.",
          datos: {},
        }
      const yearScope = await reportScope(tx, org, { period: "este_ano" }, h.now)
      const result = await h.fig("cobrado", "profesional", "este_ano")
      const rows = result.rows
        .filter((row) => row.key !== "otros")
        .sort((a, b) => centsOf(b) - centsOf(a))
      const mine = rows.find((row) => row.key === ana.id) ?? rowNamed(result, /ana torres/i)
      const total = sumOf(rows, (row) => centsOf(row))
      const rank = mine ? rows.indexOf(mine) + 1 : 0
      const others = rows.filter((row) => row !== mine)
      const charged = await tx.execute<{ name: string; cents: string; encounters: number }>(sql`
        select u.name, coalesce(sum(c.amount_cents), 0)::text as cents, count(distinct e.id)::int as encounters
        from patient_charge c
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join "user" u on u.id = e.dentist_user_id
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency}
          and ${between(sql`c.created_at`, yearScope.window.start.toISOString(), nowIso)}
        group by 1 order by sum(c.amount_cents) desc, 1`)
      const attended = await h.fig("atendidas", "profesional", "este_ano")
      const visits = (key: string) => attended.rows.find((row) => row.key === key)?.value.value ?? 0
      return {
        respuesta: mine
          ? `En lo que va del año (${yearSoFar}) produjiste ${show(result, mine.value.value)}: lo cobrado de lo que atendiste, el ${w.pct(centsOf(mine), total)} de lo atribuido a los odontólogos. ${rank === 1 ? "Eres quien más produjo; te siguen" : `Vas en el puesto ${rank} de ${rows.length}; los demás:`} ${listOf(others.map((row) => ({ name: the(row.label), value: show(result, row.value.value) })))}.`
          : `En lo que va del año no hay cobros atribuidos a lo que atendiste.`,
        criterio:
          "Producción = «Lo cobrado» de Reportes por profesional (lo pagado de lo que atendió cada uno, sin anulados ni lo devuelto; la base de las comisiones), del 1 de enero a hoy, como x03. Quien pregunta es la Dra. Ana Torres.",
        nota: `Si «producido» es lo cargado de lo que atendió cada uno este año (pagado o no): ${charged.map((row) => `${row.name}${youToo(row.name)}, ${money(Number(row.cents))} en ${plural(row.encounters, "atención", "atenciones")}`).join("; ")}. Por cita atendida (lo cobrado ÷ «Citas atendidas» de Reportes): ${rows.map((row) => `${row.label}${youToo(row.label)}, ${per(centsOf(row), visits(row.key))}`).join("; ")}.`,
        datos: {
          profesional: ana,
          porProfesional: result.rows,
          puesto: rank,
          cargado: charged,
          atendidas: attended.rows,
        },
      }
    },

    y23: async () => {
      const luis = await userNamed("%luis prado%")
      if (!luis)
        return {
          respuesta: "No hay nadie llamado Luis Prado en el equipo.",
          criterio: "Miembros de la clínica por nombre.",
          datos: {},
        }
      const sunday = addDays(monday, 6)
      const rows = [
        ...(await tx.execute<{
          day: string
          time: string
          patient: string
          branch: string
          status: string
          ended: boolean
          started: boolean
        }>(sql`
          select to_char(a.starts_at at time zone ${tz}, 'YYYY-MM-DD') as day, to_char(a.starts_at at time zone ${tz}, 'HH24:MI') as time,
            pp.display_name as patient, b.name as branch, a.status, a.ends_at <= ${nowIso}::timestamptz as ended, a.starts_at <= ${nowIso}::timestamptz as started
          from appointment a
          join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
          ${h.joinPerson(sql`a.patient_id`)}
          where a.organization_id = ${org} and a.dentist_user_id = ${luis.id} and ${between(sql`a.starts_at`, isoStart(monday), isoStart(addDays(monday, 7)))}
          order by a.starts_at`)),
      ]
      const active = rows.filter((row) => row.status !== "cancelada")
      const cancelled = rows.filter((row) => row.status === "cancelada")
      const attended = active.filter((row) => row.status === "atendida")
      const noShow = active.filter((row) => row.status === "no_asistio")
      const open = active.filter(
        (row) => row.status === "programada" || row.status === "confirmada",
      )
      const unmarked = open.filter((row) => row.started)
      const coming = open.filter((row) => !row.started)
      const parts = [
        noShow.length ? `en ${noShow.length} no vino el paciente` : null,
        unmarked.length
          ? `${plural(unmarked.length, "ya pasó sin marcarse como atendida", "ya pasaron sin marcarse como atendidas")} ni como «no vino»`
          : null,
        coming.length
          ? `le ${coming.length === 1 ? "queda 1 por venir" : `quedan ${coming.length} por venir`}`
          : "no le queda ninguna por venir esta semana",
      ].filter((part): part is string => part !== null)
      const statusWords: Record<string, string> = {
        atendida: "atendida",
        no_asistio: "no vino",
        cancelada: "cancelada",
        programada: "sin confirmar",
        confirmada: "confirmada",
      }
      return {
        respuesta: `Esta semana (${spanWords(monday, sunday)}) ${the(luis.name)} tiene ${plural(active.length, "cita", "citas")} y ${attended.length ? `ya atendió ${attended.length}` : "todavía no atendió ninguna"}: ${parts.join("; ")}.`,
        criterio:
          "Citas no canceladas de Luis Prado de esta semana entera (de lunes a domingo, día de la clínica) y cuántas terminaron atendidas; las que ya pasaron sin estado se cuentan aparte.",
        nota: noteOf([
          rows.length
            ? `Sus citas: ${listSemi(rows.map((row) => ({ name: `${w.dayWords(row.day)} a las ${row.time}, ${row.patient}`, value: `${statusWords[row.status] ?? row.status}${(row.status === "programada" || row.status === "confirmada") && row.started ? ", ya pasó" : ""}` })))}.`
            : null,
          cancelled.length
            ? `Además se cancelaron ${plural(cancelled.length, "cita", "citas")} suyas de esta semana.`
            : null,
        ]),
        datos: {
          profesional: luis,
          semana: { desde: monday, hasta: sunday },
          citas: rows,
          atendidas: attended.length,
          noVino: noShow.length,
          sinMarcar: unmarked.length,
          porVenir: coming.length,
          canceladas: cancelled.length,
        },
      }
    },

    y24: async () => {
      const since = (months: number) =>
        sql`((${nowIso}::timestamptz at time zone ${tz}) - make_interval(months => ${months})) at time zone ${tz}`
      const rows = [
        ...(await tx.execute<{
          id: string
          name: string
          cohort: number
          same: number
          clinic: number
        }>(sql`
          with attended as (
            select a.patient_id, a.dentist_user_id, a.starts_at from appointment a
            where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz),
          cohort as (
            select distinct dentist_user_id, patient_id from attended where starts_at >= ${since(24)} and starts_at < ${since(12)})
          select c.dentist_user_id as id, u.name, count(*)::int as cohort,
            count(*) filter (where exists (select 1 from attended v where v.patient_id = c.patient_id and v.dentist_user_id = c.dentist_user_id and v.starts_at >= ${since(12)}))::int as same,
            count(*) filter (where exists (select 1 from attended v where v.patient_id = c.patient_id and v.starts_at >= ${since(12)}))::int as clinic
          from cohort c join "user" u on u.id = c.dentist_user_id
          group by 1, 2`)),
      ]
      const rate = (part: number, whole: number) => (whole > 0 ? part / whole : 0)
      const bySame = [...rows].sort(
        (a, b) => rate(b.same, b.cohort) - rate(a.same, a.cohort) || b.cohort - a.cohort,
      )
      const byClinic = [...rows].sort(
        (a, b) => rate(b.clinic, b.cohort) - rate(a.clinic, a.cohort) || b.cohort - a.cohort,
      )
      const returned = await h.fig("volvieron")
      const noShow = await h.fig("no_vinieron", "profesional")
      const wait = await h.fig("espera_en_sala", "profesional")
      return {
        respuesta: `No lo sé: odentIA no tiene encuestas de satisfacción, así que no puedo decirte qué doctor tiene a los pacientes más satisfechos. Lo más cercano es si sus pacientes vuelven («Volvieron en el año» de Reportes, por quien los atendió): de los pacientes que cada uno atendió hace 12 a 24 meses, volvieron a atenderse en la clínica en los últimos 12 meses: ${byClinic.map((row) => `${ofThe(row.name)}, el ${w.pct(row.clinic, row.cohort)} (${row.clinic} de ${row.cohort})`).join("; ")}. En toda la clínica, el ${show(returned)}${byClinic.length > 1 ? `; ${NUMBER_WORDS[byClinic.length] ? `los ${NUMBER_WORDS[byClinic.length]}` : "todos"} están entre el ${w.pct(Math.min(...byClinic.map((row) => row.clinic / Math.max(1, row.cohort))) * 1000, 1000)} y el ${w.pct(Math.max(...byClinic.map((row) => row.clinic / Math.max(1, row.cohort))) * 1000, 1000)}` : ""}.`,
        criterio:
          "Trampa: no hay encuestas ni NPS. Se ofrece, por profesional, la regla de «Volvieron en el año» de Reportes (de los atendidos hace 12 a 24 meses, cuántos tuvieron otra cita atendida en los últimos 12), por quien los atendió hace 12 a 24 meses.",
        nota: `Si cuenta solo volver con el mismo profesional: ${bySame.map((row) => `${row.name}${youToo(row.name)}, ${w.pct(row.same, row.cohort)} (${row.same} de ${row.cohort})`).join("; ")}. En toda la clínica (Reportes): ${ofWords(returned.total)}. Este mes, no vino a su cita: ${listOf(noShow.rows.filter((row) => (row.value.whole ?? 0) > 0).map((row) => ({ name: row.label, value: show(noShow, row.value.value) })))}; espera en sala (mediana): ${listOf(wait.rows.map((row) => ({ name: row.label, value: show(wait, row.value.value) })))}.`,
        datos: {
          porProfesional: rows,
          clinica: returned.total,
          noVinieron: noShow.rows,
          espera: wait.rows,
        },
      }
    },

    y25: async () => {
      const nextMonday = addDays(monday, 7)
      const nextSunday = addDays(monday, 13)
      const blocks = await blocksIn(startOf(nextMonday), startOf(addDays(monday, 14)))
      const absent = blocks.filter((block) => block.dentistId !== null)
      const closed = blocks.filter((block) => block.dentistId === null && block.chair === null)
      const chairs = blocks.filter((block) => block.dentistId === null && block.chair !== null)
      const rest = (await blocksIn(h.now, startOf(nextMonday))).filter(
        (block) => block.dentistId !== null,
      )
      const closedWords = closed
        .map((block) => `la ${block.branch} cierra ${blockWhen(block)} (${blockWhy(block)})`)
        .join("; ")
      const people = new Set(absent.map((block) => block.dentistId))
      return {
        respuesta: absent.length
          ? `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${people.size === 1 ? "solo falta" : "faltan"} ${listOf(absent.map((block) => ({ name: `${whoIs(block.dentist)} ${blockWhen(block)}`, value: blockWhy(block) })))}. El resto del equipo tiene su horario de siempre.${closed.length ? ` Además, ${closedWords}.` : ""}`
          : `La próxima semana (${spanWords(nextMonday, nextSunday)}) nadie del equipo tiene una ausencia registrada: todos tienen su horario de siempre.${closed.length ? ` Pero ${closedWords}.` : ""}`,
        criterio:
          "Ausencias de profesionales (bloqueos de la agenda con profesional: vacaciones, permisos) que tocan la próxima semana entera, de lunes a domingo, con los días y horas de su sede; aparte, los cierres de sede y las unidades dentales bloqueadas.",
        nota: noteOf([
          "Las ausencias se registran en la agenda de los profesionales; recepción y caja no tienen agenda.",
          rest.length
            ? `Lo que queda de esta semana: ${listOf(rest.map((block) => ({ name: `${whoIs(block.dentist)} ${blockWhen(block)}`, value: blockWhy(block) })))}.`
            : "En lo que queda de esta semana nadie tiene ausencias.",
          chairs.length
            ? `Unidades dentales bloqueadas la próxima semana: ${chairs.map((block) => `${block.chair} de la ${block.branch} ${blockWhen(block)} (${blockWhy(block)})`).join("; ")}.`
            : null,
        ]),
        datos: {
          semana: { desde: nextMonday, hasta: nextSunday },
          ausencias: absent,
          cierres: closed,
          unidades: chairs,
          restoDeEstaSemana: rest,
        },
      }
    },
  }
}
