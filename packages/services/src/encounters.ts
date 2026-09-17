import { assertTreatmentSite, VALID_FDI_TEETH } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  cie10Code,
  clinicalNote,
  encounter,
  encounterPlanItem,
  encounterProcedure,
  encounterTooth,
  odontogramEntry,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import { listEncounterDocuments, type PatientDocumentWithContext } from "./clinical.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { requirePatient } from "./patients.js"
import { lockPlanItemForExecution, setPlanItemStatus, surfaceLimits } from "./plan.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import { requireServiceForIndication } from "./service-catalog.js"

export type EncounterRow = typeof encounter.$inferSelect
export type EncounterProcedureRow = typeof encounterProcedure.$inferSelect
export type EncounterNoteRow = typeof clinicalNote.$inferSelect
export type EncounterOdontogramRow = typeof odontogramEntry.$inferSelect
/** Documento con vínculos, piezas y etiquetas de su revisión vigente. */
export type EncounterDocumentRow = PatientDocumentWithContext
export type EncounterPlannedItemRow = typeof treatmentPlanItem.$inferSelect

export interface CreateEncounterInput {
  reason?: string | null
  branchId?: string | null
  teeth?: number[]
  /**
   * Tratamientos del presupuesto para vincular a la atención. Deben estar
   * aceptados (decision aceptado), pendientes o programados, del mismo
   * paciente/org y con presupuesto vigente. NO se marcan realizados al crear.
   */
  planItemIds?: string[]
}

export interface UpdateEncounterDraftPatch {
  reason?: string | null
  evolution?: string | null
  indications?: string | null
  nextStep?: string | null
  /** ISO-8601; null la limpia; undefined = sin cambio. */
  nextAppointmentAt?: string | null
  /** Reemplaza el set completo de piezas (vacío = sin piezas). */
  teeth?: number[]
  /** Examen clínico de la atención (extraoral/intraoral/higieneOral); null lo limpia. */
  examination?: ExaminationInput | null
}

export interface ExaminationInput {
  extraoral?: Record<string, string> | null
  intraoral?: Record<string, string> | null
  higieneOral?: string | null
}

export interface AddEncounterProcedureInput {
  /** Servicio del catálogo para acto directo; excluyente con planItemId. */
  serviceId?: string | null
  toothNumber?: number | null
  surfaces?: string[] | null
  quadrant?: number | null
  arch?: string | null
  diagnosisCode?: string | null
  /** Ítem aceptado del plan: descripción y sitio se toman del ítem, sin cambios. */
  planItemId?: string | null
}

export interface ListEncountersInput {
  cursor?: string
  limit?: number
  status?: string
}

export interface EncounterDetail {
  encounter: EncounterRow
  teeth: number[]
  procedures: EncounterProcedureRow[]
  /** clinical_note con kind='evolucion', orden ascendente determinista. */
  notes: EncounterNoteRow[]
  odontogramEntries: EncounterOdontogramRow[]
  documents: EncounterDocumentRow[]
  /** clinical_note con kind='adenda', orden ascendente determinista. */
  addenda: EncounterNoteRow[]
  /** Ítems del plan vinculados a la atención (aceptados al vincular; su estado clínico no cambia al abrir). */
  plannedItems: EncounterPlannedItemRow[]
  /** Ítems indicados en esta atención (origen), con su decisión derivada. */
  indicatedItems: EncounterPlannedItemRow[]
}

const PAGE_DEFAULT = 30
const ENCOUNTER_STATUSES = ["borrador", "finalizada"] as const

const TEXT_LIMITS = {
  reason: 2000,
  evolution: 10000,
  indications: 5000,
  nextStep: 2000,
  procedureDescription: 2000,
} as const

const FDI_SET: ReadonlySet<number> = new Set(VALID_FDI_TEETH)

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

function uniqueConstraintOf(error: unknown): string {
  const chain = [error, (error as { cause?: unknown })?.cause]
  for (const e of chain) {
    const r = e as Record<string, unknown> | null | undefined
    const found = r?.constraint_name ?? r?.constraint ?? r?.detail
    if (found) return String(found)
  }
  return String((error as Error)?.message ?? "")
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

function assertFdi(tooth: number): void {
  if (!Number.isInteger(tooth) || !FDI_SET.has(tooth))
    throw validation(`Pieza dental inválida: ${tooth}`)
}

/** Valida FDI y elimina duplicados preservando el orden de llegada. */
function dedupeTeeth(teeth: number[]): number[] {
  if (!Array.isArray(teeth)) throw validation("teeth debe ser un arreglo de piezas FDI")
  const out: number[] = []
  const seen = new Set<number>()
  for (const t of teeth) {
    assertFdi(t)
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** Trim + cota; null/undefined/vacío → null (limpia el campo). */
function cleanText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) return null
  const t = value.trim()
  if (!t) return null
  if (t.length > max) throw validation(`${field} supera ${max} caracteres`)
  return t
}

/** Fila del encounter validando tenancy org + pertenencia al paciente. */
export async function requireEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Atención")
  return row
}

/**
 * Igual que requireEncounter pero bloqueando la fila FOR UPDATE: serializa
 * edición concurrente vs finalización (update/finalize/procedure/addenda
 * verifican el estado solo después de tomar el lock).
 */
async function lockEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  const [row] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.id, encounterId),
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
      ),
    )
    .for("update")
    .limit(1)
  if (!row) throw notFound("Atención")
  return row
}

export async function createEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateEncounterInput,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const selectedTeeth = input.teeth === undefined ? [] : dedupeTeeth(input.teeth)
  let branchId: string | null = null
  if (input.branchId) {
    const [found] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    if (!found) throw notFound("Sucursal")
    branchId = found.id
  }
  const reason = input.reason == null ? null : cleanText(input.reason, "reason", TEXT_LIMITS.reason)
  // Ítems a vincular: deduplicados preservando orden; la validación de
  // pertenencia/estado/decisión ocurre antes de crear la atención para que un
  // planItemIds inválido no deje un borrador vacío (409/404/422, sin DRAFT_OPEN).
  const planItemIds = [
    ...new Set((input.planItemIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)),
  ]
  if (planItemIds.length > 52) throw validation("planItemIds admite como máximo 52 tratamientos")
  const acceptedPlans =
    planItemIds.length > 0 ? await assertLinkablePlans(tx, orgId, patientId, planItemIds) : []
  const teeth = dedupeTeeth([
    ...selectedTeeth,
    ...acceptedPlans.flatMap((plan) => (plan.toothNumber == null ? [] : [plan.toothNumber])),
  ])
  try {
    const [row] = await tx
      .insert(encounter)
      .values({
        organizationId: orgId,
        patientId,
        branchId,
        dentistUserId: actorUserId,
        status: "borrador",
        reason,
      })
      .returning()
    if (!row) throw new Error("No se pudo crear la atención")
    if (teeth.length > 0) {
      await tx
        .insert(encounterTooth)
        .values(
          teeth.map((toothNumber) => ({ organizationId: orgId, encounterId: row.id, toothNumber })),
        )
    }
    if (acceptedPlans.length > 0) {
      // Vínculo encounter_plan_item: conserva el plan sin marcarlo realizado
      // (el estado clínico solo cambia al registrar el procedimiento).
      await tx
        .insert(encounterPlanItem)
        .values(
          acceptedPlans.map((plan) => ({
            organizationId: orgId,
            encounterId: row.id,
            planItemId: plan.id,
          })),
        )
        .onConflictDoNothing({
          target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
        })
    }
    await audit(tx, orgId, actorUserId, "encounter.created", "encounter", row.id, {
      patientId,
      teeth,
      planItemIds,
    })
    return row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    if (uniqueConstraintOf(e).includes("encounter_patient_open_uidx")) {
      throw conflict("DRAFT_OPEN", "Ya hay una atención en curso para este paciente")
    }
    throw e
  }
}

type LinkablePlan = Pick<EncounterPlannedItemRow, "id" | "toothNumber">

/**
 * Valida que cada tratamiento sea del mismo paciente/org, esté pendiente o
 * programado, aceptado en su presupuesto (decision aceptado) y con presupuesto
 * vigente (no cancelado/histórico). No muta estados: solo habilita el vínculo.
 */
async function assertLinkablePlans(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemIds: string[],
): Promise<LinkablePlan[]> {
  const rows = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        inArray(treatmentPlanItem.id, planItemIds),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
  if (rows.length !== planItemIds.length) throw notFound("Ítem del plan")
  // Orden estable plan→presupuesto→ítem, igual que el resto de rutas.
  rows.sort(
    (a, b) =>
      a.planId.localeCompare(b.planId) ||
      (a.budgetId ?? "").localeCompare(b.budgetId ?? "") ||
      a.id.localeCompare(b.id),
  )
  for (const planId of [...new Set(rows.map((r) => r.planId))].sort()) {
    await tx.execute(
      sql`select "id" from "treatment_plan" where "id" = ${planId} and "organization_id" = ${orgId} for update`,
    )
  }
  for (const budgetId of [
    ...new Set(rows.map((r) => r.budgetId).filter((id): id is string => id !== null)),
  ].sort()) {
    await tx.execute(
      sql`select "id" from "treatment_budget" where "id" = ${budgetId} and "organization_id" = ${orgId} for update`,
    )
  }
  const accepted: LinkablePlan[] = []
  for (const row of rows) {
    const [plan] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, row.id),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .limit(1)
      .for("update")
    if (!plan) throw notFound("Ítem del plan")
    if (plan.status !== "pendiente" && plan.status !== "programado") {
      throw conflict(
        "ITEM_NOT_READY",
        "Solo se pueden vincular tratamientos pendientes o programados",
      )
    }
    if (!plan.budgetId) {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden vincular tratamientos aceptados en su presupuesto vigente",
      )
    }
    const [line] = await tx
      .select({ decision: treatmentBudgetItem.decision })
      .from(treatmentBudgetItem)
      .where(
        and(
          eq(treatmentBudgetItem.budgetId, plan.budgetId),
          eq(treatmentBudgetItem.planItemId, plan.id),
          eq(treatmentBudgetItem.organizationId, orgId),
        ),
      )
      .limit(1)
    if (!line || line.decision !== "aceptado") {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden vincular tratamientos aceptados en su presupuesto vigente",
      )
    }
    const [budget] = await tx
      .select({ status: treatmentBudget.status })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, plan.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget || (budget.status !== "aceptado" && budget.status !== "parcial")) {
      throw conflict(
        "BUDGET_CLOSED",
        "El presupuesto del tratamiento no tiene una aceptación vigente",
      )
    }
    accepted.push({ id: plan.id, toothNumber: plan.toothNumber })
  }
  return accepted
}

export async function getEncounterDetail(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterDetail> {
  const row = await requireEncounter(tx, orgId, patientId, encounterId)
  const childOf = and(
    eq(clinicalNote.encounterId, encounterId),
    eq(clinicalNote.organizationId, orgId),
  )
  const [teethRows, procedures, notes, addenda, entries, documents, plannedItems, indicatedItems] =
    await Promise.all([
      tx
        .select({ toothNumber: encounterTooth.toothNumber })
        .from(encounterTooth)
        .where(
          and(
            eq(encounterTooth.encounterId, encounterId),
            eq(encounterTooth.organizationId, orgId),
          ),
        )
        .orderBy(asc(encounterTooth.toothNumber)),
      tx
        .select()
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.encounterId, encounterId),
            eq(encounterProcedure.organizationId, orgId),
          ),
        )
        .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id)),
      tx
        .select()
        .from(clinicalNote)
        .where(and(childOf, eq(clinicalNote.kind, "evolucion")))
        .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
      tx
        .select()
        .from(clinicalNote)
        .where(and(childOf, eq(clinicalNote.kind, "adenda")))
        .orderBy(asc(clinicalNote.createdAt), asc(clinicalNote.id)),
      tx
        .select()
        .from(odontogramEntry)
        .where(
          and(
            eq(odontogramEntry.encounterId, encounterId),
            eq(odontogramEntry.organizationId, orgId),
          ),
        )
        .orderBy(asc(odontogramEntry.createdAt), asc(odontogramEntry.id)),
      listEncounterDocuments(tx, orgId, patientId, encounterId),
      tx
        .select({ item: treatmentPlanItem })
        .from(encounterPlanItem)
        .innerJoin(treatmentPlanItem, eq(treatmentPlanItem.id, encounterPlanItem.planItemId))
        .where(
          and(
            eq(encounterPlanItem.encounterId, encounterId),
            eq(encounterPlanItem.organizationId, orgId),
          ),
        )
        .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id)),
      tx
        .select()
        .from(treatmentPlanItem)
        .where(
          and(
            eq(treatmentPlanItem.sourceEncounterId, encounterId),
            eq(treatmentPlanItem.organizationId, orgId),
            eq(treatmentPlanItem.patientId, patientId),
          ),
        )
        .orderBy(asc(treatmentPlanItem.createdAt), asc(treatmentPlanItem.id)),
    ])
  return {
    encounter: row,
    teeth: teethRows.map((t) => t.toothNumber),
    procedures,
    notes,
    odontogramEntries: entries,
    documents,
    addenda,
    plannedItems: plannedItems.map((link) => link.item),
    indicatedItems,
  }
}

export async function listEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  input: ListEncountersInput,
): Promise<{ items: EncounterRow[]; nextCursor: string | null }> {
  await requirePatient(tx, orgId, patientId)
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  if (
    input.status !== undefined &&
    !(ENCOUNTER_STATUSES as readonly string[]).includes(input.status)
  ) {
    throw validation("status debe ser 'borrador' o 'finalizada'")
  }
  const conditions = [eq(encounter.patientId, patientId), eq(encounter.organizationId, orgId)]
  if (input.status) conditions.push(eq(encounter.status, input.status))
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    const ts = new Date(decoded.ts)
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido")
    conditions.push(
      or(
        lt(encounter.createdAt, ts),
        and(eq(encounter.createdAt, ts), lt(encounter.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select()
    .from(encounter)
    .where(and(...conditions))
    .orderBy(desc(encounter.createdAt), desc(encounter.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  }
}
const EXAMINATION_EXTRAORAL = ["atm", "ganglios", "labios"] as const
const EXAMINATION_INTRAORAL = [
  "encias",
  "lengua",
  "paladar",
  "pisoBoca",
  "carrillos",
  "orofaringe",
] as const
const EXAMINATION_HYGIENE = ["buena", "regular", "mala"] as const
/** Examen clínico con la estructura del examenClinico de anamnesis; vacíos se recortan, grupos vacíos se omiten. */
function assertExamination(input: ExaminationInput): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw validation("examination debe ser un objeto")
  const out: Record<string, unknown> = {}
  for (const [group, allowed] of [
    ["extraoral", EXAMINATION_EXTRAORAL],
    ["intraoral", EXAMINATION_INTRAORAL],
  ] as const) {
    const value = input[group]
    if (value === undefined || value === null) continue
    if (typeof value !== "object" || Array.isArray(value))
      throw validation(`examination.${group} debe ser un objeto`)
    const cleaned: Record<string, string> = {}
    for (const [key, raw] of Object.entries(value)) {
      if (!(allowed as readonly string[]).includes(key))
        throw validation(`examination.${group}.${key} no es un campo válido`)
      if (typeof raw !== "string") throw validation(`examination.${group}.${key} debe ser texto`)
      const trimmed = raw.trim()
      if (trimmed) {
        if (trimmed.length > 500)
          throw validation(`examination.${group}.${key} debe tener hasta 500 caracteres`)
        cleaned[key] = trimmed
      }
    }
    if (Object.keys(cleaned).length > 0) out[group] = cleaned
  }
  if (input.higieneOral !== undefined && input.higieneOral !== null) {
    if (!(EXAMINATION_HYGIENE as readonly string[]).includes(input.higieneOral)) {
      throw validation("examination.higieneOral debe ser buena, regular o mala")
    }
    out.higieneOral = input.higieneOral
  }
  return Object.keys(out).length > 0 ? out : null
}

export async function updateEncounterDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  patch: UpdateEncounterDraftPatch,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada")
  const set: Partial<typeof encounter.$inferInsert> = {}
  if (patch.reason !== undefined) set.reason = cleanText(patch.reason, "reason", TEXT_LIMITS.reason)
  if (patch.evolution !== undefined)
    set.evolution = cleanText(patch.evolution, "evolution", TEXT_LIMITS.evolution)
  if (patch.indications !== undefined)
    set.indications = cleanText(patch.indications, "indications", TEXT_LIMITS.indications)
  if (patch.nextStep !== undefined)
    set.nextStep = cleanText(patch.nextStep, "nextStep", TEXT_LIMITS.nextStep)
  if (patch.nextAppointmentAt !== undefined) {
    if (patch.nextAppointmentAt === null) {
      set.nextAppointmentAt = null
    } else {
      const d = new Date(patch.nextAppointmentAt)
      if (Number.isNaN(d.getTime()))
        throw validation("nextAppointmentAt debe ser una fecha ISO válida")
      set.nextAppointmentAt = d
    }
  }
  const teeth = patch.teeth === undefined ? undefined : dedupeTeeth(patch.teeth)
  if (patch.examination !== undefined)
    set.examination = patch.examination === null ? null : assertExamination(patch.examination)
  const [updated] = await tx
    .update(encounter)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(encounter.id, encounterId))
    .returning()
  if (!updated) throw notFound("Atención")
  if (teeth !== undefined) {
    await tx.delete(encounterTooth).where(eq(encounterTooth.encounterId, encounterId))
    if (teeth.length > 0) {
      await tx
        .insert(encounterTooth)
        .values(teeth.map((toothNumber) => ({ organizationId: orgId, encounterId, toothNumber })))
    }
  }
  await audit(tx, orgId, actorUserId, "encounter.updated", "encounter", encounterId, {
    patientId,
    teeth,
  })
  return updated
}

export async function addEncounterProcedure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: AddEncounterProcedureInput,
): Promise<EncounterProcedureRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada")
  const serviceIdParam = input.serviceId?.trim() ? input.serviceId.trim() : null
  const planItemIdParam = input.planItemId ?? null
  if (Boolean(serviceIdParam) === Boolean(planItemIdParam)) {
    throw validation(
      "Selecciona un servicio del catálogo o un tratamiento del presupuesto, no ambos",
    )
  }
  // Snapshot desde el plan (misma org + paciente; anti-traversal): la
  // ejecución toma descripción, sitio y codificaciones del ítem aceptado.
  let planServiceId: string | null = null
  let planTitle = ""
  let planScope: string | null = null
  let planTooth: number | null = null
  let planSurfaces: string[] = []
  let planQuadrant: number | null = null
  let planArch: string | null = null
  let planDiagnosis: string | null = null
  let planCodings: Array<{ system: string; code: string; version: string; display: string }> = []
  if (planItemIdParam) {
    const {
      item: plan,
      line,
      budget,
    } = await lockPlanItemForExecution(tx, orgId, patientId, planItemIdParam)
    if (plan.status === "realizado" || plan.status === "cancelado") {
      throw conflict("ITEM_CLOSED", "El tratamiento ya está cerrado")
    }
    // Solo presupuesto aceptado o servicio directo explícito: setPlanItemStatus
    // vuelve a exigirlo, pero aquí el error es específico antes de insertar.
    if (!line || line.decision !== "aceptado") {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden realizar tratamientos aceptados en su presupuesto vigente",
      )
    }
    // Histórico ambiguo heredado: nunca se factura como múltiples actos ni se
    // elige un principal; se pide una nueva indicación exacta.
    assertExecutableCodings(plan.codings)
    const norm = (list: string[] | null | undefined): string[] => [...(list ?? [])].sort()
    if (input.toothNumber !== undefined && (input.toothNumber ?? null) !== plan.toothNumber) {
      throw validation("El procedimiento conserva la pieza del tratamiento indicado, sin cambios")
    }
    if (
      input.surfaces !== undefined &&
      JSON.stringify(norm(input.surfaces)) !== JSON.stringify(norm(plan.surfaces))
    ) {
      throw validation(
        "El procedimiento conserva las superficies del tratamiento indicado, sin cambios",
      )
    }
    if (input.quadrant !== undefined && (input.quadrant ?? null) !== plan.quadrant) {
      throw validation(
        "El procedimiento conserva el cuadrante del tratamiento indicado, sin cambios",
      )
    }
    if (input.arch !== undefined && (input.arch ?? null) !== plan.arch) {
      throw validation("El procedimiento conserva la arcada del tratamiento indicado, sin cambios")
    }
    planTooth = plan.toothNumber
    planSurfaces = plan.surfaces
    planQuadrant = plan.quadrant
    planArch = plan.arch
    planScope = plan.scope
    planDiagnosis = plan.diagnosisCode
    planTitle = plan.title
    planServiceId = plan.serviceId
    planCodings = [...plan.codings]
  }
  let serviceId: string | null = null
  let description = ""
  let scope: string | null = planScope
  let toothNumber: number | null = planTooth
  let surfaces: string[] = [...planSurfaces]
  let quadrant: number | null = planQuadrant
  let arch: string | null = planArch
  let codings = [...planCodings]
  if (serviceIdParam) {
    const service = await requireServiceForIndication(tx, orgId, serviceIdParam)
    if (!service.scope) throw validation("La prestación no tiene un ámbito válido")
    const limits = service.scope === "surfaces" ? await surfaceLimits(tx, service) : undefined
    try {
      assertTreatmentSite(service.scope as "general" | "tooth" | "surfaces" | "quadrant" | "arch", {
        toothNumber: input.toothNumber,
        surfaces: input.surfaces,
        quadrant: input.quadrant,
        arch: input.arch,
      }, limits)
    } catch (e) {
      throw validation(e instanceof Error ? e.message : "Sitio clínico inválido")
    }
    serviceId = service.id
    description = service.name
    scope = service.scope
    toothNumber = input.toothNumber ?? null
    surfaces = input.surfaces ? [...input.surfaces] : []
    quadrant = input.quadrant ?? null
    arch = input.arch ?? null
    // Oferta oficial: un único snapshot exacto con su versión; propia: [].
    codings = await resolveServiceCodings(tx, service)
  } else {
    serviceId = planServiceId
    description = planTitle
  }
  if (!description)
    throw validation("description es obligatoria (o selecciona un servicio del catálogo)")
  if (description.length > TEXT_LIMITS.procedureDescription) {
    throw validation(`description supera ${TEXT_LIMITS.procedureDescription} caracteres`)
  }
  if (input.diagnosisCode) await assertDiagnosisCode(tx, input.diagnosisCode)
  const [row] = await tx
    .insert(encounterProcedure)
    .values({
      organizationId: orgId,
      encounterId,
      serviceId,
      toothNumber,
      scope,
      surfaces,
      quadrant,
      arch,
      description,
      diagnosisCode: input.diagnosisCode === undefined ? planDiagnosis : input.diagnosisCode,
      planItemId: input.planItemId ?? null,
      codings,
      createdBy: actorUserId,
    })
    .returning()
  if (toothNumber !== null) {
    // La pieza tratada entra al set de la atención para que el filtro por
    // pieza del timeline la incluya aunque no estuviera al crear el borrador.
    await tx
      .insert(encounterTooth)
      .values({ organizationId: orgId, encounterId, toothNumber })
      .onConflictDoNothing({ target: [encounterTooth.encounterId, encounterTooth.toothNumber] })
  }
  if (input.planItemId) {
    // Conserva el vínculo encounter_plan_item (pudo crearse al abrir la
    // atención); setPlanItemStatus valida pertenencia mismo paciente/org +
    // borrador y exige decisión aceptada. El lock del encounter ya está tomado
    // en esta tx (re-lock es no-op).
    await tx
      .insert(encounterPlanItem)
      .values({ organizationId: orgId, encounterId, planItemId: input.planItemId })
      .onConflictDoNothing({
        target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
      })
    await setPlanItemStatus(tx, orgId, actorUserId, patientId, input.planItemId, {
      status: "realizado",
      encounterId,
    })
  }
  await audit(tx, orgId, actorUserId, "encounter.procedure_added", "encounter_procedure", row.id, {
    patientId,
    encounterId,
    planItemId: input.planItemId ?? null,
  })
  return row
}

export async function finalizeEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención ya está finalizada")
  // Mínimos de cierre: motivo más algún dato clínico útil (evolución,
  // procedimiento, diagnóstico o hallazgo de odontograma). No toca presupuestos:
  // nunca acepta ni realiza ítems automáticamente.
  if (!locked.reason?.trim())
    throw validation("Registra el motivo de la atención antes de cerrarla")
  const childOf = and(
    eq(clinicalNote.encounterId, encounterId),
    eq(clinicalNote.organizationId, orgId),
  )
  const [procedures, notes, entries] = await Promise.all([
    tx
      .select({ id: encounterProcedure.id })
      .from(encounterProcedure)
      .where(
        and(
          eq(encounterProcedure.encounterId, encounterId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
      .limit(1),
    tx
      .select({ id: clinicalNote.id })
      .from(clinicalNote)
      .where(and(childOf, eq(clinicalNote.kind, "evolucion")))
      .limit(1),
    tx
      .select({ id: odontogramEntry.id })
      .from(odontogramEntry)
      .where(
        and(
          eq(odontogramEntry.encounterId, encounterId),
          eq(odontogramEntry.organizationId, orgId),
        ),
      )
      .limit(1),
  ])
  if (
    !locked.evolution?.trim() &&
    procedures.length === 0 &&
    notes.length === 0 &&
    entries.length === 0
  ) {
    throw validation(
      "Registra evolución, un procedimiento, un diagnóstico o un hallazgo antes de cerrar la atención",
    )
  }
  const now = new Date()
  const [row] = await tx
    .update(encounter)
    .set({ status: "finalizada", finalizedAt: now, finalizedBy: actorUserId, updatedAt: now })
    .where(eq(encounter.id, encounterId))
    .returning()
  if (!row) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.finalized", "encounter", encounterId, {
    patientId,
  })
  return row
}

export async function addEncounterAddendum(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { text: string },
): Promise<EncounterNoteRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status !== "finalizada") {
    throw conflict("NOT_FINALIZED", "Solo se puede agregar una adenda a una atención finalizada")
  }
  const text = input.text?.trim() ?? ""
  if (text.length < 1 || text.length > 4000) throw validation("text debe tener 1–4000 caracteres")
  const [row] = await tx
    .insert(clinicalNote)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      note: text,
      encounterId,
      kind: "adenda",
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la adenda")
  await audit(tx, orgId, actorUserId, "encounter.addendum_added", "clinical_note", row.id, {
    patientId,
    encounterId,
  })
  return row
}
