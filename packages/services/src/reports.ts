/**
 * Reportes: cuatro preguntas (dinero, agenda, pacientes y ventas, atención)
 * sobre un mismo periodo y una misma sede, cada cifra con la del periodo
 * anterior. Solo lecturas; ninguna cifra sale de un modelo.
 *
 * - Una definición por cifra: la tarjeta, su lista y la comparación usan la
 *   misma consulta con otro tramo.
 * - Lo que no pertenece a una sede (controles, presupuestos, oportunidades,
 *   conversaciones) se entrega de toda la clínica y lo dice (`wholeClinic`).
 * - Los nombres de estados y grupos viajan como claves; los escribe la interfaz.
 */
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import { type AdminRecommendation, getAdminRecommendations } from "./agent-admin.js"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { budgetLineUnitsSql, budgetValueOptionSql } from "./budgets.js"
import { getFinanceResultBetween, getFinanceTotalsBetween } from "./finance.js"
import { OVERDUE_DAYS, overdueDebtSql } from "./report-debts.js"
import { addMonths, reportDayOf, monthStart, monthsOf, type ReportBucket, type ReportSpan, type YearMonth } from "./report-periods.js"
import {
  at,
  bySpan,
  type ReportQuery,
  type ReportScope,
  reportHead,
  reportScope,
  safeCents,
  scopeBuckets,
  serializeBucket,
  hullOf,
  type Span,
  spansSql,
} from "./report-scope.js"

// --- Agenda ---------------------------------------------------------------------------------

export type AppointmentTotals = {
  total: number
  attended: number
  noShow: number
  cancelled: number
  /** Citas que ya pasaron y nadie marcó: se muestran aparte, no se reparten. */
  unmarked: number
}

/** Una cita cuenta si ya tiene desenlace o si su hora pasó; la que aún no ocurre no es de ningún grupo. */
function settledAppointment(now: Date): SQL {
  return sql`(a.status in ('atendida','no_asistio','cancelada') or (a.status in ('programada','confirmada') and a.ends_at < ${at(now)}))`
}

/** Las citas de cada tramo por grupo, en una sola consulta (`spansSql`). */
export async function appointmentTotalsMany(tx: Db, orgId: string, scope: Pick<ReportScope, "branch" | "now">, spans: Span[]): Promise<AppointmentTotals[]> {
  const rows = await tx.execute<{ idx: number } & Omit<AppointmentTotals, "total">>(sql`
    select b.idx, count(*) filter (where a.status='atendida')::int as attended,
      count(*) filter (where a.status='no_asistio')::int as "noShow",
      count(*) filter (where a.status='cancelada')::int as cancelled,
      count(*) filter (where a.status in ('programada','confirmada'))::int as unmarked
    from ${spansSql(spans)}
    join appointment a on a.organization_id=${orgId} and a.starts_at >= b.start_at and a.starts_at < b.end_at
      and ${settledAppointment(scope.now)}
      ${scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``}
    group by b.idx`)
  return bySpan(
    spans,
    [...rows],
    () => ({ total: 0, attended: 0, noShow: 0, cancelled: 0, unmarked: 0 }),
    (_, row) => ({ attended: row.attended, noShow: row.noShow, cancelled: row.cancelled, unmarked: row.unmarked, total: row.attended + row.noShow + row.cancelled + row.unmarked }),
  )
}

async function appointmentTotals(tx: Db, orgId: string, scope: ReportScope, span: ReportSpan): Promise<AppointmentTotals> {
  const [totals] = await appointmentTotalsMany(tx, orgId, scope, [span])
  return totals as AppointmentTotals
}

export type ControlTotals = {
  due: number
  /** Realizados con su atención cerrada y su resultado: lo demás no cuenta como venido. */
  came: number
  pending: number
  cancelled: number
  /** Marcados como realizados sin atención cerrada que lo respalde: ni venido ni pendiente. */
  unknown: number
}

/**
 * Controles que tocaban en el tramo, según su estado a hoy (como los
 * presupuestos): así «siguen pendientes» coincide con su lista. De toda la clínica.
 */
export async function controlTotals(tx: Db, orgId: string, span: ReportSpan): Promise<ControlTotals> {
  const [row] = await tx.execute<Omit<ControlTotals, "unknown">>(sql`
    select count(*)::int as due,
      count(*) filter (where f.status='realizado' and f.completed_encounter_id is not null
        and f.outcome is not null and e.status='finalizada')::int as came,
      count(*) filter (where f.status in ('pendiente','programado'))::int as pending,
      count(*) filter (where f.status='cancelado')::int as cancelled
    from clinical_follow_up f
    left join encounter e on e.id=f.completed_encounter_id and e.organization_id=${orgId}
    where f.organization_id=${orgId} and f.due_at >= ${at(span.start)} and f.due_at < ${at(span.end)}`)
  const totals = row ?? { due: 0, came: 0, pending: 0, cancelled: 0 }
  return { ...totals, unknown: totals.due - totals.came - totals.pending - totals.cancelled }
}

/**
 * «Espera en sala» (ADR 0032): minutos entre «Llegó» y el inicio de la
 * atención de la cita. Solo cuenta lo medido: la llegada marcada antes de
 * empezar; la que marcó «Atender» al abrir es la misma hora y queda sin dato.
 * La mediana no se deja arrastrar por un día raro. Por profesional, el que
 * atendió.
 */
export type WaitInRoom = {
  /** Mediana del tramo, en minutos enteros; null sin datos. */
  medianMinutes: number | null
  /** Citas con la espera medida. */
  measured: number
  byProfessional: Array<{ userId: string; name: string; medianMinutes: number; measured: number }>
}

async function waitInRoom(tx: Db, orgId: string, scope: ReportScope, span: ReportSpan): Promise<WaitInRoom> {
  const rows = await tx.execute<{ userId: string | null; name: string | null; median: number | string | null; measured: number }>(sql`
    select e.dentist_user_id as "userId", u.name,
      percentile_cont(0.5) within group (order by extract(epoch from (e.started_at - a.arrived_at)) / 60) as median,
      count(*)::int as measured
    from appointment a
    join encounter e on e.organization_id=a.organization_id and e.appointment_id=a.id and e.status<>'anulada'
    join "user" u on u.id=e.dentist_user_id
    where a.organization_id=${orgId} and a.starts_at >= ${at(span.start)} and a.starts_at < ${at(span.end)}
      and a.arrived_at is not null and a.arrived_at < e.started_at
      ${scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``}
    group by grouping sets ((e.dentist_user_id, u.name), ())`)
  const minutes = (value: number | string | null) => (value === null ? null : Math.round(Number(value)))
  const whole = rows.find((row) => row.userId === null)
  return {
    medianMinutes: whole && whole.measured > 0 ? minutes(whole.median) : null,
    measured: whole?.measured ?? 0,
    byProfessional: rows
      .filter((row): row is typeof row & { userId: string; name: string } => row.userId !== null && row.name !== null)
      .map((row) => ({ userId: row.userId, name: row.name, medianMinutes: minutes(row.median) ?? 0, measured: row.measured }))
      .sort((a, b) => b.medianMinutes - a.medianMinutes || a.name.localeCompare(b.name)),
  }
}

export async function getReportAgenda(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const branchSql = scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``
  const inWindow = sql`a.organization_id=${orgId} and a.starts_at >= ${at(window.start)} and a.starts_at < ${at(window.end)}
    and ${settledAppointment(now)} ${branchSql}`
  const byProfessional = await tx.execute<{ userId: string; name: string; total: number; attended: number; noShow: number }>(sql`
    select a.dentist_user_id as "userId", u.name, count(*)::int as total,
      count(*) filter (where a.status='atendida')::int as attended,
      count(*) filter (where a.status='no_asistio')::int as "noShow"
    from appointment a join "user" u on u.id=a.dentist_user_id
    where ${inWindow}
    group by a.dentist_user_id, u.name order by attended desc, u.name`)
  const bySource = await tx.execute<{ source: string; count: number }>(sql`
    select a.source, count(*)::int as count from appointment a
    where ${inWindow} group by a.source order by count desc, a.source`)
  return {
    ...reportHead(scope),
    appointments: await appointmentTotals(tx, orgId, scope, window),
    previousAppointments: await appointmentTotals(tx, orgId, scope, window.previous),
    byProfessional: [...byProfessional],
    bySource: [...bySource],
    controls: await controlTotals(tx, orgId, window),
    previousControls: await controlTotals(tx, orgId, window.previous),
    waitInRoom: await waitInRoom(tx, orgId, scope, window),
    previousWaitInRoom: (await waitInRoom(tx, orgId, scope, window.previous)).medianMinutes,
    /** Los controles son de la persona, no de una sede. */
    wholeClinic: scope.branch ? (["controls"] as const) : ([] as const),
    series: await monthlySeries(scope, (span) => appointmentTotals(tx, orgId, scope, span)),
  }
}

// --- Pacientes y ventas ---------------------------------------------------------------------

/** La primera cita atendida de cada persona: `first_visit(id, patient_id, starts_at, branch_id, service_name, dentist_user_id)`. */
export function firstVisitSql(orgId: string): SQL {
  return sql`first_visit as (
      select distinct on (patient_id) id, patient_id, starts_at, branch_id, service_name, dentist_user_id
      from appointment where organization_id=${orgId} and status='atendida'
      order by patient_id, starts_at, id
    )`
}

/** Personas atendidas por primera vez en cada tramo (su primera cita atendida cae dentro). */
export async function newPatientsMany(tx: Db, orgId: string, scope: Pick<ReportScope, "branch">, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    with ${firstVisitSql(orgId)} select b.idx, count(*)::int as count from ${spansSql(spans)}
    join first_visit f on f.starts_at >= b.start_at and f.starts_at < b.end_at
      ${scope.branch ? sql`and f.branch_id=${scope.branch.id}` : sql``}
    group by b.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

async function newPatients(tx: Db, orgId: string, scope: ReportScope, span: ReportSpan): Promise<number> {
  const [count] = await newPatientsMany(tx, orgId, scope, [span])
  return count ?? 0
}

export type BudgetGroup = "accepted" | "waiting" | "rejected"

export interface BudgetTotals {
  currency: string
  accepted: { count: number; cents: number }
  waiting: { count: number; cents: number }
  rejected: { count: number; cents: number }
}

/**
 * Las líneas que cuentan de cada presupuesto presentado, con su grupo. Una sola
 * regla con el resto de la aplicación: el presupuesto vale lo de una opción (la
 * elegida o, mientras decide, la recomendada: `budgetValueOptionSql`), lo que se
 * cobra por sesión cuenta todas sus visitas y «espera respuesta» es
 * `budgetAwaitsAnswerSql`. Uno aceptado en parte cuenta por lo aceptado, y lo
 * que dejó para después, como en espera. Las revisiones sustituidas no cuentan.
 */
export function budgetLinesSql(orgId: string, where: SQL): SQL {
  const budget = { id: sql`b.id`, status: sql`b.status`, organizationId: sql`b.organization_id` }
  return sql`with valued as (
      select b.id, b.patient_id, b.presented_at, b.title, b.currency, b.status, b.created_by,
        ${budgetAwaitsAnswerSql(budget)} as awaits,
        ${budgetValueOptionSql(budget)} as option_id
      from treatment_budget b
      where b.organization_id=${orgId} and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
        and ${where}
    ), budget_line as (
      select v.id, v.patient_id, v.presented_at, v.title, v.currency, v.created_by,
        case
          when v.status in ('aceptado','parcial') and i.decision = 'aceptado' then 'accepted'
          when v.awaits and (v.status <> 'parcial' or i.decision = 'pospuesto') then 'waiting'
          when v.status = 'rechazado' then 'rejected'
        end as grp,
        i.price_cents::bigint * ${budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })} as cents,
        (i.id is not null and i.price_cents is null) as missing_price
      from valued v
      left join treatment_budget_item i on i.organization_id=${orgId} and i.budget_id=v.id and i.option_id=v.option_id
    )`
}

/** Presupuestos presentados en cada tramo, según su respuesta a hoy (`budgetLinesSql`). */
export async function budgetTotalsMany(tx: Db, orgId: string, spans: Span[]): Promise<BudgetTotals[][]> {
  const hull = hullOf(spans)
  const rows = await tx.execute<{ idx: number; currency: string; grp: BudgetGroup; count: number; cents: string }>(sql`
    ${budgetLinesSql(orgId, sql`b.presented_at >= ${at(hull.start)} and b.presented_at < ${at(hull.end)}`)}
    select s.idx, bl.currency, bl.grp, count(distinct bl.id)::int as count, coalesce(sum(bl.cents), 0)::text as cents
    from budget_line bl join ${spansSql(spans, "s")} on bl.presented_at >= s.start_at and bl.presented_at < s.end_at
    where bl.grp is not null group by s.idx, bl.currency, bl.grp order by bl.currency`)
  return bySpan(
    spans,
    [...rows],
    (): BudgetTotals[] => [],
    (list, row) => {
      let entry = list.find((item) => item.currency === row.currency)
      if (!entry) {
        entry = { currency: row.currency, accepted: { count: 0, cents: 0 }, waiting: { count: 0, cents: 0 }, rejected: { count: 0, cents: 0 } }
        list.push(entry)
      }
      entry[row.grp] = { count: row.count, cents: safeCents(row.cents) }
      return list
    },
  )
}

/** Presupuestos presentados en el tramo, según su respuesta a hoy (`budgetLinesSql`). */
async function budgetTotals(tx: Db, orgId: string, span: ReportSpan): Promise<BudgetTotals[]> {
  const [totals] = await budgetTotalsMany(tx, orgId, [span])
  return totals ?? []
}

/**
 * Tratamientos de atenciones cerradas en el tramo, a su precio, sin los
 * anulados. Un acto con cantidad (3 sellantes) cuenta sus unidades y vale
 * precio × cantidad, como su cargo.
 */
async function procedureTotals(tx: Db, orgId: string, scope: ReportScope, span: ReportSpan) {
  const rows = await tx.execute<{ name: string; currency: string | null; count: number; cents: string }>(sql`
    select coalesce(s.name, p.description) as name, p.currency, sum(p.quantity)::int as count,
      coalesce(sum(p.price_cents::bigint * p.quantity), 0)::text as cents
    from encounter_procedure p
    join encounter e on e.id=p.encounter_id and e.organization_id=${orgId}
    left join service_catalog s on s.id=p.service_id and s.organization_id=${orgId}
    where p.organization_id=${orgId} and e.status='finalizada' and p.voided_at is null
      and e.finalized_at >= ${at(span.start)} and e.finalized_at < ${at(span.end)}
      ${scope.branch ? sql`and e.branch_id=${scope.branch.id}` : sql``}
    group by 1, p.currency order by count desc, name`)
  return rows.map((row) => ({ name: row.name, currency: row.currency, count: row.count, cents: safeCents(row.cents) }))
}

export async function getReportSales(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const procedures = await procedureTotals(tx, orgId, scope, window)
  const previousProcedures = await procedureTotals(tx, orgId, scope, window.previous)
  const opportunities = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count from opportunity
    where organization_id=${orgId} and created_at >= ${at(window.start)} and created_at < ${at(window.end)}
    group by status order by status`)
  // Por qué se pierden las ventas: los motivos de las perdidas del mismo tramo.
  const lostReasons = await tx.execute<{ reason: string; count: number }>(sql`
    select coalesce(close_reason, 'otro') as reason, count(*)::int as count from opportunity
    where organization_id=${orgId} and status = 'lost' and created_at >= ${at(window.start)} and created_at < ${at(window.end)}
    group by 1 order by count desc, reason`)
  return {
    ...reportHead(scope),
    newPatients: await newPatients(tx, orgId, scope, window),
    previousNewPatients: await newPatients(tx, orgId, scope, window.previous),
    budgets: await budgetTotals(tx, orgId, window),
    previousBudgets: await budgetTotals(tx, orgId, window.previous),
    procedures,
    previousProcedureCount: previousProcedures.reduce((sum, row) => sum + row.count, 0),
    opportunities: [...opportunities],
    /** Motivos de las perdidas (claves de la lista; los nombres los escribe la interfaz). */
    lostReasons: [...lostReasons],
    /** Presupuestos y oportunidades son de la persona, no de una sede. */
    wholeClinic: scope.branch ? (["budgets", "opportunities"] as const) : ([] as const),
    series: await monthlySeries(scope, async (span) => ({ newPatients: await newPatients(tx, orgId, scope, span) })),
  }
}

// --- Atención -------------------------------------------------------------------------------

export type ResponseTotals = {
  /** Conversaciones cuyo primer mensaje de la persona cae en el tramo. */
  conversations: number
  responded: number
  /** Respuestas con hora de envío conocida: la base del promedio. */
  timedResponses: number
  avgFirstResponseSeconds: number | null
  byAgent: number
  byTeam: number
  /** De las que respondió primero el agente, cuántas pasó después al equipo. */
  handedOff: number
}

/**
 * Primera respuesta: del primer mensaje de la persona a la primera respuesta
 * aceptada por el canal. Los envíos de prueba y los que no salieron no cuentan.
 */
function firstResponseCohort(orgId: string, span: ReportSpan): SQL {
  return sql`
    with first_inbound as (
      select distinct on (conversation_id) conversation_id, created_at
      from message where organization_id=${orgId} and direction='in'
      order by conversation_id, created_at, id
    ), cohort as (
      select i.conversation_id, i.created_at, r.sent_at, r.id as response_id, r.sender_kind, cc.channel
      from first_inbound i
      join conversation c on c.id=i.conversation_id and c.organization_id=${orgId}
      left join channel_connection cc on cc.id=c.channel_connection_id and cc.organization_id=${orgId}
      left join lateral (
        select m.id, m.sent_at, m.sender_kind from message m
        where m.organization_id=${orgId} and m.conversation_id=i.conversation_id
          and m.direction='out' and m.status in ('sent','delivered','read')
          and coalesce(m.external_id,'') not like 'mock-%'
          and m.created_at >= i.created_at
        order by coalesce(m.sent_at, m.created_at), m.id limit 1
      ) r on true
      where i.created_at >= ${at(span.start)} and i.created_at < ${at(span.end)}
    )`
}

async function responseTotals(tx: Db, orgId: string, span: ReportSpan): Promise<ResponseTotals> {
  const [row] = await tx.execute<ResponseTotals>(sql`
    ${firstResponseCohort(orgId, span)}
    select count(*)::int as conversations, count(response_id)::int as responded,
      count(*) filter (where sent_at >= created_at)::int as "timedResponses",
      avg(extract(epoch from (sent_at-created_at))) filter (where sent_at >= created_at)::float8 as "avgFirstResponseSeconds",
      count(*) filter (where sender_kind='agent')::int as "byAgent",
      count(*) filter (where response_id is not null and sender_kind<>'agent')::int as "byTeam",
      count(*) filter (where sender_kind='agent' and exists (
        select 1 from agent_handoff h where h.organization_id=${orgId}
          and h.conversation_id=cohort.conversation_id and h.created_at >= cohort.created_at))::int as "handedOff"
    from cohort`)
  return (
    row ?? {
      conversations: 0,
      responded: 0,
      timedResponses: 0,
      avgFirstResponseSeconds: null,
      byAgent: 0,
      byTeam: 0,
      handedOff: 0,
    }
  )
}

export async function getReportService(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const byChannel = await tx.execute<{ channel: string | null; count: number }>(sql`
    ${firstResponseCohort(orgId, window)}
    select channel, count(*)::int as count from cohort group by channel order by count desc, channel`)
  return {
    ...reportHead(scope),
    responses: await responseTotals(tx, orgId, window),
    previousResponses: await responseTotals(tx, orgId, window.previous),
    byChannel: [...byChannel],
    /** Las conversaciones no pertenecen a una sede. */
    wholeClinic: scope.branch ? (["responses"] as const) : ([] as const),
    series: await monthlySeries(scope, async (span) => {
      const totals = await responseTotals(tx, orgId, span)
      return { conversations: totals.conversations, responded: totals.responded }
    }),
  }
}

// --- Dinero ---------------------------------------------------------------------------------

export async function getReportMoney(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const branchId = scope.branch?.id
  const result = await getFinanceResultBetween(tx, orgId, { start: window.start, end: window.end, branchId })
  const previousTotals = await getFinanceTotalsBetween(tx, orgId, {
    start: window.previous.start,
    end: window.previous.end,
    branchId,
  })
  return {
    ...reportHead(scope),
    ...result,
    /** Totales del tramo anterior, por moneda. */
    previousTotals,
    series: await monthlySeries(scope, async (span) => ({
      totals: await getFinanceTotalsBetween(tx, orgId, { start: span.start, end: span.end, branchId }),
    })),
  }
}

// --- El Administrador junto a la cifra ------------------------------------------------------

/** La inasistencia merece aviso si llega a este porcentaje… */
export const NO_SHOW_ALERT_RATE = 10
/** …o si subió al menos estos puntos frente al periodo anterior. */
export const NO_SHOW_ALERT_RISE = 2

export type ReportAdviceTab = "dinero" | "agenda" | "ventas"

export interface ReportAdvice {
  tab: ReportAdviceTab
  /** Línea del administrador que respalda el aviso: su lista y lo que se puede hacer se abren con esta clave. */
  key: string
  title: string
  total: number
  /** Solo en la inasistencia: la cifra del periodo y la del anterior, en porcentaje entero. */
  rate: number | null
  previousRate: number | null
  /** La línea que lo atendería, que hoy está apagada: «Reprogramar tras una inasistencia». */
  line: string
}

function percent(part: number, total: number): number | null {
  return total > 0 ? Math.round((part * 100) / total) : null
}

/**
 * Un aviso por pregunta como mucho, y solo si hay algo que hacer: cada uno es
 * una recomendación del administrador (una línea apagada que hoy tiene casos,
 * con su lista). Con él apagado no hay avisos; con la línea prendida tampoco,
 * porque ya se está atendiendo. No hay modelo.
 */
export async function getReportAdvice(
  tx: Db,
  orgId: string,
  query: ReportQuery,
  can: (permission: string) => boolean,
  now: Date = new Date(),
): Promise<{ enabled: boolean; notices: ReportAdvice[] }> {
  const view = await getAdminRecommendations(tx, orgId, can, { all: true })
  if (!view.enabled) return { enabled: false, notices: [] }
  const scope = await reportScope(tx, orgId, query, now)
  const found = (key: string): AdminRecommendation | undefined => view.recommendations.find((item) => item.key === key)
  const notice = (tab: ReportAdviceTab, item: AdminRecommendation, rates?: { rate: number | null; previousRate: number | null }): ReportAdvice => ({
    tab,
    key: item.key,
    title: item.title,
    total: item.total,
    rate: rates?.rate ?? null,
    previousRate: rates?.previousRate ?? null,
    line: item.name,
  })
  const notices: ReportAdvice[] = []

  const debts = found("cobranza_vencida")
  if (debts) notices.push(notice("dinero", debts))

  // Agenda: la inasistencia solo si la cifra del periodo lo justifica; si no, los controles vencidos.
  const noShows = found("seguimiento_no_asistencia")
  const appointments = await appointmentTotals(tx, orgId, scope, scope.window)
  const before = await appointmentTotals(tx, orgId, scope, scope.window.previous)
  const rate = percent(appointments.noShow, appointments.total)
  const previousRate = percent(before.noShow, before.total)
  const worth = rate !== null && (rate >= NO_SHOW_ALERT_RATE || (previousRate !== null && rate - previousRate >= NO_SHOW_ALERT_RISE))
  const controls = found("recordatorio_control")
  if (noShows && worth) notices.push(notice("agenda", noShows, { rate, previousRate }))
  else if (controls) notices.push(notice("agenda", controls))

  const budgets = found("seguimiento_presupuesto")
  if (budgets) notices.push(notice("ventas", budgets))

  return { enabled: true, notices }
}

// --- Barras por tramo -----------------------------------------------------------------------

/**
 * Los tramos de la serie de una pregunta: por mes en un periodo de meses, o
 * por día, semana o mes en un rango (`reportBuckets`), siempre recortados al
 * periodo. Con un solo tramo no hay serie.
 */
export function seriesBuckets(scope: ReportScope): ReportBucket[] {
  if (scope.window.kind === "range") return scopeBuckets(scope)
  return monthsOf(scope.window).map((month) => {
    const start = monthStart(scope.timezone, month.year, month.month)
    const next = addMonths(month, 1)
    const naturalEnd = monthStart(scope.timezone, next.year, next.month)
    const end = naturalEnd.getTime() > scope.window.end.getTime() ? scope.window.end : naturalEnd
    const firstDay = `${month.year}-${String(month.month).padStart(2, "0")}-01`
    return { key: firstDay.slice(0, 7), start, end, partial: end.getTime() < naturalEnd.getTime(), firstDay, lastDay: reportDayOf(scope.timezone, new Date(end.getTime() - 1)) }
  })
}

/** La misma cifra tramo a tramo; `year` y `month` son los del primer día de cada tramo. */
async function monthlySeries<T>(scope: ReportScope, read: (span: ReportSpan) => Promise<T>) {
  const buckets = seriesBuckets(scope)
  if (buckets.length < 2) return []
  const series: Array<ReturnType<typeof serializeBucket> & YearMonth & T> = []
  for (const bucket of buckets) {
    const month = { year: Number(bucket.firstDay.slice(0, 4)), month: Number(bucket.firstDay.slice(5, 7)) }
    const span: ReportSpan = { from: month, to: month, start: bucket.start, end: bucket.end, partial: bucket.partial }
    series.push({ ...serializeBucket(bucket), ...month, ...(await read(span)) })
  }
  return series
}

// --- La lista detrás de una cifra -----------------------------------------------------------

export const REPORT_LISTS = [
  "no_show",
  "cancelled",
  "unmarked",
  "controls_pending",
  "budgets_waiting",
  "new_patients",
  "debts_overdue",
] as const
export type ReportListKey = (typeof REPORT_LISTS)[number]

export type ReportListRow = {
  id: string
  at: string
  patientId: string
  personName: string
  /** Lo que identifica la fila: prestación de la cita, título del control o del presupuesto. */
  title: string | null
  professionalName: string | null
  branchName: string | null
  /** La persona ya tiene una cita por venir: quien llama sabe a quién no hace falta. */
  hasNextAppointment: boolean
  cents: number | null
  currency: string | null
}

const REPORT_LIST_LIMIT = 200

export async function getReportList(
  tx: Db,
  orgId: string,
  query: ReportQuery & { list: ReportListKey },
  now: Date = new Date(),
) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const start = at(window.start)
  const end = at(window.end)
  const nextAppointment = (patient: SQL): SQL => sql`exists (
    select 1 from appointment n where n.organization_id=${orgId} and n.patient_id=${patient}
      and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))`
  type Row = Omit<ReportListRow, "cents"> & { cents: string | null; total: number }
  let rows: Row[]

  if (query.list === "no_show" || query.list === "cancelled" || query.list === "unmarked") {
    const status =
      query.list === "no_show"
        ? sql`a.status='no_asistio'`
        : query.list === "cancelled"
          ? sql`a.status='cancelada'`
          : sql`a.status in ('programada','confirmada') and a.ends_at < ${at(now)}`
    rows = [
      ...(await tx.execute<Row>(sql`
        select a.id, a.starts_at as at, a.patient_id as "patientId", pp.display_name as "personName",
          a.service_name as title, u.name as "professionalName", b.name as "branchName",
          ${nextAppointment(sql`a.patient_id`)} as "hasNextAppointment",
          null::text as cents, null::text as currency, count(*) over()::int as total
        from appointment a
        join patient p on p.id=a.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        join branch b on b.id=a.branch_id and b.organization_id=${orgId}
        join "user" u on u.id=a.dentist_user_id
        where a.organization_id=${orgId} and a.starts_at >= ${start} and a.starts_at < ${end} and ${status}
          ${scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``}
        order by a.starts_at desc, a.id limit ${REPORT_LIST_LIMIT}`)),
    ]
  } else if (query.list === "controls_pending") {
    rows = [
      ...(await tx.execute<Row>(sql`
        select f.id, f.due_at as at, f.patient_id as "patientId", pp.display_name as "personName",
          f.title, null::text as "professionalName", null::text as "branchName",
          ${nextAppointment(sql`f.patient_id`)} as "hasNextAppointment",
          null::text as cents, null::text as currency, count(*) over()::int as total
        from clinical_follow_up f
        join patient p on p.id=f.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        where f.organization_id=${orgId} and f.due_at >= ${start} and f.due_at < ${end}
          and f.status in ('pendiente','programado')
        order by f.due_at, f.id limit ${REPORT_LIST_LIMIT}`)),
    ]
  } else if (query.list === "budgets_waiting") {
    rows = [
      ...(await tx.execute<Row>(sql`
        ${budgetLinesSql(orgId, sql`b.presented_at >= ${start} and b.presented_at < ${end}`)}
        , waiting as (
          select id, patient_id, presented_at, title, currency,
            case when bool_or(missing_price) then null else coalesce(sum(cents), 0) end as cents
          from budget_line where grp = 'waiting' group by id, patient_id, presented_at, title, currency
        )
        select w.id, w.presented_at as at, w.patient_id as "patientId", pp.display_name as "personName",
          w.title, null::text as "professionalName", null::text as "branchName",
          ${nextAppointment(sql`w.patient_id`)} as "hasNextAppointment",
          w.cents::text as cents, w.currency::text as currency, count(*) over()::int as total
        from waiting w
        join patient p on p.id=w.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        order by w.presented_at, w.id limit ${REPORT_LIST_LIMIT}`)),
    ]
  } else if (query.list === "debts_overdue") {
    // Quién debía hace más de 30 días al cerrar el periodo: la misma consulta de la cifra.
    rows = [
      ...(await tx.execute<Row>(sql`
        ${overdueDebtSql(orgId, [window.end], OVERDUE_DAYS, scope.branch?.id)}
        select o.patient_id::text || ':' || o.currency as id, o.since as at, o.patient_id as "patientId", pp.display_name as "personName",
          null::text as title, null::text as "professionalName", null::text as "branchName",
          ${nextAppointment(sql`o.patient_id`)} as "hasNextAppointment",
          o.owed::text as cents, o.currency::text as currency, count(*) over()::int as total
        from overdue o
        join patient p on p.id = o.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        order by o.since, o.patient_id limit ${REPORT_LIST_LIMIT}`)),
    ]
  } else {
    rows = [
      ...(await tx.execute<Row>(sql`
        with ${firstVisitSql(orgId)} select v.id, v.starts_at as at, v.patient_id as "patientId", pp.display_name as "personName",
          v.service_name as title, u.name as "professionalName", b.name as "branchName",
          ${nextAppointment(sql`v.patient_id`)} as "hasNextAppointment",
          null::text as cents, null::text as currency, count(*) over()::int as total
        from first_visit v
        join patient p on p.id=v.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        join branch b on b.id=v.branch_id and b.organization_id=${orgId}
        join "user" u on u.id=v.dentist_user_id
        where v.starts_at >= ${start} and v.starts_at < ${end}
          ${scope.branch ? sql`and v.branch_id=${scope.branch.id}` : sql``}
        order by v.starts_at desc, v.id limit ${REPORT_LIST_LIMIT}`)),
    ]
  }

  return {
    ...reportHead(scope),
    list: query.list,
    /** Filas que existen; la respuesta trae como mucho `REPORT_LIST_LIMIT`. */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents, at: when, ...row }) => ({
      ...row,
      at: new Date(when).toISOString(),
      cents: cents === null ? null : safeCents(cents),
    })),
  }
}
