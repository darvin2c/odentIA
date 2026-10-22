/** Respuestas correctas de los presupuestos (eval/argos-owner.json). */
import { budgetAwaitsAnswerSql, budgetLineUnitsSql, budgetValueOptionSql } from "@odentia/services"
import { type SQL, sql } from "drizzle-orm"
import type { GoldenHelpers, GoldenSolvers } from "./helpers.js"

type Waiting = {
  id: string
  patientId: string
  person: string
  number: number
  status: string
  presented: string
  days: number
  pending: string
  value: string
}

type Quoted = {
  name: string
  lines: number
  budgets: number
  accepted: number
  waiting: number
  cents: string
}

export function budgetSolvers(h: GoldenHelpers): GoldenSolvers {
  const { tx, org, now, scope, money, fig, show, listOf, monthStart, joinPerson } = h
  const nowIso = now.toISOString()
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000)
  const yearAgoIso = yearAgo.toISOString()
  const dayKey = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: h.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
  /** Los últimos 365 días hasta hoy, como periodo de Reportes. */
  const lastYear = `${dayKey(yearAgo)}..${dayKey(now)}`
  /** «octubre de 2026»: el mes en curso, con su nombre. */
  const month = new Intl.DateTimeFormat(scope.locale, { month: "long", year: "numeric", timeZone: h.tz }).format(now)
  const pct = (part: number, total: number): string => (total > 0 ? `${Math.round((part / total) * 100)} %` : "sin dato")
  const date = (iso: string) => new Intl.DateTimeFormat(scope.locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: h.tz }).format(new Date(iso))

  const budgetRef = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const awaits = budgetAwaitsAnswerSql({ status: sql`b.status`, id: sql`b.id`, organizationId: sql`b.organization_id` })
  const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
  /** Entregado: lo que se le presentó a la persona y no se sustituyó ni se canceló (la base de «Aceptaron su presupuesto»). */
  const delivered = sql`b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')`
  const presentedIn = (since: string) => sql`b.presented_at >= ${since}::timestamptz and b.presented_at < ${nowIso}::timestamptz`
  /** Las líneas de la opción que vale (la elegida o la recomendada), con precio. */
  const valueLines = sql`join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
    and i.option_id = ${budgetValueOptionSql(budgetRef)} and i.price_cents is not null`
  /** Línea aceptada de verdad: decidida «aceptado» en un presupuesto aceptado en todo o en parte. */
  const acceptedLine = sql`(b.status in ('aceptado','parcial') and i.decision = 'aceptado')`

  /** Presupuestos entregados en el periodo con su valor (la opción que vale) y lo aceptado de él. */
  const valued = (where: SQL) =>
    tx.execute<{ id: string; status: string; cents: string; accepted: string }>(sql`
      select b.id, b.status, sum(i.price_cents::bigint * ${units})::text as cents,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}), 0)::text as accepted
      from treatment_budget b ${valueLines}
      where b.organization_id = ${org} and ${delivered} and ${where}
      group by b.id, b.status`)

  /** Presupuestos que esperan respuesta hoy, con lo que falta decidir y su valor entero. */
  const awaiting = () =>
    tx.execute<Waiting>(sql`
      select b.id, b.patient_id as "patientId", pp.display_name as person, b.budget_number as number, b.status, b.presented_at::text as presented,
        floor(extract(epoch from now() - b.presented_at) / 86400)::int as days,
        coalesce(sum(i.price_cents::bigint * ${units}) filter (where i.decision in ('pendiente','pospuesto')), 0)::text as pending,
        sum(i.price_cents::bigint * ${units})::text as value
      from treatment_budget b ${valueLines} ${joinPerson(sql`b.patient_id`)}
      where b.organization_id = ${org} and ${awaits}
      group by b.id, b.patient_id, pp.display_name, b.budget_number, b.status, b.presented_at
      order by b.presented_at, b.budget_number`)

  /** Veces que se cotizó cada tratamiento en lo entregado del periodo y cuántas se aceptaron, a hoy. */
  const quoted = (since: string) =>
    tx.execute<Quoted>(sql`
      select coalesce(s.name, i.title) as name, count(*)::int as lines, count(distinct b.id)::int as budgets,
        count(*) filter (where ${acceptedLine})::int as accepted,
        count(*) filter (where i.decision in ('pendiente','pospuesto') and b.status in ('presentado','pospuesto','parcial'))::int as waiting,
        sum(i.price_cents::bigint * ${units})::text as cents
      from treatment_budget b ${valueLines}
      left join service_catalog s on s.organization_id = i.organization_id and s.id = i.service_id
      where b.organization_id = ${org} and ${delivered} and ${presentedIn(since)}
      group by 1 order by 2 desc, 1`)

  const sumOf = <T>(rows: readonly T[], pick: (row: T) => string | number) => rows.reduce((total, row) => total + Number(pick(row)), 0)

  return {
    b1: async () => {
      const result = await fig("aceptaron")
      const rows = await tx.execute<{ status: string; count: number }>(sql`
        select b.status, count(*)::int as count from treatment_budget b
        where b.organization_id = ${org} and b.presented_at is not null and ${presentedIn(monthStart)}
        group by 1 order by 2 desc, 1`)
      const [made] = await tx.execute<{ created: number; drafts: number }>(sql`
        select count(*)::int as created, count(*) filter (where b.status = 'borrador')::int as drafts from treatment_budget b
        where b.organization_id = ${org} and b.created_at >= ${monthStart}::timestamptz`)
      const value = await valued(presentedIn(monthStart))
      const of = (status: string) => rows.find((row) => row.status === status)?.count ?? 0
      const count = result.total.whole ?? 0
      const replaced = of("sustituido") + of("cancelado")
      return {
        respuesta: `En ${month} (hasta hoy) se entregaron ${count} presupuestos, por ${money(sumOf(value, (row) => row.cents))}: ${of("aceptado")} aceptados, ${of("parcial")} aceptados en parte, ${of("presentado")} enviados que esperan respuesta, ${of("pospuesto")} que «lo están pensando» y ${of("rechazado")} rechazados.`,
        criterio: "Presupuestos presentados a la persona en el mes en curso y vigentes (aceptado, parcial, presentado, pospuesto o rechazado; sin borradores, sustituidos ni cancelados): la base de «Aceptaron su presupuesto» de Reportes. El importe es el de la opción que vale.",
        nota: `Contando también los presentados este mes que luego se sustituyeron por una revisión o se cancelaron: ${count + replaced}. Creados este mes, entregados o no: ${made?.created ?? 0} (${made?.drafts ?? 0} ${made?.drafts === 1 ? "sigue" : "siguen"} en borrador).`,
        datos: { reportes: result.total, porEstado: rows, creados: made, valor: sumOf(value, (row) => row.cents) },
      }
    },

    b2: async () => {
      const result = await fig("aceptaron")
      const year = await fig("aceptaron", "total", lastYear)
      const value = await valued(presentedIn(monthStart))
      const full = value.filter((row) => row.status === "aceptado").length
      const decided = value.filter((row) => ["aceptado", "parcial", "rechazado"].includes(row.status)).length
      const accepted = result.total.part ?? 0
      const presented = result.total.whole ?? 0
      return {
        respuesta: `En ${month} (hasta hoy) se aceptó el ${show(result)} de los presupuestos entregados: ${accepted} de ${presented}, en todo o en parte (en los mismos días del mes anterior, ${show(result, result.previous?.value ?? null)}).`,
        criterio: "«Aceptaron su presupuesto» de Reportes: presupuestos entregados en el mes aceptados en todo o en parte ÷ entregados, según su respuesta a hoy.",
        nota: `Solo los aceptados enteros: ${pct(full, presented)} (${full} de ${presented}). Sin contar los que aún esperan respuesta: ${pct(accepted, decided)} (${accepted} de ${decided} ya decididos). Por dinero: se aceptó ${money(sumOf(value, (row) => row.accepted))} de ${money(sumOf(value, (row) => row.cents))} presupuestados (${pct(sumOf(value, (row) => row.accepted), sumOf(value, (row) => row.cents))}). En los últimos 12 meses: ${show(year)} (${year.total.part ?? 0} de ${year.total.whole ?? 0}).`,
        datos: { mes: result.total, anterior: result.previous, doceMeses: year.total, enteros: full, decididos: decided },
      }
    },

    b3: async () => {
      const rows = await awaiting()
      const pending = sumOf(rows, (row) => row.pending)
      const value = sumOf(rows, (row) => row.value)
      const coming = await fig("lo_que_viene")
      return {
        respuesta: `Hoy tienes ${money(pending)} en ${rows.length} presupuestos sin cerrar: los que esperan respuesta (enviados o «lo está pensando»), contando solo lo que falta decidir.`,
        criterio: "Presupuestos que esperan respuesta a hoy (budgetAwaitsAnswer: presentado, pospuesto o parcial con algo pospuesto); se suma lo aún no decidido de la opción que vale.",
        nota: `Con el valor entero de esos presupuestos (incluida la parte ya aceptada de los parciales): ${money(value)}. Lo ya aceptado que falta hacer («Lo que viene» de Reportes) es otra cosa: ${show(coming)}.`,
        datos: { presupuestos: rows.length, faltaDecidir: pending, valorEntero: value, loQueViene: coming.total },
      }
    },

    b4: async () => {
      const rows = await quoted(monthStart)
      const year = await quoted(yearAgoIso)
      const done = await tx.execute<{ name: string; times: number }>(sql`
        select coalesce(s.name, ep.description) as name, sum(ep.quantity)::int as times
        from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null
        left join service_catalog s on s.organization_id = ep.organization_id and s.id = ep.service_id
        where ep.organization_id = ${org} and ep.voided_at is null and e.started_at >= ${monthStart}::timestamptz and e.started_at < ${nowIso}::timestamptz
        group by 1 order by 2 desc, 1 limit 5`)
      return {
        respuesta: rows.length
          ? `En ${month} (hasta hoy) los tratamientos más presupuestados son ${listOf(rows.slice(0, 5).map((row) => ({ name: row.name, value: `${row.lines} ${row.lines === 1 ? "vez" : "veces"}` })))}, de ${rows.length} tratamientos distintos en los presupuestos entregados.`
          : `En ${month} todavía no se entregó ningún presupuesto.`,
        criterio: "Veces que aparece cada tratamiento en la opción que vale de los presupuestos entregados en el mes en curso (sin borradores, sustituidos ni cancelados).",
        nota: `En los últimos 12 meses: ${listOf(year.slice(0, 5).map((row) => ({ name: row.name, value: `${row.lines}` })))}. Si «solicitado» es lo que más se hizo este mes (atenciones firmadas): ${listOf(done.map((row) => ({ name: row.name, value: `${row.times}` })))}.`,
        datos: { mes: rows, doceMeses: year, realizados: done },
      }
    },

    b5: async () => {
      // «Se cotiza mucho»: al menos el 5 % de todo lo cotizado del periodo. «Se vende poco»: por debajo de la aceptación de toda la clínica.
      const weak = (rows: readonly Quoted[]) => {
        const lines = rows.reduce((total, row) => total + row.lines, 0)
        const accepted = rows.reduce((total, row) => total + row.accepted, 0)
        const rate = lines > 0 ? accepted / lines : 0
        const found = rows
          .filter((row) => row.lines >= Math.max(3, lines * 0.05) && row.accepted / row.lines < rate)
          .sort((a, b) => a.accepted / a.lines - b.accepted / b.lines || b.lines - a.lines || a.name.localeCompare(b.name))
        return { lines, accepted, rate, found }
      }
      const words = (list: readonly Quoted[]) =>
        listOf(list.map((row) => ({ name: row.name, value: `cotizado ${row.lines} veces, aceptado ${row.accepted}, ${pct(row.accepted, row.lines)}` })))
      const monthRows = await quoted(monthStart)
      const yearRows = await quoted(yearAgoIso)
      const current = weak(monthRows)
      const past = weak(yearRows)
      const waiting = monthRows.reduce((total, row) => total + row.waiting, 0)
      return {
        respuesta: current.found.length
          ? `En ${month} (hasta hoy) se cotizan mucho y se aceptan poco: ${words(current.found)}. En toda la clínica se acepta el ${pct(current.accepted, current.lines)} de lo cotizado (${current.accepted} de ${current.lines} tratamientos).`
          : `En ${month} ningún tratamiento cotizado a menudo se acepta menos que el promedio de la clínica (${pct(current.accepted, current.lines)}).`,
        criterio: "Tratamientos de la opción que vale en los presupuestos entregados del mes en curso, a hoy: «mucho» = al menos el 5 % de lo cotizado (y 3 veces); «poco» = aceptados ÷ cotizados por debajo de la aceptación de toda la clínica. De menor a mayor aceptación.",
        nota: `En los últimos 12 meses (más casos): ${words(past.found)}, contra el ${pct(past.accepted, past.lines)} de la clínica (${past.accepted} de ${past.lines}). Este mes ${waiting} de los ${current.lines} tratamientos cotizados todavía esperan respuesta: cuentan como no vendidos hasta que se decidan.`,
        datos: { mes: monthRows, doceMeses: yearRows },
      }
    },

    b6: async () => {
      const rows = await awaiting()
      const people = new Map<string, { person: string; budgets: number[]; pending: number; since: string }>()
      for (const row of rows) {
        const entry = people.get(row.patientId) ?? { person: row.person, budgets: [], pending: 0, since: row.presented }
        entry.budgets.push(row.number)
        entry.pending += Number(row.pending)
        if (row.presented < entry.since) entry.since = row.presented
        people.set(row.patientId, entry)
      }
      const list = [...people.values()].sort((a, b) => a.since.localeCompare(b.since))
      const byMoney = [...list].sort((a, b) => b.pending - a.pending || a.since.localeCompare(b.since))
      return {
        respuesta: list.length
          ? `Hoy ${list.length} pacientes tienen ${rows.length} presupuestos esperando respuesta, por ${money(sumOf(rows, (row) => row.pending))} sin decidir. Los que esperan hace más tiempo: ${listOf(list.slice(0, 5).map((row) => ({ name: row.person, value: `N.º ${row.budgets.join(", ")}, ${money(row.pending)}, desde el ${date(row.since)}` })))}.`
          : "Hoy ningún presupuesto espera respuesta.",
        criterio: "La regla «espera respuesta» de odentIA (budgetAwaitsAnswer: enviado, «lo está pensando» o aceptado en parte con algo pospuesto), a hoy, por paciente y del más antiguo.",
        nota: `Por lo que falta decidir: ${listOf(byMoney.slice(0, 5).map((row) => ({ name: row.person, value: money(row.pending) })))}.`,
        datos: { pacientes: list, presupuestos: rows.length },
      }
    },

    b7: async () => {
      const stats = (where: SQL) =>
        tx.execute<{ budgets: number; average: number | null; median: number | null; acceptedAverage: number | null; acceptedBudgets: number }>(sql`
          with v as (
            select b.id, b.status, sum(i.price_cents::bigint * ${units}) as cents,
              sum(i.price_cents::bigint * ${units}) filter (where ${acceptedLine}) as accepted
            from treatment_budget b ${valueLines}
            where b.organization_id = ${org} and ${delivered} and ${where}
            group by b.id, b.status)
          select count(*)::int as budgets, avg(cents)::float as average, percentile_cont(0.5) within group (order by cents)::float as median,
            avg(accepted) filter (where status in ('aceptado','parcial'))::float as "acceptedAverage",
            count(*) filter (where status in ('aceptado','parcial'))::int as "acceptedBudgets"
          from v`)
      const [current] = await stats(presentedIn(monthStart))
      const [year] = await stats(presentedIn(yearAgoIso))
      return {
        respuesta: `En ${month} (hasta hoy) un presupuesto entregado vale en promedio ${money(current?.average ?? 0)} (${current?.budgets ?? 0} presupuestos).`,
        criterio: "Presupuestos entregados en el mes en curso (sin borradores, sustituidos ni cancelados): el total de la opción que vale (precio acordado × visitas en lo que se cobra por sesión), en promedio.",
        nota: `Mediana: ${money(current?.median ?? 0)}. Lo aceptado de los ${current?.acceptedBudgets ?? 0} aceptados en todo o en parte: ${money(current?.acceptedAverage ?? 0)} en promedio. En los últimos 12 meses: ${money(year?.average ?? 0)} en ${year?.budgets ?? 0} presupuestos (mediana ${money(year?.median ?? 0)}).`,
        datos: { mes: current, doceMeses: year },
      }
    },

    b8: async () => {
      const result = await fig("aceptaron", "profesional")
      const year = await fig("aceptaron", "profesional", lastYear)
      const byRate = (rows: typeof result.rows) =>
        [...rows].sort((a, b) => (b.value.value ?? -1) - (a.value.value ?? -1) || (b.value.whole ?? 0) - (a.value.whole ?? 0) || a.label.localeCompare(b.label))
      const words = (rows: typeof result.rows, figure: typeof result) =>
        listOf(rows.map((row) => ({ name: row.label, value: `${show(figure, row.value.value)}, ${row.value.part ?? 0} de ${row.value.whole ?? 0}` })))
      const rows = byRate(result.rows)
      const top = rows[0]
      return {
        respuesta: top
          ? `En ${month} (hasta hoy) la mayor tasa de aceptación es de ${top.label}: ${show(result, top.value.value)} (${top.value.part ?? 0} de ${top.value.whole ?? 0} presupuestos que presentó). Le siguen ${words(rows.slice(1), result)}.`
          : `En ${month} ningún odontólogo presentó presupuestos.`,
        criterio: "«Aceptaron su presupuesto» de Reportes por profesional, del mes en curso: los presupuestos que preparó cada uno, entregados en el mes y aceptados en todo o en parte, a hoy.",
        nota: `Con pocos presupuestos por persona en un mes, los últimos 12 meses: ${words(byRate(year.rows), year)}.`,
        datos: { mes: result.rows, doceMeses: year.rows },
      }
    },

    b9: async () => {
      const rows = await awaiting()
      const pending = sumOf(rows, (row) => row.pending)
      const value = sumOf(rows, (row) => row.value)
      const [rejected] = await tx.execute<{ budgets: number; cents: string }>(sql`
        select count(distinct b.id)::int as budgets, coalesce(sum(i.price_cents::bigint * ${units}), 0)::text as cents
        from treatment_budget b ${valueLines}
        where b.organization_id = ${org} and b.status = 'rechazado' and ${presentedIn(yearAgoIso)}`)
      const lost = Number(rejected?.cents ?? 0)
      return {
        respuesta: `odentIA no emite facturas, solo tickets de pago; hablo de dinero que se podría cobrar. Hoy ${rows.length} presupuestos esperan respuesta con ${money(pending)} por decidir: recuperar el 20 % serían unos ${money(Math.round(pending * 0.2))}.`,
        criterio: "20 % de lo que falta decidir en los presupuestos que esperan respuesta a hoy (la opción que vale, sin lo ya aceptado ni rechazado).",
        nota: `Sobre el valor entero de esos presupuestos (incluida la parte ya aceptada de los parciales, ${money(value)}): ${money(Math.round(value * 0.2))}. Si «recuperar» incluye los ${rejected?.budgets ?? 0} rechazados de los últimos 12 meses (${money(lost)}), el 20 % de ambos sería ${money(Math.round((pending + lost) * 0.2))}.`,
        datos: { presupuestos: rows.length, faltaDecidir: pending, valorEntero: value, rechazadosDoceMeses: rejected },
      }
    },

    b10: async () => {
      const rows = await awaiting()
      const byMoney = [...rows].sort((a, b) => Number(b.pending) - Number(a.pending) || a.presented.localeCompare(b.presented))
      const words = (list: readonly Waiting[]) =>
        listOf(list.map((row) => ({ name: `${row.person} · N.º ${row.number}`, value: `${money(Number(row.pending))}, hace ${row.days} ${row.days === 1 ? "día" : "días"}` })))
      return {
        respuesta: rows.length
          ? `Por lo que falta decidir, prioriza estos ${Math.min(5, rows.length)} de los ${rows.length} que esperan respuesta: ${words(byMoney.slice(0, 5))}.`
          : "Hoy ningún presupuesto espera respuesta.",
        criterio: "Presupuestos que esperan respuesta a hoy (budgetAwaitsAnswer), ordenados por lo que falta decidir de la opción que vale, de más a menos; a igual monto, el más antiguo.",
        nota: `Por antigüedad (los que más esperan): ${words(rows.slice(0, 5))}. De los presentados en los últimos 30 días, por lo que falta decidir: ${words(byMoney.filter((row) => row.days <= 30).slice(0, 5))}.`,
        datos: { porMonto: byMoney, porAntiguedad: rows },
      }
    },
  }
}
