/**
 * La copia completa de la historia, en un ZIP (mesa del 18 nov): el PDF para leer, el paquete HL7
 * FHIR R4, cada papel emitido en su PDF (el mismo que se envía y se imprime, con «ANULADA» encima
 * si se anuló), los archivos de su ficha y un «LÉEME.txt» con qué trae, con qué estándares y lo que
 * no se pudo incluir.
 *
 * Una sola lista (`buildPatientRecordCopy`) para todos: la descarga del equipo, el enlace de la
 * persona y lo que cuenta la pantalla (`patientRecordSummary`, de la misma lista). Lo que falla no
 * corta la copia ni queda vacío sin aviso: se nombra en el LÉEME y en el PDF.
 *
 * Lo común vale para los tres productos: recetas, órdenes, descansos, hojas de atención y
 * consentimientos son de todos; lo de cada producto llega por sus ganchos (`recordPapers`: odentIA,
 * cada odontograma firmado y el de hoy; `portalPapers`: vistIA, su receta de lentes).
 */
import { createHash } from "node:crypto"
import {
  DIAGNOSIS_SYSTEM_INFO,
  isDiagnosisSystem,
  isImageDocumentCategory,
  signerWords,
} from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { issuedPaper } from "@odentia/db/schema/clinical-forms"
import { and, eq, inArray } from "drizzle-orm"
import { dayTimeWords, dayWords } from "./document-kit.js"
import { type HealthDocumentType, renderHealthDocumentPdf } from "./health-documents.js"
import type { PaperStorage } from "./issued-papers.js"
import {
  loadPatientRecord,
  type PatientRecord,
  patientRecordFhirBundle,
  patientRecordFileName,
  patientRecordFiles,
  type RecordPaperEntry,
  renderPatientRecordPdf,
} from "./patient-record.js"
import type { ProductHooks } from "./product-hooks.js"
import { productHooks } from "./products.js"

/** Lo que la pantalla cuenta, sacado de la MISMA lista que arma el ZIP. */
export interface PatientRecordSummary {
  signedOdontograms: number
  prescriptions: number
  orders: number
  medicalLeaves: number
  consentsSigned: number
  images: number
  tomographies: number
  otherFiles: number
  /** Lo que pesa, más o menos (los archivos, las tomografías y los papeles); null si no se sabe. */
  approxBytes: number | null
}

export interface PatientRecordCopy {
  /** «Historia de Rosa Quispe.zip». */
  fileName: string
  generatedAt: Date
  /** Entradas del ZIP en orden; bytes ya armados o una clave del almacenamiento a leer en streaming. */
  entries: Array<{ name: string; bytes?: Uint8Array; storageKey?: string }>
  summary: PatientRecordSummary
  /**
   * El LÉEME otra vez, con lo que no se pudo leer del almacenamiento al armar el ZIP: va último,
   * así quien lo arma en streaming lo cambia por este si algo falló (`zipStream` con `onFailure`).
   */
  readme(unreadable: readonly string[]): Uint8Array
}

/** Dónde vive lo emitido (para leer los papeles guardados y guardar los que falten). */
export interface RecordCopyDeps {
  storage: PaperStorage
}

/** El nombre del LÉEME, en la raíz del ZIP. */
export const RECORD_README = "LÉEME.txt"
const PAPERS = "papeles"

/** Un papel por incluir: lo que se sabe de él antes de armarlo. */
interface PlannedPaper {
  kind: string
  id: string
  label: string
  at: Date
  mark: string | null
  signer: string | null
  fileName: string
  related: RecordPaperEntry["related"]
  /** Cuánto pesa, si ya se sabe (lo guardado); null si no. */
  size: number | null
  /** Lo arma (o lo lee) dentro de su propio punto de guardado: si falla, no tumba la copia. */
  render: (tx: Db) => Promise<Uint8Array>
}

/** Un nombre de archivo que ningún sistema rechaza, corto y estable. */
function safeName(text: string): string {
  return text
    .replace(/\s*[\\/:*?"<>|]+\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90)
}

/** El día (AAAA-MM-DD) de un instante en la zona de la clínica: lo de las 21:00 en Lima es de ese día, no del siguiente. */
export function clinicIsoDay(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" }).format(at)
}

/** «Receta N.º 2 - 2026-11-18 (anulada) (1a2b3c4d).pdf», con el día en la zona de la clínica. */
function paperFileName(
  label: string,
  at: Date,
  timezone: string,
  mark: "anulada" | "revocado" | null,
  id: string,
): string {
  return `${safeName(label)} - ${clinicIsoDay(at, timezone)}${mark ? ` (${mark})` : ""} (${id.slice(0, 8)}).pdf`
}

/**
 * Los papeles de la persona, con la regla de «Tus documentos» del portal (`portal-papers.ts`),
 * sin el comprobante (no es clínico) y con lo anulado también: cada receta, orden y descanso; la
 * hoja de atención que se emitió; el consentimiento firmado o revocado (el que firmó por su enlace
 * y nadie confirmó no tiene PDF guardado: se nombra en el PDF de lectura); y los del producto.
 */
async function plannedPapers(
  tx: Db,
  orgId: string,
  record: PatientRecord,
  hooks: ProductHooks,
  deps: RecordCopyDeps,
): Promise<PlannedPaper[]> {
  const patientId = record.person.patientId
  const zone = record.clinic
  const health = (type: HealthDocumentType, id: string) => async (sp: Db) =>
    (await renderHealthDocumentPdf(sp, orgId, patientId, type, id, deps.storage, { viewing: true }))
      .bytes
  const voidedOn = (at: Date | null, reason: string | null, word = "Anulada") =>
    `${word}${at ? ` el ${dayWords(at, zone)}` : ""}${reason ? `: ${reason}` : ""}`
  const papers: PlannedPaper[] = []
  for (const { row, items } of record.prescriptions) {
    const voided = row.status === "anulada"
    const label = `Receta N.º ${row.prescriptionNumber}`
    papers.push({
      kind: "receta",
      id: row.id,
      label,
      at: row.issuedAt,
      mark: voided ? voidedOn(row.cancelledAt, row.cancelReason) : null,
      signer: signerWords({
        name: row.prescriberName,
        title: row.prescriberTitle,
        registration: row.prescriberRegistration,
      }),
      fileName: paperFileName(
        label,
        row.issuedAt,
        zone.timezone,
        voided ? "anulada" : null,
        row.id,
      ),
      related: items[0] ? { resourceType: "MedicationRequest", id: items[0].id } : null,
      size: null,
      render: health("prescription", row.id),
    })
  }
  for (const o of record.orders) {
    const voided = o.status === "cancelado"
    const label = `${o.kindWords} · ${o.title}`
    papers.push({
      kind: "orden",
      id: o.id,
      label,
      at: o.createdAt,
      mark: voided
        ? voidedOn(o.cancelledAt, o.cancelReason)
        : o.status === "completado"
          ? null
          : "Sin resultado",
      signer: signerWords({
        name: o.signerName,
        title: o.signerTitle,
        registration: o.signerRegistration,
      }),
      fileName: paperFileName(label, o.createdAt, zone.timezone, voided ? "anulada" : null, o.id),
      related: { resourceType: "ServiceRequest", id: o.id },
      size: null,
      render: health("order", o.id),
    })
  }
  for (const l of record.leaves) {
    const voided = l.status === "anulado"
    const label = `Descanso médico N.º ${l.leaveNumber}`
    papers.push({
      kind: "descanso",
      id: l.id,
      label,
      at: l.issuedAt,
      mark: voided ? voidedOn(l.cancelledAt, l.cancelReason, "Anulado") : null,
      signer: signerWords({
        name: l.signerName,
        title: l.signerTitle,
        registration: l.signerRegistration,
      }),
      fileName: paperFileName(label, l.issuedAt, zone.timezone, voided ? "anulada" : null, l.id),
      related: null,
      size: null,
      render: health("medical_leave", l.id),
    })
  }
  // La hoja de atención solo si se emitió (la regla del portal): no una por cada atención firmada.
  const sheets = await tx
    .select({ id: issuedPaper.documentId, at: issuedPaper.createdAt, size: issuedPaper.sizeBytes })
    .from(issuedPaper)
    .where(
      and(
        eq(issuedPaper.organizationId, orgId),
        eq(issuedPaper.patientId, patientId),
        eq(issuedPaper.documentType, "attention_sheet"),
      ),
    )
  for (const sheet of sheets) {
    const visit = record.encounters.find((entry) => entry.row.id === sheet.id)
    const at = visit?.row.endedAt ?? sheet.at
    papers.push({
      kind: "hoja",
      id: sheet.id,
      label: "Hoja de atención",
      at,
      mark: null,
      signer: visit
        ? signerWords({
            name: visit.row.signerName,
            title: visit.row.signerTitle,
            registration: visit.row.signerRegistration,
          })
        : null,
      fileName: paperFileName("Hoja de atención", at, zone.timezone, null, sheet.id),
      related: { resourceType: "Encounter", id: sheet.id },
      size: sheet.size,
      render: health("attention_sheet", sheet.id),
    })
  }
  for (const c of record.consents) {
    if (c.status !== "firmado" && c.status !== "revocado") continue
    const revoked = c.status === "revocado"
    const label = `Consentimiento · ${c.titleSnapshot}${c.siteWords ? ` · ${c.siteWords}` : ""}`
    papers.push({
      kind: "consentimiento",
      id: c.id,
      label,
      at: c.signedAt ?? c.createdAt,
      mark: revoked ? voidedOn(c.revokedAt, c.revokeReason, "Revocado") : null,
      signer: c.signerName ?? null,
      fileName: paperFileName(
        label,
        c.signedAt ?? c.createdAt,
        zone.timezone,
        revoked ? "revocado" : null,
        c.id,
      ),
      related: { resourceType: "Consent", id: c.id },
      size: null,
      render: health("consent", c.id),
    })
  }
  // Lo del producto (odentIA: cada odontograma firmado y el de hoy, sin firmar), con su PDF diferido.
  if (hooks.recordPapers)
    for (const paper of await hooks.recordPapers(tx, { orgId, patientId }, deps.storage))
      papers.push({
        kind: paper.kind,
        id: paper.id,
        label: paper.label,
        at: paper.at,
        mark: paper.mark,
        signer: paper.signer,
        fileName: safeName(paper.fileName.replace(/\.pdf$/i, "")) + ".pdf",
        related: null,
        size: paper.size,
        // Se dibuja recién al armar el ZIP, en su punto de guardado: contar no dibuja ni guarda.
        render: (sp) => paper.render(sp),
      })
  // Lo del producto que se ve en su portal (vistIA: la receta de lentes), con su PDF.
  const own = hooks.portalPapers
  if (own)
    for (const paper of await own.list(tx, orgId, patientId))
      papers.push({
        kind: "producto",
        id: paper.id,
        label: paper.title,
        at: paper.at,
        mark: paper.stateWord,
        signer: null,
        // La anulada lo dice en su nombre, como cualquier papel (vistIA: la receta de lentes).
        fileName: paperFileName(
          paper.title,
          paper.at,
          zone.timezone,
          paper.stateWord && /^anulad/i.test(paper.stateWord) ? "anulada" : null,
          paper.id,
        ),
        related: null,
        size: null,
        render: async (sp) => (await own.pdf(sp, orgId, patientId, paper.id)).bytes,
      })
  // Lo ya guardado dice cuánto pesa: lo cuenta la pantalla sin armarlo.
  // Solo los papeles comunes: los del producto ya dicen el suyo (y el de hoy no tiene fila).
  const COMMON_KINDS = ["receta", "orden", "descanso", "hoja"]
  const unknown = papers
    .filter((paper) => paper.size === null && COMMON_KINDS.includes(paper.kind))
    .map((paper) => paper.id)
  if (unknown.length) {
    const stored = await tx
      .select({ id: issuedPaper.documentId, size: issuedPaper.sizeBytes })
      .from(issuedPaper)
      .where(and(eq(issuedPaper.organizationId, orgId), inArray(issuedPaper.documentId, unknown)))
    const sizes = new Map(stored.map((row) => [row.id, row.size]))
    for (const paper of papers) if (paper.size === null) paper.size = sizes.get(paper.id) ?? null
  }
  return papers
}

/** Una tomografía que todavía se está subiendo: una carpeta sin su estudio completo. */
function unfinishedStudy(record: PatientRecord, d: PatientRecord["documents"][number]): boolean {
  return (
    d.storageKey.endsWith("/") && record.imagingStudies.every((study) => study.documentId !== d.id)
  )
}

/**
 * Lo que va en el ZIP como archivo de su ficha: sin lo que ya está dentro de un papel (el PDF de un
 * consentimiento y el de su revocación) ni la tomografía que no terminó de subirse.
 */
function filesOfCopy(record: PatientRecord, papers: readonly Pick<PlannedPaper, "kind" | "id">[]) {
  const inside = new Set<string>()
  for (const c of record.consents)
    if (papers.some((paper) => paper.kind === "consentimiento" && paper.id === c.id))
      for (const id of [c.pdfDocumentId, c.revokePdfDocumentId]) if (id) inside.add(id)
  return record.documents.filter((d) => !inside.has(d.id) && !unfinishedStudy(record, d))
}

/** Lo que cuenta la pantalla, de la lista de la copia. */
function summaryOf(
  record: PatientRecord,
  papers: ReadonlyArray<Pick<PlannedPaper, "kind" | "id" | "size">>,
  files: PatientRecord["documents"],
  extraBytes: number,
): PatientRecordSummary {
  const studies = new Map(record.imagingStudies.map((study) => [study.documentId, study]))
  const count = (kind: string) => papers.filter((paper) => paper.kind === kind).length
  const images = files.filter(
    (d) => !studies.has(d.id) && isImageDocumentCategory(d.category),
  ).length
  const tomographies = files.filter((d) => studies.has(d.id)).length
  const known = [...papers.map((paper) => paper.size), ...files.map((d) => d.sizeBytes ?? null)]
  const sum = known.reduce<number>((total, size) => total + (size ?? 0), 0)
  return {
    signedOdontograms: count("signed_odontogram"),
    prescriptions: count("receta"),
    orders: count("orden"),
    medicalLeaves: count("descanso"),
    consentsSigned: record.consents.filter(
      (c) =>
        c.status === "firmado" &&
        papers.some((paper) => paper.kind === "consentimiento" && paper.id === c.id),
    ).length,
    images,
    tomographies,
    otherFiles: files.length - images - tomographies,
    approxBytes: known.some((size) => size !== null) || extraBytes ? sum + extraBytes : null,
  }
}

/** El LÉEME: qué trae cada carpeta, los estándares que de verdad cumple y lo que no se pudo incluir. */
function readmeText(
  record: PatientRecord,
  input: { base: string; fhir: string; papers: number; files: number; missing: readonly string[] },
): string {
  const zone = record.clinic
  const lists = [
    ...new Set(
      record.encounters
        .flatMap((entry) => entry.diagnoses.map((d) => d.diagnosisSystem))
        .concat(record.conditions.map((c) => c.diagnosisSystem ?? ""))
        .filter((system) => isDiagnosisSystem(system))
        .map((system) => DIAGNOSIS_SYSTEM_INFO[system as keyof typeof DIAGNOSIS_SYSTEM_INFO].short),
    ),
  ]
  const teeth = input.fhir.includes("http://terminology.hl7.org/CodeSystem/ex-tooth")
  const dicom = record.imagingStudies.length > 0
  const lines = [
    `Copia de la historia de ${record.person.displayName}`,
    `${record.clinic.tradeName} · generada el ${dayTimeWords(record.generatedAt, zone)}`,
    "",
    "QUÉ TRAE",
    `- «${input.base}.pdf»: la historia para leer, de principio a fin. La primera página dice lo que no se puede pasar por alto antes de atenderla y lo que sigue.`,
    `- «${input.base}.fhir.json»: la misma historia para cargarla en el sistema de otra clínica.`,
    ...(input.papers
      ? [
          `- «${PAPERS}»: cada papel emitido en su PDF, el mismo que se entregó (${input.papers}). Lo anulado o revocado lleva su marca y su motivo en la hoja.`,
        ]
      : []),
    ...(input.files
      ? [
          `- «documentos»: las imágenes y los documentos de su ficha, tal como se subieron (${input.files}).${dicom ? " Cada tomografía va en su carpeta, con sus cortes en DICOM." : ""}`,
        ]
      : []),
    ...(record.retiredDocuments.length
      ? ["- Lo retirado de su ficha no va como archivo: el PDF lo nombra con su fecha y su motivo."]
      : []),
    "",
    "CON QUÉ ESTÁNDARES ESTÁ HECHA",
    "- HL7 FHIR R4 (4.0.1): el archivo .fhir.json es un Bundle de tipo «collection». Cada referencia entre sus recursos se resuelve dentro del mismo archivo.",
    ...(lists.length
      ? [`- ${lists.join(" y ")}: cada diagnóstico lleva su código de la lista que usa la clínica.`]
      : []),
    ...(teeth ? ["- FDI (ISO 3950): las piezas dentales van con su número de dos dígitos."] : []),
    ...(dicom ? ["- DICOM: los cortes de cada tomografía, tal como salieron del equipo."] : []),
    "",
    "CÓMO SE CARGA EN OTRO SISTEMA",
    "- Un sistema que lee HL7 FHIR R4 importa el archivo .fhir.json como un Bundle. Las direcciones de los archivos (DocumentReference.content.attachment.url) son relativas a la raíz de esta copia: hay que subir también las carpetas.",
    ...(dicom
      ? [
          "- Una tomografía se abre en un visor DICOM eligiendo su carpeta de cortes; no lleva índice (DICOMDIR).",
        ]
      : []),
    "- El PDF se abre en cualquier lector de PDF.",
    "",
    "LO QUE NO SE PUDO INCLUIR",
    ...(input.missing.length
      ? input.missing.map((item) => `- ${item}`)
      : ["- Nada: todo lo de su ficha va en esta copia."]),
    "",
  ]
  // CRLF: el Bloc de notas de Windows antiguo no corta las líneas con LF solo.
  return lines.join("\r\n")
}

/** Arma la copia: la lista de su ZIP, lo que cuenta la pantalla y el LÉEME. */
async function assemble(
  tx: Db,
  orgId: string,
  patientId: string,
  deps: RecordCopyDeps,
  options: { copyLink?: { url: string; until: Date }; render: boolean },
): Promise<{ copy: PatientRecordCopy | null; summary: PatientRecordSummary }> {
  const record = await loadPatientRecord(tx, orgId, patientId)
  const hooks = await productHooks(tx, orgId)
  const planned = await plannedPapers(tx, orgId, record, hooks, deps)
  const files = filesOfCopy(record, planned)
  const missing = record.documents
    .filter((d) => unfinishedStudy(record, d))
    .map((d) => `${d.label}: la tomografía todavía no terminó de subirse; no va en esta copia.`)
  if (!options.render) return { copy: null, summary: summaryOf(record, planned, files, 0) }

  const papers: RecordPaperEntry[] = []
  const bytesOf = new Map<string, Uint8Array>()
  for (const paper of planned) {
    try {
      // Cada papel en su punto de guardado: si uno no se lee (huella que no coincide, almacenamiento
      // caído), se nombra en «No se pudo incluir» y los demás siguen (dev, 18 nov, H5).
      const bytes = await tx.transaction((sp) => paper.render(sp as unknown as Db))
      const path = `${PAPERS}/${paper.fileName}`
      bytesOf.set(path, bytes)
      papers.push({
        kind: paper.kind,
        id: paper.id,
        label: paper.label,
        at: paper.at,
        mark: paper.mark,
        signer: paper.signer,
        path,
        contentType: "application/pdf",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha1: createHash("sha1").update(bytes).digest("base64"),
        related: paper.related,
      })
    } catch (error) {
      console.error(
        `copia: no se pudo incluir ${paper.kind} ${paper.id}`,
        error instanceof Error ? error.message : error,
      )
      missing.push(`${paper.label}: no se pudo leer su PDF guardado; pídelo en la clínica.`)
    }
  }
  const copyRecord: PatientRecord = {
    ...record,
    documents: files,
    papers,
    missing,
  }
  const pdf = await renderPatientRecordPdf(
    copyRecord,
    copyRecord.clinic,
    options.copyLink ? { copyLink: options.copyLink } : {},
  )
  const fhir = JSON.stringify(patientRecordFhirBundle(copyRecord), null, 2)
  const fhirBytes = new TextEncoder().encode(fhir)
  const fileName = patientRecordFileName(copyRecord, "zip")
  const base = fileName.replace(/\.zip$/, "")
  const stored = await patientRecordFiles(tx, orgId, copyRecord)
  const summary = summaryOf(
    copyRecord,
    papers.map((paper) => ({ kind: paper.kind, id: paper.id, size: paper.size })),
    files,
    pdf.byteLength + fhirBytes.byteLength,
  )
  const readme = (unreadable: readonly string[]) =>
    new TextEncoder().encode(
      readmeText(copyRecord, {
        base,
        fhir,
        papers: papers.length,
        files: files.length,
        missing: [
          ...missing,
          ...unreadable.map(
            (name) => `«${name}»: no se pudo leer del almacenamiento al armar esta copia.`,
          ),
        ],
      }),
    )
  return {
    summary,
    copy: {
      fileName,
      generatedAt: copyRecord.generatedAt,
      entries: [
        { name: `${base}.pdf`, bytes: pdf },
        { name: `${base}.fhir.json`, bytes: fhirBytes },
        ...papers.map((paper) => ({
          name: paper.path,
          bytes: bytesOf.get(paper.path) as Uint8Array,
        })),
        ...stored.map((file) => ({ name: file.name, storageKey: file.storageKey })),
        // Último: si algo no se lee al armar el ZIP, quien lo arma lo cambia por `readme(…)`.
        { name: RECORD_README, bytes: readme([]) },
      ],
      summary,
      readme,
    },
  }
}

/**
 * La copia completa de la historia: la lista del ZIP en orden (el PDF para leer, el FHIR, los
 * papeles, los archivos y el LÉEME), lo que cuenta la pantalla y el LÉEME para rehacer si algo no
 * se lee al armarlo. `copyLink`: el PDF lleva en su primera página el enlace para bajarla.
 */
export async function buildPatientRecordCopy(
  tx: Db,
  orgId: string,
  patientId: string,
  deps: RecordCopyDeps,
  options: { copyLink?: { url: string; until: Date } } = {},
): Promise<PatientRecordCopy> {
  const { copy } = await assemble(tx, orgId, patientId, deps, { ...options, render: true })
  return copy as PatientRecordCopy
}

/**
 * Lo que trae la copia, contado de la misma lista que arma el ZIP, sin armar los PDF: la pantalla
 * lo muestra antes de bajarla. Un papel que al armarla no se pueda leer no irá (y el LÉEME lo dice).
 */
export async function patientRecordSummary(
  tx: Db,
  orgId: string,
  patientId: string,
  deps: RecordCopyDeps,
): Promise<PatientRecordSummary> {
  return (await assemble(tx, orgId, patientId, deps, { render: false })).summary
}
