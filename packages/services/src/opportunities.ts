import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import {
  patient,
  serviceCatalog,
  treatmentBudget,
} from "@odentia/db/schema/clinical"
import { contact, pipeline, pipelineStage } from "@odentia/db/schema/crm"
import {
  opportunity,
  opportunityEvent,
  OPPORTUNITY_STATUSES,
  type OpportunityStatus,
} from "@odentia/db/schema/opportunities"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, ilike, lt, or, sql } from "drizzle-orm"
import { requireContact } from "./contacts.js"
import { cancelPendingJobsForOpportunity } from "./automation.js"
import { notFound, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { createWorkspaceNotification } from "./workspace.js"

export type { OpportunityStatus }
export const OPPORTUNITY_STATUS_LIST: OpportunityStatus[] = [...OPPORTUNITY_STATUSES]

/** Motivo de cierre: texto corto obligatorio al ganar o perder. */
const CLOSE_REASON_MAX = 500

/** Moneda de la organización (perfil); sin perfil rige el default existente. */
async function orgCurrency(tx: Db, orgId: string): Promise<string> {
  const [profile] = await tx
    .select({ currency: orgProfile.currency })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return profile?.currency ?? "PEN"
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
        lt(opportunity.updatedAt, ts),
        and(eq(opportunity.updatedAt, ts), lt(opportunity.id, decoded.id)),
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
    updatedAt: r.opp.updatedAt.toISOString(),
  }))
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(last.opp.updatedAt.toISOString(), last.opp.id, fingerprint)
      : null
  return { items, nextCursor }
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
  const amountCents = cleanAmount(input.amountCents) ?? null
  const currency = cleanCurrency(input.currency) ?? (await orgCurrency(tx, orgId))
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
    })
    .returning()
  if (!created) throw new Error("No se pudo crear la oportunidad")
  await recordEvent(tx, orgId, created.id, "opportunity.created", null, stage.stageId, actor?.userId ?? null, null)
  await auditOpportunity(tx, orgId, actor?.userId ?? null, "opportunity.created", created.id, {
    contactId: input.contactId,
    stageId: stage.stageId,
  })
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
  if (input.contactId !== undefined) {
    await requireContact(tx, orgId, input.contactId)
    patch.contactId = input.contactId
    changed.push("contactId")
  }
  if (input.patientId !== undefined) {
    if (input.patientId === null) {
      patch.patientId = null
    } else {
      const found = await requirePatient(tx, orgId, input.patientId)
      patch.patientId = found.id
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
    patch.currency = cleanCurrency(input.currency) ?? "PEN"
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
  if (input.budgetId !== undefined) {
    const effectivePatient = (patch.patientId ?? current.patientId) as string | null
    patch.budgetId = (await resolveBudget(tx, orgId, input.budgetId, effectivePatient)) ?? null
    changed.push("budgetId")
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
  // El cierre solo cancela los seguimientos ligados a ESTA oportunidad
  // (otras oportunidades, recordatorios y controles sobreviven).
  await cancelPendingJobsForOpportunity(
    tx,
    orgId,
    id,
    input.outcome === "won" ? "Oportunidad ganada" : "Oportunidad perdida",
  )
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
  return getOpportunity(tx, orgId, id)
}

