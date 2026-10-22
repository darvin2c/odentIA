/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`),
 * parte 1: el dinero (g001 a g025). Cada cifra es la de Reportes cuando la
 * pantalla la tiene (`h.fig`, o la misma cifra con una sede elegida); si no,
 * una consulta con la regla de «Lo cobrado»: pagos del tramo que siguen en pie
 * al cerrarlo, menos lo anulado en el tramo de pagos anteriores y lo devuelto
 * en el tramo, en el día de la clínica.
 */
import {
  computeFigure,
  type FigureGroup,
  type FigureResult,
  type FigureRow,
  getReportCommissions,
  getReportFinance,
  getReportList,
  reportScope,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { dayStart, goldenWords } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

/** Las listas de «Te deben» por antigüedad: juntas son todos los que deben hoy. */
const DEBT_LISTS = ["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus"] as const

/** Un medio de un cierre de caja (`cash_closure.totals_by_method`): los que no son efectivo. */
interface ClosureMethod {
  name: string
  count: number
  typeCode: string | null
  amountCents: number
  refundedCents: number
}

export function generatedSolvers1(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const { money, show, listOf } = h
  const { locale, currency } = h.scope
  const nowIso = w.nowIso
  const todayKey = w.todayKey
  const yesterday = w.addDays(todayKey, -1)
  const weekday = new Date(`${todayKey}T12:00:00Z`).getUTCDay()
  const monday = w.addDays(todayKey, -((weekday + 6) % 7))
  const thisYear = Number(todayKey.slice(0, 4))
  const thisMonth = Number(todayKey.slice(5, 7))
  const pad = (value: number) => String(value).padStart(2, "0")

  // --- Palabras -------------------------------------------------------------------------
  const dayKeyOf = (date: Date): string =>
    new Intl.DateTimeFormat("en-CA", { timeZone: h.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
  const timeOf = (date: Date): string =>
    new Intl.DateTimeFormat(locale, { timeZone: h.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(date)
  /** «21 de octubre de 2026». */
  const longDay = (key: string): string =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${key}T12:00:00Z`),
    )
  /** «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «del 1 de enero al 21 de octubre de 2026». */
  const yearSoFar = `del 1 de enero al ${longDay(todayKey)}`
  /** El último mes con ese número que ya empezó: «agosto» es el de este año si ya llegó; si no, el del año pasado. */
  const monthKey = (month: number): string => `${month <= thisMonth ? thisYear : thisYear - 1}-${pad(month)}`
  const isCurrent = (key: string): boolean => key === `${thisYear}-${pad(thisMonth)}`
  /** «setiembre de 2026», o «octubre de 2026 (hasta hoy)» si es el mes en curso. */
  const monthName = (key: string): string =>
    `${w.monthWords({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) })}${isCurrent(key) ? " (hasta hoy)" : ""}`
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const rate = (bps: number): string => `${(bps / 100).toLocaleString(locale)} %`
  const changeWords = (value: number, before: number): string =>
    value === before
      ? "lo mismo"
      : `${value > before ? `${money(value - before)} más` : `${money(before - value)} menos`} (${w.signed(value, before)})`
  const noteOf = (parts: Array<string | false | null | undefined>): string | undefined =>
    parts.filter((part): part is string => !!part).join(" ") || undefined

  // --- Cifras de Reportes ---------------------------------------------------------------
  const totalOf = (result: FigureResult): number => result.total.value ?? 0
  const centsOf = (row: FigureRow | undefined): number => row?.value.value ?? 0
  const rowNamed = (result: FigureResult, pattern: RegExp): FigureRow | undefined =>
    result.rows.find((row) => pattern.test(row.label))
  const activeBranches = async () =>
    [
      ...(await h.tx.execute<{ id: string; name: string }>(sql`
        select id, name from branch where organization_id = ${h.org} and is_active order by name, id`)),
    ]
  /** La sede que nombra la pregunta («Miraflores»), y todas para decir cuáles hay si no existe. */
  const branchNamed = async (word: string) => {
    const all = await activeBranches()
    return { branch: all.find((row) => row.name.toLowerCase().includes(word.toLowerCase())) ?? null, all }
  }
  const noBranch = (word: string, all: Array<{ name: string }>) => ({
    respuesta: `No hay una sede ${word} en la clínica; las sedes son ${all.map((row) => row.name).join(", ")}.`,
    criterio: `La sede ${word} no existe entre las sedes activas.`,
    datos: { sedes: all },
  })
  /** Una cifra de Reportes con una sede elegida en la pantalla: la misma cuenta, solo de esa sede. */
  const figIn = async (figure: string, group: FigureGroup, period: string, branchId?: string): Promise<FigureResult> => {
    const scope = await reportScope(h.tx, h.org, branchId ? { period, branchId } : { period }, h.now)
    return computeFigure({ ...h.ctx, scope }, { figure, group })
  }
  /** El tramo de un periodo de Reportes (ISO), para las consultas propias del mismo periodo. */
  const windowOf = async (period: string) => {
    const scope = await reportScope(h.tx, h.org, { period }, h.now)
    return { start: scope.window.start.toISOString(), end: scope.window.end.toISOString() }
  }

  // --- Consultas propias ----------------------------------------------------------------
  /** Un instante del día de la clínica: `hour` horas después de su comienzo. */
  const instantOf = async (key: string, hour: number): Promise<string> => {
    const [row] = await h.tx.execute<{ at: string }>(sql`
      select to_char(((${key}::date)::timestamp + make_interval(hours => ${hour})) at time zone ${h.tz} at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`)
    if (!row) throw new Error(`Día inválido: ${key}`)
    return row.at
  }
  /** Lo cobrado de un tramo con la regla de Reportes; `filter` acota los pagos (alias `p`). */
  const netIn = async (start: string, end: string, filter: SQL = sql``): Promise<number> => {
    const [row] = await h.tx.execute<{ cents: string }>(sql`
      select coalesce(sum(x.cents), 0)::text as cents from (
        select p.amount_cents::bigint as cents from patient_payment p
        where p.organization_id = ${h.org} and p.currency = ${currency}
          and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
          and (p.voided_at is null or p.voided_at >= ${end}::timestamptz) ${filter}
        union all
        select -p.amount_cents::bigint from patient_payment p
        where p.organization_id = ${h.org} and p.currency = ${currency} and p.paid_at < ${start}::timestamptz
          and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz ${filter}
        union all
        select -r.amount_cents::bigint from patient_payment_refund r
        join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
        where r.organization_id = ${h.org} and p.currency = ${currency}
          and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz ${filter}) x`)
    return Number(row?.cents ?? 0)
  }
  /** Los pagos de un tramo que siguen en pie al cerrarlo, por medio (sin restar devoluciones). */
  const paymentsIn = async (start: string, end: string, filter: SQL = sql``) => {
    const rows = await h.tx.execute<{ name: string; count: number; cents: string }>(sql`
      select p.method_name as name, count(*)::int as count, sum(p.amount_cents)::text as cents from patient_payment p
      where p.organization_id = ${h.org} and p.currency = ${currency}
        and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
        and (p.voided_at is null or p.voided_at >= ${end}::timestamptz) ${filter}
      group by 1 order by sum(p.amount_cents) desc, 1`)
    const list = rows.map((row) => ({ name: row.name, count: row.count, cents: Number(row.cents) }))
    return {
      list,
      count: list.reduce((sum, row) => sum + row.count, 0),
      cents: list.reduce((sum, row) => sum + row.cents, 0),
      of: (pattern: RegExp) => list.find((row) => pattern.test(row.name)) ?? { name: "", count: 0, cents: 0 },
    }
  }
  /** Lo que se devolvió y lo que se anuló dentro de un tramo (pagos de cualquier día). */
  const takenBackIn = async (start: string, end: string, filter: SQL = sql``) => {
    const [row] = await h.tx.execute<{ refunds: number; refunded: string; voids: number; voided: string }>(sql`
      select
        (select count(*) from patient_payment_refund r join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
          where r.organization_id = ${h.org} and p.currency = ${currency}
            and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz ${filter})::int as refunds,
        (select coalesce(sum(r.amount_cents), 0) from patient_payment_refund r join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
          where r.organization_id = ${h.org} and p.currency = ${currency}
            and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz ${filter})::text as refunded,
        (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.currency = ${currency}
            and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz ${filter})::int as voids,
        (select coalesce(sum(p.amount_cents), 0) from patient_payment p where p.organization_id = ${h.org} and p.currency = ${currency}
            and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz ${filter})::text as voided`)
    return {
      refunds: row?.refunds ?? 0,
      refunded: Number(row?.refunded ?? 0),
      voids: row?.voids ?? 0,
      voided: Number(row?.voided ?? 0),
    }
  }
  const backWords = (back: Awaited<ReturnType<typeof takenBackIn>>): string | null =>
    back.refunds || back.voids
      ? [
          back.refunds ? `se ${back.refunds === 1 ? "devolvió" : "devolvieron"} ${money(back.refunded)} (${plural(back.refunds, "devolución", "devoluciones")})` : "",
          back.voids ? `se ${back.voids === 1 ? "anuló" : "anularon"} ${plural(back.voids, "pago", "pagos")} por ${money(back.voided)}` : "",
        ]
          .filter(Boolean)
          .join(" y ")
      : null
  /** El último día de la clínica con pagos en pie antes de `before`. */
  const lastPaidDay = async (before: string): Promise<string | null> => {
    const [row] = await h.tx.execute<{ day: string | null }>(sql`
      select to_char(max(${h.dayOf(sql`p.paid_at`)}), 'YYYY-MM-DD') as day from patient_payment p
      where p.organization_id = ${h.org} and p.voided_at is null and p.currency = ${currency}
        and ${h.dayOf(sql`p.paid_at`)} < ${before}::date`)
    return row?.day ?? null
  }
  /** Quién debe hoy y cuánto: las listas de «Te deben» por antigüedad juntas, de mayor a menor. */
  const debtors = async (branchId?: string) => {
    const lists = await Promise.all(
      DEBT_LISTS.map((list) =>
        getReportList(h.tx, h.org, { period: "este_mes", list, limit: 5000, ...(branchId ? { branchId } : {}) }, h.now),
      ),
    )
    return lists
      .flatMap((list) => list.rows)
      .map((row) => ({ patientId: row.patientId, name: row.personName, cents: row.cents ?? 0, since: row.at }))
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
  }
  const sinceWords = (iso: string): string => longDay(dayKeyOf(new Date(iso)))

  return {
    g001: async () => {
      const result = await h.fig("cobrado", "total", `${todayKey}..${todayKey}`)
      const start = await dayStart(h, todayKey)
      const paid = await paymentsIn(start, nowIso)
      const back = await takenBackIn(start, nowIso)
      const last = await lastPaidDay(todayKey)
      const lastResult = last ? await h.fig("cobrado", "total", `${last}..${last}`) : null
      const backText = backWords(back)
      return {
        respuesta:
          paid.count || totalOf(result)
            ? `Hoy (${w.dayWords(todayKey)}, hasta ahora) entraron ${show(result)}, sin lo anulado ni lo devuelto: ${plural(paid.count, "pago", "pagos")} por ${money(paid.cents)} (${listOf(paid.list.map((row) => ({ name: row.name, value: money(row.cents) })))})${backText ? `, y hoy ${backText}` : ""}.`
            : `Hoy (${w.dayWords(todayKey)}, hasta ahora) todavía no entró nada: no hay pagos registrados hoy${backText ? `, y hoy ${backText}` : ""}.`,
        criterio:
          "«Lo cobrado» de Reportes de hoy (día de la clínica, hasta ahora): pagos de hoy menos lo anulado y lo devuelto hoy.",
        nota: noteOf([
          last && lastResult ? `El último día con cobros antes de hoy fue el ${w.dayWords(last)}: ${show(lastResult)}.` : null,
        ]),
        datos: { hoy: result.total, pagos: paid.list, devueltoYAnulado: back, ultimoDia: last, cobradoUltimoDia: lastResult?.total ?? null },
      }
    },

    g002: async () => {
      const { branch, all } = await branchNamed("Miraflores")
      if (!branch) return noBranch("Miraflores", all)
      const result = await h.fig("cobrado", "sede", `${yesterday}..${yesterday}`)
      const row = result.rows.find((item) => item.key === branch.id)
      const start = await dayStart(h, yesterday)
      const end = await dayStart(h, todayKey)
      const paid = await paymentsIn(start, end, sql`and p.branch_id = ${branch.id}`)
      const back = backWords(await takenBackIn(start, end, sql`and p.branch_id = ${branch.id}`))
      return {
        respuesta: `Ayer (${w.dayWords(yesterday)}) en ${branch.name} se cobraron ${money(centsOf(row))}, sin lo anulado ni lo devuelto: ${plural(paid.count, "pago", "pagos")} por ${money(paid.cents)} (${listOf(paid.list.map((item) => ({ name: item.name, value: money(item.cents) })))})${back ? `; ese día ${back}` : ""}.`,
        criterio: "«Lo cobrado» de Reportes por sede, del día de ayer (día de la clínica): pagos de ese día menos lo anulado y lo devuelto ese día, en esa sede.",
        nota: `En toda la clínica ayer se cobró ${show(result)}: ${listOf(result.rows.map((item) => ({ name: item.label, value: show(result, item.value.value) })))}.`,
        datos: { sede: branch, cobrado: row?.value ?? null, pagos: paid.list, clinica: result.total, sedes: result.rows },
      }
    },

    g003: async () => {
      const week = await h.fig("cobrado", "medio", `${monday}..${todayKey}`)
      const before = await h.fig("cobrado", "medio", `${w.addDays(monday, -7)}..${w.addDays(todayKey, -7)}`)
      const yape = rowNamed(week, /yape/i)
      const paid = await paymentsIn(await dayStart(h, monday), nowIso)
      const gross = paid.of(/yape/i)
      return {
        respuesta: yape
          ? `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) entraron ${money(centsOf(yape))} por Yape, sin lo anulado ni lo devuelto: ${plural(gross.count, "pago", "pagos")}, el ${w.pct(centsOf(yape), totalOf(week))} de lo cobrado en la semana (${show(week)}).`
          : `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) no entró nada por Yape; lo cobrado en la semana es ${show(week)}.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago, fila Yape, de esta semana: del lunes a hoy, en el día de la clínica.",
        nota: noteOf([
          gross.cents !== centsOf(yape) ? `Los pagos por Yape sin restar lo devuelto suman ${money(gross.cents)}.` : null,
          `La semana pasada en los mismos días (${spanWords(w.addDays(monday, -7), w.addDays(todayKey, -7))}): ${money(centsOf(rowNamed(before, /yape/i)))} por Yape.`,
        ]),
        datos: { yape: yape?.value ?? null, pagos: gross, semana: week.total, medios: week.rows, semanaPasada: before.rows },
      }
    },

    g004: async () => {
      const result = await h.fig("cobrado", "medio", "mes_pasado")
      const cash = rowNamed(result, /efectivo/i)
      const total = totalOf(result)
      const span = await windowOf("mes_pasado")
      const paid = await paymentsIn(span.start, span.end)
      return {
        respuesta: `En ${w.previousMonth} se cobró ${show(result)}; de eso, ${money(centsOf(cash))} fue en efectivo: el ${w.pct(centsOf(cash), total)}.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago del mes pasado completo (pagos menos anulaciones y devoluciones): la fila Efectivo ÷ el total.",
        nota: `Los demás medios: ${listOf(result.rows.filter((row) => row !== cash).map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${w.pct(centsOf(row), total)}` })))}. Por cantidad de pagos, en efectivo fueron ${paid.of(/efectivo/i).count} de ${paid.count} (${w.pct(paid.of(/efectivo/i).count, paid.count)}).`,
        datos: { total: result.total, efectivo: cash?.value ?? null, medios: result.rows, pagos: paid.list },
      }
    },

    g005: async () => {
      const tickets = await h.tx.execute<{ number: number; cents: string; person: string; day: string; reason: string | null }>(sql`
        select t.ticket_number as number, t.total_cents::text as cents, pp.display_name as person,
          to_char(${h.dayOf(sql`t.voided_at`)}, 'YYYY-MM-DD') as day, t.void_reason as reason
        from payment_ticket t ${h.joinPerson(sql`t.patient_id`)}
        where t.organization_id = ${h.org} and t.voided_at >= ${h.monthStart}::timestamptz and t.voided_at < ${nowIso}::timestamptz
        order by t.voided_at, t.ticket_number`)
      const [issued] = await h.tx.execute<{ count: number }>(sql`
        select count(*)::int as count from payment_ticket t where t.organization_id = ${h.org}
          and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${nowIso}::timestamptz`)
      const [payments] = await h.tx.execute<{ count: number; cents: string; loose: number }>(sql`
        select count(*)::int as count, coalesce(sum(p.amount_cents), 0)::text as cents, count(*) filter (where p.ticket_id is null)::int as loose
        from patient_payment p where p.organization_id = ${h.org}
          and p.voided_at >= ${h.monthStart}::timestamptz and p.voided_at < ${nowIso}::timestamptz`)
      const total = tickets.reduce((sum, row) => sum + Number(row.cents), 0)
      return {
        respuesta: tickets.length
          ? `Este mes (${w.monthSoFar}) se ${tickets.length === 1 ? "anuló" : "anularon"} ${plural(tickets.length, "ticket", "tickets")} por ${money(total)} en total: ${tickets.map((row) => `el N.º ${row.number} de ${row.person}, ${money(Number(row.cents))} (${w.dayWords(row.day)}${row.reason ? `: «${row.reason}»` : ""})`).join("; ")}.`
          : `Este mes (${w.monthSoFar}) no se anuló ningún ticket.`,
        criterio: "Tickets de pago anulados en el mes en curso (fecha de la anulación, hasta ahora), con la suma de sus totales.",
        nota: `Pagos anulados este mes: ${plural(payments?.count ?? 0, "pago", "pagos")} por ${money(Number(payments?.cents ?? 0))}${payments?.loose ? ` (${payments.loose} sin ticket)` : ""}. Tickets emitidos este mes: ${issued?.count ?? 0}; la historia de prueba guarda casi todos los pagos sin ticket.`,
        datos: { anulados: tickets, total, emitidos: issued?.count ?? 0, pagosAnulados: payments },
      }
    },

    g006: async () => {
      const key = monthKey(10)
      const span = await windowOf(key)
      const refunds = await h.tx.execute<{ person: string; cents: string; day: string; reason: string; method: string; ret: number | null; retMethod: string | null }>(sql`
        select pp.display_name as person, r.amount_cents::text as cents, to_char(${h.dayOf(sql`r.refunded_at`)}, 'YYYY-MM-DD') as day,
          r.reason, pay.method_name as method, ret.return_number as ret, ret.method_name as "retMethod"
        from patient_payment_refund r
        join patient_payment pay on pay.organization_id = r.organization_id and pay.id = r.payment_id
        left join payment_return ret on ret.organization_id = r.organization_id and ret.id = r.return_id
        ${h.joinPerson(sql`r.patient_id`)}
        where r.organization_id = ${h.org} and pay.currency = ${currency}
          and r.refunded_at >= ${span.start}::timestamptz and r.refunded_at < ${span.end}::timestamptz
        order by r.refunded_at, r.id`)
      const [credit] = await h.tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(total_cents), 0)::text as cents from payment_return
        where organization_id = ${h.org} and outcome = 'a_favor' and currency = ${currency}
          and created_at >= ${span.start}::timestamptz and created_at < ${span.end}::timestamptz`)
      const voided = await takenBackIn(span.start, span.end)
      const people = new Map<string, number[]>()
      for (const row of refunds) people.set(row.person, [...(people.get(row.person) ?? []), Number(row.cents)])
      const total = refunds.reduce((sum, row) => sum + Number(row.cents), 0)
      const byPerson = [...people.entries()]
        .map(([name, list]) => ({ name, list, cents: list.reduce((sum, cents) => sum + cents, 0) }))
        .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
      return {
        respuesta: refunds.length
          ? `Sí: en ${monthName(key)} hubo ${plural(refunds.length, "devolución", "devoluciones")} por ${money(total)} en total, a ${plural(byPerson.length, "persona", "personas")}: ${byPerson.map((row) => `${row.name}, ${money(row.cents)}${row.list.length > 1 ? ` (en ${row.list.length}: ${row.list.map((cents) => money(cents)).join(" y ")})` : ""}`).join("; ")}.`
          : `No: en ${monthName(key)} no hubo devoluciones de dinero.`,
        criterio: "Devoluciones de pagos (`patient_payment_refund`) registradas en octubre, hasta hoy, con quién las recibió y cuánto.",
        nota: noteOf([
          refunds.length
            ? `El detalle: ${refunds.map((row) => `${row.person}, ${money(Number(row.cents))} el ${w.dayWords(row.day)}, de un pago hecho con ${row.method}${row.ret ? ` (devolución N.º ${row.ret}${row.retMethod ? `, entregada en ${row.retMethod}` : ""})` : ""}: «${row.reason}»`).join("; ")}.`
            : null,
          credit?.count ? `Además, ${plural(credit.count, "devolución quedó", "devoluciones quedaron")} como saldo a favor (${money(Number(credit.cents))}), sin entregar dinero.` : null,
          voided.voids ? `Aparte, se ${voided.voids === 1 ? "anuló" : "anularon"} ${plural(voided.voids, "pago", "pagos")} por ${money(voided.voided)}: anular no es devolver.` : null,
        ]),
        datos: { devoluciones: refunds, total, porPersona: byPerson, aFavor: credit, anulados: { cantidad: voided.voids, cents: voided.voided } },
      }
    },

    g007: async () => {
      const key = monthKey(9)
      const leaves = await h.fig("lo_que_deja", "total", key)
      const collected = await h.fig("cobrado", "total", key)
      const spent = await h.fig("gastos", "total", key)
      const commissions = await h.fig("comisiones", "total", key)
      const finance = await getReportFinance(h.tx, h.org, { period: key }, h.now)
      const paidCommissions = finance.cascade.commissionPaidCents
      return {
        respuesta: `En ${monthName(key)} te quedaron ${show(leaves)}: de ${show(collected)} cobrados se restan ${show(commissions)} de comisiones y ${show(spent)} de gastos registrados. Puede faltar algún gasto que no se anotó.`,
        criterio: "«Lo que deja» de Reportes › Finanzas de ese mes completo: lo cobrado − las comisiones generadas − los gastos registrados (sin el pago de comisiones, que ya está en ellas).",
        nota: `Si solo restas los gastos registrados, sin comisiones: ${money(totalOf(collected) - totalOf(spent))}. Si restas lo que de verdad salió ese mes, con el pago de comisiones hecho en él (${money(paidCommissions)}) en vez de las generadas: ${money(finance.totals.current.cashLeftCents)} («En caja quedó»).`,
        datos: { deja: leaves.total, cobrado: collected.total, gastos: spent.total, comisiones: commissions.total, pagoComisiones: paidCommissions, enCaja: finance.totals.current.cashLeftCents },
      }
    },

    g008: async () => {
      const result = await h.fig("gastos", "categoria", "este_ano")
      const commissions = await h.fig("comisiones", "total", "este_ano")
      const finance = await getReportFinance(h.tx, h.org, { period: "este_ano" }, h.now)
      const total = totalOf(result)
      const rows = result.rows.filter((row) => centsOf(row) !== 0)
      return {
        respuesta: rows.length
          ? `En lo que va del año (${yearSoFar}) los gastos registrados suman ${show(result)}; por tipo: ${listOf(rows.map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${w.pct(centsOf(row), total)}` })))}. Donde más se va es ${rows[0]?.label}.`
          : `En lo que va del año (${yearSoFar}) no hay gastos registrados.`,
        criterio: "«Lo gastado» de Reportes › Finanzas por tipo de gasto, de este año hasta hoy: gastos registrados sin anulados y sin el pago de comisiones.",
        nota: `Las comisiones de los odontólogos van aparte: ${show(commissions)} generadas en el año (${money(finance.cascade.commissionPaidCents)} pagadas en el año). Con ellas, lo que sale suma ${money(total + totalOf(commissions))}.`,
        datos: { total: result.total, porTipo: result.rows, comisiones: commissions.total, pagoComisiones: finance.cascade.commissionPaidCents },
      }
    },

    g009: async () => {
      const { branch, all } = await branchNamed("San Isidro")
      if (!branch) return noBranch("San Isidro", all)
      const result = await h.fig("gastos", "sede", "mes_pasado")
      const row = result.rows.find((item) => item.key === branch.id)
      const byType = await figIn("gastos", "categoria", "mes_pasado", branch.id)
      const finance = await getReportFinance(h.tx, h.org, { period: "mes_pasado", branchId: branch.id }, h.now)
      return {
        respuesta: `En ${w.previousMonth}, ${branch.name} gastó ${money(centsOf(row))} en gastos registrados: ${listOf(byType.rows.filter((item) => centsOf(item) !== 0).map((item) => ({ name: item.label, value: show(byType, item.value.value) })))}.`,
        criterio: "«Lo gastado» de Reportes por sede, del mes pasado completo: gastos registrados de esa sede sin anulados y sin el pago de comisiones.",
        nota: noteOf([
          finance.cascade.commissionPaidCents ? `Además, en esa sede se registró el pago de comisiones por ${money(finance.cascade.commissionPaidCents)}; con él, salió ${money(centsOf(row) + finance.cascade.commissionPaidCents)}.` : null,
          `Las demás sedes: ${listOf(result.rows.filter((item) => item.key !== branch.id).map((item) => ({ name: item.label, value: show(result, item.value.value) })))}; en toda la clínica, ${show(result)}.`,
        ]),
        datos: { sede: branch, gastos: row?.value ?? null, porTipo: byType.rows, pagoComisiones: finance.cascade.commissionPaidCents, sedes: result.rows },
      }
    },

    g010: async () => {
      const result = await h.fig("comisiones", "profesional")
      const row = rowNamed(result, /ana torres/i)
      const report = await getReportCommissions(h.tx, h.org, { period: "este_mes" }, h.now)
      const mine = report.rows.find((item) => /ana torres/i.test(item.name))
      if (!row && !mine)
        return {
          respuesta: `Este mes (${w.monthSoFar}) la Dra. Ana Torres no tiene comisiones.`,
          criterio: "«Las comisiones» de Reportes por profesional, del mes en curso.",
          datos: { filas: result.rows },
        }
      return {
        respuesta: `Este mes (${w.monthSoFar}) a la Dra. Ana Torres le tocan ${money(centsOf(row))} de comisión: el ${rate(mine?.rateBps ?? 0)} de ${money(mine?.collectedCents ?? 0)} cobrados de lo que atendió.`,
        criterio: "«Las comisiones» de Reportes por profesional, del mes en curso: su porcentaje sobre lo cobrado de lo que atendió (la cuenta de Finanzas › Comisiones).",
        nota: `De eso ya se le pagó ${money(mine?.paidCents ?? 0)} y falta pagarle ${money(mine?.pendingCents ?? 0)}. Lo que atendió este mes y sigue sin cobrar (${money(mine?.unpaidCents ?? 0)}) le dará comisión cuando se cobre.`,
        datos: { comision: row?.value ?? null, detalle: mine ?? null },
      }
    },

    g011: async () => {
      const key = monthKey(9)
      const year = key.slice(0, 4)
      const period = `${year}-07-01..${year}-09-30`
      const result = await h.fig("comisiones", "profesional", period)
      const months = result.months.slice(-3)
      const finance = await getReportFinance(h.tx, h.org, { period }, h.now)
      return {
        respuesta: `Entre julio y setiembre de ${year} las comisiones de todos los odontólogos sumaron ${show(result)}: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        criterio: "«Las comisiones» de Reportes del 1 de julio al 30 de setiembre (tres meses completos), en total y por profesional: el porcentaje de cada uno sobre lo cobrado de lo que atendió.",
        nota: `Por mes: ${listOf(months.map((month) => ({ name: w.monthWords(month.month), value: show(result, month.value.value) })))}. De esas comisiones ya se pagó ${money(finance.commissions.paidCents)}; en esos meses se registraron pagos de comisiones por ${money(finance.cascade.commissionPaidCents)} (lo pagado en un mes puede ser de comisiones de meses anteriores).`,
        datos: { total: result.total, porProfesional: result.rows, porMes: months, pagado: finance.commissions.paidCents, pagosRegistrados: finance.cascade.commissionPaidCents },
      }
    },

    g012: async () => {
      const owed = await h.fig("te_deben")
      const rows = await debtors()
      const over = rows.filter((row) => row.cents > 50_000)
      const sum = over.reduce((total, row) => total + row.cents, 0)
      const exactly = rows.filter((row) => row.cents === 50_000)
      return {
        respuesta: over.length
          ? `Hoy ${plural(over.length, "persona te debe", "personas te deben")} más de ${money(50_000)}: ${listOf(over.map((row) => ({ name: row.name, value: money(row.cents) })))}. Entre ${over.length === 1 ? "ella" : "ellas"} suman ${money(sum)} de los ${show(owed)} que te deben en total.`
          : `Hoy nadie te debe más de ${money(50_000)}${rows[0] ? `; la deuda más alta es la de ${rows[0].name} (${money(rows[0].cents)})` : ""}.`,
        criterio: "Las listas de «Te deben» de Reportes (todas las antigüedades), a hoy: lo que debe cada persona descontando lo que tiene a favor, solo quienes pasan de S/ 500.",
        nota: noteOf([
          exactly.length ? `Con exactamente ${money(50_000)}: ${listOf(exactly.map((row) => ({ name: row.name, value: money(row.cents) })))}.` : null,
          `En total te deben ${rows.length} personas.`,
        ]),
        datos: { mas500: over, suma: sum, total: owed.total, deudores: rows.length },
      }
    },

    g013: async () => {
      const { branch, all } = await branchNamed("Surco")
      if (!branch) return noBranch("Surco", all)
      const result = await h.fig("te_deben", "sede")
      const row = result.rows.find((item) => item.key === branch.id)
      const attended = await h.tx.execute<{ patientId: string }>(sql`
        select distinct a.patient_id as "patientId" from appointment a
        where a.organization_id = ${h.org} and a.branch_id = ${branch.id} and a.status = 'atendida'`)
      const ids = new Set(attended.map((item) => item.patientId))
      const theirs = (await debtors()).filter((item) => !!item.patientId && ids.has(item.patientId))
      const [charges] = await h.tx.execute<{ count: number }>(sql`
        select count(*)::int as count from patient_charge c where c.organization_id = ${h.org} and c.branch_id = ${branch.id}`)
      const idle = !charges?.count && !ids.size
      return {
        respuesta: idle
          ? `En ${branch.name} nadie debe nada: la sede todavía no tiene pacientes atendidos ni cargos registrados. Lo que te deben hoy está en ${listOf(result.rows.filter((item) => centsOf(item) !== 0).map((item) => ({ name: item.label, value: show(result, item.value.value) })))}; en toda la clínica, ${show(result)}.`
          : `Hoy los pacientes deben ${money(centsOf(row))} de lo que se les cobró en ${branch.name} (${plural(row?.value.part ?? 0, "persona", "personas")}), descontando lo que tienen a favor.`,
        criterio: "«Te deben» de Reportes por sede, a hoy: lo que cada persona debe de los conceptos de esa sede, descontando lo que tiene a favor.",
        nota: idle
          ? undefined
          : `Si cuentas toda la deuda (de cualquier sede) de quienes se han atendido alguna vez en ${branch.name}: ${money(theirs.reduce((sum, item) => sum + item.cents, 0))} de ${plural(theirs.length, "persona", "personas")}. Las demás sedes: ${listOf(result.rows.filter((item) => item.key !== branch.id).map((item) => ({ name: item.label, value: show(result, item.value.value) })))}; en toda la clínica, ${show(result)}.`,
        datos: { sede: branch, deuda: row?.value ?? null, sedes: result.rows, deQuienesSeAtienden: { personas: theirs.length, cents: theirs.reduce((sum, item) => sum + item.cents, 0) } },
      }
    },

    g014: async () => {
      const result = await h.fig("te_deben")
      const close = await h.fig("te_deben", "total", "mes_pasado")
      const overdue = await h.fig("deuda_vencida")
      const now = totalOf(result)
      const before = result.previous?.value ?? 0
      const then = dayKeyOf(h.scope.window.previous.end)
      return {
        respuesta: `${now > before ? "Sí, creció" : now < before ? "No, bajó" : "Sigue igual"}: hoy te deben ${show(result)} (${plural(result.total.part ?? 0, "persona", "personas")}); a la misma altura del mes pasado (el ${w.dayWords(then)}, a esta hora) te debían ${show(result, before)} (${plural(result.previous?.part ?? 0, "persona", "personas")}): ${changeWords(now, before)}.`,
        criterio: "«Te deben» de Reportes, a hoy, contra el mismo momento del mes anterior (la comparación de Reportes): lo que deben las personas descontando lo que tienen a favor.",
        nota: `Contra el cierre de ${w.previousMonth}: ${show(close)} (${plural(close.total.part ?? 0, "persona", "personas")}), ${changeWords(now, totalOf(close))}. Lo de hace más de 30 días: hoy ${show(overdue)}, contra ${show(overdue, overdue.previous?.value ?? null)} a la misma altura del mes pasado.`,
        datos: { hoy: result.total, mismoMomentoMesPasado: result.previous, cierreMesPasado: close.total, vencida: overdue.total, vencidaAntes: overdue.previous },
      }
    },

    g015: async () => {
      const key = monthKey(8)
      const span = await windowOf(key)
      const clinic = await h.fig("cobrado", "medio", key)
      const card = rowNamed(clinic, /tarjeta/i)
      const label = card?.label ?? "Tarjeta"
      const perBranch = []
      for (const branch of await activeBranches()) {
        const result = await figIn("cobrado", "medio", key, branch.id)
        const only = sql`and p.branch_id = ${branch.id} and p.method_name = ${label}`
        const paid = await paymentsIn(span.start, span.end, only)
        const back = await takenBackIn(span.start, span.end, only)
        perBranch.push({ name: branch.name, cents: centsOf(rowNamed(result, /tarjeta/i)), count: paid.count, gross: paid.cents, back })
      }
      const gross = perBranch.reduce((sum, row) => sum + row.gross, 0)
      return {
        respuesta: `En ${monthName(key)} se cobraron ${money(centsOf(card))} con tarjeta, sin lo anulado ni lo devuelto. Por sede: ${listOf(perBranch.map((row) => ({ name: row.name, value: `${money(row.cents)}, ${plural(row.count, "pago", "pagos")}` })))}.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago de ese mes completo, fila Tarjeta, con cada sede elegida en la pantalla (pagos menos anulaciones y devoluciones).",
        nota: noteOf([
          gross !== centsOf(card) ? `Sin restar devoluciones ni anulaciones, los pagos con tarjeta suman ${money(gross)}.` : "No hubo devoluciones ni anulaciones de pagos con tarjeta ese mes.",
          "odentIA no tiene el estado de cuenta del banco ni lo que descuenta el banco o el POS: lo que abonó el banco puede ser menos.",
        ]),
        datos: { total: card?.value ?? null, porSede: perBranch, medios: clinic.rows },
      }
    },

    g016: async () => {
      const start = await dayStart(h, todayKey)
      const noon = await instantOf(todayKey, 12)
      const beforeNoon = new Date(nowIso) < new Date(noon)
      const end = beforeNoon ? nowIso : noon
      const total = await netIn(start, end)
      const cash = await netIn(start, end, sql`and p.method_type_code = '10'`)
      const paid = await paymentsIn(start, end)
      const day = await netIn(start, nowIso)
      const last = await lastPaidDay(todayKey)
      const lastNoon = last ? await netIn(await dayStart(h, last), await instantOf(last, 12)) : 0
      const until = beforeNoon ? `hasta ahora (${timeOf(h.now)}; todavía no es mediodía)` : "hasta el mediodía"
      return {
        respuesta:
          paid.count || total
            ? `Hoy (${w.dayWords(todayKey)}) ${until} se habían cobrado ${money(total)}, sin lo anulado ni lo devuelto: ${plural(paid.count, "pago", "pagos")} por ${money(paid.cents)} (${listOf(paid.list.map((row) => ({ name: row.name, value: money(row.cents) })))}).`
            : `Hoy (${w.dayWords(todayKey)}) ${until} no se había cobrado nada: no hay pagos registrados antes de las 12:00.`,
        criterio: "«Lo cobrado» (pagos menos lo anulado y lo devuelto) de hoy, desde el comienzo del día de la clínica hasta las 12:00 (o hasta ahora si aún no son las 12), de toda la clínica.",
        nota: noteOf([
          `Solo en efectivo, ${until}: ${money(cash)}. En todo el día, hasta ahora: ${money(day)}.`,
          !paid.count && last ? `El último día con cobros, el ${w.dayWords(last)}, hasta el mediodía se habían cobrado ${money(lastNoon)}.` : null,
        ]),
        datos: { hastaMediodia: total, efectivo: cash, pagos: paid.list, diaHastaAhora: day, ultimoDia: last, ultimoDiaHastaMediodia: lastNoon },
      }
    },

    g017: async () => {
      const start = await dayStart(h, monday)
      const rows = await h.tx.execute<{ cents: string; method: string; day: string; time: string; person: string; branch: string | null; ticket: number | null; refunded: string; total: number }>(sql`
        select pay.amount_cents::text as cents, pay.method_name as method, to_char(${h.dayOf(sql`pay.paid_at`)}, 'YYYY-MM-DD') as day,
          to_char(pay.paid_at at time zone ${h.tz}, 'HH24:MI') as time, pp.display_name as person, b.name as branch, t.ticket_number as ticket,
          coalesce((select sum(r.amount_cents) from patient_payment_refund r where r.organization_id = pay.organization_id and r.payment_id = pay.id), 0)::text as refunded,
          count(*) over()::int as total
        from patient_payment pay
        ${h.joinPerson(sql`pay.patient_id`)}
        left join branch b on b.organization_id = pay.organization_id and b.id = pay.branch_id
        left join payment_ticket t on t.organization_id = pay.organization_id and t.id = pay.ticket_id
        where pay.organization_id = ${h.org} and pay.voided_at is null and pay.currency = ${currency}
          and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${nowIso}::timestamptz
        order by pay.amount_cents desc, pay.paid_at, pay.id limit 5`)
      const top = rows[0]
      const tied = top ? rows.filter((row) => row.cents === top.cents) : []
      const words = (row: (typeof rows)[number]) =>
        `${row.person}, ${money(Number(row.cents))} con ${row.method} el ${w.dayWords(row.day)}${row.branch ? ` en ${row.branch}` : ""}${row.ticket ? ` (ticket N.º ${row.ticket})` : ""}`
      return {
        respuesta: top
          ? tied.length > 1
            ? `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) los pagos más grandes son de ${money(Number(top.cents))}, y hay ${tied.length} de ese importe: ${tied.map(words).join("; ")}.`
            : `El pago más grande de esta semana (${spanWords(monday, todayKey)}, hasta ahora) fue el de ${words(top)}.`
          : `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) todavía no hay pagos.`,
        criterio: "El pago vigente (sin anular) de mayor importe registrado esta semana, del lunes a hoy en el día de la clínica.",
        nota: noteOf([
          top && Number(top.refunded) ? `De ese pago se devolvieron después ${money(Number(top.refunded))}.` : null,
          rows.length > tied.length ? `Le siguen: ${rows.slice(tied.length, tied.length + 2).map(words).join("; ")}. En la semana hay ${plural(top?.total ?? 0, "pago", "pagos")}.` : null,
        ]),
        datos: { mayores: rows },
      }
    },

    g018: async () => {
      const from = w.addDays(todayKey, -29)
      const result = await h.fig("cobrado", "medio", `${from}..${todayKey}`)
      const before = await h.fig("cobrado", "medio", `${w.addDays(from, -30)}..${w.addDays(from, -1)}`)
      const transfer = rowNamed(result, /transferencia/i)
      const paid = (await paymentsIn(await dayStart(h, from), nowIso)).of(/transferencia/i)
      return {
        respuesta: transfer
          ? `En los últimos 30 días (${spanWords(from, todayKey)}) llegaron ${money(centsOf(transfer))} por transferencia, sin lo anulado ni lo devuelto: ${plural(paid.count, "pago", "pagos")}, el ${w.pct(centsOf(transfer), totalOf(result))} de lo cobrado (${show(result)}).`
          : `En los últimos 30 días (${spanWords(from, todayKey)}) no llegó nada por transferencia; lo cobrado es ${show(result)}.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago, fila Transferencia, de los últimos 30 días con hoy (pagos menos anulaciones y devoluciones).",
        nota: noteOf([
          paid.cents !== centsOf(transfer) ? `Los pagos por transferencia sin restar lo devuelto suman ${money(paid.cents)}.` : null,
          `En los 30 días anteriores (${spanWords(w.addDays(from, -30), w.addDays(from, -1))}): ${money(centsOf(rowNamed(before, /transferencia/i)))}.`,
        ]),
        datos: { transferencia: transfer?.value ?? null, pagos: paid, total: result.total, medios: result.rows, anteriores: before.rows },
      }
    },

    g019: async () => {
      const report = await getReportCommissions(h.tx, h.org, { period: "este_mes" }, h.now)
      const owed = await h.fig("te_deben")
      const attended = report.rows.reduce((sum, row) => sum + row.attendedCents, 0)
      const unpaid = report.rows.reduce((sum, row) => sum + row.unpaidCents, 0)
      const pending = report.rows.filter((row) => row.unpaidCents > 0)
      return {
        respuesta: `De lo que se atendió este mes (${w.monthSoFar}), ${money(attended)} en procedimientos de atenciones cerradas, falta cobrar ${money(unpaid)} (el ${w.pct(unpaid, attended)}).`,
        criterio: "Reportes › Finanzas › Comisiones, del mes en curso: lo atendido en atenciones cerradas del mes (precio × cantidad) y lo que de eso sigue sin pagar hoy, sumado entre todos los profesionales.",
        nota: `Por profesional: ${listOf(pending.map((row) => ({ name: row.name, value: money(row.unpaidCents) })))}. No descuenta lo que cada paciente tiene a favor. Lo que te deben hoy de todo lo cargado, de cualquier mes: ${show(owed)}.`,
        datos: { atendido: attended, sinCobrar: unpaid, porProfesional: report.rows, teDeben: owed.total },
      }
    },

    g020: async () => {
      const collected = await h.fig("cobrado", "total", "este_ano")
      const spent = await h.fig("gastos", "total", "este_ano")
      const commissions = await h.fig("comisiones", "total", "este_ano")
      const income = totalOf(collected)
      const expenses = totalOf(spent)
      const paid = totalOf(commissions)
      return {
        respuesta: `En lo que va del año (${yearSoFar}) el ${w.pct(expenses + paid, income)} de lo cobrado se fue en gastos y comisiones: ${show(spent)} de gastos registrados y ${show(commissions)} de comisiones, de ${show(collected)} cobrados.`,
        criterio: "(Gastos registrados + comisiones de este año) ÷ lo cobrado de este año, hasta hoy; es 100 % menos el margen de «Lo que deja».",
        nota: `Solo los gastos registrados, sin comisiones: ${w.pct(expenses, income)}.`,
        datos: { cobrado: collected.total, gastos: spent.total, comisiones: commissions.total },
      }
    },

    g021: async () => {
      const result = await h.fig("lo_que_deja", "sede")
      const collected = await h.fig("cobrado", "sede")
      const spent = await h.fig("gastos", "sede")
      const last = await h.fig("lo_que_deja", "sede", "mes_pasado")
      const top = result.rows[0]
      const of = (list: FigureResult, key: string) => centsOf(list.rows.find((row) => row.key === key))
      const idle = spent.rows.filter((row) => centsOf(row) === 0 && of(collected, row.key) === 0).map((row) => row.label)
      const noExpenses = spent.rows.filter((row) => centsOf(row) === 0 && of(collected, row.key) !== 0).map((row) => row.label)
      return {
        respuesta: `Este mes (${w.monthSoFar}) la sede que más deja es ${top?.label ?? "—"}: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))} (lo cobrado menos comisiones y gastos registrados de cada sede). Puede faltar algún gasto que no se anotó.`,
        criterio: "«Lo que deja el mes» de Reportes por sede, del mes en curso: lo cobrado − comisiones − gastos registrados de cada sede.",
        nota: noteOf([
          idle.length ? `${idle.join(" y ")} no ${idle.length === 1 ? "tiene" : "tienen"} cobros ni gastos registrados este mes.` : null,
          noExpenses.length ? `${noExpenses.join(" y ")} no ${noExpenses.length === 1 ? "tiene" : "tienen"} gastos registrados este mes.` : null,
          `Restando solo los gastos, sin comisiones: ${listOf(collected.rows.map((row) => ({ name: row.label, value: money(centsOf(row) - of(spent, row.key)) })))}.`,
          `En ${w.previousMonth} completo: ${listOf(last.rows.map((row) => ({ name: row.label, value: show(last, row.value.value) })))}.`,
        ]),
        datos: { deja: result.rows, cobrado: collected.rows, gastos: spent.rows, mesPasado: last.rows },
      }
    },

    g022: async () => {
      const { branch, all } = await branchNamed("Surco")
      if (!branch) return noBranch("Surco", all)
      const result = await figIn("cobrado", "medio", "este_mes", branch.id)
      const last = await figIn("cobrado", "medio", "mes_pasado", branch.id)
      const yape = centsOf(rowNamed(result, /yape/i))
      const cash = centsOf(rowNamed(result, /efectivo/i))
      const paid = await paymentsIn(h.monthStart, nowIso, sql`and p.branch_id = ${branch.id}`)
      const yapeCount = paid.of(/yape/i).count
      const cashCount = paid.of(/efectivo/i).count
      const winner = yape > cash ? "Yape" : cash > yape ? "efectivo" : null
      const byCount = yapeCount > cashCount ? "Yape" : cashCount > yapeCount ? "efectivo" : null
      if (!paid.count) {
        // Sin pagos en la sede no hay comparación: se dice y se da lo de toda la clínica.
        const [ever] = await h.tx.execute<{ count: number }>(sql`
          select count(*)::int as count from patient_payment p where p.organization_id = ${h.org} and p.branch_id = ${branch.id}`)
        const clinic = await h.fig("cobrado", "medio")
        const all = await paymentsIn(h.monthStart, nowIso)
        return {
          respuesta: `Este mes (${w.monthSoFar}) en ${branch.name} no hay pagos registrados${ever?.count ? "" : " (la sede todavía no tiene ningún cobro)"}, así que no hay con qué comparar. En toda la clínica este mes: ${money(centsOf(rowNamed(clinic, /yape/i)))} por Yape (${plural(all.of(/yape/i).count, "pago", "pagos")}) contra ${money(centsOf(rowNamed(clinic, /efectivo/i)))} en efectivo (${plural(all.of(/efectivo/i).count, "pago", "pagos")}).`,
          criterio: "«Lo cobrado» de Reportes por medio de pago con esa sede elegida, del mes en curso: la sede no tiene pagos, y se da lo de toda la clínica.",
          datos: { sede: branch, pagosEnLaSede: ever?.count ?? 0, clinica: clinic.rows },
        }
      }
      return {
        respuesta: `Este mes (${w.monthSoFar}) en ${branch.name} ${winner ? `se paga más ${winner === "Yape" ? "con Yape" : "en efectivo"}` : "se paga lo mismo con Yape que en efectivo"}: ${money(yape)} por Yape (${plural(yapeCount, "pago", "pagos")}) contra ${money(cash)} en efectivo (${plural(cashCount, "pago", "pagos")}).`,
        criterio: "«Lo cobrado» de Reportes por medio de pago con esa sede elegida, del mes en curso (pagos menos anulaciones y devoluciones): Yape contra Efectivo, por importe.",
        nota: noteOf([
          byCount !== winner ? `Por cantidad de pagos ${byCount ? `gana ${byCount}` : "empatan"}.` : null,
          `En ${w.previousMonth} completo: ${money(centsOf(rowNamed(last, /yape/i)))} por Yape y ${money(centsOf(rowNamed(last, /efectivo/i)))} en efectivo. Todos los medios este mes en la sede: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        ]),
        datos: { sede: branch, yape, efectivo: cash, pagos: paid.list, medios: result.rows, mesPasado: last.rows },
      }
    },

    g023: async () => {
      const result = await h.fig("comisiones", "profesional", "este_ano")
      const row = rowNamed(result, /luis prado/i)
      const report = await getReportCommissions(h.tx, h.org, { period: "este_ano" }, h.now)
      const mine = report.rows.find((item) => /luis prado/i.test(item.name))
      if (!row && !mine)
        return {
          respuesta: `En lo que va del año (${yearSoFar}) Luis Prado no tiene comisiones.`,
          criterio: "«Las comisiones» de Reportes por profesional, de este año hasta hoy.",
          datos: { filas: result.rows },
        }
      return {
        respuesta: `En lo que va del año (${yearSoFar}) Luis Prado lleva ${money(centsOf(row))} en comisiones: el ${rate(mine?.rateBps ?? 0)} de ${money(mine?.collectedCents ?? 0)} cobrados de lo que atendió.`,
        criterio: "«Las comisiones» de Reportes por profesional, de este año hasta hoy: su porcentaje sobre lo cobrado de lo que atendió (la cuenta de Finanzas › Comisiones).",
        nota: `De eso ya se le pagó ${money(mine?.paidCents ?? 0)} y falta pagarle ${money(mine?.pendingCents ?? 0)}.`,
        datos: { comision: row?.value ?? null, detalle: mine ?? null },
      }
    },

    g024: async () => {
      type Closure = { branch: string; time: string; day: string; cash: number; refunded: number; expected: number; counted: number; difference: number; methods: ClosureMethod[] }
      const closures = (where: SQL, limit: number) =>
        h.tx.execute<Closure>(sql`
          select b.name as branch, to_char(c.closed_at at time zone ${h.tz}, 'HH24:MI') as time, to_char(${h.dayOf(sql`c.closed_at`)}, 'YYYY-MM-DD') as day,
            c.cash_collected_cents as cash, c.cash_refunded_cents as refunded, c.expected_cents as expected, c.counted_cents as counted,
            c.difference_cents as difference, c.totals_by_method as methods
          from cash_closure c join branch b on b.organization_id = c.organization_id and b.id = c.branch_id
          where c.organization_id = ${h.org} and c.currency = ${currency} and ${where}
          order by c.closed_at desc limit ${limit}`)
      const today = [...(await closures(sql`${h.dayOf(sql`c.closed_at`)} = ${h.today}`, 50))].reverse()
      const [previous] = await closures(sql`${h.dayOf(sql`c.closed_at`)} < ${h.today}`, 1)
      const open = await h.tx.execute<{ branch: string; opened: string }>(sql`
        select b.name as branch, s.opened_at::text as opened from cash_shift s join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
        where s.organization_id = ${h.org} and s.status = 'abierta' and s.currency = ${currency} order by b.name`)
      const collected = await h.fig("cobrado", "medio", `${todayKey}..${todayKey}`)
      const differenceWords = (cents: number) =>
        cents === 0 ? "sin diferencia" : cents < 0 ? `faltaron ${money(-cents)}` : `sobraron ${money(cents)}`
      const closureWords = (row: Closure) =>
        `${row.branch} cerró a las ${row.time}: en efectivo se cobraron ${money(row.cash)}${row.refunded ? ` y se devolvieron ${money(row.refunded)}` : ""}${row.methods.length ? `; ${listOf(row.methods.map((method) => ({ name: method.name, value: `${money(method.amountCents)}, ${plural(method.count, "pago", "pagos")}${method.refundedCents ? `, devuelto ${money(method.refundedCents)}` : ""}` })))}` : ""}; en el cajón se esperaban ${money(row.expected)} y se contaron ${money(row.counted)} (${differenceWords(row.difference)})`
      const openWords = open.length
        ? ` Sigue abierta la caja de ${open.map((row) => `${row.branch} desde el ${w.dayWords(dayKeyOf(new Date(row.opened)))} a las ${timeOf(new Date(row.opened))}`).join(" y de ")}.`
        : ""
      const collectedWords = collected.rows.length
        ? `lo cobrado hoy hasta ahora, por medio de pago, es ${listOf(collected.rows.map((row) => ({ name: row.label, value: show(collected, row.value.value) })))}; en total, ${show(collected)}`
        : "todavía no hay pagos de hoy"
      return {
        respuesta: today.length
          ? `El cierre de caja de hoy (${w.dayWords(todayKey)}): ${today.map(closureWords).join(". ")}.`
          : `Hoy (${w.dayWords(todayKey)}) todavía no se cerró la caja en ninguna sede.${openWords} ${collected.rows.length ? `Sin cierre, ${collectedWords}.` : "Tampoco hay pagos de hoy todavía."}`,
        criterio: "Los cierres de caja de hoy (`cash_closure`: el efectivo cobrado, devuelto, esperado y contado, y los demás medios con su total); sin cierre, lo cobrado hoy de Reportes por medio de pago.",
        nota: noteOf([
          today.length ? `En Reportes (toda la clínica, también lo que no pasó por caja), ${collectedWords}.` : null,
          previous ? `El último cierre anterior fue el ${w.dayWords(previous.day)}: ${closureWords(previous)}.` : null,
        ]),
        datos: { cierresHoy: today, abiertas: open, cobradoHoy: collected.rows, ultimoCierre: previous ?? null },
      }
    },

    g025: async () => {
      const result = await h.fig("te_deben", "antiguedad")
      const old = result.rows.find((row) => row.key === "90_plus")
      const list = await getReportList(h.tx, h.org, { period: "este_mes", list: "debts_age_90_plus", limit: 5000 }, h.now)
      const rows = [...list.rows].sort((a, b) => (b.cents ?? 0) - (a.cents ?? 0) || a.personName.localeCompare(b.personName))
      const threeMonths = new Date(h.now)
      threeMonths.setUTCMonth(threeMonths.getUTCMonth() - 3)
      const calendar = (await debtors()).filter((row) => new Date(row.since) < threeMonths)
      const shown = rows.slice(0, 10)
      return {
        respuesta: rows.length
          ? `Sí: hoy ${plural(old?.value.part ?? rows.length, "persona debe", "personas deben")} desde hace más de 90 días, ${money(centsOf(old))} en total (descontando lo que tienen a favor): ${listOf(shown.map((row) => ({ name: row.personName, value: `${money(row.cents)}, desde el ${sinceWords(row.at)}` })))}${rows.length > shown.length ? ` y ${rows.length - shown.length} más` : ""}.`
          : "No: hoy nadie debe desde hace más de 90 días.",
        criterio: "«Te deben» de Reportes por antigüedad, a hoy, el tramo «Más de 90 días» (por el concepto sin pagar más antiguo de cada persona), con su lista.",
        nota: `Contando 3 meses de calendario (antes del ${longDay(dayKeyOf(threeMonths))}): ${plural(calendar.length, "persona", "personas")}, ${money(calendar.reduce((sum, row) => sum + row.cents, 0))}. Por tramo: ${listOf(result.rows.map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${plural(row.value.part ?? 0, "persona", "personas")}` })))}.`,
        datos: { masDe90: old?.value ?? null, lista: rows, tresMeses: calendar, tramos: result.rows },
      }
    },
  }
}
