import { apiFetch } from "./api"

/**
 * Historias bloqueadas (ADR 0080, fase 2): a su pedido se borró lo no clínico
 * y la historia se guarda porque la ley lo pide. Solo Administración las ve y
 * las abre, con motivo.
 */
export interface LockedRecordItem {
  patientId: string
  personId: string
  patientNumber: number
  displayName: string
  docType: string | null
  docNumber: string | null
  lockedAt: string
  lockedByName: string | null
}

export interface LockedRecordView extends LockedRecordItem {
  request: { requesterName: string | null; resolution: string | null } | null
  /** Hasta cuándo la abrió para leer quien mira. */
  openUntil: string | null
}

export type RecordOpeningReason = "vuelve" | "autoridad" | "reclamo" | "otro"

/** Los motivos, en el orden del tablero 7. */
export const RECORD_OPENING_REASONS: Array<{ value: RecordOpeningReason; label: string }> = [
  { value: "autoridad", label: "Lo pide una autoridad" },
  { value: "vuelve", label: "Vuelve a atenderse" },
  { value: "reclamo", label: "Un reclamo o un juicio" },
  { value: "otro", label: "Otro" },
]

export const LOCKED_RECORDS_KEY = ["locked-records"] as const
export const lockedRecordKey = (personId: string) => ["locked-record", personId] as const

export async function fetchLockedRecords(): Promise<LockedRecordItem[]> {
  return (await apiFetch<{ data: LockedRecordItem[] }>("/api/people/locked")).data
}

export async function fetchLockedRecord(personId: string): Promise<LockedRecordView> {
  return (await apiFetch<{ data: LockedRecordView }>(`/api/people/${personId}/lock`)).data
}

export async function openLockedRecordApi(
  personId: string,
  input: { reason: RecordOpeningReason; note?: string },
): Promise<{ locked: boolean; openUntil: string | null }> {
  return (
    await apiFetch<{ data: { locked: boolean; openUntil: string | null } }>(`/api/people/${personId}/lock/open`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data
}
