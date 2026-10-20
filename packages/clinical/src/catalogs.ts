/**
 * Listas cerradas del dominio que comparten la base (sus CHECK), los servicios
 * y las pantallas. Viven aquí, sin dependencias de servidor, para que las apps
 * las importen en vez de copiarlas (fase 4, «listas copiadas a mano»). Una
 * prueba de servicios compara cada CHECK de la base con su lista
 * (`catalog-checks.test.ts`): si una cambia, la otra también.
 */

/** Gravedad de una alergia; sin dato, «desconocida». */
export const ALLERGY_SEVERITIES = ["leve", "moderada", "severa", "desconocida"] as const
export type AllergySeverity = (typeof ALLERGY_SEVERITIES)[number]

/**
 * Por qué se quitó una alergia (tablero 7 del lienzo de Pacientes): «ya no es
 * alérgica» (FHIR `clinicalStatus` resolved), «era otra cosa» (refuted) o «se
 * registró por error» (entered-in-error). Quitar nunca borra.
 */
export const ALLERGY_REMOVAL_REASONS = ["ya_no", "otra_cosa", "error"] as const
export type AllergyRemovalReason = (typeof ALLERGY_REMOVAL_REASONS)[number]

/** Quién dijo la alergia: el equipo que la registró o el paciente (FHIR `asserter`). */
export const ALLERGY_SOURCES = ["equipo", "paciente"] as const
export type AllergySource = (typeof ALLERGY_SOURCES)[number]

/** De qué lista sale el código de la sustancia: ATC de la OMS o la lista propia (ADR 0070). */
export const ALLERGEN_SYSTEMS = ["atc", "odentia"] as const
export type AllergenSystem = (typeof ALLERGEN_SYSTEMS)[number]

/** Frecuencia de la medicación habitual, elegida de una lista; otra se escribe. */
export const MEDICATION_FREQUENCIES = ["cada_8_h", "cada_12_h", "cada_24_h", "segun_necesidad"] as const
export type MedicationFrequency = (typeof MEDICATION_FREQUENCIES)[number]

/**
 * Unidad de la dosis en código UCUM: masa, volumen y unidades internacionales,
 * y las formas que se cuentan como anotaciones (`{tbl}` un comprimido).
 */
export const DOSE_UNITS = ["mg", "g", "ug", "mL", "[iU]", "{tbl}", "{cap}", "{drop}", "{puff}"] as const
export type DoseUnit = (typeof DOSE_UNITS)[number]

/** Estado de un antecedente (FHIR Condition.clinicalStatus en palabras de la clínica). */
export const CONDITION_STATUSES = ["activa", "resuelta", "inactiva"] as const
export type ConditionStatus = (typeof CONDITION_STATUSES)[number]

/** Responsabilidades sobre un paciente: quién decide, quién se informa y quién paga. */
export const RESPONSIBILITY_KINDS = ["representante_legal", "autorizado_informacion", "responsable_economico"] as const
export type ResponsibilityKind = (typeof RESPONSIBILITY_KINDS)[number]

/** Estado de un control clínico. */
export const FOLLOW_UP_STATUSES = ["pendiente", "programado", "realizado", "cancelado"] as const
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number]

/**
 * Lo que se sube como documento del paciente. Presupuestos, recetas y
 * comprobantes no se suben: salen de sus propias tablas.
 */
export const PATIENT_DOCUMENT_CATEGORIES = ["consentimiento", "radiografia", "foto_clinica", "informe", "otro"] as const
export type PatientDocumentCategory = (typeof PATIENT_DOCUMENT_CATEGORIES)[number]

/**
 * «Cómo nos conoció» (decisión 3 de Reportes v2): una lista fija, la misma en
 * todas las clínicas, para que se pueda sumar y dibujar. No hay un estándar
 * internacional del origen de un paciente (HL7 FHIR no lo codifica), por eso la
 * lista es propia y corta. «otro» guarda lo que dijo en `referral_source`; lo
 * que se escribía antes como texto libre quedó como «otro» con su texto.
 */
export const REFERRAL_KINDS = ["recomendacion", "redes_sociales", "google_mapas", "paso_por_aqui", "convenio", "otro"] as const
export type ReferralKind = (typeof REFERRAL_KINDS)[number]

export const REFERRAL_KIND_LABELS: Record<ReferralKind, string> = {
  recomendacion: "Recomendación de alguien",
  redes_sociales: "Redes sociales",
  google_mapas: "Google o mapas",
  paso_por_aqui: "Pasaba por aquí",
  convenio: "Convenio o empresa",
  otro: "Otro",
}
