import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { getAdminRecommendations, getAdminUnreached } from "./agent-admin.js"
import {
  countPendingProposals,
  listHandoffs,
  listProposals,
  pendingProposalDecider,
} from "./agent-operations.js"
import { AUDIT_AREA_LABELS, AUDIT_AREAS, type AuditArea, auditSubjectsOf, describeAuditEvent } from "./audit-words.js"
import { notFound, validation } from "./errors.js"
import { getCashToday } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import {
  composeWaiting,
  WAITING_LIMITS,
  type WaitingBudgets,
  type WaitingCase,
  type WaitingProposal,
  type WaitingTask,
} from "./workspace-home.js"

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
  /**
   * Áreas del equipo a las que pertenece quien mira (clave de `TASK_AREAS`): ve
   * también las tareas sin responsable que el Administrador dejó para su área.
   */
  taskAreas?: readonly string[]
  configure: boolean
  /** Quien atiende (odontólogo): solo sus citas, en todas las sedes, y los presupuestos de sus planes. */
  ownAppointments: boolean
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

/**
 * Aviso que se mantiene al día: si ya existe para ese destinatario y clave,
 * cambia su texto (una cuenta que sube) y vuelve a quedar sin leer solo cuando
 * el texto cambió. Para avisos que no cambian, `createWorkspaceNotification`.
 */
export async function upsertWorkspaceNotification(tx: Db, orgId: string, input: {
  userId: string; dedupeKey: string; title: string; body: string; href: string; permission: string
}) {
  if (!/^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(input.href)) throw validation("El destino del aviso debe ser una ruta interna")
  if (!input.title.trim() || input.title.length > 200 || input.body.length > 1000 || input.dedupeKey.length > 300)
    throw validation("El aviso excede los límites admitidos")
  const [recipient] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, input.userId))).limit(1)
  if (!recipient) throw notFound("Destinatario")
  await tx.insert(workspaceNotification).values({ organizationId: orgId, ...input })
    .onConflictDoUpdate({
      target: [workspaceNotification.organizationId, workspaceNotification.userId, workspaceNotification.dedupeKey],
      set: {
        title: input.title,
        body: input.body,
        href: input.href,
        readAt: sql`case when ${workspaceNotification.title} = ${input.title} and ${workspaceNotification.body} = ${input.body}
          then ${workspaceNotification.readAt} else null end`,
      },
    })
}

export async function listWorkspaceNotifications(tx: Db, orgId: string, userId: string, permissions: string[]) {
  // Materializa avisos de vencimiento para el destinatario, sin un temporizador en memoria.
  if (permissions.includes("tasks.read")) {
    const canReadCrm = permissions.includes("crm.read")
    const canReadConversations = permissions.includes("conversations.read")
    await tx.execute(sql`insert into workspace_notification
      (organization_id, user_id, dedupe_key, title, body, href, permission)
      select ${orgId}, ${userId}, 'task-due:' || id || ':' || due_at::text,
        'Tarea vencida', title,
        case
          when ${canReadCrm} and opportunity_id is not null then '/opportunities/' || opportunity_id
          when ${canReadConversations} and conversation_id is not null then '/inbox?conversation=' || conversation_id
          when ${canReadCrm} and contact_id is not null then '/contacts/' || contact_id
          else '/tasks?task=' || id
        end,
        case
          when ${canReadCrm} and opportunity_id is not null then 'crm.read'
          when ${canReadConversations} and conversation_id is not null then 'conversations.read'
          when ${canReadCrm} and contact_id is not null then 'crm.read'
          else 'tasks.read'
        end
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
  const storedItems = await tx.select().from(workspaceNotification).where(scope)
    .orderBy(desc(workspaceNotification.createdAt), desc(workspaceNotification.id)).limit(100)
  const canReadConversations = permissions.includes("conversations.read")
  const items = storedItems.map((item) => {
    if (canReadConversations || !item.href.startsWith("/inbox?")) return item
    const fallbackTask = new URL(item.href, "https://workspace.invalid").searchParams.get("fallbackTask")
    return fallbackTask ? { ...item, href: `/tasks?task=${fallbackTask}` } : item
  })
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

/** Instante como texto ISO en UTC: el cliente lo sitúa en la zona de la clínica. */
const iso = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

export interface WorkspaceHomeOptions {
  /** Sede pedida para la agenda y la caja; sin ella (o si ya no existe) vale la primera activa. */
  branchId?: string
  /** Permisos de quien mira, para lo que el Administrador puede recomendarle; sin esto no hay recomendaciones. */
  can?: (permission: string) => boolean
}

export interface WorkspaceAppointment {
  id: string
  patientId: string
  patientName: string
  startsAt: string
  status: string
  serviceName: string | null
  dentistName: string
  chairName: string
  branchName: string
  /** La siguiente cita en pie; a lo sumo una. */
  next: boolean
}

/**
 * «Hoy» de quien trabaja con la agenda. `branch`: la agenda de una sede, solo
 * lo que falta. `mine`: las citas de quien atiende, en todas las sedes y
 * también las ya atendidas.
 */
export interface WorkspaceToday {
  scope: "branch" | "mine"
  branch: { id: string; name: string } | null
  /** Zona con que se partió el día y se leen las horas: la de la sede o la de la clínica. */
  timezone: string
  /**
   * `total` cuenta lo que ocupa la agenda (ni canceladas ni inasistencias),
   * igual que el número de citas del día en la Agenda; `upcoming` son las que
   * siguen en pie y `unconfirmed`, de esas, las que nadie confirmó.
   */
  summary: { total: number; attended: number; upcoming: number; unconfirmed: number }
  appointments: WorkspaceAppointment[]
}

/** Filas de la agenda de una sede que viajan a Inicio; el resto se ve en la Agenda. */
const TODAY_BRANCH_ROWS = 5

async function homeBranch(tx: Db, orgId: string, branchId?: string) {
  const rows = await tx.execute<{ id: string; name: string; timezone: string | null }>(sql`
    select id, name, timezone from branch where organization_id=${orgId} and is_active order by created_at, id`)
  return { branch: rows.find(row => row.id === branchId) ?? rows[0] ?? null, many: rows.length > 1 }
}

async function workspaceToday(
  tx: Db, orgId: string, userId: string, own: boolean, branch: { id: string; name: string; timezone: string | null } | null, timezone: string,
): Promise<WorkspaceToday> {
  const empty = { total: 0, attended: 0, upcoming: 0, unconfirmed: 0 }
  if (!own && !branch) return { scope: "branch", branch: null, timezone, summary: empty, appointments: [] }
  // El día se parte con la zona de la sede, como en la Agenda; las citas propias, con la de la clínica.
  const zone = own ? timezone : (branch?.timezone ?? timezone)
  const start = sql`((now() at time zone ${zone})::date::timestamp at time zone ${zone})`
  const end = sql`(((now() at time zone ${zone})::date + 1)::timestamp at time zone ${zone})`
  const rows = await tx.execute<Omit<WorkspaceAppointment, "next"> & { open: boolean }>(sql`
    select a.id, a.patient_id as "patientId", p.display_name as "patientName",
      ${iso(sql`a.starts_at`)} as "startsAt", a.status, a.service_name as "serviceName",
      u.name as "dentistName", ch.name as "chairName", b.name as "branchName", a.ends_at > now() as open
    from appointment a join patient p on p.id=a.patient_id and p.organization_id=${orgId}
    join branch b on b.id=a.branch_id and b.organization_id=${orgId}
    join schedule_chair ch on ch.id=a.chair_id and ch.organization_id=${orgId}
    join "user" u on u.id=a.dentist_user_id
    where a.organization_id=${orgId} and a.starts_at >= ${start} and a.starts_at < ${end}
      and a.status in ('programada','confirmada','atendida')
      and ${own ? sql`a.dentist_user_id=${userId}` : sql`a.branch_id=${branch?.id ?? null}`}
    order by a.starts_at, a.id limit 300`)
  const standing = rows.filter(row => row.status !== "atendida")
  const nextId = standing.find(row => row.open)?.id ?? null
  const summary = {
    total: rows.length,
    attended: rows.length - standing.length,
    upcoming: standing.length,
    unconfirmed: standing.filter(row => row.status === "programada").length,
  }
  // La sede ve lo que falta, desde la siguiente; quien atiende, su día entero.
  const from = nextId ? standing.findIndex(row => row.id === nextId) : 0
  const shown = own ? rows : standing.slice(from, from + TODAY_BRANCH_ROWS)
  return {
    scope: own ? "mine" : "branch",
    branch: own || !branch ? null : { id: branch.id, name: branch.name },
    timezone: zone,
    summary,
    appointments: shown.map(({ open: _open, ...row }) => ({ ...row, next: row.id === nextId })),
  }
}

/** Casos que pasó el agente y siguen sin resolver, para quien puede tomarlos. */
async function waitingCases(tx: Db, orgId: string, userId: string, all: boolean): Promise<WaitingCase[]> {
  const rows = await listHandoffs(tx, orgId, { limit: 100, open: true })
  return rows
    // Lo que ya tomó otra persona no espera a quien mira; quien dirige lo ve todo.
    .filter(row => all || row.assigneeUserId === null || row.assigneeUserId === userId)
    .map(row => ({
      id: row.id, priority: row.priority, reason: row.reason, contactName: row.contactName,
      channel: row.channel, createdAt: row.createdAt, conversationId: row.conversationId,
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/** Propuestas pendientes que decide el equipo; las que esperan al interlocutor no esperan a nadie de aquí. */
async function waitingProposals(tx: Db, orgId: string): Promise<{ items: WaitingProposal[]; total: number }> {
  const rows = await listProposals(tx, orgId, { status: "propuesta", limit: 50 })
  const items = rows
    .filter(row => pendingProposalDecider(row.action, row.conversationId !== null) === "team")
    .slice(0, WAITING_LIMITS.proposals)
    .map(row => ({
      id: row.id, action: row.action, summary: row.context.afterSummary, createdAt: row.createdAt,
      conversationId: row.conversationId, contactName: row.context.contactName, patientName: row.context.patientName,
    }))
  return { items, total: (await countPendingProposals(tx, orgId)).team }
}

/**
 * Conversaciones abiertas con un entrante posterior al último saliente
 * aceptado (la vista «Sin responder» de la Bandeja) y desde cuándo espera la
 * que más lleva.
 */
async function waitingConversations(tx: Db, orgId: string) {
  const [row] = await tx.execute<{ waiting: number; oldestAt: string | null }>(sql`
    with pending as (
      select (select min(i.created_at) from message i
        where i.organization_id=${orgId} and i.conversation_id=c.id and i.direction='in'
          and i.created_at > coalesce((select max(o.created_at) from message o
            where o.organization_id=${orgId} and o.conversation_id=c.id and o.direction='out'
              and o.status in ('sent','delivered','read') and coalesce(o.external_id,'') not like 'mock-%'), '-infinity'::timestamptz)
      ) as since from conversation c where c.organization_id=${orgId} and c.status='open'
    ) select count(since)::int as waiting, ${iso(sql`min(since)`)} as "oldestAt" from pending`)
  return row ?? { waiting: 0, oldestAt: null }
}

async function waitingTasks(tx: Db, orgId: string, userId: string, access: WorkspaceAccess, dayEnd: SQL) {
  const areas = access.taskAreas?.length ? sql`or (t.assignee_user_id is null and t.area in ${[...access.taskAreas]})` : sql``
  const scope = sql`t.organization_id=${orgId} and t.status='open' and (${access.allTasks} or t.assignee_user_id=${userId} ${areas})`
  type Row = Omit<WaitingTask, "href"> & { contactId: string | null; conversationId: string | null; opportunityId: string | null }
  const select = sql`select t.id, t.title, ${iso(sql`t.due_at`)} as "dueAt",
      case when t.due_at is null then 'none' when t.due_at < now() then 'overdue'
        when t.due_at < ${dayEnd} then 'today' else 'later' end as due,
      coalesce(t.assignee_user_id=${userId}, false) as mine, u.name as "assigneeName",
      t.contact_id as "contactId", t.conversation_id as "conversationId", t.opportunity_id as "opportunityId"
    from task t left join "user" u on u.id=t.assignee_user_id where ${scope}`
  const overdue = await tx.execute<Row>(sql`${select} and t.due_at < now() order by t.due_at, t.id limit ${WAITING_LIMITS.overdueTasks}`)
  const [next] = await tx.execute<Row>(sql`${select} and (t.due_at is null or t.due_at >= now()) order by t.due_at asc nulls last, t.id limit 1`)
  const [count] = await tx.execute<{ open: number }>(sql`select count(*)::int as open from task t where ${scope}`)
  // Cada tarea abre lo más cercano a su contexto que el rol puede ver.
  const place = ({ contactId, conversationId, opportunityId, ...task }: Row): WaitingTask => ({
    ...task,
    href: access.crm && opportunityId
      ? `/opportunities/${opportunityId}`
      : access.conversations && conversationId
        ? `/inbox?conversation=${conversationId}`
        : access.crm && contactId
          ? `/contacts/${contactId}`
          : `/tasks?task=${task.id}`,
  })
  return { overdue: overdue.map(place), next: next ? place(next) : null, open: count?.open ?? 0 }
}

/** Presupuestos presentados o pospuestos que siguen sin respuesta; quien atiende, solo los de sus planes. */
async function waitingBudgets(tx: Db, orgId: string, userId: string, ownOnly: boolean): Promise<WaitingBudgets> {
  const scope = sql`b.organization_id=${orgId} and b.status in ('presentado','pospuesto')
    and (not ${ownOnly} or exists (select 1 from treatment_plan tp
      where tp.id=b.plan_id and tp.organization_id=${orgId} and tp.created_by=${userId}))`
  const items = await tx.execute<WaitingBudgets["items"][number]>(sql`
    select b.id, b.patient_id as "patientId", p.display_name as "patientName", b.title,
      ${iso(sql`b.presented_at`)} as "presentedAt"
    from treatment_budget b join patient p on p.id=b.patient_id and p.organization_id=${orgId}
    where ${scope} order by b.presented_at nulls last, b.id limit 20`)
  const [count] = await tx.execute<{ total: number; oldestPresentedAt: string | null }>(sql`
    select count(*)::int as total, ${iso(sql`min(b.presented_at)`)} as "oldestPresentedAt" from treatment_budget b where ${scope}`)
  return { total: count?.total ?? 0, oldestPresentedAt: count?.oldestPresentedAt ?? null, items }
}

/**
 * Inicio responde «¿qué me toca hoy?» con dos bloques: `waiting`, la lista
 * «Te espera» ya ordenada, y lo de hoy según el trabajo de quien mira
 * (`today`, la agenda de la sede o sus propias citas; `cash`, la caja del
 * día). Cada parte se calcula solo si `access` la permite: un rol no recibe
 * filas de lo que no puede ver.
 */
export async function getWorkspaceHome(tx: Db, orgId: string, userId: string, access: WorkspaceAccess, options: WorkspaceHomeOptions = {}) {
  const { timezone, locale } = await workspaceZone(tx, orgId)
  const [day] = await tx.execute<{ date: string }>(sql`select to_char(now() at time zone ${timezone}, 'YYYY-MM-DD') as date`)
  const dayEnd = sql`((${day.date}::date + 1)::timestamp at time zone ${timezone})`
  const needsBranch = access.appointments || access.finance
  const { branch, many } = needsBranch ? await homeBranch(tx, orgId, options.branchId) : { branch: null, many: false }

  const today = access.appointments ? await workspaceToday(tx, orgId, userId, access.ownAppointments, branch, timezone) : null
  const cash = access.finance && branch ? await getCashToday(tx, orgId, { branchId: branch.id }) : null

  const proposals = access.agent ? await waitingProposals(tx, orgId) : { items: [], total: 0 }
  const tasks = access.tasks ? await waitingTasks(tx, orgId, userId, access, dayEnd) : { overdue: [], next: null, open: 0 }
  // A lo sumo tres recomendaciones a la vez, como declara la ficha del administrador.
  const admin = options.can ? await getAdminRecommendations(tx, orgId, options.can) : { enabled: false, recommendations: [] }
  const advice = admin.recommendations
  // Las personas a las que el agente no pudo escribir: un motivo que alguien puede corregir.
  const unreached = options.can && access.agent ? await getAdminUnreached(tx, orgId, options.can) : null
  const waiting = composeWaiting({
    cases: access.agent ? await waitingCases(tx, orgId, userId, access.allTasks) : [],
    proposals: proposals.items,
    proposalsTotal: proposals.total,
    conversations: access.conversations ? await waitingConversations(tx, orgId) : null,
    overdueTasks: tasks.overdue,
    nextTask: tasks.next,
    openTasks: tasks.open,
    advice: advice.map(({ key, title, detail, actor }) => ({ key, title, detail, actor })),
    unreached: unreached && unreached.total > 0 ? { total: unreached.total, byCause: unreached.byCause.map(({ total, reason }) => ({ total, reason })) } : null,
    // Con el administrador encendido, los presupuestos sin respuesta son una de sus líneas: no se repiten aquí.
    budgets: (access.finance || access.clinical) && !admin.enabled ? await waitingBudgets(tx, orgId, userId, access.ownAppointments) : null,
  })

  // La puesta en marcha consulta capacidades existentes, no deduce configuración
  // a partir de contadores operativos en cero. Solo administración recibe estos datos.
  const [setup] = access.configure ? await tx.execute<{ availability: boolean; chairs: boolean; patients: boolean }>(sql`
    select exists(select 1 from professional_schedule where organization_id=${orgId} and is_active) as availability,
      exists(select 1 from schedule_chair where organization_id=${orgId} and is_active) as chairs,
      exists(select 1 from patient where organization_id=${orgId}) as patients`) : []
  // Con trabajo ya registrado, Inicio deja de ofrecer la puesta en marcha.
  const [activity] = await tx.execute<{ recorded: boolean }>(sql`
    select (
      ${access.appointments} and exists(select 1 from appointment where organization_id=${orgId})
      or ${access.tasks} and exists(select 1 from task where organization_id=${orgId} and (${access.allTasks} or assignee_user_id=${userId}))
      or ${access.conversations} and exists(select 1 from conversation where organization_id=${orgId})
      or ${access.finance} and exists(select 1 from patient_payment where organization_id=${orgId} and voided_at is null)
      or ${access.finance} and exists(select 1 from patient_charge where organization_id=${orgId} and voided_at is null)
      or ${access.finance || access.clinical} and exists(select 1 from treatment_budget where organization_id=${orgId})
      or ${access.clinical} and exists(select 1 from encounter where organization_id=${orgId})
      or ${access.crm} and exists(select 1 from opportunity where organization_id=${orgId})
      or ${access.agent} and exists(select 1 from agent_run_ledger where organization_id=${orgId})
      or ${access.agent} and exists(select 1 from agent_proposal where organization_id=${orgId})
    ) as recorded`)
  return { date: day.date, timezone, locale, access, multiBranch: many, waiting, today, cash,
    setup: setup ?? null, activity: { recorded: activity?.recorded ?? false } }
}

/** Una fila de «Actividad del equipo»: el registro y, además, cómo se dice con palabras. */
export interface WorkspaceAuditItem {
  id: string
  action: string
  entity: string
  entityId: string | null
  actorName: string | null
  createdAt: string
  /** Qué pasó, como predicado: «Reservó una cita». */
  what: string
  /** Quién lo hizo: la persona del equipo o, sin ella, lo que el registro permite afirmar. */
  who: string
  area: AuditArea | "otros"
  areaLabel: string
}

/**
 * Actividad del equipo, de lo más reciente a lo más antiguo. `area` acota por
 * tema (`AUDIT_AREAS`); `action` sigue admitiendo el código exacto para quien
 * integra o prueba. La pantalla solo muestra las palabras.
 */
export async function listWorkspaceAudit(tx: Db, orgId: string, input: { action?: string; area?: AuditArea; before?: string; beforeId?: string }) {
  if ((input.before && !Number.isFinite(Date.parse(input.before))) || (!!input.before !== !!input.beforeId)) throw validation("Cursor de auditoría inválido")
  if (input.area !== undefined && !(AUDIT_AREAS as readonly string[]).includes(input.area)) throw validation("Elige un área de la lista")
  const subjects = input.area ? auditSubjectsOf(input.area) : null
  const rows = await tx.execute<{ id: string; action: string; entity: string; entityId: string | null; actorName: string | null; createdAt: string; origin: string | null }>(sql`
    select a.id, a.action, a.entity, a.entity_id as "entityId", u.name as "actorName",
      to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
      a.metadata->>'origin' as origin
    from audit_event a left join "user" u on u.id=a.actor_user_id
    where a.organization_id=${orgId}
    ${input.action ? sql`and a.action = ${input.action}` : sql``}
    ${subjects ? sql`and split_part(a.action, '.', 1) in (${sql.join(subjects.map((subject) => sql`${subject}`), sql`, `)})` : sql``}
    ${input.before && input.beforeId ? sql`and (a.created_at,a.id) < (${input.before}::timestamptz,${input.beforeId}::uuid)` : sql``}
    order by a.created_at desc, a.id desc limit 51`)
  const items: WorkspaceAuditItem[] = rows.slice(0, 50).map(({ origin, ...row }) => {
    const words = describeAuditEvent(row.action, origin)
    return { ...row, what: words.what, who: row.actorName ?? words.author, area: words.area, areaLabel: words.areaLabel }
  })
  const last = items.at(-1)
  // Las áreas viajan con su nombre: la pantalla arma el filtro sin textos propios.
  return { items, next: rows.length > 50 && last ? { before: last.createdAt, beforeId: last.id } : null, areas: AUDIT_AREAS.map((id) => ({ id, label: AUDIT_AREA_LABELS[id] })) }
}
