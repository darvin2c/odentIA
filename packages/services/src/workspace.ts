import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import { notFound, validation } from "./errors.js"

export interface WorkspaceAccess {
  patients: boolean
  appointments: boolean
  conversations: boolean
  tasks: boolean
  finance: boolean
  clinical: boolean
  crm: boolean
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
  const [row] = await tx.execute<{ timezone: string; locale: string }>(sql`
    select timezone, locale from org_profile where organization_id = ${orgId}`)
  if (!row) throw notFound("Perfil de organización")
  return row
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
    select count(*) filter (where unread_count > 0)::int as unread,
    count(*) filter (where last_inbound_at > coalesce(last_outbound_at, '-infinity'::timestamptz))::int as waiting,
    count(*) filter (where agent_status='off' and last_inbound_at > coalesce(last_outbound_at, '-infinity'::timestamptz))::int as human
    from conversation where organization_id=${orgId} and status='open'`) : []
  const budgets = access.finance || access.clinical ? await tx.execute<{ id: string; patientId: string; patientName: string; title: string; presentedAt: string | null }>(sql`
    select b.id, b.patient_id as "patientId", p.display_name as "patientName", b.title, b.presented_at as "presentedAt"
    from treatment_budget b join patient p on p.id=b.patient_id and p.organization_id=${orgId}
    where b.organization_id=${orgId} and b.status in ('presentado','pospuesto')
    order by b.presented_at nulls last, b.id limit 8`) : []
  const debt = access.finance ? await currentDebt(tx, orgId) : []
  return { date: day.date, timezone, locale, access, appointments, appointmentCounts, tasks,
    taskCount: taskCount ?? null, conversations: conversations ?? null, budgets, debt }
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

export async function getManagementReport(tx: Db, orgId: string, from: string, to: string) {
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
  return { from, to, timezone, locale, appointments, production, clinicalProduction, opportunities, aging, budgets, collections, debt: await currentDebt(tx, orgId) }
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
