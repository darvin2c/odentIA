import { createHash } from "node:crypto"
import {
  CONSENT_DECLARATION,
  CONSENT_SECTION_LABELS,
  type ConsentSections,
  clinicalProfileFor,
  consentSignatureNote,
  diagnosisCodeLabel,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { registerPatientDocument } from "./clinical.js"
import {
  attachConsentPdf,
  attachConsentRevokePdf,
  CONSENT_SIGNATURE_WORDS,
  type ConsentDocumentRow,
  getConsentPrint,
} from "./clinical-forms.js"
import { credentialOf } from "./clinical-papers.js"
import { documentCheckUrl } from "./document-check.js"
import { loadDocumentClinic } from "./document-clinic.js"
import {
  chartNumber,
  type DocumentClinic,
  DocumentKit,
  dayTimeWords,
  documentFormat,
  SIZE,
  strokesOf,
} from "./document-kit.js"
import { ServiceError } from "./errors.js"
import type { Storage } from "./storage.js"

type ConsentPrint = Awaited<ReturnType<typeof getConsentPrint>>

/** El encabezado y las secciones de lo que se consiente: iguales firmado o por firmar. */
function consentBody(kit: DocumentKit, data: ConsentPrint) {
  const { document: doc, patient } = data
  const sectionStyle = {
    face: "sansBold" as const,
    size: SIZE.read,
    leading: 1.4,
    before: 12,
    after: 1,
  }
  kit.gap(20)
  kit.text("Consentimiento informado", { size: SIZE.second, face: "sansSemi", tone: "gray" })
  kit.gap(1)
  kit.text(doc.titleSnapshot, { face: "serif", size: SIZE.titleBudget, leading: 1.2 })
  kit.text([`Plantilla v${doc.templateVersion}`, doc.procedureRef].filter(Boolean).join(" · "), {
    size: SIZE.second,
    tone: "gray",
  })
  kit.gap(12)
  kit.facts(
    [
      { label: "Paciente", value: patient.displayName, strong: true },
      ...(patient.docNumber
        ? [{ label: patient.docType ?? "Documento", value: patient.docNumber }]
        : []),
      { label: "Historia clínica", value: chartNumber(patient.patientNumber) },
    ],
    3,
  )
  const sections = doc.sectionsSnapshot as ConsentSections | null
  if (sections) {
    kit.subheading(CONSENT_SECTION_LABELS.procedure, sectionStyle)
    kit.text(sections.procedure, { size: SIZE.read })
    if (doc.diagnosisCode) {
      kit.subheading(CONSENT_SECTION_LABELS.diagnosis, sectionStyle)
      const code = diagnosisCodeLabel(doc.diagnosisSystem, doc.diagnosisCode)
      kit.text(data.diagnosisDescription ? `${code} · ${data.diagnosisDescription}` : code, {
        size: SIZE.read,
      })
    }
    kit.subheading(CONSENT_SECTION_LABELS.benefits, sectionStyle)
    kit.bullets(sections.benefits, { size: SIZE.read })
    kit.subheading(CONSENT_SECTION_LABELS.risks, sectionStyle)
    kit.bullets(sections.risks, { size: SIZE.read })
    kit.subheading(CONSENT_SECTION_LABELS.alternatives, sectionStyle)
    kit.bullets(sections.alternatives, { size: SIZE.read })
    kit.subheading(CONSENT_SECTION_LABELS.consequences, sectionStyle)
    kit.text(sections.consequences, { size: SIZE.read })
    if (sections.notes) {
      kit.subheading(CONSENT_SECTION_LABELS.notes, sectionStyle)
      kit.text(sections.notes, { size: SIZE.read })
    }
  } else {
    kit.gap(14)
    kit.text(doc.bodySnapshot, { size: SIZE.read })
  }
  kit.gap(16)
  kit.panel({
    title: "Declaración",
    // La que aceptó al firmar; lo firmado antes de copiarla, la de siempre.
    body: doc.declarationSnapshot ?? CONSENT_DECLARATION,
    size: SIZE.read,
  })
}

function consentKit(data: ConsentPrint, clinic: DocumentClinic) {
  const { document: doc, patient } = data
  return DocumentKit.open(clinic, documentFormat(clinic), {
    title: doc.titleSnapshot,
    docLabel: "Consentimiento",
    patientLabel: `${patient.displayName} · ${chartNumber(patient.patientNumber)}`,
    ...(doc.signedAt ? { createdAt: new Date(doc.signedAt) } : {}),
  })
}

/**
 * PDF del consentimiento: clínica, paciente, secciones, declaración aceptada, firmas
 * con su trazo (persona y profesional), testigo, nivel de firma, huella y, con
 * `revocation`, la revocación. El firmado se guarda sin ella; la revocación es otro
 * PDF. La huella SHA-256 se calcula sobre estos bytes; los ya guardados no se tocan.
 */
export async function renderConsentPdf(
  data: ConsentPrint,
  clinic: DocumentClinic,
  {
    revocation = data.document.status === "revocado",
    checkUrl = null,
  }: { revocation?: boolean; checkUrl?: string | null } = {},
): Promise<Uint8Array> {
  const { document: doc } = data
  const zone = clinic
  const kit = await consentKit(data, clinic)
  // Anulado antes de firmarse: lo que se iba a consentir, con su sello y sin firmas.
  if (doc.status === "anulado") {
    kit.gap(14)
    kit.stateBox({ kind: "alert", title: "ANULADO", detail: doc.cancelReason ? `Motivo: ${doc.cancelReason}` : null })
    consentBody(kit, data)
    return kit.finish()
  }
  if (revocation && doc.status === "revocado") {
    kit.gap(14)
    kit.stateBox({
      kind: "alert",
      title: "REVOCADO",
      detail: `${doc.revokerName ?? "-"} · ${doc.revokedAt ? dayTimeWords(doc.revokedAt, zone) : "-"} · Motivo: ${doc.revokeReason ?? "-"}`,
    })
  }
  consentBody(kit, data)
  kit.gap(20)
  const method = (doc.signatureMethod ?? "clinica") as keyof typeof CONSENT_SIGNATURE_WORDS
  const signerHeading = doc.signerKind === "representante" ? "Representante legal" : "Paciente"
  const signedAt = doc.signedAt ? `Firmó el ${dayTimeWords(doc.signedAt, zone)}` : ""
  const signerLines = [
    { text: doc.signerName, strong: true },
    ...(doc.signerDoc ? [{ text: doc.signerDoc }] : []),
    ...(doc.representativeRelation ? [{ text: doc.representativeRelation }] : []),
    {
      text:
        method === "papel"
          ? `${signedAt}. Firmó la hoja en papel; su foto queda en Documentos.`
          : signedAt,
    },
  ]
  // El profesional confirma con su perfil (nombre y colegiatura), sin trazo: firma electrónica.
  const professionalStrokes = strokesOf(doc.professionalSignature)
  const informerLines = [
    { text: doc.informerName ?? "-", strong: true },
    ...(credentialOf(doc.informerTitle, doc.informerRegistration)
      ? [{ text: credentialOf(doc.informerTitle, doc.informerRegistration) ?? "" }]
      : []),
    { text: doc.informedAt ? `Informó el ${dayTimeWords(doc.informedAt, zone)}` : "" },
    ...(professionalStrokes ? [] : [{ text: "Firmado electrónicamente" }]),
  ]
  if (method === "papel") {
    kit.subheading(signerHeading, { size: SIZE.table })
    for (const line of signerLines)
      kit.text(line.text, {
        size: line.strong ? SIZE.table : SIZE.second,
        face: line.strong ? "sansSemi" : "sans",
        tone: line.strong ? "ink" : "gray",
      })
    kit.gap(10)
    kit.subheading("Profesional que informa", { size: SIZE.table })
    for (const line of informerLines)
      kit.text(line.text, {
        size: line.strong ? SIZE.table : SIZE.second,
        face: line.strong ? "sansSemi" : "sans",
        tone: line.strong ? "ink" : "gray",
      })
  } else if (professionalStrokes) {
    kit.penSignatures([
      { heading: signerHeading, strokes: strokesOf(doc.signatureData), lines: signerLines },
      { heading: "Profesional que informa", strokes: professionalStrokes, lines: informerLines },
    ])
  } else {
    kit.penSignatures([
      { heading: signerHeading, strokes: strokesOf(doc.signatureData), lines: signerLines },
    ])
    kit.gap(12)
    kit.subheading("Profesional que informa", { size: SIZE.table })
    for (const line of informerLines)
      kit.text(line.text, {
        size: line.strong ? SIZE.table : SIZE.second,
        face: line.strong ? "sansSemi" : "sans",
        tone: line.strong ? "ink" : "gray",
      })
  }
  if (doc.witnessName) {
    kit.gap(10)
    kit.text(`Testigo: ${doc.witnessName}${doc.witnessDoc ? ` · ${doc.witnessDoc}` : ""}`, {
      size: SIZE.second,
    })
  }
  if (method === "enlace" && doc.personSignedAt) {
    // La evidencia de una firma a distancia: cuándo y desde dónde.
    const from = [doc.personSignedIp && `IP ${doc.personSignedIp}`, doc.personSignedUserAgent]
      .filter(Boolean)
      .join(" · ")
    kit.gap(6)
    kit.text(
      `Firmó en su enlace ${dayTimeWords(doc.personSignedAt, zone)}${from ? ` · ${from}` : ""}`,
      {
        size: SIZE.label,
        tone: "gray",
      },
    )
  }
  if (revocation && doc.status === "revocado") {
    kit.gap(14)
    kit.penSignatures([
      {
        heading: "Quien revoca",
        strokes: strokesOf(doc.revokeSignature),
        lines: [{ text: doc.revokerName ?? "-", strong: true }],
      },
    ])
  }
  kit.gap(16)
  kit.rule()
  kit.gap(8)
  const words = CONSENT_SIGNATURE_WORDS[method] ?? CONSENT_SIGNATURE_WORDS.clinica
  const note = consentSignatureNote(clinicalProfileFor(data.establishment?.country).signatureLaw)
  const qrSize = 54
  const needed = 44 + (checkUrl ? 10 : 0)
  kit.ensure(needed)
  const top = kit.y
  const textWidth = checkUrl ? kit.width - qrSize - 15 : kit.width
  kit.text(words, { size: SIZE.second, face: "sansSemi", width: textWidth })
  kit.text(note, { size: SIZE.label, tone: "gray", width: textWidth, leading: 1.4 })
  if (checkUrl) {
    kit.text("Escanee el código para comprobar que sigue vigente.", {
      size: SIZE.label,
      tone: "gray",
      width: textWidth,
      leading: 1.4,
    })
    kit.qr(checkUrl, kit.right - qrSize, top, qrSize)
    kit.y = Math.min(kit.y, top - qrSize)
  }
  return kit.finish()
}

/**
 * La hoja para firmar en papel de un consentimiento pendiente: lo mismo, con los
 * recuadros vacíos. No lleva QR: aún no es un documento que comprobar.
 */
export async function renderConsentPaperPdf(
  data: ConsentPrint,
  clinic: DocumentClinic,
): Promise<Uint8Array> {
  const { document: doc, patient } = data
  const kit = await consentKit(data, clinic)
  consentBody(kit, data)
  kit.gap(20)
  const minor = "minor" in patient && patient.minor === true
  if (minor) {
    kit.stateBox({ kind: "note", title: "Menor de edad", detail: "Firma su representante legal." })
    kit.gap(10)
  }
  kit.penSignatures([
    {
      heading: minor ? "Representante legal" : "Paciente",
      strokes: null,
      lines: [{ text: "Nombre, documento y firma" }, { text: "Fecha y hora" }],
    },
    {
      heading: "Profesional que informa",
      strokes: null,
      lines: [
        ...(doc.informerName ? [{ text: doc.informerName, strong: true }] : []),
        ...(credentialOf(doc.informerTitle, doc.informerRegistration)
          ? [{ text: credentialOf(doc.informerTitle, doc.informerRegistration) ?? "" }]
          : []),
        { text: "Fecha y hora" },
      ],
    },
  ])
  return kit.finish()
}

/**
 * Guarda los PDF que le faltan a un consentimiento, cada uno una sola vez
 * como documento clínico del paciente y con su huella SHA-256: el firmado y,
 * si se revocó, el de la revocación. `run` ejecuta cada paso en el contexto
 * de la organización (RLS); el archivo se sube entre ambos y se borra si el
 * registro falla. Lo usan la API y la semilla.
 */
export async function generateConsentPdf(input: {
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  storage: Pick<Storage, "putPatientDocument" | "deleteAttachment">
  orgId: string
  userId: string
  consentId: string
}): Promise<ConsentDocumentRow> {
  const { run, orgId, consentId } = input
  let data = await run((tx) => getConsentPrint(tx, orgId, consentId))
  let row = data.document
  if (row.status !== "firmado" && row.status !== "revocado")
    throw new ServiceError("CONSENT_STATUS", 409, "Solo un consentimiento firmado genera PDF")
  if (!row.pdfDocumentId) {
    row = await storeConsentPdf(input, data, "firmado")
    if (row.status === "revocado") data = { ...data, document: row }
  }
  if (row.status === "revocado" && !row.revokePdfDocumentId)
    row = await storeConsentPdf(input, data, "revocado")
  return row
}

async function storeConsentPdf(
  input: Parameters<typeof generateConsentPdf>[0],
  data: ConsentPrint,
  kind: "firmado" | "revocado",
): Promise<ConsentDocumentRow> {
  const { run, storage, orgId, userId, consentId } = input
  const doc = data.document
  const { clinic, checkUrl } = await run(async (tx) => ({
    clinic: await loadDocumentClinic(tx, orgId),
    checkUrl: await documentCheckUrl(tx, orgId, "consent", consentId),
  }))
  const bytes = await renderConsentPdf(data, clinic, { revocation: kind === "revocado", checkUrl })
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const ref = await storage.putPatientDocument({
    orgId,
    patientId: doc.patientId,
    bytes,
    contentType: "application/pdf",
    ext: "pdf",
  })
  try {
    return await run(async (tx) => {
      const label = kind === "firmado" ? "Consentimiento firmado" : "Revocación del consentimiento"
      const stored = await registerPatientDocument(tx, orgId, userId, doc.patientId, {
        category: "consentimiento",
        label: `${label}: ${doc.titleSnapshot}`.slice(0, 200),
        storageKey: ref.objectKey,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        planItemId: doc.planItemId,
        tags: ["consentimiento"],
      })
      const pdf = { pdfDocumentId: stored.id, sha256 }
      return kind === "firmado"
        ? attachConsentPdf(tx, orgId, userId, consentId, pdf)
        : attachConsentRevokePdf(tx, orgId, userId, consentId, pdf)
    })
  } catch (e) {
    await storage.deleteAttachment(ref.objectKey).catch(() => {})
    throw e
  }
}
