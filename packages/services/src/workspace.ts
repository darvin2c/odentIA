import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { getAdminRecommendations, getAdminUnreached } from "./agent-admin.js"
import { listHandoffs } from "./agent-operations.js"
import { AUDIT_AREA_LABELS, AUDIT_AREAS, type AuditArea, auditSubjectsOf, describeAuditEvent } from "./audit-words.js"
import { adminRuntime, remindedUnconfirmedSql } from "./automation.js"
import { handoffOpenExistsSql, stillOpenWithPersonSql, unansweredSinceSql } from "./conversation-state.js"
import { notFound, validation } from "./errors.js"
import { getCashToday } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import {
  composeWaiting,
  WAITING_LIMITS,
  type WaitingBudgets,
  type WaitingCase,
  type WaitingStillOpen,
  type WaitingTask,
  type WaitingUnconfirmed,
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

/**
 * Lo que dice un aviso. `subject` es su asunto cuando tiene uno que se resuelve
 * (ver `NOTICE_SUBJECTS`); `actorUserId`, quien hizo lo que se avisa: nadie
 * recibe aviso de algo que hizo él mismo.
 */
export interface WorkspaceNoticeInput {
  userId: string
  dedupeKey: string
  title: string
  body: string
  href: string
  /** Permiso que necesita quien lo lee: el aviso llega a quien lo tiene. */
  permission: string
  subject?: string | null
  actorUserId?: string | null
}

/**
 * Clases de asunto con su regla de «ya se resolvió» (`settleWorkspaceNotifications`).
 * - `producto:<id>`: el stock volvió al mínimo (o el producto se desactivó).
 * - `orden-clinica:<id>`: la orden dejó de estar solicitada.
 * - `oportunidad:<id>`: se cerró o ya no la lleva quien recibió el aviso.
 * - `modelo-del-agente`: el agente volvió a responder después del aviso.
 */
export const NOTICE_SUBJECTS = ["producto", "orden-clinica", "oportunidad", "modelo-del-agente"] as const

/**
 * La campana es para enterarse, no para trabajar: lo que pide trabajo está en
 * «Te espera» (`getWorkspaceHome`) y no se avisa aquí. Devuelve si el aviso
 * es para su destinatario (falso si lo hizo él mismo).
 */
async function checkNotice(tx: Db, orgId: string, input: WorkspaceNoticeInput): Promise<boolean> {
  if (!/^\/(?!\/)[a-zA-Z0-9/_?=&.%+-]*$/.test(input.href)) throw validation("El destino del aviso debe ser una ruta interna")
  if (!input.title.trim() || input.title.length > 200 || input.body.length > 1000 || input.dedupeKey.length > 300
    || (input.subject?.length ?? 0) > 200)
    throw validation("El aviso excede los límites admitidos")
  if (input.subject && !NOTICE_SUBJECTS.some((kind) => input.subject === kind || input.subject?.startsWith(`${kind}:`)))
    throw validation("El asunto del aviso no es de una clase conocida")
  if (input.actorUserId && input.actorUserId === input.userId) return false
  const [recipient] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, input.userId))).limit(1)
  if (!recipient) throw notFound("Destinatario")
  return true
}

function noticeRow(orgId: string, { actorUserId: _actor, subject, ...input }: WorkspaceNoticeInput) {
  return { organizationId: orgId, ...input, subject: subject ?? null }
}

export async function createWorkspaceNotification(tx: Db, orgId: string, input: WorkspaceNoticeInput) {
  if (!(await checkNotice(tx, orgId, input))) return
  // La misma clave no avisa dos veces, salvo que el aviso anterior se haya
  // retirado por resolverse: entonces el asunto volvió y se avisa de nuevo.
  await tx.insert(workspaceNotification).values(noticeRow(orgId, input))
    .onConflictDoUpdate({
      target: [workspaceNotification.organizationId, workspaceNotification.userId, workspaceNotification.dedupeKey],
      set: { title: input.title, body: input.body, href: input.href, readAt: null, resolvedAt: null, createdAt: sql`now()` },
      setWhere: sql`${workspaceNotification.resolvedAt} is not null`,
    })
}

/**
 * Aviso que se mantiene al día: si ya existe para ese destinatario y clave,
 * cambia su texto (una cuenta que sube) y vuelve a quedar sin leer solo cuando
 * el texto cambió. Para avisos que no cambian, `createWorkspaceNotification`.
 */
export async function upsertWorkspaceNotification(tx: Db, orgId: string, input: WorkspaceNoticeInput) {
  if (!(await checkNotice(tx, orgId, input))) return
  await tx.insert(workspaceNotification).values(noticeRow(orgId, input))
    .onConflictDoUpdate({
      target: [workspaceNotification.organizationId, workspaceNotification.userId, workspaceNotification.dedupeKey],
      set: {
        title: input.title,
        body: input.body,
        href: input.href,
        readAt: sql`case when ${workspaceNotification.resolvedAt} is null and ${workspaceNotification.title} = ${input.title}
          and ${workspaceNotification.body} = ${input.body} then ${workspaceNotification.readAt} else null end`,
        createdAt: sql`case when ${workspaceNotification.resolvedAt} is null then ${workspaceNotification.createdAt} else now() end`,
        resolvedAt: null,
      },
    })
}

/** El id del asunto: lo que va después de `<clase>:`. */
const subjectId = (kind: string) => sql`substr(n.subject, ${kind.length + 2})`

/**
 * Retira los avisos cuyo asunto ya se resolvió (anota `resolved_at`; los avisos
 * no se borran). Es la única regla que retira avisos: ninguna pantalla ni
 * servicio los retira caso por caso. Se aplica al
 * leer la campana y, con `subject`, cuando cambia el asunto (el stock se
 * repone), para que el siguiente aviso vuelva a llegar. Un aviso sin asunto
 * solo informa y queda hasta que se lee.
 */
export async function settleWorkspaceNotifications(tx: Db, orgId: string, scope: { userId?: string; subject?: string } = {}) {
  await tx.execute(sql`update workspace_notification n set resolved_at = now()
    where n.organization_id = ${orgId} and n.subject is not null and n.resolved_at is null
      ${scope.userId ? sql`and n.user_id = ${scope.userId}` : sql``}
      ${scope.subject ? sql`and n.subject = ${scope.subject}` : sql``}
      and (
        (n.subject like 'producto:%' and not exists (select 1 from product p
          where p.organization_id = n.organization_id and p.id::text = ${subjectId("producto")} and p.is_active
            and (select coalesce(sum(l.quantity_on_hand), 0) from product_lot l
              where l.organization_id = p.organization_id and l.product_id = p.id) < p.min_stock))
        or (n.subject like 'orden-clinica:%' and not exists (select 1 from clinical_order o
          where o.organization_id = n.organization_id and o.id::text = ${subjectId("orden-clinica")} and o.status = 'solicitado'))
        or (n.subject like 'oportunidad:%' and not exists (select 1 from opportunity o
          where o.organization_id = n.organization_id and o.id::text = ${subjectId("oportunidad")}
            and o.status = 'open' and o.assigned_user_id = n.user_id))
        or (n.subject = 'modelo-del-agente' and exists (select 1 from agent_run_ledger r
          where r.organization_id = n.organization_id and r.status in ('ok', 'handoff') and r.started_at > n.created_at))
      )`)
}

/**
 * Los avisos de quien mira: los que declaran un permiso que tiene, sin los que
 * ya se resolvieron. Ninguno repite lo que está en «Te espera».
 */
export async function listWorkspaceNotifications(tx: Db, orgId: string, userId: string, permissions: string[]) {
  if (permissions.length === 0) return { items: [], unread: 0 }
  await settleWorkspaceNotifications(tx, orgId, { userId })
  const scope = and(eq(workspaceNotification.organizationId, orgId), eq(workspaceNotification.userId, userId),
    inArray(workspaceNotification.permission, permissions), isNull(workspaceNotification.resolvedAt))
  const items = await tx.select({
    id: workspaceNotification.id, title: workspaceNotification.title, body: workspaceNotification.body,
    href: workspaceNotification.href, createdAt: workspaceNotification.createdAt, readAt: workspaceNotification.readAt,
  }).from(workspaceNotification).where(scope)
    .orderBy(desc(workspaceNotification.createdAt), desc(workspaceNotification.id)).limit(100)
  const [count] = await tx.select({ value: sql<number>`count(*)::int` }).from(workspaceNotification)
    .where(and(scope, isNull(workspaceNotification.readAt)))
  return { items, unread: count?.value ?? 0 }
}

/** Abrir un aviso lo da por leído. */
export async function readWorkspaceNotification(tx: Db, orgId: string, userId: string, id: string, permissions: string[]) {
  if (permissions.length === 0) throw notFound("Aviso")
  const [row] = await tx.update(workspaceNotification).set({ readAt: sql`coalesce(${workspaceNotification.readAt}, now())` })
    .where(and(eq(workspaceNotification.id, id), eq(workspaceNotification.organizationId, orgId),
      eq(workspaceNotification.userId, userId), inArray(workspaceNotification.permission, permissions)))
    .returning({ id: workspaceNotification.id })
  if (!row) throw notFound("Aviso")
  return row
}

/** «Marcar todo leído»: los avisos que quien mira puede ver. Devuelve cuántos cambió. */
export async function readAllWorkspaceNotifications(tx: Db, orgId: string, userId: string, permissions: string[]) {
  if (permissions.length === 0) return { read: 0 }
  const rows = await tx.update(workspaceNotification).set({ readAt: sql`now()` })
    .where(and(eq(workspaceNotification.organizationId, orgId), eq(workspaceNotification.userId, userId),
      inArray(workspaceNotification.permission, permissions), isNull(workspaceNotification.readAt), isNull(workspaceNotification.resolvedAt)))
    .returning({ id: workspaceNotification.id })
  return { read: rows.length }
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
      unclaimed: row.assigneeUserId === null,
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

/**
 * Conversaciones que esperan respuesta (la vista «Esperan respuesta» de la
 * Bandeja, con su misma definición) y desde cuándo espera la que más lleva.
 * Con `withoutCases`, sin las que tienen un caso abierto del agente: esas ya
 * son su propia fila y no se cuentan dos veces.
 */
async function waitingConversations(tx: Db, orgId: string, withoutCases: boolean) {
  const conv = sql.raw("c")
  const [row] = await tx.execute<{ waiting: number; oldestAt: string | null }>(sql`
    with pending as (
      select ${unansweredSinceSql(conv)} as since from conversation c where c.organization_id=${orgId} and c.status='open'
        ${withoutCases ? sql`and not ${handoffOpenExistsSql(conv)}` : sql``}
    ) select count(since)::int as waiting, ${iso(sql`min(since)`)} as "oldestAt" from pending`)
  return row ?? { waiting: 0, oldestAt: null }
}

/**
 * Conversaciones que siguen abiertas con una persona a cargo y sin mensajes
 * desde hace las horas que eligió la clínica (`stillOpenWithPersonSql`): las de
 * quien mira y, para quien atiende lo del agente o dirige, las que no tiene nadie.
 */
async function waitingStillOpen(tx: Db, orgId: string, userId: string, access: WorkspaceAccess): Promise<WaitingStillOpen | null> {
  const conv = sql.raw("c")
  const scope = access.allTasks
    ? sql`true`
    : access.agent
      ? sql`(c.assigned_user_id = ${userId} or c.assigned_user_id is null)`
      : sql`c.assigned_user_id = ${userId}`
  const rows = await tx.execute<{ id: string; contactName: string | null; quietSince: string | null; total: number }>(sql`
    select c.id, ct.display_name as "contactName",
      ${iso(sql`greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), c.attention_started_at)`)} as "quietSince",
      count(*) over ()::int as total
    from conversation c join contact ct on ct.id = c.contact_id and ct.organization_id = c.organization_id
    where c.organization_id = ${orgId} and ${scope} and ${stillOpenWithPersonSql(conv)}
    order by greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), c.attention_started_at), c.id limit 1`)
  const first = rows[0]
  if (!first) return null
  const one = first.total === 1
  return { total: first.total, conversationId: one ? first.id : null, contactName: one ? first.contactName : null, quietSince: first.quietSince }
}

/** Citas que siguen sin confirmar después del primer recordatorio del agente, de la más próxima a la más lejana. */
async function waitingUnconfirmed(tx: Db, orgId: string): Promise<{ items: WaitingUnconfirmed[]; total: number }> {
  const appt = sql.raw("a")
  const rows = await tx.execute<{ [K in keyof WaitingUnconfirmed]: WaitingUnconfirmed[K] } & { total: number }>(sql`
    select a.id, a.patient_id as "patientId", p.display_name as "patientName", p.phone,
      ${iso(sql`a.starts_at`)} as "startsAt", b.name as "branchName", a.service_name as "serviceName",
      count(*) over ()::int as total
    from appointment a join patient p on p.id = a.patient_id and p.organization_id = ${orgId}
    join branch b on b.id = a.branch_id and b.organization_id = ${orgId}
    where a.organization_id = ${orgId} and ${remindedUnconfirmedSql(appt)}
    order by a.starts_at, a.id limit ${WAITING_LIMITS.unconfirmed}`)
  return { items: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 }
}

async function waitingTasks(tx: Db, orgId: string, userId: string, access: WorkspaceAccess, dayEnd: SQL) {
  const areas = access.taskAreas?.length ? sql`or (t.assignee_user_id is null and t.area in ${[...access.taskAreas]})` : sql``
  // La tarea de un caso del agente no es otra fila: el caso ya está en la lista.
  const cases = access.agent
    ? sql`and not exists (select 1 from agent_handoff h where h.organization_id = t.organization_id and h.task_id = t.id)`
    : sql``
  const scope = sql`t.organization_id=${orgId} and t.status='open' and (${access.allTasks} or t.assignee_user_id=${userId} ${areas}) ${cases}`
  type Row = Omit<WaitingTask, "href"> & { conversationId: string | null }
  const select = sql`select t.id, t.title, ${iso(sql`t.due_at`)} as "dueAt",
      case when t.due_at is null then 'none' when t.due_at < now() then 'overdue'
        when t.due_at < ${dayEnd} then 'today' else 'later' end as due,
      coalesce(t.assignee_user_id=${userId}, false) as mine, u.name as "assigneeName",
      t.conversation_id as "conversationId",
      ${access.crm ? sql`(select o.title from opportunity o where o.id = t.opportunity_id and o.organization_id = t.organization_id)` : sql`null`} as "opportunityTitle"
    from task t left join "user" u on u.id=t.assignee_user_id where ${scope}`
  const overdue = await tx.execute<Row>(sql`${select} and t.due_at < now() order by t.due_at, t.id limit ${WAITING_LIMITS.overdueTasks}`)
  const [next] = await tx.execute<Row>(sql`${select} and (t.due_at is null or t.due_at >= now()) order by t.due_at asc nulls last, t.id limit 1`)
  const [count] = await tx.execute<{ open: number }>(sql`select count(*)::int as open from task t where ${scope}`)
  // Una tarea de una conversación abre el hilo; las demás (de una oportunidad,
  // de una persona o sueltas) se abren en Tareas con la tarea a la vista.
  const place = ({ conversationId, ...task }: Row): WaitingTask => ({
    ...task,
    href: access.conversations && conversationId ? `/inbox?conversation=${conversationId}` : `/tasks?task=${task.id}`,
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

  const tasks = access.tasks ? await waitingTasks(tx, orgId, userId, access, dayEnd) : { overdue: [], next: null, open: 0 }
  // A lo sumo tres recomendaciones a la vez, como declara la ficha del administrador,
  // y solo las que quien mira puede atender. Quien atiende solo ve lo suyo, y las
  // recomendaciones son de toda la clínica: no las recibe.
  const admin = options.can && !access.ownAppointments
    ? await getAdminRecommendations(tx, orgId, options.can, { actionable: true })
    : { enabled: false, recommendations: [] }
  const advice = admin.recommendations
  // Las personas a las que el agente no pudo escribir: un motivo que alguien puede corregir.
  const unreached = options.can && access.agent ? await getAdminUnreached(tx, orgId, options.can) : null
  const waiting = composeWaiting({
    cases: access.agent ? await waitingCases(tx, orgId, userId, access.allTasks) : [],
    // Quien ve la agenda de la sede llama a quien no confirmó; quien atiende no.
    unconfirmed: access.appointments && !access.ownAppointments ? await waitingUnconfirmed(tx, orgId) : null,
    conversations: access.conversations ? await waitingConversations(tx, orgId, access.agent) : null,
    stillOpen: access.conversations ? await waitingStillOpen(tx, orgId, userId, access) : null,
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
  // Sin Recepción ni el Administrador no sale «Recordar la cita» ni ningún aviso:
  // es un paso más de la puesta en marcha para quien puede encenderlos.
  const agentStep = setup && options.can?.("agent.write") ? await adminRuntime(tx, orgId) : null
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
    setup: setup ? { ...setup, ...(agentStep ? { agent: agentStep.adminOn && agentStep.receptionOn } : {}) } : null,
    activity: { recorded: activity?.recorded ?? false } }
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
