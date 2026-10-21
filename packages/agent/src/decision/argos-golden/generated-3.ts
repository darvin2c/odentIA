/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 3:
 * g051 a g075, pacientes y equipo. Pacientes nuevos, «Cómo nos conocieron», activos, «Sin venir»
 * y lo cobrado por profesional son las cifras de Reportes (también de una sede); lo demás sigue
 * las reglas de `patients.ts`: personas sin Spam ni bloqueo, citas atendidas hasta ahora y «cita
 * por venir» programada o confirmada después de ahora. «Sigue viniendo» es lo contrario de
 * «Sin venir»: una cita atendida en los últimos 6 meses o una por venir.
 */
import {
  addDays,
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  computeFigure,
  dayStart,
  type FigureGroup,
  type FigureResult,
  firstVisitSql,
  lapsedSql,
  occupancyMany,
  overdueDebtSql,
  referralMany,
  reportDayOf,
  reportScope,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel } from "./trends.js"

const DAY_MS = 86_400_000
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
/** De lunes a domingo, como se lee una semana. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** «Cómo nos conoció» con las palabras de Reportes (`REFERRAL_KIND_LABELS`). */
const REFERRAL_WORDS: Record<string, string> = {
  recomendacion: "Recomendación de alguien",
  redes_sociales: "Redes sociales",
  google_mapas: "Google o mapas",
  paso_por_aqui: "Pasaba por aquí",
  convenio: "Convenio o empresa",
  otro: "Otro",
}

export function generatedSolvers3(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, tz } = h
  const { locale, currency, window } = h.scope
  const nowIso = h.now.toISOString()
  const monthStart = h.monthStart
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const pct = (part: number, total: number): string =>
    total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato"
  const dayName = (iso: string | Date): string =>
    new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: tz,
    }).format(new Date(iso))
  const shortDay = (iso: string | Date): string =>
    new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: tz,
    }).format(new Date(iso))
  const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const thisMonth = `este mes (${monthLabel(h, window.from)}, hasta hoy)`
  const ThisMonth = capital(thisMonth)
  const sameDaysBefore = `los mismos días de ${monthLabel(h, window.previous.from, false)}`
  const hoursOf = (minutes: number): string =>
    `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(locale)} h`
  const clock = (minutes: number): string =>
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`
  const plural = (count: number, one: string, many: string): string =>
    `${count} ${count === 1 ? one : many}`
  /** «la Dra. Ana Torres», «el Dr. Diego Salas»; sin título, el nombre solo. */
  const the = (name: string): string =>
    /^Dra\.?\s/.test(name) ? `la ${name}` : /^Dr\.?\s/.test(name) ? `el ${name}` : name
  /** Los últimos 365 días hasta hoy, como periodo de Reportes. */
  const lastYearPeriod = `${reportDayOf(tz, new Date(yearAgo))}..${reportDayOf(tz, h.now)}`

  /** El periodo de Reportes (`este_mes`, `2026-08`, `ultimos_3_meses`…) y, si se pide, de una sede. */
  const scopeOf = (period: string, branchId?: string) =>
    reportScope(tx, org, { period, branchId }, h.now)
  /** Una cifra de Reportes en ese periodo y sede. */
  const figAt = async (
    figure: string,
    group: FigureGroup,
    period: string,
    branchId?: string,
  ): Promise<FigureResult> =>
    computeFigure({ ...h.ctx, scope: await scopeOf(period, branchId) }, { figure, group })
  /** El año calendario en curso hasta ahora y el mismo tramo del anterior («Este año» de Reportes). */
  const calendarYear = async () => (await scopeOf("este_ano")).window
  /** La clave del último `month` que ya empezó: «en octubre» es el de este año si ya llegó. */
  const lastMonthKey = (month: number): string => {
    const year = window.from.month >= month ? window.from.year : window.from.year - 1
    return `${year}-${String(month).padStart(2, "0")}`
  }
  const monthOfKey = (key: string) => ({
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
  })

  const branches = async () => [
    ...(await tx.execute<{ id: string; name: string }>(
      sql`select id, name from branch where organization_id = ${org} and is_active order by name`,
    )),
  ]
  const branchNamed = async (word: string) =>
    (await branches()).find((row) => row.name.toLowerCase().includes(word.toLowerCase())) ?? null
  /** Un profesional de la clínica por su nombre: quien tiene horario o citas en ella. */
  const dentistNamed = async (word: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${`%${word}%`}
        and (u.id in (select dentist_user_id from appointment where organization_id = ${org}) or u.id in (select dentist_user_id from professional_schedule where organization_id = ${org}))
      order by u.name limit 1`)
    return row ?? null
  }

  /** La persona del paciente, sin Spam ni bloqueados. */
  const person = (patientColumn: SQL) =>
    sql`join patient p on p.organization_id = ${org} and p.id = ${patientColumn} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null`
  /** Citas atendidas de pacientes sin Spam ni bloqueo, hasta ahora. */
  const attended = sql`attended as (
    select a.id, a.patient_id, a.starts_at, a.ends_at, a.branch_id, a.dentist_user_id from appointment a ${person(sql`a.patient_id`)}
    where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz)`
  const upcoming = (
    patientColumn: SQL,
  ) => sql`exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = ${patientColumn}
    and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))`
  /** Hace `months` meses en el calendario de la clínica, como «Sin venir». */
  const monthsAgo = (months: number) =>
    sql`((${nowIso}::timestamptz at time zone ${tz}) - make_interval(months => ${months})) at time zone ${tz}`
  /** Inicio del día civil `YYYY-MM-DD` de la clínica. */
  const startOfDay = (day: string): Date => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    return dayStart(tz, year, month, date)
  }
  /** «Recomendación de alguien (12, 30 %), …» de una cifra por «Cómo nos conoció». */
  const referralRows = (result: FigureResult) =>
    h.listOf(
      result.rows.map((row) => ({
        name: row.label,
        value: `${row.value.value ?? 0}, ${pct(row.value.value ?? 0, result.total.value ?? 0)}`,
      })),
    )

  return {
    g051: async () => {
      const all = await branches()
      const surco = await branchNamed("Surco")
      const clinic = await h.fig("como_nos_conocieron")
      const bySede = await h.fig("pacientes_nuevos", "sede")
      const sedeWords = h.listOf(
        bySede.rows
          .filter((row) => (row.value.value ?? 0) > 0)
          .map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })),
      )
      if (!surco)
        return {
          respuesta: `No hay una sede Surco: tus sedes son ${all.map((row) => row.name).join(", ")}. ${ThisMonth} los ${clinic.total.value ?? 0} pacientes nuevos de la clínica llegaron por ${referralRows(clinic)}.`,
          criterio:
            "La sede no existe: se ofrece «Cómo nos conocieron» de Reportes de toda la clínica, del mes en curso.",
          datos: { sedes: all, clinica: clinic.rows },
        }
      const result = await figAt("como_nos_conocieron", "como_nos_conocio", "este_mes", surco.id)
      const year = await figAt("como_nos_conocieron", "como_nos_conocio", lastYearPeriod, surco.id)
      const [ever] = await tx.execute<{ attended: number; last: string | null }>(sql`
        select count(*)::int as attended, max(starts_at)::text as last from appointment
        where organization_id = ${org} and branch_id = ${surco.id} and status = 'atendida' and starts_at < ${nowIso}::timestamptz`)
      const total = result.total.value ?? 0
      const yearTotal = year.total.value ?? 0
      const never = (ever?.attended ?? 0) === 0
      return {
        respuesta:
          total > 0
            ? `${ThisMonth} los ${total} pacientes nuevos de ${surco.name} llegaron por ${referralRows(result)}.`
            : `${ThisMonth} ${surco.name} no tuvo pacientes nuevos${never ? ": todavía no tiene ninguna cita atendida registrada" : ""}, así que no hay a quién preguntarle cómo nos conoció. En toda la clínica, los ${clinic.total.value ?? 0} pacientes nuevos del mes (${sedeWords}) llegaron por ${referralRows(clinic)}.`,
        criterio:
          "«Cómo nos conocieron» de Reportes con la sede elegida, del mes en curso: lo que eligió en el registro cada paciente nuevo cuya primera cita atendida fue en esa sede.",
        nota: `En los últimos 12 meses, en ${surco.name}: ${yearTotal > 0 ? `${yearTotal} pacientes nuevos, por ${referralRows(year)}` : "ningún paciente nuevo"}.${never ? "" : ` Su última cita atendida fue el ${dayName(ever?.last ?? nowIso)}.`}`,
        datos: {
          sede: surco,
          mes: result.rows,
          doceMeses: year.rows,
          citasAtendidas: ever?.attended ?? 0,
          clinica: clinic.rows,
          nuevosPorSede: bySede.rows,
        },
      }
    },

    g052: async () => {
      const result = await h.fig("como_nos_conocieron", "como_nos_conocio", "este_ano")
      const year = await calendarYear()
      const total = result.total.value ?? 0
      const referred = result.rows.find((row) => row.key === "recomendacion")
      const value = referred?.value.value ?? 0
      const [before] = await referralMany(tx, org, { branch: null }, [year.previous])
      const beforeTotal = (before ?? []).reduce((sum, row) => sum + row.count, 0)
      const beforeValue = (before ?? []).find((row) => row.kind === "recomendacion")?.count ?? 0
      const month = await h.fig("como_nos_conocieron")
      const monthValue = month.rows.find((row) => row.key === "recomendacion")?.value.value ?? 0
      return {
        respuesta: `En lo que va de ${year.from.year} (del 1 de enero a hoy), ${value} de tus ${total} pacientes nuevos llegaron por «${referred?.label ?? REFERRAL_WORDS.recomendacion}» (${pct(value, total)}). odentIA no registra quién los recomendó, así que no distingue si fue otro paciente u otra persona.`,
        criterio:
          "«Cómo nos conocieron» de Reportes, este año hasta hoy: pacientes nuevos (primera cita atendida en el año) que eligieron «Recomendación de alguien» en su registro.",
        nota: `En el mismo tramo de ${year.previous.from.year} fueron ${beforeValue} de ${beforeTotal}. ${capital(thisMonth)}: ${monthValue} de ${month.total.value ?? 0}.`,
        datos: {
          año: result.rows,
          total,
          recomendados: value,
          añoAnterior: before ?? [],
          mes: month.rows,
        },
      }
    },

    g053: async () => {
      const [row] = await tx.execute<{
        people: number
        appointments: number
        confirmed: number
        week: number
      }>(sql`
        select count(distinct a.patient_id)::int as people, count(*)::int as appointments,
          count(*) filter (where a.status = 'confirmada')::int as confirmed,
          count(*) filter (where a.starts_at < ${nowIso}::timestamptz + interval '7 days')::int as week
        from appointment a ${person(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz`)
      const [stale] = await tx.execute<{ appointments: number; people: number; today: number }>(sql`
        select count(*)::int as appointments, count(distinct a.patient_id)::int as people,
          count(*) filter (where (a.starts_at at time zone ${tz})::date = (${nowIso}::timestamptz at time zone ${tz})::date)::int as today
        from appointment a ${person(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at <= ${nowIso}::timestamptz`)
      const people = row?.people ?? 0
      return {
        respuesta:
          people > 0
            ? `Hoy ${people} ${people === 1 ? "paciente tiene" : "pacientes tienen"} una cita por venir: ${row?.appointments ?? 0} citas programadas o confirmadas desde ahora (${row?.confirmed ?? 0} ya confirmadas).`
            : "Hoy ningún paciente tiene una cita por venir: no hay citas programadas ni confirmadas después de ahora.",
        criterio:
          "Pacientes distintos (sin Spam ni bloqueados) con una cita programada o confirmada que empieza después de ahora.",
        nota: `En los próximos 7 días: ${row?.week ?? 0} citas. Quedan además ${stale?.appointments ?? 0} citas programadas o confirmadas cuya hora ya pasó sin marcar si vino el paciente (${stale?.people ?? 0} pacientes; ${stale?.today ?? 0} de hoy): no cuentan como por venir.`,
        datos: { porVenir: row, pasaronSinMarcar: stale },
      }
    },

    g054: async () => {
      const result = await h.fig("activos")
      const lapsed = await h.fig("sin_venir")
      const [row] = await tx.execute<{ year: number; ever: number; files: number }>(sql`
        with ${attended}
        select (select count(distinct patient_id) from attended where starts_at >= ${yearAgo}::timestamptz)::int as year,
          (select count(distinct patient_id) from attended)::int as ever,
          (select count(*) from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null and pp.is_active
            where p.organization_id = ${org})::int as files`)
      return {
        respuesta: `Hoy tienes ${h.show(result)} pacientes activos: con al menos una cita atendida en los últimos 18 meses. A la misma altura del mes pasado eran ${h.show(result, result.previous?.value ?? null)}.`,
        criterio:
          "«Pacientes activos» de Reportes: personas con una cita atendida en los 18 meses anteriores a hoy.",
        nota: `Con una cita atendida en los últimos 12 meses: ${row?.year ?? 0}. Fichas de paciente sin archivar: ${row?.files ?? 0}; atendidos alguna vez: ${row?.ever ?? 0}. De los que vinieron alguna vez, ${h.show(lapsed)} llevan más de 6 meses sin venir y sin nada pendiente («Sin venir»).`,
        datos: {
          activos: result.total,
          anterior: result.previous,
          doceMeses: row?.year ?? 0,
          fichas: row?.files ?? 0,
          algunaVez: row?.ever ?? 0,
          sinVenir: lapsed.total,
        },
      }
    },

    g055: async () => {
      const [row] = await tx.execute<{
        people: number
        controls: number
        overdue: number
        booked: number
        all: number
        linked: number
      }>(sql`
        select count(distinct f.patient_id) filter (where not ${upcoming(sql`f.patient_id`)} and f.status = 'pendiente')::int as people,
          count(*) filter (where not ${upcoming(sql`f.patient_id`)} and f.status = 'pendiente')::int as controls,
          count(distinct f.patient_id) filter (where not ${upcoming(sql`f.patient_id`)} and f.status = 'pendiente' and f.due_at < ${nowIso}::timestamptz)::int as overdue,
          count(distinct f.patient_id) filter (where ${upcoming(sql`f.patient_id`)} and f.status = 'pendiente')::int as booked,
          count(distinct f.patient_id) filter (where f.status = 'pendiente')::int as all,
          count(distinct f.patient_id) filter (where f.status = 'programado')::int as linked
        from clinical_follow_up f ${person(sql`f.patient_id`)}
        where f.organization_id = ${org} and f.status in ('pendiente','programado') and pp.is_active`)
      const people = row?.people ?? 0
      const overdue = row?.overdue ?? 0
      return {
        respuesta:
          people > 0
            ? `Hoy ${people} pacientes tienen un control pendiente y ninguna cita por venir (${row?.controls ?? 0} controles); de ellos, ${overdue} ya pasaron la fecha de su control y ${people - overdue} lo tienen más adelante.`
            : "Hoy ningún paciente tiene un control pendiente sin cita.",
        criterio:
          "Controles en estado pendiente (aún sin cita ligada) de pacientes sin archivar, Spam ni bloqueo, que no tienen ninguna cita programada o confirmada por venir, a hoy.",
        nota: `Contando también a quienes ya tienen otra cita por venir: ${plural(row?.all ?? 0, "paciente", "pacientes")} con un control pendiente (${row?.booked ?? 0} de ellos con cita). Con el control ya ligado a una cita (programado): ${plural(row?.linked ?? 0, "paciente", "pacientes")}. Solo los vencidos y sin cita: ${overdue}.`,
        datos: { row },
      }
    },

    g056: async () => {
      const year = await calendarYear()
      const top = (from: string, limit: number) =>
        tx.execute<{ name: string; cents: string; payers: number; total: string }>(sql`
          with paid as (
            select pay.patient_id, pay.amount_cents::bigint as cents from patient_payment pay
            where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${currency}
              and pay.paid_at >= ${from}::timestamptz and pay.paid_at < ${nowIso}::timestamptz
            union all
            select r.patient_id, -r.amount_cents::bigint from patient_payment_refund r
            join patient_payment pay on pay.organization_id = r.organization_id and pay.id = r.payment_id and pay.voided_at is null and pay.currency = ${currency}
            where r.organization_id = ${org} and r.refunded_at >= ${from}::timestamptz and r.refunded_at < ${nowIso}::timestamptz)
          select pp.display_name as name, sum(x.cents)::text as cents, count(*) over()::int as payers, (sum(sum(x.cents)) over())::text as total
          from paid x ${person(sql`x.patient_id`)}
          group by x.patient_id, pp.display_name having sum(x.cents) > 0
          order by sum(x.cents) desc, 1 limit ${limit}`)
      const rows = await top(year.start.toISOString(), 20)
      const twelve = await top(yearAgo, 5)
      const sum = rows.reduce((total, row) => total + Number(row.cents), 0)
      const words = (list: typeof rows) =>
        h.listOf(list.map((row) => ({ name: row.name, value: h.money(Number(row.cents)) })))
      return {
        respuesta: rows.length
          ? `En lo que va de ${year.from.year} (del 1 de enero a hoy), tus ${rows.length} pacientes que más pagaron son: ${words(rows)}. Entre los ${rows.length} suman ${h.money(sum)} de ${h.money(Number(rows[0]?.total ?? 0))} que pagaron ${rows[0]?.payers ?? 0} pacientes en el año.`
          : `En lo que va de ${year.from.year} ningún paciente pagó todavía.`,
        criterio:
          "Lo pagado por cada paciente del 1 de enero a hoy: pagos vigentes menos lo devuelto, en la moneda de la clínica, de más a menos (sin Spam ni bloqueados).",
        nota: `Con los últimos 12 meses en vez del año calendario, los 5 primeros: ${words(twelve)}.`,
        datos: { año: rows, doceMeses: twelve },
      }
    },

    g057: async () => {
      const site = await branchNamed("San Isidro")
      if (!site) {
        const all = await branches()
        return {
          respuesta: `No hay una sede San Isidro: tus sedes son ${all.map((row) => row.name).join(", ")}.`,
          criterio: "La sede no existe.",
          datos: { sedes: all },
        }
      }
      const result = await figAt("pacientes_nuevos", "total", "ultimos_3_meses", site.id)
      const scope = await scopeOf("ultimos_3_meses")
      const months = result.months.filter((month) => !month.partial).slice(-3)
      const current = await figAt("pacientes_nuevos", "total", "este_mes", site.id)
      const clinic = await h.fig("pacientes_nuevos", "sede", "ultimos_3_meses")
      const value = result.total.value ?? 0
      const span = (from: { year: number; month: number }, to: { year: number; month: number }) =>
        `${monthLabel(h, from, false)} a ${monthLabel(h, to)}`
      return {
        respuesta: `En los últimos 3 meses completos (${span(scope.window.from, scope.window.to)}), ${site.name} tuvo ${value} pacientes nuevos: ${h.listOf(months.map((month) => ({ name: monthLabel(h, month.month, false), value: `${month.value.value ?? 0}` })))}. En los 3 meses anteriores (${span(scope.window.previous.from, scope.window.previous.to)}) fueron ${result.previous?.value ?? 0}.`,
        criterio:
          "«Pacientes nuevos» de Reportes con la sede elegida: personas cuya primera cita atendida en la clínica fue en esa sede, en los últimos 3 meses completos.",
        nota: `Sumando ${thisMonth}: ${value + (current.total.value ?? 0)} (${current.total.value ?? 0} de ${monthLabel(h, window.from, false)}). En toda la clínica, en esos 3 meses: ${h.listOf(clinic.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })))}.`,
        datos: {
          sede: site,
          total: result.total,
          anterior: result.previous,
          meses: months,
          mesEnCurso: current.total,
          porSede: clinic.rows,
        },
      }
    },

    g058: async () => {
      const [row] = await tx.execute<{
        patients: number
        once: number
        gone: number
        old: number
      }>(sql`
        with ${attended}, visits as (select patient_id, count(*)::int as n, max(starts_at) as last from attended group by 1)
        select count(*)::int as patients, count(*) filter (where n = 1)::int as once,
          count(*) filter (where n = 1 and not ${upcoming(sql`v.patient_id`)})::int as gone,
          count(*) filter (where n = 1 and not ${upcoming(sql`v.patient_id`)} and last < ${monthsAgo(6)})::int as old
        from visits v`)
      const gone = row?.gone ?? 0
      const old = row?.old ?? 0
      const booked = (row?.once ?? 0) - gone
      return {
        respuesta: `${gone} pacientes vinieron una sola vez (una sola cita atendida) y no tienen otra por venir: el ${pct(gone, row?.patients ?? 0)} de los ${row?.patients ?? 0} pacientes atendidos alguna vez.`,
        criterio:
          "Pacientes (sin Spam ni bloqueados) con exactamente una cita atendida en toda su historia, hasta hoy, y ninguna cita programada o confirmada por venir.",
        nota: `Solo los que vinieron hace más de 6 meses, que ya tuvieron tiempo de volver: ${old}; los otros ${gone - old} vinieron en los últimos 6 meses.${booked > 0 ? ` Otros ${booked} vinieron una vez y ya tienen su segunda cita agendada.` : ""}`,
        datos: { row },
      }
    },

    g059: async () => {
      const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
      const units = budgetLineUnitsSql({
        billingMode: sql`i.billing_mode`,
        sessionsPlanned: sql`i.sessions_planned`,
      })
      const awaits = budgetAwaitsAnswerSql({
        status: sql`b.status`,
        id: sql`b.id`,
        organizationId: sql`b.organization_id`,
      })
      const rows = await tx.execute<{
        patientId: string
        person: string
        number: number
        presented: string
        pending: string
        booked: boolean
      }>(sql`
        select b.patient_id as "patientId", pp.display_name as person, b.budget_number as number, b.presented_at::text as presented,
          coalesce(sum(i.price_cents::bigint * ${units}) filter (where i.decision in ('pendiente','pospuesto')), 0)::text as pending,
          ${upcoming(sql`b.patient_id`)} as booked
        from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql(budget)} and i.price_cents is not null
        ${person(sql`b.patient_id`)}
        where b.organization_id = ${org} and ${awaits}
        group by b.id, b.patient_id, pp.display_name, b.budget_number, b.presented_at
        order by b.presented_at, b.budget_number`)
      const group = (list: Array<(typeof rows)[number]>) => {
        const people = new Map<
          string,
          { person: string; budgets: number[]; pending: number; since: string }
        >()
        for (const row of list) {
          const entry = people.get(row.patientId) ?? {
            person: row.person,
            budgets: [],
            pending: 0,
            since: row.presented,
          }
          entry.budgets.push(row.number)
          entry.pending += Number(row.pending)
          if (row.presented < entry.since) entry.since = row.presented
          people.set(row.patientId, entry)
        }
        return [...people.values()].sort((a, b) => a.since.localeCompare(b.since))
      }
      const unbookedRows = rows.filter((row) => !row.booked)
      const list = group(unbookedRows)
      const withAppointment = group(rows.filter((row) => row.booked))
      const pending = list.reduce((total, row) => total + row.pending, 0)
      const byMoney = [...list].sort(
        (a, b) => b.pending - a.pending || a.since.localeCompare(b.since),
      )
      const shown = list.slice(0, 10)
      return {
        respuesta: list.length
          ? `Hoy ${list.length} pacientes tienen un presupuesto esperando respuesta y ninguna cita por venir (${unbookedRows.length} presupuestos, ${h.money(pending)} por decidir). Los que esperan hace más tiempo: ${h.listOf(shown.map((row) => ({ name: row.person, value: `N.º ${row.budgets.join(", ")}, ${h.money(row.pending)}, desde el ${shortDay(row.since)}` })))}${list.length > shown.length ? ` y ${list.length - shown.length} más` : ""}.`
          : "Hoy ningún paciente tiene un presupuesto esperando respuesta sin una cita por venir.",
        criterio:
          "La regla «espera respuesta» de odentIA (enviado, «lo está pensando» o aceptado en parte con algo pospuesto), a hoy, de pacientes sin Spam ni bloqueo que no tienen ninguna cita programada o confirmada por venir; del más antiguo al más reciente, con lo que falta decidir de la opción que vale.",
        nota: `Por lo que falta decidir: ${h.listOf(byMoney.slice(0, 5).map((row) => ({ name: row.person, value: h.money(row.pending) })))}. ${withAppointment.length ? `Con una cita por venir hay otros ${plural(withAppointment.length, "paciente", "pacientes")} con un presupuesto esperando respuesta.` : "Ninguno de los pacientes con un presupuesto esperando respuesta tiene una cita por venir."}`,
        datos: {
          pacientes: list,
          presupuestos: unbookedRows.length,
          faltaDecidir: pending,
          conCita: withAppointment.length,
        },
      }
    },

    g060: async () => {
      const multi = (from: SQL) =>
        sql`(select count(*) from (select patient_id from attended where starts_at >= ${from} group by 1 having count(distinct branch_id) > 1) x)::int`
      const seen = (from: SQL) =>
        sql`(select count(distinct patient_id) from attended where starts_at >= ${from})::int`
      const [row] = await tx.execute<{
        year: number
        yearAll: number
        ever: number
        everAll: number
        month: number
        monthAll: number
      }>(sql`
        with ${attended}
        select ${multi(sql`${yearAgo}::timestamptz`)} as year, ${seen(sql`${yearAgo}::timestamptz`)} as "yearAll",
          ${multi(sql`'-infinity'::timestamptz`)} as ever, ${seen(sql`'-infinity'::timestamptz`)} as "everAll",
          ${multi(sql`${monthStart}::timestamptz`)} as month, ${seen(sql`${monthStart}::timestamptz`)} as "monthAll"`)
      const combos = await tx.execute<{ names: string; patients: number }>(sql`
        with ${attended}, multi as (
          select patient_id, array_agg(distinct branch_id) as places from attended where starts_at >= ${yearAgo}::timestamptz
          group by 1 having count(distinct branch_id) > 1)
        select (select string_agg(b.name, ' y ' order by b.name) from branch b where b.organization_id = ${org} and b.id = any(m.places)) as names, count(*)::int as patients
        from multi m group by 1 order by 2 desc, 1`)
      const year = row?.year ?? 0
      return {
        respuesta: `En los últimos 12 meses, ${year} pacientes se atendieron en más de una sede: el ${pct(year, row?.yearAll ?? 0)} de los ${row?.yearAll ?? 0} atendidos${combos.length ? ` (${h.listOf(combos.map((item) => ({ name: item.names, value: `${item.patients}` })))})` : ""}.`,
        criterio:
          "Pacientes (sin Spam ni bloqueados) con citas atendidas en dos o más sedes en los últimos 365 días.",
        nota: `Desde siempre: ${row?.ever ?? 0} de ${row?.everAll ?? 0} pacientes atendidos. ${ThisMonth}: ${row?.month ?? 0} de ${row?.monthAll ?? 0}.`,
        datos: { row, combinaciones: combos },
      }
    },

    g061: async () => {
      const still = sql`(g.last >= ${monthsAgo(6)} or ${upcoming(sql`g.patient_id`)})`
      const oldest = (where: SQL, order: SQL, limit: number) =>
        tx.execute<{
          name: string
          number: number
          first: string
          last: string
          visits: number
          created: string
        }>(sql`
          with ${attended}, agg as (select patient_id, min(starts_at) as first, max(starts_at) as last, count(*)::int as visits from attended group by 1)
          select pp.display_name as name, p.patient_number as number, g.first::text as first, g.last::text as last, g.visits, p.created_at::text as created
          from agg g ${person(sql`g.patient_id`)}
          where pp.is_active and ${where}
          order by ${order} limit ${limit}`)
      const rows = await oldest(still, sql`g.first, g.last desc, 1`, 500)
      const top = rows[0]
      // Quien tuvo su primera cita el mismo día también es «el más antiguo»: se dice cuántos son.
      const ties = rows
        .slice(1)
        .filter(
          (row) =>
            top && reportDayOf(tz, new Date(row.first)) === reportDayOf(tz, new Date(top.first)),
        )
      const tieWords =
        ties.length > 4
          ? `${ties
              .slice(0, 4)
              .map((row) => row.name)
              .join(", ")} y ${ties.length - 4} más`
          : ties.map((row) => row.name).join(", ")
      const [byFile] = await oldest(still, sql`p.created_at, p.patient_number`, 1)
      const [active] = await oldest(
        sql`g.last >= ${monthsAgo(18)}`,
        sql`g.first, g.last desc, 1`,
        1,
      )
      return {
        respuesta: top
          ? `El paciente más antiguo que sigue viniendo es ${top.name}: su primera cita atendida fue el ${dayName(top.first)}${ties.length ? " (la más temprana de ese día)" : ""} y la última el ${dayName(top.last)} (${top.visits} citas atendidas).${ties.length ? ` Ese mismo día empezaron también otros ${plural(ties.length, "paciente que sigue", "pacientes que siguen")} viniendo: ${tieWords}.` : ""}`
          : "Ningún paciente sigue viniendo: nadie tiene una cita atendida en los últimos 6 meses ni una por venir.",
        criterio:
          "Pacientes sin archivar, Spam ni bloqueo que siguen viniendo (su última cita atendida fue en los últimos 6 meses o tienen una por venir: lo contrario de «Sin venir»), ordenados por su primera cita atendida.",
        nota: `Por la ficha más antigua entre los que siguen viniendo: ${byFile ? `${byFile.name} (ficha N.º ${byFile.number}, registrada el ${dayName(byFile.created)})` : "ninguno"}. Si «sigue viniendo» es ser activo como en Reportes (una cita atendida en los últimos 18 meses): ${active ? `${active.name}, desde el ${dayName(active.first)}` : "ninguno"}.`,
        datos: {
          primeros: rows.slice(0, 10),
          mismoDia: ties.length,
          porFicha: byFile ?? null,
          activo18Meses: active ?? null,
        },
      }
    },

    g062: async () => {
      const result = await h.fig("como_nos_conocieron", "como_nos_conocio", "este_ano")
      const year = await calendarYear()
      const total = result.total.value ?? 0
      const google = result.rows.find((row) => row.key === "google_mapas")
      const value = google?.value.value ?? 0
      const silent = result.rows.find((row) => row.key === "sin_dato")?.value.value ?? 0
      const month = await h.fig("como_nos_conocieron")
      const monthValue = month.rows.find((row) => row.key === "google_mapas")?.value.value ?? 0
      return {
        respuesta: `De los ${total} pacientes nuevos de ${year.from.year} (del 1 de enero a hoy), ${value} dijeron que nos conocieron por «${google?.label ?? REFERRAL_WORDS.google_mapas}»: el ${pct(value, total)}.`,
        criterio:
          "«Cómo nos conocieron» de Reportes, este año hasta hoy: pacientes nuevos (primera cita atendida en el año) que eligieron «Google o mapas» en su registro.",
        nota: `Sin contar a los ${silent} que no lo dijeron: ${pct(value, total - silent)}. ${capital(thisMonth)}: ${monthValue} de ${month.total.value ?? 0}.`,
        datos: { año: result.rows, total, google: value, noLoDijeron: silent, mes: month.rows },
      }
    },

    g063: async () => {
      const site = await branchNamed("Miraflores")
      if (!site) {
        const all = await branches()
        return {
          respuesta: `No hay una sede Miraflores: tus sedes son ${all.map((row) => row.name).join(", ")}.`,
          criterio: "La sede no existe.",
          datos: { sedes: all },
        }
      }
      const key = lastMonthKey(10)
      const scope = await scopeOf(key, site.id)
      const result = await computeFigure(
        { ...h.ctx, scope },
        { figure: "pacientes_nuevos", group: "total" },
      )
      const clinic = await figAt("pacientes_nuevos", "total", key)
      const { start, end, partial } = scope.window
      const [alt] = await tx.execute<{ count: number }>(sql`
        with first_here as (
          select distinct on (patient_id) patient_id, starts_at from appointment
          where organization_id = ${org} and status = 'atendida' and branch_id = ${site.id}
          order by patient_id, starts_at, id)
        select count(*)::int as count from first_here where starts_at >= ${start.toISOString()}::timestamptz and starts_at < ${end.toISOString()}::timestamptz`)
      const value = result.total.value ?? 0
      const name = monthLabel(h, monthOfKey(key))
      return {
        respuesta: `En ${name}${partial ? " (hasta hoy)" : ""}, ${value} personas vinieron por primera vez a ${site.name}: su primera cita atendida en la clínica fue ahí. ${partial ? `En ${sameDaysBefore}` : `En ${monthLabel(h, scope.window.previous.from)}`} fueron ${result.previous?.value ?? 0}.`,
        criterio:
          "«Pacientes nuevos» de Reportes con la sede elegida: personas cuya primera cita atendida en la clínica fue en esa sede, en octubre.",
        nota: `Contando también a quienes ya se habían atendido en otra sede y fueron a ${site.name} por primera vez: ${alt?.count ?? 0}. En toda la clínica, pacientes nuevos de ${monthLabel(h, monthOfKey(key), false)}: ${clinic.total.value ?? 0}.`,
        datos: {
          sede: site,
          periodo: key,
          total: result.total,
          anterior: result.previous,
          primeraVezEnLaSede: alt?.count ?? 0,
          clinica: clinic.total,
        },
      }
    },

    g064: async () => {
      const year = await calendarYear()
      const yearStart = year.start.toISOString()
      const lastStart = year.previous.start.toISOString()
      const [row] = await tx.execute<{
        cohort: number
        missing: number
        booked: number
        old: number
      }>(sql`
        with ${attended},
        last_year as (select patient_id, max(starts_at) as last from attended where starts_at >= ${lastStart}::timestamptz and starts_at < ${yearStart}::timestamptz group by 1),
        this_year as (select distinct patient_id from attended where starts_at >= ${yearStart}::timestamptz)
        select count(*)::int as cohort, count(*) filter (where t.patient_id is null)::int as missing,
          count(*) filter (where t.patient_id is null and ${upcoming(sql`l.patient_id`)})::int as booked,
          count(*) filter (where t.patient_id is null and l.last < ${monthsAgo(12)})::int as old
        from last_year l left join this_year t on t.patient_id = l.patient_id`)
      const returned = await h.fig("volvieron")
      const missing = row?.missing ?? 0
      const cohort = row?.cohort ?? 0
      const whole = returned.total.whole ?? 0
      const part = returned.total.part ?? 0
      return {
        respuesta: `De los ${cohort} pacientes que atendiste en ${year.previous.from.year}, ${missing} no han tenido ninguna cita atendida en ${year.from.year} (del 1 de enero a hoy): el ${pct(missing, cohort)}.${row?.booked ? ` ${row.booked} de ellos ya tienen una cita por venir.` : ""}`,
        criterio:
          "Pacientes (sin Spam ni bloqueados) con una cita atendida en el año calendario anterior y ninguna desde el 1 de enero de este año hasta hoy.",
        nota: `Con la regla de «Volvieron en el año» de Reportes (atendidos hace 12 a 24 meses y si volvieron en los últimos 12): ${whole - part} de ${whole} no volvieron (volvió el ${h.show(returned)}).`,
        datos: { row, volvieron: returned.total },
      }
    },

    g065: async () => {
      const year = await calendarYear()
      const top = (from: string, limit: number) =>
        tx.execute<{
          name: string
          visits: number
          last: string
          patients: number
          total: number
        }>(sql`
          with ${attended}
          select pp.display_name as name, count(*)::int as visits, max(x.starts_at)::text as last,
            count(*) over()::int as patients, (sum(count(*)) over())::int as total
          from attended x ${person(sql`x.patient_id`)}
          where x.starts_at >= ${from}::timestamptz
          group by x.patient_id, pp.display_name order by 2 desc, 3 desc, 1 limit ${limit}`)
      const rows = await top(year.start.toISOString(), 10)
      const twelve = await top(yearAgo, 5)
      const words = (list: typeof rows) =>
        h.listOf(
          list.map((row) => ({
            name: row.name,
            value: `${row.visits} ${row.visits === 1 ? "cita atendida" : "citas atendidas"}`,
          })),
        )
      const patients = rows[0]?.patients ?? 0
      const average = patients ? (rows[0]?.total ?? 0) / patients : 0
      return {
        respuesta: rows.length
          ? `En lo que va de ${year.from.year} (del 1 de enero a hoy), los pacientes que más vinieron son ${words(rows)}.`
          : `En lo que va de ${year.from.year} todavía no hay citas atendidas.`,
        criterio:
          "Citas atendidas de cada paciente (sin Spam ni bloqueados) del 1 de enero a hoy, de más a menos; a igual número, el que vino más recientemente.",
        nota: `En promedio, cada uno de los ${patients} pacientes atendidos este año vino ${average.toLocaleString(locale, { maximumFractionDigits: 1 })} veces. En los últimos 12 meses: ${words(twelve)}.`,
        datos: { año: rows, doceMeses: twelve },
      }
    },

    g066: async () => {
      const year = await calendarYear()
      const rows = await tx.execute<{
        patientId: string
        name: string
        at: string
        prev: string
      }>(sql`
        with ${attended}, v as (
          select patient_id, starts_at, lag(starts_at) over (partition by patient_id order by starts_at, id) as prev from attended)
        select distinct on (v.patient_id, v.starts_at) v.patient_id as "patientId", pp.display_name as name, v.starts_at::text as at, v.prev::text as prev
        from v ${person(sql`v.patient_id`)}
        where v.prev is not null and v.prev < ((v.starts_at at time zone ${tz}) - interval '1 year') at time zone ${tz}
        order by v.patient_id, v.starts_at desc`)
      const since = (from: Date, to: Date = h.now) =>
        rows.filter((row) => new Date(row.at) >= from && new Date(row.at) < to)
      const people = (list: Array<(typeof rows)[number]>) =>
        new Set(list.map((row) => row.patientId)).size
      const month = since(window.start)
      const before = since(window.previous.start, window.previous.end)
      const twelve = since(new Date(yearAgo))
      const calendar = since(year.start)
      const count = people(month)
      const recent = [...month].sort((a, b) => b.at.localeCompare(a.at))
      return {
        respuesta: `${ThisMonth}, ${count} ${count === 1 ? "paciente volvió" : "pacientes volvieron"} después de más de un año sin venir: su cita atendida anterior fue hace más de 12 meses.${recent.length ? ` ${h.listOf(recent.slice(0, 5).map((row) => ({ name: row.name, value: `vino el ${shortDay(row.at)}; antes, el ${shortDay(row.prev)}` })))}.` : ""}`,
        criterio:
          "Pacientes (sin Spam ni bloqueados) con una cita atendida en el mes en curso cuya cita atendida anterior fue más de 12 meses del calendario antes.",
        nota: `En los últimos 12 meses: ${people(twelve)}. En lo que va del año: ${people(calendar)}. En ${sameDaysBefore}: ${people(before)}.`,
        datos: {
          mes: count,
          mismosDiasMesAnterior: people(before),
          doceMeses: people(twelve),
          año: people(calendar),
          lista: recent.slice(0, 20),
        },
      }
    },

    g067: async () => {
      const ana = await dentistNamed("Ana Torres")
      if (!ana)
        return {
          respuesta: "No hay una Dra. Ana Torres en el equipo de la clínica.",
          criterio: "La profesional no existe.",
          datos: {},
        }
      const [row] = await tx.execute<{
        patients: number
        unbooked: number
        active: number
        activeUnbooked: number
        own: number
        ownUnbooked: number
        withoutHer: number
      }>(sql`
        with ${attended},
        hers as (select patient_id, max(starts_at) as last from attended where dentist_user_id = ${ana.id} group by 1),
        latest as (select distinct on (patient_id) patient_id, dentist_user_id from attended order by patient_id, starts_at desc, id desc)
        select count(*)::int as patients,
          count(*) filter (where not ${upcoming(sql`x.patient_id`)})::int as unbooked,
          count(*) filter (where x.last >= ${monthsAgo(18)})::int as active,
          count(*) filter (where x.last >= ${monthsAgo(18)} and not ${upcoming(sql`x.patient_id`)})::int as "activeUnbooked",
          count(*) filter (where l.dentist_user_id = ${ana.id})::int as own,
          count(*) filter (where l.dentist_user_id = ${ana.id} and not ${upcoming(sql`x.patient_id`)})::int as "ownUnbooked",
          count(*) filter (where not exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = x.patient_id and n.dentist_user_id = ${ana.id}
            and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada')))::int as "withoutHer"
        from hers x join latest l on l.patient_id = x.patient_id`)
      return {
        respuesta: `De los ${row?.patients ?? 0} pacientes que ${the(ana.name)} atendió alguna vez, ${row?.unbooked ?? 0} no tienen ninguna cita por venir (ni con ella ni con otro odontólogo).`,
        criterio:
          "Pacientes (sin Spam ni bloqueados) con al menos una cita atendida con la profesional, hasta hoy, que no tienen ninguna cita programada o confirmada por venir.",
        nota: `Solo sus pacientes activos (atendidos por ella en los últimos 18 meses): ${row?.activeUnbooked ?? 0} de ${row?.active ?? 0}. Solo aquellos cuya última cita atendida fue con ella: ${row?.ownUnbooked ?? 0} de ${row?.own ?? 0}. Sin una cita por venir con ella, aunque la tengan con otro: ${row?.withoutHer ?? 0}.`,
        datos: { profesional: ana, row },
      }
    },

    g068: async () => {
      const key = lastMonthKey(8)
      const scope = await scopeOf(key)
      const result = await computeFigure(
        { ...h.ctx, scope },
        { figure: "pacientes_nuevos", group: "total" },
      )
      const item = (where: SQL) =>
        sql`exists (select 1 from treatment_plan_item i where i.organization_id = ${org} and i.patient_id = c.patient_id ${where})`
      const [row] = await tx.execute<{
        fresh: number
        started: number
        accepted: number
        proposed: number
      }>(sql`
        with ${firstVisitSql(org)}, cohort as (
          select patient_id from first_visit where starts_at >= ${scope.window.start.toISOString()}::timestamptz and starts_at < ${scope.window.end.toISOString()}::timestamptz)
        select count(*)::int as fresh,
          count(*) filter (where ${item(sql`and i.decision_status = 'aceptado' and (i.status in ('en_curso','realizado') or i.started_at is not null)`)})::int as started,
          count(*) filter (where ${item(sql`and i.decision_status = 'aceptado'`)})::int as accepted,
          count(*) filter (where ${item(sql``)})::int as proposed
        from cohort c`)
      const fresh = result.total.value ?? row?.fresh ?? 0
      const started = row?.started ?? 0
      return {
        respuesta: `De los ${fresh} pacientes nuevos de ${monthLabel(h, monthOfKey(key))}, ${started} empezaron un plan de tratamiento (el ${pct(started, fresh)}): aceptaron tratamientos de su plan y ya se empezaron o se hicieron, hasta hoy.`,
        criterio:
          "«Pacientes nuevos» de Reportes de agosto (primera cita atendida en el mes) con algún tratamiento de su plan aceptado y en curso o realizado, a hoy.",
        nota: `Aceptaron algún tratamiento de su plan, empezado o no: ${row?.accepted ?? 0}. Tienen un plan propuesto, aceptado o no: ${row?.proposed ?? 0}.`,
        datos: { periodo: key, nuevos: result.total, row },
      }
    },

    g069: async () => {
      const [row] = await tx.execute<{
        total: number
        archived: number
        month: number
        attended: number
        screened: number
      }>(sql`
        select count(*) filter (where pp.screen is null)::int as total,
          count(*) filter (where pp.screen is null and not pp.is_active)::int as archived,
          count(*) filter (where pp.screen is null and p.created_at >= ${monthStart}::timestamptz)::int as month,
          count(*) filter (where pp.screen is null and exists (select 1 from appointment a where a.organization_id = ${org} and a.patient_id = p.id and a.status = 'atendida'))::int as attended,
          count(*) filter (where pp.screen is not null)::int as screened
        from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        where p.organization_id = ${org}`)
      const active = await h.fig("activos")
      const archived = row?.archived ?? 0
      return {
        respuesta: `Tienes ${row?.total ?? 0} pacientes registrados en total (fichas de paciente${archived ? `, ${archived} de ellas ${archived === 1 ? "archivada" : "archivadas"}` : ""}).`,
        criterio:
          "Todas las fichas de paciente de la clínica, también las archivadas, sin las personas en Spam ni bloqueadas.",
        nota: `Atendidos al menos una vez: ${row?.attended ?? 0}. Activos como en Reportes (una cita atendida en los últimos 18 meses): ${h.show(active)}. Registrados ${thisMonth}: ${row?.month ?? 0}.${row?.screened ? ` Sin contar ${row.screened} en Spam o bloqueados.` : ""}`,
        datos: { row, activos: active.total },
      }
    },

    g070: async () => {
      const rows = await tx.execute<{
        name: string
        owed: string
        since: string
        last: string
      }>(sql`
        ${overdueDebtSql(org, [h.now], 0)}, ${lapsedSql(org, h.scope, h.now)}
        select pp.display_name as name, o.owed::text as owed, o.since::text as since, l.starts_at::text as last
        from lapsed l join overdue o on o.patient_id = l.patient_id and o.currency = ${currency}
        ${person(sql`l.patient_id`)}
        order by o.owed desc, 1`)
      const lapsed = await h.fig("sin_venir")
      const [plain] = await tx.execute<{ people: number; cents: string }>(sql`
        ${overdueDebtSql(org, [h.now], 0)}, ${attended}, last as (select patient_id, max(starts_at) as at from attended group by 1)
        select count(*)::int as people, coalesce(sum(o.owed), 0)::text as cents
        from last l join overdue o on o.patient_id = l.patient_id and o.currency = ${currency}
        where l.at < ${monthsAgo(6)}`)
      const total = rows.reduce((sum, row) => sum + Number(row.owed), 0)
      const old = rows.filter(
        (row) => new Date(row.since).getTime() < h.now.getTime() - 30 * DAY_MS,
      ).length
      return {
        respuesta: rows.length
          ? `De los ${h.show(lapsed)} pacientes que dejaron de venir (más de 6 meses sin una cita atendida y sin cita, presupuesto ni control pendiente), ${rows.length} todavía te deben algo: ${h.money(total)} en total. Los que más deben: ${h.listOf(rows.slice(0, 5).map((row) => ({ name: row.name, value: h.money(Number(row.owed)) })))}.`
          : `Ninguno de los ${h.show(lapsed)} pacientes que dejaron de venir te debe algo.`,
        criterio:
          "«Sin venir hace más de 6 meses» de Reportes, a hoy, cruzado con «Te deben»: lo que cada uno debe hoy (sus conceptos vigentes menos lo pagado y lo que tiene a favor), en la moneda de la clínica.",
        nota: `Contando a todos los que llevan más de 6 meses sin una cita atendida, aunque tengan algo pendiente: ${plain?.people ?? 0} deben ${h.money(Number(plain?.cents ?? 0))}. De los ${rows.length}, ${old} deben desde hace más de 30 días.`,
        datos: {
          sinVenir: lapsed.total,
          deben: rows.length,
          total,
          primeros: rows.slice(0, 20),
          masDe30Dias: old,
          sinExcluir: plain,
        },
      }
    },

    g071: async () => {
      const luis = await dentistNamed("Luis Prado")
      if (!luis)
        return {
          respuesta: "No hay un Luis Prado en el equipo de la clínica.",
          criterio: "El profesional no existe.",
          datos: {},
        }
      const today = reportDayOf(tz, h.now)
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
      const monday = addDays(today, -((weekday + 6) % 7))
      const weekStart = startOfDay(monday)
      const weekEnd = startOfDay(addDays(monday, 7))
      const count = (from: Date, to: Date, end: Date) =>
        tx.execute<{
          attended: number
          noShow: number
          cancelled: number
          unmarked: number
          coming: number
        }>(sql`
          select count(*) filter (where a.status = 'atendida' and a.starts_at < ${to.toISOString()}::timestamptz)::int as attended,
            count(*) filter (where a.status = 'no_asistio' and a.starts_at < ${to.toISOString()}::timestamptz)::int as "noShow",
            count(*) filter (where a.status = 'cancelada' and a.starts_at < ${to.toISOString()}::timestamptz)::int as cancelled,
            count(*) filter (where a.status in ('programada','confirmada') and a.ends_at < ${to.toISOString()}::timestamptz)::int as unmarked,
            count(*) filter (where a.status in ('programada','confirmada') and a.starts_at > ${to.toISOString()}::timestamptz)::int as coming
          from appointment a
          where a.organization_id = ${org} and a.dentist_user_id = ${luis.id} and a.starts_at >= ${from.toISOString()}::timestamptz and a.starts_at < ${end.toISOString()}::timestamptz`)
      const [week] = await count(weekStart, h.now, weekEnd)
      const lastWeek = new Date(weekStart.getTime() - 7 * DAY_MS)
      const lastNow = new Date(h.now.getTime() - 7 * DAY_MS)
      const [before] = await count(lastWeek, lastNow, lastNow)
      const [signed] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from encounter e
        where e.organization_id = ${org} and e.dentist_user_id = ${luis.id} and e.status = 'finalizada' and e.voided_at is null
          and e.started_at >= ${weekStart.toISOString()}::timestamptz and e.started_at < ${nowIso}::timestamptz`)
      const attendedCount = week?.attended ?? 0
      const mondayWords = new Intl.DateTimeFormat(locale, {
        day: "numeric",
        month: "long",
        timeZone: "UTC",
      }).format(new Date(`${monday}T12:00:00Z`))
      return {
        respuesta: `Esta semana (del lunes ${mondayWords} a hoy), ${luis.name} atendió ${attendedCount} ${attendedCount === 1 ? "cita" : "citas"}.`,
        criterio:
          "Citas del profesional que terminaron atendidas, del lunes de esta semana hasta ahora (día de la clínica).",
        nota: `En esos días, además, ${week?.noShow ?? 0} ${week?.noShow === 1 ? "no vino" : "no vinieron"}, ${week?.cancelled ?? 0} ${week?.cancelled === 1 ? "se canceló" : "se cancelaron"} y ${week?.unmarked ?? 0} ${week?.unmarked === 1 ? "pasó" : "pasaron"} sin marcar si vino el paciente; le ${week?.coming === 1 ? "queda 1" : `quedan ${week?.coming ?? 0}`} por venir hasta el domingo. Los mismos días de la semana pasada atendió ${before?.attended ?? 0}. Atenciones firmadas esta semana: ${signed?.count ?? 0}.`,
        datos: {
          profesional: luis,
          desde: monday,
          semana: week,
          semanaPasada: before,
          atencionesFirmadas: signed?.count ?? 0,
        },
      }
    },

    g072: async () => {
      const ana = await dentistNamed("Ana Torres")
      if (!ana)
        return {
          respuesta: "No hay una Dra. Ana Torres en el equipo de la clínica.",
          criterio: "La profesional no existe.",
          datos: {},
        }
      const key = lastMonthKey(9)
      const scope = await scopeOf(key)
      const result = await h.fig("cobrado", "profesional", key)
      const row = result.rows.find((item) => item.key === ana.id)
      const value = row?.value.value ?? 0
      const total = result.rows.reduce((sum, item) => sum + (item.value.value ?? 0), 0)
      const [charged] = await tx.execute<{ cents: string; encounters: number }>(sql`
        select coalesce(sum(c.amount_cents), 0)::text as cents, count(distinct e.id)::int as encounters
        from patient_charge c
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency} and e.dentist_user_id = ${ana.id}
          and c.created_at >= ${scope.window.start.toISOString()}::timestamptz and c.created_at < ${scope.window.end.toISOString()}::timestamptz`)
      const name = monthLabel(h, monthOfKey(key))
      return {
        respuesta: `En ${name}${scope.window.partial ? " (hasta hoy)" : ""}, ${the(ana.name)} produjo ${h.show(result, value)}: lo cobrado de lo que atendió (${pct(value, total)} de lo atribuido a los ${result.rows.length} odontólogos).`,
        criterio:
          "Producción = lo cobrado por profesional de Reportes (lo pagado de lo que atendió, sin anulados ni lo devuelto; la base de las comisiones), en septiembre.",
        nota: `Por lo cargado en ${monthLabel(h, monthOfKey(key), false)} de lo que atendió (pagado o no): ${h.money(Number(charged?.cents ?? 0))} en ${charged?.encounters ?? 0} atenciones firmadas. Los demás, por lo cobrado: ${h.listOf(result.rows.filter((item) => item.key !== ana.id).map((item) => ({ name: item.label, value: h.show(result, item.value.value) })))}.`,
        datos: {
          profesional: ana,
          periodo: key,
          cobrado: value,
          porProfesional: result.rows,
          cargado: charged,
        },
      }
    },

    g073: async () => {
      const ps = window.previous.start.toISOString()
      const pe = window.previous.end.toISOString()
      const rows = await tx.execute<{ name: string; month: number; before: number }>(sql`
        with ${firstVisitSql(org)}
        select u.name, count(*) filter (where f.starts_at >= ${monthStart}::timestamptz and f.starts_at < ${nowIso}::timestamptz)::int as month,
          count(*) filter (where f.starts_at >= ${ps}::timestamptz and f.starts_at < ${pe}::timestamptz)::int as before
        from first_visit f join "user" u on u.id = f.dentist_user_id
        where f.starts_at >= ${ps}::timestamptz and f.starts_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 3 desc, 1`)
      const alt = await tx.execute<{ name: string; patients: number }>(sql`
        with pd as (
          select distinct on (patient_id, dentist_user_id) patient_id, dentist_user_id, starts_at from appointment
          where organization_id = ${org} and status = 'atendida' order by patient_id, dentist_user_id, starts_at, id)
        select u.name, count(*)::int as patients from pd join "user" u on u.id = pd.dentist_user_id
        where pd.starts_at >= ${monthStart}::timestamptz and pd.starts_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 1`)
      const result = await h.fig("pacientes_nuevos")
      const month = rows.filter((row) => row.month > 0)
      const top = month[0]
      const tied = month.filter((row) => top && row.month === top.month)
      const total = result.total.value ?? 0
      return {
        respuesta: top
          ? tied.length > 1
            ? `${ThisMonth} empatan ${tied.map((row) => row.name).join(" y ")}, con ${top.month} pacientes nuevos cada uno (de ${total}). ${month.length > tied.length ? `Le siguen ${h.listOf(month.slice(tied.length).map((row) => ({ name: row.name, value: `${row.month}` })))}.` : ""}`
            : `${ThisMonth} quien atendió más pacientes nuevos es ${the(top.name)}: ${top.month} de los ${total} pacientes nuevos de la clínica (contando quién atendió su primera cita).${month.length > 1 ? ` Le siguen ${h.listOf(month.slice(1).map((row) => ({ name: row.name, value: `${row.month}` })))}.` : ""}`
          : `${ThisMonth} todavía no hay pacientes nuevos.`,
        criterio:
          "«Pacientes nuevos» de Reportes (primera cita atendida en la clínica en el mes en curso), por el profesional de esa primera cita.",
        nota: `En ${sameDaysBefore}: ${h.listOf(
          rows
            .filter((row) => row.before > 0)
            .sort((a, b) => b.before - a.before || a.name.localeCompare(b.name))
            .map((row) => ({ name: row.name, value: `${row.before}` })),
        )}. Contando a quien vio por primera vez a cada odontólogo este mes, aunque ya fuera paciente de la clínica: ${h.listOf(alt.map((row) => ({ name: row.name, value: `${row.patients}` })))}.`,
        datos: { porProfesional: rows, total: result.total, nuevosParaElProfesional: alt },
      }
    },

    g074: async () => {
      const scope = await scopeOf("mes_pasado")
      const span = scope.window
      const [occupancy] = await occupancyMany(tx, org, [span])
      const names = await tx.execute<{ id: string; name: string }>(sql`
        select u.id, u.name from "user" u
        where u.id in (select dentist_user_id from professional_schedule where organization_id = ${org})
          or u.id in (select dentist_user_id from appointment where organization_id = ${org})`)
      const nameOf = (id: string) => names.find((row) => row.id === id)?.name ?? id
      const worked = await tx.execute<{ id: string; minutes: number; appointments: number }>(sql`
        select a.dentist_user_id as id, coalesce(sum(extract(epoch from a.ends_at - a.starts_at) / 60), 0)::int as minutes, count(*)::int as appointments
        from appointment a
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${span.start.toISOString()}::timestamptz and a.starts_at < ${span.end.toISOString()}::timestamptz
        group by 1`)
      const rows = (occupancy?.byProfessional ?? [])
        .filter((row) => row.availMin > 0)
        .map((row) => ({
          name: nameOf(row.userId),
          availMin: row.availMin,
          occMin: row.occMin,
          attendedMin: worked.find((item) => item.id === row.userId)?.minutes ?? 0,
        }))
        .sort((a, b) => b.availMin - a.availMin || a.name.localeCompare(b.name))
      const unscheduled = worked.filter((item) => !rows.some((row) => row.name === nameOf(item.id)))
      const total = rows.reduce((sum, row) => sum + row.availMin, 0)
      const month = monthLabel(h, span.from)
      return {
        respuesta: rows.length
          ? `En ${month}, según su horario (descontando ausencias y bloqueos): ${h.listOf(rows.map((row) => ({ name: row.name, value: hoursOf(row.availMin) })))}; ${hoursOf(total)} entre todos. odentIA no registra la entrada ni la salida: son las horas de su agenda.`
          : `En ${month} nadie tenía horario cargado.`,
        criterio:
          "Las horas del horario de cada profesional en el mes pasado completo, menos sus ausencias y los bloqueos de la sede (la base de «Agenda ocupada» de Reportes › Agenda).",
        nota: `Horas en citas atendidas (lo que estuvo atendiendo): ${h.listOf(rows.map((row) => ({ name: row.name, value: hoursOf(row.attendedMin) })))}${unscheduled.length ? `; sin horario cargado: ${h.listOf(unscheduled.map((item) => ({ name: nameOf(item.id), value: hoursOf(item.minutes) })))}` : ""}. Horas con citas agendadas no canceladas: ${h.listOf(rows.map((row) => ({ name: row.name, value: hoursOf(row.occMin) })))}.`,
        datos: { mes: span.from, filas: rows, sinHorario: unscheduled },
      }
    },

    g075: async () => {
      const site = await branchNamed("San Isidro")
      const all = await branches()
      if (!site)
        return {
          respuesta: `No hay una sede San Isidro: tus sedes son ${all.map((row) => row.name).join(", ")}.`,
          criterio: "La sede no existe.",
          datos: { sedes: all },
        }
      const slots = await tx.execute<{
        id: string
        name: string
        weekday: number
        startMin: number
        endMin: number
      }>(sql`
        select s.dentist_user_id as id, u.name, s.weekday, s.start_min as "startMin", s.end_min as "endMin"
        from professional_schedule s join "user" u on u.id = s.dentist_user_id
        where s.organization_id = ${org} and s.branch_id = ${site.id} and s.is_active
        order by u.name, s.weekday, s.start_min`)
      const people = [...new Map(slots.map((slot) => [slot.id, slot.name])).entries()]
      const describe = (id: string): string => {
        const byDay = new Map<number, string>()
        for (const slot of slots.filter((item) => item.id === id)) {
          const range = `${clock(slot.startMin)} a ${clock(slot.endMin)}`
          byDay.set(
            slot.weekday,
            byDay.has(slot.weekday) ? `${byDay.get(slot.weekday)} y de ${range}` : `de ${range}`,
          )
        }
        // Días seguidos con el mismo horario van juntos: «lunes a viernes de 9:00 a 13:00».
        const runs: Array<{ days: number[]; hours: string }> = []
        for (const day of WEEK_ORDER) {
          const hours = byDay.get(day)
          if (!hours) continue
          const last = runs.at(-1)
          const previous = last?.days.at(-1)
          if (
            last &&
            last.hours === hours &&
            previous !== undefined &&
            WEEK_ORDER.indexOf(previous) === WEEK_ORDER.indexOf(day) - 1
          )
            last.days.push(day)
          else runs.push({ days: [day], hours })
        }
        return runs
          .map((run) => {
            const first = WEEKDAYS[run.days[0] ?? 0]
            const last = WEEKDAYS[run.days.at(-1) ?? 0]
            const days =
              run.days.length === 1
                ? first
                : run.days.length === 2
                  ? `${first} y ${last}`
                  : `${first} a ${last}`
            return `${days} ${run.hours}`
          })
          .join("; ")
      }
      const recent = await tx.execute<{ name: string; appointments: number }>(sql`
        select u.name, count(*)::int as appointments from appointment a join "user" u on u.id = a.dentist_user_id
        where a.organization_id = ${org} and a.branch_id = ${site.id} and a.status = 'atendida'
          and a.starts_at >= ${nowIso}::timestamptz - interval '90 days' and a.starts_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 1`)
      const elsewhere = await tx.execute<{ branch: string; names: string }>(sql`
        select b.name as branch, string_agg(distinct u.name, ', ') as names from professional_schedule s
        join "user" u on u.id = s.dentist_user_id join branch b on b.id = s.branch_id
        where s.organization_id = ${org} and s.is_active and s.branch_id <> ${site.id} and b.is_active
        group by 1 order by 1`)
      return {
        respuesta: people.length
          ? `En ${site.name} ${people.length === 1 ? "atiende" : "atienden"} ${people.map(([id, name]) => `${the(name)}: ${describe(id)}`).join(". ")}.`
          : `En ${site.name} ningún odontólogo tiene horario cargado.`,
        criterio:
          "El horario vigente de cada profesional en esa sede (Equipo › Horarios), por día de la semana.",
        nota: `Citas atendidas en ${site.name} en los últimos 90 días: ${h.listOf(recent.map((row) => ({ name: row.name, value: `${row.appointments}` }))) || "ninguna"}. En las otras sedes: ${elsewhere.map((row) => `en ${row.branch}, ${row.names}`).join("; ") || "nadie tiene horario"}.`,
        datos: { sede: site, horario: slots, ultimos90Dias: recent, otrasSedes: elsewhere },
      }
    },
  }
}
