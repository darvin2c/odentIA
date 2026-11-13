/**
 * La venta del ARM de la administración (ADR 0185): lo que pasa con un cliente
 * mientras se le vende y al entrar. Actividades (la bitácora `saas_follow_up`),
 * tareas, la oportunidad y su decisión, la invitación, las presentaciones, las
 * propuestas con su PDF, los envíos por correo o WhatsApp y el embudo.
 *
 * Reglas que rigen aquí:
 * - La ruta abre la transacción y el servicio la recibe (`tx`), con el actor
 *   del personal ya verificado. Correo y almacenamiento van después del commit.
 * - Soporte anota, pone tareas y escribe; lo que cambia la venta (decidir,
 *   invitar, propuestas, vendedor) y los importes son solo de Administración.
 *   El servidor lo exige aquí, la pantalla solo lo refleja.
 * - Invitar es una sola operación (`inviteFromWaitlist`): un cliente sin
 *   solicitud viva recibe una con `source = 'administracion'`. Las condiciones
 *   de la propuesta aceptada se aplican al entrar con las mismas operaciones de
 *   «Precio y prueba» (`setSaasDiscount`, `setSaasTrialTerms`,
 *   `setSaasBillingCycle`).
 * - Un envío nunca se reintenta: el correo queda `enviado` o `incierto`, y el
 *   de WhatsApp sale por enlace y lo resuelve una persona («Salió» / «No
 *   salió»). La base protege ese flujo (`saas_outreach_guard`).
 * - La etapa del cliente no se guarda: se calcula al leer.
 */
import { randomUUID } from "node:crypto"
import {
  type ClinicalProduct,
  formatMoney,
  isClinicalProduct,
  productWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  kairosItem,
  SAAS_ACTIVITY_DIRECTIONS,
  SAAS_ACTIVITY_KINDS,
  type SAAS_CLIENT_ORIGINS,
  SAAS_CLIENT_PROFESSIONALS,
  SAAS_CLIENT_TOOLS,
  SAAS_LOST_REASONS,
  SAAS_OUTREACH_CHANNELS,
  SAAS_PROPOSAL_BILLING_CYCLES,
  SAAS_TASK_KINDS,
  type SaasActivityDirection,
  type SaasActivityKind,
  type SaasInboundMailbox,
  type SaasLostReason,
  type SaasOpportunityDecision,
  type SaasOutreachChannel,
  type SaasOutreachStatus,
  type SaasProposalStatus,
  type SaasTaskKind,
  type SaasTaskStatus,
  saasClient,
  saasClientContact,
  saasInboundEmail,
  saasOpportunity,
  saasOutreach,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import {
  saasFollowUp,
  saasPlan,
  saasSeller,
  saasSubscription,
  saasWaitlistRequest,
} from "@odentia/db/schema/saas-billing"
import { brandPaper, type MailBrand, type MailMessage, renderEmail } from "@odentia/mail"
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  type SQL,
  sql,
} from "drizzle-orm"
import {
  type ClientSignal,
  clientSignals,
  clientStageSql,
  closeClientSaleAsEntered,
  LOST_REASON_WORDS,
  nextSteps,
  outreachAdminOnlySql,
  proposalLiveSql,
  proposalOfOpenSaleSql,
  proposalReplacedBySql,
  seesTaskKind,
  taskOverdue,
  visibleTaskSql,
} from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import {
  brandMailbox,
  type MailSender,
  markStaffMailUsed,
  outreachSender,
  senderOfAddress,
} from "./admin-staff-mail.js"
import { productMailDomain } from "./clinic-progress-report.js"
import { CONSUMER_COMPLAINT_PROVIDER } from "./consumer-complaints.js"
import { type DocumentClinic, DocumentKit, dayWords, SIZE, sheetFormat } from "./document-kit.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import { moneyText } from "./saas-emails.js"
import { discardWaitlistRequest, inviteFromWaitlist } from "./saas-founders.js"
import {
  type NegotiationOutcome,
  setSaasBillingCycle,
  setSaasDiscount,
  setSaasTrialTerms,
} from "./saas-terms.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const E164 = /^\+[1-9][0-9]{6,14}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DAY = 86_400_000
/** Lo que se tolera de reloj adelantado al anotar «cuándo pasó». */
const CLOCK_SKEW_MS = 5 * 60_000
/** La propuesta en PDF no pasa de dos hojas. */
export const PROPOSAL_MAX_PAGES = 2
/** El embudo muestra lo decidido en los últimos 30 días. */
export const PIPELINE_DECIDED_DAYS = 30

/** La marca y el dominio de cada producto: un producto nuevo trae los suyos. */
const PRODUCT_BRAND: Record<ClinicalProduct, MailBrand> = {
  dental: "odentia",
  medical: "latidia",
  optical: "vistia",
}

const ZONE = { locale: "es-PE", timezone: "America/Lima" }

/* ---------- Guardas y lecturas comunes ---------- */

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function requireAdmin(actor: AdminActor): AdminActor {
  if (actor.role !== "admin") throw forbidden("Solo el rol Administración puede hacer esto")
  return actor
}

function productOf(value: string): ClinicalProduct {
  return isClinicalProduct(value) ? value : "dental"
}

type ClientRecord = typeof saasClient.$inferSelect

/** El cliente, bloqueado para escribir. Uno archivado no recibe cambios de venta. */
async function lockClient(tx: Db, id: string): Promise<ClientRecord> {
  if (!UUID.test(id)) throw notFound("Cliente")
  const [row] = await tx
    .select()
    .from(saasClient)
    .where(eq(saasClient.id, id))
    .limit(1)
    .for("update")
  if (!row) throw notFound("Cliente")
  if (row.archivedAt)
    throw new ServiceError(
      "CLIENT_ARCHIVED",
      409,
      "Ese cliente está archivado: sácalo del archivo para seguir",
    )
  return row
}

function isRealDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function requireDay(field: string, value: string | null | undefined, what: string): string {
  if (!value || !isRealDay(value)) throw invalidField(field, `Elige ${what}`)
  return value
}

function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10)
}

function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime())
  const day = out.getUTCDate()
  out.setUTCDate(1)
  out.setUTCMonth(out.getUTCMonth() + months)
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate()
  out.setUTCDate(Math.min(day, last))
  return out
}

function trimmed(
  field: string,
  value: string | null | undefined,
  maxLength: number,
  what: string,
): string {
  const text = (value ?? "").trim()
  if (!text) throw invalidField(field, `Escribe ${what}`)
  if (text.length > maxLength) throw invalidField(field, `Usa como máximo ${maxLength} caracteres`)
  return text
}

function optionalText(
  field: string,
  value: string | null | undefined,
  maxLength: number,
): string | null {
  const text = (value ?? "").trim()
  if (!text) return null
  if (text.length > maxLength) throw invalidField(field, `Usa como máximo ${maxLength} caracteres`)
  return text
}

async function contactOfClient(
  tx: Db,
  clientId: string,
  contactId: string | null | undefined,
  field = "contactId",
) {
  if (!contactId) return null
  if (!UUID.test(contactId)) throw invalidField(field, "Ese contacto no es de este cliente")
  const [row] = await tx
    .select()
    .from(saasClientContact)
    .where(and(eq(saasClientContact.id, contactId), eq(saasClientContact.clientId, clientId)))
    .limit(1)
  if (!row) throw invalidField(field, "Ese contacto no es de este cliente")
  return row
}

async function requireDemo(
  tx: Db,
  demoId: string | null | undefined,
  field = "demoId",
): Promise<string | null> {
  if (!demoId) return null
  if (!UUID.test(demoId)) throw invalidField(field, "Esa demo no existe")
  const [row] = await tx
    .select({ id: saasDemo.id })
    .from(saasDemo)
    .where(eq(saasDemo.id, demoId))
    .limit(1)
  if (!row) throw invalidField(field, "Esa demo no existe")
  return row.id
}

async function proposalOfClient(
  tx: Db,
  clientId: string,
  proposalId: string | null | undefined,
  field = "proposalId",
) {
  if (!proposalId) return null
  if (!UUID.test(proposalId)) throw invalidField(field, "Esa propuesta no es de este cliente")
  const [row] = await tx
    .select()
    .from(saasProposal)
    .where(and(eq(saasProposal.id, proposalId), eq(saasProposal.clientId, clientId)))
    .limit(1)
  if (!row) throw invalidField(field, "Esa propuesta no es de este cliente")
  return row
}

/** Una persona del personal activa: a quien se le asigna una tarea. */
async function requireActiveStaff(tx: Db, userId: string, field: string): Promise<string> {
  const [row] = await tx
    .select({ userId: adminStaff.userId })
    .from(adminStaff)
    .where(and(eq(adminStaff.userId, userId), eq(adminStaff.active, true)))
    .limit(1)
  if (!row) throw invalidField(field, "Esa persona no es del equipo de la administración")
  return row.userId
}

/** La solicitud más reciente del cliente (la que sigue la lista vieja), si tiene. */
async function latestRequestOf(tx: Db, clientId: string) {
  const [row] = await tx
    .select()
    .from(saasWaitlistRequest)
    .where(eq(saasWaitlistRequest.clientId, clientId))
    .orderBy(desc(saasWaitlistRequest.createdAt))
    .limit(1)
  return row ?? null
}

/** La solicitud viva del cliente (por revisar o invitada), si tiene. */
async function liveRequestOf(tx: Db, clientId: string) {
  const [row] = await tx
    .select()
    .from(saasWaitlistRequest)
    .where(
      and(
        eq(saasWaitlistRequest.clientId, clientId),
        inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"]),
      ),
    )
    .orderBy(desc(saasWaitlistRequest.createdAt))
    .limit(1)
    .for("update")
  return row ?? null
}

/* ---------- Actividades ---------- */

export interface ActivityInput {
  kind: SaasActivityKind
  /** `salio` (lo hicimos) o `entro` (nos buscó la clínica); una nota no lleva. */
  direction?: SaasActivityDirection | null
  body: string
  outcome?: string | null
  contactId?: string | null
  demoId?: string | null
  proposalId?: string | null
  happenedAt?: Date | null
  /** Solo la ve Administración. Lo que anota Soporte nunca lo es. */
  adminOnly?: boolean
}

export interface ActivityRow {
  id: string
  clientId: string
  kind: SaasActivityKind
  direction: SaasActivityDirection | null
  body: string
  outcome: string | null
  contactId: string | null
  demoId: string | null
  proposalId: string | null
  happenedAt: Date
  adminOnly: boolean
  byKairos: boolean
  authorUserId: string | null
  createdAt: Date
}

function activityRowOf(row: typeof saasFollowUp.$inferSelect): ActivityRow {
  return {
    id: row.id,
    clientId: row.clientId ?? "",
    kind: row.kind as SaasActivityKind,
    direction: (row.direction as SaasActivityDirection | null) ?? null,
    body: row.body,
    outcome: row.outcome,
    contactId: row.contactId,
    demoId: row.demoId,
    proposalId: row.proposalId,
    happenedAt: row.happenedAt,
    adminOnly: row.adminOnly,
    byKairos: row.byKairos,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt,
  }
}

async function insertActivity(
  tx: Db,
  actor: AdminActor | null,
  client: ClientRecord,
  input: ActivityInput,
  now: Date,
): Promise<ActivityRow> {
  if (!(SAAS_ACTIVITY_KINDS as readonly string[]).includes(input.kind))
    throw invalidField("kind", "Elige qué fue")
  const direction = input.kind === "nota" ? null : (input.direction ?? null)
  if (direction !== null && !(SAAS_ACTIVITY_DIRECTIONS as readonly string[]).includes(direction))
    throw invalidField("direction", "Elige si salió de nosotros o entró de la clínica")
  const body = trimmed("body", input.body, 2000, "qué pasó")
  const outcome = optionalText("outcome", input.outcome, 500)
  const happenedAt = input.happenedAt ?? now
  if (Number.isNaN(happenedAt.getTime())) throw invalidField("happenedAt", "Elige cuándo pasó")
  if (happenedAt.getTime() > now.getTime() + CLOCK_SKEW_MS)
    throw invalidField("happenedAt", "Lo que se anota ya pasó: elige una fecha de hoy o antes")
  const contact = await contactOfClient(tx, client.id, input.contactId)
  const demoId = await requireDemo(tx, input.demoId)
  const proposal = await proposalOfClient(tx, client.id, input.proposalId)
  // Lo que anota Soporte nunca es «Solo administración»; Kairós tampoco lo decide.
  const adminOnly = actor?.role === "admin" ? Boolean(input.adminOnly) : false
  // Con solicitud, la entrada también es de ella: la lista vieja la sigue viendo.
  const request = await latestRequestOf(tx, client.id)
  const [row] = await tx
    .insert(saasFollowUp)
    .values({
      clientId: client.id,
      requestId: request?.id ?? null,
      authorUserId: actor?.userId ?? null,
      body,
      kind: input.kind,
      direction,
      outcome,
      contactId: contact?.id ?? null,
      demoId,
      proposalId: proposal?.id ?? null,
      happenedAt,
      adminOnly,
      byKairos: actor === null,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo anotar la actividad")
  await writeAdminAudit(tx, actor, {
    action: actor ? "arm.activity_added" : "kairos.activity_added",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { activityId: row.id, kind: input.kind },
  })
  return activityRowOf(row)
}

/**
 * Anota lo que pasó con un cliente: una llamada, un WhatsApp, una reunión, una
 * nota… Queda en su bitácora, que solo se agrega. `actor` nulo es Kairós
 * (por ejemplo, un correo que entró de la clínica).
 */
export async function addActivity(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  input: ActivityInput,
  now = new Date(),
): Promise<ActivityRow> {
  const client = await lockClient(tx, clientId)
  return insertActivity(tx, actor, client, input, now)
}

/* ---------- Tareas ---------- */

export interface TaskInput {
  kind: SaasTaskKind
  title: string
  /** Día civil de Lima. */
  dueOn: string
  dueAt?: Date | null
  /** Por defecto, el responsable del cliente o quien la pone. */
  assigneeUserId?: string | null
  contactId?: string | null
  demoId?: string | null
}

export interface TaskRow {
  id: string
  clientId: string
  clientName: string
  product: ClinicalProduct
  kind: SaasTaskKind
  title: string
  dueOn: string
  dueAt: Date | null
  overdue: boolean
  assignee: { userId: string; name: string } | null
  contactId: string | null
  demoId: string | null
  status: SaasTaskStatus
  byKairos: boolean
  doneAt: Date | null
  doneNote: string | null
  createdAt: Date
}

async function insertTask(
  tx: Db,
  actor: AdminActor,
  client: ClientRecord,
  input: TaskInput,
  now: Date,
): Promise<string> {
  if (!(SAAS_TASK_KINDS as readonly string[]).includes(input.kind))
    throw invalidField("kind", "Elige qué hay que hacer")
  if (!seesTaskKind(actor, input.kind))
    throw invalidField("kind", "Las tareas de cobro las pone la administración")
  const title = trimmed("title", input.title, 200, "la tarea")
  const dueOn = requireDay("dueOn", input.dueOn, "el día")
  if (input.dueAt && Number.isNaN(input.dueAt.getTime()))
    throw invalidField("dueAt", "Elige la hora")
  if (input.dueAt && limaDate(input.dueAt) !== dueOn)
    throw invalidField("dueAt", "La hora tiene que ser del mismo día")
  const assignee = input.assigneeUserId
    ? await requireActiveStaff(tx, input.assigneeUserId, "assigneeUserId")
    : (client.ownerUserId ?? actor.userId)
  const contact = await contactOfClient(tx, client.id, input.contactId)
  const demoId = await requireDemo(tx, input.demoId)
  const [row] = await tx
    .insert(saasTask)
    .values({
      clientId: client.id,
      kind: input.kind,
      title,
      dueOn,
      dueAt: input.dueAt ?? null,
      assigneeUserId: assignee,
      contactId: contact?.id ?? null,
      demoId,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasTask.id })
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la tarea")
  await writeAdminAudit(tx, actor, {
    action: "arm.task_created",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { taskId: row.id, kind: input.kind },
  })
  return row.id
}

/** Pone una tarea para un cliente. Soporte también. */
export async function createClientTask(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: TaskInput,
  now = new Date(),
): Promise<TaskRow> {
  const client = await lockClient(tx, clientId)
  const id = await insertTask(tx, actor, client, input, now)
  return getClientTask(tx, id, now)
}

async function lockTask(tx: Db, actor: AdminActor, id: string) {
  if (!UUID.test(id)) throw notFound("Tarea")
  const [row] = await tx.select().from(saasTask).where(eq(saasTask.id, id)).limit(1).for("update")
  // Una tarea de cobro, para Soporte, no existe: la misma respuesta que una que no hay.
  if (!row || !seesTaskKind(actor, row.kind)) throw notFound("Tarea")
  return row
}

function requireOpenTask(task: typeof saasTask.$inferSelect): void {
  if (task.status !== "abierta")
    throw new ServiceError(
      "TASK_CLOSED",
      409,
      task.status === "hecha" ? "Esa tarea ya está hecha" : "Esa tarea está cancelada",
    )
}

const assigneeUser = sql<
  string | null
>`(select u.name from "user" u where u.id = ${saasTask.assigneeUserId})`

function taskFields() {
  return {
    task: saasTask,
    clientName: saasClient.name,
    product: saasClient.product,
    assigneeName: assigneeUser,
  }
}

function taskRowOf(
  row: {
    task: typeof saasTask.$inferSelect
    clientName: string
    product: string
    assigneeName: string | null
  },
  now: Date,
): TaskRow {
  const { task } = row
  return {
    id: task.id,
    clientId: task.clientId,
    clientName: row.clientName,
    product: productOf(row.product),
    kind: task.kind as SaasTaskKind,
    title: task.title,
    dueOn: task.dueOn,
    dueAt: task.dueAt,
    overdue: taskOverdue(task, now),
    assignee: task.assigneeUserId
      ? { userId: task.assigneeUserId, name: row.assigneeName ?? "" }
      : null,
    contactId: task.contactId,
    demoId: task.demoId,
    status: task.status as SaasTaskStatus,
    byKairos: task.byKairos,
    doneAt: task.doneAt,
    doneNote: task.doneNote,
    createdAt: task.createdAt,
  }
}

export async function getClientTask(tx: Db, id: string, now = new Date()): Promise<TaskRow> {
  if (!UUID.test(id)) throw notFound("Tarea")
  const [row] = await tx
    .select(taskFields())
    .from(saasTask)
    .innerJoin(saasClient, eq(saasClient.id, saasTask.clientId))
    .where(eq(saasTask.id, id))
    .limit(1)
  if (!row) throw notFound("Tarea")
  return taskRowOf(row, now)
}

/**
 * Da la tarea por hecha. Con `activity`, deja además lo que pasó en la
 * bitácora del cliente (la llamada, el mensaje…); sin ella, la tarea hecha ya
 * sale en el historial.
 */
export async function completeClientTask(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: { note?: string | null; activity?: ActivityInput | null } = {},
  now = new Date(),
): Promise<{ task: TaskRow; activity: ActivityRow | null }> {
  const task = await lockTask(tx, actor, id)
  requireOpenTask(task)
  const client = await lockClient(tx, task.clientId)
  const note = optionalText("note", input.note, 2000)
  const activity = input.activity
    ? await insertActivity(
        tx,
        actor,
        client,
        { contactId: task.contactId, demoId: task.demoId, ...input.activity },
        now,
      )
    : null
  await tx
    .update(saasTask)
    .set({ status: "hecha", doneAt: now, doneBy: actor.userId, doneNote: note, updatedAt: now })
    .where(eq(saasTask.id, id))
  await writeAdminAudit(tx, actor, {
    action: "arm.task_done",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { taskId: id, activityId: activity?.id ?? null },
  })
  return { task: await getClientTask(tx, id, now), activity }
}

export async function cancelClientTask(
  tx: Db,
  actor: AdminActor,
  id: string,
  now = new Date(),
): Promise<TaskRow> {
  const task = await lockTask(tx, actor, id)
  requireOpenTask(task)
  await tx
    .update(saasTask)
    .set({ status: "cancelada", doneAt: now, doneBy: actor.userId, updatedAt: now })
    .where(eq(saasTask.id, id))
  const [client] = await tx
    .select({ organizationId: saasClient.organizationId })
    .from(saasClient)
    .where(eq(saasClient.id, task.clientId))
  await writeAdminAudit(tx, actor, {
    action: "arm.task_cancelled",
    organizationId: client?.organizationId ?? null,
    entityId: task.clientId,
    metadata: { taskId: id },
  })
  return getClientTask(tx, id, now)
}

/** Cambia el día (y la hora) de una tarea abierta. */
export async function moveClientTask(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: { dueOn: string; dueAt?: Date | null },
  now = new Date(),
): Promise<TaskRow> {
  const task = await lockTask(tx, actor, id)
  requireOpenTask(task)
  const dueOn = requireDay("dueOn", input.dueOn, "el día")
  if (input.dueAt && (Number.isNaN(input.dueAt.getTime()) || limaDate(input.dueAt) !== dueOn))
    throw invalidField("dueAt", "La hora tiene que ser del mismo día")
  await tx
    .update(saasTask)
    .set({ dueOn, dueAt: input.dueAt ?? null, updatedAt: now })
    .where(eq(saasTask.id, id))
  await writeAdminAudit(tx, actor, {
    action: "arm.task_moved",
    entityId: task.clientId,
    metadata: { taskId: id, dueOn },
  })
  return getClientTask(tx, id, now)
}

export interface TaskFilter {
  /** `mias`: las asignadas a quien mira. */
  who?: "mias" | "todas"
  status?: SaasTaskStatus
  clientId?: string
  /** Hasta este día de Lima (incluido): «hoy y vencidas» es `dueBy = hoy`. */
  dueBy?: string
}

/** Las tareas, por día (lo vencido primero) y hora. Sin clientes archivados. */
export async function listClientTasks(
  tx: Db,
  actor: AdminActor,
  filter: TaskFilter = {},
  now = new Date(),
): Promise<TaskRow[]> {
  const where: SQL[] = [
    eq(saasTask.status, filter.status ?? "abierta"),
    isNull(saasClient.archivedAt),
  ]
  if (filter.who === "mias") where.push(eq(saasTask.assigneeUserId, actor.userId))
  const visible = visibleTaskSql(actor)
  if (visible) where.push(visible)
  if (filter.clientId) {
    if (!UUID.test(filter.clientId)) return []
    where.push(eq(saasTask.clientId, filter.clientId))
  }
  if (filter.dueBy) where.push(lte(saasTask.dueOn, requireDay("dueBy", filter.dueBy, "el día")))
  const rows = await tx
    .select(taskFields())
    .from(saasTask)
    .innerJoin(saasClient, eq(saasClient.id, saasTask.clientId))
    .where(and(...where))
    .orderBy(asc(saasTask.dueOn), sql`${saasTask.dueAt} asc nulls last`, asc(saasTask.createdAt))
    .limit(500)
  return rows.map((row) => taskRowOf(row, now))
}

/* ---------- Oportunidad y decisión ---------- */

export interface OpportunityRow {
  id: string
  clientId: string
  seller: { id: string; name: string } | null
  expectedOn: string | null
  decision: SaasOpportunityDecision | null
  reason: SaasLostReason | null
  reasonWords: string | null
  reasonDetail: string | null
  returnOn: string | null
  decidedAt: Date | null
  createdAt: Date
}

async function opportunityRow(tx: Db, id: string): Promise<OpportunityRow> {
  const [row] = await tx
    .select({ opp: saasOpportunity, sellerName: saasSeller.displayName })
    .from(saasOpportunity)
    .leftJoin(saasSeller, eq(saasSeller.id, saasOpportunity.sellerId))
    .where(eq(saasOpportunity.id, id))
    .limit(1)
  if (!row) throw notFound("Oportunidad")
  const { opp } = row
  const reason = (opp.reason as SaasLostReason | null) ?? null
  return {
    id: opp.id,
    clientId: opp.clientId,
    seller: opp.sellerId ? { id: opp.sellerId, name: row.sellerName ?? "" } : null,
    expectedOn: opp.expectedOn,
    decision: (opp.decision as SaasOpportunityDecision | null) ?? null,
    reason,
    reasonWords: reason ? LOST_REASON_WORDS[reason] : null,
    reasonDetail: opp.reasonDetail,
    returnOn: opp.returnOn,
    decidedAt: opp.decidedAt,
    createdAt: opp.createdAt,
  }
}

/**
 * La oportunidad abierta del cliente; si no tiene, la abre. Una sola abierta
 * por cliente (`saas_opportunity_open_uidx`): dos a la vez no abren dos.
 * `actor` nulo es el sistema o Kairós.
 */
export async function ensureOpenOpportunity(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  now = new Date(),
): Promise<string> {
  const open = async () => {
    const [row] = await tx
      .select({ id: saasOpportunity.id })
      .from(saasOpportunity)
      .where(and(eq(saasOpportunity.clientId, clientId), isNull(saasOpportunity.decision)))
      .limit(1)
    return row?.id ?? null
  }
  const found = await open()
  if (found) return found
  const [created] = await tx
    .insert(saasOpportunity)
    .values({ clientId, createdBy: actor?.userId ?? null, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: saasOpportunity.id })
  const id = created?.id ?? (await open())
  if (!id) throw new ServiceError("INTERNAL", 500, "No se pudo abrir la oportunidad")
  if (created) {
    await writeAdminAudit(tx, actor, {
      action: actor ? "arm.opportunity_opened" : "kairos.opportunity_opened",
      entityId: clientId,
      metadata: { opportunityId: id },
    })
  }
  return id
}

/** El vendedor y la fecha esperada de la venta abierta. Solo Administración. */
export async function setOpportunity(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: { sellerId?: string | null; expectedOn?: string | null },
  now = new Date(),
): Promise<OpportunityRow> {
  requireAdmin(actor)
  const client = await lockClient(tx, clientId)
  // Una clínica que ya entró no tiene venta que cambiar: abrirle una haría que Kairós la siguiera.
  if (client.organizationId)
    throw new ServiceError("CLIENT_HAS_ACCOUNT", 409, "Ese cliente ya tiene su cuenta")
  const id = await ensureOpenOpportunity(tx, actor, clientId, now)
  const patch: Partial<typeof saasOpportunity.$inferInsert> = { updatedAt: now }
  if (input.sellerId !== undefined) {
    if (input.sellerId === null) patch.sellerId = null
    else {
      if (!UUID.test(input.sellerId)) throw invalidField("sellerId", "Ese vendedor no existe")
      const [seller] = await tx
        .select({ id: saasSeller.id, active: saasSeller.isActive })
        .from(saasSeller)
        .where(eq(saasSeller.id, input.sellerId))
        .limit(1)
      if (!seller) throw invalidField("sellerId", "Ese vendedor no existe")
      if (!seller.active) throw invalidField("sellerId", "Ese vendedor ya no está activo")
      patch.sellerId = seller.id
    }
  }
  if (input.expectedOn !== undefined) {
    patch.expectedOn =
      input.expectedOn === null
        ? null
        : requireDay("expectedOn", input.expectedOn, "la fecha esperada")
  }
  await tx.update(saasOpportunity).set(patch).where(eq(saasOpportunity.id, id))
  await writeAdminAudit(tx, actor, {
    action: "arm.opportunity_set",
    entityId: clientId,
    metadata: { opportunityId: id, sellerId: patch.sellerId, expectedOn: patch.expectedOn },
  })
  return opportunityRow(tx, id)
}

/** Las tareas de venta que se cierran al decidir: un cliente perdido no deja «Llamar hoy». */
const SALE_TASK_KINDS: SaasTaskKind[] = ["llamar", "escribir", "presentacion", "propuesta"]

export interface DecideInput {
  decision: "no_por_ahora" | "perdido"
  reason: SaasLostReason
  reasonDetail?: string | null
  /** «No por ahora»: el día de Lima en que hay que volver. */
  returnOn?: string | null
}

export interface DecideResult {
  opportunity: OpportunityRow
  /** La solicitud de la web que se descartó al perderla, si tenía una viva. */
  discardedRequestId: string | null
  cancelledTasks: number
}

/**
 * «No por ahora» (con motivo y día para volver) o «Perdido» (con motivo y
 * nota). Solo Administración. Perder un cliente con su solicitud de la web
 * viva la descarta con la misma operación de la lista de espera
 * (`discardWaitlistRequest`), que anula su invitación si la tenía.
 */
export async function decide(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: DecideInput,
  now = new Date(),
): Promise<DecideResult> {
  requireAdmin(actor)
  const client = await lockClient(tx, clientId)
  if (input.decision !== "no_por_ahora" && input.decision !== "perdido")
    throw invalidField("decision", "Elige «No por ahora» o «Perdido»")
  if (!(SAAS_LOST_REASONS as readonly string[]).includes(input.reason))
    throw invalidField("reason", "Elige el motivo")
  const reasonDetail = optionalText("reasonDetail", input.reasonDetail, 500)
  const today = limaDate(now)
  let returnOn: string | null = null
  if (input.decision === "no_por_ahora") {
    returnOn = requireDay("returnOn", input.returnOn, "el día para volver")
    if (returnOn <= today)
      throw invalidField("returnOn", "El día para volver tiene que ser después de hoy")
  }
  if (client.organizationId)
    throw new ServiceError(
      "CLIENT_HAS_ACCOUNT",
      409,
      "Ese cliente ya tiene su cuenta: la venta ya se cerró",
    )
  let discardedRequestId: string | null = null
  if (input.decision === "perdido") {
    const live = await liveRequestOf(tx, client.id)
    if (live) {
      const words = LOST_REASON_WORDS[input.reason]
      await discardWaitlistRequest(
        tx,
        actor,
        live.id,
        (reasonDetail ? `${words}: ${reasonDetail}` : words).slice(0, 500),
      )
      discardedRequestId = live.id
    }
  }
  const id = await ensureOpenOpportunity(tx, actor, client.id, now)
  await tx
    .update(saasOpportunity)
    .set({
      decision: input.decision,
      reason: input.reason,
      reasonDetail,
      returnOn,
      decidedBy: actor.userId,
      decidedAt: now,
      updatedAt: now,
    })
    .where(eq(saasOpportunity.id, id))
  const cancelled = await tx
    .update(saasTask)
    .set({ status: "cancelada", doneAt: now, doneBy: actor.userId, updatedAt: now })
    .where(
      and(
        eq(saasTask.clientId, client.id),
        eq(saasTask.status, "abierta"),
        inArray(saasTask.kind, SALE_TASK_KINDS),
      ),
    )
    .returning({ id: saasTask.id })
  await writeAdminAudit(tx, actor, {
    action: input.decision === "perdido" ? "arm.opportunity_lost" : "arm.opportunity_later",
    entityId: client.id,
    metadata: {
      opportunityId: id,
      reason: input.reason,
      returnOn,
      cancelledTasks: cancelled.length,
    },
  })
  return {
    opportunity: await opportunityRow(tx, id),
    discardedRequestId,
    cancelledTasks: cancelled.length,
  }
}

/** Vuelve a abrir la venta de un cliente decidido: lo anterior queda como historia. Solo Administración. */
export async function reopenClientOpportunity(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  now = new Date(),
): Promise<OpportunityRow> {
  requireAdmin(actor)
  const client = await lockClient(tx, clientId)
  if (client.organizationId)
    throw new ServiceError("CLIENT_HAS_ACCOUNT", 409, "Ese cliente ya tiene su cuenta")
  return opportunityRow(tx, await ensureOpenOpportunity(tx, actor, client.id, now))
}

/**
 * La clínica entró: la oportunidad abierta se cierra como `entro` (o se deja
 * una cerrada así, si no había). La llaman la entrada por invitación y el alta
 * asistida, en su misma transacción. `actor` nulo es el sistema.
 */
export async function markOpportunityEntered(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
  now = new Date(),
): Promise<string> {
  const id = await closeClientSaleAsEntered(tx, clientId, actor, now)
  await writeAdminAudit(tx, actor, {
    action: "arm.opportunity_entered",
    entityId: clientId,
    metadata: { opportunityId: id },
  })
  return id
}

/* ---------- Invitar ---------- */

export interface InviteClientInput {
  email: string
  planId?: string | null
  /** La propuesta aceptada cuyas condiciones rigen al entrar. */
  proposalId?: string | null
  /** Lo que falta si el cliente no tiene solicitud (la solicitud los pide todos). */
  firstName?: string | null
  lastName?: string | null
  phone?: string | null
  city?: string | null
  professionals?: (typeof SAAS_CLIENT_PROFESSIONALS)[number] | null
  currentTool?: (typeof SAAS_CLIENT_TOOLS)[number] | null
}

export interface InviteClientResult {
  requestId: string
  /** El enlace se arma con el token; solo se muestra esta vez. */
  token: string
  expiresAt: Date
  email: string
  planId: string
  proposalId: string | null
  /** Se creó la solicitud desde la administración (no había una viva). */
  createdRequest: boolean
}

/** La acción de auditoría que guarda con qué propuesta se invitó: la lee la entrada. */
export const CLIENT_INVITED_ACTION = "arm.client_invited"

/** Parte un nombre en nombre y apellidos para la solicitud; sin apellidos, null. */
function splitName(name: string): { firstName: string; lastName: string | null } {
  const parts = name.trim().split(/\s+/)
  const firstName = parts.shift() ?? ""
  return { firstName, lastName: parts.length ? parts.join(" ") : null }
}

/**
 * Invita a un cliente a abrir su cuenta. Solo Administración. Usa la única
 * operación de invitar (`inviteFromWaitlist`): si el cliente no tiene una
 * solicitud viva, se crea una (`source = 'administracion'`) con sus datos y
 * lo que falte del cuerpo. Con una propuesta aceptada, la invitación lleva su
 * plan y sus condiciones se aplican al entrar (`applyInvitedProposal`).
 */
export async function inviteClient(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: InviteClientInput,
  now = new Date(),
): Promise<InviteClientResult> {
  requireAdmin(actor)
  const client = await lockClient(tx, clientId)
  if (client.organizationId)
    throw new ServiceError("CLIENT_HAS_ACCOUNT", 409, "Ese cliente ya tiene su cuenta")
  const email = (input.email ?? "").trim().toLowerCase()
  if (!EMAIL.test(email) || email.length > 254)
    throw invalidField("email", "Escribe un correo válido, como nombre@clinica.com")

  let proposal: typeof saasProposal.$inferSelect | null = null
  if (input.proposalId) {
    proposal = await proposalOfClient(tx, client.id, input.proposalId)
    if (proposal?.status !== "aceptada")
      throw invalidField("proposalId", "Solo se invita con una propuesta aceptada")
    if (!(await proposalInOpenSale(tx, proposal.id)))
      throw invalidField(
        "proposalId",
        "Esa propuesta es de una venta anterior: invita con la de esta venta o sin propuesta",
      )
    if (input.planId && input.planId !== proposal.planId)
      throw invalidField("planId", "La invitación lleva el plan de la propuesta aceptada")
  }
  const planId = proposal?.planId ?? input.planId ?? undefined

  // El mismo cerrojo que la solicitud de la web: un correo, una solicitud viva.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`waitlist:${email}`}, 0))`)
  const [other] = await tx
    .select({ id: saasWaitlistRequest.id, clientId: saasWaitlistRequest.clientId })
    .from(saasWaitlistRequest)
    .where(
      and(
        eq(saasWaitlistRequest.email, email),
        inArray(saasWaitlistRequest.status, ["por_revisar", "invitada"]),
      ),
    )
    .limit(1)
  if (other && other.clientId !== client.id) {
    throw new ServiceError(
      "WAITLIST_EMAIL_IN_USE",
      409,
      "Ese correo ya tiene una solicitud viva de otro cliente: ábrela o fusiona los dos",
      {
        email: "Ese correo ya tiene una solicitud viva de otro cliente",
      },
    )
  }

  let live = await liveRequestOf(tx, client.id)
  let createdRequest = false
  if (live && live.email !== email) {
    // Invitar a otro correo: la invitación es de un solo correo, así que la solicitud pasa a él.
    if (live.claimedAt)
      throw new ServiceError(
        "WAITLIST_IN_USE",
        409,
        "La invitación se está usando en este momento: intenta en un minuto",
      )
    await tx
      .update(saasWaitlistRequest)
      .set({ email, updatedAt: now })
      .where(eq(saasWaitlistRequest.id, live.id))
    live = { ...live, email }
  }
  if (!live) {
    const primary = await primaryContactOf(tx, client.id)
    const named = splitName(primary?.name ?? "")
    const firstName = (input.firstName ?? named.firstName).trim()
    const lastName = (input.lastName ?? named.lastName ?? "").trim()
    const phone = (input.phone ?? primary?.phone ?? "").trim().replace(/[ ()-]/g, "")
    const city = (input.city ?? client.city ?? "").trim()
    const professionals = input.professionals ?? client.professionals
    const currentTool = input.currentTool ?? client.currentTool
    const missing: Record<string, string> = {}
    if (!firstName || firstName.length > 80) missing.firstName = "Escribe el nombre de quien entra"
    if (!lastName || lastName.length > 80) missing.lastName = "Escribe sus apellidos"
    if (!E164.test(phone))
      missing.phone = "Escribe su celular con el código del país, como +51987654321"
    if (!city || city.length > 80) missing.city = "Escribe la ciudad"
    if (!professionals || !(SAAS_CLIENT_PROFESSIONALS as readonly string[]).includes(professionals))
      missing.professionals = `Elige cuántos ${productWords(productOf(client.product)).clinician.many} atienden`
    if (!currentTool || !(SAAS_CLIENT_TOOLS as readonly string[]).includes(currentTool))
      missing.currentTool = "Elige qué usan hoy"
    const first = Object.values(missing)[0]
    if (first) throw validation(first, missing)
    const [created] = await tx
      .insert(saasWaitlistRequest)
      .values({
        firstName,
        lastName,
        email,
        phone,
        clinicName: client.name.slice(0, 120),
        countryCode: client.countryCode,
        city,
        professionals: professionals as string,
        currentTool: currentTool as string,
        product: client.product,
        clientId: client.id,
        source: "administracion",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (!created) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la solicitud")
    live = created
    createdRequest = true
    // Lo que se pidió para invitar también es del cliente, si no lo tenía.
    await tx
      .update(saasClient)
      .set({
        city: client.city ?? city,
        professionals: client.professionals ?? professionals,
        currentTool: client.currentTool ?? currentTool,
        updatedAt: now,
      })
      .where(eq(saasClient.id, client.id))
  }

  const issued = await inviteFromWaitlist(tx, actor, live.id, planId ? { planId } : {}, now)
  await ensureOpenOpportunity(tx, actor, client.id, now)
  await writeAdminAudit(tx, actor, {
    action: CLIENT_INVITED_ACTION,
    entityId: live.id,
    metadata: {
      clientId: client.id,
      proposalId: proposal?.id ?? null,
      planId: issued.request.planId,
      createdRequest,
    },
  })
  return {
    requestId: live.id,
    token: issued.token,
    expiresAt: issued.expiresAt,
    email,
    planId: issued.request.planId ?? planId ?? "",
    proposalId: proposal?.id ?? null,
    createdRequest,
  }
}

async function primaryContactOf(tx: Db, clientId: string) {
  const [row] = await tx
    .select()
    .from(saasClientContact)
    .where(eq(saasClientContact.clientId, clientId))
    .orderBy(desc(saasClientContact.isPrimary), asc(saasClientContact.createdAt))
    .limit(1)
  return row ?? null
}

/** La acción de auditoría que deja aplicada una propuesta: no se aplica dos veces. */
export const PROPOSAL_APPLIED_ACTION = "arm.proposal_applied"

export interface ProposalTermsOutcome {
  applied: boolean
  discount: NegotiationOutcome | null
  trial: NegotiationOutcome | null
  billingCycle: "mensual" | "quincenal" | null
}

/**
 * Aplica a la suscripción de la clínica las condiciones de su propuesta
 * aceptada, con las mismas operaciones de «Precio y prueba». Una vez por
 * propuesta y clínica. La suscripción tiene que estar en el plan de la
 * propuesta. Sin `actor` (la entrada la hace la clínica), las aplica a nombre
 * de quien aceptó la propuesta en Administración.
 */
export async function applyProposalTerms(
  tx: Db,
  actor: AdminActor | null,
  proposalId: string,
  orgId: string,
  now = new Date(),
): Promise<ProposalTermsOutcome> {
  if (!UUID.test(proposalId)) throw notFound("Propuesta")
  const [proposal] = await tx
    .select()
    .from(saasProposal)
    .where(eq(saasProposal.id, proposalId))
    .limit(1)
  if (!proposal) throw notFound("Propuesta")
  if (proposal.status !== "aceptada")
    throw new ServiceError("PROPOSAL_NOT_ACCEPTED", 409, "Esa propuesta no está aceptada")
  const [done] = await tx
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(
      and(
        eq(adminAudit.action, PROPOSAL_APPLIED_ACTION),
        eq(adminAudit.entityId, proposalId),
        eq(adminAudit.organizationId, orgId),
      ),
    )
    .limit(1)
  if (done) return { applied: false, discount: null, trial: null, billingCycle: null }
  const [sub] = await tx
    .select()
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  if (!sub) throw notFound("Suscripción")
  if (sub.planId !== proposal.planId)
    throw new ServiceError(
      "PROPOSAL_OTHER_PLAN",
      409,
      "La clínica está en otro plan que el de la propuesta: sus condiciones no se aplican solas",
    )
  const decidedBy = actor?.userId ?? proposal.decidedBy
  if (!decidedBy)
    throw new ServiceError("PROPOSAL_NOT_ACCEPTED", 409, "No se sabe quién aceptó la propuesta")
  // Quien aceptó la propuesta es de Administración (`decideSaasProposal`): sus condiciones ya se aprobaron.
  const by: AdminActor = actor ?? { userId: decidedBy, role: "admin" }
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, proposal.planId)).limit(1)
  if (!plan) throw notFound("Plan")
  // La clínica aceptó la cuota que dice la propuesta: si el plan cambió de precio o de moneda,
  // no se da por aplicada; Administración resuelve la cuota a mano.
  if (plan.priceCents !== proposal.listPriceCents || plan.currency !== proposal.currency)
    throw new ServiceError(
      "PROPOSAL_PRICE_CHANGED",
      409,
      `La cuota del plan ya no es la de la propuesta (${moneyText(proposal.currency, proposal.listPriceCents)}): sus condiciones no se aplican solas`,
    )
  const discount =
    proposal.discountBps > 0
      ? await setSaasDiscount(
          tx,
          by,
          orgId,
          {
            discountBps: proposal.discountBps,
            discountEndsAt: proposal.discountMonths
              ? addMonths(now, proposal.discountMonths)
              : null,
          },
          now,
        )
      : null
  const trial =
    proposal.trialDays !== null || proposal.trialCreditCents !== null
      ? await setSaasTrialTerms(tx, by, orgId, {
          trialDays: proposal.trialDays ?? plan.trialDays,
          trialCreditCents: proposal.trialCreditCents ?? plan.trialCreditCents,
        })
      : null
  let billingCycle: ProposalTermsOutcome["billingCycle"] = null
  if (proposal.billingCycle !== sub.billingCycle) {
    billingCycle = proposal.billingCycle as "mensual" | "quincenal"
    await setSaasBillingCycle(tx, by, orgId, billingCycle)
  }
  await writeAdminAudit(tx, actor, {
    action: PROPOSAL_APPLIED_ACTION,
    organizationId: orgId,
    entityId: proposalId,
    metadata: { clientId: proposal.clientId, version: proposal.version },
  })
  return { applied: true, discount, trial, billingCycle }
}

/**
 * Al entrar por invitación: si la invitación de esa solicitud se hizo con una
 * propuesta aceptada (`inviteClient`), aplica sus condiciones. La llama
 * `completeFounderInvitation`, después de dejar la suscripción en el plan de
 * la invitación y en su misma transacción. Sin propuesta, no hace nada.
 */
export async function applyInvitedProposal(
  tx: Db,
  requestId: string,
  orgId: string,
  now = new Date(),
): Promise<ProposalTermsOutcome | null> {
  const [invited] = await tx
    .select({ metadata: adminAudit.metadata })
    .from(adminAudit)
    .where(and(eq(adminAudit.action, CLIENT_INVITED_ACTION), eq(adminAudit.entityId, requestId)))
    .orderBy(desc(adminAudit.createdAt))
    .limit(1)
  const proposalId = invited?.metadata?.proposalId
  if (typeof proposalId !== "string") return null
  return applyProposalTerms(tx, null, proposalId, orgId, now)
}

/* ---------- Presentaciones ---------- */

/** Agenda una presentación: es una tarea `presentacion` con su día, hora, contacto y demo. */
export async function schedulePresentation(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: {
    dueOn: string
    dueAt?: Date | null
    contactId?: string | null
    demoId?: string | null
    assigneeUserId?: string | null
  },
  now = new Date(),
): Promise<TaskRow> {
  const client = await lockClient(tx, clientId)
  const id = await insertTask(
    tx,
    actor,
    client,
    { kind: "presentacion", title: "Presentación", ...input },
    now,
  )
  if (!client.organizationId) await ensureOpenOpportunity(tx, actor, client.id, now)
  return getClientTask(tx, id, now)
}

export const PRESENTATION_OUTCOMES = ["se_hizo", "no_se_conecto", "reprogramar"] as const
export type PresentationOutcome = (typeof PRESENTATION_OUTCOMES)[number]

/**
 * Cómo fue la presentación. «Se hizo» deja la actividad `presentacion` (la que
 * pone al cliente en «Presentación hecha») y cierra la tarea. «No se conectó»
 * y «Reprogramar» dejan una nota, no una presentación: con día nuevo la tarea
 * se mueve; «No se conectó» sin día nuevo la cancela.
 */
export async function recordPresentation(
  tx: Db,
  actor: AdminActor,
  taskId: string,
  input: {
    outcome: PresentationOutcome
    body: string
    nextDueOn?: string | null
    nextDueAt?: Date | null
  },
  now = new Date(),
): Promise<{ task: TaskRow; activity: ActivityRow }> {
  const task = await lockTask(tx, actor, taskId)
  if (task.kind !== "presentacion") throw notFound("Presentación")
  requireOpenTask(task)
  const client = await lockClient(tx, task.clientId)
  if (!(PRESENTATION_OUTCOMES as readonly string[]).includes(input.outcome))
    throw invalidField("outcome", "Elige cómo fue")
  const nextDueOn = input.nextDueOn
    ? requireDay("nextDueOn", input.nextDueOn, "el día nuevo")
    : null
  if (input.outcome === "reprogramar" && !nextDueOn)
    throw invalidField("nextDueOn", "Elige el día nuevo de la presentación")
  if (nextDueOn && nextDueOn < limaDate(now))
    throw invalidField("nextDueOn", "El día nuevo tiene que ser de hoy en adelante")
  if (
    input.nextDueAt &&
    (Number.isNaN(input.nextDueAt.getTime()) ||
      !nextDueOn ||
      limaDate(input.nextDueAt) !== nextDueOn)
  )
    throw invalidField("nextDueAt", "La hora tiene que ser del día nuevo")
  const base = { body: input.body, contactId: task.contactId, demoId: task.demoId }
  let activity: ActivityRow
  if (input.outcome === "se_hizo") {
    activity = await insertActivity(
      tx,
      actor,
      client,
      { ...base, kind: "presentacion", direction: "salio", outcome: "Se hizo" },
      now,
    )
    await tx
      .update(saasTask)
      .set({ status: "hecha", doneAt: now, doneBy: actor.userId, updatedAt: now })
      .where(eq(saasTask.id, taskId))
  } else {
    const words =
      input.outcome === "no_se_conecto"
        ? "La presentación no se hizo: no se conectó"
        : `La presentación se reprogramó para el ${dayWords(nextDueOn as string, ZONE)}`
    activity = await insertActivity(
      tx,
      actor,
      client,
      { ...base, kind: "nota", outcome: words },
      now,
    )
    if (nextDueOn) {
      await tx
        .update(saasTask)
        .set({ dueOn: nextDueOn, dueAt: input.nextDueAt ?? null, updatedAt: now })
        .where(eq(saasTask.id, taskId))
    } else {
      await tx
        .update(saasTask)
        .set({
          status: "cancelada",
          doneAt: now,
          doneBy: actor.userId,
          doneNote: words,
          updatedAt: now,
        })
        .where(eq(saasTask.id, taskId))
    }
  }
  await writeAdminAudit(tx, actor, {
    action: "arm.presentation_recorded",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { taskId, outcome: input.outcome, activityId: activity.id },
  })
  return { task: await getClientTask(tx, taskId, now), activity }
}

/* ---------- Propuestas ---------- */

export interface ProposalInput {
  planId: string
  /** Puntos básicos sobre el precio de cada acción: 1000 = 10 %. La cuota no tiene descuento. */
  discountBps: number
  /** Cuántos meses dura el descuento; sin él, mientras dure la suscripción. */
  discountMonths?: number | null
  trialDays?: number | null
  trialCreditCents?: number | null
  billingCycle: (typeof SAAS_PROPOSAL_BILLING_CYCLES)[number]
  /** Día de Lima hasta el que vale. */
  validUntil: string
}

/**
 * Lo que se ve de una propuesta. Se calculan al leer: `reemplazada` (enviada y
 * después salió una versión más nueva) y `vencida` (enviada y su vigencia ya pasó).
 */
export type ProposalDisplayStatus = SaasProposalStatus | "vencida" | "reemplazada"

export interface ProposalRow {
  id: string
  clientId: string
  opportunityId: string | null
  version: number
  plan: { id: string; name: string; priceCents: number; creditCents: number }
  listPriceCents: number
  currency: string
  discountBps: number
  discountMonths: number | null
  trialDays: number | null
  trialCreditCents: number | null
  billingCycle: "mensual" | "quincenal"
  validUntil: string
  status: SaasProposalStatus
  displayStatus: ProposalDisplayStatus
  /** La versión más nueva que salió después de esta (sin decidir): ya no se envía ni se acepta. */
  replacedBy: number | null
  /** De la venta abierta (`proposalOfOpenSaleSql`): la de una venta ya cerrada no cuenta para el alta. */
  currentSale: boolean
  sentAt: Date | null
  decidedAt: Date | null
  acceptedNote: string | null
  approvedAt: Date | null
  createdAt: Date
}

/**
 * «Reemplazada»: enviada y después salió una versión más nueva (`replacedBy`);
 * «vencida»: enviada y su último día ya pasó. El SQL gemelo es
 * `proposalReplacedBySql` y `proposalLiveSql` (`admin-clients.ts`).
 */
export function proposalDisplayStatus(
  row: { status: string; validUntil: string; replacedBy?: number | null },
  today: string,
): ProposalDisplayStatus {
  if (row.status === "enviada" && row.replacedBy != null) return "reemplazada"
  if (row.status === "enviada" && row.validUntil < today) return "vencida"
  return row.status as SaasProposalStatus
}

/** «Reemplazada por la v3»: lo que se dice de una propuesta que ya no vale porque salió otra. */
export const replacedWords = (version: number) => `Reemplazada por la v${version}`

/**
 * ¿Pide aprobación? Cuando el descuento o la prueba pasan de lo que da el
 * vendedor (lo del plan: `seller_discount_bps`, la prueba por defecto) y quien
 * la arma no es de Administración. Hoy solo Administración arma propuestas,
 * así que la regla queda escrita para cuando un vendedor las arme.
 */
export function proposalNeedsApproval(
  plan: Pick<typeof saasPlan.$inferSelect, "sellerDiscountBps" | "trialDays" | "trialCreditCents">,
  input: Pick<ProposalInput, "discountBps" | "trialDays" | "trialCreditCents">,
  role: AdminActor["role"],
): boolean {
  if (role === "admin") return false
  return (
    input.discountBps > plan.sellerDiscountBps ||
    (input.trialDays ?? 0) > plan.trialDays ||
    (input.trialCreditCents ?? 0) > plan.trialCreditCents
  )
}

function proposalRowOf(
  row: {
    proposal: typeof saasProposal.$inferSelect
    planName: string
    planPriceCents: number
    planCreditCents: number
    replacedBy: number | null
    currentSale: boolean
  },
  today: string,
): ProposalRow {
  const p = row.proposal
  // Una decidida no se reemplaza: queda como se decidió. Una sin enviar con otra más nueva ya
  // enviada tampoco sale (`prepareOutreach`), aunque se siga leyendo «Borrador».
  const replacedBy =
    p.status !== "aceptada" && p.status !== "no_aceptada" && row.replacedBy !== null
      ? Number(row.replacedBy)
      : null
  return {
    id: p.id,
    clientId: p.clientId,
    opportunityId: p.opportunityId,
    version: p.version,
    plan: {
      id: p.planId,
      name: row.planName,
      priceCents: row.planPriceCents,
      creditCents: row.planCreditCents,
    },
    listPriceCents: p.listPriceCents,
    currency: p.currency,
    discountBps: p.discountBps,
    discountMonths: p.discountMonths,
    trialDays: p.trialDays,
    trialCreditCents: p.trialCreditCents,
    billingCycle: p.billingCycle as "mensual" | "quincenal",
    validUntil: p.validUntil,
    status: p.status as SaasProposalStatus,
    displayStatus: proposalDisplayStatus({ ...p, replacedBy }, today),
    replacedBy,
    currentSale: Boolean(row.currentSale),
    sentAt: p.sentAt,
    decidedAt: p.decidedAt,
    acceptedNote: p.acceptedNote,
    approvedAt: p.approvedAt,
    createdAt: p.createdAt,
  }
}

const proposalFields = {
  proposal: saasProposal,
  planName: saasPlan.name,
  planPriceCents: saasPlan.priceCents,
  planCreditCents: saasPlan.creditCents,
  replacedBy: proposalReplacedBySql("saas_proposal"),
  currentSale: proposalOfOpenSaleSql("saas_proposal"),
}

/** ¿Salió después una versión más nueva de esta propuesta? Su número, o null (`proposalReplacedBySql`). */
async function newerSentVersion(tx: Db, proposal: { id: string }): Promise<number | null> {
  const [row] = await tx.execute(
    sql`select ${proposalReplacedBySql()} as version from admin.saas_proposal p where p.id = ${proposal.id}`,
  )
  const version = (row as { version: number | null } | undefined)?.version
  return version == null ? null : Number(version)
}

/** ¿Es de la venta abierta de su cliente (`proposalOfOpenSaleSql`)? */
async function proposalInOpenSale(tx: Db, id: string): Promise<boolean> {
  const [row] = await tx.execute(
    sql`select ${proposalOfOpenSaleSql()} as open from admin.saas_proposal p where p.id = ${id}`,
  )
  return Boolean((row as { open?: boolean } | undefined)?.open)
}

/**
 * La propuesta aceptada de la venta abierta del cliente, la última, o null:
 * la que toma el alta («Dar de alta yo»). La de una venta anterior no cuenta.
 */
export async function acceptedProposalOfOpenSale(
  tx: Db,
  clientId: string,
): Promise<{ id: string; planId: string; planCode: string } | null> {
  if (!UUID.test(clientId)) return null
  const [row] = await tx
    .select({ id: saasProposal.id, planId: saasProposal.planId, planCode: saasPlan.code })
    .from(saasProposal)
    .innerJoin(saasPlan, eq(saasPlan.id, saasProposal.planId))
    .where(
      and(
        eq(saasProposal.clientId, clientId),
        eq(saasProposal.status, "aceptada"),
        proposalOfOpenSaleSql("saas_proposal"),
      ),
    )
    .orderBy(desc(saasProposal.version))
    .limit(1)
  return row ?? null
}

export async function getSaasProposal(
  tx: Db,
  actor: AdminActor,
  id: string,
  now = new Date(),
): Promise<ProposalRow> {
  requireAdmin(actor)
  if (!UUID.test(id)) throw notFound("Propuesta")
  const [row] = await tx
    .select(proposalFields)
    .from(saasProposal)
    .innerJoin(saasPlan, eq(saasPlan.id, saasProposal.planId))
    .where(eq(saasProposal.id, id))
    .limit(1)
  if (!row) throw notFound("Propuesta")
  return proposalRowOf(row, limaDate(now))
}

/** Las propuestas de un cliente, de la más nueva a la primera. Solo Administración (llevan importes). */
export async function listSaasProposals(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  now = new Date(),
): Promise<ProposalRow[]> {
  requireAdmin(actor)
  if (!UUID.test(clientId)) throw notFound("Cliente")
  const rows = await tx
    .select(proposalFields)
    .from(saasProposal)
    .innerJoin(saasPlan, eq(saasPlan.id, saasProposal.planId))
    .where(eq(saasProposal.clientId, clientId))
    .orderBy(desc(saasProposal.version))
  const today = limaDate(now)
  return rows.map((row) => proposalRowOf(row, today))
}

/**
 * Arma una propuesta (versión siguiente del cliente) con el precio de lista
 * del plan, congelado. Solo Administración. El descuento no pasa del máximo
 * del plan (su precio mínimo) ni la prueba de su tope. Si pasa de lo que da el
 * vendedor y quien la arma no es de Administración, queda `por_aprobar`.
 */
export async function createSaasProposal(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: ProposalInput,
  now = new Date(),
): Promise<ProposalRow> {
  requireAdmin(actor)
  const client = await lockClient(tx, clientId)
  if (!input.planId || !UUID.test(input.planId)) throw invalidField("planId", "Elige el plan")
  const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, input.planId)).limit(1)
  if (!plan?.isActive) throw invalidField("planId", "Ese plan no está activo")
  const product = productOf(client.product)
  if (plan.product !== product)
    throw invalidField(
      "planId",
      `${plan.name} es de ${productWords(productOf(plan.product)).name}: este cliente es de ${productWords(product).name}`,
    )
  const errors: Record<string, string> = {}
  if (!Number.isInteger(input.discountBps) || input.discountBps < 0 || input.discountBps > 9000)
    errors.discountBps = "El descuento debe ser un porcentaje válido"
  else if (input.discountBps > plan.maxDiscountBps) {
    const message = `El descuento máximo es ${plan.maxDiscountBps / 100} %: con más, los precios quedarían bajo el precio mínimo`
    throw new ServiceError("SAAS_PRICE_BELOW_FLOOR", 409, message, { discountBps: message })
  }
  const discountMonths = input.discountBps > 0 ? (input.discountMonths ?? null) : null
  if (
    discountMonths !== null &&
    (!Number.isInteger(discountMonths) || discountMonths < 1 || discountMonths > 36)
  )
    errors.discountMonths = "El descuento dura de 1 a 36 meses"
  const trialDays = input.trialDays ?? null
  const trialCreditCents = input.trialCreditCents ?? null
  if (trialDays !== null && (!Number.isInteger(trialDays) || trialDays < 1))
    errors.trialDays = "La prueba debe durar al menos un día"
  else if (trialDays !== null && trialDays > plan.trialMaxDays)
    errors.trialDays = `La prueba puede llegar como mucho a ${plan.trialMaxDays} días`
  if (
    trialCreditCents !== null &&
    (!Number.isSafeInteger(trialCreditCents) || trialCreditCents < 0)
  )
    errors.trialCreditCents = "El saldo de prueba debe ser un importe válido"
  else if (trialCreditCents !== null && trialCreditCents > plan.trialMaxCreditCents)
    errors.trialCreditCents = `El saldo de prueba puede llegar como mucho a ${formatMoney(plan.trialMaxCreditCents, plan.currency, ZONE.locale)}`
  if (!(SAAS_PROPOSAL_BILLING_CYCLES as readonly string[]).includes(input.billingCycle))
    errors.billingCycle = "Elige cada cuánto se factura"
  const today = limaDate(now)
  if (!input.validUntil || !isRealDay(input.validUntil))
    errors.validUntil = "Elige hasta qué día vale"
  else if (input.validUntil < today)
    errors.validUntil = "La vigencia tiene que ser de hoy en adelante"
  else if (input.validUntil > addDays(today, 365))
    errors.validUntil = "La vigencia puede ser de un año como mucho"
  const first = Object.values(errors)[0]
  if (first) throw validation(first, errors)

  const opportunityId = client.organizationId
    ? null
    : await ensureOpenOpportunity(tx, actor, client.id, now)
  const [last] = await tx
    .select({ version: max(saasProposal.version) })
    .from(saasProposal)
    .where(eq(saasProposal.clientId, client.id))
  const version = (last?.version ?? 0) + 1
  const status: SaasProposalStatus = proposalNeedsApproval(
    plan,
    { ...input, trialDays, trialCreditCents },
    actor.role,
  )
    ? "por_aprobar"
    : "borrador"
  const [row] = await tx
    .insert(saasProposal)
    .values({
      clientId: client.id,
      opportunityId,
      version,
      planId: plan.id,
      listPriceCents: plan.priceCents,
      currency: plan.currency,
      discountBps: input.discountBps,
      discountMonths,
      trialDays,
      trialCreditCents,
      billingCycle: input.billingCycle,
      validUntil: input.validUntil,
      status,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: saasProposal.id })
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo guardar la propuesta")
  await writeAdminAudit(tx, actor, {
    action: "arm.proposal_created",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: {
      proposalId: row.id,
      version,
      planId: plan.id,
      discountBps: input.discountBps,
      status,
    },
  })
  return getSaasProposal(tx, actor, row.id, now)
}

async function lockProposal(tx: Db, id: string) {
  if (!UUID.test(id)) throw notFound("Propuesta")
  const [row] = await tx
    .select()
    .from(saasProposal)
    .where(eq(saasProposal.id, id))
    .limit(1)
    .for("update")
  if (!row) throw notFound("Propuesta")
  return row
}

/** Aprueba una propuesta que pasaba de lo que da el vendedor: queda lista para enviar. Solo Administración. */
export async function approveSaasProposal(
  tx: Db,
  actor: AdminActor,
  id: string,
  now = new Date(),
): Promise<ProposalRow> {
  requireAdmin(actor)
  const proposal = await lockProposal(tx, id)
  if (proposal.status !== "por_aprobar")
    throw new ServiceError("PROPOSAL_NOT_PENDING", 409, "Esa propuesta no espera aprobación")
  await tx
    .update(saasProposal)
    .set({ status: "borrador", approvedBy: actor.userId, approvedAt: now, updatedAt: now })
    .where(eq(saasProposal.id, id))
  await writeAdminAudit(tx, actor, {
    action: "arm.proposal_approved",
    entityId: proposal.clientId,
    metadata: { proposalId: id },
  })
  return getSaasProposal(tx, actor, id, now)
}

/**
 * La respuesta del cliente a una propuesta enviada: aceptada o no aceptada.
 * Solo Administración. Una vencida no se acepta: se hace una versión nueva.
 * Deja la actividad en la bitácora.
 */
export async function decideSaasProposal(
  tx: Db,
  actor: AdminActor,
  id: string,
  input: { accepted: boolean; note?: string | null },
  now = new Date(),
): Promise<ProposalRow> {
  requireAdmin(actor)
  const proposal = await lockProposal(tx, id)
  const client = await lockClient(tx, proposal.clientId)
  if (proposal.status !== "enviada") {
    throw new ServiceError(
      "PROPOSAL_NOT_SENT",
      409,
      proposal.status === "aceptada" || proposal.status === "no_aceptada"
        ? "Esa propuesta ya se decidió"
        : "Esa propuesta todavía no se envió",
    )
  }
  if (input.accepted) {
    // Aceptar una que otra versión ya reemplazó dejaría dos condiciones vivas.
    const newer = await newerSentVersion(tx, proposal)
    if (newer !== null)
      throw new ServiceError(
        "PROPOSAL_REPLACED",
        409,
        `${replacedWords(newer)}: la que vale es la v${newer}; marca la respuesta en esa`,
      )
  }
  if (input.accepted && proposal.validUntil < limaDate(now))
    throw new ServiceError(
      "PROPOSAL_EXPIRED",
      409,
      `Venció el ${dayWords(proposal.validUntil, ZONE)}: haz una versión nueva con otra vigencia`,
    )
  const note = optionalText("note", input.note, 1000)
  await tx
    .update(saasProposal)
    .set({
      status: input.accepted ? "aceptada" : "no_aceptada",
      decidedAt: now,
      decidedBy: actor.userId,
      acceptedNote: note,
      updatedAt: now,
    })
    .where(eq(saasProposal.id, id))
  await insertActivity(
    tx,
    actor,
    client,
    {
      kind: "propuesta",
      direction: "entro",
      body: `${input.accepted ? "Aceptó" : "No aceptó"} la propuesta v${proposal.version}${note ? `: ${note}` : ""}`.slice(
        0,
        2000,
      ),
      proposalId: id,
      adminOnly: false,
    },
    now,
  )
  await writeAdminAudit(tx, actor, {
    action: input.accepted ? "arm.proposal_accepted" : "arm.proposal_declined",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { proposalId: id, version: proposal.version },
  })
  return getSaasProposal(tx, actor, id, now)
}

/* ---------- La propuesta en PDF ---------- */

export interface ProposalPdf {
  bytes: Uint8Array
  pages: number
  filename: string
}

function percentWords(bps: number): string {
  return `${new Intl.NumberFormat(ZONE.locale, { maximumFractionDigits: 2 }).format(bps / 100)} %`
}

/**
 * La propuesta en PDF (A4, dos hojas como mucho) con la marca del producto y
 * el titular (Sallca) en el membrete, como el informe del alta. Cuenta las
 * condiciones tal como quedaron guardadas: no promete ni agrega nada.
 * `writeTo` es a dónde dice que puede escribirnos: la dirección de quien la
 * envía (la misma del remitente del correo); sin ella, hola@ de la marca.
 */
export async function proposalPdf(
  tx: Db,
  id: string,
  writeTo?: string | null,
): Promise<ProposalPdf> {
  if (!UUID.test(id)) throw notFound("Propuesta")
  const [row] = await tx
    .select({
      proposal: saasProposal,
      plan: saasPlan,
      clientName: saasClient.name,
      product: saasClient.product,
      authorName: sql<
        string | null
      >`(select u.name from "user" u where u.id = ${saasProposal.createdBy})`,
    })
    .from(saasProposal)
    .innerJoin(saasPlan, eq(saasPlan.id, saasProposal.planId))
    .innerJoin(saasClient, eq(saasClient.id, saasProposal.clientId))
    .where(eq(saasProposal.id, id))
    .limit(1)
  if (!row) throw notFound("Propuesta")
  const { proposal: p, plan } = row
  const product = productOf(row.product)
  const brand = PRODUCT_BRAND[product]
  const paper = brandPaper(brand)
  const domain = productMailDomain(product)
  const titular = CONSUMER_COMPLAINT_PROVIDER
  const contact = await primaryContactOf(tx, p.clientId)
  const money = (cents: number) => formatMoney(cents, p.currency, ZONE.locale)

  const sender: DocumentClinic = {
    tradeName: paper.name,
    legalName: titular.legalName,
    fiscalDocType: "RUC",
    fiscalDocNumber: titular.ruc,
    address: titular.address,
    phone: domain,
    branchName: null,
    logo: { bytes: paper.logoPng, kind: "png" },
    wordmark: true,
    brandInk: paper.color,
    locale: ZONE.locale,
    timezone: ZONE.timezone,
    sheetSize: "A4",
    receiptWidth: "80",
  }
  const title = `Propuesta N.º ${p.version} · ${plan.name}`
  const kit = await DocumentKit.open(sender, sheetFormat("A4"), {
    title,
    docLabel: `Propuesta N.º ${p.version}`,
    legalNote: `${paper.name} · ${domain} · ${titular.legalName} · RUC ${titular.ruc}`,
  })
  const body = { size: SIZE.dense, leading: 1.45 }
  const section = { before: 7, after: 1 }

  kit.gap(6)
  kit.text(`Lima, ${dayWords(p.createdAt, ZONE)}`, { ...body, align: "right" })
  kit.gap(6)
  if (contact?.name) kit.text({ text: contact.name, face: "sansSemi" }, { ...body, leading: 1.35 })
  kit.text(row.clientName, { ...body, leading: 1.35 })
  kit.gap(8)
  kit.heading(title, { size: SIZE.h2small, before: 0, after: 4 })
  kit.text(`Le compartimos las condiciones para que ${row.clientName} use ${paper.name}.`, body)

  const discount =
    p.discountBps > 0
      ? `${percentWords(p.discountBps)} sobre el precio de cada acción${p.discountMonths ? `, durante ${p.discountMonths} ${p.discountMonths === 1 ? "mes" : "meses"}` : ""}`
      : "Sin descuento"
  const trialDays = p.trialDays ?? plan.trialDays
  const trialCredit = p.trialCreditCents ?? plan.trialCreditCents
  kit.subheading("Condiciones", section)
  kit.facts(
    [
      { label: "Plan", value: plan.name, strong: true },
      { label: "Cuota mensual", value: money(p.listPriceCents), strong: true },
      { label: "Crédito incluido cada mes", value: money(plan.creditCents) },
      { label: "Descuento", value: discount },
      {
        label: "Prueba",
        value: `${trialDays} ${trialDays === 1 ? "día" : "días"}${trialCredit > 0 ? `, con ${money(trialCredit)} de saldo de regalo` : ""}`,
      },
      {
        label: "Facturación de lo que pasa del crédito",
        value: p.billingCycle === "quincenal" ? "Cada quince días" : "Cada mes",
      },
      { label: "Vale hasta", value: dayWords(p.validUntil, ZONE), span: 2 },
    ],
    2,
    { size: SIZE.dense },
  )

  kit.subheading("Cómo se cobra", section)
  kit.bullets(
    [
      `La cuota es de ${money(p.listPriceCents)} al mes e incluye ${money(plan.creditCents)} de crédito para los agentes.`,
      p.discountBps > 0
        ? `El descuento se aplica al precio de cada acción de los agentes; la cuota no tiene descuento.`
        : "Cada acción de los agentes se cuenta a su precio de lista.",
      `Lo que pase del crédito se factura ${p.billingCycle === "quincenal" ? "cada quince días" : "cada mes"}.`,
    ],
    body,
  )

  const signature = { ...body, leading: 1.35 }
  kit.gap(6)
  kit.ensure(3 * SIZE.dense * 1.45 + 3 * SIZE.dense * 1.35 + 28)
  kit.text(
    `Esta propuesta vale hasta el ${dayWords(p.validUntil, ZONE)}. Si tiene preguntas, puede escribirnos a ${writeTo || `hola@${domain}`}.`,
    body,
  )
  kit.gap(4)
  kit.text("Atentamente,", body)
  kit.gap(12)
  if (row.authorName) kit.text({ text: row.authorName, face: "sansSemi" }, signature)
  kit.text(paper.name, { ...signature, tone: "gray" })

  const bytes = await kit.finish()
  if (kit.pageCount > PROPOSAL_MAX_PAGES)
    throw new ServiceError(
      "PROPOSAL_TOO_LONG",
      500,
      `La propuesta salió de ${kit.pageCount} hojas: el máximo es ${PROPOSAL_MAX_PAGES}`,
    )
  const slug = row.clientName
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
  return {
    bytes,
    pages: kit.pageCount,
    filename: `propuesta-${p.version}-${slug || "cliente"}.pdf`,
  }
}

/* ---------- Envíos ---------- */

export interface OutreachInput {
  channel: SaasOutreachChannel
  /** El contacto del cliente: de él sale el número o el correo si no viene `to`. */
  contactId?: string | null
  to?: string | null
  subject?: string | null
  body: string
  proposalId?: string | null
  kairosItemId?: string | null
}

export interface OutreachRow {
  id: string
  /** Nulo solo en la respuesta a un correo que aún no es de ningún cliente. */
  clientId: string | null
  contactId: string | null
  channel: SaasOutreachChannel
  to: string
  subject: string | null
  body: string
  proposalId: string | null
  kairosItemId: string | null
  status: SaasOutreachStatus
  sentAt: Date | null
  resolvedAt: Date | null
  createdAt: Date
  /** WhatsApp: el enlace que abre el chat con el texto puesto. */
  whatsappUrl: string | null
  /** Correo: la dirección que firma («Desde»): la de quien escribe, soporte@ u hola@. */
  from: string | null
  /** El correo que responde, si es una respuesta. */
  inReplyToEmailId: string | null
}

/** El enlace de WhatsApp con el texto puesto: `https://wa.me/<número sin +>?text=<texto>`. */
export function whatsappLink(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(text)}`
}

function outreachRowOf(row: typeof saasOutreach.$inferSelect): OutreachRow {
  const channel = row.channel as SaasOutreachChannel
  return {
    id: row.id,
    clientId: row.clientId,
    contactId: row.contactId,
    channel,
    to: row.toAddress,
    subject: row.subject,
    body: row.body,
    proposalId: row.proposalId,
    kairosItemId: row.kairosItemId,
    status: row.status as SaasOutreachStatus,
    sentAt: row.sentAt,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    whatsappUrl: channel === "whatsapp" ? whatsappLink(row.toAddress, row.body) : null,
    from: row.fromAddress,
    inReplyToEmailId: row.inReplyToEmailId,
  }
}

/** Nuestro `Message-ID`: único, con el dominio de la marca que firma. */
function newMessageId(product: ClinicalProduct): string {
  return `<${randomUUID()}@${productMailDomain(product)}>`
}

/**
 * La propuesta que se puede enviar a un cliente: lista (no por aprobar),
 * vigente, sin decidir y la última que salió. Solo la envía Administración.
 */
async function sendableProposal(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  proposalId: string,
  now: Date,
): Promise<string> {
  if (actor.role !== "admin") throw forbidden("Solo el rol Administración envía propuestas")
  const proposal = await proposalOfClient(tx, clientId, proposalId)
  if (!proposal) throw invalidField("proposalId", "Esa propuesta no es de este cliente")
  if (proposal.status === "por_aprobar")
    throw new ServiceError(
      "PROPOSAL_NEEDS_APPROVAL",
      409,
      "Esa propuesta espera aprobación de Administración",
    )
  if (proposal.status === "aceptada" || proposal.status === "no_aceptada")
    throw new ServiceError("PROPOSAL_DECIDED", 409, "Esa propuesta ya se decidió")
  const newer = await newerSentVersion(tx, proposal)
  if (newer !== null)
    throw new ServiceError(
      "PROPOSAL_REPLACED",
      409,
      `Ya salió la v${newer}: envía esa o haz una versión nueva`,
    )
  if (proposal.validUntil < limaDate(now))
    throw new ServiceError(
      "PROPOSAL_EXPIRED",
      409,
      `Venció el ${dayWords(proposal.validUntil, ZONE)}: haz una versión nueva con otra vigencia`,
    )
  return proposal.id
}

/**
 * Prepara un envío a un cliente: queda `pendiente`. El correo lo envía la
 * ruta después del commit (`outreachEmail`) y lo marca con `markOutreachSent`;
 * el de WhatsApp se abre por su enlace y lo resuelve una persona
 * (`resolveOutreach`). Una propuesta solo se envía lista (no por aprobar),
 * vigente y sin decidir. Soporte escribe, pero no envía propuestas. El correo
 * sale con el nombre y la dirección de quien escribe (o desde hola@ si aún no
 * tiene) y su propio Message-ID, para que la respuesta vuelva a su hilo.
 */
export async function prepareOutreach(
  tx: Db,
  actor: AdminActor,
  clientId: string,
  input: OutreachInput,
  now = new Date(),
): Promise<OutreachRow> {
  const client = await lockClient(tx, clientId)
  if (!(SAAS_OUTREACH_CHANNELS as readonly string[]).includes(input.channel))
    throw invalidField("channel", "Elige por dónde sale")
  const contact = await contactOfClient(tx, client.id, input.contactId)
  const body = trimmed("body", input.body, 5000, "el mensaje")
  let to = (input.to ?? "").trim()
  let subject: string | null = null
  let sender: MailSender | null = null
  if (input.channel === "whatsapp") {
    to = (to || contact?.phone || "").replace(/[ ()-]/g, "")
    if (!E164.test(to))
      throw invalidField(
        input.to ? "to" : "contactId",
        "Hace falta un celular con el código del país, como +51987654321",
      )
  } else {
    to = (to || contact?.email || "").toLowerCase()
    if (!EMAIL.test(to) || to.length > 254)
      throw invalidField(input.to ? "to" : "contactId", "Hace falta un correo válido")
    subject = trimmed("subject", input.subject, 200, "el asunto")
    sender = await outreachSender(tx, actor, productOf(client.product))
  }
  const proposalId = input.proposalId
    ? await sendableProposal(tx, actor, client.id, input.proposalId, now)
    : null
  let kairosItemId: string | null = null
  if (input.kairosItemId) {
    if (!UUID.test(input.kairosItemId))
      throw invalidField("kairosItemId", "Ese borrador de Kairós no existe")
    const [item] = await tx
      .select({ id: kairosItem.id, clientId: kairosItem.clientId })
      .from(kairosItem)
      .where(eq(kairosItem.id, input.kairosItemId))
      .limit(1)
    if (!item || item.clientId !== client.id)
      throw invalidField("kairosItemId", "Ese borrador de Kairós no es de este cliente")
    kairosItemId = item.id
  }
  const [row] = await tx
    .insert(saasOutreach)
    .values({
      clientId: client.id,
      contactId: contact?.id ?? null,
      channel: input.channel,
      toAddress: to,
      subject,
      body,
      proposalId,
      kairosItemId,
      fromAddress: sender?.address ?? null,
      messageId: sender ? newMessageId(productOf(client.product)) : null,
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo preparar el envío")
  // Desde que se reserva puede salir: la dirección de quien escribe queda fija.
  if (sender?.staffUserId) await markStaffMailUsed(tx, sender.staffUserId, now)
  await writeAdminAudit(tx, actor, {
    action: "arm.outreach_prepared",
    organizationId: client.organizationId,
    entityId: client.id,
    metadata: { outreachId: row.id, channel: input.channel, proposalId, kairosItemId },
  })
  return outreachRowOf(row)
}

export interface EmailReplyInput {
  body: string
  /** Una propuesta del cliente del correo, como en «Escribir»; solo Administración. */
  proposalId?: string | null
  /** El borrador de Kairós de este correo (`responder_correo`), si sale de él. */
  kairosItemId?: string | null
}

/** «Re: <asunto>», sin repetir el «Re:» que ya trae. */
export function replySubject(subject: string | null | undefined): string {
  const clean = (subject ?? "").replace(/\s+/g, " ").trim()
  if (!clean) return "Re: su correo"
  const reply = /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`
  return reply.length > 200 ? `${reply.slice(0, 199)}…` : reply
}

/** Los Message-ID (`<…>`) de una cabecera In-Reply-To o References, en orden y sin repetir. */
export function threadMessageIds(...values: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    for (const id of (value ?? "").match(/<[^<>\s]+>/g) ?? []) if (!out.includes(id)) out.push(id)
  }
  return out
}

/** La cabecera References de una respuesta: la del correo más su Message-ID, hasta 8000 caracteres. */
export function replyReferences(email: { references: string | null; messageId: string }): string {
  const ids = threadMessageIds(email.references, email.messageId)
  // Se conservan el primero (el que abrió el hilo) y los últimos: así lo hace todo cliente de correo.
  while (ids.length > 2 && ids.join(" ").length > 8000) ids.splice(1, 1)
  return ids.join(" ").slice(0, 8000)
}

/**
 * Prepara la respuesta a un correo que llegó: queda `pendiente` como
 * cualquier envío y la ruta la manda después del commit. Va al remitente, con
 * «Re: <asunto>», las cabeceras del hilo y su propio Message-ID. Lo que llegó
 * a soporte@ sale desde soporte@ y lo pueden responder Soporte y
 * Administración; lo demás (hola@, contacto@, fundadores@, la dirección de
 * una persona) sale con el nombre y la dirección de quien responde y solo lo
 * responde Administración. Un correo sin cliente se responde igual, sin ligarlo.
 */
export async function prepareEmailReply(
  tx: Db,
  actor: AdminActor,
  emailId: string,
  input: EmailReplyInput,
  now = new Date(),
): Promise<OutreachRow> {
  if (!UUID.test(emailId)) throw notFound("Correo")
  const [email] = await tx
    .select()
    .from(saasInboundEmail)
    .where(eq(saasInboundEmail.id, emailId))
    .limit(1)
  if (!email) throw notFound("Correo")
  const mailbox = email.mailbox as SaasInboundMailbox
  if (actor.role !== "admin" && mailbox !== "soporte")
    throw forbidden("Soporte responde solo lo que llegó a soporte@")
  const body = trimmed("body", input.body, 5000, "la respuesta")
  const client = email.clientId ? await lockClient(tx, email.clientId) : null
  const product = productOf(client?.product ?? email.product)
  const sender = await outreachSender(tx, actor, product, mailbox)
  let proposalId: string | null = null
  if (input.proposalId) {
    if (!client)
      throw invalidField("proposalId", "Este correo no es de un cliente: ligalo antes de adjuntar")
    proposalId = await sendableProposal(tx, actor, client.id, input.proposalId, now)
  }
  let kairosItemId: string | null = null
  if (input.kairosItemId) {
    if (!UUID.test(input.kairosItemId))
      throw invalidField("kairosItemId", "Ese borrador de Kairós no existe")
    const [item] = await tx
      .select({ id: kairosItem.id, emailId: sql<string | null>`${kairosItem.payload}->>'emailId'` })
      .from(kairosItem)
      .where(eq(kairosItem.id, input.kairosItemId))
      .limit(1)
    if (!item || item.emailId !== email.id)
      throw invalidField("kairosItemId", "Ese borrador de Kairós no es de este correo")
    kairosItemId = item.id
  }
  const [contact] = client
    ? await tx
        .select({ id: saasClientContact.id })
        .from(saasClientContact)
        .where(
          and(
            eq(saasClientContact.clientId, client.id),
            eq(saasClientContact.email, email.fromAddress),
          ),
        )
        .limit(1)
    : []
  const [row] = await tx
    .insert(saasOutreach)
    .values({
      clientId: client?.id ?? null,
      contactId: contact?.id ?? null,
      channel: "correo",
      toAddress: email.fromAddress,
      subject: replySubject(email.subject),
      body,
      proposalId,
      kairosItemId,
      inReplyToEmailId: email.id,
      fromAddress: sender.address,
      messageId: newMessageId(product),
      references: replyReferences(email),
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo preparar la respuesta")
  if (sender.staffUserId) await markStaffMailUsed(tx, sender.staffUserId, now)
  await writeAdminAudit(tx, actor, {
    action: "arm.reply_prepared",
    organizationId: client?.organizationId ?? null,
    entityId: client?.id ?? email.id,
    metadata: { outreachId: row.id, emailId: email.id, mailbox, proposalId, kairosItemId },
  })
  return outreachRowOf(row)
}

/**
 * El envío, bloqueado, con si es solo de Administración (`outreachAdminOnlySql`:
 * lleva una propuesta, sale de algo de Kairós solo de Administración o responde
 * lo que no llegó a soporte@). Para Soporte ese no existe: la misma respuesta
 * que uno que no hay.
 */
async function lockOutreach(tx: Db, actor: AdminActor, id: string) {
  if (!UUID.test(id)) throw notFound("Envío")
  const [found] = await tx
    .select({ row: saasOutreach, adminOnly: outreachAdminOnlySql(`"saas_outreach"`) })
    .from(saasOutreach)
    .where(eq(saasOutreach.id, id))
    .limit(1)
    .for("update")
  if (!found || (found.adminOnly && actor.role !== "admin")) throw notFound("Envío")
  return { ...found.row, adminOnly: Boolean(found.adminOnly) }
}

/**
 * Salió: deja la actividad en la bitácora (solo de Administración si el envío
 * lo es) y, si llevaba una propuesta lista, la pasa a enviada. La respuesta a
 * un correo sin cliente no deja actividad: la deja cuando se liga el correo
 * (`settleRepliesOfEmail`).
 */
async function outreachWentOut(
  tx: Db,
  actor: AdminActor | null,
  row: typeof saasOutreach.$inferSelect,
  adminOnly: boolean,
  now: Date,
): Promise<void> {
  if (!row.clientId) return
  const [client] = await tx
    .select()
    .from(saasClient)
    .where(eq(saasClient.id, row.clientId))
    .limit(1)
  if (!client) throw notFound("Cliente")
  await insertActivity(
    tx,
    actor,
    client,
    {
      kind: row.channel === "whatsapp" ? "whatsapp" : "correo",
      direction: "salio",
      body: (row.subject ? `${row.subject}\n\n${row.body}` : row.body).slice(0, 2000),
      contactId: row.contactId,
      proposalId: row.proposalId,
      adminOnly,
      ...(row.sentAt ? { happenedAt: row.sentAt } : {}),
    },
    now,
  )
  if (row.proposalId) {
    // Una propuesta ya enviada no cambia (reenviarla no mueve su fecha).
    await tx
      .update(saasProposal)
      .set({ status: "enviada", sentAt: now, updatedAt: now })
      .where(and(eq(saasProposal.id, row.proposalId), eq(saasProposal.status, "borrador")))
  }
}

/**
 * Al ligar un correo a un cliente, sus respuestas que salieron sin cliente
 * pasan a ser de él, y las que ya salieron dejan su actividad con la hora en
 * que salieron. Lo llama `assignInboundEmail`, en su misma transacción.
 */
export async function settleRepliesOfEmail(
  tx: Db,
  actor: AdminActor | null,
  emailId: string,
  clientId: string,
  now = new Date(),
): Promise<number> {
  const moved = await tx
    .update(saasOutreach)
    .set({ clientId, updatedAt: now })
    .where(and(eq(saasOutreach.inReplyToEmailId, emailId), isNull(saasOutreach.clientId)))
    .returning()
  for (const row of moved) {
    if (row.status !== "enviado") continue
    const [flag] = await tx
      .select({ adminOnly: outreachAdminOnlySql(`"saas_outreach"`) })
      .from(saasOutreach)
      .where(eq(saasOutreach.id, row.id))
      .limit(1)
    await outreachWentOut(tx, actor, row, Boolean(flag?.adminOnly), now)
  }
  return moved.length
}

/**
 * El resultado del correo, lo anota la ruta después de enviarlo: `enviado` si
 * el servidor de correo lo aceptó, `incierto` si se cortó y no se sabe. Lo
 * incierto nunca se reintenta: lo resuelve una persona (`resolveOutreach`).
 */
export async function markOutreachSent(
  tx: Db,
  actor: AdminActor,
  id: string,
  result: "enviado" | "incierto",
  now = new Date(),
): Promise<OutreachRow> {
  const row = await lockOutreach(tx, actor, id)
  if (row.channel !== "correo")
    throw new ServiceError("OUTREACH_NOT_EMAIL", 409, "Ese envío no es un correo")
  if (row.status !== "pendiente")
    throw new ServiceError("OUTREACH_SETTLED", 409, "Ese envío ya tiene su resultado")
  const [updated] = await tx
    .update(saasOutreach)
    .set({ status: result, sentAt: result === "enviado" ? now : null, updatedAt: now })
    .where(eq(saasOutreach.id, id))
    .returning()
  if (!updated) throw notFound("Envío")
  if (result === "enviado") await outreachWentOut(tx, actor, updated, row.adminOnly, now)
  await writeAdminAudit(tx, actor, {
    action: result === "enviado" ? "arm.outreach_sent" : "arm.outreach_uncertain",
    entityId: row.clientId ?? row.inReplyToEmailId,
    metadata: { outreachId: id },
  })
  return outreachRowOf(updated)
}

/**
 * Una persona dice si salió: el WhatsApp abierto por su enlace, o un correo
 * incierto (o que quedó pendiente porque la ruta se cortó antes de anotarlo).
 * «Salió» deja la actividad y pasa la propuesta a enviada; «No salió» es final.
 */
export async function resolveOutreach(
  tx: Db,
  actor: AdminActor,
  id: string,
  outcome: "salio" | "no_salio",
  now = new Date(),
): Promise<OutreachRow> {
  if (outcome !== "salio" && outcome !== "no_salio")
    throw invalidField("outcome", "Elige si salió o no")
  const row = await lockOutreach(tx, actor, id)
  if (row.status !== "pendiente" && row.status !== "incierto")
    throw new ServiceError("OUTREACH_SETTLED", 409, "Ese envío ya tiene su resultado")
  const status: SaasOutreachStatus = outcome === "salio" ? "enviado" : "no_salio"
  const [updated] = await tx
    .update(saasOutreach)
    .set({
      status,
      sentAt: outcome === "salio" ? now : null,
      resolvedBy: actor.userId,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(eq(saasOutreach.id, id))
    .returning()
  if (!updated) throw notFound("Envío")
  if (outcome === "salio") await outreachWentOut(tx, actor, updated, row.adminOnly, now)
  await writeAdminAudit(tx, actor, {
    action: outcome === "salio" ? "arm.outreach_resolved_sent" : "arm.outreach_resolved_failed",
    entityId: row.clientId ?? row.inReplyToEmailId,
    metadata: { outreachId: id },
  })
  return outreachRowOf(updated)
}

export interface OutreachEmail {
  to: string
  subject: string
  html: string
  text: string
  /** A dónde van las respuestas: la misma dirección que firma. */
  replyTo: string
  brand: MailBrand
  /** Quién firma: «Ada Lovelace · odentIA <ada.lovelace@odentia32.com>», «Soporte · odentIA <soporte@…>» u hola@. */
  from: { name: string; address: string }
  /** Nuestro Message-ID; nulo en un envío de antes de guardarlo. */
  messageId: string | null
  /** `In-Reply-To` y `References`, si responde un correo. */
  headers: Record<string, string>
  attachments: Array<{ filename: string; content: Uint8Array; contentType: string }>
}

/** El mensaje para `mailer.send`: quien firma, la respuesta a esa misma dirección, el Message-ID y el hilo. */
export function outreachMailMessage(email: OutreachEmail): MailMessage {
  return {
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    replyTo: email.replyTo,
    brand: email.brand,
    from: email.from,
    ...(email.messageId ? { messageId: email.messageId } : {}),
    ...(Object.keys(email.headers).length ? { headers: email.headers } : {}),
    attachments: email.attachments,
  }
}

const QUOTE_MAX = 4000

/** «El 12 de noviembre de 2026, 10:15, Rosa Mamani escribió:» y el texto con «> ». */
export function quotedEmail(email: {
  fromName: string | null
  fromAddress: string
  receivedAt: Date
  textBody: string | null
}): string[] {
  const text = (email.textBody ?? "").trim()
  if (!text) return []
  const when = new Intl.DateTimeFormat(ZONE.locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: ZONE.timezone,
  }).format(email.receivedAt)
  const who = email.fromName?.trim() || email.fromAddress
  const clipped = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX)}…` : text
  return [
    `El ${when}, ${who} escribió:`,
    clipped
      .split(/\r?\n/)
      .map((line) => `> ${line}`)
      .join("\n"),
  ]
}

/**
 * El correo de un envío pendiente, listo para `mailer.send` (después del
 * commit): con la marca del producto, su remitente (quien escribe, soporte@
 * u hola@) y las respuestas a esa misma dirección, su Message-ID y, si
 * responde un correo, las cabeceras del hilo y el correo citado debajo. Si
 * lleva propuesta, su PDF adjunto.
 */
export async function outreachEmail(tx: Db, id: string): Promise<OutreachEmail> {
  if (!UUID.test(id)) throw notFound("Envío")
  const [row] = await tx
    .select({
      outreach: saasOutreach,
      clientName: saasClient.name,
      clientProduct: saasClient.product,
      email: saasInboundEmail,
    })
    .from(saasOutreach)
    .leftJoin(saasClient, eq(saasClient.id, saasOutreach.clientId))
    .leftJoin(saasInboundEmail, eq(saasInboundEmail.id, saasOutreach.inReplyToEmailId))
    .where(eq(saasOutreach.id, id))
    .limit(1)
  if (!row) throw notFound("Envío")
  const { outreach, email } = row
  if (outreach.channel !== "correo" || !outreach.subject)
    throw new ServiceError("OUTREACH_NOT_EMAIL", 409, "Ese envío no es un correo")
  const product = productOf(row.clientProduct ?? email?.product ?? "dental")
  const brand = PRODUCT_BRAND[product]
  const sender = outreach.fromAddress
    ? await senderOfAddress(tx, product, outreach.fromAddress)
    : brandMailbox(product, "hola")
  const paragraphs = outreach.body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (email) paragraphs.push(...quotedEmail(email))
  const attachments: OutreachEmail["attachments"] = []
  if (outreach.proposalId) {
    const pdf = await proposalPdf(tx, outreach.proposalId, sender.address)
    attachments.push({ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" })
  }
  const template = renderEmail({
    brand,
    subject: outreach.subject,
    preview: paragraphs[0]?.slice(0, 140) ?? outreach.subject,
    title: outreach.subject,
    paragraphs,
    reason: row.clientName
      ? `Le escribimos por la relación de ${row.clientName} con ${brandPaper(brand).name}.`
      : `Le respondemos el correo que nos escribió a ${email?.toAddress ?? brandPaper(brand).name}.`,
    replies: "Si responde este correo, le llega a quien le escribe.",
    replyTo: sender.address,
  })
  const headers: Record<string, string> = {}
  if (email) {
    headers["In-Reply-To"] = email.messageId
    if (outreach.references) headers.References = outreach.references
  }
  return {
    to: outreach.toAddress,
    subject: template.subject,
    html: template.html,
    text: template.text,
    replyTo: sender.address,
    brand,
    from: { name: sender.name, address: sender.address },
    messageId: outreach.messageId,
    headers,
    attachments,
  }
}

/* ---------- Embudo ---------- */

export const PIPELINE_COLUMNS = [
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
  "decidio",
] as const
export type PipelineColumn = (typeof PIPELINE_COLUMNS)[number]

/** Las señales de la tarjeta: las mismas de la lista y la ficha (`clientSignals`). */
export type PipelineSignal = ClientSignal

export interface PipelineCard {
  clientId: string
  name: string
  product: ClinicalProduct
  nextStep: { kind: SaasTaskKind; title: string; dueOn: string } | null
  daysInStage: number
  owner: { userId: string; name: string } | null
  signals: PipelineSignal[]
  /** En «Decidió»: qué se decidió. */
  decision: SaasOpportunityDecision | null
}

export interface PipelineFilter {
  product?: ClinicalProduct
  /** Una persona, «mio» (quien mira) o «sin» (sin responsable). */
  owner?: string | "mio" | "sin"
  origin?: (typeof SAAS_CLIENT_ORIGINS)[number]
}

export interface Pipeline {
  columns: Array<{ key: PipelineColumn; cards: PipelineCard[] }>
}

type PipelineRaw = {
  client_id: string
  name: string
  product: string
  owner_user_id: string | null
  owner_name: string | null
  stage: string
  decision: string | null
  decided_at: Date | string | null
  opened_at: Date | string
  proposal_at: Date | string | null
  presented_at: Date | string | null
  scheduled_at: Date | string | null
}

const SELLING_COLUMNS: ReadonlySet<string> = new Set<PipelineColumn>([
  "contacto",
  "presentacion_agendada",
  "presentacion_hecha",
  "propuesta",
])

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null
  return value instanceof Date ? value : new Date(value)
}

/**
 * El embudo: una tarjeta por cliente con la venta abierta, en la columna de su
 * etapa (calculada: propuesta enviada vigente o invitación → «Propuesta»;
 * presentación anotada → «Presentación hecha»; presentación por hacer →
 * «Presentación agendada»; si no, «Contacto»), y lo decidido en los últimos 30
 * días en «Decidió». Las tarjetas no se arrastran: cambian cuando pasa el
 * hecho. Sin importes: lo ve también Soporte.
 */
export async function pipeline(
  tx: Db,
  actor: AdminActor,
  filter: PipelineFilter = {},
  now = new Date(),
): Promise<Pipeline> {
  const today = limaDate(now)
  const where: SQL[] = [sql`c.archived_at IS NULL`]
  if (filter.product) where.push(sql`c.product = ${filter.product}`)
  if (filter.origin) where.push(sql`c.origin = ${filter.origin}`)
  if (filter.owner === "mio") where.push(sql`c.owner_user_id = ${actor.userId}`)
  else if (filter.owner === "sin") where.push(sql`c.owner_user_id IS NULL`)
  else if (filter.owner) where.push(sql`c.owner_user_id = ${filter.owner}`)
  const since = new Date(now.getTime() - PIPELINE_DECIDED_DAYS * DAY)
  // La etapa es la de la lista y la ficha (`clientStageSql`), leída sobre la misma fila del cliente.
  const stage = sql`(select ${clientStageSql(now)} from ${saasClient} where ${saasClient.id} = c.id)`
  const rows = (await tx.execute(sql`
    with opp as (
      select distinct on (o.client_id) o.client_id, o.id, o.decision, o.decided_at, o.created_at
      from admin.saas_opportunity o
      where o.decision is null or o.decided_at >= ${since.toISOString()}::timestamptz
      order by o.client_id, (o.decision is null) desc, o.decided_at desc
    )
    select
      c.id as client_id, c.name, c.product, c.owner_user_id,
      (select u.name from "user" u where u.id = c.owner_user_id) as owner_name,
      ${stage} as stage,
      opp.decision, opp.decided_at, opp.created_at as opened_at,
      greatest(
        (select max(coalesce(p.decided_at, p.sent_at)) from admin.saas_proposal p
          where p.client_id = c.id and p.created_at >= opp.created_at
            and (p.status = 'aceptada' or ${proposalLiveSql(today)})),
        (select max(r.invited_at) from admin.saas_waitlist_request r
          where r.client_id = c.id and r.status = 'invitada')
      ) as proposal_at,
      (select max(f.happened_at) from admin.saas_follow_up f
        where f.client_id = c.id and f.kind = 'presentacion' and f.happened_at >= opp.created_at) as presented_at,
      (select max(t.created_at) from admin.saas_task t
        where t.client_id = c.id and t.kind = 'presentacion' and t.status = 'abierta') as scheduled_at
    from admin.saas_client c
    join opp on opp.client_id = c.id
    where ${and(...where)}
      and (opp.decision is not null or c.organization_id is null)
    order by c.name
  `)) as unknown as PipelineRaw[]

  const signals = await clientSignals(
    tx,
    actor,
    rows.filter((raw) => !raw.decision).map((raw) => raw.client_id),
    now,
  )
  // El próximo paso, con la regla de la lista y la ficha: Soporte no ve las tareas de cobro.
  const next = await nextSteps(
    tx,
    actor,
    rows.map((raw) => raw.client_id),
    now,
  )
  const columns = new Map<PipelineColumn, PipelineCard[]>(PIPELINE_COLUMNS.map((key) => [key, []]))
  for (const raw of rows) {
    const decision = (raw.decision as SaasOpportunityDecision | null) ?? null
    const step = next.get(raw.client_id)
    const opened = asDate(raw.opened_at) ?? now
    const column: PipelineColumn = decision
      ? "decidio"
      : SELLING_COLUMNS.has(raw.stage)
        ? (raw.stage as PipelineColumn)
        : "contacto"
    // Desde cuándo está en su columna: el hecho que la puso ahí.
    const since =
      column === "decidio"
        ? (asDate(raw.decided_at) ?? now)
        : column === "propuesta"
          ? (asDate(raw.proposal_at) ?? opened)
          : column === "presentacion_hecha"
            ? (asDate(raw.presented_at) ?? opened)
            : column === "presentacion_agendada"
              ? (asDate(raw.scheduled_at) ?? opened)
              : opened
    columns.get(column)?.push({
      clientId: raw.client_id,
      name: raw.name,
      product: productOf(raw.product),
      nextStep: step ? { kind: step.kind, title: step.title, dueOn: step.dueOn } : null,
      daysInStage: Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY)),
      owner: raw.owner_user_id ? { userId: raw.owner_user_id, name: raw.owner_name ?? "" } : null,
      signals: decision ? [] : (signals.get(raw.client_id) ?? []),
      decision,
    })
  }
  return { columns: PIPELINE_COLUMNS.map((key) => ({ key, cards: columns.get(key) ?? [] })) }
}
