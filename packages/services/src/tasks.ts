import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { patient, patientContact } from "@odentia/db/schema/clinical"
import { contact, conversation, crmTask } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, or, sql } from "drizzle-orm"
import { notFound, validation } from "./errors.js"

/** Aviso en vivo para el stream (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notify(tx: Db, payload: { orgId: string; kind: string; at: string }): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

const STATUSES = ["open", "done", "cancelled"]
const CREATED_BY = ["user", "agent"]
const KINDS = ["manual", "opportunity_follow_up"] as const
export type TaskKind = (typeof KINDS)[number]

export interface TaskItem {
  id: string
  title: string
  contactId: string | null
  conversationId: string | null
  opportunityId: string | null
  /** Paciente al que se refiere la tarea (nulo si es solo comercial u operativa). */
  patientId: string | null
  kind: TaskKind
  assigneeUserId: string | null
  dueAt: string | null
  status: string
  createdBy: string
  /** Nombre del paciente (nulo sin patients.read en la API o sin vínculo). */
  patientName: string | null
  /** Nombre del contacto (nulo sin crm.read en la API o sin vínculo). */
  contactName: string | null
  /** Título de la oportunidad vinculada (nulo sin crm.read en la API o sin vínculo). */
  opportunityTitle: string | null
}

function toItem(
  row: typeof crmTask.$inferSelect,
  contactName: string | null = null,
  opportunityTitle: string | null = null,
  patientName: string | null = null,
): TaskItem {
  const rawKind: string = row.kind
  const kind: TaskKind = rawKind === "opportunity_follow_up" ? "opportunity_follow_up" : "manual"
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    conversationId: row.conversationId,
    opportunityId: row.opportunityId,
    patientId: row.patientId,
    kind,
    assigneeUserId: row.assigneeUserId,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    status: row.status,
    createdBy: row.createdBy,
    patientName,
    contactName,
    opportunityTitle,
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
  if (Number.isNaN(parsed.getTime())) throw validation("dueAt inválido")
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
    .select({ id: opportunity.id, contactId: opportunity.contactId })
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

async function withNames(
  tx: Db,
  orgId: string,
  row: typeof crmTask.$inferSelect,
): Promise<TaskItem> {
  const oppId: string | null = row.opportunityId
  const patientId: string | null = row.patientId
  const [patientRow] = patientId
    ? await tx
        .select({ displayName: patient.displayName })
        .from(patient)
        .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
        .limit(1)
    : []
  const [contactRow, oppRow] = await Promise.all([
    row.contactId
      ? tx
          .select({ displayName: contact.displayName })
          .from(contact)
          .where(and(eq(contact.id, row.contactId), eq(contact.organizationId, orgId)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    oppId
      ? tx
          .select({ title: opportunity.title })
          .from(opportunity)
          .where(and(eq(opportunity.id, oppId), eq(opportunity.organizationId, orgId)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ])
  return toItem(
    row,
    contactRow?.displayName ?? null,
    oppRow?.title ?? null,
    patientRow?.displayName ?? null,
  )
}

export async function getTask(tx: Db, orgId: string, id: string): Promise<TaskItem> {
  if (!isUuid(id)) throw validation("Identificador de tarea inválido")
  const [row] = await tx.select().from(crmTask)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId))).limit(1)
  if (!row) throw notFound("Tarea")
  return withNames(tx, orgId, row)
}

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
    const [own] = await tx
      .select({ contactId: patientContact.contactId })
      .from(patientContact)
      .where(
        and(
          eq(patientContact.organizationId, orgId),
          eq(patientContact.patientId, input.patientId),
          eq(patientContact.relationship, "self"),
        ),
      )
      .limit(1)
    const ofPerson = own
      ? or(eq(crmTask.patientId, input.patientId), eq(crmTask.contactId, own.contactId))
      : eq(crmTask.patientId, input.patientId)
    if (ofPerson) conditions.push(ofPerson)
  }
  if (input.overdue === true) {
    conditions.push(eq(crmTask.status, "open"))
    conditions.push(sql`${crmTask.dueAt} is not null and ${crmTask.dueAt} <= now()`)
  } else if (input.overdue === false) {
    conditions.push(
      sql`not (${crmTask.status} = 'open' and ${crmTask.dueAt} is not null and ${crmTask.dueAt} <= now())`,
    )
  }
  const rows = await tx
    .select({
      task: crmTask,
      contactName: contact.displayName,
      opportunityTitle: opportunity.title,
      patientName: patient.displayName,
    })
    .from(crmTask)
    .leftJoin(patient, and(eq(patient.id, crmTask.patientId), eq(patient.organizationId, orgId)))
    .leftJoin(
      contact,
      and(eq(contact.id, crmTask.contactId), eq(contact.organizationId, orgId)),
    )
    .leftJoin(
      opportunity,
      and(eq(opportunity.id, crmTask.opportunityId), eq(opportunity.organizationId, orgId)),
    )
    .where(and(...conditions))
    .orderBy(asc(crmTask.dueAt), desc(crmTask.createdAt))
  return rows.map((r) => toItem(r.task, r.contactName, r.opportunityTitle, r.patientName))
}

export async function createTask(
  tx: Db,
  orgId: string,
  input: {
    title: string
    contactId?: string | null
    conversationId?: string | null
    opportunityId?: string | null
    /** Paciente al que se refiere la tarea; debe ser de la organización. */
    patientId?: string | null
    assigneeUserId?: string | null
    dueAt?: string | null
    createdBy: string
    kind?: TaskKind
    /** Clave estable por trigger (agente): la reentrega no duplica la tarea. */
    idempotencyKey?: string | null
    /** Usuario real que crea la tarea; nulo cuando es el agente. */
    actorUserId?: string | null
  },
): Promise<TaskItem> {
  const title = input.title.trim()
  if (!title) throw validation("El título de la tarea es obligatorio")
  if (title.length > 200) throw validation("El título no puede superar 200 caracteres")
  if (!CREATED_BY.includes(input.createdBy)) throw validation("createdBy inválido (user|agent)")
  const kind: TaskKind = input.kind ?? "manual"
  if (!KINDS.includes(kind)) throw validation("kind inválido (manual|opportunity_follow_up)")
  if (kind === "opportunity_follow_up" && !input.opportunityId) {
    throw validation("El seguimiento comercial exige opportunityId")
  }
  const dueAt = cleanDueAt(input.dueAt) ?? null
  const idemKey = input.idempotencyKey?.trim() ? input.idempotencyKey.trim().slice(0, 120) : null
  const assignee = await resolveTaskAssignee(tx, orgId, input.assigneeUserId)
  const links = await resolveTaskContact(tx, orgId, {
    contactId: input.contactId ?? null,
    conversationId: input.conversationId ?? null,
    opportunityId: input.opportunityId ?? null,
  })
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
  const values = {
    organizationId: orgId,
    title,
    patientId,
    contactId: links.contactId,
    conversationId: links.conversationId,
    opportunityId: links.opportunityId,
    assigneeUserId: assignee ?? null,
    dueAt,
    kind,
    createdBy: input.createdBy,
    idempotencyKey: idemKey,
  }
  // El índice único es parcial (solo claves no nulas): el upsert aplica solo
  // cuando el llamador trae clave estable (agente); el resto inserta directo.
  const [created] = idemKey
    ? await tx
        .insert(crmTask)
        .values(values)
        .onConflictDoNothing({
          target: [crmTask.organizationId, crmTask.idempotencyKey],
          where: sql`"idempotency_key" is not null`,
        })
        .returning()
    : await tx.insert(crmTask).values(values).returning()
  if (!created) {
    // Reentrega del mismo trigger: devuelve la tarea ya creada, sin duplicar.
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
    metadata: { createdBy: input.createdBy, kind, title },
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
    contactId?: string | null
    conversationId?: string | null
    opportunityId?: string | null
    actorUserId?: string | null
  },
): Promise<TaskItem> {
  // Lectura sin lock para decidir el orden de bloqueo.
  const [peek] = await tx
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .limit(1)
  if (!peek) throw notFound("Tarea")
  const mayClear = peek.kind === "opportunity_follow_up" && peek.opportunityId !== null
    && (input.status === "done" || input.status === "cancelled") && peek.status === "open"
  // Mismo orden que syncOpportunityFollowUp (opp antes que task): primero la
  // oportunidad, luego relectura de la tarea FOR UPDATE.
  if (mayClear && peek.opportunityId) {
    const [oppLock] = await tx
      .select({ id: opportunity.id })
      .from(opportunity)
      .where(and(eq(opportunity.id, peek.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
      .for("update")
    if (!oppLock) throw notFound("Oportunidad")
  }
  const [current] = await tx
    .select()
    .from(crmTask)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!current) throw notFound("Tarea")
  if (current.kind === "opportunity_follow_up") {
    if (input.title !== undefined || input.dueAt !== undefined || input.assigneeUserId !== undefined ||
      input.contactId !== undefined || input.conversationId !== undefined || input.opportunityId !== undefined) {
      throw validation("Edita la próxima acción y su responsable desde la oportunidad vinculada")
    }
    if (input.status === "open" && current.status !== "open") {
      throw validation("Programa una nueva próxima acción desde la oportunidad vinculada")
    }
  }
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
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw validation("Estado inválido")
    patch.status = input.status
  }
  const linksChanged =
    input.contactId !== undefined ||
    input.conversationId !== undefined ||
    input.opportunityId !== undefined
  if (linksChanged) {
    const currentLinks = {
      contactId: current.contactId,
      conversationId: current.conversationId,
      opportunityId: current.opportunityId,
    }
    const next = {
      contactId: input.contactId !== undefined ? input.contactId : currentLinks.contactId,
      conversationId:
        input.conversationId !== undefined ? input.conversationId : currentLinks.conversationId,
      opportunityId:
        input.opportunityId !== undefined ? input.opportunityId : currentLinks.opportunityId,
    }
    // Si se limpia el contacto pero quedan hilos, se revincula automáticamente;
    // si hay discrepancia se rechaza.
    if (next.contactId === null && (next.conversationId || next.opportunityId)) {
      const resolved = await resolveTaskContact(tx, orgId, {
        contactId: null,
        conversationId: next.conversationId,
        opportunityId: next.opportunityId,
      })
      // resolveTaskContact con contactId null autovincula; si no hay vínculo válido falla.
      if (resolved.contactId) next.contactId = resolved.contactId
    } else {
      await resolveTaskContact(tx, orgId, next)
    }
    patch.contactId = next.contactId
    patch.conversationId = next.conversationId
    patch.opportunityId = next.opportunityId
  }
  const [updated] = await tx
    .update(crmTask)
    .set(patch)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Tarea")
  // Completar el seguimiento vigente limpia la próxima acción de su oportunidad
  // con UPDATE condicional exacto (opp.next_action_at = task.due_at); la tarea
  // vieja (stale) no toca nada. Sin comparar Date.getTime en JS.
  const updatedOppId: string | null = updated.opportunityId
  if (
    updated.kind === "opportunity_follow_up" &&
    updatedOppId &&
    previousStatus === "open" &&
    (updated.status === "done" || updated.status === "cancelled") &&
    updated.dueAt !== null
  ) {
    const [cleared] = await tx
      .update(opportunity)
      .set({ nextActionAt: null, nextActionNote: null, updatedAt: new Date() })
      .where(
        and(
          eq(opportunity.id, updatedOppId),
          eq(opportunity.organizationId, orgId),
          sql`${opportunity.nextActionAt} = (select due_at from task where id = ${updated.id} and organization_id = ${orgId})`,
        ),
      )
      .returning({ id: opportunity.id })
    if (cleared) {
      await notify(tx, { orgId, kind: "opportunity.updated", at: new Date().toISOString() })
    }
  }
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
