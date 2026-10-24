import {
  ALLERGY_SEVERITIES,
  PATIENT_DOCUMENT_CATEGORIES,
  BLOOD_GROUPS,
  type BloodGroup,
  codeAllergySubstance,
  DOSE_UNITS,
  type DoseUnit,
  doseText,
  findHabitualMedication,
  MEDICATION_FREQUENCIES,
  MEDICATION_FREQUENCY_LABELS,
  type MedicationFrequency,
  IMAGE_TYPE_LABELS,
  type ImageType,
  imageTypeCategory,
  isImageType,
  normalizeDrugText,
  normalizeTags,
  type RegistrationAnswers,
  REPORT_STATUSES,
  type ReportStatus,
  registrationAnswersSchema,
  DIAGNOSIS_VERIFICATION,
  FAMILY_KINSHIP,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  clinicalFollowUp,
  clinicalNote,
  encounter,
  encounterProcedure,
  encounterSite,
  imagingStudy,
  imagingStudyFile,
  patient,
  patientAllergy,
  patientAnamnesis,
  patientCondition,
  patientFamilyHistory,
  patientDocument,
  patientDocumentContext,
  patientMedication,
  patientPayment,
  patientRegistration,
  prescription,
  treatmentBudget,
  treatmentPlanItem,
} from "@odentia/db/schema/clinical"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import { allergyReviewDue } from "./allergies.js"
import { decodeCursor, encodeCursor } from "./cursors.js"
import { resolveOptionalDiagnosisCode } from "./diagnosis-codes.js"
import { isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { requirePatient } from "./patients.js"
import { type ProductSite, type SiteColumns, withSite } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** El «dónde» del producto de la clínica (odentIA: piezas y caras). */
const siteOf = async (tx: Db, orgId: string): Promise<ProductSite> => (await productHooks(tx, orgId)).site

/** La atención en borrador de este paciente, bloqueada para escribir en ella. */
export async function requireDraftLink(
  tx: Db,
  orgId: string,
  patientId: string,
  encounterId: string,
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
  allergies: HealthAllergyRow[]
  conditions: HealthConditionRow[]
  medications: HealthMedicationRow[]
  latestAnamnesis: AnamnesisRow | null
}

function assertText(
  value: string | null | undefined,
  max: number,
  name: string,
  required: boolean,
): string | null {
  const trimmed = value?.trim() ?? ""
  if (!trimmed) {
    if (required) throw validation(`${name} es obligatorio (1–${max} caracteres)`)
    return null
  }
  if (trimmed.length > max) throw validation(`${name} debe tener hasta ${max} caracteres`)
  return trimmed
}

function assertDateStr(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value === "") return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw validation(`${name} debe ser una fecha YYYY-MM-DD válida`)
  const [y, m, d] = value.split("-").map(Number)
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== (m as number) - 1 ||
    date.getUTCDate() !== d
  ) {
    throw validation(`${name} debe ser una fecha YYYY-MM-DD válida`)
  }
  return value
}

function assertDateRange(start: string | null, end: string | null): void {
  if (start && end && start > end)
    throw validation("La fecha de inicio no puede ser posterior a la de fin")
}

/** Claves que la entrevista nueva no acepta: viven en la atención o en listas estructuradas. */
const FORBIDDEN_ANAMNESIS_TOP = [
  "motivoConsulta",
  "tiempoEnfermedad",
  "examenClinico",
  "diagnosticoPresuntivo",
  "diagnosticoCie10",
]

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

function validateAllergyRow(input: HealthAllergyInput): ValidatedAllergy {
  const substance = assertText(input.substance, 200, "substance", true) as string
  const reaction = assertText(input.reaction, 2000, "reaction", false)
  const severity = input.severity?.trim() || "desconocida"
  if (!(ALLERGY_SEVERITIES as readonly string[]).includes(severity)) {
    throw validation("severity debe ser leve, moderada, severa o desconocida")
  }
  const kind = input.kind?.trim() || "alergia"
  if (!["alergia", "intolerancia"].includes(kind)) throw validation("kind debe ser alergia o intolerancia")
  const criticality = input.criticality?.trim() || null
  if (criticality && !["baja", "alta", "no_evaluable"].includes(criticality))
    throw validation("criticality debe ser baja, alta o no_evaluable")
  const verification = input.verification?.trim() || "no_confirmada"
  if (!["no_confirmada", "confirmada", "descartada"].includes(verification))
    throw validation("verification debe ser no_confirmada, confirmada o descartada")
  const category = input.category?.trim() || null
  if (category && !(ALLERGY_CATEGORIES as readonly string[]).includes(category))
    throw validation("category inválida para la alergia")
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

function validateConditionRow(input: HealthConditionInput): ValidatedCondition {
  const name = assertText(input.name, 200, "name", true) as string
  if (!(CONDITION_STATUSES as readonly string[]).includes(input.status))
    throw validation("status inválido")
  const startDate = assertDateStr(input.startDate, "startDate")
  let endDate = assertDateStr(input.endDate, "endDate")
  if (!endDate && input.status === "resuelta") endDate = todayDate()
  assertDateRange(startDate, endDate)
  const notes = assertText(input.notes, 2000, "notes", false)
  const diagnosisCode = input.diagnosisCode?.trim() || null
  const diagnosisSystem = diagnosisCode ? input.diagnosisSystem?.trim() || null : null
  return { id: input.id ?? null, name, diagnosisCode, diagnosisSystem, status: input.status, startDate, endDate, notes }
}

function validateMedicationRow(input: HealthMedicationInput): ValidatedMedication {
  const name = assertText(input.name, 200, "name", true) as string
  const genericName = assertText(input.genericName, 200, "genericName", false)
  // La DCI de la lista lleva su código ATC, el mismo de la receta; lo escrito a mano, ninguno.
  const atcCode = findHabitualMedication(genericName ?? name)?.atc ?? null
  const doseUnit = input.doseUnit?.trim() || null
  const doseValue = input.doseValue ?? null
  if ((doseValue === null) !== (doseUnit === null))
    throw validation("La dosis lleva número y unidad, o ninguno de los dos")
  if (doseUnit && !(DOSE_UNITS as readonly string[]).includes(doseUnit)) throw validation("Elige la unidad de la lista")
  if (doseValue !== null && (!Number.isFinite(doseValue) || doseValue <= 0 || doseValue >= 10_000_000))
    throw validation("La dosis debe ser un número mayor que cero")
  const frequencyCode = input.frequencyCode?.trim() || null
  if (frequencyCode && !(MEDICATION_FREQUENCIES as readonly string[]).includes(frequencyCode))
    throw validation("Elige la frecuencia de la lista")
  // Lo escrito acompaña siempre a lo estructurado, para leerlo igual que antes.
  const dose =
    doseValue !== null && doseUnit
      ? doseText(doseValue, doseUnit as DoseUnit)
      : assertText(input.dose, 200, "dose", false)
  const frequency = frequencyCode
    ? MEDICATION_FREQUENCY_LABELS[frequencyCode as MedicationFrequency]
    : assertText(input.frequency, 200, "frequency", false)
  const startDate = assertDateStr(input.startDate, "startDate")
  const endDate = assertDateStr(input.endDate, "endDate")
  assertDateRange(startDate, endDate)
  const notes = assertText(input.notes, 2000, "notes", false)
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
  return {
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
}
function assertReviewStatus(input: HealthReviewStatusInput): {
  allergies: string
  conditions: string
  medications: string
} {
  if (!input || typeof input !== "object") throw validation("reviewStatus es obligatorio")
  const record: Record<string, unknown> = {
    allergies: input.allergies,
    conditions: input.conditions,
    medications: input.medications,
  }
  const expected = ["allergies", "conditions", "medications"]
  for (const key of expected) {
    if (!(HEALTH_REVIEW_STATES as readonly string[]).includes(record[key] as string)) {
      throw validation(`reviewStatus.${key} debe ser unknown, none o recorded`)
    }
  }
  for (const key of Object.keys(input)) {
    if (!expected.includes(key)) throw validation(`reviewStatus.${key} no es un grupo válido`)
  }
  return {
    allergies: input.allergies,
    conditions: input.conditions,
    medications: input.medications,
  }
}
export type DeclaredPatientHealthInput = NonNullable<RegistrationAnswers["health"]>

export async function initializeDeclaredPatientHealth(
  tx: Db,
  orgId: string,
  patientId: string,
  input: DeclaredPatientHealthInput,
  actorUserId: string | null,
): Promise<PatientHealth> {
  const parsed = registrationAnswersSchema.shape.health.safeParse(input)
  if (!parsed.success || !parsed.data) throw validation("Declaración de salud inválida")
  const declared = parsed.data
  const hasData =
    declared.bloodGroup != null ||
    [declared.allergies, declared.conditions, declared.medications].some(
      (group) => group && group.state !== "unanswered",
    ) ||
    [declared.personal, declared.dental, declared.medical].some((group) =>
      Object.values(group ?? {}).some((value) => value !== undefined && value !== ""),
    )
  if (!hasData) return getPatientHealth(tx, orgId, patientId)
  const state = (value: string | undefined) =>
    value === "none" || value === "recorded" ? value : "unknown"
  // Lo que declaró entra a la entrevista de la ficha como la arma su producto (odentIA: su boca; latidIA: el embarazo con fecha).
  const interview = (await productHooks(tx, orgId)).interview.declared(declared, await clinicToday(tx, orgId))
  return persistPatientHealth(tx, orgId, { kind: "declaration", userId: actorUserId }, patientId, {
    expectedRevision: 0,
    bloodGroup: declared.bloodGroup,
    reviewStatus: {
      allergies: state(declared.allergies?.state),
      conditions: state(declared.conditions?.state),
      medications: state(declared.medications?.state),
    },
    allergies: (declared.allergies?.items ?? []).map((item) => ({ ...item, isActive: true })),
    conditions: (declared.conditions?.items ?? []).map((item) => ({ ...item, status: "activa" })),
    medications: declared.medications?.items ?? [],
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
 * pisarlo. Devuelve cuántas alergias añadió.
 */
export async function addDeclaredAllergies(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  declared: DeclaredAllergy[],
  origin: { entity: string; entityId: string },
): Promise<number> {
  if (declared.length === 0) return 0
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
  if (fresh.length === 0) return 0
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
  return fresh.length
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
    throw validation("Grupo sanguíneo inválido")
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
  const medications = input.medications.map(validateMedicationRow)
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
  const checkGroup = (state: string, active: number, name: string): void => {
    if (state === "none" && active > 0) {
      throw validation(`${name}: hay registros activos, no puede marcarse ausencia`)
    }
    if (active > 0 && state !== "recorded") {
      throw validation(`${name}: con registros activos la revisión debe ser registrada`)
    }
  }
  if (sendsAllergies) checkGroup(reviewStatus.allergies, activeAllergies, "alergias")
  checkGroup(reviewStatus.conditions, activeConditions, "condiciones")
  checkGroup(reviewStatus.medications, activeMeds, "medicamentos")
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
  for (const row of conditions) {
    const resolved = await resolveOptionalDiagnosisCode(tx, orgId, { code: row.diagnosisCode, system: row.diagnosisSystem })
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
          atcCode: row.atcCode,
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
      throw validation("familyHistory debe ser un arreglo de hasta 50 antecedentes")
    const rows = []
    for (const row of input.familyHistory) {
      if (!(FAMILY_RELATIONSHIPS as readonly string[]).includes(row.relationship))
        throw validation("Elige el parentesco de la lista")
      rows.push({
        relationship: row.relationship,
        condition: assertText(row.condition, 200, "condition", true) as string,
        ...(await resolveOptionalDiagnosisCode(tx, orgId, { code: row.diagnosisCode, system: row.diagnosisSystem })),
        notes: assertText(row.notes, 2000, "notes", false),
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
    throw validation("Clase ASA inválida (I–VI)")
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
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId)
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
  const candidates = docs.filter((doc) => doc.imageType === "tomografia").map((doc) => doc.id)
  const summaries = await imagingSummaries(tx, orgId, candidates)
  return docs.map((doc) => ({ ...doc, imaging: summaries.get(doc.id) ?? null }))
}

/** Piezas FDI múltiples: enteras válidas, únicas y ordenadas. Vacío = imagen general. */
function normalizeDocumentTeeth(site: ProductSite, input: readonly number[] | null | undefined): number[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw validation("toothNumbers debe ser un arreglo")
  if (input.length > 52) throw validation("toothNumbers admite como máximo 52 piezas")
  const set = new Set<number>()
  for (const tooth of input) {
    if (site.code(tooth) === null) throw validation(site.invalid(tooth))
    set.add(tooth)
  }
  return [...set].sort((a, b) => a - b)
}

/** Etiquetas con el helper canónico compartido (@odentia/clinical, TagsData). */
function normalizeDocumentTags(input: readonly string[] | null | undefined): string[] {
  if (input == null) return []
  if (!Array.isArray(input)) throw validation("tags debe ser un arreglo")
  try {
    return normalizeTags(input)
  } catch (e) {
    throw validation(e instanceof Error ? e.message : "Etiquetas inválidas")
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
  if (!row) throw notFound("Atención")
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
  if (!row) throw notFound("Tratamiento")
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
  for (const [id, table, label] of [
    [input.budgetId, treatmentBudget, "Presupuesto"],
    [input.prescriptionId, prescription, "Receta"],
    [input.followUpId, clinicalFollowUp, "Control"],
    [input.paymentId, patientPayment, "Pago"],
  ] as const) {
    if (!id) continue
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.organizationId, orgId), eq(table.patientId, patientId)))
    if (!row) throw notFound(label)
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
    if (!row) throw notFound("Procedimiento")
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

function normalizeImageInput(category: string, input: DocumentImageInput) {
  let imageType: ImageType | null = null
  if (input.imageType) {
    if (!isImageType(input.imageType)) throw validation(`Tipo de imagen no reconocido: ${input.imageType}`)
    if (imageTypeCategory(input.imageType) !== category)
      throw validation(
        `${IMAGE_TYPE_LABELS[input.imageType]} no corresponde a la categoría ${category}`,
      )
    imageType = input.imageType
  }
  let capturedAt: Date | null = null
  if (input.capturedAt) {
    capturedAt = input.capturedAt instanceof Date ? input.capturedAt : new Date(input.capturedAt)
    if (Number.isNaN(capturedAt.getTime())) throw validation("La fecha de toma no es válida")
    // Margen de cinco minutos por relojes de equipos desfasados.
    if (capturedAt.getTime() > Date.now() + 5 * 60_000)
      throw validation("La fecha de toma no puede ser futura")
  }
  const source = input.source?.trim() || null
  if (source && source.length > 120) throw validation("El origen debe tener hasta 120 caracteres")
  let reportStatus: ReportStatus | null = null
  if (input.reportStatus) {
    if (!(REPORT_STATUSES as readonly string[]).includes(input.reportStatus))
      throw validation(`Estado de informe no reconocido: ${input.reportStatus}`)
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
    throw validation("category inválida")
  const label = input.label?.trim() ?? ""
  if (!label || label.length > 200) throw validation("label debe tener 1–200 caracteres")
  const image = normalizeImageInput(input.category, input)
  if (!input.storageKey) throw validation("storageKey es obligatorio")
  const site = await siteOf(tx, orgId)
  const toothNumbers = normalizeDocumentTeeth(site, input.toothNumbers)
  const tags = normalizeDocumentTags(input.tags)
  // Al registrar solo se permite vincular borradores (la atención aún es mutable).
  if (input.encounterId) await requireDraftLink(tx, orgId, patientId, input.encounterId)
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
    .orderBy(desc(takenAt), desc(patientDocument.id))
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
  if (!reason || reason.length > 2000) throw validation("El motivo debe tener 1–2000 caracteres")
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
 * clínica de la atención (ni siquiera si está cerrada). */
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
    },
  )
  return mergeDocumentContext(row, next)
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

