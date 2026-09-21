/**
 * Recorrido clínico-económico del paciente: tipos de vista y llamadas a la API.
 *
 * Un tratamiento se sigue desde su origen hasta el cobro: qué se observó, qué se
 * indicó, qué se propuso, qué se aceptó, qué se ejecutó, qué falta y qué se pagó.
 * Aquí viven controles, recetas, cuenta y responsables; la API es la fuente de
 * verdad y estas funciones solo traducen su contrato a la UI.
 */
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

const base = (patientId: string) => `/api/patients/${patientId}`

/** Mensaje de error en español para cualquier mutación clínica. */
export function mutationMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.shape.message) return err.shape.message
    if (err.shape.code) return `No se pudo guardar (${err.shape.code}). Inténtalo de nuevo.`
  }
  return err instanceof Error ? err.message : "No se pudo guardar. Inténtalo de nuevo."
}

/** Fecha corta en español (es-PE); "—" cuando el valor falta o es inválido. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" })
}

/** Importe escrito por una persona a centavos enteros; null si no es un positivo válido. */
export function centsFromInput(value: string): number | null {
  const normalized = value.trim().replace(",", ".")
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ""] = normalized.split(".")
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null
}

/** Fecha y hora cortas en español (es-PE) para citas y controles. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString("es-PE", {
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
  completedEncounterId: string | null
  outcome: string | null
  cancelledReason: string | null
  completedAt: string | null
  cancelledAt: string | null
  createdAt: string
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
  body: { scheduledAt: string },
): Promise<{ data: FollowUp }> {
  return apiFetch<{ data: FollowUp }>(`${base(patientId)}/follow-ups/${followUpId}/schedule`, {
    method: "POST",
    body: JSON.stringify(body),
  })
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
  items?: PrescriptionItem[]
}

export interface PrescriptionMedicationBody {
  medicationName: string
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

// --- Cuenta económica -------------------------------------------------------

export const PAYMENT_METHODS = [
  "efectivo",
  "tarjeta",
  "transferencia",
  "yape",
  "plin",
  "otro",
] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  transferencia: "Transferencia",
  yape: "Yape",
  plin: "Plin",
  otro: "Otro",
}

/** Cargo generado desde una línea aceptada, desde un procedimiento o manual. */
export interface Charge {
  id: string
  patientId: string
  planItemId: string | null
  budgetItemId: string | null
  encounterProcedureId: string | null
  description: string
  amountCents: number
  currency: string
  dueAt: string | null
  notes: string | null
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
}

/** Pago o anticipo: un anticipo es un pago aún sin aplicaciones. */
export interface Payment {
  id: string
  patientId: string
  payerContactId: string | null
  amountCents: number
  currency: string
  paidAt: string
  method: string
  reference: string | null
  notes: string | null
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
}

export interface PaymentApplication {
  id: string
  patientId: string
  paymentId: string
  chargeId: string
  amountCents: number
  createdAt: string
  voidedAt: string | null
  voidReason: string | null
}

export interface PaymentRefund {
  id: string
  patientId: string
  paymentId: string
  amountCents: number
  refundedAt: string
  reason: string
}

/** Totales por moneda: nunca se suman importes de monedas distintas. */
export interface AccountBalance {
  currency: string
  agreedCents: number
  chargedCents: number
  paidCents: number
  appliedCents: number
  refundedCents: number
  outstandingCents: number
  availableCreditCents: number
}

export interface PatientAccount {
  byCurrency: AccountBalance[]
  charges: Charge[]
  payments: Payment[]
  applications: PaymentApplication[]
  refunds: PaymentRefund[]
}

export function fetchPatientAccount(patientId: string): Promise<{ data: PatientAccount }> {
  return apiFetch<{ data: PatientAccount }>(`${base(patientId)}/account`)
}

export function createChargeApi(
  patientId: string,
  body: {
    budgetItemId?: string | null
    encounterProcedureId?: string | null
    planItemId?: string | null
    description?: string
    amountCents?: number
    currency?: string
    dueAt?: string | null
    notes?: string | null
  },
): Promise<{ data: Charge }> {
  return apiFetch<{ data: Charge }>(`${base(patientId)}/charges`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidChargeApi(
  patientId: string,
  chargeId: string,
  body: { reason: string },
): Promise<{ data: Charge }> {
  return apiFetch<{ data: Charge }>(`${base(patientId)}/charges/${chargeId}/void`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function createPaymentApi(
  patientId: string,
  body: {
    payerContactId?: string | null
    amountCents: number
    currency: string
    paidAt: string
    method: PaymentMethod
    reference?: string | null
    notes?: string | null
  },
): Promise<{ data: Payment }> {
  return apiFetch<{ data: Payment }>(`${base(patientId)}/payments`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function applyPaymentApi(
  patientId: string,
  paymentId: string,
  body: { chargeId: string; amountCents: number },
): Promise<{ data: PaymentApplication }> {
  return apiFetch<{ data: PaymentApplication }>(
    `${base(patientId)}/payments/${paymentId}/applications`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

export function voidPaymentApplicationApi(
  patientId: string,
  applicationId: string,
  body: { reason: string },
): Promise<{ data: PaymentApplication }> {
  return apiFetch<{ data: PaymentApplication }>(
    `${base(patientId)}/payment-applications/${applicationId}/void`,
    { method: "POST", body: JSON.stringify(body) },
  )
}

export function refundPaymentApi(
  patientId: string,
  paymentId: string,
  body: { amountCents: number; reason: string; refundedAt?: string },
): Promise<{ data: PaymentRefund }> {
  return apiFetch<{ data: PaymentRefund }>(`${base(patientId)}/payments/${paymentId}/refunds`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function voidPaymentApi(
  patientId: string,
  paymentId: string,
  body: { reason: string },
): Promise<{ data: Payment }> {
  return apiFetch<{ data: Payment }>(`${base(patientId)}/payments/${paymentId}/void`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** Disponibilidad real de cada pago y cargo activos (lo que la UI puede ofrecer). */
export function paymentAvailability(account: PatientAccount) {
  return account.payments
    .filter((payment) => !payment.voidedAt)
    .map((payment) => {
      const applied = account.applications
        .filter((a) => a.paymentId === payment.id && !a.voidedAt)
        .reduce((sum, a) => sum + a.amountCents, 0)
      const refunded = account.refunds
        .filter((r) => r.paymentId === payment.id)
        .reduce((sum, r) => sum + r.amountCents, 0)
      return {
        payment,
        availableCents: payment.amountCents - applied - refunded,
        refundableCents: payment.amountCents - applied - refunded,
      }
    })
}

/** Saldo pendiente real de cada cargo activo. */
export function chargeAvailability(account: PatientAccount) {
  return account.charges
    .filter((charge) => !charge.voidedAt)
    .map((charge) => {
      const applied = account.applications
        .filter((a) => a.chargeId === charge.id && !a.voidedAt)
        .reduce((sum, a) => sum + a.amountCents, 0)
      return { charge, appliedCents: applied, pendingCents: charge.amountCents - applied }
    })
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
  controlar: "Programar el control",
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
  charges: Charge[]
  payments: Payment[]
  applications: PaymentApplication[]
  refunds: PaymentRefund[]
  /** Derivada con el tratamiento completo a la vista; null si está cerrado. */
  nextAction: TreatmentNextAction | null
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
  journey: Pick<TreatmentJourney, "charges" | "applications">,
): AccountBalance[] {
  const active = journey.charges.filter((charge) => !charge.voidedAt)
  const units = [...new Set(active.map((charge) => charge.currency))].sort()
  return units.map((currency) => {
    const charges = active.filter((charge) => charge.currency === currency)
    const ids = new Set(charges.map((charge) => charge.id))
    const chargedCents = charges.reduce((sum, charge) => sum + charge.amountCents, 0)
    const appliedCents = journey.applications
      .filter((a) => !a.voidedAt && ids.has(a.chargeId))
      .reduce((sum, a) => sum + a.amountCents, 0)
    return {
      currency,
      agreedCents: chargedCents,
      chargedCents,
      paidCents: 0,
      appliedCents,
      refundedCents: 0,
      outstandingCents: chargedCents - appliedCents,
      availableCreditCents: 0,
    }
  })
}

export type { BudgetLine, BudgetWithTotals }
