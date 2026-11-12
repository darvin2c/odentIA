/**
 * Lo emitido no cambia (ADR 0132). Receta, orden, descanso y hoja de atención se guardan como PDF una
 * sola vez, con su huella, y desde ahí se sirve ese archivo: verlo, enviarlo y
 * descargarlo es el mismo papel aunque después cambie el nombre de la persona, sus
 * alergias o el membrete de la clínica. Lo emitido antes de esto se guarda la primera
 * vez que se abre. El consentimiento sigue su camino propio (`consent-pdf.ts`).
 */
import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { issuedPaper } from "@odentia/db/schema/clinical-forms"
import { and, eq } from "drizzle-orm"
import type { PaperContext } from "./clinical-papers.js"
import { documentCheckUrl, patientInitials } from "./document-check.js"
import { loadDocumentClinic } from "./document-clinic.js"
import { stampVoidedPdf } from "./document-kit.js"
import { ServiceError } from "./errors.js"
import type { Storage } from "./storage.js"

export type IssuedPaperType = "prescription" | "order" | "medical_leave" | "attention_sheet"

export type PaperStorage = Partial<
  Pick<Storage, "getAttachment" | "putPatientDocument" | "deleteAttachment">
>

async function storedPaperBytes(
  tx: Db,
  orgId: string,
  type: IssuedPaperType,
  documentId: string,
  storage: PaperStorage,
): Promise<Uint8Array | null> {
  const [row] = await tx
    .select({ storageKey: issuedPaper.storageKey, sha256: issuedPaper.sha256 })
    .from(issuedPaper)
    .where(
      and(
        eq(issuedPaper.organizationId, orgId),
        eq(issuedPaper.documentType, type),
        eq(issuedPaper.documentId, documentId),
      ),
    )
    .limit(1)
  if (!row) return null
  if (!storage.getAttachment)
    throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudo leer el PDF guardado")
  let bytes: Uint8Array
  try {
    bytes = await storage.getAttachment(row.storageKey)
  } catch (error) {
    console.error("No se pudo leer el papel emitido", error)
    throw new ServiceError(
      "STORAGE_UNAVAILABLE",
      503,
      "No se pudo leer el PDF guardado. Inténtalo de nuevo.",
    )
  }
  // Otro archivo en su lugar no se muestra como si fuera el emitido.
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
    throw new ServiceError(
      "PAPER_ALTERED",
      409,
      "El PDF guardado no coincide con su huella: no se muestra ni se envía",
    )
  return bytes
}

/**
 * El papel: el guardado si ya existe; si no, se genera y se guarda, salvo en dos casos.
 * Un anulado que nunca se guardó ya no sale de la clínica, y sale de sus datos con su
 * aviso. Sin dirección pública o sin clave, el papel no lleva QR y guardarlo lo dejaría
 * así para siempre; se guarda cuando se pueda.
 */
export async function issuedPaperBytes(
  tx: Db,
  input: {
    orgId: string
    patientId: string
    /** Como sale en el papel: de ahí las iniciales con que el QR lo deja cotejar. */
    patientName: string
    type: IssuedPaperType
    documentId: string
    /** La palabra y el motivo, si está anulado. */
    voided: { word: string; reason: string | null } | null
    /** Cuándo se emitió: lleva la hoja membretada que la clínica tenía entonces (ADR 0181). */
    issuedAt: Date | string
    draw: (context: PaperContext) => Promise<Uint8Array>
  },
  storage: PaperStorage,
  /** Verlo no se traba porque falle el guardado: enviarlo sí, porque debe salir el fijo. */
  options: { viewing?: boolean } = {},
): Promise<Uint8Array> {
  const { orgId, patientId, type, documentId, voided, draw } = input
  const stored = await storedPaperBytes(tx, orgId, type, documentId, storage)
  if (stored) return voided ? stampVoidedPdf(stored, voided) : stored

  const checkUrl = await documentCheckUrl(tx, orgId, type, documentId)
  const clinic = await loadDocumentClinic(tx, orgId, { at: input.issuedAt })
  const bytes = await draw({ clinic, checkUrl })
  // Sin su hoja membretada (no se pudo leer) tampoco se guarda: quedaría así para siempre.
  if (voided || !checkUrl || clinic.sheetUnavailable || !storage.putPatientDocument) return bytes

  let objectKey: string
  try {
    const ref = await storage.putPatientDocument({
      orgId,
      patientId,
      bytes,
      contentType: "application/pdf",
      ext: "pdf",
    })
    objectKey = ref.objectKey
  } catch (error) {
    console.error("No se pudo guardar el papel emitido", error)
    // Sin QR: al guardarse después saldrá otro archivo, y este no coincidiría con su huella.
    if (options.viewing) return draw({ clinic, checkUrl: null })
    throw new ServiceError(
      "STORAGE_UNAVAILABLE",
      503,
      "No se pudo guardar el PDF. Inténtalo de nuevo.",
    )
  }
  const [saved] = await tx
    .insert(issuedPaper)
    .values({
      organizationId: orgId,
      patientId,
      documentType: type,
      documentId,
      storageKey: objectKey,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      patientInitials: patientInitials(input.patientName),
    })
    .onConflictDoNothing()
    .returning({ id: issuedPaper.id })
  if (saved) return bytes
  // Otro pedido lo guardó primero: vale el suyo y este archivo sobra.
  await storage.deleteAttachment?.(objectKey).catch(() => {})
  const winner = await storedPaperBytes(tx, orgId, type, documentId, storage)
  if (!winner) throw new ServiceError("STORAGE_UNAVAILABLE", 503, "No se pudo leer el PDF guardado")
  return winner
}
