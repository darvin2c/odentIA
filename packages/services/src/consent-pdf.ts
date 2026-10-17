import {
  CONSENT_DECLARATION,
  CONSENT_SECTION_LABELS,
  type ConsentSections,
} from "@odentia/clinical"
import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { PDFDocument, StandardFonts } from "pdf-lib"
import {
  attachConsentPdf,
  CONSENT_SIGNATURE_WORDS,
  type ConsentDocumentRow,
  getConsentPrint,
} from "./clinical-forms.js"
import { NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { registerPatientDocument } from "./clinical.js"
import { MUTED, safe, strokesOf, when, Writer, type Zone } from "./pdf-writer.js"
import type { Storage } from "./storage.js"

type ConsentPrint = Awaited<ReturnType<typeof getConsentPrint>>
/**
 * PDF del consentimiento firmado: establecimiento, paciente, secciones,
 * declaración, firmas manuscritas (persona, profesional y testigo) y, si
 * corresponde, la revocación. La huella SHA-256 se calcula sobre estos bytes.
 */
export async function renderConsentPdf(data: ConsentPrint): Promise<Uint8Array> {
  const { document: doc, patient, establishment } = data
  const zone: Zone = {
    locale: establishment?.locale || NEUTRAL_LOCALE,
    timezone: establishment?.timezone || NEUTRAL_TIMEZONE,
  }
  const pdf = await PDFDocument.create()
  pdf.setTitle(safe(doc.titleSnapshot))
  pdf.setSubject(`Consentimiento informado ${doc.id}`)
  pdf.setProducer("odentIA")
  pdf.setCreationDate(doc.signedAt ?? new Date())
  const w = new Writer(
    pdf,
    await pdf.embedFont(StandardFonts.Helvetica),
    await pdf.embedFont(StandardFonts.HelveticaBold),
  )
  if (establishment) {
    w.text(establishment.tradeName ?? establishment.legalName ?? "", { size: 12, bold: true })
    w.text(
      [
        establishment.legalName,
        establishment.fiscalDocNumber &&
          [establishment.fiscalDocType, establishment.fiscalDocNumber].filter(Boolean).join(" "),
        establishment.address,
      ]
        .filter(Boolean)
        .join(" · "),
      { size: 8, color: MUTED },
    )
    w.gap()
  }
  w.text("CONSENTIMIENTO INFORMADO", { size: 9, bold: true, color: MUTED })
  w.text(doc.titleSnapshot, { size: 15, bold: true })
  w.text(`Plantilla v${doc.templateVersion} · Documento ${doc.id}`, { size: 8, color: MUTED })
  w.gap()
  w.text(
    `Paciente: ${patient.displayName} · HC ${String(patient.patientNumber).padStart(6, "0")}${patient.docNumber ? ` · ${patient.docType ?? ""} ${patient.docNumber}` : ""}${patient.birthDate ? ` · nacimiento ${patient.birthDate}` : ""}`,
  )
  if (doc.procedureRef) w.text(`Aplica a: ${doc.procedureRef}`)
  const sections = doc.sectionsSnapshot as ConsentSections | null
  if (sections) {
    w.heading(CONSENT_SECTION_LABELS.procedure)
    w.text(sections.procedure)
    if (doc.diagnosisCode) {
      w.heading(CONSENT_SECTION_LABELS.diagnosis)
      w.text(`${doc.diagnosisCode} ${data.diagnosisDescription ?? ""}`.trim())
    }
    w.heading(CONSENT_SECTION_LABELS.benefits)
    w.list(sections.benefits)
    w.heading(CONSENT_SECTION_LABELS.risks)
    w.list(sections.risks)
    w.heading(CONSENT_SECTION_LABELS.alternatives)
    w.list(sections.alternatives)
    w.heading(CONSENT_SECTION_LABELS.consequences)
    w.text(sections.consequences)
    if (sections.notes) {
      w.heading(CONSENT_SECTION_LABELS.notes)
      w.text(sections.notes)
    }
  } else {
    w.gap()
    w.text(doc.bodySnapshot)
  }
  w.heading("Declaración")
  w.text(CONSENT_DECLARATION)
  if (doc.comprehensionConfirmed)
    w.text("Comprensión confirmada por la persona firmante.", { size: 8, color: MUTED })
  w.gap(10)
  const method = (doc.signatureMethod ?? "clinica") as keyof typeof CONSENT_SIGNATURE_WORDS
  const signerCaption = `${doc.signerName}${doc.signerDoc ? ` · ${doc.signerDoc}` : ""}${doc.representativeRelation ? ` · ${doc.representativeRelation}` : ""} · ${when(doc.signedAt, zone)}`
  const signerLabel =
    doc.signerKind === "representante" ? "Firma del representante legal" : "Firma del paciente"
  if (method === "papel") {
    // La firma está en la hoja de papel, guardada como documento de la persona.
    w.text(signerLabel, { size: 9, bold: true })
    w.text(`${signerCaption} · firmó la hoja en papel; su foto queda en Documentos`, { size: 8, color: MUTED })
  } else {
    w.signature(signerLabel, strokesOf(doc.signatureData), signerCaption)
  }
  w.gap(6)
  const informerCaption = `${doc.informerName ?? "-"}${doc.informerTitle ? ` · ${doc.informerTitle}` : ""}${doc.informerRegistration ? ` · ${doc.informerRegistration}` : ""} · informó ${when(doc.informedAt, zone)}`
  const professionalStrokes = strokesOf(doc.professionalSignature)
  if (professionalStrokes) {
    w.signature("Firma del profesional que informa", professionalStrokes, informerCaption)
  } else {
    // El profesional confirma con su perfil (nombre y colegiatura), sin trazo.
    w.text("Profesional que informa", { size: 9, bold: true })
    w.text(`Informó a la persona y resolvió sus dudas · firma con su perfil profesional`, { size: 8 })
    w.text(informerCaption, { size: 8, color: MUTED })
  }
  w.gap(4)
  w.text(CONSENT_SIGNATURE_WORDS[method] ?? CONSENT_SIGNATURE_WORDS.clinica, { size: 8, color: MUTED })
  if (doc.witnessName) {
    w.gap(6)
    w.text(`Testigo: ${doc.witnessName}${doc.witnessDoc ? ` · ${doc.witnessDoc}` : ""}`)
  }
  if (doc.status === "revocado") {
    w.gap(10)
    w.text("REVOCADO", { size: 11, bold: true })
    w.text(
      `${doc.revokerName ?? "-"} · ${when(doc.revokedAt, zone)} · Motivo: ${doc.revokeReason ?? "-"}`,
    )
    w.signature("Firma de quien revoca", strokesOf(doc.revokeSignature), doc.revokerName ?? "")
  }
  w.gap(14)
  w.text(
    "Firmas manuscritas capturadas electrónicamente como evidencia; no constituyen firma digital certificada (Ley 27269).",
    { size: 7, color: MUTED },
  )
  return pdf.save({ useObjectStreams: false })
}

/**
 * Genera el PDF del consentimiento firmado, lo guarda como documento clínico
 * del paciente y fija su huella SHA-256, una sola vez. `run` ejecuta cada paso
 * en el contexto de la organización (RLS); el archivo se sube entre ambos y se
 * borra si el registro falla. Lo usan la API y la semilla.
 */
export async function generateConsentPdf(input: {
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  storage: Pick<Storage, "putPatientDocument" | "deleteAttachment">
  orgId: string
  userId: string
  consentId: string
}): Promise<ConsentDocumentRow> {
  const { run, storage, orgId, userId, consentId } = input
  const data = await run((tx) => getConsentPrint(tx, orgId, consentId))
  if (data.document.pdfDocumentId) return data.document
  const bytes = await renderConsentPdf(data)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const ref = await storage.putPatientDocument({
    orgId,
    patientId: data.document.patientId,
    bytes,
    contentType: "application/pdf",
    ext: "pdf",
  })
  try {
    return await run(async (tx) => {
      const stored = await registerPatientDocument(tx, orgId, userId, data.document.patientId, {
        category: "consentimiento",
        label: `Consentimiento firmado: ${data.document.titleSnapshot}`.slice(0, 200),
        storageKey: ref.objectKey,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        planItemId: data.document.planItemId,
        tags: ["consentimiento"],
      })
      return attachConsentPdf(tx, orgId, userId, consentId, { pdfDocumentId: stored.id, sha256 })
    })
  } catch (e) {
    await storage.deleteAttachment(ref.objectKey).catch(() => {})
    throw e
  }
}
