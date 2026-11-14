import {
  ALLERGY_SEVERITIES,
  PATIENT_DOCUMENT_CATEGORIES,
  BLOOD_GROUPS,
  type BloodGroup,
  codeAllergySubstance,
  declaredHealthAnswered,
  declaredMedicineAtc,
  knownHealthQuestions,
  MEDICATION_CLASSES,
  type MedicationClass,
  type MedicineClassAnswer,
  medicineClassAnswers,
  type RegistrationFieldKey,
  DOSE_UNITS,
  type DoseUnit,
  doseText,
  findHabitualMedication,
  type MedicationCatalog,
  MEDICATION_FREQUENCIES,
  MEDICATION_FREQUENCY_LABELS,
  type MedicationFrequency,
  type ImagingType,
  normalizeDrugText,
  normalizeTags,
  type RegistrationAnswers,
  REPORT_STATUSES,
  type ReportStatus,
  DECLARED_ONLINE_NOTE,
  registrationAnswersSchema,
  DIAGNOSIS_VERIFICATION,
  FAMILY_KINSHIP,
  type HealthAuthorship,
  type HealthDeclarant,
  healthReviewPending,
  KINSHIP_LABELS,
  legacyPregnancySaidOn,
  pregnancyRecordOf,
  isImageDocumentCategory,
  type PregnancyToday,
  pregnancyToday,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  type HEALTH_DECLARATION_VIAS,
  encounterProcedure,
  encounterSite,
  imagingStudy,
  imagingStudyFile,
  patient,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientContact,
  patientFamilyHistory,
  patientHealthDeclaration,
  patientDocument,
  patientDocumentContext,
  patientMedication,
  patientPayment,
  patientRegistration,
  prescription,
  treatmentBudget,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { consentDocument } from "@odentia/db/schema/clinical-forms"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { allergyReviewDue } from "./allergies.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import { invalidField, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { requirePatient } from "./patients.js"
import { assertAttending } from "./encounter-attending.js"
import { type ProductSite, type SiteColumns, withSite } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** El «dónde» del producto de la clínica (odentIA: piezas y caras). */
const siteOf = async (tx: Db, orgId: string): Promise<ProductSite> => (await productHooks(tx, orgId)).site

/**
 * La atención en borrador de este paciente, bloqueada para escribir en ella.
 * Con `actorUserId`, además la lleva quien escribe (ADR 0002); sin él (adjuntar
 * un documento, que puede subir otra persona del equipo), solo se une.
 */
export async function requireDraftLink(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
  actorUserId?: string,
): Promise<typeof encounter.$inferSelect> {
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
  if (!row) throw notFound("Atención")
  if (row.status === "anulada") throw conflict("VOIDED", "La atención está anulada")
  if (row.status !== "borrador") throw conflict("FINALIZED", "La atención está finalizada")
  if (actorUserId !== undefined) assertAttending(row, actorUserId)
  return row
}

/** Parentescos de los antecedentes familiares (HL7 v3 RoleCode, solo familiares). */
export const FAMILY_RELATIONSHIPS = FAMILY_KINSHIP
/** Clasificación del estado físico de la American Society of Anesthesiologists. */
export const ASA_CLASSES: readonly string[] = ["I", "II", "III", "IV", "V", "VI"]
const CONDITION_STATUSES = ["activa", "resuelta", "inactiva"] as const
/** Tipo de alérgeno; los anestésicos y materiales importan especialmente en odontología. */
export const ALLERGY_CATEGORIES = [
  "medicamento",
  "anestesico",
  "material",
  "alimento",
  "ambiental",
  "otro",
] as const
/**
 * Certeza de un diagnóstico codificado (HL7 FHIR Condition.verificationStatus).
 * «Ya diagnosticado antes» no es un tipo: lo marca el sistema (decisión 11).
 */
export const DIAGNOSIS_TYPES = DIAGNOSIS_VERIFICATION
const HEALTH_REVIEW_STATES = ["unknown", "none", "recorded"] as const
const DOCUMENT_CATEGORIES = PATIENT_DOCUMENT_CATEGORIES

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
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


function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}
// --- Agregado de salud (antecedentes + entrevista) ---
//
// Una sola operación transaccional guarda alergias, condiciones, medicación
// vigente y (opcionalmente) una nueva versión de la entrevista. Las filas se
// envían completas con sus IDs persistidos: omitir un ID es 400 (evita el
// borrado accidental) y archivar es explícito (isActive/status/endDate),
// nunca DELETE. La anamnesis sigue append-only; las colecciones de estado
// vigente se corrigen con auditoría dentro del agregado.

export type HealthReviewState = (typeof HEALTH_REVIEW_STATES)[number]

export interface HealthAllergyInput {
  id?: string
  substance: string
  /** Tipo de alérgeno (catálogo); opcional. */
  category?: string | null
  reaction?: string | null
  /** Sin dato se guarda «desconocida»: nunca se inventa una gravedad. */
  severity?: string | null
  /** Alergia o intolerancia; criticidad y verificación (HL7 FHIR AllergyIntolerance). */
  kind?: string | null
  criticality?: string | null
  verification?: string | null
  isActive?: boolean
}

export interface FamilyHistoryInput {
  relationship: string
  condition: string
  diagnosisCode?: string | null
  /** Lista del código; sin ella, la de la clínica. */
  diagnosisSystem?: string | null
  notes?: string | null
}

export interface HealthConditionInput {
  id?: string
  name: string
  /** Código de la lista de diagnósticos que precisa la condición; opcional. */
  diagnosisCode?: string | null
  /** Lista del código; sin ella, la de la clínica (un código ya guardado viaja con la suya). */
  diagnosisSystem?: string | null
  status: string
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
}

export interface HealthMedicationInput {
  id?: string
  name: string
  /** Principio activo (denominación común internacional); opcional. */
  genericName?: string | null
  /** La dosis escrita; con número y unidad UCUM se escribe sola («500 mg»). */
  dose?: string | null
  doseValue?: number | null
  doseUnit?: string | null
  /** La frecuencia escrita; elegida de la lista (`MEDICATION_FREQUENCIES`), se escribe sola. */
  frequency?: string | null
  frequencyCode?: string | null
  startDate?: string | null
  endDate?: string | null
  notes?: string | null
  /**
   * La clase que dijo quien respondió «Sí» a su pregunta («¿Tomas algún anticoagulante?»): la
   * fila nace con el código ATC de ese grupo. Solo vale en una declaración; lo que guarda el
   * equipo toma su código de la lista, como siempre.
   */
  declaredClass?: MedicationClass | null
}

export interface HealthReviewStatusInput {
  allergies: string
  conditions: string
  medications: string
}

export interface SavePatientHealthInput {
  expectedRevision: number
  reviewStatus: HealthReviewStatusInput
  /**
   * Sin enviarlas, las alergias quedan como están (y su revisión también): se
   * agregan y se quitan una por una (`allergies.ts`, tablero 7). Enviadas, van
   * completas con sus IDs, como el resto del agregado.
   */
  allergies?: HealthAllergyInput[]
  conditions: HealthConditionInput[]
  medications: HealthMedicationInput[]
  anamnesis?: { expectedVersion: number; answers: Record<string, unknown> }
  bloodGroup?: BloodGroup | null
  /** Reemplaza los antecedentes familiares cuando se envía. */
  familyHistory?: FamilyHistoryInput[]
  /** Clasificación ASA del estado físico (I–VI); null la limpia. */
  asaClass?: string | null
}

export type HealthAllergyRow = typeof patientAllergy.$inferSelect
export type HealthConditionRow = typeof patientCondition.$inferSelect
export type HealthMedicationRow = typeof patientMedication.$inferSelect
export type AnamnesisRow = typeof patientAnamnesis.$inferSelect

export interface PatientHealth {
  revision: number
  bloodGroup: BloodGroup | null
  asaClass: string | null
  familyHistory: Array<typeof patientFamilyHistory.$inferSelect>
  reviewedAt: Date | null
  reviewedBy: string | null
  reviewStatus: { allergies: string; conditions: string; medications: string }
  /** Quién revisó las alergias con el paciente y cuándo; pasados 6 meses toca preguntarle otra vez. */
  allergiesReviewedAt: Date | null
  allergiesReviewedBy: string | null
  allergyReviewDue: boolean
  /**
   * Lo declarado por el paciente espera la revisión de un profesional
   * (`healthReviewPending`): lo que solo anotó un clínico («Niega enfermedades»
   * en la atención) no lo deja pendiente.
   */
  reviewPending: boolean
  /** Lo que se dijo de su salud y nadie revisó, por declaración: quién, cuándo y qué. */
  declared: DeclaredHealthGroup[]
  /** El embarazo a hoy, con el día en que se dijo y la semana calculada; null si no hay. */
  pregnancy: PregnancyToday | null
  /** Lo que declaró de su salud, tal como llegó, de lo más nuevo a lo más antiguo («Ver declaración original»). */
  declarations: HealthDeclaration[]
  /**
   * Anticoagulantes y medicinas para los huesos: si toma (la marca de arriba), si dijo que no, si no
   * sabe o si nadie se lo preguntó (`medicineClassAnswers`). La atención lo dice tal cual.
   */
  medicineClasses: Record<MedicationClass, MedicineClassAnswer>
  allergies: HealthAllergyRow[]
  conditions: HealthConditionRow[]
  medications: HealthMedicationRow[]
  latestAnamnesis: AnamnesisRow | null
}

/**
 * Lo que alguien dijo de la salud de la persona en una misma declaración y
 * ningún profesional revisó todavía: quién lo dijo, cuándo y qué. Lo decide el
 * servidor, que sabe de qué declaración es cada cosa: la pantalla solo lo
 * escribe, igual en la franja, Antecedentes y la atención. Con más de una
 * declaración sin revisar hay un grupo por cada una: nada se le atribuye a
 * quien no lo dijo ni a otro día. Las alergias tienen su propia revisión
 * (`allergiesReviewedAt`).
 */
export interface DeclaredHealthGroup {
  by: HealthDeclarant
  /** Cuándo lo dijo; null si no consta. */
  at: Date | null
  /** Las alergias, enfermedades y medicinas que dijo y siguen sin revisar (ids). */
  allergies: string[]
  conditions: string[]
  medications: string[]
  /** El embarazo de la entrevista lo dijo en esta declaración y sigue sin revisar. */
  pregnancy: boolean
  /**
   * Lo demás de la entrevista que dijo en esta declaración y sigue sin revisar (`DECLARED_INTERVIEW`):
   * el corazón, el antibiótico, la anestesia, el tabaco y la lactancia, como el embarazo.
   */
  interview: DeclaredInterviewKey[]
  /** Su «No» a un grupo: lo dijo quien declaró, no lo preguntó ni lo anotó un profesional. */
  saidNo: { allergies: boolean; conditions: boolean; medications: boolean }
}

/**
 * Lo de la entrevista que puede decir la persona (entrega 6, QA del 14 nov, causa raíz): dónde lo
 * dice su declaración y dónde queda en la entrevista. Con eso cada dato sabe quién lo dijo y cuándo,
 * como las alergias y las medicinas, y no se lee como anotado por el equipo.
 */
/**
 * Si su «No» a los medicamentos quiere decir que no toma ninguno (QA del 14 nov, B1). Desde que «Tus
 * medicinas» pregunta aparte por el anticoagulante y los huesos, «¿algún otro medicamento?» con «No»
 * solo dice eso: es «ninguno» si también dijo que no a las dos clases que se le preguntaron. Un
 * registro de antes, con una sola pregunta, lo decía todo.
 */
export function declaredTakesNoMedicine(declared: Pick<DeclaredPatientHealthInput, "medications" | "anticoagulants" | "boneMedicines">): boolean {
  if (declared.medications?.state !== "none") return false
  return (["anticoagulants", "boneMedicines"] as const).every((key) => !declared[key] || declared[key]?.state === "none")
}

export const DECLARED_INTERVIEW = {
  corazon: { said: ["dental", "corazon", "riesgoEndocarditis"], kept: ["antecedentesOdontologicos", "corazon", "riesgoEndocarditis"] },
  antibiotico: { said: ["dental", "corazon", "antibioticoPrevio"], kept: ["antecedentesOdontologicos", "corazon", "antibioticoPrevio"] },
  anestesia: { said: ["dental", "problemaAnestesia"], kept: ["antecedentesOdontologicos", "problemaAnestesia"] },
  tabaco: { said: ["medical", "tabaco"], kept: ["habitos", "tabaco"] },
  alcohol: { said: ["medical", "alcohol"], kept: ["habitos", "alcohol"] },
  lactancia: { said: ["medical", "lactancia"], kept: ["embarazoLactancia", "lactancia"] },
} as const
export type DeclaredInterviewKey = keyof typeof DECLARED_INTERVIEW

/** Si lo que está en la entrevista es lo que dijo: la lactancia se dice Sí o No y se guarda con su día. */
function sameInterviewValue(key: DeclaredInterviewKey, said: unknown, kept: unknown): boolean {
  if (said === undefined) return false
  if (key === "lactancia") return isPlainObject(kept) && kept.estado === (said === true ? "si" : said === false ? "no" : undefined)
  return said === kept
}

/** Lo que hay en `value` siguiendo `path`, o undefined. */
function atPath(value: unknown, path: readonly string[]): unknown {
  let at = value
  for (const step of path) {
    if (!at || typeof at !== "object" || Array.isArray(at)) return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at
}

/** Una declaración de salud como llegó: no cambia aunque el equipo corrija lo vigente. */
export interface HealthDeclaration {
  /** Cuándo lo dijo. */
  at: Date
  /** Cuándo entró a su ficha (el instante de su registro, si vino con él). */
  enteredAt: Date
  via: (typeof HEALTH_DECLARATION_VIAS)[number]
  by: HealthDeclarant
  health: DeclaredPatientHealthInput
}

/**
 * Un texto de antecedentes: `field` es el nombre del dato en el cuerpo
 * (`conditions[0].name`) para decir el error junto a él.
 */
function assertText(
  value: string | null | undefined,
  max: number,
  field: string,
  required: false,
): string | null
function assertText(
  value: string | null | undefined,
  max: number,
  field: string,
  required: true,
  emptyMessage: string,
): string
function assertText(
  value: string | null | undefined,
  max: number,
  field: string,
  required: boolean,
  emptyMessage?: string,
): string | null {
  const trimmed = value?.trim() ?? ""
  if (!trimmed) {
    if (required) throw invalidField(field, emptyMessage ?? "Completa este dato.")
    return null
  }
  if (trimmed.length > max) throw invalidField(field, `Escribe como mucho ${max} caracteres.`)
  return trimmed
}

function assertDateStr(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || value === "") return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalidField(field, "Escribe una fecha válida")
  const [y, m, d] = value.split("-").map(Number)
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== (m as number) - 1 ||
    date.getUTCDate() !== d
  ) {
    throw invalidField(field, "Escribe una fecha válida")
  }
  return value
}

/** El fin antes del inicio: se dice en el fin (`endField`). */
function assertDateRange(start: string | null, end: string | null, endField: string): void {
  if (start && end && start > end) throw invalidField(endField, "El fin no puede ser anterior al inicio")
}

/** Claves que la entrevista nueva no acepta: viven en la atención o en listas estructuradas. */
const FORBIDDEN_ANAMNESIS_TOP = [
  "motivoConsulta",
  "tiempoEnfermedad",
  "examenClinico",
  "diagnosticoPresuntivo",
  "diagnosticoCie10",
]

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Lo declarado encima de la entrevista guardada, campo por campo: un grupo no reemplaza al otro entero. */
/**
 * Lo que dijo, sumado a la entrevista que había, campo por campo: llena lo que falta y no pisa lo
 * que ya estaba (QA del 14 nov, B2: volver a registrarse y «Sí, sin cambios» cambiaba el tabaco, la
 * anestesia y la lactancia que había anotado el equipo). Lo distinto queda en su declaración, a la
 * vista en «Ver declaración original». El embarazo y la lactancia sí toman lo último que dijo: son de
 * un momento y llevan el día en que se dijo.
 */
function mergeInterview(saved: Record<string, unknown>, said: Record<string, unknown>, path: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...saved }
  for (const [key, value] of Object.entries(said)) {
    const here = [...path, key]
    if (isPlainObject(out[key]) && isPlainObject(value) && !DATED_INTERVIEW.has(here.join("."))) out[key] = mergeInterview(out[key], value, here)
    else if (out[key] === undefined || DATED_INTERVIEW.has(here.join("."))) out[key] = value
  }
  return out
}

/** Lo de la entrevista que es de un momento: lo último que dijo reemplaza lo de antes. */
const DATED_INTERVIEW = new Set(["embarazoLactancia.embarazo", "embarazoLactancia.lactancia", "antecedentesPersonales.embarazo"])

/** Sin lo que ya no pertenece a la entrevista (`assertNewInterview`): sigue en las versiones de antes. */
function withoutRetiredInterview(answers: Record<string, unknown>): Record<string, unknown> {
  const out = { ...answers }
  for (const key of FORBIDDEN_ANAMNESIS_TOP) delete out[key]
  if (isPlainObject(out.antecedentesPersonales)) {
    const { enfermedades: _enfermedades, medicacionHabitual: _medicacion, ...rest } = out.antecedentesPersonales
    out.antecedentesPersonales = rest
  }
  return out
}

function assertNewInterview(answers: Record<string, unknown>): Record<string, unknown> {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw validation("answers debe ser un objeto")
  }
  for (const key of FORBIDDEN_ANAMNESIS_TOP) {
    if (answers[key] !== undefined) {
      throw validation(
        `${key} ya no pertenece a la entrevista: se captura en la atención o en listas estructuradas`,
      )
    }
  }
  const personales = answers["antecedentesPersonales"]
  if (personales !== undefined) {
    if (!personales || typeof personales !== "object" || Array.isArray(personales)) {
      throw validation("antecedentesPersonales debe ser un objeto")
    }
    const rec = personales as Record<string, unknown>
    if (rec["enfermedades"] !== undefined || rec["medicacionHabitual"] !== undefined) {
      throw validation(
        "enfermedades/medicacionHabitual en texto libre ya no se aceptan: usa las listas estructuradas",
      )
    }
  }
  return answers
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? ""
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

interface ValidatedAllergy {
  id: string | null
  substance: string
  category: string | null
  reaction: string | null
  severity: string
  kind: string
  criticality: string | null
  verification: string
  isActive: boolean
}

interface ValidatedCondition {
  id: string | null
  name: string
  diagnosisCode: string | null
  diagnosisSystem: string | null
  status: string
  startDate: string | null
  endDate: string | null
  notes: string | null
}

interface ValidatedMedication {
  id: string | null
  name: string
  genericName: string | null
  atcCode: string | null
  dose: string | null
  doseValue: string | null
  doseUnit: string | null
  frequency: string | null
  frequencyCode: string | null
  startDate: string | null
  endDate: string | null
  notes: string | null
}

function validateAllergyRow(input: HealthAllergyInput, index: number): ValidatedAllergy {
  const at = `allergies[${index}]`
  const substance = assertText(input.substance, 200, `${at}.substance`, true, "Escribe la sustancia")
  const reaction = assertText(input.reaction, 2000, `${at}.reaction`, false)
  const severity = input.severity?.trim() || "desconocida"
  if (!(ALLERGY_SEVERITIES as readonly string[]).includes(severity)) {
    throw invalidField(`${at}.severity`, "Elige qué tan fuerte fue la reacción: leve, moderada, severa o no se sabe")
  }
  const kind = input.kind?.trim() || "alergia"
  if (!["alergia", "intolerancia"].includes(kind))
    throw invalidField(`${at}.kind`, "Elige si es alergia o intolerancia")
  const criticality = input.criticality?.trim() || null
  if (criticality && !["baja", "alta", "no_evaluable"].includes(criticality))
    throw invalidField(`${at}.criticality`, "Elige la criticidad de la lista")
  const verification = input.verification?.trim() || "no_confirmada"
  if (!["no_confirmada", "confirmada", "descartada"].includes(verification))
    throw invalidField(`${at}.verification`, "Elige la verificación de la lista")
  const category = input.category?.trim() || null
  if (category && !(ALLERGY_CATEGORIES as readonly string[]).includes(category))
    throw invalidField(`${at}.category`, "Elige el tipo de alérgeno de la lista")
  return {
    id: input.id ?? null,
    substance,
    category,
    reaction,
    severity,
    kind,
    criticality,
    verification,
    isActive: input.isActive ?? true,
  }
}

function validateConditionRow(input: HealthConditionInput, index: number): ValidatedCondition {
  const at = `conditions[${index}]`
  const name = assertText(input.name, 200, `${at}.name`, true, "Escribe el nombre")
  if (!(CONDITION_STATUSES as readonly string[]).includes(input.status))
    throw invalidField(`${at}.status`, "Elige el estado de la lista")
  const startDate = assertDateStr(input.startDate, `${at}.startDate`)
  let endDate = assertDateStr(input.endDate, `${at}.endDate`)
  if (!endDate && input.status === "resuelta") endDate = todayDate()
  assertDateRange(startDate, endDate, `${at}.endDate`)
  const notes = assertText(input.notes, 2000, `${at}.notes`, false)
  const diagnosisCode = input.diagnosisCode?.trim() || null
  const diagnosisSystem = diagnosisCode ? input.diagnosisSystem?.trim() || null : null
  return { id: input.id ?? null, name, diagnosisCode, diagnosisSystem, status: input.status, startDate, endDate, notes }
}

function validateMedicationRow(
  input: HealthMedicationInput,
  index: number,
  habitual: MedicationCatalog["habitual"],
  /** Si se acepta la clase que trae la fila: solo en lo que declara la persona. */
  declaration = false,
): ValidatedMedication {
  const at = `medications[${index}]`
  const name = assertText(input.name, 200, `${at}.name`, true, "Escribe el nombre")
  const genericName = assertText(input.genericName, 200, `${at}.genericName`, false)
  // La DCI de la lista del producto lleva su código ATC, el mismo de la receta (latidIA sugiere
  // también lo que receta, ADR 0143); lo escrito a mano, ninguno. Lo que la persona dijo al responder
  // «Sí» a la pregunta de una clase lleva el código de ese grupo (`declaredMedicineAtc`).
  const atcCode =
    declaration && input.declaredClass
      ? declaredMedicineAtc(input.declaredClass, genericName ?? name, habitual)
      : (findHabitualMedication(genericName ?? name, habitual)?.atc ?? null)
  const doseUnit = input.doseUnit?.trim() || null
  const doseValue = input.doseValue ?? null
  // La dosis lleva número y unidad, o ninguno de los dos: se dice en el que falta.
  if (doseValue !== null && doseUnit === null) throw invalidField(`${at}.doseUnit`, "Elige la unidad")
  if (doseValue === null && doseUnit !== null)
    throw invalidField(`${at}.doseValue`, "Escribe la dosis o quita la unidad")
  if (doseUnit && !(DOSE_UNITS as readonly string[]).includes(doseUnit))
    throw invalidField(`${at}.doseUnit`, "Elige la unidad de la lista")
  if (doseValue !== null && (!Number.isFinite(doseValue) || doseValue <= 0 || doseValue >= 10_000_000))
    throw invalidField(`${at}.doseValue`, "Escribe la dosis con un número mayor que cero")
  const frequencyCode = input.frequencyCode?.trim() || null
  if (frequencyCode && !(MEDICATION_FREQUENCIES as readonly string[]).includes(frequencyCode))
    throw invalidField(`${at}.frequencyCode`, "Elige la frecuencia de la lista")
  // Lo escrito acompaña siempre a lo estructurado, para leerlo igual que antes.
  const dose =
    doseValue !== null && doseUnit
      ? doseText(doseValue, doseUnit as DoseUnit)
      : assertText(input.dose, 200, `${at}.dose`, false)
  const frequency = frequencyCode
    ? MEDICATION_FREQUENCY_LABELS[frequencyCode as MedicationFrequency]
    : assertText(input.frequency, 200, `${at}.frequency`, false)
  const startDate = assertDateStr(input.startDate, `${at}.startDate`)
  const endDate = assertDateStr(input.endDate, `${at}.endDate`)
  assertDateRange(startDate, endDate, `${at}.endDate`)
  const notes = assertText(input.notes, 2000, `${at}.notes`, false)
  return {
    id: input.id ?? null,
    name,
    genericName,
    atcCode,
    dose,
    doseValue: doseValue === null ? null : String(doseValue),
    doseUnit,
    frequency,
    frequencyCode,
    startDate,
    endDate,
    notes,
  }
}
export async function getPatientHealth(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<PatientHealth> {
  await requirePatient(tx, orgId, patientId)
  const [header] = await tx
    .select({
      revision: patient.healthRevision,
      reviewStatus: patient.healthReviewStatus,
      bloodGroup: patient.bloodGroup,
      asaClass: patient.asaClass,
      reviewedAt: patient.healthReviewedAt,
      reviewedBy: patient.healthReviewedBy,
      allergiesReviewedAt: patient.allergiesReviewedAt,
      allergiesReviewedBy: patient.allergiesReviewedBy,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!header) throw notFound("Paciente")
  const [allergies, conditions, medications, latest] = await Promise.all([
    tx
      .select()
      .from(patientAllergy)
      .where(and(eq(patientAllergy.patientId, patientId), eq(patientAllergy.organizationId, orgId)))
      .orderBy(sql`"is_active" desc`, desc(patientAllergy.createdAt)),
    tx
      .select()
      .from(patientCondition)
      .where(
        and(eq(patientCondition.patientId, patientId), eq(patientCondition.organizationId, orgId)),
      )
      .orderBy(
        sql`case "status" when 'activa' then 0 when 'inactiva' then 1 else 2 end`,
        desc(patientCondition.createdAt),
      ),
    tx
      .select()
      .from(patientMedication)
      .where(
        and(
          eq(patientMedication.patientId, patientId),
          eq(patientMedication.organizationId, orgId),
        ),
      )
      .orderBy(sql`"end_date" nulls first`, desc(patientMedication.createdAt)),
    tx
      .select()
      .from(patientAnamnesis)
      .where(
        and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)),
      )
      .orderBy(desc(patientAnamnesis.version))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ])
  const reviewStatus = (header.reviewStatus ?? {}) as Record<string, unknown>
  const stateOf = (value: unknown): string =>
    value === "none" || value === "recorded" ? (value as string) : "unknown"
  const familyHistory = await tx
    .select()
    .from(patientFamilyHistory)
    .where(
      and(
        eq(patientFamilyHistory.organizationId, orgId),
        eq(patientFamilyHistory.patientId, patientId),
      ),
    )
    .orderBy(asc(patientFamilyHistory.createdAt))
  const health = {
    revision: header.revision,
    bloodGroup: header.bloodGroup,
    asaClass: header.asaClass,
    familyHistory,
    reviewedAt: header.reviewedAt,
    reviewedBy: header.reviewedBy,
    reviewStatus: {
      allergies: stateOf(reviewStatus["allergies"]),
      conditions: stateOf(reviewStatus["conditions"]),
      medications: stateOf(reviewStatus["medications"]),
    },
    allergiesReviewedAt: header.allergiesReviewedAt,
    allergiesReviewedBy: header.allergiesReviewedBy,
    allergyReviewDue: allergyReviewDue(header.allergiesReviewedAt),
    allergies,
    conditions,
    medications,
    latestAnamnesis: latest,
  }
  const authorship = await healthAuthorshipOf(tx, orgId, patientId)
  const reviewPending = healthReviewPending(health, authorship)
  const declarations = await healthDeclarationsOf(tx, orgId, patientId)
  const today = await clinicToday(tx, orgId)
  // Lo guardado antes sin fecha toma la del día en que se anotó ese «sí»: sale de las versiones de la
  // entrevista, al leer, sin reescribir ninguna.
  let legacySaidOn: string | null = null
  const record = pregnancyRecordOf(latest?.answers)
  if (record?.estado === "si" && !record.fecha) {
    const versions = await tx
      .select({ answers: patientAnamnesis.answers, createdAt: patientAnamnesis.createdAt })
      .from(patientAnamnesis)
      .where(and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)))
      .orderBy(desc(patientAnamnesis.version))
    const days: Array<{ answers: unknown; day: string }> = []
    for (const version of versions)
      days.push({ answers: version.answers, day: await clinicToday(tx, orgId, version.createdAt) })
    legacySaidOn = legacyPregnancySaidOn(days)
  }
  const pregnancy = pregnancyToday(latest?.answers, today, { legacySaidOn })
  return {
    ...health,
    reviewPending,
    declared: declaredGroupsOf({ health, reviewPending, authorship, declarations, latest, pregnancy }),
    pregnancy,
    declarations,
    medicineClasses: medicineClassAnswers({
      reviewStatus: health.reviewStatus,
      declarations,
      // Lo que toma hoy: sin fin, o con un fin que aún no llega.
      current: medications.filter((row) => !row.endDate || row.endDate >= today),
      ended: medications.filter((row) => !!row.endDate && row.endDate < today),
    }),
  }
}

/**
 * Si una salud declarada dice algo: la misma regla con que el registro y el
 * enlace deciden si dejan declaración (`declaredHealthAnswered`), también para
 * leerlas: la copia de 0114 trajo también los registros con todo «sin
 * responder», y esos no son una declaración (QA del 14 nov, H9 de desarrollo;
 * la migración no se cambia porque otras ramas ya la tienen). Un «no tomo
 * anticoagulantes» sí lo es.
 */
export function hasMeaningfulHealth(health: Partial<NonNullable<RegistrationAnswers["health"]>> | null | undefined): boolean {
  return !!health && typeof health === "object" && declaredHealthAnswered(health as RegistrationAnswers["health"])
}

/** Los datos de salud del registro que ya se saben de la persona (`knownHealthQuestions`). */
export function knownHealthQuestionsOf(health: PatientHealth): Set<RegistrationFieldKey> {
  return knownHealthQuestions({
    bloodGroup: health.bloodGroup,
    reviewStatus: health.reviewStatus,
    activeAllergies: health.allergies.filter((row) => row.isActive && row.verification !== "descartada").length,
    medications: health.medications,
    interview: (health.latestAnamnesis?.answers ?? null) as Record<string, unknown> | null,
    declarations: health.declarations,
  })
}

/** Las declaraciones de salud de la persona que dicen algo, de la más nueva a la más antigua. */
async function healthDeclarationsOf(tx: Db, orgId: string, patientId: string): Promise<HealthDeclaration[]> {
  const rows = await tx
    .select()
    .from(patientHealthDeclaration)
    .where(and(eq(patientHealthDeclaration.organizationId, orgId), eq(patientHealthDeclaration.patientId, patientId)))
    .orderBy(desc(patientHealthDeclaration.createdAt))
    .limit(50)
  return rows.filter((row) => hasMeaningfulHealth(row.health as Parameters<typeof hasMeaningfulHealth>[0])).map((row) => ({
    at: row.saidAt,
    enteredAt: row.createdAt,
    via: row.via,
    by: { kind: row.respondent, name: row.declarantName, relation: row.declarantRelation },
    health: row.health,
  }))
}

const UNKNOWN_DECLARANT: HealthDeclarant = { kind: "unknown", name: null, relation: null }

/**
 * Lo que sigue sin revisar, agrupado por la declaración que lo trajo. Cada fila
 * de Antecedentes entró en la misma transacción que su declaración
 * (`recordHealthDeclaration`), así que comparten el instante: de ahí salen
 * quién lo dijo y cuándo. Lo que no tiene declaración (lo anterior a guardarla)
 * queda en un grupo sin autor, con la fecha en que entró: no se afirma quién.
 */
function declaredGroupsOf(input: {
  health: Pick<PatientHealth, "allergies" | "conditions" | "medications" | "reviewStatus" | "allergiesReviewedAt">
  reviewPending: boolean
  authorship: HealthAuthorshipDetail
  declarations: HealthDeclaration[]
  latest: AnamnesisRow | null
  pregnancy: PregnancyToday | null
}): DeclaredHealthGroup[] {
  const { health, reviewPending, authorship, declarations, latest } = input
  const groups = new Map<string, DeclaredHealthGroup>()
  const groupOf = (declaration: HealthDeclaration | undefined, fallbackAt: Date | null): DeclaredHealthGroup => {
    // Sin declaración, un grupo por día en que entró: lo de dos días no se junta bajo una fecha.
    const key = declaration ? `d:${declaration.enteredAt.getTime()}` : `?:${fallbackAt?.toISOString().slice(0, 10) ?? ""}`
    let group = groups.get(key)
    if (!group) {
      group = {
        by: declaration?.by ?? UNKNOWN_DECLARANT,
        at: declaration?.at ?? fallbackAt,
        allergies: [],
        conditions: [],
        medications: [],
        pregnancy: false,
        interview: [],
        saidNo: { allergies: false, conditions: false, medications: false },
      }
      groups.set(key, group)
    }
    return group
  }
  const enteredWith = (at: Date) => declarations.find((row) => row.enteredAt.getTime() === at.getTime())
  // Lo que entró después del último guardado del equipo, con la salud aún por revisar, lo dijo la persona.
  const sinceStaff = (at: Date) => !authorship.staffSavedAt || at > authorship.staffSavedAt
  const allergiesReviewed = health.allergiesReviewedAt
  for (const row of health.allergies) {
    if (!row.isActive || row.source !== "paciente" || row.verification === "descartada") continue
    if (allergiesReviewed && row.createdAt <= allergiesReviewed) continue
    groupOf(enteredWith(row.createdAt), row.createdAt).allergies.push(row.id)
  }
  if (reviewPending) {
    for (const row of health.conditions)
      if (sinceStaff(row.createdAt)) groupOf(enteredWith(row.createdAt), row.createdAt).conditions.push(row.id)
    for (const row of health.medications)
      if (sinceStaff(row.createdAt)) groupOf(enteredWith(row.createdAt), row.createdAt).medications.push(row.id)
    if (input.pregnancy && latest && sinceStaff(latest.createdAt)) {
      // El embarazo vigente lo dijo la última declaración que lo respondió.
      const said = declarations.find((row) => typeof row.health.personal?.embarazo === "boolean")
      groupOf(said, latest.createdAt).pregnancy = true
    }
    if (latest && sinceStaff(latest.createdAt)) {
      // Cada dato de la entrevista que está y que dijo una declaración: de la última que lo respondió.
      for (const [key, where] of Object.entries(DECLARED_INTERVIEW) as Array<[DeclaredInterviewKey, (typeof DECLARED_INTERVIEW)[DeclaredInterviewKey]]>) {
        const kept = atPath(latest.answers, where.kept)
        if (kept === undefined) continue
        // Lo que anotó el equipo no lleva la marca de ella aunque ella haya dicho otra cosa.
        const said = declarations.find((row) => sameInterviewValue(key, atPath(row.health, where.said), kept))
        if (said) groupOf(said, latest.createdAt).interview.push(key)
      }
    }
  }
  // Su «No» es de la última declaración que lo dijo; sin ella, de cuando consta que declaró.
  const saidNo = {
    allergies: allergiesSaidNo(health.reviewStatus.allergies, allergiesReviewed, authorship),
    conditions:
      reviewPending && health.reviewStatus.conditions === "none" && !authorship.deniedGroups.includes("conditions"),
    medications:
      reviewPending && health.reviewStatus.medications === "none" && !authorship.deniedGroups.includes("medications"),
  }
  for (const topic of ["allergies", "conditions", "medications"] as const) {
    if (!saidNo[topic]) continue
    const said = declarations.find((row) => row.health[topic]?.state === "none")
    groupOf(said, authorship.declaredAt).saidNo[topic] = true
  }
  return [...groups.values()].sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
}

/**
 * El «No» a las alergias lo dijo la persona (o quien habla por ella) y nadie del
 * equipo lo revisó con ella: no es el «niega» que anota quien se lo pregunta.
 */
function allergiesSaidNo(state: string, reviewedAt: Date | null, authorship: HealthAuthorship): boolean {
  return state === "none" && !reviewedAt && authorship.declaredByPatient
}

/**
 * Lo mismo para quien solo ve las alergias (recepción, `clinical.alerts`): si el
 * «No» de la ficha lo dijo la persona y sigue sin revisar, quién lo dijo y
 * cuándo. Nada más de su salud. null si no es un «No» declarado.
 */
export async function allergiesSaidNoByPatient(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ by: HealthDeclarant; at: Date | null } | null> {
  const [header] = await tx
    .select({ reviewStatus: patient.healthReviewStatus, allergiesReviewedAt: patient.allergiesReviewedAt })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!header) throw notFound("Paciente")
  const state = (header.reviewStatus as { allergies?: unknown } | null)?.allergies
  if (state !== "none" || header.allergiesReviewedAt) return null
  const authorship = await healthAuthorshipOf(tx, orgId, patientId)
  if (!allergiesSaidNo("none", null, authorship)) return null
  const said = (await healthDeclarationsOf(tx, orgId, patientId)).find((row) => row.health.allergies?.state === "none")
  return said ? { by: said.by, at: said.at } : { by: UNKNOWN_DECLARANT, at: authorship.declaredAt }
}

/**
 * Lo que recepción (`clinical.alerts`) puede saber de lo declarado: qué alergias
 * activas dijo la persona y nadie revisó, y su «No» a las alergias, con quién lo
 * dijo y cuándo (QA del 14 nov, H5 de clínica). Es la misma regla de
 * `health.declared` (`declaredGroupsOf`), leída solo con las alergias: sin
 * enfermedades, medicación ni embarazo, y la salida se arma campo por campo
 * para que nada más viaje aunque la regla crezca.
 */
export async function declaredAllergiesByPatient(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<Array<{ by: HealthDeclarant; at: Date | null; allergies: string[]; saidNo: boolean }>> {
  const [header] = await tx
    .select({ reviewStatus: patient.healthReviewStatus, allergiesReviewedAt: patient.allergiesReviewedAt })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!header) throw notFound("Paciente")
  const allergies = await tx
    .select()
    .from(patientAllergy)
    .where(
      and(
        eq(patientAllergy.patientId, patientId),
        eq(patientAllergy.organizationId, orgId),
        eq(patientAllergy.isActive, true),
      ),
    )
  const state = (header.reviewStatus as { allergies?: unknown } | null)?.allergies
  const groups = declaredGroupsOf({
    health: {
      allergies,
      conditions: [],
      medications: [],
      reviewStatus: {
        allergies: state === "none" || state === "recorded" ? state : "unknown",
        conditions: "unknown",
        medications: "unknown",
      },
      allergiesReviewedAt: header.allergiesReviewedAt,
    },
    reviewPending: false,
    authorship: await healthAuthorshipOf(tx, orgId, patientId),
    declarations: await healthDeclarationsOf(tx, orgId, patientId),
    latest: null,
    pregnancy: null,
  })
  return groups
    .filter((group) => group.allergies.length > 0 || group.saidNo.allergies)
    .map((group) => ({ by: group.by, at: group.at, allergies: group.allergies, saidNo: group.saidNo.allergies }))
}

/**
 * Quien respondió, visto desde su contacto: la propia persona o quien habla
 * por ella, con su nombre y su vínculo en palabras (el parentesco de HL7 si se
 * conoce, o el escrito al vincularlo). Es la misma forma para la franja de la
 * ficha y para el detalle de un cuestionario: nombran a la misma persona.
 */
export async function declarantOfContact(
  tx: Db,
  orgId: string,
  patientId: string,
  contactId: string | null,
): Promise<HealthDeclarant> {
  if (!contactId) return UNKNOWN_DECLARANT
  const [row] = await tx
    .select({
      name: contact.displayName,
      relationship: patientContact.relationship,
      relationshipDetail: patientContact.relationshipDetail,
      kinship: patientContact.kinship,
    })
    .from(contact)
    .leftJoin(
      patientContact,
      and(
        eq(patientContact.organizationId, contact.organizationId),
        eq(patientContact.contactId, contact.id),
        eq(patientContact.patientId, patientId),
      ),
    )
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  if (!row) return UNKNOWN_DECLARANT
  return declarantOfLink(row)
}

/** Lo mismo, con el vínculo ya leído. */
export function declarantOfLink(link: {
  name: string
  relationship: string | null
  relationshipDetail: string | null
  kinship: string | null
}): HealthDeclarant {
  if (link.relationship === "self") return { kind: "patient", name: link.name, relation: null }
  const kin =
    link.kinship && link.kinship in KINSHIP_LABELS
      ? KINSHIP_LABELS[link.kinship as keyof typeof KINSHIP_LABELS]
      : link.relationshipDetail?.trim()
  return { kind: "representative", name: link.name, relation: kin ? kin.toLocaleLowerCase("es") : null }
}

/**
 * Quien respondió un registro: la persona, quien la registró (con el nombre y
 * el parentesco que escribió) o el equipo, que anotó lo que le dijeron.
 */
export function declarantOfRegistration(answers: Pick<RegistrationAnswers, "respondent" | "representative">): HealthDeclarant {
  if (answers.respondent === "staff") return { kind: "staff", name: null, relation: null }
  if (answers.respondent === "patient") return { kind: "patient", name: null, relation: null }
  return {
    kind: "representative",
    name: answers.representative?.displayName?.trim() || null,
    relation: answers.representative?.relationshipDetail?.trim().toLocaleLowerCase("es") || null,
  }
}

/**
 * Deja constancia de una declaración de salud: lo que se dijo tal como llegó,
 * quién lo dijo y cuándo. Va en la misma transacción que las filas de
 * Antecedentes que trae (comparten el instante en que entraron): así cada cosa
 * sin revisar dice de quién es y de cuándo. `saidAt`: cuándo lo dijo, si fue
 * antes de entrar a su ficha (un registro resuelto después, un cuestionario
 * revisado otro día).
 */
export async function recordHealthDeclaration(
  tx: Db,
  orgId: string,
  patientId: string,
  input: {
    via: (typeof HEALTH_DECLARATION_VIAS)[number]
    by: HealthDeclarant
    health: DeclaredPatientHealthInput
    saidAt?: Date | null
  },
): Promise<void> {
  if (input.by.kind === "unknown") return
  await tx.insert(patientHealthDeclaration).values({
    organizationId: orgId,
    patientId,
    via: input.via,
    respondent: input.by.kind,
    declarantName: input.by.kind === "representative" ? (input.by.name?.slice(0, 200) ?? null) : null,
    declarantRelation: input.by.kind === "representative" ? (input.by.relation?.slice(0, 80) ?? null) : null,
    health: input.health,
    ...(input.saidAt ? { saidAt: input.saidAt } : {}),
  })
}

/** Lo que el servidor sabe, además, de quién escribió los antecedentes y cuándo. */
interface HealthAuthorshipDetail extends HealthAuthorship {
  /** La última vez que la persona declaró algo de su salud. */
  declaredAt: Date | null
  /** La última vez que el equipo guardó (y con eso revisó) sus antecedentes. */
  staffSavedAt: Date | null
  /** Los grupos que un clínico negó en la atención («Niega enfermedades»). */
  deniedGroups: string[]
}

/**
 * Quién escribió los antecedentes, según la auditoría: si el paciente los declaró
 * alguna vez (`health.declared`, o sus alergias en un cuestionario) y si un clínico negó un grupo en la atención
 * (`health.denied`). Se lee de lo que ya pasó: también corrige a quien quedó
 * «por revisar» por una negación antes de este cambio.
 */
async function healthAuthorshipOf(tx: Db, orgId: string, patientId: string): Promise<HealthAuthorshipDetail> {
  const rows = await tx
    .select({ action: auditEvent.action, at: auditEvent.createdAt, metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(
      and(
        eq(auditEvent.organizationId, orgId),
        eq(auditEvent.entity, "patient"),
        eq(auditEvent.entityId, patientId),
        inArray(auditEvent.action, ["health.declared", "health.allergies_declared", "health.denied", "health.saved"]),
      ),
    )
  const latest = (actions: string[]): Date | null =>
    rows.reduce<Date | null>(
      (last, row) => (actions.includes(row.action) && (!last || row.at > last) ? row.at : last),
      null,
    )
  const denied = rows.filter((row) => row.action === "health.denied")
  return {
    declaredByPatient: rows.some((row) => row.action === "health.declared" || row.action === "health.allergies_declared"),
    deniedByClinician: denied.length > 0,
    declaredAt: latest(["health.declared", "health.allergies_declared"]),
    staffSavedAt: latest(["health.saved"]),
    deniedGroups: [
      ...new Set(
        denied.flatMap((row) => {
          const groups = (row.metadata as { groups?: unknown } | null)?.groups
          return Array.isArray(groups) ? groups.filter((group): group is string => typeof group === "string") : []
        }),
      ),
    ],
  }
}

function assertReviewStatus(input: HealthReviewStatusInput): {
  allergies: string
  conditions: string
  medications: string
} {
  if (!input || typeof input !== "object") throw invalidField("reviewStatus", "Elige la revisión de cada grupo")
  const record: Record<string, unknown> = {
    allergies: input.allergies,
    conditions: input.conditions,
    medications: input.medications,
  }
  const expected = ["allergies", "conditions", "medications"]
  for (const key of expected) {
    if (!(HEALTH_REVIEW_STATES as readonly string[]).includes(record[key] as string)) {
      throw invalidField(`reviewStatus.${key}`, "Elige la revisión del grupo")
    }
  }
  for (const key of Object.keys(input)) {
    if (!expected.includes(key)) throw invalidField(`reviewStatus.${key}`, "Ese grupo no se revisa aquí")
  }
  return {
    allergies: input.allergies,
    conditions: input.conditions,
    medications: input.medications,
  }
}
export type DeclaredPatientHealthInput = NonNullable<RegistrationAnswers["health"]>

/**
 * La medicación que declaró, como filas: primero lo que dijo al responder «Sí»
 * a anticoagulantes y a medicinas para los huesos, con su clase (de ahí sale la
 * marca de la ficha), y después lo de «algún otro». Lo que repitió con el mismo
 * nombre en «algún otro» no se duplica.
 */
export function declaredMedications(
  declared: DeclaredPatientHealthInput,
): Array<HealthMedicationInput & { declaredClass: MedicationClass | null }> {
  const rows: Array<HealthMedicationInput & { declaredClass: MedicationClass | null }> = []
  const seen = new Set<string>()
  for (const group of ["anticoagulants", "boneMedicines"] as const) {
    const answer = declared[group]
    if (answer?.state !== "recorded") continue
    // Sin decir cuál, la fila lo dice (`MEDICATION_CLASSES[group].unnamed`).
    const name = answer.detail?.trim() || MEDICATION_CLASSES[group].unnamed
    seen.add(normalizeDrugText(name))
    rows.push({ name, declaredClass: group })
  }
  for (const item of declared.medications?.state === "recorded" ? declared.medications.items : []) {
    const key = normalizeDrugText(item.name)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ ...item, declaredClass: null })
  }
  return rows
}

export async function initializeDeclaredPatientHealth(
  tx: Db,
  orgId: string,
  patientId: string,
  input: DeclaredPatientHealthInput,
  actorUserId: string | null,
  /** Cuándo lo dijo, si fue antes de hoy (un registro que recepción resolvió después): fecha el embarazo. */
  saidAt?: Date | null,
): Promise<PatientHealth> {
  const parsed = registrationAnswersSchema.shape.health.safeParse(input)
  if (!parsed.success || !parsed.data) throw validation("Declaración de salud inválida")
  const declared = parsed.data
  if (!declaredHealthAnswered(declared)) return getPatientHealth(tx, orgId, patientId)
  const state = (value: string | undefined) =>
    value === "none" || value === "recorded" ? value : "unknown"
  // Lo que declaró entra a la entrevista de la ficha como la arma su producto (odentIA: su boca; latidIA: el embarazo con fecha).
  const interview = (await productHooks(tx, orgId)).interview.declared(
    declared,
    await clinicToday(tx, orgId, saidAt ?? undefined),
  )
  const medications = declaredMedications(declared)
  return persistPatientHealth(tx, orgId, { kind: "declaration", userId: actorUserId }, patientId, {
    expectedRevision: 0,
    bloodGroup: declared.bloodGroup,
    reviewStatus: {
      allergies: state(declared.allergies?.state),
      conditions: state(declared.conditions?.state),
      // Con una medicina dicha (también la de una clase), el grupo queda «registrado»; su «No» es
      // «ninguno» solo si también dijo que no al anticoagulante y a los huesos.
      medications: medications.length
        ? "recorded"
        : declared.medications?.state === "none" && !declaredTakesNoMedicine(declared)
          ? "unknown"
          : state(declared.medications?.state),
    },
    allergies: (declared.allergies?.items ?? []).map((item) => ({ ...item, isActive: true })),
    conditions: (declared.conditions?.items ?? []).map((item) => ({ ...item, status: "activa" })),
    medications,
    ...(Object.keys(interview).length ? { anamnesis: { expectedVersion: 0, answers: interview } } : {}),
  })
}

export async function savePatientHealth(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: SavePatientHealthInput,
): Promise<PatientHealth> {
  return persistPatientHealth(tx, orgId, { kind: "staff", userId: actorUserId }, patientId, input)
}

/** Lo que falta saber de su salud: alergias, enfermedades o medicación nunca preguntadas, y la ASA sin clasificar. */
export type HealthGap = "allergies" | "conditions" | "medications" | "asa"

/**
 * Lo que falta saber de su salud antes de atenderla, en especial antes de una
 * anestesia: un grupo falta si sigue «no preguntado» y no tiene filas vigentes
 * (con una fila ya se sabe algo; las alergias, además, si nadie las revisó con
 * el paciente; la medicación vigente es la de la receta: sin
 * fin o con fin desde hoy); la ASA, si no se clasificó y el producto la pide
 * (`asksAsa`: odentIA). La anamnesis con
 * los antecedentes personales es parte de la historia (NTS 139-MINSA/2018/DGAIN);
 * la clasificación es la del estado físico de la ASA. Avisa, nunca frena.
 */
export async function healthGapsOf(tx: Db, orgId: string, patientId: string): Promise<HealthGap[]> {
  const [header] = await tx
    .select({
      reviewStatus: patient.healthReviewStatus,
      asaClass: patient.asaClass,
      allergiesReviewedAt: patient.allergiesReviewedAt,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  if (!header) throw notFound("Paciente")
  const review = (header.reviewStatus ?? {}) as Record<string, unknown>
  const asked = (value: unknown) => value === "none" || value === "recorded"
  const today = await clinicToday(tx, orgId)
  const [allergies, conditions, medications, hooks] = await Promise.all([
    tx
      .select({ id: patientAllergy.id })
      .from(patientAllergy)
      .where(
        and(
          eq(patientAllergy.organizationId, orgId),
          eq(patientAllergy.patientId, patientId),
          eq(patientAllergy.isActive, true),
        ),
      )
      .limit(1),
    tx
      .select({ id: patientCondition.id })
      .from(patientCondition)
      .where(
        and(
          eq(patientCondition.organizationId, orgId),
          eq(patientCondition.patientId, patientId),
          eq(patientCondition.status, "activa"),
        ),
      )
      .limit(1),
    tx
      .select({ id: patientMedication.id })
      .from(patientMedication)
      .where(
        and(
          eq(patientMedication.organizationId, orgId),
          eq(patientMedication.patientId, patientId),
          or(isNull(patientMedication.endDate), gte(patientMedication.endDate, today)),
        ),
      )
      .limit(1),
    productHooks(tx, orgId),
  ])
  const gaps: HealthGap[] = []
  if (!asked(review["allergies"]) && !header.allergiesReviewedAt && allergies.length === 0) gaps.push("allergies")
  if (!asked(review["conditions"]) && conditions.length === 0) gaps.push("conditions")
  if (!asked(review["medications"]) && medications.length === 0) gaps.push("medications")
  if (hooks.asksAsa && !header.asaClass) gaps.push("asa")
  return gaps
}

/**
 * «Niega enfermedades» y «No toma medicación» desde la atención: deja esos
 * grupos en «niega», sin rearmar el resto de los antecedentes; quién y cuándo
 * quedan en la auditoría (`health.denied`). No marca revisado todo el agregado,
 * pero lo que solo anotó un clínico no queda «declarado por revisar»
 * (`healthReviewPending`); lo que declaró
 * el paciente y nadie revisó sigue pendiente de revisión. Con una fila vigente
 * no se puede negar: eso ya se registró. Avanza la revisión, así una edición
 * abierta de Antecedentes recarga.
 */
export async function markHealthDenied(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  groups: ReadonlyArray<"conditions" | "medications">,
): Promise<PatientHealth> {
  if (groups.length === 0) throw validation("Elige qué niega")
  await requirePatient(tx, orgId, patientId)
  const [locked] = await tx
    .select({ revision: patient.healthRevision, reviewStatus: patient.healthReviewStatus })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!locked) throw notFound("Paciente")
  const gaps = await healthGapsOf(tx, orgId, patientId)
  const stored = (locked.reviewStatus ?? {}) as Record<string, unknown>
  const state = (value: unknown) => (value === "none" || value === "recorded" ? value : "unknown")
  const next: Record<string, unknown> = {
    allergies: state(stored["allergies"]),
    conditions: state(stored["conditions"]),
    medications: state(stored["medications"]),
  }
  for (const group of groups) {
    // Ya registrado (con filas o «registrados»): negarlo contradiría lo que hay.
    if (!gaps.includes(group) && next[group] !== "none")
      throw invalidField(
        `reviewStatus.${group}`,
        group === "conditions"
          ? "Ya tiene enfermedades registradas: revísalas en Antecedentes."
          : "Ya tiene medicación registrada: revísala en Antecedentes.",
      )
    next[group] = "none"
  }
  const now = new Date()
  await tx
    .update(patient)
    .set({
      healthRevision: locked.revision + 1,
      healthReviewStatus: next,
      updatedAt: now,
    })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  await audit(tx, orgId, actorUserId, "health.denied", "patient", patientId, {
    groups: [...groups],
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return getPatientHealth(tx, orgId, patientId)
}

/** Una alergia que declaró la persona (o quien habla por ella), sin verificar. */
export interface DeclaredAllergy {
  substance: string
  reaction: string | null
}

/**
 * Lo que la persona declaró sobre sus alergias (el cuestionario «Antes de tu
 * cita») pasa a los antecedentes como alergia sin confirmar (`no_confirmada`,
 * el `unconfirmed` de HL7 FHIR AllergyIntolerance), para que la receta avise.
 * No duplica una alergia activa de la misma sustancia y nunca cambia lo que ya
 * existe: lo confirmado o descartado lo decidió un clínico. Avanza la revisión
 * del agregado, así una edición abierta de Antecedentes recarga en vez de
 * pisarlo. Devuelve las sustancias que añadió (vacío si nada entró).
 */
export async function addDeclaredAllergies(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  declared: DeclaredAllergy[],
  origin: { entity: string; entityId: string },
): Promise<string[]> {
  if (declared.length === 0) return []
  await requirePatient(tx, orgId, patientId)
  const [locked] = await tx
    .select({ revision: patient.healthRevision, reviewStatus: patient.healthReviewStatus })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!locked) throw notFound("Paciente")
  const existing = await tx
    .select({
      substance: patientAllergy.substance,
      isActive: patientAllergy.isActive,
      verification: patientAllergy.verification,
    })
    .from(patientAllergy)
    .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId)))
  // Lo que ya está decidido o vigente no se repite: una activa de la misma
  // sustancia, o una que un clínico descartó (aunque la archivara).
  const known = new Set(
    existing
      .filter((row) => row.isActive || row.verification === "descartada")
      .map((row) => normalizeDrugText(row.substance)),
  )
  const fresh: DeclaredAllergy[] = []
  for (const item of declared) {
    const substance = item.substance.trim().slice(0, 200)
    const key = normalizeDrugText(substance)
    if (!key || known.has(key)) continue
    known.add(key)
    fresh.push({ substance, reaction: item.reaction?.trim().slice(0, 2000) || null })
  }
  if (fresh.length === 0) return []
  await tx.insert(patientAllergy).values(
    fresh.map((item) => {
      // Lo que escribió el paciente queda con su código si es exactamente una sustancia de la lista.
      const entry = codeAllergySubstance(item.substance)
      return {
        organizationId: orgId,
        patientId,
        substance: item.substance,
        substanceSystem: entry?.system ?? null,
        substanceCode: entry?.code ?? null,
        category: entry?.category ?? null,
        reaction: item.reaction,
        severity: "desconocida",
        kind: "alergia",
        verification: "no_confirmada",
        source: "paciente",
        isActive: true,
        createdBy: actorUserId,
      }
    }),
  )
  const reviewStatus = { ...((locked.reviewStatus ?? {}) as Record<string, unknown>) }
  await tx
    .update(patient)
    .set({
      healthRevision: locked.revision + 1,
      // Con alergias activas el grupo queda «registrado» (la misma regla del agregado).
      healthReviewStatus: {
        allergies: "recorded",
        conditions: reviewStatus.conditions ?? "unknown",
        medications: reviewStatus.medications ?? "unknown",
      },
      updatedAt: new Date(),
    })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  // Sin copiar lo declarado: la auditoría dice qué pasó, no el dato clínico.
  await audit(tx, orgId, actorUserId, "health.allergies_declared", "patient", patientId, {
    origin: origin.entity,
    originId: origin.entityId,
    count: fresh.length,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return fresh.map((item) => item.substance)
}

/**
 * Lo demás que declaró de su salud alguien cuya ficha ya tenía antecedentes
 * (el registro en línea que recepción reconoce como la misma persona): sus
 * enfermedades y su medicación se suman a Antecedentes con una nota de dónde
 * vienen, sin repetir lo que sigue vigente por su nombre (lo suspendido que
 * retoma sí entra: mejor repetido que perdido), y lo de la entrevista (el
 * embarazo, con el día en que lo dijo) va como versión nueva. Su salud queda
 * pendiente de revisión, como una primera declaración: lo clínico lo decide el
 * profesional. La nota no dice «sin confirmar» porque nada la cambia al
 * revisar: lo que dice de dónde vino sigue siendo cierto. Las alergias van
 * aparte (`addDeclaredAllergies`), y el grupo sanguíneo guardado no se pisa.
 */
export async function addDeclaredHealth(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  patientId: string,
  input: DeclaredPatientHealthInput,
  /** `words`: cómo empieza la nota de cada fila; sin ellas, la del registro en línea. */
  origin: { entity: string; entityId: string; at: Date; words?: string },
): Promise<{ conditions: number; medications: number; interview: boolean; saidNo: Array<"allergies" | "conditions" | "medications"> }> {
  const parsed = registrationAnswersSchema.shape.health.safeParse(input)
  if (!parsed.success || !parsed.data) throw validation("Declaración de salud inválida")
  const declared = parsed.data
  await requirePatient(tx, orgId, patientId)
  const [locked] = await tx
    .select({ revision: patient.healthRevision, reviewStatus: patient.healthReviewStatus, bloodGroup: patient.bloodGroup })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!locked) throw notFound("Paciente")
  // El grupo sanguíneo que dijo entra solo si no había ninguno: el guardado no se pisa.
  const bloodGroup = !locked.bloodGroup && declared.bloodGroup ? declared.bloodGroup : null
  const today = await clinicToday(tx, orgId)
  const saidOn = await clinicToday(tx, orgId, origin.at)
  const note = `${origin.words ?? DECLARED_ONLINE_NOTE} el ${saidOn.split("-").reverse().join("/")}.`
  const withNote = (notes: string | undefined) => (notes?.trim() ? `${note} ${notes.trim()}` : note).slice(0, 2000)

  // Enfermedades: no se repite una activa con el mismo nombre.
  const activeConditions = new Set(
    (
      await tx
        .select({ name: patientCondition.name })
        .from(patientCondition)
        .where(and(eq(patientCondition.organizationId, orgId), eq(patientCondition.patientId, patientId), eq(patientCondition.status, "activa")))
    ).map((row) => normalizeDrugText(row.name)),
  )
  const conditions = declared.conditions?.state === "recorded" ? declared.conditions.items : []
  let addedConditions = 0
  for (const item of conditions) {
    const key = normalizeDrugText(item.name)
    if (!key || activeConditions.has(key)) continue
    activeConditions.add(key)
    await tx.insert(patientCondition).values({ organizationId: orgId, patientId, name: item.name.trim().slice(0, 200), status: "activa", notes: withNote(item.notes), createdBy: actorUserId })
    addedConditions += 1
  }

  // Medicación: no se repite la que sigue vigente (sin fin o con fin desde hoy).
  const currentMedications = new Set(
    (
      await tx
        .select({ name: patientMedication.name, endDate: patientMedication.endDate })
        .from(patientMedication)
        .where(and(eq(patientMedication.organizationId, orgId), eq(patientMedication.patientId, patientId)))
    )
      .filter((row) => !row.endDate || row.endDate >= today)
      .map((row) => normalizeDrugText(row.name)),
  )
  // Lo que dijo al responder «Sí» a la pregunta de una clase entra con el código de ese grupo; lo
  // demás, con el de la lista si lo escrito es exactamente una DCI (la regla de `validateMedicationRow`).
  const hooks = await productHooks(tx, orgId)
  const habitual = hooks.prescribing.catalog.habitual
  let addedMedications = 0
  for (const item of declaredMedications(declared)) {
    const key = normalizeDrugText(item.name)
    if (!key || currentMedications.has(key)) continue
    currentMedications.add(key)
    const name = item.name.trim().slice(0, 200)
    await tx.insert(patientMedication).values({
      organizationId: orgId,
      patientId,
      name,
      atcCode: item.declaredClass
        ? declaredMedicineAtc(item.declaredClass, name, habitual)
        : (findHabitualMedication(name, habitual)?.atc ?? null),
      dose: item.dose?.trim() || null,
      frequency: item.frequency?.trim() || null,
      notes: withNote(item.notes ?? undefined),
      createdBy: actorUserId,
    })
    addedMedications += 1
  }

  // La entrevista (embarazo con su fecha, operaciones…): lo que dijo encima de lo que había, campo por
  // campo (nunca un grupo entero: las operaciones que anotó el profesional siguen), en una versión nueva
  // validada como la del profesional. Lo que ya no se acepta en la entrevista queda en las versiones de antes.
  const said = hooks.interview.declared(declared, saidOn)
  let interview = false
  if (Object.keys(said).length) {
    const [latest] = await tx
      .select()
      .from(patientAnamnesis)
      .where(and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)))
      .orderBy(desc(patientAnamnesis.version))
      .limit(1)
    const merged = withoutRetiredInterview(mergeInterview((latest?.answers ?? {}) as Record<string, unknown>, said))
    // Cuántos al día va solo con «fuma»: si lo que queda no es «fuma», un número suelto haría que la
    // entrevista entera no pase y se pierda lo que dijo.
    const habits = merged["habitos"] as Record<string, unknown> | undefined
    if (habits && habits["tabaco"] !== "fuma" && "cigarrillos" in habits) {
      const { cigarrillos: _stale, ...rest } = habits
      merged["habitos"] = rest
    }
    let answers: Record<string, unknown> | null = null
    try {
      answers = hooks.interview.check(assertNewInterview(merged), today)
    } catch (error) {
      // Lo que no pasa la entrevista del profesional no se guarda a medias: queda la versión de antes.
      if (!(error instanceof ServiceError)) throw error
    }
    if (answers && (!latest || canonicalJson(latest.answers) !== canonicalJson(answers))) {
      // La dijo la persona: la versión no es «Registrado por personal clínico». Quién la aplicó queda en la auditoría.
      await tx.insert(patientAnamnesis).values({ organizationId: orgId, patientId, version: (latest?.version ?? 0) + 1, answers, createdBy: null })
      interview = true
    }
  }

  // Su «No» a un grupo que nadie había preguntado y que sigue vacío queda como «dijo que no» (no es
  // el «niega» que anota quien se lo pregunta): lo ya preguntado o con filas vigentes no se toca.
  const reviewStatus = { ...((locked.reviewStatus ?? {}) as Record<string, unknown>) }
  const unasked = (group: string) => reviewStatus[group] !== "none" && reviewStatus[group] !== "recorded"
  const saidNo: Array<"allergies" | "conditions" | "medications"> = []
  if (declared.conditions?.state === "none" && unasked("conditions") && !addedConditions && activeConditions.size === 0)
    saidNo.push("conditions")
  if (declaredTakesNoMedicine(declared) && unasked("medications") && !addedMedications && currentMedications.size === 0)
    saidNo.push("medications")
  if (declared.allergies?.state === "none" && unasked("allergies")) {
    const [header] = await tx
      .select({ reviewedAt: patient.allergiesReviewedAt })
      .from(patient)
      .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
      .limit(1)
    const [active] = await tx
      .select({ id: patientAllergy.id })
      .from(patientAllergy)
      .where(and(eq(patientAllergy.organizationId, orgId), eq(patientAllergy.patientId, patientId), eq(patientAllergy.isActive, true)))
      .limit(1)
    if (!header?.reviewedAt && !active) saidNo.push("allergies")
  }
  // Una respuesta que no deja fila ni cambia la entrevista (que no toma anticoagulantes, por
  // ejemplo) también es algo que dijo: queda en su declaración y pide revisión como lo demás.
  const directed = (["anticoagulants", "boneMedicines"] as const).some(
    (group) => declared[group] && declared[group].state !== "unanswered",
  )
  if (!addedConditions && !addedMedications && !interview && saidNo.length === 0 && !directed && !bloodGroup)
    return { conditions: 0, medications: 0, interview: false, saidNo }
  await tx
    .update(patient)
    .set({
      healthRevision: locked.revision + 1,
      ...(bloodGroup ? { bloodGroup } : {}),
      // Con lo que sumó, el grupo queda «registrado»: un «niega» de antes ya no es cierto.
      healthReviewStatus: {
        allergies: saidNo.includes("allergies") ? "none" : (reviewStatus.allergies ?? "unknown"),
        conditions: addedConditions ? "recorded" : saidNo.includes("conditions") ? "none" : (reviewStatus.conditions ?? "unknown"),
        medications: addedMedications ? "recorded" : saidNo.includes("medications") ? "none" : (reviewStatus.medications ?? "unknown"),
      },
      // Lo declarado espera la revisión de un profesional, como la primera declaración.
      healthReviewedAt: null,
      healthReviewedBy: null,
      updatedAt: new Date(),
    })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  // Sin copiar lo declarado: la auditoría dice qué pasó, no el dato clínico.
  await audit(tx, orgId, actorUserId, "health.declared", "patient", patientId, {
    origin: origin.entity,
    originId: origin.entityId,
    counts: { conditions: addedConditions, medications: addedMedications },
    interview,
    revision: { before: locked.revision, after: locked.revision + 1 },
  })
  return { conditions: addedConditions, medications: addedMedications, interview, saidNo }
}

async function persistPatientHealth(
  tx: Db,
  orgId: string,
  context: { kind: "staff"; userId: string } | { kind: "declaration"; userId: string | null },
  patientId: string,
  input: SavePatientHealthInput,
): Promise<PatientHealth> {
  const actorUserId = context.userId
  if (input.bloodGroup != null && !(BLOOD_GROUPS as readonly string[]).includes(input.bloodGroup))
    throw invalidField("bloodGroup", "Elige el grupo sanguíneo de la lista")
  await requirePatient(tx, orgId, patientId)
  // Lock del paciente: serializa revisiones concurrentes del agregado.
  const [locked] = await tx
    .select({
      revision: patient.healthRevision,
      reviewStatus: patient.healthReviewStatus,
    })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
    .for("update")
  if (!locked) throw notFound("Paciente")
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== locked.revision) {
    throw conflict(
      "STALE_HEALTH_REVISION",
      "Otra sesión guardó antecedentes mientras editabas: recarga y reintenta sin perder lo escrito",
    )
  }
  if (context.kind === "declaration") {
    const [registration] = await tx
      .select({ id: patientRegistration.id })
      .from(patientRegistration)
      .where(
        and(
          eq(patientRegistration.organizationId, orgId),
          eq(patientRegistration.patientId, patientId),
        ),
      )
      .limit(1)
    const previous = await getPatientHealth(tx, orgId, patientId)
    if (
      !registration ||
      locked.revision !== 0 ||
      previous.latestAnamnesis ||
      previous.allergies.length ||
      previous.conditions.length ||
      previous.medications.length
    )
      throw conflict(
        "HEALTH_ALREADY_INITIALIZED",
        "La declaración inicial requiere una ficha nueva sin antecedentes",
      )
  }
  // Sin alergias en el envío, no se tocan: van una por una (`allergies.ts`).
  const sendsAllergies = input.allergies !== undefined
  if (
    (sendsAllergies && !Array.isArray(input.allergies)) ||
    !Array.isArray(input.conditions) ||
    !Array.isArray(input.medications)
  ) {
    throw validation("allergies, conditions y medications deben ser arreglos completos")
  }
  const sentReviewStatus = assertReviewStatus(input.reviewStatus)
  const storedReview = (locked.reviewStatus ?? {}) as Record<string, unknown>
  const reviewStatus = sendsAllergies
    ? sentReviewStatus
    : {
        ...sentReviewStatus,
        allergies: storedReview.allergies === "none" || storedReview.allergies === "recorded" ? storedReview.allergies : "unknown",
      }
  const allergies = (input.allergies ?? []).map(validateAllergyRow)
  const conditions = input.conditions.map(validateConditionRow)
  const habitual = (await productHooks(tx, orgId)).prescribing.catalog.habitual
  const medications = input.medications.map((row, index) =>
    validateMedicationRow(row, index, habitual, context.kind === "declaration"),
  )
  // La omisión de un ID persistido es 400: evita el borrado accidental.
  const [persistedAllergies, persistedConditions, persistedMeds] = await Promise.all([
    tx
      .select({ id: patientAllergy.id })
      .from(patientAllergy)
      .where(
        and(eq(patientAllergy.patientId, patientId), eq(patientAllergy.organizationId, orgId)),
      ),
    tx
      .select({ id: patientCondition.id })
      .from(patientCondition)
      .where(
        and(eq(patientCondition.patientId, patientId), eq(patientCondition.organizationId, orgId)),
      ),
    tx
      .select({ id: patientMedication.id })
      .from(patientMedication)
      .where(
        and(
          eq(patientMedication.patientId, patientId),
          eq(patientMedication.organizationId, orgId),
        ),
      ),
  ])
  const knownIds = new Set([
    ...(sendsAllergies ? persistedAllergies.map((r) => r.id) : []),
    ...persistedConditions.map((r) => r.id),
    ...persistedMeds.map((r) => r.id),
  ])
  const sentIds = new Set<string>()
  for (const row of [...allergies, ...conditions, ...medications]) {
    if (!row.id) continue
    if (sentIds.has(row.id)) throw validation("Los IDs de antecedentes no deben repetirse")
    sentIds.add(row.id)
    if (!knownIds.has(row.id)) throw notFound("Registro de salud")
  }
  for (const [rows, persisted, name] of [
    [allergies, sendsAllergies ? persistedAllergies : [], "alergias"],
    [conditions, persistedConditions, "condiciones"],
    [medications, persistedMeds, "medicamentos"],
  ] as const) {
    for (const persistedRow of persisted) {
      if (!rows.some((r) => r.id === persistedRow.id)) {
        throw validation(
          `Falta el registro persistido de ${name}: envía la colección completa o archívalo explícitamente`,
        )
      }
    }
  }
  // Consistencia revisión/registros sobre el contenido prospectivo (antes de escribir).
  const activeAllergies = allergies.filter((r) => r.isActive).length
  const activeConditions = conditions.filter((r) => r.status === "activa").length
  const activeMeds = medications.filter((r) => !r.endDate).length
  // Se dice en la revisión del grupo (`reviewStatus.<grupo>`), con las palabras de la pantalla.
  const checkGroup = (group: "allergies" | "conditions" | "medications", state: string, active: number): void => {
    const words = {
      allergies: { rows: "alergias vigentes", none: "Hay alergias vigentes" },
      conditions: { rows: "condiciones activas", none: "Hay condiciones activas" },
      medications: { rows: "medicamentos vigentes", none: "Hay medicamentos vigentes" },
    }[group]
    if (state === "none" && active > 0) {
      throw invalidField(`reviewStatus.${group}`, `${words.none}: no puede marcarse ausencia.`)
    }
    if (active > 0 && state !== "recorded") {
      throw invalidField(`reviewStatus.${group}`, `Con ${words.rows} la revisión debe quedar registrada.`)
    }
  }
  if (sendsAllergies) checkGroup("allergies", reviewStatus.allergies, activeAllergies)
  checkGroup("conditions", reviewStatus.conditions, activeConditions)
  checkGroup("medications", reviewStatus.medications, activeMeds)
  // Entrevista: solo si cambió; versión esperada estricta (0 si no había).
  let interviewChanged = false
  let interviewAnswers: Record<string, unknown> | null = null
  let interviewBaseVersion = 0
  if (input.anamnesis !== undefined) {
    if (!input.anamnesis || typeof input.anamnesis !== "object")
      throw validation("anamnesis debe ser un objeto")
    if (!Number.isInteger(input.anamnesis.expectedVersion) || input.anamnesis.expectedVersion < 0) {
      throw validation("anamnesis.expectedVersion debe ser un entero >= 0")
    }
    // Lo del producto en la entrevista (latidIA: embarazo y lactancia con fecha, hábitos, vacunas).
    interviewAnswers = (await productHooks(tx, orgId)).interview.check(
      assertNewInterview(input.anamnesis.answers),
      await clinicToday(tx, orgId),
    )
    const [latest] = await tx
      .select()
      .from(patientAnamnesis)
      .where(
        and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)),
      )
      .orderBy(desc(patientAnamnesis.version))
      .limit(1)
    if ((latest?.version ?? 0) !== input.anamnesis.expectedVersion) {
      throw conflict(
        "STALE_HEALTH_REVISION",
        "La entrevista cambió en otra sesión: recarga antes de reenviar",
      )
    }
    interviewBaseVersion = latest?.version ?? 0
    interviewChanged = !latest || canonicalJson(latest.answers) !== canonicalJson(interviewAnswers)
  }
  // Un código que no está en su lista se rechaza antes de escribir nada.
  for (const [index, row] of conditions.entries()) {
    const resolved = await resolveOptionalDiagnosisCode(
      tx,
      orgId,
      { code: row.diagnosisCode, system: row.diagnosisSystem },
      `conditions[${index}].diagnosisCode`,
    )
    row.diagnosisCode = resolved.diagnosisCode
    row.diagnosisSystem = resolved.diagnosisSystem
  }
  // Aplicación de diffs (todo ya validado: cualquier fallo revierte todo).
  for (const row of allergies) {
    // Lo escrito que es exactamente una sustancia de la lista queda con su código (ADR 0072).
    const entry = codeAllergySubstance(row.substance)
    if (!row.id) {
      await tx.insert(patientAllergy).values({
        organizationId: orgId,
        patientId,
        substance: row.substance,
        substanceSystem: entry?.system ?? null,
        substanceCode: entry?.code ?? null,
        category: row.category ?? entry?.category ?? null,
        reaction: row.reaction,
        severity: row.severity,
        kind: row.kind,
        criticality: row.criticality,
        verification: row.verification,
        source: context.kind === "declaration" ? "paciente" : "equipo",
        isActive: row.isActive,
        createdBy: actorUserId,
      })
    } else {
      await tx
        .update(patientAllergy)
        .set({
          substance: row.substance,
          // El código cambia solo si cambió lo escrito: el elegido de la lista se conserva.
          substanceSystem: sql`case when ${patientAllergy.substance} = ${row.substance} then ${patientAllergy.substanceSystem} else ${entry?.system ?? null}::text end`,
          substanceCode: sql`case when ${patientAllergy.substance} = ${row.substance} then ${patientAllergy.substanceCode} else ${entry?.code ?? null}::text end`,
          category: row.category,
          reaction: row.reaction,
          severity: row.severity,
          kind: row.kind,
          criticality: row.criticality,
          verification: row.verification,
          isActive: row.isActive,
          // Vigente no tiene motivo de quitada; archivarla aquí la quita sin motivo.
          ...(row.isActive
            ? { removedReason: null, removedAt: null, removedBy: null }
            : {
                removedAt: sql`coalesce(${patientAllergy.removedAt}, now())`,
                removedBy: sql`coalesce(${patientAllergy.removedBy}, ${actorUserId}::text)`,
              }),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(patientAllergy.id, row.id),
            eq(patientAllergy.organizationId, orgId),
            eq(patientAllergy.patientId, patientId),
          ),
        )
    }
  }
  for (const row of conditions) {
    if (!row.id) {
      await tx.insert(patientCondition).values({
        organizationId: orgId,
        patientId,
        name: row.name,
        diagnosisCode: row.diagnosisCode,
        diagnosisSystem: row.diagnosisSystem,
        status: row.status,
        startDate: row.startDate,
        endDate: row.endDate,
        notes: row.notes,
        createdBy: actorUserId,
      })
    } else {
      await tx
        .update(patientCondition)
        .set({
          name: row.name,
          diagnosisCode: row.diagnosisCode,
          diagnosisSystem: row.diagnosisSystem,
          status: row.status,
          startDate: row.startDate,
          endDate: row.endDate,
          notes: row.notes,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(patientCondition.id, row.id),
            eq(patientCondition.organizationId, orgId),
            eq(patientCondition.patientId, patientId),
          ),
        )
    }
  }
  for (const row of medications) {
    if (!row.id) {
      await tx.insert(patientMedication).values({
        organizationId: orgId,
        patientId,
        name: row.name,
        genericName: row.genericName,
        atcCode: row.atcCode,
        dose: row.dose,
        doseValue: row.doseValue,
        doseUnit: row.doseUnit,
        frequency: row.frequency,
        frequencyCode: row.frequencyCode,
        startDate: row.startDate,
        endDate: row.endDate,
        notes: row.notes,
        createdBy: actorUserId,
      })
    } else {
      await tx
        .update(patientMedication)
        .set({
          name: row.name,
          genericName: row.genericName,
          // El código de la lista manda; sin él, el que ya tenía se conserva mientras no cambie lo
          // escrito: la clase que dijo el paciente (B01A, M05B) no se pierde al revisar otros datos.
          atcCode:
            row.atcCode ??
            sql`case when ${patientMedication.name} = ${row.name} and ${patientMedication.genericName} is not distinct from ${row.genericName}::text then ${patientMedication.atcCode} else null end`,
          dose: row.dose,
          doseValue: row.doseValue,
          doseUnit: row.doseUnit,
          frequency: row.frequency,
          frequencyCode: row.frequencyCode,
          startDate: row.startDate,
          endDate: row.endDate,
          notes: row.notes,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(patientMedication.id, row.id),
            eq(patientMedication.organizationId, orgId),
            eq(patientMedication.patientId, patientId),
          ),
        )
    }
  }
  let newVersion: number | null = null
  if (interviewChanged && interviewAnswers) {
    const version = interviewBaseVersion + 1
    try {
      const [created] = await tx
        .insert(patientAnamnesis)
        .values({
          organizationId: orgId,
          patientId,
          version,
          answers: interviewAnswers,
          createdBy: actorUserId,
        })
        .returning()
      if (!created) throw new Error("No se pudo guardar la entrevista")
      newVersion = version
    } catch (e) {
      if (!isUniqueViolation(e)) throw e
      // Carrera de versión: otra sesión creó la entrevista primero.
      throw conflict(
        "STALE_HEALTH_REVISION",
        "La entrevista cambió en otra sesión: recarga antes de reenviar",
      )
    }
  }
  // Antecedentes familiares: se reemplazan cuando se envían (parentesco del
  // catálogo, condición y código de diagnóstico opcional).
  if (input.familyHistory !== undefined) {
    if (!Array.isArray(input.familyHistory) || input.familyHistory.length > 50)
      throw invalidField("familyHistory", "Registra como mucho 50 antecedentes familiares")
    const rows = []
    for (const [index, row] of input.familyHistory.entries()) {
      const at = `familyHistory[${index}]`
      if (!(FAMILY_RELATIONSHIPS as readonly string[]).includes(row.relationship))
        throw invalidField(`${at}.relationship`, "Elige el parentesco de la lista")
      rows.push({
        relationship: row.relationship,
        condition: assertText(row.condition, 200, `${at}.condition`, true, "Escribe la condición"),
        ...(await resolveOptionalDiagnosisCode(
          tx,
          orgId,
          { code: row.diagnosisCode, system: row.diagnosisSystem },
          `${at}.diagnosisCode`,
        )),
        notes: assertText(row.notes, 2000, `${at}.notes`, false),
      })
    }
    await tx
      .delete(patientFamilyHistory)
      .where(
        and(
          eq(patientFamilyHistory.organizationId, orgId),
          eq(patientFamilyHistory.patientId, patientId),
        ),
      )
    if (rows.length)
      await tx.insert(patientFamilyHistory).values(
        rows.map((row) => ({ ...row, organizationId: orgId, patientId, createdBy: actorUserId })),
      )
  }
  if (input.asaClass !== undefined && input.asaClass !== null && !ASA_CLASSES.includes(input.asaClass))
    throw invalidField("asaClass", "Elige la clasificación ASA de la lista")
  await tx
    .update(patient)
    .set({
      ...(input.asaClass !== undefined ? { asaClass: input.asaClass } : {}),
      healthRevision: locked.revision + 1,
      healthReviewStatus: reviewStatus,
      healthReviewedAt: context.kind === "staff" ? new Date() : null,
      healthReviewedBy: context.kind === "staff" ? context.userId : null,
      ...(input.bloodGroup !== undefined ? { bloodGroup: input.bloodGroup } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
  await audit(
    tx,
    orgId,
    actorUserId,
    context.kind === "staff" ? "health.saved" : "health.declared",
    "patient",
    patientId,
    {
      revision: { before: locked.revision, after: locked.revision + 1 },
      reviewStatus,
      counts: {
        allergies: allergies.length,
        conditions: conditions.length,
        medications: medications.length,
      },
      newInterviewVersion: newVersion,
    },
  )
  return getPatientHealth(tx, orgId, patientId)
}

export async function getLatestAnamnesis(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select()
    .from(patientAnamnesis)
    .where(
      and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)),
    )
    .orderBy(desc(patientAnamnesis.version))
    .limit(1)
  return row ?? null
}

export async function listAnamnesisVersions(tx: Db, orgId: string, patientId: string) {
  await requirePatient(tx, orgId, patientId)
  return tx
    .select({
      id: patientAnamnesis.id,
      version: patientAnamnesis.version,
      createdAt: patientAnamnesis.createdAt,
      createdBy: patientAnamnesis.createdBy,
    })
    .from(patientAnamnesis)
    .where(
      and(eq(patientAnamnesis.patientId, patientId), eq(patientAnamnesis.organizationId, orgId)),
    )
    .orderBy(desc(patientAnamnesis.version))
}

export async function getAnamnesisVersion(
  tx: Db,
  orgId: string,
  patientId: string,
  versionId: string,
) {
  await requirePatient(tx, orgId, patientId)
  const [row] = await tx
    .select()
    .from(patientAnamnesis)
    .where(
      and(
        eq(patientAnamnesis.id, versionId),
        eq(patientAnamnesis.patientId, patientId),
        eq(patientAnamnesis.organizationId, orgId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Anamnesis")
  return row
}

// --- Notas de evolución ---

export async function addClinicalNote(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: {
    note: string
    diagnosisCode?: string | null
    /** Certeza del diagnóstico; exige código. Sin indicar, queda sin clasificar. */
    diagnosisType?: string | null
    /** Pieza FDI a la que se refiere el diagnóstico. */
    toothNumber?: number | null
    encounterId?: string
  },
) {
  await requirePatient(tx, orgId, patientId)
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId, actorUserId)
  const note = input.note?.trim() ?? ""
  if (note.length < 1 || note.length > 4000) throw validation("note debe tener 1–4000 caracteres")
  // Una sola vía para diagnosticar: el diagnóstico es una entidad de la
  // atención (`addEncounterDiagnosis`), no un campo de una nota suelta.
  if (input.diagnosisCode || input.diagnosisType?.trim()) {
    throw validation("Registra el diagnóstico en la sección Diagnóstico de la atención")
  }
  const site = await siteOf(tx, orgId)
  const noteSite = site.columns({ toothNumber: input.toothNumber ?? null })
  const [row] = await tx
    .insert(clinicalNote)
    .values({
      organizationId: orgId,
      patientId,
      authorUserId: actorUserId,
      note,
      ...noteSite,
      encounterId: input.encounterId ?? null,
      kind: "evolucion",
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la nota")
  await audit(tx, orgId, actorUserId, "note.created", "clinical_note", row.id, { patientId })
  return withSite(site, row)
}

export async function listClinicalNotes(
  tx: Db,
  orgId: string,
  patientId: string,
  input: { cursor?: string; limit?: number },
) {
  await requirePatient(tx, orgId, patientId)
  const limit = Math.min(Math.max(input.limit ?? 30, 1), 100)
  const conditions = [eq(clinicalNote.patientId, patientId), eq(clinicalNote.organizationId, orgId)]
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor)
    if (!decoded) throw validation("Cursor inválido")
    const ts = new Date(decoded.ts)
    if (Number.isNaN(ts.getTime())) throw validation("Cursor inválido")
    conditions.push(
      or(
        lt(clinicalNote.createdAt, ts),
        and(eq(clinicalNote.createdAt, ts), lt(clinicalNote.id, decoded.id)),
      )!,
    )
  }
  const rows = await tx
    .select()
    .from(clinicalNote)
    .where(and(...conditions))
    .orderBy(desc(clinicalNote.createdAt), desc(clinicalNote.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor:
      rows.length > limit && last ? encodeCursor(last.createdAt.toISOString(), last.id) : null,
  }
}

// --- Documentos con contexto versionado ---
//
// El blob y la clasificación original del documento son inmutables; el contexto
// (atención, tratamiento, piezas FDI, etiquetas) vive en patient_document_context
// append-only. Las columnas patient_document.encounterId/toothNumber están
// retiradas: toda lectura devuelve el documento fusionado con su contexto
// vigente (PatientDocumentWithContext).

/** Revisión inmutable del contexto clínico de un documento. */
export type DocumentContextRow = typeof patientDocumentContext.$inferSelect & { toothNumbers: number[] }

/** Entrada de contexto al registrar o corregir un documento. `null` libera el
 * vínculo; `undefined` (solo en corrección) conserva el valor vigente. */
export interface DocumentContextInput {
  encounterId?: string | null
  planItemId?: string | null
  budgetId?: string | null
  encounterProcedureId?: string | null
  prescriptionId?: string | null
  followUpId?: string | null
  paymentId?: string | null
  toothNumbers?: readonly number[] | null
  tags?: readonly string[] | null
}

export interface CorrectDocumentContextInput extends DocumentContextInput {
  /** Versión vigente esperada (bloqueo optimista). */
  expectedVersion: number
  /**
   * Fecha del documento corregida (ISO 8601); `null` vuelve a la de subida y
   * `undefined` conserva la vigente. Cambiarla pide `dateReason`.
   */
  capturedAt?: string | Date | null
  /** Por qué se corrige la fecha (hasta 500 caracteres). */
  dateReason?: string | null
}

/** Documento fusionado con su contexto vigente. */
export interface PatientDocumentWithContext {
  id: string
  organizationId: string
  patientId: string
  category: string
  label: string
  storageKey: string
  contentType: string
  sizeBytes: number
  uploadedBy: string | null
  createdAt: Date
  imageType: string | null
  capturedAt: Date | null
  source: string | null
  reportStatus: string | null
  thumbnailKey: string | null
  retiredAt: Date | null
  retiredBy: string | null
  retireReason: string | null
  /** «No mostrar en su portal» (ADR 0156): desde cuándo está oculto; nulo, se ve. */
  portalHiddenAt: Date | null
  encounterId: string | null
  planItemId: string | null
  budgetId: string | null
  encounterProcedureId: string | null
  prescriptionId: string | null
  followUpId: string | null
  paymentId: string | null
  toothNumbers: number[]
  tags: string[]
  contextVersion: number
  /** Tomografía de muchos archivos (ADR 0055); null en el resto. */
  imaging?: ImagingSummary | null
}

/** Lo que la ficha dice de una tomografía: su avance y su forma, nunca sus archivos. */
export interface ImagingSummary {
  studyInstanceUid: string
  fileCount: number
  uploadedCount: number
  sliceCount: number
  voxelMm: number | null
  totalBytes: number
  completedAt: Date | null
  thumbnailKey: string | null
  /** Nombre que trae el archivo, para avisar si no coincide; nunca identifica. */
  dicomPatientName: string | null
}

/** Resumen de las tomografías de estos documentos (las que tienen `imaging_study`). */
async function imagingSummaries(
  tx: Db,
  orgId: string,
  documentIds: readonly string[],
): Promise<Map<string, ImagingSummary>> {
  if (!documentIds.length) return new Map()
  const rows = await tx
    .select({
      documentId: imagingStudy.documentId,
      studyInstanceUid: imagingStudy.studyInstanceUid,
      fileCount: imagingStudy.fileCount,
      sliceCount: imagingStudy.sliceCount,
      voxelMm: imagingStudy.voxelMm,
      totalBytes: imagingStudy.totalBytes,
      completedAt: imagingStudy.completedAt,
      thumbnailKey: imagingStudy.thumbnailKey,
      dicomPatientName: imagingStudy.dicomPatientName,
      uploadedCount: sql<number>`(
        select count(*)::int from ${imagingStudyFile}
        where ${imagingStudyFile.documentId} = ${imagingStudy.documentId}
          and ${imagingStudyFile.organizationId} = ${imagingStudy.organizationId}
          and ${imagingStudyFile.uploadedAt} is not null
      )`,
    })
    .from(imagingStudy)
    .where(
      and(
        eq(imagingStudy.organizationId, orgId),
        inArray(imagingStudy.documentId, [...new Set(documentIds)]),
      ),
    )
  return new Map(
    rows.map(({ documentId, ...summary }) => [
      documentId,
      { ...summary, uploadedCount: Number(summary.uploadedCount) },
    ]),
  )
}

async function withImaging(
  tx: Db,
  orgId: string,
  docs: PatientDocumentWithContext[],
): Promise<PatientDocumentWithContext[]> {
  // Una tomografía es el documento que tiene su estudio, del tipo que sea en cada producto.
  const candidates = docs.filter((doc) => doc.imageType).map((doc) => doc.id)
  const summaries = await imagingSummaries(tx, orgId, candidates)
  return docs.map((doc) => ({ ...doc, imaging: summaries.get(doc.id) ?? null }))
}

/** Piezas FDI múltiples: enteras válidas, únicas y ordenadas. Vacío = imagen general. */
function normalizeDocumentTeeth(site: ProductSite, input: readonly number[] | null | undefined): number[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw invalidField("toothNumbers", "Las piezas deben ir en una lista.")
  if (input.length > 52) throw invalidField("toothNumbers", "Elige como mucho 52 piezas.")
  const set = new Set<number>()
  for (const tooth of input) {
    if (site.code(tooth) === null) throw invalidField("toothNumbers", site.invalid(tooth))
    set.add(tooth)
  }
  return [...set].sort((a, b) => a - b)
}

/** Etiquetas con el helper canónico compartido (@odentia/clinical, TagsData). */
function normalizeDocumentTags(input: readonly string[] | null | undefined): string[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw invalidField("tags", "Las etiquetas deben ir en una lista.")
  try {
    return normalizeTags(input)
  } catch (e) {
    throw invalidField("tags", e instanceof Error ? e.message : "Revisa las etiquetas.")
  }
}

/** Atención visible del mismo paciente y org, en cualquier estado. Las
 * correcciones pueden vincular atenciones cerradas como corrección documental
 * auditada sin mutar la clínica (sin inserts en encounter_site ni cambios de estado). */
async function requireVisibleEncounter(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
) {
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
  if (!row) throw new ServiceError("NOT_FOUND", 404, "Atención no encontrada", { encounterId: "Atención no encontrada" })
  return row
}

/** Ítem del plan del mismo paciente y org (anti-traversal). */
async function requirePatientPlanItem(
  tx: Db,
  orgId: string,
  patientId: string,
  planItemId: string,
) {
  const [row] = await tx
    .select()
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.id, planItemId),
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
      ),
    )
    .limit(1)
  if (!row) throw new ServiceError("NOT_FOUND", 404, "Tratamiento no encontrado", { planItemId: "Tratamiento no encontrado" })
  return row
}

async function currentDocumentContext(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
  forUpdate: boolean,
): Promise<DocumentContextRow | null> {
  // Las revisiones son append-only: FOR UPDATE requeriría conceder UPDATE.
  // El candado transaccional por documento serializa revisiones sin ese permiso.
  if (forUpdate)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${documentId}, 0))`)
  const base = tx
    .select()
    .from(patientDocumentContext)
    .where(
      and(
        eq(patientDocumentContext.documentId, documentId),
        eq(patientDocumentContext.organizationId, orgId),
        eq(patientDocumentContext.patientId, patientId),
      ),
    )
    .orderBy(desc(patientDocumentContext.version))
  const [row] = await base.limit(1)
  return row ? withTeeth(await siteOf(tx, orgId), row) : null
}

/** El contexto con sus piezas a la vista, como lo devolvía la API (ADR 0079). */
function withTeeth(site: ProductSite, row: typeof patientDocumentContext.$inferSelect): DocumentContextRow {
  const teeth = row.siteSystem === site.system ? row.siteCodes.map((code) => site.value(code)) : []
  return { ...row, toothNumbers: teeth.filter((tooth): tooth is number => tooth !== null) }
}

/** Los sitios sueltos de un documento → sus columnas (odentIA: piezas → códigos ISO 3950). */
function siteCodesColumns(site: ProductSite, teeth: readonly number[]): { siteSystem: string | null; siteCodes: string[] } {
  return teeth.length > 0 ? { siteSystem: site.system, siteCodes: teeth.map((tooth) => site.code(tooth)!) } : { siteSystem: null, siteCodes: [] }
}

/** Fusión explícita por columnas estables: nunca filtra encounterId/toothNumber
 * retiradas de patient_document. Copia los arreglos para no compartir referencias. */
function mergeDocumentContext(
  doc: typeof patientDocument.$inferSelect,
  ctx: DocumentContextRow | null | undefined,
): PatientDocumentWithContext {
  return {
    id: doc.id,
    organizationId: doc.organizationId,
    patientId: doc.patientId,
    category: doc.category,
    label: doc.label,
    storageKey: doc.storageKey,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    uploadedBy: doc.uploadedBy,
    createdAt: doc.createdAt,
    imageType: doc.imageType,
    capturedAt: doc.capturedAt,
    source: doc.source,
    reportStatus: doc.reportStatus,
    thumbnailKey: doc.thumbnailKey,
    retiredAt: doc.retiredAt,
    retiredBy: doc.retiredBy,
    retireReason: doc.retireReason,
    portalHiddenAt: doc.portalHiddenAt,
    encounterId: ctx?.encounterId ?? null,
    planItemId: ctx?.planItemId ?? null,
    budgetId: ctx?.budgetId ?? null,
    encounterProcedureId: ctx?.encounterProcedureId ?? null,
    prescriptionId: ctx?.prescriptionId ?? null,
    followUpId: ctx?.followUpId ?? null,
    paymentId: ctx?.paymentId ?? null,
    toothNumbers: ctx?.toothNumbers ? [...ctx.toothNumbers] : [],
    tags: ctx?.tags ? [...ctx.tags] : [],
    contextVersion: ctx?.version ?? 0,
  }
}

async function requireDocumentRow(tx: Db, orgId: string, patientId: string, documentId: string) {
  const [row] = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.id, documentId),
        eq(patientDocument.patientId, patientId),
        eq(patientDocument.organizationId, orgId),
      ),
    )
    .limit(1)
  if (!row) throw notFound("Documento")
  return row
}

function extendedDocumentLinks(input: DocumentContextInput, current?: DocumentContextRow) {
  return {
    budgetId: input.budgetId === undefined ? (current?.budgetId ?? null) : input.budgetId,
    encounterProcedureId:
      input.encounterProcedureId === undefined
        ? (current?.encounterProcedureId ?? null)
        : input.encounterProcedureId,
    prescriptionId:
      input.prescriptionId === undefined ? (current?.prescriptionId ?? null) : input.prescriptionId,
    followUpId: input.followUpId === undefined ? (current?.followUpId ?? null) : input.followUpId,
    paymentId: input.paymentId === undefined ? (current?.paymentId ?? null) : input.paymentId,
  }
}

async function validateExtendedDocumentLinks(
  tx: Db,
  orgId: string,
  patientId: string,
  input: DocumentContextInput,
) {
  for (const [field, id, table, label] of [
    ["budgetId", input.budgetId, treatmentBudget, "Presupuesto"],
    ["prescriptionId", input.prescriptionId, prescription, "Receta"],
    ["followUpId", input.followUpId, clinicalFollowUp, "Control"],
    ["paymentId", input.paymentId, patientPayment, "Pago"],
  ] as const) {
    if (!id) continue
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.organizationId, orgId), eq(table.patientId, patientId)))
    if (!row) throw new ServiceError("NOT_FOUND", 404, `${label} no encontrado`, { [field]: `${label} no encontrado` })
  }
  if (input.encounterProcedureId) {
    const [row] = await tx
      .select({ id: encounterProcedure.id })
      .from(encounterProcedure)
      .innerJoin(
        encounter,
        and(
          eq(encounter.id, encounterProcedure.encounterId),
          eq(encounter.organizationId, orgId),
          eq(encounter.patientId, patientId),
        ),
      )
      .where(
        and(
          eq(encounterProcedure.id, input.encounterProcedureId),
          eq(encounterProcedure.organizationId, orgId),
        ),
      )
    if (!row)
      throw new ServiceError("NOT_FOUND", 404, "Procedimiento no encontrado", {
        encounterProcedureId: "Procedimiento no encontrado",
      })
  }
}

/** Metadatos de la imagen diagnóstica al subirla (inmutables después). */
export interface DocumentImageInput {
  imageType?: string | null
  /** Fecha y hora de la toma (ISO 8601); la de subida la pone el servidor. */
  capturedAt?: string | Date | null
  source?: string | null
  reportStatus?: string | null
}

function normalizeImageInput(category: string, input: DocumentImageInput, imaging: readonly ImagingType[]) {
  let imageType: string | null = null
  if (input.imageType) {
    // Los tipos son los del producto de la clínica (issue 229: latidIA sube ecografías, tomografías…).
    const type = imaging.find((item) => item.value === input.imageType)
    if (!type) throw invalidField("imageType", `Tipo de imagen no reconocido: ${input.imageType}`)
    if (type.category !== category)
      throw invalidField("imageType", `${type.label} no corresponde a la categoría ${category}`)
    imageType = type.value
  }
  const capturedAt = input.capturedAt ? documentDate(input.capturedAt, category) : null
  const source = input.source?.trim() || null
  if (source && source.length > 120) throw invalidField("source", "El origen debe tener hasta 120 caracteres")
  let reportStatus: ReportStatus | null = null
  if (input.reportStatus) {
    if (!(REPORT_STATUSES as readonly string[]).includes(input.reportStatus))
      throw invalidField("reportStatus", `Estado de informe no reconocido: ${input.reportStatus}`)
    reportStatus = input.reportStatus as ReportStatus
  } else if (category === "radiografia") {
    reportStatus = "pendiente"
  }
  return { imageType, capturedAt, source, reportStatus }
}

export async function registerPatientDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: {
    category: string
    label: string
    storageKey: string
    contentType: string
    sizeBytes: number
    /** Miniatura ya almacenada (solo imágenes). */
    thumbnailKey?: string | null
  } & DocumentContextInput &
    DocumentImageInput,
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  if (!(DOCUMENT_CATEGORIES as readonly string[]).includes(input.category))
    throw invalidField("category", "Elige una categoría de la lista.")
  const label = input.label?.trim() ?? ""
  if (!label) throw invalidField("label", "Escribe el título.")
  if (label.length > 200) throw invalidField("label", "El título admite hasta 200 caracteres.")
  const image = normalizeImageInput(input.category, input, (await productHooks(tx, orgId)).imaging)
  if (!input.storageKey) throw validation("storageKey es obligatorio")
  const site = await siteOf(tx, orgId)
  const toothNumbers = normalizeDocumentTeeth(site, input.toothNumbers)
  const tags = normalizeDocumentTags(input.tags)
  // Al registrar solo se permite vincular borradores (la atención aún es mutable).
  // Si no se puede (no existe, finalizada, anulada), se dice junto a la atención elegida.
  if (input.encounterId)
    await requireDraftLink(tx, orgId, patientId, input.encounterId).catch((e: unknown) => {
      if (e instanceof ServiceError && !e.fields) e.fields = { encounterId: e.message }
      throw e
    })
  if (input.planItemId) await requirePatientPlanItem(tx, orgId, patientId, input.planItemId)
  await validateExtendedDocumentLinks(tx, orgId, patientId, input)
  const [row] = await tx
    .insert(patientDocument)
    .values({
      organizationId: orgId,
      patientId,
      category: input.category,
      label,
      storageKey: input.storageKey,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      uploadedBy: actorUserId,
      thumbnailKey: input.thumbnailKey ?? null,
      ...image,
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el documento")
  const [ctx] = await tx
    .insert(patientDocumentContext)
    .values({
      organizationId: orgId,
      patientId,
      documentId: row.id,
      version: 1,
      encounterId: input.encounterId ?? null,
      planItemId: input.planItemId ?? null,
      ...extendedDocumentLinks(input),
      ...siteCodesColumns(site, toothNumbers),
      tags,
      // La fecha con que nace: el historial la tiene desde la primera versión.
      capturedAt: image.capturedAt,
      authorUserId: actorUserId,
    })
    .returning()
  if (!ctx) throw new Error("No se pudo registrar el contexto del documento")
  if (input.encounterId && toothNumbers.length) {
    await tx
      .insert(encounterSite)
      .values(
        toothNumbers.map((toothNumber) => ({
          organizationId: orgId,
          encounterId: input.encounterId!,
          siteSystem: site.system!,
          siteCode: site.code(toothNumber)!,
        })),
      )
      .onConflictDoNothing()
  }
  await audit(tx, orgId, actorUserId, "document.uploaded", "patient_document", row.id, {
    patientId,
    category: input.category,
    imageType: image.imageType,
    contextVersion: 1,
    encounterId: input.encounterId ?? null,
    planItemId: input.planItemId ?? null,
  })
  return mergeDocumentContext(row, withTeeth(site, ctx))
}

/** Contexto vigente por documento (una fila por documento) acotado a org y
 * paciente. DISTINCT ON evita cargar todo el historial en listados. */
async function latestDocumentContexts(
  tx: Db,
  orgId: string,
  patientId: string,
  documentIds?: readonly string[],
): Promise<DocumentContextRow[]> {
  const conditions = [
    eq(patientDocumentContext.organizationId, orgId),
    eq(patientDocumentContext.patientId, patientId),
  ]
  if (documentIds) {
    conditions.push(inArray(patientDocumentContext.documentId, [...new Set(documentIds)]))
  }
  const rows = await tx
    .selectDistinctOn([patientDocumentContext.documentId])
    .from(patientDocumentContext)
    .where(and(...conditions))
    .orderBy(patientDocumentContext.documentId, desc(patientDocumentContext.version))
  const site = await siteOf(tx, orgId)
  return rows.map((row) => withTeeth(site, row))
}

/** Filtros del archivo clínico. Sin `includeRetired` los retirados no aparecen. */
export interface DocumentListFilters {
  category?: string
  imageType?: string
  tooth?: number
  planItemId?: string
  /** Desde/hasta (AAAA-MM-DD) sobre la fecha de toma o, si falta, la de subida. */
  from?: string
  to?: string
  includeRetired?: boolean
}

export async function listPatientDocuments(
  tx: Db,
  orgId: string,
  patientId: string,
  filters: DocumentListFilters = {},
): Promise<PatientDocumentWithContext[]> {
  await requirePatient(tx, orgId, patientId)
  const conditions = [
    eq(patientDocument.patientId, patientId),
    eq(patientDocument.organizationId, orgId),
  ]
  if (!filters.includeRetired) conditions.push(isNull(patientDocument.retiredAt))
  if (filters.category) conditions.push(eq(patientDocument.category, filters.category))
  if (filters.imageType) conditions.push(eq(patientDocument.imageType, filters.imageType))
  const takenAt = sql`coalesce(${patientDocument.capturedAt}, ${patientDocument.createdAt})`
  for (const [key, value] of [
    ["from", filters.from],
    ["to", filters.to],
  ] as const) {
    if (!value) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw validation(`${key} debe ser AAAA-MM-DD`)
    conditions.push(
      key === "from"
        ? sql`${takenAt} >= ${value}::date`
        : sql`${takenAt} < (${value}::date + interval '1 day')`,
    )
  }
  if (filters.tooth != null && (await siteOf(tx, orgId)).code(filters.tooth) === null)
    throw validation((await siteOf(tx, orgId)).invalid(filters.tooth))
  const docs = await tx
    .select()
    .from(patientDocument)
    .where(and(...conditions))
    // Con la misma fecha («Para todos»), lo último que se subió primero, y siempre en el mismo orden.
    .orderBy(desc(takenAt), desc(patientDocument.createdAt), desc(patientDocument.id))
  if (!docs.length) return []
  const latest = await latestDocumentContexts(
    tx,
    orgId,
    patientId,
    docs.map((doc) => doc.id),
  )
  const byDocument = new Map(latest.map((ctx) => [ctx.documentId, ctx]))
  // Pieza y tratamiento viven en el contexto vigente: se filtran tras fusionar.
  const merged = docs
    .map((doc) => mergeDocumentContext(doc, byDocument.get(doc.id) ?? null))
    .filter(
      (doc) =>
        (filters.tooth == null || doc.toothNumbers.includes(filters.tooth)) &&
        (!filters.planItemId || doc.planItemId === filters.planItemId),
    )
  return withImaging(tx, orgId, merged)
}

/**
 * Retira un archivo cargado por error (paciente equivocado, duplicado,
 * ilegible). No se borra: sale de la galería, conserva el blob, el contexto y
 * la traza de quién lo retiró, cuándo y por qué.
 */
export async function retirePatientDocument(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
  input: { reason: string },
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  const reason = input.reason?.trim() ?? ""
  if (!reason || reason.length > 2000) throw invalidField("reason", "El motivo debe tener 1–2000 caracteres")
  const [current] = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.id, documentId),
        eq(patientDocument.organizationId, orgId),
        eq(patientDocument.patientId, patientId),
      ),
    )
    .for("update")
  if (!current) throw notFound("Documento")
  if (current.retiredAt)
    throw new ServiceError("DOCUMENT_RETIRED", 409, "El archivo ya está retirado")
  // La foto de la hoja es la prueba de lo firmado (ADR 0132); la base también lo impide.
  const [backing] = await tx
    .select({ id: consentDocument.id })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        eq(consentDocument.status, "firmado"),
        or(
          eq(consentDocument.paperDocumentId, documentId),
          eq(consentDocument.pdfDocumentId, documentId),
          eq(consentDocument.revokePdfDocumentId, documentId),
        ),
      ),
    )
    .limit(1)
  if (backing)
    throw new ServiceError(
      "DOCUMENT_BACKS_CONSENT",
      409,
      "Este archivo respalda un consentimiento firmado y no se puede retirar. Si se cargó por error, revoca ese consentimiento: después podrás retirarlo y volver a firmar.",
    )
  const [row] = await tx
    .update(patientDocument)
    .set({ retiredAt: new Date(), retiredBy: actorUserId, retireReason: reason })
    .where(and(eq(patientDocument.id, documentId), eq(patientDocument.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "document.retired", "patient_document", documentId, {
    patientId,
    reason,
  })
  return mergeDocumentContext(
    row!,
    await currentDocumentContext(tx, orgId, patientId, documentId, false),
  )
}

/** Marca el informe de una imagen (pendiente, informada, no requiere). */
export async function setDocumentReportStatus(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
  input: { reportStatus: string },
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  if (!(REPORT_STATUSES as readonly string[]).includes(input.reportStatus))
    throw validation(`Estado de informe no reconocido: ${input.reportStatus}`)
  const current = await requireDocumentRow(tx, orgId, patientId, documentId)
  if (current.retiredAt)
    throw new ServiceError("DOCUMENT_RETIRED", 409, "El archivo está retirado")
  const [row] = await tx
    .update(patientDocument)
    .set({ reportStatus: input.reportStatus })
    .where(and(eq(patientDocument.id, documentId), eq(patientDocument.organizationId, orgId)))
    .returning()
  await audit(tx, orgId, actorUserId, "document.report_status", "patient_document", documentId, {
    patientId,
    from: current.reportStatus,
    to: input.reportStatus,
  })
  return mergeDocumentContext(
    row!,
    await currentDocumentContext(tx, orgId, patientId, documentId, false),
  )
}

/**
 * «No mostrar en su portal» (ADR 0156): la clínica oculta un archivo subido o
 * una imagen del portal del paciente, para todo acceso de hoy y de mañana, y lo
 * vuelve a mostrar sin pedir nada. Lo cambia quien escribe en la historia
 * (`clinical.write`, en la ruta) y queda su traza. Retirado, ya no cambia.
 */
export async function setDocumentPortalVisibility(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
  input: { hidden: boolean },
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  if (typeof input.hidden !== "boolean") throw invalidField("hidden", "Di si se oculta o se muestra")
  const current = await requireDocumentRow(tx, orgId, patientId, documentId)
  if (current.retiredAt)
    throw new ServiceError("DOCUMENT_RETIRED", 409, "El archivo está retirado")
  // El PDF de un consentimiento (y su revocación o su hoja escaneada) va dentro del
  // consentimiento: ocultar el archivo no lo sacaría del portal, así que no se promete.
  const [inside] = await tx
    .select({ id: consentDocument.id })
    .from(consentDocument)
    .where(
      and(
        eq(consentDocument.organizationId, orgId),
        or(
          eq(consentDocument.pdfDocumentId, documentId),
          eq(consentDocument.revokePdfDocumentId, documentId),
          eq(consentDocument.paperDocumentId, documentId),
        ),
      ),
    )
    .limit(1)
  if (inside)
    throw new ServiceError(
      "DOCUMENT_INSIDE_PAPER",
      409,
      "Este archivo va dentro de su consentimiento: en su portal se ve el consentimiento, no el archivo suelto",
    )
  const hiddenNow = current.portalHiddenAt !== null
  if (hiddenNow === input.hidden) return getPatientDocument(tx, orgId, patientId, documentId)
  await tx
    .update(patientDocument)
    .set(
      input.hidden
        ? { portalHiddenAt: new Date(), portalHiddenBy: actorUserId }
        : { portalHiddenAt: null, portalHiddenBy: null },
    )
    .where(and(eq(patientDocument.id, documentId), eq(patientDocument.organizationId, orgId)))
  await audit(
    tx,
    orgId,
    actorUserId,
    input.hidden ? "document.portal_hidden" : "document.portal_shown",
    "patient_document",
    documentId,
    { patientId },
  )
  return getPatientDocument(tx, orgId, patientId, documentId)
}

export async function getPatientDocument(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  const row = await requireDocumentRow(tx, orgId, patientId, documentId)
  const [doc] = await withImaging(tx, orgId, [
    mergeDocumentContext(row, await currentDocumentContext(tx, orgId, patientId, documentId, false)),
  ])
  return doc!
}

/** Historial de contextos del documento (versiones ascendentes, inmutable). */
export async function listDocumentContextHistory(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<DocumentContextRow[]> {
  await requirePatient(tx, orgId, patientId)
  await requireDocumentRow(tx, orgId, patientId, documentId)
  const rows = await tx
    .select()
    .from(patientDocumentContext)
    .where(
      and(
        eq(patientDocumentContext.documentId, documentId),
        eq(patientDocumentContext.patientId, patientId),
        eq(patientDocumentContext.organizationId, orgId),
      ),
    )
    .orderBy(asc(patientDocumentContext.version))
  const site = await siteOf(tx, orgId)
  return rows.map((row) => withTeeth(site, row))
}

/** Documento fusionado con su historial de contextos (detalle para el visor). */
export async function getPatientDocumentWithHistory(
  tx: Db,
  orgId: string,
  patientId: string,
  documentId: string,
): Promise<{ document: PatientDocumentWithContext; history: DocumentContextRow[] }> {
  await requirePatient(tx, orgId, patientId)
  const row = await requireDocumentRow(tx, orgId, patientId, documentId)
  const history = await listDocumentContextHistory(tx, orgId, patientId, documentId)
  const current = history.length ? history[history.length - 1]! : null
  return { document: mergeDocumentContext(row, current), history }
}

/** Corrección documental versionada: inserta una versión completa nueva con
 * bloqueo optimista. Nunca muta el blob, la clasificación original ni la
 * clínica de la atención (ni siquiera si está cerrada). La fecha del documento
 * se corrige aquí, con su motivo: la versión guarda la nueva y el archivo la copia. */
export async function correctDocumentContext(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  documentId: string,
  input: CorrectDocumentContextInput,
): Promise<PatientDocumentWithContext> {
  await requirePatient(tx, orgId, patientId)
  const row = await requireDocumentRow(tx, orgId, patientId, documentId)
  if (row.retiredAt)
    throw new ServiceError("DOCUMENT_RETIRED", 409, "El archivo está retirado: su contexto ya no se corrige")
  const current = await currentDocumentContext(tx, orgId, patientId, documentId, true)
  if (!current) throw notFound("Contexto del documento")
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw validation("expectedVersion debe ser un entero mayor a 0")
  }
  if (current.version !== input.expectedVersion) {
    throw conflict(
      "STALE_VERSION",
      `El documento cambió (versión vigente ${current.version}); recarga e intenta de nuevo`,
    )
  }
  const encounterId = input.encounterId === undefined ? current.encounterId : input.encounterId
  const planItemId = input.planItemId === undefined ? current.planItemId : input.planItemId
  const site = await siteOf(tx, orgId)
  const toothNumbers =
    input.toothNumbers === undefined || input.toothNumbers === null
      ? [...current.toothNumbers]
      : normalizeDocumentTeeth(site, input.toothNumbers)
  const tags =
    input.tags === undefined || input.tags === null
      ? [...current.tags]
      : normalizeDocumentTags(input.tags)
  if (encounterId) await requireVisibleEncounter(tx, orgId, patientId, encounterId)
  if (planItemId) await requirePatientPlanItem(tx, orgId, patientId, planItemId)
  const extended = extendedDocumentLinks(input, current)
  await validateExtendedDocumentLinks(tx, orgId, patientId, extended)
  const date = correctedDocumentDate(row.capturedAt, row.category, input)
  if (date.changed) {
    // El PDF que genera la firma (o la revocación) lleva la fecha de ese hecho: no se corrige
    // a mano. La hoja escaneada sí, porque la fecha la dice quien la sube. La base también lo impide.
    const [generated] = await tx
      .select({ id: consentDocument.id })
      .from(consentDocument)
      .where(
        and(
          eq(consentDocument.organizationId, orgId),
          or(eq(consentDocument.pdfDocumentId, documentId), eq(consentDocument.revokePdfDocumentId, documentId)),
        ),
      )
      .limit(1)
    if (generated)
      throw new ServiceError(
        "DOCUMENT_DATE_FIXED",
        409,
        "Este papel lo generó la firma del consentimiento: su fecha es la de la firma y no se cambia.",
      )
  }
  let inserted: typeof patientDocumentContext.$inferSelect | undefined
  try {
    ;[inserted] = await tx
      .insert(patientDocumentContext)
      .values({
        organizationId: orgId,
        patientId,
        documentId,
        version: current.version + 1,
        encounterId,
        planItemId,
        ...extended,
        ...siteCodesColumns(site, toothNumbers),
        tags,
        capturedAt: date.capturedAt,
        dateReason: date.reason,
        authorUserId: actorUserId,
      })
      .returning()
  } catch (e) {
    // Carrera perdida contra otra corrección: nada se mutó, el cliente recarga.
    if (isUniqueViolation(e)) {
      throw conflict(
        "STALE_VERSION",
        "El documento cambió mientras se guardaba; recarga e intenta de nuevo",
      )
    }
    throw e
  }
  if (!inserted) throw new Error("No se pudo corregir el contexto del documento")
  const next = withTeeth(site, inserted)
  let document = row
  if (date.changed) {
    // La vigente se copia en el archivo: todo lo que lee la fecha la ve igual (la base exige que coincida).
    const [updated] = await tx
      .update(patientDocument)
      .set({ capturedAt: date.capturedAt })
      .where(and(eq(patientDocument.id, documentId), eq(patientDocument.organizationId, orgId)))
      .returning()
    if (!updated) throw new Error("No se pudo corregir la fecha del documento")
    document = updated
  }
  await audit(
    tx,
    orgId,
    actorUserId,
    "document.context_corrected",
    "patient_document_context",
    next.id,
    {
      patientId,
      documentId,
      fromVersion: current.version,
      toVersion: next.version,
      encounterId,
      planItemId,
      ...(date.changed
        ? { capturedFrom: row.capturedAt?.toISOString() ?? null, capturedTo: date.capturedAt?.toISOString() ?? null, dateReason: date.reason }
        : {}),
    },
  )
  return mergeDocumentContext(document, next)
}

/**
 * La fecha propia de un documento (la de toma, en una imagen): válida, desde 1900 y
 * nunca futura, con cinco minutos de margen por relojes de equipos desfasados.
 */
function documentDate(value: string | Date, category: string): Date {
  const words = isImageDocumentCategory(category) ? "La fecha de toma" : "La fecha del documento"
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw invalidField("capturedAt", `${words} no es válida`)
  if (date.getTime() < EARLIEST_DOCUMENT_DATE) throw invalidField("capturedAt", `${words} no puede ser anterior a 1900`)
  if (date.getTime() > Date.now() + 5 * 60_000) throw invalidField("capturedAt", `${words} no puede ser futura`)
  return date
}

/** Un papel clínico anterior a 1900 es un error al escribir el año. */
const EARLIEST_DOCUMENT_DATE = Date.UTC(1900, 0, 1)

/**
 * La fecha de una corrección: la vigente si no se toca; la nueva, con su motivo,
 * si cambia.
 */
function correctedDocumentDate(
  current: Date | null,
  category: string,
  input: Pick<CorrectDocumentContextInput, "capturedAt" | "dateReason">,
): { capturedAt: Date | null; reason: string | null; changed: boolean } {
  if (input.capturedAt === undefined) return { capturedAt: current, reason: null, changed: false }
  const next = input.capturedAt === null ? null : documentDate(input.capturedAt, category)
  if ((next?.getTime() ?? null) === (current?.getTime() ?? null)) return { capturedAt: current, reason: null, changed: false }
  const reason = input.dateReason?.trim() ?? ""
  if (!reason) throw invalidField("dateReason", "Escribe por qué cambias la fecha.")
  if (reason.length > 500) throw invalidField("dateReason", "El motivo admite hasta 500 caracteres.")
  return { capturedAt: next, reason, changed: true }
}

/** Contextos vigentes por lote para hidratar historia/timeline sin leer las
 * columnas retiradas. Solo devuelve documentos del paciente y la org. */
export async function getCurrentDocumentContexts(
  tx: Db,
  orgId: string,
  patientId: string,
  documentIds: readonly string[],
): Promise<Map<string, DocumentContextRow>> {
  const ids = [...new Set(documentIds)]
  if (!ids.length) return new Map()
  await requirePatient(tx, orgId, patientId)
  const latest = await latestDocumentContexts(tx, orgId, patientId, ids)
  return new Map(latest.map((ctx) => [ctx.documentId, ctx]))
}

/** Documentos cuyo contexto vigente apunta a la atención (para
 * getEncounterDetail; reemplaza la lectura de patient_document.encounterId). */
export async function listEncounterDocuments(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
): Promise<PatientDocumentWithContext[]> {
  await requirePatient(tx, orgId, patientId)
  await requireVisibleEncounter(tx, orgId, patientId, encounterId)
  // Vigente PRIMERO por documento (DISTINCT ON) y recién DESPUÉS se filtra por
  // atención: filtrar antes elegiría la última versión que apuntó a la atención
  // aunque una versión posterior ya la hubiera desvinculado o movido.
  const latest = await latestDocumentContexts(tx, orgId, patientId)
  const current = latest.filter((ctx) => ctx.encounterId === encounterId)
  if (!current.length) return []
  const docs = await tx
    .select()
    .from(patientDocument)
    .where(
      and(
        eq(patientDocument.patientId, patientId),
        eq(patientDocument.organizationId, orgId),
        isNull(patientDocument.retiredAt),
        inArray(
          patientDocument.id,
          current.map((ctx) => ctx.documentId),
        ),
      ),
    )
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  return current
    .map((ctx) => ({ ctx, doc: byId.get(ctx.documentId)! }))
    .filter((entry) => entry.doc)
    .sort(
      (a, b) =>
        a.doc.createdAt.getTime() - b.doc.createdAt.getTime() || (a.doc.id < b.doc.id ? -1 : 1),
    )
    .map((entry) => mergeDocumentContext(entry.doc, entry.ctx))
}

