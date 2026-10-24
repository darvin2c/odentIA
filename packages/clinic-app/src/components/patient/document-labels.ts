import {
  IMAGE_TYPE_LABELS,
  type ImageType,
  type PatientDocumentCategory,
  REPORT_STATUS_LABELS,
  type ReportStatus,
} from "@odentia/clinical"
import { formatDate } from "../../lib/clinical-journey"
import { timeAgo } from "../../lib/crm"
import { type Encounter, encounterStatusLabel, type PlanItem } from "../../lib/patients"
import { productUi } from "../../product/product-ui"

/** Lo que se sube: la misma lista que la base (`PATIENT_DOCUMENT_CATEGORIES`), en el orden de la pantalla. */
export const UPLOAD_CATEGORIES = [
  "radiografia",
  "foto_clinica",
  "consentimiento",
  "informe",
  "otro",
] as const satisfies readonly PatientDocumentCategory[]

const CATEGORY_LABELS: Record<string, string> = {
  radiografia: "Radiografía",
  foto_clinica: "Foto clínica",
  consentimiento: "Consentimiento",
  informe: "Informe",
  otro: "Otro",
}

export const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/dicom",
]
/** DICOM suele llegar sin tipo declarado: se admite por extensión y el servidor
 * verifica el contenido real de todos los archivos. */
export const ACCEPT_ATTR = [...ACCEPTED_TYPES, ".dcm"].join(",")
export const MAX_BYTES = 10 * 1024 * 1024

export function isAcceptedFile(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type) || /\.dcm$/i.test(file.name)
}

export function categoryLabel(category: string): string {
  return productUi().documents.imaging.categoryLabels[category] ?? CATEGORY_LABELS[category] ?? category
}

/** Tipos de imagen que admite cada categoría, los del producto (vacío: no aplica). */
export function imageTypesFor(category: string): readonly string[] {
  return productUi()
    .documents.imaging.types.filter((type) => type.category === category)
    .map((type) => type.value)
}

export function imageTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null
  return (
    productUi().documents.imaging.types.find((item) => item.value === type)?.label ??
    IMAGE_TYPE_LABELS[type as ImageType] ??
    type
  )
}

export function reportStatusLabel(status: string | null | undefined): string | null {
  if (!status) return null
  return REPORT_STATUS_LABELS[status as ReportStatus] ?? status
}

/** Fecha que cuenta para la historia: la de toma si se registró, si no la de subida. */
export function takenAt(doc: { capturedAt?: string | null; createdAt: string }): string {
  return doc.capturedAt ?? doc.createdAt
}

/** «Tomada 30/09/2026» o «Subida 18/10/2026»: el mismo formato de fecha que el resto de los papeles. */
export function formatTakenAt(doc: { capturedAt?: string | null; createdAt: string }): string {
  return `${doc.capturedAt ? "Tomada" : "Subida"} ${formatDate(takenAt(doc))}`
}

export function encounterLabel(e: Encounter): string {
  const when = timeAgo(e.createdAt)
  return `${when}${e.reason ? ` · ${e.reason}` : ""} · ${encounterStatusLabel(e.status)}`
}

export function planItemLabel(p: PlanItem): string {
  return `${p.title}${p.toothNumber != null ? ` · Pieza ${p.toothNumber}` : ""}`
}

/** Nombre base sin extensión para proponer el título de cada archivo. */
export function basenameWithoutExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf(".")
  return (dot > 0 ? base.slice(0, dot) : base).trim() || "Documento"
}
