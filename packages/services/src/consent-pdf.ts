import {
  CONSENT_DECLARATION,
  CONSENT_SECTION_LABELS,
  type ConsentSections,
} from "@odentia/clinical"
import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib"
import { attachConsentPdf, type ConsentDocumentRow, getConsentPrint } from "./clinical-forms.js"
import { NEUTRAL_LOCALE, NEUTRAL_TIMEZONE } from "./locale.js"
import { registerPatientDocument } from "./clinical.js"
import type { Storage } from "./storage.js"

type ConsentPrint = Awaited<ReturnType<typeof getConsentPrint>>
type Strokes = number[][][]

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 50
const INK = rgb(0.07, 0.09, 0.15)
const MUTED = rgb(0.4, 0.42, 0.47)

/**
 * Las fuentes estándar de PDF codifican WinAnsi (Latin-1): cubre el español.
 * Lo que no cabe (emojis, otros alfabetos) se sustituye para no fallar.
 */
function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\u0009\u000A -~ -ÿ•]/g, "?")
}

class Writer {
  page: PDFPage
  y: number
  constructor(
    private readonly pdf: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = pdf.addPage(A4)
    this.y = A4[1] - MARGIN
  }
  private ensure(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.pdf.addPage(A4)
      this.y = A4[1] - MARGIN
    }
  }
  text(
    value: string,
    opts: { size?: number; bold?: boolean; color?: typeof INK; indent?: number } = {},
  ) {
    const size = opts.size ?? 10
    const font = opts.bold ? this.bold : this.regular
    const width = A4[0] - MARGIN * 2 - (opts.indent ?? 0)
    for (const paragraph of safe(value).split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      let line = ""
      const flush = () => {
        this.ensure(size + 4)
        this.page.drawText(line, {
          x: MARGIN + (opts.indent ?? 0),
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        })
        this.y -= size + 4
        line = ""
      }
      for (const word of words) {
        const next = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(next, size) > width && line) {
          flush()
          line = word
        } else line = next
      }
      if (line) flush()
      if (words.length === 0) this.y -= size / 2
    }
  }
  gap(height = 8) {
    this.y -= height
  }
  heading(value: string) {
    this.gap(6)
    this.text(value, { size: 11, bold: true })
  }
  list(items: string[]) {
    for (const item of items) this.text(`• ${item}`, { indent: 10 })
  }
  /** Firma manuscrita (trazos 0–1000) en un recuadro de 220×70. */
  signature(label: string, strokes: Strokes | null, caption: string) {
    const w = 220
    const h = 70
    this.ensure(h + 40)
    this.text(label, { size: 9, bold: true })
    const top = this.y
    this.page.drawRectangle({
      x: MARGIN,
      y: top - h,
      width: w,
      height: h,
      borderColor: MUTED,
      borderWidth: 0.5,
    })
    for (const stroke of strokes ?? []) {
      for (let i = 1; i < stroke.length; i++) {
        const [x1, y1] = stroke[i - 1] as [number, number]
        const [x2, y2] = stroke[i] as [number, number]
        this.page.drawLine({
          start: { x: MARGIN + (x1 / 1000) * w, y: top - (y1 / 1000) * h },
          end: { x: MARGIN + (x2 / 1000) * w, y: top - (y2 / 1000) * h },
          thickness: 1,
          color: INK,
        })
      }
    }
    this.y = top - h - 4
    this.text(caption, { size: 8, color: MUTED })
  }
}

function strokesOf(value: unknown): Strokes | null {
  if (value && typeof value === "object" && "strokes" in value && Array.isArray(value.strokes))
    return value.strokes as Strokes
  return null
}

/** Formato y zona del establecimiento; sin perfil, valores neutros (nunca un país). */
type Zone = { locale: string; timezone: string }

function when(value: Date | string | null | undefined, zone: Zone): string {
  if (!value) return "-"
  return new Date(value).toLocaleString(zone.locale, {
    timeZone: zone.timezone,
    dateStyle: "long",
    timeStyle: "short",
  })
}

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
  pdf.setProducer("Odentia32")
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
  w.signature(
    doc.signerKind === "representante" ? "Firma del representante legal" : "Firma del paciente",
    strokesOf(doc.signatureData),
    `${doc.signerName}${doc.signerDoc ? ` · ${doc.signerDoc}` : ""}${doc.representativeRelation ? ` · ${doc.representativeRelation}` : ""} · ${when(doc.signedAt, zone)}`,
  )
  w.gap(6)
  w.signature(
    "Firma del profesional que informa",
    strokesOf(doc.professionalSignature),
    `${doc.informerName ?? "-"}${doc.informerTitle ? ` · ${doc.informerTitle}` : ""}${doc.informerRegistration ? ` · ${doc.informerRegistration}` : ""} · informó ${when(doc.informedAt, zone)}`,
  )
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
