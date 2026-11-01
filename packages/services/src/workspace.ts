import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { encounter, patient } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation, message } from "@odentia/db/schema/crm"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import { getAdminRecommendations, getAdminUnreached } from "./agent-admin.js"
import { countOpenHandoffs, listHandoffs, probarHandoffSql } from "./agent-operations.js"
import { type AppointmentVisit, appointmentVisit } from "./appointments.js"
import { checkEncounterClosing } from "./encounters.js"
import { AUDIT_AREA_LABELS, AUDIT_AREAS, type AuditArea, auditSubjectsOf, describeAuditEvent } from "./audit-words.js"
import { adminRuntime, remindedUnconfirmedSql } from "./automation.js"
import { budgetAwaitsAnswerSql } from "./budget-awaiting.js"
import { listRecategorizedMessages } from "./clinic-messages.js"
import { listConsentsToPublish } from "./clinical-forms.js"
import { handoffOpenExistsSql, screenedSql, stillOpenWithPersonSql, testContactSql, unansweredSinceSql } from "./conversation-state.js"
import { dueDataRequests } from "./data-requests.js"
import { notFound, validation } from "./errors.js"
import { getCashToday } from "./finance.js"
import { inventoryWaiting } from "./inventory.js"
import { handoffOpenSql } from "./handoff-state.js"
import { getOrgLocale } from "./locale.js"
import { upcomingWork } from "./report-finance.js"
import { windowOpen } from "./message-window.js"
import { topicUrgentAt } from "./topic-urgency.js"
import {
  composeWaiting,
  WAITING_LIMITS,
  type WaitingBudgets,
  type WaitingCase,
  type WaitingPerson,
  type WaitingStaleEncounter,
  type WaitingStillOpen,
  type WaitingPortalReentry,
  type WaitingPossibleDuplicate,
  type WaitingRegistrationDone,
  type WaitingTask,
  type WaitingUnconfirmed,
  type WaitingUnclosed,
  type WaitingAcceptedUnbooked,
  type WaitingUnsentBudget,
} from "./workspace-home.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

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
  /**
   * Envía presupuestos y habla con la persona (`budgets.send` y el CRM):
   * recepción y quien dirige. Le salen los presupuestos que nadie envió.
   */
  sendsBudgets?: boolean
  /**
   * Responde los temas que le pasan sin ver la Bandeja (`conversations.topics`):
   * caja recibe en «Te espera» los temas de pagos y los responde ahí mismo.
   */
  topics?: boolean
  /**
   * Escribe en la historia clínica (`clinical.write`): si hoy tiene citas propias
   * ve «Mis pacientes de hoy», también si es la dueña, y sus atenciones de otro
   * día sin cerrar llegan a «Te espera».
   */
  attends?: boolean
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
  /** La persona de la que trata: si es de prueba, no se avisa (ADR 0094). */
  contactId?: string | null
}

/**
 * Clases de asunto con su regla de «ya se resolvió» (`settleWorkspaceNotifications`).
 * - `producto:<id>`: avisos de stock bajo de antes (ADR 0067: la campana ya no
 *   avisa stock bajo; lo que hace falta es la fila de Inventario de «Te
 *   espera»). Se retira cuando ninguna sede está bajo su mínimo (o el producto
 *   se desactivó).
 * - `orden-clinica:<id>`: la orden dejó de estar solicitada.
 * - `oportunidad:<id>`: se cerró o ya no la lleva quien recibió el aviso.
 * - `modelo-del-agente`: el agente volvió a responder después del aviso.
 * - `clave-meta:<conexión>`: la clave de WhatsApp ya no tiene problema (se
 *   renovó o se volvió a conectar) o la conexión ya no está activa.
 * - `firma-meta:<conexión>`: WhatsApp con la app propia recibió un aviso bien
 *   firmado o se cambió la clave secreta.
 * - `vence-clave-meta:<conexión>`: la clave de la app propia ya no vence en
 *   los próximos 7 días (se pegó otra) o la conexión ya no está activa.
 * - `meta-desconecto:<conexión>`: Meta ya no tiene cortada la conexión (se
 *   volvió a conectar o Meta avisó que se reconectó) o la conexión ya no está activa.
 */
export const NOTICE_SUBJECTS = [
  "producto",
  "orden-clinica",
  "oportunidad",
  "modelo-del-agente",
  "clave-meta",
  "firma-meta",
  "vence-clave-meta",
  "meta-desconecto",
] as const

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
  if (input.contactId) {
    const [person] = await tx.select({ isTest: contact.isTest }).from(contact)
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, input.contactId))).limit(1)
    if (person?.isTest) return false
  }
  const [recipient] = await tx.select({ id: member.id }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, input.userId))).limit(1)
  if (!recipient) throw notFound("Destinatario")
  return true
}

function noticeRow(orgId: string, { actorUserId: _actor, contactId: _contact, subject, ...input }: WorkspaceNoticeInput) {
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
          join product_minimum pm on pm.organization_id = p.organization_id and pm.product_id = p.id and pm.min_quantity > 0
          where p.organization_id = n.organization_id and p.id::text = ${subjectId("producto")} and p.is_active
            -- Lo que hay en la sede: sus lotes menos lo que se usó sin haber.
            and coalesce((select sum(l.quantity_on_hand) from product_lot l
              join warehouse w on w.organization_id = l.organization_id and w.id = l.warehouse_id
              where l.organization_id = p.organization_id and l.product_id = p.id and w.branch_id = pm.branch_id), 0)
              - coalesce((select sum(s.quantity) from stock_shortage s
              join warehouse w on w.organization_id = s.organization_id and w.id = s.warehouse_id
              where s.organization_id = p.organization_id and s.product_id = p.id and w.branch_id = pm.branch_id), 0)
              < pm.min_quantity))
        or (n.subject like 'orden-clinica:%' and not exists (select 1 from clinical_order o
          where o.organization_id = n.organization_id and o.id::text = ${subjectId("orden-clinica")} and o.status = 'solicitado'))
        or (n.subject like 'oportunidad:%' and not exists (select 1 from opportunity o
          where o.organization_id = n.organization_id and o.id::text = ${subjectId("oportunidad")}
            and o.status = 'open' and o.assigned_user_id = n.user_id))
        or (n.subject = 'modelo-del-agente' and exists (select 1 from agent_run_ledger r
          where r.organization_id = n.organization_id and r.status in ('ok', 'handoff') and r.started_at > n.created_at))
        or (n.subject like 'clave-meta:%' and not exists (select 1 from channel_connection c
          where c.organization_id = n.organization_id and c.id::text = ${subjectId("clave-meta")}
            and c.status = 'active' and c.signup->>'tokenProblem' is not null))
        or (n.subject like 'firma-meta:%' and not exists (select 1 from channel_connection c
          where c.organization_id = n.organization_id and c.id::text = ${subjectId("firma-meta")}
            and c.status = 'active' and c.own_app->>'signatureRejectedAt' is not null))
        or (n.subject like 'vence-clave-meta:%' and not exists (select 1 from channel_connection c
          where c.organization_id = n.organization_id and c.id::text = ${subjectId("vence-clave-meta")}
            and c.status = 'active' and (c.own_app->>'tokenExpiresAt')::timestamptz <= now() + interval '7 days'))
        or (n.subject like 'meta-desconecto:%' and not exists (select 1 from channel_connection c
          where c.organization_id = n.organization_id and c.id::text = ${subjectId("meta-desconecto")}
            and c.status = 'active' and jsonb_typeof(c.signup->'metaRemoved') = 'object'))
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
  professionalUserId: string
  professionalName: string
  roomName: string
  branchName: string
  endsAt: string
  /** Cuándo llegó; null si nadie lo marcó. */
  arrivedAt: string | null
  /** El momento de la cita (`appointmentVisit`, ADR 0032): de ahí salen la sala, «Ahora» y «Más tarde». */
  visit: AppointmentVisit
  /** La atención abierta unida a la cita, sin nada de la historia: con quién y desde cuándo. */
  encounter: { id: string; startedAt: string; professionalUserId: string; professionalName: string } | null
  /** La siguiente cita en pie que aún no llega; a lo sumo una. */
  next: boolean
}

/**
 * Cuántas citas hay hoy y cómo van. `total` cuenta lo que ocupa la agenda (ni
 * canceladas ni inasistencias), igual que el número de citas del día en la
 * Agenda; `waiting` son las que llegaron y esperan, `attending` las que están
 * en atención, `attended` las atendidas y `upcoming` las que faltan (por
 * confirmar o confirmadas, sin llegar); `unconfirmed`, de esas, las que nadie
 * confirmó.
 */
export interface WorkspaceTodaySummary {
  total: number
  waiting: number
  attending: number
  attended: number
  upcoming: number
  unconfirmed: number
}

/**
 * «Hoy» de quien trabaja con la agenda. `branch`: la agenda de una sede, con lo
 * que está en la sala y lo que falta. `mine`: las citas de quien atiende, en
 * todas las sedes, en el orden «Sala de espera», «Ahora» y «Más tarde» (las ya
 * atendidas al final).
 */
export interface WorkspaceToday {
  scope: "branch" | "mine"
  branch: { id: string; name: string } | null
  /** Zona con que se partió el día y se leen las horas: la de la sede o la de la clínica. */
  timezone: string
  summary: WorkspaceTodaySummary
  appointments: WorkspaceAppointment[]
}

/** La agenda de la sede en una línea, para quien atiende y además ve la sede (la dueña que atiende). */
export interface WorkspaceAgendaLine {
  branch: { id: string; name: string }
  summary: WorkspaceTodaySummary
}

/** Filas de la agenda de una sede que viajan a Inicio; el resto se ve en la Agenda. */
const TODAY_BRANCH_ROWS = 6

async function homeBranch(tx: Db, orgId: string, branchId?: string) {
  const rows = await tx.execute<{ id: string; name: string; timezone: string | null }>(sql`
    select id, name, timezone from branch where organization_id=${orgId} and is_active order by created_at, id`)
  return { branch: rows.find(row => row.id === branchId) ?? rows[0] ?? null, many: rows.length > 1 }
}

/** El día de hoy en una zona, como rango de instantes. */
function dayBounds(zone: string) {
  return {
    start: sql`((now() at time zone ${zone})::date::timestamp at time zone ${zone})`,
    end: sql`(((now() at time zone ${zone})::date + 1)::timestamp at time zone ${zone})`,
  }
}

/** Quien atiende tiene hoy citas propias (en pie, atendidas o «No vino»), en la zona de la clínica. */
async function hasOwnAppointmentsToday(tx: Db, orgId: string, userId: string, timezone: string): Promise<boolean> {
  const { start, end } = dayBounds(timezone)
  const [row] = await tx.execute<{ found: boolean }>(sql`
    select exists(select 1 from appointment a where a.organization_id=${orgId} and a.professional_user_id=${userId}
      and not a.is_test and a.starts_at >= ${start} and a.starts_at < ${end}
      and a.status in ('programada','confirmada','atendida','no_asistio')) as found`)
  return row?.found ?? false
}

/** Orden de lectura: la sala (por llegada), lo que está en atención, lo que falta y, al final, lo terminado. */
const VISIT_ORDER: Record<AppointmentVisit, number> = {
  llego: 0, en_atencion: 1, por_confirmar: 2, confirmada: 2, atendida: 3, no_vino: 4, cancelada: 5,
}

async function workspaceToday(
  tx: Db, orgId: string, userId: string, own: boolean, branch: { id: string; name: string; timezone: string | null } | null, timezone: string,
): Promise<WorkspaceToday> {
  const empty: WorkspaceTodaySummary = { total: 0, waiting: 0, attending: 0, attended: 0, upcoming: 0, unconfirmed: 0 }
  if (!own && !branch) return { scope: "branch", branch: null, timezone, summary: empty, appointments: [] }
  // El día se parte con la zona de la sede, como en la Agenda; las citas propias, con la de la clínica.
  const zone = own ? timezone : (branch?.timezone ?? timezone)
  const { start, end } = dayBounds(zone)
  type Row = Omit<WorkspaceAppointment, "next" | "visit" | "encounter"> & {
    open: boolean
    encounterId: string | null
    encounterStatus: string | null
    encounterStartedAt: string | null
    encounterProfessionalUserId: string | null
    encounterProfessionalName: string | null
  }
  const rows = await tx.execute<Row>(sql`
    select a.id, a.patient_id as "patientId", pp.display_name as "patientName",
      ${iso(sql`a.starts_at`)} as "startsAt", a.status, a.service_name as "serviceName",
      a.professional_user_id as "professionalUserId", u.name as "professionalName", ch.name as "roomName", b.name as "branchName",
      case when a.arrived_at is null then null else ${iso(sql`a.arrived_at`)} end as "arrivedAt",
      ${iso(sql`a.ends_at`)} as "endsAt",
      a.ends_at > now() as open,
      e.id as "encounterId", e.status as "encounterStatus",
      case when e.id is null then null else ${iso(sql`e.started_at`)} end as "encounterStartedAt",
      e.professional_user_id as "encounterProfessionalUserId", eu.name as "encounterProfessionalName"
    from appointment a join patient p on p.id=a.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    join branch b on b.id=a.branch_id and b.organization_id=${orgId}
    join schedule_room ch on ch.id=a.room_id and ch.organization_id=${orgId}
    join "user" u on u.id=a.professional_user_id
    left join encounter e on e.organization_id=a.organization_id and e.appointment_id=a.id and e.status<>'anulada'
    left join "user" eu on eu.id=e.professional_user_id
    where a.organization_id=${orgId} and not a.is_test and a.starts_at >= ${start} and a.starts_at < ${end}
      and a.status in ('programada','confirmada','atendida','no_asistio')
      and ${own ? sql`a.professional_user_id=${userId}` : sql`a.branch_id=${branch?.id ?? null}`}
    order by a.starts_at, a.id limit 300`)
  const items = rows.map(({ encounterId, encounterStatus, encounterStartedAt, encounterProfessionalUserId, encounterProfessionalName, ...row }) => {
    const visit = appointmentVisit({ status: row.status, arrivedAt: row.arrivedAt, encounterStatus })
    const encounter = encounterId && encounterStatus === "borrador" && encounterStartedAt && encounterProfessionalUserId
      ? { id: encounterId, startedAt: encounterStartedAt, professionalUserId: encounterProfessionalUserId, professionalName: encounterProfessionalName ?? "" }
      : null
    return { ...row, visit, encounter }
  })
  const count = (...visits: AppointmentVisit[]) => items.filter(item => visits.includes(item.visit)).length
  const occupying = items.filter(item => item.visit !== "no_vino")
  const summary: WorkspaceTodaySummary = {
    total: occupying.length,
    waiting: count("llego"),
    attending: count("en_atencion"),
    attended: count("atendida"),
    upcoming: count("por_confirmar", "confirmada"),
    unconfirmed: count("por_confirmar"),
  }
  const pending = items.filter(item => item.visit === "por_confirmar" || item.visit === "confirmada")
  const nextId = pending.find(item => item.open)?.id ?? null
  const sorted = [...items].sort((a, b) =>
    VISIT_ORDER[a.visit] - VISIT_ORDER[b.visit]
    || (a.visit === "llego" ? (a.arrivedAt ?? "").localeCompare(b.arrivedAt ?? "") : 0)
    || a.startsAt.localeCompare(b.startsAt))
  // Quien atiende ve su día entero. La sede ve la sala, lo que está en atención,
  // lo que falta desde la siguiente, lo que pasó sin que llegara (aún puede
  // llegar tarde o marcarse «No vino») y, al final, quien no vino (para reagendar).
  const waitingRank = (item: (typeof sorted)[number]) =>
    item.visit === "llego" || item.visit === "en_atencion" ? 0
      : item.visit === "por_confirmar" || item.visit === "confirmada" ? (item.open ? 1 : 2)
        : item.visit === "no_vino" ? 3 : 4
  const shown = own
    ? sorted
    : sorted
        .filter(item => waitingRank(item) < 4)
        .sort((a, b) => waitingRank(a) - waitingRank(b))
        .slice(0, TODAY_BRANCH_ROWS)
  return {
    scope: own ? "mine" : "branch",
    branch: own || !branch ? null : { id: branch.id, name: branch.name },
    timezone: zone,
    summary,
    appointments: shown.map(({ open: _open, ...row }) => ({ ...row, next: row.id === nextId })),
  }
}

/**
 * Atenciones en borrador de un día anterior (en la zona de la clínica) que
 * lleva quien mira, con lo que les falta para cerrarse (decisión 12 de la fase 3).
 */
async function waitingStaleEncounters(tx: Db, orgId: string, userId: string, timezone: string): Promise<WaitingStaleEncounter[]> {
  const { start } = dayBounds(timezone)
  const rows = await tx
    .select({ row: encounter, patientName: patientPerson.displayName, personId: patient.personId })
    .from(encounter)
    .innerJoin(patient, and(eq(patient.id, encounter.patientId), eq(patient.organizationId, encounter.organizationId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(
      eq(encounter.organizationId, orgId),
      eq(encounter.professionalUserId, userId),
      eq(encounter.status, "borrador"),
      sql`${encounter.startedAt} < ${start}`,
    ))
    .orderBy(asc(encounter.startedAt), asc(encounter.id))
    .limit(WAITING_STALE_ENCOUNTERS)
  const items: WaitingStaleEncounter[] = []
  for (const { row, patientName, personId } of rows) {
    const closing = await checkEncounterClosing(tx, orgId, userId, row)
    items.push({ id: row.id, patientId: row.patientId, personId, patientName, startedAt: row.startedAt.toISOString(), missing: closing.missing })
  }
  return items
}

/** Atenciones de otro día sin cerrar que llegan a «Te espera» a la vez. */
const WAITING_STALE_ENCOUNTERS = 5

/** De estas conversaciones, las de Instagram o Messenger donde ya no se puede escribirle. */
async function shutConversations(tx: Db, orgId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await tx
    .select({ id: conversation.id, lastInboundAt: conversation.lastInboundAt })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), inArray(conversation.id, ids), inArray(channelConnection.provider, ["instagram", "messenger"])))
  return new Set(rows.filter((row) => !windowOpen(row.lastInboundAt)).map((row) => row.id))
}

/**
 * Casos que pasó el agente y siguen sin resolver, para quien puede tomarlos:
 * primero los urgentes y, en cada urgencia, el que más lleva esperando. El
 * corte va después de ordenar, y `total` cuenta todos: los más viejos nunca
 * quedan fuera sin decirlo.
 */
async function waitingCases(
  tx: Db,
  orgId: string,
  userId: string,
  all: boolean,
  scope: { onlyMine?: boolean; onlyPayments?: boolean } = {},
): Promise<{ items: WaitingCase[]; total: number }> {
  // Lo que ya tomó otra persona no espera a quien mira; quien dirige lo ve todo.
  // Quien no ve los casos del agente (el odontólogo) recibe solo los temas que
  // le pasaron, como una duda clínica de su paciente (ADR 0050); caja, los de
  // pagos (R3 y decisión 3 del pulido).
  // Lo suyo se filtra antes del límite: con una cola grande, sus pagos y sus dudas clínicas no quedan fuera.
  const only =
    scope.onlyMine || scope.onlyPayments
      ? { ...(scope.onlyMine ? { assignee: userId } : {}), ...(scope.onlyPayments ? { kinds: ["pago"] } : {}) }
      : undefined
  const rows = await listHandoffs(tx, orgId, {
    limit: 100,
    open: true,
    order: "urgencia",
    ...(all ? {} : { visibleTo: userId }),
    ...(only ? { only } : {}),
  })
  // Se responde desde Inicio lo propio y lo que nadie tomó: responder lo toma al
  // enviar (ADR 0127); caja, solo los pagos. No donde Instagram o Messenger ya no
  // dejan escribir: eso es «Escribirle» por otro canal.
  const mayReply = (row: (typeof rows)[number]) =>
    row.conversationId !== null && (row.assigneeUserId === userId || (row.assigneeUserId === null && (!scope.onlyPayments || row.kind === "pago")))
  const shut = await shutConversations(tx, orgId, rows.map((row) => row.conversationId).filter((id): id is string => id !== null))
  const closed = (row: (typeof rows)[number]) => shut.has(row.conversationId ?? "")
  const replies = (row: (typeof rows)[number]) => mayReply(row) && !closed(row)
  const assigneeIds = [...new Set(rows.map((row) => row.assigneeUserId).filter((id): id is string => id !== null && id !== userId))]
  const assignees = new Map(
    assigneeIds.length
      ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, assigneeIds))).map((row) => [row.id, row.name] as const)
      : [],
  )
  const sourceIds = rows.map((row) => row.sourceMessageId).filter((id): id is string => id !== null)
  const quotes = new Map(
    sourceIds.length
      ? (await tx.select({ id: message.id, body: message.body }).from(message).where(and(eq(message.organizationId, orgId), inArray(message.id, sourceIds))))
          .map((row) => [row.id, (row.body ?? "").replace(/\s+/g, " ").trim().slice(0, 280) || null] as const)
      : [],
  )
  const items = rows
    .map(row => ({
      id: row.id, priority: row.priority, urgent: row.urgent, topicKind: row.kind, reason: row.reason, contactName: row.contactName,
      channel: row.channel, createdAt: row.createdAt, conversationId: row.conversationId, taskId: row.taskId, contactId: row.contactId,
      unclaimed: row.assigneeUserId === null,
      canReply: replies(row),
      windowClosed: closed(row),
      assigneeName: row.assigneeUserId && row.assigneeUserId !== userId ? (assignees.get(row.assigneeUserId) ?? null) : null,
      quote: row.sourceMessageId ? (quotes.get(row.sourceMessageId) ?? null) : null,
    }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const total = scope.onlyMine || scope.onlyPayments || rows.length < 100 ? rows.length : await countOpenHandoffs(tx, orgId, all ? {} : { forUserId: userId })
  return { items, total }
}

/** Las conversaciones que esperan respuesta: la misma definición para listarlas y para contarlas. */
function pendingConversationsSql(orgId: string, assignedTo: string | null): SQL {
  const conv = sql.raw("c")
  return sql`select c.id, c.contact_id, c.channel_connection_id, ${unansweredSinceSql(conv)} as since from conversation c where c.organization_id=${orgId} and c.status='open'
        and not ${screenedSql(conv)} and c.test_by_user_id is null
        and not ${handoffOpenExistsSql(conv)}
        ${assignedTo ? sql`and c.assigned_user_id = ${assignedTo}` : sql``}`
}

/**
 * Conversaciones que esperan respuesta (la vista «Esperan respuesta» de la
 * Bandeja, con su misma definición): cuántas son y, de las que más llevan, con
 * quién y qué pidió. Sin las que tienen un caso abierto del agente: esas ya son
 * su propia fila y no se cuentan dos veces. Con `assignedTo`, solo las que lleva
 * esa persona: quien atiende no recibe la cuenta de toda la clínica.
 */
async function waitingConversations(tx: Db, orgId: string, assignedTo: string | null): Promise<{ waiting: number; items: WaitingPerson[] }> {
  const rows = await tx.execute<{ conversationId: string; contactId: string; contactName: string | null; channel: string | null; since: string; quote: string | null; total: number }>(sql`
    with pending as (${pendingConversationsSql(orgId, assignedTo)})
    select p.id as "conversationId", p.contact_id as "contactId", ct.display_name as "contactName", ch.channel,
      ${iso(sql`p.since`)} as since,
      (select left(regexp_replace(m.body, '[[:space:]]+', ' ', 'g'), 280) from message m
        where m.organization_id = ${orgId} and m.conversation_id = p.id and m.direction = 'in' and m.body is not null
        order by m.created_at desc, m.id desc limit 1) as quote,
      count(*) over ()::int as total
    from pending p
    join contact ct on ct.id = p.contact_id and ct.organization_id = ${orgId}
    left join channel_connection ch on ch.id = p.channel_connection_id and ch.organization_id = ${orgId}
    where p.since is not null
    order by p.since, p.id limit ${WAITING_LIMITS.conversations}`)
  const shut = await shutConversations(tx, orgId, rows.map((row) => row.conversationId))
  const items: WaitingPerson[] = []
  for (const { total: _total, ...row } of rows) {
    const urgentAt = await topicUrgentAt(tx, orgId, new Date(row.since))
    items.push({ ...row, urgent: urgentAt.getTime() <= Date.now(), windowClosed: shut.has(row.conversationId) })
  }
  return { waiting: rows[0]?.total ?? 0, items }
}

/**
 * Cuántas personas esperan a quien mira: el único número del menú, en «Inicio».
 * Los casos del agente sin tomar o suyos, más las conversaciones que esperan
 * respuesta y no son un caso; nunca lo que ya tiene otra persona, aunque quien
 * dirige lo vea en «Te espera». Cada persona cuenta una vez, como su fila.
 */
export async function countWorkspaceWaiting(tx: Db, orgId: string, userId: string, access: WorkspaceAccess): Promise<number> {
  // Sin ver los casos del agente, los que le pasaron; caja, además, los pagos sin tomar.
  const onlyPayments = !access.conversations && access.topics === true
  const cases = access.agent
    ? sql`(h.assignee_user_id is null or h.assignee_user_id = ${userId})`
    : access.conversations || access.topics
      ? sql`(h.assignee_user_id = ${userId} ${onlyPayments ? sql`or (h.assignee_user_id is null and h.kind = 'pago')` : sql``})`
      : null
  const sources: SQL[] = []
  // Un caso sin persona es su propia fila.
  if (cases) {
    sources.push(sql`select coalesce(h.contact_id::text, h.id::text) as person from agent_handoff h
      where h.organization_id = ${orgId} and ${handoffOpenSql(sql.raw("h"))} and not ${probarHandoffSql(sql.raw("h"))} and ${cases}`)
  }
  if (access.conversations) {
    sources.push(sql`select p.contact_id::text as person from (${pendingConversationsSql(orgId, access.agent ? null : userId)}) p where p.since is not null`)
  }
  if (sources.length === 0) return 0
  const [row] = await tx.execute<{ people: number }>(sql`select count(distinct person)::int as people from (${sql.join(sources, sql` union all `)}) waiting`)
  return row?.people ?? 0
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
    where c.organization_id = ${orgId} and ${scope} and ${stillOpenWithPersonSql(conv)} and c.test_by_user_id is null
    order by greatest(coalesce(c.last_message_at, '-infinity'::timestamptz), c.attention_started_at), c.id limit 1`)
  const first = rows[0]
  if (!first) return null
  const one = first.total === 1
  return { total: first.total, conversationId: one ? first.id : null, contactName: one ? first.contactName : null, quietSince: first.quietSince }
}

/**
 * Citas que hay que confirmar llamando, de la más próxima a la más lejana: las
 * que siguen sin confirmar después del primer recordatorio del agente y las de
 * mañana de quien no recibe recordatorios (ADR 0040), con «Recordar la cita»
 * prendida: sin ella nadie los recibe y no hay a quién llamar de más.
 */
/**
 * Quien envió hoy sus datos por su enlace («Tus datos y tu salud») y tiene
 * una cita hoy en pie, sin llegar (el día en la zona de su sede).
 */
async function waitingRegistrationsDone(tx: Db, orgId: string): Promise<WaitingRegistrationDone[]> {
  const rows = await tx.execute<{ [K in keyof WaitingRegistrationDone]: WaitingRegistrationDone[K] }>(sql`
    select a.id as "appointmentId", a.patient_id as "patientId", p.person_id as "personId", pp.display_name as "patientName",
      ${iso(sql`sent.at`)} as "sentAt", ${iso(sql`a.starts_at`)} as "startsAt", u.name as "professionalName"
    from appointment a
    join branch b on b.id = a.branch_id and b.organization_id = a.organization_id
    join patient p on p.id = a.patient_id and p.organization_id = a.organization_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join "user" u on u.id = a.professional_user_id
    cross join lateral (select max(e.created_at) as at from audit_event e
      where e.organization_id = a.organization_id and e.action = 'personal_link.data_sent' and e.entity_id = a.patient_id::text
        and (e.created_at at time zone coalesce(b.timezone, 'UTC'))::date = (now() at time zone coalesce(b.timezone, 'UTC'))::date) sent
    where a.organization_id = ${orgId} and not a.is_test and a.status in ('programada', 'confirmada') and a.arrived_at is null
      and (a.starts_at at time zone coalesce(b.timezone, 'UTC'))::date = (now() at time zone coalesce(b.timezone, 'UTC'))::date
      and sent.at is not null
    order by sent.at desc, a.id limit ${WAITING_LIMITS.otherCases}`)
  return [...rows]
}

/**
 * Citas de un día que ya terminó (en la zona de su sede o, sin ella, la de la clínica) que siguen en pie sin
 * llegada: nadie dijo si vinieron. De la más antigua a la más reciente.
 */
async function waitingUnclosed(tx: Db, orgId: string, timezone: string, professionalUserId: string | null): Promise<{ items: WaitingUnclosed[]; total: number; nextAt: string | null }> {
  const rows = await tx.execute<{ [K in keyof WaitingUnclosed]: WaitingUnclosed[K] } & { total: number }>(sql`
    select a.id, a.patient_id as "patientId", p.person_id as "personId", pp.display_name as "patientName", ${iso(sql`a.starts_at`)} as "startsAt",
      a.professional_user_id as "professionalUserId", u.name as "professionalName", a.service_name as "serviceName", b.name as "branchName",
      count(*) over ()::int as total
    from appointment a
    join branch b on b.id = a.branch_id and b.organization_id = a.organization_id
    join patient p on p.id = a.patient_id and p.organization_id = a.organization_id
    join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join "user" u on u.id = a.professional_user_id
    where a.organization_id = ${orgId} and not a.is_test and a.status in ('programada', 'confirmada') and a.arrived_at is null
      ${professionalUserId ? sql`and a.professional_user_id = ${professionalUserId}` : sql``}
      and (a.starts_at at time zone coalesce(b.timezone, ${timezone}))::date < (now() at time zone coalesce(b.timezone, ${timezone}))::date
      -- Con su atención empezada no está sin cerrar: está en atención (y su borrador ya sale aparte).
      and not exists (select 1 from encounter e where e.organization_id = a.organization_id and e.appointment_id = a.id and e.status <> 'anulada')
    order by a.starts_at, a.id limit ${WAITING_LIMITS.unclosed + 1}`)
  const items = rows.map(({ total: _total, ...row }) => row)
  // La primera que no cabe: «N más» lleva a su día en la Agenda, donde se cierra.
  return { items: items.slice(0, WAITING_LIMITS.unclosed), total: rows[0]?.total ?? 0, nextAt: items[WAITING_LIMITS.unclosed]?.startsAt ?? null }
}

/** La misma cuenta de Reportes › Finanzas («No tienen cita»), en la moneda de la clínica. */
async function acceptedUnbookedOf(tx: Db, orgId: string): Promise<WaitingAcceptedUnbooked | null> {
  const { currency } = await getOrgLocale(tx, orgId)
  const work = await upcomingWork(tx, orgId, currency, new Date())
  return work.unbooked.patients > 0 ? { patients: work.unbooked.patients, cents: work.unbooked.cents, currency } : null
}

async function waitingUnconfirmed(tx: Db, orgId: string): Promise<{ items: WaitingUnconfirmed[]; total: number }> {
  const appt = sql.raw("a")
  const rows = await tx.execute<{ [K in keyof WaitingUnconfirmed]: WaitingUnconfirmed[K] } & { total: number }>(sql`
    select a.id, a.patient_id as "patientId", p.person_id as "personId", pp.display_name as "patientName", pp.phone,
      ${iso(sql`a.starts_at`)} as "startsAt", b.name as "branchName", a.service_name as "serviceName",
      case when ${remindedUnconfirmedSql(appt)} then 'sin_confirmar' else 'sin_recordatorios' end as why,
      count(*) over ()::int as total
    from appointment a join patient p on p.id = a.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    join branch b on b.id = a.branch_id and b.organization_id = ${orgId}
    where a.organization_id = ${orgId} and not a.is_test
      and (${remindedUnconfirmedSql(appt)} or ${noRemindersTomorrowSql(orgId)})
    order by a.starts_at, a.id limit ${WAITING_LIMITS.unconfirmed}`)
  return { items: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 }
}

/**
 * Una cita de mañana (en la zona de su sede), en pie y sin confirmar, cuyo
 * paciente no recibe recordatorios: quien recibe sus mensajes (el mismo
 * contacto que «Recordar la cita», `preferredContact`) los apagó o pidió no
 * recibir ningún mensaje. Solo con «Recordar la cita» prendida. `a` y `b` son
 * la cita y su sede.
 */
function noRemindersTomorrowSql(orgId: string): SQL {
  return sql`(a.status = 'programada'
    and (a.starts_at at time zone coalesce(b.timezone, 'UTC'))::date = ((now() at time zone coalesce(b.timezone, 'UTC'))::date + 1)
    and exists (select 1 from automation_rule r where r.organization_id = ${orgId}
      and r.kind = 'recordatorio_cita' and r.enabled and r.agent_part)
    and exists (select 1 from automation_consent s
      where s.organization_id = ${orgId} and s.status = 'revoked' and s.purpose in ('recordatorio', 'avisos')
        and s.contact_id = (select pc.contact_id from patient_contact pc
          join contact c on c.id = pc.contact_id and c.organization_id = pc.organization_id and c.is_active
          where pc.organization_id = ${orgId} and pc.patient_id = a.patient_id
          order by pc.is_preferred desc, (pc.relationship = 'self') desc, pc.created_at, pc.id limit 1)))`
}

async function waitingTasks(tx: Db, orgId: string, userId: string, access: WorkspaceAccess, dayEnd: SQL) {
  const areas = access.taskAreas?.length ? sql`or (t.assignee_user_id is null and t.area in ${[...access.taskAreas]})` : sql``
  // La tarea de un caso del agente no es otra fila: el caso ya está en la lista,
  // también para el odontólogo y caja, que ven sus temas como casos.
  const cases = access.agent || access.conversations || access.topics
    ? sql`and not exists (select 1 from agent_handoff h where h.organization_id = t.organization_id and h.task_id = t.id)`
    : sql``
  // Lo que dejó el sistema con su propia fila (`task.kind`) no se repite como tarea.
  // Lo de una persona de prueba se ve en «Probar», no en «Te espera» (ADR 0094).
  const scope = sql`t.organization_id=${orgId} and t.status='open' and t.kind is null and (${access.allTasks} or t.assignee_user_id=${userId} ${areas}) ${cases}
    and not ${testContactSql(sql`t.contact_id`)}`
  type Row = Omit<WaitingTask, "href"> & { conversationId: string | null }
  const select = sql`select t.id, t.title, ${iso(sql`t.due_at`)} as "dueAt",
      case when t.due_at is null then 'none' when t.due_at < now() then 'overdue'
        when t.due_at < ${dayEnd} then 'today' else 'later' end as due,
      coalesce(t.assignee_user_id=${userId}, false) as mine, u.name as "assigneeName",
      t.conversation_id as "conversationId", t.contact_id as "personId",
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

/**
 * Lo que dejaron «Su enlace», el registro en línea y el portal para
 * recepción, con su propia fila: la posible ficha repetida, alguien que se
 * registró con el documento de otra persona, el representante por confirmar
 * y quien pide volver a entrar al portal (ADR 0037). Son tareas abiertas de
 * su área; se van al hacerlas. La clase de la tarea dice cuál es
 * (`ficha_repetida`, `registro_con_documento`, `confirmar_representante`,
 * `volver_al_portal`).
 */
async function waitingSystemTasks(
  tx: Db,
  orgId: string,
  userId: string,
  access: WorkspaceAccess,
): Promise<{ duplicates: WaitingPossibleDuplicate[]; reentries: WaitingPortalReentry[] }> {
  const areas = access.taskAreas?.length ? sql`or (t.assignee_user_id is null and t.area in ${[...access.taskAreas]})` : sql``
  const rows = await tx.execute<{
    id: string
    kind: string
    patientId: string | null
    patientPersonId: string | null
    patientName: string | null
    contactId: string | null
    contactName: string | null
    reason: string | null
    createdAt: string
    grantId: string | null
    held: boolean
  }>(sql`
    select t.id, t.kind, t.patient_id as "patientId", pp.id as "patientPersonId", pp.display_name as "patientName",
      t.contact_id as "contactId", ct.display_name as "contactName", t.reason, ${iso(sql`t.created_at`)} as "createdAt",
      (select g.id from portal_grant g where g.organization_id = t.organization_id and g.patient_id = t.patient_id
        and g.contact_id = t.contact_id and g.status = 'activo' limit 1) as "grantId",
      exists (select 1 from registration_hold h where h.organization_id = t.organization_id and h.task_id = t.id) as held
    from task t
    left join patient p on p.id = t.patient_id and p.organization_id = t.organization_id
    left join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    left join contact ct on ct.id = t.contact_id and ct.organization_id = t.organization_id
    where t.organization_id = ${orgId} and t.status = 'open' and t.kind is not null
      and (t.patient_id is not null or t.contact_id is not null) and not ${testContactSql(sql`t.contact_id`)}
      and (${access.allTasks} or t.assignee_user_id = ${userId} ${areas})
    order by t.created_at, t.id limit 100`)
  const SOURCE: Record<string, WaitingPossibleDuplicate["source"]> = {
    ficha_repetida: "enlace",
    registro_con_documento: "registro",
    confirmar_representante: "representante",
  }
  return {
    duplicates: rows
      .flatMap((row): WaitingPossibleDuplicate[] => {
        const source = SOURCE[row.kind]
        if (!source) return []
        // En «registro» la fila es de quien tenía el documento (con ficha o sin ella).
        const name = source === "registro" ? (row.contactName ?? row.patientName) : row.patientName
        if (!name || (source !== "registro" && !row.patientId)) return []
        return [
          {
            id: row.id,
            source,
            patientId: row.patientId,
            personId: source === "enlace" ? row.patientPersonId : row.contactId,
            patientName: name,
            personName: source === "representante" ? row.contactName : null,
            detail: row.reason ?? "",
            createdAt: row.createdAt,
            ...(source === "registro" ? { held: row.held } : {}),
          },
        ]
      }),
    reentries: rows
      .filter((row) => row.kind === "volver_al_portal" && row.patientId)
      .map((row) => ({
        id: row.id,
        patientId: row.patientId as string,
        personId: row.patientPersonId,
        contactName: row.contactName ?? row.patientName ?? "",
        grantId: row.grantId,
        createdAt: row.createdAt,
      })),
  }
}

/**
 * Presupuestos armados y sin enviar desde antes de hoy (en la zona de la
 * clínica): el borrador de la persona con alguna línea. El total es el de la
 * opción recomendada (la que vale mientras decide).
 */
async function waitingUnsentBudgets(
  tx: Db,
  orgId: string,
  dayStart: SQL,
): Promise<{ items: WaitingUnsentBudget[]; total: number }> {
  const rows = await tx.execute<{ [K in keyof WaitingUnsentBudget]: WaitingUnsentBudget[K] } & { total: number }>(sql`
    select b.id, b.patient_id as "patientId", p.person_id as "personId", pp.display_name as "patientName", ${iso(sql`armado.at`)} as since,
      (select count(distinct l.plan_item_id)::int from treatment_budget_item l
        join treatment_budget_option o on o.id = l.option_id and o.organization_id = l.organization_id
        where l.organization_id = b.organization_id and l.budget_id = b.id and o.is_recommended) as "itemCount",
      (select case when bool_or(l.price_cents is null) then null else sum(l.price_cents *
          case when l.billing_mode = 'session' then greatest(coalesce(l.sessions_planned, 1), 1) else 1 end)::int end
        from treatment_budget_item l
        join treatment_budget_option o on o.id = l.option_id and o.organization_id = l.organization_id
        where l.organization_id = b.organization_id and l.budget_id = b.id and o.is_recommended) as "totalCents",
      b.currency,
      (select count(*)::int from treatment_budget_option o where o.organization_id = b.organization_id and o.budget_id = b.id) as options,
      count(*) over ()::int as total
    from treatment_budget b join patient p on p.id = b.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
    -- Armado cuando entró su último tratamiento: lo que creció hoy aún no espera.
    cross join lateral (select max(l.created_at) as at from treatment_budget_item l
      where l.organization_id = b.organization_id and l.budget_id = b.id) armado
    where b.organization_id = ${orgId} and b.status = 'borrador' and b.supersedes_budget_id is null
      and armado.at < ${dayStart}
    order by armado.at, b.id limit ${WAITING_LIMITS.unsentBudgets}`)
  return { items: rows.map(({ total: _total, ...row }) => row), total: rows[0]?.total ?? 0 }
}

/** Presupuestos que siguen esperando respuesta (`budgetAwaitsAnswerSql`); quien atiende, solo los de sus planes. */
async function waitingBudgets(tx: Db, orgId: string, userId: string, ownOnly: boolean): Promise<WaitingBudgets> {
  const awaiting = budgetAwaitsAnswerSql({ id: sql`b.id`, status: sql`b.status`, organizationId: sql`b.organization_id` })
  // Quien atiende ve los de lo que él indicó o preparó (el plan es uno por persona).
  const scope = sql`b.organization_id=${orgId} and ${awaiting}
    and (not ${ownOnly} or b.created_by=${userId} or exists (select 1 from treatment_budget_item own_line
      join treatment_plan_item own_item on own_item.id=own_line.plan_item_id and own_item.organization_id=own_line.organization_id
      where own_line.organization_id=${orgId} and own_line.budget_id=b.id and own_item.created_by=${userId}))`
  const items = await tx.execute<WaitingBudgets["items"][number]>(sql`
    select b.id, b.patient_id as "patientId", pp.display_name as "patientName", b.title,
      ${iso(sql`b.presented_at`)} as "presentedAt"
    from treatment_budget b join patient p on p.id=b.patient_id and p.organization_id=${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
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
  const dayStart = sql`((${day.date}::date)::timestamp at time zone ${timezone})`
  const needsBranch = access.appointments || access.finance
  const { branch, many } = needsBranch ? await homeBranch(tx, orgId, options.branchId) : { branch: null, many: false }

  // «Mis pacientes de hoy» es de quien atiende: el odontólogo siempre y, si hoy
  // tiene citas propias, también la dueña o quien dirige y atiende (ADR 0032).
  const ownToday = access.appointments && (access.ownAppointments
    || (access.attends === true && await hasOwnAppointmentsToday(tx, orgId, userId, timezone)))
  const today = access.appointments ? await workspaceToday(tx, orgId, userId, ownToday, branch, timezone) : null
  // Quien además ve la sede tiene su agenda en una línea, como la caja.
  const branchDay = ownToday && !access.ownAppointments && branch ? await workspaceToday(tx, orgId, userId, false, branch, timezone) : null
  const agendaLine: WorkspaceAgendaLine | null = branchDay?.branch ? { branch: branchDay.branch, summary: branchDay.summary } : null
  const cash = access.finance && branch ? await getCashToday(tx, orgId, { branchId: branch.id }) : null

  const tasks = access.tasks ? await waitingTasks(tx, orgId, userId, access, dayEnd) : { overdue: [], next: null, open: 0 }
  const system = access.tasks && access.patients ? await waitingSystemTasks(tx, orgId, userId, access) : { duplicates: [], reentries: [] }
  // A lo sumo tres recomendaciones a la vez, como declara la ficha del administrador,
  // y solo las que quien mira puede atender. Quien atiende solo ve lo suyo, y las
  // recomendaciones son de toda la clínica: no las recibe.
  const admin = options.can && !access.ownAppointments
    ? await getAdminRecommendations(tx, orgId, options.can, { actionable: true, onlyShown: true })
    : { enabled: false, recommendations: [] }
  const advice = admin.recommendations
  // Las personas a las que el agente no pudo escribir: un motivo que alguien puede corregir.
  const unreached = options.can && access.agent ? await getAdminUnreached(tx, orgId, options.can) : null
  const waiting = composeWaiting({
    ...(access.agent || access.conversations || access.topics
      ? await waitingCases(tx, orgId, userId, access.agent && access.allTasks, {
          onlyMine: !access.agent,
          onlyPayments: !access.conversations && access.topics === true,
        }).then(({ items, total }) => ({ cases: items, casesTotal: total }))
      : { cases: [] }),
    // Ningún borrador queda abandonado: la atención de otro día le sale a quien la lleva.
    staleEncounters: access.attends ? await waitingStaleEncounters(tx, orgId, userId, timezone) : [],
    // Quien ve la agenda de la sede llama a quien no confirmó; quien atiende no.
    unconfirmed: access.appointments && !access.ownAppointments ? await waitingUnconfirmed(tx, orgId) : null,
    // Y cierra lo que ya pasó: ¿vino o no vino? Quien atiende, las suyas: si vino, le toca registrar la atención.
    unclosed: access.appointments ? await waitingUnclosed(tx, orgId, timezone, access.ownAppointments ? userId : null) : null,
    // Lo aceptado sin cita, para quien ve Reportes: la fila abre esa lista para agendarlos.
    acceptedUnbooked: options.can?.("reports.read") ? await acceptedUnbookedOf(tx, orgId) : null,
    // Quien ve la agenda de la sede sabe quién ya completó su registro para su cita de hoy.
    registrationsDone: access.appointments && !access.ownAppointments ? await waitingRegistrationsDone(tx, orgId) : [],
    // El presupuesto que nadie envió le sale a quien habla con la persona (decisión 12).
    unsentBudgets: access.sendsBudgets ? await waitingUnsentBudgets(tx, orgId, dayStart) : null,
    possibleDuplicates: system.duplicates,
    portalReentries: system.reentries,
    // Los pedidos sobre sus datos, para quien los atiende (ADR 0080).
    dataRequests: options.can?.("patients.write") ? (await dueDataRequests(tx, orgId, day.date)).map(({ kind, ...item }) => ({ ...item, request: kind }))
      : [],
    conversations: access.conversations ? await waitingConversations(tx, orgId, access.agent ? null : userId) : null,
    stillOpen: access.conversations ? await waitingStillOpen(tx, orgId, userId, access) : null,
    overdueTasks: tasks.overdue,
    nextTask: tasks.next,
    openTasks: tasks.open,
    advice: advice.map(({ key, title, detail, actor }) => ({ key, title, detail, actor })),
    unreached: unreached && unreached.total > 0 ? { total: unreached.total, byCause: unreached.byCause.map(({ total, reason }) => ({ total, reason })) } : null,
    // Con el administrador encendido, los presupuestos sin respuesta son una de sus líneas: no se repiten aquí.
    budgets: (access.finance || access.clinical) && !admin.enabled ? await waitingBudgets(tx, orgId, userId, access.ownAppointments) : null,
    // Quien administra los mensajes cambia el texto del aviso que WhatsApp pasó a promoción (ADR 0040).
    promotions: options.can?.("settings.write") ? await listRecategorizedMessages(tx, orgId) : [],
    today: day.date,
    // Quien configura publica el consentimiento que una atención pidió (paso 2B).
    // Lo que hace falta y lo vencido de cada sede, para quien pide las compras (ADR 0067).
    inventory: options.can?.("inventory.write") ? await inventoryWaiting(tx, orgId) : [],
    consentsToPublish: access.configure
      ? (await listConsentsToPublish(tx, orgId)).map(({ templateKey, title, requestedByName, requestedAt }) => ({
          templateKey,
          title,
          requestedByName,
          requestedAt,
        }))
      : [],
  })

  // La puesta en marcha consulta capacidades existentes, no deduce configuración
  // a partir de contadores operativos en cero. Solo administración recibe estos datos.
  const [setup] = access.configure ? await tx.execute<{ availability: boolean; rooms: boolean; patients: boolean }>(sql`
    select exists(select 1 from professional_schedule where organization_id=${orgId} and is_active) as availability,
      exists(select 1 from schedule_room where organization_id=${orgId} and is_active) as rooms,
      exists(select 1 from patient p join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        where p.organization_id=${orgId} and not pp.is_test) as patients`) : []
  // Sin Recepción ni el Administrador no sale «Recordar la cita» ni ningún aviso:
  // es un paso más de la puesta en marcha para quien puede encenderlos.
  const agentStep = setup && options.can?.("agent.write") ? await adminRuntime(tx, orgId) : null
  // Con trabajo ya registrado, Inicio deja de ofrecer la puesta en marcha.
  const [activity] = await tx.execute<{ recorded: boolean }>(sql`
    select (
      ${access.appointments} and exists(select 1 from appointment where organization_id=${orgId} and not is_test)
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
  return { date: day.date, timezone, locale, access, multiBranch: many, waiting, today, agendaLine, cash,
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
      -- Lo que hizo la propia persona (portal, enlace de reserva) lleva el actor «contact:<id>».
      case when a.actor_user_id like 'contact:%' then 'patient' else a.metadata->>'origin' end as origin
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
