import type { Db } from "@odentia/db"
import { crmTask } from "@odentia/db/schema/crm"
import { and, asc, desc, eq } from "drizzle-orm"
import { notFound, validation } from "./errors.js"

const STATUSES = ["open", "done", "cancelled"]
const CREATED_BY = ["user", "agent"]

export interface TaskItem {
  id: string
  title: string
  contactId: string | null
  conversationId: string | null
  assigneeUserId: string | null
  dueAt: string | null
  status: string
  createdBy: string
}

function toItem(row: typeof crmTask.$inferSelect): TaskItem {
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    conversationId: row.conversationId,
    assigneeUserId: row.assigneeUserId,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    status: row.status,
    createdBy: row.createdBy,
  }
}

export async function listTasks(
  tx: Db,
  orgId: string,
  input: { status?: string; assignee?: string },
): Promise<TaskItem[]> {
  const conditions = [eq(crmTask.organizationId, orgId)]
  if (input.status) {
    if (!STATUSES.includes(input.status)) throw validation("Estado inválido")
    conditions.push(eq(crmTask.status, input.status))
  }
  if (input.assignee) conditions.push(eq(crmTask.assigneeUserId, input.assignee))
  const rows = await tx
    .select()
    .from(crmTask)
    .where(and(...conditions))
    .orderBy(asc(crmTask.dueAt), desc(crmTask.createdAt))
  return rows.map(toItem)
}

export async function createTask(
  tx: Db,
  orgId: string,
  input: {
    title: string
    contactId?: string | null
    conversationId?: string | null
    assigneeUserId?: string | null
    dueAt?: string | null
    createdBy: string
  },
): Promise<TaskItem> {
  const title = input.title.trim()
  if (!title) throw validation("El título de la tarea es obligatorio")
  if (!CREATED_BY.includes(input.createdBy)) throw validation("createdBy inválido (user|agent)")
  let dueAt: Date | null = null
  if (input.dueAt) {
    dueAt = new Date(input.dueAt)
    if (Number.isNaN(dueAt.getTime())) throw validation("dueAt inválido")
  }
  const [created] = await tx
    .insert(crmTask)
    .values({
      organizationId: orgId,
      title,
      contactId: input.contactId ?? null,
      conversationId: input.conversationId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      dueAt,
      createdBy: input.createdBy,
    })
    .returning()
  if (!created) throw new Error("No se pudo crear la tarea")
  return toItem(created)
}

export async function updateTask(
  tx: Db,
  orgId: string,
  id: string,
  input: { title?: string; dueAt?: string | null; assigneeUserId?: string | null; status?: string },
): Promise<TaskItem> {
  const patch: Partial<typeof crmTask.$inferInsert> = { updatedAt: new Date() }
  if (input.title !== undefined) {
    const title = input.title.trim()
    if (!title) throw validation("El título de la tarea es obligatorio")
    patch.title = title
  }
  if (input.dueAt !== undefined) {
    if (input.dueAt === null) {
      patch.dueAt = null
    } else {
      const dueAt = new Date(input.dueAt)
      if (Number.isNaN(dueAt.getTime())) throw validation("dueAt inválido")
      patch.dueAt = dueAt
    }
  }
  if (input.assigneeUserId !== undefined) patch.assigneeUserId = input.assigneeUserId
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw validation("Estado inválido")
    patch.status = input.status
  }
  const [updated] = await tx
    .update(crmTask)
    .set(patch)
    .where(and(eq(crmTask.id, id), eq(crmTask.organizationId, orgId)))
    .returning()
  if (!updated) throw notFound("Tarea")
  return toItem(updated)
}

export async function completeTask(tx: Db, orgId: string, id: string): Promise<TaskItem> {
  return updateTask(tx, orgId, id, { status: "done" })
}
