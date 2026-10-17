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
