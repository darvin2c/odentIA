/** Tipos espejo de la API de pacientes + helpers puros para la UI. */
import {
  DIAGNOSIS_VERIFICATION_LABELS,
  type MissingPersonDatum,
  type Vitals,
} from "@odentia/clinical"
import { apiFetch } from "./api"
import type { EncounterDiagnosis } from "./encounters"

export type BloodGroup = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown"

export interface Patient {
  id: string
  organizationId?: string
  patientNumber: number
  displayName: string
  /** Nombre separado (ADR 0004); el visible se deriva de él. */
  givenNames?: string | null
  familyName?: string | null
  identityNeedsReview?: boolean
  bloodGroup?: BloodGroup | null
  docType?: string | null
  docNumber?: string | null
  docCountry?: string | null
  nationality?: string | null
  /** Lugar de nacimiento: país (ISO 3166-1 alfa-2) y ciudad escrita. */
  birthCountry?: string | null
  birthPlace?: string | null
  /** Domicilio internacional: calle en `address`; región ISO 3166-2 si el país tiene lista. */
  addressCity?: string | null
  addressDistrict?: string | null
  addressRegion?: string | null
  addressPostalCode?: string | null
  addressCountry?: string | null
  addressReference?: string | null
  insurerName?: string | null
  affiliationNumber?: string | null
  asaClass?: string | null
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
  /** Tipo general del seguro y, si lo tiene, su régimen con nombre propio del país. */
  insuranceType?: string | null
  insuranceScheme?: string | null
  referralKind?: string | null
  referralSource?: string | null
  registeredBranchId?: string | null
  isActive: boolean
  createdAt: string
  updatedAt?: string
}

export interface Allergy {
  id: string
  substance: string
  /** Lista y código de la sustancia (ADR 0072); sin ellos, «sin codificar». */
  substanceSystem?: string | null
  substanceCode?: string | null
  category?: string | null
  reaction?: string | null
  severity: string
  kind?: string
  criticality?: string | null
  verification?: string
  /** Quién la dijo: el equipo o el paciente en su formulario. */
  source?: string
  isActive: boolean
  removedReason?: string | null
  removedAt?: string | null
  removedBy?: string | null
  createdBy?: string | null
  createdAt?: string
}

export interface Condition {
  id: string
  name: string
  diagnosisCode?: string | null
  diagnosisSystem?: string | null
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
  atcCode?: string | null
  dose?: string | null
  /** Número y unidad UCUM de la dosis, cuando se eligieron (la base devuelve el número como texto). */
  doseValue?: string | null
  doseUnit?: string | null
  frequency?: string | null
  frequencyCode?: string | null
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
  /** Sin dato el servidor guarda «desconocida». */
  severity?: string | null
  kind?: string | null
  criticality?: string | null
  verification?: string | null
  isActive?: boolean
}

/** Antecedente familiar por parentesco y condición. */
export interface FamilyHistoryItem {
  /** Parentesco con HL7 v3 RoleCode (solo familiares). */
  relationship: string
  condition: string
  diagnosisCode?: string | null
  diagnosisSystem?: string | null
  notes?: string | null
}

export interface HealthConditionInput {
  id?: string
  name: string
  diagnosisCode?: string | null
  diagnosisSystem?: string | null
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
  doseValue?: number | null
  doseUnit?: string | null
  frequency?: string | null
  frequencyCode?: string | null
  startDate?: string | null
  endDate?: string | null
}

export interface SaveHealthInput {
  expectedRevision: number
  reviewStatus: HealthReviewStatus
  /** Sin enviarlas quedan como están: se agregan y quitan una por una. */
  allergies?: HealthAllergyInput[]
  conditions: HealthConditionInput[]
  medications: HealthMedicationInput[]
  bloodGroup?: BloodGroup | null
  familyHistory?: FamilyHistoryItem[]
  asaClass?: string | null
  anamnesis?: { expectedVersion: number; answers: AnamnesisAnswers }
}

export interface PatientHealth {
  revision: number
  reviewStatus: HealthReviewStatus
  allergies: Allergy[]
  conditions: Condition[]
  medications: Medication[]
  bloodGroup: BloodGroup | null
  asaClass?: string | null
  familyHistory?: Array<FamilyHistoryItem & { id: string }>
  reviewedAt: string | null
  reviewedBy: string | null
  /** Quién revisó las alergias con el paciente y cuándo; `allergyReviewDue` lo calcula el servidor (6 meses). */
  allergiesReviewedAt?: string | null
  allergiesReviewedBy?: string | null
  allergyReviewDue?: boolean
  latestAnamnesis: {
    id: string
    version: number
    answers: AnamnesisAnswers
    createdAt: string
    createdBy: string | null
  } | null
}

export { ALLERGY_SEVERITIES } from "@odentia/clinical"

/** Tipo de alérgeno; mismo catálogo que valida el servidor. */
export const ALLERGY_CATEGORY_LABELS: Record<string, string> = {
  medicamento: "Medicamento",
  anestesico: "Anestésico",
  material: "Material (látex, metales, resinas)",
  alimento: "Alimento",
  ambiental: "Ambiental",
  otro: "Otro",
}

/** Certeza de un diagnóstico codificado (FHIR verificationStatus). */
export const DIAGNOSIS_TYPE_LABELS: Record<string, string> = DIAGNOSIS_VERIFICATION_LABELS

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
  unknown: "No se le preguntó",
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
 * marcó revisor/fecha. Distinto de «No se le preguntó» (contenido desconocido).
 */
export function isHealthReviewPending(health: PatientHealth | null | undefined): boolean {
  return hasHealthInfo(health) && !health?.reviewedAt
}

export interface ClinicalNote {
  id: string
  note: string
  diagnosisCode?: string | null
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
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
  /** Subtipo de imagen diagnóstica (@odentia/clinical IMAGE_TYPES). */
  imageType?: string | null
  capturedAt?: string | null
  source?: string | null
  reportStatus?: string | null
  retiredAt?: string | null
  retireReason?: string | null
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
  /** Tomografía de muchos archivos (ADR 0055); null en el resto. */
  imaging?: ImagingSummary | null
}

/** Lo que la ficha dice de una tomografía: su avance y su forma. */
export interface ImagingSummary {
  studyInstanceUid: string
  fileCount: number
  uploadedCount: number
  sliceCount: number
  voxelMm: number | null
  totalBytes: number
  completedAt: string | null
  thumbnailKey: string | null
  dicomPatientName: string | null
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

/**
 * Un hallazgo registrado en un lugar, con lo que lee lo común (odentIA: un
 * hallazgo del odontograma; lo demás está en `OdontogramEntry`, de lo dental).
 */
export interface SiteFinding {
  id: string
  toothNumber: number
  surface?: string | null
  condition: string
  status: string
  diagnosisCode?: string | null
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
  note?: string | null
  createdAt?: string
  voidedAt?: string | null
}

/** Atención clínica (borrador editable / finalizada inmutable). Fechas como ISO string. */
export interface Encounter {
  id: string
  organizationId?: string
  patientId?: string
  branchId: string | null
  professionalUserId: string
  /** borrador, finalizada o anulada. */
  status: string
  /** Cita que motivó la atención, si la hubo. */
  appointmentId?: string | null
  reason: string | null
  /** Nota normativa: enfermedad actual, signos vitales y pronóstico. */
  presentIllness?: string | null
  illnessDuration?: string | null
  vitals?: Record<string, number> | null
  prognosis?: string | null
  /** Por qué se cerró con un consentimiento sin firmar («Seguir sin él»). */
  consentSkipReason?: string | null
  evolution: string | null
  indications: string | null
  finalizedAt: string | null
  /** El examen físico, con la forma del producto (`ProductExaminationUi`). */
  examination?: Record<string, unknown> | null
  finalizedBy: string | null
  /** Inicio y fin declarados de la atención. */
  startedAt?: string
  endedAt?: string | null
  /** Firma del profesional al cerrar (instantánea del perfil). */
  signerName?: string | null
  signerTitle?: string | null
  signerRegistration?: string | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  createdAt: string
  updatedAt: string
}

/** Procedimiento realizado durante una atención. Fechas como ISO string. */
export interface ProcedureItem {
  id: string
  /** Unidades del acto; el cargo es precio unitario × cantidad. */
  quantity?: number
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
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
  planItemId: string | null
  /** Snapshot del costo al registrar el acto; null en actos libres (sin cargo). */
  priceCents: number | null
  currency: string | null
  createdBy?: string | null
  createdAt: string
  /** Anulado en borrador: sin cargo ni sesión. */
  voidedAt?: string | null
  voidReason?: string | null
}

/** Ítem del plan de tratamiento (decisión derivada de la línea vigente). Fechas como ISO string. */
export interface PlanItem {
  id: string
  organizationId?: string
  patientId?: string
  planId: string
  odontogramEntryId?: string | null
  budgetId: string | null
  decision: "pendiente" | "aceptado" | "pospuesto" | "rechazado" | "reemplazado" | "no_elegida"
  /** Decisión clínica vigente del ítem: la indicación manda, el snapshot es evidencia. */
  decisionStatus: "pendiente" | "aceptado" | "pospuesto" | "rechazado" | "reemplazado" | "no_elegida"
  /** Fase del plan (urgencia → mantenimiento) y orden de ejecución. */
  /** La fase del plan, una de las del producto (`productUi().plan`). */
  phase?: string
  sortOrder?: number
  /** Sesiones previstas y hechas (procedimientos no anulados). */
  plannedSessions?: number
  sessionsDone?: number
  decidedAt: string | null
  decidedByContactId: string | null
  decidedByName: string | null
  decisionNote: string | null
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
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
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
  /** El plan abierto de la persona: recibe las indicaciones nuevas (uno por persona). */
  isOpen: boolean
}

/** Detalle de una atención: encuentro + piezas, procedimientos, notas, odontograma, documentos y adendas. */
export interface EncounterDetail {
  encounter: Encounter
  teeth: number[]
  plannedItems: PlanItem[]
  indicatedItems: PlanItem[]
  procedures: ProcedureItem[]
  /** Diagnósticos CIE-10 de la atención, anulados incluidos. */
  diagnoses: EncounterDiagnosis[]
  /** Notas de evolución sin código (kind='evolucion'), orden ascendente. */
  notes: ClinicalNote[]
  /**
   * Lo que el producto registró en la atención (odentIA: los hallazgos del
   * odontograma). Solo lo trae el producto que lo registra: latidIA no.
   */
  odontogramEntries?: SiteFinding[]
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
  | "consent"
  | "order"
  | "form"
  | "odontogram_signed"

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
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
  category?: string
  version?: number
  condition?: string
  surface?: string | null
  status?: string
  procedures?: string[]
  documentsCount?: number
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
  /** El estado con el nombre único de la aplicación (el de un presupuesto lo escribe el servidor). */
  statusText?: string | null
  /** Vencimiento de un control, para leerlo aquí mismo. */
  dueAt?: string | null
  /** Motivo de una atención anulada: la historia la muestra con él. */
  voidReason?: string | null
  /** El periodontograma de la atención: un hecho de ella. */
  periodontal?: PeriodontalBrief | null
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
/** Atención en curso con lo que lleva y lo que le falta para cerrarse. */
export interface OpenEncounterBrief {
  id: string
  reason: string | null
  startedAt: string
  professionalUserId: string
  appointmentId: string | null
  diagnosisCount: number
  procedureCount: number
  missing: Array<"reason" | "diagnosis" | "evolution" | "signature">
}

export interface PatientSummary {
  lastEncounter: Encounter | null
  openEncounterId: string | null
  openEncounter?: OpenEncounterBrief | null
  /** Consentimientos emitidos y aún sin firmar. */
  pendingConsents?: Array<{ id: string; title: string }>
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
      | "contentType"
      | "imageType"
      | "capturedAt"
      | "encounterId"
      | "planItemId"
      | "toothNumbers"
      | "tags"
      | "createdAt"
    >
  >
  /** «Encías»: el último periodontograma firmado y el último diagnóstico confirmado (issue 49). */
  periodontal?: PeriodontalBrief | null
}

/** El periodontograma de una atención, para nombrarlo donde aparece. */
export interface PeriodontalBrief {
  chartId: string
  encounterId: string
  date: string
  /** «Estadio III · Grado B · Generalizada»; null sin diagnóstico confirmado. */
  classification: string | null
  bleedingPercent: number | null
  partial: boolean
  /** Fecha de la visita del diagnóstico (solo en el Resumen). */
  classifiedOn?: string | null
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
  /** Parentesco con HL7 v3 RoleCode, si se conoce. */
  kinship?: string | null
  isPreferred: boolean
  /** Contacto de emergencia: una marca sobre la persona vinculada (decisión 25). */
  isEmergency: boolean
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
  /**
   * «Faltan datos para atenderla», calculado en el servidor (decisión 10 de la
   * fase 3); null para quien no edita los datos (odontólogo, caja).
   */
  missingData: MissingPersonDatum[] | null
  /** Menor de edad hoy, con el día de la clínica: lo decide el servidor, no el navegador. */
  isMinor: boolean
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
    case "en_curso":
      return "En curso"
    case "suspendido":
      return "Suspendido"
    case "realizado":
      return "Realizado"
    case "cancelado":
      return "Cancelado"
    case "reemplazado":
      return "Reemplazado"
    default:
      return status
  }
}

export function encounterStatusLabel(status: string): string {
  switch (status) {
    case "borrador":
      return "En curso"
    case "finalizada":
      return "Finalizada"
    case "anulada":
      return "Anulada"
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
    case "consent":
      return "Consentimiento"
    case "order":
      return "Orden"
    case "form":
      return "Formulario"
    case "odontogram_signed":
      return "Odontograma firmado"
    default:
      return type
  }
}

/** Los signos vitales de una atención, con cuándo y quién los tomó. */
export interface VitalsReading {
  encounterId: string
  startedAt: string
  /** borrador (la atención de hoy) o finalizada. */
  status: string
  professionalUserId: string
  vitals: Vitals
}

/** Los signos vitales de la persona en el tiempo, de la más antigua a la más reciente (issue 229). */
export function fetchPatientVitals(patientId: string): Promise<{ data: VitalsReading[] }> {
  return apiFetch<{ data: VitalsReading[] }>(`/api/patients/${patientId}/vitals`)
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

/**
 * «Fecha de nacimiento, sexo y documento»: lo que falta, como lo entrega el
 * servidor, en una frase; el tipo y el número de documento se dicen juntos.
 */
export function filiationGapsText(gaps: ReadonlyArray<Pick<MissingPersonDatum, "label"> & { key: string }>): string {
  const words = [
    ...new Set(
      gaps.map((gap) =>
        gap.key === "docType" || gap.key === "docNumber" ? "documento" : gap.label.toLowerCase(),
      ),
    ),
  ]
  const text = words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} y ${words.at(-1)}`
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : ""
}

/* ---- Alergias una por una (issue 43, tablero 7; las reglas son del servidor) ---- */

export interface AllergyAddInput {
  substance?: string | null
  substanceSystem?: string | null
  substanceCode?: string | null
  severity?: string | null
  reaction?: string | null
}

export function addAllergyApi(patientId: string, body: AllergyAddInput): Promise<{ data: Allergy }> {
  return apiFetch<{ data: Allergy }>(`/api/patients/${patientId}/health/allergies`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function removeAllergyApi(patientId: string, allergyId: string, reason: string): Promise<{ data: Allergy }> {
  return apiFetch<{ data: Allergy }>(`/api/patients/${patientId}/health/allergies/${allergyId}/remove`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  })
}

export function restoreAllergyApi(patientId: string, allergyId: string): Promise<{ data: Allergy }> {
  return apiFetch<{ data: Allergy }>(`/api/patients/${patientId}/health/allergies/${allergyId}/restore`, {
    method: "POST",
  })
}

export function codeAllergyApi(
  patientId: string,
  allergyId: string,
  body: { substanceSystem: string; substanceCode: string },
): Promise<{ data: Allergy }> {
  return apiFetch<{ data: Allergy }>(`/api/patients/${patientId}/health/allergies/${allergyId}/code`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function markAllergiesReviewedApi(patientId: string): Promise<{ data: { reviewedAt: string } }> {
  return apiFetch<{ data: { reviewedAt: string } }>(`/api/patients/${patientId}/health/allergies/reviewed`, {
    method: "POST",
  })
}
