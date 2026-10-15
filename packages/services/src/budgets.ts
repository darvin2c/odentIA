import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import {
  orgCounter,
  encounterProcedure,
  patient,
  patientCharge,
  patientPaymentApplication,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { promotion as promotionTable } from "@odentia/db/schema/promotions"
import { sumAcceptedCents } from "@odentia/clinical"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requireOrgCurrency } from "./locale.js"
import { decideBudgetOpportunity, linkPresentedBudget } from "./opportunities.js"
import { requirePatient } from "./patients.js"
import type { PlanItemDecision } from "./plan.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { isPromotionLive, requirePromotionPrice } from "./promotions.js"

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

/** Línea con estado clínico y totales unidos solo para lectura. */
export type BudgetLineWithStatus = BudgetLineRow & {
  itemStatus: string
  /**
   * Total de la línea: el precio acordado o, si se cobra por sesión, el
   * precio de cada visita por las visitas previstas. Es lo que suma el
   * presupuesto; la deuda nace visita a visita.
   */
  lineTotalCents: number | null
  /** El mismo total a la tarifa de referencia (base del descuento). */
  tariffLineTotalCents: number | null
  /** Rebaja de la línea frente a la tarifa; null si no hay rebaja o falta un importe. */
  lineDiscountCents: number | null
}

/** Visitas que cuenta una línea: las previstas si se cobra por sesión; si no, una. */
export function budgetLineUnits(line: { billingMode: string; sessionsPlanned: number | null }): number {
  return line.billingMode === "session" ? Math.max(line.sessionsPlanned ?? 1, 1) : 1
}

function lineTotal(
  line: { billingMode: string; sessionsPlanned: number | null },
  unitCents: number | null,
): number | null {
  if (unitCents == null) return null
  const total = unitCents * budgetLineUnits(line)
  if (!Number.isSafeInteger(total) || total > 2147483647)
    throw validation("El total de la línea excede el importe admitido")
  return total
}

/** Presupuesto con líneas snapshot y totales enteros (null = precio desconocido). */
export type BudgetWithTotals = BudgetRow & {
  items: BudgetLineWithStatus[]
  /** Suma de precios finales acordados. */
  totalCents: number | null
  acceptedCents: number | null
  /** Suma de tarifas originales (referencia del descuento). */
  tariffTotalCents: number | null
  /** Rebaja total acordada (tarifa − final; null si algún precio es desconocido). */
  discountCents: number | null
}

/** Quién actúa en la ruta: el servidor limita al odontólogo a su plan propio. */
export interface BudgetActorOpts {
  memberRole?: string
}

/** Aviso en vivo (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notifyBudget(tx: Db, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "budget.updated", at: new Date().toISOString() })})`,
  )
}

/**
 * Plan propio del odontólogo: el plan lo creó él (`treatmentPlan.createdBy`).
 * Administración/propietario no tienen esta restricción; caja no escribe
 * presupuestos (la ruta exige `budgets.write`, que caja no tiene).
 */
function assertOwnPlan(
  plan: typeof treatmentPlan.$inferSelect,
  actorUserId: string,
  memberRole?: string,
): void {
  if ((memberRole ?? "").trim().toLowerCase() !== "dentist") return
  if (plan.createdBy !== actorUserId) {
    throw new ServiceError(
      "BUDGET_NOT_OWN_PLAN",
      403,
      "Solo puedes presupuestar el plan que indicaste tú",
    )
  }
}

/**
 * Plan propio del odontólogo para reutilizar fuera de presupuestos (p. ej.
 * envío de ya entregados): misma semántica `BUDGET_NOT_OWN_PLAN`.
 */
export async function requireOwnPlan(
  tx: Db,
  orgId: string,
  planId: string,
  actorUserId: string,
  memberRole?: string,
): Promise<void> {
  if ((memberRole ?? "").trim().toLowerCase() !== "dentist") return
  const [plan] = await tx
    .select({ createdBy: treatmentPlan.createdBy })
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.id, planId), eq(treatmentPlan.organizationId, orgId)))
    .limit(1)
  if (!plan || plan.createdBy !== actorUserId) {
    throw new ServiceError(
      "BUDGET_NOT_OWN_PLAN",
      403,
      "Solo puedes actuar sobre presupuestos de tu propio plan",
    )
  }
}
/**
 * Modo de cobro congelado por servicio (`treatment` una vez, `session` por
 * visita). La columna `service_catalog.billing_mode` es obligatoria (migración
 * del integrador): sin ella la consulta falla y no hay repliegue silencioso.
 */
export async function readBillingModes(
  tx: Db,
  orgId: string,
  serviceIds: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const ids = [...new Set(serviceIds.filter((id) => typeof id === "string" && id))].sort()
  if (ids.length === 0) return out
  const rows = await tx.execute(
    sql`select "id", "billing_mode" from "service_catalog" where "organization_id" = ${orgId} and "id" in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`,
  )
  for (const row of rows as unknown as Array<{ id: string; billing_mode: string }>) {
    out[row.id] = row.billing_mode === "session" ? "session" : "treatment"
  }
  return out
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
  return lines.map((line) => {
    const lineTotalCents = lineTotal(line, line.priceCents)
    const tariffLineTotalCents = lineTotal(line, line.tariffPriceCents ?? line.priceCents)
    const discount =
      lineTotalCents != null && tariffLineTotalCents != null
        ? tariffLineTotalCents - lineTotalCents
        : null
    return {
      ...line,
      itemStatus: statuses.get(line.planItemId) ?? "pendiente",
      lineTotalCents,
      tariffLineTotalCents,
      lineDiscountCents: discount != null && discount > 0 ? discount : null,
    }
  })
}

/** Suma entera exacta; null si algún importe del conjunto es desconocido. */
function sumCents(values: Array<number | null>): number | null {
  let total = 0
  for (const value of values) {
    if (value == null) return null
    total += value
  }
  return total
}

function withTotals(budget: BudgetRow, items: BudgetLineWithStatus[]): BudgetWithTotals {
  // El presupuesto suma el total de cada línea: lo que se cobra por sesión
  // cuenta todas sus visitas previstas, no solo la primera.
  const totalCents = sumCents(items.map((item) => item.lineTotalCents))
  const tariffTotalCents = sumCents(items.map((item) => item.tariffLineTotalCents))
  return {
    ...budget,
    items,
    totalCents,
    // Regla compartida con la vista previa de la interfaz (`@odentia/clinical`).
    acceptedCents: sumAcceptedCents(items),
    tariffTotalCents,
    discountCents:
      totalCents == null || tariffTotalCents == null ? null : tariffTotalCents - totalCents,
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
    if (item.priceCents === null) throw validation("Todos los ítems deben tener precio conocido")
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

/**
 * Líneas de un borrador a partir de indicaciones cotizables: precio y tarifa
 * congelados de la indicación, sin promoción, y el modo de cobro del servicio.
 * La usan preparar un presupuesto y añadirle tratamientos: misma regla.
 */
async function insertDraftLines(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  planId: string,
  budgetId: string,
  items: QuotableItem[],
  billingModes: Record<string, string>,
): Promise<void> {
  for (const item of items) {
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId,
      patientId,
      planId,
      budgetId,
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
      tariffPriceCents: item.priceCents,
      priceReason: null,
      promotionId: null,
      promotionName: null,
      promotionMode: null,
      billingMode: item.serviceId ? (billingModes[item.serviceId] ?? "treatment") : "treatment",
      sessionsPlanned: item.plannedSessions,
      currency: item.currency,
      decision: "pendiente",
      createdBy: actorUserId,
    })
    await tx
      .update(treatmentPlanItem)
      .set({ budgetId, updatedAt: new Date() })
      .where(
        and(
          eq(treatmentPlanItem.id, item.id),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
  }
}

export interface AddBudgetItemsInput {
  itemIds: string[]
}

/**
 * Añadir tratamientos del plan a un presupuesto en borrador. Entran con las
 * mismas reglas que al prepararlo (cotizables, con tarifa, misma moneda, sin
 * promoción). El borrador de una revisión no lo admite: sus tratamientos se
 * eligen al crearla.
 */
export async function addBudgetItems(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: AddBudgetItemsInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  assertOwnPlan(await lockPlan(tx, orgId, patientId, budget.planId), actorUserId, opts.memberRole)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo a un presupuesto en borrador se le añaden tratamientos")
  }
  if (current.supersedesBudgetId) {
    throw conflict(
      "BUDGET_REVISION_ITEMS",
      "Los tratamientos de una revisión se eligen al crearla",
    )
  }
  const items = await requireQuotableItems(tx, orgId, patientId, current.planId, input.itemIds)
  if (items.some((item) => item.currency !== current.currency)) {
    throw conflict("BUDGET_CURRENCY_MIX", "Los tratamientos usan otra moneda que el presupuesto")
  }
  const billingModes = await readBillingModes(
    tx,
    orgId,
    items.map((item) => item.serviceId).filter((id): id is string => id !== null),
  )
  await insertDraftLines(tx, orgId, actorUserId, patientId, current.planId, budgetId, items, billingModes)
  await audit(tx, orgId, actorUserId, "budget.items_added", budgetId, {
    patientId,
    itemIds: items.map((item) => item.id),
    itemCount: items.length,
  })
  await notifyBudget(tx, orgId)
  return withTotals(current, await listBudgetLines(tx, orgId, patientId, budgetId))
}

export interface RemoveBudgetItemsInput {
  itemIds: string[]
}

/**
 * Quitar tratamientos de un presupuesto en borrador: nadie lo ha recibido, así
 * que la línea se borra (la base solo lo permite en borrador) y la indicación
 * vuelve a quedar sin presupuestar. Lo acordado en esa línea (precio, motivo,
 * promoción) se pierde y queda en la auditoría. El borrador puede quedar sin
 * líneas, pero así no se entrega (`deliverBudget`). Como al añadir, el
 * borrador de una revisión no lo admite.
 */
export async function removeBudgetItems(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: RemoveBudgetItemsInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  assertOwnPlan(await lockPlan(tx, orgId, patientId, budget.planId), actorUserId, opts.memberRole)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo de un presupuesto en borrador se quitan tratamientos")
  }
  if (current.supersedesBudgetId) {
    throw conflict(
      "BUDGET_REVISION_ITEMS",
      "Los tratamientos de una revisión se eligen al crearla",
    )
  }
  if (!Array.isArray(input.itemIds) || input.itemIds.length < 1 || input.itemIds.length > 200) {
    throw validation("itemIds debe tener entre 1 y 200 identificadores únicos")
  }
  const ids = [...new Set(input.itemIds)].sort()
  if (ids.length !== input.itemIds.length) throw validation("itemIds no debe repetirse")
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const removed = lines.filter((line) => ids.includes(line.planItemId))
  if (removed.length !== ids.length) throw notFound("Línea del presupuesto")
  await tx
    .delete(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentBudgetItem.budgetId, budgetId),
        inArray(treatmentBudgetItem.planItemId, ids),
      ),
    )
  await tx
    .update(treatmentPlanItem)
    .set({ budgetId: null, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.budgetId, budgetId),
        inArray(treatmentPlanItem.id, ids),
      ),
    )
  await audit(tx, orgId, actorUserId, "budget.items_removed", budgetId, {
    patientId,
    itemCount: removed.length,
    removed: removed.map((line) => ({
      planItemId: line.planItemId,
      title: line.title,
      priceCents: line.priceCents,
      tariffCents: line.tariffPriceCents,
      reason: line.priceReason,
      promotion: line.promotionName,
      sessions: line.sessionsPlanned,
    })),
  })
  await notifyBudget(tx, orgId)
  return withTotals(current, await listBudgetLines(tx, orgId, patientId, budgetId))
}

export async function createBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateBudgetInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  if (!input.planId?.trim())
    throw validation("planId es obligatorio: el presupuesto pertenece a un plan")
  const plan = await lockPlan(tx, orgId, patientId, input.planId.trim())
  assertOwnPlan(plan, actorUserId, opts.memberRole)
  const items = await requireQuotableItems(tx, orgId, patientId, plan.id, input.itemIds)
  const billingModes = await readBillingModes(
    tx,
    orgId,
    items.map((item) => item.serviceId).filter((id): id is string => id !== null),
  )
  // La moneda es la de sus tratamientos (una sola); nunca la de un país fijo.
  const currency = items[0]?.currency ?? (await requireOrgCurrency(tx, orgId))
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
  await insertDraftLines(tx, orgId, actorUserId, patientId, plan.id, budget.id, items, billingModes)
  await audit(tx, orgId, actorUserId, "budget.created", budget.id, {
    patientId,
    planId: plan.id,
    budgetNumber,
    currency,
    itemCount: items.length,
  })
  await notifyBudget(tx, orgId)
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
  opts: BudgetActorOpts = {},
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
  assertOwnPlan(await lockPlan(tx, orgId, patientId, prev.planId), actorUserId, opts.memberRole)
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
  await notifyBudget(tx, orgId)
  return updated
}

/**
 * Entregar el presupuesto (sustituye a `presentBudget`): imprimir o enviar lo
 * entrega en la misma transacción. No hay paso «presentar» aparte. Exige
 * borrador con líneas y plan propio para el odontólogo.
 */
export async function deliverBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  opts: BudgetActorOpts = {},
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
  assertOwnPlan(await lockPlan(tx, orgId, patientId, prev.planId), actorUserId, opts.memberRole)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador puede entregarse")
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  if (lines.length === 0) throw validation("El presupuesto no tiene ítems")
  // El borrador pudo esperar días: al entregarlo, cada promoción debe seguir
  // vigente e incluir el servicio. Después de entregado ya no se revalida.
  for (const line of lines) {
    if (!line.promotionId || !line.serviceId) continue
    try {
      await requirePromotionPrice(tx, orgId, line.promotionId, line.serviceId, line.priceCents)
    } catch (error) {
      if (error instanceof ServiceError && error.code.startsWith("PROMOTION_"))
        throw conflict(
          "PROMOTION_NOT_LIVE",
          `La promoción «${line.promotionName ?? ""}» de «${line.title}» ya no está vigente: quítala o elige otra antes de entregar`,
        )
      throw error
    }
  }
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
  await audit(tx, orgId, actorUserId, "budget.delivered", budgetId, {
    patientId,
    itemCount: lines.length,
  })
  // Se une sola a la oportunidad del mismo tratamiento (o a la más reciente),
  // que pasa a «Presupuesto enviado» (ADR 0028).
  await linkPresentedBudget(tx, orgId, {
    patientId,
    budgetId,
    serviceIds: lines.map((line) => line.serviceId).filter((id): id is string => !!id),
  })
  await notifyBudget(tx, orgId)
  return updated
}
export interface AdjustBudgetLineInput {
  planItemId: string
  /** Precio final acordado por unidad; undefined = sin cambio. */
  priceCents?: number | null
  /** Motivo del ajuste; obligatorio si el final baja de la referencia. */
  reason?: string | null
  /** Promoción a aplicar; null = quitarla; undefined = sin cambio. */
  promotionId?: string | null
  /** Precio final con promoción «desde» (el final lo pone quien presupuesta). */
  promotionFinalPriceCents?: number | null
  /** Visitas previstas de una línea que se cobra por sesión; undefined = sin cambio. */
  sessionsPlanned?: number
}

export interface AdjustBudgetLinesInput {
  lines: AdjustBudgetLineInput[]
}

function assertPriceReason(reason: string | null | undefined): string {
  const value = reason?.trim() ?? ""
  if (!value || value.length > 500) throw validation("El motivo debe tener 1–500 caracteres")
  return value
}

/**
 * Precio acordado por línea con motivo + promoción opt-in (solo borrador).
 * `priceCents` queda como precio final; la tarifa original congelada es la
 * referencia del descuento, salvo promoción «desde», donde la referencia es
 * su mínimo anunciado. La promoción se valida vigente con la misma regla que
 * usa caja (`requirePromotionPrice`); la UI nunca calcula descuentos.
 */
export async function adjustBudgetLines(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: AdjustBudgetLinesInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  assertOwnPlan(await lockPlan(tx, orgId, patientId, budget.planId), actorUserId, opts.memberRole)
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador admite ajuste de precio")
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200) {
    throw validation("lines debe tener entre 1 y 200 ajustes")
  }
  const seen: Record<string, true> = {}
  for (const line of input.lines) {
    if (seen[line.planItemId]) throw validation("Cada tratamiento se ajusta una sola vez")
    seen[line.planItemId] = true
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const byItem: Record<string, (typeof lines)[number]> = {}
  for (const line of lines) byItem[line.planItemId] = line
  const now = new Date()
  const changes: Array<Record<string, unknown>> = []
  for (const patch of input.lines) {
    const line = byItem[patch.planItemId]
    if (!line) throw notFound("Línea del presupuesto")
    let priceCents = line.priceCents
    let priceReason = line.priceReason
    let promotionId = line.promotionId
    let promotionName = line.promotionName
    let promotionMode = line.promotionMode
    let sessionsPlanned = line.sessionsPlanned
    if (patch.sessionsPlanned !== undefined) {
      if (line.billingMode !== "session")
        throw validation("Las visitas previstas solo aplican a lo que se cobra por sesión")
      if (!Number.isInteger(patch.sessionsPlanned) || patch.sessionsPlanned < 1 || patch.sessionsPlanned > 200)
        throw validation("Las visitas previstas van de 1 a 200")
      sessionsPlanned = patch.sessionsPlanned
    }
    if (patch.promotionId !== undefined) {
      if (patch.promotionId === null) {
        // Quitar la promoción devuelve la tarifa: su precio no era un
        // descuento acordado y no necesita motivo.
        if (promotionId) {
          priceCents = line.tariffPriceCents ?? priceCents
          priceReason = null
        }
        promotionId = null
        promotionName = null
        promotionMode = null
      } else {
        if (!line.serviceId) {
          throw conflict("PROMOTION_NO_SERVICE", "La línea no tiene servicio para promocionar")
        }
        const snapshot = await requirePromotionPrice(
          tx,
          orgId,
          patch.promotionId,
          line.serviceId,
          patch.promotionFinalPriceCents ?? patch.priceCents ?? undefined,
        )
        if (snapshot.currency !== line.currency) {
          throw conflict("CURRENCY_MISMATCH", "La promoción usa otra moneda")
        }
        promotionId = snapshot.promotionId
        promotionName = snapshot.promotionName
        promotionMode = snapshot.mode
        priceCents = snapshot.priceCents
        priceReason = patch.reason?.trim() ? assertPriceReason(patch.reason) : null
      }
    }
    if (patch.priceCents !== undefined && patch.priceCents !== null) {
      if (!Number.isSafeInteger(patch.priceCents) || patch.priceCents < 0 || patch.priceCents > 2147483647) {
        throw validation("priceCents debe ser un entero >= 0")
      }
      priceCents = patch.priceCents
    }
    if (priceCents == null) throw validation("La línea no tiene precio acordado")
    if (promotionMode === "fixed" && promotionId && line.serviceId) {
      const snapshot = await requirePromotionPrice(tx, orgId, promotionId, line.serviceId, undefined)
      if (priceCents !== snapshot.priceCents) {
        throw conflict("PROMOTION_FIXED_PRICE", "El precio fijo de la promoción no se negocia")
      }
    }
    const reference =
      promotionMode === "from" && promotionId && line.serviceId
        ? (await requirePromotionPrice(tx, orgId, promotionId, line.serviceId, priceCents)).floorCents ?? line.tariffPriceCents
        : (line.tariffPriceCents ?? priceCents)
    if (promotionId === null || promotionMode === "from") {
      if (priceCents < (reference ?? priceCents)) {
        priceReason = assertPriceReason(patch.reason ?? priceReason)
      } else if (patch.reason !== undefined) {
        priceReason = patch.reason?.trim() ? assertPriceReason(patch.reason) : null
      }
    }
    lineTotal({ billingMode: line.billingMode, sessionsPlanned }, priceCents)
    await tx
      .update(treatmentBudgetItem)
      .set({ priceCents, priceReason, promotionId, promotionName, promotionMode, sessionsPlanned, updatedAt: now })
      .where(
        and(
          eq(treatmentBudgetItem.id, line.id),
          eq(treatmentBudgetItem.organizationId, orgId),
        ),
      )
    // El motivo se sobrescribe en la línea: la auditoría conserva cada cambio.
    changes.push({
      lineId: line.id,
      planItemId: line.planItemId,
      title: line.title,
      fromCents: line.priceCents,
      toCents: priceCents,
      tariffCents: line.tariffPriceCents,
      reason: priceReason,
      fromPromotion: line.promotionName,
      toPromotion: promotionName,
      fromSessions: line.sessionsPlanned,
      toSessions: sessionsPlanned,
    })
  }
  await audit(tx, orgId, actorUserId, "budget.prices_adjusted", budgetId, {
    patientId,
    lineCount: input.lines.length,
    changes,
  })
  await notifyBudget(tx, orgId)
  return withTotals(await requireBudget(tx, orgId, patientId, budgetId), await listBudgetLines(tx, orgId, patientId, budgetId))
}


export async function decideBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  input: DecideBudgetInput,
  opts: BudgetActorOpts & { skipOwnPlan?: boolean } = {},
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
  if (!opts.skipOwnPlan) {
    assertOwnPlan(await lockPlan(tx, orgId, patientId, prev.planId), actorUserId, opts.memberRole)
  } else {
    await lockPlan(tx, orgId, patientId, prev.planId)
  }
  await lockBudgetRow(tx, orgId, patientId, budgetId)
  const current = await requireBudget(tx, orgId, patientId, budgetId)
  // Responder después: un parcial/pospuesto admite completar lo pospuesto sin
  // reescribir lo ya decidido; otra autoridad no pisa la decisión registrada.
  const isFollowUp = current.status === "parcial" || current.status === "pospuesto"
  if (current.status !== "presentado" && !isFollowUp) {
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
  if (isFollowUp) {
    if (current.decisionContactId && representative && current.decisionContactId !== representative.id) {
      throw conflict("BUDGET_DECISION_OWNER", "Solo quien decidió puede completar su respuesta")
    }
    for (const line of lines) {
      if (line.decision !== "pospuesto") {
        const next = decisions.get(line.planItemId)
        if (next !== line.decision) {
          throw conflict("BUDGET_DECISION_FINAL", "Lo ya decidido no se reescribe al completar")
        }
      }
    }
  }
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
  // Aceptarlo, aunque sea en parte, gana su oportunidad; rechazarlo la pierde.
  await decideBudgetOpportunity(tx, orgId, {
    patientId,
    budgetId,
    status,
    serviceIds: lines.map((line) => line.serviceId).filter((id): id is string => !!id),
  })
  await notifyBudget(tx, orgId)
  return withTotals(updated, await listBudgetLines(tx, orgId, patientId, budgetId))
}

export async function cancelBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  opts: BudgetActorOpts = {},
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
  assertOwnPlan(await lockPlan(tx, orgId, patientId, prev.planId), actorUserId, opts.memberRole)
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
  await notifyBudget(tx, orgId)
  return updated
}

/**
 * Planes propios del odontólogo (restricción objeto de lectura): el
 * odontólogo solo ve presupuestos de planes que creó él. Caja y
 * administración ven todos (la ruta ya exige `budgets.read`).
 */
async function assertOwnBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  memberRole: string | undefined,
  planId: string,
): Promise<void> {
  if ((memberRole ?? "").trim().toLowerCase() !== "dentist") return
  const [plan] = await tx
    .select({ createdBy: treatmentPlan.createdBy })
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.id, planId), eq(treatmentPlan.organizationId, orgId)))
    .limit(1)
  if (!plan || plan.createdBy !== actorUserId) {
    throw new ServiceError("BUDGET_NOT_OWN_PLAN", 403, "Solo puedes ver presupuestos de tu plan")
  }
}

export async function listBudgets(
  tx: Db,
  orgId: string,
  patientId: string,
  planId?: string,
  opts: BudgetActorOpts & { actorUserId?: string } = {},
): Promise<BudgetWithTotals[]> {
  await requirePatient(tx, orgId, patientId)
  const conditions = [
    eq(treatmentBudget.patientId, patientId),
    eq(treatmentBudget.organizationId, orgId),
  ]
  if (planId) conditions.push(eq(treatmentBudget.planId, planId))
  if ((opts.memberRole ?? "").trim().toLowerCase() === "dentist" && opts.actorUserId) {
    const ownPlans = tx
      .select({ id: treatmentPlan.id })
      .from(treatmentPlan)
      .where(
        and(
          eq(treatmentPlan.organizationId, orgId),
          eq(treatmentPlan.patientId, patientId),
          eq(treatmentPlan.createdBy, opts.actorUserId),
        ),
      )
    conditions.push(sql`${treatmentBudget.planId} IN (${ownPlans})`)
  }
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
  opts: BudgetActorOpts & { actorUserId?: string } = {},
): Promise<BudgetWithTotals> {
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  if (opts.actorUserId) await assertOwnBudget(tx, orgId, opts.actorUserId, opts.memberRole, budget.planId)
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
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const previous = await requireBudget(tx, orgId, patientId, budgetId)
  assertOwnPlan(await lockPlan(tx, orgId, patientId, previous.planId), actorUserId, opts.memberRole)
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
    if (item.priceCents == null || item.currency !== current.currency) throw conflict("BUDGET_CURRENCY_MIX", "Todas las líneas requieren precio en la moneda de la propuesta")
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
  // Un tratamiento que entra nuevo a la revisión toma el modo de cobro de su servicio.
  const billingModes = await readBillingModes(
    tx,
    orgId,
    items.map((item) => item.serviceId).filter((id): id is string => !!id),
  )
  const revisedAt = new Date()
  for (const item of items) {
    const snapshot = oldLines.find(l => l.planItemId === item.id) ?? item
    const carried = "tariffPriceCents" in snapshot ? snapshot as BudgetLineWithStatus : null
    // La revisión conserva lo acordado, salvo una promoción que ya terminó:
    // esa línea vuelve a su tarifa y queda a la vista en el borrador.
    let promotion = carried?.promotionId
      ? { id: carried.promotionId, name: carried.promotionName, mode: carried.promotionMode }
      : null
    let priceCents = snapshot.priceCents
    let priceReason = carried?.priceReason ?? null
    if (promotion) {
      const [promo] = await tx
        .select()
        .from(promotionTable)
        .where(and(eq(promotionTable.id, promotion.id), eq(promotionTable.organizationId, orgId)))
        .limit(1)
      if (!promo || !isPromotionLive(promo, revisedAt)) {
        promotion = null
        priceCents = carried?.tariffPriceCents ?? item.priceCents
        priceReason = null
      }
    }
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId, patientId, planId: current.planId, budgetId: revision.id,
      planItemId: item.id, serviceId: snapshot.serviceId, title: snapshot.title,
      scope: snapshot.scope, toothNumber: snapshot.toothNumber, surfaces: snapshot.surfaces,
      quadrant: snapshot.quadrant, arch: snapshot.arch, codings: snapshot.codings,
      priceCents,
      tariffPriceCents: carried?.tariffPriceCents ?? item.priceCents,
      priceReason,
      promotionId: promotion?.id ?? null,
      promotionName: promotion?.name ?? null,
      promotionMode: promotion?.mode ?? null,
      billingMode:
        carried?.billingMode ?? (item.serviceId ? (billingModes[item.serviceId] ?? "treatment") : "treatment"),
      sessionsPlanned: carried?.sessionsPlanned ?? item.plannedSessions,
      currency: snapshot.currency, createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "budget.revised", revision.id, { patientId, reason, supersedesBudgetId: current.id })
  await notifyBudget(tx, orgId)
  return withTotals(revision, await listBudgetLines(tx, orgId, patientId, revision.id))
}

export interface BudgetPrintLine {
  title: string
  detail: string | null
  /** Precio de referencia de la unidad (tarifa, o lo acordado si es mayor). */
  listUnitCents: number | null
  /** Precio final acordado de la unidad (el tratamiento o cada visita). */
  unitCents: number | null
  /** Visitas previstas si se cobra por sesión; si no, 1. */
  units: number
  /** Total de la línea a precio de referencia y a precio acordado. */
  listTotalCents: number | null
  totalCents: number | null
  /** Rebaja de la línea (referencia − acordado; nunca negativa). */
  discountCents: number | null
  promotionName: string | null
  billingMode: string
  sessionsPlanned: number | null
  decision: string
}

export interface BudgetPrintPayload {
  /** UN/CEFACT 1001: 310 = oferta/cotización. */
  quotationCode: "310"
  /** Hoja del presupuesto según la clínica: A4 (ISO 216) o Carta. */
  paper: string
  budgetNumber: number
  revisionNumber: number
  title: string
  planTitle: string
  status: string
  isDraft: boolean
  notes: string | null
  currency: string
  locale: string
  timezone: string
  issuedAt: Date
  clinic: { name: string; branchName: string | null; address: string | null; phone: string | null }
  patient: { displayName: string; docType: string | null; docNumber: string | null }
  professional: { name: string; title: string | null; registration: string | null } | null
  lines: BudgetPrintLine[]
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
}

/**
 * Contenido de la hoja del presupuesto (lo que imprime el PDF): precios
 * finales acordados, referencia del descuento y código de cotización 310.
 * Moneda, formato, zona y papel salen del perfil de la clínica.
 */
export async function getBudgetPrintPayload(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
  opts: BudgetActorOpts & { actorUserId?: string } = {},
): Promise<BudgetPrintPayload> {
  const budget = await getBudgetDetail(tx, orgId, patientId, budgetId, opts)
  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  if (!profile) throw notFound("Perfil de organización")
  const [patientRow] = await tx
    .select({
      displayName: patient.displayName,
      docType: patient.docType,
      docNumber: patient.docNumber,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!patientRow) throw notFound("Paciente")
  const [planRow] = await tx
    .select({ title: treatmentPlan.title, createdBy: treatmentPlan.createdBy })
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.id, budget.planId), eq(treatmentPlan.organizationId, orgId)))
    .limit(1)
  let professional: BudgetPrintPayload["professional"] = null
  if (planRow?.createdBy) {
    const [author] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, planRow.createdBy))
      .limit(1)
    if (author) {
      let signature: { title?: string | null; registration?: string | null } | null = null
      try {
        signature = await requireProfessionalSignature(tx, orgId, planRow.createdBy)
      } catch {
        signature = null
      }
      professional = {
        name: author.name,
        title: signature?.title ?? null,
        registration: signature?.registration ?? null,
      }
    }
  }
  // El presupuesto no pertenece a una sede. Si la clínica tiene una sola, la
  // hoja lleva su nombre, dirección y teléfono; con varias, los de la clínica.
  const branches = await tx
    .select({ name: branch.name, addressLine1: branch.addressLine1, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  const onlyBranch = branches.length === 1 ? branches[0]! : null
  const lines: BudgetPrintLine[] = budget.items.map((line) => {
    const units = budgetLineUnits(line)
    const unitCents = line.priceCents
    // La referencia nunca queda por debajo de lo acordado: un precio mayor
    // que la tarifa no se imprime como «descuento negativo».
    const listUnitCents =
      unitCents == null
        ? null
        : Math.max(line.tariffPriceCents ?? unitCents, unitCents)
    const totalCents = unitCents == null ? null : unitCents * units
    const listTotalCents = listUnitCents == null ? null : listUnitCents * units
    return {
      title: line.title,
      detail: line.toothNumber != null ? `pieza ${line.toothNumber}` : null,
      listUnitCents,
      unitCents,
      units,
      listTotalCents,
      totalCents,
      discountCents:
        listTotalCents != null && totalCents != null ? listTotalCents - totalCents : null,
      promotionName: line.promotionName,
      billingMode: line.billingMode,
      sessionsPlanned: line.sessionsPlanned,
      decision: line.decision,
    }
  })
  const subtotalCents = sumCents(lines.map((line) => line.listTotalCents))
  return {
    quotationCode: "310",
    paper: profile.sheetSize,
    budgetNumber: budget.budgetNumber,
    revisionNumber: budget.revisionNumber,
    title: budget.title,
    planTitle: planRow?.title ?? budget.title,
    status: budget.status,
    isDraft: budget.status === "borrador",
    notes: budget.notes,
    currency: budget.currency,
    locale: profile.locale,
    timezone: profile.timezone,
    issuedAt: budget.presentedAt ?? budget.createdAt,
    clinic: {
      name: profile.tradeName || profile.legalName || "",
      branchName: onlyBranch?.name ?? null,
      address: onlyBranch?.addressLine1 ?? profile.fiscalAddress ?? null,
      phone: onlyBranch?.phone ?? null,
    },
    patient: patientRow,
    professional,
    lines,
    subtotalCents,
    discountCents:
      subtotalCents == null || budget.totalCents == null ? null : subtotalCents - budget.totalCents,
    totalCents: budget.totalCents,
  }
}
