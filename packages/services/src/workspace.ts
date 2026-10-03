import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
import { notFound, validation } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { listHandoffs, listProposals, type ProposalItem } from "./agent-operations.js"

export interface WorkspaceAccess {
  patients: boolean
  appointments: boolean
  conversations: boolean
  tasks: boolean
  finance: boolean
  clinical: boolean
  crm: boolean
  agent: boolean
  allTasks: boolean
}

export async function createWorkspaceNotification(tx: Db, orgId: string, input: {
  userId: string; dedupeKey: string; title: string; body: string; href: string; permission: string
}) {
  if (!/^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(input.href)) throw validation("El destino del aviso debe ser una ruta interna")
  if (!input.title.trim() || input.title.length > 200 || input.body.length > 1000 || input.dedupeKey.length > 300)
    throw validation("El aviso excede los límites admitidos")
  const [recipient] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, input.userId))).limit(1)
  if (!recipient) throw notFound("Destinatario")
  await tx.insert(workspaceNotification).values({ organizationId: orgId, ...input })
    .onConflictDoNothing({ target: [workspaceNotification.organizationId, workspaceNotification.userId, workspaceNotification.dedupeKey] })
}

export async function listWorkspaceNotifications(tx: Db, orgId: string, userId: string, permissions: string[]) {
  // Materializa avisos de vencimiento para el destinatario, sin un temporizador en memoria.
  if (permissions.includes("tasks.read")) {
    await tx.execute(sql`insert into workspace_notification
      (organization_id, user_id, dedupe_key, title, body, href, permission)
      select ${orgId}, ${userId}, 'task-due:' || id || ':' || due_at::text,
        'Tarea vencida', title, '/tasks', 'tasks.read'
      from task where organization_id = ${orgId} and assignee_user_id = ${userId}
        and status = 'open' and due_at <= now()
      on conflict (organization_id, user_id, dedupe_key) do nothing`)
  }
  if (permissions.includes("conversations.read")) {
    await tx.execute(sql`insert into workspace_notification
      (organization_id, user_id, dedupe_key, title, body, href, permission)
      select ${orgId}, ${userId}, 'conversation:' || id || ':' || last_inbound_at::text,
        'Conversación pendiente', 'Tienes un mensaje pendiente de atención.',
        '/inbox?conversation=' || id, 'conversations.read'
      from conversation where organization_id = ${orgId} and assigned_user_id = ${userId}
        and status = 'open' and unread_count > 0 and last_inbound_at is not null
      on conflict (organization_id, user_id, dedupe_key) do nothing`)
  }
  if (permissions.length === 0) return { items: [], unread: 0 }
  const scope = and(eq(workspaceNotification.organizationId, orgId), eq(workspaceNotification.userId, userId), inArray(workspaceNotification.permission, permissions))
  const items = await tx.select().from(workspaceNotification).where(scope)
    .orderBy(desc(workspaceNotification.createdAt), desc(workspaceNotification.id)).limit(100)
  const [count] = await tx.select({ value: sql<number>`count(*)::int` }).from(workspaceNotification)
    .where(and(scope, isNull(workspaceNotification.readAt)))
  return { items, unread: count?.value ?? 0 }
}

export async function readWorkspaceNotification(tx: Db, orgId: string, userId: string, id: string, permissions: string[]) {
  if (permissions.length === 0) throw notFound("Aviso")
  const [row] = await tx.update(workspaceNotification).set({ readAt: sql`coalesce(${workspaceNotification.readAt}, now())` })
    .where(and(eq(workspaceNotification.id, id), eq(workspaceNotification.organizationId, orgId),
      eq(workspaceNotification.userId, userId), inArray(workspaceNotification.permission, permissions)))
    .returning({ id: workspaceNotification.id })
  if (!row) throw notFound("Aviso")
  return row
}

async function workspaceZone(tx: Db, orgId: string) {
  const { timezone, locale } = await getOrgLocale(tx, orgId)
  return { timezone, locale }
}


export interface WorkspaceAgentHome {
  pendingProposals: number
  proposals: Array<{ id: string; action: string; summary: string; createdAt: string; conversationId: string | null; mode: string; context: ProposalItem["context"] }>
  recentHandoffs: Array<{ id: string; reason: string; priority: string; createdAt: string; conversationId: string | null; contactName: string | null; channel: string | null }>
  today: { runs: number; ok: number; handoff: number; error: number; omitida: number }
}

/** Banda del agente para el home: pendientes, derivaciones recientes y corridas de hoy (zona de la org). */
async function workspaceAgent(tx: Db, orgId: string, start: SQL, end: SQL): Promise<WorkspaceAgentHome> {
  const proposalRows = await listProposals(tx, orgId, { status: "propuesta", limit: 3 })
  const [pending] = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from agent_proposal where organization_id=${orgId} and status='propuesta'`)
  const handoffRows = (await listHandoffs(tx, orgId, { limit: 3 }))
    .filter(row => Date.parse(row.createdAt) >= Date.now() - 72 * 3_600_000)
  const [today] = await tx.execute<{ runs: number; ok: number; handoff: number; error: number; omitida: number }>(sql`
    select count(*)::int as runs,
      count(*) filter (where status='ok')::int as ok,
      count(*) filter (where status='handoff')::int as handoff,
      count(*) filter (where status='error')::int as error,
      count(*) filter (where status='omitida')::int as omitida
    from agent_run_ledger where organization_id=${orgId} and started_at >= ${start} and started_at < ${end}`)
  return {
    pendingProposals: pending?.count ?? 0,
    proposals: proposalRows.map(row => ({
      id: row.id, action: row.action, summary: row.context.afterSummary,
      createdAt: row.createdAt, conversationId: row.conversationId, mode: row.mode, context: row.context,
    })),
    recentHandoffs: handoffRows.map(row => ({
      id: row.id, reason: row.reason, priority: row.priority, createdAt: row.createdAt,
      conversationId: row.conversationId, contactName: row.contactName, channel: row.channel,
    })),
    today: {
      runs: today?.runs ?? 0, ok: today?.ok ?? 0, handoff: today?.handoff ?? 0,
      error: today?.error ?? 0, omitida: today?.omitida ?? 0,
    },
  }
}

export interface WorkspacePulse {
  funnel: { stage: string; count: number; amountCents: string; currency: string }[] | null
  channels: { channel: string; count: number }[] | null
  execution: Array<{ day: string; ok: number; handoff: number; error: number }> | null
  collections: { day: string; currency: string; amountCents: string }[] | null
  performance: CrmPerformance
}


export interface CrmPerformance {
  responses: { conversations: number; responded: number; timedResponses: number; avgFirstResponseSeconds: number | null } | null
  followUps: { open: number; overdue: number; unassigned: number } | null
  conversations: { closed: number; waiting: number } | null
  bookings: Array<{ source: string; count: number; active: number }> | null
  conversion: Array<{ channel: string | null; assigneeUserId: string | null; assigneeName: string | null; created: number; won: number; lost: number; open: number; wonRate: number | null }> | null
  proposals: { executed: number; failed: number; pending: number } | null
}

/** Cohorte por fecha de entrada/creación; los pendientes son una foto actual. */
async function crmPerformance(tx: Db, orgId: string, access: WorkspaceAccess, start: SQL, end: SQL): Promise<CrmPerformance> {
  const [responses] = access.conversations ? await tx.execute<NonNullable<CrmPerformance["responses"]>>(sql`
    with first_inbound as (
      select distinct on (conversation_id) conversation_id, created_at
      from message where organization_id=${orgId} and direction='in'
      order by conversation_id, created_at, id
    ), cohort as (
      select i.conversation_id, i.created_at, r.sent_at, r.id as response_id
      from first_inbound i left join lateral (
        select m.id, m.sent_at from message m
        where m.organization_id=${orgId} and m.conversation_id=i.conversation_id
          and m.direction='out' and m.status in ('sent','delivered','read')
          and coalesce(m.external_id,'') not like 'mock-%'
          and m.created_at >= i.created_at
        order by coalesce(m.sent_at, m.created_at), m.id limit 1
      ) r on true where i.created_at >= ${start} and i.created_at < ${end}
    ) select count(*)::int as conversations,
      count(response_id)::int as responded,
      count(*) filter(where sent_at >= created_at)::int as "timedResponses",
      avg(extract(epoch from (sent_at-created_at))) filter(where sent_at >= created_at)::float8 as "avgFirstResponseSeconds"
    from cohort`) : []
  const [followUps] = access.crm && access.tasks ? await tx.execute<NonNullable<CrmPerformance["followUps"]>>(sql`
    select count(*)::int as open, count(*) filter(where due_at <= now())::int as overdue,
      count(*) filter(where assignee_user_id is null)::int as unassigned
    from task where organization_id=${orgId} and status='open' and kind='opportunity_follow_up'`) : []
  const [conversations] = access.conversations ? await tx.execute<NonNullable<CrmPerformance["conversations"]>>(sql`
    select (select count(distinct entity_id)::int from audit_event
      where organization_id=${orgId} and entity='conversation' and action='conversation.updated'
        and metadata->>'op'='close' and created_at >= ${start} and created_at < ${end}) as closed,
      (select count(*)::int from conversation c where c.organization_id=${orgId} and c.status='open'
        and exists(select 1 from message i where i.organization_id=${orgId} and i.conversation_id=c.id and i.direction='in'
          and not exists(select 1 from message o where o.organization_id=${orgId} and o.conversation_id=c.id
            and o.direction='out' and o.status in ('sent','delivered','read')
            and coalesce(o.external_id,'') not like 'mock-%' and o.created_at >= i.created_at))) as waiting`) : []
  const bookings = access.appointments ? await tx.execute<NonNullable<CrmPerformance["bookings"]>[number]>(sql`
    select source, count(*)::int as count,
      count(*) filter(where status in ('programada','confirmada','atendida'))::int as active
    from appointment where organization_id=${orgId} and created_at >= ${start} and created_at < ${end}
    group by source order by source`) : null
  const conversion = access.crm ? await tx.execute<NonNullable<CrmPerformance["conversion"]>[number]>(sql`
    select cc.channel, o.assigned_user_id as "assigneeUserId", u.name as "assigneeName",
      count(*)::int as created, count(*) filter(where o.status='won')::int as won,
      count(*) filter(where o.status='lost')::int as lost, count(*) filter(where o.status='open')::int as open,
      (100.0*count(*) filter(where o.status='won')/nullif(count(*),0))::float8 as "wonRate"
    from opportunity o left join conversation c on c.id=o.conversation_id and c.organization_id=${orgId}
    left join channel_connection cc on cc.id=c.channel_connection_id and cc.organization_id=${orgId}
    left join "user" u on u.id=o.assigned_user_id
    where o.organization_id=${orgId} and o.created_at >= ${start} and o.created_at < ${end}
    group by cc.channel, o.assigned_user_id, u.name order by cc.channel nulls last, u.name nulls last`) : null
  const [proposals] = access.agent ? await tx.execute<NonNullable<CrmPerformance["proposals"]>>(sql`
    select count(*) filter(where status='ejecutada' and executed_at >= ${start} and executed_at < ${end})::int as executed,
      count(*) filter(where status='fallida' and updated_at >= ${start} and updated_at < ${end})::int as failed,
      count(*) filter(where status='propuesta')::int as pending
    from agent_proposal where organization_id=${orgId}`) : []
  return { responses: responses ?? null, followUps: followUps ?? null, conversations: conversations ?? null, bookings, conversion, proposals: proposals ?? null }
}
/**
 * Pulso del negocio para los gráficos del home. Cada sección es nula sin su
 * permiso; los días usan la zona horaria de la organización.
 */
export async function getWorkspacePulse(tx: Db, orgId: string, access: WorkspaceAccess): Promise<WorkspacePulse> {
  const { timezone } = await workspaceZone(tx, orgId)
  const funnel = access.crm ? await tx.execute<{ stage: string; count: number; amountCents: string; currency: string }>(sql`
    select s.name as stage, count(*)::int as count,
      coalesce(sum(o.amount_cents), 0)::text as "amountCents", o.currency as currency
    from opportunity o join pipeline_stage s on s.id = o.stage_id and s.organization_id = ${orgId}
    where o.organization_id = ${orgId} and o.status = 'open'
    group by s.id, s.name, s.position, o.currency
    order by s.position, s.name, o.currency`) : null
  const channels = access.conversations ? await tx.execute<{ channel: string; count: number }>(sql`
    select cc.channel as channel, count(*)::int as count
    from conversation c join channel_connection cc on cc.id = c.channel_connection_id and cc.organization_id = ${orgId}
    where c.organization_id = ${orgId} and c.status = 'open'
    group by cc.channel order by cc.channel`) : null
  const execution = access.agent ? await tx.execute<{ day: string; ok: number; handoff: number; error: number }>(sql`
    with days as (
      select to_char((now() at time zone ${timezone}) - (n || ' days')::interval, 'YYYY-MM-DD') as day
      from generate_series(0, 29) n
    ) select days.day as day,
      count(l.id) filter (where l.status = 'ok')::int as ok,
      count(l.id) filter (where l.status = 'handoff')::int as handoff,
      count(l.id) filter (where l.status = 'error')::int as error
    from days left join agent_run_ledger l
      on l.organization_id = ${orgId} and to_char(l.started_at at time zone ${timezone}, 'YYYY-MM-DD') = days.day
    group by days.day order by days.day`) : null
  const collections = access.finance ? await tx.execute<{ day: string; currency: string; amountCents: string }>(sql`
    select to_char(paid_at at time zone ${timezone}, 'YYYY-MM-DD') as day,
      currency, sum(amount_cents)::text as "amountCents"
    from patient_payment
    where organization_id = ${orgId} and voided_at is null
      and paid_at >= (((to_char(now() at time zone ${timezone}, 'YYYY-MM-DD'))::date - 29)::timestamp at time zone ${timezone})
    group by day, currency order by day, currency`) : null
  const start = sql`((now() at time zone ${timezone})::date - 29)::timestamp at time zone ${timezone}`
  return { funnel, channels, execution, collections, performance: await crmPerformance(tx, orgId, access, start, sql`now()`) }
}

export async function getWorkspaceHome(tx: Db, orgId: string, userId: string, access: WorkspaceAccess) {
  const { timezone, locale } = await workspaceZone(tx, orgId)
  const [day] = await tx.execute<{ date: string }>(sql`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as date`)
  const start = sql`((${day.date}::date)::timestamp at time zone ${timezone})`
  const end = sql`((${day.date}::date + 1)::timestamp at time zone ${timezone})`
  const appointments = access.appointments ? await tx.execute<{
    id: string; patientId: string; patientName: string; startsAt: string; status: string; branchName: string; dentistName: string
  }>(sql`select a.id, a.patient_id as "patientId", p.display_name as "patientName",
    a.starts_at as "startsAt", a.status, b.name as "branchName", u.name as "dentistName"
    from appointment a join patient p on p.id=a.patient_id and p.organization_id=${orgId}
    join branch b on b.id=a.branch_id and b.organization_id=${orgId}
    join "user" u on u.id=a.dentist_user_id
    where a.organization_id=${orgId} and a.starts_at >= ${start} and a.starts_at < ${end}
    and a.status in ('programada','confirmada') order by a.starts_at, a.id limit 12`) : []
  const appointmentCounts = access.appointments ? await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count from appointment where organization_id=${orgId}
    and starts_at >= ${start} and starts_at < ${end} group by status`) : []
  const tasks = access.tasks ? await tx.execute<{ id: string; title: string; dueAt: string | null; overdue: boolean }>(sql`
    select id, title, due_at as "dueAt", coalesce(due_at < now(), false) as overdue
    from task where organization_id=${orgId} and status='open'
    and (${access.allTasks} or assignee_user_id=${userId})
    order by due_at asc nulls last, id limit 8`) : []
  const [taskCount] = access.tasks ? await tx.execute<{ overdue: number; open: number }>(sql`
    select count(*) filter (where due_at < now())::int as overdue, count(*)::int as open
    from task where organization_id=${orgId} and status='open'
    and (${access.allTasks} or assignee_user_id=${userId})`) : []
  const [conversations] = access.conversations ? await tx.execute<{ unread: number; waiting: number; human: number }>(sql`
    with operative as (
      select c.unread_count, c.agent_status, exists (
        select 1 from message i where i.organization_id=${orgId} and i.conversation_id=c.id and i.direction='in'
          and not exists (select 1 from message o where o.organization_id=${orgId} and o.conversation_id=c.id
            and o.direction='out' and o.status in ('sent','delivered','read')
            and coalesce(o.external_id,'') not like 'mock-%' and o.created_at >= i.created_at)
      ) as waiting from conversation c where c.organization_id=${orgId} and c.status='open'
    ) select count(*) filter(where unread_count > 0)::int as unread,
      count(*) filter(where waiting)::int as waiting,
      count(*) filter(where agent_status='off' and waiting)::int as human from operative`) : []
  const budgets = access.finance || access.clinical ? await tx.execute<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>(sql`
    select b.id, b.patient_id as "patientId", p.display_name as "patientName", b.title, b.presented_at as "presentedAt"
    from treatment_budget b join patient p on p.id=b.patient_id and p.organization_id=${orgId}
    where b.organization_id=${orgId} and b.status in ('presentado','pospuesto')
    order by b.presented_at nulls last, b.id limit 8`) : []
  const debt = access.finance ? await currentDebt(tx, orgId) : []
  const agent = access.agent ? await workspaceAgent(tx, orgId, start, end) : null
  return { date: day.date, timezone, locale, access, appointments, appointmentCounts, tasks,
    taskCount: taskCount ?? null, conversations: conversations ?? null, budgets, debt, agent }
}

async function currentDebt(tx: Db, orgId: string) {
  return tx.execute<{ currency: string; outstandingCents: string; overdueCents: string; patients: number }>(sql`
    with balances as (
      select c.patient_id, c.currency, c.due_at, c.amount_cents - coalesce(sum(a.amount_cents),0) as remaining
      from patient_charge c left join patient_payment_application a on a.charge_id=c.id
        and a.organization_id=${orgId} and a.voided_at is null
      where c.organization_id=${orgId} and c.voided_at is null
      group by c.id
    ) select currency, sum(remaining)::text as "outstandingCents",
      coalesce(sum(remaining) filter (where due_at < now()),0)::text as "overdueCents",
      count(distinct patient_id)::int as patients from balances where remaining > 0 group by currency order by currency`)
}

export async function getManagementReport(tx: Db, orgId: string, from: string, to: string, access: WorkspaceAccess) {
  const { timezone, locale } = await workspaceZone(tx, orgId)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to ||
    !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) ||
    Date.parse(to) - Date.parse(from) > 366 * 86_400_000) throw validation("Elige un período válido de hasta un año")
  const start = sql`(${from}::date::timestamp at time zone ${timezone})`
  const end = sql`((${to}::date + 1)::timestamp at time zone ${timezone})`
  const appointments = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count from appointment where organization_id=${orgId}
    and starts_at >= ${start} and starts_at < ${end} group by status order by status`)
  const production = await tx.execute<{ userId: string; name: string; attended: number; total: number }>(sql`
    select a.dentist_user_id as "userId", u.name,
      count(*) filter(where a.status='atendida')::int as attended, count(*)::int as total
    from appointment a join "user" u on u.id=a.dentist_user_id
    where a.organization_id=${orgId} and a.starts_at >= ${start} and a.starts_at < ${end}
    group by a.dentist_user_id, u.name order by attended desc, u.name`)
  const budgets = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count from treatment_budget where organization_id=${orgId}
    and presented_at >= ${start} and presented_at < ${end} group by status order by status`)
  const collections = await tx.execute<{ currency: string; receivedCents: string; refundedCents: string; netCents: string }>(sql`
    with movements as (
      select currency, amount_cents::bigint as received, 0::bigint as refunded from patient_payment
      where organization_id=${orgId} and voided_at is null and paid_at >= ${start} and paid_at < ${end}
      union all
      select p.currency, 0::bigint, r.amount_cents::bigint from patient_payment_refund r
      join patient_payment p on p.id=r.payment_id and p.organization_id=${orgId}
      where r.organization_id=${orgId} and r.refunded_at >= ${start} and r.refunded_at < ${end}
    ) select currency, sum(received)::text as "receivedCents", sum(refunded)::text as "refundedCents",
      (sum(received)-sum(refunded))::text as "netCents" from movements group by currency order by currency`)
  const clinicalProduction = await tx.execute<{ name: string; currency: string | null; procedures: number; amountCents: string }>(sql`
    select u.name, p.currency, count(*)::int as procedures,
      coalesce(sum(p.price_cents),0)::text as "amountCents"
    from encounter_procedure p join encounter e on e.id=p.encounter_id and e.organization_id=${orgId}
    join "user" u on u.id=e.dentist_user_id
    where p.organization_id=${orgId} and e.status='finalizada'
      and e.finalized_at >= ${start} and e.finalized_at < ${end}
    group by e.dentist_user_id, u.name, p.currency order by u.name, p.currency`)
  const opportunities = await tx.execute<{ status: string; currency: string; count: number; amountCents: string }>(sql`
    select status, currency, count(*)::int as count, coalesce(sum(amount_cents),0)::text as "amountCents"
    from opportunity where organization_id=${orgId} and created_at >= ${start} and created_at < ${end}
    group by status, currency order by currency, status`)
  const aging = await tx.execute<{ currency: string; bucket: string; amountCents: string }>(sql`
    with balances as (
      select c.currency, c.due_at, c.amount_cents-coalesce(sum(a.amount_cents),0) as remaining
      from patient_charge c left join patient_payment_application a on a.charge_id=c.id
        and a.organization_id=${orgId} and a.voided_at is null
      where c.organization_id=${orgId} and c.voided_at is null group by c.id
    ) select currency, case when due_at is null then 'Sin vencimiento'
      when due_at >= now() then 'Por vencer' when due_at >= now()-interval '30 days' then '1–30 días'
      when due_at >= now()-interval '60 days' then '31–60 días'
      when due_at >= now()-interval '90 days' then '61–90 días' else 'Más de 90 días' end as bucket,
      sum(remaining)::text as "amountCents" from balances where remaining>0 group by currency, bucket order by currency, bucket`)
  return { from, to, timezone, locale, appointments, production, clinicalProduction, opportunities, aging, budgets, collections, debt: await currentDebt(tx, orgId), performance: await crmPerformance(tx, orgId, access, start, end) }
}

export async function listWorkspaceAudit(tx: Db, orgId: string, input: { action?: string; before?: string; beforeId?: string }) {
  if ((input.before && !Number.isFinite(Date.parse(input.before))) || (!!input.before !== !!input.beforeId)) throw validation("Cursor de auditoría inválido")
  const rows = await tx.execute<{ id: string; action: string; entity: string; entityId: string | null; actorName: string | null; createdAt: string }>(sql`
    select a.id, a.action, a.entity, a.entity_id as "entityId", u.name as "actorName",
      to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
    from audit_event a left join "user" u on u.id=a.actor_user_id
    where a.organization_id=${orgId}
    ${input.action ? sql`and a.action = ${input.action}` : sql``}
    ${input.before && input.beforeId ? sql`and (a.created_at,a.id) < (${input.before}::timestamptz,${input.beforeId}::uuid)` : sql``}
    order by a.created_at desc, a.id desc limit 51`)
  const items = rows.slice(0, 50)
  const last = items.at(-1)
  return { items, next: rows.length > 50 && last ? { before: last.createdAt, beforeId: last.id } : null }
}
