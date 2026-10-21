/** Respuestas correctas de las ventas y la caja (eval/argos-owner.json). */
import { getReportList } from "@odentia/services"
import { sql } from "drizzle-orm"
import { collectedByDay, dayStart, goldenWords, NO_INVOICES } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

/** Los tipos UN/CEFACT 4461 que el dueño nombra, en su orden (`method_type_code` del pago, congelado al cobrar). */
const NAMED_METHODS: Array<{ code: string; name: string }> = [
  { code: "10", name: "efectivo" },
  { code: "48", name: "tarjeta" },
  { code: "30", name: "transferencia" },
]

export function salesSolvers(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const { money, show, listOf } = h
  /** Lo vendido (criterio 3): pagos vigentes aplicados a tratamientos y productos sin anular, de los pagos de un tramo. */
  const soldIn = (where: ReturnType<typeof sql>) =>
    h.tx.execute<{ name: string; sales: number; cents: string }>(sql`
      select ${h.conceptName} as name, count(distinct c.id)::int as sales, sum(a.amount_cents)::text as cents
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
      ${h.conceptJoins}
      where a.organization_id = ${h.org} and a.voided_at is null and pay.currency = ${h.scope.currency} and ${where}
      group by 1 order by sum(a.amount_cents) desc, 1`)
  const totals = (rows: Array<{ sales: number; cents: string }>) => ({
    sales: rows.reduce((sum, row) => sum + row.sales, 0),
    cents: rows.reduce((sum, row) => sum + Number(row.cents), 0),
  })
  /** Lo cargado a los pacientes (pagado o no) en un tramo, sin anulados. */
  const chargedIn = async (start: string, end: string) => {
    const [row] = await h.tx.execute<{ count: number; cents: string }>(sql`
      select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
      where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency}
        and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz`)
    return { count: row?.count ?? 0, cents: Number(row?.cents ?? 0) }
  }
  /** Lo que deben las personas hoy, de mayor a menor: las listas de «Te deben» por antigüedad juntas. */
  const debtors = async () => {
    const lists = await Promise.all(
      (["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus"] as const).map(
        (list) => getReportList(h.tx, h.org, { period: "este_mes", list, limit: 5000 }, h.now),
      ),
    )
    return lists
      .flatMap((list) => list.rows)
      .sort((a, b) => (b.cents ?? 0) - (a.cents ?? 0) || a.personName.localeCompare(b.personName))
  }
  /** Si el corte de una lista parte un empate, lo dice: cuántos tienen el último importe y cuántos entraron. */
  const tieWords = (all: Array<{ cents: number }>, shown: number, order: string): string => {
    const cut = all[Math.min(shown, all.length) - 1]
    if (!cut || all.length <= shown) return ""
    const tied = all.filter((row) => row.cents === cut.cents).length
    const inside = all.slice(0, shown).filter((row) => row.cents === cut.cents).length
    return tied > inside
      ? ` Con ${money(cut.cents)} hay ${tied} empatados: aquí van ${inside}, ${order}.`
      : ""
  }
  /** «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`

  return {
    v1: async () => {
      const month = await collectedByDay(h, h.monthStart, w.nowIso)
      const year = await collectedByDay(h, await dayStart(h, w.yearAgoKey), w.nowIso)
      const top = (rows: typeof month) =>
        [...rows]
          .filter((row) => row.cents > 0)
          .sort((a, b) => b.cents - a.cents || a.day.localeCompare(b.day))
          .slice(0, 10)
      const charged = await h.tx.execute<{ day: string; cents: string }>(sql`
        select to_char(d.day, 'YYYY-MM-DD') as day, sum(d.cents)::text as cents
        from (select ${h.dayOf(sql`c.created_at`)} as day, c.amount_cents::bigint as cents from patient_charge c
          where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency}
            and c.created_at >= ${h.monthStart}::timestamptz and c.created_at < ${w.nowIso}::timestamptz) d
        group by d.day order by sum(d.cents) desc, d.day limit 3`)
      const monthTop = top(month)
      const yearTop = top(year)
      const words = (rows: typeof month) =>
        rows
          .map((row, index) => `${index + 1}) ${w.dayWords(row.day)}, ${money(row.cents)}`)
          .join("; ")
      return {
        respuesta: `${NO_INVOICES}; por lo cobrado, los ${monthTop.length} días con más ingresos de este mes (${w.monthSoFar}) son: ${words(monthTop)}. Hubo cobros en ${month.filter((row) => row.cents > 0).length} días del mes.`,
        criterio:
          "«Lo cobrado» (pagos menos anulaciones y devoluciones) de cada día de la clínica del mes en curso, de mayor a menor; sumados dan la cifra del mes.",
        nota: `En los últimos 365 días: ${words(yearTop)}. Si «facturación» es lo cargado a los pacientes (pagado o no), este mes: ${listOf(charged.map((row) => ({ name: w.dayWords(row.day), value: money(Number(row.cents)) })))}.`,
        datos: { mes: monthTop, doceMeses: yearTop, cargado: charged },
      }
    },

    v2: async () => {
      const sold = await soldIn(sql`${h.dayOf(sql`pay.paid_at`)} = ${h.today}`)
      const collected = await h.fig("cobrado", "total", `${w.todayKey}..${w.todayKey}`)
      const charged = await chargedIn(await dayStart(h, w.todayKey), w.nowIso)
      const [last] = await h.tx.execute<{ day: string }>(sql`
        select to_char(max(${h.dayOf(sql`pay.paid_at`)}), 'YYYY-MM-DD') as day from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
        where a.organization_id = ${h.org} and a.voided_at is null and ${h.dayOf(sql`pay.paid_at`)} < ${h.today}`)
      const before = last?.day
        ? await soldIn(sql`${h.dayOf(sql`pay.paid_at`)} = ${last.day}::date`)
        : []
      const today = totals(sold)
      const previous = totals(before)
      const top = listOf(
        sold.slice(0, 3).map((row) => ({ name: row.name, value: money(Number(row.cents)) })),
      )
      return {
        respuesta: today.sales
          ? `Hoy (${w.dayWords(w.todayKey)}) se vendieron ${money(today.cents)}: ${today.sales} ${today.sales === 1 ? "tratamiento o producto pagado" : "tratamientos y productos pagados"}, sobre todo ${top}.`
          : `Hoy (${w.dayWords(w.todayKey)}, hasta ahora) todavía no se vendió nada: no hay pagos de hoy aplicados a tratamientos ni productos.`,
        criterio:
          "Lo vendido hoy (día de la clínica): pagos vigentes de hoy aplicados a tratamientos y productos sin anular, sin lo devuelto.",
        nota: `Lo cobrado hoy de Reportes (con adelantos y saldo a favor): ${show(collected)}. Lo cargado hoy, pagado o no: ${money(charged.cents)} en ${charged.count} conceptos.${last?.day ? ` El último día con ventas fue el ${w.dayWords(last.day)}: ${money(previous.cents)} en ${previous.sales} ventas (${listOf(before.slice(0, 3).map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}).` : ""}`,
        datos: {
          vendido: sold,
          cobrado: collected.total,
          cargado: charged,
          ultimoDia: last?.day ?? null,
          vendidoUltimoDia: before,
        },
      }
    },

    v3: async () => {
      const weekday = new Date(`${w.todayKey}T12:00:00Z`).getUTCDay()
      const monday = w.addDays(w.todayKey, -((weekday + 6) % 7))
      const result = await h.fig("cobrado", "total", `${monday}..${w.todayKey}`)
      const lastWeek = await h.fig(
        "cobrado",
        "total",
        `${w.addDays(monday, -7)}..${w.addDays(w.todayKey, -7)}`,
      )
      const sevenDays = await h.fig(
        "cobrado",
        "total",
        `${w.addDays(w.todayKey, -6)}..${w.todayKey}`,
      )
      const charged = await chargedIn(await dayStart(h, monday), w.nowIso)
      return {
        respuesta: `${NO_INVOICES}; por lo cobrado, esta semana (${spanWords(monday, w.todayKey)}, hasta ahora) entraron ${show(result)}, sin lo anulado ni lo devuelto.`,
        criterio:
          "«Lo cobrado» de Reportes de esta semana: del lunes a hoy, en el día de la clínica.",
        nota: `La semana pasada en los mismos días, completos (${spanWords(w.addDays(monday, -7), w.addDays(w.todayKey, -7))}): ${show(lastWeek)}. Los últimos 7 días (${spanWords(w.addDays(w.todayKey, -6), w.todayKey)}): ${show(sevenDays)}. Lo cargado esta semana a los pacientes (pagado o no): ${money(charged.cents)} en ${charged.count} conceptos.`,
        datos: {
          semana: result.total,
          desde: monday,
          semanaPasada: lastWeek.total,
          sieteDias: sevenDays.total,
          cargado: charged,
        },
      }
    },

    v4: async () => {
      const result = await h.fig("cobrado", "medio")
      const total = result.total.value ?? 0
      const counts = await h.tx.execute<{ name: string; count: number }>(sql`
        select pay.method_name as name, count(*)::int as count from patient_payment pay
        where pay.organization_id = ${h.org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${w.nowIso}::timestamptz
        group by 1 order by 2 desc, 1`)
      const applied = await h.tx.execute<{ name: string; cents: string }>(sql`
        select pay.method_name as name, sum(a.amount_cents)::text as cents from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
        where a.organization_id = ${h.org} and a.voided_at is null and pay.currency = ${h.scope.currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${w.nowIso}::timestamptz
        group by 1 order by sum(a.amount_cents) desc, 1`)
      // Lo cobrado que todavía no se aplicó a un tratamiento o producto (adelantos, saldo a favor), por medio.
      const loose = result.rows
        .map((row) => ({
          name: row.label,
          cents:
            (row.value.value ?? 0) -
            Number(applied.find((item) => item.name === row.label)?.cents ?? 0),
        }))
        .filter((row) => row.cents > 0)
      return {
        respuesta: `Este mes (${w.monthSoFar}) lo cobrado por medio de pago es: ${listOf(result.rows.map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${w.pct(row.value.value ?? 0, total)}` })))}; en total, ${show(result)}.${loose.length ? ` De eso, ${loose.map((row) => `${money(row.cents)} (${row.name})`).join(" y ")} aún no se aplica a ningún tratamiento ni producto: son adelantos o saldo a favor.` : ""}`,
        criterio:
          "«Lo cobrado» de Reportes por medio de pago (pagos menos anulaciones y devoluciones de cada medio), del mes en curso.",
        nota: `Por cantidad de pagos: ${listOf(counts.map((row) => ({ name: row.name, value: `${row.count} pagos` })))}. Si «vendimos» es solo lo pagado aplicado a tratamientos y productos (sin adelantos ni lo que queda a favor): ${listOf(applied.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}.`,
        datos: { filas: result.rows, total: result.total, pagos: counts, aplicado: applied },
      }
    },

    v5: async () => {
      /** Los tickets sin anular de un tramo (su total) y, donde un pago no tiene ticket, el pago. */
      const docs = (start: string) => sql`
        with docs as (
          select t.ticket_number as number, t.patient_id, t.created_at as at, t.total_cents::bigint as cents,
            (select string_agg(distinct p.method_name, ' + ') from patient_payment p where p.organization_id = t.organization_id and p.ticket_id = t.id and p.voided_at is null) as methods
          from payment_ticket t
          where t.organization_id = ${h.org} and t.voided_at is null and t.currency = ${h.scope.currency}
            and t.created_at >= ${start}::timestamptz and t.created_at < ${w.nowIso}::timestamptz
          union all
          select null, p.patient_id, p.paid_at, p.amount_cents::bigint, p.method_name from patient_payment p
          where p.organization_id = ${h.org} and p.voided_at is null and p.ticket_id is null and p.currency = ${h.scope.currency}
            and p.paid_at >= ${start}::timestamptz and p.paid_at < ${w.nowIso}::timestamptz)`
      const month = await h.tx.execute<{
        number: number | null
        person: string
        day: string
        methods: string
        cents: string
        total: number
        tied: number
      }>(sql`
        ${docs(h.monthStart)}
        select x.* from (
          select d.number, pp.display_name as person, to_char(${h.dayOf(sql`d.at`)}, 'YYYY-MM-DD') as day, coalesce(d.methods, 'Saldo a favor') as methods,
            d.cents::text as cents, d.at, count(*) over()::int as total, count(*) over (partition by d.cents)::int as tied
          from docs d ${h.joinPerson(sql`d.patient_id`)}) x
        order by x.cents::bigint desc, x.at desc limit 10`)
      const year = await h.tx.execute<{ cents: string; count: number }>(sql`
        ${docs(await dayStart(h, w.yearAgoKey))}
        select d.cents::text as cents, count(*)::int as count from docs d group by d.cents order by d.cents desc limit 3`)
      const [kept] = await h.tx.execute<{
        count: number
        number: number | null
        cents: string | null
        person: string | null
      }>(sql`
        select count(*) over()::int as count, t.ticket_number as number, t.total_cents::text as cents, pp.display_name as person
        from payment_ticket t ${h.joinPerson(sql`t.patient_id`)}
        where t.organization_id = ${h.org} and t.voided_at is null and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${w.nowIso}::timestamptz
        order by t.total_cents desc, t.ticket_number limit 1`)
      const last = month.at(-1)
      const inside = last ? month.filter((row) => row.cents === last.cents).length : 0
      return {
        respuesta: `${NO_INVOICES}, así que no hay facturas. Los ${month.length} tickets de mayor importe de este mes (${w.monthSoFar}), contando como ticket cada pago que no lo tiene: ${month
          .map(
            (row, index) =>
              `${index + 1}) ${row.number ? `ticket N.º ${row.number}, ` : ""}${row.person}, ${money(Number(row.cents))} (${w.dayWords(row.day)}, ${row.methods})`,
          )
          .join(
            "; ",
          )}. En el mes hay ${month[0]?.total ?? 0} entre tickets y pagos.${last && last.tied > inside ? ` Con ${money(Number(last.cents))} hay ${last.tied} empatados: aquí van los ${inside} más recientes.` : ""}`,
        criterio:
          "Trampa: no hay facturas. Se ofrecen los tickets del mes en curso sin anular (su total) y, donde un pago no tiene ticket, el pago, de mayor a menor importe.",
        nota: `Tickets numerados guardados este mes: ${kept?.count ?? 0}${kept?.number ? ` (el mayor, el N.º ${kept.number} de ${kept.person}, por ${money(Number(kept.cents ?? 0))})` : ""}; la historia de prueba guarda los pagos sin ticket. En los últimos 365 días, los importes más altos: ${listOf(year.map((row) => ({ name: money(Number(row.cents)), value: `${row.count} ${row.count === 1 ? "ticket" : "tickets"}` })))}.`,
        datos: { mes: month, doceMeses: year, ticketsGuardados: kept ?? null },
      }
    },

    v6: async () => {
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const coming = await h.fig("lo_que_viene")
      const rows = await debtors()
      return {
        respuesta: `Hoy los pacientes te deben ${show(owed)} (${owed.total.part ?? rows.length} personas), descontando lo que tienen a favor. Los que más deben: ${listOf(rows.slice(0, 5).map((row) => ({ name: row.personName, value: money(row.cents) })))}.${tieWords(
          rows.map((row) => ({ cents: row.cents ?? 0 })),
          5,
          "por orden alfabético",
        )}`,
        criterio:
          "«Te deben» de Reportes › Finanzas, a hoy (lo cargado menos lo pagado y lo que tienen a favor), con sus listas por antigüedad.",
        nota: `De eso, ${show(overdue)} es de hace más de 30 días (${overdue.total.part ?? 0} personas). Aparte, lo aceptado en presupuestos que falta hacer y aún no se carga («Lo que viene»): ${show(coming)}.`,
        datos: {
          teDeben: owed.total,
          vencido: overdue.total,
          loQueViene: coming.total,
          primeros: rows.slice(0, 10),
        },
      }
    },

    v7: async () => {
      const owed = await h.fig("te_deben")
      const rows = await debtors()
      const overdue = await getReportList(
        h.tx,
        h.org,
        { period: "este_mes", list: "debts_overdue", limit: 5000 },
        h.now,
      )
      const since = (iso: string) =>
        new Intl.DateTimeFormat(h.scope.locale, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          timeZone: h.tz,
        }).format(new Date(iso))
      const oldest = [...rows].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 3)
      return {
        respuesta: `Los 10 pacientes que más deben hoy: ${rows
          .slice(0, 10)
          .map((row, index) => `${index + 1}) ${row.personName}, ${money(row.cents)}`)
          .join("; ")}.${tieWords(
          rows.map((row) => ({ cents: row.cents ?? 0 })),
          10,
          "por orden alfabético",
        )} En total, ${rows.length} personas te deben ${show(owed)}.`,
        criterio:
          "Las listas de «Te deben» de Reportes (todas las antigüedades), a hoy, por lo que debe cada persona descontando lo que tiene a favor.",
        nota: `Solo lo vencido (más de 30 días), los que más deben: ${listOf(
          [...overdue.rows]
            .sort((a, b) => (b.cents ?? 0) - (a.cents ?? 0))
            .slice(0, 3)
            .map((row) => ({ name: row.personName, value: money(row.cents) })),
        )}. Por la deuda más antigua: ${listOf(oldest.map((row) => ({ name: row.personName, value: `${money(row.cents)} desde el ${since(row.at)}` })))}.`,
        datos: {
          primeros: rows.slice(0, 10),
          total: owed.total,
          vencidos: overdue.rows.slice(0, 10),
        },
      }
    },

    v8: async () => {
      /** Lo cobrado por tipo de medio, con la regla de «cobrado» por medio (`collectedByMethod`). */
      const byType = (start: string, end: string) =>
        h.tx.execute<{ code: string | null; name: string; cents: string; count: number }>(sql`
          select x.code, x.name, sum(x.cents)::text as cents, count(*) filter (where x.cents > 0)::int as count from (
            select p.method_type_code as code, p.method_name as name, p.amount_cents::bigint as cents from patient_payment p
            where p.organization_id = ${h.org} and p.currency = ${h.scope.currency}
              and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
              and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
            union all
            select p.method_type_code, p.method_name, -p.amount_cents::bigint from patient_payment p
            where p.organization_id = ${h.org} and p.currency = ${h.scope.currency} and p.paid_at < ${start}::timestamptz
              and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz
            union all
            select p.method_type_code, p.method_name, -r.amount_cents::bigint from patient_payment_refund r
            join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
            where r.organization_id = ${h.org} and p.currency = ${h.scope.currency}
              and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz
          ) x group by 1, 2 order by sum(x.cents) desc`)
      const group = (rows: Awaited<ReturnType<typeof byType>>) => {
        const named = NAMED_METHODS.map(({ code, name }) => ({
          name,
          cents: rows
            .filter((row) => row.code === code)
            .reduce((sum, row) => sum + Number(row.cents), 0),
          count: rows.filter((row) => row.code === code).reduce((sum, row) => sum + row.count, 0),
        }))
        const others = rows
          .filter((row) => !NAMED_METHODS.some((method) => method.code === row.code))
          .map((row) => ({ name: row.name, cents: Number(row.cents), count: row.count }))
        return { named, others, total: rows.reduce((sum, row) => sum + Number(row.cents), 0) }
      }
      const month = group(await byType(h.monthStart, w.nowIso))
      const yearStart = await dayStart(h, `${w.todayKey.slice(0, 4)}-01-01`)
      const year = group(await byType(yearStart, w.nowIso))
      const screen = await h.fig("cobrado", "medio")
      const three = (part: ReturnType<typeof group>) =>
        part.named.reduce((sum, row) => sum + row.cents, 0)
      const [cash, card, transfer] = month.named
      const words = (part: ReturnType<typeof group>) =>
        listOf(
          [...part.named, ...part.others].map((row) => ({
            name: row.name,
            value: `${money(row.cents)}, ${w.pct(row.cents, part.total)}`,
          })),
        )
      return {
        respuesta: `Este mes (${w.monthSoFar}) cobraste ${money(cash?.cents ?? 0)} en efectivo, ${money(card?.cents ?? 0)} con tarjeta y ${money(transfer?.cents ?? 0)} por transferencia: ${money(three(month))} entre los tres.${month.others.length ? ` Además entraron ${month.others.map((row) => `${money(row.cents)} por ${row.name}`).join(", ")}, que no ${month.others.length === 1 ? "es" : "son"} ninguno de los tres; en total, ${money(month.total)}.` : ""}`,
        criterio:
          "«Lo cobrado» del mes en curso por tipo de medio (UN/CEFACT 4461 del pago: 10 efectivo, 48 tarjeta, 30 transferencia), pagos menos anulaciones y devoluciones; los demás medios, aparte.",
        nota: `En lo que va del año (desde el 1 de enero): ${words(year)}; en total ${money(year.total)}. Por cantidad de pagos este mes: ${listOf([...month.named, ...month.others].map((row) => ({ name: row.name, value: `${row.count}` })))}.`,
        datos: { mes: month, año: year, reportes: screen.rows, cobrado: screen.total },
      }
    },
  }
}
