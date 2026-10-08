/** Tipos espejo de la API de pacientes + helpers puros para la UI. */
import { activeFindingsAsOf, type FindingDetails } from "@odentia/clinical"
import { apiFetch } from "./api"

export type BloodGroup = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown"

export interface Patient {
  id: string
  organizationId?: string
  patientNumber: number
  displayName: string
  bloodGroup?: BloodGroup | null
  docType?: string | null
  docNumber?: string | null
  birthDate?: string | null
  sex?: string | null
  phone?: string | null
  email?: string | null
  avatarStorageKey?: string | null
  maritalStatus?: string | null
  educationLevel?: string | null
  occupation?: string | null
  address?: string | null
  origin?: string | null
  emergencyContactName?: string | null
  emergencyContactPhone?: string | null
  insuranceType?: string | null
  insuranceDetail?: string | null
  referralSource?: string | null
  registeredBranchId?: string | null
  isActive: boolean
  dataConsentAt?: string | null
  createdAt: string
  updatedAt?: string
}

export interface Allergy {
  id: string
  substance: string
  category?: string | null
  reaction?: string | null
  severity: string
  isActive: boolean
  createdAt?: string
}

export interface Condition {
  id: string
  name: string
  cie10Code?: string | null
  status: string
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
  isActive?: boolean
  createdAt?: string
}

export interface Medication {
  id: string
  name: string
  genericName?: string | null
  dose?: string | null
  frequency?: string | null
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
}

export interface AnamnesisAnswers {
  [key: string]: unknown
  motivoConsulta?: string
  tiempoEnfermedad?: string
  observaciones?: string
  diagnosticoPresuntivo?: string
}
export type HealthReviewState = "unknown" | "none" | "recorded"

export interface HealthReviewStatus {
  allergies: HealthReviewState
  conditions: HealthReviewState
  medications: HealthReviewState
}

export interface HealthAllergyInput {
  id?: string
  substance: string
  category?: string | null
  reaction?: string | null
  severity: string
  isActive?: boolean
}

export interface HealthConditionInput {
  id?: string
  name: string
  cie10Code?: string | null
  status: string
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
}

export interface HealthMedicationInput {
  id?: string
  name: string
  genericName?: string | null
  dose?: string | null
  frequency?: string | null
  startDate?: string | null
  endDate?: string | null
}

export interface SaveHealthInput {
  expectedRevision: number
  reviewStatus: HealthReviewStatus
  allergies: HealthAllergyInput[]
  conditions: HealthConditionInput[]
  medications: HealthMedicationInput[]
  bloodGroup?: BloodGroup | null
  anamnesis?: { expectedVersion: number; answers: AnamnesisAnswers }
  dataConsent?: true
}

export interface PatientHealth {
  revision: number
  reviewStatus: HealthReviewStatus
  allergies: Allergy[]
  conditions: Condition[]
  medications: Medication[]
  bloodGroup: BloodGroup | null
  reviewedAt: string | null
  reviewedBy: string | null
  latestAnamnesis: {
    id: string
    version: number
    answers: AnamnesisAnswers
    createdAt: string
    createdBy: string | null
  } | null
}

export const ALLERGY_SEVERITIES = ["leve", "moderada", "severa", "desconocida"] as const

/** Tipo de alérgeno; mismo catálogo que valida el servidor. */
export const ALLERGY_CATEGORY_LABELS: Record<string, string> = {
  medicamento: "Medicamento",
  anestesico: "Anestésico",
  material: "Material (látex, metales, resinas)",
  alimento: "Alimento",
  ambiental: "Ambiental",
  otro: "Otro",
}

/** Certeza de un diagnóstico codificado. */
export const DIAGNOSIS_TYPE_LABELS: Record<string, string> = {
  presuntivo: "Presuntivo",
  definitivo: "Definitivo",
  repetido: "Repetido",
}

export const ALLERGY_SEVERITY_LABELS: Record<string, string> = {
  leve: "Leve",
  moderada: "Moderada",
  severa: "Severa",
  desconocida: "Desconocida",
}

export const CONDITION_STATUS_LABELS: Record<string, string> = {
  activa: "Activa",
  resuelta: "Resuelta",
  inactiva: "Inactiva",
}

export const HEALTH_REVIEW_LABELS: Record<HealthReviewState, string> = {
  unknown: "Sin determinar",
  none: "Niega antecedentes de este tipo",
  recorded: "Registrados",
}

/**
 * Hay información clínica registrada: grupo sanguíneo, filas vigentes o una
 * determinación explícita (negación o registro) en algún grupo, o entrevista.
 * La longitud de las listas por sí sola no basta: sangre, un «No» o una
 * respuesta odontológica también son información.
 */
export function hasHealthInfo(health: PatientHealth | null | undefined): boolean {
  if (!health) return false
  // La declaración explícita «No sé» incrementa revisión aunque no cree filas.
  if (health.revision > 0) return true
  if (health.bloodGroup != null) return true
  if (health.allergies.length > 0 || health.conditions.length > 0 || health.medications.length > 0)
    return true
  const status = health.reviewStatus
  if (
    status.allergies !== "unknown" ||
    status.conditions !== "unknown" ||
    status.medications !== "unknown"
  )
    return true
  const answers = health.latestAnamnesis?.answers
  return !!answers && Object.keys(answers).length > 0
}

/**
 * Declaración pendiente de revisión profesional: hay información pero nunca se
 * marcó revisor/fecha. Distinto de «Sin determinar» (contenido desconocido).
 */
export function isHealthReviewPending(health: PatientHealth | null | undefined): boolean {
  return hasHealthInfo(health) && !health?.reviewedAt
}

export interface ClinicalNote {
  id: string
  note: string
  diagnosisCode?: string | null
  diagnosisType?: string | null
  toothNumber?: number | null
  authorUserId?: string
  encounterId?: string | null
  kind?: string
  createdAt: string
}

export interface PatientDocument {
  id: string
  category: string
  label: string
  storageKey?: string
  contentType: string
  sizeBytes: number
  encounterId: string | null
  planItemId: string | null
  /** Vínculos clínico-económicos del contexto vigente (nullable). */
  budgetId: string | null
  encounterProcedureId: string | null
  prescriptionId: string | null
  followUpId: string | null
  paymentId: string | null
  toothNumbers: number[]
  tags: string[]
  contextVersion: number
  createdAt: string
}

export interface PatientDocumentContext {
  id: string
  documentId: string
  version: number
  encounterId: string | null
  planItemId: string | null
  encounterProcedureId?: string | null
  budgetId?: string | null
  followUpId?: string | null
  prescriptionId?: string | null
  paymentId?: string | null
  toothNumbers: number[]
  tags: string[]
  authorUserId: string
  createdAt: string
}

export interface OdontogramEntry {
  id: string
  toothNumber: number
  surface?: string | null
  condition: string
  status: string
  diagnosisCode?: string | null
  note?: string | null
  encounterId?: string | null
  createdAt?: string
  details?: FindingDetails
  needsReview?: boolean
  legacyData?: Record<string, unknown> | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
}

export type ToothState = {
  condition: string
  status: string
  surfaces: string[]
  entries: string[]
}

export interface OdontogramState {
  teeth: Record<string, ToothState>
  history: OdontogramEntry[]
}

export interface OdontogramAssessment {
  id: string
  patientId: string
  patientName: string
  patientNumber: number
  authorUserId: string
  createdAt: string
  purpose: "initial" | "new_findings" | "completion" | "reentry" | "legal" | "personal"
  standard: string
  specifications: string
  observations: string
  examinerName: string
  registrationNumber: string
  signature: number[][][]
  entries: OdontogramEntry[]
}

/** Atención clínica (borrador editable / finalizada inmutable). Fechas como ISO string. */
export interface Encounter {
  id: string
  organizationId?: string
  patientId?: string
  branchId: string | null
  dentistUserId: string
  status: string
  reason: string | null
  evolution: string | null
  indications: string | null
  nextStep: string | null
  nextAppointmentAt: string | null
  finalizedAt: string | null
  examination?: {
    extraoral?: Record<string, string>
    intraoral?: Record<string, string>
    higieneOral?: string
  } | null
  finalizedBy: string | null
  createdAt: string
  updatedAt: string
}

/** Procedimiento realizado durante una atención. Fechas como ISO string. */
export interface ProcedureItem {
  id: string
  organizationId?: string
  encounterId: string
  serviceId: string | null
  toothNumber: number | null
  scope: string | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
  description: string
  diagnosisCode: string | null
  planItemId: string | null
  /** Snapshot del costo al registrar el acto; null en actos libres (sin cargo). */
  priceCents: number | null
  currency: string | null
  createdBy?: string | null
  createdAt: string
}

/** Ítem del plan de tratamiento (decisión derivada de la línea vigente). Fechas como ISO string. */
export interface PlanItem {
  id: string
  organizationId?: string
  patientId?: string
  planId: string
  odontogramEntryId?: string | null
  budgetId: string | null
  decision: "pendiente" | "aceptado" | "rechazado" | "sin_registro"
  /** Decisión clínica vigente del ítem: la indicación manda, el snapshot es evidencia. */
  decisionStatus:
    | "pendiente"
    | "aceptado"
    | "pospuesto"
    | "rechazado"
    | "reemplazado"
    | "sin_registro"
  decidedAt: string | null
  decidedByContactId: string | null
  decidedByName: string | null
  decisionNote: string | null
  /** Alternativas excluyentes del mismo problema clínico. */
  optionGroupId: string | null
  isRecommended: boolean
  /** Indicación anterior que esta reemplaza tras una reevaluación. */
  supersedesItemId: string | null
  /** Motivo obligatorio al suspender o cancelar. */
  statusReason: string | null
  startedAt: string | null
  completedAt: string | null
  serviceId: string | null
  toothNumber: number | null
  scope: string | null
  surfaces: string[]
  quadrant: number | null
  arch: string | null
  title: string
  detail: string | null
  diagnosisCode: string | null
  priceCents: number | null
  currency: string
  status: string
  sourceEncounterId: string | null
  createdBy?: string | null
  createdAt: string
  updatedAt?: string
}

/** Plan clínico longitudinal con estado derivado. */
export interface TreatmentPlan {
  id: string
  patientId?: string
  title: string
  originEncounterId: string | null
  isLegacy: boolean
  createdAt: string
  updatedAt?: string
}

export interface TreatmentPlanWithStatus {
  plan: TreatmentPlan
  status: "Sin tratamientos" | "En curso" | "Completado" | "Cancelado"
  totalItems: number
  pendingItems: number
}

/** Detalle de una atención: encuentro + piezas, procedimientos, notas, odontograma, documentos y adendas. */
export interface EncounterDetail {
  encounter: Encounter
  teeth: number[]
  plannedItems: PlanItem[]
  indicatedItems: PlanItem[]
  procedures: ProcedureItem[]
  /** Notas de evolución (kind='evolucion'), orden ascendente. */
  notes: ClinicalNote[]
  odontogramEntries: OdontogramEntry[]
  documents: PatientDocument[]
  /** Correcciones posteriores al cierre (kind='adenda'), orden ascendente. */
  addenda: ClinicalNote[]
}

export type TimelineType =
  | "encounter"
  | "note"
  | "anamnesis"
  | "document"
  | "odontogram"
  | "plan"
  | "budget"
  | "follow_up"
  | "prescription"

/** Evento de la historia clínica unificada. Fechas como ISO string. */
export interface TimelineItem {
  id: string
  type: TimelineType
  createdAt: string
  title: string
  detail?: string | null
  toothNumbers: number[]
  authorId?: string | null
  refId: string
  diagnosisCode?: string | null
  category?: string
  version?: number
  condition?: string
  surface?: string | null
  status?: string
  procedures?: string[]
  documentsCount?: number
  nextStep?: string | null
  nextAppointmentAt?: string | null
  indications?: string | null
  diagnoses?: string[]
  plannedItems: Array<
    Pick<PlanItem, "id" | "title" | "toothNumber" | "status" | "planId" | "budgetId">
  >
  documents?: PatientLastVisit["documents"]
  tags?: string[]
  encounterId?: string | null
  planItemId?: string | null
  budgetId?: string | null
  followUpId?: string | null
  prescriptionId?: string | null
  /** Plan clínico del tratamiento, para abrir su recorrido desde la historia. */
  planId?: string | null
  /** Decisión vigente del tratamiento. */
  decision?: string | null
  /** Vencimiento de un control, para leerlo aquí mismo. */
  dueAt?: string | null
}

export interface PlanPendingTotal {
  currency: string
  count: number
  totalCents: number
}

export interface PatientLastVisit {
  encounterId: string
  reason: string | null
  evolution: string | null
  indications: string | null
  nextStep: string | null
  nextAppointmentAt: string | null
  finalizedAt: string | null
  teeth: number[]
  procedures: Array<Pick<ProcedureItem, "description" | "toothNumber" | "diagnosisCode">>
  diagnoses: string[]
  plannedItems: Array<
    Pick<PlanItem, "id" | "title" | "toothNumber" | "status" | "planId" | "budgetId">
  >
  documents: Array<Pick<PatientDocument, "id" | "label" | "category">>
}

/** Próxima acción derivada del recorrido: la calcula la API, la UI solo la muestra. */
export type TreatmentNextAction =
  | "definir"
  | "presupuestar"
  | "decidir"
  | "iniciar"
  | "reanudar"
  | "continuar"
  | "completar"
  | "controlar"

/** Saldo del tratamiento en una moneda concreta (nunca se suman monedas distintas). */
export interface TreatmentBalance {
  currency: string
  chargedCents: number
  appliedCents: number
  outstandingCents: number
}

/** Fila del recorrido clínico-económico que acompaña al resumen del paciente. */
export interface TreatmentJourneySummary {
  item: PlanItem
  plan: TreatmentPlan
  budget: {
    id: string
    budgetNumber: number
    title: string
    status: string
    revisionNumber: number
  } | null
  decision: string
  clinicalStatus: string
  lastSession: { procedure: ProcedureItem; encounter: Encounter } | null
  nextFollowUp: { id: string; title: string; status: string; dueAt: string } | null
  /** null cuando el tratamiento está cerrado y no admite más trabajo. */
  nextAction: TreatmentNextAction | null
  balances: TreatmentBalance[]
}

/** Resumen del paciente: última atención finalizada, borrador abierto y plan pendiente. */
export interface PatientSummary {
  lastEncounter: Encounter | null
  openEncounterId: string | null
  nextAppointmentAt: string | null
  treatmentJourneys: TreatmentJourneySummary[]
  planPending: {
    count: number
    unpricedCount: number
    /** null cuando hay más de una moneda (ver totals); nunca se suman monedas distintas. */
    totalCents: number | null
    /** null cuando hay más de una moneda (ver totals). */
    currency: string | null
    totals: PlanPendingTotal[]
  }
  activeDiagnoses: Array<{ toothNumber: number; condition: string; status: string }>
  lastVisit: PatientLastVisit | null
  acceptedPending: Array<
    Pick<
      PlanItem,
      | "id"
      | "title"
      | "toothNumber"
      | "diagnosisCode"
      | "priceCents"
      | "currency"
      | "status"
      | "planId"
      | "budgetId"
    > & {
      budgetNumber: number
      budgetTitle: string
    }
  >
  proposedBudgets: Array<{
    id: string
    budgetNumber: number
    title: string
    currency: string
    status: string
    itemsCount: number
    unpricedCount: number
    totalCents: number | null
    totals: PlanPendingTotal[]
    createdAt: string
  }>
  anamnesisBrief: {
    version: number
    createdAt: string
    motivo: string | null
    tiempo: string | null
    answeredCount: number
  } | null
  recentDocuments: Array<
    Pick<
      PatientDocument,
      | "id"
      | "label"
      | "category"
      | "encounterId"
      | "planItemId"
      | "toothNumbers"
      | "tags"
      | "createdAt"
    >
  >
}

export type PatientContactRelationship = "self" | "guardian" | "family" | "other"

export interface PatientContactLink {
  contactId: string
  displayName: string
  phone: string | null
  email: string | null
  isActive: boolean
  relationship: PatientContactRelationship
  relationshipDetail: string | null
  isPreferred: boolean
}

export interface PatientRegistrationInfo {
  entryPoint: string
  respondent: string | null
  createdAt: string
  actor: { id: string; name: string } | null
  contextContactId: string | null
  conversationId: string | null
  formVersion: number | null
  answers: unknown
  privacyNotice: string | null
}

export interface PatientFull {
  patient: Patient
  contacts: PatientContactLink[]
  registration: PatientRegistrationInfo | null
  activeAllergies: Allergy[]
  activeConditions: Condition[]
  currentMedications: Medication[]
}

/** Etiqueta de historia clínica: HC-000123 (padding 6). */
export function hcLabel(n: number): string {
  return `HC-${String(n).padStart(6, "0")}`
}

/** Edad en años desde fecha de nacimiento ISO; "" si ausente/inválida. */
export function ageFrom(birthDate: string | null | undefined): string {
  if (!birthDate) return ""
  const born = new Date(birthDate).getTime()
  if (Number.isNaN(born)) return ""
  const now = new Date()
  const b = new Date(born)
  let age = now.getFullYear() - b.getFullYear()
  const m = now.getMonth() - b.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1
  if (age < 0) return ""
  return `${age}`
}

export function statusLabel(status: string): string {
  if (status === "recorded") return "Registrado"
  if (status === "voided") return "Anulado por corrección"
  return status
}

/** Etiqueta en español del tipo de pieza: "incisor" → "Incisivo". */
export function toothTypeLabel(type: "incisor" | "canine" | "premolar" | "molar"): string {
  switch (type) {
    case "incisor":
      return "Incisivo"
    case "canine":
      return "Canino"
    case "premolar":
      return "Premolar"
    default:
      return "Molar"
  }
}

export function planStatusLabel(status: string): string {
  switch (status) {
    case "pendiente":
      return "Pendiente"
    case "programado":
      return "Programado"
    case "realizado":
      return "Realizado"
    case "cancelado":
      return "Cancelado"
    default:
      return status
  }
}

export function encounterStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "Borrador"
    case "finalizada":
      return "Finalizada"
    default:
      return status
  }
}

export function timelineTypeLabel(type: string): string {
  switch (type) {
    case "encounter":
      return "Atención"
    case "note":
      return "Nota clínica"
    case "anamnesis":
      return "Anamnesis"
    case "document":
      return "Documento"
    case "odontogram":
      return "Odontograma"
    case "plan":
      return "Tratamiento"
    case "budget":
      return "Presupuesto"
    case "follow_up":
      return "Control"
    case "prescription":
      return "Receta"
    default:
      return type
  }
}

/** Proyección por pieza de hallazgos coexistentes; el historial original no se modifica. */
export function winnersAsOf(history: OdontogramEntry[], iso?: string): OdontogramState {
  const byTooth = new Map<number, OdontogramEntry[]>()
  for (const entry of activeFindingsAsOf(history, iso)) {
    for (const tooth of entry.details?.relatedTeeth?.length
      ? entry.details.relatedTeeth
      : [entry.toothNumber]) {
      const entries = byTooth.get(tooth) ?? []
      entries.push(entry)
      byTooth.set(tooth, entries)
    }
  }
  const teeth: Record<string, ToothState> = {}
  for (const [tooth, entries] of byTooth) {
    const latest = entries.at(-1)!
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: [
        ...new Set(entries.flatMap((entry) => (entry.surface ? [entry.surface] : []))),
      ].sort(),
      entries: entries.map((entry) => entry.id),
    }
  }
  return { teeth, history }
}

/** Agregado de antecedentes + entrevista (revisión optimista). */
export function fetchPatientHealth(patientId: string): Promise<{ data: PatientHealth }> {
  return apiFetch<{ data: PatientHealth }>(`/api/patients/${patientId}/health`)
}

export function savePatientHealthApi(
  patientId: string,
  body: SaveHealthInput,
): Promise<{ data: PatientHealth }> {
  return apiFetch<{ data: PatientHealth }>(`/api/patients/${patientId}/health`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export function fetchAnamnesisHistory(patientId: string): Promise<{
  data: Array<{ id: string; version: number; createdAt: string; createdBy: string | null }>
}> {
  return apiFetch<{
    data: Array<{ id: string; version: number; createdAt: string; createdBy: string | null }>
  }>(`/api/patients/${patientId}/anamnesis/history`)
}

