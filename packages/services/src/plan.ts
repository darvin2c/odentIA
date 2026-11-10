import type { Db } from "@odentia/db"
import {
  encounter,
  encounterPlanItem,
  encounterProcedure,
  patientCharge,
  serviceCatalog,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentBudgetOption,
  treatmentPlan,
  treatmentPlanItem,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm"
import { acceptedBudgetLines } from "./agreed-lines.js"
import { readBillingModes } from "./budgets.js"
import {
  diagnosisTitlesOf,
  namedDiagnosis,
  resolveOptionalDiagnosisCode,
} from "./diagnosis-codes.js"
import { assertAttending } from "./encounter-attending.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { treatmentConsentStates } from "./consent-state.js"
import { createFinishControls } from "./finish-controls.js"
import { orgClinicalProfile } from "./locale.js"
import { requirePatient } from "./patients.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import {
  type ProductHooks,
  type ProductParts,
  type ProductSite,
  type SiteColumns,
  type SiteFields,
  siteInputOf,
  withSite,
} from "./product-hooks.js"
import { productHooks } from "./products.js"
import { requireServiceForIndication, type ServiceRow } from "./service-catalog.js"
import { serviceKindOf } from "./specialties.js"
import { waitingFor } from "./to-schedule.js"

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

/**
 * El ítem con su sitio como lo dice el producto y lo que este le agrega
 * (odentIA: pieza y caras, y el hallazgo que lo motivó como `odontogramEntryId`).
 */
export type PlanItemRow = typeof treatmentPlanItem.$inferSelect & SiteFields & ProductParts
export type TreatmentPlanRow = typeof treatmentPlan.$inferSelect
type BudgetLineRow = typeof treatmentBudgetItem.$inferSelect & SiteFields

/** Cabecera de presupuesto (lectura acotada a org+paciente). */
export type BudgetHeaderRow = typeof treatmentBudget.$inferSelect

/** Ítem con decisión vigente explícita. */
export type PlanItemWithDecision = PlanItemRow & { decision: PlanItemDecision }

/**
 * El camino de un tratamiento: su presupuesto tiene varias opciones y él no está
 * en todas (lo común va en todas y no tiene camino). Lo dice el presupuesto, no
 * se guarda aparte: el plan agrupa lo que compite mientras la persona elige.
 */
export interface PlanItemPath {
  budgetId: string
  /** Sus opciones (1 = «Opción A»): casi siempre una. */
  positions: number[]
  /** El nombre que le puso quien lo preparó a esa opción, si lo hay. */
  name: string | null
  /** Cuántos caminos tiene el presupuesto. */
  pathCount: number
  /** Ya eligió un camino (este u otro). */
  chosen: boolean
}

/** Ítem listado con su progreso: sesiones hechas = procedimientos no anulados. */
export type PlanItemWithProgress = PlanItemWithDecision & {
  /** El diagnóstico con su nombre («Pulpitis (CIE-11 DA09.0)»); null sin diagnóstico. */
  diagnosisName: string | null
  sessionsDone: number
  path: PlanItemPath | null
  /**
   * Aceptado, y la revisión entregada de su presupuesto le pregunta de nuevo
   * (cambió su precio o sus condiciones): sigue valiendo lo aceptado mientras tanto.
   */
  newTermsPending: boolean
  /**
   * Realizado y le puede faltar otra sesión (ADR 0164): llegó en atenciones firmadas
   * a sus previstas y a las sesiones con que se repartió su comisión. La pantalla
   * ofrece «Falta otra sesión» solo entonces (`reopenPlanItemForSession`).
   */
  canAddSession: boolean
  /**
   * El precio acordado: el de la línea aceptada de su presupuesto, el mismo que
   * se cobra (`acceptedBudgetLines`). Nulo si no hay nada aceptado: vale
   * `priceCents` (QA de la ficha del 8 nov: la atención decía S/ 120 de lista
   * con S/ 90 acordado).
   */
  agreedPriceCents: number | null
  agreedCurrency: string | null
  /**
   * Sin nada aceptado, el precio que le ofrece su presupuesto vigente (la opción
   * elegida o, mientras decide, la recomendada). No es lo que se cobra: se dice
   * «en su presupuesto», nunca como acordado.
   */
  offeredPriceCents: number | null
  offeredCurrency: string | null
}

/**
 * Lo que decide si un realizado puede volver a en curso con otra sesión: sus
 * sesiones en atenciones firmadas (las que cuenta la comisión) y las sesiones
 * con que se repartió la comisión de sus cargos (`commission_sessions`).
 */
async function sessionsForAnother(
  tx: Db,
  orgId: string,
  ids: string[],
): Promise<Map<string, { signed: number; frozen: number; oneOff?: boolean }>> {
  const out = new Map<string, { signed: number; frozen: number; oneOff?: boolean }>()
  if (ids.length === 0) return out
  const oneOffKinds = (await hooksOf(tx, orgId)).oneOffKinds ?? []
  const oneOffSql = oneOffKinds.length
    ? sql`tpl.specialty in (${sql.join(
        oneOffKinds.map((kind) => sql`${kind}`),
        sql`, `,
      )})`
    : sql`false`
  const rows = await tx.execute<{ id: string; signed: number; frozen: number; one_off: boolean | null }>(sql`
    select item.id,
      -- Una consulta, una evaluación o una radiografía se hacen de una vez: no piden otra sesión
      -- (QA del 9 nov, repaso 3: la consulta de una urgencia ofrecía «Falta otra sesión»).
      (select ${oneOffSql} from service_catalog svc join treatment_template tpl on tpl.id = svc.template_id
        where svc.organization_id = item.organization_id and svc.id = item.service_id) as one_off,
      (select count(distinct e.id)::int from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
        where ep.organization_id = item.organization_id and ep.plan_item_id = item.id and ep.voided_at is null
          and e.status = 'finalizada' and e.voided_at is null) as signed,
      (select coalesce(max(c.commission_sessions), 0)::int from patient_charge c
        where c.organization_id = item.organization_id and c.plan_item_id = item.id and c.voided_at is null) as frozen
    from treatment_plan_item item
    where item.organization_id = ${orgId} and item.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
  for (const row of rows) out.set(row.id, { signed: Number(row.signed), frozen: Number(row.frozen), oneOff: row.one_off === true })
  return out
}

/** Si un realizado puede volver a en curso: lo firmado llega a sus previstas y a lo que repartió su comisión. */
function anotherSessionAllowed(
  item: { status: string; plannedSessions: number },
  money: { signed: number; frozen: number; oneOff?: boolean } | undefined,
): boolean {
  return (
    item.status === "realizado" &&
    !!money &&
    !money.oneOff &&
    money.signed > 0 &&
    money.signed >= Math.max(item.plannedSessions, money.frozen)
  )
}

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
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  /** Hallazgo del odontograma que motiva la indicación (mismo paciente, no anulado). */
  odontogramEntryId?: string | null
  /** Fase del plan; por defecto, la que propone la especialidad del servicio. */
  phase?: string | null
  /** Sesiones previstas (1–60); por defecto, las habituales de su servicio (ADR 0164). */
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
  /** Lista del código; sin ella, la de la clínica (el ya guardado viaja con la suya). */
  diagnosisSystem?: string | null
  /**
   * Sesiones previstas (1–60) mientras no se hizo ninguna. Al cambiar de servicio sin ellas, las
   * habituales del nuevo: «Cambiar» pide lo mismo que «Indicar» (QA del 9 nov, repaso 3).
   */
  plannedSessions?: number | null
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

/** Lo que hace el producto de la clínica en el plan (su sitio, sus fases y lo que anota con cada ítem). */
const hooksOf = (tx: Db, orgId: string): Promise<ProductHooks> => productHooks(tx, orgId)

/**
 * La decisión con que nace lo indicado: en odentIA espera la respuesta a su
 * presupuesto; en latidIA queda aceptado al indicarlo (decisión 15 del issue 229).
 */
function indicatedDecision(
  hooks: ProductHooks,
): Pick<typeof treatmentPlanItem.$inferInsert, "decisionStatus" | "decidedAt"> {
  return hooks.budgetRequired
    ? { decisionStatus: "pendiente" }
    : { decisionStatus: "aceptado", decidedAt: new Date() }
}

function assertScopeValue(site: ProductSite, scope: string | null | undefined): string {
  if (!scope || !site.scopes.includes(scope)) throw validation("La oferta no tiene un ámbito válido para indicar")
  return scope
}

/** Ítems del plan como los dice la API: su sitio y lo que el producto les agrega. */
async function withPlanParts<T extends SiteColumns & { id: string }>(
  tx: Db,
  orgId: string,
  rows: readonly T[],
): Promise<Array<T & SiteFields & ProductParts>> {
  const hooks = await hooksOf(tx, orgId)
  const parts = await hooks.planItemParts(tx, orgId, rows.map((row) => row.id))
  return rows.map((row) => ({ ...withSite(hooks.site, row), ...(parts.get(row.id) ?? {}) }))
}

/** Un ítem del plan como lo dice la API (su sitio y lo que el producto le agrega). */
export async function withPlanItemParts<T extends SiteColumns & { id: string }>(
  tx: Db,
  orgId: string,
  row: T,
): Promise<T & SiteFields & ProductParts> {
  const [item] = await withPlanParts(tx, orgId, [row])
  return item!
}

/** Límites de superficies: de la plantilla, o 1–5 para ofertas propias. */
export async function surfaceLimits(
  tx: Db,
  orgId: string,
  service: { templateId: string | null },
): Promise<{ min: number | null; max: number | null }> {
  if (!service.templateId) return { min: 1, max: 5 }
  return (await (await hooksOf(tx, orgId)).templateSurfaceLimits(tx, service.templateId)) ?? { min: 1, max: 5 }
}

/** Lock de la atención borrador (contexto de mutación clínica), llevada por quien escribe. */
export async function lockDraftEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  actorUserId: string,
): Promise<void> {
  const [enc] = await tx
    .select({ id: encounter.id, status: encounter.status, professionalUserId: encounter.professionalUserId })
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
  assertAttending(enc, actorUserId)
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
  return withPlanItemParts(tx, orgId, item)
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
  return row?.line ? withSite((await hooksOf(tx, orgId)).site, row.line) : null
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
  rows: Array<typeof treatmentPlanItem.$inferSelect>,
): Promise<PlanItemWithProgress[]> {
  const items = await withPlanParts(tx, orgId, rows)
  const ids = items.map((item) => item.id)
  // Sesiones hechas: atenciones distintas, no anuladas, con un procedimiento vigente
  // (la misma regla de `sessionsDoneSql` y de las comisiones).
  const done = ids.length
    ? await tx
        .select({ id: encounterProcedure.planItemId, n: sql<number>`count(distinct ${encounterProcedure.encounterId})::int` })
        .from(encounterProcedure)
        .innerJoin(
          encounter,
          and(eq(encounter.organizationId, encounterProcedure.organizationId), eq(encounter.id, encounterProcedure.encounterId)),
        )
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.planItemId, ids),
            isNull(encounterProcedure.voidedAt),
            ne(encounter.status, "anulada"),
          ),
        )
        .groupBy(encounterProcedure.planItemId)
    : []
  const sessions = new Map(done.map((row) => [row.id, row.n]))
  const paths = await pathsOf(tx, orgId, items)
  const accepted = items.filter((item) => item.decisionStatus === "aceptado" && item.budgetId)
  const asked = accepted.length
    ? await tx
        .selectDistinct({ planItemId: treatmentBudgetItem.planItemId })
        .from(treatmentBudgetItem)
        .innerJoin(
          treatmentBudget,
          and(
            eq(treatmentBudget.id, treatmentBudgetItem.budgetId),
            eq(treatmentBudget.organizationId, treatmentBudgetItem.organizationId),
          ),
        )
        .where(
          and(
            eq(treatmentBudgetItem.organizationId, orgId),
            inArray(
              treatmentBudgetItem.planItemId,
              accepted.map((item) => item.id),
            ),
            eq(treatmentBudgetItem.decision, "pendiente"),
            ne(treatmentBudget.status, "borrador"),
            sql`${treatmentBudgetItem.budgetId} = (select own.budget_id from treatment_plan_item own where own.id = ${treatmentBudgetItem.planItemId} and own.organization_id = ${treatmentBudgetItem.organizationId})`,
          ),
        )
    : []
  const newTerms = new Set(asked.map((row) => row.planItemId))
  const another = await sessionsForAnother(
    tx,
    orgId,
    items.filter((item) => item.status === "realizado").map((item) => item.id),
  )
  const agreed = await agreedPricesOf(tx, orgId, items)
  // El diagnóstico con su nombre, como en la Historia: «Pulpitis (CIE-11 DA09.0)», no solo el código.
  const titles = await diagnosisTitlesOf(
    tx,
    items.map((item) => ({ system: item.diagnosisSystem, code: item.diagnosisCode })),
  )
  return items.map((item) => ({
    ...item,
    diagnosisName: item.diagnosisCode ? namedDiagnosis(titles, item.diagnosisSystem, item.diagnosisCode) : null,
    decision: item.decisionStatus as PlanItemDecision,
    sessionsDone: sessions.get(item.id) ?? 0,
    path: paths.get(item.id) ?? null,
    newTermsPending: newTerms.has(item.id),
    canAddSession: anotherSessionAllowed(item, another.get(item.id)),
    agreedPriceCents: agreed.accepted.get(item.id)?.priceCents ?? null,
    agreedCurrency: agreed.accepted.get(item.id)?.currency ?? null,
    offeredPriceCents: agreed.offered.get(item.id)?.priceCents ?? null,
    offeredCurrency: agreed.offered.get(item.id)?.currency ?? null,
  }))
}

/**
 * El precio de presupuesto de cada tratamiento: el aceptado (lo que se cobra,
 * también el de un presupuesto sustituido mientras su revisión espera respuesta)
 * y, sin nada aceptado, el que le ofrece la línea vigente de su presupuesto no
 * cancelado (la opción elegida o, mientras decide, la recomendada; como `currentLine`).
 */
async function agreedPricesOf(
  tx: Db,
  orgId: string,
  items: ReadonlyArray<{ id: string; patientId: string; budgetId: string | null }>,
): Promise<{
  accepted: Map<string, { priceCents: number | null; currency: string }>
  offered: Map<string, { priceCents: number | null; currency: string }>
}> {
  const accepted = new Map<string, { priceCents: number | null; currency: string }>()
  const offered = new Map<string, { priceCents: number | null; currency: string }>()
  for (const patientId of new Set(items.map((item) => item.patientId)))
    for (const [id, line] of await acceptedBudgetLines(
      tx,
      orgId,
      patientId,
      items.filter((item) => item.patientId === patientId).map((item) => item.id),
    ))
      accepted.set(id, { priceCents: line.priceCents, currency: line.currency })
  const rest = items.filter((item) => item.budgetId && !accepted.has(item.id))
  if (rest.length === 0) return { accepted, offered }
  const lines = await tx
    .select({ planItemId: treatmentBudgetItem.planItemId, priceCents: treatmentBudgetItem.priceCents, currency: treatmentBudgetItem.currency })
    .from(treatmentBudgetItem)
    .innerJoin(
      treatmentBudgetOption,
      and(
        eq(treatmentBudgetOption.id, treatmentBudgetItem.optionId),
        eq(treatmentBudgetOption.organizationId, treatmentBudgetItem.organizationId),
      ),
    )
    .innerJoin(
      treatmentBudget,
      and(eq(treatmentBudget.id, treatmentBudgetItem.budgetId), eq(treatmentBudget.organizationId, treatmentBudgetItem.organizationId)),
    )
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        inArray(
          treatmentBudgetItem.planItemId,
          rest.map((item) => item.id),
        ),
        sql`${treatmentBudgetItem.budgetId} = (select own.budget_id from treatment_plan_item own where own.id = ${treatmentBudgetItem.planItemId} and own.organization_id = ${treatmentBudgetItem.organizationId})`,
        ne(treatmentBudget.status, "cancelado"),
      ),
    )
    .orderBy(
      sql`${treatmentBudgetOption.decision} = 'elegida' desc`,
      sql`${treatmentBudgetOption.isRecommended} desc`,
      asc(treatmentBudgetOption.position),
    )
  for (const line of lines) if (!offered.has(line.planItemId)) offered.set(line.planItemId, { priceCents: line.priceCents, currency: line.currency })
  return { accepted, offered }
}

/** El camino de cada tratamiento según las opciones de su presupuesto vigente. */
async function pathsOf(
  tx: Db,
  orgId: string,
  items: ReadonlyArray<{ id: string; budgetId: string | null }>,
): Promise<Map<string, PlanItemPath>> {
  const out = new Map<string, PlanItemPath>()
  const budgetIds = [...new Set(items.map((item) => item.budgetId).filter((id): id is string => !!id))]
  if (budgetIds.length === 0) return out
  const options = await tx
    .select({
      id: treatmentBudgetOption.id,
      budgetId: treatmentBudgetOption.budgetId,
      position: treatmentBudgetOption.position,
      name: treatmentBudgetOption.name,
      decision: treatmentBudgetOption.decision,
    })
    .from(treatmentBudgetOption)
    .where(and(eq(treatmentBudgetOption.organizationId, orgId), inArray(treatmentBudgetOption.budgetId, budgetIds)))
  const several = new Set(
    budgetIds.filter((id) => options.filter((option) => option.budgetId === id).length > 1),
  )
  if (several.size === 0) return out
  const lines = await tx
    .select({
      planItemId: treatmentBudgetItem.planItemId,
      budgetId: treatmentBudgetItem.budgetId,
      optionId: treatmentBudgetItem.optionId,
    })
    .from(treatmentBudgetItem)
    .where(and(eq(treatmentBudgetItem.organizationId, orgId), inArray(treatmentBudgetItem.budgetId, [...several])))
  for (const item of items) {
    if (!item.budgetId || !several.has(item.budgetId)) continue
    const own = options.filter((option) => option.budgetId === item.budgetId)
    const mine = own.filter((option) =>
      lines.some((line) => line.planItemId === item.id && line.optionId === option.id),
    )
    if (mine.length === 0 || mine.length === own.length) continue
    out.set(item.id, {
      budgetId: item.budgetId,
      positions: mine.map((option) => option.position).sort((a, b) => a - b),
      name: mine.length === 1 ? (mine[0]?.name ?? null) : null,
      pathCount: own.length,
      chosen: own.some((option) => option.decision === "elegida"),
    })
  }
  return out
}

/** Siguiente posición al final del plan: el orden de indicación es el de partida. */
async function nextSortOrder(tx: Db, orgId: string, planId: string): Promise<number> {
  const [row] = await tx
    .select({ max: sql<number | null>`max(${treatmentPlanItem.sortOrder})` })
    .from(treatmentPlanItem)
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.planId, planId)))
  return (row?.max ?? 0) + 1
}

function assertPhase(hooks: ProductHooks, value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (!hooks.planPhases.includes(value)) throw invalidField("phase", `Fase inválida: ${hooks.planPhases.join(", ")}`)
  return value
}

function assertPlannedSessions(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 1 || value > 60)
    throw invalidField("plannedSessions", "Las sesiones previstas van de 1 a 60")
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
  await lockDraftEncounter(tx, orgId, patientId, originEncounterId, actorUserId)
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
 * El plan donde se indica: el pedido (del mismo paciente), el que nació en esta
 * misma atención (aunque lo de hoy ya esté todo realizado: una resina hecha y
 * otra indicada en la misma atención son el mismo plan, QA del 6 nov) o el
 * abierto; si no hay ninguno, nace uno con la atención como origen. La atención
 * borrador ya está bloqueada por quien llama, así que dos indicaciones a la vez
 * no abren dos planes.
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
  const [born] = await tx
    .select({ id: treatmentPlan.id })
    .from(treatmentPlan)
    .where(
      and(
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
        eq(treatmentPlan.originEncounterId, encounterId),
        eq(treatmentPlan.isLegacy, false),
      ),
    )
    .orderBy(desc(treatmentPlan.createdAt), desc(treatmentPlan.id))
    .limit(1)
  if (born) return lockPlanRow(tx, orgId, patientId, born.id)
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
    /**
     * Le queda algo por hacer (`isPlanOpen`). Puede haber más de uno (planes
     * de antes de que hubiera uno solo): ninguno es «anterior» mientras le
     * quede algo por hacer.
     */
    active: boolean
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
      active: open?.id === plan.id || isPlanOpen(plan, statuses),
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

/**
 * El motivo con que queda lo que se quitó en la misma atención donde se indicó,
 * antes de que la persona respondiera (`removeIndicatedFromEncounter`). El Plan
 * no lo lista: fue corregir el borrador, como lo de una atención anulada.
 */
export const REMOVED_IN_ENCOUNTER = "Se quitó en la atención donde se indicó"

/**
 * Los tratamientos del plan. `withoutVoided` (el Plan de la persona): lo que
 * se canceló porque se anuló la atención donde se indicó no se lista; queda en
 * la atención anulada y en la auditoría. La copia de la historia y los demás
 * lectores lo siguen recibiendo.
 */
export async function listPlanItems(
  tx: Db,
  orgId: string,
  patientId: string,
  planId?: string,
  opts: { withoutVoided?: boolean } = {},
): Promise<Array<PlanItemWithProgress & { waitsFor: { id: string; title: string } | null }>> {
  await requirePatient(tx, orgId, patientId)
  const conditions = [
    eq(treatmentPlanItem.patientId, patientId),
    eq(treatmentPlanItem.organizationId, orgId),
  ]
  if (planId) conditions.push(eq(treatmentPlanItem.planId, planId))
  if (opts.withoutVoided) {
    // Tampoco lo que quien atendía quitó en la misma atención donde lo indicó: fue corregir el borrador.
    conditions.push(sql`not (${treatmentPlanItem.status} = 'cancelado' and (exists (
      select 1 from encounter voided where voided.organization_id = ${treatmentPlanItem.organizationId}
        and voided.id = ${treatmentPlanItem.sourceEncounterId} and voided.status = 'anulada')
      or ${treatmentPlanItem.statusReason} = ${REMOVED_IN_ENCOUNTER}))`)
  }
  const items = await tx
    .select()
    .from(treatmentPlanItem)
    .where(and(...conditions))
    .orderBy(
      asc(treatmentPlanItem.sortOrder),
      asc(treatmentPlanItem.createdAt),
      asc(treatmentPlanItem.id),
    )
  const withProgress = await withDecisions(tx, orgId, items)
  // Lo que va después de otro tratamiento de la misma pieza (la corona tras la endodoncia), con
  // la regla de «Qué sigue» (`waitingFor`): «Registrar lo de hoy» no lo propone por omisión.
  const phases = (await hooksOf(tx, orgId)).planPhases
  // Lo indicado y aún por decidir cuenta como si se aceptara: la endodoncia y la corona indicadas en
  // la misma consulta ya tienen su orden antes de responder el presupuesto (QA antes de entregar).
  const asDecided = withProgress.map((item) => (item.decisionStatus === "pendiente" ? { ...item, decisionStatus: "aceptado" } : item))
  // El consentimiento va con el tratamiento: el Plan dice si falta firmarlo (consentimientos, 10 nov).
  const consents = await treatmentConsentStates(tx, orgId, withProgress.map((item) => item.id))
  return withProgress.map((item, index) => {
    const before = waitingFor(asDecided[index]!, asDecided, phases)
    return { ...item, waitsFor: before ? { id: before.id, title: before.title } : null, consent: consents.get(item.id)?.state ?? null, consentMissing: consents.get(item.id)?.missing ?? [] }
  })
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
    throw invalidField("serviceId", "Elige la prestación de la lista de servicios.")
  const encounterId = input.sourceEncounterId.trim()
  await lockDraftEncounter(tx, orgId, patientId, encounterId, actorUserId)
  // No se elige plan al indicar: va al abierto, que nace solo si no hay.
  const plan = await planForIndication(tx, orgId, actorUserId, patientId, encounterId, input.planId)
  const service = await requireServiceForIndication(tx, orgId, input.serviceId.trim())
  const hooks = await hooksOf(tx, orgId)
  const scope = assertScopeValue(hooks.site, service.scope)
  const itemSite = hooks.site.columns(siteInputOf(hooks.site, input), { scope, surfaces: await surfaceLimits(tx, orgId, service), pending: true })
  const detail = assertDetail(input.detail)
  const diagnosis = await resolveOptionalDiagnosisCode(tx, orgId, { code: input.diagnosisCode, system: input.diagnosisSystem }, "diagnosisCode")
  const codings = await resolveServiceCodings(tx, (await orgClinicalProfile(tx, orgId)).services, service)
  // La fase la propone la especialidad de la clínica por su clave de la biblioteca.
  const phase =
    assertPhase(hooks, input.phase) ?? hooks.phaseFor(await serviceKindOf(tx, orgId, service))
  // Nace con las sesiones habituales de su servicio (ADR 0164): una endodoncia
  // de dos no se termina en su primera firma (ADR 0161).
  const plannedSessions = assertPlannedSessions(input.plannedSessions) ?? service.usualSessions
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
      scope,
      ...itemSite,
      title: service.name,
      detail,
      ...diagnosis,
      codings,
      priceCents: service.priceCents,
      currency: service.currency,
      status: "pendiente",
      ...indicatedDecision(hooks),
      sourceEncounterId: encounterId,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear el ítem del plan")
  // Lo que el producto anota con el ítem (odentIA: el hallazgo que lo motivó).
  await hooks.planItemCreated(tx, { orgId, patientId, item: row, input: { ...input } })
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
  return { ...(await withPlanItemParts(tx, orgId, row)), decision: row.decisionStatus as PlanItemDecision }
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
  diagnosisSystem?: string | null
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
  await lockDraftEncounter(tx, orgId, patientId, input.sourceEncounterId.trim(), actorUserId)
  const plan = await planForIndication(tx, orgId, actorUserId, patientId, input.sourceEncounterId.trim(), input.planId)
  const service = await requireServiceForIndication(tx, orgId, input.serviceId.trim())
  const hooks = await hooksOf(tx, orgId)
  const scope = assertScopeValue(hooks.site, service.scope)
  if (!hooks.site.looseScope || scope !== hooks.site.looseScope)
    throw validation("El lote de varios sitios solo admite prestaciones de un sitio suelto, como las de una pieza")
  const sites = teeth.map((tooth) => hooks.site.columns({ toothNumber: tooth }, { scope }))
  const detail = assertDetail(input.detail)
  const diagnosis = await resolveOptionalDiagnosisCode(tx, orgId, { code: input.diagnosisCode, system: input.diagnosisSystem })
  if (service.priceCents === null)
    throw new ServiceError("SERVICE_UNPRICED", 409, "La prestación aún no tiene precio configurado")
  const codings = await resolveServiceCodings(tx, (await orgClinicalProfile(tx, orgId)).services, service)
  const rows: PlanItemRow[] = []
  const phase = hooks.phaseFor(await serviceKindOf(tx, orgId, service))
  let sortOrder = await nextSortOrder(tx, orgId, plan.id)
  for (const itemSite of sites) {
    const [row] = await tx
      .insert(treatmentPlanItem)
      .values({
        organizationId: orgId,
        patientId,
        planId: plan.id,
        serviceId: service.id,
        budgetId: null,
        phase,
        // Cada pieza nace con las sesiones habituales de su servicio, como al indicar una (ADR 0164).
        plannedSessions: service.usualSessions,
        sortOrder: sortOrder++,
        scope,
        ...itemSite,
        title: service.name,
        detail,
        ...diagnosis,
        codings,
        priceCents: service.priceCents,
        currency: service.currency,
        status: "pendiente",
        ...indicatedDecision(hooks),
        sourceEncounterId: input.sourceEncounterId.trim(),
        createdBy: actorUserId,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear el ítem del plan")
    rows.push(await withPlanItemParts(tx, orgId, row))
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
  return rows.map((row) => ({ ...row, decision: row.decisionStatus as PlanItemDecision }))
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
  await lockDraftEncounter(tx, orgId, patientId, patch.encounterId.trim(), actorUserId)
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
  const hooks = await hooksOf(tx, orgId)
  let itemSite: SiteColumns = { siteSystem: current.siteSystem, siteCode: current.siteCode, siteQualifiers: current.siteQualifiers }
  let scope = assertScopeValue(hooks.site, current.scope)
  // El sitio pedido: lo que llegó sobre lo que ya tenía.
  const askedSite = () => ({ ...hooks.site.fields(current), ...siteInputOf(hooks.site, patch) })
  if (patch.serviceId !== undefined) {
    if (!patch.serviceId?.trim())
      throw validation("serviceId es obligatorio: selecciona una prestación de la lista de servicios")
    // El mismo serviceId no recalcula precio; un cambio real sí re-congela.
    if (patch.serviceId.trim() !== current.serviceId) {
      const service = await requireServiceForIndication(tx, orgId, patch.serviceId.trim())
      scope = assertScopeValue(hooks.site, service.scope)
      itemSite = hooks.site.columns(askedSite(), { scope, surfaces: await surfaceLimits(tx, orgId, service), pending: true })
      if (service.priceCents === null) {
        throw new ServiceError(
          "SERVICE_UNPRICED",
          409,
          "La prestación aún no tiene precio configurado",
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
      set.codings = await resolveServiceCodings(tx, (await orgClinicalProfile(tx, orgId)).services, service)
      // Sin sesiones hechas, también las sesiones previstas son las del servicio nuevo (ADR 0164).
      if (current.status === "pendiente" || current.status === "programado") set.plannedSessions = service.usualSessions
      // Y su fase: la exodoncia cambiada por una endodoncia no se queda en la quirúrgica (QA del 9 nov,
      // repaso 3). Es la misma regla que al indicar; el orden del plan sale de ella («va después»).
      set.phase = hooks.phaseFor(await serviceKindOf(tx, orgId, service))
      fields.push("serviceId")
    }
  }
  const siteTouched = Object.keys(siteInputOf(hooks.site, patch)).length > 0
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
      limits = offer ? await surfaceLimits(tx, orgId, offer) : { min: 1, max: 5 }
    }
    itemSite = hooks.site.columns(askedSite(), { scope, surfaces: limits, pending: true })
    fields.push("site")
  }
  if (fields.includes("serviceId") || fields.includes("site")) {
    Object.assign(set, itemSite)
    if (fields.includes("site") && !fields.includes("serviceId")) {
      // El sitio se valida contra el scope vigente del ítem.
    }
  }
  const plannedSessions = assertPlannedSessions(patch.plannedSessions)
  if (plannedSessions !== null && plannedSessions !== (set.plannedSessions ?? current.plannedSessions)) {
    // Con una sesión hecha, las previstas se cambian desde el Plan («Planificar»), que mira las hechas.
    if (current.status !== "pendiente" && current.status !== "programado")
      throw invalidField("plannedSessions", "Ya empezó: cambia sus sesiones desde el Plan")
    set.plannedSessions = plannedSessions
    fields.push("plannedSessions")
  }
  if (patch.detail !== undefined) {
    set.detail = assertDetail(patch.detail)
    fields.push("detail")
  }
  if (patch.diagnosisCode !== undefined) {
    const diagnosis = await resolveOptionalDiagnosisCode(tx, orgId, { code: patch.diagnosisCode, system: patch.diagnosisSystem })
    set.diagnosisCode = diagnosis.diagnosisCode
    set.diagnosisSystem = diagnosis.diagnosisSystem
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
  // Cambió lo que su consentimiento describe: lo firmado deja de contar y el pendiente se anula para
  // prepararlo con el texto nuevo (consentimientos, 10 nov).
  if (fields.some((field) => field === "serviceId" || field === "site" || field === "diagnosisCode"))
    await resetPlanItemConsents(tx, orgId, actorUserId, updated.id)
  if (budget && budget.status === "borrador") {
    // La línea del borrador es snapshot: se actualiza en la misma transacción.
    // Solo el borrador sigue a la nueva indicación; presentados/decididos son
    // históricos inmutables (updatePlanItem ya rechazó budget no-borrador).
    // Solo cambiar de servicio es otra indicación: re-congela la tarifa y el modo
    // de cobro, y limpia precio acordado y promoción (eran del servicio anterior).
    // Corregir la pieza, sus caras, el detalle o el diagnóstico conserva lo que se
    // acordó por ese tratamiento (QA del 8 nov, entrega 3: «Cambiar» en la atención
    // volvía a la tarifa y perdía el precio pactado).
    const serviceChanged = fields.includes("serviceId")
    const sessionsChanged = serviceChanged || fields.includes("plannedSessions")
    const modes = serviceChanged && updated.serviceId ? await readBillingModes(tx, orgId, [updated.serviceId]) : {}
    await tx
      .update(treatmentBudgetItem)
      .set({
        scope: updated.scope,
        siteSystem: updated.siteSystem,
        siteCode: updated.siteCode,
        siteQualifiers: updated.siteQualifiers,
        ...(serviceChanged
          ? {
              serviceId: updated.serviceId,
              title: updated.title,
              codings: updated.codings,
              priceCents: updated.priceCents,
              tariffPriceCents: updated.priceCents,
              priceReason: null,
              promotionId: null,
              promotionName: null,
              promotionMode: null,
              billingMode: updated.serviceId ? (modes[updated.serviceId] ?? "treatment") : "treatment",
              currency: updated.currency,
            }
          : {}),
        ...(sessionsChanged ? { sessionsPlanned: updated.plannedSessions } : {}),
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
  const item = await withPlanItemParts(tx, orgId, updated)
  return { ...item, decision: await itemDecision(tx, orgId, item) }
}

/**
 * Un tratamiento sin presupuesto que quedó aceptado en una atención: se hizo en
 * ella (aceptado al hacerlo o servicio directo), así que tiene un procedimiento
 * vigente. Si ese acto se anuló, la aceptación ya no tiene de dónde salir.
 */
async function acceptedInAttention(tx: Db, orgId: string, itemId: string): Promise<boolean> {
  const [done] = await tx
    .select({ id: encounterProcedure.id })
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.planItemId, itemId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .limit(1)
  return Boolean(done)
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
  if (input.encounterId) await lockDraftEncounter(tx, orgId, patientId, input.encounterId, actorUserId)
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
    // Completar lo que aún no empezó: falta registrar la sesión, no es un error de estado.
    if (current.status === "pendiente" && input.status === "realizado")
      throw conflict("INVALID_TRANSITION", "Registra primero la sesión de hoy: un tratamiento sin sesiones no se completa")
    throw conflict("INVALID_TRANSITION", "La transición clínica no está permitida")
  }
  let reason: string | null = null
  if (input.status === "suspendido" || input.status === "cancelado") {
    reason = input.statusReason?.trim() ?? ""
    if (!reason || reason.length > 2000) throw invalidField("statusReason", "El motivo debe tener 1–2000 caracteres.")
  }
  if (["programado", "en_curso", "realizado"].includes(input.status)) {
    if (current.decisionStatus !== "aceptado")
      throw conflict("ITEM_NOT_ACCEPTED", "El tratamiento no está aceptado")
    // Donde lo indicado queda aceptado al indicarlo (latidIA), basta la decisión.
    // Lo aceptado en una atención (al hacerlo, sin presupuesto) tampoco lo pide:
    // una endodoncia en dos sesiones aceptada en la primera se completa en la segunda.
    if (
      (await hooksOf(tx, orgId)).budgetRequired &&
      (budget ? budget.status === "cancelado" : !(await acceptedInAttention(tx, orgId, itemId)))
    ) {
      throw conflict("BUDGET_CLOSED", "El presupuesto del tratamiento está cerrado")
    }
    assertExecutableCodings(current.codings)
  }
  if (input.status === "realizado") {
    if (!input.encounterId)
      throw conflict("ATTENTION_REQUIRED", "Completar requiere una atención borrador")
    // Basta una sesión vigente de cualquier atención, no de la que lo completa: el
    // Recorrido ofrece «Completar tratamiento» en la atención abierta aunque hoy no
    // se haya hecho una sesión (un control que lo da por terminado), y sus pruebas lo
    // fijan. Lo que no se ofrece es completar sin sesión desde «Hecho hoy»: allí, sin
    // un procedimiento suyo en esta atención, el botón es «Registrar la sesión».
    const [procedure] = await tx
      .select({ id: encounterProcedure.id })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.organizationId, orgId),
          eq(encounterProcedure.planItemId, itemId),
          // Una sesión anulada no cuenta: si no, se cerraría un tratamiento que no se hizo.
          isNull(encounterProcedure.voidedAt),
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
  // Lo que su producto hace con un tratamiento realizado (odentIA: lo que su
  // servicio deja en la pieza se registra en esta atención, una sola vez).
  if (input.status === "realizado" && input.encounterId)
    await (await productHooks(tx, orgId)).treatmentDone(tx, {
      orgId,
      actorUserId,
      patientId,
      encounterId: input.encounterId,
      planItemId: updated.id,
    })
  // Y los controles que deja su servicio al terminar (B5), en todos los productos.
  if (input.status === "realizado")
    await createFinishControls(tx, {
      orgId,
      actorUserId,
      patientId,
      encounterId: input.encounterId ?? null,
      planItemId: updated.id,
    })
  return {
    ...(await withPlanItemParts(tx, orgId, updated)),
    decision: updated.decisionStatus as PlanItemDecision,
  }
}

/**
 * «Falta otra sesión» sobre lo ya realizado (ADR 0164): la salida de un
 * tratamiento que se terminó al firmar porque llegó a sus sesiones previstas
 * («Sí, terminar» viene elegido, ADR 0161) y necesita otra. Vuelve a en curso
 * con una sesión prevista más que las hechas. No toca lo firmado ni lo cobrado:
 * no hay cargo nuevo, el presupuesto aceptado sigue con su tope y lo que dejó
 * en el odontograma se queda (se dibuja una sola vez por tratamiento). Solo si
 * llegó a sus previstas: uno que se terminó antes («Completar») se terminó a
 * propósito, y reabrirlo devolvería a «por asignar» la comisión que ya se dio a
 * su última sesión (`unassignedCommissionSessions`).
 */
export async function reopenPlanItemForSession(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  itemId: string,
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
  if (item.status !== "realizado")
    throw conflict("ITEM_NOT_DONE", "Solo a un tratamiento realizado le puede faltar otra sesión")
  const [progress] = await withDecisions(tx, orgId, [item])
  const done = progress?.sessionsDone ?? 0
  // La comisión cuenta solo atenciones firmadas y se reparte con las sesiones que su
  // cargo congeló (`commission_sessions`): si lo firmado no llega a ellas, lo que sobró
  // ya se le dio a la última sesión y reabrir lo devolvería a «por asignar».
  const money = (await sessionsForAnother(tx, orgId, [item.id])).get(item.id) ?? { signed: 0, frozen: 0 }
  if (money.signed < done)
    throw conflict(
      "ITEM_SESSION_UNSIGNED",
      "Su última sesión está en una atención sin firmar: fírmala y vuelve a intentarlo",
    )
  if (money.oneOff)
    throw conflict("ITEM_ONE_OFF", "Una consulta, una evaluación o una radiografía se hace de una vez: no le falta otra sesión")
  if (!anotherSessionAllowed(item, money)) {
    const planned = Math.max(item.plannedSessions, money.frozen)
    throw conflict(
      "ITEM_FINISHED_EARLY",
      `Se terminó en la sesión ${money.signed}, antes de sus ${planned} previstas: no se reabre para no mover lo ya repartido`,
    )
  }
  if (done + 1 > 60) throw invalidField("plannedSessions", "Las sesiones previstas van de 1 a 60")
  const now = new Date()
  await tx
    .update(treatmentPlanItem)
    .set({ status: "en_curso", completedAt: null, plannedSessions: done + 1, updatedAt: now })
    .where(eq(treatmentPlanItem.id, item.id))
  await audit(tx, orgId, actorUserId, "plan.item_reopened_for_session", "treatment_plan_item", item.id, {
    patientId,
    planId: item.planId,
    sessionsDone: done,
    from: item.plannedSessions,
    to: done + 1,
    completedAt: item.completedAt?.toISOString() ?? null,
  })
  const [updated] = await tx.select().from(treatmentPlanItem).where(eq(treatmentPlanItem.id, item.id))
  if (!updated) throw notFound("Tratamiento")
  const [listed] = await withDecisions(tx, orgId, [updated])
  return listed as PlanItemWithProgress
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
    diagnosisSystem?: string | null
  },
): Promise<PlanItemWithDecision> {
  const reason = input.reason?.trim()
  if (!reason || reason.length > 2000) throw invalidField("reason", "El motivo debe tener 1–2000 caracteres.")
  await requirePatient(tx, orgId, patientId)
  await lockDraftEncounter(tx, orgId, patientId, input.encounterId, actorUserId)
  const { item } = await lockPlanItemForExecution(tx, orgId, patientId, itemId)
  if (CLOSED_STATUSES.includes(item.status))
    throw conflict("ITEM_CLOSED", "El tratamiento está cerrado")
  // Un adelanto «Para» este tratamiento quedaría en el reemplazado y el nuevo se cobraría entero
  // (mesa de la entrega 12): primero caja lo anula o lo devuelve.
  const [advance] = await tx
    .select({ id: patientCharge.id })
    .from(patientCharge)
    .where(
      and(
        eq(patientCharge.organizationId, orgId),
        eq(patientCharge.planItemId, item.id),
        isNull(patientCharge.voidedAt),
        sql`${patientCharge.requestKey} like 'adelanto:%'`,
      ),
    )
    .limit(1)
  if (advance)
    throw conflict(
      "ITEM_HAS_ADVANCE",
      "Tiene un adelanto pagado para este tratamiento: pídele a caja que anule ese cobro antes de cambiarlo, para que no se cobre dos veces",
    )
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
  // El nuevo pide su consentimiento con su texto; lo pendiente del reemplazado se anula.
  await resetPlanItemConsents(tx, orgId, actorUserId, item.id)
  await audit(tx, orgId, actorUserId, "plan.item_revised", "treatment_plan_item", item.id, {
    patientId,
    reason,
    supersededBy: revised.id,
    encounterId: input.encounterId,
    // Cómo estaba: anular la atención donde se hizo el cambio lo deja así (`undoRevisionsOf`).
    before: {
      status: item.status,
      decisionStatus: item.decisionStatus,
      statusReason: item.statusReason,
      consentResetAt: item.consentResetAt?.toISOString() ?? null,
    },
  })
  return { ...(await withPlanItemParts(tx, orgId, revised)), decision: revised.decisionStatus as PlanItemDecision }
}

/** Lo que vuelve a decir el tratamiento cuyo cambio se deshizo al anular la atención. */
export interface UndoneRevision {
  /** El que vuelve a quedar como estaba. */
  restoredId: string
  restored: string
  /** El que lo había reemplazado y se anula con la atención. */
  replacement: string
}

/**
 * Los cambios de tratamiento («Revisar indicación», «Cambiar» lo aceptado) hechos en esta atención:
 * el nuevo nació en ella y reemplazó a otro que sigue «reemplazado» por él. Sin efectos.
 */
export async function revisionsOf(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<Array<{ newId: string; newTitle: string; oldId: string; oldTitle: string; oldTooth: string | null }>> {
  const rows = await tx
    .select({
      newId: treatmentPlanItem.id,
      newTitle: treatmentPlanItem.title,
      oldId: treatmentPlanItem.supersedesItemId,
    })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        sql`${treatmentPlanItem.supersedesItemId} is not null`,
        // Lo que `voidEncounter` anula con la atención, y el del medio de una cadena cambiada dos
        // veces en ella (A → B → C: se vuelve a A; revisión de la entrega 12).
        inArray(treatmentPlanItem.status, ["pendiente", "programado", "suspendido", "reemplazado"]),
      ),
    )
  if (rows.length === 0) return []
  const olds = await tx
    .select({ id: treatmentPlanItem.id, title: treatmentPlanItem.title, siteCode: treatmentPlanItem.siteCode })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        inArray(treatmentPlanItem.id, rows.map((row) => row.oldId!)),
        eq(treatmentPlanItem.status, "reemplazado"),
        // El que nació en esta misma atención también se anula: se vuelve al de antes.
        sql`${treatmentPlanItem.sourceEncounterId} is distinct from ${encounterId}::uuid`,
      ),
    )
  const byId = new Map(olds.map((row) => [row.id, row]))
  return rows.flatMap((row) => {
    const old = byId.get(row.oldId!)
    return old ? [{ newId: row.newId, newTitle: row.newTitle, oldId: old.id, oldTitle: old.title, oldTooth: old.siteCode }] : []
  })
}

/**
 * Anular la atención donde se cambió un tratamiento deshace el cambio: el nuevo se anula con ella
 * (lo hace `voidEncounter`) y el anterior vuelve a como estaba —su estado, su decisión y su
 * consentimiento firmado— en vez de quedar «reemplazado» por algo que ya no existe (QA del 10 nov,
 * A1). Lo que había antes sale de la auditoría del cambio; uno anterior a guardarla vuelve a
 * «pendiente» con la decisión de su presupuesto.
 */
export async function undoRevisionsOf(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  reason: string,
  at: Date,
): Promise<void> {
  const revisions = await revisionsOf(tx, orgId, patientId, encounterId)
  for (const revision of revisions) {
    const [event] = await tx
      .select({ metadata: auditEvent.metadata })
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.organizationId, orgId),
          eq(auditEvent.entity, "treatment_plan_item"),
          eq(auditEvent.entityId, revision.oldId),
          eq(auditEvent.action, "plan.item_revised"),
        ),
      )
      .orderBy(desc(auditEvent.createdAt))
      .limit(1)
    const before = (event?.metadata as { before?: RevisionBefore } | null)?.before
    const decision = before?.decisionStatus ?? (await budgetDecisionOf(tx, orgId, revision.oldId))
    await tx
      .update(treatmentPlanItem)
      .set({
        status: before?.status ?? "pendiente",
        decisionStatus: decision,
        statusReason: before ? before.statusReason : null,
        ...(before ? { consentResetAt: before.consentResetAt ? new Date(before.consentResetAt) : null } : {}),
        updatedAt: at,
      })
      .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, revision.oldId)))
    await audit(tx, orgId, actorUserId, "plan.item_revision_undone", "treatment_plan_item", revision.oldId, {
      patientId,
      encounterId,
      replacement: revision.newId,
      reason,
      restoredTo: { status: before?.status ?? "pendiente", decisionStatus: decision },
    })
  }
  // Lo del medio de una cadena (nació aquí y ya estaba reemplazado) se anula con la atención.
  if (revisions.length > 0)
    await tx
      .update(treatmentPlanItem)
      .set({ status: "cancelado", statusReason: reason, updatedAt: at })
      .where(
        and(
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
          eq(treatmentPlanItem.sourceEncounterId, encounterId),
          eq(treatmentPlanItem.status, "reemplazado"),
        ),
      )
}

interface RevisionBefore {
  status: string
  decisionStatus: string
  statusReason: string | null
  consentResetAt: string | null
}

/** La decisión que dice su presupuesto (para un cambio guardado antes de anotar cómo estaba). */
async function budgetDecisionOf(tx: Db, orgId: string, itemId: string): Promise<string> {
  const [line] = await tx
    .select({ decision: treatmentBudgetItem.decision })
    .from(treatmentBudgetItem)
    .where(and(eq(treatmentBudgetItem.organizationId, orgId), eq(treatmentBudgetItem.planItemId, itemId)))
    .orderBy(desc(treatmentBudgetItem.createdAt))
    .limit(1)
  const decision = line?.decision
  return decision && ["aceptado", "pospuesto", "rechazado"].includes(decision) ? decision : "pendiente"
}

/** Lo firmado del tratamiento deja de contar y lo pendiente se anula: se firma el texto nuevo. */
async function resetPlanItemConsents(tx: Db, orgId: string, actorUserId: string, planItemId: string): Promise<void> {
  const now = new Date()
  await tx
    .update(treatmentPlanItem)
    .set({ consentResetAt: now })
    .where(and(eq(treatmentPlanItem.organizationId, orgId), eq(treatmentPlanItem.id, planItemId)))
  const { cancelConsentDocument } = await import("./clinical-forms.js")
  const pending = await tx
    .select({ id: consentDocument.id })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.planItemId, planItemId),
        eq(consentDocument.status, "pendiente"),
      ),
    )
  for (const doc of pending)
    await cancelConsentDocument(tx, orgId, actorUserId, doc.id, "Cambió el tratamiento: se prepara con el texto nuevo")
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
  const phase = assertPhase(await hooksOf(tx, orgId), input.phase)
  const plannedSessions = assertPlannedSessions(input.plannedSessions)
  if (plannedSessions !== null) {
    const [done] = await withDecisions(tx, orgId, [item])
    if (done && plannedSessions < done.sessionsDone)
      throw invalidField("plannedSessions", `Ya se hicieron ${done.sessionsDone} sesiones: no pueden preverse menos`)
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
