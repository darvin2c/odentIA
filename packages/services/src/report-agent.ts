/**
 * Reportes › Agente: lo que hizo el agente en el periodo, lo que se pagó por
 * él a odentIA, lo cobrado en las citas que agendó y cómo se respondió a quien
 * escribió (lo que antes era la pestaña «Atención»). Solo lecturas; ninguna
 * cifra sale de un modelo.
 *
 * - Lo que hizo: conversaciones con una respuesta suya, citas que reservó (en
 *   su conversación o desde su enlace, `AGENT_SOURCES`), citas recuperadas y
 *   consultas dictadas confirmadas. Las dos últimas son las acciones del cobro
 *   por valor (ADR 0031), contadas el día en que se contaron.
 * - Lo pagado: las mismas cuentas de Facturación. El estado de cada acción
 *   (prueba, crédito, por encima del crédito…) lo da `listPeriodActions` sobre
 *   su tramo de la suscripción entero, y el periodo toma las que caen en él.
 *   En la moneda del plan, sin convertir.
 * - Lo cobrado en sus citas: los pagos aplicados a los cargos de su atención,
 *   en la moneda de la clínica. No es lo que «ganó» el agente (decisión 5):
 *   quizá esos pacientes habrían venido igual.
 *
 * Cada cifra se calcula para varios tramos en una sola consulta (`spansSql`):
 * el periodo, el anterior y los 12 meses de su línea.
 */
import type { Db } from "@odentia/db"
import { saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { eq, sql, type SQL } from "drizzle-orm"
import { lastMonths } from "./report-periods.js"
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
import type { ReportListRow } from "./reports.js"
import {
  AGENT_SOURCES,
  currentSaasPeriod,
  getActionPricing,
  listPeriodActions,
  microsToCents,
  netMicros,
  type SaasActionRow,
  type SaasPeriod,
  saasTaxOf,
} from "./saas-actions.js"
import { addMonth } from "./saas-invoicing.js"

const agentSources = (): SQL =>
  sql.join(
    AGENT_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )

/** Una respuesta que el canal aceptó: los envíos de prueba y los que no salieron no cuentan. */
const accepted = (alias: string): SQL =>
  sql.raw(`${alias}.status in ('sent','delivered','read') and coalesce(${alias}.external_id, '') not like 'mock-%'`)

// --- Lo que hizo ----------------------------------------------------------------------------

export interface AgentConversations {
  /** Conversaciones con al menos una respuesta del agente en el tramo. */
  attended: number
  /** De ellas, las que no tuvieron mensajes del equipo ni paso al equipo en el tramo. */
  alone: number
}

/** Conversaciones que atendió el agente en cada tramo. Son de toda la clínica: no tienen sede. */
export async function agentConversationsMany(tx: Db, orgId: string, spans: Span[]): Promise<AgentConversations[]> {
  const hull = hullOf(spans)
  const rows = await tx.execute<{ idx: number; attended: number; alone: number }>(sql`
    select x.idx, count(*)::int as attended, count(*) filter (where not x.team)::int as alone
    from (
      select b.idx, m.conversation_id,
        exists (
          select 1 from message t where t.organization_id = ${orgId} and t.conversation_id = m.conversation_id
            and t.direction = 'out' and t.sender_kind = 'user' and t.created_at >= b.start_at and t.created_at < b.end_at
        ) or exists (
          select 1 from agent_handoff h where h.organization_id = ${orgId} and h.conversation_id = m.conversation_id
            and h.created_at >= b.start_at and h.created_at < b.end_at
        ) as team
      from ${spansSql(spans)}
      join message m on m.organization_id = ${orgId} and m.created_at >= b.start_at and m.created_at < b.end_at
        and m.created_at >= ${at(hull.start)} and m.created_at < ${at(hull.end)}
        and m.direction = 'out' and m.sender_kind = 'agent' and ${accepted("m")}
      group by b.idx, b.start_at, b.end_at, m.conversation_id
    ) x
    group by x.idx`)
  return bySpan(spans, [...rows], () => ({ attended: 0, alone: 0 }), (_, row) => ({ attended: row.attended, alone: row.alone }))
}

export type AgentBooked = {
  /** Citas que reservó el agente (en su conversación o desde su enlace), por el día en que se reservaron. */
  booked: number
  /** De ellas, las que ya están atendidas. */
  attended: number
  /** Todas las citas reservadas en el tramo, por quien sea: la base de su parte. */
  all: number
}

export async function agentBookedMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<AgentBooked[]> {
  const rows = await tx.execute<{ idx: number } & AgentBooked>(sql`
    select b.idx,
      count(*) filter (where a.source in (${agentSources()}))::int as booked,
      count(*) filter (where a.source in (${agentSources()}) and a.status = 'atendida')::int as attended,
      count(*)::int as "all"
    from ${spansSql(spans)}
    join appointment a on a.organization_id = ${orgId} and a.created_at >= b.start_at and a.created_at < b.end_at
      ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    group by b.idx`)
  return bySpan(spans, [...rows], () => ({ booked: 0, attended: 0, all: 0 }), (_, row) => ({ booked: row.booked, attended: row.attended, all: row.all }))
}

/**
 * Citas recuperadas: las acciones `cita` del cobro por valor (ADR 0031), por
 * el día en que se contaron, que el cobro no anuló: si se deshizo la
 * asistencia, `listPeriodActions` la anula y aquí tampoco cuenta. Con una sede
 * elegida, solo las de citas de esa sede.
 */
function recoveredSql(orgId: string, spans: Span[], branchId: string | undefined): SQL {
  return sql`
    select b.idx, x.appointment_id
    from ${spansSql(spans)}
    join saas_action x on x.organization_id = ${orgId} and x.kind = 'cita' and x.occurred_at >= b.start_at and x.occurred_at < b.end_at
    left join appointment a on a.organization_id = x.organization_id and a.id = x.appointment_id
    where (x.appointment_id is null or a.status = 'atendida') ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}`
}

export async function agentRecoveredMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    select r.idx, count(*)::int as count from (${recoveredSql(orgId, spans, branchId)}) r group by r.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

/** Consultas dictadas y confirmadas por el odontólogo: las acciones `consulta`, por el día en que se cerró la atención. */
export async function agentDictatedMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    select b.idx, count(*)::int as count
    from ${spansSql(spans)}
    join saas_action x on x.organization_id = ${orgId} and x.kind = 'consulta' and x.occurred_at >= b.start_at and x.occurred_at < b.end_at
    ${branchId ? sql`join encounter e on e.organization_id = x.organization_id and e.id = x.encounter_id and e.branch_id = ${branchId}` : sql``}
    group by b.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

/** Las conversaciones que el agente pasó al equipo en cada tramo (una por conversación). */
export async function agentHandoffsMany(tx: Db, orgId: string, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    select b.idx, count(distinct coalesce(h.conversation_id, h.id))::int as count
    from ${spansSql(spans)}
    join agent_handoff h on h.organization_id = ${orgId} and h.created_by = 'agent' and h.created_at >= b.start_at and h.created_at < b.end_at
    group by b.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

// --- Lo cobrado en sus citas ----------------------------------------------------------------

/**
 * Lo pagado por una cita, por moneda: los pagos aplicados a los cargos de su
 * atención cerrada, sin lo anulado y descontando lo devuelto en proporción a
 * lo que cada pago aplicó a esos cargos. `appointments` es una consulta que
 * entrega `appointment_id`.
 */
function appointmentPaidSql(orgId: string, appointments: SQL): SQL {
  return sql`
    select e.appointment_id, c.currency,
      sum(pa.amount_cents - least(pa.amount_cents, round(pa.amount_cents * coalesce(rf.cents, 0)::numeric / nullif(p.amount_cents, 0))))::bigint as cents
    from encounter e
    join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id and ep.voided_at is null
    join patient_charge c on c.organization_id = e.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null
    join patient_payment_application pa on pa.organization_id = e.organization_id and pa.charge_id = c.id and pa.voided_at is null
    join patient_payment p on p.organization_id = e.organization_id and p.id = pa.payment_id and p.voided_at is null
    left join lateral (
      select sum(r.amount_cents) as cents from patient_payment_refund r where r.organization_id = p.organization_id and r.payment_id = p.id
    ) rf on true
    where e.organization_id = ${orgId} and e.status = 'finalizada' and e.voided_at is null
      and e.appointment_id in (${appointments})
    group by e.appointment_id, c.currency`
}

export interface AgentCollected {
  /** Citas que agendó en el tramo y ya vinieron, sin las recuperadas del tramo. */
  booked: { visits: number; byCurrency: Array<{ currency: string; cents: number }> }
  /** Citas recuperadas del tramo. */
  recovered: { visits: number; byCurrency: Array<{ currency: string; cents: number }> }
}

/**
 * Lo cobrado en las citas del agente en cada tramo: las que reservó en el
 * tramo y las recuperadas del tramo, cada cita una sola vez (la recuperada va
 * en su línea). Lo pagado hasta hoy, por moneda: nunca se suman monedas.
 */
export async function agentCollectedMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<AgentCollected[]> {
  const rows = await tx.execute<{ idx: number; recovered: boolean; appointment_id: string; currency: string | null; cents: string | null }>(sql`
    with cohort as (
      select u.idx, u.appointment_id, bool_or(u.recovered) as recovered from (
        select b.idx, a.id as appointment_id, false as recovered
        from ${spansSql(spans)}
        join appointment a on a.organization_id = ${orgId} and a.created_at >= b.start_at and a.created_at < b.end_at
          and a.source in (${agentSources()}) and a.status = 'atendida'
          ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
        union all
        select r.idx, r.appointment_id, true from (${recoveredSql(orgId, spans, branchId)}) r where r.appointment_id is not null
      ) u
      group by u.idx, u.appointment_id
    ), paid as (${appointmentPaidSql(orgId, sql`select appointment_id from cohort`)})
    select k.idx, k.recovered, k.appointment_id, p.currency, p.cents::text as cents
    from cohort k left join paid p on p.appointment_id = k.appointment_id`)
  const out: AgentCollected[] = spans.map(() => ({ booked: { visits: 0, byCurrency: [] }, recovered: { visits: 0, byCurrency: [] } }))
  const seen = new Set<string>()
  for (const row of rows) {
    const entry = out[Number(row.idx)]
    if (!entry) continue
    const part = row.recovered ? entry.recovered : entry.booked
    const key = `${row.idx}:${row.appointment_id}`
    if (!seen.has(key)) {
      seen.add(key)
      part.visits += 1
    }
    if (row.currency === null || row.cents === null) continue
    const found = part.byCurrency.find((item) => item.currency === row.currency)
    if (found) found.cents += safeCents(row.cents)
    else part.byCurrency.push({ currency: row.currency, cents: safeCents(row.cents) })
  }
  return out
}

/** Lo cobrado en una moneda, sumando las dos líneas: lo que dice el Resumen junto a la cifra. */
export function collectedIn(collected: AgentCollected, currency: string): number {
  const of = (list: Array<{ currency: string; cents: number }>) => list.find((item) => item.currency === currency)?.cents ?? 0
  return of(collected.booked.byCurrency) + of(collected.recovered.byCurrency)
}

// --- Lo pagado a odentIA --------------------------------------------------------------------

type Tramo = SaasPeriod & { creditCents: number }

/**
 * Los tramos de la suscripción que tocan `hull`, enteros: el que corre hoy
 * (`currentSaasPeriod`, el mismo de Facturación); antes, los meses desde que
 * se activó el plan (cada uno empieza el mismo día, como los cierra el
 * cobro), la prueba y, donde no hubo nada de eso, meses calendario, como hace
 * `currentSaasPeriod` sin suscripción. Nada antes de la primera acción.
 */
async function saasTramos(tx: Db, orgId: string, hull: Span, now: Date): Promise<Tramo[]> {
  const [first] = await tx.execute<{ at: string | null }>(sql`select min(occurred_at)::text as at from saas_action where organization_id = ${orgId}`)
  if (!first?.at) return []
  const from = new Date(Math.max(hull.start.getTime(), new Date(first.at).getTime()))
  const current = await currentSaasPeriod(tx, orgId, now)
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  const pricing = await getActionPricing(tx, orgId)
  const past: Tramo[] = []
  if (sub?.activatedAt && sub.activatedAt < current.start) {
    let start = sub.activatedAt
    let end = addMonth(start)
    while (start < current.start) {
      past.push({ start, end: end < current.start ? end : current.start, credit: "mes", creditCents: pricing.creditCents })
      start = end
      end = addMonth(end)
    }
  }
  if (sub?.trialStartedAt && current.credit !== "prueba") {
    const ends = [sub.trialEndsAt ?? sub.activatedAt ?? current.start, sub.activatedAt ?? current.start, current.start]
    const end = new Date(Math.min(...ends.map((date) => date.getTime())))
    if (sub.trialStartedAt < end) {
      const [plan] = pricing.planId ? await tx.select({ trialCreditCents: saasPlan.trialCreditCents }).from(saasPlan).where(eq(saasPlan.id, pricing.planId)).limit(1) : []
      past.push({ start: sub.trialStartedAt, end, credit: "prueba", creditCents: sub.trialCreditCents ?? plan?.trialCreditCents ?? 0 })
    }
  }
  // Lo que no cubre ningún tramo se cuenta por mes calendario.
  past.sort((a, b) => a.start.getTime() - b.start.getTime())
  const gaps: Tramo[] = []
  let cursor = from
  const fill = (until: Date) => {
    while (cursor < until) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
      const start = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1))
      gaps.push({ start: start < cursor ? cursor : start, end: next < until ? next : until, credit: "mes", creditCents: pricing.creditCents })
      cursor = next < until ? next : until
    }
  }
  for (const tramo of past) {
    if (tramo.end <= cursor) continue
    fill(tramo.start)
    cursor = tramo.end
  }
  fill(current.start)
  return [...past, ...gaps, current].filter((tramo) => tramo.end > from && tramo.start < hull.end)
}

export interface AgentBillingLine {
  kind: "conversacion" | "consulta" | "cita"
  count: number
  /** Precio de cada una si todas lo comparten (un cambio de precio a mitad de mes deja varios). */
  unitMicros: number | null
  amountCents: number
}

export interface AgentBilling {
  /** Moneda del plan de odentIA (no la de la clínica). */
  currency: string | null
  /** Acciones pagadas (con el crédito del plan o por encima), por tipo, a su precio. */
  lines: AgentBillingLine[]
  /** Conversaciones ya cobradas que devuelven las citas recuperadas. */
  refunds: { count: number; amountCents: number }
  /** Lo que costaron: las líneas menos la devolución. */
  totalCents: number
  /** De ese total, lo que cubrió el crédito del plan y lo que se cobró por encima (lo que la factura suma a la cuota). */
  coveredCents: number
  overCents: number
  /** Lo que salió del saldo de prueba, de regalo: no es parte de lo pagado. */
  trial: { count: number; amountCents: number }
  /** Acciones contadas sin precio (el plan aún no lo tenía). */
  unpriced: number
  /** Cuántos meses del plan toca el tramo: cada uno trae su crédito (el mes del plan empieza el día que se activó). */
  planMonths: number
  /** Cuándo empieza el primero de esos meses (ISO): de ahí el día en que se renueva el crédito. */
  planStart: string | null
}

const KINDS = ["conversacion", "consulta", "cita"] as const

/**
 * Lo pagado por el agente en un conjunto de acciones, con la aritmética de la
 * factura (`issueCycleCharge`): cada línea redondea su suma al centavo y la
 * devolución va aparte, restando.
 */
function billingOf(rows: SaasActionRow[], currency: string | null, plan: Tramo[]): AgentBilling {
  const paid = rows.filter((row) => row.state === "credito" || row.state === "sobre_credito")
  const over = paid.filter((row) => row.state === "sobre_credito")
  const gross = (list: SaasActionRow[], kind: string): number => microsToCents(list.filter((row) => row.kind === kind).reduce((sum, row) => sum + (row.priceMicros ?? 0), 0))
  const refunded = (list: SaasActionRow[]): number => microsToCents(list.reduce((sum, row) => sum + (row.priceMicros ?? 0) - netMicros(row), 0))
  const lines = KINDS.map((kind) => {
    const ofKind = paid.filter((row) => row.kind === kind)
    const prices = new Set(ofKind.map((row) => row.priceMicros))
    return { kind, count: ofKind.length, unitMicros: prices.size === 1 ? (ofKind[0]?.priceMicros ?? null) : null, amountCents: gross(paid, kind) }
  })
  const refunds = { count: paid.reduce((sum, row) => sum + row.refunds.length, 0), amountCents: refunded(paid) }
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0) - refunds.amountCents
  const overCents = KINDS.reduce((sum, kind) => sum + gross(over, kind), 0) - refunded(over)
  const trial = rows.filter((row) => row.state === "prueba")
  return {
    currency,
    lines,
    refunds,
    totalCents,
    coveredCents: totalCents - overCents,
    overCents,
    trial: { count: trial.length, amountCents: microsToCents(trial.reduce((sum, row) => sum + netMicros(row), 0)) },
    unpriced: rows.filter((row) => row.state === "sin_precio").length,
    planMonths: plan.length,
    planStart: plan[0]?.start.toISOString() ?? null,
  }
}

/**
 * Lo pagado por el agente en cada tramo: las acciones que ocurrieron en él,
 * cada una con el estado que le da su tramo de la suscripción entero
 * (`listPeriodActions`, la única definición de Facturación y del cobro). Para
 * un tramo que es el mes de la suscripción, lo que pasó del crédito es lo que
 * la factura de ese mes suma a la cuota. De toda la clínica.
 */
export async function agentBillingMany(tx: Db, orgId: string, spans: Span[], now: Date = new Date()): Promise<AgentBilling[]> {
  const tramos = await saasTramos(tx, orgId, hullOf(spans), now)
  const rows: SaasActionRow[] = []
  for (const tramo of tramos) rows.push(...(await listPeriodActions(tx, orgId, tramo)))
  const { currency } = await getActionPricing(tx, orgId)
  return spans.map((span) =>
    billingOf(
      rows.filter((row) => row.occurredAt >= span.start && row.occurredAt < span.end),
      currency,
      tramos
        .filter((tramo) => tramo.credit === "mes" && tramo.end > span.start && tramo.start < span.end)
        .sort((a, b) => a.start.getTime() - b.start.getTime()),
    ),
  )
}

// --- Cómo respondimos -----------------------------------------------------------------------

export type FirstResponses = {
  /** Conversaciones cuyo primer mensaje de la persona cae en el tramo. */
  conversations: number
  responded: number
  byAgent: number
  byTeam: number
  /** Mediana en segundos hasta la primera respuesta, del agente y del equipo por separado; null sin respuestas medidas. */
  agentMedianSeconds: number | null
  teamMedianSeconds: number | null
}

/**
 * Primera respuesta: del primer mensaje de la persona a la primera respuesta
 * aceptada por el canal (la misma regla de la antigua «Atención»), con
 * mediana en vez de promedio: unas pocas respuestas de horas no la mueven.
 */
function firstResponseCohortSql(orgId: string, spans: Span[]): SQL {
  return sql`
    with first_inbound as (
      select distinct on (conversation_id) conversation_id, created_at
      from message where organization_id = ${orgId} and direction = 'in'
      order by conversation_id, created_at, id
    ), cohort as (
      select b.idx, i.conversation_id, i.created_at, r.sent_at, r.id as response_id, r.sender_kind, cc.channel
      from ${spansSql(spans)}
      join first_inbound i on i.created_at >= b.start_at and i.created_at < b.end_at
      join conversation c on c.id = i.conversation_id and c.organization_id = ${orgId}
      left join channel_connection cc on cc.id = c.channel_connection_id and cc.organization_id = ${orgId}
      left join lateral (
        select m.id, m.sent_at, m.sender_kind from message m
        where m.organization_id = ${orgId} and m.conversation_id = i.conversation_id
          and m.direction = 'out' and ${accepted("m")} and m.created_at >= i.created_at
        order by coalesce(m.sent_at, m.created_at), m.id limit 1
      ) r on true
    )`
}

export async function firstResponsesMany(tx: Db, orgId: string, spans: Span[]): Promise<FirstResponses[]> {
  const rows = await tx.execute<{ idx: number } & FirstResponses>(sql`
    ${firstResponseCohortSql(orgId, spans)}
    select idx, count(*)::int as conversations, count(response_id)::int as responded,
      count(*) filter (where sender_kind = 'agent')::int as "byAgent",
      count(*) filter (where response_id is not null and sender_kind <> 'agent')::int as "byTeam",
      percentile_cont(0.5) within group (order by extract(epoch from (sent_at - created_at)))
        filter (where sender_kind = 'agent' and sent_at >= created_at)::float8 as "agentMedianSeconds",
      percentile_cont(0.5) within group (order by extract(epoch from (sent_at - created_at)))
        filter (where response_id is not null and sender_kind <> 'agent' and sent_at >= created_at)::float8 as "teamMedianSeconds"
    from cohort group by idx`)
  return bySpan(
    spans,
    [...rows],
    (): FirstResponses => ({ conversations: 0, responded: 0, byAgent: 0, byTeam: 0, agentMedianSeconds: null, teamMedianSeconds: null }),
    (_, row) => ({
      conversations: row.conversations,
      responded: row.responded,
      byAgent: row.byAgent,
      byTeam: row.byTeam,
      agentMedianSeconds: row.agentMedianSeconds === null ? null : Math.round(Number(row.agentMedianSeconds)),
      teamMedianSeconds: row.teamMedianSeconds === null ? null : Math.round(Number(row.teamMedianSeconds)),
    }),
  )
}

/** Por dónde escribieron quienes empezaron a conversar en el tramo. */
async function channelsOf(tx: Db, orgId: string, span: Span): Promise<Array<{ channel: string | null; count: number }>> {
  const rows = await tx.execute<{ channel: string | null; count: number }>(sql`
    ${firstResponseCohortSql(orgId, [span])}
    select channel, count(*)::int as count from cohort group by channel order by count desc, channel`)
  return [...rows]
}

/** Desde cuándo trabaja el agente: su primera respuesta, su primera cita o su primera acción contada. */
async function agentSince(tx: Db, orgId: string): Promise<Date | null> {
  const [row] = await tx.execute<{ since: string | null }>(sql`
    select least(
      (select min(created_at) from message where organization_id = ${orgId} and direction = 'out' and sender_kind = 'agent'),
      (select min(created_at) from appointment where organization_id = ${orgId} and source in (${agentSources()})),
      (select min(occurred_at) from saas_action where organization_id = ${orgId})
    )::text as since`)
  return row?.since ? new Date(row.since) : null
}

// --- La pestaña -----------------------------------------------------------------------------

export async function getReportAgent(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date(), options: { billing?: boolean } = {}) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  // El periodo, el anterior y los 12 meses que terminan en el último mes del periodo.
  const months = lastMonths(scope.timezone, window.to, 12, window.end)
  const spans: Span[] = [window, window.previous, ...months]
  const conversations = await agentConversationsMany(tx, orgId, spans)
  const booked = await agentBookedMany(tx, orgId, branchId, spans)
  const recovered = await agentRecoveredMany(tx, orgId, branchId, spans)
  const dictated = await agentDictatedMany(tx, orgId, branchId, spans)
  const [collected] = await agentCollectedMany(tx, orgId, branchId, [window])
  const responses = await firstResponsesMany(tx, orgId, [window, window.previous])
  const handoffs = await agentHandoffsMany(tx, orgId, [window, window.previous])
  const byChannel = await channelsOf(tx, orgId, window)
  const since = await agentSince(tx, orgId)
  // Lo pagado a odentIA solo lo ve quien ve Facturación.
  const [paid] = options.billing ? await agentBillingMany(tx, orgId, [window], now) : [null]
  const tax = paid ? await saasTaxOf(tx, orgId) : null
  const pricing = paid ? await getActionPricing(tx, orgId) : null

  // Las citas que agendó por tramo del gráfico; en un periodo de meses son los mismos 12 meses.
  const buckets = scopeBuckets(scope)
  const chart = window.kind === "months" ? booked.slice(2) : await agentBookedMany(tx, orgId, branchId, buckets)
  const nth = <T>(list: T[], index: number): T => list[index] as T
  const inCurrency = (list: Array<{ currency: string; cents: number }>) => list.find((item) => item.currency === currency)?.cents ?? 0
  const othersOf = (list: Array<{ currency: string; cents: number }>) => list.filter((item) => item.currency !== currency)
  const empty: AgentCollected = { booked: { visits: 0, byCurrency: [] }, recovered: { visits: 0, byCurrency: [] } }
  const money = collected ?? empty

  return {
    ...reportHead(scope),
    /** Los 12 meses de cada línea pequeña. */
    months: months.map(serializeBucket),
    conversations: { current: nth(conversations, 0), previous: nth(conversations, 1), months: conversations.slice(2).map((item) => item.attended) },
    booked: {
      current: { booked: nth(booked, 0).booked, attended: nth(booked, 0).attended },
      previous: { booked: nth(booked, 1).booked, attended: nth(booked, 1).attended },
      months: booked.slice(2).map((item) => item.booked),
    },
    recovered: { current: nth(recovered, 0), previous: nth(recovered, 1), months: recovered.slice(2) },
    dictated: { current: nth(dictated, 0), previous: nth(dictated, 1), months: dictated.slice(2) },
    /** Lo cobrado en sus citas, hasta hoy, en la moneda de la clínica; las otras monedas aparte, nunca sumadas. */
    collected: {
      currency,
      booked: { visits: money.booked.visits, cents: inCurrency(money.booked.byCurrency) },
      recovered: { visits: money.recovered.visits, cents: inCurrency(money.recovered.byCurrency) },
      others: [...othersOf(money.booked.byCurrency), ...othersOf(money.recovered.byCurrency)].reduce<Array<{ currency: string; cents: number }>>((list, item) => {
        const found = list.find((entry) => entry.currency === item.currency)
        if (found) found.cents += item.cents
        else list.push({ ...item })
        return list
      }, []),
    },
    /** Lo pagado a odentIA por el agente, en la moneda del plan; null para quien no ve Facturación. */
    paid: paid ? { ...paid, planCreditCents: pricing?.creditCents ?? 0, tax } : null,
    /** Citas que agendó el agente por tramo del gráfico y todas las reservadas; null antes de que empezara. */
    chart: buckets.map((bucket, index) => {
      const item = chart[index] ?? { booked: 0, attended: 0, all: 0 }
      const before = since === null || bucket.end.getTime() <= since.getTime()
      return { ...serializeBucket(bucket), booked: before ? null : item.booked, all: item.all }
    }),
    since: since?.toISOString() ?? null,
    responses: {
      current: nth(responses, 0),
      previous: nth(responses, 1),
      handedOff: nth(handoffs, 0),
      previousHandedOff: nth(handoffs, 1),
      byChannel,
    },
    /** Las conversaciones y el cobro de odentIA no pertenecen a una sede. */
    wholeClinic: scope.branch ? (["conversations", "responses", "paid"] as const) : ([] as const),
  }
}

// --- Las listas detrás de sus cifras --------------------------------------------------------

export const AGENT_REPORT_LISTS = ["agent_booked", "agent_handoffs"] as const
export type AgentReportListKey = (typeof AGENT_REPORT_LISTS)[number]

const AGENT_LIST_LIMIT = 200

/**
 * «Citas que agendó» (con lo pagado en cada una) y «Pasaron al equipo» (una
 * fila por conversación, con el motivo; lleva a la conversación en la
 * Bandeja). Las mismas consultas de sus cifras.
 */
export async function getAgentReportList(tx: Db, orgId: string, query: ReportQuery & { list: AgentReportListKey }, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  type Row = Omit<ReportListRow, "cents"> & { cents: string | null; total: number }
  let rows: Row[]
  if (query.list === "agent_booked") {
    rows = [
      ...(await tx.execute<Row>(sql`
        with booked as (
          select a.id, a.starts_at, a.patient_id, a.service_name, a.dentist_user_id, a.branch_id
          from appointment a
          where a.organization_id = ${orgId} and a.created_at >= ${at(window.start)} and a.created_at < ${at(window.end)}
            and a.source in (${agentSources()}) ${scope.branch ? sql`and a.branch_id = ${scope.branch.id}` : sql``}
        ), paid as (${appointmentPaidSql(orgId, sql`select id from booked`)})
        select k.id, k.starts_at as at, k.patient_id as "patientId", pp.display_name as "personName",
          k.service_name as title, u.name as "professionalName", br.name as "branchName",
          exists (select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = k.patient_id
            and n.starts_at > ${at(now)} and n.status in ('programada','confirmada')) as "hasNextAppointment",
          pd.cents::text as cents, case when pd.cents is null then null else ${currency}::text end as currency,
          null::uuid as "conversationId", count(*) over()::int as total
        from booked k
        join patient p on p.id = k.patient_id and p.organization_id = ${orgId}
        join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        join branch br on br.id = k.branch_id and br.organization_id = ${orgId}
        join "user" u on u.id = k.dentist_user_id
        left join paid pd on pd.appointment_id = k.id and pd.currency = ${currency}
        order by k.starts_at desc, k.id limit ${AGENT_LIST_LIMIT}`)),
    ]
  } else {
    rows = [
      ...(await tx.execute<Row>(sql`
        with passed as (
          select distinct on (coalesce(h.conversation_id, h.id)) h.id, h.created_at, h.reason, h.conversation_id,
            coalesce(h.contact_id, c.contact_id) as contact_id
          from agent_handoff h
          left join conversation c on c.organization_id = h.organization_id and c.id = h.conversation_id
          where h.organization_id = ${orgId} and h.created_by = 'agent'
            and h.created_at >= ${at(window.start)} and h.created_at < ${at(window.end)}
          order by coalesce(h.conversation_id, h.id), h.created_at desc
        )
        select x.id, x.created_at as at, pt.id as "patientId", coalesce(pp.display_name, 'Sin nombre') as "personName",
          x.reason as title, null::text as "professionalName", null::text as "branchName", false as "hasNextAppointment",
          null::text as cents, null::text as currency, x.conversation_id as "conversationId", count(*) over()::int as total
        from passed x
        left join contact pp on pp.organization_id = ${orgId} and pp.id = x.contact_id
        left join patient pt on pt.organization_id = ${orgId} and pt.person_id = x.contact_id
        order by x.created_at desc, x.id limit ${AGENT_LIST_LIMIT}`)),
    ]
  }
  return {
    ...reportHead(scope),
    list: query.list,
    /** Filas que existen; la respuesta trae como mucho `AGENT_LIST_LIMIT`. */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents, at: when, ...row }) => ({
      ...row,
      at: new Date(when).toISOString(),
      cents: cents === null ? null : safeCents(cents),
    })),
  }
}
