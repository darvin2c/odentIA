/**
 * Los papeles clínicos que firma quien los emite: receta, orden y descanso médico,
 * con el kit único. Son los mismos para enviar, para «Tus papeles» y para que el
 * equipo los vea o los imprima. Los datos de firma son los congelados al emitir.
 */
import { diagnosisCodeLabel, medicalLeaveEnd } from "@odentia/clinical"
import {
  ageWords,
  chartNumber,
  dayTimeWords,
  dayWords,
  documentFormat,
  DocumentKit,
  type DocumentClinic,
  numberInWords,
  SIZE,
} from "./document-kit.js"
import type { getOrderPrint } from "./clinical-forms.js"
import type { getMedicalLeavePrint } from "./medical-leaves.js"
import type { getPrescriptionPrint } from "./prescriptions.js"

/** Lo que el papel necesita además de sus datos. */
export interface PaperContext {
  clinic: DocumentClinic
  /** La dirección para comprobarlo con el QR; sin ella, sale sin QR. */
  checkUrl: string | null
}

export const ORDER_KIND_WORDS: Record<string, string> = {
  imagen: "Orden de imagen",
  laboratorio: "Orden de laboratorio",
  interconsulta: "Derivación",
}

interface PaperPerson {
  displayName: string
  patientNumber: number
  docType: string | null
  docNumber: string | null
  birthDate: string | null
}

/** «Cirujano dentista · COP 12345». */
export function credentialOf(title: string | null | undefined, registration: string | null | undefined): string | null {
  return [title, registration].filter(Boolean).join(" · ") || null
}

function diagnosisWords(system: string | null, code: string | null, description: string | null): string | null {
  if (!code) return null
  const label = diagnosisCodeLabel(system, code)
  return description ? `${label} · ${description}` : label
}

function personFacts(kit: DocumentKit, person: PaperPerson) {
  const age = ageWords(person.birthDate, kit.clinic)
  return [
    { label: "Paciente", value: person.displayName, span: 2, strong: true },
    ...(person.docNumber ? [{ label: person.docType ?? "Documento", value: person.docNumber }] : []),
    ...(age ? [{ label: "Edad", value: age }] : []),
  ]
}

function signedAtBottom(
  kit: DocumentKit,
  input: { name: string | null; title: string | null; registration: string | null; at: Date | string; checkUrl: string | null },
) {
  if (!input.name) return
  const signed = {
    name: input.name,
    credential: credentialOf(input.title, input.registration),
    at: dayTimeWords(input.at, kit.clinic),
    checkUrl: input.checkUrl,
  }
  kit.anchorBottom(kit.signedBlockHeight(signed))
  kit.signedBlock(signed)
}

/** La receta: alergias a la vista, cantidad en cifras y letras, y «Rp/». */
export async function renderPrescriptionPdf(data: Awaited<ReturnType<typeof getPrescriptionPrint>>, context: PaperContext) {
  const { prescription: rx, patient: person } = data
  const docLabel = `Receta N.º ${rx.prescriptionNumber}`
  const kit = await DocumentKit.open(context.clinic, documentFormat(context.clinic), {
    title: docLabel,
    docLabel,
    patientLabel: person.displayName,
    createdAt: new Date(rx.issuedAt),
  })
  const zone = context.clinic
  kit.gap(22)
  kit.titleWithDetails("Receta", [
    { text: `N.º ${rx.prescriptionNumber}`, strong: true },
    { text: `Emitida el ${dayWords(rx.issuedAt, zone)}` },
    ...(rx.validUntil ? [{ text: `Válida hasta el ${dayWords(rx.validUntil, zone)}` }] : []),
  ])
  if (rx.status === "anulada") {
    kit.gap(12)
    kit.stateBox({ kind: "alert", title: "ANULADA", detail: rx.cancelReason ? `Motivo: ${rx.cancelReason}` : null })
  }
  kit.gap(16)
  const diagnosis = diagnosisWords(rx.diagnosisSystem, rx.diagnosisCode, data.diagnosisDescription)
  kit.facts(
    [
      ...personFacts(kit, person),
      ...(diagnosis ? [{ label: "Diagnóstico", value: diagnosis, span: 2 }] : []),
      { label: "Historia clínica", value: chartNumber(person.patientNumber), span: 2 },
      // El peso con que se recetó (latidIA, a un menor de 12 años).
      ...(rx.patientWeightKg ? [{ label: "Peso", value: `${Number(rx.patientWeightKg)} kg`, span: 2 }] : []),
      ...(data.allergies.length > 0 ? [{ label: "Alergias", value: data.allergies.join(", "), span: 4, bold: true }] : []),
    ],
    4,
  )
  kit.heading("Rp/", { size: SIZE.total, before: 22, after: 8 })
  rx.items.forEach((item, index) => {
    const name = [
      item.genericName ?? item.medicationName,
      item.strength,
    ]
      .filter(Boolean)
      .join(" ")
    const title = [name, item.dosageForm].filter(Boolean).join(" · ")
    kit.table({
      columns: [{ label: "", width: 21, pad: 0 }, { label: "" }],
      closed: false,
      rowPad: 9,
      size: SIZE.read,
      rows: [
        [
          [{ inlines: `${index + 1}.`, face: "sansSemi" }],
          [
            { inlines: `${title}${item.brandName ? ` (${item.brandName})` : ""}`, size: 13.5, face: "sansSemi" },
            ...(item.quantity
              ? [{ inlines: `Cantidad: ${item.quantity} (${numberInWords(item.quantity)})`, size: SIZE.table, tone: "soft" as const, gapBefore: 1 }]
              : []),
            { inlines: `${item.dose}, vía ${item.route}, ${item.frequency}, ${item.duration}.`, gapBefore: 4 },
            ...(item.instructions ? [{ inlines: item.instructions, tone: "soft" as const }] : []),
          ],
        ],
      ],
    })
  })
  if (rx.notes) {
    kit.subheading("Indicaciones", { before: 10 })
    kit.text(rx.notes, { size: SIZE.read })
  }
  kit.gap(14)
  signedAtBottom(kit, {
    name: rx.prescriberName,
    title: rx.prescriberTitle,
    registration: rx.prescriberRegistration,
    at: rx.issuedAt,
    checkUrl: context.checkUrl,
  })
  return kit.finish()
}

/** La orden: para quién, qué se pide y el motivo clínico. */
export async function renderOrderPdf(data: Awaited<ReturnType<typeof getOrderPrint>>, context: PaperContext) {
  const { order, patient: person, requestedBy } = data
  const kind = ORDER_KIND_WORDS[order.kind] ?? "Orden"
  const kit = await DocumentKit.open(context.clinic, documentFormat(context.clinic), {
    title: `${kind} · ${order.title}`,
    docLabel: kind,
    patientLabel: person.displayName,
    createdAt: new Date(order.createdAt),
  })
  kit.gap(22)
  kit.titleWithDetails(kind, [{ text: `Pedida el ${dayWords(order.createdAt, context.clinic)}` }])
  if (order.status === "cancelado") {
    kit.gap(12)
    kit.stateBox({ kind: "alert", title: "ANULADA", detail: order.cancelReason ? `Motivo: ${order.cancelReason}` : null })
  }
  kit.gap(16)
  const diagnosis = diagnosisWords(order.diagnosisSystem, order.diagnosisCode, data.diagnosisDescription)
  kit.facts(
    [
      ...personFacts(kit, person),
      ...(diagnosis ? [{ label: "Diagnóstico", value: diagnosis, span: 2 }] : []),
      { label: "Historia clínica", value: chartNumber(person.patientNumber), span: 2 },
    ],
    4,
  )
  kit.gap(22)
  kit.text("Para", { size: SIZE.second, tone: "gray" })
  kit.text(order.recipient, { size: 13.5, face: "sansSemi" })
  kit.gap(14)
  kit.rule({ tone: "hair" })
  kit.gap(13)
  kit.text("Se pide", { size: SIZE.second, tone: "gray" })
  kit.gap(1)
  kit.text(order.title, { face: "serif", size: SIZE.h2, leading: 1.25 })
  if (order.detail) {
    kit.gap(6)
    kit.text("Motivo clínico", { size: SIZE.second, tone: "gray" })
    kit.text(order.detail, { size: SIZE.read })
  }
  kit.gap(14)
  signedAtBottom(kit, {
    name: requestedBy?.name ?? null,
    title: requestedBy?.title ?? null,
    registration: requestedBy?.registration ?? null,
    at: order.createdAt,
    checkUrl: context.checkUrl,
  })
  return kit.finish()
}

/**
 * El descanso médico: un documento propio, sin el formato oficial de ningún país
 * (issue 229, decisión 8). El diagnóstico va solo si la persona lo autorizó.
 */
export async function renderMedicalLeavePdf(data: Awaited<ReturnType<typeof getMedicalLeavePrint>>, context: PaperContext) {
  const { leave, patient: person } = data
  const zone = context.clinic
  const docLabel = `Constancia N.º ${leave.leaveNumber}`
  const kit = await DocumentKit.open(context.clinic, documentFormat(context.clinic), {
    title: `Descanso médico ${leave.leaveNumber}`,
    docLabel,
    patientLabel: person.displayName,
    createdAt: new Date(leave.issuedAt),
  })
  kit.gap(22)
  kit.titleWithDetails("Descanso médico", [
    { text: docLabel, strong: true },
    { text: `Emitida el ${dayWords(leave.issuedAt, zone)}` },
  ])
  if (leave.status === "anulado") {
    kit.gap(12)
    kit.stateBox({ kind: "alert", title: "ANULADO", detail: leave.cancelReason ? `Motivo: ${leave.cancelReason}` : null })
  }
  kit.gap(16)
  const diagnosis =
    leave.showDiagnosis && leave.diagnosisCode
      ? diagnosisWords(leave.diagnosisSystem, leave.diagnosisCode, data.diagnosisDescription)
      : null
  kit.facts(
    [
      ...personFacts(kit, person),
      ...(data.guardianName ? [{ label: "Madre, padre o apoderado", value: data.guardianName, span: 2 }] : []),
      ...(data.evaluatedAt ? [{ label: "Evaluado el", value: dayTimeWords(data.evaluatedAt, zone), span: 2 }] : []),
      ...(diagnosis ? [{ label: "Diagnóstico", value: diagnosis, span: 4 }] : []),
    ],
    4,
  )
  kit.gap(30)
  const end = medicalLeaveEnd(leave.startsOn, leave.days)
  kit.text(
    leave.days === 1
      ? `Se indica 1 día de descanso, el ${dayWords(leave.startsOn, zone)}.`
      : `Se indican ${leave.days} días de descanso, del ${dayWords(leave.startsOn, zone)} al ${dayWords(end, zone)}.`,
    { face: "serifMedium", size: SIZE.total, leading: 1.35 },
  )
  kit.gap(20)
  kit.rule({ tone: "hair" })
  if (leave.notes) {
    kit.subheading("Indicaciones", { before: 14 })
    kit.text(leave.notes, { size: SIZE.read })
  }
  kit.gap(14)
  signedAtBottom(kit, {
    name: leave.signerName,
    title: leave.signerTitle,
    registration: leave.signerRegistration,
    at: leave.issuedAt,
    checkUrl: context.checkUrl,
  })
  return kit.finish()
}
