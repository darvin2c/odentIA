/** Tipos espejo de la API de pacientes + helpers puros para la UI. */
import {
  DIAGNOSIS_VERIFICATION_LABELS,
  hasHealthInfo as sharedHasHealthInfo,
  healthReviewPending,
  type HealthDeclarant,
  type MissingPersonDatum,
  type PregnancyToday,
  type Vitals,
} from "@odentia/clinical"
import { apiFetch } from "./api"
import type { EncounterDiagnosis } from "./encounters"

export type BloodGroup = "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | "unknown"

/** El consentimiento de un tratamiento: falta, preparado sin firmar, firmado por enlace sin confirmar o firmado. */
export type TreatmentConsentState = "falta" | "sin_firmar" | "por_confirmar" | "firmado"

/** «a», «a y b». */
function titlesWords(titles: readonly string[]): string {
  const quoted = titles.map((title) => `«${title}»`)
  return quoted.length <= 1 ? (quoted[0] ?? "") : `${quoted.slice(0, -1).join(", ")} y ${quoted.at(-1)}`
}

/**
 * «Falta su consentimiento», para decirlo junto al tratamiento; nada si está firmado. Si falta
 * preparar alguno, dice cuál (`missing`): una exodoncia puede pedir el suyo y el de la anestesia.
 */
export function treatmentConsentWords(
  state: TreatmentConsentState | null | undefined,
  missing: readonly string[] = [],
): string | null {
  if (state === "falta")
    return missing.length === 0
      ? "Falta preparar su consentimiento y firmarlo antes de hacerlo"
      : `Falta preparar ${missing.length === 1 ? "el consentimiento" : "los consentimientos"} ${titlesWords(missing)} y firmarlo${missing.length === 1 ? "" : "s"} antes de hacerlo`
  if (state === "sin_firmar") return "Su consentimiento está listo: falta firmarlo antes de hacerlo"
  if (state === "por_confirmar") return "Firmó su consentimiento en su enlace: confírmalo antes de hacerlo"
  if (state === "firmado") return "Consentimiento firmado"
  return null
}

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

/**
 * Lo que alguien dijo de su salud en una misma declaración y ningún profesional revisó todavía:
 * quién lo dijo, cuándo y qué. Con más de una declaración sin revisar hay un grupo por cada una.
 */
export interface DeclaredHealthGroup {
  by: HealthDeclarant
  /** Cuándo lo dijo; null si no consta. */
  at: string | null
  allergies: string[]
  conditions: string[]
  medications: string[]
  pregnancy: boolean
  /** Su «No» a un grupo lo dijo quien declaró, no lo anotó un profesional. */
  saidNo: { allergies: boolean; conditions: boolean; medications: boolean }
}

/** Una declaración de salud tal como llegó. */
export interface HealthDeclarationView {
  /** Cuándo lo dijo. */
  at: string
  /** Cuándo entró a su ficha: el instante de su registro, si vino con él. */
  enteredAt: string
  via: "enlace" | "registro" | "formulario"
  by: HealthDeclarant
  health: Record<string, unknown>
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
  /** Lo declarado por el paciente espera la revisión de un profesional (lo decide el servidor). */
  reviewPending?: boolean
  /** Lo que se dijo de su salud y nadie revisó, por declaración: quién, cuándo y qué (lo decide el servidor). */
  declared?: DeclaredHealthGroup[]
  /** El embarazo a hoy, con el día en que se dijo y la semana calculada; null si no hay. */
  pregnancy?: PregnancyToday | null
  /** Lo que declaró de su salud, tal como llegó, de lo más nuevo a lo más antiguo. */
  declarations?: HealthDeclarationView[]
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

/** Clasificación ASA del estado físico (ASA Physical Status Classification System). */
export const ASA_OPTIONS: Array<[string, string]> = [
  ["I", "ASA I · sano"],
  ["II", "ASA II · enfermedad sistémica leve"],
  ["III", "ASA III · enfermedad sistémica grave"],
  ["IV", "ASA IV · amenaza constante para la vida"],
  ["V", "ASA V · moribundo"],
  ["VI", "ASA VI · muerte cerebral (donante)"],
]

/** «ASA II · enfermedad sistémica leve» de lo guardado; null sin clasificar (QA del 6 nov: no salía en ningún resumen). */
export function asaLabel(value: string | null | undefined): string | null {
  return ASA_OPTIONS.find(([key]) => key === value)?.[1] ?? null
}

/**
 * Enfermedades y medicación que nunca se le preguntaron: el grupo sigue en «no
 * preguntado» y no tiene filas vigentes (con una ya se sabe algo). Es la misma
 * regla del cierre en el servidor (`healthGapsOf`). `today`: el día de la clínica.
 */
export function unaskedHealthGroups(health: PatientHealth, today: string): Array<"conditions" | "medications"> {
  const groups: Array<"conditions" | "medications"> = []
  if (health.reviewStatus.conditions === "unknown" && !health.conditions.some((row) => row.status === "activa"))
    groups.push("conditions")
  if (health.reviewStatus.medications === "unknown" && !health.medications.some((row) => isCurrentMedication(row, today)))
    groups.push("medications")
  return groups
}

/** La que toma: sin fecha de fin o con fin desde hoy, como en la receta. */
export function isCurrentMedication(row: Pick<Medication, "endDate">, today: string): boolean {
  return !row.endDate || row.endDate >= today
}

export const HEALTH_REVIEW_LABELS: Record<HealthReviewState, string> = {
  unknown: "No se le preguntó",
  none: "Niega antecedentes de este tipo",
  recorded: "Registrados",
}

/**
 * Hay información clínica registrada (no es solo «No se le preguntó»). La
 * regla es común con el servidor (`@odentia/clinical`).
 */
export function hasHealthInfo(health: PatientHealth | null | undefined): boolean {
  return sharedHasHealthInfo(health)
}

/**
 * Declaración pendiente de revisión profesional. La decide el servidor
 * (`reviewPending`), que sabe si lo anotó un clínico o lo declaró el paciente;
 * una respuesta sin ese dato usa la misma regla sin él.
 */
export function isHealthReviewPending(health: PatientHealth | null | undefined): boolean {
  if (!health) return false
  return health.reviewPending ?? healthReviewPending(health)
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
  /** Quien la escribió (las adendas lo traen). */
  authorName?: string | null
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
  /** «No mostrar en su portal»: desde cuándo está oculto; nulo, se ve (ADR 0156). */
  portalHiddenAt?: string | null
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
  /** La fecha del documento en esta versión; nula, vale la de subida. */
  capturedAt?: string | null
  /** Por qué se corrigió la fecha en esta versión. */
  dateReason?: string | null
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
  /** Sesiones previstas y hechas (atenciones distintas con un procedimiento vigente). */
  plannedSessions?: number
  sessionsDone?: number
  /** En la atención: indicado en ella, sin respuesta ni entregar; quien la lleva lo puede quitar. Lo decide el servidor. */
  removable?: boolean
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
  /**
   * Su camino: el presupuesto tiene varias opciones y él no está en todas (lo
   * común no tiene camino). Lo dice el servidor; el plan agrupa lo que compite.
   */
  path?: PlanItemPath | null
  /** Aceptado, y la revisión entregada le pregunta de nuevo por su precio: vale lo aceptado mientras tanto. */
  newTermsPending?: boolean
  /** Realizado al que le puede faltar otra sesión: el Plan ofrece «Falta otra sesión…». */
  canAddSession?: boolean
  /** El precio acordado (la línea aceptada, lo que se cobra); nulo sin nada aceptado. */
  agreedPriceCents?: number | null
  agreedCurrency?: string | null
  /** Sin nada aceptado, el que le ofrece su presupuesto: no es lo que se cobra. */
  offeredPriceCents?: number | null
  offeredCurrency?: string | null
  /** El diagnóstico con su nombre («Pulpitis (CIE-11 DA09.0)»), como lo dice el servidor. */
  diagnosisName?: string | null
  /** Va después de otro tratamiento de la misma pieza (la corona tras la endodoncia): lo dice el servidor. */
  waitsFor?: { id: string; title: string } | null
  /** Su consentimiento, si su servicio lo pide (consentimientos, 10 nov). */
  consent?: TreatmentConsentState | null
  /** Los consentimientos que faltan preparar, por su título (`treatmentConsentWords`). */
  consentMissing?: string[]
}

type PriceFields = Pick<PlanItem, "priceCents" | "currency" | "agreedPriceCents" | "agreedCurrency" | "offeredPriceCents" | "offeredCurrency">

/**
 * Lo que se cobra al hacerlo: el precio acordado si lo aceptó, si no el de la
 * indicación (QA de la ficha del 8 nov: la atención decía S/ 120 de lista con
 * S/ 90 acordado).
 */
export function agreedPriceOf(item: PriceFields): { priceCents: number | null; currency: string } {
  return item.agreedCurrency != null
    ? { priceCents: item.agreedPriceCents ?? null, currency: item.agreedCurrency }
    : { priceCents: item.priceCents, currency: item.currency }
}

/**
 * El precio que se dice de un tratamiento y de dónde sale: el acordado; si no
 * aceptó, el que le ofrece su presupuesto («en su presupuesto», no se cobra así
 * todavía); si no tiene presupuesto, el de la indicación.
 */
export function quotedPriceOf(item: PriceFields): { priceCents: number | null; currency: string; offered: boolean } {
  if (item.agreedCurrency != null) return { ...agreedPriceOf(item), offered: false }
  if (item.offeredCurrency != null)
    return { priceCents: item.offeredPriceCents ?? null, currency: item.offeredCurrency, offered: item.offeredPriceCents !== item.priceCents }
  return { priceCents: item.priceCents, currency: item.currency, offered: false }
}

export interface PlanItemPath {
  budgetId: string
  /** Sus opciones (1 = «Opción A»): casi siempre una. */
  positions: number[]
  /** El nombre que le puso quien lo preparó, si lo hay. */
  name: string | null
  pathCount: number
  /** Ya eligió un camino (este u otro). */
  chosen: boolean
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
  /** Le queda algo por hacer: no es un plan anterior aunque no reciba lo nuevo. */
  active?: boolean
}

/**
 * Los planes que se muestran como vigentes y los anteriores (QA del 6 nov, M12):
 * anterior es solo el que ya no tiene nada por hacer. Lo aceptado y programado
 * de un segundo plan abierto no se esconde en «Planes anteriores». Los vacíos
 * no cuentan como anteriores.
 */
export function splitPlans<T extends TreatmentPlanWithStatus>(plans: readonly T[]): { current: T[]; previous: T[] } {
  const current = plans.filter((row) => row.isOpen || row.active)
  // Sin ninguno abierto, el último sigue a la vista (como antes).
  const shown = current.length > 0 ? current : plans.slice(-1)
  return {
    current: shown,
    previous: plans.filter((row) => !shown.includes(row) && row.totalItems > 0),
  }
}

/**
 * Un formulario finalizado, para leerlo: cada pregunta que se hizo con su respuesta
 * en palabras, y sus adendas. Lo dice el servidor, igual que en la copia de la historia.
 */
export interface FormRecord {
  id: string
  title: string
  version: number
  /** Quién lo llenó y cuándo se finalizó, en una frase. */
  byWords: string
  /** «Correcciones» en lo que envió el paciente, «Adendas» en lo del equipo. */
  addendaTitle: string
  sections: Array<{
    id: string
    title: string
    /** `words` nulo: la pregunta se hizo y quedó sin respuesta. */
    items: Array<{ id: string; label: string; words: string | null }>
  }>
  addenda: Array<{ id: string; text: string; authorName: string | null; createdAt: string }>
}

/** Detalle de una atención: encuentro + piezas, procedimientos, notas, odontograma, documentos y adendas. */
export interface EncounterDetail {
  encounter: Encounter
  /** El motivo escrito al reservar su cita: se ofrece, no cuenta hasta que se confirma. */
  bookedReason: string | null
  teeth: number[]
  plannedItems: PlanItem[]
  indicatedItems: PlanItem[]
  /** Los presupuestos de lo indicado en ella, con su estado dicho («Eligió la opción A», «Anulado»). */
  budgets?: Array<{ id: string; budgetNumber: number; status: string; stateText: string; voidedWith?: boolean }>
  /** Lo que la atención deja por ejecutar, sin lo que la persona dejó fuera: lo cuenta el servidor. */
  pendingTreatments: number
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
  /** Los formularios finalizados en la atención, con sus respuestas: algo que se anotó en ella. */
  forms?: FormRecord[]
  /** Correcciones posteriores al cierre (kind='adenda'), orden ascendente. */
  addenda: ClinicalNote[]
  /** «Hoy viene a…» del borrador, como lo calcula el servidor; nulo si está firmada o anulada. */
  visit?: EncounterVisit | null
}

/** Un tratamiento aceptado por hacer, con la sesión que le toca hoy («sesión 2 de 2»). */
export interface VisitTreatment {
  planItemId: string
  title: string
  toothNumber: number | null
  n: number
  m: number
  started: boolean
  /** Ya está en esta atención (lo trajo su cita o «Hacerla hoy»). */
  linked: boolean
  /** Su sesión de hoy ya está registrada. */
  registered: boolean
  /** Lo trae la cita de esta atención: no se saca desde aquí. */
  broughtByAppointment: boolean
  /** Va después de otro tratamiento de la misma pieza (la corona tras la endodoncia); `today`: ese se hace hoy. */
  after?: { title: string; today: boolean } | null
  /** Su servicio pide esperar entre sesiones y aún no se cumple: `sinceDays` desde la última (0 = hoy). */
  wait?: { days: number; sinceDays: number; from: string } | null
  /** Su consentimiento, si su servicio lo pide; va con el tratamiento, aunque se preparara en otra atención. */
  consent?: TreatmentConsentState | null
  /** Los consentimientos que faltan preparar, por su título (`treatmentConsentWords`). */
  consentMissing?: string[]
}

/** Un control con su ventana abierta: esta visita lo cumple si se marca. */
export interface VisitControl {
  id: string
  title: string
  dueAt: string
  overdue: boolean
  byName: string | null
  chosen: boolean
  /** Reservado en la cita de esta atención: se cumple al firmar, sin elegirlo. */
  byAppointment?: boolean
}

export interface EncounterVisit {
  treatments: VisitTreatment[]
  moreTreatments: number
  controls: VisitControl[]
  /** Sin cita hoy: su próxima cita ya reservada. */
  booked?: { startsAt: string; serviceName: string | null } | null
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
  /** Motivo de una atención anulada (o de un archivo retirado): la historia la muestra con él. */
  voidReason?: string | null
  /** Un documento: cuándo se subió, que puede ser otro día que el de su fecha (`createdAt`). */
  uploadedAt?: string
  /** Quién atendió; en una anulada, quién y cuándo la anuló. */
  professionalName?: string | null
  /** Quién firmó la atención y cuándo. */
  signerName?: string | null
  signedAt?: string | null
  /** Un formulario: quién lo llenó, dicho por el servidor («Lo llenó Ana Torres»). */
  byText?: string | null
  /** Hecho de una atención que sigue en curso, sin firmar. */
  openEncounter?: boolean
  voidedByName?: string | null
  voidedAt?: string | null
  /** Lo que nació en la atención, dentro de su tarjeta (solo en la historia completa). */
  born?: EncounterBorn
  /** El periodontograma de la atención: un hecho de ella. */
  periodontal?: PeriodontalBrief | null
}

/** Lo nacido en una atención; lo anulado o cancelado viene con `retired` para plegarlo. */
export interface EncounterBorn {
  indicated: Array<{ id: string; title: string; where: string | null; stateText: string; retired: boolean; budgetId: string | null }>
  budgets: Array<{ id: string; budgetNumber: number; stateText: string; retired: boolean }>
  consents: Array<{ id: string; title: string; status: string; signerName: string | null; relation: string | null }>
  prescriptions: Array<{ id: string; number: number; detail: string; voided: boolean; reason: string | null }>
  orders: Array<{ id: string; title: string; state: string }>
  /**
   * Sus formularios: a medias o finalizado (y cuándo, y si fue después de firmar); `retired`, de una
   * atención anulada, que trae también los descartados con su motivo (`discardedWithAttention`: lo
   * descartó la propia anulación). `summary`: lo respondido en una línea, si lo hay.
   */
  forms: Array<{
    id: string
    title: string
    state: "a_medias" | "finalizado" | "descartado"
    finalizedAt: string | null
    afterSigning: boolean
    retired: boolean
    discardReason: string | null
    discardedWithAttention: boolean
    summary: string
  }>
  followUps: Array<{ id: string; title: string; dueAt: string; stateText: string; retired: boolean }>
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
  documents: Array<Pick<PatientDocument, "id" | "label" | "category"> & { capturedAt?: string | null }>
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
  /** La cita por venir que ya lo lleva, si tiene. */
  nextAppointmentAt?: string | null
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
  pendingConsents?: Array<{ id: string; title: string; personSignedAt?: string | null; linkSentAt?: string | null }>
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
  /**
   * Si se le preguntó por alergias («recorded», «none» = niega, «unknown» = no se
   * le preguntó): sin alergias registradas no es lo mismo. Solo a quien ve las
   * alergias; nulo para el resto.
   */
  allergyReview?: HealthReviewState | null
  /** El «No» a las alergias lo dijo la persona (o quien habla por ella) y nadie lo revisó: quién y cuándo. */
  allergySaidNo?: { by: HealthDeclarant; at: string | null } | null
  /**
   * Las alergias activas que dijo la persona y nadie revisó (y su «No»), por declaración: quién y
   * cuándo. Llega también a quien solo ve las alergias (recepción): nada más de su salud.
   */
  declaredAllergies?: Array<{ by: HealthDeclarant; at: string | null; allergies: string[]; saidNo: boolean }>
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

/** De lo que falta, lo suyo: lo que pide su enlace (el documento de su representante no lo completa ella). */
export function ownGaps<T extends { key: string }>(gaps: readonly T[]): T[] {
  return gaps.filter((gap) => gap.key !== "representativeDoc")
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

/** «Niega enfermedades» o «No toma medicación»: deja ese grupo en «niega», con quién y cuándo. */
export function markHealthDeniedApi(
  patientId: string,
  groups: Array<"conditions" | "medications">,
): Promise<{ data: PatientHealth }> {
  return apiFetch<{ data: PatientHealth }>(`/api/patients/${patientId}/health/denied`, {
    method: "POST",
    body: JSON.stringify({ groups }),
  })
}

export function markAllergiesReviewedApi(patientId: string): Promise<{ data: { reviewedAt: string } }> {
  return apiFetch<{ data: { reviewedAt: string } }>(`/api/patients/${patientId}/health/allergies/reviewed`, {
    method: "POST",
  })
}
