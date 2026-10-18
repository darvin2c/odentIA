/**
 * Reportes › Pacientes: quiénes nos buscaron por primera vez y hasta dónde
 * llegaron, por dónde llegaron, cómo nos conocieron y si vuelven. Solo
 * lecturas; ninguna cifra sale de un modelo.
 *
 * - El embudo sigue a las mismas personas (decisión 2): las que nos buscaron
 *   por primera vez en el tramo, hasta hoy, aunque el paso ocurra después del
 *   tramo. Cada paso cuenta a quien dio también los anteriores: ninguna tasa
 *   pasa de 100 %. Sus pasos son los momentos de Oportunidades
 *   (`SALE_MOMENTS`): agendar una cita es «Evaluación agendada»
 *   (`advanceForAppointment`), presentar el presupuesto es «Presupuesto
 *   enviado» (`linkPresentedBudget`) y aceptarlo, del todo o en parte, es
 *   «Ganada» (`decideBudgetOpportunity`). Por eso las cifras coinciden.
 * - La aceptación es la del Resumen (`budgetAcceptanceMany`) y los pacientes
 *   nuevos, la de siempre (`newPatientsMany`): no hay dos definiciones.
 * - Las personas, sus conversaciones, presupuestos y controles no son de una
 *   sede: con una sede elegida se entregan de toda la clínica y lo dice
 *   (`wholeClinic`). Lo que sale de las citas (pacientes nuevos, cómo nos
 *   conocieron, activos, volvieron y sin venir) sí se filtra por sede.
 * - Cada cifra es una consulta por tramos (`spansSql`): la tarjeta, su
 *   comparación, su línea y su lista usan la misma definición.
 */
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { budgetAcceptanceMany } from "./report-summary.js"
import { lastMonths } from "./report-periods.js"
import {
  at,
  bySpan,
  hullOf,
  type ReportQuery,
  type ReportScope,
  reportHead,
  reportScope,
  serializeBucket,
  type Span,
  spansSql,
} from "./report-scope.js"
import { controlTotals, firstVisitSql, newPatientsMany, type ReportListRow } from "./reports.js"

/** Los pasos del embudo, en orden: cada uno exige los anteriores. */
export const FUNNEL_STEPS = ["sought", "booked", "came", "budget", "accepted", "paid"] as const
export type FunnelStep = (typeof FUNNEL_STEPS)[number]
export type FunnelCounts = Record<FunnelStep, number>

/** Un tramo que terminó hace menos de estos días sigue abierto: quienes escribieron todavía pueden agendar. */
export const FUNNEL_OPEN_DAYS = 30
/** «Dejaron de escribir»: su último mensaje fue hace más de estos días y no tienen nada abierto. */
export const STOPPED_WRITING_DAYS = 3
/** Pacientes activos: con una cita atendida en estos meses. */
export const ACTIVE_MONTHS = 18
/** Sin venir: su última cita atendida fue hace más de estos meses. */
export const LAPSED_MONTHS = 6

const DAY_MS = 86_400_000

/** Los presupuestos que se le presentaron a la persona, como en `budgetLinesSql`: sin borradores ni revisiones sustituidas. */
const PRESENTED_BUDGET = sql`b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')`

/** Un instante movido `months` meses en la zona de la clínica (`-12`: el mismo momento un año antes). */
function monthsBefore(column: SQL, months: number, timezone: string): SQL {
  return sql`((${column} at time zone ${timezone}) - make_interval(months => ${months})) at time zone ${timezone}`
}

/**
 * El primer contacto de cada persona: su primer mensaje entrante (en
 * cualquier conversación y canal) o, si fue antes, su registro como paciente
 * (lo registró recepción o se registró en línea). Da `first_contact(person_id,
 * patient_id, first_at, channel, wrote)`: `channel` es el de esa primera
 * conversación (nulo si ese canal ya no existe), `recepcion` o
 * `registro_en_linea`; `wrote` dice si lo primero fue un mensaje.
 */
export function firstContactSql(orgId: string): SQL {
  return sql`first_inbound as (
      select distinct on (c.contact_id) c.contact_id, fi.created_at as at, cc.channel
      from conversation c
      join lateral (
        select m.created_at from message m
        where m.organization_id = ${orgId} and m.conversation_id = c.id and m.direction = 'in'
        order by m.created_at, m.id limit 1
      ) fi on true
      left join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id
      where c.organization_id = ${orgId}
      order by c.contact_id, fi.created_at, c.id
    ), registered as (
      select p.id as patient_id, p.person_id, p.created_at, r.entry_point
      from patient p
      left join patient_registration r on r.organization_id = p.organization_id and r.patient_id = p.id
      where p.organization_id = ${orgId}
    ), first_contact as (
      select coalesce(r.person_id, i.contact_id) as person_id, r.patient_id,
        least(i.at, r.created_at) as first_at,
        (i.at is not null and (r.created_at is null or i.at <= r.created_at)) as wrote,
        case
          when i.at is not null and (r.created_at is null or i.at <= r.created_at) then i.channel
          when r.entry_point in ('public_link', 'qr') then 'registro_en_linea'
          else 'recepcion'
        end as channel
      from first_inbound i full join registered r on r.person_id = i.contact_id
    )`
}

/**
 * Las personas cuyo primer contacto cae en `hull` y hasta dónde llegaron hasta
 * hoy: `funnel(person_id, patient_id, first_at, channel, wrote, booked, came,
 * budget, accepted, paid)`. Cada paso ocurre desde su primer contacto y exige
 * los anteriores: agendó (una cita creada desde entonces), vino (una de esas
 * citas, atendida), recibió presupuesto (presentado), lo aceptó (del todo o en
 * parte, según su estado a hoy) y pagó algo (un pago sin anular).
 */
export function funnelSql(orgId: string, hull: Span): SQL {
  return sql`with ${firstContactSql(orgId)}, reached as (
      select k.*,
        exists (select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = k.patient_id
          and a.created_at >= k.first_at) as booked,
        exists (select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = k.patient_id
          and a.created_at >= k.first_at and a.status = 'atendida') as came,
        exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = k.patient_id
          and ${PRESENTED_BUDGET} and b.presented_at >= k.first_at) as budget,
        exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = k.patient_id
          and b.status in ('aceptado','parcial') and b.presented_at >= k.first_at) as accepted,
        exists (select 1 from patient_payment y where y.organization_id = ${orgId} and y.patient_id = k.patient_id
          and y.voided_at is null and y.paid_at >= k.first_at) as paid
      from first_contact k
      where k.first_at >= ${at(hull.start)} and k.first_at < ${at(hull.end)}
    ), funnel as (
      select person_id, patient_id, first_at, channel, wrote,
        booked,
        booked and came as came,
        booked and came and budget as budget,
        booked and came and budget and accepted as accepted,
        booked and came and budget and accepted and paid as paid
      from reached
    )`
}

/**
 * Preguntaron algo y dejaron de escribir: tienen una conversación con algo
 * suyo, ninguna sigue abierta y nada suyo llegó en los últimos
 * `STOPPED_WRITING_DAYS` días. Condición sobre una fila de `funnel` (`f`).
 */
function stoppedWritingSql(orgId: string, now: Date): SQL {
  return sql`(exists (select 1 from conversation c where c.organization_id = ${orgId} and c.contact_id = f.person_id and c.last_inbound_at is not null)
    and not exists (select 1 from conversation c where c.organization_id = ${orgId} and c.contact_id = f.person_id
      and (c.status = 'open' or c.last_inbound_at >= ${at(new Date(now.getTime() - STOPPED_WRITING_DAYS * DAY_MS))})))`
}

function emptyFunnel(): FunnelCounts {
  return { sought: 0, booked: 0, came: 0, budget: 0, accepted: 0, paid: 0 }
}

/** El embudo de cada tramo: las personas que nos buscaron en él y hasta dónde llegaron hasta hoy. De toda la clínica. */
export async function funnelMany(tx: Db, orgId: string, spans: Span[]): Promise<FunnelCounts[]> {
  const rows = await tx.execute<{ idx: number } & FunnelCounts>(sql`
    ${funnelSql(orgId, hullOf(spans))}
    select s.idx, count(*)::int as sought,
      count(*) filter (where f.booked)::int as booked,
      count(*) filter (where f.came)::int as came,
      count(*) filter (where f.budget)::int as budget,
      count(*) filter (where f.accepted)::int as accepted,
      count(*) filter (where f.paid)::int as paid
    from funnel f join ${spansSql(spans, "s")} on f.first_at >= s.start_at and f.first_at < s.end_at
    group by s.idx`)
  return bySpan(spans, [...rows], emptyFunnel, (_, row) => ({
    sought: row.sought,
    booked: row.booked,
    came: row.came,
    budget: row.budget,
    accepted: row.accepted,
    paid: row.paid,
  }))
}

export type FunnelChannel = {
  /** Clave del canal (`whatsapp`, `instagram`…), `recepcion`, `registro_en_linea` o nulo si ese canal ya no existe. */
  channel: string | null
  sought: number
  came: number
}

/**
 * Por dónde nos buscaron las personas del tramo (el canal de su primera
 * conversación, que lo sabe el sistema) y cuántas vinieron; y cuántas de las
 * que no agendaron dejaron de escribir.
 */
export async function funnelChannels(tx: Db, orgId: string, span: Span, now: Date): Promise<{ channels: FunnelChannel[]; stopped: number }> {
  const rows = await tx.execute<FunnelChannel & { stopped: number }>(sql`
    ${funnelSql(orgId, span)}
    select f.channel, count(*)::int as sought, count(*) filter (where f.came)::int as came,
      count(*) filter (where not f.booked and ${stoppedWritingSql(orgId, now)})::int as stopped
    from funnel f group by f.channel order by sought desc, f.channel`)
  return {
    channels: rows.map((row) => ({ channel: row.channel, sought: row.sought, came: row.came })),
    stopped: rows.reduce((total, row) => total + row.stopped, 0),
  }
}

/** Cómo nos conocieron los pacientes nuevos de cada tramo (su primera cita atendida cae dentro); `kind` nulo: no lo dijeron. */
export async function referralMany(
  tx: Db,
  orgId: string,
  scope: Pick<ReportScope, "branch">,
  spans: Span[],
): Promise<Array<Array<{ kind: string | null; count: number }>>> {
  const rows = await tx.execute<{ idx: number; kind: string | null; count: number }>(sql`
    with ${firstVisitSql(orgId)}
    select s.idx, p.referral_kind as kind, count(*)::int as count
    from ${spansSql(spans, "s")}
    join first_visit v on v.starts_at >= s.start_at and v.starts_at < s.end_at
      ${scope.branch ? sql`and v.branch_id = ${scope.branch.id}` : sql``}
    join patient p on p.organization_id = ${orgId} and p.id = v.patient_id
    group by s.idx, p.referral_kind order by count desc, kind`)
  return bySpan(
    spans,
    [...rows],
    (): Array<{ kind: string | null; count: number }> => [],
    (list, row) => [...list, { kind: row.kind, count: row.count }],
  )
}

/** Citas atendidas, de la sede si se eligió una: la base de activos, volvieron y sin venir. */
function attendedSql(orgId: string, branchId: string | undefined): SQL {
  return sql`attended as (
      select a.id, a.patient_id, a.starts_at, a.branch_id, a.service_name, a.dentist_user_id from appointment a
      where a.organization_id = ${orgId} and a.status = 'atendida' ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    )`
}

/** Pacientes activos en cada momento: con una cita atendida en los `ACTIVE_MONTHS` meses anteriores. */
export async function activePatientsMany(tx: Db, orgId: string, scope: Pick<ReportScope, "branch" | "timezone">, moments: Date[]): Promise<number[]> {
  const spans = moments.map((moment) => ({ start: moment, end: moment }))
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    with ${attendedSql(orgId, scope.branch?.id)}
    select s.idx, count(distinct v.patient_id)::int as count
    from ${spansSql(spans, "s")}
    join attended v on v.starts_at < s.end_at and v.starts_at >= ${monthsBefore(sql`s.end_at`, ACTIVE_MONTHS, scope.timezone)}
    group by s.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

/**
 * Volvieron en el año, en cada momento: de los pacientes con una cita
 * atendida hace 12 a 24 meses, cuántos tuvieron otra en los últimos 12.
 */
export async function returnedMany(
  tx: Db,
  orgId: string,
  scope: Pick<ReportScope, "branch" | "timezone">,
  moments: Date[],
): Promise<Array<{ cohort: number; returned: number }>> {
  const spans = moments.map((moment) => ({ start: moment, end: moment }))
  const yearAgo = monthsBefore(sql`s.end_at`, 12, scope.timezone)
  const rows = await tx.execute<{ idx: number; cohort: number; returned: number }>(sql`
    with ${attendedSql(orgId, scope.branch?.id)}, before as (
      select distinct s.idx, v.patient_id from ${spansSql(spans, "s")}
      join attended v on v.starts_at >= ${monthsBefore(sql`s.end_at`, 24, scope.timezone)} and v.starts_at < ${yearAgo}
    ), recent as (
      select distinct s.idx, v.patient_id from ${spansSql(spans, "s")}
      join attended v on v.starts_at >= ${yearAgo} and v.starts_at < s.end_at
    )
    select o.idx, count(*)::int as cohort, count(r.patient_id)::int as returned
    from before o left join recent r on r.idx = o.idx and r.patient_id = o.patient_id
    group by o.idx`)
  return bySpan(spans, [...rows], () => ({ cohort: 0, returned: 0 }), (_, row) => ({ cohort: row.cohort, returned: row.returned }))
}

/**
 * Sin venir hace más de `LAPSED_MONTHS` meses, a hoy (la misma regla que
 * tendrá «Invitar a volver», #139): personas sin archivar cuya última cita
 * atendida fue antes de eso y que hoy no tienen cita por venir, presupuesto
 * que espere respuesta (`budgetAwaitsAnswerSql`) ni control pendiente. Da
 * `lapsed(id, patient_id, starts_at, branch_id, service_name, dentist_user_id)`
 * con su última cita atendida.
 */
export function lapsedSql(orgId: string, scope: Pick<ReportScope, "branch" | "timezone">, now: Date): SQL {
  const budget = { id: sql`b.id`, status: sql`b.status`, organizationId: sql`b.organization_id` }
  return sql`${attendedSql(orgId, undefined)}, last_visit as (
      select distinct on (patient_id) * from attended order by patient_id, starts_at desc, id desc
    ), lapsed as (
      select v.* from last_visit v
      join patient p on p.organization_id = ${orgId} and p.id = v.patient_id
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
      where v.starts_at < ${monthsBefore(at(now), LAPSED_MONTHS, scope.timezone)}
        ${scope.branch ? sql`and v.branch_id = ${scope.branch.id}` : sql``}
        and not exists (select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = v.patient_id
          and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))
        and not exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = v.patient_id
          and ${budgetAwaitsAnswerSql(budget)})
        and not exists (select 1 from clinical_follow_up c where c.organization_id = ${orgId} and c.patient_id = v.patient_id
          and c.status in ('pendiente','programado'))
    )`
}

async function lapsedCount(tx: Db, orgId: string, scope: ReportScope): Promise<number> {
  const [row] = await tx.execute<{ count: number }>(sql`with ${lapsedSql(orgId, scope, scope.now)} select count(*)::int as count from lapsed`)
  return row?.count ?? 0
}

/** El tramo terminó hace menos de `FUNNEL_OPEN_DAYS` días (o todavía corre): sus personas aún pueden agendar. */
function stillOpen(end: Date, now: Date): boolean {
  return now.getTime() - end.getTime() < FUNNEL_OPEN_DAYS * DAY_MS
}

/**
 * Resumen › «Dónde se caen los pacientes»: el embudo del periodo y el del
 * anterior. Va aparte de la pestaña para que el Resumen no espere a lo demás.
 */
export async function getReportFunnel(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const [current, previous] = await funnelMany(tx, orgId, [scope.window, scope.window.previous])
  return {
    ...reportHead(scope),
    funnel: { current: current ?? emptyFunnel(), previous: previous ?? emptyFunnel(), open: stillOpen(scope.window.end, now), openDays: FUNNEL_OPEN_DAYS },
    /** Las personas no son de una sede. */
    wholeClinic: scope.branch ? (["funnel"] as const) : ([] as const),
  }
}

export async function getReportPatients(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const spans: Span[] = [window, window.previous]
  // «Volvieron en el año» lleva su línea de 12 meses, que terminan en el último mes del periodo.
  const months = lastMonths(scope.timezone, window.to, 12, window.end)
  const [funnel, detail, fresh, acceptance, active, returned, referral, controls, previousControls, lapsed] = [
    await funnelMany(tx, orgId, spans),
    await funnelChannels(tx, orgId, window, now),
    await newPatientsMany(tx, orgId, scope, spans),
    await budgetAcceptanceMany(tx, orgId, spans),
    await activePatientsMany(tx, orgId, scope, [window.end, window.previous.end]),
    await returnedMany(tx, orgId, scope, [window.end, window.previous.end, ...months.map((month) => month.end)]),
    await referralMany(tx, orgId, scope, [window]),
    await controlTotals(tx, orgId, window),
    await controlTotals(tx, orgId, window.previous),
    await lapsedCount(tx, orgId, scope),
  ]
  const nth = <T>(list: T[], index: number): T => list[index] as T
  return {
    ...reportHead(scope),
    /** Los 12 meses de la línea de «Volvieron en el año». */
    months: months.map(serializeBucket),
    funnel: {
      current: nth(funnel, 0),
      previous: nth(funnel, 1),
      open: stillOpen(window.end, now),
      openDays: FUNNEL_OPEN_DAYS,
      /** De las que no agendaron, cuántas preguntaron algo y dejaron de escribir. */
      stopped: detail.stopped,
      stoppedDays: STOPPED_WRITING_DAYS,
    },
    channels: detail.channels,
    newPatients: { current: nth(fresh, 0), previous: nth(fresh, 1) },
    acceptance: { current: nth(acceptance, 0), previous: nth(acceptance, 1) },
    active: { current: nth(active, 0), previous: nth(active, 1), months: ACTIVE_MONTHS },
    /** Cómo nos conocieron los pacientes nuevos del periodo; `kind` nulo: no lo dijeron. */
    referral: nth(referral, 0),
    controls: { current: controls, previous: previousControls },
    returned: { current: nth(returned, 0), previous: nth(returned, 1), months: returned.slice(2) },
    lapsed: { count: lapsed, months: LAPSED_MONTHS },
    /** Personas, conversaciones, presupuestos y controles no son de una sede. */
    wholeClinic: scope.branch ? (["funnel", "channels", "acceptance", "controls"] as const) : ([] as const),
  }
}

// --- Las listas detrás de las cifras --------------------------------------------------------

/** Las listas de esta pestaña: las personas de cada paso del embudo, las que se cayeron en él y las de «Si vuelven». */
export const PATIENT_REPORT_LISTS = [
  "funnel_sought",
  "funnel_booked",
  "funnel_came",
  "funnel_budget",
  "funnel_accepted",
  "funnel_paid",
  "funnel_lost_booked",
  "funnel_lost_came",
  "funnel_lost_budget",
  "funnel_lost_accepted",
  "funnel_lost_paid",
  "funnel_stopped",
  "controls_missed",
  "lapsed",
] as const
export type PatientReportListKey = (typeof PATIENT_REPORT_LISTS)[number]

export function isPatientReportList(value: string): value is PatientReportListKey {
  return (PATIENT_REPORT_LISTS as readonly string[]).includes(value)
}

/** Una fila de estas listas: es de una persona, que puede no ser paciente todavía. */
export type PatientReportListRow = Omit<ReportListRow, "patientId"> & {
  patientId: string | null
  personId: string
  /** Canal por el que nos buscó, en las listas del embudo. */
  channel: string | null
}

const LIST_LIMIT = 200

/** Quiénes están en cada paso del embudo o se cayeron en él. */
const FUNNEL_WHERE: Record<Exclude<PatientReportListKey, "funnel_stopped" | "controls_missed" | "lapsed">, SQL> = {
  funnel_sought: sql`true`,
  funnel_booked: sql`f.booked`,
  funnel_came: sql`f.came`,
  funnel_budget: sql`f.budget`,
  funnel_accepted: sql`f.accepted`,
  funnel_paid: sql`f.paid`,
  funnel_lost_booked: sql`not f.booked`,
  funnel_lost_came: sql`f.booked and not f.came`,
  funnel_lost_budget: sql`f.came and not f.budget`,
  funnel_lost_accepted: sql`f.budget and not f.accepted`,
  funnel_lost_paid: sql`f.accepted and not f.paid`,
}

export async function getPatientReportList(
  tx: Db,
  orgId: string,
  query: ReportQuery & { list: PatientReportListKey },
  now: Date = new Date(),
) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const nextAppointment = (patient: SQL): SQL => sql`exists (
    select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = ${patient}
      and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))`
  type Row = Omit<PatientReportListRow, "cents"> & { cents: string | null; total: number }
  let rows: Row[]

  if (query.list === "controls_missed") {
    // Los controles que tocaban en el periodo y no se hicieron: los que no cuentan como «vino» en `controlTotals`.
    rows = [
      ...(await tx.execute<Row>(sql`
        select f.id, f.due_at as at, f.patient_id as "patientId", pp.id as "personId", pp.display_name as "personName",
          f.title, null::text as "professionalName", null::text as "branchName",
          ${nextAppointment(sql`f.patient_id`)} as "hasNextAppointment",
          null::text as cents, null::text as currency, null::text as channel, count(*) over()::int as total
        from clinical_follow_up f
        left join encounter e on e.id = f.completed_encounter_id and e.organization_id = ${orgId}
        join patient p on p.id = f.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        where f.organization_id = ${orgId} and f.due_at >= ${at(window.start)} and f.due_at < ${at(window.end)}
          and not (f.status = 'realizado' and f.completed_encounter_id is not null and f.outcome is not null and e.status is not distinct from 'finalizada')
        order by f.due_at, f.id limit ${LIST_LIMIT}`)),
    ]
  } else if (query.list === "lapsed") {
    rows = [
      ...(await tx.execute<Row>(sql`
        with ${lapsedSql(orgId, scope, now)}
        select v.patient_id::text as id, v.starts_at as at, v.patient_id as "patientId", pp.id as "personId", pp.display_name as "personName",
          v.service_name as title, u.name as "professionalName", br.name as "branchName",
          false as "hasNextAppointment", null::text as cents, null::text as currency, null::text as channel, count(*) over()::int as total
        from lapsed v
        join patient p on p.id = v.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        left join branch br on br.id = v.branch_id and br.organization_id = ${orgId}
        left join "user" u on u.id = v.dentist_user_id
        order by v.starts_at, v.patient_id limit ${LIST_LIMIT}`)),
    ]
  } else {
    const where = query.list === "funnel_stopped" ? sql`not f.booked and ${stoppedWritingSql(orgId, now)}` : FUNNEL_WHERE[query.list]
    rows = [
      ...(await tx.execute<Row>(sql`
        ${funnelSql(orgId, window)}
        select f.person_id::text as id, f.first_at as at, f.patient_id as "patientId", f.person_id as "personId", pp.display_name as "personName",
          null::text as title, null::text as "professionalName", null::text as "branchName",
          (f.patient_id is not null and ${nextAppointment(sql`f.patient_id`)}) as "hasNextAppointment",
          null::text as cents, null::text as currency, f.channel, count(*) over()::int as total
        from funnel f join contact pp on pp.organization_id = ${orgId} and pp.id = f.person_id
        where ${where}
        order by f.first_at desc, f.person_id limit ${LIST_LIMIT}`)),
    ]
  }

  return {
    ...reportHead(scope),
    list: query.list,
    /** Filas que existen; la respuesta trae como mucho `LIST_LIMIT`. */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents: _cents, at: when, ...row }) => ({
      ...row,
      at: new Date(when).toISOString(),
      cents: null,
    })),
  }
}
