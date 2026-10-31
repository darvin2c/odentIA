/**
 * Cliente del odontograma firmado y de las hojas para imprimir (fase 3, paso
 * 5; ADR 0036). Firmado solo en clínicas de Perú: lo firma el cierre de la
 * atención que cambió el gráfico y, para lo judicial, lo personal y el
 * reingreso, «Firmar odontograma». Fuera de Perú se imprime una hoja neutra.
 */

import { apiFetch } from "@odentia/clinic-app/lib/api"
import type { SiteFinding } from "@odentia/clinic-app/lib/patients"
import {
  activeFindingsAsOf,
  type FindingDetails,
  type ManualOdontogramPurpose,
  type SignedOdontogramPurpose,
} from "@odentia/dental"

/** Un hallazgo del odontograma, con lo propio de odentIA (sus detalles, su revisión, lo que lo dejó). */
export interface OdontogramEntry extends SiteFinding {
  id: string
  toothNumber: number
  surface?: string | null
  condition: string
  status: string
  diagnosisCode?: string | null
  /** Lista del código («ICD-10», «ICD-11»). */
  diagnosisSystem?: string | null
  note?: string | null
  encounterId?: string | null
  createdAt?: string
  details?: FindingDetails
  needsReview?: boolean
  legacyData?: Record<string, unknown> | null
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
  /** Tratado: deja de estar vigente desde entonces (sigue en la evolución). */
  resolvedAt?: string | null
  /** Lo tratado queda dibujado: el tratamiento completado que dejó este hallazgo. */
  leftByPlanItemId?: string | null
}

export type ToothState = {
  condition: string
  status: string
  surfaces: string[]
  entries: string[]
}

export interface OdontogramState {
  teeth: Record<string, ToothState>
  history: OdontogramEntry[]
}

/**
 * Odontograma firmado (solo en clínicas de Perú; ADR 0036): instantánea de los
 * hallazgos con la firma del perfil de quien firmó (sin trazo) y su momento.
 * El que firmó el cierre de una atención la nombra (`encounterId`).
 */
export interface OdontogramAssessment {
  id: string
  patientId: string
  patientName: string
  patientNumber: number
  authorUserId: string
  createdAt: string
  purpose: SignedOdontogramPurpose
  standard: string
  specifications: string
  observations: string
  examinerName: string
  examinerTitle: string
  /** Colegio y número, como se imprime: «COP 12345». */
  registrationNumber: string
  encounterId: string | null
  entries: OdontogramEntry[]
}

/** Proyección por pieza de hallazgos coexistentes; el historial original no se modifica. */
export function winnersAsOf(history: OdontogramEntry[], iso?: string): OdontogramState {
  const byTooth = new Map<number, OdontogramEntry[]>()
  for (const entry of activeFindingsAsOf(history, iso)) {
    for (const tooth of entry.details?.relatedTeeth?.length
      ? entry.details.relatedTeeth
      : [entry.toothNumber]) {
      const entries = byTooth.get(tooth) ?? []
      entries.push(entry)
      byTooth.set(tooth, entries)
    }
  }
  const teeth: Record<string, ToothState> = {}
  for (const [tooth, entries] of byTooth) {
    const latest = entries.at(-1)!
    teeth[String(tooth)] = {
      condition: latest.condition,
      status: latest.status,
      surfaces: [
        ...new Set(entries.flatMap((entry) => (entry.surface ? [entry.surface] : []))),
      ].sort(),
      entries: entries.map((entry) => entry.id),
    }
  }
  return { teeth, history }
}

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
  logo?: string | null
  /** Con una sola sede, su nombre y su teléfono. */
  branchName?: string | null
  phone?: string | null
}

function base(patientId: string): string {
  return `/api/patients/${patientId}/odontogram`
}

export function fetchSignedOdontograms(
  patientId: string,
): Promise<{ data: OdontogramAssessment[] }> {
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
  data: {
    assessment: OdontogramAssessment
    patient: PrintPatient
    establishment: PrintEstablishment | null
    /** La dirección del QR; null: el papel sale sin QR. */
    checkUrl: string | null
  }
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
