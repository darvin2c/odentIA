/**
 * Las respuestas correctas de las preguntas generadas (`eval/argos-generadas.json`), parte 2:
 * g026–g050, ventas y pacientes. Mismas reglas que las carpetas del dueño:
 * «realizado» es un procedimiento sin anular de una atención firmada, contando
 * su cantidad (como `tratamientos_hechos` de Argos, por el día de la atención);
 * «vendido» es lo pagado de lo cargado (pagos vigentes aplicados a conceptos sin
 * anular, por el día del pago); el ticket promedio es lo cobrado ÷ pacientes que
 * pagaron (f9, d6); un paciente excluye Spam y bloqueados. Sin periodo, el mes
 * en curso hasta ahora; «este año», del 1 de enero a hoy; un mes nombrado, el
 * más reciente con ese nombre que ya empezó.
 */
import { getReportList, lapsedSql, reportScope } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { dayStart, goldenWords } from "./finance.js"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel, sameDaysWords } from "./trends.js"

type Done = { name: string; times: number; rows: number; encounters: number; patients: number }
type Sold = {
  name: string
  kind: "tratamiento" | "producto"
  specialty: string | null
  sales: number
  cents: string
}
type ProductSale = { name: string; unit: string; units: number; cents: string }

/** «1 frasco», «2 cepillos», «3 unidades». */
function unitsWord(count: number, unit: string): string {
  if (count === 1) return `1 ${unit}`
  return `${count} ${/[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`}`
}

export function generatedSolvers2(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const { tx, org, money, show, listOf } = h
  const nowIso = w.nowIso
  const current = h.scope.window.from
  const days = sameDaysWords(h)
  const previous = {
    start: h.scope.window.previous.start.toISOString(),
    end: h.scope.window.previous.end.toISOString(),
  }
  const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`
  const howMany = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`
  const shortDay = (iso: string) =>
    new Intl.DateTimeFormat(h.scope.locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: h.tz,
    }).format(new Date(iso))
  /** «del lunes 12 al domingo 18 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  const todayDay = Number(w.todayKey.slice(8, 10))
  /** «en lo que va de 2026 (del 1 de enero al 21 de octubre)». */
  const yearSoFar = `en lo que va de ${current.year} (del 1 de enero al ${todayDay} de ${monthLabel(h, current, false)})`
  const yearStart = () => dayStart(h, `${current.year}-01-01`)
  /** El mes anterior completo. */
  const lastMonth = async () => {
    const month =
      current.month === 1
        ? { year: current.year - 1, month: 12 }
        : { year: current.year, month: current.month - 1 }
    return {
      ...month,
      start: await dayStart(h, `${month.year}-${String(month.month).padStart(2, "0")}-01`),
      end: h.monthStart,
      words: monthLabel(h, month),
    }
  }
  /** El mes con ese número más reciente que ya empezó: «setiembre» en octubre de 2026 es setiembre de 2026; el en curso, hasta ahora. */
  const namedMonth = async (month: number) => {
    const year = month <= current.month ? current.year : current.year - 1
    const key = `${year}-${String(month).padStart(2, "0")}`
    const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`
    const start = await dayStart(h, `${key}-01`)
    const full = await dayStart(h, `${next}-01`)
    const partial = new Date(full).getTime() > h.now.getTime()
    const words = partial
      ? `${monthLabel(h, { year, month }, false)} (del 1 al ${todayDay}, hasta hoy)`
      : monthLabel(h, { year, month })
    return { year, month, key, start, end: partial ? nowIso : full, partial, words }
  }
  /** La semana pasada, de lunes a domingo, y la anterior. */
  const lastWeek = async () => {
    const weekday = new Date(`${w.todayKey}T12:00:00Z`).getUTCDay()
    const monday = w.addDays(w.todayKey, -((weekday + 6) % 7))
    const from = w.addDays(monday, -7)
    const to = w.addDays(monday, -1)
    return {
      from,
      to,
      key: `${from}..${to}`,
      start: await dayStart(h, from),
      end: await dayStart(h, monday),
      before: {
        from: w.addDays(from, -7),
        to: w.addDays(to, -7),
        start: await dayStart(h, w.addDays(from, -7)),
        end: await dayStart(h, from),
      },
      words: spanWords(from, to),
    }
  }
  const branchNamed = async (word: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select id, name from branch where organization_id = ${org} and name ilike ${`%${word}%`} order by is_active desc, name limit 1`)
    return row ?? null
  }
  /** Lo registrado alguna vez en una sede: cobros, cargos, citas y atenciones. */
  const everIn = async (branchId: string) => {
    const [row] = await tx.execute<{
      payments: number
      charges: number
      appointments: number
      encounters: number
    }>(sql`
      select (select count(*) from patient_payment where organization_id = ${org} and branch_id = ${branchId})::int as payments,
        (select count(*) from patient_charge where organization_id = ${org} and branch_id = ${branchId})::int as charges,
        (select count(*) from appointment where organization_id = ${org} and branch_id = ${branchId})::int as appointments,
        (select count(*) from encounter where organization_id = ${org} and branch_id = ${branchId})::int as encounters`)
    return row ?? { payments: 0, charges: 0, appointments: 0, encounters: 0 }
  }
  /** Hace `months` meses en el calendario de la clínica (como «Sin venir»). */
  const monthsAgo = (months: number) =>
    sql`((${nowIso}::timestamptz at time zone ${h.tz}) - make_interval(months => ${months})) at time zone ${h.tz}`
  /** La persona del paciente, sin Spam ni bloqueados. */
  const person = (patientColumn: SQL) =>
    sql`join patient p on p.organization_id = ${org} and p.id = ${patientColumn} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null`

  // --- Lo realizado --------------------------------------------------------------------------
  const doneFrom = (start: string, end: string, where: SQL) => sql`
    from encounter_procedure ep
    join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
    left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
    where ep.organization_id = ${org} and ep.voided_at is null
      and e.started_at >= ${start}::timestamptz and e.started_at < ${end}::timestamptz ${where}`
  /** Procedimientos de atenciones firmadas en [start, end), por tratamiento, contando su cantidad. */
  const done = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<Done>(sql`
      select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times, count(*)::int as rows,
        count(distinct e.id)::int as encounters, count(distinct e.patient_id)::int as patients
      ${doneFrom(start, end, where)}
      group by 1 order by 2 desc, 1`)
  /** Lo mismo, en una sola cifra. */
  const doneTotal = async (
    start: string,
    end: string,
    where: SQL = sql``,
  ): Promise<Omit<Done, "name">> => {
    const [row] = await tx.execute<Omit<Done, "name">>(sql`
      select coalesce(sum(ep.quantity), 0)::int as times, count(*)::int as rows,
        count(distinct e.id)::int as encounters, count(distinct e.patient_id)::int as patients
      ${doneFrom(start, end, where)}`)
    return row ?? { times: 0, rows: 0, encounters: 0, patients: 0 }
  }
  /** Por otra cosa (sede, profesional): `by` es la expresión del grupo. */
  const doneBy = (by: SQL, start: string, end: string, where: SQL = sql``) =>
    tx.execute<{ name: string; times: number; rows: number }>(sql`
      select ${by} as name, sum(ep.quantity)::int as times, count(*)::int as rows
      from encounter_procedure ep
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
      left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
      left join branch b on b.organization_id = e.organization_id and b.id = e.branch_id
      left join "user" u on u.id = e.dentist_user_id
      where ep.organization_id = ${org} and ep.voided_at is null
        and e.started_at >= ${start}::timestamptz and e.started_at < ${end}::timestamptz ${where}
      group by 1 order by 2 desc, 1`)
  const timesWords = (rows: Array<{ name: string; times: number }>) =>
    listOf(rows.map((row) => ({ name: row.name, value: `${row.times}` })))
  /** Un solo servicio: «nombre»; varios, cada uno con sus veces. */
  const serviceWords = (rows: Array<{ name: string; times: number }>) =>
    rows.length === 1 ? `«${rows[0]?.name}»` : timesWords(rows)

  // --- Lo vendido ----------------------------------------------------------------------------
  /** La especialidad del servicio del concepto (el de la atención, el del presupuesto o el del plan), como `argos.ventas`. */
  const specialtyJoins = sql`
    left join treatment_budget_item bi on bi.organization_id = c.organization_id and bi.id = c.budget_item_id
    left join service_catalog sx on sx.organization_id = c.organization_id and sx.id = coalesce(ep.service_id, bi.service_id, pi.service_id)
    left join org_specialty os on os.organization_id = c.organization_id and os.id = sx.specialty_id`
  /** Lo pagado en [start, end) aplicado a cada concepto sin anular (pagos vigentes), de más a menos. */
  const sold = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<Sold>(sql`
      select ${h.conceptName} as name, case when c.product_id is null then 'tratamiento' else 'producto' end as kind,
        os.name as specialty, count(distinct c.id)::int as sales, sum(a.amount_cents)::text as cents
      from patient_payment_application a
      join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
      ${h.conceptJoins} ${specialtyJoins}
      where a.organization_id = ${org} and a.voided_at is null and pay.currency = ${h.scope.currency}
        and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz ${where}
      group by 1, 2, 3 order by sum(a.amount_cents) desc, 1`)
  /** Lo cargado en [start, end), pagado o no, sin anulados. */
  const charged = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<Sold>(sql`
      select ${h.conceptName} as name, case when c.product_id is null then 'tratamiento' else 'producto' end as kind,
        os.name as specialty, count(*)::int as sales, sum(c.amount_cents)::text as cents
      from patient_charge c ${h.conceptJoins} ${specialtyJoins}
      where c.organization_id = ${org} and c.voided_at is null and c.currency = ${h.scope.currency}
        and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz ${where}
      group by 1, 2, 3 order by sum(c.amount_cents) desc, 1`)
  const centsOf = (rows: Array<{ cents: string }>) =>
    rows.reduce((sum, row) => sum + Number(row.cents), 0)
  const salesOf = (rows: Array<{ sales: number }>) => rows.reduce((sum, row) => sum + row.sales, 0)
  const centsWords = (rows: Array<{ name: string; cents: string }>) =>
    listOf(rows.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))
  /** Ortodoncia: la especialidad del servicio o su nombre. */
  const ortho = sql`and (os.name ilike '%ortodon%' or ${h.conceptName} ilike '%ortodon%')`

  /** Productos con pagos vigentes en [start, end): las unidades del cargo pagado y lo pagado en el tramo. */
  const paidProducts = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<ProductSale>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
          and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz) ap on ap.cents > 0
      where c.organization_id = ${org} and c.voided_at is null ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 1`)
  /** Productos cargados en [start, end), pagados o no (la venta es del día del primer cargo de la cadena). */
  const chargedProducts = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<ProductSale>(sql`
      select pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(c.amount_cents)::text as cents
      from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
      left join patient_charge o on o.organization_id = c.organization_id and o.id = c.original_charge_id
      where c.organization_id = ${org} and c.voided_at is null
        and coalesce(o.created_at, c.created_at) >= ${start}::timestamptz and coalesce(o.created_at, c.created_at) < ${end}::timestamptz ${where}
      group by 1, 2 order by sum(c.product_quantity) desc, sum(c.amount_cents) desc, 1`)
  const forSale = () =>
    tx.execute<{ name: string }>(
      sql`select name from product where organization_id = ${org} and is_active and for_sale order by name`,
    )
  const productWords = (rows: ProductSale[]) =>
    listOf(
      rows.map((row) => ({
        name: row.name,
        value: `${unitsWord(row.units, row.unit)}, ${money(Number(row.cents))}`,
      })),
    )

  /** Pacientes distintos con un pago vigente en [start, end), por sede del pago. */
  const payersBy = (start: string, end: string) =>
    tx.execute<{ branchId: string | null; payers: number; payments: number }>(sql`
      select pay.branch_id as "branchId", count(distinct pay.patient_id)::int as payers, count(*)::int as payments
      from patient_payment pay
      where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
        and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz
      group by 1`)
  const payersIn = async (start: string, end: string) => {
    const [row] = await tx.execute<{ payers: number; payments: number }>(sql`
      select count(distinct pay.patient_id)::int as payers, count(*)::int as payments from patient_payment pay
      where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
        and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz`)
    return row ?? { payers: 0, payments: 0 }
  }
  const per = (cents: number, count: number) =>
    count > 0 ? money(Math.round(cents / count)) : "sin dato"

  // --- Pacientes atendidos -------------------------------------------------------------------
  /** Pacientes distintos con una cita atendida en [start, end) y cuántos de ellos son nuevos (su primera cita atendida cae dentro). */
  const attendedIn = async (start: string, end: string) => {
    const [row] = await tx.execute<{ total: number; fresh: number; appointments: number }>(sql`
      with attended as (
        select a.id, a.patient_id, a.starts_at from appointment a ${person(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz),
      first_visit as (select distinct on (patient_id) patient_id, starts_at from attended order by patient_id, starts_at, id),
      seen as (select patient_id, count(*) as appointments from attended where starts_at >= ${start}::timestamptz and starts_at < ${end}::timestamptz group by 1)
      select count(*)::int as total, count(*) filter (where f.starts_at >= ${start}::timestamptz)::int as fresh, coalesce(sum(s.appointments), 0)::int as appointments
      from seen s join first_visit f on f.patient_id = s.patient_id`)
    return row ?? { total: 0, fresh: 0, appointments: 0 }
  }

  return {
    g026: async () => {
      const cleaning = sql`and (s.name ilike '%limpieza%' or s.name ilike '%profilaxis%')`
      const rows = await done(h.monthStart, nowIso, cleaning)
      const total = await doneTotal(h.monthStart, nowIso, cleaning)
      const before = await doneTotal(previous.start, previous.end, cleaning)
      const paid = await sold(
        h.monthStart,
        nowIso,
        sql`and (${h.conceptName} ilike '%limpieza%' or ${h.conceptName} ilike '%profilaxis%')`,
      )
      const [visits] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from appointment a where a.organization_id = ${org} and a.status = 'atendida'
          and (a.service_name ilike '%limpieza%' or a.service_name ilike '%profilaxis%')
          and a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      return {
        respuesta: total.times
          ? `Este mes (${w.monthSoFar}) se hicieron ${total.times} limpiezas (${serviceWords(rows)}), a ${howMany(total.patients, "paciente", "pacientes")}.`
          : `Este mes (${w.monthSoFar}) todavía no se hizo ninguna limpieza.`,
        criterio:
          "Procedimientos sin anular de limpieza o profilaxis en atenciones firmadas del mes en curso (por el día de la atención), contando su cantidad.",
        nota: `Contando cada procedimiento una vez, sin su cantidad: ${total.rows}. En ${days.sameAs}: ${before.times} (${before.rows} procedimientos). Citas atendidas de limpieza este mes: ${visits?.count ?? 0}. Lo pagado este mes por limpiezas: ${money(centsOf(paid))} (${salesOf(paid)} pagadas).`,
        datos: {
          mes: rows,
          total,
          mismosDiasMesAnterior: before,
          citas: visits?.count ?? 0,
          pagado: paid,
        },
      }
    },

    g027: async () => {
      const month = await namedMonth(9)
      const result = await h.fig("cobrado", "tratamiento", month.key)
      const products = await tx.execute<{ name: string }>(sql`
        select distinct c.description as name from patient_charge c where c.organization_id = ${org} and c.product_id is not null and c.description is not null`)
      const productNames = new Set([...products].map((row) => row.name))
      const rows = result.rows.filter((row) => row.key !== "otros" && !productNames.has(row.label))
      const total = result.total.value ?? 0
      const paid = (await sold(month.start, month.end)).filter((row) => row.kind === "tratamiento")
      const loaded = (await charged(month.start, month.end)).filter(
        (row) => row.kind === "tratamiento",
      )
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${month.words} el tratamiento que más plata dejó fue ${top.label}: ${show(result, top.value.value)} cobrados, el ${w.pct(top.value.value ?? 0, total)} de lo cobrado en el mes (${show(result)}). Le siguen ${listOf(rows.slice(1, 3).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`
          : `En ${month.words} no hubo cobros de tratamientos.`,
        criterio:
          "«Lo cobrado» de Reportes por tratamiento (lo aplicado a cada servicio, sin anulados y restando lo devuelto), del mes nombrado completo; sin productos.",
        nota: `Por lo pagado ese mes aplicado a cada tratamiento: ${centsWords(paid.slice(0, 3))}. Si es lo cargado ese mes (pagado o no): ${centsWords(loaded.slice(0, 3))}.`,
        datos: {
          mes: month.key,
          reportes: result.rows,
          total: result.total,
          pagado: paid.slice(0, 10),
          cargado: loaded.slice(0, 10),
        },
      }
    },

    g028: async () => {
      const branch = await branchNamed("miraflores")
      const start = await yearStart()
      const whitening = sql`and s.name ilike '%blanque%'`
      const byBranch = await doneBy(sql`coalesce(b.name, 'Sin sede')`, start, nowIso, whitening)
      const inBranch = branch
        ? await doneTotal(start, nowIso, sql`${whitening} and e.branch_id = ${branch.id}`)
        : null
      const names = branch
        ? await done(start, nowIso, sql`${whitening} and e.branch_id = ${branch.id}`)
        : []
      const yearAgo = await dayStart(h, w.yearAgoKey)
      const lastYear = branch
        ? await doneTotal(yearAgo, nowIso, sql`${whitening} and e.branch_id = ${branch.id}`)
        : null
      const all = byBranch.reduce((sum, row) => sum + row.times, 0)
      return {
        respuesta: !branch
          ? `No hay una sede Miraflores. Blanqueamientos ${yearSoFar} por sede: ${timesWords(byBranch)}.`
          : inBranch?.times
            ? `${capital(yearSoFar)} se hicieron ${inBranch.times} blanqueamientos en la ${branch.name} (${serviceWords(names)}), a ${howMany(inBranch.patients, "paciente", "pacientes")}.`
            : `${capital(yearSoFar)} no se hizo ningún blanqueamiento en la ${branch.name}.`,
        criterio:
          "Procedimientos sin anular de blanqueamiento en atenciones firmadas de la sede, del 1 de enero a hoy (por el día de la atención), contando su cantidad.",
        nota: `En toda la clínica, ${all} (${timesWords(byBranch)}). En los últimos 365 días en esa sede: ${lastYear?.times ?? 0}.`,
        datos: { sede: branch, sedeAño: inBranch, porSede: byBranch, ultimos365: lastYear },
      }
    },

    g029: async () => {
      const month = await lastMonth()
      const paid = await paidProducts(month.start, month.end)
      const loaded = await chargedProducts(month.start, month.end)
      const catalog = await forSale()
      const now = await paidProducts(h.monthStart, nowIso)
      const pastes = catalog.some((row) => /pasta/i.test(row.name))
      return {
        respuesta: paid.length
          ? `En ${month.words} se vendieron ${money(centsOf(paid))} en productos: ${productWords(paid)}.${pastes ? "" : " No tienes pastas dentales en tus productos."}`
          : `En ${month.words} no se vendió ningún producto: no hay pagos de cepillos, enjuagues ni otros productos ese mes (${money(0)}). Tus productos a la venta son ${catalog.map((row) => row.name).join(" y ")}${pastes ? "" : "; no tienes pastas dentales"}.`,
        criterio:
          "Productos (conceptos con producto) con pagos vigentes en el mes anterior completo, sin anulados ni lo devuelto: lo pagado y sus unidades.",
        nota: `Contando lo cargado ese mes aunque no se haya pagado: ${productWords(loaded) || "nada"}. Este mes (${w.monthSoFar}) sí se vendieron: ${productWords(now) || "ninguno"}${now.length ? `, ${money(centsOf(now))} en total` : ""}.`,
        datos: {
          mes: `${month.year}-${month.month}`,
          pagado: paid,
          cargado: loaded,
          aLaVenta: catalog,
          esteMes: now,
        },
      }
    },

    g030: async () => {
      const branch = await branchNamed("isidro")
      const collected = await h.fig("cobrado", "sede")
      const attended = await h.fig("atendidas", "sede")
      const leaves = await h.fig("lo_que_deja", "sede")
      const branchValue = (result: typeof collected) =>
        branch ? (result.rows.find((row) => row.key === branch.id)?.value.value ?? 0) : 0
      const cents = branchValue(collected)
      const visits = branchValue(attended)
      const kept = branchValue(leaves)
      const [own] = branch
        ? await tx.execute<{ encounters: number; cents: string }>(sql`
            select count(distinct e.id)::int as encounters, coalesce(sum(c.amount_cents), 0)::text as cents
            from encounter e
            left join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id and ep.voided_at is null
            left join patient_charge c on c.organization_id = ep.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null
            where e.organization_id = ${org} and e.status = 'finalizada' and e.voided_at is null and e.branch_id = ${branch.id}
              and e.started_at >= ${h.monthStart}::timestamptz and e.started_at < ${nowIso}::timestamptz`)
        : []
      const totalVisits = attended.rows.reduce((sum, row) => sum + (row.value.value ?? 0), 0)
      return {
        respuesta: !branch
          ? "No hay una sede San Isidro."
          : visits
            ? `Este mes (${w.monthSoFar}), en la ${branch.name} cada cita atendida deja en promedio ${per(cents, visits)}: ${money(cents)} cobrados en la sede entre ${visits} citas atendidas.`
            : `Este mes (${w.monthSoFar}) la ${branch.name} todavía no tiene citas atendidas.`,
        criterio:
          "«Lo cobrado» de Reportes de la sede (pagos de la sede menos lo anulado y lo devuelto) ÷ sus «Citas atendidas» de Reportes, del mes en curso.",
        nota: `Con lo cargado por lo hecho en cada atención firmada de la sede este mes (pagado o no): ${per(Number(own?.cents ?? 0), own?.encounters ?? 0)} por atención (${money(Number(own?.cents ?? 0))} en ${own?.encounters ?? 0} atenciones). Con «Lo que deja» de la sede (después de comisiones y gastos): ${per(kept, visits)} por cita. En toda la clínica: ${per(collected.total.value ?? 0, totalVisits)} por cita atendida.`,
        datos: {
          sede: branch,
          cobrado: cents,
          citasAtendidas: visits,
          loQueDeja: kept,
          cargado: own ?? null,
          clinica: { cobrado: collected.total, citas: totalVisits },
        },
      }
    },

    g031: async () => {
      const surco = await branchNamed("surco")
      const miraflores = await branchNamed("miraflores")
      const collected = await h.fig("cobrado", "sede")
      const payers = await payersBy(h.monthStart, nowIso)
      const of = (branch: { id: string; name: string } | null) => {
        const cents = branch
          ? (collected.rows.find((row) => row.key === branch.id)?.value.value ?? 0)
          : 0
        const people = branch ? payers.find((row) => row.branchId === branch.id) : undefined
        return {
          name: branch?.name ?? "",
          cents,
          payers: people?.payers ?? 0,
          payments: people?.payments ?? 0,
        }
      }
      const s = of(surco)
      const m = of(miraflores)
      const ever = surco ? await everIn(surco.id) : null
      const others = collected.rows
        .filter((row) => row.key !== surco?.id && row.key !== miraflores?.id)
        .map((row) => of({ id: row.key, name: row.label }))
      const ticket = (row: typeof s) => per(row.cents, row.payers)
      const neverAnything = ever && !ever.payments && !ever.charges && !ever.appointments
      return {
        respuesta: !surco
          ? `No hay una sede Surco. El ticket promedio de la ${m.name} este mes (${w.monthSoFar}) es ${ticket(m)} por paciente.`
          : !s.payers
            ? `No se puede comparar: la ${s.name} no tiene ningún cobro este mes${neverAnything ? " (ni cobros, citas ni atenciones registrados nunca)" : ""}, así que no tiene ticket promedio. El de la ${m.name} este mes (${w.monthSoFar}) es ${ticket(m)} por paciente: ${money(m.cents)} cobrados de ${m.payers} pacientes que pagaron.`
            : `Este mes (${w.monthSoFar}) el ticket promedio de la ${s.name} (${ticket(s)} por paciente) es ${s.cents / s.payers > m.cents / Math.max(1, m.payers) ? "más alto" : "más bajo"} que el de la ${m.name} (${ticket(m)}).`,
        criterio:
          "Ticket promedio = «Lo cobrado» de Reportes de cada sede ÷ pacientes distintos con un pago vigente en esa sede, del mes en curso (como f9 y d6).",
        nota: `Por pago recibido (cada ticket): ${m.name} ${per(m.cents, m.payments)} en ${m.payments} pagos${s.payments ? `; ${s.name} ${per(s.cents, s.payments)}` : ""}. ${others.map((row) => `${row.name}: ${ticket(row)} por paciente (${money(row.cents)} de ${row.payers} pacientes)`).join("; ")}.`,
        datos: { surco: s, miraflores: m, otras: others, surcoAlgunaVez: ever },
      }
    },

    g032: async () => {
      const start = await yearStart()
      const implant = sql`and s.name ilike '%implant%'`
      const total = await doneTotal(start, nowIso, implant)
      const rows = await done(start, nowIso, implant)
      const ever = await doneTotal("1900-01-01T00:00:00Z", nowIso, implant)
      const [value] = await tx.execute<{ cents: string }>(sql`
        select coalesce(sum(ep.price_cents::bigint * ep.quantity), 0)::text as cents ${doneFrom(start, nowIso, implant)}`)
      const implantName = sql`and ${h.conceptName} ilike '%implant%'`
      const loaded = await charged(start, nowIso, implantName)
      const paid = await sold(start, nowIso, implantName)
      const [elsewhere] = await tx.execute<{ budgets: number; plans: number }>(sql`
        select (select count(*) from treatment_budget_item bi join service_catalog s on s.organization_id = bi.organization_id and s.id = bi.service_id
            where bi.organization_id = ${org} and s.name ilike '%implant%')::int as budgets,
          (select count(*) from treatment_plan_item pi join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
            where pi.organization_id = ${org} and s.name ilike '%implant%')::int as plans`)
      const catalog = await tx.execute<{ name: string; cents: number | null }>(sql`
        select name, price_cents as cents from service_catalog where organization_id = ${org} and is_active and name ilike '%implante%' and price_cents is not null
        order by price_cents desc nulls last, name`)
      return {
        respuesta: total.times
          ? `${capital(yearSoFar)} se colocaron ${total.times} implantes (${timesWords(rows)}), por ${money(Number(value?.cents ?? 0))} a precio de la atención; de eso se cargó ${money(centsOf(loaded))} y se pagó ${money(centsOf(paid))}.`
          : `${capital(yearSoFar)} no se colocó ningún implante: no hay atenciones firmadas con un implante, así que no suman nada (${money(0)}).${!centsOf(loaded) && !elsewhere?.budgets && !elsewhere?.plans ? " Tampoco hay implantes cargados, presupuestados ni indicados en los planes." : ""}${catalog.length ? ` En el catálogo está ${listOf(catalog.map((row) => ({ name: `«${row.name}»`, value: money(row.cents) })))}.` : ""}`,
        criterio:
          "Procedimientos sin anular de implante en atenciones firmadas del 1 de enero a hoy (por el día de la atención), contando su cantidad; lo que suman es su precio × cantidad, y aparte lo cargado y lo pagado.",
        nota: `Desde siempre: ${ever.times} implantes colocados. Implantes en presupuestos: ${elsewhere?.budgets ?? 0}; en planes de tratamiento: ${elsewhere?.plans ?? 0}.`,
        datos: {
          año: total,
          porServicio: rows,
          valor: Number(value?.cents ?? 0),
          cargado: loaded,
          pagado: paid,
          siempre: ever,
          otros: elsewhere,
          catalogo: catalog,
        },
      }
    },

    g033: async () => {
      const surco = await branchNamed("surco")
      const yearAgo = await dayStart(h, w.yearAgoKey)
      const inSurco = surco
        ? await paidProducts("1900-01-01T00:00:00Z", nowIso, sql`and c.branch_id = ${surco.id}`)
        : []
      const loadedSurco = surco
        ? await chargedProducts("1900-01-01T00:00:00Z", nowIso, sql`and c.branch_id = ${surco.id}`)
        : []
      const byBranch = await tx.execute<{
        branch: string
        name: string
        unit: string
        units: number
        cents: string
      }>(sql`
        select coalesce(b.name, 'Sin sede') as branch, pr.name, pr.unit, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents
        from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
        left join branch b on b.organization_id = c.organization_id and b.id = c.branch_id
        join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
            and pay.paid_at >= ${yearAgo}::timestamptz and pay.paid_at < ${nowIso}::timestamptz) ap on ap.cents > 0
        where c.organization_id = ${org} and c.voided_at is null
        group by 1, 2, 3 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 2`)
      const month = await paidProducts(
        h.monthStart,
        nowIso,
        surco ? sql`and c.branch_id = ${surco.id}` : sql``,
      )
      const ever = surco ? await everIn(surco.id) : null
      const branches = [...new Set(byBranch.map((row) => row.branch))]
      const top = byBranch[0]
      const tiedUnits = top ? byBranch.filter((row) => row.units === top.units).length : 0
      const topWords = top
        ? tiedUnits > 1
          ? `empatan en unidades (${unitsWord(top.units, "unidad")} cada uno) y por monto va primero ${top.name}`
          : `el que más se vende es ${top.name}`
        : ""
      return {
        respuesta: !surco
          ? "No hay una sede Surco."
          : inSurco.length
            ? `En la ${surco.name} el producto que más se vende este mes (${w.monthSoFar}) es ${month[0]?.name ?? inSurco[0]?.name}: ${productWords(month.length ? month.slice(0, 3) : inSurco.slice(0, 3))}.`
            : `En la ${surco.name} no se ha vendido ningún producto: no tiene cargos ni pagos de productos registrados${ever && !ever.payments && !ever.charges ? " (ni ningún otro cobro)" : ""}. ${top ? `Las ventas de productos de la clínica son de la ${branches.join(" y la ")}: en los últimos 12 meses, ${listOf(byBranch.map((row) => ({ name: row.name, value: `${unitsWord(row.units, row.unit)}, ${money(Number(row.cents))}` })))}; ${topWords}.` : "La clínica no tiene ventas de productos."}`,
        criterio:
          "Productos con pagos vigentes cuyo cargo es de la sede (sin anulados ni lo devuelto), por unidades y después por monto; si la sede no tiene, lo de las demás sedes en los últimos 12 meses.",
        nota: `Contando lo cargado en ${surco?.name ?? "Surco"} aunque no se haya pagado: ${productWords(loadedSurco) || "nada"}.`,
        datos: {
          surco,
          pagadoSurco: inSurco,
          cargadoSurco: loadedSurco,
          porSede: byBranch,
          surcoAlgunaVez: ever,
        },
      }
    },

    g034: async () => {
      const start = await yearStart()
      const rows = await sold(start, nowIso, ortho)
      const loaded = await charged(start, nowIso, ortho)
      const screen = await h.fig("cobrado", "tratamiento", "este_ano")
      const fromScreen = screen.rows.filter((row) => /ortodon/i.test(row.label))
      return {
        respuesta: rows.length
          ? `${capital(yearSoFar)} llevas ${money(centsOf(rows))} vendidos en ortodoncia: ${rows.length === 1 ? `todo de «${rows[0]?.name}», ${howMany(salesOf(rows), "pagado", "pagados")}` : `${howMany(salesOf(rows), "tratamiento pagado", "tratamientos pagados")} (${centsWords(rows)})`}.`
          : `${capital(yearSoFar)} no se ha vendido nada de ortodoncia.`,
        criterio:
          "Lo vendido: pagos vigentes del 1 de enero a hoy aplicados a tratamientos sin anular de la especialidad de ortodoncia (o con ortodoncia en el nombre), sin lo devuelto.",
        nota: `Contando lo cargado este año aunque no se haya pagado: ${money(centsOf(loaded))} en ${loaded.reduce((sum, row) => sum + row.sales, 0)} conceptos. Reportes › Lo cobrado por tratamiento del año: ${listOf(fromScreen.map((row) => ({ name: row.label, value: show(screen, row.value.value) }))) || "sin filas de ortodoncia"}.`,
        datos: { vendido: rows, cargado: loaded, reportes: fromScreen },
      }
    },

    g035: async () => {
      const firstMonth =
        current.month > 3
          ? { year: current.year, month: current.month - 3 }
          : { year: current.year - 1, month: current.month + 9 }
      const recentStart = await dayStart(
        h,
        `${firstMonth.year}-${String(firstMonth.month).padStart(2, "0")}-01`,
      )
      const lastFull =
        current.month === 1
          ? { year: current.year - 1, month: 12 }
          : { year: current.year, month: current.month - 1 }
      const catalog = await tx.execute<{ name: string }>(sql`
        select distinct name from service_catalog where organization_id = ${org} and is_active order by name`)
      const recent = await done(recentStart, h.monthStart)
      // Lo hecho fuera de esos 3 meses (antes o en el mes en curso): para separar lo que la clínica hace de lo que nunca hizo.
      const other = await tx.execute<{ name: string; at: string; times: number }>(sql`
        select coalesce(s.name, ep.description) as name, max(e.started_at)::text as at, sum(ep.quantity)::int as times
        ${doneFrom("1900-01-01T00:00:00Z", nowIso, sql`and (e.started_at < ${recentStart}::timestamptz or e.started_at >= ${h.monthStart}::timestamptz)`)}
        group by 1 order by 2 desc`)
      const ninety = await done(await dayStart(h, w.addDays(w.todayKey, -89)), nowIso)
      const doneNames = new Set(recent.map((row) => row.name))
      const missing = catalog.filter((row) => !doneNames.has(row.name))
      const usual = other.filter(
        (row) => !doneNames.has(row.name) && catalog.some((item) => item.name === row.name),
      )
      const never = missing.filter((row) => !other.some((item) => item.name === row.name))
      const span = `${monthLabel(h, firstMonth, false)} y ${monthLabel(h, lastFull)}`
      const ninetyMissing = catalog.filter((row) => !ninety.some((item) => item.name === row.name))
      return {
        respuesta: missing.length
          ? `Sí. Entre ${span} (los últimos 3 meses completos) se hicieron ${recent.length} de los ${catalog.length} tratamientos activos del catálogo; ${missing.length} no se hicieron ni una vez. ${
              usual.length
                ? `De los que la clínica sí hace, no se hizo ${listOf(usual.map((row) => ({ name: row.name, value: `${howMany(row.times, "vez", "veces")} en otros meses, la última el ${shortDay(row.at)}` })))}; los otros ${never.length} nunca se han hecho, por ejemplo ${never
                    .slice(0, 3)
                    .map((row) => row.name)
                    .join(", ")}.`
                : `Todos los que la clínica hace habitualmente sí se hicieron (${timesWords(recent)}); los ${never.length} que faltan nunca se han hecho, por ejemplo ${never
                    .slice(0, 5)
                    .map((row) => row.name)
                    .join(", ")}.`
            }`
          : `No: entre ${span} se hicieron todos los ${catalog.length} tratamientos activos del catálogo al menos una vez.`,
        criterio:
          "Tratamientos activos del catálogo (por nombre) sin ningún procedimiento sin anular en atenciones firmadas de los últimos 3 meses completos (por el día de la atención).",
        nota: `${usual.length ? `Los que sí se hicieron en esos 3 meses: ${timesWords(recent)}. ` : ""}En los últimos 90 días hasta hoy: ${ninetyMissing.length} sin hacer ni una vez (se hicieron ${ninety.length}: ${timesWords(ninety)}).`,
        datos: {
          hechos: recent,
          sinHacer: missing.map((row) => row.name),
          antesSi: usual,
          nunca: never.length,
          catalogo: catalog.length,
          noventaDias: ninety,
        },
      }
    },

    g036: async () => {
      const month = await namedMonth(10)
      const [dentist] = await tx.execute<{ id: string; name: string }>(sql`
        select u.id, u.name from "user" u where exists (select 1 from member m where m.organization_id = ${org} and m.user_id = u.id)
          and u.name ilike '%ana torres%' limit 1`)
      const resin = sql`and s.name ilike '%resina%'`
      const rows = dentist
        ? await done(month.start, month.end, sql`${resin} and e.dentist_user_id = ${dentist.id}`)
        : []
      const total = dentist
        ? await doneTotal(
            month.start,
            month.end,
            sql`${resin} and e.dentist_user_id = ${dentist.id}`,
          )
        : { times: 0, rows: 0, encounters: 0, patients: 0 }
      const everyone = await doneBy(
        sql`coalesce(u.name, 'Sin profesional')`,
        month.start,
        month.end,
        resin,
      )
      return {
        respuesta: !dentist
          ? "No hay nadie llamado Ana Torres en el equipo."
          : total.times
            ? `En ${month.words} la ${dentist.name} hizo ${total.times} resinas (${serviceWords(rows)}), a ${howMany(total.patients, "paciente", "pacientes")}.`
            : `En ${month.words} la ${dentist.name} no hizo ninguna resina.`,
        criterio:
          "Procedimientos sin anular con resina en el nombre (obturación con resina, resina fotocurable) en atenciones firmadas de la profesional, del mes nombrado (por el día de la atención), contando su cantidad.",
        nota: `Contando cada procedimiento una vez, sin su cantidad: ${total.rows}. Todo el equipo en ese mes: ${timesWords(everyone)}.`,
        datos: { profesional: dentist ?? null, porServicio: rows, total, equipo: everyone },
      }
    },

    g037: async () => {
      const rows = await sold(h.monthStart, nowIso)
      const loaded = await charged(h.monthStart, nowIso)
      const collected = await h.fig("cobrado")
      const part = (list: Sold[], kind: Sold["kind"]) =>
        centsOf(list.filter((row) => row.kind === kind))
      const treatments = part(rows, "tratamiento")
      const products = part(rows, "producto")
      const total = treatments + products
      const loose = (collected.total.value ?? 0) - total
      return {
        respuesta: `Este mes (${w.monthSoFar}) se vendieron ${money(total)} (lo pagado de tratamientos y productos): ${money(treatments)} son tratamientos (${w.pct(treatments, total)}) y ${money(products)} productos (${w.pct(products, total)}).`,
        criterio:
          "Lo vendido del mes en curso: pagos vigentes aplicados a conceptos sin anular, repartido entre tratamientos y productos (concepto con producto).",
        nota: `Contando lo cargado este mes aunque no se haya pagado: tratamientos ${money(part(loaded, "tratamiento"))}, productos ${money(part(loaded, "producto"))}. Lo cobrado de Reportes del mes es ${show(collected)}${loose > 0 ? `: además de lo vendido incluye ${money(loose)} de adelantos o saldo a favor aún sin aplicar` : ""}.`,
        datos: {
          tratamientos: treatments,
          productos: products,
          total,
          cargado: {
            tratamientos: part(loaded, "tratamiento"),
            productos: part(loaded, "producto"),
          },
          cobrado: collected.total,
        },
      }
    },

    g038: async () => {
      const rows = await done(h.monthStart, nowIso)
      const total = rows.reduce((sum, row) => sum + row.times, 0)
      return {
        respuesta: rows.length
          ? `Este mes (${w.monthSoFar}) se realizaron ${rows.length} tratamientos distintos, de más a menos veces: ${rows.map((row, index) => `${index + 1}) ${row.name}, ${row.times}`).join("; ")}. En total, ${total}.`
          : `Este mes (${w.monthSoFar}) todavía no hay atenciones firmadas con tratamientos.`,
        criterio:
          "Procedimientos sin anular de atenciones firmadas del mes en curso (por el día de la atención), por tratamiento y contando su cantidad, de más a menos.",
        nota: `Contando cada procedimiento una vez, sin su cantidad: ${listOf([...rows].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name)).map((row) => ({ name: row.name, value: `${row.rows}` })))}.`,
        datos: { mes: rows, total },
      }
    },

    g039: async () => {
      const endo = sql`and s.name ilike '%endodon%'`
      const now = await doneTotal(h.monthStart, nowIso, endo)
      const before = await doneTotal(previous.start, previous.end, endo)
      const month = await lastMonth()
      const full = await doneTotal(month.start, month.end, endo)
      const verdict =
        now.times > before.times
          ? "Este mes, por ahora"
          : now.times < before.times
            ? "El mes pasado"
            : "Ninguno: van iguales"
      return {
        respuesta: `${verdict}: ${days.current} se hicieron ${now.times} endodoncias, contra ${before.times} en ${days.sameAs}.`,
        criterio:
          "Procedimientos sin anular de endodoncia en atenciones firmadas (por el día de la atención), contando su cantidad: el mes en curso contra los mismos días del mes anterior, como compara Reportes.",
        nota: `Contra todo ${month.words} (mes completo): ${full.times} endodoncias, ${full.times > now.times ? `${full.times - now.times} más que lo que va de este mes` : full.times < now.times ? `${now.times - full.times} menos que lo que va de este mes` : "las mismas que lo que va de este mes"}.`,
        datos: { esteMes: now, mismosDiasMesAnterior: before, mesAnteriorCompleto: full },
      }
    },

    g040: async () => {
      const top = await tx.execute<{
        name: string
        cents: string
        sales: number
        concepts: string
        tied: number
      }>(sql`
        select pp.display_name as name, sum(a.amount_cents)::text as cents, count(distinct c.id)::int as sales,
          string_agg(distinct ${h.conceptName}, ', ') as concepts, count(*) over (partition by sum(a.amount_cents))::int as tied
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null
        ${h.conceptJoins} ${person(sql`c.patient_id`)}
        where a.organization_id = ${org} and a.voided_at is null and pay.currency = ${h.scope.currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz
        group by c.patient_id, pp.display_name order by sum(a.amount_cents) desc, 1 limit 5`)
      const [payment] = await tx.execute<{
        name: string
        cents: string
        at: string
        tied: number
      }>(sql`
        select pp.display_name as name, pay.amount_cents::text as cents, pay.paid_at::text as at,
          count(*) over (partition by pay.amount_cents)::int as tied from patient_payment pay ${person(sql`pay.patient_id`)}
        where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
          and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz
        order by pay.amount_cents desc, pay.paid_at desc limit 1`)
      const [loadedTop] = await tx.execute<{ name: string; cents: string }>(sql`
        select pp.display_name as name, sum(c.amount_cents)::text as cents from patient_charge c ${person(sql`c.patient_id`)}
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${h.monthStart}::timestamptz and c.created_at < ${nowIso}::timestamptz
        group by c.patient_id, pp.display_name order by sum(c.amount_cents) desc, 1 limit 1`)
      const [concept] = await tx.execute<{
        person: string
        name: string
        cents: string
        tied: number
      }>(sql`
        select pp.display_name as person, ${h.conceptName} as name, c.amount_cents::text as cents, count(*) over (partition by c.amount_cents)::int as tied
        from patient_charge c ${h.conceptJoins} ${person(sql`c.patient_id`)}
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${h.scope.currency}
          and c.created_at >= ${h.monthStart}::timestamptz and c.created_at < ${nowIso}::timestamptz
        order by c.amount_cents desc, c.created_at desc limit 1`)
      const first = top[0]
      const third = top[2]
      const thirdTied = third
        ? third.tied - top.slice(1, 3).filter((row) => row.cents === third.cents).length
        : 0
      return {
        respuesta: first
          ? `Este mes (${w.monthSoFar}) la venta más alta a un solo paciente es la de ${first.name}: ${money(Number(first.cents))} pagados en ${howMany(first.sales, "tratamiento o producto", "tratamientos y productos")} (${first.concepts}).${first.tied > 1 ? ` Hay ${first.tied} pacientes empatados con ese importe.` : ""} Le siguen ${listOf(top.slice(1, 3).map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}${thirdTied > 0 ? `, y ${howMany(thirdTied, "paciente más", "pacientes más")} con ${money(Number(third?.cents ?? 0))}` : ""}.`
          : `Este mes (${w.monthSoFar}) todavía no se vendió nada.`,
        criterio:
          "Lo vendido del mes en curso por paciente (sin Spam ni bloqueados): pagos vigentes aplicados a sus tratamientos y productos sin anular, de más a menos.",
        nota: `Si es un solo pago: el mayor del mes fue de ${money(Number(payment?.cents ?? 0))}, de ${payment?.name ?? "—"} el ${payment ? shortDay(payment.at) : "—"}${(payment?.tied ?? 0) > 1 ? ` (hay ${payment?.tied} pagos de ese importe; es el más reciente)` : ""}. Por lo cargado este mes (pagado o no), quien más: ${loadedTop?.name ?? "—"} con ${money(Number(loadedTop?.cents ?? 0))}. El concepto más caro cargado: ${concept?.name ?? "—"} a ${concept?.person ?? "—"}, ${money(Number(concept?.cents ?? 0))}${(concept?.tied ?? 0) > 1 ? ` (hay ${concept?.tied} de ese importe; es el más reciente)` : ""}.`,
        datos: {
          porPaciente: top,
          mayorPago: payment ?? null,
          cargadoPorPaciente: loadedTop ?? null,
          conceptoMasCaro: concept ?? null,
        },
      }
    },

    g041: async () => {
      const month = await namedMonth(9)
      const surco = await branchNamed("surco")
      const result = await h.fig("cobrado", "sede", month.key)
      const row = surco ? result.rows.find((item) => item.key === surco.id) : undefined
      const value = row?.value.value ?? 0
      const ever = surco ? await everIn(surco.id) : null
      const loaded = surco
        ? await charged(month.start, month.end, sql`and c.branch_id = ${surco.id}`)
        : []
      const others = result.rows.filter((item) => item.key !== surco?.id)
      return {
        respuesta: !surco
          ? `No hay una sede Surco. En ${month.words}: ${listOf(result.rows.map((item) => ({ name: item.label, value: show(result, item.value.value) })))}.`
          : value
            ? `En ${month.words} la ${surco.name} vendió ${show(result, value)} (lo cobrado en la sede, sin lo anulado ni lo devuelto), el ${w.pct(value, result.total.value ?? 0)} de la clínica.`
            : `En ${month.words} la ${surco.name} no tuvo ventas: ${show(result, 0)} cobrados${ever && !ever.payments && !ever.appointments ? "; no tiene ningún cobro ni cita registrados" : ""}. Las demás sedes: ${listOf(others.map((item) => ({ name: item.label, value: show(result, item.value.value) })))}; en total, ${show(result)}.`,
        criterio:
          "«Lo cobrado» de Reportes por sede (pagos de la sede menos lo anulado y lo devuelto), del mes nombrado completo.",
        nota: `Contando lo cargado en ${surco?.name ?? "Surco"} ese mes (pagado o no): ${money(centsOf(loaded))}.`,
        datos: {
          mes: month.key,
          sede: surco,
          cobrado: value,
          porSede: result.rows,
          cargado: centsOf(loaded),
          algunaVez: ever,
        },
      }
    },

    g042: async () => {
      const start = await yearStart()
      const rows = await sold(start, nowIso)
      const loaded = await charged(start, nowIso)
      const isOrtho = (row: Sold) =>
        /ortodon/i.test(row.specialty ?? "") || /ortodon/i.test(row.name)
      const total = centsOf(rows)
      const orthoCents = centsOf(rows.filter(isOrtho))
      const loadedTotal = centsOf(loaded)
      const loadedOrtho = centsOf(loaded.filter(isOrtho))
      const collected = await h.fig("cobrado", "total", "este_ano")
      return {
        respuesta: `${capital(yearSoFar)} la ortodoncia es el ${w.pct(orthoCents, total)} de lo vendido: ${money(orthoCents)} de ${money(total)} pagados de tratamientos y productos.`,
        criterio:
          "Lo vendido del 1 de enero a hoy (pagos vigentes aplicados a conceptos sin anular): lo de la especialidad de ortodoncia (o con ortodoncia en el nombre) ÷ todo.",
        nota: `Sobre todo lo cobrado del año en Reportes (con adelantos y saldo a favor): ${w.pct(orthoCents, collected.total.value ?? 0)} de ${show(collected)}. Contando lo cargado (pagado o no): ${w.pct(loadedOrtho, loadedTotal)} (${money(loadedOrtho)} de ${money(loadedTotal)}).`,
        datos: {
          ortodoncia: orthoCents,
          vendido: total,
          cargadoOrtodoncia: loadedOrtho,
          cargado: loadedTotal,
          cobrado: collected.total,
        },
      }
    },

    g043: async () => {
      const year = await reportScope(tx, org, { period: "este_ano" }, h.now)
      const collected = await h.fig("cobrado", "total", "este_ano")
      const lines = await h.fig("cobrado", "mes")
      /** Pacientes que pagaron, contados una vez por cada mes en que pagaron (el ticket de f9 es por mes), y los pagos. */
      const byMonth = (start: string, end: string) =>
        tx.execute<{ month: string; payers: number; payments: number }>(sql`
          select to_char(pay.paid_at at time zone ${h.tz}, 'YYYY-MM') as month, count(distinct pay.patient_id)::int as payers, count(*)::int as payments
          from patient_payment pay
          where pay.organization_id = ${org} and pay.voided_at is null and pay.currency = ${h.scope.currency}
            and pay.paid_at >= ${start}::timestamptz and pay.paid_at < ${end}::timestamptz group by 1`)
      const payersByMonth = await byMonth(year.window.start.toISOString(), nowIso)
      const beforeByMonth = await byMonth(
        year.window.previous.start.toISOString(),
        year.window.previous.end.toISOString(),
      )
      const sumOf = (rows: typeof payersByMonth, field: "payers" | "payments") =>
        rows.reduce((sum, row) => sum + row[field], 0)
      const thisYear = {
        payers: sumOf(payersByMonth, "payers"),
        payments: sumOf(payersByMonth, "payments"),
        people: (await payersIn(year.window.start.toISOString(), nowIso)).payers,
      }
      const lastYear = {
        payers: sumOf(beforeByMonth, "payers"),
        payments: sumOf(beforeByMonth, "payments"),
      }
      const months = lines.months
        .filter((item) => item.month.year === current.year)
        .map((item) => {
          const key = `${item.month.year}-${String(item.month.month).padStart(2, "0")}`
          const payers = payersByMonth.find((row) => row.month === key)?.payers ?? 0
          const cents = item.value.value ?? 0
          return {
            key,
            month: item.month,
            partial: item.partial,
            cents,
            payers,
            ticket: payers ? Math.round(cents / payers) : null,
          }
        })
      const full = months.filter((item) => !item.partial && item.ticket !== null)
      const first = full[0]
      const last = full.at(-1)
      const cents = collected.total.value ?? 0
      const centsBefore = collected.previous?.value ?? 0
      const now = Math.round(cents / Math.max(1, thisYear.payers))
      const before = Math.round(centsBefore / Math.max(1, lastYear.payers))
      const running = months.find((item) => item.partial)
      return {
        respuesta: `${now > before ? "Sí, subió" : now < before ? "No, bajó" : "Está igual"}: ${yearSoFar} el ticket promedio es ${money(now)} por paciente al mes (${show(collected)} cobrados; cada mes pagaron en promedio ${Math.round(thisYear.payers / Math.max(1, payersByMonth.length))} pacientes); en los mismos días de ${current.year - 1}, ${money(before)}: ${w.signed(now, before)}.`,
        criterio:
          "Ticket promedio = «Lo cobrado» de Reportes ÷ pacientes que pagaron en cada mes (como f9, que es por mes: un paciente que paga en dos meses cuenta dos veces), del 1 de enero a hoy contra los mismos días del año anterior (la comparación de Reportes para «este año»).",
        nota: `${first && last ? `Dentro del año, mes a mes (meses completos): de ${money(first.ticket)} en ${monthLabel(h, first.month, false)} a ${money(last.ticket)} en ${monthLabel(h, last.month, false)} (${w.signed(last.ticket ?? 0, first.ticket ?? 0)}); ${listOf(full.map((item) => ({ name: monthLabel(h, item.month, false), value: money(item.ticket) })))}.${running ? ` ${capital(monthLabel(h, running.month, false))} va ${per(running.cents, running.payers)} hasta hoy (mes sin terminar).` : ""} ` : ""}Por pago recibido (cada ticket): ${per(cents, thisYear.payments)} este año contra ${per(centsBefore, lastYear.payments)} (${w.signed(Math.round(cents / Math.max(1, thisYear.payments)), Math.round(centsBefore / Math.max(1, lastYear.payments)))}). Contando a cada paciente una sola vez en todo el año: ${per(cents, thisYear.people)} (${thisYear.people} pacientes).`,
        datos: {
          año: {
            cobrado: collected.total,
            pacientesMes: thisYear.payers,
            pagos: thisYear.payments,
            ticket: now,
          },
          añoAnterior: {
            cobrado: collected.previous,
            pacientesMes: lastYear.payers,
            pagos: lastYear.payments,
            ticket: before,
          },
          meses: months,
        },
      }
    },

    g044: async () => {
      const week = await lastWeek()
      const extraction = sql`and (s.name ilike 'exodoncia%' or s.name ilike '%extracci%')`
      const rows = await done(week.start, week.end, extraction)
      const total = await doneTotal(week.start, week.end, extraction)
      const before = await doneTotal(week.before.start, week.before.end, extraction)
      const seven = await doneTotal(
        await dayStart(h, w.addDays(w.todayKey, -6)),
        nowIso,
        extraction,
      )
      return {
        respuesta: total.times
          ? `La semana pasada (${week.words}) se hicieron ${total.times} extracciones (${serviceWords(rows)}), a ${howMany(total.patients, "paciente", "pacientes")}.`
          : `La semana pasada (${week.words}) no se hizo ninguna extracción.`,
        criterio:
          "Procedimientos sin anular de exodoncia en atenciones firmadas de la semana pasada, de lunes a domingo (por el día de la atención), contando su cantidad.",
        nota: `Contando cada procedimiento una vez, sin su cantidad: ${total.rows}. La semana anterior (${spanWords(week.before.from, week.before.to)}): ${before.times}. Los últimos 7 días (${spanWords(w.addDays(w.todayKey, -6), w.todayKey)}): ${seven.times}.`,
        datos: {
          semana: { desde: week.from, hasta: week.to },
          porServicio: rows,
          total,
          semanaAnterior: before,
          sieteDias: seven,
        },
      }
    },

    g045: async () => {
      const kits = await tx.execute<{ name: string; unit: string }>(sql`
        select name, unit from product where organization_id = ${org} and (name ilike '%blanque%' or name ilike '%kit%')`)
      const catalog = await forSale()
      const kitWhere = sql`and (pr.name ilike '%blanque%' or pr.name ilike '%kit%')`
      const ever = kits.length ? await paidProducts("1900-01-01T00:00:00Z", nowIso, kitWhere) : []
      const whitening = sql`and s.name ilike '%blanque%'`
      const month = await doneTotal(h.monthStart, nowIso, whitening)
      const start = await yearStart()
      const year = await doneTotal(start, nowIso, whitening)
      const paidMonth = await sold(
        h.monthStart,
        nowIso,
        sql`and ${h.conceptName} ilike '%blanque%'`,
      )
      const paidYear = await sold(start, nowIso, sql`and ${h.conceptName} ilike '%blanque%'`)
      return {
        respuesta: kits.length
          ? `Desde siempre se han vendido ${productWords(ever) || "0"} de ${kits.map((row) => row.name).join(", ")}.`
          : `No hay ningún kit de blanqueamiento para la casa entre tus productos, así que no se ha vendido ninguno. Los productos que vendes son ${catalog.map((row) => row.name).join(" y ")}. Lo más cercano es el blanqueamiento en la clínica: este mes (${w.monthSoFar}) se hicieron ${month.times} y se pagaron ${money(centsOf(paidMonth))}.`,
        criterio:
          "No existe ese producto (ninguno con blanqueamiento o kit en el nombre): se dice que no hay, los productos a la venta y lo más cercano registrado, los blanqueamientos hechos en atenciones firmadas este mes y lo pagado por ellos.",
        nota: `${capital(yearSoFar)}: ${year.times} blanqueamientos hechos y ${money(centsOf(paidYear))} pagados por ellos.`,
        datos: {
          kits,
          aLaVenta: catalog,
          vendidos: ever,
          blanqueamientosMes: month,
          pagadoMes: paidMonth,
          blanqueamientosAño: year,
          pagadoAño: paidYear,
        },
      }
    },

    g046: async () => {
      const week = await lastWeek()
      const result = await h.fig("pacientes_nuevos", "total", week.key)
      const list = await getReportList(
        tx,
        org,
        { period: week.key, list: "new_patients", limit: 200 },
        h.now,
      )
      const [registered] = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null
        where p.organization_id = ${org} and p.created_at >= ${week.start}::timestamptz and p.created_at < ${week.end}::timestamptz`)
      const sought = await h.fig("nos_buscaron", "total", week.key)
      const value = result.total.value ?? 0
      return {
        respuesta: value
          ? `La semana pasada (${week.words}) llegaron ${howMany(value, "paciente nuevo", "pacientes nuevos")} (su primera cita atendida): ${list.rows.map((row) => row.personName).join(", ")}.`
          : `La semana pasada (${week.words}) no llegó ningún paciente nuevo.`,
        criterio:
          "«Pacientes nuevos» de Reportes de la semana pasada, de lunes a domingo: personas cuya primera cita atendida cayó en esos días.",
        nota: `La semana anterior (${spanWords(week.before.from, week.before.to)}): ${show(result, result.previous?.value ?? null)}. Fichas de paciente registradas esa semana, aunque no se hayan atendido: ${registered?.count ?? 0}. Personas que nos buscaron por primera vez esa semana: ${show(sought)}.`,
        datos: {
          total: result.total,
          anterior: result.previous,
          lista: list.rows.map((row) => row.personName),
          registrados: registered?.count ?? 0,
          nosBuscaron: sought.total,
        },
      }
    },

    g047: async () => {
      const month = await namedMonth(9)
      const row = await attendedIn(month.start, month.end)
      const visits = await h.fig("atendidas", "total", month.key)
      const [encounters] = await tx.execute<{ patients: number }>(sql`
        select count(distinct e.patient_id)::int as patients from encounter e ${person(sql`e.patient_id`)}
        where e.organization_id = ${org} and e.status = 'finalizada' and e.voided_at is null
          and e.started_at >= ${month.start}::timestamptz and e.started_at < ${month.end}::timestamptz`)
      return {
        respuesta: `En ${month.words} atendiste a ${howMany(row.total, "paciente distinto", "pacientes distintos")}, en ${show(visits)} citas atendidas.`,
        criterio:
          "Pacientes distintos (sin Spam ni bloqueados) con al menos una cita atendida en el mes nombrado; las citas, «Citas atendidas» de Reportes.",
        nota: `De ellos, ${row.fresh} eran nuevos (su primera cita atendida) y ${row.total - row.fresh} ya venían de antes. Contando atenciones firmadas en vez de citas: ${encounters?.patients ?? 0} pacientes.`,
        datos: {
          pacientes: row.total,
          nuevos: row.fresh,
          citas: visits.total,
          conAtencionFirmada: encounters?.patients ?? 0,
        },
      }
    },

    g048: async () => {
      const month = await attendedIn(h.monthStart, nowIso)
      const before = await attendedIn(previous.start, previous.end)
      const fresh = await h.fig("pacientes_nuevos")
      const back = month.total - month.fresh
      return {
        respuesta: `Este mes (${w.monthSoFar}) vinieron ${month.total} pacientes (con una cita atendida): ${back} ya se habían atendido antes con la clínica (${w.pct(back, month.total)}) y ${month.fresh} vinieron por primera vez.`,
        criterio:
          "Pacientes distintos (sin Spam ni bloqueados) con una cita atendida en el mes en curso; ya atendidos antes, si su primera cita atendida fue antes del mes (lo contrario de «Pacientes nuevos»).",
        nota: `En ${w.previousSameDays}: ${before.total - before.fresh} de ${before.total} ya se habían atendido antes. «Pacientes nuevos» de Reportes este mes: ${show(fresh)}.`,
        datos: { mes: month, mismosDiasMesAnterior: before, pacientesNuevos: fresh.total },
      }
    },

    g049: async () => {
      const [row] = await tx.execute<{
        plain: number
        booked: number
        archived: number
        cutoff: string
      }>(sql`
        with attended as (
          select a.id, a.patient_id, a.starts_at from appointment a ${person(sql`a.patient_id`)}
          where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz),
        last as (select patient_id, max(starts_at) as at from attended group by 1)
        select count(*) filter (where pp.is_active)::int as plain,
          count(*) filter (where pp.is_active and exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = l.patient_id
            and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada')))::int as booked,
          count(*) filter (where not pp.is_active)::int as archived,
          (${monthsAgo(12)})::text as cutoff
        from last l ${person(sql`l.patient_id`)}
        where l.at < ${monthsAgo(12)}`)
      const [lapsed] = await tx.execute<{ count: number }>(sql`
        with ${lapsedSql(org, h.scope, h.now)} select count(*) filter (where starts_at < ${monthsAgo(12)})::int as count from lapsed`)
      const limit = row?.cutoff ?? nowIso
      return {
        respuesta: `Hoy ${row?.plain ?? 0} pacientes llevan más de un año sin venir: su última cita atendida fue antes del ${shortDay(limit)}.${row?.booked ? ` De ellos, ${row.booked} ya ${row.booked === 1 ? "tiene" : "tienen"} una cita por venir.` : ""}`,
        criterio:
          "Pacientes no archivados (sin Spam ni bloqueados) cuya última cita atendida fue hace más de 12 meses del calendario, a hoy, sin más condiciones (la regla de «no han vuelto en N meses»).",
        nota: `Con la regla de «Sin venir» de Reportes (sin cita por venir, presupuesto esperando respuesta ni control pendiente) y más de un año: ${lapsed?.count ?? 0}. Contando también a los archivados: ${(row?.plain ?? 0) + (row?.archived ?? 0)}.`,
        datos: {
          masDeUnAño: row?.plain ?? 0,
          conCita: row?.booked ?? 0,
          archivados: row?.archived ?? 0,
          sinVenirMasDeUnAño: lapsed?.count ?? 0,
          limite: limit,
        },
      }
    },

    g050: async () => {
      const month = await namedMonth(1)
      const rows = await tx.execute<{
        name: string
        at: string
        active: boolean
        booked: boolean
        visits: number
      }>(sql`
        with attended as (
          select a.id, a.patient_id, a.starts_at from appointment a ${person(sql`a.patient_id`)}
          where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz),
        last as (select patient_id, max(starts_at) as at, count(*) filter (where starts_at >= ${month.start}::timestamptz) as visits from attended group by 1)
        select pp.display_name as name, l.at::text as at, pp.is_active as active, l.visits::int as visits,
          exists (select 1 from appointment n where n.organization_id = ${org} and n.patient_id = l.patient_id
            and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada')) as booked
        from last l ${person(sql`l.patient_id`)}
        where l.at >= ${month.start}::timestamptz and l.at < ${month.end}::timestamptz
        order by l.at, 1`)
      const [came] = await tx.execute<{ count: number }>(sql`
        select count(distinct a.patient_id)::int as count from appointment a ${person(sql`a.patient_id`)}
        where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at >= ${month.start}::timestamptz and a.starts_at < ${month.end}::timestamptz`)
      const active = rows.filter((row) => row.active)
      const archived = rows.length - active.length
      const booked = active.filter((row) => row.booked).length
      const shown = active.slice(0, 30)
      return {
        respuesta: active.length
          ? `${howMany(active.length, "paciente vino", "pacientes vinieron")} en ${month.words} y no ${active.length === 1 ? "ha" : "han"} vuelto a atenderse desde entonces: ${listOf(shown.map((row) => ({ name: row.name, value: shortDay(row.at) })))}${active.length > shown.length ? ` y ${active.length - shown.length} más` : ""}.${booked ? ` De ellos, ${booked} ya ${booked === 1 ? "tiene" : "tienen"} una cita por venir.` : ""}`
          : `Ningún paciente que vino en ${month.words} dejó de volver: todos tuvieron otra cita atendida después.`,
        criterio:
          "Pacientes no archivados (sin Spam ni bloqueados) cuya última cita atendida fue en el enero más reciente: vinieron entonces y no tienen otra cita atendida después; con la fecha de su última cita.",
        nota: `En ${month.words} vinieron ${came?.count ?? 0} pacientes distintos; ${(came?.count ?? 0) - rows.length} volvieron después.${archived ? ` Además, ${archived} archivado${archived === 1 ? "" : "s"} que tampoco volvió.` : ""}`,
        datos: {
          lista: active,
          archivados: archived,
          conCita: booked,
          vinieronEnEnero: came?.count ?? 0,
        },
      }
    },
  }
}
