/**
 * Respuestas correctas de los pacientes (eval/argos-owner.json). Paciente es
 * una persona sin Spam ni bloqueo (`contact.screen` vacío); nuevo, su primera
 * cita atendida en el periodo; recurrente, atendido en el periodo sin ser
 * nuevo; «dejaron de venir», la regla de «Sin venir» de Reportes. Frecuencias,
 * tiempos y el valor de un paciente miran los últimos 365 días.
 */
import { getPatientReportList, getReportList, lapsedSql } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAY_MS = 86_400_000

export function patientSolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, tz } = h
  const { locale } = h.scope
  const nowIso = h.now.toISOString()
  const monthStart = h.monthStart
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const previous = h.scope.window.previous
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const monthName = (month: { year: number; month: number }): string =>
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 15)))
  const dayName = (iso: string | Date): string => new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: tz }).format(new Date(iso))
  const shortDay = (iso: string | Date): string => new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }).format(new Date(iso))
  /** «este mes (octubre de 2026, hasta hoy)». */
  const thisMonth = `este mes (${monthName(h.scope.window.from)}, hasta hoy)`
  const ThisMonth = `${thisMonth.charAt(0).toUpperCase()}${thisMonth.slice(1)}`
  const sameDaysBefore = `los mismos días de ${monthName(previous.from)}`
  /** Los últimos `count` meses completos, del más antiguo al más reciente. */
  const fullMonths = (count: number): Array<{ year: number; month: number; key: string }> =>
    Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(h.scope.window.from.year, h.scope.window.from.month - 1 - (count - index), 1))
      const year = date.getUTCFullYear()
      const month = date.getUTCMonth() + 1
      return { year, month, key: `${year}-${String(month).padStart(2, "0")}` }
    })
  /** La persona del paciente, sin Spam ni bloqueados. */
  const person = (patientColumn: SQL) =>
    sql`join patient p on p.organization_id = ${org} and p.id = ${patientColumn} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null`
  /** Citas atendidas de pacientes sin Spam ni bloqueo, hasta ahora. */
  const attended = sql`attended as (
    select a.id, a.patient_id, a.starts_at from appointment a ${person(sql`a.patient_id`)}
    where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz)`
  const firstVisit = sql`first_visit as (select distinct on (patient_id) patient_id, starts_at from attended order by patient_id, starts_at, id)`
  const upcoming = (patientColumn: SQL) => sql`exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = ${patientColumn}
    and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))`
  /** Hace `months` meses en el calendario de la clínica, como «Sin venir». */
  const monthsAgo = (months: number) => sql`((${nowIso}::timestamptz at time zone ${tz}) - make_interval(months => ${months})) at time zone ${tz}`

  return {
    p1: async () => {
      const result = await h.fig("pacientes_nuevos")
      const list = await getReportList(tx, org, { period: "este_mes", list: "new_patients", limit: 200 }, h.now)
      const sought = await h.fig("nos_buscaron")
      const [row] = await tx.execute<{ fresh: number; registered: number }>(sql`
        with ${attended}, ${firstVisit}
        select (select count(*) from first_visit where starts_at >= ${monthStart}::timestamptz)::int as fresh,
          (select count(*) from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null
            where p.organization_id = ${org} and p.created_at >= ${monthStart}::timestamptz and p.created_at < ${nowIso}::timestamptz)::int as registered`)
      const value = result.total.value ?? 0
      const before = result.previous?.value ?? 0
      return {
        respuesta: `${ThisMonth} tuviste ${value} pacientes nuevos (su primera cita atendida); en ${sameDaysBefore}, ${before}${value === before ? ", los mismos" : value > before ? `: ${value - before} más` : `: ${before - value} menos`}. Los más recientes: ${h.listOf(list.rows.slice(0, 4).map((item) => ({ name: item.personName, value: shortDay(item.at) })))}.`,
        criterio: "«Pacientes nuevos» de Reportes: personas cuya primera cita atendida cae en el mes en curso, contra los mismos días del mes anterior.",
        nota: `Otras lecturas: fichas de paciente registradas este mes, aunque aún no se atiendan: ${row?.registered ?? 0}. Personas que nos buscaron por primera vez este mes (embudo, por cualquier canal): ${sought.total.value ?? 0}, de ellas ${sought.total.part ?? 0} ya vinieron.`,
        datos: { total: result.total, anterior: result.previous, sinSpam: row?.fresh ?? 0, registrados: row?.registered ?? 0, nosBuscaron: sought.total, lista: list.rows.map((item) => ({ name: item.personName, at: item.at })) },
      }
    },

    p2: async () => {
      const result = await h.fig("sin_venir")
      const [row] = await tx.execute<{ over6: number; booked: number; over12: number }>(sql`
        with ${attended}, last as (select patient_id, max(starts_at) as at from attended group by 1)
        select count(*) filter (where at < ${monthsAgo(6)})::int as over6,
          count(*) filter (where at < ${monthsAgo(6)} and ${upcoming(sql`last.patient_id`)})::int as booked,
          count(*) filter (where at < ${monthsAgo(12)})::int as over12
        from last`)
      const [split] = await tx.execute<{ over12: number }>(sql`
        with ${lapsedSql(org, h.scope, h.now)} select count(*) filter (where starts_at < ${monthsAgo(12)})::int as over12 from lapsed`)
      return {
        respuesta: `Hoy ${h.show(result)} pacientes dejaron de venir: su última cita atendida fue hace más de 6 meses y no tienen cita por venir, presupuesto esperando respuesta ni control pendiente. De ellos, ${split?.over12 ?? 0} llevan más de un año sin venir.`,
        criterio: "«Sin venir hace más de 6 meses» de Reportes, a hoy (sin archivados).",
        nota: `Contando a todos los que llevan más de 6 meses sin una cita atendida, aunque tengan algo pendiente: ${row?.over6 ?? 0} (${row?.booked ? `de ellos ${row.booked} ya con una cita por venir` : "ninguno con una cita por venir"}). Contando a todos, con más de 12 meses sin venir: ${row?.over12 ?? 0}.`,
        datos: { total: result.total, masDe6Meses: row?.over6 ?? 0, conCita: row?.booked ?? 0, masDe12Meses: row?.over12 ?? 0, sinVenirMasDeUnAño: split?.over12 ?? 0 },
      }
    },

    p3: async () => {
      const rows = await tx.execute<{ name: string; at: string; booked: boolean; active: boolean; total: number }>(sql`
        with ${attended}, last as (select patient_id, max(starts_at) as at from attended group by 1)
        select pp.display_name as name, l.at::text as at, ${upcoming(sql`l.patient_id`)} as booked, pp.is_active as active, count(*) over()::int as total
        from last l ${person(sql`l.patient_id`)}
        where l.at < ${monthsAgo(6)}
        order by l.at desc, 1`)
      const lapsed = await h.fig("sin_venir")
      const total = rows[0]?.total ?? 0
      const booked = rows.filter((row) => row.booked).length
      const archived = rows.filter((row) => !row.active).length
      const [days] = await tx.execute<{ count: number }>(sql`
        with ${attended}, last as (select patient_id, max(starts_at) as at from attended group by 1)
        select count(*)::int as count from last where at < ${nowIso}::timestamptz - interval '180 days'`)
      const [limit] = await tx.execute<{ day: string }>(sql`select (${monthsAgo(6)})::text as day`)
      return {
        respuesta: `${total} pacientes no han regresado en los últimos 6 meses (su última cita atendida fue antes del ${dayName(limit?.day ?? nowIso)}). Los que se fueron más recientemente: ${h.listOf(rows.slice(0, 5).map((row) => ({ name: row.name, value: `última cita el ${shortDay(row.at)}` })))}. ${booked === 0 ? "Ninguno tiene una cita por venir." : `De los ${total}, ${booked} ya ${booked === 1 ? "tiene" : "tienen"} una cita por venir.`}`,
        criterio: "Pacientes (sin Spam ni bloqueados) cuya última cita atendida fue hace más de 6 meses del calendario, a hoy; de la más reciente a la más antigua.",
        nota: `Con la regla de «Sin venir» de Reportes (sin cita, presupuesto esperando ni control pendiente, y sin archivados): ${h.show(lapsed)}. Con 180 días en vez de 6 meses: ${days?.count ?? 0}.${archived ? ` Incluye ${archived} archivado${archived === 1 ? "" : "s"}.` : ""}`,
        datos: { total, conCita: booked, archivados: archived, sinVenir: lapsed.total, ciento80Dias: days?.count ?? 0, primeros: rows.slice(0, 20) },
      }
    },

    p4: async () => {
      const count = (from: string, to: string) =>
        tx.execute<{ total: number; fresh: number }>(sql`
          with ${attended}, ${firstVisit}, seen as (select distinct patient_id from attended where starts_at >= ${from}::timestamptz and starts_at < ${to}::timestamptz)
          select count(*)::int as total, count(*) filter (where f.starts_at >= ${from}::timestamptz)::int as fresh
          from seen s join first_visit f on f.patient_id = s.patient_id`)
      const [month] = await count(monthStart, nowIso)
      const [before] = await count(previous.start.toISOString(), previous.end.toISOString())
      const [year] = await count(yearAgo, nowIso)
      const [twice] = await tx.execute<{ count: number }>(sql`
        with ${attended} select count(*)::int as count from (select patient_id from attended where starts_at >= ${yearAgo}::timestamptz group by 1 having count(*) >= 2) x`)
      const total = month?.total ?? 0
      const fresh = month?.fresh ?? 0
      const back = total - fresh
      const lastBack = (before?.total ?? 0) - (before?.fresh ?? 0)
      const yearBack = (year?.total ?? 0) - (year?.fresh ?? 0)
      return {
        respuesta: `${ThisMonth}, ${back} pacientes recurrentes: de los ${total} atendidos, ${back} ya habían venido antes (${pct(back, total)}) y ${fresh} son nuevos. En ${sameDaysBefore} fueron ${lastBack} recurrentes de ${before?.total ?? 0} atendidos.`,
        criterio: "Pacientes distintos con una cita atendida en el mes en curso que no son nuevos (su primera cita atendida fue antes del mes).",
        nota: `En los últimos 12 meses: ${yearBack} de ${year?.total ?? 0} pacientes atendidos ya venían de antes (${pct(yearBack, year?.total ?? 0)}), y ${twice?.count ?? 0} tuvieron 2 o más citas atendidas en esos 12 meses.`,
        datos: { mes: month, mismosDiasMesAnterior: before, doceMeses: year, dosOMasCitasEnElAño: twice?.count ?? 0 },
      }
    },

    p5: async () => {
      const [gap] = await tx.execute<{ average: number | null; median: number | null; gaps: number }>(sql`
        with ${attended}, v as (
          select patient_id, starts_at, lag(starts_at) over (partition by patient_id order by starts_at, id) as prev
          from attended where starts_at >= ${yearAgo}::timestamptz)
        select avg(extract(epoch from starts_at - prev) / 86400)::float as average,
          percentile_cont(0.5) within group (order by extract(epoch from starts_at - prev) / 86400)::float as median, count(*)::int as gaps
        from v where prev is not null`)
      const [visits] = await tx.execute<{ visits: number; patients: number; repeat: number; repeatVisits: number }>(sql`
        with ${attended}, y as (select patient_id, count(*) as visits from attended where starts_at >= ${yearAgo}::timestamptz group by 1)
        select coalesce(sum(visits), 0)::int as visits, count(*)::int as patients,
          count(*) filter (where visits >= 2)::int as repeat, coalesce(sum(visits) filter (where visits >= 2), 0)::int as "repeatVisits"
        from y`)
      const [spanning] = await tx.execute<{ average: number | null; median: number | null }>(sql`
        with ${attended}, v as (
          select patient_id, starts_at, lag(starts_at) over (partition by patient_id order by starts_at, id) as prev from attended)
        select avg(extract(epoch from starts_at - prev) / 86400)::float as average,
          percentile_cont(0.5) within group (order by extract(epoch from starts_at - prev) / 86400)::float as median
        from v where prev is not null and starts_at >= ${yearAgo}::timestamptz`)
      const average = Math.round(gap?.average ?? 0)
      const perPatient = visits?.patients ? visits.visits / visits.patients : 0
      const words = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 })
      return {
        respuesta: `En los últimos 12 meses, un paciente vuelve en promedio cada ${average} días (unos ${words(average / 30.4)} meses) entre una cita atendida y la siguiente; la mediana es de ${Math.round(gap?.median ?? 0)} días. Visto por paciente: ${visits?.visits ?? 0} citas atendidas de ${visits?.patients ?? 0} pacientes, ${words(perPatient)} visitas por paciente al año.`,
        criterio: "Días entre citas atendidas seguidas del mismo paciente (sin Spam ni bloqueados), con ambas citas en los últimos 365 días; y citas atendidas ÷ pacientes atendidos en ese año.",
        nota: `Solo entre quienes vinieron 2 o más veces en el año (${visits?.repeat ?? 0} pacientes): ${words(visits?.repeat ? visits.repeatVisits / visits.repeat : 0)} visitas por paciente. Si la cita anterior puede ser de antes del año (todas las vueltas que ocurrieron en el año): ${Math.round(spanning?.average ?? 0)} días en promedio, ${Math.round(spanning?.median ?? 0)} de mediana.`,
        datos: { entreCitas: gap, porPaciente: visits, conCitaAnteriorFueraDelAño: spanning },
      }
    },

    p6: async () => {
      const [row] = await tx.execute<{
        people: number
        items: number
        waiting: number
        running: number
        suspended: number
        activePeople: number
        unbooked: number
      }>(sql`
        select count(distinct pi.patient_id)::int as people, count(*)::int as items,
          count(*) filter (where pi.status in ('pendiente','programado'))::int as waiting,
          count(*) filter (where pi.status = 'en_curso')::int as running,
          count(*) filter (where pi.status = 'suspendido')::int as suspended,
          count(distinct pi.patient_id) filter (where pi.status <> 'suspendido')::int as "activePeople",
          count(distinct pi.patient_id) filter (where not ${upcoming(sql`pi.patient_id`)})::int as unbooked
        from treatment_plan_item pi ${person(sql`pi.patient_id`)}
        where pi.organization_id = ${org} and pi.decision_status = 'aceptado' and pi.status not in ('realizado','cancelado','reemplazado')`)
      const coming = await h.fig("lo_que_viene")
      return {
        respuesta: `Hoy ${row?.people ?? 0} pacientes tienen tratamientos pendientes: ${row?.items ?? 0} tratamientos aceptados sin terminar (${row?.waiting ?? 0} por empezar, ${row?.running ?? 0} en curso y ${row?.suspended ?? 0} suspendidos). De esos pacientes, ${row?.unbooked ?? 0} no tienen una cita por venir.`,
        criterio: "Tratamientos del plan aceptados que no están realizados, cancelados ni reemplazados, a hoy; pacientes distintos sin Spam ni bloqueados.",
        nota: `Sin contar los suspendidos: ${row?.activePeople ?? 0} pacientes. Por presupuestos («Lo que viene» de Reportes: lo aceptado en un presupuesto que falta hacer): ${coming.total.part ?? 0} pacientes por ${h.show(coming)}, ${coming.total.whole ?? 0} de ellos sin cita.`,
        datos: { row, loQueViene: coming.total },
      }
    },

    p7: async () => {
      const top = (from: string | null) =>
        tx.execute<{ name: string; cents: string; payers: number }>(sql`
          with paid as (
            select pay.patient_id, pay.amount_cents::bigint as cents from patient_payment pay
            where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
              and pay.paid_at < ${nowIso}::timestamptz ${from ? sql`and pay.paid_at >= ${from}::timestamptz` : sql``}
            union all
            select r.patient_id, -r.amount_cents::bigint from patient_payment_refund r
            join patient_payment pay on pay.organization_id = r.organization_id and pay.id = r.payment_id and pay.voided_at is null and pay.currency = ${h.scope.currency}
            where r.organization_id = ${org} and r.refunded_at < ${nowIso}::timestamptz ${from ? sql`and r.refunded_at >= ${from}::timestamptz` : sql``})
          select pp.display_name as name, sum(x.cents)::text as cents, count(*) over()::int as payers
          from paid x ${person(sql`x.patient_id`)}
          group by x.patient_id, pp.display_name having sum(x.cents) > 0
          order by sum(x.cents) desc, 1 limit 10`)
      const year = await top(yearAgo)
      const ever = await top(null)
      const charged = await tx.execute<{ name: string; cents: string }>(sql`
        select pp.display_name as name, sum(c.amount_cents)::text as cents from patient_charge c ${person(sql`c.patient_id`)}
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${yearAgo}::timestamptz and c.created_at < ${nowIso}::timestamptz
        group by c.patient_id, pp.display_name order by sum(c.amount_cents) desc, 1 limit 5`)
      const words = (rows: Array<{ name: string; cents: string }>, count = 5) => h.listOf(rows.slice(0, count).map((row) => ({ name: row.name, value: h.money(Number(row.cents)) })))
      return {
        respuesta: `Por lo que pagaron en los últimos 12 meses, tus pacientes de mayor valor son ${words(year)}. En total ${year[0]?.payers ?? 0} pacientes pagaron algo en ese año.`,
        criterio: "Lo pagado por cada paciente en los últimos 365 días: pagos vigentes menos lo devuelto, en la moneda de la clínica, de más a menos.",
        nota: `Por todo lo pagado desde siempre: ${words(ever)}. Por lo cargado en el año (tratamientos y productos, pagados o no): ${words(charged)}.`,
        datos: { doceMeses: year, siempre: ever, cargado: charged },
      }
    },

    p8: async () => {
      const cohort = (from: string, to: string) =>
        tx.execute<{ fresh: number; back: number; booked: number }>(sql`
          with ${attended}, ${firstVisit}, cohort as (select patient_id, starts_at from first_visit where starts_at >= ${from}::timestamptz and starts_at < ${to}::timestamptz)
          select count(*)::int as fresh,
            count(*) filter (where exists (select 1 from attended a where a.patient_id = c.patient_id and a.starts_at > c.starts_at))::int as back,
            count(*) filter (where exists (select 1 from attended a where a.patient_id = c.patient_id and a.starts_at > c.starts_at) or ${upcoming(sql`c.patient_id`)})::int as booked
          from cohort c`)
      const [year] = await cohort(yearAgo, nowIso)
      const [ripe] = await cohort(yearAgo, new Date(h.now.getTime() - 90 * DAY_MS).toISOString())
      const [month] = await cohort(monthStart, nowIso)
      return {
        respuesta: `De los ${year?.fresh ?? 0} pacientes nuevos de los últimos 12 meses, ${year?.back ?? 0} ya volvieron para una segunda cita atendida: el ${pct(year?.back ?? 0, year?.fresh ?? 0)}.`,
        criterio: "Pacientes cuya primera cita atendida fue en los últimos 365 días (sin Spam ni bloqueados) y que tienen otra cita atendida después, hasta hoy.",
        nota: `Solo los nuevos de hace 3 a 12 meses, que ya tuvieron tiempo de volver: ${ripe?.back ?? 0} de ${ripe?.fresh ?? 0} (${pct(ripe?.back ?? 0, ripe?.fresh ?? 0)}). Contando también a quien ya tiene su segunda cita agendada: ${year?.booked ?? 0} de ${year?.fresh ?? 0} (${pct(year?.booked ?? 0, year?.fresh ?? 0)}). Los nuevos de este mes: ${month?.back ?? 0} de ${month?.fresh ?? 0} ya volvieron.`,
        datos: { doceMeses: year, deHace3a12Meses: ripe, mes: month },
      }
    },

    p9: async () => {
      // Quien hoy está «Sin venir» se perdió el mes en que cumplió 6 meses sin una cita atendida.
      const months = fullMonths(6)
      const lapsedByMonth = await tx.execute<{ month: string; count: number }>(sql`
        with ${lapsedSql(org, h.scope, h.now)}
        select to_char((l.starts_at at time zone ${tz}) + interval '6 months', 'YYYY-MM') as month, count(*)::int as count
        from lapsed l ${person(sql`l.patient_id`)} group by 1`)
      const plainByMonth = await tx.execute<{ month: string; count: number }>(sql`
        with ${attended}, last as (select patient_id, max(starts_at) as at from attended group by 1)
        select to_char((at at time zone ${tz}) + interval '6 months', 'YYYY-MM') as month, count(*)::int as count
        from last where at < ${monthsAgo(6)} group by 1`)
      const of = (rows: typeof lapsedByMonth, key: string) => rows.find((row) => row.month === key)?.count ?? 0
      const series = months.map((month) => ({ ...month, lapsed: of(lapsedByMonth, month.key), plain: of(plainByMonth, month.key) }))
      const average = (values: number[]) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0)
      const avg6 = average(series.map((row) => row.lapsed))
      const avg3 = average(series.slice(-3).map((row) => row.lapsed))
      const avgPlain = average(series.map((row) => row.plain))
      const current = of(lapsedByMonth, `${h.scope.window.from.year}-${String(h.scope.window.from.month).padStart(2, "0")}`)
      const lapsed = await h.fig("sin_venir")
      const words = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 })
      const name = (month: { year: number; month: number }) =>
        new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 15))).toLowerCase()
      return {
        respuesta: `En los últimos 6 meses completos dejaste de ver en promedio ${words(avg6)} pacientes por mes: ${h.listOf(series.map((row) => ({ name: name(row), value: `${row.lapsed}` })))}. Son los que ese mes cumplieron 6 meses sin una cita atendida y hoy siguen sin cita, presupuesto ni control pendiente. Hoy suman ${h.show(lapsed)} sin venir.`,
        criterio: "La regla de «Sin venir» de Reportes, a hoy, repartida por el mes en que cada paciente cumplió 6 meses desde su última cita atendida; los últimos 6 meses completos.",
        nota: `Con los últimos 3 meses completos: ${words(avg3)} por mes. Contando a todos los que cumplieron 6 meses sin venir, aunque hoy tengan algo pendiente: ${words(avgPlain)} por mes (${h.listOf(series.map((row) => ({ name: name(row), value: `${row.plain}` })))}). En el mes en curso, hasta hoy: ${current}.`,
        datos: { meses: series, promedio6: avg6, promedio3: avg3, promedioSinExcluir: avgPlain, mesEnCurso: current, sinVenirHoy: lapsed.total },
      }
    },

    p10: async () => {
      const lapsed = await getPatientReportList(tx, org, { period: "este_mes", list: "lapsed", limit: 5000 }, h.now)
      const recent = [...lapsed.rows].sort((a, b) => b.at.localeCompare(a.at))
      const unbooked = await getReportList(tx, org, { period: "este_mes", list: "upcoming_unbooked", limit: 5000 }, h.now)
      const controls = await tx.execute<{ patientId: string; name: string }>(sql`
        select distinct f.patient_id as "patientId", pp.display_name as name from clinical_follow_up f ${person(sql`f.patient_id`)}
        where f.organization_id = ${org} and f.status = 'pendiente' and f.due_at < ${nowIso}::timestamptz and pp.is_active
          and not ${upcoming(sql`f.patient_id`)}`)
      const everyone = new Set([...lapsed.rows.map((row) => row.patientId), ...unbooked.rows.map((row) => row.patientId), ...controls.map((row) => row.patientId)].filter(Boolean))
      return {
        respuesta: `Te sugiero contactar a los ${lapsed.total} pacientes que dejaron de venir: más de 6 meses sin una cita atendida y sin cita, presupuesto ni control pendiente. Empezando por los que se fueron más recientemente: ${h.listOf(recent.slice(0, 5).map((row) => ({ name: row.personName, value: `última cita el ${shortDay(row.at)}${row.title ? `, ${row.title}` : ""}` })))}.`,
        criterio: "La lista «Sin venir hace más de 6 meses» de Reportes (la de «Invitar a volver»), a hoy, ordenada de la última cita más reciente a la más antigua.",
        nota: `También conviene llamar a ${unbooked.total} pacientes con tratamientos aceptados por hacer y sin cita («Lo que viene» sin cita) y a ${controls.length} con un control vencido y sin cita. Juntando las tres listas, sin repetir: ${everyone.size} pacientes.`,
        datos: {
          sinVenir: lapsed.total,
          primeros: recent.slice(0, 10).map((row) => ({ name: row.personName, at: row.at, title: row.title, professional: row.professionalName })),
          aceptadoSinCita: unbooked.total,
          controlesVencidos: controls.length,
          juntos: everyone.size,
        },
      }
    },
  }
}
