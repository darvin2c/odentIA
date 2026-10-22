/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`),
 * parte 8: g176–g200. Periodos con palabras (un mes de otro año, una semana, un
 * día contra el mismo de la semana anterior), consejos y predicciones que
 * odentIA no da y datos que no registra (costos, comprobantes, impuestos,
 * publicidad, satisfacción, cuotas, precios ajenos, motivos). Las trampas dicen
 * qué falta y dan lo registrado más cercano con su cifra.
 */
import {
  appointmentTotalsMany,
  budgetValueOptionSql,
  computeFigure,
  type FigureGroup,
  type FigureResult,
  funnelMany,
  getAgendaReport,
  getReportPromotions,
  reportScope,
  upcomingWork,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { dayStart, goldenWords, NO_INVOICES } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { changePct, monthLabel, sameDaysWords, signedMoney } from "./trends.js"

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
const DAY_MS = 86_400_000

export function generatedSolvers8(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { money, show, listOf } = h
  const { window } = h.scope
  const nowIso = h.now.toISOString()
  const yearAgoIso = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const today = { year: Number(w.todayKey.slice(0, 4)), month: Number(w.todayKey.slice(5, 7)) }
  const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const pct = (part: number, total: number): string =>
    total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato"
  const thisMonth = `este mes (${w.monthSoFar})`
  const dateWords = (iso: string | Date): string =>
    new Intl.DateTimeFormat(h.scope.locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: h.tz,
    }).format(new Date(iso))
  /** «del lunes 6 al domingo 12 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** El primer instante de un día de la clínica, como fecha. */
  const startOf = async (key: string): Promise<Date> => new Date(await dayStart(h, key))
  /** La sede activa cuyo nombre contiene `name`. */
  const branchNamed = async (name: string): Promise<{ id: string; name: string } | null> => {
    const [row] = await h.tx.execute<{ id: string; name: string }>(sql`
      select id, name from branch where organization_id = ${h.org} and is_active and lower(name) like ${`%${name}%`} order by name limit 1`)
    return row ?? null
  }
  const rowOf = (result: FigureResult, pattern: RegExp) =>
    result.rows.find((row) => pattern.test(row.label))
  /** Una cifra de Reportes con una sede elegida en la pantalla. */
  const figIn = async (
    figure: string,
    group: FigureGroup,
    period: string,
    branchId: string,
  ): Promise<FigureResult> =>
    computeFigure(
      { ...h.ctx, scope: await reportScope(h.tx, h.org, { period, branchId }, h.now) },
      { figure, group },
    )
  const rowsWords = (
    result: FigureResult,
    extra?: (row: FigureResult["rows"][number]) => string,
  ): string =>
    listOf(
      result.rows.map((row) => ({
        name: row.label,
        value: `${show(result, row.value.value)}${extra ? extra(row) : ""}`,
      })),
    )
  /** «5 de 48» de un porcentaje de Reportes. */
  const ofWords = (value: { part?: number; whole?: number } | null | undefined): string =>
    `${value?.part ?? 0} de ${value?.whole ?? 0}`
  /** El último septiembre (o el mes `month`) ya terminado. */
  const lastFull = (month: number): number => (today.month > month ? today.year : today.year - 1)
  /** Lo que se hizo de cada servicio (procedimientos sin anular de atenciones firmadas, por el día de la firma). */
  const doneSince = (where: SQL, since: string) =>
    h.tx.execute<{ id: string; name: string; price: number; times: number; month: number }>(sql`
      select s.id, s.name, s.price_cents as price,
        coalesce(sum(ep.quantity) filter (where e.finalized_at >= ${since}::timestamptz), 0)::int as times,
        coalesce(sum(ep.quantity) filter (where e.finalized_at >= ${h.monthStart}::timestamptz), 0)::int as month
      from service_catalog s
      left join encounter_procedure ep on ep.organization_id = s.organization_id and ep.service_id = s.id and ep.voided_at is null
      left join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada'
        and e.voided_at is null and e.finalized_at < ${nowIso}::timestamptz
      where s.organization_id = ${h.org} and s.is_active and ${where}
      group by s.id, s.name, s.price_cents order by 4 desc, 3 desc, 2`)
  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  /** Tratamientos de la opción que vale en los presupuestos entregados desde `since`, y cuántos se aceptaron (como b5). */
  const quoted = (since: string) =>
    h.tx.execute<{
      id: string | null
      name: string
      lines: number
      accepted: number
      rejected: number
    }>(sql`
      select s.id, coalesce(s.name, i.title) as name, count(*)::int as lines,
        count(*) filter (where b.status in ('aceptado','parcial') and i.decision = 'aceptado')::int as accepted,
        count(*) filter (where b.status = 'rechazado' or i.decision = 'rechazado')::int as rejected
      from treatment_budget b
      join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null
      left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
      where b.organization_id = ${h.org} and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
        and b.presented_at >= ${since}::timestamptz and b.presented_at < ${nowIso}::timestamptz
      group by 1, 2 order by 3 desc, 2`)
  /** Citas por venir (programadas o confirmadas) de un tramo. */
  const bookedIn = async (start: Date, end: Date) => {
    const [row] = await h.tx.execute<{ total: number; confirmed: number; first: number }>(sql`
      select count(*)::int as total, count(*) filter (where a.status = 'confirmada')::int as confirmed,
        count(*) filter (where not exists (select 1 from appointment v where v.organization_id = a.organization_id
          and v.patient_id = a.patient_id and v.status = 'atendida'))::int as first
      from appointment a
      where a.organization_id = ${h.org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz
        and a.starts_at >= ${start.toISOString()}::timestamptz and a.starts_at < ${end.toISOString()}::timestamptz`)
    return { total: row?.total ?? 0, confirmed: row?.confirmed ?? 0, first: row?.first ?? 0 }
  }
  /** El mes siguiente a `month` («2026-11»). */
  const nextMonth = (month: { year: number; month: number }) =>
    month.month === 12
      ? { year: month.year + 1, month: 1 }
      : { year: month.year, month: month.month + 1 }
  const monthKey = (month: { year: number; month: number }) =>
    `${month.year}-${String(month.month).padStart(2, "0")}`
  const monthSpan = async (month: { year: number; month: number }) => ({
    start: await startOf(`${monthKey(month)}-01`),
    end: await startOf(`${monthKey(nextMonth(month))}-01`),
  })
  /** La actividad registrada de una sede: citas, horarios y gastos. */
  const branchActivity = async (branchId: string) => {
    const [row] = await h.tx.execute<{
      appointments: number
      schedules: number
      expenses: number
      payments: number
    }>(sql`
      select (select count(*) from appointment a where a.organization_id = ${h.org} and a.branch_id = ${branchId})::int as appointments,
        (select count(*) from professional_schedule s where s.organization_id = ${h.org} and s.branch_id = ${branchId} and s.is_active)::int as schedules,
        (select count(*) from expense e where e.organization_id = ${h.org} and e.branch_id = ${branchId} and e.voided_at is null)::int as expenses,
        (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.branch_id = ${branchId} and p.voided_at is null)::int as payments`)
    return {
      appointments: row?.appointments ?? 0,
      schedules: row?.schedules ?? 0,
      expenses: row?.expenses ?? 0,
      payments: row?.payments ?? 0,
    }
  }
  /** Los gastos registrados de un tipo en un tramo, con sus conceptos. */
  const expensesOf = async (category: string, start: string, end: string) => {
    const [row] = await h.tx.execute<{ count: number; cents: string; concepts: string | null }>(sql`
      select count(*)::int as count, coalesce(sum(e.amount_cents), 0)::text as cents, string_agg(distinct e.concept, ', ') as concepts
      from expense e where e.organization_id = ${h.org} and e.voided_at is null and e.currency = ${h.scope.currency} and e.category = ${category}
        and e.spent_at >= ${start}::timestamptz and e.spent_at < ${end}::timestamptz`)
    return {
      count: row?.count ?? 0,
      cents: Number(row?.cents ?? 0),
      concepts: row?.concepts ?? null,
    }
  }
  const lastMonthName = monthLabel(h, window.previous.from)
  const lastMonthStart = window.previous.start.toISOString()

  return {
    g176: async () => {
      const year = today.year - 1
      const key = `${year}-12`
      const name = monthLabel(h, { year, month: 12 })
      const result = await h.fig("cobrado", "total", key)
      const bySede = await h.fig("cobrado", "sede", key)
      const before = await h.fig("cobrado", "total", `${year - 1}-12`)
      const span = await monthSpan({ year, month: 12 })
      const [charged] = await h.tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
        where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${span.start.toISOString()}::timestamptz and c.created_at < ${span.end.toISOString()}::timestamptz`)
      return {
        respuesta: `En ${name} entraron ${show(result)}: lo cobrado a los pacientes, sin lo anulado ni lo devuelto.`,
        criterio:
          "«Lo cobrado» de Reportes de diciembre del año pasado, mes completo: pagos menos lo anulado y lo devuelto, en la moneda de la clínica.",
        nota: `Por sede: ${rowsWords(bySede)}. En ${monthLabel(h, { year, month: 11 })} entraron ${show(result, result.previous?.value ?? null)} y en ${monthLabel(h, { year: year - 1, month: 12 })}, ${show(before)}. Si «entró» es lo cargado a los pacientes ese mes (pagado o no): ${money(Number(charged?.cents ?? 0))} en ${charged?.count ?? 0} conceptos.`,
        datos: {
          periodo: key,
          total: result.total,
          anterior: result.previous,
          porSede: bySede.rows,
          diciembreAnterior: before.total,
          cargado: charged,
        },
      }
    },

    g177: async () => {
      const branch = await branchNamed("san isidro")
      // Del 6 al 12 de octubre: el de este año si ya pasó; si no, el del año pasado.
      const year = `${today.year}-10-12` <= w.todayKey ? today.year : today.year - 1
      const from = `${year}-10-06`
      const to = `${year}-10-12`
      const span = { start: await startOf(from), end: await startOf(w.addDays(to, 1)) }
      const [clinic] = await appointmentTotalsMany(h.tx, h.org, { branch: null, now: h.now }, [
        span,
      ])
      if (!branch) {
        return {
          respuesta: `No hay una sede San Isidro registrada. En toda la clínica, ${spanWords(from, to)} de ${year}, hubo ${(clinic?.total ?? 0) - (clinic?.cancelled ?? 0)} citas sin contar las canceladas.`,
          criterio: "La sede no existe: se ofrecen las citas de toda la clínica esos días.",
          datos: { clinica: clinic },
        }
      }
      const [totals] = await appointmentTotalsMany(h.tx, h.org, { branch, now: h.now }, [span])
      const attended = await h.fig("atendidas", "sede", `${from}..${to}`)
      const kept = (totals?.total ?? 0) - (totals?.cancelled ?? 0)
      const unmarked = totals?.unmarked ?? 0
      return {
        respuesta: `${capital(spanWords(from, to))} de ${year}, en ${branch.name} hubo ${kept} citas sin contar las canceladas: ${totals?.attended ?? 0} atendidas y ${totals?.noShow ?? 0} a las que el paciente no vino${unmarked ? `, y ${unmarked} que pasaron sin marcar` : ""}. ${(totals?.cancelled ?? 0) === 0 ? "No se canceló ninguna." : (totals?.cancelled ?? 0) === 1 ? "Además se canceló 1." : `Además se cancelaron ${totals?.cancelled ?? 0}.`}`,
        criterio:
          "Citas de la sede con inicio en esos días (día de la clínica), por estado: la regla de Reportes › Agenda (atendidas, no vinieron, canceladas y las que pasaron sin marcar).",
        nota: `Contando también las canceladas: ${totals?.total ?? 0}. Si «hubo» son solo las atendidas: ${show(attended, rowOf(attended, /san isidro/i)?.value.value ?? totals?.attended ?? 0)} (la cifra «Citas atendidas» de Reportes). En toda la clínica esos días: ${(clinic?.total ?? 0) - (clinic?.cancelled ?? 0)} citas sin canceladas, ${clinic?.attended ?? 0} atendidas.`,
        datos: {
          sede: branch,
          desde: from,
          hasta: to,
          citas: totals,
          atendidasReportes: attended.rows,
          clinica: clinic,
        },
      }
    },

    g178: async () => {
      const result = await h.fig("pacientes_nuevos", "mes", "mes_pasado")
      const months = result.months.filter((month) => !month.partial && month.value.value !== null)
      const sorted = [...months].sort(
        (a, b) =>
          (a.value.value ?? 0) - (b.value.value ?? 0) ||
          a.month.year - b.month.year ||
          a.month.month - b.month.month,
      )
      const low = sorted[0]?.value.value ?? 0
      const worst = sorted.filter((month) => (month.value.value ?? 0) === low)
      const high = sorted.at(-1)
      const current = await h.fig("pacientes_nuevos")
      const first = months[0]
      const last = months.at(-1)
      const names = (list: typeof months) =>
        list.map((month) => monthLabel(h, month.month)).join(" y ")
      return {
        respuesta: worst.length
          ? `En los últimos 12 meses completos (${first ? monthLabel(h, first.month) : "—"} a ${last ? monthLabel(h, last.month) : "—"}), el peor mes en pacientes nuevos fue ${names(worst)}: ${low} pacientes nuevos (personas cuya primera cita atendida fue ese mes). Le siguen ${listOf(sorted.slice(worst.length, worst.length + 2).map((month) => ({ name: monthLabel(h, month.month), value: show(result, month.value.value) })))}.`
          : "No hay meses completos para comparar.",
        criterio:
          "«Pacientes nuevos» de Reportes por mes, los últimos 12 meses completos (el mes en curso, incompleto, no entra).",
        nota: `El mejor fue ${high ? `${monthLabel(h, high.month)} (${show(result, high.value.value)})` : "—"}. Mes a mes: ${listOf(months.map((month) => ({ name: monthLabel(h, month.month), value: show(result, month.value.value) })))}. ${capital(monthLabel(h, window.from))} va ${show(current)} hasta hoy (${days.current}).`,
        datos: {
          meses: result.months,
          peor: worst.map((month) => month.month),
          mesEnCurso: current.total,
        },
      }
    },

    g179: async () => {
      const year = lastFull(9)
      const weeks: Array<{ from: string; to: string; days: number }> = []
      let from = `${year}-09-01`
      for (let day = from; day <= `${year}-09-30`; day = w.addDays(day, 1)) {
        const sunday = new Date(`${day}T12:00:00Z`).getUTCDay() === 0
        if (sunday || day === `${year}-09-30`) {
          weeks.push({
            from,
            to: day,
            days:
              Math.round(
                (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS,
              ) + 1,
          })
          from = w.addDays(day, 1)
        }
      }
      const rows: Array<{
        from: string
        to: string
        days: number
        cents: number
        attended: number
      }> = []
      for (const week of weeks) {
        const collected = await h.fig("cobrado", "total", `${week.from}..${week.to}`)
        const attended = await h.fig("atendidas", "total", `${week.from}..${week.to}`)
        rows.push({
          ...week,
          cents: collected.total.value ?? 0,
          attended: attended.total.value ?? 0,
        })
      }
      const month = await h.fig("cobrado", "total", `${year}-09`)
      const full = rows.filter((row) => row.days === 7)
      const byCents = [...full].sort((a, b) => a.cents - b.cents || a.from.localeCompare(b.from))
      const byAttended = [...full].sort(
        (a, b) => a.attended - b.attended || a.from.localeCompare(b.from),
      )
      const byDaily = [...rows].sort(
        (a, b) => a.cents / a.days - b.cents / b.days || a.from.localeCompare(b.from),
      )
      const weekName = (row: (typeof rows)[number]) => spanWords(row.from, row.to)
      const short = (row: (typeof rows)[number]) => (row.days < 7 ? `, ${row.days} días` : "")
      const worst = byCents[0]
      const name = monthLabel(h, { year, month: 9 })
      return {
        respuesta: worst
          ? `Por lo cobrado, la semana completa más floja de ${name} fue la ${spanWords(worst.from, worst.to)}: ${money(worst.cents)}. Semana a semana (de lunes a domingo): ${listOf(rows.map((row) => ({ name: weekName(row), value: `${money(row.cents)}${short(row)}` })))}.`
          : `${capital(name)} no tiene semanas completas.`,
        criterio:
          "«Lo cobrado» de Reportes de cada semana de septiembre (lunes a domingo, día de la clínica), cortadas al mes; la más floja entre las de 7 días, porque las de los bordes tienen menos días.",
        nota: `Por citas atendidas, la semana completa más floja fue la ${byAttended[0] ? `${spanWords(byAttended[0].from, byAttended[0].to)} (${byAttended[0].attended} citas)` : "—"}; semana a semana: ${listOf(rows.map((row) => ({ name: weekName(row), value: `${row.attended}${short(row)}` })))}. Por lo cobrado por día, contando también las semanas incompletas, la más floja es la ${byDaily[0] ? `${weekName(byDaily[0])}: ${money(Math.round(byDaily[0].cents / byDaily[0].days))} por día` : "—"}. En todo ${name} se cobró ${show(month)}.`,
        datos: { semanas: rows, mes: month.total },
      }
    },

    g180: async () => {
      const yesterday = w.addDays(w.todayKey, -1)
      const before = w.addDays(yesterday, -7)
      const now = await h.fig("cobrado", "sede", `${yesterday}..${yesterday}`)
      const then = await h.fig("cobrado", "sede", `${before}..${before}`)
      const current = rowOf(now, /miraflores/i)
      const previous = rowOf(then, /miraflores/i)
      const value = current?.value.value ?? 0
      const prior = previous?.value.value ?? 0
      const name = current?.label ?? previous?.label ?? "Miraflores"
      const change =
        value === prior
          ? "lo mismo"
          : `${money(Math.abs(value - prior))} ${value > prior ? "más" : "menos"}${changePct(value, prior) ? ` (${changePct(value, prior)})` : ""}`
      return {
        respuesta: `${value > prior ? "Sí" : "No"}: ayer, ${w.dayWords(yesterday)}, ${name} cobró ${money(value)}; el ${w.dayWords(before)}, ${money(prior)}: ${change}.`,
        criterio:
          "«Lo cobrado» de Reportes de la sede, ayer contra el mismo día de la semana anterior (día de la clínica), pagos menos lo anulado y lo devuelto.",
        nota: `Toda la clínica: ayer ${show(now)}, el ${w.dayWords(before)} ${show(then)} (${signedMoney(h, (now.total.value ?? 0) - (then.total.value ?? 0))}). Las otras sedes ayer: ${listOf(now.rows.filter((row) => row !== current).map((row) => ({ name: row.label, value: show(now, row.value.value) })))}.`,
        datos: {
          ayer: yesterday,
          semanaPasada: before,
          sedeAyer: current ?? null,
          sedeAntes: previous ?? null,
          clinica: { ayer: now.total, antes: then.total },
        },
      }
    },

    g181: async () => {
      const result = await h.fig("no_vinieron")
      const bySede = await h.fig("no_vinieron", "sede")
      const byPro = await h.fig("no_vinieron", "profesional")
      const last = await h.fig("no_vinieron", "total", "mes_pasado")
      const week = await bookedIn(h.now, new Date(h.now.getTime() + 7 * DAY_MS))
      return {
        respuesta: `Qué hacer es un consejo que odentIA no da. Lo registrado: ${days.current} no vino el ${show(result)} de las citas que ya pasaron (${ofWords(result.total)}); ${days.previous}, el ${show(result, result.previous?.value ?? null)} (${ofWords(result.previous)}).`,
        criterio:
          "Trampa: es un consejo. Se ofrece «No vinieron» de Reportes (citas a las que el paciente no vino ÷ citas que ya pasaron) del mes en curso contra los mismos días del mes anterior, por sede y por profesional.",
        nota: `Por sede: ${rowsWords(bySede, (row) => `, ${ofWords(row.value)}`)}. Por profesional: ${rowsWords(byPro, (row) => `, ${ofWords(row.value)}`)}. En ${lastMonthName} completo: ${show(last)} (${ofWords(last.total)}). ${week.total ? `En los próximos 7 días hay ${week.total} citas agendadas, ${week.total - week.confirmed} sin confirmar.` : "En los próximos 7 días no hay citas agendadas."}`,
        datos: {
          mes: result.total,
          anterior: result.previous,
          porSede: bySede.rows,
          porProfesional: byPro.rows,
          mesPasado: last.total,
          proximos7Dias: week,
        },
      }
    },

    g182: async () => {
      const month = await h.fig("cobrado", "sede")
      const year = await h.fig("cobrado", "sede", w.lastYear)
      const attended = await h.fig("atendidas", "sede")
      const surco = rowOf(month, /surco/i)
      const miraflores = rowOf(month, /miraflores/i)
      const branch = await branchNamed("surco")
      const activity = branch ? await branchActivity(branch.id) : null
      const empty = activity !== null && activity.appointments === 0 && activity.payments === 0
      const surcoCents = surco?.value.value ?? 0
      const mirafloresCents = miraflores?.value.value ?? 0
      return {
        respuesta: !branch
          ? `No hay una sede Surco registrada: las sedes son ${listOf(month.rows.map((row) => ({ name: row.label, value: show(month, row.value.value) })))} este mes.`
          : `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Lo registrado ${thisMonth}: ${branch.name} cobró ${money(surcoCents)} y ${miraflores?.label ?? "Miraflores"}, ${money(mirafloresCents)}.${empty ? ` En ${branch.name} no hay ninguna cita, ningún cobro ni horarios de profesionales registrados: no tiene ventas que comparar.` : surcoCents < mirafloresCents ? ` La diferencia es de ${money(mirafloresCents - surcoCents)}.` : ` Este mes ${branch.name} no vende menos.`}`,
        criterio:
          "Trampa: odentIA no sabe causas. Se ofrece «Lo cobrado» de Reportes por sede del mes en curso, y lo registrado en la sede (citas, cobros y horarios).",
        nota: `En los últimos 365 días, por sede: ${rowsWords(year)}. Citas atendidas este mes por sede: ${rowsWords(attended)}.${activity ? ` En ${branch?.name}: ${activity.appointments} citas, ${activity.payments} cobros, ${activity.schedules} horarios y ${activity.expenses} gastos registrados desde siempre.` : ""}`,
        datos: {
          mes: month.rows,
          año: year.rows,
          atendidas: attended.rows,
          sede: branch,
          actividad: activity,
        },
      }
    },

    g183: async () => {
      const year = today.year
      const december = { year, month: 12 }
      const span = await monthSpan(december)
      const booked = await bookedIn(span.start, span.end)
      const coming = await upcomingWork(h.tx, h.org, h.scope.currency, h.now)
      const owed = await h.fig("te_deben")
      const lastDecember = await h.fig("cobrado", "total", `${year - 1}-12`)
      const months = await h.fig("cobrado", "mes", "mes_pasado")
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length
        ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length
        : 0
      return {
        respuesta: `No puedo decirte cuánto vas a cobrar: odentIA no predice el futuro. Lo ya registrado para ${monthLabel(h, december)}: ${booked.total ? `${booked.total} citas agendadas (${booked.confirmed} confirmadas)` : "ninguna cita agendada todavía"}, y lo aceptado en presupuestos que falta hacer vale ${money(coming.cents)} (${coming.patients} pacientes), sin fecha de cobro. Como referencia, en ${monthLabel(h, { year: year - 1, month: 12 })} se cobró ${show(lastDecember)}.`,
        criterio:
          "Trampa: es una predicción. Se ofrecen las citas programadas o confirmadas de diciembre, «Lo que viene» de Reportes (lo aceptado sin hacer, a hoy) y lo cobrado en diciembre del año pasado.",
        nota: `Lo cobrado en los últimos 3 meses completos: ${listOf(recent.map((month) => ({ name: monthLabel(h, month.month), value: show(months, month.value.value) })))} (promedio ${money(Math.round(average))} al mes). Hoy te deben ${show(owed)} (${owed.total.part ?? 0} personas).`,
        datos: {
          diciembre: monthKey(december),
          citas: booked,
          loQueViene: coming,
          teDeben: owed.total,
          diciembrePasado: lastDecember.total,
          ultimos3: recent,
        },
      }
    },

    g184: async () => {
      const branch = await branchNamed("san isidro")
      const occupied = await h.fig("agenda_ocupada", "sede")
      const free = await h.fig("horas_libres", "sede")
      const last = await h.fig("agenda_ocupada", "sede", "mes_pasado")
      if (!branch) {
        return {
          respuesta: `No hay una sede San Isidro registrada. Agenda ocupada ${thisMonth} por sede: ${rowsWords(occupied)}.`,
          criterio:
            "Trampa: es un consejo y la sede no existe. Se ofrece «Agenda ocupada» de Reportes por sede.",
          datos: { ocupada: occupied.rows },
        }
      }
      const people = await figIn("agenda_ocupada", "profesional", "este_mes", branch.id)
      const peopleFree = await figIn("horas_libres", "profesional", "este_mes", branch.id)
      const noShow = await figIn("no_vinieron", "total", "este_mes", branch.id)
      const own = rowOf(occupied, /san isidro/i)
      const ownFree = rowOf(free, /san isidro/i)
      const others = occupied.rows.filter((row) => row !== own && row.value.value !== null)
      const staff =
        people.rows.length === 1
          ? `con un solo profesional con horario, ${people.rows[0]?.label}`
          : `con ${people.rows.length} profesionales con horario: ${listOf(people.rows.map((row) => ({ name: row.label, value: show(people, row.value.value) })))}`
      return {
        respuesta: `Si te conviene contratar es una decisión tuya; odentIA no da consejos. Lo registrado ${thisMonth}: la agenda de ${branch.name} está ocupada al ${show(occupied, own?.value.value ?? null)} y le quedaron ${show(free, ownFree?.value.value ?? null)} libres, ${staff}.${others.length ? ` La de ${others.map((row) => `${row.label} está al ${show(occupied, row.value.value)}`).join("; la de ")}.` : ""}`,
        criterio:
          "Trampa: es un consejo. Se ofrece «Agenda ocupada» y «Horas libres» de Reportes de la sede del mes en curso (minutos con cita ÷ minutos del horario), por profesional, y la de las otras sedes.",
        nota: `Horas libres por profesional en ${branch.name}: ${rowsWords(peopleFree)}. En ${lastMonthName} completo, agenda ocupada por sede: ${rowsWords(last)}. No vino el ${show(noShow)} de las citas de ${branch.name} que ya pasaron este mes (${ofWords(noShow.total)}).`,
        datos: {
          sede: branch,
          ocupada: occupied.rows,
          libres: free.rows,
          porProfesional: people.rows,
          libresPorProfesional: peopleFree.rows,
          mesPasado: last.rows,
          noVinieron: noShow.total,
        },
      }
    },

    g185: async () => {
      const keys = [
        "cobrado",
        "lo_que_deja",
        "pacientes_nuevos",
        "atendidas",
        "no_vinieron",
        "canceladas",
        "aceptaron",
        "agenda_ocupada",
        "controles",
        "deuda_vencida",
        "te_deben",
      ]
      const results = await Promise.all(keys.map((key) => h.fig(key)))
      // La misma cuenta de s3: un porcentaje se mide en puntos; lo demás, en proporción.
      const rows = results.map((result) => {
        const value = result.total.value ?? 0
        const before = result.previous?.value ?? 0
        const worse = result.figure.better === "up" ? value < before : value > before
        const size =
          result.figure.unit === "rate"
            ? Math.abs(value - before) / 100
            : before !== 0
              ? Math.abs(value - before) / Math.abs(before)
              : value !== 0
                ? 1
                : 0
        const change =
          result.figure.unit === "rate"
            ? `${value - before > 0 ? "+" : "−"}${Math.abs(value - before)} puntos`
            : (changePct(value, before) ??
              (result.figure.unit === "money"
                ? signedMoney(h, value - before)
                : `${value - before > 0 ? "+" : ""}${value - before}`))
        return {
          name: result.figure.name,
          value: show(result, value),
          before: show(result, before),
          change,
          worse,
          size,
        }
      })
      const worse = rows.filter((row) => row.worse).sort((a, b) => b.size - a.size)
      const top = worse[0]
      const lapsed = await h.fig("sin_venir")
      const describe = (row: (typeof rows)[number]) =>
        `${row.value} contra ${row.before}, ${row.change}`
      return {
        respuesta: top
          ? `Qué arreglar es un juicio tuyo; odentIA no lo decide. Lo más cercano: la cifra de Reportes que más empeoró ${days.current} frente a ${days.sameAs} es «${top.name}»: ${describe(top)}.`
          : `Qué arreglar es un juicio tuyo; odentIA no lo decide. Ninguna cifra de Reportes empeoró ${days.current} frente a ${days.sameAs}.`,
        criterio:
          "Trampa: es una opinión. Se ofrece la cifra de Reportes que más empeoró contra los mismos días del mes anterior, con la cuenta de s3 (en proporción el dinero y los conteos, en puntos los porcentajes).",
        nota: `Las que siguen: ${listOf(worse.slice(1, 4).map((row) => ({ name: row.name, value: describe(row) }))) || "ninguna"}. Lo pendiente a hoy: ${show(lapsed)} pacientes llevan más de 6 meses sin venir.`,
        datos: { cifras: rows, sinVenir: lapsed.total },
      }
    },

    g186: async () => {
      const services = await doneSince(
        sql`(s.name ilike '%limpieza%' or s.name ilike '%profilaxis%')`,
        yearAgoIso,
      )
      const main = services[0]
      if (!main) {
        return {
          respuesta:
            "Subir el precio es una decisión tuya; odentIA no da consejos. Además, no hay ningún servicio de limpieza en tu lista de precios.",
          criterio: "Trampa: es un consejo y el servicio no existe.",
          datos: {},
        }
      }
      const [charged] = await h.tx.execute<{ count: number; average: number | null }>(sql`
        select count(*)::int as count, avg(c.amount_cents::float / greatest(coalesce(ep.quantity, 1), 1))::float as average
        from patient_charge c ${h.conceptJoins}
        where c.organization_id = ${h.org} and c.voided_at is null and c.product_id is null and c.currency = ${h.scope.currency}
          and coalesce(sep.id, spi.id) = ${main.id} and c.created_at >= ${yearAgoIso}::timestamptz and c.created_at < ${nowIso}::timestamptz`)
      const collected = await h.fig("cobrado", "tratamiento")
      const paid = collected.rows.find((row) => row.label === main.name)
      const budgets = (await quoted(yearAgoIso)).find((row) => row.id === main.id)
      const promos = await h.tx.execute<{
        name: string
        starts: string | null
        ends: string | null
      }>(sql`
        select name, starts_at::text as starts, ends_at::text as ends from promotion
        where organization_id = ${h.org} and is_active and (name ilike '%limpieza%' or name ilike '%profilaxis%') order by starts_at`)
      const otherServices = services.slice(1)
      return {
        respuesta: `Subir el precio es una decisión tuya; odentIA no da consejos ni sabe cómo responderían tus pacientes. Lo registrado: la ${main.name} cuesta ${money(main.price)} en tu lista de precios; en los últimos 12 meses se hizo ${main.times.toLocaleString(h.scope.locale)} veces y se cargó en promedio ${money(Math.round(charged?.average ?? 0))} por vez; ${thisMonth} van ${main.month}.`,
        criterio:
          "Trampa: es un consejo. Se ofrece el precio de lista de la limpieza que se usa, las veces que se hizo (atenciones firmadas) y lo cargado en promedio por vez en los últimos 365 días.",
        nota: `Lo cobrado de limpiezas este mes (Reportes): ${show(collected, paid?.value.value ?? 0)}. En los presupuestos entregados de los últimos 12 meses se cotizó ${budgets?.lines ?? 0} veces y se aceptó ${budgets?.accepted ?? 0} (${pct(budgets?.accepted ?? 0, budgets?.lines ?? 0)}). Promociones con limpieza: ${listOf(promos.map((row) => ({ name: row.name, value: `${row.starts ? `desde el ${dateWords(row.starts)}` : "sin inicio"}${row.ends ? ` hasta el ${dateWords(new Date(new Date(row.ends).getTime() - 1))}` : ""}` }))) || "ninguna"}.${otherServices.length ? ` También están en tu lista ${listOf(otherServices.map((row) => ({ name: row.name, value: `${money(row.price)}, ${row.times} veces en 12 meses` })))}.` : ""}`,
        datos: {
          servicios: services,
          cargado: charged,
          cobradoMes: paid ?? null,
          presupuestos: budgets ?? null,
          promociones: promos,
        },
      }
    },

    g187: async () => {
      const implants = await doneSince(sql`s.name ilike '%implant%'`, "-infinity")
      const [ever] = await h.tx.execute<{ lines: number; accepted: number }>(sql`
        select count(*)::int as lines, count(*) filter (where b.status in ('aceptado','parcial') and i.decision = 'aceptado')::int as accepted
        from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id and i.option_id = ${budgetValueOptionSql(budgetRef)}
        left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
        where b.organization_id = ${h.org} and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
          and coalesce(s.name, i.title) ilike '%implant%'`)
      const year = await quoted(yearAgoIso)
      const lines = year.reduce((sum, row) => sum + row.lines, 0)
      const accepted = year.reduce((sum, row) => sum + row.accepted, 0)
      const lowest = year
        .filter((row) => row.lines >= 3)
        .sort((a, b) => a.accepted / a.lines - b.accepted / b.lines || b.lines - a.lines)
      const [notes] = await h.tx.execute<{ rejected: number; noted: number }>(sql`
        select count(*)::int as rejected, count(*) filter (where b.decision_note is not null)::int as noted from treatment_budget b
        where b.organization_id = ${h.org} and b.status = 'rechazado' and b.presented_at >= ${yearAgoIso}::timestamptz`)
      const main = implants.sort((a, b) => b.price - a.price)[0]
      const none = (ever?.lines ?? 0) === 0
      const words = (list: ReadonlyArray<(typeof year)[number]>) =>
        listOf(
          list
            .slice(0, 3)
            .map((row) => ({
              name: row.name,
              value: `${pct(row.accepted, row.lines)}, ${row.accepted} de ${row.lines}`,
            })),
        )
      return {
        respuesta: none
          ? `No sé por qué: odentIA registra lo que responden, no sus motivos. Y no hay presupuestos de implantes: ningún presupuesto entregado incluye un implante${main ? ` (en tu lista está «${main.name}» a ${money(main.price)}, pero nunca se cotizó)` : ""}. Lo más cercano: en los últimos 12 meses se aceptó el ${pct(accepted, lines)} de los tratamientos cotizados (${accepted} de ${lines}); los que menos se aceptan son ${words(lowest)}.`
          : `No sé por qué: odentIA registra lo que responden, no sus motivos. Lo registrado: de ${ever?.lines ?? 0} implantes cotizados en presupuestos entregados se aceptaron ${ever?.accepted ?? 0} (${pct(ever?.accepted ?? 0, ever?.lines ?? 0)}); en toda la clínica, en los últimos 12 meses, el ${pct(accepted, lines)}.`,
        criterio:
          "Trampa: odentIA no sabe causas, y no hay implantes en los presupuestos. Se ofrece la aceptación de los tratamientos de la opción que vale en los presupuestos entregados de los últimos 365 días, a hoy (como b5).",
        nota: `Presupuestos rechazados en los últimos 12 meses: ${notes?.rejected ?? 0}; ${notes?.noted ?? 0} con una nota de la respuesta (texto libre, no un motivo de una lista).${implants.length ? ` Servicios con implante en tu lista: ${listOf(implants.map((row) => ({ name: row.name, value: `${money(row.price)}, ${row.times} hechos` })))}.` : ""}`,
        datos: {
          implantesCotizados: ever,
          doceMeses: year,
          rechazados: notes,
          servicios: implants,
        },
      }
    },

    g188: async () => {
      const months = await h.fig("pacientes_nuevos", "mes", "mes_pasado")
      const recent = months.months.filter((month) => !month.partial).slice(-3)
      const average = recent.length
        ? recent.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / recent.length
        : 0
      const year = months.months.filter((month) => !month.partial)
      const yearAverage = year.length
        ? year.reduce((sum, month) => sum + (month.value.value ?? 0), 0) / year.length
        : 0
      const current = await h.fig("pacientes_nuevos")
      const next = nextMonth(today)
      const nextSpan = await monthSpan(next)
      const booked = await bookedIn(nextSpan.start, nextSpan.end)
      const words = (value: number) =>
        value.toLocaleString(h.scope.locale, { maximumFractionDigits: 1 })
      return {
        respuesta: `No puedo predecirlo: odentIA no proyecta el futuro. Como referencia, en los últimos 3 meses completos llegaron ${listOf(recent.map((month) => ({ name: monthLabel(h, month.month), value: show(months, month.value.value) })))} pacientes nuevos (${words(average)} al mes en promedio); ${days.current} van ${show(current)}, contra ${show(current, current.previous?.value ?? null)} ${days.previous}.`,
        criterio:
          "Trampa: es una predicción. Se ofrecen «Pacientes nuevos» de Reportes de los últimos 3 meses completos y del mes en curso contra los mismos días del anterior.",
        nota: `${booked.total ? `Lo ya agendado para ${monthLabel(h, next)}: ${booked.first} citas de personas que aún no tienen una cita atendida (su primera visita), de ${booked.total} citas agendadas.` : `Para ${monthLabel(h, next)} todavía no hay citas agendadas.`} En los últimos 12 meses completos el promedio fue ${words(yearAverage)} pacientes nuevos al mes.`,
        datos: {
          ultimos3: recent,
          mes: current.total,
          anterior: current.previous,
          proximoMes: { mes: monthKey(next), ...booked },
          promedio12: yearAverage,
        },
      }
    },

    g189: async () => {
      const promos = await h.tx.execute<{
        id: string
        name: string
        from: string | null
        to: string | null
        ended: boolean
        active: boolean
      }>(sql`
        select id, name, to_char((starts_at at time zone ${h.tz})::date, 'YYYY-MM-DD') as from,
          to_char(((ends_at - interval '1 second') at time zone ${h.tz})::date, 'YYYY-MM-DD') as to,
          coalesce(ends_at <= now(), false) as ended, is_active as active
        from promotion where organization_id = ${h.org} and name ilike '%blanque%' order by starts_at desc nulls last`)
      const promo = promos[0]
      if (!promo) {
        const all = await h.tx.execute<{ name: string }>(
          sql`select name from promotion where organization_id = ${h.org} and is_active and (ends_at is null or ends_at > now()) order by name`,
        )
        return {
          respuesta: `Si vale la pena es una decisión tuya; odentIA no la juzga. Además, no hay ninguna promoción de blanqueamiento registrada; las vigentes son ${all.map((row) => row.name).join(", ") || "ninguna"}.`,
          criterio:
            "Trampa: es un juicio y la promoción no existe. Se ofrecen las promociones vigentes.",
          datos: { vigentes: all },
        }
      }
      const from = promo.from ?? w.todayKey
      const to = promo.to && promo.to < w.todayKey ? promo.to : w.todayKey
      const report = await getReportPromotions(h.tx, h.org, { period: `${from}..${to}` }, h.now)
      const row = report.promotions.find((item) => item.promotionId === promo.id)
      const span = {
        start: await startOf(from),
        end: to === w.todayKey ? h.now : await startOf(w.addDays(to, 1)),
      }
      const length = span.end.getTime() - span.start.getTime()
      const [done] = await h.tx.execute<{ during: number; before: number }>(sql`
        select coalesce(sum(ep.quantity) filter (where e.finalized_at >= ${span.start.toISOString()}::timestamptz and e.finalized_at < ${span.end.toISOString()}::timestamptz), 0)::int as during,
          coalesce(sum(ep.quantity) filter (where e.finalized_at >= ${new Date(span.start.getTime() - length).toISOString()}::timestamptz and e.finalized_at < ${span.start.toISOString()}::timestamptz), 0)::int as before
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${h.org} and ep.voided_at is null and s.name ilike '%blanque%'`)
      const verdict = !row
        ? "nadie la usó"
        : row.verdict === "solo_bajo_precio"
          ? "Reportes la marca como «Solo bajó el precio»: quienes la usaron ya eran pacientes y nadie volvió por otro tratamiento"
          : row.verdict === "trajo_nuevos"
            ? `Reportes la marca como «Trajo pacientes nuevos»${row.returned ? `, y ${row.returned} volvieron por más` : ""}`
            : `Reportes la marca como «${row.returned} volvieron por más»`
      const runWords = `${promo.from ? `del ${dateWords(`${promo.from}T12:00:00Z`)}` : ""}${promo.to ? ` al ${dateWords(`${promo.to}T12:00:00Z`)}` : " sin fecha de fin"}`
      return {
        respuesta: `Si vale la pena es una decisión tuya; odentIA no la juzga. ${promo.ended ? `Además, «${promo.name}» ya terminó: fue ${runWords}.` : `«${promo.name}» sigue vigente (${runWords}).`} Mientras duró, la usaron ${row?.people ?? 0} personas (${row?.fresh ?? 0} nuevas), ${row?.accepted ?? 0} aceptaron el tratamiento, se dejó de cobrar ${money(row?.discountCents ?? 0)} y quienes la usaron pagaron ${money(row?.collectedCents ?? 0)} desde entonces; ${verdict}.`,
        criterio:
          "Trampa: es un juicio. Se ofrece la promoción en Reportes › Finanzas › Promociones en los días que estuvo vigente: quiénes la usaron, cuántos eran nuevos, lo aceptado, el descuento, lo que pagaron desde entonces y su lectura.",
        nota: `Blanqueamientos hechos (atenciones firmadas) mientras duró: ${done?.during ?? 0}; en los mismos días justo antes: ${done?.before ?? 0}. Pagaron algo ${row?.paidSome ?? 0} de los ${row?.people ?? 0} que la usaron.`,
        datos: { promocion: promo, reportes: row ?? null, blanqueamientos: done },
      }
    },

    g190: async () => {
      const sundays = await h.tx.execute<{ branch: string; person: string; since: string }>(sql`
        select b.name as branch, u.name as person, min(s.valid_from)::text as since from professional_schedule s
        join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
        join "user" u on u.id = s.professional_user_id
        where s.organization_id = ${h.org} and s.is_active and s.valid_until is null and s.weekday = 0
        group by 1, 2 order by 1, 2`)
      const byDay = await h.tx.execute<{ dow: number; total: number }>(sql`
        select extract(dow from a.starts_at at time zone ${h.tz})::int as dow, count(*)::int as total from appointment a
        where a.organization_id = ${h.org} and a.status <> 'cancelada'
          and a.starts_at >= ${yearAgoIso}::timestamptz and a.starts_at < ${nowIso}::timestamptz
        group by 1 order by 1`)
      const messages = await h.tx.execute<{ dow: number; total: number }>(sql`
        select extract(dow from m.created_at at time zone ${h.tz})::int as dow, count(*)::int as total from message m
        where m.organization_id = ${h.org} and m.direction = 'in' and m.created_at >= ${yearAgoIso}::timestamptz and m.created_at < ${nowIso}::timestamptz
        group by 1`)
      const report = await getAgendaReport(h.tx, h.org, { period: "este_mes" }, h.now)
      const occupancy = new Map<number, { avail: number; occ: number }>()
      for (const slot of report.map.week) {
        const entry = occupancy.get(slot.weekday) ?? { avail: 0, occ: 0 }
        entry.avail += slot.availMin
        entry.occ += slot.occMin
        occupancy.set(slot.weekday, entry)
      }
      const count = (dow: number) => byDay.find((row) => row.dow === dow)?.total ?? 0
      const worked = byDay.filter((row) => row.total > 0).sort((a, b) => a.total - b.total)
      const fewest = worked[0]
      const most = worked.at(-1)
      const sunday = count(0)
      const inbound = messages.reduce((sum, row) => sum + row.total, 0)
      const sundayMessages = messages.find((row) => row.dow === 0)?.total ?? 0
      const people = [...new Set(sundays.map((row) => row.person))]
      const branches = [...new Set(sundays.map((row) => row.branch))]
      const since = sundays.map((row) => row.since).sort()[0]
      return {
        respuesta: `Si conviene abrir los domingos es una decisión tuya; odentIA no da consejos. Lo registrado: en los últimos 12 meses ${sunday === 0 ? "no hubo ninguna cita en domingo" : `hubo ${sunday} citas en domingo`}${sundays.length ? `; desde el ${dateWords(`${since}T12:00:00Z`)}, el horario de ${branches.join(" y ")} incluye el domingo (${people.join(" y ")})` : " y ningún profesional tiene horario ese día"}. Por día, las citas sin cancelar de esos 12 meses van de ${fewest ? `${fewest.total} el ${WEEKDAYS[fewest.dow]}` : "—"} a ${most ? `${most.total} el ${WEEKDAYS[most.dow]}` : "—"}.`,
        criterio:
          "Trampa: es un consejo. Se ofrecen las citas sin cancelar de los últimos 365 días por día de la semana (día de la clínica) y los horarios vigentes con domingo.",
        nota: `Citas sin cancelar por día en los últimos 12 meses: ${listOf(worked.map((row) => ({ name: WEEKDAYS[row.dow] ?? "", value: `${row.total}` })))}. Agenda ocupada este mes por día de la semana (Reportes › Agenda): ${listOf(
          [...occupancy.entries()]
            .filter(([, entry]) => entry.avail > 0)
            .sort((a, b) => ((a[0] + 6) % 7) - ((b[0] + 6) % 7))
            .map(([dow, entry]) => ({
              name: WEEKDAYS[dow] ?? "",
              value: pct(entry.occ, entry.avail),
            })),
        )}. De los mensajes que escribieron las personas en esos 12 meses, ${sundayMessages} de ${inbound} llegaron un domingo (${pct(sundayMessages, inbound)}).`,
        datos: {
          horariosDomingo: sundays,
          citasPorDia: byDay,
          ocupacion: [...occupancy.entries()],
          mensajes: messages,
        },
      }
    },

    g191: async () => {
      const crowns = await doneSince(
        sql`s.name ilike '%corona%' and s.name not ilike '%alargamiento%'`,
        yearAgoIso,
      )
      const main = crowns[0]
      const [lastDone] = await h.tx.execute<{ times: number }>(sql`
        select coalesce(sum(ep.quantity), 0)::int as times from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${h.org} and ep.voided_at is null and s.name ilike '%corona%' and s.name not ilike '%alargamiento%'
          and e.finalized_at >= ${lastMonthStart}::timestamptz and e.finalized_at < ${h.monthStart}::timestamptz`)
      const lab = await expensesOf("Laboratorio", lastMonthStart, h.monthStart)
      const materials = await expensesOf("Materiales", lastMonthStart, h.monthStart)
      const labYear = await expensesOf("Laboratorio", yearAgoIso, nowIso)
      const yearTimes = crowns.reduce((sum, row) => sum + row.times, 0)
      return {
        respuesta: `No lo sé: odentIA no tiene lo que cuesta cada tratamiento. El laboratorio se registra como un gasto del mes, sin ligarlo a cada corona, y los materiales se descuentan por atención y el lote no guarda lo que costó. Lo más cercano: en ${lastMonthName} se registraron ${money(lab.cents)} en gastos de Laboratorio${lab.concepts ? ` («${lab.concepts}»)` : ""} y ${money(materials.cents)} en Materiales, y se hicieron ${lastDone?.times ?? 0} coronas${main ? `; la ${main.name} cuesta ${money(main.price)} en tu lista` : ""}.`,
        criterio:
          "Trampa: sin costo por tratamiento. Se ofrecen los gastos registrados de Laboratorio y Materiales del último mes completo y las coronas hechas ese mes (atenciones firmadas), sin dividir uno entre otro.",
        nota: `En los últimos 365 días: ${money(labYear.cents)} en gastos de Laboratorio (${labYear.count} gastos) y ${yearTimes} coronas hechas (${listOf(crowns.filter((row) => row.times > 0).map((row) => ({ name: row.name, value: `${row.times}` })))}). El gasto de laboratorio junta coronas y prótesis.`,
        datos: {
          coronas: crowns,
          mesPasado: { hechas: lastDone?.times ?? 0, laboratorio: lab, materiales: materials },
          doceMeses: { laboratorio: labYear, hechas: yearTimes },
        },
      }
    },

    g192: async () => {
      const year = lastFull(9)
      const key = `${year}-09`
      const span = await monthSpan({ year, month: 9 })
      const [row] = await h.tx.execute<{
        tickets: number
        cents: string
        payments: number
        loose: number
      }>(sql`
        select (select count(*) from payment_ticket t where t.organization_id = ${h.org} and t.voided_at is null
            and t.created_at >= ${span.start.toISOString()}::timestamptz and t.created_at < ${span.end.toISOString()}::timestamptz)::int as tickets,
          (select coalesce(sum(t.total_cents), 0) from payment_ticket t where t.organization_id = ${h.org} and t.voided_at is null
            and t.created_at >= ${span.start.toISOString()}::timestamptz and t.created_at < ${span.end.toISOString()}::timestamptz)::text as cents,
          (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.voided_at is null
            and p.paid_at >= ${span.start.toISOString()}::timestamptz and p.paid_at < ${span.end.toISOString()}::timestamptz)::int as payments,
          (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.voided_at is null and p.ticket_id is null
            and p.paid_at >= ${span.start.toISOString()}::timestamptz and p.paid_at < ${span.end.toISOString()}::timestamptz)::int as loose`)
      const collected = await h.fig("cobrado", "total", key)
      const name = monthLabel(h, { year, month: 9 })
      const tickets = row?.tickets ?? 0
      return {
        respuesta: `${NO_INVOICES}. En ${name} ${tickets === 0 ? "no se emitió ningún ticket de pago" : `se emitieron ${tickets} tickets de pago por ${money(Number(row?.cents ?? 0))}`}; lo cobrado del mes, sin lo anulado ni lo devuelto, fue ${show(collected)} en ${row?.payments ?? 0} pagos.`,
        criterio:
          "Trampa: odentIA no emite boletas ni facturas. Se ofrecen los tickets de pago de septiembre y «Lo cobrado» de Reportes del mes.",
        nota: `${row?.loose ?? 0} de los ${row?.payments ?? 0} pagos de ${name} no tienen ticket: la historia de prueba los guarda sin él. Contar tickets da otra cifra; contar lo cobrado, no.`,
        datos: { mes: key, tickets: row, cobrado: collected.total },
      }
    },

    g193: async () => {
      const collected = await h.fig("cobrado")
      const spent = await h.fig("gastos", "categoria")
      const taxes = rowOf(spent, /impuesto/i)
      const [last] = await h.tx.execute<{ concept: string; at: string; cents: number }>(sql`
        select e.concept, e.spent_at::text as at, e.amount_cents as cents from expense e
        where e.organization_id = ${h.org} and e.voided_at is null and e.category = 'Impuestos' and e.spent_at < ${nowIso}::timestamptz
        order by e.spent_at desc limit 1`)
      return {
        respuesta: `odentIA no calcula impuestos ni emite comprobantes (solo tickets de pago), así que no sé cuánto IGV te toca pagar. Lo registrado ${thisMonth}: cobraste ${show(collected)}${taxes ? ` y registraste ${show(spent, taxes.value.value)} en gastos de tipo Impuestos` : " y no hay gastos de tipo Impuestos registrados"}${last ? `; el último fue «${last.concept}», el ${dateWords(last.at)}, por ${money(last.cents)}` : ""}.`,
        criterio:
          "Trampa: sin cálculo de impuestos ni comprobantes. Se ofrecen «Lo cobrado» de Reportes del mes y los gastos registrados de tipo Impuestos (el último, si este mes no hay).",
        nota: `Gastos registrados este mes por tipo: ${rowsWords(spent) || "ninguno"} (${show(spent)} en total).`,
        datos: { cobrado: collected.total, gastos: spent.rows, ultimoImpuesto: last ?? null },
      }
    },

    g194: async () => {
      const scope = await reportScope(h.tx, h.org, { period: "este_ano" }, h.now)
      const [funnel] = await funnelMany(h.tx, h.org, [scope.window], h.now)
      const channel = (key: string) => funnel?.channels.find((row) => row.channel === key)
      const instagram = channel("instagram")
      const messenger = channel("messenger")
      const referral = await h.fig("como_nos_conocieron", "como_nos_conocio", "este_ano")
      const social = referral.rows.find((row) => row.key === "redes_sociales")
      const spent = await h.fig("gastos", "categoria", "este_ano")
      const [ads] = await h.tx.execute<{ count: number }>(sql`
        select count(*)::int as count from expense e where e.organization_id = ${h.org} and e.voided_at is null
          and e.spent_at >= ${scope.window.start.toISOString()}::timestamptz
          and (e.concept ilike '%publicidad%' or e.concept ilike '%facebook%' or e.concept ilike '%instagram%' or e.concept ilike '%anuncio%' or e.concept ilike '%marketing%')`)
      const year = today.year
      return {
        respuesta: `No lo sé: odentIA no registra lo que gastas en publicidad${(ads?.count ?? 0) === 0 ? ", y entre los gastos registrados de este año no hay ninguno de publicidad" : ""}. Lo más cercano: en lo que va de ${year}, ${instagram?.sought ?? 0} personas nos escribieron por primera vez por Instagram (${instagram?.came ?? 0} ya vinieron) y ${messenger?.sought ?? 0} por Messenger (${messenger?.came ?? 0} vinieron); ${social?.value.value ?? 0} pacientes nuevos dijeron que nos conocieron por redes sociales.`,
        criterio:
          "Trampa: sin gasto en publicidad. Se ofrecen el embudo de Reportes del año por canal (Instagram y Messenger) y «Cómo nos conocieron» = Redes sociales, y se mira que ningún gasto registrado sea de publicidad.",
        nota: `Gastos registrados en ${year} por tipo: ${rowsWords(spent)}. Gastos con «publicidad», «Facebook», «Instagram», «anuncio» o «marketing» en el concepto: ${ads?.count ?? 0}.`,
        datos: {
          instagram: instagram ?? null,
          messenger: messenger ?? null,
          redesSociales: social ?? null,
          gastos: spent.rows,
          gastosDePublicidad: ads?.count ?? 0,
        },
      }
    },

    g195: async () => {
      const branch = await branchNamed("surco")
      const activity = branch ? await branchActivity(branch.id) : null
      const returned = await h.fig("volvieron", "sede")
      const own = rowOf(returned, /surco/i)
      const others = returned.rows.filter((row) => row !== own && (row.value.whole ?? 0) > 0)
      return {
        respuesta: `odentIA no tiene encuestas de satisfacción, así que no sé qué tan satisfechos quedan.${activity && activity.appointments === 0 ? ` Además, en ${branch?.name} no hay ninguna cita ni atención registrada.` : ""} Lo más cercano es si vuelven («Volvieron en el año» de Reportes): ${own && (own.value.whole ?? 0) > 0 ? `${own.label}, ${show(returned, own.value.value)} (${ofWords(own.value)}); ` : ""}${listOf(others.map((row) => ({ name: row.label, value: `${show(returned, row.value.value)}, ${ofWords(row.value)}` })))}.`,
        criterio:
          "Trampa: no hay encuestas ni NPS. Se ofrece «Volvieron en el año» de Reportes por sede (de los atendidos hace 12 a 24 meses, cuántos volvieron en los últimos 12) y lo registrado en la sede.",
        nota: `Toda la clínica: ${show(returned)} (${ofWords(returned.total)}).${activity ? ` En ${branch?.name}: ${activity.appointments} citas, ${activity.payments} cobros y ${activity.schedules} horarios registrados.` : " No hay una sede Surco registrada."}`,
        datos: {
          sede: branch,
          actividad: activity,
          volvieron: returned.rows,
          clinica: returned.total,
        },
      }
    },

    g196: async () => {
      const lab = await expensesOf("Laboratorio", h.monthStart, nowIso)
      const lastLab = await expensesOf("Laboratorio", lastMonthStart, h.monthStart)
      const owed = await h.fig("lo_que_debes")
      const [orders] = await h.tx.execute<{ month: number; open: number }>(sql`
        select count(*) filter (where o.created_at >= ${h.monthStart}::timestamptz)::int as month,
          count(*) filter (where o.status in ('solicitado','en_proceso'))::int as open
        from clinical_order o where o.organization_id = ${h.org} and o.kind = 'laboratorio'`)
      return {
        respuesta: `No lo sé: odentIA no registra lo que se le debe al laboratorio por cada trabajo; «Lo que debes» de Reportes solo junta comisiones por pagar y compras de Inventario sin pagar. Lo registrado ${thisMonth}: ${lab.count ? `${money(lab.cents)} en gastos de Laboratorio ya registrados` : "todavía no hay gastos de Laboratorio registrados"}${lastLab.count ? `; en ${lastMonthName} fueron ${money(lastLab.cents)}` : ""}.`,
        criterio:
          "Trampa: no hay cuentas por pagar al laboratorio. Se ofrecen los gastos registrados de tipo Laboratorio del mes en curso y del anterior.",
        nota: `«Lo que debes» de Reportes hoy (comisiones por pagar y compras de Inventario recibidas sin pagar): ${show(owed)}. Órdenes de laboratorio de este mes en las fichas: ${orders?.month ?? 0} (${orders?.open ?? 0} abiertas en total); no llevan importe.`,
        datos: {
          laboratorioMes: lab,
          laboratorioMesPasado: lastLab,
          loQueDebes: owed.total,
          ordenes: orders,
        },
      }
    },

    g197: async () => {
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const [partial] = await h.tx.execute<{ people: number; charges: number; cents: string }>(sql`
        with paid as (
          select a.charge_id, sum(a.amount_cents)::bigint as cents from patient_payment_application a
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where a.organization_id = ${h.org} and a.voided_at is null group by 1)
        select count(distinct c.patient_id)::int as people, count(*)::int as charges, coalesce(sum(c.amount_cents - p.cents), 0)::text as cents
        from patient_charge c join paid p on p.charge_id = c.id
        where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency} and p.cents > 0 and p.cents < c.amount_cents`)
      return {
        respuesta: `odentIA no maneja cuotas ni planes de financiamiento, así que no sé quién paga en cuotas ni cuáles están vencidas. Lo más cercano, a hoy: ${owed.total.part ?? 0} personas deben ${show(owed)}, y ${overdue.total.part ?? 0} de ellas deben ${show(overdue)} desde hace más de 30 días.`,
        criterio:
          "Trampa: no hay cuotas. Se ofrecen «Te deben» y «Te deben hace más de 30 días» de Reportes, a hoy.",
        nota: `Pacientes con un tratamiento o producto pagado en parte (con algún pago y saldo pendiente): ${partial?.people ?? 0}, en ${partial?.charges ?? 0} conceptos, con ${money(Number(partial?.cents ?? 0))} por pagar.`,
        datos: { teDeben: owed.total, vencido: overdue.total, pagadoEnParte: partial },
      }
    },

    g198: async () => {
      const implants = await doneSince(sql`s.name ilike '%implant%'`, "-infinity")
      const [quotedRow] = await h.tx.execute<{ lines: number }>(sql`
        select count(*)::int as lines from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
        where b.organization_id = ${h.org} and b.status <> 'borrador' and coalesce(s.name, i.title) ilike '%implant%'`)
      const main = [...implants].sort((a, b) => b.price - a.price)[0]
      return {
        respuesta: `odentIA no tiene precios de otras clínicas. Lo tuyo: ${main ? `el «${main.name}» está en tu lista a ${money(main.price)}` : "no hay ningún implante en tu lista de precios"}${(quotedRow?.lines ?? 0) === 0 && (main?.times ?? 0) === 0 ? ", y todavía no se ha cotizado ni hecho ninguno" : ""}.`,
        criterio:
          "Trampa: sin datos de la competencia. Se ofrece el precio de lista del implante de la clínica y si se ha cotizado o hecho.",
        nota: `Servicios con implante en tu lista: ${listOf(implants.map((row) => ({ name: row.name, value: `${money(row.price)}, ${row.times} hechos` }))) || "ninguno"}. Veces cotizado en presupuestos: ${quotedRow?.lines ?? 0}.`,
        datos: { servicios: implants, cotizados: quotedRow?.lines ?? 0 },
      }
    },

    g199: async () => {
      const month = await h.fig("canceladas")
      const bySede = await h.fig("canceladas", "sede")
      const year = await h.fig("canceladas", "total", w.lastYear)
      return {
        respuesta: `odentIA no guarda el motivo de una cancelación (ni quién canceló), así que no sé cuál es el más común. Lo registrado: ${days.current} se cancelaron ${month.total.part ?? 0} citas, el ${show(month)} de las que ya pasaron (${ofWords(month.total)}); ${days.previous}, el ${show(month, month.previous?.value ?? null)} (${ofWords(month.previous)}).`,
        criterio:
          "Trampa: la cita no guarda el motivo de la cancelación. Se ofrece «Canceladas» de Reportes del mes en curso contra los mismos días del anterior.",
        nota: `Por sede este mes: ${rowsWords(bySede, (row) => `, ${ofWords(row.value)}`)}. En los últimos 365 días: ${show(year)} (${ofWords(year.total)}).`,
        datos: {
          mes: month.total,
          anterior: month.previous,
          porSede: bySede.rows,
          doceMeses: year.total,
        },
      }
    },

    g200: async () => {
      const channels = await h.fig("nos_buscaron", "canal")
      const instagram = channels.rows.find((row) => row.key === "instagram")
      const referral = await h.fig("como_nos_conocieron")
      const social = referral.rows.find((row) => row.key === "redes_sociales")
      const last = (await h.fig("nos_buscaron", "canal", "mes_pasado")).rows.find(
        (row) => row.key === "instagram",
      )
      return {
        respuesta: `odentIA no tiene las estadísticas de Instagram (cuántos vieron tus publicaciones ni su alcance). Lo más cercano: ${thisMonth} ${instagram?.value.value ?? 0} personas nos escribieron por primera vez por Instagram y ${instagram?.value.part ?? 0} de ellas ya vinieron a atenderse; ${social?.value.value ?? 0} de los ${referral.total.value ?? 0} pacientes nuevos dijeron que nos conocieron por redes sociales.`,
        criterio:
          "Trampa: sin métricas de la red social. Se ofrecen el embudo de Reportes por canal (Instagram) y «Cómo nos conocieron» = Redes sociales del mes en curso.",
        nota: `En ${lastMonthName} completo nos escribieron por primera vez por Instagram ${last?.value.value ?? 0} personas (${last?.value.part ?? 0} vinieron). Por todos los canales este mes: ${listOf(channels.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}` })))}.`,
        datos: {
          instagram: instagram ?? null,
          canales: channels.rows,
          redesSociales: social ?? null,
          mesPasado: last ?? null,
        },
      }
    },
  }
}
