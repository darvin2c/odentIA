/**
 * Cliente del odontograma firmado y de las hojas para imprimir (fase 3, paso
 * 5; ADR 0036). Firmado solo en clínicas de Perú: lo firma el cierre de la
 * atención que cambió el gráfico y, para lo judicial, lo personal y el
 * reingreso, «Firmar odontograma». Fuera de Perú se imprime una hoja neutra.
 */
import type { ManualOdontogramPurpose } from "@odentia/dental"
import { apiFetch } from "../api"
import type { OdontogramAssessment, OdontogramEntry } from "../patients"

/** Quién es la persona en una hoja impresa. */
export interface PrintPatient {
  displayName: string
  patientNumber: number
  docType: string | null
  docNumber: string | null
  birthDate: string | null
}

/** La clínica que encabeza la hoja. */
export interface PrintEstablishment {
  legalName: string | null
  tradeName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  address: string | null
}

function base(patientId: string): string {
  return `/api/patients/${patientId}/odontogram`
}

export function fetchSignedOdontograms(patientId: string): Promise<{ data: OdontogramAssessment[] }> {
  return apiFetch<{ data: OdontogramAssessment[] }>(`${base(patientId)}/assessments`)
}

/** «Firmar odontograma»: el momento y, si hace falta, notas; quien firma sale del perfil. */
export function signOdontogramApi(
  patientId: string,
  body: { purpose: ManualOdontogramPurpose; specifications?: string; observations?: string },
): Promise<{ data: OdontogramAssessment }> {
  return apiFetch<{ data: OdontogramAssessment }>(`${base(patientId)}/assessments`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export function fetchSignedOdontogramPrint(
  patientId: string,
  assessmentId: string,
): Promise<{
  data: { assessment: OdontogramAssessment; patient: PrintPatient; establishment: PrintEstablishment | null }
}> {
  return apiFetch(`${base(patientId)}/assessments/${assessmentId}/print`)
}

export function fetchOdontogramPrint(patientId: string): Promise<{
  data: {
    entries: OdontogramEntry[]
    patient: PrintPatient
    establishment: PrintEstablishment | null
    printedAt: string
  }
}> {
  return apiFetch(`${base(patientId)}/print`)
}
