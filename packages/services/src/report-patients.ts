/**
 * Reportes › Pacientes: quiénes nos buscaron por primera vez y hasta dónde
 * llegaron, por dónde llegaron, cómo nos conocieron y si vuelven. Solo
 * lecturas; ninguna cifra sale de un modelo.
 *
 * - El embudo sigue a las mismas personas (decisión 2): las que nos buscaron
 *   por primera vez en el tramo, hasta hoy, aunque el paso ocurra después del
 *   tramo. Cada paso cuenta a quien llegó a él o a uno posterior: las cifras
 *   nunca suben de un paso al siguiente y ninguna tasa pasa de 100 %. Sus
 *   pasos son los momentos de Oportunidades (`SALE_MOMENTS`): agendar una cita
 *   es «Evaluación agendada» (`advanceForAppointment`; cancelarla sin otra la
 *   devuelve, `returnForCancelledAppointment`, y «No vino» no), presentar el
 *   presupuesto es «Presupuesto enviado» (`linkPresentedBudget`) y aceptarlo,
 *   del todo o en parte, es «Ganada» (`decideBudgetOpportunity`).
 * - Paciente ≠ interlocutor: quien escribe por un paciente (su madre, quien lo
 *   registró desde su conversación o con su enlace) no es otra persona que
 *   nos buscó. Su mensaje es el primer contacto del paciente, con su canal, y
 *   nadie se cuenta dos veces. Spam, bloqueados y las pruebas del chat web no cuentan (`uncountedSql`).
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
import { uncountedSql } from "./conversation-state.js"
import { budgetAcceptanceMany } from "./report-summary.js"
import { productHooks } from "./products.js"
import { lastMonths } from "./report-periods.js"
import { INVITED_TO_RETURN_ACTION } from "./return-invites.js"
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

/** Los pasos del embudo, en orden: cada uno cuenta a quien llegó a él o a uno posterior. */
export const FUNNEL_STEPS = ["sought", "booked", "came", "budget", "accepted", "paid"] as const
export type FunnelStep = (typeof FUNNEL_STEPS)[number]
export type FunnelCounts = Record<FunnelStep, number>

/**
 * Los pasos que muestra la clínica. Donde lo indicado queda aceptado al
 * indicarlo (latidIA, decisión 15 del issue 229) no hay presupuesto que
 * recibir ni aceptar: tras venir, «pagó» es la consulta cobrada.
 */
export function funnelStepsOf(budgetRequired: boolean): readonly FunnelStep[] {
  return budgetRequired ? FUNNEL_STEPS : FUNNEL_STEPS.filter((step) => step !== "budget" && step !== "accepted")
}

/** Un tramo que terminó hace menos de estos días sigue abierto: quienes escribieron todavía pueden agendar. */
export const FUNNEL_OPEN_DAYS = 30
/** «Dejaron de escribir»: su último mensaje fue hace más de estos días y no tienen nada abierto. */
export const STOPPED_WRITING_DAYS = 3
/** Pacientes activos: con una cita atendida en estos meses. */
export const ACTIVE_MONTHS = 18
/**
 * Sin venir: su última cita atendida fue hace más de estos meses. Es el de
 * odentIA; cada producto dice el suyo (`ProductHooks.recallMonths`: latidIA, 12).
 */
export const LAPSED_MONTHS = 6

const DAY_MS = 86_400_000

/** Los presupuestos que se le presentaron a la persona, como en `budgetLinesSql`: sin borradores ni revisiones sustituidas. */
const PRESENTED_BUDGET = sql`b.status in ('aceptado','parcial','presentado','pospuesto','rechazado')`

/** Un instante movido `months` meses en la zona de la clínica (`-12`: el mismo momento un año antes). */
function monthsBefore(column: SQL, months: number, timezone: string): SQL {
  return sql`((${column} at time zone ${timezone}) - make_interval(months => ${months})) at time zone ${timezone}`
}

/**
 * El primer contacto de cada persona, una fila por persona:
 * `first_contact(person_id, patient_id, first_at, channel, writer_id)`.
 * - Un paciente: lo primero entre su propio primer mensaje entrante (en
 *   cualquier conversación y canal), el de quien escribió por él y lo
 *   registró (`writer_id`: `patient_registration.context_contact_id` o la
 *   persona de su `conversation_id`, si no es él) y su registro. De quien
 *   escribió por él cuenta solo lo que escribió en la conversación de ese
 *   registro en los `WRITER_LOOKBACK_DAYS` anteriores, no su primer mensaje de
 *   siempre: una madre que es paciente desde hace un año y hoy registra a su
 *   hijo trae al hijo hoy. `channel` es
 *   el de esa conversación (nulo si ese canal ya no existe) o, si lo primero
 *   fue el registro, `registro_en_linea` (lo llenó la persona: código QR,
 *   enlace público o el enlace de una conversación) o `recepcion` (lo registró
 *   el equipo).
 * - Quien aún no es paciente: su primer mensaje entrante, salvo que escriba
 *   por un paciente (vinculado sin ser `self`, o quien lo registró): esa
 *   búsqueda es la del paciente y no se cuenta otra vez.
 * Las conversaciones de quien está en Spam o bloqueado no cuentan.
 */
/** Cuánto antes de un registro cuenta lo que escribió quien registró al paciente: la búsqueda que lo trajo. */
export const WRITER_LOOKBACK_DAYS = 30

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
      where c.organization_id = ${orgId} and not ${uncountedSql(sql.raw("c"))}
      order by c.contact_id, fi.created_at, c.id
    ), registered as (
      select p.id as patient_id, p.person_id, p.created_at, r.conversation_id,
        nullif(coalesce(r.context_contact_id, rc.contact_id), p.person_id) as writer_id,
        case when r.entry_point in ('public_link', 'qr') or (r.entry_point = 'conversation' and r.actor_user_id is null)
          then 'registro_en_linea' else 'recepcion' end as registered_via
      from patient p
      left join patient_registration r on r.organization_id = p.organization_id and r.patient_id = p.id
      left join conversation rc on rc.organization_id = r.organization_id and rc.id = r.conversation_id
      where p.organization_id = ${orgId}
        and not exists (select 1 from contact t where t.organization_id = p.organization_id and t.id = p.person_id and t.is_test)
    ), first_contact as (
      select g.person_id, g.patient_id, k.at as first_at, k.channel, g.writer_id
      from registered g
      left join first_inbound own on own.contact_id = g.person_id
      left join lateral (
        select m.created_at as at, wcc.channel from message m
        join conversation wc on wc.organization_id = m.organization_id and wc.id = m.conversation_id
        left join channel_connection wcc on wcc.organization_id = wc.organization_id and wcc.id = wc.channel_connection_id
        where g.writer_id is not null and m.organization_id = ${orgId} and m.conversation_id = g.conversation_id
          and m.direction = 'in' and m.created_at <= g.created_at
          and m.created_at > g.created_at - make_interval(days => ${WRITER_LOOKBACK_DAYS})
          and not ${uncountedSql(sql.raw("wc"))}
        order by m.created_at, m.id limit 1
      ) w on true
      cross join lateral (
        select x.at, x.channel from (values (own.at, own.channel, 0), (w.at, w.channel, 1), (g.created_at, g.registered_via, 2)) as x(at, channel, rank)
        where x.at is not null order by x.at, x.rank limit 1
      ) k
      union all
      select i.contact_id, null::uuid, i.at, i.channel, null::uuid
      from first_inbound i
      where not exists (select 1 from patient p where p.organization_id = ${orgId} and p.person_id = i.contact_id)
        and not exists (select 1 from patient_contact v where v.organization_id = ${orgId} and v.contact_id = i.contact_id and v.relationship <> 'self')
        and not exists (select 1 from registered g where g.writer_id = i.contact_id)
    )`
}

/**
 * Las personas cuyo primer contacto cae en `hull` y hasta dónde llegaron hasta
 * hoy: `funnel(person_id, patient_id, first_at, channel, booked, came, budget,
 * accepted, paid, stopped, conversation_id)`. Cada paso ocurre desde su primer
 * contacto y cuenta a quien llegó a él o a uno posterior:
 * - agendó: una cita sin cancelar («No vino» cuenta; cancelar sin otra no);
 * - vino: una cita atendida o una atención firmada;
 * - recibió presupuesto (presentado) y lo aceptó (del todo o en parte, según
 *   su estado a hoy), sin exigir la cita atendida: la cita queda atendida al
 *   firmar la atención, que puede seguir en borrador;
 * - pagó algo: lo aceptó y tiene un pago sin anular; sin presupuesto
 *   (`budgetRequired` falso, latidIA), vino y lo tiene: la consulta cobrada.
 * `stopped`: no agendó, preguntó algo y dejó de escribir (ninguna conversación
 * suya ni de quien escribió por ella sigue abierta y nada llegó en los
 * últimos `STOPPED_WRITING_DAYS` días). `conversation_id`: de quien aún no es
 * paciente, su conversación más reciente.
 */
export function funnelSql(orgId: string, hull: Span, now: Date, budgetRequired = true): SQL {
  const quietSince = at(new Date(now.getTime() - STOPPED_WRITING_DAYS * DAY_MS))
  const beforePaying = budgetRequired ? sql`r.accepted` : sql`(r.came or r.budget)`
  return sql`with ${firstContactSql(orgId)}, cohort as (
      select * from first_contact k where k.first_at >= ${at(hull.start)} and k.first_at < ${at(hull.end)}
    ), reached as (
      select k.*,
        exists (select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = k.patient_id
          and a.created_at >= k.first_at and a.status <> 'cancelada') as booked,
        exists (select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = k.patient_id
          and a.created_at >= k.first_at and a.status = 'atendida')
          or exists (select 1 from encounter e where e.organization_id = ${orgId} and e.patient_id = k.patient_id
            and e.status = 'finalizada' and e.finalized_at >= k.first_at) as came,
        exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = k.patient_id
          and ${PRESENTED_BUDGET} and b.presented_at >= k.first_at) as budget,
        exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = k.patient_id
          and b.status in ('aceptado','parcial') and b.presented_at >= k.first_at) as accepted,
        exists (select 1 from patient_payment y where y.organization_id = ${orgId} and y.patient_id = k.patient_id
          and y.voided_at is null and y.paid_at >= k.first_at) as paid
      from cohort k
    ), talk as (
      -- Una fila por persona del tramo y por quien escribió por ella: si algo sigue abierto, lo último que llegó y la conversación más reciente.
      select c.contact_id, bool_or(c.status = 'open') as open, max(c.last_inbound_at) as last_in,
        (array_agg(c.id order by c.last_message_at desc nulls last, c.created_at desc, c.id))[1] as latest
      from conversation c
      where c.organization_id = ${orgId}
        and c.contact_id in (select person_id from cohort union all select writer_id from cohort where writer_id is not null)
      group by c.contact_id
    ), funnel as (
      select r.person_id, r.patient_id, r.first_at, r.channel,
        r.booked or r.came or r.budget as booked,
        r.came or r.budget as came,
        -- Aceptar exige un presupuesto presentado: ya está dentro de «budget».
        r.budget,
        r.accepted,
        ${beforePaying} and r.paid as paid,
        not (r.booked or r.came or r.budget)
          and coalesce(greatest(tp.last_in, tw.last_in) < ${quietSince}, false)
          and not coalesce(tp.open or tw.open, false) as stopped,
        case when r.patient_id is null then tp.latest end as conversation_id
      from reached r
      left join talk tp on tp.contact_id = r.person_id
      left join talk tw on tw.contact_id = r.writer_id
    )`
}

function emptyFunnel(): FunnelCounts {
  return { sought: 0, booked: 0, came: 0, budget: 0, accepted: 0, paid: 0 }
}

export type FunnelChannel = {
  /** Clave del canal (`whatsapp`, `instagram`…), `recepcion`, `registro_en_linea` o nulo si ese canal ya no existe. */
  channel: string | null
  sought: number
  came: number
}

/** El embudo de un tramo, por dónde nos buscaron (y cuántos vinieron) y cuántos de los que no agendaron dejaron de escribir. */
export type FunnelOfSpan = { counts: FunnelCounts; channels: FunnelChannel[]; stopped: number }

/**
 * El embudo de cada tramo: las personas que nos buscaron en él y hasta dónde
 * llegaron hasta hoy, por canal. De toda la clínica. Una sola consulta para
 * los pasos, los canales y quienes dejaron de escribir.
 */
export async function funnelMany(tx: Db, orgId: string, spans: Span[], now: Date = new Date()): Promise<FunnelOfSpan[]> {
  const { budgetRequired } = await productHooks(tx, orgId)
  const rows = await tx.execute<{ idx: number; channel: string | null; stopped: number } & FunnelCounts>(sql`
    ${funnelSql(orgId, hullOf(spans), now, budgetRequired)}
    select s.idx, f.channel, count(*)::int as sought,
      count(*) filter (where f.booked)::int as booked,
      count(*) filter (where f.came)::int as came,
      count(*) filter (where f.budget)::int as budget,
      count(*) filter (where f.accepted)::int as accepted,
      count(*) filter (where f.paid)::int as paid,
      count(*) filter (where f.stopped)::int as stopped
    from funnel f join ${spansSql(spans, "s")} on f.first_at >= s.start_at and f.first_at < s.end_at
    group by s.idx, f.channel order by s.idx, sought desc, f.channel`)
  return bySpan(
    spans,
    [...rows],
    (): FunnelOfSpan => ({ counts: emptyFunnel(), channels: [], stopped: 0 }),
    (span, row) => ({
      counts: Object.fromEntries(FUNNEL_STEPS.map((step) => [step, span.counts[step] + row[step]])) as FunnelCounts,
      channels: [...span.channels, { channel: row.channel, sought: row.sought, came: row.came }],
      stopped: span.stopped + row.stopped,
    }),
  )
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
      select a.id, a.patient_id, a.starts_at, a.branch_id, a.service_name, a.professional_user_id from appointment a
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
 * Sin venir hace más de `months` meses (los del producto), a hoy (la misma regla que
 * tendrá «Invitar a volver», #139): personas sin archivar cuya última cita
 * atendida fue antes de eso y que hoy no tienen cita por venir, presupuesto
 * que espere respuesta (`budgetAwaitsAnswerSql`) ni control pendiente. Da
 * `lapsed(id, patient_id, starts_at, branch_id, service_name, professional_user_id)`
 * con su última cita atendida.
 */
export function lapsedSql(
  orgId: string,
  scope: Pick<ReportScope, "branch" | "timezone">,
  now: Date,
  months: number = LAPSED_MONTHS,
): SQL {
  const budget = { id: sql`b.id`, status: sql`b.status`, organizationId: sql`b.organization_id` }
  return sql`${attendedSql(orgId, undefined)}, last_visit as (
      select distinct on (patient_id) * from attended order by patient_id, starts_at desc, id desc
    ), lapsed as (
      select v.* from last_visit v
      join patient p on p.organization_id = ${orgId} and p.id = v.patient_id
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id and pp.is_active
      where v.starts_at < ${monthsBefore(at(now), months, scope.timezone)}
        ${scope.branch ? sql`and v.branch_id = ${scope.branch.id}` : sql``}
        and not exists (select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = v.patient_id
          and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))
        and not exists (select 1 from treatment_budget b where b.organization_id = ${orgId} and b.patient_id = v.patient_id
          and ${budgetAwaitsAnswerSql(budget)})
        and not exists (select 1 from clinical_follow_up c where c.organization_id = ${orgId} and c.patient_id = v.patient_id
          and c.status in ('pendiente','programado'))
    )`
}

export async function lapsedCount(tx: Db, orgId: string, scope: ReportScope): Promise<number> {
  const months = (await productHooks(tx, orgId)).recallMonths
  const [row] = await tx.execute<{ count: number }>(sql`with ${lapsedSql(orgId, scope, scope.now, months)} select count(*)::int as count from lapsed`)
  return row?.count ?? 0
}

/**
 * «Volvieron tras la invitación» (#139): los pacientes invitados a volver en
 * el tramo, por el agente o con «Ya la invité» (`INVITED_TO_RETURN_ACTION`,
 * contado desde su primera invitación del tramo), y su primera cita atendida
 * después de esa invitación, a hoy. Da
 * `invited(patient_id, invited_at, returned_id, returned_at)`; `returned_id`
 * es nulo si todavía no volvió. Las invitaciones no son de una sede.
 */
function invitedSql(orgId: string, span: Pick<Span, "start" | "end">): SQL {
  return sql`first_invite as (
      select ae.entity_id as patient_id, min(ae.created_at) as invited_at from audit_event ae
      where ae.organization_id = ${orgId} and ae.action = ${INVITED_TO_RETURN_ACTION} and ae.entity = 'patient'
        and ae.created_at >= ${at(span.start)} and ae.created_at < ${at(span.end)}
      group by ae.entity_id
    ), invited as (
      select i.patient_id, i.invited_at, back.id as returned_id, back.starts_at as returned_at
      from first_invite i
      left join lateral (
        select a.id, a.starts_at from appointment a
        where a.organization_id = ${orgId} and a.patient_id::text = i.patient_id and a.status = 'atendida' and a.starts_at > i.invited_at
        order by a.starts_at, a.id limit 1
      ) back on true
    )`
}

export async function invitedToReturnCount(tx: Db, orgId: string, span: Pick<Span, "start" | "end">): Promise<{ invited: number; returned: number }> {
  const [row] = await tx.execute<{ invited: number; returned: number }>(sql`
    with ${invitedSql(orgId, span)}
    select count(*)::int as invited, count(returned_id)::int as returned from invited`)
  return { invited: row?.invited ?? 0, returned: row?.returned ?? 0 }
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
  const [current, previous] = await funnelMany(tx, orgId, [scope.window, scope.window.previous], now)
  return {
    ...reportHead(scope),
    funnel: {
      steps: funnelStepsOf((await productHooks(tx, orgId)).budgetRequired),
      current: current?.counts ?? emptyFunnel(),
      previous: previous?.counts ?? emptyFunnel(),
      open: stillOpen(scope.window.end, now),
      openDays: FUNNEL_OPEN_DAYS,
    },
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
  const [funnel, fresh, acceptance, active, returned, referral, controls, previousControls, lapsed, invites] = [
    await funnelMany(tx, orgId, spans, now),
    await newPatientsMany(tx, orgId, scope, spans),
    await budgetAcceptanceMany(tx, orgId, spans),
    await activePatientsMany(tx, orgId, scope, [window.end, window.previous.end]),
    await returnedMany(tx, orgId, scope, [window.end, window.previous.end, ...months.map((month) => month.end)]),
    await referralMany(tx, orgId, scope, [window]),
    await controlTotals(tx, orgId, window),
    await controlTotals(tx, orgId, window.previous),
    await lapsedCount(tx, orgId, scope),
    await invitedToReturnCount(tx, orgId, window),
  ]
  const nth = <T>(list: T[], index: number): T => list[index] as T
  const current = nth(funnel, 0)
  return {
    ...reportHead(scope),
    /** Los 12 meses de la línea de «Volvieron en el año». */
    months: months.map(serializeBucket),
    funnel: {
      steps: funnelStepsOf((await productHooks(tx, orgId)).budgetRequired),
      current: current.counts,
      previous: nth(funnel, 1).counts,
      open: stillOpen(window.end, now),
      openDays: FUNNEL_OPEN_DAYS,
      /** De las que no agendaron, cuántas preguntaron algo y dejaron de escribir. */
      stopped: current.stopped,
      stoppedDays: STOPPED_WRITING_DAYS,
    },
    channels: current.channels,
    newPatients: { current: nth(fresh, 0), previous: nth(fresh, 1) },
    acceptance: { current: nth(acceptance, 0), previous: nth(acceptance, 1) },
    active: { current: nth(active, 0), previous: nth(active, 1), months: ACTIVE_MONTHS },
    /** Cómo nos conocieron los pacientes nuevos del periodo; `kind` nulo: no lo dijeron. */
    referral: nth(referral, 0),
    controls: { current: controls, previous: previousControls },
    returned: { current: nth(returned, 0), previous: nth(returned, 1), months: returned.slice(2) },
    lapsed: { count: lapsed, months: (await productHooks(tx, orgId)).recallMonths },
    /** Invitados a volver en el periodo y cuántos de ellos ya vinieron, a hoy. */
    invites,
    /** Personas, conversaciones, presupuestos, controles e invitaciones no son de una sede. */
    wholeClinic: scope.branch ? (["funnel", "channels", "acceptance", "controls", "invites"] as const) : ([] as const),
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
  "invited_returned",
] as const
export type PatientReportListKey = (typeof PATIENT_REPORT_LISTS)[number]

export function isPatientReportList(value: string): value is PatientReportListKey {
  return (PATIENT_REPORT_LISTS as readonly string[]).includes(value)
}

/** Una fila de estas listas: es de una persona, que puede no ser paciente todavía. */
export type PatientReportListRow = Omit<ReportListRow, "patientId"> & {
  /** Null: la persona escribió pero aún no es paciente. */
  patientId: string | null
  personId: string
  /** Canal por el que nos buscó: solo en las listas del embudo (en las demás no viaja). */
  channel?: string | null
  /** De quien aún no es paciente, su conversación más reciente: la fila lleva a la Bandeja. */
  conversationId: string | null
}

const LIST_LIMIT = 200

type FunnelListKey = Exclude<PatientReportListKey, "controls_missed" | "lapsed" | "invited_returned">

/** Quiénes están en cada paso del embudo o se cayeron en él. */
const FUNNEL_WHERE: Record<FunnelListKey, SQL> = {
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
  funnel_stopped: sql`f.stopped`,
}

/** Sin presupuesto (latidIA), quien no pagó se cayó después de venir. */
function funnelWhere(list: FunnelListKey, budgetRequired: boolean): SQL {
  return list === "funnel_lost_paid" && !budgetRequired ? sql`f.came and not f.paid` : FUNNEL_WHERE[list]
}

export async function getPatientReportList(
  tx: Db,
  orgId: string,
  query: ReportQuery & { list: PatientReportListKey; limit?: number },
  now: Date = new Date(),
) {
  const scope = await reportScope(tx, orgId, query, now)
  const limit = Math.max(1, Math.min(query.limit ?? LIST_LIMIT, 5000))
  const { window } = scope
  const nextAppointment = (patient: SQL): SQL => sql`exists (
    select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = ${patient}
      and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))`
  type Row = Omit<PatientReportListRow, "cents"> & { cents: string | null; total: number }
  let rows: Row[]
  const { recallMonths } = await productHooks(tx, orgId)

  if (query.list === "controls_missed") {
    // Los controles que tocaban en el periodo y no se hicieron: los que no cuentan como «vino» en `controlTotals`.
    rows = [
      ...(await tx.execute<Row>(sql`
        select f.id, f.due_at as at, f.patient_id as "patientId", pp.id as "personId", pp.display_name as "personName",
          f.title, null::text as "professionalName", null::text as "branchName",
          ${nextAppointment(sql`f.patient_id`)} as "hasNextAppointment",
          null::text as cents, null::text as currency, null::uuid as "conversationId", count(*) over()::int as total
        from clinical_follow_up f
        left join encounter e on e.id = f.completed_encounter_id and e.organization_id = ${orgId}
        join patient p on p.id = f.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        where f.organization_id = ${orgId} and f.due_at >= ${at(window.start)} and f.due_at < ${at(window.end)}
          and not (f.status = 'realizado' and f.completed_encounter_id is not null and f.outcome is not null and e.status is not distinct from 'finalizada')
        order by f.due_at, f.id limit ${limit}`)),
    ]
  } else if (query.list === "lapsed") {
    rows = [
      ...(await tx.execute<Row>(sql`
        with ${lapsedSql(orgId, scope, now, recallMonths)}
        select v.patient_id::text as id, v.starts_at as at, v.patient_id as "patientId", pp.id as "personId", pp.display_name as "personName",
          v.service_name as title, u.name as "professionalName", br.name as "branchName",
          false as "hasNextAppointment", null::text as cents, null::text as currency, null::uuid as "conversationId", count(*) over()::int as total
        from lapsed v
        join patient p on p.id = v.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        left join branch br on br.id = v.branch_id and br.organization_id = ${orgId}
        left join "user" u on u.id = v.professional_user_id
        order by v.starts_at, v.patient_id limit ${limit}`)),
    ]
  } else if (query.list === "invited_returned") {
    // Los invitados del periodo que ya volvieron, con la cita en que volvieron.
    rows = [
      ...(await tx.execute<Row>(sql`
        with ${invitedSql(orgId, window)}
        select a.id::text as id, i.returned_at as at, p.id as "patientId", pp.id as "personId", pp.display_name as "personName",
          a.service_name as title, u.name as "professionalName", br.name as "branchName",
          false as "hasNextAppointment", null::text as cents, null::text as currency, null::uuid as "conversationId", count(*) over()::int as total
        from invited i
        join appointment a on a.id = i.returned_id and a.organization_id = ${orgId}
        join patient p on p.id = a.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        left join branch br on br.id = a.branch_id and br.organization_id = ${orgId}
        left join "user" u on u.id = a.professional_user_id
        order by i.returned_at desc, a.id limit ${limit}`)),
    ]
  } else {
    const { budgetRequired } = await productHooks(tx, orgId)
    rows = [
      ...(await tx.execute<Row>(sql`
        ${funnelSql(orgId, window, now, budgetRequired)}
        select f.person_id::text as id, f.first_at as at, f.patient_id as "patientId", f.person_id as "personId", pp.display_name as "personName",
          null::text as title, null::text as "professionalName", null::text as "branchName",
          (f.patient_id is not null and ${nextAppointment(sql`f.patient_id`)}) as "hasNextAppointment",
          null::text as cents, null::text as currency, f.channel, f.conversation_id as "conversationId",
          count(*) over()::int as total
        from funnel f join contact pp on pp.organization_id = ${orgId} and pp.id = f.person_id
        where ${funnelWhere(query.list, budgetRequired)}
        order by f.first_at desc, f.person_id limit ${limit}`)),
    ]
  }

  return {
    ...reportHead(scope),
    list: query.list,
    /** Las personas del embudo, los controles y las invitaciones no son de una sede: con una sede elegida, la lista es de toda la clínica. */
    wholeClinic: scope.branch !== null && query.list !== "lapsed",
    /** Los plazos con que se arma la lista, para decirlos en «Cómo se calcula». */
    rules: { stoppedDays: STOPPED_WRITING_DAYS, lapsedMonths: recallMonths },
    /** Filas que existen; la respuesta trae como mucho `LIST_LIMIT`. */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents: _cents, at: when, ...row }) => ({
      ...row,
      at: new Date(when).toISOString(),
      cents: null,
    })),
  }
}
