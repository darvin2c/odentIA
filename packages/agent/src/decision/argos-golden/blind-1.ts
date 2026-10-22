/**
 * Las respuestas correctas de las preguntas escritas a ciegas (`eval/argos-blind.json`),
 * parte 1: x01 a x25. Se calculan sobre las tablas y con las cifras de Reportes,
 * nunca con las vistas `argos` ni las cifras de Argos: así no heredan un error suyo.
 *
 * Las reglas son las de los bancos anteriores: lo cobrado es «Lo cobrado» de
 * Reportes (pagos menos anulaciones y devoluciones, en el día de la clínica);
 * «esta semana», del lunes a hoy; «la semana pasada», de lunes a domingo; «los
 * últimos 3 meses», meses completos; lo pendiente y el inventario, a hoy; lo que
 * viene (mañana, la próxima semana), ese periodo entero. Las preguntas iguales a
 * una generada (x01 = g001, x06 = g012, x22 = g134) usan su mismo cálculo.
 */
import {
  acceptedOutSql,
  agendaMinutes,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  channelWords,
  computeFigure,
  expensesMany,
  type FigureGroup,
  type FigureResult,
  type FigureRow,
  getReportCommissions,
  getReportPromotions,
  lapsedSql,
  listProducts,
  type ProductListItem,
  reportScope,
  screenedSql,
  subtractSpans,
  unansweredSinceSql,
  unansweredSql,
} from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import { dayStart, goldenWords, NO_INVOICES } from "./finance.js"
import { generatedSolvers1 } from "./generated-1.js"
import { generatedSolvers6 } from "./generated-6.js"
import type { GoldenAnswer, GoldenHelpers, GoldenSolvers } from "./helpers.js"
import { monthLabel, sameDaysWords } from "./trends.js"

/** «1 frasco», «2 frascos», «3 unidades»: la unidad de uso del producto. */
function unitsWord(count: number, unit: string): string {
  if (count === 1 || count === -1) return `${count} ${unit}`
  const plural = /[aeiouáéó]$/i.test(unit) ? `${unit}s` : `${unit}es`
  return `${count} ${plural}`
}

/** La misma pregunta que una generada: su mismo cálculo, diciendo de cuál viene. */
function sameAs(solvers: GoldenSolvers, id: string): () => Promise<GoldenAnswer> {
  return async () => {
    const run = solvers[id]
    if (!run) throw new Error(`Falta el cálculo de la pregunta ${id}`)
    const answer = await run()
    return { ...answer, criterio: `${answer.criterio} Es la misma pregunta que ${id}: el mismo cálculo.` }
  }
}

export function blindSolvers1(h: GoldenHelpers): GoldenSolvers {
  const w = goldenWords(h)
  const days = sameDaysWords(h)
  const { tx, org, money, show, listOf } = h
  const { locale, currency, window } = h.scope
  const nowIso = w.nowIso
  const todayKey = w.todayKey
  const year = Number(todayKey.slice(0, 4))
  const thisMonth = Number(todayKey.slice(5, 7))
  const weekdayOf = (key: string): number => new Date(`${key}T12:00:00Z`).getUTCDay()
  /** El lunes de esta semana (día de la clínica). */
  const monday = w.addDays(todayKey, -((weekdayOf(todayKey) + 6) % 7))
  /** «5,764 guantes»: la unidad de uso con el número dicho como la clínica. */
  const units = (count: number, unit: string): string => unitsWord(count, unit).replace(/^-?\d+/, count.toLocaleString(locale))
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(locale)} h`
  /** «el miércoles 21 de octubre», «del lunes 19 al miércoles 21 de octubre». */
  const spanWords = (from: string, to: string): string =>
    from === to
      ? `el ${w.dayWords(from)}`
      : `del ${from.slice(0, 7) === to.slice(0, 7) ? w.dayWords(from).replace(/ de [^ ]+$/, "") : w.dayWords(from)} al ${w.dayWords(to)}`
  /** «10 de octubre de 2026». */
  const dateWords = (day: string): string =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${day.slice(0, 10)}T12:00:00Z`))
  /** «14:00» de un instante, en la hora de la clínica. */
  const clockOf = (ms: number): string =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: h.tz }).format(new Date(ms))
  /** «la Dra. Ana Torres», «el Dr. Diego Salas»; sin título, el nombre solo. */
  const the = (name: string): string => (/^Dra\.?\s/.test(name) ? `la ${name}` : /^Dr\.?\s/.test(name) ? `el ${name}` : name)
  /** «a la Dra. Elena Rojas», «al Dr. Diego Salas». */
  const toThe = (name: string): string => (/^Dr\.?\s/.test(name) ? `al ${name}` : `a ${the(name)}`)
  /** Quien pregunta es la dueña, que también atiende. */
  const asker = /ana torres/i
  const youToo = (name: string): string => (asker.test(name) ? " (tú)" : "")
  /** El último mes con ese número que ya empezó: «setiembre» en octubre de 2026 es el de 2026. */
  const monthKey = (month: number): string => `${month <= thisMonth ? year : year - 1}-${String(month).padStart(2, "0")}`
  const monthOfKey = (key: string) => ({ year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) })
  const rowNamed = (result: FigureResult, pattern: RegExp): FigureRow | undefined => result.rows.find((row) => pattern.test(row.label))
  const centsOf = (row: FigureRow | undefined): number => row?.value.value ?? 0
  const ofWords = (value: { part?: number; whole?: number } | null | undefined): string => `${value?.part ?? 0} de ${value?.whole ?? 0}`
  const changeWords = (value: number, before: number, format: (n: number) => string): string =>
    value === before ? "lo mismo" : `${format(Math.abs(value - before))} ${value > before ? "más" : "menos"} (${w.signed(value, before)})`

  const branches = async () => [
    ...(await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${org} and is_active order by name`)),
  ]
  /** La sede que nombra la pregunta, por una palabra de su nombre. */
  const branchNamed = async (word: string) => (await branches()).find((row) => row.name.toLowerCase().includes(word.toLowerCase())) ?? null
  const noBranch = async (word: string): Promise<GoldenAnswer> => {
    const all = await branches()
    return {
      respuesta: `No hay una sede ${word} en la clínica; las sedes son ${all.map((row) => row.name).join(", ")}.`,
      criterio: `La sede ${word} no existe entre las sedes activas.`,
      datos: { sedes: all },
    }
  }
  /** Una cifra de Reportes con una sede elegida en la pantalla: la misma cuenta, solo de esa sede. */
  const figIn = async (figure: string, group: FigureGroup, period: string, branchId: string): Promise<FigureResult> =>
    computeFigure({ ...h.ctx, scope: await reportScope(tx, org, { period, branchId }, h.now) }, { figure, group })
  /** Un profesional de la clínica por su nombre: quien tiene horario o citas en ella. */
  const dentistNamed = async (word: string) => {
    const [row] = await tx.execute<{ id: string; name: string }>(sql`
      select u.id, u.name from "user" u
      where u.name ilike ${`%${word}%`}
        and (u.id in (select dentist_user_id from appointment where organization_id = ${org})
          or u.id in (select dentist_user_id from professional_schedule where organization_id = ${org}))
      order by u.name limit 1`)
    return row ?? null
  }
  /** La actividad registrada de una sede, desde siempre: citas, cobros, horarios y gastos. */
  const branchActivity = async (branchId: string) => {
    const [row] = await tx.execute<{ appointments: number; payments: number; schedules: number; expenses: number }>(sql`
      select (select count(*) from appointment a where a.organization_id = ${org} and a.branch_id = ${branchId})::int as appointments,
        (select count(*) from patient_payment p where p.organization_id = ${org} and p.branch_id = ${branchId} and p.voided_at is null)::int as payments,
        (select count(*) from professional_schedule s where s.organization_id = ${org} and s.branch_id = ${branchId} and s.is_active)::int as schedules,
        (select count(*) from expense e where e.organization_id = ${org} and e.branch_id = ${branchId} and e.voided_at is null)::int as expenses`)
    return { appointments: row?.appointments ?? 0, payments: row?.payments ?? 0, schedules: row?.schedules ?? 0, expenses: row?.expenses ?? 0 }
  }
  /** Pagos de un tramo que siguen en pie al cerrarlo, por medio (sin restar devoluciones), como g003. */
  const paymentsByMethod = async (start: string, end: string) => {
    const rows = await tx.execute<{ name: string; count: number; cents: string }>(sql`
      select p.method_name as name, count(*)::int as count, sum(p.amount_cents)::text as cents from patient_payment p
      where p.organization_id = ${org} and p.currency = ${currency}
        and p.paid_at >= ${start}::timestamptz and p.paid_at < ${end}::timestamptz
        and (p.voided_at is null or p.voided_at >= ${end}::timestamptz)
      group by 1 order by sum(p.amount_cents) desc, 1`)
    const list = rows.map((row) => ({ name: row.name, count: row.count, cents: Number(row.cents) }))
    return { list, of: (pattern: RegExp) => list.find((row) => pattern.test(row.name)) ?? { name: "", count: 0, cents: 0 } }
  }
  /** Cada producto de cada sede activa, como lo muestra Inventario hoy. */
  const bySede = async () => {
    const found: Array<ProductListItem & { branch: string; branchId: string }> = []
    for (const branch of await branches()) {
      const list = await listProducts(tx, org, { branchId: branch.id, now: h.now })
      for (const item of list.items) found.push({ ...item, branch: branch.name, branchId: branch.id })
    }
    return found
  }
  /** Lotes con existencias, con su sede y su vencimiento (como g142). */
  const lots = () =>
    tx.execute<{ product: string; unit: string; branch: string; code: string; expires: string | null; quantity: number }>(sql`
      select pr.name as product, pr.unit, b.name as branch, l.code, to_char(l.expires_at, 'YYYY-MM-DD') as expires, l.quantity_on_hand as quantity
      from product_lot l
      join product pr on pr.organization_id = l.organization_id and pr.id = l.product_id
      join warehouse wh on wh.organization_id = l.organization_id and wh.id = l.warehouse_id
      join branch b on b.organization_id = wh.organization_id and b.id = wh.branch_id
      where l.organization_id = ${org} and l.quantity_on_hand > 0
      order by l.expires_at nulls last, pr.name, b.name`)
  type Lot = Awaited<ReturnType<typeof lots>>[number]
  const lotWords = (rows: Lot[]) =>
    listOf(
      rows.map((row) => ({
        name: `${row.product} en ${row.branch}${row.code ? `, lote ${row.code}` : ""}`,
        value: `${unitsWord(row.quantity, row.unit)}, ${row.expires ? `${row.expires < todayKey ? "venció" : "vence"} el ${dateWords(row.expires)}` : "sin vencimiento"}`,
      })),
    )
  /** Procedimientos sin anular de atenciones firmadas en [start, end), por el día de la atención y contando su cantidad (como g038). */
  const done = (start: string, end: string, where: SQL = sql``) =>
    tx.execute<{ name: string; times: number; rows: number; patients: number }>(sql`
      select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times, count(*)::int as rows, count(distinct e.patient_id)::int as patients
      from encounter_procedure ep
      join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
      left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
      where ep.organization_id = ${org} and ep.voided_at is null
        and e.started_at >= ${start}::timestamptz and e.started_at < ${end}::timestamptz ${where}
      group by 1 order by 2 desc, 1`)

  const g1 = generatedSolvers1(h)
  const g6 = generatedSolvers6(h)

  return {
    // --- Dinero ---------------------------------------------------------------------------
    x01: sameAs(g1, "g001"),

    x06: sameAs(g1, "g012"),

    x07: async () => {
      const range = `${monday}..${todayKey}`
      const week = await h.fig("cobrado", "medio", range)
      const before = await h.fig("cobrado", "medio", `${w.addDays(monday, -7)}..${w.addDays(todayKey, -7)}`)
      const paid = await paymentsByMethod(await dayStart(h, monday), nowIso)
      const yape = centsOf(rowNamed(week, /yape/i))
      const cash = centsOf(rowNamed(week, /efectivo/i))
      const total = week.total.value ?? 0
      const lastYape = centsOf(rowNamed(before, /yape/i))
      const lastCash = centsOf(rowNamed(before, /efectivo/i))
      const gross = paid.of(/yape/i)
      const grossCash = paid.of(/efectivo/i)
      const winner = yape > cash ? `Yape va ${money(yape - cash)} por encima` : cash > yape ? `el efectivo va ${money(cash - yape)} por encima` : "van iguales"
      return {
        respuesta: `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) entraron ${money(yape)} por Yape (${plural(gross.count, "pago", "pagos")}) contra ${money(cash)} en efectivo (${plural(grossCash.count, "pago", "pagos")}): ${winner}. Entre los dos son el ${w.pct(yape + cash, total)} de lo cobrado en la semana (${show(week)}), sin lo anulado ni lo devuelto.`,
        criterio: "«Lo cobrado» de Reportes por medio de pago de esta semana (del lunes a hoy, en el día de la clínica): las filas Yape y Efectivo, pagos menos anulaciones y devoluciones.",
        nota: `${gross.cents !== yape || grossCash.cents !== cash ? `Sin restar lo devuelto, los pagos suman ${money(gross.cents)} por Yape y ${money(grossCash.cents)} en efectivo. ` : ""}La semana pasada en los mismos días (${spanWords(w.addDays(monday, -7), w.addDays(todayKey, -7))}): ${money(lastYape)} por Yape y ${money(lastCash)} en efectivo. Todos los medios esta semana: ${listOf(week.rows.map((row) => ({ name: row.label, value: show(week, row.value.value) })))}.`,
        datos: { semana: week.total, yape, efectivo: cash, medios: week.rows, pagos: paid.list, semanaPasada: before.rows },
      }
    },

    x12: async () => {
      const [row] = await tx.execute<{ tickets: number; cents: string; payments: number; loose: number }>(sql`
        select (select count(*) from payment_ticket t where t.organization_id = ${org} and t.voided_at is null
            and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${nowIso}::timestamptz)::int as tickets,
          (select coalesce(sum(t.total_cents), 0) from payment_ticket t where t.organization_id = ${org} and t.voided_at is null
            and t.created_at >= ${h.monthStart}::timestamptz and t.created_at < ${nowIso}::timestamptz)::text as cents,
          (select count(*) from patient_payment p where p.organization_id = ${org} and p.voided_at is null
            and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${nowIso}::timestamptz)::int as payments,
          (select count(*) from patient_payment p where p.organization_id = ${org} and p.voided_at is null and p.ticket_id is null
            and p.paid_at >= ${h.monthStart}::timestamptz and p.paid_at < ${nowIso}::timestamptz)::int as loose`)
      const collected = await h.fig("cobrado")
      const tickets = row?.tickets ?? 0
      return {
        respuesta: `${NO_INVOICES}. Este mes (${w.monthSoFar}, hasta hoy) ${tickets === 0 ? "no se emitió ningún ticket de pago" : `se ${tickets === 1 ? "emitió 1 ticket" : `emitieron ${tickets} tickets`} de pago por ${money(Number(row?.cents ?? 0))}`}; lo cobrado del mes, sin lo anulado ni lo devuelto, va en ${show(collected)} en ${plural(row?.payments ?? 0, "pago", "pagos")}.`,
        criterio: "Trampa: odentIA no emite boletas ni facturas. Se ofrecen los tickets de pago de octubre (hasta hoy) y «Lo cobrado» de Reportes del mes en curso.",
        nota: `${row?.loose ?? 0} de los ${row?.payments ?? 0} pagos de octubre no tienen ticket: la historia de prueba los guarda sin él. Contar tickets da otra cifra; contar lo cobrado, no.`,
        datos: { tickets: row, cobrado: collected.total },
      }
    },

    x13: async () => {
      const person = await dentistNamed("Diego Salas")
      if (!person) return { respuesta: "No hay un Dr. Diego Salas en el equipo de la clínica.", criterio: "El profesional no existe.", datos: {} }
      const result = await h.fig("comisiones", "profesional")
      const row = result.rows.find((item) => item.key === person.id) ?? rowNamed(result, /diego salas/i)
      const report = await getReportCommissions(tx, org, { period: "este_mes" }, h.now)
      const mine = report.rows.find((item) => /diego salas/i.test(item.name))
      if (!row && !mine)
        return {
          respuesta: `Este mes (${w.monthSoFar}) ${the(person.name)} no tiene comisiones.`,
          criterio: "«Las comisiones» de Reportes por profesional, del mes en curso.",
          datos: { filas: result.rows },
        }
      const rate = `${((mine?.rateBps ?? 0) / 100).toLocaleString(locale)} %`
      return {
        respuesta: `Este mes (${w.monthSoFar}) ${toThe(person.name)} le tocan ${money(centsOf(row))} de comisión: el ${rate} de ${money(mine?.collectedCents ?? 0)} cobrados de lo que atendió.`,
        criterio: "«Las comisiones» de Reportes por profesional, del mes en curso: su porcentaje sobre lo cobrado de lo que atendió (la cuenta de Finanzas › Comisiones), como g010.",
        nota: `De eso ya se le pagó ${money(mine?.paidCents ?? 0)} y falta pagarle ${money(mine?.pendingCents ?? 0)}. Lo que atendió este mes y sigue sin cobrar (${money(mine?.unpaidCents ?? 0)}) le dará comisión cuando se cobre.`,
        datos: { profesional: person, comision: row?.value ?? null, detalle: mine ?? null },
      }
    },

    x18: async () => {
      const spent = await h.fig("gastos", "categoria")
      const lastFull = await h.fig("gastos", "total", "mes_pasado")
      const commissions = await h.fig("comisiones")
      // Los mismos días del mes anterior, por tipo, con la misma cuenta de Reportes (`expensesMany`).
      const [, previous] = await expensesMany(tx, org, [window, window.previous])
      const before = previous?.find((item) => item.currency === currency)
      const beforeRows = [...(before?.byCategory ?? [])].sort((a, b) => b.cents - a.cents)
      const value = spent.total.value ?? 0
      const last = spent.previous?.value ?? 0
      const rows = spent.rows.filter((row) => centsOf(row) !== 0)
      const top = rows[0]
      const beforeOf = (label: string) => beforeRows.find((row) => row.category === label)?.cents ?? 0
      return {
        respuesta: `${value > last ? "Sí" : value < last ? "No" : "Igual"}: este mes (${w.monthSoFar}) van ${show(spent)} en gastos registrados, contra ${show(spent, last)} en ${w.previousSameDays}: ${changeWords(value, last, money)}.${top ? ` Donde más se fue la plata: ${top.label}, ${show(spent, top.value.value)} (${w.pct(centsOf(top), value)} del mes; en los mismos días del mes anterior, ${money(beforeOf(top.label))}). Le siguen ${listOf(rows.slice(1, 4).map((row) => ({ name: row.label, value: show(spent, row.value.value) })))}.` : ""}`,
        criterio: "«Lo gastado» de Reportes › Finanzas por tipo, del mes en curso contra los mismos días del mes anterior hasta la misma hora: gastos registrados sin anulados y sin el pago de comisiones.",
        nota: `Por tipo en ${w.previousSameDays}: ${listOf(beforeRows.filter((row) => row.cents !== 0).map((row) => ({ name: row.category, value: money(row.cents) })))}. Contra ${w.previousMonth} completo: ${show(lastFull)}. Las comisiones de los odontólogos van aparte: ${show(commissions)} este mes contra ${show(commissions, commissions.previous?.value ?? null)} en los mismos días del mes anterior.`,
        datos: { mes: spent.total, anterior: spent.previous, porTipo: spent.rows, porTipoAnterior: beforeRows, mesPasado: lastFull.total, comisiones: commissions.total, comisionesAnterior: commissions.previous },
      }
    },

    x19: async () => {
      // El servicio más hecho de cada uno en los últimos 365 días (o el primero de la lista si no se hizo).
      const services = (where: SQL) =>
        tx.execute<{ id: string; name: string; price: number; times: number; charged: number; average: number | null }>(sql`
          select s.id, s.name, s.price_cents as price,
            coalesce((select sum(ep.quantity) from encounter_procedure ep
              join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
              where ep.organization_id = s.organization_id and ep.service_id = s.id and ep.voided_at is null
                and e.started_at >= ${w.nowIso}::timestamptz - interval '365 days' and e.started_at < ${nowIso}::timestamptz), 0)::int as times,
            (select count(*) from patient_charge c join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
              where c.organization_id = s.organization_id and ep.service_id = s.id and c.voided_at is null
                and c.created_at >= ${w.nowIso}::timestamptz - interval '365 days')::int as charged,
            (select avg(c.amount_cents)::float from patient_charge c join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
              where c.organization_id = s.organization_id and ep.service_id = s.id and c.voided_at is null
                and c.created_at >= ${w.nowIso}::timestamptz - interval '365 days') as average
          from service_catalog s where s.organization_id = ${org} and s.is_active and ${where}
          order by 4 desc, 3 desc, 2`)
      const crowns = await services(sql`s.name ilike '%corona%' and s.name not ilike '%alargamiento%'`)
      const whitening = await services(sql`s.name ilike '%blanquea%'`)
      const crown = crowns[0]
      const white = whitening[0]
      const others = [...crowns.slice(1), ...whitening.slice(1)].filter((row) => row.times > 0)
      // Lo pagado este mes de cada servicio, sobre los pagos: la lista de Reportes por tratamiento junta los menores en «Otros».
      const paidThisMonth = async (serviceId: string | undefined) => {
        if (!serviceId) return 0
        const [row] = await tx.execute<{ cents: string }>(sql`
          select coalesce(sum(a.amount_cents), 0)::text as cents
          from patient_charge c
          join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
          join patient_payment_application a on a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where c.organization_id = ${org} and c.voided_at is null and ep.service_id = ${serviceId}
            and pay.paid_at >= ${h.monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz`)
        return Number(row?.cents ?? 0)
      }
      const crownMonth = await paidThisMonth(crown?.id)
      const whiteMonth = await paidThisMonth(white?.id)
      const year = await h.fig("cobrado", "tratamiento", w.lastYear)
      const of = (result: FigureResult, name: string | undefined) => (name ? centsOf(result.rows.find((row) => row.label === name)) : 0)
      const [lab] = await tx.execute<{ cents: string }>(sql`
        select coalesce(sum(e.amount_cents), 0)::text as cents from expense e
        where e.organization_id = ${org} and e.voided_at is null and e.currency = ${currency} and e.category = 'Laboratorio'
          and e.spent_at >= ${w.nowIso}::timestamptz - interval '365 days' and e.spent_at < ${nowIso}::timestamptz`)
      const words = (row: (typeof crowns)[number] | undefined, done: string) =>
        row ? `${row.name}: ${money(of(year, row.name))} cobrados en los últimos 365 días, ${row.times} ${done}; en tu lista cuesta ${money(row.price)}${row.average !== null ? ` y se cargó en promedio ${money(Math.round(row.average))} cada vez` : ""}` : "no está en tu lista"
      return {
        respuesta: `No puedo decirte cuál te deja más ganancia: odentIA no tiene lo que cuesta cada tratamiento (laboratorio, materiales, el tiempo del profesional), solo lo que se cobra, así que no hay utilidad por tratamiento. Lo más cercano es lo que se cobra: ${words(crown, crown?.times === 1 ? "hecha" : "hechas")}; ${words(white, white?.times === 1 ? "hecho" : "hechos")}. Es lo cobrado, sin restar costos.`,
        criterio: "Trampa: sin el costo de cada tratamiento no hay ganancia. Se ofrecen, de la corona y del blanqueamiento más hechos, «Lo cobrado» de Reportes por tratamiento de los últimos 365 días, las veces hechas (atenciones firmadas), su precio de lista y lo cargado en promedio cada vez.",
        nota: `Este mes (${w.monthSoFar}), por lo cobrado: ${crown?.name ?? "corona"} ${money(crownMonth)} y ${white?.name ?? "blanqueamiento"} ${money(whiteMonth)}. El laboratorio se registra como un gasto del mes sin ligarlo a cada corona: ${money(Number(lab?.cents ?? 0))} en gastos de Laboratorio en los últimos 365 días, que juntan coronas y prótesis. ${others.length ? `Otros servicios con esos nombres que se hicieron: ${listOf(others.map((row) => ({ name: row.name, value: `${money(row.price)}, ${row.times} hechos` })))}.` : `Los demás servicios de corona y blanqueamiento de tu lista no se hicieron en los últimos 365 días.`}`,
        datos: { corona: crown ?? null, blanqueamiento: white ?? null, coronas: crowns, blanqueamientos: whitening, laboratorio365: Number(lab?.cents ?? 0) },
      }
    },

    // --- Pacientes ------------------------------------------------------------------------
    x02: async () => {
      const last = await reportScope(tx, org, { period: "mes_pasado" }, h.now)
      const name = monthLabel(h, last.window.from)
      const before = monthLabel(h, last.window.previous.from)
      const fresh = await h.fig("pacientes_nuevos", "total", "mes_pasado")
      const referral = await h.fig("como_nos_conocieron", "como_nos_conocio", "mes_pasado")
      const channels = await h.fig("nos_buscaron", "canal", "mes_pasado")
      const total = fresh.total.value ?? 0
      const counted = referral.total.value ?? 0
      return {
        respuesta: `En ${name} tuviste ${plural(total, "paciente nuevo", "pacientes nuevos")} (su primera cita atendida en la clínica). Por cómo nos conocieron: ${listOf(referral.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${w.pct(row.value.value ?? 0, counted)}` })))}.`,
        criterio: "«Pacientes nuevos» y «Cómo nos conocieron» de Reportes › Pacientes del mes pasado completo: personas cuya primera cita atendida cae en el mes, y lo que eligió cada una en «Cómo nos conoció» de su registro.",
        nota: `Si «por dónde» es el canal por el que nos buscaron por primera vez en ${name} (el embudo: quien escribió o se registró ese mes, aunque aún no venga): ${listOf(channels.rows.map((row) => ({ name: row.label, value: `${row.value.value ?? 0}, ${row.value.part ?? 0} vinieron` })))}. En ${before} hubo ${fresh.previous?.value ?? 0} pacientes nuevos.`,
        datos: { nuevos: fresh.total, anterior: fresh.previous, comoNosConocieron: referral.rows, canales: channels.rows },
      }
    },

    x15: async () => {
      const result = await h.fig("sin_venir")
      const monthsAgo = (months: number) => sql`((${nowIso}::timestamptz at time zone ${h.tz}) - make_interval(months => ${months})) at time zone ${h.tz}`
      const [row] = await tx.execute<{ over6: number; booked: number; over12: number }>(sql`
        with attended as (
          select a.patient_id, a.starts_at from appointment a
          join patient p on p.organization_id = ${org} and p.id = a.patient_id
          join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.screen is null
          where a.organization_id = ${org} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz),
        last as (select patient_id, max(starts_at) as at from attended group by 1)
        select count(*) filter (where at < ${monthsAgo(6)})::int as over6,
          count(*) filter (where at < ${monthsAgo(6)} and exists (select 1 from appointment n where n.organization_id = ${org}
            and n.patient_id = last.patient_id and n.starts_at > ${nowIso}::timestamptz and n.status in ('programada','confirmada')))::int as booked,
          count(*) filter (where at < ${monthsAgo(12)})::int as over12
        from last`)
      const [split] = await tx.execute<{ over12: number }>(sql`
        with ${lapsedSql(org, h.scope, h.now)} select count(*) filter (where starts_at < ${monthsAgo(12)})::int as over12 from lapsed`)
      return {
        respuesta: `Hoy ${show(result)} pacientes llevan más de 6 meses sin venir: su última cita atendida fue hace más de 6 meses y no tienen cita por venir, presupuesto esperando respuesta ni control pendiente. De ellos, ${split?.over12 ?? 0} llevan más de un año.`,
        criterio: "«Sin venir hace más de 6 meses» de Reportes, a hoy (sin archivados): la cifra que nombra la pregunta.",
        nota: `Contando a todos cuya última cita atendida fue hace más de 6 meses, aunque tengan algo pendiente (un presupuesto o un control): ${row?.over6 ?? 0} (${row?.booked ? `${row.booked} ya con una cita por venir` : "ninguno con una cita por venir"}); con más de un año, ${row?.over12 ?? 0}.`,
        datos: { total: result.total, masDe6Meses: row?.over6 ?? 0, conCita: row?.booked ?? 0, masDe12Meses: row?.over12 ?? 0, sinVenirMasDeUnAño: split?.over12 ?? 0 },
      }
    },

    x24: async () => {
      const branch = await branchNamed("san isidro")
      if (!branch) return noBranch("San Isidro")
      const returned = await h.fig("volvieron", "sede")
      const own = returned.rows.find((row) => row.key === branch.id) ?? rowNamed(returned, /san isidro/i)
      const others = returned.rows.filter((row) => row !== own && (row.value.whole ?? 0) > 0)
      const noShow = await figIn("no_vinieron", "total", "este_mes", branch.id)
      const wait = await figIn("espera_en_sala", "total", "este_mes", branch.id)
      return {
        respuesta: `odentIA no tiene encuestas de satisfacción, así que no sé si los pacientes están contentos con la atención en ${branch.name}. Lo más cercano es si vuelven («Volvieron en el año» de Reportes): en ${branch.name}, ${own && (own.value.whole ?? 0) > 0 ? `el ${show(returned, own.value.value)} (${ofWords(own.value)} pacientes atendidos hace 12 a 24 meses volvieron en los últimos 12)` : "no hay pacientes con que medirlo"}; ${listOf(others.map((row) => ({ name: row.label, value: `${show(returned, row.value.value)}, ${ofWords(row.value)}` })))}.`,
        criterio: "Trampa: no hay encuestas ni NPS. Se ofrece «Volvieron en el año» de Reportes por sede (de los atendidos hace 12 a 24 meses, cuántos volvieron en los últimos 12), como g195.",
        nota: `Toda la clínica: ${show(returned)} (${ofWords(returned.total)}). Este mes en ${branch.name}: no vino a su cita el ${show(noShow)} (${ofWords(noShow.total)}) y la espera en sala es de ${show(wait)} (mediana).`,
        datos: { sede: branch, volvieron: returned.rows, clinica: returned.total, noVinieron: noShow.total, esperaEnSala: wait.total },
      }
    },

    // --- Equipo y agenda ------------------------------------------------------------------
    x03: async () => {
      const key = monthKey(9)
      const scope = await reportScope(tx, org, { period: key }, h.now)
      const name = monthLabel(h, monthOfKey(key))
      const result = await h.fig("cobrado", "profesional", key)
      const rows = [...result.rows].filter((row) => row.key !== "otros").sort((a, b) => centsOf(b) - centsOf(a))
      const top = rows[0]
      const second = rows[1]
      const charged = await tx.execute<{ name: string; cents: string; encounters: number }>(sql`
        select u.name, coalesce(sum(c.amount_cents), 0)::text as cents, count(distinct e.id)::int as encounters
        from patient_charge c
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join "user" u on u.id = e.dentist_user_id
        where c.organization_id = ${org} and c.voided_at is null and c.currency = ${currency}
          and c.created_at >= ${scope.window.start.toISOString()}::timestamptz and c.created_at < ${scope.window.end.toISOString()}::timestamptz
        group by 1 order by sum(c.amount_cents) desc, 1`)
      const total = rows.reduce((sum, row) => sum + centsOf(row), 0)
      return {
        respuesta: top
          ? `En ${name} quien más produjo fue ${the(top.label)}${youToo(top.label)}: ${show(result, top.value.value)} cobrados de lo que atendió (${w.pct(centsOf(top), total)} de lo atribuido a los odontólogos)${second ? `, ${money(centsOf(top) - centsOf(second))} más que ${the(second.label)}${youToo(second.label)} (${show(result, second.value.value)})` : ""}.${rows.length > 2 ? ` Después: ${listOf(rows.slice(2).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.` : ""}`
          : `En ${name} no hay cobros atribuidos a ningún profesional.`,
        criterio: "Producción = «Lo cobrado» de Reportes por profesional (lo pagado de lo que atendió cada uno, sin anulados ni lo devuelto; la base de las comisiones), de setiembre completo, como g072.",
        nota: `Si «produjo» es lo cargado en ${name} de lo que atendió (pagado o no): ${listOf(charged.map((row) => ({ name: row.name, value: `${money(Number(row.cents))} en ${row.encounters} atenciones` })))}.`,
        datos: { periodo: key, porProfesional: result.rows, cargado: charged },
      }
    },

    x04: async () => {
      const surco = await branchNamed("surco")
      if (!surco) return noBranch("Surco")
      const activity = await branchActivity(surco.id)
      const rows: Array<{ name: string; current: number; previous: number }> = []
      for (const branch of await branches()) {
        const result = await figIn("atendidas", "total", "este_mes", branch.id)
        rows.push({ name: branch.name, current: result.total.value ?? 0, previous: result.previous?.value ?? 0 })
      }
      const own = rows.find((row) => row.name === surco.name)
      const others = rows.filter((row) => row.name !== surco.name)
      const [booked] = await tx.execute<{ current: number; previous: number }>(sql`
        select count(*) filter (where a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz)::int as current,
          count(*) filter (where a.starts_at >= ${window.previous.start.toISOString()}::timestamptz and a.starts_at < ${window.previous.end.toISOString()}::timestamptz)::int as previous
        from appointment a where a.organization_id = ${org} and a.branch_id = ${surco.id} and a.status <> 'cancelada'`)
      const words = (list: typeof rows) => listOf(list.map((row) => ({ name: row.name, value: `${row.current} contra ${row.previous}` })))
      const empty = activity.appointments === 0
      return {
        respuesta: empty
          ? `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Además, en ${surco.name} las citas no bajaron: no hay ninguna cita registrada ahí, ni este mes ni antes${activity.schedules === 0 ? ", y ningún profesional tiene horario en esa sede" : ""}. Lo registrado en las otras sedes, citas atendidas ${days.current} contra ${days.sameAs}: ${words(others)}.`
          : `No puedo decirte por qué: odentIA registra lo que pasó, no sus causas. Lo registrado: en ${surco.name} se atendieron ${own?.current ?? 0} citas ${days.current} contra ${own?.previous ?? 0} en ${days.sameAs}; en las otras sedes, ${words(others)}.`,
        criterio: "Trampa: odentIA no sabe causas. Se ofrecen «Citas atendidas» de Reportes por sede del mes en curso contra los mismos días del mes anterior, y lo registrado en la sede desde siempre (citas, cobros, horarios).",
        nota: `Citas agendadas en ${surco.name} (no canceladas, atendidas o no): ${booked?.current ?? 0} este mes contra ${booked?.previous ?? 0} en los mismos días del mes anterior. En ${surco.name}, desde siempre: ${activity.appointments} citas, ${activity.payments} cobros, ${activity.schedules} horarios y ${activity.expenses} gastos registrados.`,
        datos: { sede: surco, actividad: activity, atendidasPorSede: rows, agendadasSurco: booked },
      }
    },

    x05: async () => {
      const branch = await branchNamed("san isidro")
      if (!branch) return noBranch("San Isidro")
      const tomorrow = w.addDays(todayKey, 1)
      const status = await tx.execute<{ status: string; day: string; total: number }>(sql`
        select a.status, case when ${h.dayOf(sql`a.starts_at`)} = ${h.today} then 'hoy' else 'manana' end as day, count(*)::int as total
        from appointment a where a.organization_id = ${org} and a.branch_id = ${branch.id}
          and ${h.dayOf(sql`a.starts_at`)} in (${h.today}, ${h.today} + 1)
        group by 1, 2`)
      const count = (day: string, list: string[]) => status.filter((row) => row.day === day && list.includes(row.status)).reduce((sum, row) => sum + row.total, 0)
      const total = count("manana", ["programada", "confirmada"])
      const confirmed = count("manana", ["confirmada"])
      const [coming] = await tx.execute<{ here: number; all: number; next: string | null }>(sql`
        select count(*) filter (where a.branch_id = ${branch.id})::int as here, count(*)::int as all,
          to_char(min(${h.dayOf(sql`a.starts_at`)}) filter (where a.branch_id = ${branch.id} and ${h.dayOf(sql`a.starts_at`)} > ${h.today} + 1), 'YYYY-MM-DD') as next
        from appointment a where a.organization_id = ${org} and a.status in ('programada','confirmada') and a.starts_at > ${nowIso}::timestamptz`)
      // Quién atiende mañana en la sede y cuánto tiene libre (la cuenta de Reportes › Agenda).
      const start = new Date(await dayStart(h, tomorrow))
      const end = new Date(await dayStart(h, w.addDays(tomorrow, 1)))
      const agenda = await agendaMinutes(tx, org, { start, end }, { branchId: branch.id })
      const people = await tx.execute<{ id: string; name: string }>(sql`select id, name from "user" where id in (select dentist_user_id from professional_schedule where organization_id = ${org})`)
      const nameOf = (id: string) => people.find((row) => row.id === id)?.name ?? "—"
      const working = agenda.days.filter((day) => day.availMin > 0)
      const todayWords = [
        [count("hoy", ["atendida"]), "atendida", "atendidas"],
        [count("hoy", ["no_asistio"]), "en que no vino el paciente", "en que no vino el paciente"],
        [count("hoy", ["cancelada"]), "cancelada", "canceladas"],
        [count("hoy", ["programada", "confirmada"]), "sin marcar", "sin marcar"],
      ]
        .filter(([total]) => Number(total) > 0)
        .map(([total, one, many]) => plural(Number(total), String(one), String(many)))
        .join(", ")
      const todayTotal = status.filter((row) => row.day === "hoy").reduce((sum, row) => sum + row.total, 0)
      // Lo más cercano que sí hay: el último día con citas en la sede.
      const [lastDay] = await tx.execute<{ day: string | null; total: number; attended: number; noShow: number; cancelled: number }>(sql`
        with last as (select max(${h.dayOf(sql`a.starts_at`)}) as day from appointment a
          where a.organization_id = ${org} and a.branch_id = ${branch.id} and a.status <> 'cancelada' and ${h.dayOf(sql`a.starts_at`)} <= ${h.today})
        select to_char(last.day, 'YYYY-MM-DD') as day, count(a.id)::int as total,
          count(a.id) filter (where a.status = 'atendida')::int as attended, count(a.id) filter (where a.status = 'no_asistio')::int as "noShow",
          count(a.id) filter (where a.status = 'cancelada')::int as cancelled
        from last left join appointment a on a.organization_id = ${org} and a.branch_id = ${branch.id} and ${h.dayOf(sql`a.starts_at`)} = last.day
        group by last.day`)
      const [weekAgo] = await tx.execute<{ total: number; attended: number }>(sql`
        select count(*)::int as total, count(*) filter (where a.status = 'atendida')::int as attended from appointment a
        where a.organization_id = ${org} and a.branch_id = ${branch.id} and a.status <> 'cancelada' and ${h.dayOf(sql`a.starts_at`)} = ${h.today} - 6`)
      const lastWords = lastDay?.day
        ? `el último día con citas en ${branch.name} fue el ${w.dayWords(lastDay.day)}: ${plural(lastDay.total, "cita", "citas")} (${lastDay.attended} ${lastDay.attended === 1 ? "atendida" : "atendidas"}${lastDay.noShow ? `, ${lastDay.noShow} en que no vino el paciente` : ""}${lastDay.cancelled ? `, ${plural(lastDay.cancelled, "cancelada", "canceladas")}` : ""})`
        : `${branch.name} nunca tuvo citas`
      return {
        respuesta: total
          ? `Mañana (${w.dayWords(tomorrow)}) en ${branch.name} hay ${plural(total, "cita", "citas")}: ${confirmed} ${confirmed === 1 ? "confirmada" : "confirmadas"} y ${total - confirmed} por confirmar.`
          : `Mañana (${w.dayWords(tomorrow)}) no hay citas en ${branch.name}${count("manana", ["cancelada"]) ? ` (${plural(count("manana", ["cancelada"]), "se canceló", "se cancelaron")})` : ""}${coming?.all ? "" : ", y no queda ninguna cita por venir en ninguna sede"}.${working.length ? ` Mañana atiende${working.length > 1 ? "n" : ""} ahí ${working.map((day) => `${the(nameOf(day.dentistUserId))}, con ${hoursOf(day.availMin - day.occMin)} libres`).join(" y ")}.` : ` Mañana nadie tiene horario en ${branch.name}.`} Lo más cercano: ${todayTotal ? `hoy en ${branch.name} hubo ${plural(todayTotal, "cita", "citas")} (${todayWords})` : `hoy en ${branch.name} no hubo citas; ${lastWords}`}.`,
        criterio: "Citas de mañana (día de la clínica) programadas o confirmadas en la sede; si no hay, el horario de mañana en la sede (la cuenta de Reportes › Agenda) y las citas de hoy o, si hoy no hubo, las del último día con citas en la sede.",
        nota: coming?.next
          ? `La siguiente fecha con citas en ${branch.name} es el ${w.dayWords(coming.next)}. Citas por venir en toda la clínica: ${coming.all}.`
          : coming?.all
            ? `En ${branch.name} no hay ninguna cita por venir; en toda la clínica, ${plural(coming.all, "cita por venir", "citas por venir")}.`
            : `El mismo día de la semana pasada (${w.dayWords(w.addDays(tomorrow, -7))}) ${branch.name} tuvo ${plural(weekAgo?.total ?? 0, "cita", "citas")}, ${weekAgo?.attended ?? 0} ${weekAgo?.attended === 1 ? "atendida" : "atendidas"}.`,
        datos: { sede: branch, manana: tomorrow, porEstado: status, porVenir: coming ?? null, ultimoDiaConCitas: lastDay ?? null, horarioManana: working.map((day) => ({ name: nameOf(day.dentistUserId), availMin: day.availMin, occMin: day.occMin })) },
      }
    },

    x08: async () => {
      const from = w.addDays(monday, -7)
      const to = w.addDays(monday, -1)
      const range = `${from}..${to}`
      const result = await h.fig("no_vinieron", "total", range)
      const bySede = await h.fig("no_vinieron", "sede", range)
      const cancelled = await h.fig("canceladas", "total", range)
      const before = await h.fig("no_vinieron", "total", `${w.addDays(from, -7)}..${w.addDays(to, -7)}`)
      const start = await dayStart(h, from)
      const end = await dayStart(h, monday)
      const [row] = await tx.execute<{ people: number }>(sql`
        select count(distinct a.patient_id)::int as people from appointment a
        where a.organization_id = ${org} and a.status = 'no_asistio' and a.starts_at >= ${start}::timestamptz and a.starts_at < ${end}::timestamptz`)
      const missed = result.total.part ?? 0
      return {
        respuesta: `La semana pasada (${spanWords(from, to)}) faltaron a su cita ${plural(row?.people ?? 0, "paciente", "pacientes")}: ${plural(missed, "cita", "citas")} sin venir, el ${show(result)} de las ${result.total.whole ?? 0} citas que ya pasaron.${bySede.rows.some((item) => (item.value.part ?? 0) > 0) ? ` Por sede: ${listOf(bySede.rows.filter((item) => (item.value.part ?? 0) > 0).map((item) => ({ name: item.label, value: ofWords(item.value) })))}.` : ""}`,
        criterio: "«No vinieron» de Reportes de la semana pasada, de lunes a domingo (citas en que el paciente no vino ÷ citas que ya pasaron), con las personas distintas de esas citas, como g089.",
        nota: `Si cuentas también las canceladas: esa semana se cancelaron ${plural(cancelled.total.part ?? 0, "cita", "citas")} más. La semana anterior (${spanWords(w.addDays(from, -7), w.addDays(to, -7))}) no vinieron ${before.total.part ?? 0} citas, el ${show(before)}.`,
        datos: { semana: { desde: from, hasta: to }, total: result.total, personas: row?.people ?? 0, porSede: bySede.rows, canceladas: cancelled.total, semanaAnterior: before.total },
      }
    },

    x09: async () => {
      const branch = await branchNamed("miraflores")
      if (!branch) return noBranch("Miraflores")
      const result = await figIn("espera_en_sala", "total", "este_mes", branch.id)
      const clinic = await h.fig("espera_en_sala")
      // El promedio simple con la misma regla de Reportes (`waitInRoom`): la llegada marcada antes de empezar la atención.
      const [row] = await tx.execute<{ average: number | null; measured: number }>(sql`
        select avg(extract(epoch from (e.started_at - a.arrived_at)) / 60)::float as average, count(*)::int as measured
        from appointment a
        join encounter e on e.organization_id = a.organization_id and e.appointment_id = a.id and e.status <> 'anulada'
        where a.organization_id = ${org} and a.branch_id = ${branch.id}
          and a.starts_at >= ${h.monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
          and a.arrived_at is not null and a.arrived_at < e.started_at`)
      const average = row?.average === null || row?.average === undefined ? null : Math.round(row.average)
      return {
        respuesta: result.total.value === null
          ? `Este mes (${w.monthSoFar}) en ${branch.name} no hay llegadas marcadas con que medir la espera en sala.`
          : `Este mes (${w.monthSoFar}) en ${branch.name} los pacientes esperan ${show(result)} en sala (la mediana de Reportes, en ${plural(row?.measured ?? 0, "cita", "citas")} con la llegada marcada); en promedio simple, ${average ?? 0} minutos.`,
        criterio: "«Espera en sala» de Reportes con la sede elegida, del mes en curso: mediana de minutos entre «Llegó» y el inicio de la atención (solo la llegada marcada antes de empezar). El promedio simple sale de las mismas citas.",
        nota: `En los mismos días del mes anterior en ${branch.name}: ${show(result, result.previous?.value ?? null)} (mediana). En toda la clínica este mes: ${show(clinic)}.`,
        datos: { sede: branch, mediana: result.total, anterior: result.previous, promedio: average, medidas: row?.measured ?? 0, clinica: clinic.total },
      }
    },

    x16: async () => {
      const person = await dentistNamed("Elena Rojas")
      if (!person) return { respuesta: "No hay una Dra. Elena Rojas en el equipo de la clínica.", criterio: "La profesional no existe.", datos: {} }
      const nextMonday = w.addDays(monday, 7)
      const nextSunday = w.addDays(monday, 13)
      const startIso = await dayStart(h, nextMonday)
      const endIso = await dayStart(h, w.addDays(monday, 14))
      const minutes = await agendaMinutes(tx, org, { start: new Date(startIso), end: new Date(endIso) }, { dentistUserId: person.id })
      const scheduled = minutes.days.reduce((sum, day) => sum + day.scheduledMin, 0)
      const free = minutes.days.reduce((sum, day) => sum + Math.max(0, day.availMin - day.occMin), 0)
      const booked = minutes.days.reduce((sum, day) => sum + day.occMin, 0)
      // Los tramos libres de cada día, con las mismas reglas que `agendaMinutes`: el horario vigente ese día,
      // menos los bloqueos suyos o de toda la sede, menos sus citas no canceladas.
      const shifts = await tx.execute<{ day: string; branchId: string; branch: string; start: number; end: number }>(sql`
        with d as (select generate_series(${nextMonday}::date, ${nextSunday}::date, interval '1 day')::date as day)
        select to_char(d.day, 'YYYY-MM-DD') as day, s.branch_id as "branchId", b.name as branch,
          (extract(epoch from ((d.day::timestamp + make_interval(mins => s.start_min)) at time zone coalesce(b.timezone, ${h.tz}))) * 1000)::float8 as start,
          (extract(epoch from ((d.day::timestamp + make_interval(mins => s.end_min)) at time zone coalesce(b.timezone, ${h.tz}))) * 1000)::float8 as end
        from d
        join professional_schedule s on s.organization_id = ${org} and s.dentist_user_id = ${person.id} and s.weekday = extract(dow from d.day)::int
          and s.valid_from <= d.day and (s.valid_until is null or s.valid_until > d.day)
        join branch b on b.organization_id = s.organization_id and b.id = s.branch_id
        order by d.day, s.start_min`)
      const cuts = await tx.execute<{ branchId: string | null; start: number; end: number }>(sql`
        select k.branch_id as "branchId", (extract(epoch from k.starts_at) * 1000)::float8 as start, (extract(epoch from k.ends_at) * 1000)::float8 as end
        from schedule_block k where k.organization_id = ${org} and k.starts_at < ${endIso}::timestamptz and k.ends_at > ${startIso}::timestamptz
          and (k.dentist_user_id = ${person.id} or (k.dentist_user_id is null and k.chair_id is null))
        union all
        select null, (extract(epoch from a.starts_at) * 1000)::float8, (extract(epoch from a.ends_at) * 1000)::float8 from appointment a
        where a.organization_id = ${org} and a.dentist_user_id = ${person.id} and a.status <> 'cancelada'
          and a.starts_at < ${endIso}::timestamptz and a.ends_at > ${startIso}::timestamptz`)
      const byDay = new Map<string, { branch: string; spans: Array<[number, number]> }>()
      for (const shift of shifts) {
        const key = `${shift.day}|${shift.branchId}`
        const entry = byDay.get(key) ?? { branch: shift.branch, spans: [] }
        entry.spans.push([shift.start, shift.end])
        byDay.set(key, entry)
      }
      const ranges = [...byDay.entries()].flatMap(([key, entry]) => {
        const [day, branchId] = key.split("|") as [string, string]
        const rest = subtractSpans(
          entry.spans,
          cuts.filter((cut) => cut.branchId === null || cut.branchId === branchId).map((cut): [number, number] => [cut.start, cut.end]),
        )
        return rest.length ? [{ day, branch: entry.branch, spans: rest.map(([a, b]) => `de ${clockOf(a)} a ${clockOf(b)}`) }] : []
      })
      const sedes = new Set(ranges.map((range) => range.branch))
      const rangeParts = ranges.map((range) => `el ${w.dayWords(range.day)} ${range.spans.join(" y ")}${sedes.size > 1 ? ` en ${range.branch}` : ""}`)
      const rangeWords = rangeParts.length > 1 ? `${rangeParts.slice(0, -1).join("; ")} y ${rangeParts.at(-1)}` : (rangeParts[0] ?? "")
      return {
        respuesta: scheduled
          ? free > 0
            ? `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${the(person.name)} tiene libre ${rangeWords}${sedes.size === 1 ? `, en ${[...sedes][0]}` : ""}: ${hoursOf(free)} en total${booked ? `; ya tiene ${hoursOf(booked)} con citas` : ", porque todavía no tiene citas agendadas"}.`
            : `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${the(person.name)} no tiene horas libres: su horario (${hoursOf(scheduled)}) está lleno o bloqueado.`
          : `La próxima semana (${spanWords(nextMonday, nextSunday)}) ${the(person.name)} no tiene horario.`,
        criterio: "La próxima semana, de lunes a domingo: su horario vigente cada día, menos sus ausencias y los cierres de su sede, menos sus citas no canceladas (la cuenta de Reportes › Agenda), dicho en tramos.",
        nota: `Su horario suma ${hoursOf(scheduled)} esa semana${scheduled > free + booked ? `; los bloqueos le quitan ${hoursOf(scheduled - free - booked)}` : " y ningún bloqueo lo toca"}.`,
        datos: { profesional: person, semana: { desde: nextMonday, hasta: nextSunday }, horario: scheduled, libres: free, conCitas: booked, tramos: ranges, porDia: minutes.days },
      }
    },

    x25: async () => {
      const sepKey = monthKey(9)
      const augKey = monthKey(8)
      const sep = await h.fig("canceladas", "total", sepKey)
      const aug = await h.fig("canceladas", "total", augKey)
      const sepSede = await h.fig("canceladas", "sede", sepKey)
      const augSede = await h.fig("canceladas", "sede", augKey)
      const sepName = monthLabel(h, monthOfKey(sepKey), false)
      const augName = monthLabel(h, monthOfKey(augKey), false)
      const s = sep.total.part ?? 0
      const a = aug.total.part ?? 0
      const words = (result: FigureResult) => `el ${show(result)} de las ${result.total.whole ?? 0} citas que ya pasaron`
      const rateSep = sep.total.value ?? 0
      const rateAug = aug.total.value ?? 0
      return {
        respuesta: s === a
          ? `Se cancelaron las mismas en los dos meses: ${plural(s, "cita", "citas")} en ${sepName} (${words(sep)}) y en ${augName} (${words(aug)}).`
          : `Se cancelaron más en ${s > a ? sepName : augName}: ${plural(s, "cita", "citas")} en ${sepName} (${words(sep)}) contra ${a} en ${augName} (${words(aug)}).`,
        criterio: "«Canceladas» de Reportes de setiembre y de agosto completos: citas de ese mes que hoy están canceladas ÷ citas que ya pasaron. Se comparan por cuántas.",
        nota: `${(s > a) !== (rateSep > rateAug) && s !== a ? `Por porcentaje la comparación se invierte: ${show(sep)} en ${sepName} contra ${show(aug)} en ${augName}. ` : ""}Por sede, ${sepName}: ${listOf(sepSede.rows.map((row) => ({ name: row.label, value: ofWords(row.value) })))}; ${augName}: ${listOf(augSede.rows.map((row) => ({ name: row.label, value: ofWords(row.value) })))}. Se cuentan por el día de la cita: una cita no guarda el día en que se canceló.`,
        datos: { setiembre: sep.total, agosto: aug.total, setiembrePorSede: sepSede.rows, agostoPorSede: augSede.rows },
      }
    },

    // --- Inventario -----------------------------------------------------------------------
    x10: async () => {
      const found = await bySede()
      const short = found.filter((item) => item.needs)
      const supplies = short.filter((item) => item.usedInCare)
      const others = short.filter((item) => !item.usedInCare)
      const shortWords = (list: typeof found) =>
        listOf(
          list.map((row) => ({
            name: `${row.name} en ${row.branch}`,
            value: row.shortage > 0 ? `se usaron ${unitsWord(row.shortage, row.unit)} sin haber; mínimo ${row.minQuantity}` : `hay ${unitsWord(row.onHand, row.unit)}, mínimo ${row.minQuantity}`,
          })),
        )
      // Lo usado en los últimos 30 días por producto y sede, para decir para cuánto alcanza.
      const used = await tx.execute<{ productId: string; branchId: string; units: number }>(sql`
        select m.product_id as "productId", wh.branch_id as "branchId", sum(-m.quantity_delta)::int as units
        from stock_movement m join warehouse wh on wh.organization_id = m.organization_id and wh.id = m.warehouse_id
        where m.organization_id = ${org} and m.kind = 'consumo'
          and m.created_at >= ${nowIso}::timestamptz - interval '30 days' and m.created_at < ${nowIso}::timestamptz
        group by 1, 2`)
      const usedOf = (item: (typeof found)[number]) => used.find((row) => row.productId === item.id && row.branchId === item.branchId)?.units ?? 0
      const focusWords = (pattern: RegExp) => {
        const list = found.filter((item) => pattern.test(item.name) && item.isActive)
        if (!list.length) return null
        const name = list[0]?.name ?? ""
        const parts = list.map((item) => {
          const usable = item.onHand - (item.expired?.quantity ?? 0)
          const head =
            item.onHand <= 0
              ? `${item.branch}, no queda nada`
              : `${item.branch}, ${units(item.onHand, item.unit)}${item.expired ? ` (${units(item.expired.quantity, item.unit)} vencidos: sirven ${usable.toLocaleString(locale)})` : ""}`
          const min = item.minQuantity > 0 ? `, mínimo ${item.minQuantity.toLocaleString(locale)}${item.needs ? ": hace falta" : usable < item.minQuantity ? ": sin los vencidos queda bajo el mínimo" : ""}` : item.onHand > 0 ? ", sin mínimo puesto" : ""
          return `${head}${min}`
        })
        return { name, text: `${name}: ${parts.join("; ")}`, list }
      }
      const lido = focusWords(/lidoca/i)
      const gloves = focusWords(/guante.*nitrilo|nitrilo/i)
      const pace = [lido, gloves]
        .flatMap((focus) => focus?.list ?? [])
        .filter((item) => item.onHand > 0 && usedOf(item) > 0)
        .map((item) => {
          const days = Math.floor(((item.onHand - (item.expired?.quantity ?? 0)) / usedOf(item)) * 30)
          return { name: `${item.name} en ${item.branch}`, value: `${units(usedOf(item), item.unit)} usados en 30 días: alcanza para ${days > 365 ? "más de un año" : `unos ${days} días`}` }
        })
      return {
        respuesta: `${supplies.length ? `Hoy ${supplies.length === 1 ? "hace falta 1 insumo" : `hacen falta ${supplies.length} insumos`}: ${shortWords(supplies)}.` : "Hoy ningún insumo está por debajo de su mínimo ni se usó sin haber."} ${lido ? `${lido.text}.` : "No tienes lidocaína en Inventario."} ${gloves ? `${gloves.text}.` : "No tienes guantes de nitrilo en Inventario."}`,
        criterio: "«Hacen falta» de Inventario en cada sede, a hoy: insumos (productos que se usan en las atenciones) por debajo de su mínimo o usados sin haber; y lo que hay de lidocaína y guantes de nitrilo en cada sede (lotes − faltante, en su unidad de uso), con lo vencido aparte.",
        nota: `${others.length ? `Además hacen falta productos que no son insumos (solo se venden): ${shortWords(others)}. ` : ""}${pace.length ? `Al ritmo de los últimos 30 días: ${listOf(pace)}.` : "En los últimos 30 días no se usó lidocaína ni guantes."}`,
        datos: { hacenFalta: short.map((row) => ({ name: row.name, branch: row.branch, onHand: row.onHand, shortage: row.shortage, min: row.minQuantity, insumo: row.usedInCare })), lidocaina: lido?.list ?? [], guantes: gloves?.list ?? [], usado30Dias: used },
      }
    },

    x11: async () => {
      const all = [...(await lots())]
      const yearEnd = `${year}-12-31`
      const coming = all.filter((row) => row.expires && row.expires >= todayKey && row.expires <= yearEnd)
      const expired = all.filter((row) => row.expires && row.expires < todayKey)
      const next = all.filter((row) => row.expires && row.expires > yearEnd).slice(0, 2)
      const horizon = w.addDays(todayKey, 30)
      const in30 = coming.filter((row) => (row.expires ?? "") <= horizon)
      return {
        respuesta: `${coming.length ? `Sí: de hoy al 31 de diciembre vence${coming.length === 1 ? "" : "n"} ${plural(coming.length, "lote", "lotes")}: ${lotWords(coming)}.` : `No: ningún lote con existencias vence de hoy al 31 de diciembre de ${year}.`}${expired.length ? ` Además, ${expired.length === 1 ? "hay un lote ya vencido que sigue" : `hay ${expired.length} lotes ya vencidos que siguen`} en el almacén: ${lotWords(expired)}.` : ""}${!coming.length && next.length ? ` Lo próximo en vencer: ${lotWords(next.slice(0, 1))}.` : ""}`,
        criterio: "Lotes con existencias, a hoy, que vencen entre hoy y el 31 de diciembre; lo ya vencido que sigue en el almacén, aparte.",
        nota: `De esos, en los próximos 30 días («Por vencer» de Inventario): ${in30.length ? lotWords(in30) : "ninguno"}.${next.length ? ` Después de fin de año, lo primero en vencer: ${lotWords(next)}.` : ""}`,
        datos: { antesDeFinDeAno: coming, vencidos: expired, siguientes: next },
      }
    },

    // --- Presupuestos y ventas ------------------------------------------------------------
    x14: async () => {
      const result = await h.fig("aceptaron", "total", "este_ano")
      const yearScope = await reportScope(tx, org, { period: "este_ano" }, h.now)
      const [row] = await tx.execute<{ delivered: number; full: number; partial: number; rejected: number; waiting: number }>(sql`
        select count(*)::int as delivered, count(*) filter (where b.status = 'aceptado')::int as full,
          count(*) filter (where b.status = 'parcial')::int as partial, count(*) filter (where b.status = 'rechazado')::int as rejected,
          count(*) filter (where b.status in ('presentado','pospuesto'))::int as waiting
        from treatment_budget b
        where b.organization_id = ${org} and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
          and b.presented_at >= ${yearScope.window.start.toISOString()}::timestamptz and b.presented_at < ${nowIso}::timestamptz`)
      const accepted = result.total.part ?? 0
      return {
        respuesta: `En lo que va del año (del 1 de enero al ${dateWords(todayKey)}) entregaste ${result.total.whole ?? 0} presupuestos y ${plural(accepted, "se aceptó", "se aceptaron")} en todo o en parte: el ${show(result)}. De ellos, ${row?.full ?? 0} enteros y ${row?.partial ?? 0} en parte.`,
        criterio: "«Aceptaron su presupuesto» de Reportes de este año hasta hoy: presupuestos entregados (presentados, sin borradores, sustituidos ni cancelados) aceptados en todo o en parte, según su respuesta a hoy.",
        nota: `De los demás, ${row?.rejected ?? 0} se rechazaron y ${row?.waiting ?? 0} siguen esperando respuesta. En el mismo tramo del año pasado: ${show(result, result.previous?.value ?? null)} (${ofWords(result.previous)}).`,
        datos: { total: result.total, anterior: result.previous, porEstado: row },
      }
    },

    x17: async () => {
      const scope = await reportScope(tx, org, { period: "ultimos_3_meses" }, h.now)
      const { from, to } = scope.window
      const months = `${monthLabel(h, from, false)} a ${monthLabel(h, to)}`
      const rows = await done(scope.window.start.toISOString(), scope.window.end.toISOString())
      const withOctober = await done(scope.window.start.toISOString(), nowIso)
      const top = rows[0]
      const isEvaluation = (name: string) => /evaluaci|consulta|control/i.test(name)
      const treatments = rows.filter((row) => !isEvaluation(row.name))
      const byRows = [...rows].sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name))
      const paid = await h.fig("cobrado", "tratamiento", "ultimos_3_meses")
      return {
        respuesta: top
          ? `En los últimos 3 meses completos (${months}) el tratamiento que más se hizo fue ${top.name}: ${plural(top.times, "vez", "veces")}, a ${plural(top.patients, "paciente", "pacientes")}. Le siguen ${listOf(rows.slice(1, 4).map((row) => ({ name: row.name, value: `${row.times}` })))}.`
          : `En los últimos 3 meses completos (${months}) no hay atenciones firmadas con tratamientos.`,
        criterio: "Procedimientos sin anular de atenciones firmadas de julio a setiembre (los 3 últimos meses completos, por el día de la atención), por tratamiento y contando su cantidad.",
        nota: `${top && isEvaluation(top.name) && treatments[0] ? `Sin contar evaluaciones, consultas ni controles, el primero es ${treatments[0].name} (${treatments[0].times}). ` : ""}Contando cada procedimiento una vez, sin su cantidad: ${listOf(byRows.slice(0, 3).map((row) => ({ name: row.name, value: `${row.rows}` })))}. Con lo que va de octubre: ${listOf(withOctober.slice(0, 3).map((row) => ({ name: row.name, value: `${row.times}` })))}. Por lo cobrado en esos meses (Reportes): ${listOf(paid.rows.slice(0, 3).map((row) => ({ name: row.label, value: show(paid, row.value.value) })))}.`,
        datos: { desde: from, hasta: to, filas: rows.slice(0, 15), conOctubre: withOctober.slice(0, 10), cobrado: paid.rows },
      }
    },

    x22: sameAs(g6, "g134"),

    x23: async () => {
      const promos = await tx.execute<{ id: string; name: string; starts: string | null; ends: string | null }>(sql`
        select id, name, to_char(starts_at at time zone ${h.tz}, 'YYYY-MM-DD') as starts, to_char((ends_at - interval '1 second') at time zone ${h.tz}, 'YYYY-MM-DD') as ends
        from promotion where organization_id = ${org} and name ilike '%evaluaci%' and (name ilike '%grat%' or name ilike '%sin costo%' or name ilike '%free%')
        order by starts_at`)
      const promo = promos[0]
      const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
      const lineUnits = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
      // Quienes recibieron la evaluación gratis en un tramo (como Reportes › Promociones: un presupuesto entregado o un cobro con ella)
      // y si después aceptaron un presupuesto de tratamientos (otro presupuesto con una línea aceptada sin esa promoción).
      const uses = (start: string, end: string) =>
        promo
          ? tx.execute<{ patientId: string; person: string; at: string; accepted: boolean; acceptedCents: string | null; waiting: boolean; waitingCents: string | null }>(sql`
              with used as (
                select b.patient_id, min(b.presented_at) as at from treatment_budget b
                join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
                  and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.promotion_id = ${promo.id} and i.price_cents is not null
                where b.organization_id = ${org} and b.status <> 'borrador' and b.presented_at >= ${start}::timestamptz and b.presented_at < ${end}::timestamptz
                group by 1
                union
                select c.patient_id, min(c.created_at) from patient_charge c
                where c.organization_id = ${org} and c.voided_at is null and c.budget_item_id is null and c.promotion_id = ${promo.id}::text
                  and c.created_at >= ${start}::timestamptz and c.created_at < ${end}::timestamptz
                group by 1),
              person as (select patient_id, min(at) as at from used group by 1),
              later as (
                select pe.patient_id, b.id, b.status,
                  sum(i.price_cents::bigint * ${lineUnits}) filter (where i.decision = 'aceptado') as accepted_cents,
                  sum(i.price_cents::bigint * ${lineUnits}) filter (where i.decision in ('pendiente','pospuesto')) as waiting_cents
                from person pe
                join treatment_budget b on b.organization_id = ${org} and b.patient_id = pe.patient_id and b.presented_at >= pe.at
                  and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
                join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
                  and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null and i.promotion_id is distinct from ${promo.id}
                group by 1, 2, 3)
              select pe.patient_id as "patientId", pp.display_name as person, to_char(pe.at at time zone ${h.tz}, 'YYYY-MM-DD') as at,
                exists (select 1 from later l where l.patient_id = pe.patient_id and l.status in ('aceptado','parcial') and l.accepted_cents > 0) as accepted,
                (select sum(l.accepted_cents) from later l where l.patient_id = pe.patient_id and l.status in ('aceptado','parcial'))::text as "acceptedCents",
                exists (select 1 from later l where l.patient_id = pe.patient_id and l.status in ('presentado','pospuesto','parcial') and l.waiting_cents > 0) as waiting,
                (select sum(l.waiting_cents) from later l where l.patient_id = pe.patient_id and l.status in ('presentado','pospuesto','parcial'))::text as "waitingCents"
              from person pe ${h.joinPerson(sql`pe.patient_id`)}
              order by pe.at, 2`)
          : Promise.resolve([])
      if (!promo) {
        const [evaluations] = await tx.execute<{ times: number }>(sql`
          select coalesce(sum(ep.quantity), 0)::int as times from encounter_procedure ep
          join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
          join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
          where ep.organization_id = ${org} and ep.voided_at is null and s.name ilike '%evaluaci%' and e.started_at >= ${h.monthStart}::timestamptz`)
        return {
          respuesta: `No tienes una promoción de evaluación gratis. Este mes se hicieron ${evaluations?.times ?? 0} evaluaciones, todas con su precio.`,
          criterio: "No hay promoción de evaluación gratis; se dan las evaluaciones del mes (atenciones firmadas).",
          datos: { evaluaciones: evaluations?.times ?? 0 },
        }
      }
      const month = [...(await uses(h.monthStart, nowIso))]
      const sinceStart = [...(await uses(await dayStart(h, promo.starts ?? `${year}-01-01`), nowIso))]
      const accepted = month.filter((row) => row.accepted)
      const waiting = month.filter((row) => !row.accepted && row.waiting)
      const report = await getReportPromotions(tx, org, { period: "este_mes" }, h.now)
      const screen = report.promotions.find((row) => row.promotionId === promo.id)
      const [evaluations] = await tx.execute<{ times: number; charged: number }>(sql`
        select coalesce(sum(ep.quantity), 0)::int as times,
          count(*) filter (where exists (select 1 from patient_charge c where c.organization_id = ep.organization_id and c.encounter_procedure_id = ep.id
            and c.voided_at is null and c.amount_cents > 0))::int as charged
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${org} and ep.voided_at is null and s.name ilike '%evaluaci%'
          and e.started_at >= ${h.monthStart}::timestamptz and e.started_at < ${nowIso}::timestamptz`)
      const who = (list: typeof month) => listOf(list.map((row) => ({ name: row.person, value: w.dayWords(row.at) })))
      const names = (list: typeof month, words: (row: (typeof month)[number]) => string) => list.map((row) => `${row.person}, ${words(row)}`).join("; ")
      return {
        respuesta: month.length
          ? `Este mes (${w.monthSoFar}) se dieron ${plural(month.length, "evaluación gratis", "evaluaciones gratis")} (la promoción «${promo.name}»): ${who(month)}. ${accepted.length ? `${accepted.length === month.length ? (accepted.length === 1 ? "Esa terminó" : "Todas terminaron") : `${accepted.length} ${accepted.length === 1 ? "terminó" : "terminaron"}`} en un presupuesto de tratamiento aceptado: ${names(accepted, (row) => `que aceptó ${money(Number(row.acceptedCents ?? 0))}`)}` : "Ninguna terminó todavía en un presupuesto de tratamiento aceptado"}${waiting.length ? `; ${waiting.length === 1 ? "otra tiene" : `otras ${waiting.length} tienen`} un presupuesto esperando respuesta: ${names(waiting, (row) => `con ${money(Number(row.waitingCents ?? 0))} por decidir`)}` : ""}.`
          : `Este mes (${w.monthSoFar}) no se dio ninguna evaluación gratis (la promoción «${promo.name}»).`,
        criterio: "Usos de la promoción «Evaluación gratis» en el mes en curso como los cuenta Reportes › Promociones (un presupuesto entregado o un cobro con ella), por persona; «terminó en un presupuesto aceptado»: después de usarla, esa persona aceptó en todo o en parte otro presupuesto con tratamientos, a hoy.",
        nota: `Reportes › Promociones cuenta ${screen?.accepted ?? 0} de ${screen?.people ?? 0} como «aceptaron», porque la evaluación gratis va como una línea aceptada en su propio presupuesto. Desde que empezó la promoción (${promo.starts ? dateWords(promo.starts) : "—"}): ${plural(sinceStart.length, "evaluación gratis", "evaluaciones gratis")}, ${sinceStart.filter((row) => row.accepted).length} terminaron en un presupuesto aceptado. Evaluaciones hechas este mes en las atenciones: ${evaluations?.times ?? 0}, ${evaluations?.charged ?? 0} con su precio cobrado.`,
        datos: { promocion: promo, mes: month, desdeQueEmpezo: sinceStart, reportes: screen ?? null, evaluacionesDelMes: evaluations },
      }
    },

    // --- Conversaciones -------------------------------------------------------------------
    x20: async () => {
      const yesterday = w.addDays(todayKey, -1)
      const start = await dayStart(h, yesterday)
      const end = await dayStart(h, todayKey)
      const rows = await tx.execute<{ person: string; channel: string | null; lastIn: string; answeredByClose: boolean; waiting: boolean; since: string | null; screened: boolean }>(sql`
        select pp.display_name as person, cc.channel, to_char(x.last_in at time zone ${h.tz}, 'HH24:MI') as "lastIn",
          exists (select 1 from message m where m.organization_id = c.organization_id and m.conversation_id = c.id and ${acceptedOutSql(sql.raw("m"))}
            and m.created_at > x.last_in and m.created_at < ${end}::timestamptz) as "answeredByClose",
          ${unansweredSql(sql.raw("c"))} as waiting, ${unansweredSinceSql(sql.raw("c"))}::text as since, ${screenedSql(sql.raw("c"))} as screened
        from conversation c
        join contact pp on pp.organization_id = c.organization_id and pp.id = c.contact_id
        left join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
        join lateral (select max(m.created_at) as last_in from message m where m.organization_id = c.organization_id and m.conversation_id = c.id
          and m.direction = 'in' and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz) x on x.last_in is not null
        where c.organization_id = ${org}
        order by x.last_in`)
      const wrote = rows.filter((row) => !row.screened)
      const whatsapp = wrote.filter((row) => row.channel === "whatsapp")
      const left = whatsapp.filter((row) => !row.answeredByClose)
      const still = left.filter((row) => row.waiting)
      const spam = rows.filter((row) => row.screened && row.channel === "whatsapp" && !row.answeredByClose)
      const otherLeft = wrote.filter((row) => row.channel !== "whatsapp" && !row.answeredByClose)
      return {
        respuesta: whatsapp.length
          ? left.length
            ? `Ayer (${w.dayWords(yesterday)}) ${left.length === 1 ? "1 conversación de WhatsApp se quedó" : `${left.length} conversaciones de WhatsApp se quedaron`} sin responder, de ${plural(whatsapp.length, "conversación", "conversaciones")} en que la persona nos escribió por WhatsApp: ${listOf(left.map((row) => ({ name: row.person, value: `su último mensaje a las ${row.lastIn}` })))}. ${still.length === left.length ? (left.length === 1 ? "Sigue" : "Siguen") : `${still.length} ${still.length === 1 ? "sigue" : "siguen"}`} esperando respuesta hoy.`
            : `Ayer (${w.dayWords(yesterday)}) ninguna conversación de WhatsApp se quedó sin responder: las ${whatsapp.length} en que la persona escribió tuvieron respuesta ese mismo día.`
          : `Ayer (${w.dayWords(yesterday)}) nadie nos escribió por WhatsApp.`,
        criterio: "Conversaciones de WhatsApp (sin Spam ni bloqueados) en que la persona escribió ayer (día de la clínica) y que al cerrar el día no tenían una respuesta aceptada por el canal después de su último mensaje: la regla de «sin respuesta» de la Bandeja, al cierre de ayer.",
        nota: `${spam.length ? `Aparte, ${plural(spam.length, "conversación de Spam o bloqueados quedó", "conversaciones de Spam o bloqueados quedaron")} sin respuesta a propósito y no cuentan. ` : ""}En los otros canales, ayer quedaron sin responder ${otherLeft.length}${otherLeft.length ? `: ${otherLeft.map((row) => `${row.person} por ${channelWords(row.channel)}`).join(", ")}` : ""}.`,
        datos: { dia: yesterday, conversaciones: rows },
      }
    },

    x21: async () => {
      const since = await dayStart(h, monday)
      const lastMonday = w.addDays(monday, -7)
      const lastWeekStart = await dayStart(h, lastMonday)
      const people = (start: string, end: string, channel: string | null) =>
        tx.execute<{ people: number }>(sql`
          select count(distinct c.contact_id)::int as people from message m
          join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
          join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
          where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
            and m.created_at >= ${start}::timestamptz and m.created_at < ${end}::timestamptz
            ${channel ? sql`and cc.channel = ${channel}` : sql``}`)
      const [week] = await people(since, nowIso, "instagram")
      const [lastWeek] = await people(lastWeekStart, since, "instagram")
      const [month] = await people(h.monthStart, nowIso, "instagram")
      const firsts = await h.fig("nos_buscaron", "canal", `${monday}..${todayKey}`)
      const first = firsts.rows.find((row) => row.key === "instagram")
      const [last] = await tx.execute<{ day: string | null; status: string | null }>(sql`
        select to_char(max(${h.dayOf(sql`m.created_at`)}), 'YYYY-MM-DD') as day,
          (select string_agg(distinct x.status, ', ') from channel_connection x where x.organization_id = ${org} and x.channel = 'instagram') as status
        from message m
        join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
        join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'instagram'
        where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))} and m.created_at < ${nowIso}::timestamptz`)
      const byChannel = await tx.execute<{ channel: string; people: number }>(sql`
        select cc.channel, count(distinct c.contact_id)::int as people from message m
        join conversation c on c.organization_id = m.organization_id and c.id = m.conversation_id
        join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
        where m.organization_id = ${org} and m.direction = 'in' and not ${screenedSql(sql.raw("c"))}
          and m.created_at >= ${since}::timestamptz and m.created_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 1`)
      const count = week?.people ?? 0
      return {
        respuesta: count
          ? `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) nos escribieron por Instagram ${plural(count, "persona", "personas")}${first?.value.value ? `; ${first.value.value} por primera vez` : ""}.`
          : `Esta semana (${spanWords(monday, todayKey)}, hasta ahora) nadie nos escribió por Instagram.${last?.day ? ` El último mensaje por Instagram llegó el ${w.dayWords(last.day)}; la semana pasada (${spanWords(lastMonday, w.addDays(monday, -1))}) ${(lastWeek?.people ?? 0) === 1 ? "escribió 1 persona" : `escribieron ${lastWeek?.people ?? 0} personas`} y en lo que va del mes, ${plural(month?.people ?? 0, "persona", "personas")}.` : ""}`,
        criterio: "Personas distintas (sin Spam ni bloqueados) con al menos un mensaje por Instagram esta semana, del lunes a hoy en el día de la clínica.",
        nota: `${last?.status && !/active/.test(last.status) ? "La conexión de Instagram de la clínica está desactivada: mientras siga así, por ese canal no entran mensajes. " : ""}Por primera vez («Nos buscaron por primera vez» de Reportes, canal Instagram, esta semana): ${first?.value.value ?? 0}. Por todos los canales esta semana escribieron: ${listOf(byChannel.map((row) => ({ name: channelWords(row.channel), value: `${row.people}` }))) || "nadie"}.`,
        datos: { semana: count, semanaPasada: lastWeek?.people ?? 0, mes: month?.people ?? 0, primeraVez: first ?? null, ultimoDia: last?.day ?? null, estadoConexion: last?.status ?? null, porCanal: byChannel },
      }
    },
  }
}
