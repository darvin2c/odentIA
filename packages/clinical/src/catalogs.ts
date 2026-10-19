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
