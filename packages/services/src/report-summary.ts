/**
 * Reportes › Resumen: cómo va el negocio en seis cifras, cada una con el
 * periodo anterior y su línea de 12 meses; lo cobrado por tramo con el año
 * anterior al lado, y una fila por profesional. Solo lecturas; ninguna cifra
 * sale de un modelo.
 *
 * Cada cifra es la misma consulta que su pestaña, calculada para varios tramos
 * a la vez (`spansSql`): el periodo, el anterior y los 12 meses de su línea.
 */
import type { Db } from "@odentia/db"
import { sql } from "drizzle-orm"
import { collectedByProfessional, collectedNetMany } from "./finance.js"
import { OVERDUE_DAYS, overdueDebtSql } from "./report-debts.js"
import { lastMonths, type ReportBucket, yearBefore } from "./report-periods.js"
import {
  at,
  bySpan,
  hullOf,
  type ReportQuery,
  reportHead,
  reportScope,
  safeCents,
  scopeBuckets,
  serializeBucket,
  type Span,
  spansSql,
} from "./report-scope.js"
import { appointmentTotalsMany, budgetLinesSql, newPatientsMany } from "./reports.js"
import { agentBookedMany, agentCollectedMany, agentRecoveredMany, collectedIn } from "./report-agent.js"
import { occupancyMany } from "./report-agenda.js"

/** Presupuestos presentados y cuántos de ellos se aceptaron (en todo o en parte), por tramo. */
export interface Acceptance {
  presented: number
  accepted: number
}

/**
 * Aceptación: de los presupuestos presentados en el tramo, cuántos tienen algo
 * aceptado, según su respuesta a hoy (`budgetLinesSql`). Uno aceptado en parte
 * cuenta como aceptado una sola vez. Son de la persona, no de una sede.
 */
export async function budgetAcceptanceMany(tx: Db, orgId: string, spans: Span[]): Promise<Acceptance[]> {
  const hull = hullOf(spans)
  const rows = await tx.execute<{ idx: number; presented: number; accepted: number }>(sql`
    ${budgetLinesSql(orgId, sql`b.presented_at >= ${at(hull.start)} and b.presented_at < ${at(hull.end)}`)}
    select s.idx, count(distinct bl.id)::int as presented,
      count(distinct bl.id) filter (where bl.accepted)::int as accepted
    from budget_line bl join ${spansSql(spans, "s")} on bl.presented_at >= s.start_at and bl.presented_at < s.end_at
    group by s.idx`)
  return bySpan(spans, [...rows], () => ({ presented: 0, accepted: 0 }), (_, row) => ({ presented: row.presented, accepted: row.accepted }))
}

/**
 * Citas que agendó el agente en cada tramo: las que se reservaron en su
 * conversación o desde su enlace (`AGENT_SOURCES`, como el cobro por acción),
 * por el día en que se reservaron. Las recuperadas son las acciones `cita` del
 * cobro por valor (ADR 0031), por el día en que se contaron, si la cita sigue
 * atendida. Son las mismas definiciones de Reportes › Agente (`report-agent.ts`).
 */
export async function agentBookingsMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<Array<{ booked: number; recovered: number }>> {
  const booked = await agentBookedMany(tx, orgId, branchId, spans)
  const recovered = await agentRecoveredMany(tx, orgId, branchId, spans)
  return spans.map((_, index) => ({ booked: booked[index]?.booked ?? 0, recovered: recovered[index] ?? 0 }))
}

/** Lo que debían hace más de `OVERDUE_DAYS` días en cada momento, por moneda, con cuántas personas. */
export async function overdueDebtMany(
  tx: Db,
  orgId: string,
  branchId: string | undefined,
  moments: Date[],
): Promise<Array<Array<{ currency: string; cents: number; people: number }>>> {
  const rows = await tx.execute<{ idx: number; currency: string; cents: string; people: number }>(sql`
    ${overdueDebtSql(orgId, moments, OVERDUE_DAYS, branchId)}
    select idx, currency, sum(owed)::text as cents, count(*)::int as people from overdue group by idx, currency`)
  return bySpan(
    moments.map((moment) => ({ start: moment, end: moment })),
    [...rows],
    (): Array<{ currency: string; cents: number; people: number }> => [],
    (list, row) => [...list, { currency: row.currency, cents: safeCents(row.cents), people: row.people }],
  )
}

function inCurrency<T extends { currency: string }>(list: T[] | undefined, currency: string): T | undefined {
  return list?.find((item) => item.currency === currency)
}

export async function getReportSummary(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  // El periodo, el anterior y los 12 meses que terminan en el último mes del periodo.
  const months: ReportBucket[] = lastMonths(scope.timezone, window.to, 12, window.end)
  const spans: Span[] = [window, window.previous, ...months]
  const [appointments, fresh, acceptance, collected, agent, debts] = [
    await appointmentTotalsMany(tx, orgId, scope, spans),
    await newPatientsMany(tx, orgId, scope, spans),
    await budgetAcceptanceMany(tx, orgId, spans),
    await collectedNetMany(tx, orgId, spans, { branchId }),
    await agentBookingsMany(tx, orgId, branchId, spans),
    await overdueDebtMany(tx, orgId, branchId, spans.map((span) => span.end)),
  ]
  const nth = <T>(list: T[], index: number): T => list[index] as T
  const monthsOf = <T, V>(list: T[], pick: (item: T) => V): V[] => list.slice(2).map(pick)
  const cents = (list: Array<{ currency: string; cents: number }> | undefined): number => inCurrency(list, currency)?.cents ?? 0
  // Lo cobrado en las citas del agente solo se dice del periodo (Reportes › Agente, decisión 5).
  const [agentCollected] = await agentCollectedMany(tx, orgId, branchId, [window])

  // Lo cobrado por tramo del periodo, con el mismo tramo un año antes.
  const buckets = scopeBuckets(scope)
  const before = buckets.map((bucket) => yearBefore(scope.timezone, bucket))
  const chart = await collectedNetMany(tx, orgId, [...buckets, ...before], { branchId })

  return {
    ...reportHead(scope),
    /** Los 12 meses de cada línea pequeña. */
    months: months.map(serializeBucket),
    collected: {
      currency,
      current: cents(nth(collected, 0)),
      previous: cents(nth(collected, 1)),
      months: monthsOf(collected, cents),
      /** Otras monedas del periodo, si las hubo: nunca se suman. */
      others: nth(collected, 0)
        .filter((item) => item.currency !== currency)
        .map((item) => ({ currency: item.currency, current: item.cents, previous: inCurrency(nth(collected, 1), item.currency)?.cents ?? 0 })),
    },
    newPatients: { current: nth(fresh, 0), previous: nth(fresh, 1), months: fresh.slice(2) },
    acceptance: { current: nth(acceptance, 0), previous: nth(acceptance, 1), months: acceptance.slice(2) },
    noShow: {
      current: { noShow: nth(appointments, 0).noShow, total: nth(appointments, 0).total },
      previous: { noShow: nth(appointments, 1).noShow, total: nth(appointments, 1).total },
      months: monthsOf(appointments, (item) => ({ noShow: item.noShow, total: item.total })),
    },
    agent: {
      /** `collectedCents`: lo cobrado en esas citas, en la moneda de la clínica. */
      current: { ...nth(agent, 0), collectedCents: agentCollected ? collectedIn(agentCollected, currency) : 0 },
      previous: nth(agent, 1),
      months: monthsOf(agent, (item) => item.booked),
    },
    overdue: {
      currency,
      days: OVERDUE_DAYS,
      current: inCurrency(nth(debts, 0), currency) ?? { currency, cents: 0, people: 0 },
      previous: inCurrency(nth(debts, 1), currency) ?? { currency, cents: 0, people: 0 },
      months: monthsOf(debts, cents),
    },
    /** Lo cobrado por tramo del periodo y el mismo tramo un año antes, en la moneda de la clínica. */
    chart: buckets.map((bucket, index) => ({
      ...serializeBucket(bucket),
      cents: cents(chart[index]),
      previousCents: cents(chart[buckets.length + index]),
    })),
    /** Presupuestos y deudas de la persona: no pertenecen a una sede. */
    wholeClinic: scope.branch ? (["acceptance"] as const) : ([] as const),
  }
}

/**
 * Reportes › Resumen › Por profesional: citas del periodo, presupuestos que
 * presentó y lo cobrado de lo que atendió (la misma base de las comisiones,
 * `collectedByProfessional`). Va aparte del Resumen para que sus cifras de
 * arriba no esperen a esta tabla, que es la consulta más pesada.
 */
export async function getReportProfessionals(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  const professionals = await tx.execute<{ userId: string; name: string; attended: number; noShow: number; total: number }>(sql`
    select a.dentist_user_id as "userId", u.name,
      count(*) filter (where a.status = 'atendida')::int as attended,
      count(*) filter (where a.status = 'no_asistio')::int as "noShow",
      count(*)::int as total
    from appointment a join "user" u on u.id = a.dentist_user_id
    where a.organization_id = ${orgId} and a.starts_at >= ${at(window.start)} and a.starts_at < ${at(window.end)}
      and (a.status in ('atendida','no_asistio','cancelada') or (a.status in ('programada','confirmada') and a.ends_at < ${at(now)}))
      ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    group by a.dentist_user_id, u.name`)
  const presentedBy = await tx.execute<{ userId: string; presented: number; accepted: number }>(sql`
    ${budgetLinesSql(orgId, sql`b.presented_at >= ${at(window.start)} and b.presented_at < ${at(window.end)}`)}
    select created_by as "userId", count(distinct id)::int as presented,
      count(distinct id) filter (where accepted)::int as accepted
    from budget_line where created_by is not null group by created_by`)
  const collectedBy = await collectedByProfessional(tx, orgId, { start: window.start, end: window.end, branchId }, currency)
  const rows = new Map<string, { userId: string; name: string; attended: number; noShow: number; total: number; presented: number; accepted: number; collectedCents: number }>()
  for (const row of professionals) rows.set(row.userId, { ...row, presented: 0, accepted: 0, collectedCents: 0 })
  for (const row of collectedBy) {
    const entry = rows.get(row.professionalUserId) ?? { userId: row.professionalUserId, name: row.name ?? "", attended: 0, noShow: 0, total: 0, presented: 0, accepted: 0, collectedCents: 0 }
    entry.collectedCents = row.cobradoCents
    rows.set(row.professionalUserId, entry)
  }
  // Los presupuestos solo cuentan para quien también atendió en el periodo: quien los prepara desde recepción no es un profesional de esta tabla.
  for (const row of presentedBy) {
    const entry = rows.get(row.userId)
    if (entry) Object.assign(entry, { presented: row.presented, accepted: row.accepted })
  }
  // «Ocupado»: la agenda ocupada de cada uno, la misma cuenta de Reportes › Agenda (decisión 4).
  const [occupancy] = await occupancyMany(tx, orgId, [{ start: window.start, end: window.end }], { branchId })
  const minutesOf = new Map((occupancy?.byProfessional ?? []).map((row) => [row.userId, row]))


  return {
    ...reportHead(scope),
    rows: [...rows.values()]
      .map((row) => ({ ...row, availMin: minutesOf.get(row.userId)?.availMin ?? 0, occMin: minutesOf.get(row.userId)?.occMin ?? 0 }))
      .sort((a, b) => b.collectedCents - a.collectedCents || b.attended - a.attended || a.name.localeCompare(b.name)),
  }
}
