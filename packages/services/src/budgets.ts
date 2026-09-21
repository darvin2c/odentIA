import type { Db } from "@odentia/db"
import {
  orgCounter,
  encounterProcedure,
  patientCharge,
  patientPaymentApplication,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import type { PlanItemDecision } from "./plan.js"

import { requireDecisionContact } from "./responsibilities.js"
import { assertExecutableCodings } from "./procedure-codings.js"

/**
 * Documento económico de un plan clínico: cabecera con decisión auditada +
 * líneas snapshot de lo realmente cotizado (no un join mutable a la oferta
 * vigente). El presupuesto nace de un plan (nunca aislado), con ítems
 * elegibles explícitos y una sola moneda. La decisión por línea se conserva
 * como evidencia; la indicación guarda la decisión clínica vigente.
 */

export const BUDGET_STATUSES = [
  "borrador",
  "presentado",
  "aceptado",
  "parcial",
  "rechazado",
  "pospuesto",
  "sustituido",
  "cancelado",
  "historico",
] as const
export type BudgetStatus = (typeof BUDGET_STATUSES)[number]

export type BudgetRow = typeof treatmentBudget.$inferSelect
export type BudgetLineRow = typeof treatmentBudgetItem.$inferSelect

/** Línea con estado clínico unido solo para lectura. */
export type BudgetLineWithStatus = BudgetLineRow & { itemStatus: string }

/** Presupuesto con líneas snapshot y totales enteros (null = precio desconocido). */
export type BudgetWithTotals = BudgetRow & {
  items: BudgetLineWithStatus[]
  totalCents: number | null
  acceptedCents: number | null
}

export interface CreateBudgetInput {
  planId: string
  itemIds: string[]
  title?: string | null
  notes?: string | null
}

export interface UpdateBudgetDraftInput {
  title?: string
  notes?: string | null
}

export interface DecideBudgetInput {
  decisions: Array<{ planItemId: string; decision: "aceptado" | "rechazado" | "pospuesto" }>
  decidedByContactId?: string | null
  decisionNote?: string | null
}

export interface ReviseBudgetInput {
  itemIds: string[]
  title?: string | null
  notes?: string | null
  reason: string
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "treatment_budget",
    entityId,
    metadata: metadata ?? null,
  })
}

/** Lock del plan (toda mutación de presupuestos empieza aquí). */
async function lockPlan(
  tx: Db,
  orgId: string,
  patientId: string,
  planId: string,
): Promise<typeof treatmentPlan.$inferSelect> {
  const [plan] = await tx
    .select()
    .from(treatmentPlan)
    .where(
      and(
        eq(treatmentPlan.id, planId),
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
      ),
    )
    .limit(1)
    .for("update")
  if (!plan) throw notFound("Plan de tratamiento")
  return plan
}

/** Lock de la cabecera (serializa presentar/decidir/cancelar/altas). */
async function lockBudgetRow(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetRow> {
  const [row] = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
    .for("update")
  if (!row) throw notFound("Presupuesto")
  return row
}

/** Lookup acotado a org + paciente + presupuesto (anti-traversal). */
async function requireBudget(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetRow> {
  const [row] = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Presupuesto")
  return row
}

async function listBudgetLines(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetLineWithStatus[]> {
  const lines = await tx
    .select()
    .from(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.budgetId, budgetId),
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
      ),
    )
    .orderBy(asc(treatmentBudgetItem.createdAt), asc(treatmentBudgetItem.id))
  const statuses = new Map<string, string>()
  if (lines.length > 0) {
    const items = await tx
      .select({ id: treatmentPlanItem.id, status: treatmentPlanItem.status })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          inArray(
            treatmentPlanItem.id,
            lines.map((l) => l.planItemId),
          ),
        ),
      )
    for (const item of items) statuses.set(item.id, item.status)
  }
  return lines.map((line) => ({
    ...line,
    itemStatus: statuses.get(line.planItemId) ?? "pendiente",
  }))
}

/** Suma entera exacta; null si algún precio del conjunto es desconocido. */
function sumCents(items: Array<{ priceCents: number | null }>): number | null {
  let total = 0
  for (const item of items) {
    if (item.priceCents == null) return null
    total += item.priceCents
  }
  return total
}

function withTotals(budget: BudgetRow, items: BudgetLineWithStatus[]): BudgetWithTotals {
  return {
    ...budget,
    items,
    totalCents: sumCents(items),
    acceptedCents: sumCents(items.filter((item) => item.decision === "aceptado")),
  }
}

function assertTitle(title: string | null | undefined, fallback: string): string {
  const value = (title?.trim() || fallback.trim()) ?? ""
  if (!value || value.length > 200) throw validation("title debe tener 1–200 caracteres")
  return value
}

function assertPatchTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined
  const value = title.trim()
  if (!value || value.length > 200) throw validation("title debe tener 1–200 caracteres")
  return value
}

function assertNotes(notes: string | null | undefined): string | null | undefined {
  if (notes === undefined) return undefined
  if (notes === null) return null
  if (notes.length > 4000) throw validation("notes debe tener hasta 4000 caracteres")
  const trimmed = notes.trim()
  return trimmed ? trimmed : null
}

async function nextBudgetNumber(tx: Db, orgId: string): Promise<number> {
  const [row] = await tx
    .insert(orgCounter)
    .values({ organizationId: orgId, key: "budget", value: 1 })
    .onConflictDoUpdate({
      target: [orgCounter.organizationId, orgCounter.key],
      set: { value: sql`"org_counter"."value" + 1` },
    })
    .returning({ value: orgCounter.value })
  if (!row) throw new Error("No se pudo generar el correlativo del presupuesto")
  return row.value
}

type QuotableItem = typeof treatmentPlanItem.$inferSelect

/**
 * Ítems elegibles para un nuevo documento: sin presupuesto vigente, con
 * presupuesto cancelado o rechazados. No duplican cotización vigente, no
 * recotizan un aceptado ni uno realizado. Todos con tarifa conocida y una
 * sola moneda. Lock: plan → presupuestos vigentes (UUID ordenado) → ítems.
 */
async function requireQuotableItems(
  tx: Db,
  orgId: string,
  patientId: string,
  planId: string,
  itemIds: string[],
): Promise<QuotableItem[]> {
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 200) {
    throw validation("itemIds debe tener entre 1 y 200 identificadores únicos")
  }
  const sorted = [...new Set(itemIds)].sort()
  if (sorted.length !== itemIds.length) throw validation("itemIds no debe repetirse")
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.id, sorted),
      ),
    )
  if (items.length !== sorted.length) throw notFound("Ítem del plan")
  for (const item of items) {
    if (item.planId !== planId) throw validation("Todos los ítems deben pertenecer al plan")
    if (["realizado", "cancelado", "reemplazado"].includes(item.status)) {
      throw conflict("ITEM_CLOSED", "El tratamiento está cerrado y no puede cotizarse")
    }
    // Histórico ambiguo heredado: un nuevo presupuesto nunca cotiza varias
    // equivalencias como actos; se pide una nueva indicación exacta.
    assertExecutableCodings(item.codings)
    if (item.priceCents === null) throw validation("Todos los ítems deben tener tarifa conocida")
  }
  const currencies = new Set(items.map((i) => i.currency))
  if (currencies.size !== 1)
    throw conflict("BUDGET_CURRENCY_MIX", "Los ítems usan monedas distintas")
  // Locks ordenados: presupuestos vigentes primero, luego ítems.
  const budgetIds = [
    ...new Set(items.map((i) => i.budgetId).filter((id): id is string => id !== null)),
  ].sort()
  const budgets = new Map<string, BudgetRow>()
  for (const budgetId of budgetIds) {
    budgets.set(budgetId, await lockBudgetRow(tx, orgId, patientId, budgetId))
  }
  const locked: QuotableItem[] = []
  for (const id of sorted) {
    const [item] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, id),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .limit(1)
      .for("update")
    if (!item) throw notFound("Ítem del plan")
    locked.push(item)
  }
  const linesByItem = new Map<string, BudgetLineRow>()
  if (budgetIds.length > 0) {
    const lines = await tx
      .select()
      .from(treatmentBudgetItem)
      .where(
        and(
          eq(treatmentBudgetItem.organizationId, orgId),
          inArray(treatmentBudgetItem.budgetId, budgetIds),
        ),
      )
    for (const line of lines) linesByItem.set(line.planItemId, line)
  }
  for (const item of locked) {
    if (!item.budgetId) continue
    const budget = budgets.get(item.budgetId)
    if (!budget) throw notFound("Presupuesto")
    if (budget.status === "borrador" || budget.status === "presentado") {
      throw conflict(
        "ITEM_ALREADY_QUOTED",
        "El tratamiento ya está cotizado en un presupuesto vigente",
      )
    }
    const decision = item.decisionStatus as PlanItemDecision
    if (decision === "aceptado") {
      throw conflict("ITEM_CLOSED", "El tratamiento ya fue aceptado y no puede recotizarse")
    }
    if (decision !== "rechazado" && budget.status !== "cancelado") {
      throw conflict(
        "ITEM_ALREADY_QUOTED",
        "El tratamiento ya está cotizado en un presupuesto vigente",
      )
    }
  }
  return locked
}

export async function createBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateBudgetInput,
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  if (!input.planId?.trim())
    throw validation("planId es obligatorio: el presupuesto pertenece a un plan")
  const plan = await lockPlan(tx, orgId, patientId, input.planId.trim())
  const items = await requireQuotableItems(tx, orgId, patientId, plan.id, input.itemIds)
  const currency = items[0]?.currency ?? "PEN"
  const title = assertTitle(input.title, plan.title)
  const notes = assertNotes(input.notes) ?? null
  const budgetNumber = await nextBudgetNumber(tx, orgId)
  const [budget] = await tx
    .insert(treatmentBudget)
    .values({
      organizationId: orgId,
      patientId,
      planId: plan.id,
      budgetNumber,
      title,
      currency,
      status: "borrador",
      notes,
      createdBy: actorUserId,
    })
    .returning()
  if (!budget) throw new Error("No se pudo crear el presupuesto")
  for (const item of items) {
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId,
      patientId,
      planId: plan.id,
      budgetId: budget.id,
      planItemId: item.id,
      serviceId: item.serviceId,
      title: item.title,
      scope: item.scope,
      toothNumber: item.toothNumber,
      surfaces: item.surfaces,
      quadrant: item.quadrant,
      arch: item.arch,
      codings: item.codings,
      priceCents: item.priceCents,
      currency: item.currency,
      decision: "pendiente",
      createdBy: actorUserId,
    })
    await tx
      .update(treatmentPlanItem)
      .set({ budgetId: budget.id, updatedAt: new Date() })
      .where(
        and(
          eq(treatmentPlanItem.id, item.id),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
  }
  await audit(tx, orgId, actorUserId, "budget.created", budget.id, {
    patientId,
    planId: plan.id,
    budgetNumber,
    currency,
    itemCount: items.length,
  })
  const lines = await listBudgetLines(tx, orgId, patientId, budget.id)
  return withTotals(budget, lines)
}

export async function updateBudgetDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: UpdateBudgetDraftInput,
): Promise<BudgetRow> {
  await requirePatient(tx, orgId, patientId)
  const [prev] = await tx
    .select({ planId: treatmentBudget.planId })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Presupuesto")
  await lockPlan(tx, orgId, patientId, prev.planId)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador puede editarse")
  }
  const set: Partial<typeof treatmentBudget.$inferInsert> = {}
  const fields: string[] = []
  if (input.title !== undefined) {
    set.title = assertPatchTitle(input.title)
    fields.push("title")
  }
  if (input.notes !== undefined) {
    set.notes = assertNotes(input.notes)
    fields.push("notes")
  }
  if (fields.length === 0) throw validation("Sin cambios: patch vacío")
  const [updated] = await tx
    .update(treatmentBudget)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Presupuesto")
  await audit(tx, orgId, actorUserId, "budget.updated", budgetId, { patientId, fields })
  return updated
}

export async function presentBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetRow> {
  await requirePatient(tx, orgId, patientId)
  const [prev] = await tx
    .select({ planId: treatmentBudget.planId })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Presupuesto")
  await lockPlan(tx, orgId, patientId, prev.planId)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador puede presentarse")
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  if (lines.length === 0) throw validation("El presupuesto no tiene ítems")
  const [updated] = await tx
    .update(treatmentBudget)
    .set({ status: "presentado", presentedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Presupuesto")
  if (current.supersedesBudgetId) {
    const previous = await lockBudgetRow(tx, orgId, patientId, current.supersedesBudgetId)
    if (!["presentado", "aceptado", "parcial", "pospuesto"].includes(previous.status)) {
      throw conflict("BUDGET_STATUS", "La propuesta anterior ya no admite sustitución")
    }
    await assertRetainedExecutedItems(tx, orgId, patientId, previous.id, lines.map(l => l.planItemId))
    await tx.update(treatmentBudget).set({ status: "sustituido", updatedAt: new Date() })
      .where(and(eq(treatmentBudget.id, previous.id), eq(treatmentBudget.organizationId, orgId)))
    await tx.update(treatmentPlanItem).set({ budgetId, updatedAt: new Date() })
      .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.id, lines.map(l => l.planItemId))))
  }
  await audit(tx, orgId, actorUserId, "budget.presented", budgetId, {
    patientId,
    itemCount: lines.length,
  })
  return updated
}

export async function decideBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: DecideBudgetInput,
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const [prev] = await tx
    .select({ planId: treatmentBudget.planId })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Presupuesto")
  await lockPlan(tx, orgId, patientId, prev.planId)
  await lockBudgetRow(tx, orgId, patientId, budgetId)
  const current = await requireBudget(tx, orgId, patientId, budgetId)
  if (current.status !== "presentado") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto presentado puede decidirse")
  }
  const decisionNote = assertNotes(input.decisionNote) ?? null
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  if (!Array.isArray(input.decisions) || input.decisions.length !== lines.length) {
    throw validation("Debe decidir cada línea exactamente una vez")
  }
  const decisions = new Map(input.decisions.map(d => [d.planItemId, d.decision]))
  if (decisions.size !== lines.length || lines.some(l => !decisions.has(l.planItemId)) ||
    input.decisions.some(d => !["aceptado", "rechazado", "pospuesto"].includes(d.decision))) {
    throw validation("Debe decidir cada línea exactamente una vez")
  }
  const representative = input.decidedByContactId
    ? await requireDecisionContact(tx, orgId, patientId, input.decidedByContactId) : null
  const items = await tx.select().from(treatmentPlanItem).where(and(
    eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId),
    eq(treatmentPlanItem.planId, current.planId),
  )).orderBy(asc(treatmentPlanItem.id)).for("update")
  const selectedGroups = new Set<string>()
  for (const item of items) {
    const decision = decisions.get(item.id)
    if (!decision) continue
    if (["cancelado", "reemplazado"].includes(item.status)) throw conflict("ITEM_CLOSED", "La indicación está cerrada")
    if (item.budgetId !== budgetId) throw conflict("BUDGET_STATUS", "La propuesta ya no es vigente para esta indicación")
    if (["en_curso", "realizado"].includes(item.status) && decision !== "aceptado") {
      throw conflict("ITEM_IN_EXECUTION", "No puede retirar la aceptación de un tratamiento ejecutado")
    }
    if (decision !== "aceptado" || !item.optionGroupId) continue
    if (selectedGroups.has(item.optionGroupId)) throw conflict("OPTION_CONFLICT", "Solo puede aceptar una alternativa por grupo")
    selectedGroups.add(item.optionGroupId)
    if (items.some(other => other.id !== item.id && other.optionGroupId === item.optionGroupId &&
      ["en_curso", "realizado"].includes(other.status))) {
      throw conflict("OPTION_ALREADY_IN_EXECUTION", "Otra alternativa ya está en ejecución")
    }
  }
  const now = new Date()
  for (const line of lines) {
    const decision = decisions.get(line.planItemId)!
    await tx.update(treatmentBudgetItem).set({ decision, updatedAt: now })
      .where(and(eq(treatmentBudgetItem.id, line.id), eq(treatmentBudgetItem.organizationId, orgId)))
    await tx.update(treatmentPlanItem).set({
      decisionStatus: decision, decisionNote, decidedAt: now,
      decidedByContactId: representative?.id ?? null, decidedByName: representative?.displayName ?? null,
      updatedAt: now,
    }).where(and(eq(treatmentPlanItem.id, line.planItemId), eq(treatmentPlanItem.organizationId, orgId),
      eq(treatmentPlanItem.patientId, patientId)))
  }
  for (const item of items) {
    if (!item.optionGroupId || !selectedGroups.has(item.optionGroupId) || decisions.get(item.id) === "aceptado" ||
      ["realizado", "cancelado", "reemplazado"].includes(item.status)) continue
    await tx.update(treatmentPlanItem).set({
      decisionStatus: "rechazado", decisionNote: "Alternativa no elegida", decidedAt: now,
      decidedByContactId: representative?.id ?? null, decidedByName: representative?.displayName ?? null,
      updatedAt: now,
    }).where(and(eq(treatmentPlanItem.id, item.id), eq(treatmentPlanItem.organizationId, orgId)))
  }
  const acceptedCount = input.decisions.filter(d => d.decision === "aceptado").length
  const status: BudgetStatus = acceptedCount === lines.length ? "aceptado" : acceptedCount > 0 ? "parcial"
    : input.decisions.some(d => d.decision === "pospuesto") ? "pospuesto" : "rechazado"
  const [updated] = await tx.update(treatmentBudget).set({
    status, acceptedByName: representative?.displayName ?? null,
    decisionContactId: representative?.id ?? null, decisionNote, decidedAt: now,
    decidedBy: actorUserId, updatedAt: now,
  }).where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId),
    eq(treatmentBudget.patientId, patientId))).returning()
  if (!updated) throw notFound("Presupuesto")
  await audit(tx, orgId, actorUserId, "budget.decision", budgetId, {
    patientId, status, acceptedCount, decisionContactId: representative?.id ?? null,
  })
  return withTotals(updated, await listBudgetLines(tx, orgId, patientId, budgetId))
}

export async function cancelBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetRow> {
  await requirePatient(tx, orgId, patientId)
  const [prev] = await tx
    .select({ planId: treatmentBudget.planId })
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Presupuesto")
  await lockPlan(tx, orgId, patientId, prev.planId)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador" && current.status !== "presentado") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador o presentado puede cancelarse")
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  if (lines.some((line) => line.itemStatus === "realizado")) {
    throw conflict(
      "BUDGET_HAS_REALIZED",
      "El presupuesto tiene tratamientos realizados y no puede cancelarse",
    )
  }
  const [updated] = await tx
    .update(treatmentBudget)
    .set({ status: "cancelado", updatedAt: new Date() })
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Presupuesto")
  // Las líneas conservan su snapshot; los ítems que aún apunten al cancelado
  // quedan sin presupuesto vigente (decisión pendiente o recotizables).
  for (const line of lines) {
    await tx
      .update(treatmentPlanItem)
      .set({ budgetId: null, updatedAt: new Date() })
      .where(
        and(
          eq(treatmentPlanItem.id, line.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          eq(treatmentPlanItem.budgetId, budgetId),
        ),
      )
  }
  await audit(tx, orgId, actorUserId, "budget.cancelled", budgetId, {
    patientId,
    from: current.status,
    itemCount: lines.length,
  })
  return updated
}

export async function listBudgets(
  tx: Db,
  orgId: string,
  patientId: string,
  planId?: string,
): Promise<BudgetWithTotals[]> {
  await requirePatient(tx, orgId, patientId)
  const conditions = [
    eq(treatmentBudget.patientId, patientId),
    eq(treatmentBudget.organizationId, orgId),
  ]
  if (planId) conditions.push(eq(treatmentBudget.planId, planId))
  const budgets = await tx
    .select()
    .from(treatmentBudget)
    .where(and(...conditions))
    .orderBy(asc(treatmentBudget.budgetNumber))
  const result: BudgetWithTotals[] = []
  for (const budget of budgets) {
    result.push(withTotals(budget, await listBudgetLines(tx, orgId, patientId, budget.id)))
  }
  return result
}

export async function getBudgetDetail(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetWithTotals> {
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  return withTotals(budget, await listBudgetLines(tx, orgId, patientId, budgetId))
}

async function assertRetainedExecutedItems(tx: Db, orgId: string, patientId: string, budgetId: string, itemIds: string[]) {
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const removed = lines.filter(l => !itemIds.includes(l.planItemId))
  if (removed.length === 0) return
  const [procedure] = await tx.select({ id: encounterProcedure.id }).from(encounterProcedure)
    .where(and(eq(encounterProcedure.organizationId, orgId),
      inArray(encounterProcedure.planItemId, removed.map(l => l.planItemId)))).limit(1)
  const [charge] = await tx.select({ id: patientCharge.id }).from(patientCharge)
    .where(and(eq(patientCharge.organizationId, orgId), eq(patientCharge.patientId, patientId),
      inArray(patientCharge.budgetItemId, removed.map(l => l.id)), isNull(patientCharge.voidedAt))).limit(1)
  const [application] = await tx.select({ id: patientPaymentApplication.id }).from(patientPaymentApplication)
    .innerJoin(patientCharge, eq(patientCharge.id, patientPaymentApplication.chargeId))
    .where(and(eq(patientPaymentApplication.organizationId, orgId), eq(patientPaymentApplication.patientId, patientId),
      inArray(patientCharge.budgetItemId, removed.map(l => l.id)), isNull(patientPaymentApplication.voidedAt))).limit(1)
  if (procedure || charge || application) throw conflict("BUDGET_ITEM_IN_USE", "No puede retirar líneas con ejecución o movimientos económicos")
}

export async function reviseBudget(
  tx: Db, orgId: string, actorUserId: string, patientId: string, budgetId: string, input: ReviseBudgetInput,
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const previous = await requireBudget(tx, orgId, patientId, budgetId)
  await lockPlan(tx, orgId, patientId, previous.planId)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (!["presentado", "aceptado", "parcial", "pospuesto"].includes(current.status)) {
    throw conflict("BUDGET_STATUS", "Esta propuesta no admite revisión")
  }
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  if (!input.itemIds?.length || input.itemIds.length > 200 || new Set(input.itemIds).size !== input.itemIds.length) {
    throw validation("itemIds debe contener entre 1 y 200 identificadores únicos")
  }
  const [successor] = await tx.select({ id: treatmentBudget.id }).from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), eq(treatmentBudget.supersedesBudgetId, budgetId))).limit(1)
  if (successor) throw conflict("BUDGET_REVISION_EXISTS", "La propuesta ya tiene una revisión")
  await assertRetainedExecutedItems(tx, orgId, patientId, budgetId, input.itemIds)
  const items = await tx.select().from(treatmentPlanItem).where(and(
    eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.patientId, patientId),
    eq(treatmentPlanItem.planId, current.planId), inArray(treatmentPlanItem.id, input.itemIds),
  )).orderBy(asc(treatmentPlanItem.id)).for("update")
  if (items.length !== input.itemIds.length) throw notFound("Ítem del plan")
  for (const item of items) {
    if (["cancelado", "reemplazado"].includes(item.status)) throw conflict("ITEM_CLOSED", "La indicación está cerrada")
    if (item.priceCents == null || item.currency !== current.currency) throw conflict("BUDGET_CURRENCY_MIX", "Todas las líneas requieren tarifa en la moneda de la propuesta")
    if (item.budgetId && item.budgetId !== current.id) throw conflict("ITEM_ALREADY_QUOTED", "La indicación pertenece a otra propuesta")
    assertExecutableCodings(item.codings)
  }
  const [revision] = await tx.insert(treatmentBudget).values({
    organizationId: orgId, patientId, planId: current.planId, budgetNumber: current.budgetNumber,
    revisionNumber: current.revisionNumber + 1, supersedesBudgetId: current.id,
    title: assertTitle(input.title, current.title), notes: assertNotes(input.notes) ?? current.notes,
    currency: current.currency, createdBy: actorUserId,
  }).returning()
  if (!revision) throw new Error("No se pudo crear la revisión")
  const oldLines = await listBudgetLines(tx, orgId, patientId, current.id)
  for (const item of items) {
    const snapshot = oldLines.find(l => l.planItemId === item.id) ?? item
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId, patientId, planId: current.planId, budgetId: revision.id,
      planItemId: item.id, serviceId: snapshot.serviceId, title: snapshot.title,
      scope: snapshot.scope, toothNumber: snapshot.toothNumber, surfaces: snapshot.surfaces,
      quadrant: snapshot.quadrant, arch: snapshot.arch, codings: snapshot.codings,
      priceCents: snapshot.priceCents, currency: snapshot.currency, createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "budget.revised", revision.id, { patientId, reason, supersedesBudgetId: current.id })
  return withTotals(revision, await listBudgetLines(tx, orgId, patientId, revision.id))
}
