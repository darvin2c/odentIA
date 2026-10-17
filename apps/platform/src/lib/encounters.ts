/**
 * Cliente del ciclo de la atención (ADR 0002 y 0003): cierre guiado por
 * requisitos, anulación con motivo, relevo, diagnósticos CIE-10 como entidad
 * y perfil profesional con el que se firma.
 */
import { apiFetch } from "./api"
import type { ConsentNeed } from "./encounter-documents"
import type { Encounter, ProcedureItem } from "./patients"

export type ClosingRequirement = "reason" | "diagnosis" | "evolution" | "signature"

export interface ClosingCheck {
  ready: boolean
  missing: ClosingRequirement[]
  /**
   * Consentimientos que pide la atención y no están firmados. No bloquean:
   * cerrar sin ellos pide decir por qué (`consentSkipReason`).
   */
  consents: ConsentNeed[]
  /**
   * En clínicas de Perú, el odontograma que firmará este cierre (su momento y
   * lo que cambió en la atención); null si no cambió el gráfico o la clínica
   * no firma odontogramas.
   */
  odontogram: ClosingOdontogram | null
}

/** El odontograma firmado que deja el cierre (solo en clínicas de Perú, NTS 188). */
export interface ClosingOdontogram {
  purpose: "initial" | "new_findings" | "completion"
  standard: string
  shortName: string
  findings: Array<{ condition: string; teeth: number[] }>
}

/** Texto de cada requisito pendiente, en el orden de la historia clínica. */
export const CLOSING_REQUIREMENT_LABELS: Record<ClosingRequirement, string> = {
  reason: "Motivo de consulta",
  diagnosis: "Al menos un diagnóstico con su tipo (presuntivo basta)",
  evolution: "Evolución",
  signature: "Tu colegiatura en el perfil profesional",
}

export interface EncounterDiagnosis {
  id: string
  patientId: string
  encounterId: string | null
  /** Lista del código: «ICD-10» o «ICD-11». */
  diagnosisSystem: string
  diagnosisCode: string
  /** HL7 FHIR verificationStatus: provisional («Presuntivo») o confirmed («Definitivo»). */
  diagnosisType: "provisional" | "confirmed" | null
  /** «Ya diagnosticado antes»: lo marca el sistema (decisión 11). */
  previouslyDiagnosed: boolean
  toothNumber: number | null
  surfaces: string[]
  note: string | null
  status: "activo" | "resuelto"
  resolvedAt: string | null
  legacyNoteId: string | null
  createdBy: string | null
  createdAt: string
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
}

/** Diagnóstico de la lista de problemas del paciente. */
export interface PatientDiagnosis extends EncounterDiagnosis {
  description: string
  encounterStartedAt: string | null
  authorName: string | null
}

export const DIAGNOSIS_STATUS_LABELS: Record<string, string> = {
  activo: "Activo",
  resuelto: "Resuelto",
}

export interface ProfessionalProfile {
  userId: string
  accountName: string
  signatureName: string | null
  /** Vacíos mientras la persona no los escriba: no hay título ni colegio por defecto. */
  professionalTitle: string
  registrationBody: string
  registrationNumber: string | null
  specialtyRegistration: string | null
  complete: boolean
  updatedAt: string | null
}

export interface ProfessionalProfileInput {
  signatureName?: string | null
  professionalTitle?: string
  registrationBody?: string
  registrationNumber?: string | null
  specialtyRegistration?: string | null
}

const base = (patientId: string) => `/api/patients/${patientId}`

function post<T>(url: string, body?: unknown): Promise<{ data: T }> {
  return apiFetch<{ data: T }>(url, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function fetchEncounterClosing(patientId: string, encounterId: string) {
  return apiFetch<{ data: ClosingCheck }>(`${base(patientId)}/encounters/${encounterId}/closing`)
}

export function voidEncounterApi(patientId: string, encounterId: string, reason: string) {
  return post<Encounter>(`${base(patientId)}/encounters/${encounterId}/void`, { reason })
}

export function takeOverEncounterApi(patientId: string, encounterId: string) {
  return post<Encounter>(`${base(patientId)}/encounters/${encounterId}/take-over`)
}

export function voidProcedureApi(
  patientId: string,
  encounterId: string,
  procedureId: string,
  reason: string,
) {
  return post<ProcedureItem>(
    `${base(patientId)}/encounters/${encounterId}/procedures/${procedureId}/void`,
    { reason },
  )
}

export function addDiagnosisApi(
  patientId: string,
  encounterId: string,
  body: {
    diagnosisCode: string
    diagnosisSystem?: string | null
    diagnosisType: string
    toothNumber?: number | null
    surfaces?: string[]
    note?: string | null
  },
) {
  return post<EncounterDiagnosis>(`${base(patientId)}/encounters/${encounterId}/diagnoses`, body)
}

export function voidDiagnosisApi(
  patientId: string,
  encounterId: string,
  diagnosisId: string,
  reason: string,
) {
  return post<EncounterDiagnosis>(
    `${base(patientId)}/encounters/${encounterId}/diagnoses/${diagnosisId}/void`,
    { reason },
  )
}

export function fetchPatientDiagnoses(patientId: string, status?: "activo" | "resuelto") {
  const query = status ? `?status=${status}` : ""
  return apiFetch<{ data: PatientDiagnosis[] }>(`${base(patientId)}/diagnoses${query}`)
}

export function setDiagnosisStatusApi(
  patientId: string,
  diagnosisId: string,
  status: "activo" | "resuelto",
) {
  return apiFetch<{ data: EncounterDiagnosis }>(`${base(patientId)}/diagnoses/${diagnosisId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })
}

export function fetchMyProfessionalProfile() {
  return apiFetch<{ data: ProfessionalProfile }>("/api/clinical-forms/professionals/me/profile")
}

export function fetchProfessionalProfiles() {
  return apiFetch<{ data: ProfessionalProfile[] }>("/api/clinical-forms/professionals/profiles")
}

export function saveProfessionalProfileApi(userId: string | "me", body: ProfessionalProfileInput) {
  return apiFetch<{ data: ProfessionalProfile }>(
    `/api/clinical-forms/professionals/${userId}/profile`,
    { method: "PUT", body: JSON.stringify(body) },
  )
}

/** Colegio y número («<colegio> <número>») o null si falta la colegiatura. */
export function registrationLabel(
  profile: Pick<ProfessionalProfile, "registrationBody" | "registrationNumber">,
): string | null {
  return profile.registrationNumber
    ? `${profile.registrationBody} ${profile.registrationNumber}`
    : null
}
