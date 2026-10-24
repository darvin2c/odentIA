import { apiFetch } from "./api"

/** El descanso médico como lo devuelve la API (issue 229, decisión 8). */
export interface MedicalLeave {
  id: string
  patientId: string
  encounterId: string | null
  leaveNumber: number
  status: "emitido" | "anulado"
  startsOn: string
  days: number
  endsOn: string
  /** La persona autorizó que el diagnóstico figure; sin eso, no hay diagnóstico. */
  showDiagnosis: boolean
  diagnosisSystem: string | null
  diagnosisCode: string | null
  notes: string | null
  signerName: string | null
  signerTitle: string | null
  signerRegistration: string | null
  issuedAt: string
  cancelledAt: string | null
  cancelReason: string | null
}

export interface MedicalLeavePrint {
  leave: MedicalLeave
  diagnosisDescription: string | null
  patient: {
    displayName: string
    patientNumber: number
    docType: string | null
    docNumber: string | null
    birthDate: string | null
  }
  establishment: {
    legalName: string | null
    tradeName: string | null
    fiscalDocType: string | null
    fiscalDocNumber: string | null
    address: string | null
  } | null
}

export interface CreateMedicalLeaveBody {
  encounterId?: string | null
  startsOn?: string | null
  days: number
  showDiagnosis?: boolean
  diagnosisCode?: string | null
  diagnosisSystem?: string | null
  notes?: string | null
}

const base = (patientId: string) => `/api/patients/${patientId}/medical-leaves`

export function fetchMedicalLeaves(patientId: string) {
  return apiFetch<{ data: MedicalLeave[] }>(base(patientId))
}

export function createMedicalLeaveApi(patientId: string, body: CreateMedicalLeaveBody) {
  return apiFetch<{ data: MedicalLeave }>(base(patientId), {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function cancelMedicalLeaveApi(
  patientId: string,
  leaveId: string,
  body: { reason: string },
) {
  return apiFetch<{ data: MedicalLeave }>(`${base(patientId)}/${leaveId}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function fetchMedicalLeavePrint(patientId: string, leaveId: string) {
  return apiFetch<{ data: MedicalLeavePrint }>(`${base(patientId)}/${leaveId}/print`)
}
