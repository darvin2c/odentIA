import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import {
  patient,
  patientContact,
  serviceCatalog,
  treatmentBudget,
} from "@odentia/db/schema/clinical"
import { contact, conversation, crmTask, pipeline, pipelineStage } from "@odentia/db/schema/crm"
import {
  opportunity,
  opportunityEvent,
  OPPORTUNITY_STATUSES,
  type OpportunityStatus,
} from "@odentia/db/schema/opportunities"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm"
import { requireContact } from "./contacts.js"
import { notFound, validation } from "./errors.js"
import { findOrgCurrency, NO_CURRENCY, requireOrgCurrency } from "./locale.js"
import { requirePatient } from "./patients.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { createWorkspaceNotification } from "./workspace.js"

export type { OpportunityStatus }
export const OPPORTUNITY_STATUS_LIST: OpportunityStatus[] = [...OPPORTUNITY_STATUSES]

/** Motivo de cierre: texto corto obligatorio al ganar o perder. */
const CLOSE_REASON_MAX = 500

/** Aviso mínimo CRM para refresco: solo `{ orgId, kind, at }`, sin PII. */
async function notifyOpp(tx: Db, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "opportunity.updated", at: new Date().toISOString() })})`,
  )
}

export interface OpportunityListItem {
  id: string
  title: string
  contactId: string
  contactName: string
  patientId: string | null
  patientName: string | null
  pipelineId: string
  stageId: string
  stageName: string
  stageKind: string
  status: OpportunityStatus
  amountCents: number | null
  currency: string
  interestText: string | null
  serviceName: string | null
  assignedUserId: string | null
  nextActionAt: string | null
  nextActionNote: string | null
  conversationId: string | null
  createdAt: string
  updatedAt: string
}

export interface OpportunityDetail extends OpportunityListItem {
  contactPhone: string | null
  contactEmail: string | null
  serviceId: string | null
  nextActionNote: string | null
  closedAt: string | null
  closeReason: string | null
  budgetId: string | null
  budgetTitle: string | null
  budgetStatus: string | null
  createdAt: string
  history: Array<{
    id: string
    action: string
    fromStageId: string | null
    toStageId: string | null
    actorUserId: string | null
    note: string | null
    createdAt: string
  }>
}

export interface OpportunityFilters {
  q?: string
  contactId?: string
  patientId?: string
  pipelineId?: string
  stageId?: string
  status?: OpportunityStatus
  assignedUserId?: string
  /** Solo con próxima acción vencida o sin fecha (para seguimiento). */
  nextActionDue?: boolean
  cursor?: string
  limit?: number
}

export interface CreateOpportunityInput {
  contactId: string
  patientId?: string | null
  pipelineId?: string
  stageId?: string
  title: string
  serviceId?: string | null
  interestText?: string | null
  amountCents?: number | null
  currency?: string
  assignedUserId?: string | null
  nextActionAt?: string | null
  nextActionNote?: string | null
  budgetId?: string | null
  conversationId?: string | null
}

export interface UpdateOpportunityInput {
  contactId?: string
  patientId?: string | null
  title?: string
  serviceId?: string | null
  interestText?: string | null
  amountCents?: number | null
  currency?: string
  assignedUserId?: string | null
  nextActionAt?: string | null
  nextActionNote?: string | null
  budgetId?: string | null
  conversationId?: string | null
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

function asStatus(value: string): OpportunityStatus {
  if (value === "won" || value === "lost" || value === "open") return value
  throw validation("Estado de oportunidad inválido")
}

/** Etapa válida de la org; si no se indica, la primera del pipeline default. */
async function resolveStage(
  tx: Db,
  orgId: string,
  stageId: string | undefined,
  pipelineId: string | undefined,
): Promise<{ pipelineId: string; stageId: string; kind: string }> {
  if (stageId) {
    const [stage] = await tx
      .select()
      .from(pipelineStage)
      .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
      .limit(1)
    if (!stage) throw validation("Etapa inválida para esta organización")
    if (pipelineId && stage.pipelineId !== pipelineId) {
      throw validation("La etapa no pertenece al pipeline indicado")
    }
    return { pipelineId: stage.pipelineId, stageId: stage.id, kind: stage.kind }
  }
  if (pipelineId) {
    const [pipe] = await tx
      .select({ id: pipeline.id })
      .from(pipeline)
      .where(and(eq(pipeline.id, pipelineId), eq(pipeline.organizationId, orgId)))
      .limit(1)
    if (!pipe) throw validation("Pipeline inválido para esta organización")
    const [first] = await tx
      .select()
      .from(pipelineStage)
      .where(eq(pipelineStage.pipelineId, pipe.id))
      .orderBy(asc(pipelineStage.position))
      .limit(1)
    if (!first) throw validation("El pipeline no tiene etapas")
    return { pipelineId: pipe.id, stageId: first.id, kind: first.kind }
  }
  const ensured = await ensureDefaultPipeline(tx, orgId)
  const first = ensured.stages[0]
  if (!first) throw new Error("Pipeline default sin etapas")
  return { pipelineId: ensured.pipelineId, stageId: first.id, kind: first.kind }
}

async function requireOpportunity(tx: Db, orgId: string, id: string, forUpdate = false) {
  const query = tx
    .select()
    .from(opportunity)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
    .limit(1)
    .$dynamic()
  const [row] = forUpdate ? await query.for("update") : await query
  if (!row) throw notFound("Oportunidad")
  return row
}

async function requireStageInOrg(tx: Db, orgId: string, stageId: string) {
  const [stage] = await tx
    .select()
    .from(pipelineStage)
    .where(and(eq(pipelineStage.id, stageId), eq(pipelineStage.organizationId, orgId)))
    .limit(1)
  if (!stage) throw validation("Etapa inválida para esta organización")
  return stage
}

/** El asignado debe ser miembro de la org; null libera la asignación. */
async function resolveAssignee(
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

function cleanTitle(title: string): string {
  const value = title.trim()
  if (!value || value.length > 200) throw validation("El título debe tener 1–200 caracteres")
  return value
}

function cleanAmount(amountCents: number | null | undefined): number | null | undefined {
  if (amountCents === undefined || amountCents === null) return amountCents ?? null
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw validation("El valor debe ser un entero de céntimos >= 0")
  }
  return amountCents
}

function cleanCurrency(currency: string | undefined): string | undefined {
  if (currency === undefined) return undefined
  const value = currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(value)) throw validation("La moneda debe ser un código ISO de 3 letras")
  return value
}

function cleanNextActionAt(nextActionAt: string | null | undefined): Date | null | undefined {
  if (nextActionAt === undefined) return undefined
  if (nextActionAt === null) return null
  const date = new Date(nextActionAt)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(nextActionAt) || !Number.isFinite(date.getTime())) {
    throw validation("La próxima acción debe ser fecha ISO con hora")
  }
  return date
}

function cleanNote(note: string | null | undefined, max: number, field: string) {
  if (note === undefined) return undefined
  if (note === null) return null
  const value = note.trim()
  if (!value) return null
  if (value.length > max) throw validation(`${field} no puede superar ${max} caracteres`)
  return value
}

/** Servicio de catálogo de la org o null; valida pertenencia al tenant. */
async function resolveService(
  tx: Db,
  orgId: string,
  serviceId: string | null | undefined,
): Promise<string | null | undefined> {
  if (serviceId === undefined) return undefined
  if (serviceId === null) return null
  const [service] = await tx
    .select({ id: serviceCatalog.id })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.id, serviceId), eq(serviceCatalog.organizationId, orgId)))
    .limit(1)
  if (!service) throw validation("Servicio inválido para esta organización")
  return service.id
}

/**
 * Presupuesto de la org; si la oportunidad ya tiene paciente, el presupuesto
 * debe ser del mismo paciente (no mezclar economía de dos fichas clínicas).
 */
async function resolveBudget(
  tx: Db,
  orgId: string,
  budgetId: string | null | undefined,
  patientId: string | null | undefined,
): Promise<string | null | undefined> {
  if (budgetId === undefined) return undefined
  if (budgetId === null) return null
  const [budget] = await tx
    .select({ id: treatmentBudget.id, patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  if (!budget) throw validation("Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
  }
  return budget.id
}

/** Conversación de la org con su contacto dueño. */
async function requireConversationInOrg(tx: Db, orgId: string, id: string) {
  const [row] = await tx
    .select({ id: conversation.id, contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.id, id), eq(conversation.organizationId, orgId)))
    .limit(1)
  if (!row) throw notFound("Conversación")
  return row
}

/** El paciente debe estar vinculado al contacto (patient_contact), sin duplicar fichas. */
async function requirePatientLink(tx: Db, orgId: string, patientId: string, contactId: string): Promise<void> {
  const [link] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.contactId, contactId),
      ),
    )
    .limit(1)
  if (!link) throw validation("El paciente no está vinculado a este contacto")
}

/** Presupuesto efectivo coherente con el paciente efectivo (también al cambiar patientId). */
async function assertBudgetCoherent(
  tx: Db,
  orgId: string,
  budgetId: string | null,
  patientId: string | null,
): Promise<void> {
  if (!budgetId) return
  const [budget] = await tx
    .select({ id: treatmentBudget.id, patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  if (!budget) throw validation("Presupuesto inválido para esta organización")
  if (patientId && budget.patientId !== patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
  }
  if (!patientId && budget.patientId) {
    throw validation("El presupuesto pertenece a otro paciente")
  }
}

/** Valida el hilo origen: debe ser de la org y del mismo contacto de la oportunidad. */
async function resolveOpportunityConversation(
  tx: Db,
  orgId: string,
  conversationId: string | null | undefined,
  effectiveContactId: string,
): Promise<string | null | undefined> {
  if (conversationId === undefined) return undefined
  if (conversationId === null) return null
  const row = await requireConversationInOrg(tx, orgId, conversationId)
  if (row.contactId !== effectiveContactId) {
    throw validation("La conversación pertenece a otro contacto")
  }
  return row.id
}

/** Título del seguimiento: nota de próxima acción o título de la oportunidad (máx 200). */
function followUpTitle(nextActionNote: string | null, opportunityTitle: string): string {
  const note = nextActionNote?.trim() ? nextActionNote.trim() : opportunityTitle.trim()
  return note.slice(0, 200) || opportunityTitle.slice(0, 200)
}

/**
 * Sincroniza la próxima acción con una tarea durable kind=opportunity_follow_up.
 * Un seguimiento abierto por oportunidad (único parcial en migración).
 * Idempotente y transaccional; nunca reactiva tareas canceladas.
 */
async function syncOpportunityFollowUp(
  tx: Db,
  orgId: string,
  opp: typeof opportunity.$inferSelect,
  actorUserId: string | null,
): Promise<void> {
  // La oportunidad ya viene bloqueada por el llamador (require FOR UPDATE en
  // update, fila recién insertada en create): se bloquea la tarea DESPUÉS,
  // mismo orden que updateTask (opp antes que task) para noDeadlock.
  if (opp.status !== "open" || !opp.nextActionAt) {
    // Eliminar fecha o cerrar cancela el seguimiento abierto.
    await cancelOpportunityFollowUp(tx, orgId, opp.id, actorUserId)
    return
  }
  const [open] = await tx
    .select()
    .from(crmTask)
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.opportunityId, opp.id),
        eq(crmTask.kind, "opportunity_follow_up"),
        eq(crmTask.status, "open"),
      ),
    )
    .limit(1)
    .for("update")
  const title = followUpTitle(opp.nextActionNote, opp.title)
  if (open) {
    const [updated] = await tx
      .update(crmTask)
      .set({
        title,
        contactId: opp.contactId,
        conversationId: opp.conversationId,
        assigneeUserId: opp.assignedUserId,
        dueAt: sql`(select next_action_at from opportunity where id = ${opp.id} and organization_id = ${orgId})`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(crmTask.id, open.id),
        eq(crmTask.organizationId, orgId),
        sql`(${crmTask.title}, ${crmTask.contactId}, ${crmTask.conversationId}, ${crmTask.assigneeUserId}, ${crmTask.dueAt})
          is distinct from (${title}, ${opp.contactId}, ${opp.conversationId}, ${opp.assignedUserId},
            (select next_action_at from opportunity where id = ${opp.id} and organization_id = ${orgId}))`,
      ))
      .returning()
    if (updated) await auditFollowUp(tx, orgId, actorUserId, open, updated)
    return
  }
  // Sin catch 23505 (continuar la tx abortada es inválido): un solo UPSERT
  // contra el único parcial; la concurrencia ya está serializada por el lock
  // de oportunidad que conserva el llamador.
  await tx.execute(sql`
    insert into "task"
      ("organization_id", "title", "contact_id", "conversation_id", "opportunity_id",
       "assignee_user_id", "due_at", "status", "kind", "created_by")
    select organization_id, ${title}, contact_id, conversation_id, id,
      assigned_user_id, next_action_at, 'open', 'opportunity_follow_up', 'user'
    from opportunity where id = ${opp.id} and organization_id = ${orgId}
    on conflict ("organization_id", "opportunity_id")
      where "opportunity_id" is not null and "kind" = 'opportunity_follow_up' and "status" = 'open'
    do update set
      "title" = excluded."title",
      "contact_id" = excluded."contact_id",
      "conversation_id" = excluded."conversation_id",
      "assignee_user_id" = excluded."assignee_user_id",
      "due_at" = excluded."due_at",
      "updated_at" = now()
  `)
}

/** Cancela el seguimiento abierto de la oportunidad (cierre o limpieza de fecha). */
async function cancelOpportunityFollowUp(
  tx: Db,
  orgId: string,
  opportunityId: string,
  actorUserId: string | null,
): Promise<void> {
  const [current] = await tx.select().from(crmTask).where(and(
    eq(crmTask.organizationId, orgId),
    eq(crmTask.opportunityId, opportunityId),
    eq(crmTask.kind, "opportunity_follow_up"),
    eq(crmTask.status, "open"),
  )).for("update").limit(1)
  if (!current) return
  const [updated] = await tx
    .update(crmTask)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.opportunityId, opportunityId),
        eq(crmTask.kind, "opportunity_follow_up"),
        eq(crmTask.status, "open"),
      ),
    )
    .returning()
  if (updated) await auditFollowUp(tx, orgId, actorUserId, current, updated)
}

/** Mismo contrato de transición que las tareas manuales para la actividad del caso. */
async function auditFollowUp(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  previous: typeof crmTask.$inferSelect,
  updated: typeof crmTask.$inferSelect,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "task.updated",
    entity: "task",
    entityId: updated.id,
    metadata: {
      title: updated.title,
      statusPrev: previous.status,
      statusNext: updated.status,
      dueAtPrev: previous.dueAt?.toISOString() ?? null,
      dueAtNext: updated.dueAt?.toISOString() ?? null,
      assigneeUserIdPrev: previous.assigneeUserId,
      assigneeUserIdNext: updated.assigneeUserId,
      contactId: updated.contactId,
      conversationId: updated.conversationId,
      opportunityId: updated.opportunityId,
    },
  })
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({
    orgId, kind: "task.updated", at: new Date().toISOString(),
  })})`)
}

async function auditOpportunity(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "opportunity",
    entityId,
    metadata: metadata as Record<string, unknown> | null,
  })
}

async function recordEvent(
  tx: Db,
  orgId: string,
  opportunityId: string,
  action: string,
  fromStageId: string | null,
  toStageId: string | null,
  actorUserId: string | null,
  note: string | null,
): Promise<void> {
  await tx.insert(opportunityEvent).values({
    organizationId: orgId,
    opportunityId,
    action,
    fromStageId,
    toStageId,
    actorUserId,
    note,
  })
}

async function notifyAssignee(
  tx: Db,
  orgId: string,
  assignedUserId: string | null,
  dedupeKey: string,
  title: string,
  body: string,
  href: string,
): Promise<void> {
  if (!assignedUserId) return
  await createWorkspaceNotification(tx, orgId, {
    userId: assignedUserId,
    dedupeKey,
    title,
    body,
    href,
    permission: "crm.read",
  })
}

const PAGE_DEFAULT = 30

function listingFingerprint(input: {
  q: string
  contactId: string
  patientId: string
  pipelineId: string
  stageId: string
  status: string
  assignedUserId: string
  nextActionDue: boolean
}): string {
  return JSON.stringify(input)
}

function encodeCursor(ts: string, id: string, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ ts, id, f: fingerprint }), "utf8").toString("base64url")
}

function decodeCursor(cursor: string): { ts: string; id: string; f: string } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { ts: string; id: string; f: string }
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string") return null
    return parsed
  } catch {
    return null
  }
}

export async function listOpportunities(
  tx: Db,
  orgId: string,
  input: OpportunityFilters,
): Promise<{ items: OpportunityListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  const q = input.q?.trim() ? input.q.trim() : ""
  const contactId = input.contactId ?? ""
  const patientId = input.patientId ?? ""
  const pipelineId = input.pipelineId ?? ""
  const stageId = input.stageId ?? ""
  const status = input.status ?? ""
  const assignedUserId = input.assignedUserId ?? ""
  const nextActionDue = input.nextActionDue ?? false
  if (status && !OPPORTUNITY_STATUSES.includes(status)) {
    throw validation("Estado de oportunidad inválido")
  }
  const fingerprint = listingFingerprint({
    q,
    contactId,
    patientId,
    pipelineId,
    stageId,
    status,
    assignedUserId,
    nextActionDue,
  })
  const conditions = [eq(opportunity.organizationId, orgId)]
  if (q) {
    const like = `%${q}%`
    conditions.push(
      or(ilike(opportunity.title, like), ilike(opportunity.interestText, like))!,
    )
  }
  if (contactId) conditions.push(eq(opportunity.contactId, contactId))
  if (patientId) conditions.push(eq(opportunity.patientId, patientId))
  if (pipelineId) conditions.push(eq(opportunity.pipelineId, pipelineId))
  if (stageId) conditions.push(eq(opportunity.stageId, stageId))
  if (status) conditions.push(eq(opportunity.status, status))
  if (assignedUserId) conditions.push(eq(opportunity.assignedUserId, assignedUserId))
  if (nextActionDue) {
    conditions.push(
      or(
        sql`"next_action_at" <= now()`,
        and(sql`"next_action_at" is null`, eq(opportunity.status, "open")),
      )!,
    )
  }
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (!decoded || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw validation("Cursor inválido")
    if (decoded.f !== fingerprint) {
      throw validation("El cursor no corresponde a los filtros actuales")
    }
    const ts = new Date(decoded.ts)
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido")
    conditions.push(
      or(
        lt(opportunity.updatedAt, sql`${decoded.ts}::timestamptz`),
        and(eq(opportunity.updatedAt, sql`${decoded.ts}::timestamptz`), lt(opportunity.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select({
      opp: opportunity,
      contactName: contact.displayName,
      patientName: patient.displayName,
      stageName: pipelineStage.name,
      stageKind: pipelineStage.kind,
      serviceName: serviceCatalog.name,
      cursorAt: sql<string>`to_char(${opportunity.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(opportunity)
    .innerJoin(
      contact,
      and(eq(contact.id, opportunity.contactId), eq(contact.organizationId, orgId)),
    )
    .leftJoin(
      patient,
      and(eq(patient.id, opportunity.patientId), eq(patient.organizationId, orgId)),
    )
    .innerJoin(pipelineStage, eq(pipelineStage.id, opportunity.stageId))
    .leftJoin(serviceCatalog, eq(serviceCatalog.id, opportunity.serviceId))
    .where(and(...conditions))
    .orderBy(desc(opportunity.updatedAt), desc(opportunity.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const items: OpportunityListItem[] = page.map((r) => ({
    id: r.opp.id,
    title: r.opp.title,
    contactId: r.opp.contactId,
    contactName: r.contactName,
    patientId: r.opp.patientId,
    patientName: r.patientName,
    pipelineId: r.opp.pipelineId,
    stageId: r.opp.stageId,
    stageName: r.stageName,
    stageKind: r.stageKind,
    status: asStatus(r.opp.status),
    amountCents: r.opp.amountCents,
    currency: r.opp.currency,
    interestText: r.opp.interestText,
    serviceName: r.serviceName,
    assignedUserId: r.opp.assignedUserId,
    nextActionAt: iso(r.opp.nextActionAt),
    nextActionNote: r.opp.nextActionNote,
    conversationId: r.opp.conversationId,
    createdAt: r.opp.createdAt.toISOString(),
    updatedAt: r.opp.updatedAt.toISOString(),
  }))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(last.cursorAt, last.opp.id, fingerprint)
      : null
  return { items, nextCursor }
}

export interface OpportunitySummaryStage {
  stageId: string
  count: number
  amounts: Array<{ currency: string; amountCents: string }>
}

export interface OpportunitySummary {
  total: number
  stages: OpportunitySummaryStage[]
}

/** Resumen agregado por filtros (mismos filtros de lista, sin cursor/limit). */
export async function getOpportunitySummary(
  tx: Db,
  orgId: string,
  input: Omit<OpportunityFilters, "cursor" | "limit">,
): Promise<OpportunitySummary> {
  const q = input.q?.trim() ? input.q.trim() : ""
  if (input.status && !OPPORTUNITY_STATUSES.includes(input.status)) {
    throw validation("Estado de oportunidad inválido")
  }
  const conditions = [eq(opportunity.organizationId, orgId)]
  if (q) {
    const like = `%${q}%`
    conditions.push(
      or(ilike(opportunity.title, like), ilike(opportunity.interestText, like))!,
    )
  }
  if (input.contactId) conditions.push(eq(opportunity.contactId, input.contactId))
  if (input.patientId) conditions.push(eq(opportunity.patientId, input.patientId))
  if (input.pipelineId) conditions.push(eq(opportunity.pipelineId, input.pipelineId))
  if (input.stageId) conditions.push(eq(opportunity.stageId, input.stageId))
  if (input.status) conditions.push(eq(opportunity.status, input.status))
  if (input.assignedUserId) conditions.push(eq(opportunity.assignedUserId, input.assignedUserId))
  if (input.nextActionDue) {
    conditions.push(
      or(
        sql`"next_action_at" <= now()`,
        and(sql`"next_action_at" is null`, eq(opportunity.status, "open")),
      )!,
    )
  }
  const where = and(...conditions)
  const [totalRow] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(opportunity)
    .where(where)
  const total = totalRow?.count ?? 0
  if (total === 0) return { total: 0, stages: [] }
  const grouped = await tx
    .select({
      stageId: opportunity.stageId,
      currency: opportunity.currency,
      count: sql<number>`count(*)::int`,
      totalCents: sql<string>`coalesce(sum("amount_cents"), 0)::text`,
    })
    .from(opportunity)
    .where(where)
    .groupBy(opportunity.stageId, opportunity.currency)
  const byStage = new Map<string, { count: number; amounts: Array<{ currency: string; amountCents: string }> }>()
  for (const row of grouped) {
    const entry = byStage.get(row.stageId) ?? { count: 0, amounts: [] }
    entry.count += row.count
    entry.amounts.push({ currency: row.currency, amountCents: row.totalCents })
    byStage.set(row.stageId, entry)
  }
  // Ordenar por posición del pipeline para un resumen estable.
  const stageIds = [...byStage.keys()]
  const stagesMeta = stageIds.length
    ? await tx
        .select({
          id: pipelineStage.id,
          pipelineId: pipelineStage.pipelineId,
          position: pipelineStage.position,
        })
        .from(pipelineStage)
        .where(and(eq(pipelineStage.organizationId, orgId)))
    : []
  const posById = new Map(stagesMeta.map((s) => [s.id, s] as const))
  const stages: OpportunitySummaryStage[] = [...byStage.entries()].map(([stageId, v]) => ({
    stageId,
    count: v.count,
    amounts: v.amounts.sort((a, b) => (a.currency < b.currency ? -1 : 1)),
  }))
  stages.sort((a, b) => {
    const pa = posById.get(a.stageId)
    const pb = posById.get(b.stageId)
    if (pa && pb) {
      if (pa.pipelineId !== pb.pipelineId) return pa.pipelineId < pb.pipelineId ? -1 : 1
      return pa.position - pb.position
    }
    return a.stageId < b.stageId ? -1 : 1
  })
  return { total, stages }
}
export async function getOpportunity(
  tx: Db,
  orgId: string,
  id: string,
): Promise<OpportunityDetail> {
  const row = await requireOpportunity(tx, orgId, id)
  const [[contactRow], [patientRow], [stage], [service], [budget], history] = await Promise.all([
    tx
      .select({ displayName: contact.displayName, phone: contact.phone, email: contact.email })
      .from(contact)
      .where(and(eq(contact.id, row.contactId), eq(contact.organizationId, orgId)))
      .limit(1),
    row.patientId
      ? tx
          .select({ displayName: patient.displayName })
          .from(patient)
          .where(and(eq(patient.id, row.patientId), eq(patient.organizationId, orgId)))
          .limit(1)
      : Promise.resolve([]),
    tx
      .select({ name: pipelineStage.name, kind: pipelineStage.kind })
      .from(pipelineStage)
      .where(eq(pipelineStage.id, row.stageId))
      .limit(1),
    row.serviceId
      ? tx
          .select({ name: serviceCatalog.name })
          .from(serviceCatalog)
          .where(eq(serviceCatalog.id, row.serviceId))
          .limit(1)
      : Promise.resolve([]),
    row.budgetId
      ? tx
          .select({ title: treatmentBudget.title, status: treatmentBudget.status })
          .from(treatmentBudget)
          .where(
            and(eq(treatmentBudget.id, row.budgetId), eq(treatmentBudget.organizationId, orgId)),
          )
          .limit(1)
      : Promise.resolve([]),
    tx
      .select()
      .from(opportunityEvent)
      .where(
        and(
          eq(opportunityEvent.opportunityId, id),
          eq(opportunityEvent.organizationId, orgId),
        ),
      )
      .orderBy(asc(opportunityEvent.createdAt)),
  ])
  if (!contactRow) throw notFound("Contacto")
  return {
    id: row.id,
    title: row.title,
    contactId: row.contactId,
    contactName: contactRow.displayName,
    contactPhone: contactRow.phone,
    contactEmail: contactRow.email,
    patientId: row.patientId,
    patientName: patientRow?.displayName ?? null,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    stageName: stage?.name ?? "—",
    stageKind: stage?.kind ?? "open",
    status: asStatus(row.status),
    amountCents: row.amountCents,
    currency: row.currency,
    interestText: row.interestText,
    serviceId: row.serviceId,
    serviceName: service?.name ?? null,
    assignedUserId: row.assignedUserId,
    nextActionAt: iso(row.nextActionAt),
    nextActionNote: row.nextActionNote,
    conversationId: row.conversationId,
    closedAt: iso(row.closedAt),
    closeReason: row.closeReason,
    budgetId: row.budgetId,
    budgetTitle: budget?.title ?? null,
    budgetStatus: budget?.status ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      fromStageId: h.fromStageId,
      toStageId: h.toStageId,
      actorUserId: h.actorUserId,
      note: h.note,
      createdAt: h.createdAt.toISOString(),
    })),
  }
}

export async function createOpportunity(
  tx: Db,
  orgId: string,
  input: CreateOpportunityInput,
  actor?: { userId: string | null },
): Promise<OpportunityDetail> {
  await requireContact(tx, orgId, input.contactId)
  let patientId: string | null = null
  if (input.patientId) {
    const found = await requirePatient(tx, orgId, input.patientId)
    patientId = found.id
    await requirePatientLink(tx, orgId, patientId, input.contactId)
  }
  const stage = await resolveStage(tx, orgId, input.stageId, input.pipelineId)
  if (stage.kind !== "open") {
    throw validation("La oportunidad nace en una etapa abierta; el cierre con motivo viene después")
  }
  const title = cleanTitle(input.title)
  const serviceId = await resolveService(tx, orgId, input.serviceId)
  const budgetId = await resolveBudget(tx, orgId, input.budgetId, patientId)
  // Si el presupuesto trae paciente y no se declaró, se adopta (sin duplicar ficha).
  const effectivePatientId = patientId ?? (await budgetPatient(tx, orgId, budgetId))
  if (effectivePatientId) {
    await requirePatientLink(tx, orgId, effectivePatientId, input.contactId)
  }
  const conversationId = await resolveOpportunityConversation(
    tx,
    orgId,
    input.conversationId ?? null,
    input.contactId,
  )
  const amountCents = cleanAmount(input.amountCents) ?? null
  // Moneda indicada o la de la clínica. Una oportunidad sin importe puede nacer
  // antes de que la clínica configure su moneda (p. ej. al entrar un mensaje):
  // entonces lleva «sin moneda» (ISO 4217 XXX), nunca la de un país. Con
  // importe, la moneda es obligatoria.
  const currency =
    cleanCurrency(input.currency) ??
    (await findOrgCurrency(tx, orgId)) ??
    (amountCents === null ? NO_CURRENCY : await requireOrgCurrency(tx, orgId))
  const assignedUserId = (await resolveAssignee(tx, orgId, input.assignedUserId)) ?? null
  const nextActionAt = cleanNextActionAt(input.nextActionAt) ?? null
  const nextActionNote = cleanNote(input.nextActionNote ?? null, 500, "La nota") ?? null
  const interestText = cleanNote(input.interestText ?? null, 500, "El interés") ?? null
  const [created] = await tx
    .insert(opportunity)
    .values({
      organizationId: orgId,
      contactId: input.contactId,
      patientId: effectivePatientId,
      pipelineId: stage.pipelineId,
      stageId: stage.stageId,
      title,
      serviceId,
      interestText,
      amountCents,
      currency,
      assignedUserId,
      nextActionAt,
      nextActionNote,
      status: "open",
      budgetId,
      conversationId: conversationId ?? null,
    })
    .returning()
  if (!created) throw new Error("No se pudo crear la oportunidad")
  await recordEvent(tx, orgId, created.id, "opportunity.created", null, stage.stageId, actor?.userId ?? null, null)
  await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.created", created.id, {
    contactId: input.contactId,
    stageId: stage.stageId,
  })
  await syncOpportunityFollowUp(tx, orgId, created, actor?.userId ?? null)
  await notifyOpp(tx, orgId)
  await notifyAssignee(
    tx,
    orgId,
    assignedUserId,
    `opportunity:${created.id}:assigned`,
    "Nueva oportunidad asignada",
    title,
    `/opportunities/${created.id}`,
  )
  return getOpportunity(tx, orgId, created.id)
}

async function budgetPatient(
  tx: Db,
  orgId: string,
  budgetId: string | null | undefined,
): Promise<string | null> {
  if (!budgetId) return null
  const [budget] = await tx
    .select({ patientId: treatmentBudget.patientId })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
  return budget?.patientId ?? null
}

export async function updateOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  input: UpdateOpportunityInput,
  actor?: { userId: string | null },
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad cerrada no se edita; reábrala primero")
  const patch: Partial<typeof opportunity.$inferInsert> = { updatedAt: new Date() }
  const changed: string[] = []
  const effectiveContactId = input.contactId ?? current.contactId
  if (input.contactId !== undefined) {
    await requireContact(tx, orgId, input.contactId)
    patch.contactId = input.contactId
    changed.push("contactId")
  }
  let effectivePatientId: string | null = input.patientId !== undefined ? input.patientId : current.patientId
  if (input.patientId !== undefined) {
    if (input.patientId === null) {
      patch.patientId = null
      effectivePatientId = null
    } else {
      const found = await requirePatient(tx, orgId, input.patientId)
      patch.patientId = found.id
      effectivePatientId = found.id
    }
    changed.push("patientId")
  }
  if (input.title !== undefined) {
    patch.title = cleanTitle(input.title)
    changed.push("title")
  }
  if (input.serviceId !== undefined) {
    patch.serviceId = (await resolveService(tx, orgId, input.serviceId)) ?? null
    changed.push("serviceId")
  }
  if (input.interestText !== undefined) {
    patch.interestText = cleanNote(input.interestText, 500, "El interés") ?? null
    changed.push("interestText")
  }
  if (input.amountCents !== undefined) {
    patch.amountCents = cleanAmount(input.amountCents) ?? null
    changed.push("amountCents")
  }
  if (input.currency !== undefined) {
    patch.currency = cleanCurrency(input.currency) ?? (await requireOrgCurrency(tx, orgId))
    changed.push("currency")
  }
  const assigneeChanged = input.assignedUserId !== undefined
  const previousAssignee = current.assignedUserId
  if (assigneeChanged) {
    patch.assignedUserId = (await resolveAssignee(tx, orgId, input.assignedUserId)) ?? null
    changed.push("assignedUserId")
  }
  if (input.nextActionAt !== undefined) {
    patch.nextActionAt = cleanNextActionAt(input.nextActionAt) ?? null
    changed.push("nextActionAt")
  }
  if (input.nextActionNote !== undefined) {
    patch.nextActionNote = cleanNote(input.nextActionNote, 500, "La nota") ?? null
    changed.push("nextActionNote")
  }
  const effectiveBudgetId: string | null =
    input.budgetId !== undefined ? input.budgetId : current.budgetId
  if (input.budgetId !== undefined) {
    patch.budgetId =
      (await resolveBudget(tx, orgId, input.budgetId, effectivePatientId)) ?? null
    changed.push("budgetId")
  }
  // Coherencia estricta aunque solo cambie patientId/contacto: el presupuesto
  // vigente debe seguir siendo del paciente efectivo.
  await assertBudgetCoherent(tx, orgId, effectiveBudgetId, effectivePatientId)
  // Los datos legados no conceden representación: editar título/seguimiento
  // no crea un vínculo. Cualquier cambio de persona, paciente o presupuesto
  // sí exige verificar la relación explícita vigente.
  const relationshipChanged = effectiveContactId !== current.contactId ||
    effectivePatientId !== current.patientId || effectiveBudgetId !== current.budgetId
  if (effectivePatientId && relationshipChanged) {
    await requirePatientLink(tx, orgId, effectivePatientId, effectiveContactId)
  }
  if (input.conversationId !== undefined) {
    patch.conversationId =
      (await resolveOpportunityConversation(tx, orgId, input.conversationId, effectiveContactId)) ?? null
    changed.push("conversationId")
  } else if (input.contactId !== undefined && current.conversationId) {
    // Al cambiar de contacto, el hilo origen debe seguir siendo del nuevo contacto.
    const conv = await requireConversationInOrg(tx, orgId, current.conversationId)
    if (conv.contactId !== effectiveContactId) {
      throw validation("La conversación pertenece a otro contacto")
    }
  }
  if (changed.length > 0) {
    await tx
      .update(opportunity)
      .set(patch)
      .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
    await recordEvent(tx, orgId, id, "opportunity.updated", null, null, actor?.userId ?? null, null)
    await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.updated", id, {
      fields: changed,
    })
    await notifyOpp(tx, orgId)
  }
  if (changed.length > 0) {
    const [fresh] = await tx
      .select()
      .from(opportunity)
      .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
      .limit(1)
      .for("update")
    if (fresh) await syncOpportunityFollowUp(tx, orgId, fresh, actor?.userId ?? null)
  }
  if (assigneeChanged && patch.assignedUserId && patch.assignedUserId !== previousAssignee) {
    await notifyAssignee(
      tx,
      orgId,
      patch.assignedUserId,
      `opportunity:${id}:assigned`,
      "Oportunidad asignada",
      current.title,
      `/opportunities/${id}`,
    )
  }
  return getOpportunity(tx, orgId, id)
}

export interface OpportunityStageEvent {
  organizationId: string
  opportunityId: string
  contactId: string
  patientId: string | null
  fromStageId: string | null
  toStageId: string
  stageKind: string
  status: OpportunityStatus
  actorUserId: string | null
}

/**
 * Mueve la oportunidad de etapa y sincroniza `status` con el `kind` del
 * destino. Devuelve el evento de estado para que Automatizaciones suscriba
 * disparadores (p. ej. seguimiento al llegar a "Cita agendada", aviso al
 * ganar/perder). También queda en `audit_event` (action
 * `opportunity.stage_changed`) y en `opportunity_event`.
 */
export async function moveOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  stageId: string,
  actor?: { userId: string | null },
): Promise<{ detail: OpportunityDetail; event: OpportunityStageEvent }> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad cerrada no se mueve; reábrala primero")
  const stage = await requireStageInOrg(tx, orgId, stageId)
  if (stage.id === current.stageId) return { detail: await getOpportunity(tx, orgId, id), event: stageEventOf(orgId, current, null, stage, actor) }
  const status: OpportunityStatus =
    stage.kind === "won" ? "won" : stage.kind === "lost" ? "lost" : "open"
  const patch: Partial<typeof opportunity.$inferInsert> = {
    stageId: stage.id,
    pipelineId: stage.pipelineId,
    status,
    updatedAt: new Date(),
  }
  // Cerrar por mover a etapa terminal exige motivo: se pide vía closeOpportunity.
  if (status !== "open") {
    throw validation("Para ganar o perder use el cierre con motivo (botón Ganada/Perdida)")
  }
  await tx
    .update(opportunity)
    .set(patch)
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.moved", current.stageId, stage.id, actor?.userId ?? null, null)
  await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.stage_changed", id, {
    fromStageId: current.stageId,
    toStageId: stage.id,
    stageKind: stage.kind,
  })
  await notifyOpp(tx, orgId)
  const event = stageEventOf(orgId, current, current.stageId, stage, actor)
  return { detail: await getOpportunity(tx, orgId, id), event }
}

function stageEventOf(
  orgId: string,
  current: typeof opportunity.$inferSelect,
  fromStageId: string | null,
  stage: typeof pipelineStage.$inferSelect,
  actor: { userId: string | null } | undefined,
): OpportunityStageEvent {
  return {
    organizationId: orgId,
    opportunityId: current.id,
    contactId: current.contactId,
    patientId: current.patientId,
    fromStageId,
    toStageId: stage.id,
    stageKind: stage.kind,
    status: "open",
    actorUserId: actor?.userId ?? null,
  }
}

export async function closeOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  input: { outcome: "won" | "lost"; reason: string },
  actor?: { userId: string | null },
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status !== "open") throw validation("La oportunidad ya está cerrada")
  const reason = input.reason.trim()
  if (!reason || reason.length > CLOSE_REASON_MAX) {
    throw validation(`El motivo debe tener 1–${CLOSE_REASON_MAX} caracteres`)
  }
  if (input.outcome !== "won" && input.outcome !== "lost") {
    throw validation("Resultado inválido (won/lost)")
  }
  // Ubicar en la primera etapa terminal del mismo pipeline (kind won/lost).
  const [terminal] = await tx
    .select()
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.pipelineId, current.pipelineId),
        eq(pipelineStage.organizationId, orgId),
        eq(pipelineStage.kind, input.outcome),
      ),
    )
    .orderBy(asc(pipelineStage.position))
    .limit(1)
  const now = new Date()
  await tx
    .update(opportunity)
    .set({
      stageId: terminal?.id ?? current.stageId,
      status: input.outcome,
      closedAt: now,
      closeReason: reason,
      // Cierre limpia la próxima acción (cancela el seguimiento); reabrir no
      // reactiva nada y la fecha queda null hasta nueva programación.
      nextActionAt: null,
      nextActionNote: null,
      updatedAt: now,
    })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(
    tx,
    orgId,
    id,
    input.outcome === "won" ? "opportunity.won" : "opportunity.lost",
    current.stageId,
    terminal?.id ?? current.stageId,
    actor?.userId ?? null,
    reason,
  )
  await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.closed", id, {
    outcome: input.outcome,
    toStageId: terminal?.id ?? current.stageId,
  })
  await cancelOpportunityFollowUp(tx, orgId, id, actor?.userId ?? null)
  await notifyOpp(tx, orgId)
  if (current.assignedUserId && current.assignedUserId !== (actor?.userId ?? null)) {
    await notifyAssignee(
      tx,
      orgId,
      current.assignedUserId,
      `opportunity:${id}:closed`,
      input.outcome === "won" ? "Oportunidad ganada" : "Oportunidad perdida",
      current.title,
      `/opportunities/${id}`,
    )
  }
  return getOpportunity(tx, orgId, id)
}

export async function reopenOpportunity(
  tx: Db,
  orgId: string,
  id: string,
  actor?: { userId: string | null },
): Promise<OpportunityDetail> {
  const current = await requireOpportunity(tx, orgId, id, true)
  if (current.status === "open") throw validation("La oportunidad ya está abierta")
  const [first] = await tx
    .select()
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.pipelineId, current.pipelineId),
        eq(pipelineStage.organizationId, orgId),
        eq(pipelineStage.kind, "open"),
      ),
    )
    .orderBy(asc(pipelineStage.position))
    .limit(1)
  if (!first) throw validation("El pipeline no tiene etapas abiertas")
  const now = new Date()
  await tx
    .update(opportunity)
    .set({
      stageId: first.id,
      status: "open",
      closedAt: null,
      closeReason: null,
      updatedAt: now,
    })
    .where(and(eq(opportunity.id, id), eq(opportunity.organizationId, orgId)))
  await recordEvent(tx, orgId, id, "opportunity.reopened", current.stageId, first.id, actor?.userId ?? null, null)
  await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.reopened", id, {
    fromStageId: current.stageId,
    toStageId: first.id,
  })
  // No se reactivan tareas canceladas al reabrir (el próximo edit con fecha crea una nueva).
  await notifyOpp(tx, orgId)
  return getOpportunity(tx, orgId, id)
}

