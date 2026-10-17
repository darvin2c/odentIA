import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { contact, conversation, crmTask, TASK_AREAS, type TaskArea, type TaskKind } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm"
import { resolveAfterHandoffTask } from "./conversation-close.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"

/** Aviso en vivo para el stream (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

const STATUSES = ["open", "done", "cancelled"]
// Quién deja una tarea: una persona, Recepción en una conversación o el
// Administrador por una línea prendida.
/** Quién deja una tarea: una persona, el agente, el Administrador o el sistema (lo que la persona hizo en su enlace). */
const CREATED_BY = ["user", "agent", "admin", "sistema"]

/**
 * Las partes del equipo de cada rol: además de las suyas, cada persona ve las
 * tareas sin responsable de su parte del equipo («Mías y de mi área»).
 */
export function taskAreasOfRole(role: string): TaskArea[] {
  if (role === "owner" || role === "admin") return ["administracion"]
  if (role === "reception") return ["recepcion"]
  if (role === "cashier") return ["caja"]
  if (role === "dentist") return ["clinico"]
  return []
}

export interface TaskItem {
  id: string
  title: string
  contactId: string | null
  conversationId: string | null
  /** La oportunidad de la que es la próxima acción (una sola tarea abierta por oportunidad). */
  opportunityId: string | null
  /** Paciente al que se refiere la tarea (nulo si es solo comercial u operativa). */
  patientId: string | null
  assigneeUserId: string | null
  dueAt: string | null
  status: string
  createdBy: string
  /** A qué parte del equipo va cuando no tiene responsable; nulo en las tareas de siempre. */
  area: TaskArea | null
  /** Por qué se creó, cuando la deja el Administrador. */
  reason: string | null
  /** Por qué se cerró sola: «Rosa confirmó su cita». Nulo si la cerró una persona. */
  settledReason: string | null
  /** Nombre del paciente (nulo sin patients.read en la API o sin vínculo). */
  patientName: string | null
  /** Nombre del contacto (nulo sin crm.read en la API o sin vínculo). */
  contactName: string | null
  /** Título de la oportunidad vinculada (nulo sin crm.read en la API o sin vínculo). */
  opportunityTitle: string | null
  /**
   * La tarea es la de un caso que pasó el agente («Te lo pasó el agente»), con
   * su urgencia. Completarla puede resolver la conversación: antes se muestra
   * lo mismo que «Resolver» (`getTaskResolvePreview`).
   */
  agentCase: { priority: string } | null
  createdAt: string
  updatedAt: string
}

function toItem(
  row: typeof crmTask.$inferSelect,
  contactName: string | null = null,
  opportunityTitle: string | null = null,
  patientName: string | null = null,
  casePriority: string | null = null,
): TaskItem {
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    conversationId: row.conversationId,
    opportunityId: row.opportunityId,
    patientId: row.patientId,
    assigneeUserId: row.assigneeUserId,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    status: row.status,
    createdBy: row.createdBy,
    area: (TASK_AREAS as readonly string[]).includes(row.area ?? "") ? (row.area as TaskArea) : null,
    reason: row.reason,
    settledReason: row.settledReason,
    patientName,
    contactName,
    opportunityTitle,
    agentCase: casePriority ? { priority: casePriority } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export interface TaskFilters {
  status?: string
  assignee?: string
  contactId?: string
  conversationId?: string
  opportunityId?: string
  /** Tareas de la persona: referidas al paciente o al contacto que es su propia persona. */
  patientId?: string
  /** true = vencidas (dueAt <= ahora y abiertas); false = no vencidas. */
  overdue?: boolean
}

function isUuid(value: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(value)
}

function cleanDueAt(dueAt: string | null | undefined): Date | null | undefined {
  if (dueAt === undefined) return undefined
  if (dueAt === null) return null
  const parsed = new Date(dueAt)
  if (Number.isNaN(parsed.getTime())) throw validation("La fecha de vencimiento no es válida")
  return parsed
}

/** El asignado debe ser miembro de la org; null libera la asignación. */
async function resolveTaskAssignee(
  tx: Db,
  orgId: string,
  assignedUserId: string | null | undefined,
): Promise<string | null | undefined> {
  if (assignedUserId === undefined) return undefined
  if (assignedUserId === null) return null
  const [membership] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, assignedUserId)))
    .limit(1)
  if (!membership) throw validation("El asignado no es miembro de esta organización")
  return membership.userId
}

async function requireContactInOrg(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, id), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Contacto")
  return row
}

async function requireConversationInOrg(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  return row
}

async function requireOpportunityInOrg(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: opportunity.id, contactId: opportunity.contactId, status: opportunity.status })
    .from(opportunity)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Oportunidad")
  return row
}

/**
 * Resuelve el contacto efectivo de la tarea.
 * Vincula automáticamente al contacto del hilo/oportunidad si no se dio
 * y rechaza discrepancias entre hilos de distintos contactos.
 */
async function resolveTaskContact(
  tx: Db,
  orgId: string,
  input: { contactId?: string | null; conversationId?: string | null; opportunityId?: string | null },
): Promise<{ contactId: string | null; conversationId: string | null; opportunityId: string | null }> {
  const conversationId = input.conversationId ?? null
  const opportunityId = input.opportunityId ?? null
  let contactId = input.contactId ?? null
  if (contactId !== null && !isUuid(contactId)) throw validation("contactId inválido")
  if (conversationId !== null && !isUuid(conversationId)) throw validation("conversationId inválido")
  if (opportunityId !== null && !isUuid(opportunityId)) throw validation("opportunityId inválido")
  if (contactId) await requireContactInOrg(tx, orgId, contactId)
  const convRow = conversationId ? await requireConversationInOrg(tx, orgId, conversationId) : null
  const oppRow = opportunityId ? await requireOpportunityInOrg(tx, orgId, opportunityId) : null
  if (convRow && oppRow && convRow.contactId !== oppRow.contactId) {
    throw validation("La conversación y la oportunidad pertenecen a contactos distintos")
  }
  const linkedContactId = convRow?.contactId ?? oppRow?.contactId ?? null
  if (contactId && linkedContactId && contactId !== linkedContactId) {
    throw validation("La tarea no puede mezclar contactos distintos (hilo/oportunidad)")
  }
  if (!contactId) contactId = linkedContactId
  return { contactId, conversationId, opportunityId }
}

/** La propia persona (contacto `self`) del paciente: así la tarea dice de quién es. */
async function selfContactOf(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [own] = await tx
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return own?.contactId ?? null
}

const CASE_PRIORITY = sql<string | null>`(select h.priority from agent_handoff h
  where h.organization_id = ${crmTask.organizationId} and h.task_id = ${crmTask.id} order by h.created_at desc limit 1)`

function withNamesQuery(tx: Db, orgId: string) {
  return tx
    .select({
      task: crmTask,
      contactName: contact.displayName,
      opportunityTitle: opportunity.title,
      patientName: patientPerson.displayName,
      // Un caso por tarea en la práctica; si hubiera dos, vale el último.
      casePriority: CASE_PRIORITY,
    })
    .from(crmTask)
    .leftJoin(patient, and(eq(patient.id, crmTask.patientId), eq(patient.organizationId, orgId)))
    .leftJoin(patientPerson, joinPatientPerson(patientPerson))
    .leftJoin(contact, and(eq(contact.id, crmTask.contactId), eq(contact.organizationId, orgId)))
    .leftJoin(opportunity, and(eq(opportunity.id, crmTask.opportunityId), eq(opportunity.organizationId, orgId)))
}

async function withNames(tx: Db, orgId: string, row: typeof crmTask.$inferSelect): Promise<TaskItem> {
  const [found] = await withNamesQuery(tx, orgId).where(and(eq(crmTask.id, row.id), eq(crmTask.organizationId, orgId))).limit(1)
  if (!found) return toItem(row)
  return toItem(found.task, found.contactName, found.opportunityTitle, found.patientName, found.casePriority)
}

export async function getTask(tx: Db, orgId: string, id: string): Promise<TaskItem> {
  if (!isUuid(id)) throw validation("Identificador de tarea inválido")
  const [row] = await tx.select().from(crmTask)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId))).limit(1)
  if (!row) throw notFound("Tarea")
  return withNames(tx, orgId, row)
}

/** Lista simple, filtrada (agente, contexto de una persona): sin páginas. */
export async function listTasks(tx: Db, orgId: string, input: TaskFilters): Promise<TaskItem[]> {
  const conditions = [eq(crmTask.organizationId, orgId)]
  if (input.status) {
    if (!STATUSES.includes(input.status)) throw validation("Estado inválido")
    conditions.push(eq(crmTask.status, input.status))
  }
  if (input.assignee) conditions.push(eq(crmTask.assigneeUserId, input.assignee))
  if (input.contactId) {
    if (!isUuid(input.contactId)) throw validation("contactId inválido")
    conditions.push(eq(crmTask.contactId, input.contactId))
  }
  if (input.conversationId) {
    if (!isUuid(input.conversationId)) throw validation("conversationId inválido")
    conditions.push(eq(crmTask.conversationId, input.conversationId))
  }
  if (input.opportunityId) {
    if (!isUuid(input.opportunityId)) throw validation("opportunityId inválido")
    conditions.push(eq(crmTask.opportunityId, input.opportunityId))
  }
  if (input.patientId) {
    if (!isUuid(input.patientId)) throw validation("patientId inválido")
    const own = await selfContactOf(tx, orgId, input.patientId)
    conditions.push(own ? or(eq(crmTask.patientId, input.patientId), eq(crmTask.contactId, own))! : eq(crmTask.patientId, input.patientId))
  }
  if (input.overdue === true) {
    conditions.push(eq(crmTask.status, "open"))
    conditions.push(sql`${crmTask.dueAt} is not null and ${crmTask.dueAt} <= now()`)
  } else if (input.overdue === false) {
    conditions.push(sql`not (${crmTask.status} = 'open' and ${crmTask.dueAt} is not null and ${crmTask.dueAt} <= now())`)
  }
  const rows = await withNamesQuery(tx, orgId)
    .where(and(...conditions))
    .orderBy(asc(crmTask.dueAt), desc(crmTask.createdAt))
  return rows.map((r) => toItem(r.task, r.contactName, r.opportunityTitle, r.patientName, r.casePriority))
}

/** Qué tareas se miran en Tareas: las abiertas, solo las vencidas o las hechas. */
export const TASK_VIEWS = ["abiertas", "vencidas", "hechas"] as const
export type TaskView = (typeof TASK_VIEWS)[number]

/** Cómo se ordenan las abiertas: lo que vence antes o lo más reciente. */
export const TASK_SORTS = ["vence", "recientes"] as const
export type TaskSort = (typeof TASK_SORTS)[number]

export interface TaskPageInput {
  /** Quién mira: sus tareas y las sin responsable de su área; con `all`, las de toda la clínica. */
  viewer: { userId: string; areas: readonly string[]; all: boolean }
  view?: TaskView
  sort?: TaskSort
  q?: string
  cursor?: string
  limit?: number
}

const TASK_PAGE = 30

interface TaskCursor {
  /** Valor de la columna de orden (ISO) o null (sin fecha, al final). */
  v: string | null
  id: string
  f: string
}

function encodeTaskCursor(cursor: TaskCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeTaskCursor(value: string): TaskCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TaskCursor
    if (typeof parsed.id === "string" && isUuid(parsed.id) && (parsed.v === null || typeof parsed.v === "string")) return parsed
  } catch {
    // cae al error de abajo
  }
  throw validation("Cursor inválido")
}

/**
 * Tareas con páginas, búsqueda y orden en el servidor. Se abre en «Mías y de
 * mi área» (las de quien mira y las sin responsable de su parte del equipo);
 * «Toda la clínica» (`viewer.all`) la decide quien llama con el permiso
 * `tasks.all`. Las vencidas son siempre abiertas: no hay vencidas hechas.
 */
export async function pageTasks(
  tx: Db,
  orgId: string,
  input: TaskPageInput,
): Promise<{ items: TaskItem[]; nextCursor: string | null; total: number }> {
  const view: TaskView = input.view ?? "abiertas"
  if (!(TASK_VIEWS as readonly string[]).includes(view)) throw validation("Vista de tareas inválida")
  const sort: TaskSort = view === "hechas" ? "recientes" : (input.sort ?? "vence")
  if (!(TASK_SORTS as readonly string[]).includes(sort)) throw validation("Orden de tareas inválido")
  const limit = Math.min(Math.max(input.limit ?? TASK_PAGE, 1), 100)
  const q = input.q?.trim() ?? ""
  const areas = input.viewer.areas.filter((area) => (TASK_AREAS as readonly string[]).includes(area))
  const conditions: SQL[] = [eq(crmTask.organizationId, orgId)]
  if (!input.viewer.all) {
    conditions.push(
      or(
        eq(crmTask.assigneeUserId, input.viewer.userId),
        areas.length ? and(isNull(crmTask.assigneeUserId), inArray(crmTask.area, areas)) : undefined,
      )!,
    )
  }
  if (view === "hechas") conditions.push(eq(crmTask.status, "done"))
  else conditions.push(eq(crmTask.status, "open"))
  if (view === "vencidas") conditions.push(sql`${crmTask.dueAt} is not null and ${crmTask.dueAt} <= now()`)
  if (q) {
    const like = `%${q}%`
    conditions.push(or(ilike(crmTask.title, like), ilike(contact.displayName, like), ilike(patientPerson.displayName, like), ilike(opportunity.title, like))!)
  }
  const fingerprint = JSON.stringify({ view, sort, q, all: input.viewer.all })
  const total = await countTasks(tx, orgId, conditions)
  const column = sort === "vence" ? crmTask.dueAt : view === "hechas" ? crmTask.updatedAt : crmTask.createdAt
  if (input.cursor) {
    const cursor = decodeTaskCursor(input.cursor)
    if (cursor.f !== fingerprint) throw validation("El cursor no corresponde a los filtros actuales")
    if (sort === "vence") {
      conditions.push(
        cursor.v === null
          ? and(isNull(crmTask.dueAt), gt(crmTask.id, cursor.id))!
          : or(
              gt(crmTask.dueAt, sql`${cursor.v}::timestamptz`),
              and(eq(crmTask.dueAt, sql`${cursor.v}::timestamptz`), gt(crmTask.id, cursor.id)),
              isNull(crmTask.dueAt),
            )!,
      )
    } else {
      conditions.push(
        or(
          lt(column, sql`${cursor.v}::timestamptz`),
          and(eq(column, sql`${cursor.v}::timestamptz`), lt(crmTask.id, cursor.id)),
        )!,
      )
    }
  }
  const order = sort === "vence"
    ? [sql`${crmTask.dueAt} asc nulls last`, asc(crmTask.id)]
    : [desc(column), desc(crmTask.id)]
  const rows = await withNamesQuery(tx, orgId)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const lastValue = last
    ? (sort === "vence" ? last.task.dueAt : view === "hechas" ? last.task.updatedAt : last.task.createdAt)
    : null
  return {
    items: page.map((r) => toItem(r.task, r.contactName, r.opportunityTitle, r.patientName, r.casePriority)),
    nextCursor:
      rows.length > limit && last
        ? encodeTaskCursor({ v: lastValue ? lastValue.toISOString() : null, id: last.task.id, f: fingerprint })
        : null,
    total,
  }
}

async function countTasks(tx: Db, orgId: string, conditions: SQL[]): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(crmTask)
    .leftJoin(patient, and(eq(patient.id, crmTask.patientId), eq(patient.organizationId, orgId)))
    .leftJoin(patientPerson, joinPatientPerson(patientPerson))
    .leftJoin(contact, and(eq(contact.id, crmTask.contactId), eq(contact.organizationId, orgId)))
    .leftJoin(opportunity, and(eq(opportunity.id, crmTask.opportunityId), eq(opportunity.organizationId, orgId)))
    .where(and(...conditions))
  return row?.n ?? 0
}

export async function createTask(
  tx: Db,
  orgId: string,
  input: {
    title: string
    contactId?: string | null
    conversationId?: string | null
    /** La oportunidad de la que es la próxima acción: una sola tarea abierta por oportunidad. */
    opportunityId?: string | null
    /** Paciente al que se refiere la tarea; debe ser de la organización. */
    patientId?: string | null
    assigneeUserId?: string | null
    dueAt?: string | null
    createdBy: string
    /** Parte del equipo a la que va si no tiene responsable. */
    area?: TaskArea | null
    /** Por qué se creó, en una frase. */
    reason?: string | null
    /** Clave estable por trigger (agente): la reentrega no duplica la tarea. */
    idempotencyKey?: string | null
    /** Usuario real que crea la tarea; nulo cuando es el agente. */
    actorUserId?: string | null
    /** Pendiente del sistema con su propia fila en «Te espera» (`TASK_KINDS`). */
    kind?: TaskKind | null
  },
): Promise<TaskItem> {
  const title = input.title.trim()
  if (!title) throw validation("El título de la tarea es obligatorio")
  if (title.length > 200) throw validation("El título no puede superar 200 caracteres")
  if (!CREATED_BY.includes(input.createdBy)) throw validation("createdBy inválido (user|agent|admin|sistema)")
  if (input.area != null && !(TASK_AREAS as readonly string[]).includes(input.area)) throw validation("Área inválida")
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 480) : null
  const dueAt = cleanDueAt(input.dueAt) ?? null
  const idemKey = input.idempotencyKey?.trim() ? input.idempotencyKey.trim().slice(0, 120) : null
  if (idemKey) {
    // Reentrega del mismo trigger: devuelve la tarea ya creada, sin duplicar.
    const [existing] = await tx
      .select()
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.idempotencyKey, idemKey)))
      .limit(1)
    if (existing) return withNames(tx, orgId, existing)
  }
  const assignee = await resolveTaskAssignee(tx, orgId, input.assigneeUserId)
  const patientId = input.patientId ?? null
  if (patientId !== null) {
    if (!isUuid(patientId)) throw validation("patientId inválido")
    const [row] = await tx
      .select({ id: patient.id })
      .from(patient)
      .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
      .limit(1)
    if (!row) throw notFound("Paciente")
  }
  // Una tarea de un paciente sin otro vínculo es de su propia persona: así dice de quién es.
  const onlyPatient = patientId && !input.contactId && !input.conversationId && !input.opportunityId
  const links = await resolveTaskContact(tx, orgId, {
    contactId: onlyPatient ? await selfContactOf(tx, orgId, patientId) : (input.contactId ?? null),
    conversationId: input.conversationId ?? null,
    opportunityId: input.opportunityId ?? null,
  })
  let area = input.area ?? null
  if (links.opportunityId) {
    // La oportunidad se bloquea para que dos tareas no nazcan a la vez.
    const [opp] = await tx
      .select({ status: opportunity.status, assignedUserId: opportunity.assignedUserId })
      .from(opportunity)
      .where(and(eq(opportunity.id, links.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
      .for("update")
    if (opp?.status !== "open") throw validation("La oportunidad ya se cerró: no necesita otra tarea")
    const [open] = await tx
      .select({ id: crmTask.id, title: crmTask.title })
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.opportunityId, links.opportunityId), eq(crmTask.status, "open")))
      .limit(1)
    if (open) {
      throw new ServiceError(
        "OPPORTUNITY_HAS_TASK",
        409,
        `Esta oportunidad ya tiene su tarea: «${open.title}». Márcala como hecha o cámbiala`,
      )
    }
    // Sin responsable, la tarea de una oportunidad va a Recepción, igual que la oportunidad.
    if (!assignee && !area) area = "recepcion"
  }
  const values = {
    organizationId: orgId,
    title,
    patientId,
    contactId: links.contactId,
    conversationId: links.conversationId,
    opportunityId: links.opportunityId,
    assigneeUserId: assignee ?? null,
    dueAt,
    createdBy: input.createdBy,
    area,
    reason,
    idempotencyKey: idemKey,
    kind: input.kind ?? null,
  }
  // El índice único es parcial (solo claves no nulas): el upsert aplica solo
  // cuando el llamador trae clave estable; el resto inserta directo.
  const [created] = idemKey
    ? await tx
        .insert(crmTask)
        .values(values)
        .onConflictDoNothing({ target: [crmTask.organizationId, crmTask.idempotencyKey], where: sql`"idempotency_key" is not null` })
        .returning()
    : await tx.insert(crmTask).values(values).returning()
  if (!created) {
    const [existing] = await tx
      .select()
      .from(crmTask)
      .where(and(eq(crmTask.organizationId, orgId), eq(crmTask.idempotencyKey, idemKey ?? "")))
      .limit(1)
    if (!existing) throw new Error("Conflicto de idempotencia sin tarea existente")
    return withNames(tx, orgId, existing)
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.actorUserId ?? null,
    action: "task.created",
    entity: "task",
    entityId: created.id,
    metadata: { createdBy: input.createdBy, title, ...(input.createdBy !== "user" ? { origin: input.createdBy === "agent" ? "agent" : "system" } : {}) },
  })
  await notify(tx, { orgId, kind: "task.updated", at: new Date().toISOString() })
  return withNames(tx, orgId, created)
}

export async function updateTask(
  tx: Db,
  orgId: string,
  id: string,
  input: {
    title?: string
    dueAt?: string | null
    assigneeUserId?: string | null
    status?: string
    /** Sin responsable, a qué parte del equipo va. */
    area?: TaskArea | null
    contactId?: string | null
    conversationId?: string | null
    opportunityId?: string | null
    actorUserId?: string | null
  },
): Promise<TaskItem> {
  if (!isUuid(id)) throw notFound("Tarea")
  const [current] = await tx
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Tarea")
  const previousStatus = current.status
  const previousDueAt = current.dueAt ? current.dueAt.toISOString() : null
  const patch: Partial<typeof crmTask.$inferInsert> = { updatedAt: new Date() }
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (!title) throw validation("El título de la tarea es obligatorio")
    if (title.length > 200) throw validation("El título no puede superar 200 caracteres")
    patch.title = title
  }
  if (input.dueAt !== undefined) patch.dueAt = cleanDueAt(input.dueAt) ?? null
  if (input.assigneeUserId !== undefined) {
    patch.assigneeUserId = (await resolveTaskAssignee(tx, orgId, input.assigneeUserId)) ?? null
  }
  if (input.area !== undefined) {
    if (input.area !== null && !(TASK_AREAS as readonly string[]).includes(input.area)) throw validation("Área inválida")
    patch.area = input.area
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw validation("Estado inválido")
    patch.status = input.status
    // La cierra o la reabre una persona: ya no «se cerró sola».
    patch.settledReason = null
  }
  const linksChanged =
    input.contactId !== undefined || input.conversationId !== undefined || input.opportunityId !== undefined
  const next = {
    contactId: input.contactId !== undefined ? input.contactId : current.contactId,
    conversationId: input.conversationId !== undefined ? input.conversationId : current.conversationId,
    opportunityId: input.opportunityId !== undefined ? input.opportunityId : current.opportunityId,
  }
  if (linksChanged) {
    // Si se limpia el contacto pero quedan hilos, se revincula automáticamente;
    // si hay discrepancia se rechaza.
    const resolved = await resolveTaskContact(tx, orgId, next)
    if (next.contactId === null && resolved.contactId) next.contactId = resolved.contactId
    patch.contactId = next.contactId
    patch.conversationId = next.conversationId
    patch.opportunityId = next.opportunityId
  }
  // Reabrir o mover la tarea a una oportunidad respeta que sea la única abierta.
  const reopening = input.status === "open" && previousStatus !== "open"
  const movingOpp = input.opportunityId !== undefined && input.opportunityId !== current.opportunityId
  if (next.opportunityId && (reopening || movingOpp) && (patch.status ?? current.status) === "open") {
    const [other] = await tx
      .select({ id: crmTask.id, title: crmTask.title })
      .from(crmTask)
      .where(
        and(
          eq(crmTask.organizationId, orgId),
          eq(crmTask.opportunityId, next.opportunityId),
          eq(crmTask.status, "open"),
          sql`${crmTask.id} <> ${id}`,
        ),
      )
      .limit(1)
    if (other) {
      throw new ServiceError(
        "OPPORTUNITY_HAS_TASK",
        409,
        `Esta oportunidad ya tiene su tarea: «${other.title}». Márcala como hecha o cámbiala`,
      )
    }
  }
  const [updated] = await tx
    .update(crmTask)
    .set(patch)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Tarea")
  // Transición auditable para la actividad unificada (CrmActivity lee audit_event):
  // solo IDs y antes/después operativos, sin texto clínico.
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: input.actorUserId ?? null,
    action: "task.updated",
    entity: "task",
    entityId: id,
    metadata: {
      title: updated.title,
      statusPrev: previousStatus,
      statusNext: updated.status,
      dueAtPrev: previousDueAt,
      dueAtNext: updated.dueAt ? updated.dueAt.toISOString() : null,
      contactId: updated.contactId,
      conversationId: updated.conversationId,
      opportunityId: updated.opportunityId,
    },
  })
  await notify(tx, { orgId, kind: "task.updated", at: new Date().toISOString() })
  if (updated.opportunityId) await notify(tx, { orgId, kind: "opportunity.updated", at: new Date().toISOString() })
  // Completar la tarea de una derivación resuelve la conversación si no le
  // queda otro caso abierto (ADR 0024): despedida y cierre con `equipo`.
  if (previousStatus === "open" && updated.status === "done" && updated.conversationId) {
    await resolveAfterHandoffTask(tx, orgId, updated.id, input.actorUserId ?? null)
  }
  return withNames(tx, orgId, updated)
}

export async function completeTask(
  tx: Db,
  orgId: string,
  id: string,
  actor?: { userId: string | null },
): Promise<TaskItem> {
  return updateTask(tx, orgId, id, { status: "done", actorUserId: actor?.userId ?? null })
}

/**
 * Cierra sola una tarea cuyo motivo desapareció (la cita pasó, la persona
 * confirmó, la oportunidad se cerró, el presupuesto se decidió), diciendo por
 * qué. No toca una tarea ya cerrada ni la de un caso del agente: esa la
 * resuelve una persona (ADR 0024). Devuelve si la cerró.
 */
export async function settleTask(tx: Db, orgId: string, id: string, reason: string): Promise<boolean> {
  const [updated] = await tx
    .update(crmTask)
    .set({ status: "done", settledReason: reason.trim().slice(0, 300), updatedAt: new Date() })
    .where(
      and(
        eq(crmTask.id, id),
        eq(crmTask.organizationId, orgId),
        eq(crmTask.status, "open"),
        sql`not exists (select 1 from agent_handoff h where h.organization_id = ${orgId} and h.task_id = ${crmTask.id})`,
      ),
    )
    .returning({ id: crmTask.id, title: crmTask.title, opportunityId: crmTask.opportunityId })
  if (!updated) return false
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId: null,
    action: "task.settled",
    entity: "task",
    entityId: id,
    metadata: { title: updated.title, statusPrev: "open", statusNext: "done", origin: "system", opportunityId: updated.opportunityId },
  })
  await notify(tx, { orgId, kind: "task.updated", at: new Date().toISOString() })
  return true
}
