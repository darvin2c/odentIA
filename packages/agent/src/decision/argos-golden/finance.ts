/** Respuestas correctas de las finanzas (eval/argos-owner.json). */
import type { FigureResult, FigureRow } from "@odentia/services"
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]

/** Lo que se dice siempre que preguntan por facturas o facturación (criterio 2). */
export const NO_INVOICES = "odentIA no emite facturas ni boletas, solo tickets de pago"

/** Fechas y porcentajes dichos con el idioma y el día de la clínica; los comparten finanzas y ventas. */
export function goldenWords(h: GoldenHelpers) {
  const { locale } = h.scope
  const noon = (key: string): Date => new Date(`${key}T12:00:00Z`)
  const dayKey = (date: Date): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: h.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date)
  const addDays = (key: string, count: number): string => {
    const date = noon(key)
    date.setUTCDate(date.getUTCDate() + count)
    return date.toISOString().slice(0, 10)
  }
  const todayKey = dayKey(h.now)
  /** «miércoles 14 de octubre». */
  const dayWords = (key: string): string =>
    `${DAYS[noon(key).getUTCDay()]} ${new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(noon(key))}`
  /** «octubre de 2026». */
  const monthWords = (month: { year: number; month: number }): string =>
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(month.year, month.month - 1, 15)),
    )
  const dayOfMonth = (key: string): number => Number(key.slice(8, 10))
  const { window } = h.scope
  const current = monthWords(window.from)
  const previous = monthWords(window.previous.from)
  const upTo = dayOfMonth(todayKey)
  /** «del 1 al 21 de octubre de 2026». */
  const monthSoFar = upTo === 1 ? `el 1 de ${current}` : `del 1 al ${upTo} de ${current}`
  /** «los mismos días de septiembre de 2026 (del 1 al 21)». */
  const previousSameDays = `los mismos días de ${previous} (${upTo === 1 ? "el 1" : `del 1 al ${upTo}`})`
  const yearAgoKey = addDays(todayKey, -364)
  const pct = (part: number, total: number): string => {
    if (total <= 0) return "sin dato"
    const value = (part / total) * 100
    return value > 0 && value < 0.5 ? "menos del 1 %" : `${Math.round(value)} %`
  }
  const signed = (part: number, total: number): string => {
    if (total <= 0) return "sin dato"
    const change = Math.round(((part - total) / total) * 100)
    return `${change > 0 ? "+" : ""}${change} %`
  }
  return {
    todayKey,
    addDays,
    dayWords,
    monthWords,
    monthSoFar,
    previousSameDays,
    previousMonth: previous,
    /** Los últimos 365 días con hoy, como periodo de Reportes. */
    lastYear: `${yearAgoKey}..${todayKey}`,
    yearAgoKey,
    nowIso: h.now.toISOString(),
    pct,
    signed,
  }
}

/** El primer instante de un día de la clínica (ISO), para mirar desde ese día. */
export async function dayStart(h: GoldenHelpers, key: string): Promise<string> {
  const [row] = await h.tx.execute<{ at: string }>(
    sql`select to_char((${key}::date)::timestamp at time zone ${h.tz} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
  )
  if (!row) throw new Error(`Día inválido: ${key}`)
  return row.at
}

/**
 * Lo cobrado de cada día de la clínica en un tramo, con la regla de la cifra
 * «cobrado» (`collectedNetMany`): pagos del tramo que siguen en pie al cerrarlo,
 * menos lo anulado en el tramo de pagos anteriores y lo devuelto en el tramo.
 * Sumados, los días dan la cifra del tramo.
 */
export async function collectedByDay(
  h: GoldenHelpers,
  start: string,
  end: string,
): Promise<Array<{ day: string; dow: number; cents: number }>> {
  const rows = await h.tx.execute<{ day: string; dow: number; cents: string }>(sql`
    with x as (
      select p.paid_at as at, p.amount_cents::bigint as cents from patient_payment p
      where p.organization_id = ${h.org} and p.currency = ${h.scope.currency}
        and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
        and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
      union all
      select p.voided_at, -p.amount_cents::bigint from patient_payment p
      where p.organization_id = ${h.org} and p.currency = ${h.scope.currency} and p.paid_at < ${start}::timestamptz
        and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz
      union all
      select r.refunded_at, -r.amount_cents::bigint from patient_payment_refund r
      join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
      where r.organization_id = ${h.org} and p.currency = ${h.scope.currency}
        and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz)
    select to_char(d.day, 'YYYY-MM-DD') as day, extract(dow from d.day)::int as dow, sum(d.cents)::text as cents
    from (select ${h.dayOf(sql`x.at`)} as day, x.cents from x) d
    group by d.day order by d.day`)
  return rows.map((row) => ({ day: row.day, dow: row.dow, cents: Number(row.cents) }))
}

/** Las filas de Reportes sin «Otros (n)», que junta lo que no entra en la vista. */
function namedRows(result: FigureResult): FigureRow[] {
  return result.rows.filter((row) => row.key !== "otros")
}

/**
 * Las filas de tratamientos de «Lo cobrado» por tratamiento: Reportes nombra un
 * producto con lo escrito en su cargo y lo pone en la misma lista.
 */
async function treatmentRows(h: GoldenHelpers, result: FigureResult): Promise<FigureRow[]> {
  const products = await h.tx.execute<{ name: string }>(sql`
    select distinct c.description as name from patient_charge c
    where c.organization_id = ${h.org} and c.product_id is not null and c.description is not null`)
  const names = new Set([...products].map((row) => row.name))
  return namedRows(result).filter((row) => !names.has(row.label))
}

export function financeSolvers(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const { money, show, listOf } = h
  const sumOf = (list: Array<{ value: { value: number | null } }>): number =>
    list.reduce((total, item) => total + (item.value.value ?? 0), 0)
  const changeWords = (value: number, before: number): string =>
    `${value >= before ? `${money(value - before)} más` : `${money(before - value)} menos`} (${w.signed(value, before)})`

  /**
   * Lo pagado de cada concepto (lo vendido, criterio 3): pagos vigentes del
   * tramo aplicados a tratamientos y productos sin anular, por su nombre.
   */
  const paidByConcept = (since: string, until: string) =>
    h.tx.execute<{ name: string; kind: string; sales: number; cents: string }>(sql`
      select ${h.conceptName} as name, case when c.product_id is null then 'tratamiento' else 'producto' end as kind,
        count(distinct c.id)::int as sales, sum(a.amount_cents)::text as cents
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
      ${h.conceptJoins}
      where a.organization_id = ${h.org} and a.voided_at is null and pay.currency = ${h.scope.currency}
        and pay.paid_at >= ${since}::timestamptz and pay.paid_at < ${until}::timestamptz
      group by 1, 2 order by sum(a.amount_cents) desc, 1`)

  /**
   * Lo cobrado de cada paciente en un tramo (la regla de «cobrado») y cuánto
   * de eso es de pacientes nuevos del tramo: su primera cita atendida cae dentro
   * (la regla de «Pacientes nuevos»). `registered`: dados de alta en el tramo.
   */
  const collectedFromNew = async (start: string, end: string) => {
    const [row] = await h.tx.execute<{
      total: string
      fresh: string
      freshPayers: number
      payers: number
      registered: string
      registeredPayers: number
    }>(sql`
      with first_visit as (
        select distinct on (patient_id) patient_id, starts_at from appointment
        where organization_id = ${h.org} and status = 'atendida' order by patient_id, starts_at, id),
      money as (
        select p.patient_id, p.amount_cents::bigint as cents from patient_payment p
        where p.organization_id = ${h.org} and p.currency = ${h.scope.currency}
          and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
          and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
        union all
        select p.patient_id, -p.amount_cents::bigint from patient_payment p
        where p.organization_id = ${h.org} and p.currency = ${h.scope.currency} and p.paid_at < ${start}::timestamptz
          and p.voided_at >= ${start}::timestamptz and p.voided_at < ${end}::timestamptz
        union all
        select p.patient_id, -r.amount_cents::bigint from patient_payment_refund r
        join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
        where r.organization_id = ${h.org} and p.currency = ${h.scope.currency}
          and r.refunded_at >= ${start}::timestamptz and r.refunded_at < ${end}::timestamptz),
      tagged as (
        select m.patient_id, m.cents,
          coalesce(f.starts_at >= ${start}::timestamptz and f.starts_at < ${end}::timestamptz, false) as fresh,
          (pt.created_at >= ${start}::timestamptz and pt.created_at < ${end}::timestamptz) as registered
        from money m
        join patient pt on pt.organization_id = ${h.org} and pt.id = m.patient_id
        left join first_visit f on f.patient_id = m.patient_id)
      select coalesce(sum(cents), 0)::text as total,
        coalesce(sum(cents) filter (where fresh), 0)::text as fresh,
        count(distinct patient_id) filter (where fresh)::int as "freshPayers",
        count(distinct patient_id)::int as payers,
        coalesce(sum(cents) filter (where registered), 0)::text as registered,
        count(distinct patient_id) filter (where registered)::int as "registeredPayers"
      from tagged`)
    return {
      total: Number(row?.total ?? 0),
      fresh: Number(row?.fresh ?? 0),
      freshPayers: row?.freshPayers ?? 0,
      payers: row?.payers ?? 0,
      registered: Number(row?.registered ?? 0),
      registeredPayers: row?.registeredPayers ?? 0,
    }
  }

  return {
    f1: async () => {
      const result = await h.fig("cobrado")
      const [charged] = await h.tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
        where c.organization_id = ${h.org} and c.voided_at is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${h.monthStart}::timestamptz and c.created_at < ${w.nowIso}::timestamptz`)
      const [tickets] = await h.tx.execute<{
        tickets: number
        cents: string
        payments: number
        loose: number
      }>(sql`
        select (select count(*) from payment_ticket t where t.organization_id = ${h.org} and t.voided_at is null
            and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${w.nowIso}::timestamptz)::int as tickets,
          (select coalesce(sum(t.total_cents), 0) from payment_ticket t where t.organization_id = ${h.org} and t.voided_at is null
            and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${w.nowIso}::timestamptz)::text as cents,
          (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.voided_at is null
            and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${w.nowIso}::timestamptz)::int as payments,
          (select count(*) from patient_payment p where p.organization_id = ${h.org} and p.voided_at is null and p.ticket_id is null
            and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${w.nowIso}::timestamptz)::int as loose`)
      return {
        respuesta: `${NO_INVOICES}, así que no hay un «facturado». Lo que cobró la clínica este mes (${w.monthSoFar}), sin lo anulado ni lo devuelto, es ${show(result)}.`,
        criterio:
          "«Lo cobrado» de Reportes del mes en curso hasta hoy (pagos menos anulaciones y devoluciones), en lugar de «facturación».",
        nota: `Si «facturó» es lo cargado a los pacientes este mes (tratamientos y productos, pagados o no): ${money(Number(charged?.cents ?? 0))} en ${charged?.count ?? 0} conceptos. Tickets numerados del mes: ${tickets?.tickets ?? 0} por ${money(Number(tickets?.cents ?? 0))}${tickets?.loose ? ` (${tickets.loose} de los ${tickets.payments} pagos del mes no tienen ticket: la historia de prueba los guarda sin él)` : ""}. En ${w.previousSameDays} se cobró ${show(result, result.previous?.value ?? null)}.`,
        datos: { total: result.total, anterior: result.previous, cargado: charged, tickets },
      }
    },

    f2: async () => {
      const collected = await h.fig("cobrado")
      const leaves = await h.fig("lo_que_deja")
      const lastCollected = await h.fig("cobrado", "total", "mes_pasado")
      const lastLeaves = await h.fig("lo_que_deja", "total", "mes_pasado")
      const value = collected.total.value ?? 0
      const before = collected.previous?.value ?? 0
      const kept = leaves.total.value ?? 0
      const keptBefore = leaves.previous?.value ?? 0
      return {
        respuesta: `Este mes (${w.monthSoFar}) cobraste ${show(collected)}; en ${w.previousSameDays}, ${show(collected, before)}: ${changeWords(value, before)}.`,
        criterio:
          "«Lo cobrado» de Reportes del mes en curso contra los mismos días del mes anterior (la comparación de Reportes); «cuánto gané» es lo cobrado en Reportes.",
        nota: `Si «gané» es lo que le queda a la clínica después de comisiones y gastos registrados («Lo que deja»): este mes ${show(leaves)} contra ${show(leaves, keptBefore)} en los mismos días del mes anterior, ${changeWords(kept, keptBefore)}. Contra ${w.previousMonth} completo: cobrado ${show(lastCollected)}, lo que dejó ${show(lastLeaves)}.`,
        datos: {
          cobrado: collected.total,
          cobradoAnterior: collected.previous,
          deja: leaves.total,
          dejaAnterior: leaves.previous,
          mesPasado: { cobrado: lastCollected.total, deja: lastLeaves.total },
        },
      }
    },

    f3: async () => {
      const month = await h.fig("cobrado", "tratamiento")
      const year = await h.fig("cobrado", "tratamiento", w.lastYear)
      // Lo que vale cada vez: lo cargado este mes por tratamiento ÷ veces (con al menos 3, para que el promedio diga algo).
      const perSale = await h.tx.execute<{ name: string; sales: number; average: number }>(sql`
        select ${h.conceptName} as name, count(*)::int as sales, avg(c.amount_cents)::float as average
        from patient_charge c ${h.conceptJoins}
        where c.organization_id = ${h.org} and c.voided_at is null and c.product_id is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${h.monthStart}::timestamptz and c.created_at < ${w.nowIso}::timestamptz
        group by 1 having count(*) >= 3 order by 3 desc, 1`)
      const top = async (result: FigureResult, count: number) =>
        listOf(
          (await treatmentRows(h, result))
            .slice(0, count)
            .map((row) => ({ name: row.label, value: show(result, row.value.value) })),
        )
      const monthTop = await top(month, 5)
      const yearTop = await top(year, 5)
      return {
        respuesta: `No puedo decir cuáles son los más rentables: odentIA no tiene lo que cuesta cada tratamiento (laboratorio, materiales, tiempo del profesional), solo lo que se cobra, así que no hay utilidad por tratamiento. Lo más cercano, por lo cobrado este mes (${w.monthSoFar}): ${monthTop}.`,
        criterio:
          "Trampa: sin costos por tratamiento no hay rentabilidad. Se ofrece «Lo cobrado» de Reportes por tratamiento del mes en curso, sin restar nada.",
        nota: `En los últimos 365 días, por lo cobrado: ${yearTop}. Por lo que vale cada vez (lo cargado este mes ÷ veces, con al menos 3): ${listOf(perSale.slice(0, 3).map((row) => ({ name: row.name, value: `${money(Math.round(row.average))} por vez, ${row.sales} veces` })))}.`,
        datos: { mes: month.rows, año: year.rows, porVenta: perSale.slice(0, 10) },
      }
    },

    f4: async () => {
      const month = await h.fig("cobrado", "tratamiento")
      const year = await h.fig("cobrado", "tratamiento", w.lastYear)
      const sold = (await paidByConcept(h.monthStart, w.nowIso)).filter(
        (row) => row.kind === "tratamiento",
      )
      const total = month.total.value ?? 0
      const rows = await treatmentRows(h, month)
      const yearRows = await treatmentRows(h, year)
      return {
        respuesta: `Este mes (${w.monthSoFar}) los tratamientos que más ingresos generan son ${listOf(rows.slice(0, 5).map((row) => ({ name: row.label, value: `${show(month, row.value.value)}, ${w.pct(row.value.value ?? 0, total)} de lo cobrado` })))}; en total hubo cobros de ${sold.length} tratamientos distintos.`,
        criterio:
          "«Lo cobrado» de Reportes por tratamiento (lo aplicado en el mes a los cargos de cada servicio, sin anulados y restando lo devuelto), del mes en curso.",
        nota: `En los últimos 365 días: ${listOf(
          yearRows
            .slice(0, 5)
            .map((row) => ({ name: row.label, value: show(year, row.value.value) })),
        )}. Por veces vendidas este mes: ${listOf(
          [...sold]
            .sort((a, b) => b.sales - a.sales || Number(b.cents) - Number(a.cents))
            .slice(0, 3)
            .map((row) => ({ name: row.name, value: `${row.sales} veces` })),
        )}.`,
        datos: { mes: month.rows, año: year.rows, vendido: sold },
      }
    },

    f5: async () => {
      const owed = await h.fig("te_deben")
      const overdue = await h.fig("deuda_vencida")
      const coming = await h.fig("lo_que_viene")
      const owedCents = owed.total.value ?? 0
      const comingCents = coming.total.value ?? 0
      return {
        respuesta: `Hoy tienes ${show(owed)} pendientes de cobrar: lo que ${owed.total.part ?? 0} personas deben de lo ya cargado, descontando lo que tienen a favor. De eso, ${show(overdue)} (${overdue.total.part ?? 0} personas) es de hace más de 30 días.`,
        criterio:
          "«Te deben» de Reportes › Finanzas, a hoy; con su parte «Te deben hace más de 30 días».",
        nota: `Si cuentas también lo aceptado en presupuestos que falta hacer y aún no se carga («Lo que viene»): ${show(coming)} más, de ${coming.total.part ?? 0} pacientes; juntos, ${money(owedCents + comingCents)}.`,
        datos: { teDeben: owed.total, vencido: overdue.total, loQueViene: coming.total },
      }
    },

    f6: async () => {
      const collected = await h.fig("cobrado")
      const byTreatment = await h.fig("cobrado", "tratamiento")
      const byProfessional = await h.fig("cobrado", "profesional")
      const byBranch = await h.fig("cobrado", "sede")
      const sold = await paidByConcept(h.monthStart, w.nowIso)
      const specialties = await h.tx.execute<{ name: string; cents: string }>(sql`
        select coalesce(os.name, 'Sin especialidad') as name, sum(a.amount_cents)::text as cents
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null and c.product_id is null
        ${h.conceptJoins}
        left join org_specialty os on os.organization_id = c.organization_id and os.id = coalesce(sep.specialty_id, spi.specialty_id)
        where a.organization_id = ${h.org} and a.voided_at is null and pay.currency = ${h.scope.currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${w.nowIso}::timestamptz
        group by 1 order by sum(a.amount_cents) desc, 1`)
      const total = collected.total.value ?? 0
      const treatments = sold
        .filter((row) => row.kind === "tratamiento")
        .reduce((sum, row) => sum + Number(row.cents), 0)
      const products = sold
        .filter((row) => row.kind === "producto")
        .reduce((sum, row) => sum + Number(row.cents), 0)
      const loose = total - treatments - products
      const share = (cents: number) => `${money(cents)}, ${w.pct(cents, total)}`
      const topTreatments = await treatmentRows(h, byTreatment)
      return {
        respuesta: `Este mes (${w.monthSoFar}) cobraste ${show(collected)}. Tu fuente principal son los tratamientos: ${share(treatments)}; productos, ${share(products)}${loose > 0 ? `, y ${share(loose)} son adelantos o saldo a favor aún sin aplicar` : ""}. Los tratamientos que más dejan: ${listOf(
          topTreatments
            .slice(0, 5)
            .map((row) => ({ name: row.label, value: share(row.value.value ?? 0) })),
        )}.`,
        criterio:
          "«Lo cobrado» de Reportes del mes en curso, repartido en lo aplicado a tratamientos, a productos y lo aún sin aplicar, y «Lo cobrado» por tratamiento.",
        nota: `Por especialidad: ${listOf(specialties.slice(0, 4).map((row) => ({ name: row.name, value: share(Number(row.cents)) })))}. Por profesional (de lo que atendió cada uno): ${listOf(byProfessional.rows.slice(0, 3).map((row) => ({ name: row.label, value: share(row.value.value ?? 0) })))}. Por sede: ${listOf(byBranch.rows.filter((row) => (row.value.value ?? 0) !== 0).map((row) => ({ name: row.label, value: share(row.value.value ?? 0) })))}.`,
        datos: {
          total: collected.total,
          tratamientos: treatments,
          productos: products,
          sinAplicar: loose,
          porTratamiento: byTreatment.rows,
          especialidades: specialties,
          profesionales: byProfessional.rows,
          sedes: byBranch.rows,
        },
      }
    },

    f7: async () => {
      const month = await collectedByDay(h, h.monthStart, w.nowIso)
      const year = await collectedByDay(h, await dayStart(h, w.yearAgoKey), w.nowIso)
      const byWeekday = (rows: typeof month) => {
        const out = DAYS.map((name, dow) => ({ name, dow, cents: 0, days: 0 }))
        for (const row of rows) {
          const slot = out[row.dow]
          if (!slot) continue
          slot.cents += row.cents
          if (row.cents !== 0) slot.days += 1
        }
        return out.filter((row) => row.cents !== 0).sort((a, b) => b.cents - a.cents)
      }
      const monthDays = byWeekday(month)
      const yearDays = byWeekday(year)
      const monthTotal = month.reduce((sum, row) => sum + row.cents, 0)
      const yearTotal = year.reduce((sum, row) => sum + row.cents, 0)
      const words = (rows: typeof monthDays, total: number, count: number) =>
        listOf(
          rows.slice(0, count).map((row) => ({
            name: row.name,
            value: `${money(row.cents)}, ${w.pct(row.cents, total)}`,
          })),
        )
      const lowest = monthDays.at(-1)
      return {
        respuesta: `${NO_INVOICES}; por lo cobrado, este mes (${w.monthSoFar}) los días en que más entra son ${words(monthDays, monthTotal, 3)}${lowest ? `; el más flojo, ${lowest.name} (${money(lowest.cents)})` : ""}.`,
        criterio:
          "«Lo cobrado» (pagos menos anulaciones y devoluciones) del mes en curso por día de la semana de la clínica; sumado da la cifra del mes.",
        nota: `En los últimos 365 días: ${words(yearDays, yearTotal, 3)}. Por día con cobros, en promedio, este mes: ${listOf(
          [...monthDays]
            .sort((a, b) => b.cents / Math.max(1, b.days) - a.cents / Math.max(1, a.days))
            .slice(0, 3)
            .map((row) => ({
              name: row.name,
              value: `${money(Math.round(row.cents / Math.max(1, row.days)))} en ${row.days} días`,
            })),
        )}.`,
        datos: { mes: monthDays, doceMeses: yearDays, totalMes: monthTotal, totalAño: yearTotal },
      }
    },

    f8: async () => {
      const result = await h.fig("cobrado", "mes")
      const current = await h.fig("cobrado")
      const full = result.months.filter((month) => !month.partial && month.value.value !== null)
      const last = full.slice(-3)
      const before = full.slice(-6, -3)
      const recent = sumOf(last)
      const earlier = sumOf(before)
      const span = (list: typeof full) =>
        `${w.monthWords(list[0]?.month ?? { year: 0, month: 1 })} a ${w.monthWords(list.at(-1)?.month ?? { year: 0, month: 1 })}`
      return {
        respuesta: `${NO_INVOICES}; por lo cobrado, ${recent >= earlier ? "estás creciendo" : "estás disminuyendo"}: en los últimos 3 meses completos (${span(last)}) cobraste ${money(recent)}; en los 3 anteriores (${span(before)}), ${money(earlier)}: ${changeWords(recent, earlier)}.`,
        criterio:
          "«Lo cobrado» de Reportes de los últimos 3 meses completos contra los 3 anteriores (el mes en curso, incompleto, no entra).",
        nota: `Mes a mes: ${listOf(full.slice(-6).map((month) => ({ name: w.monthWords(month.month), value: show(result, month.value.value) })))}. El mes en curso va ${show(current)} contra ${show(current, current.previous?.value ?? null)} en ${w.previousSameDays} (${w.signed(current.total.value ?? 0, current.previous?.value ?? 0)}).`,
        datos: { meses: result.months, ultimos3: recent, anteriores3: earlier },
      }
    },

    f9: async () => {
      const result = await h.fig("cobrado")
      const year = await h.fig("cobrado", "total", w.lastYear)
      const lifetime = await h.fig("valor_paciente")
      const count = (start: string) =>
        h.tx.execute<{ payers: number; payments: number; attended: number }>(sql`
          select (select count(distinct pay.patient_id) from patient_payment pay where pay.organization_id = ${h.org} and pay.voided_at is null
              and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${w.nowIso}::timestamptz)::int as payers,
            (select count(*) from patient_payment pay where pay.organization_id = ${h.org} and pay.voided_at is null
              and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${w.nowIso}::timestamptz)::int as payments,
            (select count(distinct a.patient_id) from appointment a where a.organization_id = ${h.org} and a.status = 'atendida'
              and a.starts_at >= ${start}::timestamptz and a.starts_at < ${w.nowIso}::timestamptz)::int as attended`)
      const [month] = await count(h.monthStart)
      const [last] = await count(await dayStart(h, w.yearAgoKey))
      const value = result.total.value ?? 0
      const yearValue = year.total.value ?? 0
      const per = (cents: number, people: number | undefined) =>
        money(people ? Math.round(cents / people) : 0)
      return {
        respuesta: `Este mes (${w.monthSoFar}) tu ticket promedio por paciente es ${per(value, month?.payers)}: ${show(result)} cobrados de ${month?.payers ?? 0} pacientes que pagaron.`,
        criterio:
          "«Lo cobrado» de Reportes del mes en curso ÷ pacientes distintos con un pago vigente en el mes.",
        nota: `En los últimos 365 días: ${per(yearValue, last?.payers)} por paciente (${show(year)} de ${last?.payers ?? 0} pacientes). Por pago (cada ticket) este mes: ${per(value, month?.payments)} en ${month?.payments ?? 0} pagos. Entre los ${month?.attended ?? 0} pacientes atendidos del mes: ${per(value, month?.attended)}. Lo que deja un paciente nuevo en sus primeros 6 meses (Reportes): ${show(lifetime)}.`,
        datos: {
          mes: { total: result.total, ...month },
          año: { total: year.total, ...last },
          valorPaciente: lifetime.total,
        },
      }
    },

    f10: async () => {
      const month = await collectedFromNew(h.monthStart, w.nowIso)
      const year = await collectedFromNew(await dayStart(h, w.yearAgoKey), w.nowIso)
      const fresh = await h.fig("pacientes_nuevos")
      const collected = await h.fig("cobrado")
      return {
        respuesta: `Este mes (${w.monthSoFar}) el ${w.pct(month.fresh, month.total)} de lo cobrado viene de pacientes nuevos: ${money(month.fresh)} de ${money(month.total)}, de ${month.freshPayers} de los ${fresh.total.value ?? 0} pacientes nuevos del mes${month.freshPayers < (fresh.total.value ?? 0) ? " (los demás aún no pagan)" : ""}.`,
        criterio:
          "«Lo cobrado» del mes en curso de cada paciente (pagos menos anulaciones y devoluciones); nuevo, si su primera cita atendida es de este mes (la regla de «Pacientes nuevos»).",
        nota: `En los últimos 365 días, de pacientes cuya primera cita atendida cae en ese año: ${w.pct(year.fresh, year.total)} (${money(year.fresh)} de ${money(year.total)}). Si «nuevo» es dado de alta este mes: ${w.pct(month.registered, month.total)} (${money(month.registered)}, ${month.registeredPayers} pacientes).`,
        datos: {
          mes: month,
          doceMeses: year,
          pacientesNuevos: fresh.total,
          cobrado: collected.total,
        },
      }
    },
  }
}
