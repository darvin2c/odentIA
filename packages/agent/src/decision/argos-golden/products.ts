/**
 * Respuestas correctas de los productos y tratamientos más vendidos
 * (eval/argos-owner.json, t1–t10). «Vendido» es lo pagado de lo cargado: los
 * conceptos vigentes con pagos vigentes aplicados en el periodo, como o1/o2;
 * un producto es un concepto con `product_id` y un tratamiento, los demás.
 * «Realizado» es un procedimiento sin anular de una atención firmada, por el
 * día en que se firmó (Reportes). Sin periodo en la pregunta, el mes en curso;
 * la nota trae los últimos 12 meses y la otra lectura (lo cargado).
 */
import { sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

const DAY_MS = 86_400_000

/** «1 frasco», «2 frascos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  const plural = /[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`
  return `${count} ${plural}`
}

type ProductSale = {
  id: string
  name: string
  unit: string
  units: number
  cents: string
  patients: number
}

export function productSolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, money, listOf } = h
  const nowIso = h.now.toISOString()
  const monthStart = h.monthStart
  const yearAgo = new Date(h.now.getTime() - 365 * DAY_MS).toISOString()
  const previous = { start: h.scope.window.previous.start.toISOString(), end: h.scope.window.previous.end.toISOString() }
  const monthOf = (date: Date) => new Intl.DateTimeFormat(h.scope.locale, { month: "long", timeZone: h.tz }).format(date).toLowerCase()
  const dayOfMonth = (date: Date) => new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: h.tz }).format(date)
  /** «en lo que va de octubre (del 1 al 21)». */
  const thisMonth = `en lo que va de ${monthOf(h.now)} (del 1 al ${dayOfMonth(h.now)})`
  const lastMonthDays = `los mismos días de ${monthOf(h.scope.window.previous.start)} (del 1 al ${dayOfMonth(new Date(h.scope.window.previous.end.getTime() - 1))})`
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

  /** Productos pagados en [start, end): pagos vigentes aplicados a conceptos vigentes; por unidades y después por monto. */
  const paidProducts = (start: string, end: string) =>
    tx.execute<ProductSale>(sql`
      select pr.id, pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents, count(distinct c.patient_id)::int as patients
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
          and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz) ap on ap.cents > 0
      where c.organization_id = ${org} and c.voided_at is null
      group by 1, 2, 3 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 2`)
  /**
   * Productos cargados en [start, end), pagados o no. Una devolución anula el
   * concepto y deja otro con lo que queda (ADR 0068): la venta es del día del
   * primero de la cadena.
   */
  const chargedProducts = (start: string, end: string) =>
    tx.execute<ProductSale>(sql`
      select pr.id, pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(c.amount_cents)::text as cents, count(distinct c.patient_id)::int as patients
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
      where c.organization_id = ${org} and c.voided_at is null
        and coalesce(o.created_at, c.created_at) >= ${start}::timestamptz and coalesce(o.created_at, c.created_at) < ${end}::timestamptz
      group by 1, 2, 3 order by sum(c.product_quantity) desc, sum(c.amount_cents) desc, 2`)
  /** Lo pagado en [start, end) aplicado a cada tratamiento (sin productos ni anulados), de más a menos. */
  const paidTreatments = (start: string, end: string) =>
    tx.execute<{ name: string; cents: string }>(sql`
      select ${h.conceptName} as name, sum(a.amount_cents)::text as cents
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null and c.product_id is null
      ${h.conceptJoins}
      where a.organization_id = ${org} and a.voided_at is null and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz
      group by 1 order by sum(a.amount_cents) desc, 1`)
  /** Procedimientos sin anular de atenciones firmadas en [start, end), por tratamiento y contando la cantidad. */
  const doneTreatments = (start: string, end: string) =>
    tx.execute<{ name: string; times: number; rows: number }>(sql`
      select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times, count(*)::int as rows
      from encounter_procedure ep
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
      left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
      where ep.organization_id = ${org} and ep.voided_at is null
        and e.finalized_at >= ${start}::timestamptz and e.finalized_at < ${end}::timestamptz
      group by 1 order by 2 desc, 1`)

  const saleWords = (rows: ProductSale[]) => listOf(rows.map((row) => ({ name: row.name, value: `${unitsWord(row.units, row.unit)}, ${money(Number(row.cents))}` })))
  const centsWords = (rows: Array<{ name: string; cents: string }>) => listOf(rows.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))
  const timesWords = (rows: Array<{ name: string; times: number }>) => listOf(rows.map((row) => ({ name: row.name, value: `${row.times}` })))
  const totalCents = (rows: Array<{ cents: string }>) => rows.reduce((sum, row) => sum + Number(row.cents), 0)
  const howMany = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

  /** «Los más vendidos» del mes con la nota de los 12 meses y de lo cargado (t1, t6, t10). */
  const topProducts = async (limit: number) => {
    const month = await paidProducts(monthStart, nowIso)
    const year = await paidProducts(yearAgo, nowIso)
    const charged = await chargedProducts(monthStart, nowIso)
    return { month, year, charged, top: month.slice(0, limit) }
  }

  return {
    t1: async () => {
      const { month, year, charged, top } = await topProducts(10)
      return {
        respuesta: top.length
          ? `${capital(thisMonth)} se vendieron y pagaron ${howMany(month.length, "producto", "productos")}, menos de 10: ${saleWords(top)}. En total, ${money(totalCents(month))}.`
          : `${capital(thisMonth)} todavía no se pagó ningún producto.`,
        criterio: "Productos (conceptos con producto, no tratamientos) con pagos vigentes este mes, sin anulados ni lo devuelto; por unidades y después por monto.",
        nota: `En los últimos 12 meses: ${saleWords(year.slice(0, 10)) || "ninguno"}. Contando lo cargado este mes aunque no se haya pagado: ${saleWords(charged.slice(0, 10)) || "ninguno"}.`,
        datos: { mes: month, doceMeses: year, cargadoMes: charged },
      }
    },
    t2: async () => {
      const month = await doneTreatments(monthStart, nowIso)
      const year = await doneTreatments(yearAgo, nowIso)
      const procedures = month.reduce((sum, row) => sum + row.times, 0)
      return {
        respuesta: month.length
          ? `${capital(thisMonth)}, ${month.length < 10 ? `solo se realizaron ${month.length} tratamientos distintos, menos de 10` : "los 10 tratamientos más realizados son"}: ${timesWords(month.slice(0, 10))}. En total, ${procedures} realizados${month.length > 10 ? ` de ${month.length} tratamientos distintos` : ""}.`
          : `${capital(thisMonth)} todavía no hay atenciones firmadas con tratamientos.`,
        criterio: "Procedimientos sin anular de atenciones firmadas (finalizadas, sin anular) este mes, por el día de la firma; por tratamiento y contando la cantidad.",
        nota: `En los últimos 12 meses: ${timesWords(year.slice(0, 10))}. Contando cada procedimiento una vez, sin su cantidad (este mes): ${timesWords([...month].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name)).slice(0, 5).map((row) => ({ name: row.name, times: row.rows })))}.`,
        datos: { mes: month, doceMeses: year.slice(0, 20) },
      }
    },
    t3: async () => {
      const month = await paidTreatments(monthStart, nowIso)
      const year = await paidTreatments(yearAgo, nowIso)
      const screen = await h.fig("cobrado", "tratamiento")
      return {
        respuesta: month.length
          ? `${capital(thisMonth)}, los 10 tratamientos que más ingresos dejaron son: ${centsWords(month.slice(0, 10))}. Son ${howMany(month.length, "tratamiento", "tratamientos")} con pagos este mes, por ${money(totalCents(month))}.`
          : `${capital(thisMonth)} todavía no se pagó ningún tratamiento.`,
        criterio: "Lo pagado este mes (pagos vigentes) aplicado a cada tratamiento, sin productos ni conceptos anulados; de más a menos.",
        nota: `En los últimos 12 meses: ${centsWords(year.slice(0, 10))}. Reportes › Lo cobrado por tratamiento (este mes, con productos y restando devoluciones): ${listOf(screen.rows.filter((row) => row.key !== "otros").map((row) => ({ name: row.label, value: h.show(screen, row.value.value) })))}.`,
        datos: { mes: month, doceMeses: year.slice(0, 20), reportes: screen.rows },
      }
    },
    t4: async () => {
      const forSale = await tx.execute<{ id: string; name: string; unit: string }>(sql`
        select id, name, unit from product where organization_id = ${org} and is_active and for_sale order by name`)
      const month = await paidProducts(monthStart, nowIso)
      const year = await paidProducts(yearAgo, nowIso)
      const charged = await chargedProducts(monthStart, nowIso)
      const rank = (sales: ProductSale[]) =>
        forSale
          .map((item) => {
            const found = sales.find((row) => row.id === item.id)
            return { name: item.name, unit: item.unit, units: found?.units ?? 0, cents: found?.cents ?? "0", id: item.id, patients: found?.patients ?? 0 }
          })
          .sort((a, b) => a.units - b.units || Number(a.cents) - Number(b.cents) || a.name.localeCompare(b.name))
      const least = rank(month)
      const unsold = least.filter((row) => row.units === 0)
      return {
        respuesta: least.length
          ? `Tienes ${howMany(forSale.length, "producto", "productos")} a la venta. ${capital(thisMonth)}, de menos a más vendido: ${saleWords(least.slice(0, 5))}.${unsold.length ? ` Sin ninguna venta pagada: ${unsold.map((row) => row.name).join(", ")}.` : ` Todos tuvieron al menos una venta pagada; con las mismas unidades, el que menos dejó es ${least[0]?.name}.`}`
          : "No tienes productos activos a la venta.",
        criterio: "Productos activos marcados «Se vende», con lo pagado este mes (cero si no se vendieron), de menos a más por unidades y después por monto.",
        nota: `En los últimos 12 meses, de menos a más: ${saleWords(rank(year).slice(0, 5))}. Contando lo cargado este mes aunque no se haya pagado: ${saleWords(rank(charged).slice(0, 5))}.`,
        datos: { mes: least, doceMeses: rank(year), cargadoMes: rank(charged) },
      }
    },
    t5: async () => {
      const month = await paidProducts(monthStart, nowIso)
      const year = await paidProducts(yearAgo, nowIso)
      const byMoney = (rows: ProductSale[]) => [...rows].sort((a, b) => Number(b.cents) - Number(a.cents) || a.name.localeCompare(b.name))
      return {
        respuesta: `No puedo saber la ganancia de cada producto: odentIA no guarda cuánto te costó cada unidad que vendes. Lo más cercano es lo que pagaron por ellos ${thisMonth}: ${saleWords(byMoney(month).slice(0, 5)) || "ninguna venta pagada"}. Es lo cobrado, sin restar el costo.`,
        criterio: "Trampa: sin el costo de lo vendido no hay ganancia. Se ofrece lo pagado por producto este mes, de más a menos, sin restar nada.",
        nota: `En los últimos 12 meses, lo pagado por producto: ${saleWords(byMoney(year).slice(0, 5)) || "ninguno"}.`,
        datos: { mes: byMoney(month), doceMeses: byMoney(year) },
      }
    },
    t6: async () => {
      const { month, charged, top } = await topProducts(5)
      return {
        respuesta: top.length
          ? `${capital(thisMonth)} se vendieron y pagaron ${howMany(month.length, "producto", "productos")}: ${saleWords(top)}. En total, ${money(totalCents(month))}.`
          : `${capital(thisMonth)} todavía no se pagó ningún producto.`,
        criterio: "Productos (no tratamientos) con pagos vigentes este mes, sin anulados ni lo devuelto; por unidades y después por monto.",
        nota: `Contando lo cargado este mes aunque no se haya pagado: ${saleWords(charged.slice(0, 5)) || "ninguno"}.`,
        datos: { mes: month, cargadoMes: charged },
      }
    },
    t7: async () => {
      const compare = (current: ProductSale[], before: ProductSale[]) => {
        const ids = [...new Set([...current, ...before].map((row) => row.id))]
        return ids
          .map((id) => {
            const now = current.find((row) => row.id === id)
            const then = before.find((row) => row.id === id)
            const name = (now ?? then)?.name ?? ""
            const unit = (now ?? then)?.unit ?? "unidad"
            return { name, unit, units: now?.units ?? 0, unitsBefore: then?.units ?? 0, cents: Number(now?.cents ?? 0), centsBefore: Number(then?.cents ?? 0) }
          })
          .sort((a, b) => b.units - b.unitsBefore - (a.units - a.unitsBefore) || b.cents - b.centsBefore - (a.cents - a.centsBefore) || a.name.localeCompare(b.name))
      }
      const paid = compare(await paidProducts(monthStart, nowIso), await paidProducts(previous.start, previous.end))
      const charged = compare(await chargedProducts(monthStart, nowIso), await chargedProducts(previous.start, previous.end))
      const up = paid.filter((row) => row.units > row.unitsBefore)
      const down = paid.filter((row) => row.units < row.unitsBefore)
      const changeWords = (rows: typeof paid) =>
        listOf(rows.map((row) => ({ name: row.name, value: `de ${row.unitsBefore} a ${row.units}; ${money(row.centsBefore)} → ${money(row.cents)}` })))
      return {
        respuesta: up.length
          ? `${capital(thisMonth)}, frente a ${lastMonthDays}, subieron ${howMany(up.length, "producto", "productos")}: ${changeWords(up)}.${down.length ? ` Bajaron: ${changeWords(down)}.` : " Ninguno bajó."}`
          : `Ningún producto vendió más ${thisMonth} que en ${lastMonthDays}.`,
        criterio: "Unidades de producto pagadas este mes frente a los mismos días del mes anterior (como compara Reportes); sube el que vendió más unidades.",
        nota: `Por monto pagado suben: ${changeWords(paid.filter((row) => row.cents > row.centsBefore)) || "ninguno"}. Contando lo cargado aunque no se haya pagado, suben: ${changeWords(charged.filter((row) => row.units > row.unitsBefore)) || "ninguno"}.`,
        datos: { pagado: paid, cargado: charged, anterior: previous },
      }
    },
    t8: async () => {
      const month = await paidTreatments(monthStart, nowIso)
      const year = await paidTreatments(yearAgo, nowIso)
      return {
        respuesta: `No puedo decirte cuáles son los más rentables: odentIA no guarda lo que te cuesta cada tratamiento (laboratorio, materiales, el tiempo del profesional y los gastos generales). Lo más cercano es lo que más ingresos dejó ${thisMonth}: ${centsWords(month.slice(0, 5))}. Es lo cobrado, sin restar costos.`,
        criterio: "Trampa: sin el costo de cada tratamiento no hay rentabilidad. Se ofrece lo pagado este mes por tratamiento (sin productos ni anulados), los 5 primeros.",
        nota: `En los últimos 12 meses, lo que más ingresos dejó: ${centsWords(year.slice(0, 5))}.`,
        datos: { mes: month.slice(0, 10), doceMeses: year.slice(0, 10) },
      }
    },
    t9: async () => {
      const [all] = await tx.execute<{ count: number; cents: string; treatments: number; treatmentCents: string }>(sql`
        select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents,
          (count(*) filter (where c.product_id is null))::int as treatments,
          coalesce(sum(c.amount_cents) filter (where c.product_id is null), 0)::text as "treatmentCents"
        from patient_charge c
        left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
        where c.organization_id = ${org} and c.voided_at is null
          and coalesce(o.created_at, c.created_at) >= ${monthStart}::timestamptz and coalesce(o.created_at, c.created_at) < ${nowIso}::timestamptz`)
      const [tickets] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(t.total_cents), 0)::text as cents from payment_ticket t
        where t.organization_id = ${org} and t.voided_at is null and t.created_at >= ${monthStart}::timestamptz and t.created_at < ${nowIso}::timestamptz`)
      const [payments] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(pay.amount_cents), 0)::text as cents from patient_payment pay
        where pay.organization_id = ${org} and pay.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz`)
      const average = (cents: string | undefined, count: number | undefined) => (count ? money(Math.round(Number(cents ?? 0) / count)) : "sin dato")
      return {
        respuesta: `${capital(thisMonth)}, el ticket promedio de venta es ${average(all?.cents, all?.count)}: ${all?.count ?? 0} ventas (tratamientos y productos cargados) por ${money(Number(all?.cents ?? 0))}.`,
        criterio: "Lo cargado este mes (conceptos vigentes, tratamientos y productos) ÷ cuántos conceptos.",
        nota: `Solo tratamientos: ${average(all?.treatmentCents, all?.treatments)} (${all?.treatments ?? 0} por ${money(Number(all?.treatmentCents ?? 0))}). Por ticket de pago de Cobrar: ${average(tickets?.cents, tickets?.count)} (${tickets?.count ?? 0} tickets por ${money(Number(tickets?.cents ?? 0))}). Por pago recibido: ${average(payments?.cents, payments?.count)} (${payments?.count ?? 0} pagos por ${money(Number(payments?.cents ?? 0))}).`,
        datos: { cargado: all, tickets, pagos: payments },
      }
    },
    t10: async () => {
      const { month, year, charged, top } = await topProducts(5)
      const byPeople = [...month].sort((a, b) => b.patients - a.patients || b.units - a.units || a.name.localeCompare(b.name))
      const people = (rows: ProductSale[]) =>
        listOf(rows.map((row) => ({ name: row.name, value: `${unitsWord(row.units, row.unit)}, ${howMany(row.patients, "paciente", "pacientes")}, ${money(Number(row.cents))}` })))
      return {
        respuesta: top.length
          ? `${capital(thisMonth)}, lo que más compran tus pacientes es: ${people(top)}. Son ${howMany(month.length, "producto", "productos")} con ventas pagadas.`
          : `${capital(thisMonth)} los pacientes todavía no pagaron ningún producto.`,
        criterio: "Productos con pagos vigentes este mes, por unidades y después por monto, con cuántos pacientes distintos los compraron.",
        nota: `Por cuántos pacientes distintos los compraron: ${people(byPeople.slice(0, 5)) || "ninguno"}. En los últimos 12 meses: ${people(year.slice(0, 5)) || "ninguno"}. Contando lo cargado este mes aunque no se haya pagado: ${people(charged.slice(0, 5)) || "ninguno"}.`,
        datos: { mes: month, doceMeses: year, cargadoMes: charged },
      }
    },
  }
}
