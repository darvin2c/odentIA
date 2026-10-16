import {
  assertTreatmentSite,
  phaseForSpecialty,
  TREATMENT_PHASES,
  TREATMENT_SCOPES,
  type TreatmentPhase,
  type TreatmentScope,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  cie10Code,
  encounter,
  encounterPlanItem,
  encounterProcedure,
  odontogramEntry,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm"
import { notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import { requireServiceForIndication, type ServiceRow } from "./service-catalog.js"
import { serviceSpecialtyOf } from "./specialties.js"
import { readBillingModes } from "./budgets.js"
import { drawTreatedFinding } from "./treated-findings.js"

/**
 * Plan clínico longitudinal: existe antes que cualquier presupuesto y puede
 * continuar en múltiples visitas. Hay un plan abierto por persona (ADR 0034):
 * no se elige plan al indicar; la primera indicación lo crea solo, con la
 * atención donde nació. El ítem (indicación) nace en una atención borrador con
 * sitio clínico y snapshot de oferta; `budgetId` es el presupuesto vigente. La
 * decisión clínica vive en la indicación; las líneas económicas conservan la
 * decisión de cada propuesta histórica.
 * Convención: `tx` ya corre dentro de `withOrgContext`; nunca abrir contexto
 * aquí. El encounter se toca vía schema directo (lock), nunca vía el servicio
 * de encounters (evita ciclo).
 * Orden global de locks: atención → plan → presupuestos (UUID ordenado) →
 * ítems (UUID ordenado). Sin atención: empieza en plan.
 */

export const PLAN_ITEM_STATUSES = [
  "pendiente",
  "programado",
  "en_curso",
  "suspendido",
  "realizado",
  "cancelado",
  "reemplazado",
] as const

const CLOSED_STATUSES: readonly string[] = ["realizado", "cancelado", "reemplazado"]

export const PLAN_ITEM_DECISIONS = [
  "pendiente",
  "aceptado",
  "pospuesto",
  "rechazado",
  "reemplazado",
  // Solo estaba en una opción del presupuesto que la persona no eligió (decisión 13).
  "no_elegida",
] as const
export type PlanItemDecision = (typeof PLAN_ITEM_DECISIONS)[number]

export type PlanItemRow = typeof treatmentPlanItem.$inferSelect
export type TreatmentPlanRow = typeof treatmentPlan.$inferSelect
type BudgetLineRow = typeof treatmentBudgetItem.$inferSelect

/** Cabecera de presupuesto (lectura acotada a org+paciente). */
export type BudgetHeaderRow = typeof treatmentBudget.$inferSelect

/** Ítem con decisión vigente explícita. */
export type PlanItemWithDecision = PlanItemRow & { decision: PlanItemDecision }

/** Ítem listado con su progreso: sesiones hechas = procedimientos no anulados. */
export type PlanItemWithProgress = PlanItemWithDecision & { sessionsDone: number }

export type TreatmentPlanStatus = "Sin tratamientos" | "En curso" | "Completado" | "Cancelado"

export function derivePlanStatus(statuses: string[]): TreatmentPlanStatus {
  if (statuses.length === 0) return "Sin tratamientos"
  if (statuses.every((s) => s === "realizado")) return "Completado"
  if (statuses.every((s) => s === "cancelado" || s === "reemplazado")) return "Cancelado"
  return "En curso"
}

export interface TreatmentSiteInput {
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
}

export interface AddPlanItemInput {
  /** Oferta del tarifario (activa y con tarifa). Scope/precio/título/moneda se copian. */
  serviceId: string
  /** Plan clínico del mismo paciente/org; sin él, el plan abierto (o uno nuevo). */
  planId?: string | null
  /** Atención borrador donde se indica (origen inmutable). */
  sourceEncounterId: string
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
  detail?: string | null
  diagnosisCode?: string | null
  /** Hallazgo del odontograma que motiva la indicación (mismo paciente, no anulado). */
  odontogramEntryId?: string | null
  /** Fase del plan; por defecto, la que propone la especialidad del servicio. */
  phase?: string | null
  /** Sesiones previstas (1–60); por defecto, una. */
  plannedSessions?: number | null
}

export interface UpdatePlanItemPatch {
  /** Cambiar de oferta re-congela título/precio/moneda; el mismo serviceId no recalcula. */
  serviceId?: string
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
  detail?: string | null
  diagnosisCode?: string | null
  /** Atención borrador actual como contexto de mutación (obligatorio, nunca reescribe el origen). */
  encounterId: string
}

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entity: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity,
    entityId,
    metadata: metadata ?? null,
  })
}

async function assertDiagnosisCode(tx: Db, code: string): Promise<void> {
  const [row] = await tx
    .select({ code: cie10Code.code })
    .from(cie10Code)
    .where(eq(cie10Code.code, code))
    .limit(1)
  if (!row) throw validation(`Código CIE-10 inexistente: ${code}`)
}

function assertDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null
  if (detail.length > 4000) throw validation("detail debe tener hasta 4000 caracteres")
  const trimmed = detail.trim()
  return trimmed ? trimmed : null
}

function assertTitle(title: string): string {
  const value = title?.trim() ?? ""
  if (!value || value.length > 200) throw validation("title debe tener 1–200 caracteres")
  return value
}

function normalizeDiagnosisCode(code: string | null | undefined): string | null {
  const trimmed = code?.trim() ?? ""
  return trimmed ? trimmed : null
}

function assertScopeValue(scope: string | null | undefined): TreatmentScope {
  if (!scope || !(TREATMENT_SCOPES as readonly string[]).includes(scope)) {
    throw validation("La oferta no tiene un ámbito válido para indicar")
  }
  return scope as TreatmentScope
}

function assertSite(
  scope: TreatmentScope,
  site: TreatmentSiteInput,
  limits?: { min: number | null; max: number | null },
): {
  toothNumber: number | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
} {
  try {
    assertTreatmentSite(scope, site, limits)
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Sitio clínico inválido")
  }
  return {
    toothNumber: site.toothNumber ?? null,
    surfaces: site.surfaces ? [...site.surfaces] : [],
    quadrant: site.quadrant ?? null,
    arch: site.arch ?? null,
  }
}

/** Límites de superficies: de la plantilla, o 1–5 para ofertas propias. */
export async function surfaceLimits(
  tx: Db,
  service: ServiceRow,
): Promise<{ min: number | null; max: number | null }> {
  if (!service.templateId) return { min: 1, max: 5 }
  const [tpl] = await tx
    .select()
    .from(treatmentTemplate)
    .where(eq(treatmentTemplate.id, service.templateId))
    .limit(1)
  if (!tpl) return { min: 1, max: 5 }
  return { min: tpl.surfaceCountMin, max: tpl.surfaceCountMax }
}

/** Lock de la atención borrador (contexto de mutación clínica). */
async function lockDraftEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<void> {
  const [enc] = await tx
    .select({ id: encounter.id, status: encounter.status })
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .limit(1)
    .for("update")
  if (!enc) throw notFound("Atención")
  if (enc.status === "anulada") throw conflict("VOIDED", "La atención está anulada")
  if (enc.status !== "borrador") throw conflict("FINALIZED", "La atención está finalizada")
}

/** Lock del plan acotado a org+paciente (anti-traversal). */
async function lockPlanRow(
  tx: Db,
  orgId: string,
  patientId: string,
  planId: string,
): Promise<TreatmentPlanRow> {
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

/** Lock del ítem acotado a org+paciente. */
async function lockItemRow(
  tx: Db,
  orgId: string,
  patientId: string,
  itemId: string,
): Promise<PlanItemRow> {
  const [item] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .limit(1)
    .for("update")
  if (!item) throw notFound("Ítem del plan")
  return item
}

/** Lookup del presupuesto acotado a org + paciente (anti-traversal). */
async function requireBudget(
  tx: Db,
  orgId: string,
  patientId: string,
  budgetId: string,
): Promise<BudgetHeaderRow> {
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

/** Lock del presupuesto (serializa altas, edición, presentar, decidir y cancelar). */
async function lockBudgetRow(tx: Db, orgId: string, budgetId: string): Promise<BudgetHeaderRow> {
  const [row] = await tx
    .select()
    .from(treatmentBudget)
    .where(and(eq(treatmentBudget.id, budgetId), eq(treatmentBudget.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!row) throw notFound("Presupuesto")
  return row
}

/**
 * Línea económica vigente del ítem (null = sin presupuesto). Si el tratamiento
 * está en varias opciones, vale la de la opción elegida (o, mientras decide,
 * la de la recomendada).
 */
async function currentLine(
  tx: Db,
  orgId: string,
  item: { id: string; budgetId: string | null },
): Promise<BudgetLineRow | null> {
  if (!item.budgetId) return null
  const [row] = await tx
    .select({ line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentBudgetOption,
      and(
        eq(treatmentBudgetOption.id, treatmentBudgetItem.optionId),
        eq(treatmentBudgetOption.organizationId, treatmentBudgetItem.organizationId),
      ),
    )
    .where(
      and(
        eq(treatmentBudgetItem.budgetId, item.budgetId),
        eq(treatmentBudgetItem.planItemId, item.id),
        eq(treatmentBudgetItem.organizationId, orgId),
      ),
    )
    .orderBy(
      sql`${treatmentBudgetOption.decision} = 'elegida' desc`,
      sql`${treatmentBudgetOption.isRecommended} desc`,
      asc(treatmentBudgetOption.position),
    )
    .limit(1)
  return row?.line ?? null
}

export async function itemDecision(
  tx: Db,
  orgId: string,
  item: { id: string; budgetId: string | null },
): Promise<PlanItemDecision> {
  const [row] = await tx
    .select({ decision: treatmentPlanItem.decisionStatus })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, item.id)))
  if (!row) throw notFound("Ítem del plan")
  return row.decision as PlanItemDecision
}

async function withDecisions(
  tx: Db,
  orgId: string,
  items: PlanItemRow[],
): Promise<PlanItemWithProgress[]> {
  const ids = items.map((item) => item.id)
  const done = ids.length
    ? await tx
        .select({ id: encounterProcedure.planItemId, n: sql<number>`count(*)::int` })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.planItemId, ids),
            isNull(encounterProcedure.voidedAt),
          ),
        )
        .groupBy(encounterProcedure.planItemId)
    : []
  const sessions = new Map(done.map((row) => [row.id, row.n]))
  return items.map((item) => ({
    ...item,
    decision: item.decisionStatus as PlanItemDecision,
    sessionsDone: sessions.get(item.id) ?? 0,
  }))
}

/** Siguiente posición al final del plan: el orden de indicación es el de partida. */
async function nextSortOrder(tx: Db, orgId: string, planId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${treatmentPlanItem.sortOrder})` })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.planId, planId)))
  return (row?.max ?? 0) + 1
}

function assertPhase(value: string | null | undefined): TreatmentPhase | null {
  if (value === undefined || value === null) return null
  if (!(TREATMENT_PHASES as readonly string[]).includes(value))
    throw validation(`Fase inválida: ${TREATMENT_PHASES.join(", ")}`)
  return value as TreatmentPhase
}

function assertPlannedSessions(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 1 || value > 60)
    throw validation("Las sesiones previstas van de 1 a 60")
  return value
}

/**
 * Bloqueo ordenado para ejecución clínica (encounters.addEncounterProcedure):
 * atención (ya tomada por el caller) → plan → presupuesto → ítem.
 */
export async function lockPlanItemForExecution(
  tx: Db,
  orgId: string,
  patientId: string,
  itemId: string,
): Promise<{ item: PlanItemRow; budget: BudgetHeaderRow | null; line: BudgetLineRow | null }> {
  const [prev] = await tx
    .select({ planId: treatmentPlanItem.planId, budgetId: treatmentPlanItem.budgetId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Ítem del plan")
  await lockPlanRow(tx, orgId, patientId, prev.planId)
  let budget: BudgetHeaderRow | null = null
  if (prev.budgetId) budget = await lockBudgetRow(tx, orgId, prev.budgetId)
  const item = await lockItemRow(tx, orgId, patientId, itemId)
  const line = await currentLine(tx, orgId, item)
  return { item, budget, line }
}

export async function createTreatmentPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { title: string; originEncounterId: string },
): Promise<TreatmentPlanRow> {
  await requirePatient(tx, orgId, patientId)
  if (!input.originEncounterId?.trim())
    throw validation("originEncounterId es obligatorio: el plan nace en una atención borrador")
  const originEncounterId = input.originEncounterId.trim()
  await lockDraftEncounter(tx, orgId, patientId, originEncounterId)
  const title = assertTitle(input.title)
  // La atención donde nace queda en el plan (antes se pedía y no se guardaba).
  const [row] = await tx
    .insert(treatmentPlan)
    .values({ organizationId: orgId, patientId, title, originEncounterId, isLegacy: false, createdBy: actorUserId })
    .returning()
  if (!row) throw new Error("No se pudo crear el plan de tratamiento")
  await audit(tx, orgId, actorUserId, "plan.created", "treatment_plan", row.id, {
    patientId,
    title,
    originEncounterId,
  })
  return row
}

/** Título del plan que nace solo con la primera indicación. */
export const OPEN_PLAN_TITLE = "Plan de tratamiento"

/**
 * Un plan está abierto mientras le queda algo por hacer o aún no tiene nada:
 * no es heredado y no todo está realizado, cancelado o reemplazado.
 */
export function isPlanOpen(plan: { isLegacy: boolean }, statuses: readonly string[]): boolean {
  if (plan.isLegacy) return false
  return statuses.length === 0 || statuses.some((status) => !CLOSED_STATUSES.includes(status))
}

/** El plan abierto de la persona (el más reciente), o null si no tiene. */
export async function findOpenPlan(tx: Db, orgId: string, patientId: string): Promise<TreatmentPlanRow | null> {
  const plans = await tx
    .select()
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.organizationId, orgId), eq(treatmentPlan.patientId, patientId), eq(treatmentPlan.isLegacy, false)))
    .orderBy(desc(treatmentPlan.createdAt), desc(treatmentPlan.id))
  if (plans.length === 0) return null
  const items = await tx
    .select({ planId: treatmentPlanItem.planId, status: treatmentPlanItem.status })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        inArray(treatmentPlanItem.planId, plans.map((plan) => plan.id)),
      ),
    )
  return (
    plans.find((plan) =>
      isPlanOpen(plan, items.filter((item) => item.planId === plan.id).map((item) => item.status)),
    ) ?? null
  )
}

/**
 * El plan donde se indica: el pedido (del mismo paciente) o el abierto; si no
 * hay ninguno, nace uno con la atención como origen. La atención borrador ya
 * está bloqueada por quien llama, así que dos indicaciones a la vez no abren
 * dos planes.
 */
async function planForIndication(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  planId: string | null | undefined,
): Promise<TreatmentPlanRow> {
  if (planId?.trim()) return lockPlanRow(tx, orgId, patientId, planId.trim())
  const open = await findOpenPlan(tx, orgId, patientId)
  if (open) return lockPlanRow(tx, orgId, patientId, open.id)
  const created = await createTreatmentPlan(tx, orgId, actorUserId, patientId, {
    title: OPEN_PLAN_TITLE,
    originEncounterId: encounterId,
  })
  return lockPlanRow(tx, orgId, patientId, created.id)
}

export async function listTreatmentPlans(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<
  Array<{
    plan: TreatmentPlanRow
    status: TreatmentPlanStatus
    totalItems: number
    pendingItems: number
    /** El plan abierto de la persona: el que recibe las indicaciones nuevas. */
    isOpen: boolean
  }>
> {
  await requirePatient(tx, orgId, patientId)
  const open = await findOpenPlan(tx, orgId, patientId)
  const plans = await tx
    .select()
    .from(treatmentPlan)
    .where(and(eq(treatmentPlan.patientId, patientId), eq(treatmentPlan.organizationId, orgId)))
    .orderBy(asc(treatmentPlan.createdAt), asc(treatmentPlan.id))
  const items =
    plans.length === 0
      ? []
      : await tx
          .select({ planId: treatmentPlanItem.planId, status: treatmentPlanItem.status })
          .from(treatmentPlanItem)
          .where(
            and(
              eq(treatmentPlanItem.organizationId, orgId),
              eq(treatmentPlanItem.patientId, patientId),
              inArray(
                treatmentPlanItem.planId,
                plans.map((p) => p.id),
              ),
            ),
          )
  const byPlan = new Map<string, string[]>()
  for (const item of items) {
    const list = byPlan.get(item.planId) ?? []
    list.push(item.status)
    byPlan.set(item.planId, list)
  }
  return plans.map((plan) => {
    const statuses = byPlan.get(plan.id) ?? []
    return {
      plan,
      status: derivePlanStatus(statuses),
      totalItems: statuses.length,
      pendingItems: statuses.filter((s) => s === "pendiente" || s === "programado").length,
      isOpen: open?.id === plan.id,
    }
  })
}

export async function getTreatmentPlanDetail(
  tx: Db,
  orgId: string,
  patientId: string,
  planId: string,
): Promise<{
  plan: TreatmentPlanRow
  status: TreatmentPlanStatus
  items: PlanItemWithDecision[]
  budgetIds: string[]
}> {
  await requirePatient(tx, orgId, patientId)
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
  if (!plan) throw notFound("Plan de tratamiento")
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.planId, planId), eq(treatmentPlanItem.organizationId, orgId)))
    .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id))
  const withDecision = await withDecisions(tx, orgId, items)
  const budgetIds = [
    ...new Set(items.map((i) => i.budgetId).filter((id): id is string => id !== null)),
  ]
  return {
    plan,
    status: derivePlanStatus(items.map((i) => i.status)),
    items: withDecision,
    budgetIds,
  }
}

export async function listPlanItems(
  tx: Db,
  orgId: string,
  patientId: string,
  planId?: string,
): Promise<PlanItemWithProgress[]> {
  await requirePatient(tx, orgId, patientId)
  const conditions = [
    eq(treatmentPlanItem.patientId, patientId),
    eq(treatmentPlanItem.organizationId, orgId),
  ]
  if (planId) conditions.push(eq(treatmentPlanItem.planId, planId))
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(...conditions))
    .orderBy(
      asc(treatmentPlanItem.sortOrder),
      asc(treatmentPlanItem.createdAt),
      asc(treatmentPlanItem.id),
    )
  return withDecisions(tx, orgId, items)
}

export async function addPlanItem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddPlanItemInput,
): Promise<PlanItemWithDecision> {
  await requirePatient(tx, orgId, patientId)
  if (!input.sourceEncounterId?.trim()) throw validation("sourceEncounterId es obligatorio")
  if (!input.serviceId?.trim())
    throw validation("serviceId es obligatorio: selecciona una prestación de la lista de servicios")
  const encounterId = input.sourceEncounterId.trim()
  await lockDraftEncounter(tx, orgId, patientId, encounterId)
  // No se elige plan al indicar: va al abierto, que nace solo si no hay.
  const plan = await planForIndication(tx, orgId, actorUserId, patientId, encounterId, input.planId)
  if (input.odontogramEntryId) {
    // Trazabilidad clínica: la indicación responde a un hallazgo real del paciente.
    const [entry] = await tx
      .select({ id: odontogramEntry.id })
      .from(odontogramEntry)
      .where(
        and(
          eq(odontogramEntry.id, input.odontogramEntryId),
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          isNull(odontogramEntry.voidedAt),
        ),
      )
    if (!entry) throw notFound("Hallazgo del odontograma")
  }
  const service = await requireServiceForIndication(tx, orgId, input.serviceId.trim())
  const scope = assertScopeValue(service.scope)
  const site = assertSite(
    scope,
    {
      toothNumber: input.toothNumber,
      surfaces: input.surfaces,
      quadrant: input.quadrant,
      arch: input.arch,
    },
    await surfaceLimits(tx, service),
  )
  const detail = assertDetail(input.detail)
  const diagnosisCode = normalizeDiagnosisCode(input.diagnosisCode)
  if (diagnosisCode) await assertDiagnosisCode(tx, diagnosisCode)
  const codings = await resolveServiceCodings(tx, service)
  // La fase la propone la especialidad de la clínica por su clave de la biblioteca.
  const phase =
    assertPhase(input.phase) ?? phaseForSpecialty((await serviceSpecialtyOf(tx, orgId, service.specialtyId))?.key)
  const plannedSessions = assertPlannedSessions(input.plannedSessions) ?? 1
  const sortOrder = await nextSortOrder(tx, orgId, plan.id)
  const [row] = await tx
    .insert(treatmentPlanItem)
    .values({
      organizationId: orgId,
      patientId,
      planId: plan.id,
      serviceId: service.id,
      budgetId: null,
      phase,
      plannedSessions,
      sortOrder,
      odontogramEntryId: input.odontogramEntryId ?? null,
      toothNumber: site.toothNumber,
      scope,
      surfaces: site.surfaces,
      quadrant: site.quadrant,
      arch: site.arch,
      title: service.name,
      detail,
      diagnosisCode,
      codings,
      priceCents: service.priceCents,
      currency: service.currency,
      status: "pendiente",
      sourceEncounterId: encounterId,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear el ítem del plan")
  await audit(tx, orgId, actorUserId, "plan.item_added", "treatment_plan_item", row.id, {
    patientId,
    planId: row.planId,
    sourceEncounterId: row.sourceEncounterId,
    serviceId: service.id,
    scope,
    codings: codings.length,
    priceCents: service.priceCents,
    currency: service.currency,
  })
  return { ...row, decision: "pendiente" }
}

export interface AddPlanItemsBatchInput {
  /** Oferta de ámbito tooth: una fila por diente (selección explícita multi-pieza). */
  serviceId: string
  /** Sin él, el plan abierto (o uno nuevo). */
  planId?: string | null
  sourceEncounterId: string
  toothNumbers: number[]
  detail?: string | null
  diagnosisCode?: string | null
}

/**
 * Lote multi-pieza en una sola transacción (la abre el caller vía
 * withOrgContext): valida TODO antes de insertar; cualquier pieza inválida
 * aborta el lote completo sin parciales (rollback).
 */
export async function addPlanItemsBatch(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: AddPlanItemsBatchInput,
): Promise<PlanItemWithDecision[]> {
  await requirePatient(tx, orgId, patientId)
  if (!input.sourceEncounterId?.trim()) throw validation("sourceEncounterId es obligatorio")
  if (!input.serviceId?.trim()) throw validation("serviceId es obligatorio")
  if (
    !Array.isArray(input.toothNumbers) ||
    input.toothNumbers.length < 1 ||
    input.toothNumbers.length > 52
  ) {
    throw validation("toothNumbers debe tener entre 1 y 52 piezas")
  }
  const teeth = [...new Set(input.toothNumbers)].sort((a, b) => a - b)
  if (teeth.length !== input.toothNumbers.length) throw validation("toothNumbers no debe repetirse")
  await lockDraftEncounter(tx, orgId, patientId, input.sourceEncounterId.trim())
  const plan = await planForIndication(tx, orgId, actorUserId, patientId, input.sourceEncounterId.trim(), input.planId)
  const service = await requireServiceForIndication(tx, orgId, input.serviceId.trim())
  const scope = assertScopeValue(service.scope)
  if (scope !== "tooth")
    throw validation("El lote multi-pieza solo admite prestaciones de ámbito tooth")
  for (const tooth of teeth) {
    assertSite("tooth", { toothNumber: tooth })
  }
  const detail = assertDetail(input.detail)
  const diagnosisCode = normalizeDiagnosisCode(input.diagnosisCode)
  if (diagnosisCode) await assertDiagnosisCode(tx, diagnosisCode)
  if (service.priceCents === null)
    throw new ServiceError("SERVICE_UNPRICED", 409, "La prestación aún no tiene precio configurado")
  const codings = await resolveServiceCodings(tx, service)
  const rows: PlanItemRow[] = []
  const phase = phaseForSpecialty((await serviceSpecialtyOf(tx, orgId, service.specialtyId))?.key)
  let sortOrder = await nextSortOrder(tx, orgId, plan.id)
  for (const tooth of teeth) {
    const [row] = await tx
      .insert(treatmentPlanItem)
      .values({
        organizationId: orgId,
        patientId,
        planId: plan.id,
        serviceId: service.id,
        budgetId: null,
        phase,
        sortOrder: sortOrder++,
        toothNumber: tooth,
        scope,
        surfaces: [],
        quadrant: null,
        arch: null,
        title: service.name,
        detail,
        diagnosisCode,
        codings,
        priceCents: service.priceCents,
        currency: service.currency,
        status: "pendiente",
        sourceEncounterId: input.sourceEncounterId.trim(),
        createdBy: actorUserId,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear el ítem del plan")
    rows.push(row)
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "plan.items_added_batch",
    "treatment_plan_item",
    rows[0]?.id ?? "",
    {
      patientId,
      planId: plan.id,
      serviceId: service.id,
      count: rows.length,
    },
  )
  return rows.map((row) => ({ ...row, decision: "pendiente" as const }))
}

export async function updatePlanItem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  patch: UpdatePlanItemPatch,
): Promise<PlanItemWithDecision> {
  await requirePatient(tx, orgId, patientId)
  if (!patch.encounterId?.trim())
    throw validation("encounterId es obligatorio como contexto de mutación")
  await lockDraftEncounter(tx, orgId, patientId, patch.encounterId.trim())
  const [prev] = await tx
    .select({ planId: treatmentPlanItem.planId, budgetId: treatmentPlanItem.budgetId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .limit(1)
  if (!prev) throw notFound("Ítem del plan")
  await lockPlanRow(tx, orgId, patientId, prev.planId)
  let budget: BudgetHeaderRow | null = null
  if (prev.budgetId) {
    budget = await lockBudgetRow(tx, orgId, prev.budgetId)
    if (budget.status !== "borrador") {
      throw conflict(
        "ITEM_CLOSED",
        "El ítem pertenece a un presupuesto presentado o decidido y no puede editarse",
      )
    }
  }
  const current = await lockItemRow(tx, orgId, patientId, itemId)
  if (CLOSED_STATUSES.includes(current.status)) {
    throw conflict("ITEM_CLOSED", "El ítem está cerrado y no puede editarse")
  }
  const set: Partial<typeof treatmentPlanItem.$inferInsert> = {}
  const fields: string[] = []
  let site = {
    toothNumber: current.toothNumber,
    surfaces: current.surfaces,
    quadrant: current.quadrant,
    arch: current.arch,
  }
  let scope = assertScopeValue(current.scope)
  if (patch.serviceId !== undefined) {
    if (!patch.serviceId?.trim())
      throw validation("serviceId es obligatorio: selecciona una prestación de la lista de servicios")
    // El mismo serviceId no recalcula precio; un cambio real sí re-congela.
    if (patch.serviceId.trim() !== current.serviceId) {
      const service = await requireServiceForIndication(tx, orgId, patch.serviceId.trim())
      scope = assertScopeValue(service.scope)
      site = assertSite(
        scope,
        {
          toothNumber: patch.toothNumber !== undefined ? patch.toothNumber : current.toothNumber,
          surfaces: patch.surfaces !== undefined ? patch.surfaces : current.surfaces,
          quadrant: patch.quadrant !== undefined ? patch.quadrant : current.quadrant,
          arch: patch.arch !== undefined ? patch.arch : current.arch,
        },
        await surfaceLimits(tx, service),
      )
      if (service.priceCents === null) {
        throw new ServiceError(
          "SERVICE_UNPRICED",
          409,
          "La prestación aún no tiene precio configurado",
        )
      }
      if (budget && service.currency !== budget.currency) {
        throw new ServiceError(
          "BUDGET_CURRENCY_MIX",
          409,
          "La oferta usa una moneda distinta a la del presupuesto en borrador",
        )
      }
      set.serviceId = service.id
      set.title = service.name
      set.scope = scope
      set.priceCents = service.priceCents
      set.currency = service.currency
      // Cambio de servicio = nueva indicación: re-congela el snapshot exacto
      // vigente; los históricos (presupuestos presentados/decididos,
      // atenciones) nunca se mutan.
      set.codings = await resolveServiceCodings(tx, service)
      fields.push("serviceId")
    }
  }
  const siteTouched =
    patch.toothNumber !== undefined ||
    patch.surfaces !== undefined ||
    patch.quadrant !== undefined ||
    patch.arch !== undefined
  if (siteTouched && !fields.includes("serviceId")) {
    let limits: { min: number | null; max: number | null } | undefined
    if (current.serviceId) {
      const [offer] = await tx
        .select()
        .from(serviceCatalog)
        .where(
          and(eq(serviceCatalog.id, current.serviceId), eq(serviceCatalog.organizationId, orgId)),
        )
        .limit(1)
      limits = offer ? await surfaceLimits(tx, offer) : { min: 1, max: 5 }
    }
    site = assertSite(
      scope,
      {
        toothNumber: patch.toothNumber !== undefined ? patch.toothNumber : current.toothNumber,
        surfaces: patch.surfaces !== undefined ? patch.surfaces : current.surfaces,
        quadrant: patch.quadrant !== undefined ? patch.quadrant : current.quadrant,
        arch: patch.arch !== undefined ? patch.arch : current.arch,
      },
      limits,
    )
    fields.push("site")
  }
  if (fields.includes("serviceId") || fields.includes("site")) {
    set.toothNumber = site.toothNumber
    set.surfaces = site.surfaces
    set.quadrant = site.quadrant
    set.arch = site.arch
    if (fields.includes("site") && !fields.includes("serviceId")) {
      // El sitio se valida contra el scope vigente del ítem.
    }
  }
  if (patch.detail !== undefined) {
    set.detail = assertDetail(patch.detail)
    fields.push("detail")
  }
  if (patch.diagnosisCode !== undefined) {
    const code = normalizeDiagnosisCode(patch.diagnosisCode)
    if (code) await assertDiagnosisCode(tx, code)
    set.diagnosisCode = code
    fields.push("diagnosisCode")
  }
  if (fields.length === 0) throw validation("Sin cambios: patch vacío")
  const [updated] = await tx
    .update(treatmentPlanItem)
    .set({ ...set, updatedAt: new Date() })
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Ítem del plan")
  if (budget && budget.status === "borrador") {
    // La línea del borrador es snapshot: se actualiza en la misma transacción.
    // Solo el borrador sigue a la nueva indicación; presentados/decididos son
    // históricos inmutables (updatePlanItem ya rechazó budget no-borrador).
    // Cambiar de indicación re-congela la tarifa y el modo de cobro, y limpia
    // precio acordado y promoción (eran del servicio anterior).
    const modes = updated.serviceId
      ? await readBillingModes(tx, orgId, [updated.serviceId])
      : {}
    await tx
      .update(treatmentBudgetItem)
      .set({
        serviceId: updated.serviceId,
        title: updated.title,
        scope: updated.scope,
        toothNumber: updated.toothNumber,
        surfaces: updated.surfaces,
        quadrant: updated.quadrant,
        arch: updated.arch,
        codings: updated.codings,
        priceCents: updated.priceCents,
        tariffPriceCents: updated.priceCents,
        priceReason: null,
        promotionId: null,
        promotionName: null,
        promotionMode: null,
        billingMode: updated.serviceId ? (modes[updated.serviceId] ?? "treatment") : "treatment",
        sessionsPlanned: updated.plannedSessions,
        currency: updated.currency,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(treatmentBudgetItem.budgetId, budget.id),
          eq(treatmentBudgetItem.planItemId, itemId),
          eq(treatmentBudgetItem.organizationId, orgId),
        ),
      )
  }
  await audit(tx, orgId, actorUserId, "plan.item_updated", "treatment_plan_item", itemId, {
    patientId,
    fields,
  })
  return { ...updated, decision: await itemDecision(tx, orgId, updated) }
}

export async function setPlanItemStatus(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  input: { status: string; encounterId?: string | null; statusReason?: string | null },
): Promise<PlanItemWithDecision> {
  if (!(PLAN_ITEM_STATUSES as readonly string[]).includes(input.status))
    throw validation("status inválido")
  await requirePatient(tx, orgId, patientId)
  if (input.encounterId) await lockDraftEncounter(tx, orgId, patientId, input.encounterId)
  const { item: current, budget } = await lockPlanItemForExecution(tx, orgId, patientId, itemId)
  if (CLOSED_STATUSES.includes(current.status))
    throw conflict("ITEM_CLOSED", "El tratamiento está cerrado")
  const transitions: Record<string, readonly string[]> = {
    pendiente: ["programado", "en_curso", "suspendido", "cancelado"],
    programado: ["en_curso", "suspendido", "realizado", "cancelado"],
    en_curso: ["suspendido", "realizado"],
    suspendido: ["pendiente", "programado", "en_curso", "cancelado"],
  }
  if (!transitions[current.status]?.includes(input.status)) {
    throw conflict("INVALID_TRANSITION", "La transición clínica no está permitida")
  }
  let reason: string | null = null
  if (input.status === "suspendido" || input.status === "cancelado") {
    reason = input.statusReason?.trim() ?? ""
    if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  }
  if (["programado", "en_curso", "realizado"].includes(input.status)) {
    if (current.decisionStatus !== "aceptado")
      throw conflict("ITEM_NOT_ACCEPTED", "El tratamiento no está aceptado")
    if (!budget || budget.status === "cancelado") {
      throw conflict("BUDGET_CLOSED", "El presupuesto del tratamiento está cerrado")
    }
    assertExecutableCodings(current.codings)
  }
  if (input.status === "realizado") {
    if (!input.encounterId)
      throw conflict("ATTENTION_REQUIRED", "Completar requiere una atención borrador")
    const [procedure] = await tx
      .select({ id: encounterProcedure.id })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.organizationId, orgId),
          eq(encounterProcedure.planItemId, itemId),
        ),
      )
      .limit(1)
    if (!procedure)
      throw conflict(
        "ATTENTION_REQUIRED",
        "Completar requiere al menos un procedimiento registrado",
      )
    await tx
      .insert(encounterPlanItem)
      .values({
        organizationId: orgId,
        encounterId: input.encounterId,
        planItemId: itemId,
      })
      .onConflictDoNothing()
  }
  const now = new Date()
  const [updated] = await tx
    .update(treatmentPlanItem)
    .set({
      status: input.status,
      statusReason: reason,
      updatedAt: now,
      ...(input.status === "en_curso" && !current.startedAt ? { startedAt: now } : {}),
      ...(input.status === "realizado" ? { completedAt: now } : {}),
    })
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .returning()
  if (!updated) throw notFound("Ítem del plan")
  await audit(tx, orgId, actorUserId, "plan.item_status_changed", "treatment_plan_item", itemId, {
    patientId,
    from: current.status,
    to: input.status,
    reason,
    encounterId: input.encounterId,
  })
  // Lo tratado queda dibujado: lo que su servicio deja en la pieza (la resina,
  // una restauración) se registra en esta atención, una sola vez.
  if (input.status === "realizado" && input.encounterId)
    await drawTreatedFinding(tx, orgId, actorUserId, patientId, input.encounterId, updated)
  return { ...updated, decision: updated.decisionStatus as PlanItemDecision }
}

export async function revisePlanItem(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  input: TreatmentSiteInput & {
    encounterId: string
    reason: string
    serviceId: string
    detail?: string | null
    diagnosisCode?: string | null
  },
): Promise<PlanItemWithDecision> {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, input.encounterId)
  const { item } = await lockPlanItemForExecution(tx, orgId, patientId, itemId)
  if (CLOSED_STATUSES.includes(item.status))
    throw conflict("ITEM_CLOSED", "El tratamiento está cerrado")
  const next = await addPlanItem(tx, orgId, actorUserId, patientId, {
    ...input,
    sourceEncounterId: input.encounterId,
    planId: item.planId,
  })
  await tx
    .update(treatmentPlanItem)
    .set({
      status: "reemplazado",
      decisionStatus: "reemplazado",
      statusReason: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(treatmentPlanItem.id, item.id), eq(treatmentPlanItem.organizationId, orgId)))
  const [revised] = await tx
    .update(treatmentPlanItem)
    .set({ supersedesItemId: item.id })
    .where(and(eq(treatmentPlanItem.id, next.id), eq(treatmentPlanItem.organizationId, orgId)))
    .returning()
  if (!revised) throw notFound("Ítem del plan")
  await audit(tx, orgId, actorUserId, "plan.item_revised", "treatment_plan_item", item.id, {
    patientId,
    reason,
    supersededBy: revised.id,
  })
  return { ...revised, decision: revised.decisionStatus as PlanItemDecision }
}

export interface PlanItemPlanningInput {
  phase?: string
  plannedSessions?: number
  /** Sube o baja una posición dentro de su fase (alternativa de teclado al arrastre). */
  move?: "up" | "down"
}

/**
 * Planificación del tratamiento: fase, sesiones previstas y orden. No es un
 * acto clínico (no exige atención abierta) ni cambia la decisión o el estado.
 */
export async function updatePlanItemPlanning(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
  input: PlanItemPlanningInput,
): Promise<PlanItemWithProgress> {
  await requirePatient(tx, orgId, patientId)
  const [found] = await tx
    .select({ planId: treatmentPlanItem.planId })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, itemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
  if (!found) throw notFound("Tratamiento")
  await lockPlanRow(tx, orgId, patientId, found.planId)
  const [item] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.id, itemId), eq(treatmentPlanItem.organizationId, orgId)))
    .for("update")
  if (!item) throw notFound("Tratamiento")
  if (CLOSED_STATUSES.includes(item.status))
    throw new ServiceError("ITEM_CLOSED", 409, "Un tratamiento cerrado ya no se planifica")
  const phase = assertPhase(input.phase)
  const plannedSessions = assertPlannedSessions(input.plannedSessions)
  if (plannedSessions !== null) {
    const [done] = await withDecisions(tx, orgId, [item])
    if (done && plannedSessions < done.sessionsDone)
      throw validation(`Ya se hicieron ${done.sessionsDone} sesiones: no pueden preverse menos`)
  }
  const changes: Partial<PlanItemRow> = {}
  if (phase !== null && phase !== item.phase) {
    changes.phase = phase
    // Al cambiar de fase entra al final de la nueva.
    changes.sortOrder = await nextSortOrder(tx, orgId, item.planId)
  }
  if (plannedSessions !== null) changes.plannedSessions = plannedSessions
  if (Object.keys(changes).length > 0) {
    await tx
      .update(treatmentPlanItem)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(treatmentPlanItem.id, item.id))
  }
  if (input.move) {
    const currentOrder = changes.sortOrder ?? item.sortOrder
    const currentPhase = changes.phase ?? item.phase
    const [neighbor] = await tx
      .select({ id: treatmentPlanItem.id, sortOrder: treatmentPlanItem.sortOrder })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.planId, item.planId),
          eq(treatmentPlanItem.phase, currentPhase),
          input.move === "up"
            ? lt(treatmentPlanItem.sortOrder, currentOrder)
            : gt(treatmentPlanItem.sortOrder, currentOrder),
        ),
      )
      .orderBy(
        input.move === "up" ? desc(treatmentPlanItem.sortOrder) : asc(treatmentPlanItem.sortOrder),
      )
      .limit(1)
    if (neighbor) {
      await tx
        .update(treatmentPlanItem)
        .set({ sortOrder: currentOrder, updatedAt: new Date() })
        .where(eq(treatmentPlanItem.id, neighbor.id))
      await tx
        .update(treatmentPlanItem)
        .set({ sortOrder: neighbor.sortOrder, updatedAt: new Date() })
        .where(eq(treatmentPlanItem.id, item.id))
    }
  }
  await audit(tx, orgId, actorUserId, "plan.item_planned", "treatment_plan_item", item.id, {
    patientId,
    planId: item.planId,
    phase: changes.phase ?? null,
    plannedSessions: changes.plannedSessions ?? null,
    move: input.move ?? null,
  })
  const [updated] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(eq(treatmentPlanItem.id, item.id))
  if (!updated) throw notFound("Tratamiento")
  const [listed] = await withDecisions(tx, orgId, [updated])
  return listed as PlanItemWithProgress
}
