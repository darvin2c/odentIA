/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 5:
 * la agenda (g101–g105) y los presupuestos y planes (g106–g125).
 *
 * Un presupuesto entregado es el que se le presentó a la persona y no se
 * sustituyó ni se canceló; su importe es el de la opción que vale y lo
 * aceptado, lo aceptado de ella (como `budgets.ts`). Un presupuesto no guarda
 * su sede (en Reportes es de toda la clínica): donde la pregunta la pide, es la
 * de la atención donde se indicó su primer tratamiento o, si no la hay, la de
 * quien lo armó. Un plan sigue abierto mientras le queda algo aceptado por
 * hacer; lo de los planes es a hoy.
 */
import { addDays, agendaMinutes, budgetAwaitsAnswerSql, budgetLineUnitsSql, budgetValueOptionSql, dayStart, getReportList, reportDayOf, upcomingWork } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel } from "./trends.js"

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
const DAY_MS = 86_400_000
/** «La tarde»: de las 12:00 a las 19:00 del día de la sede. */
const AFTERNOON = { from: 12, to: 19 }

/** Un presupuesto con su valor (la opción que vale), lo aceptado y lo aún no decidido. */
type Budget = {
  id: string
  patientId: string
  person: string
  number: number
  status: string
  presented: string
  decided: string | null
  professional: string | null
  cents: string
  accepted: string
  pending: string
}

export function generatedSolvers5(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, tz, money, listOf, joinPerson } = h
  const { locale, window } = h.scope
  const nowIso = h.now.toISOString()
  const monthStart = h.monthStart
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS)
  const yearAgoIso = yearAgo.toISOString()
  const today = reportDayOf(tz, h.now)
  /** Los últimos 365 días hasta hoy, como periodo de Reportes. */
  const lastYear = `${reportDayOf(tz, yearAgo)}..${today}`
  const startOf = (day: string): Date => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    return dayStart(tz, year, month, date)
  }
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7))
  /** «octubre de 2026»: el mes en curso. */
  const monthName = monthLabel(h, window.from)
  const iso = (value: Date | string): string => (typeof value === "string" ? value : value.toISOString())
  const between = (column: SQL, start: Date | string, end: Date | string) => sql`${column} >= ${iso(start)}::timestamptz and ${column} < ${iso(end)}::timestamptz`
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(locale)} h`
  const shortDate = (value: string): string => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }).format(new Date(value))
  /** «jueves 22 de octubre», de un día `YYYY-MM-DD`. */
  const dayWords = (day: string): string =>
    `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${Number(day.slice(8))} de ${monthLabel(h, { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) }, false)}`
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  /** «de la Dra. Ana Torres», «del Dr. Diego Salas», «de Luis Prado». */
  const ofName = (name: string): string => (/^Dra\.?\s/.test(name) ? `de la ${name}` : /^Dr\.?\s/.test(name) ? `del ${name}` : `de ${name}`)
  /** «a, b y c». */
  const andList = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items.at(-1)}`)
  const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | number): number => rows.reduce((total, row) => total + Number(pick(row)), 0)
  /** Un instante como texto ISO que `new Date` lee siempre. */
  const isoOf = (column: SQL) => sql`(to_json(${column}) #>> '{}')`
  /** El primer tratamiento de una lista «a · b · c» y cuántos más. */
  const firstOf = (titles: string | null): string => {
    const list = (titles ?? "").split(" · ").filter(Boolean)
    return list.length > 1 ? `${list[0]} y ${plural(list.length - 1, "más", "más")}` : (list[0] ?? "—")
  }

  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const awaits = budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })
  const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
  /** Entregado: se le presentó a la persona y no se sustituyó ni se canceló (la base de «Aceptaron su presupuesto»). */
  const delivered = sql`b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')`
  const acceptedBudget = sql`b.status in ('aceptado','parcial')`
  /** Línea aceptada de verdad: decidida «aceptado» en un presupuesto aceptado en todo o en parte. */
  const acceptedLine = sql`(b.status in ('aceptado','parcial') and i.decision = 'aceptado')`
  /** Las líneas de la opción que vale, con precio. */
  const valueLines = sql`join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
    and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null`
  /** La sede de un presupuesto: la de la atención donde se indicó su primer tratamiento o, si no la hay, la de quien lo armó. */
  const budgetBranch = sql`coalesce(
    (select e.branch_id from treatment_budget_item x
      join treatment_plan_item xp on xp.organization_id = x.organization_id and xp.id = x.plan_item_id
      join encounter e on e.organization_id = xp.organization_id and e.id = xp.source_encounter_id
      where x.organization_id = b.organization_id and x.budget_id = b.id order by e.started_at, e.id limit 1),
    (select s.branch_id from professional_schedule s where s.organization_id = b.organization_id and s.dentist_user_id = b.created_by
      group by s.branch_id order by count(*) desc, s.branch_id limit 1))`

  /** Presupuestos presentados (no borradores) que cumplen `where`, con su valor, lo aceptado y lo aún no decidido. */
  const budgets = (where: SQL) =>
    tx.execute<Budget>(sql`
      select b.id, b.patient_id as "patientId", pp.display_name as person, b.budget_number as number, b.status,
        ${isoOf(sql`b.presented_at`)} as presented, ${isoOf(sql`b.decided_at`)} as decided, u.name as professional,
        coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}), 0)::text as accepted,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where i.decision in ('pendiente','pospuesto')), 0)::text as pending
      from treatment_budget b
      left join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
      left join "user" u on u.id = b.created_by
      ${joinPerson(sql`b.patient_id`)}
      where b.organization_id = ${org} and b.presented_at is not null and ${where}
      group by b.id, b.patient_id, pp.display_name, b.budget_number, b.status, b.presented_at, b.decided_at, u.name
      order by b.presented_at, b.budget_number`)

  /** Presupuestos entregados en el tramo por sede (la de su atención o la de quien lo armó), con los aceptados. */
  const byBranch = (start: Date | string, end: Date | string) =>
    tx.execute<{ id: string | null; name: string; presented: number; accepted: number; full: number }>(sql`
      with x as (
        select b.status, ${budgetBranch} as branch_id from treatment_budget b
        where b.organization_id = ${org} and ${delivered} and ${between(sql`b.presented_at`, start, end)})
      select br.id, coalesce(br.name, 'Sin sede') as name, count(x.status)::int as presented,
        count(x.status) filter (where x.status in ('aceptado','parcial'))::int as accepted,
        count(x.status) filter (where x.status = 'aceptado')::int as full
      from branch br full join x on x.branch_id = br.id
      where br.id is null or (br.organization_id = ${org} and br.is_active)
      group by br.id, br.name order by 4 desc, 3 desc, 2`)

  /** El inicio de un mes del año más reciente que ya empezó (octubre: el de este año si ya llegó). */
  const latestMonth = (month: number): { year: number; month: number; start: Date; end: Date } => {
    const year = window.from.month >= month ? window.from.year : window.from.year - 1
    const start = dayStart(tz, year, month, 1)
    const next = month === 12 ? dayStart(tz, year + 1, 1, 1) : dayStart(tz, year, month + 1, 1)
    return { year, month, start, end: next.getTime() < h.now.getTime() ? next : h.now }
  }
  const nextMonthStart = window.from.month === 12 ? dayStart(tz, window.from.year + 1, 1, 1) : dayStart(tz, window.from.year, window.from.month + 1, 1)

  /** Una sede por su nombre. */
  const branchNamed = async (words: string) => {
    const [branch] = await tx.execute<{ id: string; name: string }>(sql`
      select id, name from branch where organization_id = ${org} and is_active and name ilike ${`%${words}%`} order by name limit 1`)
    return branch ?? null
  }

  /** Lo que hay en una sede: unidades dentales, profesionales con horario y citas en el tramo. */
  const branchFacts = async (branchId: string, start: Date | string, end: Date | string) => {
    const [row] = await tx.execute<{ chairs: number; people: number; appointments: number; encounters: number }>(sql`
      select (select count(*) from schedule_chair c where c.organization_id = ${org} and c.branch_id = ${branchId} and c.is_active)::int as chairs,
        (select count(distinct s.dentist_user_id) from professional_schedule s where s.organization_id = ${org} and s.branch_id = ${branchId} and s.is_active)::int as people,
        (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${branchId} and ${between(sql`a.starts_at`, start, end)})::int as appointments,
        (select count(*) from encounter e where e.organization_id = ${org} and e.branch_id = ${branchId})::int as encounters`)
    return row ?? { chairs: 0, people: 0, appointments: 0, encounters: 0 }
  }

  /** «sin unidades dentales registradas, ni profesionales con horario, ni citas». */
  const missingWords = (facts: { chairs: number; people: number; appointments: number }): string[] =>
    [facts.chairs === 0 ? "unidades dentales registradas" : null, facts.people === 0 ? "profesionales con horario" : null, facts.appointments === 0 ? "citas" : null].filter(
      (item): item is string => item !== null,
    )
  const orList = (items: string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ni ${items.at(-1)}`)

  const statusWords = (row: Budget): string => {
    switch (row.status) {
      case "aceptado":
        return `Sí, lo aceptó entero${row.decided ? ` el ${shortDate(row.decided)}` : ""}`
      case "parcial":
        return `Lo aceptó en parte${row.decided ? ` el ${shortDate(row.decided)}` : ""}: ${money(Number(row.accepted))} de ${money(Number(row.cents))}`
      case "rechazado":
        return `No, lo rechazó${row.decided ? ` el ${shortDate(row.decided)}` : ""}`
      case "pospuesto":
        return "Todavía no: dijo que lo está pensando"
      default:
        return "Todavía no: sigue esperando respuesta"
    }
  }

  return {
    // --- Agenda ---------------------------------------------------------------------------------

    g101: async () => {
      const branch = await branchNamed("miraflores")
      const day = addDays(today, 1)
      if (!branch) {
        return { respuesta: "No hay una sede Miraflores en la clínica.", criterio: "Sedes activas de la clínica.", datos: {} }
      }
      const minutes = await agendaMinutes(tx, org, { start: startOf(day), end: startOf(addDays(day, 1)) }, { branchId: branch.id })
      const people = await tx.execute<{ id: string; name: string }>(sql`
        select distinct u.id, u.name from professional_schedule s join "user" u on u.id = s.dentist_user_id
        where s.organization_id = ${org} and s.branch_id = ${branch.id}`)
      const [booked] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from appointment a
        where a.organization_id = ${org} and a.branch_id = ${branch.id} and a.status <> 'cancelada'
          and ${between(sql`a.starts_at`, startOf(day), startOf(addDays(day, 1)))}
          and extract(hour from a.starts_at at time zone ${tz}) >= ${AFTERNOON.from} and extract(hour from a.starts_at at time zone ${tz}) < ${AFTERNOON.to}`)
      const byPerson = new Map<string, { free: number; avail: number; hours: number[] }>()
      // Si «la tarde» empieza después del refrigerio, a las 14:00.
      const lateFree = minutes.slots.filter((slot) => slot.hour >= 14 && slot.hour < AFTERNOON.to).reduce((total, slot) => total + Math.max(0, slot.availMin - slot.occMin), 0)
      for (const slot of minutes.slots) {
        if (slot.hour < AFTERNOON.from || slot.hour >= AFTERNOON.to) continue
        const entry = byPerson.get(slot.dentistUserId) ?? { free: 0, avail: 0, hours: [] }
        const free = Math.max(0, slot.availMin - slot.occMin)
        entry.free += free
        entry.avail += slot.availMin
        if (free >= 1) entry.hours.push(slot.hour)
        byPerson.set(slot.dentistUserId, entry)
      }
      // Horas seguidas con algo libre: «14:00 a 18:00».
      const ranges = (hours: number[]): string => {
        const sorted = [...new Set(hours)].sort((a, b) => a - b)
        const out: Array<[number, number]> = []
        for (const hour of sorted) {
          const last = out.at(-1)
          if (last && last[1] === hour) last[1] = hour + 1
          else out.push([hour, hour + 1])
        }
        return out.map(([from, to]) => `${from}:00 a ${to}:00`).join(" y ")
      }
      const rows = [...byPerson.entries()]
        .map(([id, entry]) => ({ name: people.find((row) => row.id === id)?.name ?? "—", ...entry }))
        .sort((a, b) => b.free - a.free || a.name.localeCompare(b.name))
      const free = sumOf(rows, (row) => row.free)
      const avail = sumOf(rows, (row) => row.avail)
      const dayFree = minutes.days.reduce((total, item) => total + Math.max(0, item.availMin - item.occMin), 0)
      const dayAvail = minutes.days.reduce((total, item) => total + item.availMin, 0)
      const when = `mañana, ${dayWords(day)}, por la tarde (de ${AFTERNOON.from}:00 a ${AFTERNOON.to}:00)`
      const withFree = rows.filter((row) => row.free >= 1)
      return {
        respuesta:
          free >= 1
            ? `Sí: ${when} la ${branch.name} tiene ${hoursOf(free)} libres en la agenda${booked?.count ? ` (ya hay ${plural(booked.count, "cita", "citas")})` : ", sin ninguna cita todavía"}: ${listOf(withFree.map((row) => ({ name: row.name, value: `${hoursOf(row.free)}, de ${ranges(row.hours)}` })))}.`
            : avail > 0
              ? `No: ${when} la agenda de la ${branch.name} está llena (${plural(booked?.count ?? 0, "cita", "citas")}).`
              : `No: ${when} nadie atiende en la ${branch.name}: no hay horario de profesionales en esa franja.`,
        criterio: `El horario de cada profesional de la sede para mañana (día de la clínica), de ${AFTERNOON.from}:00 a ${AFTERNOON.to}:00, menos sus ausencias y los bloqueos de la sede y menos las citas no canceladas: la cuenta de Reportes › Agenda (agendaMinutes). Las unidades dentales no tienen horario: el espacio es el de la agenda de los profesionales.`,
        nota: `Si «la tarde» empieza a las 14:00: ${hoursOf(lateFree)} libres. Todo el día de mañana en la sede: ${hoursOf(dayFree)} libres de ${hoursOf(dayAvail)} de horario.`,
        datos: { sede: branch.name, dia: day, franja: AFTERNOON, libresMin: free, horarioMin: avail, citas: booked?.count ?? 0, porProfesional: rows, desdeLas14Min: lateFree, diaEntero: { libresMin: dayFree, horarioMin: dayAvail } },
      }
    },

    g102: async () => {
      const last = window.previous.from
      const lastName = monthLabel(h, last)
      const start = dayStart(tz, last.year, last.month, 1)
      const end = window.start
      const free = await h.fig("horas_libres", "sede", "mes_pasado")
      const occupied = await h.fig("agenda_ocupada", "sede", "mes_pasado")
      const branch = await branchNamed("surco")
      const others = free.rows.filter((row) => row.key !== branch?.id && (row.value.value ?? 0) > 0)
      const othersWords = listOf(others.map((row) => ({ name: row.label, value: `${h.show(free, row.value.value)} sin usar` })))
      if (!branch) {
        return {
          respuesta: `No hay una sede Surco en la clínica. En ${lastName} quedaron ${othersWords}.`,
          criterio: "Sedes activas de la clínica; «Horas libres» de Reportes por sede del mes pasado.",
          datos: { horasLibres: free.rows },
        }
      }
      const facts = await branchFacts(branch.id, start, end)
      const row = free.rows.find((item) => item.key === branch.id)
      const occupiedRow = occupied.rows.find((item) => item.key === branch.id)
      const missing = missingWords(facts)
      return {
        respuesta:
          (row?.value.value ?? null) !== null
            ? `odentIA no mide las horas de cada unidad dental: las unidades no tienen horario, solo los profesionales. Lo más cercano: en ${lastName} la agenda de los profesionales de la ${branch.name} tuvo ${h.show(free, row?.value.value)} sin usar (ocupada ${h.show(occupied, occupiedRow?.value.value ?? null)}), con ${plural(facts.chairs, "unidad dental", "unidades dentales")}.`
            : `En ${lastName} la ${branch.name} no tuvo horas que medir: no tiene ${orList(missing)}${facts.appointments === 0 ? " ese mes" : ""}. Además, odentIA no mide las horas de cada unidad dental (las unidades no tienen horario), solo la agenda de los profesionales. En las otras sedes quedaron ${othersWords}.`,
        criterio:
          "«Horas libres» de Reportes por sede, del mes pasado completo: horario de los profesionales menos ausencias, bloqueos y citas no canceladas. La ocupación por unidad dental no existe: las unidades no tienen horario (report-agenda.ts).",
        nota: `Agenda ocupada en ${lastName}: ${listOf(occupied.rows.filter((item) => item.value.value !== null).map((item) => ({ name: item.label, value: h.show(occupied, item.value.value) })))}.`,
        datos: { sede: branch.name, hechos: facts, horasLibres: free.rows, ocupada: occupied.rows },
      }
    },

    g103: async () => {
      const lastDay = reportDayOf(tz, new Date(nextMonthStart.getTime() - 1))
      const [row] = await tx.execute<{ total: number; confirmed: number; unconfirmed: number; people: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed,
          count(*) filter (where a.status = 'programada')::int as unconfirmed, count(distinct a.patient_id)::int as people
        from appointment a
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz and a.starts_at < ${iso(nextMonthStart)}::timestamptz`)
      const branches = await tx.execute<{ name: string; count: number }>(sql`
        select b.name, count(*)::int as count from appointment a join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz and a.starts_at < ${iso(nextMonthStart)}::timestamptz
        group by 1 order by 2 desc, 1`)
      const [unmarked] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from appointment a
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.ends_at < ${nowIso}::timestamptz and a.starts_at >= ${monthStart}::timestamptz`)
      const rest = await agendaMinutes(tx, org, { start: h.now, end: nextMonthStart })
      const restFree = rest.days.reduce((total, day) => total + Math.max(0, day.availMin - day.occMin), 0)
      const total = row?.total ?? 0
      const until = `de ahora al ${Number(lastDay.slice(8))} de ${monthLabel(h, window.from, false)}`
      return {
        respuesta: total
          ? `Quedan ${plural(total, "cita programada", "citas programadas")} ${until}: ${row?.confirmed ?? 0} confirmadas y ${row?.unconfirmed ?? 0} sin confirmar, de ${plural(row?.people ?? 0, "paciente", "pacientes")} (${listOf(branches.map((item) => ({ name: item.name, value: `${item.count}` })))}).`
          : `No queda ninguna cita programada para lo que resta del mes (${until}).`,
        criterio: "Citas programadas o confirmadas que empiezan después de ahora y antes de que termine el mes en curso (día de la clínica), a hoy.",
        nota: `${unmarked?.count ? `Además, ${plural(unmarked.count, "cita de este mes ya pasó", "citas de este mes ya pasaron")} sin marcar si vino el paciente: no cuentan como por venir. ` : ""}En lo que queda del mes hay ${hoursOf(restFree)} libres en la agenda de los profesionales.`,
        datos: { citas: row, porSede: branches, sinMarcar: unmarked?.count ?? 0, horasLibresRestoMin: restFree, hasta: lastDay },
      }
    },

    g104: async () => {
      const weekStart = startOf(monday)
      const weekEnd = startOf(addDays(monday, 7))
      const [row] = await tx.execute<{
        fresh: number
        people: number
        attended: number
        noShow: number
        upcoming: number
        unmarked: number
        cancelled: number
        all: number
      }>(sql`
        with week as (
          select a.id, a.patient_id, a.status, a.starts_at, a.ends_at,
            not exists (select 1 from appointment x where x.organization_id = a.organization_id and x.patient_id = a.patient_id
              and x.status = 'atendida' and x.starts_at < a.starts_at) as fresh
          from appointment a
          where a.organization_id = ${org} and ${between(sql`a.starts_at`, weekStart, weekEnd)})
        select count(*) filter (where fresh and status <> 'cancelada')::int as fresh,
          count(distinct patient_id) filter (where fresh and status <> 'cancelada')::int as people,
          count(*) filter (where fresh and status = 'atendida')::int as attended,
          count(*) filter (where fresh and status = 'no_asistio')::int as "noShow",
          count(*) filter (where fresh and status in ('programada','confirmada') and starts_at > ${nowIso}::timestamptz)::int as upcoming,
          count(*) filter (where fresh and status in ('programada','confirmada') and starts_at <= ${nowIso}::timestamptz)::int as unmarked,
          count(*) filter (where fresh and status = 'cancelada')::int as cancelled,
          count(*) filter (where status <> 'cancelada')::int as "all"
        from week`)
      const fresh = await h.fig("pacientes_nuevos", "total", `${monday}..${today}`)
      const sunday = addDays(monday, 6)
      const count = row?.fresh ?? 0
      const parts = [
        row?.attended ? `${row.attended} ${row.attended === 1 ? "ya se atendió" : "ya se atendieron"}` : null,
        row?.noShow ? `${row.noShow} no ${row.noShow === 1 ? "vino" : "vinieron"}` : null,
        row?.unmarked ? `${row.unmarked} ${row.unmarked === 1 ? "pasó" : "pasaron"} sin marcar si vino` : null,
        `${row?.upcoming ?? 0} ${row?.upcoming === 1 ? "queda" : "quedan"} por venir hasta el domingo`,
      ].filter((item): item is string => item !== null)
      return {
        respuesta: `Esta semana (del ${dayWords(monday)} al ${dayWords(sunday)}) hay ${plural(count, "cita de primera vez", "citas de primera vez")}, de pacientes sin una cita atendida antes: ${andList(parts)}. Son ${count} de las ${row?.all ?? 0} citas de la semana.`,
        criterio:
          "Citas no canceladas de la semana (lunes a domingo, día de la clínica) cuyo paciente no tenía ninguna cita atendida antes de esa cita: su primera vez. Lo que ya pasó, de lunes a hoy; lo que queda, hasta el domingo.",
        nota: `«Pacientes nuevos» de Reportes de lunes a hoy (su primera cita atendida): ${h.show(fresh)}. Aparte, ${plural(row?.cancelled ?? 0, "cita de primera vez se canceló", "citas de primera vez se cancelaron")} esta semana.`,
        datos: { semana: { desde: monday, hasta: sunday }, citas: row, pacientesNuevos: fresh.total },
      }
    },

    g105: async () => {
      const result = await h.fig("agenda_ocupada", "profesional")
      const rows = [...result.rows].sort((a, b) => (b.value.value ?? -1) - (a.value.value ?? -1) || (b.value.part ?? 0) - (a.value.part ?? 0) || a.label.localeCompare(b.label))
      const byHours = [...result.rows].sort((a, b) => (b.value.part ?? 0) - (a.value.part ?? 0) || a.label.localeCompare(b.label))
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${monthName} (hasta hoy) la agenda más copada es la ${ofName(top.label)}: ${h.show(result, top.value.value)} ocupada (${hoursOf(top.value.part ?? 0)} con citas de ${hoursOf(top.value.whole ?? 0)} de horario). Le siguen ${listOf(rows.slice(1).map((row) => ({ name: row.label, value: h.show(result, row.value.value) })))}. En toda la clínica, ${h.show(result)}.`
          : `En ${monthName} nadie tiene horario cargado.`,
        criterio: "«Agenda ocupada» de Reportes por profesional, del mes en curso: minutos de citas no canceladas ÷ minutos de su horario menos sus ausencias.",
        nota: `Por horas con citas, no por porcentaje: ${listOf(byHours.map((row) => ({ name: row.label, value: hoursOf(row.value.part ?? 0) })))}.`,
        datos: { filas: result.rows, total: result.total },
      }
    },

    // --- Presupuestos -----------------------------------------------------------------------------

    g106: async () => {
      const rows = await budgets(awaits)
      const people = new Set(rows.map((row) => row.patientId)).size
      const of = (status: string) => rows.filter((row) => row.status === status).length
      const oldest = rows[0]
      const over30 = rows.filter((row) => new Date(row.presented).getTime() < h.now.getTime() - 30 * DAY_MS)
      return {
        respuesta: rows.length
          ? `Hoy ${plural(rows.length, "presupuesto espera", "presupuestos esperan")} respuesta, de ${plural(people, "paciente", "pacientes")}, por ${money(sumOf(rows, (row) => row.pending))} sin decidir: ${of("presentado")} enviados sin respuesta, ${of("pospuesto")} que «lo están pensando» y ${of("parcial")} aceptados en parte con algo pendiente.`
          : "Hoy ningún presupuesto espera respuesta.",
        criterio: "La regla «espera respuesta» de odentIA (budgetAwaitsAnswer: enviado, «lo está pensando» o aceptado en parte con algo pospuesto), a hoy; se suma lo aún no decidido de la opción que vale.",
        nota: `Con el valor entero de esos presupuestos (incluida la parte ya aceptada de los parciales): ${money(sumOf(rows, (row) => row.cents))}. ${over30.length} esperan hace más de 30 días${oldest ? `; el más antiguo, desde el ${shortDate(oldest.presented)}` : ""}.`,
        datos: { presupuestos: rows.length, pacientes: people, faltaDecidir: sumOf(rows, (row) => row.pending), valorEntero: sumOf(rows, (row) => row.cents), masDe30Dias: over30.length },
      }
    },

    g107: async () => {
      const month = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, monthStart, nowIso)}`)
      const accepted = month.filter((row) => row.status === "aceptado" || row.status === "parcial")
      const decided = await budgets(sql`${acceptedBudget} and ${between(sql`b.decided_at`, monthStart, nowIso)}`)
      const full = accepted.filter((row) => row.status === "aceptado").length
      return {
        respuesta: `En ${monthName} (hasta hoy) te aceptaron ${money(sumOf(accepted, (row) => row.accepted))} en ${plural(accepted.length, "presupuesto", "presupuestos")} (${full} enteros y ${accepted.length - full} en parte), de los ${month.length} entregados este mes.`,
        criterio: "Presupuestos entregados en el mes en curso y aceptados en todo o en parte, a hoy (la base de «Aceptaron su presupuesto» de Reportes); se suma lo aceptado de la opción que vale, no su valor entero.",
        nota: `Contando los que dijeron que sí este mes aunque se entregaran antes: ${money(sumOf(decided, (row) => row.accepted))} en ${plural(decided.length, "presupuesto", "presupuestos")}. Con el valor entero de los aceptados este mes (también lo no aceptado de los parciales): ${money(sumOf(accepted, (row) => row.cents))}.`,
        datos: { entregados: month.length, aceptados: accepted.length, enteros: full, aceptado: sumOf(accepted, (row) => row.accepted), decididosEsteMes: { presupuestos: decided.length, aceptado: sumOf(decided, (row) => row.accepted) } },
      }
    },

    g108: async () => {
      const span = latestMonth(9)
      const name = monthLabel(h, span)
      const presented = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, span.start, span.end)}`)
      const rejected = presented.filter((row) => row.status === "rechazado")
      const decided = await budgets(sql`b.status = 'rechazado' and ${between(sql`b.decided_at`, span.start, span.end)}`)
      return {
        respuesta: `En ${name} te rechazaron ${plural(rejected.length, "presupuesto", "presupuestos")} de los ${presented.length} entregados ese mes (${pct(rejected.length, presented.length)}), por ${money(sumOf(rejected, (row) => row.cents))}.`,
        criterio: "Presupuestos entregados en septiembre (día de la clínica) que hoy están rechazados, sobre los entregados ese mes (la base de «Aceptaron su presupuesto»); el importe es el de la opción que vale.",
        nota: `Contando los que se rechazaron durante ${name}, aunque se hubieran entregado antes: ${decided.length} (${money(sumOf(decided, (row) => row.cents))}).`,
        datos: { entregados: presented.length, rechazados: rejected.map((row) => ({ numero: row.number, paciente: row.person, valor: Number(row.cents) })), rechazadosEnElMes: decided.length },
      }
    },

    g109: async () => {
      const yearStart = dayStart(tz, window.from.year, 1, 1)
      const [row] = await tx.execute<{
        budgets: number
        accepted: number
        anyAccepted: number
        waiting: number
        rejected: number
        lines: number
        yesLines: number
        cents: string
        yesCents: string
        names: string | null
      }>(sql`
        with lines as (
          select b.id, b.status, ${awaits} as waiting, coalesce(s.name, i.title) as name,
            coalesce(s.name, i.title) ilike '%implant%' as implant, ${acceptedLine} as yes,
            coalesce(i.price_cents, 0)::bigint * ${units} as cents
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id and i.option_id = ${budgetValueOptionSql(budgetRef)}
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          where b.organization_id = ${org} and ${delivered} and ${between(sql`b.presented_at`, yearStart, nowIso)}),
        per as (
          select id, status, bool_or(waiting) as waiting, bool_or(implant) as has, bool_or(implant and yes) as took,
            count(*) filter (where implant) as lines, count(*) filter (where implant and yes) as yes_lines,
            sum(cents) filter (where implant) as cents, sum(cents) filter (where implant and yes) as yes_cents
          from lines group by id, status)
        select count(*) filter (where has)::int as budgets, count(*) filter (where took)::int as accepted,
          count(*) filter (where has and status in ('aceptado','parcial'))::int as "anyAccepted",
          count(*) filter (where has and waiting)::int as waiting, count(*) filter (where has and status = 'rechazado')::int as rejected,
          coalesce(sum(lines), 0)::int as lines, coalesce(sum(yes_lines), 0)::int as "yesLines",
          coalesce(sum(cents), 0)::text as cents, coalesce(sum(yes_cents), 0)::text as "yesCents",
          (select string_agg(distinct name, ', ' order by name) from lines where implant) as names
        from per`)
      const count = row?.budgets ?? 0
      const accepted = row?.accepted ?? 0
      // Sin implantes cotizados: lo que sí hay (el catálogo, si se cotizaron alguna vez, y todo lo entregado del año).
      const catalog = await tx.execute<{ name: string }>(sql`
        select distinct s.name from service_catalog s where s.organization_id = ${org} and s.name ilike '%implant%' order by 1`)
      const [ever] = await tx.execute<{ lines: number; done: number }>(sql`
        select (select count(*) from treatment_budget_item i left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
            where i.organization_id = ${org} and coalesce(s.name, i.title) ilike '%implant%')::int as lines,
          (select count(*) from encounter_procedure ep left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
            where ep.organization_id = ${org} and ep.voided_at is null and coalesce(s.name, ep.description) ilike '%implant%')::int as done`)
      const year = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, yearStart, nowIso)}`)
      const yearAccepted = year.filter((item) => item.status === "aceptado" || item.status === "parcial").length
      return {
        respuesta: count
          ? `En ${window.from.year} (hasta hoy) se entregaron ${plural(count, "presupuesto con implantes", "presupuestos con implantes")} y en ${accepted} se aceptó el implante (${pct(accepted, count)}): ${row?.yesLines ?? 0} de ${row?.lines ?? 0} implantes cotizados, ${money(Number(row?.yesCents ?? 0))} de ${money(Number(row?.cents ?? 0))}.`
          : `En ${window.from.year} (hasta hoy) no se hizo ningún presupuesto de implantes: ninguno de los entregados tiene un implante${ever?.lines === 0 ? ", y nunca se ha cotizado uno" : ""}${catalog.length ? ` (están en los servicios: ${catalog.map((item) => item.name).join(", ")})` : ""}. Lo que sí hay este año: ${year.length} presupuestos entregados, ${yearAccepted} aceptados en todo o en parte (${pct(yearAccepted, year.length)}).`,
        criterio: "Presupuestos entregados desde el 1 de enero hasta hoy con al menos un tratamiento con «implante» en el nombre en la opción que vale; aceptado = esa línea aceptada en un presupuesto aceptado en todo o en parte, a hoy.",
        nota: count
          ? `${row?.anyAccepted ?? 0} de esos presupuestos se aceptaron en todo o en parte (aunque en alguno quedara fuera el implante); ${row?.waiting ?? 0} siguen esperando respuesta y ${row?.rejected ?? 0} se rechazaron. Cuentan como implante: ${row?.names ?? "—"}.`
          : `Tampoco hay implantes realizados en las atenciones (${ever?.done ?? 0}).`,
        datos: { row, catalogo: catalog.map((item) => item.name), siempre: ever, anio: { entregados: year.length, aceptados: yearAccepted } },
      }
    },

    g110: async () => {
      const delay = (start: string) =>
        tx.execute<{ count: number; median: number | null; average: number | null }>(sql`
          select count(*)::int as count,
            percentile_cont(0.5) within group (order by extract(epoch from b.decided_at - b.presented_at) / 86400)::float as median,
            avg(extract(epoch from b.decided_at - b.presented_at) / 86400)::float as average
          from treatment_budget b
          where b.organization_id = ${org} and ${acceptedBudget} and b.presented_at is not null and b.decided_at is not null
            and ${between(sql`b.decided_at`, start, nowIso)}`)
      const [year] = await delay(yearAgoIso)
      const [month] = await delay(monthStart)
      const days = (value: number | null | undefined) => (Math.round((value ?? 0) * 10) / 10).toLocaleString(locale)
      return {
        respuesta: `En los últimos 12 meses, un paciente se demora en promedio ${days(year?.average)} días en aceptar un presupuesto, desde que se le entrega hasta que dice que sí (la mediana es de ${days(year?.median)} días), en ${year?.count ?? 0} presupuestos aceptados en todo o en parte.`,
        criterio: "Presupuestos aceptados en todo o en parte y decididos en los últimos 365 días: días entre presentado y decidido, en promedio. Es un «cuánto tardan»: mira 12 meses, como la regla de Argos.",
        nota: `Solo los decididos este mes: ${days(month?.average)} días en promedio (mediana ${days(month?.median)}) en ${month?.count ?? 0} presupuestos.`,
        datos: { doceMeses: year, mes: month },
      }
    },

    g111: async () => {
      const [limit] = await tx.execute<{ at: string }>(sql`select ${isoOf(sql`((${nowIso}::timestamptz at time zone ${tz}) - interval '1 month') at time zone ${tz}`)} as at`)
      const all = await budgets(awaits)
      const cut = new Date(limit?.at ?? nowIso).getTime()
      const rows = all.filter((row) => new Date(row.presented).getTime() < cut)
      const byMoney = [...rows].sort((a, b) => Number(b.pending) - Number(a.pending) || a.presented.localeCompare(b.presented))
      const words = (list: readonly Budget[]) => listOf(list.map((row) => ({ name: `${row.person} · N.º ${row.number}`, value: `desde el ${shortDate(row.presented)}, ${money(Number(row.pending))}` })))
      const over30 = all.filter((row) => new Date(row.presented).getTime() < h.now.getTime() - 30 * DAY_MS)
      return {
        respuesta: rows.length
          ? `Hoy ${plural(rows.length, "presupuesto lleva", "presupuestos llevan")} más de un mes esperando respuesta (entregados antes del ${shortDate(limit?.at ?? nowIso)}), de ${plural(new Set(rows.map((row) => row.patientId)).size, "paciente", "pacientes")}, por ${money(sumOf(rows, (row) => row.pending))} sin decidir. Los que esperan hace más: ${words(rows.slice(0, 5))}.`
          : "Hoy ningún presupuesto lleva más de un mes esperando respuesta.",
        criterio: "Presupuestos que esperan respuesta a hoy (budgetAwaitsAnswer) entregados hace más de un mes del calendario de la clínica, del más antiguo; se suma lo aún no decidido de la opción que vale.",
        nota: `Por lo que falta decidir: ${words(byMoney.slice(0, 5))}. Con 30 días en vez de un mes: ${over30.length}. En total esperan respuesta ${all.length}.`,
        datos: { masDeUnMes: rows.length, faltaDecidir: sumOf(rows, (row) => row.pending), lista: rows.map((row) => ({ numero: row.number, paciente: row.person, desde: row.presented, faltaDecidir: Number(row.pending) })) },
      }
    },

    g112: async () => {
      const result = await h.fig("aceptaron", "profesional")
      const year = await h.fig("aceptaron", "profesional", lastYear)
      const row = result.rows.find((item) => /luis prado/i.test(item.label))
      const yearRow = year.rows.find((item) => /luis prado/i.test(item.label))
      const month = await budgets(sql`${delivered} and u.name ilike '%luis prado%' and ${between(sql`b.presented_at`, monthStart, nowIso)}`)
      const ever = await budgets(sql`${delivered} and u.name ilike '%luis prado%'`)
      const accepted = (list: readonly Budget[]) => list.filter((item) => item.status === "aceptado" || item.status === "parcial")
      const full = month.filter((item) => item.status === "aceptado").length
      return {
        respuesta: month.length
          ? `En ${monthName} (hasta hoy) a Luis Prado le aceptaron ${accepted(month).length} de los ${month.length} presupuestos que armó y se entregaron este mes (${row ? h.show(result, row.value.value) : pct(accepted(month).length, month.length)}): ${full} enteros y ${accepted(month).length - full} en parte.`
          : `En ${monthName} Luis Prado todavía no tiene presupuestos entregados.`,
        criterio: "«Aceptaron su presupuesto» de Reportes por profesional, del mes en curso: los presupuestos que armó Luis Prado, entregados en el mes y aceptados en todo o en parte, a hoy.",
        nota: `En los últimos 12 meses: ${yearRow ? `${yearRow.value.part ?? 0} de ${yearRow.value.whole ?? 0} (${h.show(year, yearRow.value.value)})` : "ninguno"}. De todos los que armó desde siempre: ${accepted(ever).length} de ${ever.length} (${pct(accepted(ever).length, ever.length)}).`,
        datos: { mes: row?.value ?? null, enteros: full, doceMeses: yearRow?.value ?? null, siempre: { entregados: ever.length, aceptados: accepted(ever).length } },
      }
    },

    // --- Planes de tratamiento ----------------------------------------------------------------------

    g113: async () => {
      const [row] = await tx.execute<{ running: number; started: number; suspendedOnly: number; screen: number; plans: number }>(sql`
        with p as (
          select pi.plan_id,
            bool_or(pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado','en_curso')) as running,
            bool_or(pi.status in ('en_curso','realizado')) as started,
            bool_or(pi.decision_status = 'aceptado' and pi.status = 'suspendido') as suspended,
            bool_and(pi.status = 'realizado') as done, bool_and(pi.status in ('cancelado','reemplazado')) as dropped
          from treatment_plan_item pi
          join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
          where pi.organization_id = ${org}
          group by pi.plan_id)
        select count(*) filter (where running)::int as running, count(*) filter (where running and started)::int as started,
          count(*) filter (where suspended and not running)::int as "suspendedOnly",
          count(*) filter (where not done and not dropped)::int as screen, count(*)::int as plans
        from p`)
      const running = row?.running ?? 0
      return {
        respuesta: `Hoy hay ${plural(running, "plan de tratamiento en curso", "planes de tratamiento en curso")}: con tratamientos aceptados que aún falta hacer (por empezar, programados o en marcha). En ${row?.started ?? 0} de ellos ya se hizo o se empezó algo.`,
        criterio: "Planes (no heredados) con al menos un tratamiento aceptado por empezar, programado o en curso, a hoy. Un plan es de un paciente.",
        nota: `Aparte, ${plural(row?.suspendedOnly ?? 0, "plan solo tiene", "planes solo tienen")} tratamientos suspendidos por hacer. Con el estado que muestra la ficha («En curso»: todo plan que no está terminado ni cancelado, aunque solo tenga tratamientos sin aceptar o rechazados): ${row?.screen ?? 0} de ${row?.plans ?? 0} planes.`,
        datos: { row },
      }
    },

    g114: async () => {
      const rows = await tx.execute<{
        planId: string
        patientId: string
        person: string
        names: string[]
        suspended: boolean
        onlySuspended: boolean
        lastVisit: string | null
        total: number
      }>(sql`
        with items as (
          select pi.plan_id, pi.patient_id, pi.status, coalesce(s.name, pi.title) as name
          from treatment_plan_item pi
          join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
          left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
          where pi.organization_id = ${org} and pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado','en_curso','suspendido')
            and not exists (select 1 from appointment n where n.organization_id = pi.organization_id and n.patient_id = pi.patient_id
              and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))),
        stalled as (
          select plan_id, patient_id, array_agg(distinct name order by name) as names, bool_or(status = 'suspendido') as suspended,
            bool_and(status = 'suspendido') as only_suspended
          from items group by plan_id, patient_id)
        select st.plan_id as "planId", st.patient_id as "patientId", pp.display_name as person, st.names, st.suspended, st.only_suspended as "onlySuspended",
          ${isoOf(sql`(select max(a.starts_at) from appointment a where a.organization_id = ${org} and a.patient_id = st.patient_id and a.status = 'atendida')`)} as "lastVisit",
          count(*) over()::int as total
        from stalled st ${joinPerson(sql`st.patient_id`)}
        order by (select max(a.starts_at) from appointment a where a.organization_id = ${org} and a.patient_id = st.patient_id and a.status = 'atendida') nulls first, pp.display_name`)
      const unbooked = await getReportList(tx, org, { period: "este_mes", list: "upcoming_unbooked", limit: 5000 }, h.now)
      const total = rows[0]?.total ?? 0
      const suspended = rows.filter((row) => row.suspended).length
      const treatments = (names: string[]) => (names.length > 1 ? `${names[0]} y ${plural(names.length - 1, "más", "más")}` : (names[0] ?? "—"))
      return {
        respuesta: total
          ? `Hoy ${plural(total, "plan de tratamiento está parado", "planes de tratamiento están parados")}: tienen tratamientos aceptados por hacer y el paciente no tiene ninguna cita por venir (${suspended} de ellos con algo suspendido). Los que llevan más tiempo sin una cita atendida: ${listOf(rows.slice(0, 5).map((row) => ({ name: row.person, value: `${row.lastVisit ? `última cita atendida el ${shortDate(row.lastVisit)}` : "nunca vino"}; ${treatments(row.names)}` })))}.`
          : "Hoy ningún plan con tratamientos aceptados por hacer está sin cita.",
        criterio: "Planes (no heredados) con tratamientos aceptados por empezar, programados, en curso o suspendidos, de pacientes sin una cita programada o confirmada por venir, a hoy; de la última cita atendida más antigua a la más reciente.",
        nota: `«Aceptaron y no tienen cita» de Reportes, por lo aceptado en presupuestos que falta hacer: ${plural(unbooked.total, "paciente", "pacientes")} por ${money(sumOf(unbooked.rows, (row) => row.cents ?? 0))}. Sin contar los planes que solo tienen tratamientos suspendidos: ${rows.filter((row) => !row.onlySuspended).length}.`,
        datos: { total, conSuspendidos: suspended, primeros: rows.slice(0, 20), reportesSinCita: { pacientes: unbooked.total, centavos: sumOf(unbooked.rows, (row) => row.cents ?? 0) } },
      }
    },

    g115: async () => {
      const yearStart = dayStart(tz, window.from.year, 1, 1)
      const [row] = await tx.execute<{ year: number; strict: number; month: number; lastYear: number }>(sql`
        with p as (
          select pi.plan_id, bool_and(pi.status in ('realizado','cancelado','reemplazado')) as closed, bool_and(pi.status = 'realizado') as all_done,
            bool_or(pi.status = 'realizado') as some_done, max(pi.completed_at) filter (where pi.status = 'realizado') as last
          from treatment_plan_item pi
          join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
          where pi.organization_id = ${org}
          group by pi.plan_id)
        select count(*) filter (where closed and some_done and ${between(sql`last`, yearStart, nowIso)})::int as year,
          count(*) filter (where all_done and ${between(sql`last`, yearStart, nowIso)})::int as strict,
          count(*) filter (where closed and some_done and ${between(sql`last`, monthStart, nowIso)})::int as month,
          count(*) filter (where closed and some_done and ${between(sql`last`, dayStart(tz, window.from.year - 1, 1, 1), yearStart)})::int as "lastYear"
        from p`)
      return {
        respuesta: `En ${window.from.year} (hasta hoy) se terminaron ${plural(row?.year ?? 0, "plan de tratamiento", "planes de tratamiento")}: ya no les queda nada por hacer (lo que no se hizo se canceló) y su último tratamiento se realizó este año.`,
        criterio: "Planes (no heredados) cuyos tratamientos están todos realizados, cancelados o reemplazados, con al menos uno realizado, y cuyo último tratamiento realizado terminó entre el 1 de enero y hoy, a hoy.",
        nota: `Solo los que tienen todo realizado, sin nada cancelado (el «Completado» de la ficha): ${row?.strict ?? 0}. En ${monthName}: ${row?.month ?? 0}. En todo ${window.from.year - 1}: ${row?.lastYear ?? 0}.`,
        datos: { row },
      }
    },

    g116: async () => {
      const coming = await h.fig("lo_que_viene")
      const work = await upcomingWork(tx, org, h.scope.currency, h.now)
      const waiting = await budgets(awaits)
      const [plan] = await tx.execute<{ cents: string; items: number }>(sql`
        select coalesce(sum(pi.price_cents * pi.planned_sessions), 0)::text as cents, count(*)::int as items
        from treatment_plan_item pi
        join treatment_plan tp on tp.organization_id = pi.organization_id and tp.id = pi.plan_id and not tp.is_legacy
        where pi.organization_id = ${org} and pi.decision_status = 'aceptado' and pi.status not in ('realizado','cancelado','reemplazado')`)
      return {
        respuesta: `Hoy falta hacer ${h.show(coming)} de lo aceptado en los planes que siguen abiertos, al precio acordado en su presupuesto, de ${plural(work.patients, "paciente", "pacientes")}; ${
          work.unbooked.patients === work.patients
            ? `ninguno de ellos tiene una cita por venir`
            : `de eso, ${money(work.unbooked.cents)} es de ${plural(work.unbooked.patients, "paciente", "pacientes")} sin cita por venir`
        }.`,
        criterio: "«Lo que viene» de Reportes: lo aceptado en presupuestos (aceptados en todo o en parte) cuyo tratamiento no está realizado, cancelado ni reemplazado, a su precio acordado, a hoy.",
        nota: `Si cuentas también lo que aún no aceptan (presupuestos que esperan respuesta, lo no decidido): ${money(sumOf(waiting, (row) => row.pending))} más, en ${waiting.length} presupuestos. Con el precio de cada tratamiento aceptado del plan en vez del presupuesto: ${money(Number(plan?.cents ?? 0))} (${plan?.items ?? 0} tratamientos).`,
        datos: { loQueViene: coming.total, sinCita: work.unbooked, esperanRespuesta: sumOf(waiting, (row) => row.pending), porPlan: plan },
      }
    },

    g117: async () => {
      const list = await getReportList(tx, org, { period: "este_mes", list: "upcoming_unbooked", limit: 5000 }, h.now)
      const coming = await h.fig("lo_que_viene")
      const cents = sumOf(list.rows, (row) => row.cents ?? 0)
      const recent = list.rows.filter((row) => new Date(row.at).getTime() >= window.start.getTime()).length
      return {
        respuesta: list.total
          ? `Hoy ${plural(list.total, "paciente aceptó", "pacientes aceptaron")} su presupuesto, ${list.total === 1 ? "tiene" : "tienen"} tratamientos por hacer y no ${list.total === 1 ? "tiene" : "tienen"} ninguna cita por venir, por ${money(cents)}. Los de más monto: ${listOf(list.rows.slice(0, 5).map((row) => ({ name: row.personName, value: `${money(row.cents ?? 0)}, ${firstOf(row.title)}` })))}.`
          : "Hoy todos los pacientes con algo aceptado por hacer tienen una cita por venir.",
        criterio: "La lista «Aceptaron y no tienen cita» de Reportes (la de «Lo que viene»): pacientes con lo aceptado en un presupuesto que falta hacer y sin cita programada o confirmada por venir, a hoy, de más a menos monto.",
        nota: `«Lo que viene» entero, con cita o sin ella: ${h.show(coming)} de ${plural(coming.total.part ?? 0, "paciente", "pacientes")}. De los ${list.total} sin cita, ${recent} aceptaron este mes.`,
        datos: { total: list.total, centavos: cents, primeros: list.rows.slice(0, 20).map((row) => ({ name: row.personName, cents: row.cents, title: row.title, at: row.at })) },
      }
    },

    g118: async () => {
      const span = latestMonth(10)
      const name = monthLabel(h, span, false)
      const partial = span.end.getTime() === h.now.getTime()
      const rows = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, span.start, span.end)}`)
      const sorted = [...rows].sort((a, b) => Number(b.cents) - Number(a.cents) || a.presented.localeCompare(b.presented))
      const top = sorted[0]
      const bestAccepted = [...rows].sort((a, b) => Number(b.accepted) - Number(a.accepted) || a.presented.localeCompare(b.presented))[0]
      return {
        respuesta: top
          ? `El presupuesto más grande de ${name}${partial ? " (hasta hoy)" : ""} es el N.º ${top.number} de ${top.person}, por ${money(Number(top.cents))}, entregado el ${shortDate(top.presented)}${top.professional ? ` (lo armó ${top.professional})` : ""}. ${statusWords(top)}.`
          : `En ${name} no se entregó ningún presupuesto.`,
        criterio: `Presupuestos entregados en ${name} de ${span.year} (sin borradores, sustituidos ni cancelados), por el valor de la opción que vale; su respuesta, a hoy.`,
        nota: `Le siguen ${listOf(sorted.slice(1, 3).map((row) => ({ name: `N.º ${row.number} de ${row.person}`, value: `${money(Number(row.cents))}, ${row.status}` })))}.${bestAccepted && Number(bestAccepted.accepted) > 0 && bestAccepted.id !== top?.id ? ` Por lo aceptado, el más grande es el N.º ${bestAccepted.number} de ${bestAccepted.person}: ${money(Number(bestAccepted.accepted))} aceptados.` : ""}`,
        datos: { entregados: rows.length, mayores: sorted.slice(0, 5).map((row) => ({ numero: row.number, paciente: row.person, valor: Number(row.cents), aceptado: Number(row.accepted), estado: row.status })) },
      }
    },

    g119: async () => {
      const month = await byBranch(monthStart, nowIso)
      const year = await byBranch(yearAgoIso, nowIso)
      const clinic = await h.fig("aceptaron")
      const words = (list: typeof month) => listOf(list.filter((row) => row.presented > 0).map((row) => ({ name: row.name, value: `${row.accepted} de ${row.presented}, ${pct(row.accepted, row.presented)}` })))
      const top = month.find((row) => row.presented > 0)
      const empty = month.filter((row) => row.presented === 0).map((row) => row.name)
      const byRate = [...month].filter((row) => row.presented > 0).sort((a, b) => b.accepted / b.presented - a.accepted / a.presented)[0]
      return {
        respuesta: top
          ? `Un presupuesto no guarda en qué sede se hizo (en Reportes se mide para toda la clínica); por la sede de la atención donde se armó, en ${monthName} (hasta hoy) se aceptan más en ${top.name}: ${top.accepted} de ${top.presented} entregados (${pct(top.accepted, top.presented)}). Todas: ${words(month)}.${byRate && byRate.name !== top.name ? ` Por porcentaje, la más alta es ${byRate.name}.` : ""}${empty.length ? ` ${empty.join(" y ")} no ${empty.length === 1 ? "tiene" : "tienen"} presupuestos.` : ""}`
          : `En ${monthName} todavía no se entregó ningún presupuesto.`,
        criterio:
          "Presupuestos entregados en el mes en curso y aceptados en todo o en parte, a hoy (la base de «Aceptaron su presupuesto»), por la sede de la atención donde se indicó su primer tratamiento o, si no la hay, la de quien lo armó (cada profesional atiende en una sola sede). De más a menos aceptados.",
        nota: `En los últimos 12 meses: ${words(year)}. En toda la clínica este mes: ${h.show(clinic)} (${clinic.total.part ?? 0} de ${clinic.total.whole ?? 0}).`,
        datos: { mes: month, doceMeses: year, clinica: clinic.total },
      }
    },

    g120: async () => {
      const ortho = (start: string) =>
        tx.execute<{ lines: number; accepted: number; waiting: number; cents: string; acceptedCents: string; budgets: number }>(sql`
          select count(*)::int as lines, count(*) filter (where ${acceptedLine})::int as accepted,
            count(*) filter (where i.decision in ('pendiente','pospuesto') and ${awaits})::int as waiting,
            coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents,
            coalesce(sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}), 0)::text as "acceptedCents",
            count(distinct b.id)::int as budgets
          from treatment_budget b ${valueLines}
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          left join org_specialty os on os.organization_id = s.organization_id and os.id = s.specialty_id
          where b.organization_id = ${org} and ${delivered} and ${between(sql`b.presented_at`, start, nowIso)}
            and (coalesce(s.name, i.title) ilike '%ortodon%' or os.name ilike '%ortodon%')`)
      const [month] = await ortho(monthStart)
      const [year] = await ortho(yearAgoIso)
      const lines = month?.lines ?? 0
      const accepted = month?.accepted ?? 0
      return {
        respuesta: lines
          ? `En ${monthName} (hasta hoy) se aceptó el ${pct(accepted, lines)} de la ortodoncia presupuestada: ${accepted} de ${lines} tratamientos de ortodoncia en los presupuestos entregados (${money(Number(month?.acceptedCents ?? 0))} de ${money(Number(month?.cents ?? 0))}).`
          : `En ${monthName} todavía no se presupuestó ortodoncia.`,
        criterio: "Tratamientos de ortodoncia (especialidad o nombre con «ortodoncia») en la opción que vale de los presupuestos entregados en el mes en curso; aceptados ÷ cotizados, según su respuesta a hoy.",
        nota: `En los últimos 12 meses, con más casos y más tiempo para decidir: ${pct(year?.accepted ?? 0, year?.lines ?? 0)} (${year?.accepted ?? 0} de ${year?.lines ?? 0}). Este mes ${month?.waiting ?? 0} todavía esperan respuesta: sin contarlos, ${pct(accepted, lines - (month?.waiting ?? 0))}.`,
        datos: { mes: month, doceMeses: year },
      }
    },

    g121: async () => {
      const month = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, monthStart, nowIso)}`)
      const partial = month.filter((row) => row.status === "parcial")
      const decided = await budgets(sql`b.status = 'parcial' and ${between(sql`b.decided_at`, monthStart, nowIso)}`)
      const year = await budgets(sql`${delivered} and ${between(sql`b.presented_at`, yearAgoIso, nowIso)}`)
      const yearPartial = year.filter((row) => row.status === "parcial").length
      return {
        respuesta: `En ${monthName} (hasta hoy) se aceptaron solo en parte ${plural(partial.length, "presupuesto", "presupuestos")} de los ${month.length} entregados${partial.length ? `: ${listOf(partial.map((row) => ({ name: `N.º ${row.number} de ${row.person}`, value: `${money(Number(row.accepted))} aceptados de ${money(Number(row.cents))}` })))}` : ""}.`,
        criterio: "Presupuestos entregados en el mes en curso que hoy están aceptados en parte (la base de «Aceptaron su presupuesto» de Reportes), con lo aceptado de la opción que vale.",
        nota: `Contando los que se aceptaron en parte durante este mes, aunque se entregaran antes: ${decided.length}. En los últimos 12 meses: ${yearPartial} de ${year.length} entregados (${pct(yearPartial, year.length)}).`,
        datos: { entregados: month.length, parciales: partial.map((row) => ({ numero: row.number, paciente: row.person, valor: Number(row.cents), aceptado: Number(row.accepted) })), decididosEsteMes: decided.length, doceMeses: { parciales: yearPartial, entregados: year.length } },
      }
    },

    g122: async () => {
      const [row] = await tx.execute<{ overHalf: number; open: number; finished: number; half: number; overHalfMoney: number; plans: number; dentist: string | null }>(sql`
        with plans as (
          select tp.id, u.name from treatment_plan tp join "user" u on u.id = tp.created_by
          where tp.organization_id = ${org} and not tp.is_legacy and u.name ilike '%ana torres%'),
        progress as (
          select pi.plan_id, count(*) filter (where pi.status <> 'cancelado') as total, count(*) filter (where pi.status = 'realizado') as done,
            coalesce(sum(pi.price_cents) filter (where pi.status <> 'cancelado'), 0) as cents, coalesce(sum(pi.price_cents) filter (where pi.status = 'realizado'), 0) as done_cents
          from treatment_plan_item pi join plans pl on pl.id = pi.plan_id
          where pi.organization_id = ${org} and pi.decision_status = 'aceptado' and pi.status <> 'reemplazado'
          group by pi.plan_id)
        select count(*) filter (where done * 2 > total and done < total)::int as "overHalf", count(*) filter (where done < total)::int as open,
          count(*) filter (where total > 0 and done = total)::int as finished, count(*) filter (where done * 2 = total and done < total)::int as half,
          count(*) filter (where done_cents * 2 > cents and done < total)::int as "overHalfMoney",
          (select count(*) from plans)::int as plans, (select min(name) from plans) as dentist
        from progress`)
      const name = row?.dentist ?? "Dra. Ana Torres"
      const overHalf = row?.overHalf ?? 0
      return {
        respuesta: `${plural(overHalf, "plan de tratamiento", "planes de tratamiento")} ${ofName(name)} ${overHalf === 1 ? "va" : "van"} por más de la mitad: ${overHalf === 1 ? "tiene" : "tienen"} hecho más de la mitad de sus tratamientos aceptados y aún les falta algo. Son de los ${row?.open ?? 0} planes suyos que siguen abiertos.`,
        criterio: "Planes que armó la Dra. Ana Torres (quien indicó su primer tratamiento), a hoy: tratamientos aceptados realizados ÷ aceptados sin los cancelados, más de la mitad y menos del total.",
        nota: `Por dinero (lo realizado ÷ lo aceptado, al precio del plan): ${row?.overHalfMoney ?? 0}. Justo en la mitad: ${row?.half ?? 0}. Ya terminados: ${row?.finished ?? 0}, de ${row?.plans ?? 0} planes suyos.`,
        datos: { row },
      }
    },

    g123: async () => {
      const lastMonday = addDays(monday, -7)
      const lastSunday = addDays(monday, -1)
      const rows = await byBranch(startOf(lastMonday), startOf(monday))
      const branch = await branchNamed("surco")
      const total = sumOf(rows, (row) => row.presented)
      const week = `la semana pasada (del ${dayWords(lastMonday)} al ${dayWords(lastSunday)})`
      const [made] = await tx.execute<{ created: number }>(sql`
        select count(*)::int as created from treatment_budget b
        where b.organization_id = ${org} and ${between(sql`b.created_at`, startOf(lastMonday), startOf(monday))}`)
      const words = listOf(rows.filter((row) => row.presented > 0).map((row) => ({ name: row.name, value: `${row.presented}` })))
      if (!branch) {
        return {
          respuesta: `No hay una sede Surco en la clínica. ${week[0]?.toUpperCase()}${week.slice(1)} se entregaron ${total} presupuestos: ${words}.`,
          criterio: "Sedes activas de la clínica.",
          datos: { porSede: rows },
        }
      }
      const facts = await branchFacts(branch.id, startOf(lastMonday), startOf(monday))
      const count = rows.find((row) => row.id === branch.id)?.presented ?? 0
      const lacks = [facts.people === 0 ? "profesionales con horario" : null, facts.encounters === 0 ? "atenciones registradas" : null].filter((item): item is string => item !== null)
      return {
        respuesta: count
          ? `${week[0]?.toUpperCase()}${week.slice(1)} la ${branch.name} entregó ${plural(count, "presupuesto", "presupuestos")}, de ${total} en toda la clínica (${words}).`
          : `Ninguno: ${week} la ${branch.name} no entregó presupuestos${lacks.length ? `; no tiene ${orList(lacks)}` : ""}. En toda la clínica se entregaron ${total}: ${words}.`,
        criterio:
          "Presupuestos entregados de lunes a domingo de la semana pasada (día de la clínica, sin borradores, sustituidos ni cancelados), por la sede de la atención donde se indicó su primer tratamiento o, si no la hay, la de quien lo armó: un presupuesto no guarda su sede.",
        nota: `Creados esa semana, entregados o no (en toda la clínica): ${made?.created ?? 0}.`,
        datos: { semana: { desde: lastMonday, hasta: lastSunday }, porSede: rows, hechos: facts },
      }
    },

    g124: async () => {
      const leftOut = (start: string) =>
        tx.execute<{ name: string; times: number; rejected: number; postponed: number; cents: string; budgets: number }>(sql`
          select coalesce(s.name, i.title) as name, count(*)::int as times, count(*) filter (where i.decision = 'rechazado')::int as rejected,
            count(*) filter (where i.decision = 'pospuesto')::int as postponed, sum(i.price_cents::bigint * ${units})::text as cents, count(distinct b.id)::int as budgets
          from treatment_budget b ${valueLines}
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          where b.organization_id = ${org} and b.status = 'parcial' and i.decision <> 'aceptado' and ${between(sql`b.presented_at`, start, nowIso)}
          group by 1 order by 2 desc, sum(i.price_cents::bigint * ${units}) desc, 1`)
      const partials = async (start: string) => {
        const [row] = await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from treatment_budget b where b.organization_id = ${org} and b.status = 'parcial' and ${between(sql`b.presented_at`, start, nowIso)}`)
        return row?.count ?? 0
      }
      const month = await leftOut(monthStart)
      const year = await leftOut(yearAgoIso)
      const monthCount = await partials(monthStart)
      const yearCount = await partials(yearAgoIso)
      const words = (rows: typeof month) => listOf(rows.slice(0, 5).map((row) => ({ name: row.name, value: `${plural(row.times, "vez", "veces")}, ${money(Number(row.cents))}` })))
      const rejected = sumOf(month, (row) => row.rejected)
      const postponed = sumOf(month, (row) => row.postponed)
      const undecided = sumOf(month, (row) => row.times) - rejected - postponed
      const how = [
        rejected ? `${rejected} se ${rejected === 1 ? "rechazó" : "rechazaron"}` : null,
        postponed ? `${postponed} ${postponed === 1 ? "quedó" : "quedaron"} para después` : null,
        undecided ? `${undecided} sin decidir` : null,
      ].filter((item): item is string => item !== null)
      return {
        respuesta: month.length
          ? `En ${monthName} (hasta hoy) se aceptaron en parte ${plural(monthCount, "presupuesto", "presupuestos")} y lo que dejaron fuera fue ${words(month)}.`
          : `En ${monthName} ningún presupuesto se aceptó solo en parte.`,
        criterio: "Presupuestos entregados en el mes en curso y aceptados en parte, a hoy: los tratamientos de la opción que vale que no se aceptaron (rechazados, pospuestos o sin decidir), por veces y después por monto.",
        nota: `En los últimos 12 meses (${plural(yearCount, "presupuesto aceptado", "presupuestos aceptados")} en parte): ${words(year)}.${how.length ? ` De lo dejado fuera este mes, ${andList(how)}.` : ""}`,
        datos: { mes: month, doceMeses: year, parcialesMes: monthCount, parcialesDoceMeses: yearCount },
      }
    },

    g125: async () => {
      const all = await budgets(awaits)
      const olderThan = (days: number) => all.filter((row) => new Date(row.presented).getTime() < h.now.getTime() - days * DAY_MS)
      const over30 = olderThan(30)
      const over90 = olderThan(90)
      const [cancelled] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from treatment_budget b where b.organization_id = ${org} and b.status = 'cancelado'`)
      return {
        respuesta: `En odentIA un presupuesto no vence: no tiene fecha de vencimiento y espera respuesta hasta que el paciente decida o se cancele. Lo más cercano: hoy ${plural(over30.length, "presupuesto espera", "presupuestos esperan")} respuesta hace más de 30 días (${money(sumOf(over30, (row) => row.pending))} sin decidir), ${over90.length} de ellos hace más de 90.`,
        criterio: "Los presupuestos no tienen vigencia en odentIA. Se ofrecen los que esperan respuesta a hoy (budgetAwaitsAnswer) por antigüedad desde que se entregaron, con lo aún no decidido de la opción que vale.",
        nota: `En total esperan respuesta ${all.length} (${money(sumOf(all, (row) => row.pending))}). Cancelados sin respuesta: ${cancelled?.count ?? 0}.`,
        datos: { esperan: all.length, masDe30Dias: over30.length, masDe90Dias: over90.length, cancelados: cancelled?.count ?? 0 },
      }
    },
  }
}
