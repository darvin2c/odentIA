/**
 * Las respuestas correctas del examen de Argos (issue 192, fase 0) sobre la
 * base de desarrollo con su semilla. Uso:
 *
 *   pnpm --filter @odentia/agent eval:argos-respuestas [-- --file=eval/argos-examen.json --org=seed-org-dental-smile --json=salida.json --only=f1,f2]
 *
 * Cada pregunta del banco se calcula aquí, sin modelo: con la misma función de
 * Reportes si la cifra ya existe y, si no, con una consulta escrita con las
 * reglas de odentIA (lo cobrado sin lo anulado ni lo devuelto, una opción por
 * presupuesto, el día de la clínica). Lee con el rol de la aplicación y la
 * clínica fijada (RLS); no escribe nada. El periodo que la pregunta no dice
 * es el mes en curso (decisión D7 del lienzo); donde otro criterio cambia la
 * respuesta, la nota lo muestra para que el dueño elija. Las cifras dependen
 * del día en que corrió la semilla: se calculan otra vez antes de cada examen.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createAppDb, withOrgContext } from "@odentia/db"
import {
  agendaMinutes,
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  computeFigure,
  type FigureContext,
  type FigureGroup,
  type FigureResult,
  formatFigure,
  funnelMany,
  getAgendaReport,
  getReportList,
  getReportPromotions,
  listProducts,
  listPromotions,
  reportScope,
} from "@odentia/services"
import { sql } from "drizzle-orm"
import { ownerSolvers } from "./argos-golden/index.js"

interface Question {
  id: string
  texto: string
  espera: "responde" | "trampa"
  debe?: string
}

interface Answer {
  /** La respuesta correcta, como la diría Argos. */
  respuesta: string
  /** Cómo se calculó, en palabras. */
  criterio: string
  /** Otra lectura de la pregunta que da otra cifra: el dueño elige. */
  nota?: string
  datos: Record<string, unknown>
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/argos-examen.json")), "utf8")) as { preguntas: Question[] }
const ORG = arg("org", "seed-org-dental-smile")
const url = process.env.APP_DATABASE_URL
if (!url) throw new Error("Falta APP_DATABASE_URL (el .env de infra/dev)")
const db = createAppDb(url)
const now = new Date()

const answers = await withOrgContext(db, ORG, async (tx) => {
  const scope = await reportScope(tx, ORG, { period: "este_mes" }, now)
  const ctx: FigureContext = { tx, orgId: ORG, scope, billing: true }
  const tz = scope.timezone
  const money = (cents: number | null | undefined): string => formatFigure(cents ?? 0, "money", scope)
  const fig = (figure: string, group: FigureGroup = "total", period = "este_mes"): Promise<FigureResult> =>
    period === "este_mes"
      ? computeFigure(ctx, { figure, group })
      : reportScope(tx, ORG, { period }, now).then((other) => computeFigure({ ...ctx, scope: other }, { figure, group }))
  const show = (result: FigureResult, value = result.total.value): string =>
    value === null ? "sin dato" : formatFigure(value, result.figure.unit, scope)
  const today = sql`(now() at time zone ${tz})::date`
  const dayOf = (column: ReturnType<typeof sql>) => sql`(${column} at time zone ${tz})::date`
  const monthStart = scope.window.start.toISOString()
  const personName = sql`pp.display_name`
  const joinPerson = (patientColumn: ReturnType<typeof sql>) =>
    sql`join patient p on p.organization_id = ${ORG} and p.id = ${patientColumn} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id`
  /** El nombre de lo que se cobró: su servicio, su producto o lo escrito. */
  const conceptName = sql`coalesce(sep.name, spi.name, pr.name, c.description)`
  const conceptJoins = sql`
    left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
    left join service_catalog sep on sep.organization_id = c.organization_id and sep.id = ep.service_id
    left join treatment_plan_item pi on pi.organization_id = c.organization_id and pi.id = c.plan_item_id
    left join service_catalog spi on spi.organization_id = c.organization_id and spi.id = pi.service_id
    left join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id`
  const listOf = (rows: Array<{ name: string; value: string }>): string => rows.map((row) => `${row.name} (${row.value})`).join(", ")

  const solve: Record<string, () => Promise<Answer>> = {
    // --- Preguntas originales del dueño ---------------------------------------------------
    o1: async () => {
      const paid = await tx.execute<{ name: string; kind: string; times: number; cents: string }>(sql`
        with paid as (
          select a.charge_id, sum(a.amount_cents)::bigint as cents
          from patient_payment_application a
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where a.organization_id = ${ORG} and a.voided_at is null and ${dayOf(sql`pay.paid_at`)} = ${today}
          group by a.charge_id)
        select ${conceptName} as name, case when c.product_id is null then 'tratamiento' else 'producto' end as kind,
          sum(coalesce(c.product_quantity, ep.quantity, 1))::int as times, sum(paid.cents)::text as cents
        from paid join patient_charge c on c.organization_id = ${ORG} and c.id = paid.charge_id and c.voided_at is null
        ${conceptJoins}
        group by 1, 2 order by sum(coalesce(c.product_quantity, ep.quantity, 1)) desc, sum(paid.cents) desc, 1`)
      const charged = await tx.execute<{ name: string; times: number; cents: string }>(sql`
        select ${conceptName} as name, sum(coalesce(c.product_quantity, ep.quantity, 1))::int as times, sum(c.amount_cents)::text as cents
        from patient_charge c ${conceptJoins}
        where c.organization_id = ${ORG} and c.voided_at is null and ${dayOf(sql`c.created_at`)} = ${today}
        group by 1 order by sum(coalesce(c.product_quantity, ep.quantity, 1)) desc, sum(c.amount_cents) desc, 1`)
      const top = paid[0]
      return {
        respuesta: top
          ? `Lo que más se vendió hoy fue ${top.name}: ${top.times} ${top.times === 1 ? "vez" : "veces"}, ${money(Number(top.cents))}. Le siguen ${listOf(paid.slice(1, 4).map((row) => ({ name: row.name, value: `${row.times}` })))}.`
          : "Hoy todavía no hay ventas cobradas.",
        criterio: "Tratamientos y productos de los tickets de hoy (día de la clínica), sin anulados ni lo devuelto, ordenados por veces (lienzo, tablero 2).",
        nota: `Contando lo cargado hoy aunque no se haya pagado: ${listOf(charged.slice(0, 4).map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        datos: { pagado: paid, cargado: charged },
      }
    },
    o2: async () => {
      // «Vendido» es lo pagado (criterio 2): los productos de conceptos con pago vigente, del mes en curso (D7).
      const paid = await tx.execute<{ name: string; units: number; cents: string }>(sql`
        select pr.name, sum(c.product_quantity)::int as units, sum(ap.cents)::text as cents
        from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
        join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz) ap on ap.cents > 0
        where c.organization_id = ${ORG} and c.voided_at is null
        group by 1 order by sum(c.product_quantity) desc, sum(ap.cents) desc, 1`)
      const charged = await tx.execute<{ name: string; units: number }>(sql`
        select pr.name, sum(c.product_quantity)::int as units
        from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
        where c.organization_id = ${ORG} and c.voided_at is null and c.created_at >= ${monthStart}::timestamptz
        group by 1 order by 2 desc, 1`)
      const top = paid[0]
      return {
        respuesta: top
          ? `Este mes tu producto más vendido es ${top.name}: ${top.units} ${top.units === 1 ? "vendido y pagado" : "vendidos y pagados"} por ${money(Number(top.cents))}. ${paid.length > 1 ? `Le sigue ${listOf(paid.slice(1, 3).map((row) => ({ name: row.name, value: `${row.units}, ${money(Number(row.cents))}` })))}.` : ""}`
          : "Este mes todavía no se pagó ningún producto.",
        criterio: "Productos (no tratamientos) pagados este mes, sin anulados y descontando lo devuelto; por unidades y después por monto.",
        nota: `Contando lo vendido aunque no se haya pagado: ${listOf(charged.map((row) => ({ name: row.name, value: `${row.units}` })))}.`,
        datos: { pagado: paid, cargado: charged },
      }
    },
    o3: async () => {
      const rows = await tx.execute<{ person: string; name: string; cents: string; owed: string }>(sql`
        select ${personName} as person, ${conceptName} as name, c.amount_cents::text as cents,
          (c.amount_cents - coalesce((select sum(a.amount_cents) from patient_payment_application a where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null), 0))::text as owed
        from patient_charge c ${conceptJoins} ${joinPerson(sql`c.patient_id`)}
        where c.organization_id = ${ORG} and c.voided_at is null and ${dayOf(sql`c.created_at`)} = ${today}
        order by c.amount_cents - coalesce((select sum(a.amount_cents) from patient_payment_application a where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null), 0) desc, 1, 2`)
      const open = rows.filter((row) => Number(row.owed) > 0)
      return {
        respuesta: open.length
          ? `Sí: ${open.length} ${open.length === 1 ? "cobro quedó" : "cobros quedaron"} sin pagar hoy por ${money(open.reduce((sum, row) => sum + Number(row.owed), 0))}: ${listOf(open.slice(0, 5).map((row) => ({ name: `${row.person} · ${row.name}`, value: money(Number(row.owed)) })))}.`
          : "No: todo lo que se cargó hoy está pagado.",
        criterio: "Lo cargado hoy (día de la clínica), sin anulados, con saldo: el importe menos lo que se le aplicó de pagos vigentes.",
        datos: { cargadoHoy: rows.length, sinPagar: open },
      }
    },
    o4: async () => {
      const month = await getReportPromotions(tx, ORG, { period: "este_mes" }, now)
      const year = await getReportPromotions(tx, ORG, { period: "este_ano" }, now)
      const best = (list: typeof month.promotions) => [...list].sort((a, b) => b.collectedCents - a.collectedCents)[0]
      const top = best(month.promotions)
      const topYear = best(year.promotions)
      return {
        respuesta: top
          ? `Por lo cobrado, tu mejor promoción este mes es ${top.name}: ${money(top.collectedCents)} de ${top.people} ${top.people === 1 ? "persona" : "personas"} (${top.fresh} nuevas).`
          : "Este mes ninguna promoción se usó.",
        criterio: "Promociones usadas este mes (presupuestos presentados o cobros con promoción), ordenadas por lo cobrado a quienes la usaron; ofrece también «pacientes nuevos» y «quién volvió».",
        nota: topYear ? `En lo que va del año la mejor es ${topYear.name}: ${money(topYear.collectedCents)} de ${topYear.people} personas.` : undefined,
        datos: { mes: month.promotions, año: year.promotions },
      }
    },
    o5: async () => {
      const live = await listPromotions(tx, ORG, { vigentesOnly: true, at: now })
      const words = live.map((row) => ({
        name: row.name,
        value: row.endsAt ? `termina el ${new Intl.DateTimeFormat(scope.locale, { day: "numeric", month: "long", timeZone: tz }).format(new Date(row.endsAt))}` : "sin fecha de fin",
      }))
      return {
        respuesta: live.length ? `Sí, ${live.length} vigentes: ${listOf(words)}.` : "No tienes promociones vigentes.",
        criterio: "Promociones activas con hoy dentro de su inicio y su fin, como Servicios › Promociones.",
        datos: { vigentes: words },
      }
    },

    // --- Del catálogo: se pueden responder ------------------------------------------------
    c3: async () => {
      const result = await fig("cobrado")
      return {
        respuesta: `Este mes cobraste ${show(result)}.`,
        criterio: "Lo cobrado de Reportes: pagos del mes hasta hoy menos lo anulado y lo devuelto en el mes.",
        datos: { total: result.total },
      }
    },
    c4: async () => {
      const result = await fig("cobrado")
      const value = result.total.value ?? 0
      const before = result.previous?.value ?? 0
      return {
        respuesta: `Este mes cobraste ${show(result)}; en los mismos días del mes anterior, ${show(result, before)}: ${value >= before ? `${money(value - before)} más` : `${money(before - value)} menos`}.`,
        criterio: "Lo cobrado del mes en curso contra los mismos días del mes anterior (la comparación de Reportes).",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    c5: async () => {
      const result = await fig("cobrado", "mes")
      const full = result.months.filter((month) => !month.partial && month.value.value !== null)
      const sorted = [...full].sort((a, b) => (b.value.value ?? 0) - (a.value.value ?? 0))
      const name = (month: (typeof full)[number]) =>
        new Intl.DateTimeFormat(scope.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.month.year, month.month.month - 1, 15)))
      const high = sorted[0]
      const low = sorted[sorted.length - 1]
      return {
        respuesta:
          high && low
            ? `odentIA no emite facturas, solo tickets de pago. Por lo cobrado, en los últimos 12 meses el mejor mes fue ${name(high)} (${show(result, high.value.value)}) y el más bajo ${name(low)} (${show(result, low.value.value)}).`
            : "No hay meses completos para comparar.",
        criterio: "Lo cobrado por mes de los últimos 12 meses completos (el mes en curso no entra), en lugar de «facturación».",
        datos: { meses: result.months },
      }
    },
    c11: async () => {
      const result = await fig("lo_que_deja")
      return {
        respuesta: `Este mes la clínica se quedó con ${show(result)}: lo cobrado menos comisiones y gastos registrados. Puede faltar algún gasto que no se anotó.`,
        criterio: "«Lo que deja el mes» de Reportes › Finanzas: cobrado − comisiones generadas − gastos registrados.",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    c22: async () => {
      const result = await fig("pacientes_nuevos")
      return {
        respuesta: `Este mes llegaron ${show(result)} pacientes nuevos (en los mismos días del mes anterior, ${show(result, result.previous?.value ?? null)}).`,
        criterio: "Pacientes cuya primera cita atendida cae en el mes, como Reportes › Pacientes.",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    c23: async () => {
      const result = await fig("sin_venir")
      return {
        respuesta: `${show(result)} pacientes dejaron de venir: su última cita atendida fue hace más de 6 meses y no tienen cita, presupuesto ni control pendiente.`,
        criterio: "«Sin venir hace más de 6 meses» de Reportes, a hoy.",
        datos: { total: result.total },
      }
    },
    c27: async () => {
      const top = (since: string) =>
        tx.execute<{ person: string; visits: number }>(sql`
          select ${personName} as person, count(*)::int as visits from appointment a ${joinPerson(sql`a.patient_id`)}
          where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${since}::timestamptz and a.starts_at < ${now.toISOString()}::timestamptz
          group by a.patient_id, pp.display_name order by 2 desc, 1 limit 5`)
      const year = await top(new Date(now.getTime() - 365 * 86_400_000).toISOString())
      const month = await top(monthStart)
      return {
        respuesta: `En los últimos 12 meses, tus pacientes más frecuentes son ${listOf(year.map((row) => ({ name: row.person, value: `${row.visits} citas` })))}.`,
        criterio: "Citas atendidas por paciente en los últimos 12 meses, de más a menos.",
        nota: `Con el mes en curso (D7) casi todos tienen 1 o 2 citas: ${listOf(month.map((row) => ({ name: row.person, value: `${row.visits}` })))}. Propongo que «frecuentes» mire 12 meses.`,
        datos: { doceMeses: year, mes: month },
      }
    },
    c29: async () => {
      const [row] = await tx.execute<{ all: number; unbooked: number }>(sql`
        with last as (
          select a.patient_id, max(a.starts_at) as at from appointment a
          join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
          join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active and pp.screen is null
          where a.organization_id = ${ORG} and a.status = 'atendida' group by 1)
        select count(*) filter (where at < now() - interval '90 days')::int as all,
          count(*) filter (where at < now() - interval '90 days' and not exists (
            select 1 from appointment n where n.organization_id = ${ORG} and n.patient_id = last.patient_id
              and n.starts_at > now() and n.status in ('programada','confirmada')))::int as unbooked
        from last`)
      return {
        respuesta: `${row?.all ?? 0} pacientes no han vuelto en los últimos 90 días; de ellos, ${row?.unbooked ?? 0} no tienen cita por venir.`,
        criterio: "Pacientes no archivados (ni spam) con al menos una cita atendida cuya última fue hace más de 90 días.",
        datos: { row },
      }
    },
    c31: async () => {
      const rows = await tx.execute<{ branch: string; status: string; total: number }>(sql`
        select b.name as branch, a.status, count(*)::int as total from appointment a
        join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
        where a.organization_id = ${ORG} and ${dayOf(sql`a.starts_at`)} = ${today} + 1 and a.status in ('programada','confirmada')
        group by 1, 2 order by 1, 2`)
      const total = rows.reduce((sum, row) => sum + row.total, 0)
      const confirmed = rows.filter((row) => row.status === "confirmada").reduce((sum, row) => sum + row.total, 0)
      return {
        respuesta: `Mañana tienes ${total} citas, ${confirmed} ya confirmadas.`,
        criterio: "Citas de mañana (día de la clínica) programadas o confirmadas, todas las sedes.",
        datos: { porSede: rows },
      }
    },
    c34: async () => {
      const result = await fig("no_vinieron")
      return {
        respuesta: `Este mes no vino el ${show(result)} de las citas (${result.total.part ?? 0} de ${result.total.whole ?? 0}); en los mismos días del mes anterior, ${show(result, result.previous?.value ?? null)}.`,
        criterio: "«No vinieron» de Reportes: citas en que el paciente no vino ÷ citas que ya pasaron.",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    c35: async () => {
      const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
      const byDay = (since: string) =>
        tx.execute<{ day: number; total: number }>(sql`
          select extract(dow from a.starts_at at time zone ${tz})::int as day, count(*)::int as total from appointment a
          where a.organization_id = ${ORG} and a.status <> 'cancelada' and a.starts_at >= ${since}::timestamptz and a.starts_at < ${now.toISOString()}::timestamptz
          group by 1 order by 2 desc`)
      const month = await byDay(monthStart)
      const year = await byDay(new Date(now.getTime() - 365 * 86_400_000).toISOString())
      const words = (rows: typeof month) => listOf(rows.slice(0, 3).map((row) => ({ name: days[row.day] ?? "", value: `${row.total}` })))
      return {
        respuesta: `Este mes los días con más citas son ${words(month)}.`,
        criterio: "Citas no canceladas del mes en curso por día de la semana (día de la clínica).",
        nota: `En los últimos 12 meses: ${words(year)}.`,
        datos: { mes: month, doceMeses: year },
      }
    },
    c37: async () => {
      const result = await fig("agenda_ocupada", "profesional")
      return {
        respuesta: `Este mes las agendas más ocupadas son ${listOf(result.rows.slice(0, 4).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        criterio: "«Agenda ocupada» de Reportes por profesional: minutos con cita ÷ minutos de su horario.",
        datos: { filas: result.rows },
      }
    },
    c41: async () => {
      const rows = await tx.execute<{ name: string; times: number }>(sql`
        select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada'
        left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${ORG} and ep.voided_at is null and e.started_at >= ${monthStart}::timestamptz
        group by 1 order by 2 desc, 1 limit 10`)
      return {
        respuesta: `Este mes, los tratamientos más realizados son: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        criterio: "Procedimientos no anulados de atenciones firmadas del mes en curso, por tratamiento (contando la cantidad).",
        datos: { filas: rows },
      }
    },
    c43: async () => {
      const [row] = await tx.execute<{ times: number; services: string }>(sql`
        select coalesce(sum(ep.quantity), 0)::int as times, string_agg(distinct s.name, ', ') as services
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada'
        join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        left join treatment_template t on t.id = s.template_id
        where ep.organization_id = ${ORG} and ep.voided_at is null and e.started_at >= ${monthStart}::timestamptz
          and (t.specialty = 'endodoncia' or s.code ilike 'ENDODONCIA%')`)
      return {
        respuesta: `Este mes se hicieron ${row?.times ?? 0} endodoncias.`,
        criterio: `Procedimientos de endodoncia (tipo de la biblioteca o el servicio ENDODONCIA) de atenciones firmadas del mes: ${row?.services ?? "ninguno"}.`,
        datos: { row },
      }
    },
    c48: async () => {
      const result = await fig("aceptaron")
      return {
        respuesta: `Este mes se aceptó el ${show(result)} de lo presupuestado (${result.total.part ?? 0} de ${result.total.whole ?? 0} ${result.figure.noun?.many ?? ""}).`,
        criterio: "«Aceptaron su presupuesto» de Reportes: lo aceptado en los presupuestos presentados en el mes.",
        datos: { total: result.total, anterior: result.previous, figura: result.figure.how },
      }
    },
    c51: async () => {
      const result = await fig("cobrado", "profesional")
      const top = result.rows[0]
      return {
        respuesta: top ? `Este mes quien más generó fue ${top.label}: ${show(result, top.value.value)} cobrados de lo que atendió.` : "Este mes no hay cobros por profesional.",
        criterio: "Lo cobrado por profesional de Reportes: lo pagado de lo que atendió cada uno (la base de las comisiones).",
        datos: { filas: result.rows },
      }
    },
    c63: async () => {
      const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
      const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
      const [row] = await tx.execute<{ budgets: number; cents: string }>(sql`
        select count(distinct b.id)::int as budgets, coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents
        from treatment_budget b
        join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
          and i.option_id = ${budgetValueOptionSql(budget)} and i.decision in ('pendiente','pospuesto') and i.price_cents is not null
        where b.organization_id = ${ORG} and ${budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })}`)
      return {
        respuesta: `Hay ${row?.budgets ?? 0} presupuestos esperando respuesta por ${money(Number(row?.cents ?? 0))}.`,
        criterio: "Presupuestos que esperan respuesta (enviados o «lo está pensando»), sumando solo la opción que vale y lo aún no decidido.",
        nota: "«Sin aceptar» también podría incluir lo rechazado; aquí no se cuenta.",
        datos: { row },
      }
    },
    c64: async () => {
      const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
      const rows = await tx.execute<{ person: string; number: number; presented: string; total: number }>(sql`
        select ${personName} as person, b.budget_number as number, to_char(b.presented_at at time zone ${tz}, 'DD/MM/YYYY') as presented, count(*) over()::int as total
        from treatment_budget b ${joinPerson(sql`b.patient_id`)}
        where b.organization_id = ${ORG} and ${budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })}
          and exists (select 1 from treatment_budget_item i where i.organization_id = b.organization_id and i.budget_id = b.id and i.option_id = ${budgetValueOptionSql(budget)})
        order by b.presented_at asc limit 5`)
      return {
        respuesta: `${rows[0]?.total ?? 0} presupuestos esperan respuesta. Los más antiguos: ${listOf(rows.map((row) => ({ name: `${row.person} (N.º ${row.number})`, value: `desde ${row.presented}` })))}.`,
        criterio: "La regla «espera respuesta» de odentIA (budgetAwaitsAnswer), a hoy, ordenados del más antiguo.",
        datos: { filas: rows },
      }
    },
    c69: async () => {
      const result = await fig("te_deben")
      const lists = await Promise.all(
        (["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus"] as const).map((list) =>
          getReportList(tx, ORG, { period: "este_mes", list, limit: 200 }, now),
        ),
      )
      const rows = lists.flatMap((list) => list.rows).sort((a, b) => (b.cents ?? 0) - (a.cents ?? 0))
      return {
        respuesta: `${rows.length} pacientes te deben ${show(result)} en total. Los que más deben: ${listOf(rows.slice(0, 5).map((row) => ({ name: row.personName, value: money(row.cents) })))}.`,
        criterio: "«Te deben» de Reportes › Finanzas (saldo descontando lo que tienen a favor), con sus listas por antigüedad.",
        datos: { total: result.total, primeros: rows.slice(0, 10) },
      }
    },
    c70: async () => {
      const result = await fig("deuda_vencida")
      return {
        respuesta: `Tienes ${show(result)} vencidos: deudas de más de 30 días.`,
        criterio: "«Te deben hace más de 30 días» de Reportes, a hoy.",
        datos: { total: result.total },
      }
    },
    c77: async () => {
      const result = await fig("como_nos_conocieron")
      return {
        respuesta: `Este mes tus pacientes nuevos llegaron por ${listOf(result.rows.slice(0, 4).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        criterio: "«Cómo nos conocieron» de Reportes › Pacientes, del mes en curso.",
        datos: { filas: result.rows, como: result.figure.how },
      }
    },
    c83: async () => {
      const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${ORG} and is_active order by name`)
      const found: Array<{ branch: string; name: string; onHand: number; min: number; state: string }> = []
      for (const branch of branches) {
        const list = await listProducts(tx, ORG, { branchId: branch.id, need: "hacen_falta", now })
        for (const item of list.items) found.push({ branch: branch.name, name: item.name, onHand: item.onHand, min: item.minQuantity, state: item.state })
      }
      return {
        respuesta: found.length
          ? `Hacen falta ${found.length}: ${listOf(
              found.map((row) => ({
                name: `${row.name} en ${row.branch}`,
                value: row.onHand < 0 ? `se usaron ${-row.onHand} sin haber, mínimo ${row.min}` : `hay ${row.onHand}, mínimo ${row.min}`,
              })),
            )}.`
          : "Ningún material está por debajo de su mínimo.",
        criterio: "Productos de cada sede con «Hacen falta» de Inventario: por debajo de su mínimo, sin existencias o con faltante.",
        datos: { filas: found },
      }
    },
    c91: async () => {
      const result = await fig("espera_en_sala")
      return {
        respuesta: `Este mes los pacientes esperan ${show(result)} en sala (mediana entre la llegada y el inicio de la atención).`,
        criterio: "«Espera en sala» de Reportes: mediana de minutos entre «Llegó» y el inicio de la atención.",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    c95: async () => {
      const result = await fig("cobrado", "sede")
      const top = result.rows[0]
      return {
        respuesta: top ? `Este mes la sede que más genera es ${top.label}: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.` : "Sin cobros este mes.",
        criterio: "Lo cobrado por sede de Reportes, del mes en curso.",
        datos: { filas: result.rows },
      }
    },

    // --- Trampas: lo correcto es decir qué falta y ofrecer lo más parecido ----------------
    c2: async () => {
      const result = await fig("cobrado")
      const [row] = await tx.execute<{ tickets: number }>(sql`
        select count(*)::int as tickets from payment_ticket
        where organization_id = ${ORG} and voided_at is null and created_at >= ${monthStart}::timestamptz`)
      return {
        respuesta: `odentIA no emite facturas, solo tickets de pago. Lo que suman los tickets de este mes, sin lo anulado ni lo devuelto: ${show(result)}.`,
        criterio: "Trampa: se responde con lo cobrado del mes (lo que suman los tickets), nunca con «facturado».",
        nota: `La historia de prueba guarda los pagos sin su ticket: solo hay ${row?.tickets ?? 0} tickets este mes (los de la demostración). Contar tickets daría otra cifra; contar lo cobrado no.`,
        datos: { total: result.total, ticketsGuardados: row?.tickets ?? 0 },
      }
    },
    c75: async () => {
      const owed = await fig("te_deben")
      const coming = await fig("lo_que_viene")
      return {
        respuesta: `odentIA no maneja cuotas ni financiamiento. Lo más parecido: te deben ${show(owed)} y hay ${show(coming)} en tratamientos aceptados que faltan hacer.`,
        criterio: "Trampa: no hay planes de cuotas. Se ofrece «Te deben» y «Lo que viene».",
        datos: { teDeben: owed.total, loQueViene: coming.total },
      }
    },
    c81: async () => {
      const result = await fig("como_nos_conocieron")
      return {
        respuesta: `No lo sé: odentIA no guarda lo que gastas en publicidad. Lo que sí tengo: este mes los pacientes nuevos llegaron por ${listOf(result.rows.slice(0, 3).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        criterio: "Trampa: sin gasto de publicidad no hay costo por paciente. Se ofrece «Cómo nos conocieron».",
        datos: { filas: result.rows },
      }
    },
    c89: async () => ({
      respuesta: "odentIA no tiene encuestas de satisfacción, así que no puedo medirla.",
      criterio: "Trampa: no hay ningún dato de satisfacción ni de recomendación.",
      datos: {},
    }),
    c13: async () => {
      const result = await fig("cobrado", "tratamiento")
      const commissions = await fig("comisiones")
      return {
        respuesta: `Te doy una parte: por lo cobrado este mes van primero ${listOf(result.rows.slice(0, 3).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}. Faltan el laboratorio y los gastos generales, que no se ligan a cada tratamiento, así que no es la utilidad.`,
        criterio: "Trampa a medias: lo cobrado por tratamiento; las comisiones del mes son de toda la clínica y los materiales solo se conocen en algunos servicios.",
        nota: `Comisiones del mes (de toda la clínica): ${show(commissions)}.`,
        datos: { filas: result.rows, comisiones: commissions.total },
      }
    },
    c39: async () => {
      const result = await fig("canceladas")
      return {
        respuesta: `odentIA no guarda una marca de «reprogramada». Lo que sí tengo: este mes se cancelaron ${result.total.part ?? 0} citas, el ${show(result)} de ${result.total.whole ?? 0}.`,
        criterio: "Trampa a medias: mover una cita no deja marca propia. Se ofrece «Canceladas».",
        datos: { total: result.total },
      }
    },
    c79: async () => {
      const month = await getReportPromotions(tx, ORG, { period: "este_mes" }, now)
      const referral = await fig("como_nos_conocieron")
      return {
        respuesta: `odentIA no tiene campañas. Lo más parecido: este mes las promociones llegaron a ${listOf(month.promotions.slice(0, 3).map((row) => ({ name: row.name, value: `${row.people} ${row.people === 1 ? "persona" : "personas"}` })))}, y los nuevos llegaron sobre todo por ${referral.rows[0]?.label ?? "—"}.`,
        criterio: "Trampa a medias: sin campañas. Se ofrecen las promociones del mes y «Cómo nos conocieron».",
        datos: { promociones: month.promotions, comoNosConocieron: referral.rows },
      }
    },
  }

  // --- Reserva (eval/argos-reserva.json): preguntas que ningún ajuste vio ------------------
  Object.assign(solve, {
    r7: async () => {
      const [row] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
        where c.organization_id = ${ORG} and c.voided_at is null and c.product_id is null and c.created_at >= ${monthStart}::timestamptz`)
      const average = row && row.count > 0 ? Number(row.cents) / row.count : 0
      return {
        respuesta: `Este mes el ticket promedio por tratamiento es ${money(Math.round(average))} (${row?.count ?? 0} tratamientos cargados por ${money(Number(row?.cents ?? 0))}).`,
        criterio: "Lo cargado por tratamientos del mes (sin productos ni anulados) ÷ cuántos tratamientos.",
        nota: "Otra lectura: el promedio por tipo de tratamiento.",
        datos: { row },
      }
    },
    r14: async () => {
      // Por tratamiento sin agrupar «Otros»: lo pagado este mes de cada uno.
      const low = await tx.execute<{ name: string; cents: string }>(sql`
        select ${conceptName} as name, sum(a.amount_cents)::text as cents
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null and c.product_id is null
        ${conceptJoins}
        where a.organization_id = ${ORG} and a.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz
        group by 1 order by sum(a.amount_cents), 1 limit 3`)
      return {
        respuesta: `No puedo saber la rentabilidad por tratamiento: faltan el laboratorio y los gastos de cada uno. Lo que sí tengo: este mes, lo que menos cobró fue ${listOf(low.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}.`,
        criterio: "Trampa a medias: sin costos por tratamiento no hay rentabilidad. Se ofrece lo cobrado por tratamiento este mes, de menos a más.",
        datos: { filas: low },
      }
    },
    r19: async () => {
      const spent = await fig("gastos")
      const commissions = await fig("comisiones")
      return {
        respuesta: `odentIA no emite facturas y solo conoce los gastos que registras y las comisiones. Este mes van ${show(spent)} de gastos y ${show(commissions)} de comisiones: cobrar al menos ${show(spent, (spent.total.value ?? 0) + (commissions.total.value ?? 0))} cubriría lo registrado, sin contar lo que no se anotó.`,
        criterio: "Trampa a medias: no hay costos fijos ni facturas. Se ofrece gastos registrados + comisiones del mes como referencia.",
        datos: { gastos: spent.total, comisiones: commissions.total },
      }
    },
    r26: async () => {
      const [row] = await tx.execute<{ median: string | null; average: string | null; gaps: number }>(sql`
        with v as (
          select a.patient_id, a.starts_at, lag(a.starts_at) over (partition by a.patient_id order by a.starts_at) as prev
          from appointment a where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= now() - interval '365 days' and a.starts_at < now())
        select percentile_cont(0.5) within group (order by extract(epoch from starts_at - prev) / 86400)::text as median,
          avg(extract(epoch from starts_at - prev) / 86400)::text as average, count(*)::int as gaps
        from v where prev is not null`)
      return {
        respuesta: `En los últimos 12 meses, entre una visita y la siguiente pasan ${Math.round(Number(row?.median ?? 0))} días (mediana); en promedio, ${Math.round(Number(row?.average ?? 0))} días.`,
        criterio: "Días entre citas atendidas seguidas de cada paciente, últimos 12 meses (frecuencia: 12 meses, criterio 3).",
        datos: { row },
      }
    },
    r36: async () => {
      const report = await getAgendaReport(tx, ORG, { period: "este_mes" }, now)
      const free = new Map<string, number>()
      for (const slot of report.map.week) {
        const key = `${slot.weekday}|${slot.hour}`
        free.set(key, (free.get(key) ?? 0) + Math.max(0, slot.availMin - slot.occMin))
      }
      const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"]
      const top = [...free.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      return {
        respuesta: `Este mes los horarios con más espacio libre son ${listOf(
          top.map(([key, minutes]) => {
            const [weekday, hour] = key.split("|").map(Number) as [number, number]
            return { name: `${days[weekday]} a las ${hour}:00`, value: `${Math.round(minutes / 60)} h libres` }
          }),
        )}.`,
        criterio: "Semana tipo de Reportes › Agenda: minutos de horario menos minutos con cita, por día de la semana y hora, del mes en curso.",
        datos: { top },
      }
    },
    r45: async () => {
      const [row] = await tx.execute<{ plans: number; items: number }>(sql`
        with accepted as (
          select pi.plan_id, pi.status, pi.started_at from treatment_plan_item pi
          where pi.organization_id = ${ORG} and pi.decision_status = 'aceptado' and pi.status not in ('cancelado','reemplazado'))
        select (select count(*) from (select plan_id from accepted group by plan_id
            having bool_and(started_at is null and status in ('pendiente','programado'))) x)::int as plans,
          (select count(*) from accepted where started_at is null and status in ('pendiente','programado'))::int as items`)
      return {
        respuesta: `${row?.plans ?? 0} planes de tratamiento tienen tratamientos aceptados y ninguno empezado (${row?.items ?? 0} tratamientos aceptados sin empezar en total).`,
        criterio: "Planes con al menos un tratamiento aceptado y ninguno empezado, a hoy.",
        datos: { row },
      }
    },
    r52: async () => {
      const rows = await tx.execute<{ name: string; patients: number }>(sql`
        select u.name, count(distinct a.patient_id)::int as patients from appointment a join "user" u on u.id = a.dentist_user_id
        where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < now()
        group by 1 order by 2 desc, 1`)
      return {
        respuesta: `Este mes: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.patients} pacientes` })))}.`,
        criterio: "Pacientes distintos con una cita atendida en el mes, por profesional.",
        datos: { filas: rows },
      }
    },
    r57: async () => {
      const result = await fig("cobrado", "profesional")
      const total = result.rows.reduce((sum, row) => sum + (row.value.value ?? 0), 0)
      return {
        respuesta: `Este mes lo cobrado se reparte así: ${listOf(result.rows.map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${total ? Math.round(((row.value.value ?? 0) / total) * 100) : 0} %` })))}.`,
        criterio: "Lo cobrado por profesional de Reportes (de lo que atendió cada uno), con su parte del total atribuido.",
        datos: { filas: result.rows },
      }
    },
    r62: async () => {
      const result = await fig("aceptaron")
      return {
        respuesta: `Este mes se aceptó el ${show(result)} de los presupuestos (${result.total.part ?? 0} de ${result.total.whole ?? 0}).`,
        criterio: "«Aceptaron su presupuesto» de Reportes, del mes en curso.",
        datos: { total: result.total },
      }
    },
    r71: async () => {
      const lists = await Promise.all(
        (["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus"] as const).map((list) =>
          getReportList(tx, ORG, { period: "este_mes", list, limit: 200 }, now),
        ),
      )
      const rows = lists.flatMap((list) => list.rows).sort((a, b) => a.at.localeCompare(b.at))
      const day = (iso: string) => new Intl.DateTimeFormat(scope.locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: tz }).format(new Date(iso))
      return {
        respuesta: `Las deudas más antiguas son de ${listOf(rows.slice(0, 5).map((row) => ({ name: row.personName, value: `${money(row.cents)} desde el ${day(row.at)}` })))}.`,
        criterio: "Listas de «Te deben» por antigüedad, ordenadas por el cargo sin pagar más antiguo, a hoy.",
        datos: { primeras: rows.slice(0, 10) },
      }
    },
    r78: async () => {
      const result = await fig("como_nos_conocieron")
      const row = result.rows.find((item) => item.key === "recomendacion" || /recomend/i.test(item.label))
      return {
        respuesta: `Este mes llegaron ${row?.value.value ?? 0} pacientes nuevos por recomendación${row?.value.whole ? ` (de ${row.value.whole})` : ""}.`,
        criterio: "Pacientes nuevos del mes con «Cómo nos conoció» = recomendación.",
        datos: { filas: result.rows },
      }
    },
    r86: async () => {
      const branches = await tx.execute<{ id: string; name: string }>(sql`select id, name from branch where organization_id = ${ORG} and is_active order by name`)
      const found: Array<{ name: string; branch: string; quantity: number; date: string }> = []
      for (const branch of branches) {
        const list = await listProducts(tx, ORG, { branchId: branch.id, need: "por_vencer", now })
        for (const item of list.items) if (item.expiring) found.push({ name: item.name, branch: branch.name, quantity: item.expiring.quantity, date: item.expiring.date })
      }
      return {
        respuesta: found.length
          ? `Vencen en los próximos 30 días: ${listOf(found.map((row) => ({ name: `${row.name} en ${row.branch}`, value: `${row.quantity} el ${row.date}` })))}.`
          : "Ningún producto vence en los próximos 30 días.",
        criterio: "«Por vencer» de Inventario: lotes que vencen en 30 días o menos (lo ya vencido va aparte).",
        datos: { filas: found },
      }
    },
    r93: async () => ({
      respuesta: "odentIA no pregunta a los pacientes si recomendarían la clínica, así que no tengo ese porcentaje.",
      criterio: "Trampa: no hay encuestas ni NPS.",
      datos: {},
    }),
    r99: async () => {
      const result = await fig("agenda_ocupada", "sede")
      return {
        respuesta: `Este mes la mejor ocupación es de ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        criterio: "«Agenda ocupada» de Reportes por sede, del mes en curso.",
        datos: { filas: result.rows },
      }
    },
  } satisfies Record<string, () => Promise<Answer>>)

  // --- Medición final (eval/argos-holdout.json): las 55 que ningún ajuste vio -------------
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const monthName = (month: { year: number; month: number }): string =>
    new Intl.DateTimeFormat(scope.locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 15)))
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  const nowIso = now.toISOString()
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString()
  const hoursOf = (minutes: number): string => `${(Math.round((minutes / 60) * 10) / 10).toLocaleString(scope.locale)} h`
  const sumOf = (list: Array<{ value: { value: number | null } }>): number => list.reduce((total, item) => total + (item.value.value ?? 0), 0)
  /** «Cómo nos conoció» con las palabras del registro (la lista fija de `REFERRAL_KINDS`). */
  const referralWords = sql`case p.referral_kind when 'recomendacion' then 'Recomendación de alguien' when 'redes_sociales' then 'Redes sociales'
    when 'google_mapas' then 'Google o mapas' when 'paso_por_aqui' then 'Pasaba por aquí' when 'convenio' then 'Convenio o empresa'
    when 'otro' then 'Otro' else 'No lo dijo' end`
  /** Lo que pagó una persona hasta hoy: pagos vigentes menos lo devuelto de ellos. */
  const paidByPatient = (patientColumn: ReturnType<typeof sql>) => sql`(
    coalesce((select sum(pay.amount_cents) from patient_payment pay where pay.organization_id = ${ORG} and pay.patient_id = ${patientColumn} and pay.voided_at is null), 0)
    - coalesce((select sum(r.amount_cents) from patient_payment_refund r
        join patient_payment pay on pay.organization_id = r.organization_id and pay.id = r.payment_id and pay.voided_at is null
        where r.organization_id = ${ORG} and r.patient_id = ${patientColumn}), 0))`
  const consumed = (since: string) => sql`m.organization_id = ${ORG} and m.kind = 'consumo' and m.created_at >= ${since}::timestamptz and m.created_at < ${nowIso}::timestamptz`
  const done = sql`join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada'`
  const specialtyJoins = sql`
    left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
    left join org_specialty os on os.organization_id = s.organization_id and os.id = s.specialty_id`
  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })

  Object.assign(solve, {
    r1: async () => {
      const result = await fig("cobrado", "total", `${todayKey}..${todayKey}`)
      const [charged] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
        where c.organization_id = ${ORG} and c.voided_at is null and ${dayOf(sql`c.created_at`)} = ${today}`)
      return {
        respuesta: `Hoy la clínica cobró ${show(result)}.`,
        criterio: "Lo cobrado de hoy (día de la clínica): pagos de hoy menos lo anulado y lo devuelto hoy.",
        nota: `Lo cargado hoy, pagado o no: ${money(Number(charged?.cents ?? 0))} en ${charged?.count ?? 0} tratamientos y productos.`,
        datos: { total: result.total, cargado: charged },
      }
    },
    r6: async () => {
      const result = await fig("cobrado")
      const lifetime = await fig("valor_paciente")
      const [row] = await tx.execute<{ payers: number; attended: number }>(sql`
        select (select count(distinct pay.patient_id) from patient_payment pay where pay.organization_id = ${ORG} and pay.voided_at is null
            and pay.paid_at >= ${monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz)::int as payers,
          (select count(distinct a.patient_id) from appointment a where a.organization_id = ${ORG} and a.status = 'atendida'
            and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz)::int as attended`)
      const value = result.total.value ?? 0
      return {
        respuesta: `Este mes cada paciente que pagó dejó en promedio ${money(row?.payers ? value / row.payers : 0)}: ${show(result)} cobrados de ${row?.payers ?? 0} pacientes.`,
        criterio: "Lo cobrado del mes ÷ pacientes distintos con un pago vigente en el mes.",
        nota: `Entre los ${row?.attended ?? 0} pacientes atendidos del mes: ${money(row?.attended ? value / row.attended : 0)}. El «valor de un paciente» de Reportes (lo que pagan los nuevos en sus primeros 6 meses) es ${show(lifetime)}.`,
        datos: { total: result.total, row, valorPaciente: lifetime.total },
      }
    },
    r8: async () => {
      const owed = await fig("te_deben")
      const coming = await fig("lo_que_viene")
      return {
        respuesta: `Hoy te deben ${show(owed)}: lo cargado a los pacientes que aún no pagan, descontando lo que tienen a favor.`,
        criterio: "«Te deben» de Reportes › Finanzas, a hoy.",
        nota: `Lo aceptado en presupuestos que falta hacer (aún no cargado) suma otros ${show(coming)}.`,
        datos: { teDeben: owed.total, loQueViene: coming.total },
      }
    },
    r9: async () => {
      const result = await fig("cobrado", "total", "este_ano")
      const year = await reportScope(tx, ORG, { period: "este_ano" }, now)
      const [charged] = await tx.execute<{ cents: string }>(sql`
        select coalesce(sum(c.amount_cents), 0)::text as cents from patient_charge c
        where c.organization_id = ${ORG} and c.voided_at is null and c.created_at >= ${year.window.start.toISOString()}::timestamptz`)
      return {
        respuesta: `odentIA no emite facturas, solo tickets de pago. En lo que va del año se cobró ${show(result)}, sin lo anulado ni lo devuelto.`,
        criterio: "Trampa: «facturado» se responde con lo cobrado del año (lo que suman los tickets), nunca con «facturado».",
        nota: `Lo cargado a los pacientes en el año (tratamientos y productos, pagados o no): ${money(Number(charged?.cents ?? 0))}.`,
        datos: { total: result.total, cargado: charged },
      }
    },
    r10: async () => {
      const result = await fig("cobrado", "mes")
      const current = await fig("cobrado")
      const full = result.months.filter((month) => !month.partial && month.value.value !== null)
      const last = full.slice(-3)
      const before = full.slice(-6, -3)
      const recent = sumOf(last)
      const earlier = sumOf(before)
      const change = earlier > 0 ? Math.round(((recent - earlier) / earlier) * 100) : null
      return {
        respuesta: `${recent >= earlier ? "Estás creciendo" : "Estás bajando"}: en los últimos 3 meses completos (${last.map((month) => monthName(month.month)).join(", ")}) cobraste ${money(recent)}; en los 3 anteriores, ${money(earlier)}${change !== null ? ` (${change > 0 ? "+" : ""}${change} %)` : ""}.`,
        criterio: "Lo cobrado de los últimos 3 meses completos contra los 3 anteriores (el mes en curso, incompleto, no entra).",
        nota: `Mes a mes: ${listOf(full.slice(-6).map((month) => ({ name: monthName(month.month), value: show(result, month.value.value) })))}. El mes en curso va ${show(current)} contra ${show(current, current.previous?.value ?? null)} en los mismos días del mes anterior.`,
        datos: { meses: result.months },
      }
    },
    r12: async () => {
      const collected = await fig("cobrado")
      const leaves = await fig("lo_que_deja")
      const lastCollected = await fig("cobrado", "total", "mes_pasado")
      const lastLeaves = await fig("lo_que_deja", "total", "mes_pasado")
      return {
        respuesta: `Este mes el margen es del ${pct(leaves.total.value ?? 0, collected.total.value ?? 0)}: de ${show(collected)} cobrados quedaron ${show(leaves)} después de comisiones y gastos registrados. Puede faltar algún gasto que no se anotó.`,
        criterio: "«Lo que deja el mes» ÷ lo cobrado del mes, con las cifras de Reportes › Finanzas.",
        nota: `El mes pasado (completo): ${pct(lastLeaves.total.value ?? 0, lastCollected.total.value ?? 0)} (${show(lastLeaves)} de ${show(lastCollected)}).`,
        datos: { cobrado: collected.total, deja: leaves.total, mesPasado: { cobrado: lastCollected.total, deja: lastLeaves.total } },
      }
    },
    r15: async () => {
      const collected = await fig("cobrado", "profesional")
      const commissions = await fig("comisiones", "profesional")
      const rows = collected.rows
        .map((row) => {
          const commission = commissions.rows.find((item) => item.key === row.key || item.label === row.label)?.value.value ?? 0
          return { name: row.label, collected: row.value.value ?? 0, commission, net: (row.value.value ?? 0) - commission }
        })
        .sort((a, b) => b.net - a.net)
      return {
        respuesta: `No puedo saber la rentabilidad de cada odontólogo: los gastos y el laboratorio no se ligan a quien atiende. Lo más cercano, este mes: lo cobrado de lo que atendió menos su comisión, ${listOf(rows.slice(0, 4).map((row) => ({ name: row.name, value: money(row.net) })))}.`,
        criterio: "Trampa a medias: lo cobrado por profesional (la base de las comisiones) menos su comisión del mes.",
        datos: { filas: rows },
      }
    },
    r16: async () => {
      const spent = await fig("gastos", "categoria")
      const materials = spent.rows.find((row) => /material/i.test(row.label))
      const [used] = await tx.execute<{ units: number; products: number; encounters: number }>(sql`
        select coalesce(sum(-m.quantity_delta), 0)::int as units, count(distinct m.product_id)::int as products, count(distinct m.encounter_id)::int as encounters
        from stock_movement m where ${consumed(monthStart)}`)
      return {
        respuesta: `No lo sé por tratamiento: los materiales se descuentan por atención y no por cada tratamiento, y el lote no guarda lo que costó. Lo más cercano, este mes: ${show(spent, materials?.value.value ?? 0)} en gastos de Materiales, y en ${used?.encounters ?? 0} atenciones se usaron ${used?.units ?? 0} unidades de ${used?.products ?? 0} productos.`,
        criterio: "Trampa a medias: gastos registrados en Materiales del mes y lo descontado de Inventario en las atenciones del mes.",
        datos: { materiales: materials ?? null, usado: used },
      }
    },
    r17: async () => {
      const result = await fig("gastos", "categoria")
      const commissions = await fig("comisiones")
      return {
        respuesta: `Este mes tus gastos más altos son ${listOf(result.rows.slice(0, 4).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}, de ${show(result)} en total.`,
        criterio: "Gastos registrados del mes por categoría (Reportes › Finanzas), sin anulados y sin el pago de comisiones.",
        nota: `Las comisiones del mes van aparte: ${show(commissions)}.`,
        datos: { filas: result.rows, comisiones: commissions.total },
      }
    },
    r18: async () => {
      const collected = await fig("cobrado")
      const spent = await fig("gastos")
      const commissions = await fig("comisiones")
      const income = collected.total.value ?? 0
      const expenses = spent.total.value ?? 0
      const paid = commissions.total.value ?? 0
      return {
        respuesta: `Este mes el ${pct(expenses + paid, income)} de lo cobrado se fue en gastos y comisiones: ${show(spent)} de gastos registrados y ${show(commissions)} de comisiones, de ${show(collected)} cobrados.`,
        criterio: "(Gastos registrados + comisiones del mes) ÷ lo cobrado del mes; es 100 % menos el margen de «Lo que deja».",
        nota: `Solo los gastos registrados, sin comisiones: ${pct(expenses, income)}.`,
        datos: { cobrado: collected.total, gastos: spent.total, comisiones: commissions.total },
      }
    },
    r20: async () => {
      const result = await fig("lo_que_deja", "mes")
      const full = result.months.filter((month) => !month.partial).slice(-6)
      const current = result.months.find((month) => month.partial)
      const sorted = [...full].sort((a, b) => (b.value.value ?? -Infinity) - (a.value.value ?? -Infinity))
      return {
        respuesta: `Lo que dejó cada mes (cobrado − comisiones − gastos registrados): ${listOf(full.map((month) => ({ name: monthName(month.month), value: show(result, month.value.value) })))}. El mejor fue ${sorted[0] ? monthName(sorted[0].month) : "—"} y el más bajo ${(() => { const low = sorted.at(-1); return low ? monthName(low.month) : "—" })()}.`,
        criterio: "«Lo que deja el mes» de Reportes por mes, los últimos 6 meses completos.",
        nota: current ? `El mes en curso va ${show(result, current.value.value)} hasta hoy.` : undefined,
        datos: { meses: result.months },
      }
    },
    r21: async () => {
      const result = await fig("activos")
      const [row] = await tx.execute<{ year: number }>(sql`
        select count(distinct a.patient_id)::int as year from appointment a
        where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${yearAgo}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      return {
        respuesta: `Tienes ${show(result)} pacientes activos: con al menos una cita atendida en los últimos 18 meses.`,
        criterio: "«Pacientes activos» de Reportes, a hoy (18 meses).",
        nota: `Con 12 meses en vez de 18: ${row?.year ?? 0}.`,
        datos: { total: result.total, doceMeses: row?.year ?? 0 },
      }
    },
    r24: async () => {
      const back = (since: string) =>
        tx.execute<{ count: number }>(sql`
          with v as (
            select a.patient_id, a.starts_at, lag(a.starts_at) over (partition by a.patient_id order by a.starts_at) as prev
            from appointment a where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at < ${nowIso}::timestamptz)
          select count(distinct patient_id)::int as count from v
          where starts_at >= ${since}::timestamptz and prev is not null and prev < starts_at - interval '6 months'`)
      const [month] = await back(monthStart)
      const [year] = await back(yearAgo)
      return {
        respuesta: `Este mes volvieron ${month?.count ?? 0} pacientes después de más de 6 meses sin venir.`,
        criterio: "Pacientes con una cita atendida este mes cuya cita atendida anterior fue hace más de 6 meses.",
        nota: `En los últimos 12 meses: ${year?.count ?? 0}.`,
        datos: { mes: month?.count ?? 0, doceMeses: year?.count ?? 0 },
      }
    },
    r25: async () => {
      const result = await fig("volvieron")
      return {
        respuesta: `Tu retención es del ${show(result)}: de los ${result.total.whole ?? 0} pacientes atendidos hace 12 a 24 meses, ${result.total.part ?? 0} volvieron en los últimos 12.`,
        criterio: "«Volvieron en el año» de Reportes, a hoy.",
        datos: { total: result.total },
      }
    },
    r28: async () => {
      const [row] = await tx.execute<{ total: number; fresh: number }>(sql`
        with first as (select a.patient_id, min(a.starts_at) as at from appointment a where a.organization_id = ${ORG} and a.status = 'atendida' group by 1),
        month as (select distinct a.patient_id from appointment a where a.organization_id = ${ORG} and a.status = 'atendida'
          and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz)
        select count(*)::int as total, count(*) filter (where f.at >= ${monthStart}::timestamptz)::int as fresh
        from month m join first f on f.patient_id = m.patient_id`)
      const total = row?.total ?? 0
      const fresh = row?.fresh ?? 0
      return {
        respuesta: `Este mes, de ${total} pacientes atendidos, ${fresh} son nuevos (${pct(fresh, total)}) y ${total - fresh} recurrentes (${pct(total - fresh, total)}).`,
        criterio: "Pacientes distintos con una cita atendida en el mes; nuevo si es su primera cita atendida (la regla de «Pacientes nuevos»).",
        datos: { row },
      }
    },
    r30: async () => {
      const result = await fig("pacientes_nuevos", "mes")
      const full = result.months.filter((month) => !month.partial)
      const sorted = [...full].sort((a, b) => (b.value.value ?? -Infinity) - (a.value.value ?? -Infinity))
      return {
        respuesta: `Pacientes nuevos por mes en el último año: ${listOf(result.months.map((month) => ({ name: `${monthName(month.month)}${month.partial ? " (hasta hoy)" : ""}`, value: show(result, month.value.value) })))}. El mejor mes fue ${sorted[0] ? monthName(sorted[0].month) : "—"} y el más bajo ${(() => { const low = sorted.at(-1); return low ? monthName(low.month) : "—" })()}.`,
        criterio: "«Pacientes nuevos» de Reportes por mes, los últimos 12 meses (el mejor y el peor, sin el mes en curso).",
        datos: { meses: result.months },
      }
    },
    r32: async () => {
      const result = await fig("atendidas")
      return {
        respuesta: `Este mes se atendieron ${show(result)} citas (en los mismos días del mes anterior, ${show(result, result.previous?.value ?? null)}).`,
        criterio: "«Citas atendidas» de Reportes, del mes en curso.",
        datos: { total: result.total, anterior: result.previous },
      }
    },
    r33: async () => {
      const result = await fig("canceladas")
      const [row] = await tx.execute<{ appointments: number; people: number }>(sql`
        select count(*)::int as appointments, count(distinct a.patient_id)::int as people from appointment a
        where a.organization_id = ${ORG} and a.status = 'cancelada' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      return {
        respuesta: `odentIA no guarda en la cita quién la canceló (la persona o la clínica). Este mes se cancelaron ${row?.appointments ?? 0} citas de ${row?.people ?? 0} personas: el ${show(result)} de las citas que ya pasaron.`,
        criterio: "Trampa a medias: citas del mes canceladas (hasta hoy) y personas distintas; no se sabe quién canceló.",
        datos: { row, total: result.total },
      }
    },
    r38: async () => {
      const [row] = await tx.execute<{ average: number | null; median: number | null; count: number }>(sql`
        select avg(a.duration_min)::float as average, percentile_cont(0.5) within group (order by a.duration_min)::float as median, count(*)::int as count
        from appointment a where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz`)
      const [real] = await tx.execute<{ average: number | null; count: number }>(sql`
        select avg(extract(epoch from e.ended_at - e.started_at) / 60)::float as average, count(*)::int as count from encounter e
        where e.organization_id = ${ORG} and e.status = 'finalizada' and e.ended_at is not null and e.ended_at > e.started_at
          and e.ended_at - e.started_at < interval '8 hours' and e.started_at >= ${monthStart}::timestamptz`)
      return {
        respuesta: `Este mes una cita atendida dura en promedio ${Math.round(row?.average ?? 0)} minutos (${row?.count ?? 0} citas).`,
        criterio: "Duración reservada en la agenda de las citas atendidas del mes.",
        nota: `Mediana: ${Math.round(row?.median ?? 0)} minutos. Lo que duró de verdad la atención (inicio a fin, ${real?.count ?? 0} atenciones firmadas): ${Math.round(real?.average ?? 0)} minutos en promedio.`,
        datos: { reservado: row, atencion: real },
      }
    },
    r40: async () => {
      const attended = await fig("atendidas")
      const noShow = await fig("no_vinieron")
      const cancelled = await fig("canceladas")
      const base = noShow.total.whole ?? 0
      const came = attended.total.value ?? 0
      const dropped = cancelled.total.part ?? 0
      return {
        respuesta: `Este mes el ${pct(came, base)} de las citas que ya pasaron terminó atendida (${came} de ${base}).`,
        criterio: "Citas atendidas ÷ citas del mes que ya pasaron (atendidas, no vinieron, canceladas y las que pasaron sin marcar), la base de «No vinieron».",
        nota: `Sin contar las canceladas: ${pct(came, base - dropped)} (${came} de ${base - dropped}).`,
        datos: { atendidas: came, yaPasaron: base, canceladas: dropped },
      }
    },
    r42: async () => {
      const rows = await tx.execute<{ name: string; cents: string }>(sql`
        select ${conceptName} as name, sum(a.amount_cents)::text as cents
        from patient_payment_application a
        join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id and c.voided_at is null and c.product_id is null
        ${conceptJoins}
        where a.organization_id = ${ORG} and a.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz
        group by 1 order by sum(a.amount_cents) desc, 1 limit 5`)
      const screen = await fig("cobrado", "tratamiento")
      return {
        respuesta: `Este mes los tratamientos que más ingresos dejaron son ${listOf(rows.map((row) => ({ name: row.name, value: money(Number(row.cents)) })))}.`,
        criterio: "Lo pagado este mes aplicado a cada tratamiento (sin productos ni anulados), de más a menos.",
        nota: `Reportes por tratamiento: ${listOf(screen.rows.slice(0, 5).map((row) => ({ name: row.label, value: show(screen, row.value.value) })))}.`,
        datos: { filas: rows, reportes: screen.rows },
      }
    },
    r44: async () => {
      const [row] = await tx.execute<{ running: number; people: number; booked: number }>(sql`
        select count(*) filter (where pi.status = 'en_curso')::int as running, count(distinct pi.patient_id) filter (where pi.status = 'en_curso')::int as people,
          count(*) filter (where pi.status = 'programado')::int as booked
        from treatment_plan_item pi where pi.organization_id = ${ORG} and pi.status in ('en_curso','programado')`)
      return {
        respuesta: `Hoy hay ${row?.running ?? 0} tratamientos en proceso (empezados y sin terminar), de ${row?.people ?? 0} pacientes.`,
        criterio: "Tratamientos de los planes en estado «en curso», a hoy.",
        nota: `Además, ${row?.booked ?? 0} están programados (con cita, sin empezar).`,
        datos: { row },
      }
    },
    r46: async () => {
      const [row] = await tx.execute<{ waiting: number; month: number; quarter: number }>(sql`
        select count(*)::int as waiting, count(*) filter (where coalesce(pi.decided_at, pi.created_at) < now() - interval '30 days')::int as month,
          count(*) filter (where coalesce(pi.decided_at, pi.created_at) < now() - interval '90 days')::int as quarter
        from treatment_plan_item pi
        where pi.organization_id = ${ORG} and pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado') and pi.started_at is null`)
      return {
        respuesta: `odentIA no guarda una fecha prevista para cada tratamiento, así que no sé cuáles van atrasados. Lo más cercano: ${row?.waiting ?? 0} tratamientos aceptados siguen sin empezar; ${row?.month ?? 0} llevan más de 30 días esperando y ${row?.quarter ?? 0} más de 90.`,
        criterio: "Trampa: sin fecha prevista no hay atraso. Se ofrecen los aceptados sin empezar, a hoy, por antigüedad (desde que se aceptaron o, si no consta, desde que se indicaron).",
        datos: { row },
      }
    },
    r47: async () => {
      const rows = await tx.execute<{ name: string; count: number; days: number | null; fromAccepted: number | null }>(sql`
        select coalesce(os.name, 'Sin especialidad') as name, count(*)::int as count,
          avg(extract(epoch from pi.completed_at - pi.started_at) / 86400)::float as days,
          avg(extract(epoch from pi.completed_at - coalesce(pi.decided_at, pi.created_at)) / 86400)::float as "fromAccepted"
        from treatment_plan_item pi
        left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
        left join org_specialty os on os.organization_id = s.organization_id and os.id = s.specialty_id
        where pi.organization_id = ${ORG} and pi.status = 'realizado' and pi.started_at is not null and pi.completed_at is not null
          and pi.completed_at >= ${yearAgo}::timestamptz and pi.completed_at < ${nowIso}::timestamptz
        group by 1 order by 3 desc nulls last, 1`)
      const days = (value: number | null) => `${Math.round(value ?? 0)} días`
      return {
        respuesta: `En los últimos 12 meses, de que empieza a que termina un tratamiento: ${listOf(rows.map((row) => ({ name: row.name, value: `${days(row.days)}, ${row.count} terminados` })))}.`,
        criterio: "Tratamientos del plan terminados en los últimos 12 meses, por especialidad del servicio: días entre su inicio y su fin, en promedio.",
        nota: `Desde que se aceptó hasta que terminó: ${listOf(rows.map((row) => ({ name: row.name, value: days(row.fromAccepted) })))}. 12 meses y no el mes, porque un mes tiene pocos terminados.`,
        datos: { filas: rows },
      }
    },
    r49: async () => {
      const coming = await fig("lo_que_viene")
      const waiting = await (solve.c63 as () => Promise<Answer>)()
      return {
        respuesta: `Lo aceptado que falta hacer vale ${show(coming)}, a su precio acordado.`,
        criterio: "«Lo que viene» de Reportes: lo aceptado en presupuestos que todavía no se hizo, a hoy.",
        nota: `Aparte, lo que aún no se decide en presupuestos que esperan respuesta: ${waiting.respuesta}`,
        datos: { loQueViene: coming.total, esperan: waiting.datos },
      }
    },
    r50: async () => {
      const rows = await tx.execute<{ name: string; accepted: number; dropped: number }>(sql`
        select coalesce(s.name, pi.title) as name, count(*)::int as accepted, count(*) filter (where pi.status in ('suspendido','cancelado'))::int as dropped
        from treatment_plan_item pi left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
        where pi.organization_id = ${ORG} and pi.decision_status = 'aceptado' and pi.status <> 'reemplazado'
        group by 1 having count(*) >= 3
        order by count(*) filter (where pi.status in ('suspendido','cancelado'))::float / count(*) desc, 3 desc, 1 limit 5`)
      return {
        respuesta: `odentIA no marca el abandono ni guarda una fecha prevista. Lo más cercano: de lo aceptado, lo que más quedó suspendido o cancelado es ${listOf(rows.slice(0, 3).map((row) => ({ name: row.name, value: `${pct(row.dropped, row.accepted)}, ${row.dropped} de ${row.accepted}` })))}.`,
        criterio: "Trampa a medias: de los tratamientos aceptados (todos, a hoy), la parte suspendida o cancelada por tratamiento; solo los que tienen al menos 3 aceptados.",
        datos: { filas: rows },
      }
    },
    r53: async () => {
      const rows = await tx.execute<{ name: string; times: number }>(sql`
        select u.name, sum(ep.quantity)::int as times from encounter_procedure ep ${done}
        join "user" u on u.id = e.dentist_user_id
        where ep.organization_id = ${ORG} and ep.voided_at is null and e.started_at >= ${monthStart}::timestamptz
        group by 1 order by 2 desc, 1`)
      return {
        respuesta: `Este mes: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.times} tratamientos` })))}.`,
        criterio: "Procedimientos no anulados de atenciones firmadas del mes, por quien atendió (contando la cantidad).",
        datos: { filas: rows },
      }
    },
    r54: async () => {
      const result = await fig("cobrado", "profesional")
      const hours = await tx.execute<{ id: string; name: string; minutes: number }>(sql`
        select u.id, u.name, sum(a.duration_min)::int as minutes from appointment a join "user" u on u.id = a.dentist_user_id
        where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz
        group by 1, 2`)
      const rows = result.rows
        .map((row) => {
          const minutes = hours.find((item) => item.id === row.key || item.name === row.label)?.minutes ?? 0
          const cents = row.value.value ?? 0
          return { name: row.label, cents, minutes, perHour: minutes > 0 ? cents / (minutes / 60) : null }
        })
        .sort((a, b) => (b.perHour ?? -1) - (a.perHour ?? -1))
      return {
        respuesta: `Este mes, por hora de cita atendida: ${listOf(rows.map((row) => ({ name: row.name, value: row.perHour === null ? "sin citas atendidas" : `${money(row.perHour)} por hora (${money(row.cents)} en ${hoursOf(row.minutes)})` })))}.`,
        criterio: "Lo cobrado de lo que atendió cada uno (la base de las comisiones) ÷ las horas reservadas de sus citas atendidas del mes.",
        datos: { filas: rows },
      }
    },
    r55: async () => {
      const result = await fig("canceladas", "profesional")
      const byCount = [...result.rows].sort((a, b) => (b.value.part ?? 0) - (a.value.part ?? 0) || a.label.localeCompare(b.label))
      const byRate = [...result.rows].sort((a, b) => (b.value.value ?? -Infinity) - (a.value.value ?? -Infinity))
      const top = byCount[0]
      return {
        respuesta: top
          ? `Este mes quien más cancelaciones tiene es ${top.label}: ${top.value.part ?? 0} citas canceladas (${show(result, top.value.value)} de sus citas). Le siguen ${listOf(byCount.slice(1, 3).map((row) => ({ name: row.label, value: `${row.value.part ?? 0}` })))}.`
          : "Este mes no hay cancelaciones.",
        criterio: "«Canceladas» de Reportes por profesional, ordenado por cuántas.",
        nota: `Por porcentaje: ${listOf(byRate.slice(0, 3).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`,
        datos: { filas: result.rows },
      }
    },
    r56: async () => {
      const rows = await tx.execute<{ name: string; count: number; cents: string }>(sql`
        select coalesce(u.name, 'Sin dato') as name, count(*)::int as count, coalesce(sum(pi.price_cents), 0)::text as cents
        from treatment_plan_item pi left join "user" u on u.id = pi.created_by
        where pi.organization_id = ${ORG} and pi.decision_status = 'aceptado' and pi.status in ('pendiente','programado','en_curso')
        group by 1 order by 2 desc, 1`)
      return {
        respuesta: `odentIA sabe quién indicó cada tratamiento, no quién lo hará. Por quien lo indicó, lo aceptado sin terminar: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.count} tratamientos, ${money(Number(row.cents))}` })))}.`,
        criterio: "Trampa a medias: tratamientos aceptados pendientes, programados o en curso, a hoy, por quien los indicó.",
        datos: { filas: rows },
      }
    },
    r58: async () => {
      const demand = (since: string) =>
        tx.execute<{ name: string; times: number }>(sql`
          select coalesce(os.name, 'Sin especialidad') as name, sum(ep.quantity)::int as times from encounter_procedure ep ${done} ${specialtyJoins}
          where ep.organization_id = ${ORG} and ep.voided_at is null and e.started_at >= ${since}::timestamptz
          group by 1 order by 2 desc, 1`)
      const month = await demand(monthStart)
      const year = await demand(yearAgo)
      return {
        respuesta: `Este mes las especialidades con más tratamientos son ${listOf(month.slice(0, 4).map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        criterio: "Tratamientos realizados (procedimientos de atenciones firmadas) del mes, por la especialidad del servicio.",
        nota: `En los últimos 12 meses: ${listOf(year.slice(0, 4).map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        datos: { mes: month, doceMeses: year },
      }
    },
    r59: async () => {
      const [end] = await tx.execute<{ at: string }>(sql`select ((date_trunc('month', now() at time zone ${tz}) + interval '1 month') at time zone ${tz})::text as at`)
      const people = await tx.execute<{ id: string; name: string }>(sql`
        select distinct s.dentist_user_id as id, u.name from professional_schedule s join "user" u on u.id = s.dentist_user_id
        where s.organization_id = ${ORG} and s.is_active order by 2`)
      const rest: Array<{ name: string; minutes: number }> = []
      for (const person of people) {
        const minutes = await agendaMinutes(tx, ORG, { start: now, end: new Date(end?.at ?? nowIso) }, { dentistUserId: person.id })
        rest.push({ name: person.name, minutes: minutes.days.reduce((total, day) => total + Math.max(0, day.availMin - day.occMin), 0) })
      }
      rest.sort((a, b) => b.minutes - a.minutes)
      const screen = await fig("horas_libres", "profesional")
      return {
        respuesta: `Lo que queda de este mes, horas libres en la agenda: ${listOf(rest.map((row) => ({ name: row.name, value: hoursOf(row.minutes) })))}.`,
        criterio: "Desde ahora hasta fin de mes: horas del horario de cada profesional menos sus ausencias y sus citas no canceladas (la cuenta de Reportes › Agenda).",
        nota: `«Horas libres» de Reportes, del mes hasta hoy: ${listOf(screen.rows.map((row) => ({ name: row.label, value: show(screen, row.value.value) })))}.`,
        datos: { restoDelMes: rest, reportes: screen.rows },
      }
    },
    r60: async () => {
      const before = scope.window.previous
      const rows = await tx.execute<{ name: string; current: number; previous: number }>(sql`
        select u.name,
          count(*) filter (where a.starts_at >= ${monthStart}::timestamptz and a.starts_at < ${nowIso}::timestamptz)::int as current,
          count(*) filter (where a.starts_at >= ${before.start.toISOString()}::timestamptz and a.starts_at < ${before.end.toISOString()}::timestamptz)::int as previous
        from appointment a join "user" u on u.id = a.dentist_user_id
        where a.organization_id = ${ORG} and a.status = 'atendida' and a.starts_at >= ${before.start.toISOString()}::timestamptz and a.starts_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 1`)
      return {
        respuesta: `Citas atendidas este mes contra los mismos días del mes anterior: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.current} contra ${row.previous}, ${row.current >= row.previous ? "+" : ""}${row.current - row.previous}` })))}.`,
        criterio: "Citas atendidas por profesional del mes en curso contra los mismos días del mes anterior (la comparación de Reportes).",
        datos: { filas: rows },
      }
    },
    r61: async () => {
      const result = await fig("aceptaron")
      const [row] = await tx.execute<{ presented: number; created: number; drafts: number }>(sql`
        select count(*) filter (where b.status <> 'borrador' and b.presented_at >= ${monthStart}::timestamptz)::int as presented,
          count(*) filter (where b.created_at >= ${monthStart}::timestamptz)::int as created,
          count(*) filter (where b.status = 'borrador' and b.created_at >= ${monthStart}::timestamptz)::int as drafts
        from treatment_budget b where b.organization_id = ${ORG}`)
      return {
        respuesta: `Este mes se presentaron ${result.total.whole ?? row?.presented ?? 0} presupuestos.`,
        criterio: "Presupuestos entregados al paciente en el mes (sin borradores): la base de «Aceptaron su presupuesto».",
        nota: `Creados este mes, contando ${row?.drafts ?? 0} borradores sin entregar: ${row?.created ?? 0}. Presentados contados en la tabla: ${row?.presented ?? 0}.`,
        datos: { reportes: result.total, row },
      }
    },
    r65: async () => {
      const accepted = (since: string) =>
        tx.execute<{ budgets: number; average: number | null }>(sql`
          select count(*)::int as budgets, avg(t.cents)::float as average from (
            select b.id, sum(i.price_cents::bigint * ${units}) as cents from treatment_budget b
            join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
              and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.decision = 'aceptado' and i.price_cents is not null
            where b.organization_id = ${ORG} and b.status in ('aceptado','parcial')
              and b.presented_at >= ${since}::timestamptz and b.presented_at < ${nowIso}::timestamptz
            group by b.id) t`)
      const [month] = await accepted(monthStart)
      const [year] = await accepted(yearAgo)
      return {
        respuesta: `Este mes un presupuesto aceptado vale en promedio ${money(month?.average ?? 0)}: lo aceptado de ${month?.budgets ?? 0} presupuestos aceptados en todo o en parte.`,
        criterio: "Presupuestos presentados en el mes y aceptados en todo o en parte: lo aceptado de la opción que vale, en promedio.",
        nota: `En los últimos 12 meses: ${money(year?.average ?? 0)} en ${year?.budgets ?? 0} presupuestos.`,
        datos: { mes: month, doceMeses: year },
      }
    },
    r66: async () => {
      const delay = (since: string) =>
        tx.execute<{ count: number; median: number | null; average: number | null }>(sql`
          select count(*)::int as count,
            percentile_cont(0.5) within group (order by extract(epoch from b.decided_at - b.presented_at) / 86400)::float as median,
            avg(extract(epoch from b.decided_at - b.presented_at) / 86400)::float as average
          from treatment_budget b
          where b.organization_id = ${ORG} and b.status in ('aceptado','parcial') and b.presented_at is not null and b.decided_at is not null
            and b.decided_at >= ${since}::timestamptz and b.decided_at < ${nowIso}::timestamptz`)
      const [year] = await delay(yearAgo)
      const [month] = await delay(monthStart)
      return {
        respuesta: `En los últimos 12 meses, entre que se presenta un presupuesto y el paciente lo acepta pasan ${Math.round(year?.median ?? 0)} días (mediana; en promedio, ${Math.round(year?.average ?? 0)}), en ${year?.count ?? 0} presupuestos aceptados.`,
        criterio: "Presupuestos aceptados en todo o en parte y decididos en los últimos 12 meses: días entre presentado y decidido. Es un «cuánto tardan»: mira 12 meses.",
        nota: `Solo los decididos este mes: ${Math.round(month?.median ?? 0)} días de mediana en ${month?.count ?? 0} presupuestos.`,
        datos: { doceMeses: year, mes: month },
      }
    },
    r67: async () => {
      const rate = (since: string) =>
        tx.execute<{ name: string; lines: number; accepted: number }>(sql`
          select coalesce(s.name, i.title) as name, count(*)::int as lines, count(*) filter (where i.decision = 'aceptado')::int as accepted
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id and i.option_id = ${budgetValueOptionSql(budgetRef)}
          left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
          where b.organization_id = ${ORG} and b.status not in ('borrador','sustituido','cancelado') and b.presented_at >= ${since}::timestamptz and b.presented_at < ${nowIso}::timestamptz
          group by 1 having count(*) >= 2
          order by count(*) filter (where i.decision = 'aceptado')::float / count(*), count(*) desc, 1 limit 5`)
      const month = await rate(monthStart)
      const year = await rate(yearAgo)
      const words = (rows: typeof month) => listOf(rows.slice(0, 3).map((row) => ({ name: row.name, value: `${pct(row.accepted, row.lines)}, ${row.accepted} de ${row.lines}` })))
      return {
        respuesta: `Este mes los tratamientos que menos se aceptan son ${words(month)}.`,
        criterio: "Líneas de la opción que vale en los presupuestos presentados en el mes (sin borradores ni sustituidos), por tratamiento: aceptadas ÷ presentadas, a hoy; solo los que aparecen al menos 2 veces.",
        nota: `En los últimos 12 meses: ${words(year)}.`,
        datos: { mes: month, doceMeses: year },
      }
    },
    r68: async () => {
      const result = await fig("aceptaron", "profesional")
      const top = result.rows[0]
      return {
        respuesta: top
          ? `Este mes la mayor conversión es de ${top.label}: ${show(result, top.value.value)} (${top.value.part ?? 0} de ${top.value.whole ?? 0} presupuestos). Le siguen ${listOf(result.rows.slice(1, 3).map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`
          : "Este mes nadie presentó presupuestos.",
        criterio: "«Aceptaron su presupuesto» de Reportes por profesional (los que presentó cada uno), del mes en curso.",
        datos: { filas: result.rows },
      }
    },
    r72: async () => {
      const [row] = await tx.execute<{ charged: string; paid: string }>(sql`
        select coalesce(sum(c.amount_cents), 0)::text as charged, coalesce(sum(ap.cents), 0)::text as paid from patient_charge c
        left join lateral (select sum(a.amount_cents) as cents from patient_payment_application a
          join patient_payment pay on pay.organization_id = a.organization_id and pay.id = a.payment_id and pay.voided_at is null
          where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null) ap on true
        where c.organization_id = ${ORG} and c.voided_at is null and c.created_at >= ${monthStart}::timestamptz`)
      const charged = Number(row?.charged ?? 0)
      const paid = Number(row?.paid ?? 0)
      return {
        respuesta: `odentIA no emite facturas, solo tickets de pago. De lo cargado a los pacientes este mes (${money(charged)}), ya se pagó ${money(paid)}: el ${pct(paid, charged)}.`,
        criterio: "Trampa: en lugar de «facturado», lo cargado del mes (sin anulados) y lo ya pagado de eso, a hoy.",
        datos: { row },
      }
    },
    r73: async () => {
      const [row] = await tx.execute<{ payments: number; partial: number; charges: number; credit: number }>(sql`
        with pays as (
          select pay.id, pay.amount_cents from patient_payment pay
          where pay.organization_id = ${ORG} and pay.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz),
        applied as (
          select a.payment_id, a.charge_id, a.amount_cents from patient_payment_application a join pays on pays.id = a.payment_id
          where a.organization_id = ${ORG} and a.voided_at is null),
        open as (
          select c.id from patient_charge c where c.organization_id = ${ORG} and c.voided_at is null and c.amount_cents > coalesce((
            select sum(x.amount_cents) from patient_payment_application x
            join patient_payment p2 on p2.organization_id = x.organization_id and p2.id = x.payment_id and p2.voided_at is null
            where x.organization_id = c.organization_id and x.charge_id = c.id and x.voided_at is null), 0))
        select (select count(*) from pays)::int as payments,
          (select count(distinct payment_id) from applied where charge_id in (select id from open))::int as partial,
          (select count(distinct charge_id) from applied where charge_id in (select id from open))::int as charges,
          (select count(*) from pays where pays.amount_cents > coalesce((select sum(amount_cents) from applied where applied.payment_id = pays.id), 0))::int as credit`)
      return {
        respuesta: `Este mes ${row?.partial ?? 0} de los ${row?.payments ?? 0} pagos fueron parciales: dejaron saldo en ${row?.charges ?? 0} tratamientos o productos que aún no se terminan de pagar.`,
        criterio: "Pagos vigentes del mes aplicados a un concepto que hoy todavía tiene saldo.",
        nota: `Pagos del mes con una parte que quedó a favor, sin aplicarse: ${row?.credit ?? 0}.`,
        datos: { row },
      }
    },
    r74: async () => {
      const rows = await tx.execute<{ name: string; count: number; cents: string }>(sql`
        select pay.method_name as name, count(*)::int as count, sum(pay.amount_cents)::text as cents from patient_payment pay
        where pay.organization_id = ${ORG} and pay.voided_at is null and pay.paid_at >= ${monthStart}::timestamptz and pay.paid_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, sum(pay.amount_cents) desc, 1`)
      const screen = await fig("cobrado", "medio")
      return {
        respuesta: `Este mes los medios de pago más usados son ${listOf(rows.map((row) => ({ name: row.name, value: `${row.count} pagos, ${money(Number(row.cents))}` })))}.`,
        criterio: "Pagos vigentes del mes por medio, de más a menos veces.",
        nota: `Por monto, como Reportes (lo cobrado por medio): ${listOf(screen.rows.map((row) => ({ name: row.label, value: show(screen, row.value.value) })))}.`,
        datos: { filas: rows, reportes: screen.rows },
      }
    },
    r76: async () => {
      const owed = await fig("te_deben", "mes")
      const overdue = await fig("deuda_vencida", "mes")
      const label = (month: (typeof owed.months)[number]) => `${monthName(month.month)}${month.partial ? " (hoy)" : ""}`
      return {
        respuesta: `Lo que te debían al cierre de cada mes: ${listOf(owed.months.slice(-6).map((month) => ({ name: label(month), value: show(owed, month.value.value) })))}.`,
        criterio: "«Te deben» de Reportes al cierre de cada mes (el mes en curso, a hoy), los últimos 6 meses.",
        nota: `Lo vencido (más de 30 días) en esos meses: ${listOf(overdue.months.slice(-6).map((month) => ({ name: label(month), value: show(overdue, month.value.value) })))}.`,
        datos: { teDeben: owed.months, vencido: overdue.months },
      }
    },
    r80: async () => {
      const rows = await tx.execute<{ kind: string; patients: number; average: number | null; total: string }>(sql`
        with first as (select a.patient_id, min(a.starts_at) as at from appointment a where a.organization_id = ${ORG} and a.status = 'atendida' group by 1),
        fresh as (
          select f.patient_id, ${referralWords} as kind from first f join patient p on p.organization_id = ${ORG} and p.id = f.patient_id
          where f.at >= ${yearAgo}::timestamptz and f.at < ${nowIso}::timestamptz)
        select kind, count(*)::int as patients, avg(${paidByPatient(sql`fresh.patient_id`)})::float as average, sum(${paidByPatient(sql`fresh.patient_id`)})::text as total
        from fresh group by 1 order by 3 desc nulls last, 1`)
      const byTotal = [...rows].sort((a, b) => Number(b.total) - Number(a.total))
      return {
        respuesta: `En los últimos 12 meses, los pacientes nuevos que más pagan en promedio llegaron por ${listOf(rows.slice(0, 3).map((row) => ({ name: row.kind, value: `${money(row.average ?? 0)} por paciente, ${row.patients} pacientes` })))}.`,
        criterio: "Pacientes nuevos de los últimos 12 meses (primera cita atendida) por «Cómo nos conoció»: lo que pagó cada uno hasta hoy, sin anulados ni lo devuelto, en promedio. 12 meses porque el valor de un paciente necesita tiempo.",
        nota: `Por lo pagado en total: ${listOf(byTotal.slice(0, 3).map((row) => ({ name: row.kind, value: money(Number(row.total)) })))}.`,
        datos: { filas: rows },
      }
    },
    r82: async () => {
      const [month] = await funnelMany(tx, ORG, [scope.window], now)
      const last = await reportScope(tx, ORG, { period: "mes_pasado" }, now)
      const [previous] = await funnelMany(tx, ORG, [last.window], now)
      const sought = month?.counts.sought ?? 0
      const booked = month?.counts.booked ?? 0
      return {
        respuesta: `De las ${sought} personas que nos buscaron por primera vez este mes, ${booked} agendaron una cita: el ${pct(booked, sought)}.`,
        criterio: "El embudo de Reportes › Pacientes: personas cuya primera conversación o registro fue en el mes y cuántas agendaron (una cita sin cancelar), hasta hoy.",
        nota: `El mes pasado: ${previous?.counts.booked ?? 0} de ${previous?.counts.sought ?? 0} (${pct(previous?.counts.booked ?? 0, previous?.counts.sought ?? 0)}).`,
        datos: { mes: month?.counts, mesPasado: previous?.counts },
      }
    },
    r84: async () => {
      const spent = await fig("gastos", "categoria")
      const materials = spent.rows.find((row) => /material/i.test(row.label))
      const [orders] = await tx.execute<{ count: number; cents: string }>(sql`
        select count(*)::int as count, coalesce(sum((select sum(l.quantity * l.unit_cost_cents) from purchase_order_line l
          where l.organization_id = po.organization_id and l.order_id = po.id)), 0)::text as cents
        from purchase_order po where po.organization_id = ${ORG} and po.status not in ('borrador','cancelada') and po.created_at >= ${monthStart}::timestamptz`)
      return {
        respuesta: `Este mes se gastaron ${show(spent, materials?.value.value ?? 0)} en insumos: los gastos registrados en Materiales (incluye lo pagado de las compras de Inventario).`,
        criterio: "Gastos registrados del mes en la categoría Materiales, sin anulados.",
        nota: `Compras de Inventario hechas este mes (pagadas o no): ${orders?.count ?? 0} por ${money(Number(orders?.cents ?? 0))}.`,
        datos: { materiales: materials ?? null, compras: orders },
      }
    },
    r85: async () => {
      const used = (since: string) =>
        tx.execute<{ name: string; unit: string; units: number }>(sql`
          select pr.name, pr.unit, sum(-m.quantity_delta)::int as units from stock_movement m
          join product pr on pr.organization_id = m.organization_id and pr.id = m.product_id
          where ${consumed(since)} group by 1, 2 order by 3 desc, 1 limit 5`)
      const month = await used(monthStart)
      const year = await used(yearAgo)
      const words = (rows: typeof month) => listOf(rows.map((row) => ({ name: row.name, value: `${row.units}, en ${row.unit}` })))
      return {
        respuesta: `Este mes los materiales más usados en las atenciones son ${words(month)}.`,
        criterio: "Lo descontado de Inventario en las atenciones del mes (movimientos de consumo), por producto.",
        nota: `En los últimos 12 meses: ${words(year)}.`,
        datos: { mes: month, doceMeses: year },
      }
    },
    r87: async () => {
      const rows = await tx.execute<{ branch: string; products: number; units: number }>(sql`
        select b.name as branch, count(distinct l.product_id)::int as products, sum(l.quantity_on_hand)::int as units from product_lot l
        join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
        join branch b on b.organization_id = w.organization_id and b.id = w.branch_id
        where l.organization_id = ${ORG} and l.quantity_on_hand > 0 group by 1 order by 1`)
      return {
        respuesta: `No puedo valorizar el inventario: los lotes no guardan lo que costaron. Lo que sí sé, hoy: ${listOf(rows.map((row) => ({ name: row.branch, value: `${row.units} unidades de ${row.products} productos` })))}.`,
        criterio: "Trampa: sin costo por lote no hay valor. Se ofrecen las unidades en existencia por sede, a hoy (lotes con cantidad, también los vencidos).",
        datos: { filas: rows },
      }
    },
    r88: async () => {
      const rows = await tx.execute<{ name: string; units: number; encounters: number }>(sql`
        select coalesce(u.name, 'Sin atención') as name, sum(-m.quantity_delta)::int as units, count(distinct m.encounter_id)::int as encounters
        from stock_movement m left join encounter e on e.organization_id = m.organization_id and e.id = m.encounter_id
        left join "user" u on u.id = e.dentist_user_id
        where ${consumed(monthStart)} group by 1 order by 2 desc, 1`)
      return {
        respuesta: `Por procedimiento no lo sé: el consumo se registra por atención. Por odontólogo, este mes: ${listOf(rows.map((row) => ({ name: row.name, value: `${row.units} unidades en ${row.encounters} atenciones` })))}.`,
        criterio: "Trampa a medias: lo descontado de Inventario en las atenciones del mes, por quien atendió (suma unidades de productos distintos).",
        datos: { filas: rows },
      }
    },
    r90: async () => ({
      respuesta: "odentIA todavía no marca las quejas en los mensajes, así que no sé cuántas hubo este mes.",
      criterio: "Trampa: no hay etiqueta de queja por mensaje (está pedida aparte). No se inventa con conversaciones.",
      datos: {},
    }),
    r92: async () => {
      const result = await fig("controles")
      const last = await fig("controles", "total", "mes_pasado")
      return {
        respuesta: `Este mes vino a su control el ${show(result)} de los pacientes a quienes les tocaba (${result.total.part ?? 0} de ${result.total.whole ?? 0} controles).`,
        criterio: "«Vinieron a su control» de Reportes: controles que tocaban en el mes y se hicieron con su atención cerrada ÷ los que tocaban, a hoy.",
        nota: `El mes pasado (completo): ${show(last)} (${last.total.part ?? 0} de ${last.total.whole ?? 0}).`,
        datos: { mes: result.total, mesPasado: last.total },
      }
    },
    r94: async () => {
      const [row] = await tx.execute<{ people: number; controls: number; overdue: number }>(sql`
        select count(distinct f.patient_id)::int as people, count(*)::int as controls,
          count(distinct f.patient_id) filter (where f.status = 'pendiente' and f.due_at < now())::int as overdue
        from clinical_follow_up f ${joinPerson(sql`f.patient_id`)}
        where f.organization_id = ${ORG} and f.status in ('pendiente','programado') and pp.is_active`)
      return {
        respuesta: `Hoy ${row?.people ?? 0} pacientes tienen controles pendientes (${row?.controls ?? 0} en total); ${row?.overdue ?? 0} tienen uno vencido y sin cita.`,
        criterio: "Controles pendientes o programados (con cita), a hoy, de pacientes sin archivar.",
        datos: { row },
      }
    },
    r96: async () => {
      const result = await fig("pacientes_nuevos", "sede")
      const top = result.rows[0]
      return {
        respuesta: top
          ? `Este mes la sede con más pacientes nuevos es ${top.label}: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))}.`
          : "Este mes no llegaron pacientes nuevos.",
        criterio: "«Pacientes nuevos» de Reportes por sede, del mes en curso.",
        datos: { filas: result.rows },
      }
    },
    r97: async () => {
      const result = await fig("canceladas", "sede")
      const rows = [...result.rows].sort((a, b) => (b.value.value ?? -Infinity) - (a.value.value ?? -Infinity))
      return {
        respuesta: `Este mes la sede con más cancelaciones es ${rows[0]?.label ?? "—"}: ${listOf(rows.map((row) => ({ name: row.label, value: `${show(result, row.value.value)}, ${row.value.part ?? 0} de ${row.value.whole ?? 0}` })))}.`,
        criterio: "«Canceladas» de Reportes por sede: canceladas ÷ citas que ya pasaron, del mes en curso.",
        datos: { filas: result.rows },
      }
    },
    r98: async () => {
      const result = await fig("lo_que_deja", "sede")
      return {
        respuesta: `Este mes la sede que más deja es ${result.rows[0]?.label ?? "—"}: ${listOf(result.rows.map((row) => ({ name: row.label, value: show(result, row.value.value) })))} (lo cobrado menos comisiones y gastos registrados de cada sede). Puede faltar algún gasto que no se anotó.`,
        criterio: "«Lo que deja el mes» de Reportes por sede, del mes en curso.",
        datos: { filas: result.rows },
      }
    },
    r100: async () => {
      const [range] = await tx.execute<{ from: string; to: string }>(sql`
        select to_char(date_trunc('month', now() at time zone ${tz}) - interval '6 months', 'YYYY-MM-DD') as from,
          to_char(date_trunc('month', now() at time zone ${tz}) - interval '1 day', 'YYYY-MM-DD') as to`)
      const period = `${range?.from}..${range?.to}`
      const collected = await fig("cobrado", "sede", period)
      const attended = await fig("atendidas", "sede", period)
      const fresh = await fig("pacientes_nuevos", "sede", period)
      const occupied = await fig("agenda_ocupada", "sede", period)
      const of = (result: FigureResult, row: (typeof collected.rows)[number]) => result.rows.find((item) => item.key === row.key || item.label === row.label)?.value.value ?? null
      return {
        respuesta: `En los últimos 6 meses completos (${range?.from} a ${range?.to}): ${listOf(collected.rows.map((row) => ({ name: row.label, value: `${show(collected, row.value.value)} cobrados, ${show(attended, of(attended, row))} citas atendidas, ${show(fresh, of(fresh, row))} pacientes nuevos` })))}.`,
        criterio: "Los últimos 6 meses completos por sede: lo cobrado, las citas atendidas y los pacientes nuevos, con las cifras de Reportes.",
        nota: `Agenda ocupada en esos meses: ${listOf(occupied.rows.map((row) => ({ name: row.label, value: show(occupied, row.value.value) })))}.`,
        datos: { cobrado: collected.rows, atendidas: attended.rows, nuevos: fresh.rows, ocupada: occupied.rows },
      }
    },
  } satisfies Record<string, () => Promise<Answer>>)

  // --- Preguntas nuevas del dueño (eval/argos-owner.json): una carpeta por área --------------
  Object.assign(solve, ownerSolvers({ tx, org: ORG, now, scope, ctx, tz, money, fig, show, today, dayOf, monthStart, joinPerson, conceptName, conceptJoins, listOf }))

  const out: Array<Question & Answer> = []
  // `--only=f1,f2`: solo esas preguntas del banco.
  const only = arg("only", "").split(",").filter(Boolean)
  for (const question of bank.preguntas.filter((item) => !only.length || only.includes(item.id))) {
    const run = solve[question.id]
    if (!run) throw new Error(`Falta el cálculo de la pregunta ${question.id}`)
    out.push({ ...question, ...(await run()) })
  }
  return out
})

const jsonPath = arg("json", "")
if (jsonPath) writeFileSync(resolve(jsonPath), `${JSON.stringify({ calculado: now.toISOString(), org: ORG, respuestas: answers }, null, 2)}\n`)
for (const answer of answers) {
  console.log(`\n### ${answer.id} · ${answer.texto}${answer.espera === "trampa" ? " (trampa)" : ""}`)
  console.log(`- Respuesta: ${answer.respuesta}`)
  console.log(`- Cómo: ${answer.criterio}`)
  if (answer.nota) console.log(`- Nota: ${answer.nota}`)
}
process.exit(0)
