import { API_URL } from "./auth-client"

export type DocumentCheckState = "vigente" | "anulado" | "revocado" | "vencido"

/** Lo que la API dice de un papel con su QR (ADR 0112): su estado y lo mínimo para cotejarlo. */
export interface DocumentCheck {
  state: DocumentCheckState
  label: string
  issuedAt: string | null
  validUntil: string | null
  voidedAt: string | null
  signer: { name: string; title: string | null; registration: string | null } | null
  patientInitials: string
  clinic: { name: string; phone: string | null }
}

/** Sin sesión ni datos de quien pregunta. `null`: no se pudo comprobar, sin decir por qué. */
export async function fetchDocumentCheck(token: string): Promise<DocumentCheck | null> {
  const response = await fetch(`${API_URL}/api/public/documents/${encodeURIComponent(token)}`, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error("No disponible")
  return ((await response.json()) as { data: DocumentCheck }).data
}
