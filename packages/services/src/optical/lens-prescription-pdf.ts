import type { Db } from "@odentia/db"
import { lensPrescription } from "@odentia/db/schema/optical"
import {
  type ContactLens,
  EYES,
  formatDay,
  PRESCRIPTION_KINDS,
  type PrescriptionLenses,
  PRISM_BASES,
  pupillaryDistanceText,
  type PupillaryDistance,
  type Refraction,
} from "@odentia/optical"
import { and, eq } from "drizzle-orm"
import { documentCheckUrl } from "../document-check.js"
import { loadDocumentClinic } from "../document-clinic.js"
import { ageWords, chartNumber, DocumentKit, dayTimeWords, dayWords, documentFormat, SIZE } from "../document-kit.js"
import { notFound } from "../errors.js"
import { orgProduct } from "../locale.js"
import { joinPatientPerson, patientPerson } from "../patient-identity.js"
import { drawnSignatureAt } from "../professional-profiles.js"
import { patient } from "@odentia/db/schema/clinical"

/** Una dioptría como va en la receta impresa: «+1,25», «−0,50»; vacía, «—». */
function diopter(value: number | undefined): string {
  if (value === undefined) return "—"
  if (value === 0) return "Neutro"
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toFixed(2).replace(".", ",")}`
}

const plain = (value: number | undefined, unit = "") => (value === undefined ? "—" : `${String(value).replace(".", ",")}${unit}`)

/** Los prismas de un ojo: «1 Δ base adentro + 0,5 Δ base arriba». */
function prismText(lens: Refraction | undefined): string {
  const parts = [
    [lens?.prisma, lens?.base],
    [lens?.prisma2, lens?.base2],
  ]
    .filter(([amount]) => amount !== undefined)
    .map(([amount, base]) => `${String(amount).replace(".", ",")} Δ ${PRISM_BASES.find((item) => item.key === base)?.label.toLowerCase() ?? ""}`)
  return parts.length ? parts.join(" + ") : "—"
}

/**
 * La receta de lentes impresa (entrega 3 del plan): el membrete de la óptica, la
 * persona con su edad, la graduación de cada ojo en su tabla, la distancia
 * pupilar, las indicaciones y quien la firma, con su firma dibujada y el QR con
 * que se comprueba (como el odontograma firmado, se genera de sus datos: no se
 * guarda un archivo). La externa dice de quién es y si se verificó; la anulada lo
 * dice arriba, con su motivo.
 */
export async function renderLensPrescriptionPdf(
  tx: Db,
  orgId: string,
  patientId: string,
  id: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  if ((await orgProduct(tx, orgId)) !== "optical") throw notFound("Receta de lentes")
  const [row] = await tx
    .select()
    .from(lensPrescription)
    .where(and(eq(lensPrescription.organizationId, orgId), eq(lensPrescription.patientId, patientId), eq(lensPrescription.id, id)))
  if (!row) throw notFound("Receta")
  const [person] = await tx
    .select({
      displayName: patientPerson.displayName,
      patientNumber: patient.patientNumber,
      docType: patientPerson.docType,
      docNumber: patientPerson.docNumber,
      birthDate: patientPerson.birthDate,
    })
    .from(patient)
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
  if (!person) throw notFound("Paciente")
  // Con la hoja membretada de cuando se emitió (ADR 0181).
  const clinic = await loadDocumentClinic(tx, orgId, { at: row.createdAt })
  const kind = PRESCRIPTION_KINDS.find((item) => item.key === row.kind)?.label ?? row.kind
  const title = `Receta de ${kind.toLowerCase()}`
  const kit = await DocumentKit.open(clinic, documentFormat(clinic), {
    title,
    docLabel: title,
    patientLabel: person.displayName,
    createdAt: new Date(`${row.issuedOn}T12:00:00Z`),
  })
  kit.gap(22)
  kit.titleWithDetails(title, [
    { text: `Emitida el ${dayWords(row.issuedOn, clinic)}`, strong: true },
    { text: `Válida hasta el ${dayWords(row.validUntil, clinic)}` },
  ])
  if (row.voidedAt) {
    kit.gap(12)
    kit.stateBox({ kind: "alert", title: "ANULADA", detail: row.voidReason ? `Motivo: ${row.voidReason}` : null })
  }
  kit.gap(16)
  const age = ageWords(person.birthDate, clinic)
  kit.facts(
    [
      { label: "Paciente", value: person.displayName, span: 2, strong: true },
      ...(person.docNumber ? [{ label: person.docType ?? "Documento", value: person.docNumber }] : []),
      ...(age ? [{ label: "Edad", value: age }] : []),
      { label: "Historia clínica", value: chartNumber(person.patientNumber) },
    ],
    4,
  )
  const lenses = row.lenses as PrescriptionLenses
  const contact = row.kind === "contacto"
  const columns = [
    { label: "", width: 34 },
    { label: "Esfera" },
    { label: "Cilindro" },
    { label: "Eje" },
    { label: "Adición" },
    ...(contact ? [{ label: "Curva base" }, { label: "Diámetro" }] : [{ label: "Prisma" }]),
  ]
  kit.heading("Graduación", { size: SIZE.total, before: 22, after: 8 })
  kit.table({
    columns,
    rowPad: 8,
    size: SIZE.read,
    rows: EYES.map((eye) => {
      const lens = lenses[eye.key] as (Refraction & ContactLens) | undefined
      return [
        [{ inlines: eye.short, face: "sansSemi" as const }],
        // Con cilindro y sin esfera, la esfera es neutra: en blanco el taller lee «no se midió».
        diopter(lens?.esfera ?? (lens?.cilindro !== undefined ? 0 : undefined)),
        lens?.cilindro === undefined ? "—" : diopter(lens.cilindro),
        lens?.eje === undefined ? "—" : `${lens.eje}°`,
        lens?.adicion === undefined ? "—" : diopter(lens.adicion),
        ...(contact
          ? [plain(lens?.curvaBase, " mm"), plain(lens?.diametro, " mm")]
          : [prismText(lens)]),
      ]
    }),
  })
  const brands = contact ? EYES.filter((eye) => (lenses[eye.key] as ContactLens | undefined)?.marca) : []
  if (brands.length > 0)
    kit.text(brands.map((eye) => `${eye.short}: ${(lenses[eye.key] as ContactLens).marca}`).join(" · "), { size: SIZE.read })
  const dp = pupillaryDistanceText(row.pupillaryDistance as PupillaryDistance | null)
  if (dp) {
    kit.subheading("Distancia pupilar", { before: 12 })
    kit.text(dp, { size: SIZE.read })
  }
  if (row.notes) {
    kit.subheading("Indicaciones", { before: 12 })
    kit.text(row.notes, { size: SIZE.read })
  }
  if (row.source === "externa") {
    kit.subheading("Receta externa", { before: 12 })
    kit.text(
      `Transcrita de la receta de ${row.prescriberName}${row.prescriberRegistration ? ` (${row.prescriberRegistration})` : ""} del ${formatDay(row.issuedOn)}. ${row.verifiedAt ? "Verificada por un optómetra de la óptica." : "Sin verificar todavía por un optómetra de la óptica."}`,
      { size: SIZE.read },
    )
  } else {
    const signed = {
      name: row.prescriberName,
      credential: row.prescriberRegistration,
      at: dayTimeWords(row.createdAt, clinic),
      checkUrl: await documentCheckUrl(tx, orgId, "lens_prescription", row.id),
      strokes: await drawnSignatureAt(tx, orgId, row.prescriberUserId, row.createdAt),
    }
    kit.gap(14)
    kit.anchorBottom(kit.signedBlockHeight(signed))
    kit.signedBlock(signed)
  }
  const bytes = await kit.finish()
  return { bytes, filename: `Receta-de-${row.kind === "contacto" ? "lentes-de-contacto" : "anteojos"}-${row.issuedOn}.pdf` }
}
