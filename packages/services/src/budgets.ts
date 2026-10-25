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
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { promotion as promotionTable } from "@odentia/db/schema/promotions"
import {
  BUDGET_OPTIONS_MAX,
  budgetOptionLabel,
  budgetStateText,
  sumAcceptedCents,
} from "@odentia/clinical"
import { and, asc, eq, inArray, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import { budgetAwaitsAnswer } from "./budget-awaiting.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { requireOrgCurrency } from "./locale.js"
import { decideBudgetOpportunity, linkPresentedBudget } from "./opportunities.js"
import { requirePatient } from "./patients.js"
import type { PlanItemDecision } from "./plan.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import { isPromotionLive, requirePromotionPrice } from "./promotions.js"

import { branchAddressColumns, branchAddressWriter } from "./branches.js"
import { requireDecisionContact } from "./responsibilities.js"
import { assertExecutableCodings } from "./procedure-codings.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import type { ProductSite, SiteFields } from "./product-hooks.js"
import { productHooks } from "./products.js"

/**
 * Documento económico de un plan clínico: cabecera con decisión auditada +
 * líneas snapshot de lo realmente cotizado (no un join mutable a la oferta
 * vigente). El presupuesto nace de un plan (nunca aislado), con ítems
 * elegibles explícitos y una sola moneda. La decisión por línea se conserva
 * como evidencia; la indicación guarda la decisión clínica vigente.
 *
 * Fase 3, paso 3 (ADR 0034):
 * - Un solo borrador por persona, que crece con cada atención: al firmarla
 *   entra lo indicado en ella (`assembleEncounterBudget`). Si el anterior ya se
 *   envió, lo nuevo abre otro solo con lo nuevo.
 * - Dos o tres opciones en un mismo presupuesto (decisión 13): cada opción
 *   tiene sus líneas y su propio total, nunca sumados. La persona elige una y
 *   dentro de ella puede dejar algo para después; las otras quedan «No
 *   elegida». Mientras decide, el valor es el de la recomendada; después, el
 *   de lo elegido.
 * - El odontólogo actúa sobre lo que él indicó (`treatment_plan_item.created_by`),
 *   no sobre «su plan»: el plan es uno por persona.
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
] as const
export type BudgetStatus = (typeof BUDGET_STATUSES)[number]

export type BudgetRow = typeof treatmentBudget.$inferSelect
/** La línea con su sitio como lo dice el producto (odentIA: pieza y caras). */
export type BudgetLineRow = typeof treatmentBudgetItem.$inferSelect & SiteFields
export type BudgetOptionRow = typeof treatmentBudgetOption.$inferSelect

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

/** Una opción con sus totales: nunca se suman entre opciones. */
export interface BudgetOptionWithTotals {
  id: string
  position: number
  /** «Opción A». */
  label: string
  isRecommended: boolean
  /** `pendiente` mientras decide, `elegida` o `no_elegida`. */
  decision: string
  lineCount: number
  totalCents: number | null
  acceptedCents: number | null
  tariffTotalCents: number | null
  discountCents: number | null
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
  /** Todas las líneas, de todas las opciones (cada una dice su `optionId`). */
  items: BudgetLineWithStatus[]
  /** Las opciones, en orden; con una sola, la pantalla no habla de opciones. */
  options: BudgetOptionWithTotals[]
  /**
   * Total que vale el presupuesto: el de la opción elegida o, mientras decide,
   * el de la recomendada. Nunca la suma de las opciones.
   */
  totalCents: number | null
  acceptedCents: number | null
  /** Suma de tarifas originales de esa misma opción (referencia del descuento). */
  tariffTotalCents: number | null
  /** Rebaja total acordada (tarifa − final; null si algún precio es desconocido). */
  discountCents: number | null
  /** Espera la respuesta de quien decide (`budgetAwaitsAnswer`): la pantalla no lo deduce del estado. */
  awaitsAnswer: boolean
  /** El estado dicho con un solo nombre en toda la aplicación (`budgetStateText`). */
  stateText: string
}

/** Quién actúa en la ruta: el servidor limita al odontólogo a lo que indicó. */
export interface BudgetActorOpts {
  memberRole?: string
  /** Quién entrega el presupuesto: el agente o el equipo (la oportunidad lo dice). */
  by?: "agente" | "persona"
}

/** Aviso en vivo (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notifyBudget(tx: Db, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind: "budget.updated", at: new Date().toISOString() })})`,
  )
}

export function isProfessional(memberRole?: string): boolean {
  return (memberRole ?? "").trim().toLowerCase() === "clinician"
}

/**
 * Lo propio del odontólogo: el presupuesto lo preparó él o lleva algún
 * tratamiento que él indicó. Administración y propietario no tienen esta
 * restricción; caja y recepción no arman presupuestos (la ruta lo decide).
 */
function ownBudgetSql(actorUserId: string) {
  return ownBudgetOf(treatmentBudget, actorUserId)
}

/** La misma regla sobre cualquier alias de `treatment_budget` (el buscador rápido usa SQL a mano). */
export function ownBudgetOf(
  budget: { id: SQLWrapper; organizationId: SQLWrapper; createdBy: SQLWrapper },
  actorUserId: string,
): SQL {
  return sql`(${budget.createdBy} = ${actorUserId} or exists (
    select 1 from treatment_budget_item own_line
      join treatment_plan_item own_item on own_item.id = own_line.plan_item_id and own_item.organization_id = own_line.organization_id
    where own_line.organization_id = ${budget.organizationId} and own_line.budget_id = ${budget.id}
      and own_item.created_by = ${actorUserId}))`
}

async function assertOwnBudget(
  tx: Db,
  orgId: string,
  budgetId: string,
  actorUserId: string | null,
  memberRole?: string,
  message = "Solo puedes actuar sobre presupuestos de lo que indicaste tú",
): Promise<void> {
  if (!isProfessional(memberRole) || !actorUserId) return
  const [own] = await tx
    .select({ id: treatmentBudget.id })
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId), ownBudgetSql(actorUserId)))
    .limit(1)
  if (!own) throw new ServiceError("BUDGET_NOT_OWN_PLAN", 403, message)
}

/** El odontólogo solo presupuesta lo que él indicó. */
function assertOwnItems(items: ReadonlyArray<{ createdBy: string | null }>, actorUserId: string, memberRole?: string): void {
  if (!isProfessional(memberRole)) return
  if (items.some((item) => item.createdBy !== actorUserId)) {
    throw new ServiceError("BUDGET_NOT_OWN_PLAN", 403, "Solo puedes presupuestar lo que indicaste tú")
  }
}

/**
 * Presupuesto propio del odontólogo para reutilizar fuera de presupuestos (envío
 * de documentos): misma regla y mismo código `BUDGET_NOT_OWN_PLAN`.
 */
export async function requireOwnBudget(
  tx: Db,
  orgId: string,
  budgetId: string,
  actorUserId: string,
  memberRole?: string,
): Promise<void> {
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, memberRole, "Solo puedes actuar sobre presupuestos de lo que indicaste tú")
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
  /** Plan de los tratamientos; si falta, el de los tratamientos elegidos. */
  planId?: string | null
  itemIds: string[]
  title?: string | null
  notes?: string | null
}

export interface UpdateBudgetDraftInput {
  title?: string
  notes?: string | null
}

export interface DecideBudgetInput {
  /** La opción que eligió; obligatoria si el presupuesto tiene más de una. */
  optionId?: string | null
  /** Una respuesta por cada línea de la opción elegida. */
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
  actorUserId: string | null,
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

/** Plan del presupuesto bloqueado y, después, su cabecera: el orden de locks de siempre. */
async function lockForWrite(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetRow> {
  const budget = await requireBudget(tx, orgId, patientId, budgetId)
  await lockPlan(tx, orgId, patientId, budget.planId)
  return lockBudgetRow(tx, orgId, patientId, budgetId)
}

async function listOptions(tx: Db, orgId: string, budgetIds: string[]): Promise<BudgetOptionRow[]> {
  if (budgetIds.length === 0) return []
  return tx
    .select()
    .from(treatmentBudgetOption)
    .where(and(eq(treatmentBudgetOption.organizationId, orgId), inArray(treatmentBudgetOption.budgetId, budgetIds)))
    .orderBy(asc(treatmentBudgetOption.position))
}

async function listBudgetLines(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetLineWithStatus[]> {
  return (await budgetLinesOf(tx, orgId, [budgetId], patientId)).get(budgetId) ?? []
}

/**
 * Las líneas de esos presupuestos, cada una con el estado de su tratamiento,
 * por presupuesto y en el orden del plan. Una vez para muchos presupuestos
 * (`listBudgetsForPatients`), con la misma forma que las de uno.
 */
async function budgetLinesOf(
  tx: Db,
  orgId: string,
  budgetIds: string[],
  patientId?: string,
): Promise<Map<string, BudgetLineWithStatus[]>> {
  const out = new Map<string, BudgetLineWithStatus[]>()
  if (budgetIds.length === 0) return out
  const site = (await productHooks(tx, orgId)).site
  const lines = await tx
    .select({ line: treatmentBudgetItem, position: treatmentBudgetOption.position })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentBudgetOption,
      and(
        eq(treatmentBudgetOption.id, treatmentBudgetItem.optionId),
        eq(treatmentBudgetOption.organizationId, treatmentBudgetItem.organizationId),
      ),
    )
    // Las líneas en el orden del plan: las que se copian juntas comparten la hora de alta.
    .leftJoin(
      treatmentPlanItem,
      and(
        eq(treatmentPlanItem.id, treatmentBudgetItem.planItemId),
        eq(treatmentPlanItem.organizationId, treatmentBudgetItem.organizationId),
      ),
    )
    .where(
      and(
        inArray(treatmentBudgetItem.budgetId, budgetIds),
        eq(treatmentBudgetItem.organizationId, orgId),
        ...(patientId ? [eq(treatmentBudgetItem.patientId, patientId)] : []),
      ),
    )
    .orderBy(
      asc(treatmentBudgetOption.position),
      asc(treatmentPlanItem.sortOrder),
      asc(treatmentBudgetItem.createdAt),
      asc(treatmentBudgetItem.id),
    )
  const statuses = new Map<string, string>()
  if (lines.length > 0) {
    const items = await tx
      .select({ id: treatmentPlanItem.id, status: treatmentPlanItem.status })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          inArray(treatmentPlanItem.id, [...new Set(lines.map((l) => l.line.planItemId))]),
        ),
      )
    for (const item of items) statuses.set(item.id, item.status)
  }
  for (const { line } of lines) {
    const lineTotalCents = lineTotal(line, line.priceCents)
    const tariffLineTotalCents = lineTotal(line, line.tariffPriceCents ?? line.priceCents)
    const discount =
      lineTotalCents != null && tariffLineTotalCents != null
        ? tariffLineTotalCents - lineTotalCents
        : null
    const list = out.get(line.budgetId) ?? []
    list.push({
      ...line,
      ...site.fields(line),
      itemStatus: statuses.get(line.planItemId) ?? "pendiente",
      lineTotalCents,
      tariffLineTotalCents,
      lineDiscountCents: discount != null && discount > 0 ? discount : null,
    })
    out.set(line.budgetId, list)
  }
  return out
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

/** La opción que vale: la elegida o, mientras decide, la recomendada (o la primera). */
export function valueOptionOf<T extends { decision: string; isRecommended: boolean }>(options: readonly T[]): T | null {
  return (
    options.find((option) => option.decision === "elegida") ??
    options.find((option) => option.isRecommended) ??
    options[0] ??
    null
  )
}

/**
 * La misma regla que `valueOptionOf`, en SQL: la opción que vale de una fila de
 * `treatment_budget` (la elegida, si no la recomendada, si no la primera). Para
 * lo que suma presupuestos en la base (Reportes): nunca se suman las opciones.
 * Cambian juntas; su prueba las compara.
 */
export function budgetValueOptionSql(budget: { id: SQLWrapper; organizationId: SQLWrapper }): SQL {
  return sql`(select value_option.id from treatment_budget_option value_option
    where value_option.organization_id = ${budget.organizationId} and value_option.budget_id = ${budget.id}
    order by (value_option.decision = 'elegida') desc, value_option.is_recommended desc, value_option.position
    limit 1)`
}

/** Las visitas que cuenta una línea (`budgetLineUnits`), en SQL sobre el alias de la línea. */
export function budgetLineUnitsSql(line: { billingMode: SQLWrapper; sessionsPlanned: SQLWrapper }): SQL {
  return sql`(case when ${line.billingMode} = 'session' then greatest(coalesce(${line.sessionsPlanned}, 1), 1) else 1 end)`
}

function optionTotals(option: BudgetOptionRow, items: BudgetLineWithStatus[]): BudgetOptionWithTotals {
  const lines = items.filter((line) => line.optionId === option.id)
  const totalCents = sumCents(lines.map((line) => line.lineTotalCents))
  const tariffTotalCents = sumCents(lines.map((line) => line.tariffLineTotalCents))
  return {
    id: option.id,
    position: option.position,
    label: budgetOptionLabel(option.position),
    isRecommended: option.isRecommended,
    decision: option.decision,
    lineCount: lines.length,
    totalCents,
    acceptedCents: sumAcceptedCents(lines),
    tariffTotalCents,
    discountCents: totalCents == null || tariffTotalCents == null ? null : tariffTotalCents - totalCents,
  }
}

function withTotals(budget: BudgetRow, items: BudgetLineWithStatus[], optionRows: BudgetOptionRow[]): BudgetWithTotals {
  const options = optionRows.map((option) => optionTotals(option, items))
  // El presupuesto vale lo de una sola opción (la elegida o la recomendada): lo
  // que se cobra por sesión cuenta todas sus visitas previstas.
  const value = valueOptionOf(options)
  return {
    ...budget,
    items,
    options,
    totalCents: value ? value.totalCents : 0,
    // Regla compartida con la vista previa de la interfaz (`@odentia/clinical`):
    // solo la opción elegida tiene líneas aceptadas.
    acceptedCents: sumAcceptedCents(items),
    tariffTotalCents: value ? value.tariffTotalCents : 0,
    discountCents: value ? value.discountCents : 0,
    awaitsAnswer: budgetAwaitsAnswer({ status: budget.status, items }),
    stateText: budgetStateText({ status: budget.status, items, options }),
  }
}

async function loadBudget(tx: Db, orgId: string, patientId: string, budget: BudgetRow): Promise<BudgetWithTotals> {
  return withTotals(budget, await listBudgetLines(tx, orgId, patientId, budget.id), await listOptions(tx, orgId, [budget.id]))
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

function assertItemIds(itemIds: string[]): string[] {
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 200) {
    throw validation("itemIds debe tener entre 1 y 200 identificadores únicos")
  }
  const sorted = [...new Set(itemIds)].sort()
  if (sorted.length !== itemIds.length) throw validation("itemIds no debe repetirse")
  return sorted
}

/**
 * Ítems elegibles para un documento: sin presupuesto vigente, con presupuesto
 * cancelado o rechazados; o ya de este mismo borrador (`intoBudgetId`), para
 * ponerlos en otra de sus opciones. No duplican cotización vigente, no
 * recotizan un aceptado ni uno realizado. Todos con tarifa conocida y una sola
 * moneda. Lock: plan → presupuestos vigentes (UUID ordenado) → ítems.
 */
async function requireQuotableItems(
  tx: Db,
  orgId: string,
  patientId: string,
  planId: string,
  itemIds: string[],
  intoBudgetId?: string,
): Promise<QuotableItem[]> {
  const sorted = assertItemIds(itemIds)
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
    ...new Set(
      items.map((i) => i.budgetId).filter((id): id is string => id !== null && id !== intoBudgetId),
    ),
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
  for (const item of locked) {
    if (!item.budgetId || item.budgetId === intoBudgetId) continue
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
    if (decision !== "rechazado" && decision !== "no_elegida" && budget.status !== "cancelado") {
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
  actorUserId: string | null,
  patientId: string,
  planId: string,
  budgetId: string,
  optionId: string,
  items: QuotableItem[],
  billingModes: Record<string, string>,
): Promise<void> {
  for (const item of items) {
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId,
      patientId,
      planId,
      budgetId,
      optionId,
      planItemId: item.id,
      serviceId: item.serviceId,
      title: item.title,
      scope: item.scope,
      siteSystem: item.siteSystem,
      siteCode: item.siteCode,
      siteQualifiers: item.siteQualifiers,
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
  }
  const ids = items.map((item) => item.id)
  if (ids.length > 0) {
    await tx
      .update(treatmentPlanItem)
      .set({ budgetId, updatedAt: new Date() })
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          inArray(treatmentPlanItem.id, ids),
        ),
      )
  }
}

/** Un tratamiento sin líneas en el presupuesto deja de apuntarlo: vuelve a quedar sin presupuestar. */
async function releaseOrphanItems(tx: Db, orgId: string, patientId: string, budgetId: string, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return
  const still = await tx
    .select({ planItemId: treatmentBudgetItem.planItemId })
    .from(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.budgetId, budgetId),
        inArray(treatmentBudgetItem.planItemId, itemIds),
      ),
    )
  const kept = new Set(still.map((row) => row.planItemId))
  const orphans = itemIds.filter((id) => !kept.has(id))
  if (orphans.length === 0) return
  await tx
    .update(treatmentPlanItem)
    .set({ budgetId: null, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.budgetId, budgetId),
        inArray(treatmentPlanItem.id, orphans),
      ),
    )
}

/** La opción pedida del presupuesto, o todas si no se pide ninguna. */
async function targetOptions(tx: Db, orgId: string, budgetId: string, optionId?: string | null): Promise<BudgetOptionRow[]> {
  const options = await listOptions(tx, orgId, [budgetId])
  if (!optionId) return options
  const option = options.find((row) => row.id === optionId)
  if (!option) throw notFound("Opción del presupuesto")
  return [option]
}

function assertDraftOwnItems(current: BudgetRow): void {
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo a un presupuesto en borrador se le cambian los tratamientos")
  }
  if (current.supersedesBudgetId) {
    throw conflict(
      "BUDGET_REVISION_ITEMS",
      "Los tratamientos de una revisión se eligen al crearla",
    )
  }
}

export interface AddBudgetItemsInput {
  itemIds: string[]
  /** La opción donde entran; sin ella, entran en todas. */
  optionId?: string | null
}

/**
 * Añadir tratamientos del plan a un presupuesto en borrador. Entran con las
 * mismas reglas que al prepararlo (cotizables, con tarifa, misma moneda, sin
 * promoción), en la opción pedida o en todas. El borrador de una revisión no
 * lo admite: sus tratamientos se eligen al crearla.
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
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  assertDraftOwnItems(current)
  const items = await requireQuotableItems(tx, orgId, patientId, current.planId, input.itemIds, budgetId)
  assertOwnItems(items, actorUserId, opts.memberRole)
  const added = await addLinesToOptions(tx, orgId, actorUserId, patientId, current, items, input.optionId)
  if (added === 0) throw conflict("ITEM_ALREADY_QUOTED", "El tratamiento ya está en ese presupuesto")
  await audit(tx, orgId, actorUserId, "budget.items_added", budgetId, {
    patientId,
    itemIds: items.map((item) => item.id),
    itemCount: items.length,
    ...(input.optionId ? { optionId: input.optionId } : {}),
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, current)
}

/** Pone cada tratamiento en las opciones pedidas donde aún no está. */
async function addLinesToOptions(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  budget: BudgetRow,
  items: QuotableItem[],
  optionId?: string | null,
): Promise<number> {
  if (items.some((item) => item.currency !== budget.currency)) {
    throw conflict("BUDGET_CURRENCY_MIX", "Los tratamientos usan otra moneda que el presupuesto")
  }
  const options = await targetOptions(tx, orgId, budget.id, optionId)
  const billingModes = await readBillingModes(
    tx,
    orgId,
    items.map((item) => item.serviceId).filter((id): id is string => id !== null),
  )
  const present = await tx
    .select({ optionId: treatmentBudgetItem.optionId, planItemId: treatmentBudgetItem.planItemId })
    .from(treatmentBudgetItem)
    .where(and(eq(treatmentBudgetItem.organizationId, orgId), eq(treatmentBudgetItem.budgetId, budget.id)))
  // Lo que ya está en una opción no se repite en ella.
  let added = 0
  for (const option of options) {
    const missing = items.filter(
      (item) => !present.some((row) => row.optionId === option.id && row.planItemId === item.id),
    )
    added += missing.length
    await insertDraftLines(tx, orgId, actorUserId, patientId, budget.planId, budget.id, option.id, missing, billingModes)
  }
  return added
}

export interface RemoveBudgetItemsInput {
  itemIds: string[]
  /** La opción de donde salen; sin ella, salen de todas. */
  optionId?: string | null
}

/**
 * Quitar tratamientos de un presupuesto en borrador: nadie lo ha recibido, así
 * que la línea se borra (la base solo lo permite en borrador). El tratamiento
 * que ya no está en ninguna opción vuelve a quedar sin presupuestar. Lo
 * acordado en esa línea (precio, motivo, promoción) se pierde y queda en la
 * auditoría. El borrador puede quedar sin líneas, pero así no se entrega
 * (`deliverBudget`). Como al añadir, el borrador de una revisión no lo admite.
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
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  assertDraftOwnItems(current)
  const ids = assertItemIds(input.itemIds)
  const options = await targetOptions(tx, orgId, budgetId, input.optionId)
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const removed = lines.filter(
    (line) => ids.includes(line.planItemId) && options.some((option) => option.id === line.optionId),
  )
  if (new Set(removed.map((line) => line.planItemId)).size !== ids.length) throw notFound("Línea del presupuesto")
  if (isProfessional(opts.memberRole)) {
    const owners = await tx
      .select({ createdBy: treatmentPlanItem.createdBy })
      .from(treatmentPlanItem)
      .where(and(eq(treatmentPlanItem.organizationId, orgId), inArray(treatmentPlanItem.id, ids)))
    assertOwnItems(owners, actorUserId, opts.memberRole)
  }
  await tx
    .delete(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentBudgetItem.budgetId, budgetId),
        inArray(treatmentBudgetItem.id, removed.map((line) => line.id)),
      ),
    )
  await releaseOrphanItems(tx, orgId, patientId, budgetId, ids)
  await audit(tx, orgId, actorUserId, "budget.items_removed", budgetId, {
    patientId,
    itemCount: removed.length,
    ...(input.optionId ? { optionId: input.optionId } : {}),
    removed: removed.map((line) => ({
      planItemId: line.planItemId,
      optionId: line.optionId,
      title: line.title,
      priceCents: line.priceCents,
      tariffCents: line.tariffPriceCents,
      reason: line.priceReason,
      promotion: line.promotionName,
      sessions: line.sessionsPlanned,
    })),
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, current)
}

/** El borrador de la persona (uno solo, salvo el de una revisión). */
export async function findDraftBudget(tx: Db, orgId: string, patientId: string): Promise<BudgetRow | null> {
  const [row] = await tx
    .select()
    .from(treatmentBudget)
    .where(
      and(
        eq(treatmentBudget.organizationId, orgId),
        eq(treatmentBudget.patientId, patientId),
        eq(treatmentBudget.status, "borrador"),
        isNull(treatmentBudget.supersedesBudgetId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Nace el borrador con su primera opción, la recomendada. */
async function insertDraftBudget(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  plan: typeof treatmentPlan.$inferSelect,
  currency: string,
  input: { title?: string | null; notes?: string | null },
): Promise<{ budget: BudgetRow; option: BudgetOptionRow }> {
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
  const [option] = await tx
    .insert(treatmentBudgetOption)
    .values({ organizationId: orgId, patientId, budgetId: budget.id, position: 1, isRecommended: true, createdBy: actorUserId })
    .returning()
  if (!option) throw new Error("No se pudo crear la opción del presupuesto")
  await audit(tx, orgId, actorUserId, "budget.created", budget.id, {
    patientId,
    planId: plan.id,
    budgetNumber,
    currency,
  })
  return { budget, option }
}

/**
 * Preparar el presupuesto: hay un solo borrador por persona, así que si ya
 * existe los tratamientos entran en él (en todas sus opciones). Si no, nace
 * uno nuevo con una sola opción.
 */
export async function createBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateBudgetInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const ids = assertItemIds(input.itemIds)
  const planId = input.planId?.trim() || (await planOfItems(tx, orgId, patientId, ids))
  const plan = await lockPlan(tx, orgId, patientId, planId)
  const draft = await findDraftBudget(tx, orgId, patientId)
  if (draft) {
    if (draft.planId !== plan.id) {
      throw conflict("BUDGET_PLAN_MISMATCH", "La persona ya tiene un presupuesto por enviar de otro plan: envíalo o anúlalo antes")
    }
    // Lo que ya está en el borrador no se vuelve a añadir: preparar otra vez es sumar lo nuevo.
    const present = await tx
      .selectDistinct({ planItemId: treatmentBudgetItem.planItemId })
      .from(treatmentBudgetItem)
      .where(and(eq(treatmentBudgetItem.organizationId, orgId), eq(treatmentBudgetItem.budgetId, draft.id)))
    const fresh = ids.filter((id) => !present.some((row) => row.planItemId === id))
    if (fresh.length === 0) {
      // Devolver el borrador también es leerlo: el odontólogo solo el que es suyo.
      await assertOwnBudget(tx, orgId, draft.id, actorUserId, opts.memberRole, "Solo puedes presupuestar lo que indicaste tú")
      return getBudgetDetail(tx, orgId, patientId, draft.id)
    }
    return addBudgetItems(tx, orgId, actorUserId, patientId, draft.id, { itemIds: fresh }, opts)
  }
  const items = await requireQuotableItems(tx, orgId, patientId, plan.id, ids)
  assertOwnItems(items, actorUserId, opts.memberRole)
  // La moneda es la de sus tratamientos (una sola); nunca la de un país fijo.
  const currency = items[0]?.currency ?? (await requireOrgCurrency(tx, orgId))
  const { budget, option } = await insertDraftBudget(tx, orgId, actorUserId, patientId, plan, currency, input)
  const billingModes = await readBillingModes(
    tx,
    orgId,
    items.map((item) => item.serviceId).filter((id): id is string => id !== null),
  )
  await insertDraftLines(tx, orgId, actorUserId, patientId, plan.id, budget.id, option.id, items, billingModes)
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, budget)
}

async function planOfItems(tx: Db, orgId: string, patientId: string, itemIds: string[]): Promise<string> {
  const rows = await tx
    .selectDistinct({ planId: treatmentPlanItem.planId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.id, itemIds),
      ),
    )
  if (rows.length === 0) throw notFound("Ítem del plan")
  if (rows.length > 1) throw validation("Todos los ítems deben pertenecer al plan")
  return rows[0]!.planId
}

/** Lo que el cierre de la atención dice del presupuesto que quedó armado. */
export interface AssembledBudget {
  id: string
  budgetNumber: number
  /** Tratamientos del presupuesto (de la opción que vale). */
  itemCount: number
  totalCents: number | null
  currency: string
  /** Lo que entró en esta atención. */
  added: number
}

/**
 * Al firmar la atención queda armado el presupuesto (decisión 12): lo indicado
 * en ella que se puede cotizar entra al borrador de la persona, que crece con
 * cada atención; si no hay, nace uno. Lo que no se puede cotizar (sin precio,
 * cerrado, ya en otro presupuesto vigente) no entra ni detiene el cierre. No
 * envía nada: el cierre pregunta «¿Enviárselo ahora?». Donde lo indicado
 * queda aceptado al indicarlo (latidIA, decisión 15 del issue 229), el
 * presupuesto es opcional y no se arma solo.
 */
export async function assembleEncounterBudget(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<AssembledBudget | null> {
  if (!(await productHooks(tx, orgId)).budgetRequired) return null
  const candidates = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        isNull(treatmentPlanItem.budgetId),
        eq(treatmentPlanItem.status, "pendiente"),
        eq(treatmentPlanItem.decisionStatus, "pendiente"),
      ),
    )
    .orderBy(asc(treatmentPlanItem.sortOrder), asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const quotable = candidates.filter((item) => {
    if (item.priceCents === null) return false
    try {
      assertExecutableCodings(item.codings)
      return true
    } catch {
      return false
    }
  })
  let draft = await findDraftBudget(tx, orgId, patientId)
  if (quotable.length > 0) {
    // Un borrador por plan: lo de otro plan espera a que se envíe el que hay.
    const planId = draft?.planId ?? quotable[0]!.planId
    const sameCurrency = draft?.currency ?? quotable[0]!.currency
    const items = quotable.filter((item) => item.planId === planId && item.currency === sameCurrency)
    if (items.length > 0) {
      const plan = await lockPlan(tx, orgId, patientId, planId)
      if (!draft) draft = (await insertDraftBudget(tx, orgId, actorUserId, patientId, plan, sameCurrency, {})).budget
      const locked = await lockBudgetRow(tx, orgId, patientId, draft.id)
      const ready = await requireQuotableItems(tx, orgId, patientId, planId, items.map((item) => item.id), locked.id)
      await addLinesToOptions(tx, orgId, actorUserId, patientId, locked, ready)
      await audit(tx, orgId, actorUserId, "budget.items_added", locked.id, {
        patientId,
        itemIds: ready.map((item) => item.id),
        itemCount: ready.length,
        encounterId,
      })
      await notifyBudget(tx, orgId)
      const full = await loadBudget(tx, orgId, patientId, locked)
      const value = valueOptionOf(full.options)
      return {
        id: full.id,
        budgetNumber: full.budgetNumber,
        itemCount: value?.lineCount ?? full.items.length,
        totalCents: full.totalCents,
        currency: full.currency,
        added: ready.length,
      }
    }
  }
  return null
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
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
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

// ------------------------------------------------------------- opciones ---

/**
 * «Duplicar como otra opción»: la opción nueva nace como copia de la pedida
 * (mismos tratamientos y precios acordados) y después se cambia lo que haga
 * falta. A lo sumo tres opciones; solo en borrador.
 */
export async function duplicateBudgetOption(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  optionId: string,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  assertDraftOwnItems(current)
  const options = await listOptions(tx, orgId, [budgetId])
  const source = options.find((option) => option.id === optionId)
  if (!source) throw notFound("Opción del presupuesto")
  if (options.length >= BUDGET_OPTIONS_MAX) {
    throw conflict("BUDGET_OPTIONS_MAX", `Un presupuesto admite hasta ${BUDGET_OPTIONS_MAX} opciones`)
  }
  const position = Math.max(...options.map((option) => option.position)) + 1
  const [created] = await tx
    .insert(treatmentBudgetOption)
    .values({ organizationId: orgId, patientId, budgetId, position, isRecommended: false, createdBy: actorUserId })
    .returning()
  if (!created) throw new Error("No se pudo crear la opción")
  const lines = (await listBudgetLines(tx, orgId, patientId, budgetId)).filter((line) => line.optionId === source.id)
  for (const line of lines) {
    await tx.insert(treatmentBudgetItem).values({
      organizationId: orgId,
      patientId,
      planId: line.planId,
      budgetId,
      optionId: created.id,
      planItemId: line.planItemId,
      serviceId: line.serviceId,
      title: line.title,
      scope: line.scope,
      siteSystem: line.siteSystem,
      siteCode: line.siteCode,
      siteQualifiers: line.siteQualifiers,
      codings: line.codings,
      priceCents: line.priceCents,
      tariffPriceCents: line.tariffPriceCents,
      priceReason: line.priceReason,
      promotionId: line.promotionId,
      promotionName: line.promotionName,
      promotionMode: line.promotionMode,
      billingMode: line.billingMode,
      sessionsPlanned: line.sessionsPlanned,
      currency: line.currency,
      decision: "pendiente",
      createdBy: actorUserId,
    })
  }
  await audit(tx, orgId, actorUserId, "budget.option_duplicated", budgetId, {
    patientId,
    from: source.position,
    position,
    lineCount: lines.length,
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, current)
}

/** Marca la opción recomendada (una por presupuesto); solo en borrador. */
export async function recommendBudgetOption(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  optionId: string,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  if (current.status !== "borrador") throw conflict("BUDGET_STATUS", "La recomendada se elige antes de enviar")
  const options = await listOptions(tx, orgId, [budgetId])
  if (!options.some((option) => option.id === optionId)) throw notFound("Opción del presupuesto")
  await tx
    .update(treatmentBudgetOption)
    .set({ isRecommended: false, updatedAt: new Date() })
    .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.budgetId, budgetId)))
  await tx
    .update(treatmentBudgetOption)
    .set({ isRecommended: true, updatedAt: new Date() })
    .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.id, optionId)))
  await audit(tx, orgId, actorUserId, "budget.option_recommended", budgetId, {
    patientId,
    position: options.find((option) => option.id === optionId)?.position ?? null,
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, current)
}

/**
 * Quita una opción del borrador (siempre queda al menos una). Las demás se
 * renumeran para que las letras sigan seguidas; si era la recomendada, pasa a
 * serlo la primera.
 */
export async function removeBudgetOption(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  budgetId: string,
  optionId: string,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  assertDraftOwnItems(current)
  const options = await listOptions(tx, orgId, [budgetId])
  const gone = options.find((option) => option.id === optionId)
  if (!gone) throw notFound("Opción del presupuesto")
  if (options.length === 1) throw conflict("BUDGET_LAST_OPTION", "El presupuesto necesita al menos una opción")
  const lines = await tx
    .delete(treatmentBudgetItem)
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.budgetId, budgetId),
        eq(treatmentBudgetItem.optionId, optionId),
      ),
    )
    .returning({ planItemId: treatmentBudgetItem.planItemId })
  await tx
    .delete(treatmentBudgetOption)
    .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.id, optionId)))
  await releaseOrphanItems(tx, orgId, patientId, budgetId, lines.map((line) => line.planItemId))
  // Letras seguidas: se renumera de menor a mayor, así cada posición ya está libre.
  const rest = options.filter((option) => option.id !== optionId)
  for (const [index, option] of rest.entries()) {
    await tx
      .update(treatmentBudgetOption)
      .set({ position: index + 1, isRecommended: gone.isRecommended ? index === 0 : option.isRecommended, updatedAt: new Date() })
      .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.id, option.id)))
  }
  await audit(tx, orgId, actorUserId, "budget.option_removed", budgetId, {
    patientId,
    position: gone.position,
    lineCount: lines.length,
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, current)
}

// ---------------------------------------------------------------- entregar ---

/**
 * Entregar el presupuesto (sustituye a `presentBudget`): imprimir o enviar lo
 * entrega en la misma transacción. No hay paso «presentar» aparte. Exige
 * borrador con líneas en cada opción; el odontólogo, que sea suyo.
 */
export async function deliverBudget(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  budgetId: string,
  opts: BudgetActorOpts = {},
): Promise<BudgetRow> {
  await requirePatient(tx, orgId, patientId)
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador puede entregarse")
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  if (lines.length === 0) throw validation("El presupuesto no tiene ítems")
  const options = await listOptions(tx, orgId, [budgetId])
  for (const option of options) {
    if (!lines.some((line) => line.optionId === option.id)) {
      throw validation(`La ${budgetOptionLabel(option.position).toLowerCase()} no tiene tratamientos: quítala o agrégale alguno`)
    }
  }
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
    ...(options.length > 1 ? { options: options.length } : {}),
  })
  // Se une sola a la oportunidad del mismo tratamiento (o a la más reciente),
  // que pasa a «Presupuesto enviado» (ADR 0028). Mientras decide, vale lo de la
  // opción recomendada (decisión 13).
  const full = withTotals(updated, lines, options)
  await linkPresentedBudget(tx, orgId, {
    patientId,
    budgetId,
    serviceIds: [...new Set(lines.map((line) => line.serviceId).filter((id): id is string => !!id))],
    by: opts.by,
    total: { cents: full.totalCents, currency: updated.currency },
  })
  await notifyBudget(tx, orgId)
  return updated
}
export interface AdjustBudgetLineInput {
  planItemId: string
  /** La opción de la línea; sin ella, el cambio vale para ese tratamiento en todas. */
  optionId?: string | null
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
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  if (current.status !== "borrador") {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto en borrador admite ajuste de precio")
  }
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 200) {
    throw validation("lines debe tener entre 1 y 200 ajustes")
  }
  const seen: Record<string, true> = {}
  for (const line of input.lines) {
    const key = `${line.planItemId}:${line.optionId ?? "*"}`
    if (seen[key]) throw validation("Cada tratamiento se ajusta una sola vez")
    seen[key] = true
  }
  const lines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const now = new Date()
  const changes: Array<Record<string, unknown>> = []
  for (const patch of input.lines) {
    const targets = lines.filter(
      (line) => line.planItemId === patch.planItemId && (!patch.optionId || line.optionId === patch.optionId),
    )
    if (targets.length === 0) throw notFound("Línea del presupuesto")
    for (const line of targets) changes.push(await adjustOneLine(tx, orgId, line, patch, now))
  }
  await audit(tx, orgId, actorUserId, "budget.prices_adjusted", budgetId, {
    patientId,
    lineCount: changes.length,
    changes,
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, await requireBudget(tx, orgId, patientId, budgetId))
}

async function adjustOneLine(
  tx: Db,
  orgId: string,
  line: BudgetLineWithStatus,
  patch: AdjustBudgetLineInput,
  now: Date,
): Promise<Record<string, unknown>> {
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
  return {
    lineId: line.id,
    optionId: line.optionId,
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
  }
}

// ----------------------------------------------------------------- decidir ---

/**
 * Anota la respuesta de quien decide. Con varias opciones, primero se elige
 * una (`optionId`): las demás quedan «No elegida» solas, y lo que solo estaba
 * en ellas también. Dentro de la elegida, cada tratamiento se acepta, se deja
 * para después o no se acepta. Un parcial o pospuesto admite completar lo que
 * quedó para después sin reescribir lo ya decidido.
 *
 * `actorUserId` es quien del equipo anota la respuesta; `null` cuando decide la
 * propia persona (el portal) o el agente con su confirmación: el presupuesto no
 * queda a nombre de nadie de la clínica y la auditoría lo anota a quien decidió
 * (`contact:<id>`).
 */
export async function decideBudget(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  budgetId: string,
  input: DecideBudgetInput,
  opts: BudgetActorOpts & { skipOwnPlan?: boolean; via?: string } = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const prev = await requireBudget(tx, orgId, patientId, budgetId)
  await lockPlan(tx, orgId, patientId, prev.planId)
  if (!opts.skipOwnPlan) {
    if (actorUserId === null) throw new Error("Sin alguien del equipo, decideBudget exige skipOwnPlan")
    await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
  }
  const current = await lockBudgetRow(tx, orgId, patientId, budgetId)
  // Responder después: un parcial/pospuesto admite completar lo pospuesto sin
  // reescribir lo ya decidido; otra autoridad no pisa la decisión registrada.
  const isFollowUp = current.status === "parcial" || current.status === "pospuesto"
  if (current.status !== "presentado" && !isFollowUp) {
    throw conflict("BUDGET_STATUS", "Solo un presupuesto presentado puede decidirse")
  }
  const decisionNote = assertNotes(input.decisionNote) ?? null
  const options = await listOptions(tx, orgId, [budgetId])
  const already = options.find((option) => option.decision === "elegida") ?? null
  let chosen: BudgetOptionRow
  if (already) {
    if (input.optionId && input.optionId !== already.id) {
      throw conflict("BUDGET_DECISION_FINAL", "Ya eligió otra opción: para cambiarla se crea una revisión")
    }
    chosen = already
  } else if (options.length === 1) {
    chosen = options[0]!
  } else {
    const picked = options.find((option) => option.id === input.optionId)
    if (!picked) throw validation("Elige una de las opciones del presupuesto")
    chosen = picked
  }
  const allLines = await listBudgetLines(tx, orgId, patientId, budgetId)
  const lines = allLines.filter((line) => line.optionId === chosen.id)
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
  const chosenItems = new Set(lines.map((line) => line.planItemId))
  for (const item of items) {
    const decision = decisions.get(item.id)
    if (!decision) continue
    if (["cancelado", "reemplazado"].includes(item.status)) throw conflict("ITEM_CLOSED", "La indicación está cerrada")
    if (item.budgetId !== budgetId) throw conflict("BUDGET_STATUS", "La propuesta ya no es vigente para esta indicación")
    if (["en_curso", "realizado"].includes(item.status) && decision !== "aceptado") {
      throw conflict("ITEM_IN_EXECUTION", "No puede retirar la aceptación de un tratamiento ejecutado")
    }
  }
  const now = new Date()
  const who = {
    decidedAt: now,
    decidedByContactId: representative?.id ?? null,
    decidedByName: representative?.displayName ?? null,
  }
  for (const line of lines) {
    const decision = decisions.get(line.planItemId)!
    await tx.update(treatmentBudgetItem).set({ decision, updatedAt: now })
      .where(and(eq(treatmentBudgetItem.id, line.id), eq(treatmentBudgetItem.organizationId, orgId)))
    await tx.update(treatmentPlanItem).set({ decisionStatus: decision, decisionNote, ...who, updatedAt: now })
      .where(and(eq(treatmentPlanItem.id, line.planItemId), eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId)))
  }
  if (!already) {
    // Elegir una opción: las demás quedan «No elegida» solas, y lo que solo
    // estaba en ellas también (no es un «no»: nunca lo vio como su camino).
    await tx.update(treatmentBudgetOption).set({ decision: "elegida", updatedAt: now })
      .where(and(eq(treatmentBudgetOption.organizationId, orgId), eq(treatmentBudgetOption.id, chosen.id)))
    const others = options.filter((option) => option.id !== chosen.id)
    if (others.length > 0) {
      await tx.update(treatmentBudgetOption).set({ decision: "no_elegida", updatedAt: now })
        .where(and(eq(treatmentBudgetOption.organizationId, orgId), inArray(treatmentBudgetOption.id, others.map((o) => o.id))))
      const notChosen = allLines.filter((line) => line.optionId !== chosen.id)
      if (notChosen.length > 0) {
        await tx.update(treatmentBudgetItem).set({ decision: "no_elegida", updatedAt: now })
          .where(and(eq(treatmentBudgetItem.organizationId, orgId), inArray(treatmentBudgetItem.id, notChosen.map((l) => l.id))))
      }
      const onlyThere = [...new Set(notChosen.map((line) => line.planItemId))].filter((id) => !chosenItems.has(id))
      const open = items.filter((item) => onlyThere.includes(item.id) && !["realizado", "en_curso", "cancelado", "reemplazado"].includes(item.status))
      if (open.length > 0) {
        await tx.update(treatmentPlanItem).set({ decisionStatus: "no_elegida", decisionNote: "Opción no elegida", ...who, updatedAt: now })
          .where(and(eq(treatmentPlanItem.organizationId, orgId), inArray(treatmentPlanItem.id, open.map((item) => item.id))))
      }
    }
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
  const auditActor = actorUserId ?? (representative ? `contact:${representative.id}` : null)
  await audit(tx, orgId, auditActor, "budget.decision", budgetId, {
    patientId, status, acceptedCount, decisionContactId: representative?.id ?? null,
    ...(options.length > 1 ? { option: chosen.position } : {}),
    ...(opts.via ? { via: opts.via } : {}),
  })
  // Aceptarlo, aunque sea en parte, gana su oportunidad; rechazarlo la pierde.
  await decideBudgetOpportunity(tx, orgId, {
    patientId,
    budgetId,
    status,
    serviceIds: [...new Set(lines.map((line) => line.serviceId).filter((id): id is string => !!id))],
    // Lo que de verdad aceptó: el valor de la oportunidad ganada (en parte, lo aceptado).
    accepted: {
      cents: sumAcceptedCents(lines.map((line) => ({ lineTotalCents: line.lineTotalCents, decision: decisions.get(line.planItemId) }))),
      currency: updated.currency,
    },
  })
  await notifyBudget(tx, orgId)
  return loadBudget(tx, orgId, patientId, updated)
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
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
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
  const itemIds = [...new Set(lines.map((line) => line.planItemId))]
  if (itemIds.length > 0) {
    await tx
      .update(treatmentPlanItem)
      .set({ budgetId: null, updatedAt: new Date() })
      .where(
        and(
          inArray(treatmentPlanItem.id, itemIds),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          eq(treatmentPlanItem.budgetId, budgetId),
        ),
      )
  }
  await audit(tx, orgId, actorUserId, "budget.cancelled", budgetId, {
    patientId,
    from: current.status,
    itemCount: itemIds.length,
  })
  await notifyBudget(tx, orgId)
  return updated
}

/**
 * Los presupuestos de muchos pacientes a la vez, con sus totales: lo mismo que
 * `listBudgets` de cada uno (sin filtrar por profesional), en cuatro consultas.
 * Lo usa «Qué sigue» en lote (`planNextStepsOf`).
 */
export async function listBudgetsForPatients(
  tx: Db,
  orgId: string,
  patientIds: string[],
): Promise<Map<string, BudgetWithTotals[]>> {
  const out = new Map<string, BudgetWithTotals[]>()
  if (patientIds.length === 0) return out
  const budgets = await tx
    .select()
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.organizationId, orgId), inArray(treatmentBudget.patientId, patientIds)))
    .orderBy(asc(treatmentBudget.budgetNumber), asc(treatmentBudget.revisionNumber))
  const ids = budgets.map((budget) => budget.id)
  const [options, lines] = [await listOptions(tx, orgId, ids), await budgetLinesOf(tx, orgId, ids)]
  const optionsOf = new Map<string, BudgetOptionRow[]>()
  for (const option of options) optionsOf.set(option.budgetId, [...(optionsOf.get(option.budgetId) ?? []), option])
  for (const budget of budgets) {
    const list = out.get(budget.patientId) ?? []
    list.push(withTotals(budget, lines.get(budget.id) ?? [], optionsOf.get(budget.id) ?? []))
    out.set(budget.patientId, list)
  }
  return out
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
  if (isProfessional(opts.memberRole) && opts.actorUserId) conditions.push(ownBudgetSql(opts.actorUserId))
  const budgets = await tx
    .select()
    .from(treatmentBudget)
    .where(and(...conditions))
    .orderBy(asc(treatmentBudget.budgetNumber), asc(treatmentBudget.revisionNumber))
  const options = await listOptions(tx, orgId, budgets.map((budget) => budget.id))
  const result: BudgetWithTotals[] = []
  for (const budget of budgets) {
    result.push(
      withTotals(
        budget,
        await listBudgetLines(tx, orgId, patientId, budget.id),
        options.filter((option) => option.budgetId === budget.id),
      ),
    )
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
  if (opts.actorUserId) {
    await assertOwnBudget(tx, orgId, budgetId, opts.actorUserId, opts.memberRole, "Solo puedes ver presupuestos de lo que indicaste tú")
  }
  return loadBudget(tx, orgId, patientId, budget)
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

/**
 * Nueva revisión de una propuesta entregada: conserva el número y versiona el
 * documento. Nace con una sola opción, con lo acordado de la opción que valía
 * (la elegida o la recomendada) para los tratamientos que se mantienen.
 */
export async function reviseBudget(
  tx: Db, orgId: string, actorUserId: string, patientId: string, budgetId: string, input: ReviseBudgetInput,
  opts: BudgetActorOpts = {},
): Promise<BudgetWithTotals> {
  await requirePatient(tx, orgId, patientId)
  const current = await lockForWrite(tx, orgId, patientId, budgetId)
  await assertOwnBudget(tx, orgId, budgetId, actorUserId, opts.memberRole)
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
  const [option] = await tx.insert(treatmentBudgetOption).values({
    organizationId: orgId, patientId, budgetId: revision.id, position: 1, isRecommended: true, createdBy: actorUserId,
  }).returning()
  if (!option) throw new Error("No se pudo crear la opción de la revisión")
  const previousOptions = await listOptions(tx, orgId, [current.id])
  const valued = valueOptionOf(previousOptions)
  const oldLines = (await listBudgetLines(tx, orgId, patientId, current.id)).filter(
    (line) => !valued || line.optionId === valued.id,
  )
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
      organizationId: orgId, patientId, planId: current.planId, budgetId: revision.id, optionId: option.id,
      planItemId: item.id, serviceId: snapshot.serviceId, title: snapshot.title,
      scope: snapshot.scope, siteSystem: snapshot.siteSystem, siteCode: snapshot.siteCode,
      siteQualifiers: snapshot.siteQualifiers, codings: snapshot.codings,
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
  return loadBudget(tx, orgId, patientId, revision)
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

/** Una opción en la hoja: sus líneas y su total, nunca sumado con las demás. */
export interface BudgetPrintOption {
  label: string
  isRecommended: boolean
  /** `pendiente`, `elegida` o `no_elegida`. */
  decision: string
  lines: BudgetPrintLine[]
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
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
  /** El estado con su nombre de siempre (`budgetStateText`). */
  stateText: string
  isDraft: boolean
  notes: string | null
  currency: string
  locale: string
  timezone: string
  issuedAt: Date
  clinic: { name: string; branchName: string | null; address: string | null; phone: string | null }
  patient: { displayName: string; docType: string | null; docNumber: string | null }
  professional: { name: string; title: string | null; registration: string | null } | null
  /** Las líneas de la opción que vale (con una sola opción, todas). */
  lines: BudgetPrintLine[]
  /** Con más de una opción, cada una con su total; vacío con una sola. */
  options: BudgetPrintOption[]
  subtotalCents: number | null
  discountCents: number | null
  totalCents: number | null
}

function printLine(site: ProductSite, line: BudgetLineWithStatus): BudgetPrintLine {
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
    detail: site.words(line, "short"),
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
}

/**
 * Contenido de la hoja del presupuesto (lo que imprime el PDF): precios
 * finales acordados, referencia del descuento y código de cotización 310.
 * Con varias opciones, cada una con su total. Moneda, formato, zona y papel
 * salen del perfil de la clínica.
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
      displayName: patientPerson.displayName,
      docType: patientPerson.docType,
      docNumber: patientPerson.docNumber,
    })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!patientRow) throw notFound("Paciente")
  const [planRow] = await tx
    .select({ title: treatmentPlan.title, createdBy: treatmentPlan.createdBy })
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.id, budget.planId), eq(treatmentPlan.organizationId, orgId)))
    .limit(1)
  const site = (await productHooks(tx, orgId)).site
  // Firma quien preparó el presupuesto; si no consta, quien abrió el plan.
  const author = budget.createdBy ?? planRow?.createdBy ?? null
  let professional: BudgetPrintPayload["professional"] = null
  if (author) {
    const [row] = await tx
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, author))
      .limit(1)
    if (row) {
      let signature: { title?: string | null; registration?: string | null } | null = null
      try {
        signature = await requireProfessionalSignature(tx, orgId, author)
      } catch {
        signature = null
      }
      professional = {
        name: row.name,
        title: signature?.title ?? null,
        registration: signature?.registration ?? null,
      }
    }
  }
  // El presupuesto no pertenece a una sede. Si la clínica tiene una sola, la
  // hoja lleva su nombre, dirección y teléfono; con varias, los de la clínica.
  const branches = await tx
    .select({ name: branch.name, address: branchAddressColumns, phone: branch.phone })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .limit(2)
  const onlyBranch = branches.length === 1 ? branches[0]! : null
  const value = valueOptionOf(budget.options)
  const lines = budget.items.filter((line) => !value || line.optionId === value.id).map((line) => printLine(site, line))
  const subtotalCents = sumCents(lines.map((line) => line.listTotalCents))
  const options: BudgetPrintOption[] =
    budget.options.length > 1
      ? budget.options.map((option) => {
          const optionLines = budget.items.filter((line) => line.optionId === option.id).map((line) => printLine(site, line))
          const optionSubtotal = sumCents(optionLines.map((line) => line.listTotalCents))
          return {
            label: option.label,
            isRecommended: option.isRecommended,
            decision: option.decision,
            lines: optionLines,
            subtotalCents: optionSubtotal,
            discountCents:
              optionSubtotal == null || option.totalCents == null ? null : optionSubtotal - option.totalCents,
            totalCents: option.totalCents,
          }
        })
      : []
  return {
    quotationCode: "310",
    paper: profile.sheetSize,
    budgetNumber: budget.budgetNumber,
    revisionNumber: budget.revisionNumber,
    title: budget.title,
    planTitle: planRow?.title ?? budget.title,
    status: budget.status,
    stateText: budget.stateText,
    isDraft: budget.status === "borrador",
    notes: budget.notes,
    currency: budget.currency,
    locale: profile.locale,
    timezone: profile.timezone,
    issuedAt: budget.presentedAt ?? budget.createdAt,
    clinic: {
      name: profile.tradeName || profile.legalName || "",
      branchName: onlyBranch?.name ?? null,
      address: (onlyBranch ? (await branchAddressWriter(tx, orgId))(onlyBranch.address) : null) ?? profile.fiscalAddress ?? null,
      phone: onlyBranch?.phone ?? null,
    },
    patient: patientRow,
    professional,
    lines,
    options,
    subtotalCents,
    discountCents:
      subtotalCents == null || budget.totalCents == null ? null : subtotalCents - budget.totalCents,
    totalCents: budget.totalCents,
  }
}
