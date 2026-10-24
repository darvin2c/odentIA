/**
 * Equivalencias de los códigos propios de odentIA con HL7 FHIR R4 (4.0.1),
 * para la copia de la historia que se entrega a la persona (issue 45, ADR
 * 0080). Los códigos internos no se renombran: se traducen aquí, en un solo
 * lugar y con pruebas. Lo que no tiene equivalencia segura no se inventa: va
 * como texto.
 */

/** Versión de FHIR de la exportación. Cambiarla es una decisión nueva (ADR 0080). */
export const FHIR_VERSION = "4.0.1"

/** HL7 AdministrativeGender desde `SEX_CODES` (ISO/IEC 5218). */
export const SEX_TO_FHIR_GENDER = {
  M: "male",
  F: "female",
  I: "other",
  D: "unknown",
} as const

/** Encounter.status (R4) desde `encounter.status`. */
export const ENCOUNTER_STATUS_FHIR = {
  borrador: "in-progress",
  finalizada: "finished",
  anulada: "entered-in-error",
} as const

/** Appointment.status (R4) desde `appointment.status`. */
export const APPOINTMENT_STATUS_FHIR = {
  programada: "booked",
  confirmada: "booked",
  atendida: "fulfilled",
  no_asistio: "noshow",
  cancelada: "cancelled",
} as const

/** Condition.clinicalStatus desde el diagnóstico de la atención y el antecedente. */
export const CONDITION_CLINICAL_STATUS_FHIR = {
  activo: "active",
  resuelto: "resolved",
  activa: "active",
  resuelta: "resolved",
  inactiva: "inactive",
} as const
export const FHIR_CONDITION_CLINICAL_SYSTEM = "http://terminology.hl7.org/CodeSystem/condition-clinical"

/** AllergyIntolerance (R4) desde `patient_allergy`. */
export const ALLERGY_TYPE_FHIR = { alergia: "allergy", intolerancia: "intolerance" } as const
export const ALLERGY_CRITICALITY_FHIR = { baja: "low", alta: "high", no_evaluable: "unable-to-assess" } as const
export const ALLERGY_VERIFICATION_FHIR = {
  no_confirmada: "unconfirmed",
  confirmada: "confirmed",
  descartada: "refuted",
} as const
/** `category` de FHIR solo tiene food, medication, environment y biologic: lo demás va como texto. */
export const ALLERGY_CATEGORY_FHIR = {
  medicamento: "medication",
  anestesico: "medication",
  alimento: "food",
  ambiental: "environment",
} as const
export const ALLERGY_SEVERITY_FHIR = { leve: "mild", moderada: "moderate", severa: "severe" } as const
export const FHIR_ALLERGY_CLINICAL_SYSTEM = "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical"
export const FHIR_ALLERGY_VERIFICATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification"

/** MedicationRequest.status desde `prescription.status`. */
export const PRESCRIPTION_STATUS_FHIR = { emitida: "active", anulada: "cancelled" } as const

/** Consent.status (R4) desde `consent_document.status`. */
export const CONSENT_STATUS_FHIR = {
  pendiente: "proposed",
  firmado: "active",
  revocado: "inactive",
  anulado: "entered-in-error",
} as const
/** Consent.scope y Consent.category son obligatorios en R4: tratamiento y consentimiento del paciente (LOINC). */
export const FHIR_CONSENT_SCOPE = {
  system: "http://terminology.hl7.org/CodeSystem/consentscope",
  code: "treatment",
} as const
export const FHIR_CONSENT_CATEGORY = { system: "http://loinc.org", code: "59284-0", display: "Patient Consent" } as const

/** Observation de signos vitales: categoría `vital-signs` y unidades UCUM. */
export const FHIR_OBSERVATION_CATEGORY_SYSTEM = "http://terminology.hl7.org/CodeSystem/observation-category"
export const FHIR_UCUM_SYSTEM = "http://unitsofmeasure.org"
export const FHIR_LOINC_SYSTEM = "http://loinc.org"
/** Por qué falta un valor; `not-performed`: no se examinó (issue 229, decisión 5). */
export const FHIR_DATA_ABSENT_REASON_SYSTEM = "http://terminology.hl7.org/CodeSystem/data-absent-reason"
/** N, normal; A, anormal: la lectura de una parte del examen. */
export const FHIR_OBSERVATION_INTERPRETATION_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"

/** Parentesco de una persona vinculada: v3-RoleCode, con «otro» como texto. */
export const FHIR_ROLE_CODE_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"

/** El código FHIR de un valor propio, o null si no tiene equivalencia segura. */
export function fhirCode<T extends Record<string, string>>(table: T, value: string | null | undefined): T[keyof T] | null {
  if (!value || !Object.hasOwn(table, value)) return null
  return table[value as keyof T]
}
