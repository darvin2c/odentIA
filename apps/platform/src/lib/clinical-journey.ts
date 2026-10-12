/**
 * Recorrido clínico-económico del paciente: tipos de vista y llamadas a la API.
 *
 * Un tratamiento se sigue desde su origen hasta el cobro: qué se observó, qué se
 * indicó, qué se propuso, qué se aceptó, qué se ejecutó, qué falta y qué se pagó.
 * Aquí viven controles, recetas, cuenta y responsables; la API es la fuente de
 * verdad y estas funciones solo traducen su contrato a la UI.
 */

import type { AppointmentStatus } from "./agenda"
import { ApiError, apiFetch } from "./api"
import type { BudgetLine, BudgetWithTotals } from "./budgets"
import type {
  Encounter,
  OdontogramEntry,
  PatientDocument,
  PlanItem,
  ProcedureItem,
  TreatmentNextAction,
  TreatmentPlan,
} from "./patients"
import { activeOrgLocale } from "./locale"

const base = (patientId: string) => `/api/patients/${patientId}`

/** Mensaje de error en español para cualquier mutación clínica. */
export function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/** Fecha corta, en el formato de la clínica; "—" cuando el valor falta o es inválido. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString(activeOrgLocale(), { day: "2-digit", month: "2-digit", year: "numeric" })
}

/** Fecha y hora cortas, en el formato de la clínica para citas y controles. */
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
  })
}

// --- Controles clínicos -----------------------------------------------------

export const FOLLOW_UP_STATUSES = ["pendiente", "programado", "realizado", "cancelado"] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

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
  if (appointment.status === "no_asistio") return "No asistió · sin reserva vigente"
  return `Cita ${appointment.status === "confirmada" ? "confirmada" : "reservada"} · ${formatDateTime(appointment.startsAt)}`
}

export type ScheduleFollowUpBody =
  | { appointmentId: string }
  | {
      appointment: {
        branchId?: string
        dentistUserId: string
        /** Sin sillón, la agenda pone uno libre. */
        chairId?: string
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
  diagnosisCode?: string | null
  validUntil?: string | null
  prescriberName?: string | null
  prescriberTitle?: string | null
  prescriberRegistration?: string | null
  items?: PrescriptionItem[]
}

/** Datos de la hoja impresa de una receta. */
export interface PrescriptionPrint {
  prescription: Prescription
  diagnosisDescription: string | null
  patient: {
    displayName: string
    patientNumber: number
    docType: string | null
    docNumber: string | null
    birthDate: string | null
  }
  establishment: {
    legalName: string
    tradeName: string | null
    fiscalDocType: string | null
    fiscalDocNumber: string | null
    address: string | null
  } | null
}

export function fetchPrescriptionPrint(patientId: string, prescriptionId: string) {
  return apiFetch<{ data: PrescriptionPrint }>(
    `${base(patientId)}/prescriptions/${prescriptionId}/print`,
  )
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
    validUntil?: string | null
    acknowledgeAllergies?: boolean
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

export const RESPONSIBILITY_KINDS = [
  "representante_legal",
  "autorizado_informacion",
  "responsable_economico",
  "acompanante",
] as const
export type ResponsibilityKind = (typeof RESPONSIBILITY_KINDS)[number]

export const RESPONSIBILITY_KIND_LABELS: Record<ResponsibilityKind, string> = {
  representante_legal: "Representante legal",
  autorizado_informacion: "Autorizado para información",
  responsable_economico: "Responsable económico",
  acompanante: "Acompañante",
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

/** Alternativas excluyentes del mismo problema clínico. */
export interface JourneyOptionGroup {
  id: string
  title: string
  alternatives: PlanItem[]
}

export interface TreatmentJourney {
  item: PlanItem
  plan: TreatmentPlan
  originEncounter: Encounter | null
  /** Hallazgo del odontograma que motivó la indicación, si se registró. */
  originFinding: OdontogramEntry | null
  replacedBy: PlanItem[]
  supersedes: PlanItem | null
  optionGroup: JourneyOptionGroup | null
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

/** Agrupa la indicación como alternativa del mismo problema clínico. */
export function setItemAlternativeApi(
  patientId: string,
  itemId: string,
  body: { optionGroupId: string | null; isRecommended?: boolean },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/alternative`, {
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
  },
): Promise<{ data: PlanItem }> {
  return apiFetch<{ data: PlanItem }>(`${base(patientId)}/treatments/${itemId}/revise`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function createOptionGroupApi(
  patientId: string,
  planId: string,
  body: { title: string },
): Promise<{ data: JourneyOptionGroup }> {
  return apiFetch<{ data: JourneyOptionGroup }>(
    `${base(patientId)}/plans/${planId}/option-groups`,
    { method: "POST", body: JSON.stringify(body) },
  )
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
