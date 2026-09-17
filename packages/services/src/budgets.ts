import type { Db } from "@odentia/db"
import {
  orgCounter,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import type { PlanItemDecision } from "./plan.js"
import { PLAN_ITEM_DECISIONS } from "./plan.js"
import { assertExecutableCodings } from "./procedure-codings.js"

/**
 * Documento económico de un plan clínico: cabecera con decisión auditada +
 * líneas snapshot de lo realmente cotizado (no un join mutable a la oferta
 * vigente). El presupuesto nace de un plan (nunca aislado), con ítems
 * elegibles explícitos y una sola moneda. `acceptedItemIds` identifica ítems
 * clínicos incluidos en ESE documento; la decisión se escribe en sus líneas.
 */

export const BUDGET_STATUSES = [
  "borrador",
  "presentado",
  "aceptado",
  "parcial",
  "rechazado",
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
  acceptedItemIds: string[]
  acceptedByName: string
  decisionNote?: string | null
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
    if (item.status === "realizado" || item.status === "cancelado") {
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
    const line = linesByItem.get(item.id)
    const decision = (line?.decision ?? "pendiente") as PlanItemDecision
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
    .set({ status: "presentado", updatedAt: new Date() })
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Presupuesto")
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
  if (!Array.isArray(input.acceptedItemIds)) throw validation("acceptedItemIds debe ser un arreglo")
  const accepted = new Set<string>()
  for (const id of input.acceptedItemIds) {
    if (typeof id !== "string" || !id) throw validation("acceptedItemIds contiene un id inválido")
    accepted.add(id)
  }
  const acceptedByName = input.acceptedByName?.trim() ?? ""
  if (!acceptedByName || acceptedByName.length > 200) {
    throw validation("acceptedByName debe tener 1–200 caracteres")
  }
  const decisionNote = assertNotes(input.decisionNote) ?? null
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const knownIds = new Set(lines.map((line) => line.planItemId))
  for (const id of accepted) {
    if (!knownIds.has(id))
      throw validation("acceptedItemIds contiene un tratamiento ajeno al presupuesto")
  }
  const acceptedCount = lines.filter((line) => accepted.has(line.planItemId)).length
  const status: BudgetStatus =
    acceptedCount === lines.length ? "aceptado" : acceptedCount === 0 ? "rechazado" : "parcial"
  // La decisión se escribe en las líneas ANTES de cambiar el estado de
  // cabecera, dentro del mismo lock/transacción (el trigger solo permite
  // cambiar `decision` una vez presentado).
  for (const line of lines) {
    const decision = accepted.has(line.planItemId) ? "aceptado" : "rechazado"
    if (line.decision !== decision) {
      await tx
        .update(treatmentBudgetItem)
        .set({ decision, updatedAt: new Date() })
        .where(
          and(eq(treatmentBudgetItem.id, line.id), eq(treatmentBudgetItem.organizationId, orgId)),
        )
    }
  }
  const [updated] = await tx
    .update(treatmentBudget)
    .set({
      status,
      acceptedByName,
      decisionNote,
      decidedAt: new Date(),
      decidedBy: actorUserId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(treatmentBudget.id, budgetId),
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Presupuesto")
  await audit(tx, orgId, actorUserId, "budget.decision", budgetId, {
    patientId,
    status,
    acceptedCount,
    rejectedCount: lines.length - acceptedCount,
    acceptedByName,
  })
  const fresh = await listBudgetLines(tx, orgId, patientId, budgetId)
  return withTotals(updated, fresh)
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

/** Decisiones vigentes de varios ítems (proyección de lectura). */
export async function budgetDecisions(
  tx: Db,
  orgId: string,
  items: Array<{ id: string; budgetId: string | null }>,
): Promise<Map<string, PlanItemDecision>> {
  const result = new Map<string, PlanItemDecision>()
  const budgetIds = [
    ...new Set(items.map((i) => i.budgetId).filter((id): id is string => id !== null)),
  ]
  const linesByItem = new Map<string, string>()
  if (budgetIds.length > 0) {
    const lines = await tx
      .select({
        planItemId: treatmentBudgetItem.planItemId,
        decision: treatmentBudgetItem.decision,
      })
      .from(treatmentBudgetItem)
      .where(
        and(
          eq(treatmentBudgetItem.organizationId, orgId),
          inArray(treatmentBudgetItem.budgetId, budgetIds),
        ),
      )
    for (const line of lines) linesByItem.set(line.planItemId, line.decision)
  }
  for (const item of items) {
    const decision = linesByItem.get(item.id) ?? "pendiente"
    result.set(
      item.id,
      ((PLAN_ITEM_DECISIONS as readonly string[]).includes(decision)
        ? decision
        : "pendiente") as PlanItemDecision,
    )
  }
  return result
}
