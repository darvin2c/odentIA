/** Respuestas correctas de la estrategia (el porqué, el futuro y los consejos) (eval/argos-owner.json). */
import {
  addDays,
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  collectedByProfessional,
  dayStart,
  type FigureResult,
  getAgendaReport,
  getPatientReportList,
  reportDayOf,
  reportScope,
  type Span,
  upcomingWork,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { changePct, monthLabel, salesByConcept, sameDaysWords, signedMoney } from "./trends.js"

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

export function strategySolvers(h: GoldenHelpers): GoldenSolvers {
  const { window } = h.scope
  const days = sameDaysWords(h)
  const nowIso = h.now.toISOString()
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(h.scope.locale)} h`
  const dateWords = (iso: string) => new Intl.DateTimeFormat(h.scope.locale, { day: "numeric", month: "long", year: "numeric", timeZone: h.tz }).format(new Date(iso))

  /** Presupuestos que esperan respuesta y lo que vale lo aún no decidido (como c63). */
  const awaiting = async () => {
    const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
    const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
    const [row] = await h.tx.execute<{ budgets: number; people: number; cents: string; oldest: string | null }>(sql`
      select count(distinct b.id)::int as budgets, count(distinct b.patient_id)::int as people,
        coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents, min(b.presented_at)::text as oldest
      from treatment_budget b
      join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budget)} and i.decision in ('pendiente','pospuesto') and i.price_cents is not null
      where b.organization_id = ${h.org} and ${budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })}`)
    return { budgets: row?.budgets ?? 0, people: row?.people ?? 0, cents: Number(row?.cents ?? 0), oldest: row?.oldest ?? null }
  }

  /** Lo cobrado de lo que atendió cada profesional, mes en curso contra los mismos días del anterior. */
  const professionalsSameDays = async () => {
    const current = await collectedByProfessional(h.tx, h.org, { start: window.start, end: window.end }, h.scope.currency)
    const previous = await collectedByProfessional(h.tx, h.org, { start: window.previous.start, end: window.previous.end }, h.scope.currency)
    const ids = [...new Set([...current, ...previous].map((row) => row.professionalUserId))]
    return ids.map((id) => {
      const now = current.find((row) => row.professionalUserId === id)
      const before = previous.find((row) => row.professionalUserId === id)
      const cents = now?.cobradoCents ?? 0
      const prevCents = before?.cobradoCents ?? 0
      return { name: now?.name ?? before?.name ?? "", cents, prevCents, change: cents - prevCents }
    })
  }

  /** Inicio del día civil `YYYY-MM-DD` de la clínica. */
  const startOfDay = (day: string): Date => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    return dayStart(h.tz, year, month, date)
  }

  return {
    s1: async () => {
      const total = await h.fig("cobrado")
      const value = total.total.value ?? 0
      const before = total.previous?.value ?? 0
      const concepts = (await salesByConcept(h, window, window.previous)).map((row) => ({ ...row, change: row.cents - row.prevCents }))
      const conceptDrops = concepts.filter((row) => row.change < 0).sort((a, b) => a.change - b.change || a.name.localeCompare(b.name))
      const people = await professionalsSameDays()
      const peopleDrops = people.filter((row) => row.change < 0).sort((a, b) => a.change - b.change)
      const attended = await h.fig("atendidas")
      const fresh = await h.fig("pacientes_nuevos")
      const accepted = await h.fig("aceptaron")
      const move = (cents: number, prevCents: number) => `${h.money(cents)} contra ${h.money(prevCents)}, ${signedMoney(h, cents - prevCents)}`
      const fell = value < before
      return {
        respuesta: fell
          ? `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Lo que sí muestran los datos: ${days.current} cobraste ${h.show(total)}, contra ${h.show(total, before)} ${days.previous} (${signedMoney(h, value - before)}, ${changePct(value, before) ?? "—"}). Lo que más bajó, por tratamiento: ${h.listOf(
              conceptDrops.slice(0, 3).map((row) => ({ name: row.name, value: move(row.cents, row.prevCents) })),
            )}; por profesional (lo cobrado de lo que atendió): ${h.listOf(peopleDrops.slice(0, 3).map((row) => ({ name: row.name, value: move(row.cents, row.prevCents) })))}.`
          : `Este mes tus ingresos no bajaron: ${days.current} cobraste ${h.show(total)}, contra ${h.show(total, before)} ${days.previous} (${signedMoney(h, value - before)}). Y el porqué no lo sé: odentIA registra lo que pasó, no sus causas.`,
        criterio:
          "Trampa: odentIA no sabe causas. Se ofrece lo cobrado de Reportes contra los mismos días del mes anterior y dónde bajó: lo pagado por tratamiento (sin anulados ni lo devuelto) y lo cobrado por profesional (Reportes).",
        nota: `Otras cifras del mismo tramo: citas atendidas ${h.show(attended)} contra ${h.show(attended, attended.previous?.value ?? null)}; pacientes nuevos ${h.show(fresh)} contra ${h.show(fresh, fresh.previous?.value ?? null)}; aceptaron su presupuesto ${h.show(accepted)} contra ${h.show(accepted, accepted.previous?.value ?? null)}. Todo lo que bajó por tratamiento: ${h.listOf(conceptDrops.map((row) => ({ name: row.name, value: signedMoney(h, row.change) })))}.`,
        datos: { total: total.total, anterior: total.previous, porConcepto: concepts, porProfesional: people },
      }
    },
    s2: async () => {
      const leaves = await h.fig("lo_que_deja")
      const collected = await h.fig("cobrado")
      const spent = await h.fig("gastos", "categoria")
      const commissions = await h.fig("comisiones")
      const lastLeaves = await h.fig("lo_que_deja", "total", "mes_pasado")
      const lastCollected = await h.fig("cobrado", "total", "mes_pasado")
      const value = (result: FigureResult) => result.total.value ?? 0
      const before = (result: FigureResult) => result.previous?.value ?? 0
      return {
        respuesta: `No puedo decirte qué la afecta: odentIA no explica causas ni conoce el costo de cada tratamiento (el laboratorio y los materiales no se ligan a cada uno). Lo registrado ${days.current}: de ${h.show(collected)} cobrados quedaron ${h.show(leaves)} (margen del ${pct(value(leaves), value(collected))}), después de ${h.show(spent)} de gastos registrados y ${h.show(commissions)} de comisiones; ${days.previous} quedaron ${h.show(leaves, before(leaves))} de ${h.show(collected, before(collected))} (${pct(before(leaves), before(collected))}). Los gastos más altos este mes: ${h.listOf(spent.rows.slice(0, 3).map((row) => ({ name: row.label, value: h.show(spent, row.value.value) })))}.`,
        criterio: "Trampa: sin causas ni costos por tratamiento. Se ofrece «Lo que deja» de Reportes (cobrado − comisiones − gastos registrados) y su margen, contra los mismos días del mes anterior, con los gastos por tipo.",
        nota: `Gastos registrados: ${h.show(spent)} contra ${h.show(spent, before(spent))} en los mismos días del mes anterior; comisiones: ${h.show(commissions)} contra ${h.show(commissions, before(commissions))}. En todo ${monthLabel(h, window.previous.from)}, el margen fue del ${pct(value(lastLeaves), value(lastCollected))} (${h.show(lastLeaves)} de ${h.show(lastCollected)}). Puede faltar algún gasto que no se anotó.`,
        datos: { cobrado: collected.total, deja: leaves.total, gastos: spent.rows, comisiones: commissions.total, anterior: { cobrado: collected.previous, deja: leaves.previous, gastos: spent.previous, comisiones: commissions.previous } },
      }
    },
    s3: async () => {
      const keys = ["cobrado", "lo_que_deja", "pacientes_nuevos", "atendidas", "no_vinieron", "canceladas", "aceptaron", "agenda_ocupada", "controles", "deuda_vencida", "te_deben"]
      const results = await Promise.all(keys.map((key) => h.fig(key)))
      const rows = results.map((result) => {
        const value = result.total.value ?? 0
        const before = result.previous?.value ?? 0
        const worse = result.figure.better === "up" ? value < before : value > before
        // Un porcentaje se mide en puntos (26 puntos pesan como un 26 %); lo demás, en proporción.
        const size = result.figure.unit === "rate" ? Math.abs(value - before) / 100 : before !== 0 ? Math.abs(value - before) / Math.abs(before) : value !== 0 ? 1 : 0
        const change =
          result.figure.unit === "rate"
            ? `${value - before > 0 ? "+" : "−"}${Math.abs(value - before)} puntos`
            : (changePct(value, before) ?? (result.figure.unit === "money" ? signedMoney(h, value - before) : `${value - before > 0 ? "+" : ""}${value - before}`))
        return { name: result.figure.name, value: h.show(result, value), before: h.show(result, before), change, worse, size, changed: value !== before }
      })
      const worse = rows.filter((row) => row.worse).sort((a, b) => b.size - a.size)
      const better = rows.filter((row) => !row.worse && row.changed)
      const waiting = await awaiting()
      const lapsed = await h.fig("sin_venir")
      const describe = (row: (typeof rows)[number]) => `${row.value} contra ${row.before}, ${row.change}`
      return {
        respuesta: `Cuáles son los problemas más importantes es un juicio tuyo; odentIA no lo decide. Lo más cercano: las cifras de Reportes que más empeoraron ${days.current} frente a ${days.sameAs} son ${h.listOf(worse.slice(0, 3).map((row) => ({ name: row.name, value: describe(row) })))}.`,
        criterio: "Trampa: «problemas más importantes» es una opinión. Se ofrecen las cifras de Reportes que empeoraron contra los mismos días del mes anterior, ordenadas por cuánto cambiaron: en proporción el dinero y los conteos, en puntos los porcentajes.",
        nota: `Todas las que empeoraron: ${h.listOf(worse.map((row) => ({ name: row.name, value: describe(row) })))}. Mejoraron: ${h.listOf(better.map((row) => ({ name: row.name, value: describe(row) }))) || "ninguna"}. Lo pendiente a hoy: ${waiting.budgets} presupuestos esperan respuesta (${h.money(waiting.cents)}) y ${h.show(lapsed)} pacientes llevan más de 6 meses sin venir.`,
        datos: { cifras: rows, presupuestosEsperando: waiting, sinVenir: lapsed.total },
      }
    },
    s4: async () => {
      const waiting = await awaiting()
      const coming = await upcomingWork(h.tx, h.org, h.scope.currency, h.now)
      const lapsed = await h.fig("sin_venir")
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const free = await h.fig("horas_libres")
      return {
        respuesta: `Qué estás desaprovechando es una evaluación que odentIA no hace, pero sí tengo lo registrado que todavía no se convierte en ingreso: ${waiting.budgets} presupuestos esperan respuesta por ${h.money(waiting.cents)}; lo aceptado que falta hacer vale ${h.money(coming.cents)} (${coming.patients} pacientes; ${coming.unbooked.patients} de ellos sin cita, por ${h.money(coming.unbooked.cents)}); y ${h.show(lapsed)} pacientes llevan más de 6 meses sin venir.`,
        criterio: "Trampa: es un juicio. Se ofrecen presupuestos que esperan respuesta (lo aún no decidido), «Lo que viene» de Reportes (lo aceptado sin hacer, con lo que no tiene cita) y «Sin venir hace más de 6 meses», a hoy.",
        nota: `También: te deben ${h.show(owed)} (${h.show(overdue)} hace más de 30 días, de ${overdue.total.part ?? 0} personas), y este mes quedaron ${h.show(free)} libres en la agenda.`,
        datos: { esperanRespuesta: waiting, loQueViene: coming, sinVenir: lapsed.total, teDeben: owed.total, vencido: overdue.total, horasLibres: free.total },
      }
    },
    s5: async () => {
      const months = await h.fig("cobrado", "mes", "mes_pasado")
      const lastValue = months.total.value ?? 0
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length : 0
      const current = await h.fig("cobrado")
      const waiting = await awaiting()
      const coming = await upcomingWork(h.tx, h.org, h.scope.currency, h.now)
      const owed = await h.fig("te_deben")
      const free = await h.fig("horas_libres")
      const lastName = monthLabel(h, window.previous.from)
      return {
        respuesta: `No puedo decirte qué hacer: odentIA no da consejos (y no emite facturas, solo tickets de pago). Como referencia, en ${lastName} cobraste ${h.show(months)}; un 15 % más son ${h.money(Math.round(lastValue * 0.15))} adicionales al mes (${h.money(Math.round(lastValue * 1.15))} en total). Lo registrado que aún no se cobra: ${h.money(waiting.cents)} en ${waiting.budgets} presupuestos que esperan respuesta, ${h.money(coming.cents)} de lo aceptado que falta hacer y ${h.show(owed)} que te deben.`,
        criterio: "Trampa: es un consejo. Se ofrece cuánto es un 15 % sobre lo cobrado del último mes completo (Reportes) y el dinero registrado sin cobrar: presupuestos que esperan respuesta, lo aceptado sin hacer y lo que te deben.",
        nota: `Sobre el promedio de los últimos 3 meses completos (${h.money(Math.round(average))}), el 15 % son ${h.money(Math.round(average * 0.15))}. ${days.current[0]?.toUpperCase()}${days.current.slice(1)} vas ${h.show(current)}; un 15 % más que ${days.previous} (${h.show(current, current.previous?.value ?? null)}) serían ${h.money(Math.round((current.previous?.value ?? 0) * 1.15))}. Horas libres en la agenda este mes: ${h.show(free)}.`,
        datos: { mesPasado: months.total, ultimos3: recent, mes: current.total, esperanRespuesta: waiting, loQueViene: coming, teDeben: owed.total },
      }
    },
    s6: async () => {
      const list = await getPatientReportList(h.tx, h.org, { period: "este_mes", list: "lapsed", limit: 5000 }, h.now)
      const rows = [...list.rows].sort((a, b) => a.at.localeCompare(b.at))
      const [row] = await h.tx.execute<{ quarter: number; quarter_unbooked: number; missed: number }>(sql`
        with last as (
          select a.patient_id, max(a.starts_at) filter (where a.status = 'atendida') as attended,
            (array_agg(a.status order by a.starts_at desc) filter (where a.starts_at < ${nowIso}::timestamptz and a.status in ('atendida','no_asistio','cancelada')))[1] as last_status
          from appointment a
          join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
          join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active and pp.screen is null
          where a.organization_id = ${h.org} group by 1),
        booked as (
          select distinct n.patient_id from appointment n where n.organization_id = ${h.org} and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada'))
        select count(*) filter (where attended < ${nowIso}::timestamptz - interval '90 days')::int as quarter,
          count(*) filter (where attended < ${nowIso}::timestamptz - interval '90 days' and patient_id not in (select patient_id from booked))::int as quarter_unbooked,
          count(*) filter (where last_status in ('no_asistio','cancelada') and patient_id not in (select patient_id from booked))::int as missed
        from last`)
      return {
        respuesta: `No puedo calcular la probabilidad de que alguien abandone: odentIA no predice. Lo más cercano: ${list.total} pacientes llevan más de 6 meses sin venir y no tienen cita, presupuesto esperando ni control pendiente. Los que llevan más tiempo: ${h.listOf(rows.slice(0, 5).map((item) => ({ name: item.personName, value: `última cita el ${dateWords(item.at)}` })))}.`,
        criterio: "Trampa: no hay probabilidad de abandono. Se ofrece la lista «Sin venir hace más de 6 meses» de Reportes (a hoy), de la última cita atendida más antigua a la más reciente.",
        nota: `Con 90 días en vez de 6 meses: ${row?.quarter ?? 0} pacientes no vienen desde hace más de 90 días; ${row?.quarter_unbooked ?? 0} de ellos sin cita por venir. Pacientes cuya última cita fue una falta o una cancelación y no tienen otra agendada: ${row?.missed ?? 0}.`,
        datos: { total: list.total, primeros: rows.slice(0, 20), otros: row },
      }
    },
    s7: async () => {
      const quarter = await reportScope(h.tx, h.org, { period: "ultimos_3_meses" }, h.now)
      const recent: Span = quarter.window
      const earlier: Span = quarter.window.previous
      const iso = (span: Span) => [span.start.toISOString(), span.end.toISOString()] as const
      const [rs, re] = iso(recent)
      const [es, ee] = iso(earlier)
      const [ms, me] = iso(window)
      const [ps, pe] = iso(window.previous)
      const rows = await h.tx.execute<{ name: string; recent: number; earlier: number; month: number; before: number }>(sql`
        select coalesce(s.name, ep.description) as name,
          coalesce(sum(ep.quantity) filter (where e.started_at >= ${rs}::timestamptz and e.started_at < ${re}::timestamptz), 0)::int as recent,
          coalesce(sum(ep.quantity) filter (where e.started_at >= ${es}::timestamptz and e.started_at < ${ee}::timestamptz), 0)::int as earlier,
          coalesce(sum(ep.quantity) filter (where e.started_at >= ${ms}::timestamptz and e.started_at < ${me}::timestamptz), 0)::int as month,
          coalesce(sum(ep.quantity) filter (where e.started_at >= ${ps}::timestamptz and e.started_at < ${pe}::timestamptz), 0)::int as before
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada'
        left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${h.org} and ep.voided_at is null and e.started_at >= ${es}::timestamptz and e.started_at < ${me}::timestamptz
        group by 1`)
      const down = rows.filter((row) => row.recent < row.earlier).sort((a, b) => a.recent - a.earlier - (b.recent - b.earlier) || a.name.localeCompare(b.name))
      const monthDown = rows.filter((row) => row.month < row.before).sort((a, b) => a.month - a.before - (b.month - b.before) || a.name.localeCompare(b.name))
      const span = (value: Span) => {
        const first = reportDayOf(h.tz, value.start)
        const last = reportDayOf(h.tz, new Date(value.end.getTime() - 1))
        const ym = (day: string) => ({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) })
        return `${monthLabel(h, ym(first), false)} a ${monthLabel(h, ym(last), false)}`
      }
      const words = (list: Array<(typeof rows)[number]>, now: "recent" | "month", then: "earlier" | "before") =>
        h.listOf(list.slice(0, 5).map((row) => ({ name: row.name, value: `${row[now]} contra ${row[then]}, ${changePct(row[now], row[then]) ?? `${row[now] - row[then]}`}` })))
      return {
        respuesta: down.length
          ? `Comparando los últimos 3 meses completos (${span(recent)}) con los 3 anteriores (${span(earlier)}), se hicieron menos veces ${down.length} tratamientos; los que más bajaron: ${words(down, "recent", "earlier")}.`
          : `Ningún tratamiento se hizo menos veces en ${span(recent)} que en ${span(earlier)}.`,
        criterio: "Veces que se hizo cada tratamiento (procedimientos no anulados de atenciones firmadas, contando la cantidad) en los últimos 3 meses completos contra los 3 anteriores, ordenado por cuánto bajó.",
        nota: `Mes en curso contra los mismos días del anterior (${days.current} contra ${days.sameAs}): ${words(monthDown, "month", "before") || "ninguno bajó"}.`,
        datos: { filas: rows },
      }
    },
    s8: async () => {
      const [next] = await h.tx.execute<{ start: string; end: string; key: string }>(sql`
        select ((date_trunc('month', now() at time zone ${h.tz}) + interval '1 month') at time zone ${h.tz})::text as start,
          ((date_trunc('month', now() at time zone ${h.tz}) + interval '2 months') at time zone ${h.tz})::text as end,
          to_char(date_trunc('month', now() at time zone ${h.tz}) + interval '1 month', 'YYYY-MM') as key`)
      const start = new Date(next?.start ?? nowIso)
      const end = new Date(next?.end ?? nowIso)
      const [booked] = await h.tx.execute<{ total: number; confirmed: number; people: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed, count(distinct a.patient_id)::int as people
        from appointment a
        where a.organization_id = ${h.org} and a.status in ('programada','confirmada')
          and a.starts_at >= ${start.toISOString()}::timestamptz and a.starts_at < ${end.toISOString()}::timestamptz`)
      const [thirty] = await h.tx.execute<{ total: number; confirmed: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed from appointment a
        where a.organization_id = ${h.org} and a.status in ('programada','confirmada')
          and a.starts_at > ${nowIso}::timestamptz and a.starts_at < ${nowIso}::timestamptz + interval '30 days'`)
      const coming = await upcomingWork(h.tx, h.org, h.scope.currency, h.now)
      const waiting = await awaiting()
      const months = await h.fig("cobrado", "mes", "mes_pasado")
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length : 0
      const [year, month] = (next?.key ?? "2000-01").split("-").map(Number) as [number, number]
      const nextName = monthLabel(h, { year, month })
      return {
        respuesta: `No puedo predecir cuánto vas a facturar: odentIA no proyecta el futuro (y no emite facturas, solo tickets de pago). Lo ya registrado para ${nextName}: ${booked?.total ?? 0} citas agendadas (${booked?.confirmed ?? 0} confirmadas) de ${booked?.people ?? 0} pacientes; y lo aceptado en presupuestos que falta hacer vale ${h.money(coming.cents)} (${coming.patients} pacientes), sin fecha de cobro.`,
        criterio: "Trampa: es una predicción. Se ofrecen las citas programadas o confirmadas del mes siguiente y «Lo que viene» de Reportes (lo aceptado sin hacer), a hoy.",
        nota: `Como referencia, lo cobrado en los últimos 3 meses completos: ${h.listOf(recent.map((item) => ({ name: monthLabel(h, item.month), value: h.show(months, item.value.value) })))} (promedio ${h.money(Math.round(average))}). Leyendo «el próximo mes» como los próximos 30 días: ${thirty?.total ?? 0} citas agendadas (${thirty?.confirmed ?? 0} confirmadas). Presupuestos que esperan respuesta: ${waiting.budgets} por ${h.money(waiting.cents)}.`,
        datos: { mesSiguiente: next, citas: booked, proximos30Dias: thirty, loQueViene: coming, esperanRespuesta: waiting, ultimos3: recent },
      }
    },
    s9: async () => {
      const report = await getAgendaReport(h.tx, h.org, { period: "este_mes" }, h.now)
      const slots = new Map<string, number>()
      const byDay = new Map<number, number>()
      for (const slot of report.map.week) {
        const free = Math.max(0, slot.availMin - slot.occMin)
        slots.set(`${slot.weekday}|${slot.hour}`, (slots.get(`${slot.weekday}|${slot.hour}`) ?? 0) + free)
        byDay.set(slot.weekday, (byDay.get(slot.weekday) ?? 0) + free)
      }
      const top = [...slots.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      const days7 = [...byDay.entries()].sort((a, b) => b[1] - a[1])
      const free = await h.fig("horas_libres")
      const occupied = await h.fig("agenda_ocupada")
      const perPerson = await h.fig("horas_libres", "profesional")
      const noShow = await h.fig("no_vinieron")
      return {
        respuesta: `Qué cambiar en tu agenda es un consejo que no doy, pero sí tengo cómo se usó este mes: quedaron ${h.show(free)} libres (agenda ocupada ${h.show(occupied)}), y las franjas con más horas libres son ${h.listOf(
          top.map(([key, minutes]) => {
            const [weekday, hour] = key.split("|").map(Number) as [number, number]
            return { name: `${WEEKDAYS[weekday]} a las ${hour}:00`, value: hoursOf(minutes) }
          }),
        )}.`,
        criterio: "Trampa: es un consejo. Se ofrece la semana tipo de Reportes › Agenda del mes en curso (horario menos citas no canceladas, por día de la semana y hora), con «Horas libres» y «Agenda ocupada».",
        nota: `Por día de la semana: ${h.listOf(days7.map(([weekday, minutes]) => ({ name: WEEKDAYS[weekday] ?? "", value: hoursOf(minutes) })))}. Por profesional: ${h.listOf(perPerson.rows.map((row) => ({ name: row.label, value: h.show(perPerson, row.value.value) })))}. No vino el ${h.show(noShow)} de las citas que ya pasaron.`,
        datos: { franjas: top, porDia: days7, horasLibres: free.total, ocupada: occupied.total, porProfesional: perPerson.rows },
      }
    },
    s10: async () => {
      const today = reportDayOf(h.tz, h.now)
      const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
      const monday = addDays(today, -((weekday + 6) % 7))
      const weekStart = startOfDay(monday)
      const weekEnd = startOfDay(addDays(monday, 7))
      const [week] = await h.tx.execute<{ coming: number; unconfirmed: number; unmarked: number }>(sql`
        select count(*) filter (where a.starts_at >= ${nowIso}::timestamptz and a.starts_at < ${weekEnd.toISOString()}::timestamptz)::int as coming,
          count(*) filter (where a.status = 'programada' and a.starts_at >= ${nowIso}::timestamptz and a.starts_at < ${weekEnd.toISOString()}::timestamptz)::int as unconfirmed,
          count(*) filter (where a.ends_at < ${nowIso}::timestamptz and a.starts_at >= ${weekStart.toISOString()}::timestamptz)::int as unmarked
        from appointment a
        where a.organization_id = ${h.org} and a.status in ('programada','confirmada')
          and a.starts_at >= ${weekStart.toISOString()}::timestamptz and a.starts_at < ${weekEnd.toISOString()}::timestamptz`)
      const waiting = await awaiting()
      const overdue = await h.fig("deuda_vencida")
      const [controls] = await h.tx.execute<{ overdue: number }>(sql`
        select count(distinct f.patient_id)::int as overdue from clinical_follow_up f ${h.joinPerson(sql`f.patient_id`)}
        where f.organization_id = ${h.org} and f.status = 'pendiente' and f.due_at < ${nowIso}::timestamptz and pp.is_active`)
      const coming = await upcomingWork(h.tx, h.org, h.scope.currency, h.now)
      const lapsed = await h.fig("sin_venir")
      const sunday = new Intl.DateTimeFormat(h.scope.locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${addDays(monday, 6)}T12:00:00Z`))
      return {
        respuesta: `Tus prioridades las decides tú; odentIA no las elige. Lo pendiente que tengo registrado para esta semana: 1) ${week?.unconfirmed ?? 0} de las ${week?.coming ?? 0} citas que quedan hasta el domingo ${sunday} siguen sin confirmar; 2) ${waiting.budgets} presupuestos esperan respuesta (${h.money(waiting.cents)}${waiting.oldest ? `, el más antiguo desde el ${dateWords(waiting.oldest)}` : ""}); 3) ${overdue.total.part ?? 0} personas te deben hace más de 30 días (${h.show(overdue)}); 4) ${controls?.overdue ?? 0} pacientes tienen un control vencido sin cita; 5) ${coming.unbooked.patients} pacientes con tratamiento aceptado no tienen cita (${h.money(coming.unbooked.cents)}).`,
        criterio: "Trampa: es un consejo. Se ofrece lo pendiente registrado, a hoy: citas de esta semana sin confirmar, presupuestos que esperan respuesta, deuda de más de 30 días (Reportes), controles vencidos sin cita y lo aceptado sin cita («Lo que viene» de Reportes).",
        nota: `Además: ${week?.unmarked ?? 0} citas de esta semana ya pasaron sin marcar si vino el paciente, y ${h.show(lapsed)} pacientes llevan más de 6 meses sin venir.`,
        datos: { semana: { desde: monday, hasta: addDays(monday, 6), ...week }, esperanRespuesta: waiting, vencido: overdue.total, controlesVencidos: controls?.overdue ?? 0, aceptadoSinCita: coming.unbooked, sinVenir: lapsed.total },
      }
    },
  }
}
