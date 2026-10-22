/** Respuestas correctas de las comparaciones en el tiempo (eval/argos-owner.json). */
import { addDays, collectedByProfessional, collectedNetMany, dayStart, type FigureResult, reportDayOf, type Span } from "@odentia/services"
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

/** Lo vendido de un concepto en dos tramos: lo pagado de lo cargado (sin anulados ni lo devuelto). */
export interface ConceptSales {
  name: string
  kind: "tratamiento" | "producto"
  units: number
  cents: number
  prevUnits: number
  prevCents: number
}

/**
 * Lo pagado en cada tramo de cada tratamiento o producto (como o1/o2): las
 * aplicaciones vigentes de pagos vigentes con fecha de pago en el tramo, sobre
 * cargos no anulados. Las unidades son las del cargo que recibió un pago en el tramo.
 */
export async function salesByConcept(h: GoldenHelpers, current: Span, previous: Span): Promise<ConceptSales[]> {
  const cs = current.start.toISOString()
  const ce = current.end.toISOString()
  const ps = previous.start.toISOString()
  const pe = previous.end.toISOString()
  const rows = await h.tx.execute<{ name: string; kind: "tratamiento" | "producto"; units: number; cents: string; prev_units: number; prev_cents: string }>(sql`
    with paid as (
      select a.charge_id,
        coalesce(sum(a.amount_cents) filter (where pay.paid_at >= ${cs}::timestamptz and pay.paid_at < ${ce}::timestamptz), 0)::bigint as cur,
        coalesce(sum(a.amount_cents) filter (where pay.paid_at >= ${ps}::timestamptz and pay.paid_at < ${pe}::timestamptz), 0)::bigint as prev
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      where a.organization_id = ${h.org} and a.voided_at is null
        and ((pay.paid_at >= ${cs}::timestamptz and pay.paid_at < ${ce}::timestamptz) or (pay.paid_at >= ${ps}::timestamptz and pay.paid_at < ${pe}::timestamptz))
      group by a.charge_id)
    select ${h.conceptName} as name, case when c.product_id is null then 'tratamiento' else 'producto' end as kind,
      coalesce(sum(coalesce(c.product_quantity, ep.quantity, 1)) filter (where paid.cur > 0), 0)::int as units,
      sum(paid.cur)::text as cents,
      coalesce(sum(coalesce(c.product_quantity, ep.quantity, 1)) filter (where paid.prev > 0), 0)::int as prev_units,
      sum(paid.prev)::text as prev_cents
    from paid join patient_charge c on c.organization_id = ${h.org} and c.id = paid.charge_id and c.voided_at is null and c.currency = ${h.scope.currency}
    ${h.conceptJoins}
    group by 1, 2`)
  return rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    units: row.units,
    cents: Number(row.cents),
    prevUnits: row.prev_units,
    prevCents: Number(row.prev_cents),
  }))
}

/** «+S/ 1,200.00» o «−S/ 300.00». */
export function signedMoney(h: GoldenHelpers, cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${h.money(Math.abs(cents))}`
}

/** Cambio porcentual redondeado, con signo; null si no había con qué comparar. */
export function changePct(current: number, previous: number): string | null {
  if (previous === 0) return null
  const value = Math.round(((current - previous) / previous) * 100)
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)} %`
}

/** Nombre del mes («septiembre de 2026»), en minúscula: el mes solo sale con mayúscula en algunas regiones. */
export function monthLabel(h: GoldenHelpers, month: { year: number; month: number }, withYear = true): string {
  return new Intl.DateTimeFormat(h.scope.locale, { month: "long", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" })
    .format(new Date(Date.UTC(month.year, month.month - 1, 15)))
    .toLocaleLowerCase(h.scope.locale)
}

/** Los días que compara Reportes: «del 1 al 21 de octubre», «del 1 al 21 de septiembre» y «los mismos días de septiembre». */
export function sameDaysWords(h: GoldenHelpers): { current: string; previous: string; sameAs: string } {
  const { window, timezone } = h.scope
  const lastOf = (end: Date) => Number(reportDayOf(timezone, new Date(end.getTime() - 1)).slice(8))
  return {
    current: `del 1 al ${lastOf(window.end)} de ${monthLabel(h, window.from, false)}`,
    previous: `del 1 al ${lastOf(window.previous.end)} de ${monthLabel(h, window.previous.from, false)}`,
    sameAs: `los mismos días de ${monthLabel(h, window.previous.from, false)}`,
  }
}

/** Cada día civil de `from` a `to` como tramo; el de hoy termina ahora. */
function daySpans(h: GoldenHelpers, from: string, to: string): Array<Span & { day: string }> {
  const out: Array<Span & { day: string }> = []
  const startOf = (day: string) => {
    const [year, month, date] = day.split("-").map(Number) as [number, number, number]
    return dayStart(h.tz, year, month, date)
  }
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const next = startOf(addDays(day, 1))
    out.push({ day, start: startOf(day), end: next.getTime() > h.now.getTime() ? h.now : next })
  }
  return out
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

export function trendSolvers(h: GoldenHelpers): GoldenSolvers {
  const { window } = h.scope
  const days = sameDaysWords(h)

  /** Lo vendido de tratamientos o productos, del mes en curso contra los mismos días del anterior. */
  const sameDaysSales = async (kind: ConceptSales["kind"]) => (await salesByConcept(h, window, window.previous)).filter((row) => row.kind === kind)

  /** Tratamientos que más subieron (`up`) o más bajaron en lo pagado, mes en curso contra los mismos días del anterior. */
  const treatmentMoves = async (direction: "up" | "down") => {
    const rows = await sameDaysSales("tratamiento")
    const moved = rows
      .map((row) => ({ ...row, change: row.cents - row.prevCents, timesChange: row.units - row.prevUnits }))
      .filter((row) => (direction === "up" ? row.change > 0 : row.change < 0))
      .sort((a, b) => (direction === "up" ? b.change - a.change : a.change - b.change) || a.name.localeCompare(b.name))
    const byTimes = rows
      .map((row) => ({ ...row, timesChange: row.units - row.prevUnits }))
      .filter((row) => (direction === "up" ? row.timesChange > 0 : row.timesChange < 0))
      .sort((a, b) => (direction === "up" ? b.timesChange - a.timesChange : a.timesChange - b.timesChange) || a.name.localeCompare(b.name))
    return { rows, moved, byTimes }
  }

  /** Los 3 meses completos y los 3 anteriores, por tratamiento (lo pagado). */
  const quarterSales = async () => {
    const [range] = await h.tx.execute<{ recent_start: string; recent_end: string; earlier_start: string }>(sql`
      select ((date_trunc('month', now() at time zone ${h.tz}) - interval '3 months') at time zone ${h.tz})::text as recent_start,
        (date_trunc('month', now() at time zone ${h.tz}) at time zone ${h.tz})::text as recent_end,
        ((date_trunc('month', now() at time zone ${h.tz}) - interval '6 months') at time zone ${h.tz})::text as earlier_start`)
    const recent = { start: new Date(range?.recent_start ?? h.monthStart), end: new Date(range?.recent_end ?? h.monthStart) }
    const earlier = { start: new Date(range?.earlier_start ?? h.monthStart), end: recent.start }
    const rows = (await salesByConcept(h, recent, earlier)).filter((row) => row.kind === "tratamiento")
    const months = (span: Span) => {
      const first = reportDayOf(h.tz, span.start)
      const last = reportDayOf(h.tz, new Date(span.end.getTime() - 1))
      const ym = (day: string) => ({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) })
      return `${monthLabel(h, ym(first), false)} a ${monthLabel(h, ym(last), false)}`
    }
    return { rows, recentWords: months(recent), earlierWords: months(earlier) }
  }

  return {
    k1: async () => {
      const rows = await sameDaysSales("producto")
      const more = rows
        .filter((row) => row.units > row.prevUnits)
        .sort((a, b) => b.units - b.prevUnits - (a.units - a.prevUnits) || b.cents - a.cents || a.name.localeCompare(b.name))
      const byMoney = rows.filter((row) => row.cents > row.prevCents).sort((a, b) => b.cents - b.prevCents - (a.cents - a.prevCents))
      // «El mes pasado» entero: septiembre completo contra el mes en curso hasta hoy.
      const lastMonth = await h.fig("cobrado", "total", "mes_pasado")
      const full = (await salesByConcept(h, window, { start: window.previous.start, end: window.start })).filter((row) => row.kind === "producto")
      const moreThanFull = full.filter((row) => row.units > row.prevUnits).sort((a, b) => b.units - b.prevUnits - (a.units - a.prevUnits))
      return {
        respuesta: more.length
          ? `${days.current[0]?.toUpperCase()}${days.current.slice(1)} se vendieron más que en los mismos días de ${monthLabel(h, window.previous.from, false)} ${more.length} ${more.length === 1 ? "producto" : "productos"}: ${h.listOf(
              more.slice(0, 5).map((row) => ({ name: row.name, value: `${row.units} contra ${row.prevUnits}, ${h.money(row.cents)} pagados` })),
            )}.`
          : `Ningún producto se vendió más que en los mismos días de ${monthLabel(h, window.previous.from, false)}.`,
        criterio: `Productos pagados (lo pagado de lo cargado, sin anulados ni lo devuelto) ${days.current} contra ${days.sameAs}, por unidades.`,
        nota: `Por lo pagado en dinero: ${h.listOf(byMoney.slice(0, 5).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}` }))) || "ninguno subió"}. Contra todo ${monthLabel(h, window.previous.from)} (mes completo, ${h.show(lastMonth)} cobrados en total), superan sus unidades: ${h.listOf(moreThanFull.slice(0, 5).map((row) => ({ name: row.name, value: `${row.units} contra ${row.prevUnits}` }))) || "ninguno"}.`,
        datos: { mismosDias: rows, mesCompleto: full },
      }
    },
    k2: async () => {
      const { moved, byTimes, rows } = await treatmentMoves("up")
      const quarter = await quarterSales()
      const quarterUp = quarter.rows
        .map((row) => ({ ...row, change: row.cents - row.prevCents }))
        .filter((row) => row.change > 0)
        .sort((a, b) => b.change - a.change)
      return {
        respuesta: moved.length
          ? `Por lo pagado, ${days.current} contra ${days.sameAs}, los tratamientos que más crecieron son ${h.listOf(
              moved.slice(0, 5).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}` })),
            )}.`
          : `Ningún tratamiento vendió más que en los mismos días de ${monthLabel(h, window.previous.from, false)}.`,
        criterio: "Lo pagado de cada tratamiento (sin productos, anulados ni lo devuelto) del mes en curso contra los mismos días del mes anterior, ordenado por cuánto subió en dinero.",
        nota: `Por veces que se vendió: ${h.listOf(byTimes.slice(0, 5).map((row) => ({ name: row.name, value: `${row.units} contra ${row.prevUnits}` }))) || "ninguno subió"}. Los últimos 3 meses completos (${quarter.recentWords}) contra los 3 anteriores (${quarter.earlierWords}): ${h.listOf(quarterUp.slice(0, 5).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}` }))) || "ninguno subió"}.`,
        datos: { mismosDias: rows, tresMeses: quarter.rows },
      }
    },
    k3: async () => {
      const currency = h.scope.currency
      const current = await collectedByProfessional(h.tx, h.org, { start: window.start, end: window.end }, currency)
      const previous = await collectedByProfessional(h.tx, h.org, { start: window.previous.start, end: window.previous.end }, currency)
      const ids = [...new Set([...current, ...previous].map((row) => row.professionalUserId))]
      const rows = ids
        .map((id) => {
          const now = current.find((row) => row.professionalUserId === id)
          const before = previous.find((row) => row.professionalUserId === id)
          const cents = now?.cobradoCents ?? 0
          const prevCents = before?.cobradoCents ?? 0
          return { name: now?.name ?? before?.name ?? "", cents, prevCents, change: cents - prevCents, pct: prevCents > 0 ? (cents - prevCents) / prevCents : null }
        })
        .sort((a, b) => b.change - a.change || a.name.localeCompare(b.name))
      const byPct = [...rows].filter((row) => row.pct !== null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
      // Los dos últimos meses completos, con las cifras de Reportes.
      const last = await h.fig("cobrado", "profesional", "mes_pasado")
      const [range] = await h.tx.execute<{ key: string }>(sql`select to_char(date_trunc('month', now() at time zone ${h.tz}) - interval '2 months', 'YYYY-MM') as key`)
      const before = await h.fig("cobrado", "profesional", range?.key ?? "mes_pasado")
      const full = last.rows
        .map((row) => {
          const prior = before.rows.find((item) => item.key === row.key)?.value.value ?? 0
          return { name: row.label, cents: row.value.value ?? 0, prevCents: prior, change: (row.value.value ?? 0) - prior }
        })
        .sort((a, b) => b.change - a.change)
      const top = rows[0]
      const describe = (row: (typeof rows)[number]) => `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}${row.pct !== null ? ` (${changePct(row.cents, row.prevCents)})` : ""}`
      return {
        respuesta:
          top && top.change > 0
            ? `odentIA no emite facturas; por lo cobrado de lo que atendió cada uno, ${days.current} contra ${days.sameAs}, quien más mejoró es ${top.name}: ${describe(top)}. Le siguen ${h.listOf(rows.slice(1, 4).map((row) => ({ name: row.name, value: describe(row) })))}.`
            : `odentIA no emite facturas; por lo cobrado de lo que atendió cada uno, nadie cobró más ${days.current} que ${days.previous}. ${top ? `Quien menos bajó es ${top.name}: ${describe(top)}. ` : ""}Los demás: ${h.listOf(rows.slice(1, 4).map((row) => ({ name: row.name, value: describe(row) })))}.`,
        criterio: "Lo cobrado por profesional de Reportes (lo pagado de lo que atendió cada uno, la base de las comisiones), del mes en curso contra los mismos días del mes anterior, ordenado por cuánto subió en dinero.",
        nota: `Por porcentaje: ${h.listOf(byPct.slice(0, 3).map((row) => ({ name: row.name, value: changePct(row.cents, row.prevCents) ?? "—" })))}. Con los dos últimos meses completos (${monthLabel(h, window.previous.from)} contra el anterior): ${h.listOf(full.slice(0, 4).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}` })))}.`,
        datos: { mismosDias: rows, mesesCompletos: full },
      }
    },
    k4: async () => {
      const today = reportDayOf(h.tz, h.now)
      const byWeekday = async (from: string) => {
        const spans = daySpans(h, from, today)
        const values = await collectedNetMany(h.tx, h.org, spans)
        const totals = WEEKDAYS.map((name) => ({ name, cents: 0, days: 0 }))
        spans.forEach((span, index) => {
          const weekday = new Date(`${span.day}T12:00:00Z`).getUTCDay()
          const slot = totals[weekday]
          if (!slot) return
          slot.cents += values[index]?.find((item) => item.currency === h.scope.currency)?.cents ?? 0
          slot.days += 1
        })
        return totals
      }
      const month = await byWeekday(reportDayOf(h.tz, window.start))
      const year = await byWeekday(addDays(today, -364))
      const byTotal = (rows: typeof month) => [...rows].sort((a, b) => b.cents - a.cents)
      const byAverage = (rows: typeof month) => [...rows].filter((row) => row.days > 0).sort((a, b) => b.cents / b.days - a.cents / a.days)
      const words = (rows: typeof month) => h.listOf(rows.slice(0, 3).map((row) => ({ name: row.name, value: h.money(row.cents) })))
      const average = (rows: typeof month) => h.listOf(rows.slice(0, 3).map((row) => ({ name: row.name, value: `${h.money(Math.round(row.cents / row.days))} por día` })))
      const top = byTotal(month)[0]
      return {
        respuesta: top
          ? `Este mes el día que más ingresos deja es el ${top.name}: ${h.money(top.cents)} cobrados en ${top.days} ${top.name}${top.days === 1 || top.name.endsWith("s") ? "" : "s"}. Le siguen ${h.listOf(byTotal(month).slice(1, 3).map((row) => ({ name: row.name, value: h.money(row.cents) })))}.`
          : "Este mes todavía no hay cobros.",
        criterio: "Lo cobrado de Reportes (pagos menos lo anulado y lo devuelto) de cada día del mes en curso, sumado por día de la semana (día de la clínica).",
        nota: `Por promedio de cada día este mes: ${average(byAverage(month))}. En los últimos 12 meses: ${words(byTotal(year))} (en promedio, ${average(byAverage(year))}).`,
        datos: { mes: month, doceMeses: year },
      }
    },
    k5: async () => {
      const full = await h.fig("cobrado", "mes", "mes_pasado")
      const months = full.months.filter((month) => !month.partial && month.value.value !== null)
      const sorted = [...months].sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const current = await h.fig("cobrado", "mes")
      const year = h.scope.window.from.year
      const thisYear = current.months.filter((month) => month.month.year === year)
      const closed = thisYear.filter((month) => !month.partial).sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const running = thisYear.find((month) => month.partial)
      const first = months[0]
      const last = months.at(-1)
      const top = sorted[0]
      return {
        respuesta: top
          ? `odentIA no emite facturas; por lo cobrado, en los últimos 12 meses completos (${first ? monthLabel(h, first.month) : "—"} a ${last ? monthLabel(h, last.month) : "—"}) el mes con más ventas fue ${monthLabel(h, top.month)}: ${h.show(full, top.value.value)}. Le siguen ${h.listOf(sorted.slice(1, 3).map((month) => ({ name: monthLabel(h, month.month), value: h.show(full, month.value.value) })))}.`
          : "No hay meses completos para comparar.",
        criterio: "Lo cobrado de Reportes por mes, los últimos 12 meses completos (el mes en curso, incompleto, no entra).",
        nota: `En el año ${year}: el mejor mes cerrado es ${closed[0] ? `${monthLabel(h, closed[0].month)} (${h.show(current, closed[0].value.value)})` : "—"}${running ? `; ${monthLabel(h, running.month, false)} va ${h.show(current, running.value.value)} hasta hoy` : ""}. Mes a mes: ${h.listOf(months.map((month) => ({ name: monthLabel(h, month.month), value: h.show(full, month.value.value) })))}.`,
        datos: { doceMeses: full.months, año: thisYear },
      }
    },
    k6: async () => {
      const month = await h.fig("cobrado", "sede")
      const last = await h.fig("cobrado", "sede", "mes_pasado")
      const year = await h.fig("cobrado", "sede", "este_ano")
      const words = (result: FigureResult) => h.listOf(result.rows.map((row) => ({ name: row.label, value: h.show(result, row.value.value) })))
      const top = month.rows[0]
      const total = month.total.value ?? 0
      return {
        respuesta: top
          ? `Este mes la sede que más ingresos genera es ${top.label}: ${h.show(month, top.value.value)}${total > 0 ? ` (${Math.round(((top.value.value ?? 0) / total) * 100)} % de ${h.show(month)})` : ""}. Por sede: ${words(month)}.`
          : "Este mes todavía no hay cobros.",
        criterio: "Lo cobrado por sede de Reportes, del mes en curso hasta hoy.",
        nota: `En ${monthLabel(h, window.previous.from)} (completo): ${words(last)}. En lo que va del año: ${words(year)}.`,
        datos: { mes: month.rows, mesPasado: last.rows, año: year.rows },
      }
    },
    k7: async () => {
      const { moved, byTimes, rows } = await treatmentMoves("down")
      const quarter = await quarterSales()
      const quarterDown = quarter.rows
        .map((row) => ({ ...row, change: row.cents - row.prevCents }))
        .filter((row) => row.change < 0)
        .sort((a, b) => a.change - b.change)
      return {
        respuesta: moved.length
          ? `Por lo pagado, ${days.current} contra ${days.sameAs}, bajaron ${moved.length} tratamientos; los que más: ${h.listOf(
              moved.slice(0, 5).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}` })),
            )}.`
          : `Ningún tratamiento vendió menos que en los mismos días de ${monthLabel(h, window.previous.from, false)}.`,
        criterio: "Lo pagado de cada tratamiento (sin productos, anulados ni lo devuelto) del mes en curso contra los mismos días del mes anterior, ordenado por cuánto bajó en dinero.",
        nota: `Por veces que se vendió: ${h.listOf(byTimes.slice(0, 5).map((row) => ({ name: row.name, value: `${row.units} contra ${row.prevUnits}` }))) || "ninguno bajó"}. Los últimos 3 meses completos (${quarter.recentWords}) contra los 3 anteriores (${quarter.earlierWords}): ${h.listOf(quarterDown.slice(0, 5).map((row) => ({ name: row.name, value: `${h.money(row.cents)} contra ${h.money(row.prevCents)}, ${signedMoney(h, row.change)}` }))) || "ninguno bajó"}.`,
        datos: { mismosDias: rows, tresMeses: quarter.rows },
      }
    },
  }
}
