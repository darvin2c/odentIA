import {
  assertTreatmentSite,
  emptyPeriodontalTooth,
  parseVitals,
  pendingProbingWords,
  type PeriodontalToothRecord,
  VALID_FDI_TEETH,
} from "@odentia/clinical"
import { type AssembledBudget, assembleEncounterBudget, readBillingModes } from "./budgets.js"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterDiagnosis,
  encounterPlanItem,
  encounterProcedure,
  encounterTooth,
  odontogramEntry,
  patient,
  patientCharge,
  periodontalChart,
  periodontalTooth,
  prescription,
  treatmentBudget,
  treatmentBudgetItem,
  treatmentPlan,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { member } from "@odentia/db/schema/auth"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { canAccess } from "@odentia/auth/permissions"
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm"
import { markArrivedOnAttend, notifyAppointmentChanged, setAppointmentStatus } from "./appointments.js"
import {
  type ClosingOdontogram,
  closingOdontogramOf,
  listEncounterDocuments,
  type OdontogramAssessmentRow,
  type PatientDocumentWithContext,
  signClosingOdontogram,
} from "./clinical.js"
import { type ConsentNeed, getEncounterConsentNeeds } from "./clinical-forms.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import {
  branchNotFound,
  isUniqueViolation,
  notFound,
  ServiceError,
  validation,
} from "./errors.js"
import { requirePatient } from "./patients.js"
import { createCharge } from "./payments.js"
import { requireProfessionalSignature } from "./professional-profiles.js"
import {
  addPlanItem,
  createTreatmentPlan,
  lockPlanItemForExecution,
  setPlanItemStatus,
  surfaceLimits,
} from "./plan.js"
import { assertExecutableCodings, resolveServiceCodings } from "./procedure-codings.js"
import { requireServiceForIndication } from "./service-catalog.js"
import {
  type ClosingMaterials,
  closingMaterialsOf,
  type DiscountedMaterials,
  discountEncounterMaterials,
} from "./service-materials.js"
import { countConsultationAction } from "./saas-actions.js"
import { drawTreatedFinding, voidLeftFindings } from "./treated-findings.js"

export type EncounterRow = typeof encounter.$inferSelect
export type EncounterProcedureRow = typeof encounterProcedure.$inferSelect
export type EncounterDiagnosisRow = typeof encounterDiagnosis.$inferSelect
export type EncounterNoteRow = typeof clinicalNote.$inferSelect
export type EncounterOdontogramRow = typeof odontogramEntry.$inferSelect
/** Documento con vínculos, piezas y etiquetas de su revisión vigente. */
export type EncounterDocumentRow = PatientDocumentWithContext
export type EncounterPlannedItemRow = typeof treatmentPlanItem.$inferSelect

export interface CreateEncounterInput {
  /**
   * Motivo de la visita (hasta 2000 caracteres). Sin cita es obligatorio al
   * abrir; desde una cita («Atender», sin formulario) toma el motivo escrito en
   * la cita o queda vacío, y se exige al cerrar (ADR 0032).
   */
  reason?: string | null
  /**
   * Cita que motiva la atención (mismo paciente). Hereda la sede; al cerrar la
   * atención la cita pasa a «atendida». Sin ella, la atención se une a la cita
   * de hoy que siga en pie; con un borrador del mismo día sin cita, ese
   * borrador se une a la cita en vez de abrir otro.
   */
  appointmentId?: string | null
  branchId?: string | null
  /** Profesional que atiende; por defecto quien abre. Debe tener escritura clínica. */
  dentistUserId?: string | null
  teeth?: number[]
  /**
   * Tratamientos del presupuesto para vincular a la atención. Deben estar
   * aceptados (decision aceptado), pendientes o programados, del mismo
   * paciente/org y con presupuesto vigente. NO se marcan realizados al crear.
   */
  planItemIds?: string[]
}

export interface UpdateEncounterDraftPatch {
  branchId?: string | null
  reason?: string | null
  evolution?: string | null
  indications?: string | null
  /** Reemplaza el set completo de piezas (vacío = sin piezas). */
  teeth?: number[]
  /** Examen clínico de la atención (extraoral/intraoral/higieneOral); null lo limpia. */
  examination?: ExaminationInput | null
  /** Enfermedad actual: relato y tiempo de enfermedad. */
  presentIllness?: string | null
  illnessDuration?: string | null
  /** Signos vitales (claves de @odentia/clinical); null los limpia. */
  vitals?: Record<string, unknown> | null
  prognosis?: string | null
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
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  /** Ítem aceptado del plan: descripción y sitio se toman del ítem, sin cambios. */
  planItemId?: string | null
  /** Acto libre (sin servicio ni tratamiento): descripción obligatoria; nunca genera cargo. */
  description?: string | null
  /** Hallazgo del odontograma que trata un servicio directo; queda tratado al cerrar. */
  odontogramEntryId?: string | null
  /** Unidades del acto (1–99); el cargo es precio unitario × cantidad. */
  quantity?: number | null
}

export interface ListEncountersInput {
  cursor?: string
  limit?: number
  status?: string
}

export interface EncounterDetail {
  encounter: EncounterRow
  teeth: number[]
  /** Incluye los anulados (con motivo) para conservar la traza del borrador. */
  procedures: EncounterProcedureRow[]
  /** Diagnósticos de la atención (lista y código), anulados incluidos. */
  diagnoses: EncounterDiagnosisRow[]
  /** Notas de evolución sin código (los diagnósticos históricos viven en `diagnoses`). */
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
export const ENCOUNTER_STATUSES = ["borrador", "finalizada", "anulada"] as const

const TEXT_LIMITS = {
  reason: 2000,
  evolution: 10000,
  indications: 5000,
  procedureDescription: 2000,
  presentIllness: 4000,
  illnessDuration: 200,
  prognosis: 2000,
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
 * Borrador abierto y llevado por quien escribe. Otro profesional lee la
 * atención y, para continuarla, toma el relevo (queda registrado).
 */
export function assertOpenDraft(row: EncounterRow, actorUserId: string): void {
  if (row.status === "finalizada") throw conflict("FINALIZED", "La atención está finalizada")
  if (row.status === "anulada") throw conflict("VOIDED", "La atención está anulada")
  if (row.dentistUserId !== actorUserId) {
    throw conflict(
      "NOT_ATTENDING",
      "Otro profesional lleva esta atención: toma el relevo para continuarla",
    )
  }
}

/**
 * Igual que requireEncounter pero bloqueando la fila FOR UPDATE: serializa
 * edición concurrente vs finalización (update/finalize/procedure/addenda
 * verifican el estado solo después de tomar el lock).
 */
export async function lockEncounter(
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

/** Zona de la cita: la de su sede o, si la sede no tiene, la de la clínica. */
const appointmentTimeZone = sql<string>`coalesce(${branch.timezone}, ${orgProfile.timezone}, 'UTC')`

/** Una cita que todavía se puede atender (programada o confirmada). */
interface AttendableAppointment {
  id: string
  branchId: string
  startsAt: Date
  timeZone: string
}

/** Día local («2026-10-16») de un instante en una zona IANA. */
function localDateIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
}

/**
 * La cita de hoy del paciente que sigue en pie (programada o confirmada) y aún
 * no tiene atención; si hay varias, la que llegó y, si ninguna, la más cercana
 * a la hora (ADR 0032). «Hoy» es el día en la zona de la sede de la cita.
 */
async function todaysAppointment(
  tx: Db,
  orgId: string,
  patientId: string,
  now: Date,
): Promise<AttendableAppointment | null> {
  const at = now.toISOString()
  const [row] = await tx
    .select({
      id: appointment.id,
      branchId: appointment.branchId,
      startsAt: appointment.startsAt,
      timeZone: appointmentTimeZone,
    })
    .from(appointment)
    .innerJoin(
      branch,
      and(eq(branch.id, appointment.branchId), eq(branch.organizationId, appointment.organizationId)),
    )
    .leftJoin(orgProfile, eq(orgProfile.organizationId, appointment.organizationId))
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        // Ventana amplia para el índice; el día exacto lo decide la zona.
        sql`${appointment.startsAt} between ${at}::timestamptz - interval '36 hours' and ${at}::timestamptz + interval '36 hours'`,
        sql`(${appointment.startsAt} at time zone ${appointmentTimeZone})::date = (${at}::timestamptz at time zone ${appointmentTimeZone})::date`,
        sql`not exists (select 1 from ${encounter} e where e.organization_id = ${appointment.organizationId} and e.appointment_id = ${appointment.id} and e.status <> 'anulada')`,
      ),
    )
    .orderBy(
      sql`${appointment.arrivedAt} is null`,
      sql`abs(extract(epoch from (${appointment.startsAt} - ${at}::timestamptz)))`,
      asc(appointment.startsAt),
    )
    .limit(1)
    .for("update", { of: appointment })
  return row ?? null
}

/**
 * Atender una cita con un borrador abierto sin cita, empezado ese mismo día:
 * es la misma visita, así que el borrador se une a la cita (y toma su sede si
 * no tenía) en vez de abrir otra atención. Al cerrarlo, la cita queda atendida.
 * Si el borrador ya es de esta cita, se continúa. Otro caso no se toca.
 */
async function joinOpenDraft(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  visit: AttendableAppointment,
): Promise<EncounterRow | null> {
  const [draft] = await tx
    .select()
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "borrador"),
      ),
    )
    .for("update")
    .limit(1)
  if (!draft) return null
  if (draft.appointmentId === visit.id) return draft
  if (draft.appointmentId) return null
  if (localDateIn(draft.createdAt, visit.timeZone) !== localDateIn(visit.startsAt, visit.timeZone))
    return null
  const [joined] = await tx
    .update(encounter)
    .set({ appointmentId: visit.id, branchId: draft.branchId ?? visit.branchId, updatedAt: new Date() })
    .where(and(eq(encounter.id, draft.id), eq(encounter.organizationId, orgId)))
    .returning()
  if (!joined) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.appointment_joined", "encounter", joined.id, {
    patientId,
    appointmentId: visit.id,
  })
  return joined
}

/** Borrador abierto de un paciente, sin nada de la historia: cuál es y quién lo lleva. */
export async function getOpenEncounterRef(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ id: string; dentistUserId: string } | null> {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select({ id: encounter.id, dentistUserId: encounter.dentistUserId })
    .from(encounter)
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "borrador"),
      ),
    )
    .limit(1)
  return row ?? null
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
  // La cita que motiva la atención fija la sede; su estado debe admitir que se
  // atienda (no cancelada, sin inasistencia ni ya atendida).
  let fromAppointment: AttendableAppointment | null = null
  if (input.appointmentId) {
    const [row] = await tx
      .select({
        id: appointment.id,
        branchId: appointment.branchId,
        startsAt: appointment.startsAt,
        status: appointment.status,
        timeZone: appointmentTimeZone,
      })
      .from(appointment)
      .innerJoin(
        branch,
        and(eq(branch.id, appointment.branchId), eq(branch.organizationId, appointment.organizationId)),
      )
      .leftJoin(orgProfile, eq(orgProfile.organizationId, appointment.organizationId))
      .where(
        and(
          eq(appointment.id, input.appointmentId),
          eq(appointment.organizationId, orgId),
          eq(appointment.patientId, patientId),
        ),
      )
      .for("update", { of: appointment })
      .limit(1)
    if (!row) throw notFound("Cita")
    if (!["programada", "confirmada"].includes(row.status)) {
      throw conflict(
        "APPOINTMENT_NOT_ATTENDABLE",
        "Solo se atiende una cita programada o confirmada",
      )
    }
    fromAppointment = row
    const continued = await joinOpenDraft(tx, orgId, actorUserId, patientId, row)
    if (continued) {
      // La cita que se agendó para lo aceptado trae sus tratamientos (ADR 0034).
      await linkAppointmentItems(tx, orgId, patientId, row.id, continued.id)
      // Atender a quien nadie marcó: la llegada queda anotada a esta hora.
      await markArrivedOnAttend(tx, orgId, actorUserId, row.id)
      await notifyAppointmentChanged(tx, orgId)
      return continued
    }
  }
  // Sin cita indicada, la atención se une a la cita de hoy que sigue en pie:
  // así, al cerrarla, la cita queda atendida y sus controles hechos.
  const joinedToday = fromAppointment === null
  if (joinedToday) fromAppointment = await todaysAppointment(tx, orgId, patientId, new Date())
  let branchId: string | null = fromAppointment?.branchId ?? null
  // La sede de la cita de hoy manda sobre la que se eligió por defecto.
  if (input.branchId && !(joinedToday && fromAppointment)) {
    const [found] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    if (!found) throw branchNotFound()
    branchId = found.id
  }
  // Sin cita ni sede indicada, una clínica de una sola sede no tiene nada que
  // elegir: la atención nace en ella y lo que se cobre llega a su caja.
  if (!branchId) {
    const active = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
      .limit(2)
    if (active.length === 1) branchId = active[0]!.id
  }
  // Desde una cita no se pide el motivo al abrir: vale el que se escribió al
  // reservar o queda vacío, y el cierre lo exige (ADR 0032).
  let reason = cleanText(input.reason, "reason", TEXT_LIMITS.reason)
  if (!reason && fromAppointment) {
    const [booked] = await tx
      .select({ reason: appointment.reason })
      .from(appointment)
      .where(and(eq(appointment.id, fromAppointment.id), eq(appointment.organizationId, orgId)))
      .limit(1)
    reason = cleanText(booked?.reason, "reason", TEXT_LIMITS.reason)
  }
  if (!reason && !fromAppointment) throw validation("El motivo de la atención es obligatorio")
  // Profesional que atiende: por defecto quien abre (también desde la cita de
  // otro profesional: quien cubre a otro es quien escribe). Otro elegido debe
  // ser miembro con escritura clínica, nunca caja ni recepción.
  let dentistUserId = actorUserId
  if (input.dentistUserId && input.dentistUserId !== actorUserId) {
    const [membership] = await tx
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, input.dentistUserId)))
      .limit(1)
    if (!membership) throw notFound("Profesional")
    if (!canAccess(membership.role, "clinical.write"))
      throw validation(
        "Quien atiende debe poder escribir en la historia clínica: elige a un profesional clínico",
      )
    dentistUserId = input.dentistUserId
  }
  // pertenencia/estado/decisión ocurre antes de crear la atención para que un
  // planItemIds inválido no deje un borrador vacío (409/404/422, sin DRAFT_OPEN).
  // La cita que se agendó para lo aceptado trae sus tratamientos (ADR 0034).
  const fromCita = fromAppointment ? await appointmentItemsToLink(tx, orgId, patientId, fromAppointment.id) : []
  const planItemIds = [
    ...new Set(
      [...(input.planItemIds ?? []), ...fromCita].map((id) => id.trim()).filter((id) => id.length > 0),
    ),
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
        dentistUserId,
        appointmentId: fromAppointment?.id ?? null,
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
      appointmentId: fromAppointment?.id ?? null,
    })
    if (fromAppointment) {
      // La cita pasa a «En atención»; si nadie marcó la llegada, queda anotada ahora.
      await markArrivedOnAttend(tx, orgId, actorUserId, fromAppointment.id)
      await notifyAppointmentChanged(tx, orgId)
    }
    return row
  } catch (e) {
    if (!isUniqueViolation(e)) throw e
    if (uniqueConstraintOf(e).includes("encounter_patient_open_uidx")) {
      throw conflict("DRAFT_OPEN", "Ya hay una atención en curso para este paciente")
    }
    if (uniqueConstraintOf(e).includes("encounter_appointment_active_uidx")) {
      throw conflict("APPOINTMENT_HAS_ENCOUNTER", "Esta cita ya tiene una atención")
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
/**
 * Lo que se agendó con la cita (`appointment_plan_item`) y aún se puede traer a
 * su atención: aceptado en su presupuesto vigente y sin terminar. Lo que ya no
 * cumple (se completó o cambió de decisión) simplemente no se trae.
 */
async function appointmentItemsToLink(
  tx: Db,
  orgId: string,
  patientId: string,
  appointmentId: string,
): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from appointment_plan_item ap
      join treatment_plan_item i on i.id = ap.plan_item_id and i.organization_id = ap.organization_id
      join treatment_budget b on b.id = i.budget_id and b.organization_id = i.organization_id
    where ap.organization_id = ${orgId} and ap.patient_id = ${patientId} and ap.appointment_id = ${appointmentId}
      and i.decision_status = 'aceptado' and i.status in ('pendiente','programado','en_curso')
      and b.status in ('aceptado','parcial')
    order by i.sort_order, i.id`)
  return rows.map((row) => row.id)
}

/** Une a una atención ya abierta lo que se agendó con su cita. */
async function linkAppointmentItems(
  tx: Db,
  orgId: string,
  patientId: string,
  appointmentId: string,
  encounterId: string,
): Promise<void> {
  const ids = await appointmentItemsToLink(tx, orgId, patientId, appointmentId)
  if (ids.length === 0) return
  await tx
    .insert(encounterPlanItem)
    .values(ids.map((planItemId) => ({ organizationId: orgId, encounterId, planItemId })))
    .onConflictDoNothing({ target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId] })
}

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
    if (!["pendiente", "programado", "en_curso"].includes(plan.status)) {
      throw conflict(
        "ITEM_NOT_READY",
        "Solo se pueden vincular tratamientos pendientes, programados o en curso",
      )
    }
    if (!plan.budgetId) {
      throw conflict(
        "ITEM_NOT_ACCEPTED",
        "Solo se pueden vincular tratamientos aceptados en su presupuesto vigente",
      )
    }
    if (plan.decisionStatus !== "aceptado") {
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
  const [
    teethRows,
    procedures,
    notes,
    addenda,
    entries,
    documents,
    plannedItems,
    indicatedItems,
    diagnoses,
  ] = await Promise.all([
    tx
      .select({ toothNumber: encounterTooth.toothNumber })
      .from(encounterTooth)
      .where(
        and(eq(encounterTooth.encounterId, encounterId), eq(encounterTooth.organizationId, orgId)),
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
    tx
      .select()
      .from(encounterDiagnosis)
      .where(
        and(
          eq(encounterDiagnosis.encounterId, encounterId),
          eq(encounterDiagnosis.organizationId, orgId),
        ),
      )
      .orderBy(asc(encounterDiagnosis.createdAt), asc(encounterDiagnosis.id)),
  ])
  return {
    encounter: row,
    teeth: teethRows.map((t) => t.toothNumber),
    procedures,
    diagnoses,
    notes,
    odontogramEntries: entries,
    documents,
    addenda,
    plannedItems: plannedItems.map((link) => link.item),
    indicatedItems,
  }
}

/** Atención en la lista del paciente, con lo necesario para reconocerla. */
export type EncounterListItem = EncounterRow & {
  diagnosisCodes: string[]
  procedureCount: number
}

export async function listEncounters(
  tx: Db,
  orgId: string,
  patientId: string,
  input: ListEncountersInput,
): Promise<{ items: EncounterListItem[]; nextCursor: string | null }> {
  await requirePatient(tx, orgId, patientId)
  const limit = Math.min(Math.max(input.limit ?? PAGE_DEFAULT, 1), 100)
  if (
    input.status !== undefined &&
    !(ENCOUNTER_STATUSES as readonly string[]).includes(input.status)
  ) {
    throw validation("status debe ser 'borrador', 'finalizada' o 'anulada'")
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
  // Lo que la lista necesita para reconocer cada atención sin abrirla:
  // diagnósticos y actos vigentes (los anulados no cuentan).
  const ids = page.map((row) => row.id)
  const codes = ids.length
    ? await tx
        .select({ encounterId: encounterDiagnosis.encounterId, code: encounterDiagnosis.diagnosisCode })
        .from(encounterDiagnosis)
        .where(
          and(
            eq(encounterDiagnosis.organizationId, orgId),
            inArray(encounterDiagnosis.encounterId, ids),
            isNull(encounterDiagnosis.voidedAt),
          ),
        )
        .orderBy(asc(encounterDiagnosis.createdAt))
    : []
  const counts = ids.length
    ? await tx
        .select({ encounterId: encounterProcedure.encounterId, n: sql<number>`count(*)::int` })
        .from(encounterProcedure)
        .where(
          and(
            eq(encounterProcedure.organizationId, orgId),
            inArray(encounterProcedure.encounterId, ids),
            isNull(encounterProcedure.voidedAt),
          ),
        )
        .groupBy(encounterProcedure.encounterId)
    : []
  const procedureCount = new Map(counts.map((row) => [row.encounterId, row.n]))
  return {
    items: page.map((row) => ({
      ...row,
      diagnosisCodes: [
        ...new Set(codes.filter((c) => c.encounterId === row.id).map((c) => c.code)),
      ],
      procedureCount: procedureCount.get(row.id) ?? 0,
    })),
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
  assertOpenDraft(locked, actorUserId)
  const set: Partial<typeof encounter.$inferInsert> = {}
  if (patch.branchId !== undefined) {
    if (patch.branchId !== null) {
      const [found] = await tx
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.id, patch.branchId), eq(branch.organizationId, orgId)))
        .limit(1)
      if (!found) throw branchNotFound()
    }
    set.branchId = patch.branchId
  }
  if (patch.reason !== undefined) set.reason = cleanText(patch.reason, "reason", TEXT_LIMITS.reason)
  if (patch.evolution !== undefined)
    set.evolution = cleanText(patch.evolution, "evolution", TEXT_LIMITS.evolution)
  if (patch.indications !== undefined)
    set.indications = cleanText(patch.indications, "indications", TEXT_LIMITS.indications)
  const teeth = patch.teeth === undefined ? undefined : dedupeTeeth(patch.teeth)
  if (patch.examination !== undefined)
    set.examination = patch.examination === null ? null : assertExamination(patch.examination)
  for (const key of ["presentIllness", "illnessDuration", "prognosis"] as const) {
    if (patch[key] !== undefined) set[key] = cleanText(patch[key], key, TEXT_LIMITS[key])
  }
  if (patch.vitals !== undefined) {
    const parsed = parseVitals(patch.vitals)
    if (!parsed.ok) throw validation(parsed.error)
    set.vitals = parsed.value
  }
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

/**
 * Plan contenedor del tratamiento directo: el plan vigente más reciente del
 * paciente; si no tiene ninguno, nace aquí con título estándar.
 */
async function getOrCreateDirectPlan(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: treatmentPlan.id })
    .from(treatmentPlan)
    .where(
      and(
        eq(treatmentPlan.organizationId, orgId),
        eq(treatmentPlan.patientId, patientId),
        eq(treatmentPlan.isLegacy, false),
      ),
    )
    .orderBy(desc(treatmentPlan.createdAt), desc(treatmentPlan.id))
    .limit(1)
  if (existing) return existing.id
  const created = await createTreatmentPlan(tx, orgId, actorUserId, patientId, {
    title: "Plan de tratamiento",
    originEncounterId: encounterId,
  })
  return created.id
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
  assertOpenDraft(locked, actorUserId)
  const serviceIdParam = input.serviceId?.trim() ? input.serviceId.trim() : null
  const planItemIdParam = input.planItemId ?? null
  if (serviceIdParam && planItemIdParam) {
    throw validation(
      "Selecciona un servicio del catálogo o un tratamiento del presupuesto, no ambos",
    )
  }
  // Sin servicio ni tratamiento es un acto libre: descripción obligatoria y
  // jamás genera cargo (no hay tarifa fuera del catálogo).
  const freeDescription = cleanText(
    input.description,
    "description",
    TEXT_LIMITS.procedureDescription,
  )
  if (!serviceIdParam && !planItemIdParam && !freeDescription) {
    throw validation(
      "Selecciona un servicio del catálogo, un tratamiento del presupuesto o describe el acto libre",
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
  let planDiagnosisSystem: string | null = null
  let planCodings: Array<{ system: string; code: string; version: string; display: string }> = []
  let planPriceCents: number | null = null
  let planCurrency: string | null = null
  if (planItemIdParam) {
    const { item: plan, budget } = await lockPlanItemForExecution(
      tx,
      orgId,
      patientId,
      planItemIdParam,
    )
    if (["realizado", "cancelado", "reemplazado"].includes(plan.status)) {
      throw conflict("ITEM_CLOSED", "El tratamiento ya está cerrado")
    }
    if (plan.status === "suspendido")
      throw conflict("ITEM_NOT_READY", "El tratamiento está suspendido")
    // Solo presupuesto aceptado o servicio directo explícito: setPlanItemStatus
    // vuelve a exigirlo, pero aquí el error es específico antes de insertar.
    if (plan.decisionStatus !== "aceptado") {
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
    planDiagnosisSystem = plan.diagnosisSystem
    planTitle = plan.title
    planServiceId = plan.serviceId
    planCodings = [...plan.codings]
    // Snapshot económico: la ejecución cobra lo acordado en la indicación.
    planPriceCents = plan.priceCents
    planCurrency = plan.currency
  }
  let serviceId: string | null = null
  let description = ""
  let scope: string | null = planScope
  let toothNumber: number | null = planTooth
  let surfaces: string[] = [...planSurfaces]
  let quadrant: number | null = planQuadrant
  let arch: string | null = planArch
  let codings = [...planCodings]
  // El costo nace con el acto: snapshot del tarifario o de la indicación; el
  // acto libre no tiene precio y nunca genera cargo.
  let priceCents: number | null = planPriceCents
  let currency: string | null = planCurrency
  if (serviceIdParam) {
    const service = await requireServiceForIndication(tx, orgId, serviceIdParam)
    if (!service.scope) throw validation("La prestación no tiene un ámbito válido")
    const limits = service.scope === "surfaces" ? await surfaceLimits(tx, service) : undefined
    try {
      assertTreatmentSite(
        service.scope as "general" | "tooth" | "surfaces" | "quadrant" | "arch",
        {
          toothNumber: input.toothNumber,
          surfaces: input.surfaces,
          quadrant: input.quadrant,
          arch: input.arch,
        },
        limits,
      )
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
    // El costo viaja con el acto desde el tarifario vigente.
    priceCents = service.priceCents
    currency = service.currency
  } else if (planItemIdParam) {
    serviceId = planServiceId
    description = planTitle
  } else {
    // Acto libre: solo descripción; sin servicio no hay tarifa ni cargo.
    description = freeDescription ?? ""
    toothNumber = input.toothNumber ?? null
    surfaces = input.surfaces ? [...input.surfaces] : []
    quadrant = input.quadrant ?? null
    arch = input.arch ?? null
    priceCents = null
    currency = null
  }
  const quantity = input.quantity ?? 1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99)
    throw validation("La cantidad va de 1 a 99")
  if (planItemIdParam && quantity !== 1)
    throw validation("El tratamiento del plan se registra por sesión: la cantidad es 1")
  // El cargo nace del acto: precio unitario × cantidad.
  if (priceCents !== null) priceCents *= quantity
  if (!description)
    throw validation("description es obligatoria (o selecciona un servicio del catálogo)")
  if (description.length > TEXT_LIMITS.procedureDescription) {
    throw validation(`description supera ${TEXT_LIMITS.procedureDescription} caracteres`)
  }
  if (!serviceIdParam && !planItemIdParam && toothNumber !== null) assertFdi(toothNumber)
  // Tratamiento directo (un solo gesto): ejecutar un servicio sin indicación
  // previa crea la indicación implícita en el plan vigente, ya realizada y
  // aceptada en la misma atención.
  let directPlanItemId: string | null = null
  if (serviceIdParam) {
    const planId = await getOrCreateDirectPlan(tx, orgId, actorUserId, patientId, encounterId)
    const indicated = await addPlanItem(tx, orgId, actorUserId, patientId, {
      serviceId: serviceIdParam,
      planId,
      sourceEncounterId: encounterId,
      toothNumber,
      surfaces,
      quadrant,
      arch,
      diagnosisCode: input.diagnosisCode ?? null,
      diagnosisSystem: input.diagnosisSystem ?? null,
      odontogramEntryId: input.odontogramEntryId ?? null,
    })
    directPlanItemId = indicated.id
    if (quantity > 1 && indicated.priceCents !== null) {
      // La indicación implícita refleja lo realizado: todas las unidades.
      await tx
        .update(treatmentPlanItem)
        .set({ priceCents: indicated.priceCents * quantity, updatedAt: new Date() })
        .where(eq(treatmentPlanItem.id, indicated.id))
    }
  }
  // Sin indicar, el acto lleva el diagnóstico de su tratamiento, con su lista.
  const diagnosis =
    input.diagnosisCode === undefined
      ? { diagnosisSystem: planDiagnosis ? planDiagnosisSystem : null, diagnosisCode: planDiagnosis }
      : await resolveOptionalDiagnosisCode(tx, orgId, { code: input.diagnosisCode, system: input.diagnosisSystem })
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
      quantity,
      ...diagnosis,
      planItemId: input.planItemId ?? directPlanItemId,
      priceCents,
      currency,
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
    const [item] = await tx
      .select({ status: treatmentPlanItem.status })
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, input.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
        ),
      )
    if (item && (item.status === "pendiente" || item.status === "programado")) {
      await setPlanItemStatus(tx, orgId, actorUserId, patientId, input.planItemId, {
        status: "en_curso",
        encounterId,
      })
    }
  }
  if (directPlanItemId) {
    // Tratamiento directo: la indicación implícita queda enlazada a la sesión
    // y se cierra como aceptada + realizada en la misma transacción.
    await tx
      .insert(encounterPlanItem)
      .values({ organizationId: orgId, encounterId, planItemId: directPlanItemId })
      .onConflictDoNothing({
        target: [encounterPlanItem.encounterId, encounterPlanItem.planItemId],
      })
    const now = new Date()
    await tx
      .update(treatmentPlanItem)
      .set({
        status: "realizado",
        decisionStatus: "aceptado",
        decisionNote: "Tratamiento directo: indicado y ejecutado en la misma atención",
        decidedAt: now,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(treatmentPlanItem.id, directPlanItemId),
          eq(treatmentPlanItem.organizationId, orgId),
        ),
      )
    await audit(
      tx,
      orgId,
      actorUserId,
      "plan.item_direct_completed",
      "treatment_plan_item",
      directPlanItemId,
      {
        patientId,
        encounterId,
        procedureId: row.id,
      },
    )
    // Lo tratado queda dibujado: el servicio directo nace realizado.
    await drawTreatedFinding(tx, orgId, actorUserId, patientId, encounterId, {
      id: directPlanItemId,
      serviceId,
      toothNumber,
      surfaces,
      odontogramEntryId: input.odontogramEntryId ?? null,
    })
  }
  await audit(tx, orgId, actorUserId, "encounter.procedure_added", "encounter_procedure", row.id, {
    patientId,
    encounterId,
    planItemId: input.planItemId ?? null,
  })
  return row
}

/** Cargo omitido al cerrar: queda registrado para mostrarlo en el resumen. */
export interface SkippedCharge {
  procedureId: string
  reason: "covered" | "free_act" | "zero_price" | "sessions_complete"
}

/** Línea del diálogo de cierre: qué quedó por cobrar y qué no. */
export interface FinalizeBillingLine {
  procedureId: string
  description: string
  amountCents: number | null
  currency: string | null
  status: "charged" | "skipped"
  reason: SkippedCharge["reason"] | null
}

export interface FinalizeEncounterResult {
  encounter: EncounterRow
  /** Cargos generados automáticamente desde los actos con servicio. */
  charges: Array<typeof patientCharge.$inferSelect>
  skippedCharges: SkippedCharge[]
  /** Resumen para el diálogo de cierre y caja (con moneda del primer cargo). */
  billing: { chargedCents: number; currency: string | null; lines: FinalizeBillingLine[] }
  /**
   * El presupuesto que quedó armado con lo indicado en esta atención (decisión
   * 12): el cierre pregunta «¿Enviárselo ahora?». Nulo si no entró nada.
   */
  budget: AssembledBudget | null
  /**
   * El odontograma que firmó este cierre (solo en clínicas de Perú, si la
   * atención cambió el gráfico), con su momento deducido.
   */
  odontogram: Pick<OdontogramAssessmentRow, "id" | "purpose"> | null
  /**
   * Los materiales que descontó el cierre (ADR 0067), con lo que quedó como
   * faltante. Null si la atención no tiene sede o no usó nada configurado.
   */
  materials: DiscountedMaterials | null
}

/** Aviso en vivo (`org_events`): solo `{ orgId, kind, at }`, sin datos clínicos. */
async function notifyClose(tx: Db, orgId: string, kind: string): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify({ orgId, kind, at: new Date().toISOString() })})`)
}

/**
 * Línea aceptada vigente de un tratamiento (presupuesto aceptado/parcial con
 * decisión aceptada): trae precio final acordado y modo de cobro congelados.
 */
async function acceptedBudgetLine(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemId: string,
): Promise<typeof treatmentBudgetItem.$inferSelect | null> {
  const [found] = await tx
    .select({ line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, eq(treatmentBudget.id, treatmentBudgetItem.budgetId))
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentBudgetItem.planItemId, planItemId),
        eq(treatmentBudgetItem.decision, "aceptado"),
        sql`${treatmentBudget.status} IN ('aceptado','parcial')`,
      ),
    )
    .orderBy(desc(treatmentBudget.decidedAt), desc(treatmentBudget.createdAt))
    .limit(1)
  if (found) return found.line
  // Mientras una revisión ya entregada espera respuesta, lo último aceptado
  // sigue valiendo: lo que se atienda en ese intervalo se cobra a lo acordado,
  // no a tarifa. Deja de valer cuando la revisión se decide.
  const [previous] = await tx
    .select({ line: treatmentBudgetItem })
    .from(treatmentBudgetItem)
    .innerJoin(treatmentBudget, eq(treatmentBudget.id, treatmentBudgetItem.budgetId))
    .where(
      and(
        eq(treatmentBudgetItem.organizationId, orgId),
        eq(treatmentBudgetItem.patientId, patientId),
        eq(treatmentBudgetItem.planItemId, planItemId),
        eq(treatmentBudgetItem.decision, "aceptado"),
        eq(treatmentBudget.status, "sustituido"),
        sql`exists (
          select 1 from "treatment_budget" next
          where next."supersedes_budget_id" = ${treatmentBudget.id}
            and next."organization_id" = ${orgId}
            and next."status" in ('presentado','pospuesto')
        )`,
      ),
    )
    .orderBy(desc(treatmentBudget.decidedAt), desc(treatmentBudget.createdAt))
    .limit(1)
  return previous?.line ?? null
}

/** Lo que falta para cerrar una atención, en el orden de la historia clínica. */
export type ClosingRequirement = "reason" | "diagnosis" | "evolution" | "signature"

export interface ClosingCheck {
  ready: boolean
  missing: ClosingRequirement[]
  /**
   * Consentimientos que pide la atención y no están firmados (pendientes, sin
   * preparar o sin publicar). No bloquean (decisión 3): cerrar sin ellos pide
   * decir por qué.
   */
  consents: ConsentNeed[]
  /**
   * En clínicas de Perú, el odontograma que este cierre firmará (su momento y
   * lo que cambió), o null si la atención no cambió el gráfico o la clínica no
   * firma odontogramas.
   */
  odontogram: ClosingOdontogram | null
  /**
   * El periodontograma de la atención, que queda fijo al firmarla (decisión 6),
   * o null si no tiene. A medias no bloquea: se firma como parcial.
   */
  periodontal: ClosingPeriodontal | null
  /**
   * Lo que se descontará al firmar (materiales de sus servicios × cantidad),
   * por producto y con la sede. Informa, no pide confirmar; null si la
   * atención no tiene sede o no hay nada que descontar.
   */
  materials: ClosingMaterials | null
}

export interface ClosingPeriodontal {
  /** Piezas naturales e implantes que se sondean. */
  teeth: number
  implants: number
  /** Lo que falta sondear en palabras («abajo por fuera, de la 43 a la 47»); null si está completo. */
  pending: string | null
}

/** El periodontograma de la atención para el cierre: cuántas piezas y qué falta. */
async function closingPeriodontalOf(tx: Db, orgId: string, encounterId: string): Promise<ClosingPeriodontal | null> {
  const [chart] = await tx
    .select({ id: periodontalChart.id, expectedTeeth: periodontalChart.expectedTeeth, implantTeeth: periodontalChart.implantTeeth })
    .from(periodontalChart)
    .where(and(eq(periodontalChart.organizationId, orgId), eq(periodontalChart.encounterId, encounterId)))
    .limit(1)
  if (!chart) return null
  const rows = await tx
    .select({
      toothNumber: periodontalTooth.toothNumber,
      skipped: periodontalTooth.skipped,
      probingDepth: periodontalTooth.probingDepth,
    })
    .from(periodontalTooth)
    .where(and(eq(periodontalTooth.organizationId, orgId), eq(periodontalTooth.chartId, chart.id)))
  const stored = new Map(rows.map((row) => [row.toothNumber, row]))
  const teeth: PeriodontalToothRecord[] = chart.expectedTeeth.map((tooth) => ({
    ...emptyPeriodontalTooth(tooth),
    ...(stored.get(tooth) ?? {}),
  }))
  return {
    teeth: chart.expectedTeeth.length - chart.implantTeeth.length,
    implants: chart.implantTeeth.length,
    pending: pendingProbingWords(teeth, chart.expectedTeeth),
  }
}

const CLOSING_MESSAGES: Record<ClosingRequirement, string> = {
  reason: "el motivo de consulta",
  diagnosis: "al menos un diagnóstico con su tipo (presuntivo basta)",
  evolution: "la evolución",
  signature: "tu colegiatura en el perfil profesional",
}

/**
 * Mínimo para cerrar (ADR 0003 y 0041): motivo, un diagnóstico de la lista con
 * su tipo («Presuntivo» basta),
 * evolución y firma con colegiatura. Funciones vitales y pronóstico quedan
 * opcionales (los exámenes auxiliares son órdenes de la atención): documentar
 * una consulta no obliga a inventar.
 */
export async function checkEncounterClosing(
  tx: Db,
  orgId: string,
  actorUserId: string,
  row: EncounterRow,
): Promise<ClosingCheck> {
  const missing: ClosingRequirement[] = []
  if (!row.reason?.trim()) missing.push("reason")
  const [diagnosis] = await tx
    .select({ id: encounterDiagnosis.id })
    .from(encounterDiagnosis)
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, row.id),
        isNull(encounterDiagnosis.voidedAt),
        isNotNull(encounterDiagnosis.diagnosisType),
      ),
    )
    .limit(1)
  if (!diagnosis) missing.push("diagnosis")
  if (!row.evolution?.trim()) missing.push("evolution")
  try {
    await requireProfessionalSignature(tx, orgId, actorUserId)
  } catch (e) {
    // Sin perfil completo, o quien atiende ya no es miembro: no puede firmar.
    if (!(e instanceof ServiceError) || (e.code !== "PROFILE_INCOMPLETE" && e.status !== 404))
      throw e
    missing.push("signature")
  }
  const consents = (await getEncounterConsentNeeds(tx, orgId, row.patientId, row.id)).filter(
    (need) => need.status !== "firmado",
  )
  const odontogram = await closingOdontogramOf(tx, orgId, row.patientId, row.id)
  const periodontal = await closingPeriodontalOf(tx, orgId, row.id)
  const materials = await closingMaterialsOf(tx, orgId, row)
  return { ready: missing.length === 0, missing, consents, odontogram, periodontal, materials }
}

export async function getEncounterClosing(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<ClosingCheck> {
  const row = await requireEncounter(tx, orgId, patientId, encounterId)
  return checkEncounterClosing(tx, orgId, actorUserId, row)
}

export interface FinalizeEncounterInput {
  /** Hora de fin declarada (ISO); por defecto, ahora. */
  endedAt?: string | null
  /**
   * «Seguir sin él»: por qué se cierra con un consentimiento sin firmar. Se
   * pide solo si falta alguno; queda en la atención como el resto.
   */
  consentSkipReason?: string | null
}

export async function finalizeEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: FinalizeEncounterInput = {},
): Promise<FinalizeEncounterResult> {
  await requirePatient(tx, orgId, patientId)
  // El cierre participa del mismo bloqueo que los cargos manuales y de
  // presupuesto: consultar cobertura y generar cargos es una sola operación.
  await tx
    .select({ id: patient.id })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .for("update")
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "finalizada") throw conflict("FINALIZED", "La atención ya está finalizada")
  assertOpenDraft(locked, actorUserId)
  // Una consulta puede terminar sin prestaciones: documentarla no obliga a
  // inventar procedimientos, tratamientos ni cargos; sí exige el mínimo clínico.
  const closing = await checkEncounterClosing(tx, orgId, actorUserId, locked)
  if (!closing.ready) {
    throw new ServiceError(
      "CLOSING_INCOMPLETE",
      409,
      `Para cerrar la atención registra ${closing.missing.map((m) => CLOSING_MESSAGES[m]).join(", ")}`,
    )
  }
  // Un consentimiento sin firmar avisa sin bloquear: se sigue diciendo por qué.
  let consentSkipReason: string | null = null
  if (closing.consents.length > 0) {
    const reason = input.consentSkipReason?.trim() ?? ""
    if (!reason) {
      throw new ServiceError(
        "CONSENT_UNSIGNED",
        409,
        `Falta el consentimiento de ${closing.consents.map((need) => `«${need.title}»`).join(", ")}: fírmalo ahora o sigue sin él diciendo por qué`,
      )
    }
    if (reason.length > 2000) throw validation("El motivo admite hasta 2000 caracteres")
    consentSkipReason = reason
  }
  const signature = await requireProfessionalSignature(tx, orgId, actorUserId)
  const now = new Date()
  let endedAt = now
  if (input.endedAt) {
    endedAt = new Date(input.endedAt)
    if (Number.isNaN(endedAt.getTime())) throw validation("endedAt debe ser una fecha ISO válida")
    if (endedAt < locked.startedAt)
      throw validation("La hora de fin no puede ser anterior al inicio de la atención")
    if (endedAt.getTime() > now.getTime() + 5 * 60_000)
      throw validation("La hora de fin no puede estar en el futuro")
  }
  const procedures = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.encounterId, encounterId),
        eq(encounterProcedure.organizationId, orgId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
  const [row] = await tx
    .update(encounter)
    .set({
      status: "finalizada",
      finalizedAt: now,
      finalizedBy: actorUserId,
      endedAt,
      signerName: signature.name,
      signerTitle: signature.title,
      signerRegistration: signature.registration,
      consentSkipReason,
      updatedAt: now,
    })
    .where(eq(encounter.id, encounterId))
    .returning()
  if (!row) throw notFound("Atención")
  await resolveTreatedFindings(tx, orgId, actorUserId, patientId, encounterId, now)
  // En Perú, la atención que cambió el gráfico firma el odontograma con el
  // mismo perfil y en el mismo paso (NTS 188, 5.3 y 5.10).
  const odontogram = await signClosingOdontogram(tx, orgId, actorUserId, patientId, encounterId, signature)
  if (row.appointmentId) await closeAppointment(tx, orgId, actorUserId, patientId, row, now)
  // Con lo dictado confirmado, el Asistente clínico ordenó esta consulta (ADR 0031).
  await countConsultationAction(tx, orgId, { patientId, encounterId, at: now })
  // Los cargos caen solos al finalizar, con el precio final acordado:
  // - Modo `treatment`: un cargo por tratamiento (anti-doble-cobro por cargo
  //   activo del mismo tratamiento; el importe respeta el total acordado).
  // - Modo `session`: un cargo por visita atendida al precio de sesión
  //   acordado, con tope de visitas previstas y sin duplicar el acto
  //   (anti-doble-cargo por procedimiento). La deuda nace por visita.
  const charges: FinalizeEncounterResult["charges"] = []
  const skippedCharges: SkippedCharge[] = []
  const billingLines: FinalizeBillingLine[] = []
  const skip = (
    proc: { id: string; description: string; currency: string | null },
    reason: SkippedCharge["reason"],
  ): void => {
    skippedCharges.push({ procedureId: proc.id, reason })
    billingLines.push({
      procedureId: proc.id,
      description: proc.description,
      amountCents: null,
      currency: proc.currency,
      status: "skipped",
      reason,
    })
  }
  for (const proc of procedures) {
    if (!proc.serviceId) {
      skip(proc, "free_act")
      continue
    }
    const line = proc.planItemId
      ? await acceptedBudgetLine(tx, orgId, patientId, proc.planItemId)
      : null
    // Lo acordado en el presupuesto manda; sin presupuesto aceptado decide el
    // servicio: un control por sesión se cobra en cada visita igualmente.
    const serviceMode = line ? null : (await readBillingModes(tx, orgId, [proc.serviceId]))[proc.serviceId]
    const sessionMode = (line?.billingMode ?? serviceMode) === "session"
    // La promoción acordada viaja congelada: no se revalida su vigencia.
    const frozenPromotion =
      line?.promotionId && line.promotionName
        ? { id: line.promotionId, name: line.promotionName }
        : undefined
    if (sessionMode && proc.planItemId) {
      const [duplicate] = await tx
        .select({ id: patientCharge.id })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.encounterProcedureId, proc.id),
            isNull(patientCharge.voidedAt),
          ),
        )
        .limit(1)
      if (duplicate) {
        skip(proc, "covered")
        continue
      }
      const visits = await tx
        .select({ id: patientCharge.id })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.planItemId, proc.planItemId),
            isNotNull(patientCharge.encounterProcedureId),
            isNull(patientCharge.voidedAt),
          ),
        )
      const [planItem] = proc.planItemId
        ? await tx
            .select({ plannedSessions: treatmentPlanItem.plannedSessions })
            .from(treatmentPlanItem)
            .where(
              and(
                eq(treatmentPlanItem.id, proc.planItemId),
                eq(treatmentPlanItem.organizationId, orgId),
              ),
            )
            .limit(1)
        : []
      // El tope son las visitas previstas. Si nadie las fijó no hay tope:
      // se cobra cada visita atendida, no solo la primera.
      const cap = line?.sessionsPlanned ?? planItem?.plannedSessions ?? null
      if (cap !== null && visits.length >= cap) {
        skip(proc, "sessions_complete")
        continue
      }
      const amount = line?.priceCents ?? proc.priceCents
      if (amount === null || amount <= 0) {
        skip(proc, "zero_price")
        continue
      }
      const charge = await createCharge(tx, orgId, actorUserId, patientId, {
        encounterProcedureId: proc.id,
        amountCents: amount,
        frozenPromotion,
      })
      charges.push(charge)
      billingLines.push({
        procedureId: proc.id,
        description: charge.description,
        amountCents: charge.amountCents,
        currency: charge.currency,
        status: "charged",
        reason: null,
      })
      continue
    }
    if (proc.priceCents === null || proc.priceCents <= 0) {
      skip(proc, "zero_price")
      continue
    }
    if (proc.planItemId) {
      const active = await tx
        .select({ amountCents: patientCharge.amountCents })
        .from(patientCharge)
        .where(
          and(
            eq(patientCharge.organizationId, orgId),
            eq(patientCharge.patientId, patientId),
            eq(patientCharge.planItemId, proc.planItemId),
            isNull(patientCharge.voidedAt),
          ),
        )
      const agreed = line?.priceCents ?? proc.priceCents
      const charged = active.reduce((sum, c) => sum + c.amountCents, 0)
      const remaining = agreed - charged
      if (remaining <= 0) {
        skip(proc, "covered")
        continue
      }
      // Por tratamiento se cobra lo acordado completo en la primera
      // atención, también cuando lo acordado supera la tarifa del acto.
      const amount = remaining
      const charge = await createCharge(tx, orgId, actorUserId, patientId, {
        encounterProcedureId: proc.id,
        amountCents: amount,
        frozenPromotion,
      })
      charges.push(charge)
      billingLines.push({
        procedureId: proc.id,
        description: charge.description,
        amountCents: charge.amountCents,
        currency: charge.currency,
        status: "charged",
        reason: null,
      })
      continue
    }
    const [duplicate] = await tx
      .select({ id: patientCharge.id })
      .from(patientCharge)
      .where(
        and(
          eq(patientCharge.organizationId, orgId),
          eq(patientCharge.patientId, patientId),
          eq(patientCharge.encounterProcedureId, proc.id),
          isNull(patientCharge.voidedAt),
        ),
      )
      .limit(1)
    if (duplicate) {
      skip(proc, "covered")
      continue
    }
    const charge = await createCharge(tx, orgId, actorUserId, patientId, {
      encounterProcedureId: proc.id,
    })
    charges.push(charge)
    billingLines.push({
      procedureId: proc.id,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
      status: "charged",
      reason: null,
    })
  }
  const chargedCents = billingLines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0)
  // Los materiales de sus servicios salen solos de la sede de la atención
  // (ADR 0067): lo que no alcanza queda como faltante y nunca bloquea el cierre.
  const materials = await discountEncounterMaterials(tx, orgId, actorUserId, row)
  await audit(tx, orgId, actorUserId, "encounter.finalized", "encounter", encounterId, {
    patientId,
    charges: charges.length,
    skippedCharges: skippedCharges.length,
    // Cuántos consentimientos quedaron sin firmar; el motivo vive en la atención.
    consentsUnsigned: closing.consents.length,
    materials: materials?.items.length ?? 0,
  })
  // Al firmar queda armado el presupuesto con lo indicado aquí: crece el
  // borrador de la persona o nace uno. No se envía solo.
  const budget = await assembleEncounterBudget(tx, orgId, actorUserId, patientId, encounterId)
  await notifyClose(tx, orgId, "encounter.finalized")
  await notifyClose(tx, orgId, "patient.account.updated")
  return {
    encounter: row,
    charges,
    skippedCharges,
    budget,
    odontogram: odontogram ? { id: odontogram.id, purpose: odontogram.purpose } : null,
    materials,
    billing: {
      chargedCents,
      currency: charges[0]?.currency ?? procedures[0]?.currency ?? null,
      lines: billingLines,
    },
  }
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

function cleanReason(reason: string | null | undefined): string {
  const text = reason?.trim() ?? ""
  if (text.length < 1 || text.length > 2000)
    throw validation("El motivo debe tener 1–2000 caracteres")
  return text
}

/**
 * Hallazgos tratados al cerrar: cada indicación realizada en la atención que
 * nació de un hallazgo deja ese hallazgo como tratado (sigue en la historia,
 * pero ya no es un problema por tratar).
 */
async function resolveTreatedFindings(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  at: Date,
): Promise<void> {
  const items = await tx
    .select({ id: treatmentPlanItem.id, entryId: treatmentPlanItem.odontogramEntryId })
    .from(encounterPlanItem)
    .innerJoin(treatmentPlanItem, eq(treatmentPlanItem.id, encounterPlanItem.planItemId))
    .where(
      and(
        eq(encounterPlanItem.organizationId, orgId),
        eq(encounterPlanItem.encounterId, encounterId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.status, "realizado"),
        isNotNull(treatmentPlanItem.odontogramEntryId),
      ),
    )
  for (const item of items) {
    if (!item.entryId) continue
    const [resolved] = await tx
      .update(odontogramEntry)
      .set({ resolvedAt: at, resolvedBy: actorUserId, resolvedByPlanItemId: item.id })
      .where(
        and(
          eq(odontogramEntry.id, item.entryId),
          eq(odontogramEntry.organizationId, orgId),
          eq(odontogramEntry.patientId, patientId),
          isNull(odontogramEntry.resolvedAt),
          isNull(odontogramEntry.voidedAt),
        ),
      )
      .returning({ id: odontogramEntry.id })
    if (resolved) {
      await audit(
        tx,
        orgId,
        actorUserId,
        "odontogram.entry_resolved",
        "odontogram_entry",
        resolved.id,
        {
          patientId,
          encounterId,
          planItemId: item.id,
        },
      )
    }
  }
}

/**
 * La cita atendida se cierra con la atención: los controles reservados en ella
 * quedan realizados con esta atención y la cita pasa a «atendida».
 */
async function closeAppointment(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  row: EncounterRow,
  at: Date,
): Promise<void> {
  if (!row.appointmentId) return
  const completed = await tx
    .update(clinicalFollowUp)
    .set({
      status: "realizado",
      completedEncounterId: row.id,
      completedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        eq(clinicalFollowUp.appointmentId, row.appointmentId),
        eq(clinicalFollowUp.status, "programado"),
      ),
    )
    .returning({ id: clinicalFollowUp.id })
  for (const followUp of completed) {
    await audit(tx, orgId, actorUserId, "follow_up.completed", "clinical_follow_up", followUp.id, {
      patientId,
      encounterId: row.id,
    })
  }
  await setAppointmentStatus(tx, orgId, actorUserId, row.appointmentId, "atendida")
}

/**
 * Anula un procedimiento del borrador sin borrarlo: no genera cargo ni cuenta
 * como sesión. La indicación vuelve a su carril real: un tratamiento directo
 * se cancela; uno planificado queda en curso si le quedan sesiones o vuelve a
 * programado si no.
 */
async function voidProcedureRow(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  proc: EncounterProcedureRow,
  reason: string,
  at: Date,
): Promise<EncounterProcedureRow> {
  const [voided] = await tx
    .update(encounterProcedure)
    .set({ voidedAt: at, voidedBy: actorUserId, voidReason: reason })
    .where(
      and(
        eq(encounterProcedure.id, proc.id),
        eq(encounterProcedure.organizationId, orgId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .returning()
  if (!voided) throw conflict("ALREADY_VOIDED", "El procedimiento ya está anulado")
  if (proc.planItemId) {
    const [item] = await tx
      .select()
      .from(treatmentPlanItem)
      .where(
        and(
          eq(treatmentPlanItem.id, proc.planItemId),
          eq(treatmentPlanItem.organizationId, orgId),
          eq(treatmentPlanItem.patientId, patientId),
        ),
      )
      .for("update")
      .limit(1)
    if (item) {
      const direct =
        item.sourceEncounterId === encounterId &&
        (item.decisionNote ?? "").startsWith("Tratamiento directo")
      if (direct) {
        await tx
          .update(treatmentPlanItem)
          .set({
            status: "cancelado",
            statusReason: `Procedimiento anulado: ${reason}`,
            completedAt: null,
            updatedAt: at,
          })
          .where(eq(treatmentPlanItem.id, item.id))
      } else if (item.status === "en_curso" || item.status === "realizado") {
        const [remaining] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(encounterProcedure)
          .where(
            and(
              eq(encounterProcedure.organizationId, orgId),
              eq(encounterProcedure.planItemId, item.id),
              isNull(encounterProcedure.voidedAt),
            ),
          )
        const sessions = remaining?.n ?? 0
        await tx
          .update(treatmentPlanItem)
          .set({
            status: sessions > 0 ? "en_curso" : "programado",
            completedAt: null,
            ...(sessions > 0 ? {} : { startedAt: null }),
            updatedAt: at,
          })
          .where(eq(treatmentPlanItem.id, item.id))
      }
      // Ya no está realizado: lo que dejó dibujado en esta atención se anula.
      if (direct || item.status === "realizado")
        await voidLeftFindings(tx, orgId, actorUserId, patientId, encounterId, item.id, reason, at)
    }
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "encounter.procedure_voided",
    "encounter_procedure",
    proc.id,
    {
      patientId,
      encounterId,
      planItemId: proc.planItemId,
      reason,
    },
  )
  return voided
}

export async function voidEncounterProcedure(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  procedureId: string,
  input: { reason: string },
): Promise<EncounterProcedureRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  assertOpenDraft(locked, actorUserId)
  const reason = cleanReason(input.reason)
  const [proc] = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.id, procedureId),
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
      ),
    )
    .limit(1)
  if (!proc) throw notFound("Procedimiento")
  if (proc.voidedAt) throw conflict("ALREADY_VOIDED", "El procedimiento ya está anulado")
  return voidProcedureRow(tx, orgId, actorUserId, patientId, encounterId, proc, reason, new Date())
}

/**
 * Anula el borrador completo (ADR 0002): queda en la historia como «anulada»
 * con quién, cuándo y por qué; no genera cargos ni controles. Anula con el
 * mismo motivo sus procedimientos, diagnósticos, hallazgos, recetas y
 * controles; la cita conserva su estado y puede volver a atenderse.
 */
export async function voidEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
  input: { reason: string },
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status === "anulada") throw conflict("ALREADY_VOIDED", "La atención ya está anulada")
  assertOpenDraft(locked, actorUserId)
  const reason = cleanReason(input.reason)
  const cascade = `Atención anulada: ${reason}`.slice(0, 2000)
  // Lo indicado aquí que ya entró a una propuesta no desaparece en silencio.
  const [budgeted] = await tx
    .select({ id: treatmentPlanItem.id })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        isNotNull(treatmentPlanItem.budgetId),
        inArray(treatmentPlanItem.status, ["pendiente", "programado", "en_curso", "suspendido"]),
      ),
    )
    .limit(1)
  if (budgeted) {
    throw conflict(
      "INDICATIONS_BUDGETED",
      "Esta atención indicó tratamientos que ya están en una propuesta: cancélala o revísala antes de anular",
    )
  }
  const at = new Date()
  const procedures = await tx
    .select()
    .from(encounterProcedure)
    .where(
      and(
        eq(encounterProcedure.organizationId, orgId),
        eq(encounterProcedure.encounterId, encounterId),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .orderBy(asc(encounterProcedure.createdAt), asc(encounterProcedure.id))
  for (const proc of procedures) {
    await voidProcedureRow(tx, orgId, actorUserId, patientId, encounterId, proc, cascade, at)
  }
  await tx
    .update(treatmentPlanItem)
    .set({ status: "cancelado", statusReason: cascade, updatedAt: at })
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.sourceEncounterId, encounterId),
        inArray(treatmentPlanItem.status, ["pendiente", "programado", "suspendido"]),
      ),
    )
  await tx
    .update(encounterDiagnosis)
    .set({ voidedAt: at, voidedBy: actorUserId, voidReason: cascade, updatedAt: at })
    .where(
      and(
        eq(encounterDiagnosis.organizationId, orgId),
        eq(encounterDiagnosis.encounterId, encounterId),
        isNull(encounterDiagnosis.voidedAt),
      ),
    )
  await tx
    .update(odontogramEntry)
    .set({
      status: "voided",
      voidedAt: at,
      voidedBy: actorUserId,
      voidReason: cascade,
      updatedAt: at,
    })
    .where(
      and(
        eq(odontogramEntry.organizationId, orgId),
        eq(odontogramEntry.patientId, patientId),
        eq(odontogramEntry.encounterId, encounterId),
        isNull(odontogramEntry.voidedAt),
        ne(odontogramEntry.status, "voided"),
      ),
    )
  await tx
    .update(prescription)
    .set({
      status: "anulada",
      cancelledAt: at,
      cancelledBy: actorUserId,
      cancelReason: cascade,
      updatedAt: at,
    })
    .where(
      and(
        eq(prescription.organizationId, orgId),
        eq(prescription.patientId, patientId),
        eq(prescription.encounterId, encounterId),
        eq(prescription.status, "emitida"),
      ),
    )
  await tx
    .update(clinicalFollowUp)
    .set({ status: "cancelado", cancelledReason: cascade, cancelledAt: at, updatedAt: at })
    .where(
      and(
        eq(clinicalFollowUp.organizationId, orgId),
        eq(clinicalFollowUp.patientId, patientId),
        eq(clinicalFollowUp.originEncounterId, encounterId),
        inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
      ),
    )
  const [row] = await tx
    .update(encounter)
    .set({
      status: "anulada",
      voidedAt: at,
      voidedBy: actorUserId,
      voidReason: reason,
      updatedAt: at,
    })
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.voided", "encounter", encounterId, {
    patientId,
    reason,
    procedures: procedures.length,
  })
  // La Agenda deja de decir «En atención»: la cita vuelve a poder atenderse y
  // su llegada se conserva (ADR 0032).
  if (row.appointmentId) await notifyAppointmentChanged(tx, orgId)
  return row
}

/**
 * Relevo: otro profesional continúa el borrador. Queda registrado quién lo
 * llevaba; desde ahí, quien toma el relevo es quien firma.
 */
export async function takeOverEncounter(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  encounterId: string,
): Promise<EncounterRow> {
  await requirePatient(tx, orgId, patientId)
  const locked = await lockEncounter(tx, orgId, patientId, encounterId)
  if (locked.status !== "borrador") {
    throw conflict(
      locked.status === "anulada" ? "VOIDED" : "FINALIZED",
      "Solo se toma el relevo de una atención en curso",
    )
  }
  if (locked.dentistUserId === actorUserId) return locked
  const [row] = await tx
    .update(encounter)
    .set({ dentistUserId: actorUserId, updatedAt: new Date() })
    .where(and(eq(encounter.id, encounterId), eq(encounter.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Atención")
  await audit(tx, orgId, actorUserId, "encounter.taken_over", "encounter", encounterId, {
    patientId,
    from: locked.dentistUserId,
  })
  return row
}
