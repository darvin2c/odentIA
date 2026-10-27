/**
 * Reportes: lo que comparten las pestañas (citas por cómo terminaron,
 * controles, espera en sala, pacientes nuevos y presupuestos aceptados), el
 * aviso del Administrador junto a la cifra y las listas de citas, pacientes
 * nuevos y deuda vencida. Cada pestaña vive en su `report-*.ts`. Solo
 * lecturas; ninguna cifra sale de un modelo.
 *
 * - Una definición por cifra: la tarjeta, su lista y la comparación usan la
 *   misma consulta con otro tramo.
 * - Lo que no pertenece a una sede (controles, presupuestos, conversaciones)
 *   se entrega de toda la clínica y lo dice (`wholeClinic`).
 * - Los nombres de estados y grupos viajan como claves; los escribe la interfaz.
 */
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import { type AdminRecommendation, getAdminRecommendations } from "./agent-admin.js"
import { budgetValueOptionSql } from "./budgets.js"
import { getAgentReportList } from "./report-agent.js"
import { OVERDUE_DAYS, overdueDebtSql } from "./report-debts.js"
import { FINANCE_LISTS, financeListRows, isFinanceList } from "./report-finance.js"
import type { ReportSpan } from "./report-periods.js"
import { at, bySpan, type ReportQuery, type ReportScope, reportHead, reportScope, safeCents, type Span, spansSql } from "./report-scope.js"

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
      and not a.is_test and ${settledAppointment(scope.now)}
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

export async function waitInRoom(tx: Db, orgId: string, scope: Pick<ReportScope, "branch">, span: Span): Promise<WaitInRoom> {
  const rows = await tx.execute<{ userId: string | null; name: string | null; median: number | string | null; measured: number }>(sql`
    select e.professional_user_id as "userId", u.name,
      percentile_cont(0.5) within group (order by extract(epoch from (e.started_at - a.arrived_at)) / 60) as median,
      count(*)::int as measured
    from appointment a
    join encounter e on e.organization_id=a.organization_id and e.appointment_id=a.id and e.status<>'anulada'
    join "user" u on u.id=e.professional_user_id
    where a.organization_id=${orgId} and a.starts_at >= ${at(span.start)} and a.starts_at < ${at(span.end)}
      and a.arrived_at is not null and a.arrived_at < e.started_at
      ${scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``}
    group by grouping sets ((e.professional_user_id, u.name), ())`)
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

// --- Pacientes ------------------------------------------------------------------------------

/** La primera cita atendida de cada persona: `first_visit(id, patient_id, starts_at, branch_id, service_name, professional_user_id)`. */
export function firstVisitSql(orgId: string): SQL {
  return sql`first_visit as (
      select distinct on (patient_id) id, patient_id, starts_at, branch_id, service_name, professional_user_id
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

/**
 * Las líneas que cuentan de cada presupuesto presentado y si se aceptaron,
 * según su respuesta a hoy. Una sola regla con el resto de la aplicación: el
 * presupuesto vale lo de una opción (la elegida o, mientras decide, la
 * recomendada: `budgetValueOptionSql`). Uno aceptado en parte tiene líneas
 * aceptadas y otras no. Las revisiones sustituidas no cuentan.
 */
export function budgetLinesSql(orgId: string, where: SQL): SQL {
  const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  return sql`with valued as (
      select b.id, b.presented_at, b.status, b.created_by, ${budgetValueOptionSql(budget)} as option_id
      from treatment_budget b
      where b.organization_id=${orgId} and b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')
        and ${where}
    ), budget_line as (
      select v.id, v.presented_at, v.created_by,
        coalesce(v.status in ('aceptado','parcial') and i.decision = 'aceptado', false) as accepted
      from valued v
      left join treatment_budget_item i on i.organization_id=${orgId} and i.budget_id=v.id and i.option_id=v.option_id
    )`
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

// --- La lista detrás de una cifra -----------------------------------------------------------

export const REPORT_LISTS = [
  "no_show",
  "cancelled",
  "unmarked",
  "new_patients",
  "debts_overdue",
  "agent_booked",
  "agent_handoffs",
  ...FINANCE_LISTS,
] as const
export type ReportListKey = (typeof REPORT_LISTS)[number]

export type ReportListRow = {
  id: string
  at: string
  /** Null: la persona escribió pero aún no es paciente (no tiene ficha). */
  patientId: string | null
  personName: string
  /** Lo que identifica la fila: prestación de la cita, título del control o del presupuesto. */
  title: string | null
  professionalName: string | null
  branchName: string | null
  /** La persona ya tiene una cita por venir: quien llama sabe a quién no hace falta. */
  hasNextAppointment: boolean
  cents: number | null
  currency: string | null
  /** La fila lleva a esta conversación en la Bandeja en vez de a la ficha. */
  conversationId?: string | null
  /** «Aceptaron y no tienen cita»: lo aceptado por hacer, para agendarlo desde la fila. */
  planItemIds?: string[] | null
  /** El servicio de eso, si es uno solo: la reserva lo trae elegido. */
  serviceId?: string | null
}

const REPORT_LIST_LIMIT = 200
/** Una descarga trae la lista entera hasta este tope; la pantalla, las primeras `REPORT_LIST_LIMIT`. */
export const REPORT_LIST_DOWNLOAD_LIMIT = 5000

/** Cuántas filas trae una lista: las de la pantalla, o más para descargarla, nunca sin tope. */
export function reportListLimit(asked: number | undefined): number {
  return Math.max(1, Math.min(asked ?? REPORT_LIST_LIMIT, REPORT_LIST_DOWNLOAD_LIMIT))
}

export async function getReportList(
  tx: Db,
  orgId: string,
  query: ReportQuery & { list: ReportListKey; limit?: number },
  now: Date = new Date(),
) {
  const limit = reportListLimit(query.limit)
  // Las listas de Reportes › Agente viven con sus cifras.
  if (query.list === "agent_booked" || query.list === "agent_handoffs") return getAgentReportList(tx, orgId, { ...query, list: query.list }, now)
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
        join "user" u on u.id=a.professional_user_id
        where a.organization_id=${orgId} and not a.is_test and a.starts_at >= ${start} and a.starts_at < ${end} and ${status}
          ${scope.branch ? sql`and a.branch_id=${scope.branch.id}` : sql``}
        order by a.starts_at desc, a.id limit ${limit}`)),
    ]
  } else if (isFinanceList(query.list)) {
    // Las listas de Reportes › Finanzas: «Te deben» por antigüedad y lo aceptado sin cita.
    rows = (await financeListRows(tx, orgId, scope, query.list, limit, now)).map((row) => ({ ...row, at: new Date(row.at).toISOString() }))
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
        order by o.since, o.patient_id limit ${limit}`)),
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
        join "user" u on u.id=v.professional_user_id
        where v.starts_at >= ${start} and v.starts_at < ${end}
          ${scope.branch ? sql`and v.branch_id=${scope.branch.id}` : sql``}
        order by v.starts_at desc, v.id limit ${limit}`)),
    ]
  }

  return {
    ...reportHead(scope),
    list: query.list,
    /** Filas que existen; la respuesta trae como mucho `limit` (`REPORT_LIST_LIMIT` en la pantalla). */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents, at: when, ...row }) => ({
      ...row,
      at: new Date(when).toISOString(),
      cents: cents === null ? null : safeCents(cents),
    })),
  }
}
