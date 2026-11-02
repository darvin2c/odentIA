import { API_URL } from "./auth-client"

export type DocumentCheckState = "vigente" | "anulado" | "revocado" | "vencido"

/** Lo que la API dice de un papel con su QR (ADR 0115): su estado y lo mínimo para cotejarlo. */
export interface DocumentCheck {
  state: DocumentCheckState
  label: string
  issuedAt: string | null
  validUntil: string | null
  voidedAt: string | null
  signer: { name: string; title: string | null; registration: string | null } | null
  patientInitials: string
  /** Huellas de sus archivos guardados: sin ellas, no hay PDF con el que comparar. */
  fingerprints: string[]
  clinic: { name: string; phone: string | null }
}

/** Un PDF más grande que esto no es uno de estos papeles: ni se lee. */
const MAX_COMPARED_BYTES = 30 * 1024 * 1024

/**
 * Si un archivo es exactamente uno de los guardados. Se calcula en el navegador: el
 * archivo no sale del teléfono de quien comprueba. Sin `crypto.subtle` (página sin
 * https) no se puede comparar y se responde `null`.
 */
export async function matchesFingerprint(
  file: Pick<Blob, "size" | "arrayBuffer">,
  fingerprints: string[],
): Promise<boolean | null> {
  if (!globalThis.crypto?.subtle) return null
  if (file.size > MAX_COMPARED_BYTES) return false
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
  return fingerprints.includes(hex)
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
