/**
 * Recorrido clínico-económico del paciente: tipos de vista y llamadas a la API.
 *
 * Un tratamiento se sigue desde su origen hasta el cobro: qué se observó, qué se
 * indicó, qué se propuso, qué se aceptó, qué se ejecutó, qué falta y qué se pagó.
 * Aquí viven controles, recetas, cuenta y responsables; la API es la fuente de
 * verdad y estas funciones solo traducen su contrato a la UI.
 */

import type { FollowUpStatus, ResponsibilityKind } from "@odentia/clinical"
import type { AppointmentStatus } from "./agenda"
import { ApiError, apiFetch } from "./api"
import type { BudgetLine, BudgetWithTotals } from "./budgets"
import type { Encounter, PatientDocument, PlanItem, ProcedureItem, SiteFinding, TreatmentNextAction, TreatmentPlan } from "./patients"
import { dayMinutesIn, minutesToInstant, zonedDateOf } from "@odentia/ui-patterns"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

const base = (patientId: string) => `/api/patients/${patientId}`

/** Mensaje de error en español para cualquier mutación clínica. */
export function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/**
 * Fecha corta, en el formato y la zona de la clínica (no la del navegador);
 * "—" cuando el valor falta o es inválido. Una fecha sin hora («2026-10-22»)
 * se dice tal cual, sin moverla de día.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const calendarDay = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(calendarDay ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString(activeOrgLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: calendarDay ? "UTC" : activeOrgTimeZone(),
  })
}

/** Fecha y hora cortas, en el formato y la zona de la clínica, para citas y controles. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString(activeOrgLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: activeOrgTimeZone(),
  })
}

/**
 * Valor de un campo de fecha y hora («2026-10-22T10:00») para un instante, en
 * la zona de la clínica: desde otro país se ve la misma hora que en la clínica.
 */
export function clinicDateTimeValue(iso: string): string {
  const timeZone = activeOrgTimeZone()
  const minutes = dayMinutesIn(iso, timeZone)
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
  const mm = String(minutes % 60).padStart(2, "0")
  return `${zonedDateOf(iso, timeZone)}T${hh}:${mm}`
}

/** El instante de un valor de fecha y hora escrito en la zona de la clínica; null si no es válido. */
export function instantFromClinicValue(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!match) return null
  const [, date, hh, mm] = match as unknown as [string, string, string, string]
  const hours = Number(hh)
  const minutes = Number(mm)
  if (hours > 23 || minutes > 59 || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null
  return minutesToInstant(date, hours * 60 + minutes, activeOrgTimeZone())
}

// --- Controles clínicos -----------------------------------------------------

export { FOLLOW_UP_STATUSES, type FollowUpStatus } from "@odentia/clinical"

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  pendiente: "Pendiente",
  programado: "Programado",
  realizado: "Realizado",
  cancelado: "Cancelado",
}

export const FOLLOW_UP_KIND_LABELS: Record<string, string> = {
  tratamiento: "Seguimiento del tratamiento",
  mantenimiento: "Mantenimiento",
}

/** Control longitudinal: una cita programada no equivale a un control realizado. */
export interface FollowUp {
  id: string
  patientId: string
  planItemId: string | null
  encounterProcedureId: string | null
  originEncounterId: string | null
  kind: string
  title: string
  instructions: string | null
  dueAt: string
  status: FollowUpStatus
  scheduledAt: string | null
  appointmentId: string | null
  appointment: { id: string; startsAt: string; endsAt: string; status: AppointmentStatus } | null
  legacyScheduledAt: string | null
  /** Cada cuántos meses se repite; nulo: una vez (issue 229, decisión 16). */
  repeatEveryMonths: number | null
  /** El control de la serie que lo dejó indicado. */
  repeatsFromId: string | null
  completedEncounterId: string | null
  outcome: string | null
  cancelledReason: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
}

/** Situación de la reserva, independiente del cierre clínico del control. */
export function followUpAppointmentLabel(control: FollowUp): string {
  const appointment = control.appointment
  if (!appointment)
    return control.legacyScheduledAt ? "Sin reserva verificada" : "Sin cita reservada"
  if (appointment.status === "atendida") {
    return control.status === "pendiente" || control.status === "programado"
      ? "Pendiente de cierre clínico"
      : "Cita atendida"
  }
  if (appointment.status === "cancelada") return "Cita cancelada · sin reserva vigente"
  if (appointment.status === "no_asistio") return "No vino · sin reserva vigente"
  return `Cita ${appointment.status === "confirmada" ? "confirmada" : "reservada"} · ${formatDateTime(appointment.startsAt)}`
}

export type ScheduleFollowUpBody =
  | { appointmentId: string }
  | {
      appointment: {
        branchId?: string
        professionalUserId: string
        /** Sin unidad dental, la agenda pone una libre. */
        roomId?: string
        serviceId?: string
        startsAt: string
        endsAt?: string
        durationMin?: number
      }
    }

export function fetchFollowUps(
  patientId: string,
  status?: FollowUpStatus,
): Promise<{ data: FollowUp[] }> {
  const query = status ? `?status=${status}` : ""
  return apiFetch<{ data: FollowUp[] }>(`${base(patientId)}/follow-ups${query}`)
}

export interface CreateFollowUpBody {
  kind: "tratamiento" | "mantenimiento"
  title: string
  dueAt: string
  instructions?: string | null
  planItemId?: string | null
  encounterProcedureId?: string | null
  originEncounterId?: string | null
  repeatEveryMonths?: number | null
}

export function createFollowUpApi(
  patientId: string,
  body: CreateFollowUpBody,
): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function scheduleFollowUpApi(
  patientId: string,
  followUpId: string,
  body: ScheduleFollowUpBody,
): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups/${followUpId}/schedule`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Lo mínimo de un control para reservar su cita (vía clínica o coordinación). */
export type SchedulableControl = Pick<
  FollowUp,
  "id" | "patientId" | "title" | "dueAt" | "status" | "appointment" | "legacyScheduledAt"
>

/** Vista de coordinación: títulos, estados y fechas; sin detalle clínico ni importes. */
export interface TreatmentCoordination {
  budgetsAwaitingDecision: Array<{ id: string; title: string; presentedAt: string | null }>
  followUps: SchedulableControl[]
  treatments: Array<{ id: string; title: string; status: string; decision: string }>
}

export function fetchTreatmentCoordination(
  patientId: string,
): Promise<{ data: TreatmentCoordination }> {
  return apiFetch<{ data: TreatmentCoordination }>(`${base(patientId)}/coordination`)
}

export function scheduleFollowUpFromCoordinationApi(
  patientId: string,
  followUpId: string,
  body: ScheduleFollowUpBody,
): Promise<{ data: SchedulableControl }> {
  return apiFetch<{ data: SchedulableControl }>(
    `${base(patientId)}/coordination/follow-ups/${followUpId}/schedule`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

export function completeFollowUpApi(
  patientId: string,
  followUpId: string,
  body: { encounterId: string; outcome: string },
): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups/${followUpId}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** «Dejar de repetir»: el control sigue en pie; al completarlo ya no deja otro. */
export function stopFollowUpRepeatApi(patientId: string, followUpId: string): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups/${followUpId}/stop-repeat`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

export function cancelFollowUpApi(
  patientId: string,
  followUpId: string,
  body: { reason: string },
): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups/${followUpId}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// --- Recetas ----------------------------------------------------------------

export const PRESCRIPTION_STATUS_LABELS: Record<string, string> = {
  emitida: "Emitida",
  anulada: "Anulada",
}

export interface PrescriptionItem {
  id: string
  medicationName: string
  genericName?: string | null
  brandName?: string | null
  strength?: string | null
  dosageForm?: string | null
  atcCode?: string | null
  dose: string
  route: string
  frequency: string
  duration: string
  quantity: number | null
  instructions: string | null
}

/** Receta inmutable: se corrige anulándola con motivo, nunca editando el contenido. */
export interface Prescription {
  id: string
  patientId: string
  encounterId: string | null
  planItemId: string | null
  prescriptionNumber: number
  status: string
  notes: string | null
  issuedBy: string | null
  issuedAt: string
  cancelledAt: string | null
  cancelReason: string | null
  /** Por qué se recetó pese al aviso de alergia (decisión 10). */
  allergyOverrideReason?: string | null
  /** El peso (kg) con que se recetó: latidIA, a un menor de 12 años (issue 229). */
  patientWeightKg?: string | null
  diagnosisCode?: string | null
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
  validUntil?: string | null
  prescriberName?: string | null
  prescriberTitle?: string | null
  prescriberRegistration?: string | null
  items?: PrescriptionItem[]
}

export interface PrescriptionMedicationBody {
  genericName: string
  brandName?: string | null
  strength: string
  dosageForm: string
  dose: string
  route: string
  frequency: string
  duration: string
  quantity?: number | null
  instructions?: string | null
}

export function fetchPrescriptions(patientId: string): Promise<{ data: Prescription[] }> {
  return apiFetch<{ data: Prescription[] }>(`${base(patientId)}/prescriptions`)
}

export function fetchPrescriptionDetail(
  patientId: string,
  prescriptionId: string,
): Promise<{ data: Prescription }> {
  return apiFetch<{ data: Prescription }>(`${base(patientId)}/prescriptions/${prescriptionId}`)
}

export function createPrescriptionApi(
  patientId: string,
  body: {
    encounterId?: string | null
    planItemId?: string | null
    notes?: string | null
    diagnosisCode?: string | null
    /** Lista del código («ICD-10», «ICD-11»). */
    diagnosisSystem?: string | null
    validUntil?: string | null
    acknowledgeAllergies?: boolean
    /** Con aviso de alergia, por qué se receta igual: queda en la receta. */
    allergyOverrideReason?: string | null
    /** El peso (kg) con que se receta, si la receta lo lleva. */
    patientWeightKg?: number | null
    items: PrescriptionMedicationBody[]
  },
): Promise<{ data: Prescription }> {
  return apiFetch<{ data: Prescription }>(`${base(patientId)}/prescriptions`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function cancelPrescriptionApi(
  patientId: string,
  prescriptionId: string,
  body: { reason: string },
): Promise<{ data: Prescription }> {
  return apiFetch<{ data: Prescription }>(
    `${base(patientId)}/prescriptions/${prescriptionId}/cancel`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

// --- Responsables -----------------------------------------------------------

// La lista vive en `@odentia/clinical`, la misma que valida el servidor.
export { RESPONSIBILITY_KINDS, type ResponsibilityKind } from "@odentia/clinical"

export const RESPONSIBILITY_KIND_LABELS: Record<ResponsibilityKind, string> = {
  representante_legal: "Representante legal",
  autorizado_informacion: "Autorizado para información",
  responsable_economico: "Responsable económico",
}

/** Responsabilidad de un contacto vinculado, con vigencia e historial. */
export interface Responsibility {
  id: string
  patientId: string
  contactId: string
  kind: ResponsibilityKind
  startsAt: string
  endsAt: string | null
  evidenceDocumentId: string | null
  notes: string | null
  revokedAt: string | null
  revokeReason: string | null
  isCurrent: boolean
  contact: { id: string; displayName: string; isActive: boolean }
  evidenceDocument: Pick<PatientDocument, "id" | "label" | "category"> | null
}

export function fetchResponsibilities(patientId: string): Promise<{ data: Responsibility[] }> {
  return apiFetch<{ data: Responsibility[] }>(`${base(patientId)}/responsibilities`)
}

export function grantResponsibilityApi(
  patientId: string,
  body: {
    contactId: string
    kind: ResponsibilityKind
    startsAt: string
    endsAt?: string | null
    evidenceDocumentId?: string | null
    notes?: string | null
  },
): Promise<{ data: Responsibility }> {
  return apiFetch<{ data: Responsibility }>(`${base(patientId)}/responsibilities`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function revokeResponsibilityApi(
  patientId: string,
  responsibilityId: string,
  body: { reason: string },
): Promise<{ data: Responsibility }> {
  return apiFetch<{ data: Responsibility }>(
    `${base(patientId)}/responsibilities/${responsibilityId}/revoke`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

// --- Recorrido del tratamiento ---------------------------------------------

export type { TreatmentNextAction }

export const NEXT_ACTION_LABELS: Record<TreatmentNextAction, string> = {
  definir: "Definir el tratamiento",
  presupuestar: "Preparar la propuesta",
  decidir: "Registrar la decisión",
  iniciar: "Iniciar la primera sesión",
  reanudar: "Reanudar el tratamiento",
  continuar: "Continuar en la atención abierta",
  completar: "Completar el tratamiento",
  controlar: "Revisar el control",
}

/** Cabecera de presupuesto tal como la devuelve el recorrido (sin totales agregados). */
export interface JourneyBudget {
  id: string
  budgetNumber: number
  revisionNumber: number
  title: string
  status: string
  presentedAt: string | null
  decidedAt: string | null
  acceptedByName: string | null
  notes: string | null
  decisionNote: string | null
  supersedesBudgetId: string | null
}

export interface JourneyBudgetLine {
  id: string
  title: string
  priceCents: number | null
  currency: string
  decision: string
}

export interface TreatmentJourney {
  item: PlanItem
  plan: TreatmentPlan
  originEncounter: Encounter | null
  /** Hallazgo del odontograma que motivó la indicación, si se registró. */
  originFinding: SiteFinding | null
  replacedBy: PlanItem[]
  supersedes: PlanItem | null
  budgetHistory: Array<{ budget: JourneyBudget; line: JourneyBudgetLine }>
  procedures: Array<{ procedure: ProcedureItem; encounter: Encounter }>
  followUps: FollowUp[]
  prescriptions: Array<Prescription & { items: PrescriptionItem[] }>
  documents: PatientDocument[]
  /** Caja del tratamiento; `null` cuando quien consulta no tiene `finance.read`. */
  finance: TreatmentFinance | null
  /** Derivada con el tratamiento completo a la vista; null si está cerrado. */
  nextAction: TreatmentNextAction | null
}

/** Caja del tratamiento tal como la sirve el recorrido (filas de cargo/pago). */
export interface JourneyCharge {
  id: string
  description: string
  amountCents: number
  currency: string
  voidedAt: string | null
}

export interface JourneyPayment {
  id: string
  paidAt: string
  amountCents: number
  currency: string
}

export interface JourneyApplication {
  paymentId: string
  chargeId: string
  amountCents: number
  voidedAt: string | null
}

export interface JourneyRefund {
  paymentId: string
  amountCents: number
}

export interface JourneyBalance {
  currency: string
  chargedCents: number
  appliedCents: number
  outstandingCents: number
}

export interface TreatmentFinance {
  charges: JourneyCharge[]
  payments: JourneyPayment[]
  applications: JourneyApplication[]
  refunds: JourneyRefund[]
  balances: JourneyBalance[]
}
export function fetchTreatmentJourney(
  patientId: string,
  itemId: string,
): Promise<{ data: TreatmentJourney }> {
  return apiFetch<{ data: TreatmentJourney }>(`${base(patientId)}/treatments/${itemId}/journey`)
}

export function completeTreatmentApi(
  patientId: string,
  itemId: string,
  body: { encounterId: string },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/complete`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function suspendTreatmentApi(
  patientId: string,
  itemId: string,
  body: { reason: string; encounterId?: string },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/suspend`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Reactiva un tratamiento suspendido donde quedó: en curso si ya tenía sesiones. */
export function resumeTreatmentApi(
  patientId: string,
  itemId: string,
  body: { status: "pendiente" | "programado" | "en_curso" },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/resume`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function cancelTreatmentApi(
  patientId: string,
  itemId: string,
  body: { reason: string; encounterId?: string },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function reviseTreatmentApi(
  patientId: string,
  itemId: string,
  body: {
    encounterId: string
    reason: string
    serviceId: string
    toothNumber?: number | null
    surfaces?: string[] | null
    quadrant?: number | null
    arch?: "upper" | "lower" | null
    detail?: string | null
    diagnosisCode?: string | null
    /** Lista del código («ICD-10», «ICD-11»). */
    diagnosisSystem?: string | null
  },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/revise`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Saldo del tratamiento por moneda; nunca se suman monedas distintas. */
export function journeyBalances(
  journey: Pick<TreatmentFinance, "charges" | "applications">,
): JourneyBalance[] {
  const active = journey.charges.filter((charge) => !charge.voidedAt)
  const units = [...new Set(active.map((charge) => charge.currency))].sort()
  return units.map((currency) => {
    const charges = active.filter((charge) => charge.currency === currency)
    const ids = new Set(charges.map((charge) => charge.id))
    const chargedCents = charges.reduce((sum, charge) => sum + charge.amountCents, 0)
    const appliedCents = journey.applications
      .filter((a) => !a.voidedAt && ids.has(a.chargeId))
      .reduce((sum, a) => sum + a.amountCents, 0)
    return { currency, chargedCents, appliedCents, outstandingCents: chargedCents - appliedCents }
  })
}

export type { BudgetLine, BudgetWithTotals }
