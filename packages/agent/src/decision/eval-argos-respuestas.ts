/**
 * Las respuestas correctas del examen de Argos (issue 192, fase 0) sobre la
 * base de desarrollo con su semilla. Uso:
 *
 *   pnpm --filter @odentia/agent eval:argos-respuestas [-- --file=eval/argos-examen.json --org=seed-org-dental-smile --json=salida.json]
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
  budgetAwaitsAnswerSql,
  budgetLineUnitsSql,
  budgetValueOptionSql,
  computeFigure,
  type FigureContext,
  type FigureGroup,
  type FigureResult,
  formatFigure,
  getReportList,
  getReportPromotions,
  listProducts,
  listPromotions,
  reportScope,
} from "@odentia/services"
import { sql } from "drizzle-orm"

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
      const rows = await tx.execute<{ name: string; units: number; cents: string; paid: string }>(sql`
        select pr.name, sum(c.product_quantity)::int as units, sum(c.amount_cents)::text as cents,
          coalesce(sum((select sum(a.amount_cents) from patient_payment_application a where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null)), 0)::text as paid
        from patient_charge c join product pr on pr.organization_id = c.organization_id and pr.id = c.product_id
        where c.organization_id = ${ORG} and c.voided_at is null
        group by 1 order by sum(c.product_quantity) desc, sum(c.amount_cents) desc, 1`)
      const top = rows[0]
      return {
        respuesta: top
          ? `Tu producto más vendido es ${top.name}: ${top.units} vendidos por ${money(Number(top.cents))}. Le sigue ${listOf(rows.slice(1, 3).map((row) => ({ name: row.name, value: `${row.units}` })))}.`
          : "Todavía no vendiste productos.",
        criterio: "Productos vendidos en Caja desde siempre (no tratamientos), sin anulados y descontando lo devuelto.",
        datos: { productos: rows },
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
          group by 1 order by 2 desc, 1 limit 5`)
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
          where a.organization_id = ${ORG} and a.status = 'atendida' group by 1)
        select count(*) filter (where at < now() - interval '90 days')::int as all,
          count(*) filter (where at < now() - interval '90 days' and not exists (
            select 1 from appointment n where n.organization_id = ${ORG} and n.patient_id = last.patient_id
              and n.starts_at > now() and n.status in ('programada','confirmada')))::int as unbooked
        from last`)
      return {
        respuesta: `${row?.all ?? 0} pacientes no han vuelto en los últimos 90 días; de ellos, ${row?.unbooked ?? 0} no tienen cita por venir.`,
        criterio: "Pacientes con al menos una cita atendida cuya última fue hace más de 90 días.",
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

  const out: Array<Question & Answer> = []
  for (const question of bank.preguntas) {
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
