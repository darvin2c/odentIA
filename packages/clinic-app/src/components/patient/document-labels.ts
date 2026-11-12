import {
  DICOM_DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_BYTES,
  documentMaxBytes,
  IMAGE_TYPE_LABELS,
  type ImageType,
  isImageDocumentCategory,
  type PatientDocumentCategory,
  REPORT_STATUS_LABELS,
  type ReportStatus,
} from "@odentia/clinical"
import { regionToday, zonedDateOf } from "@odentia/ui-patterns"
import { formatDate, instantFromClinicValue } from "../../lib/clinical-journey"
import { timeAgo } from "../../lib/crm"
import { activeOrgTimeZone } from "../../lib/locale"
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
/** Los topes de la API (`documentMaxBytes`): 10 MB, y 30 MB la radiografía DICOM. */
export const MAX_BYTES = DOCUMENT_MAX_BYTES
export const DICOM_MAX_BYTES = DICOM_DOCUMENT_MAX_BYTES

function isDicomFile(file: File): boolean {
  return file.type === "application/dicom" || /\.dcm$/i.test(file.name)
}

export function isAcceptedFile(file: File): boolean {
  return ACCEPTED_TYPES.includes(file.type) || /\.dcm$/i.test(file.name)
}

/** El tope de un archivo: el de la radiografía DICOM o el de los demás. */
export function maxBytesFor(file: File): number {
  return documentMaxBytes(isDicomFile(file) ? "application/dicom" : file.type)
}

/**
 * Por qué no entra un archivo, con qué hacer. Los formatos que llegan de los
 * sensores, del iPhone o del escáner se nombran; el contenido real lo verifica
 * el servidor.
 */
export function unsupportedFormatMessage(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ""
  if (ext === "tif" || ext === "tiff" || ext === "bmp")
    return `Es ${ext === "bmp" ? "BMP" : "TIFF"}: expórtala en DICOM o en JPG desde el programa del sensor.`
  if (ext === "heic" || ext === "heif")
    return "Es una foto HEIC del iPhone: súbela desde el iPhone, que la convierte a JPG, o elige «Más compatible» en la cámara."
  if (ext === "stl" || ext === "ply" || ext === "obj")
    return "Es un modelo del escáner intraoral: todavía no se guardan en la ficha."
  return "Solo se admiten JPG, PNG, WebP, PDF o DICOM."
}

/** ¿El producto guarda la tomografía y la abre en su visor? (odentIA y latidIA.) */
export function storesTomography(): boolean {
  return productUi().documents.imaging.tomography !== null
}

/**
 * Cómo abre el visor la tomografía del producto: «cbct», la dental (panorámica, arco, piezas);
 * «ct», la médica (cortes y ventanas en unidades Hounsfield).
 */
export function tomographyKind(): "cbct" | "ct" {
  return productUi().documents.imaging.tomography?.kind ?? "cbct"
}

/** El nombre de la tomografía en este producto: «Tomografía (CBCT)» o «Tomografía computarizada». */
export function tomographyTypeLabel(): string {
  const type = productUi().documents.imaging.tomography?.imageType
  return imageTypeLabel(type) ?? "Tomografía"
}

export function categoryLabel(category: string): string {
  return (
    productUi().documents.imaging.categoryLabels[category] ?? CATEGORY_LABELS[category] ?? category
  )
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

/** Fecha que cuenta para la historia: la del documento (la de toma, en una imagen) si se registró, si no la de subida. */
export function takenAt(doc: { capturedAt?: string | null; createdAt: string }): string {
  return doc.capturedAt ?? doc.createdAt
}

/**
 * Instante de la fecha de un archivo para un día elegido en la clínica: hoy, ahora
 * (nunca en el futuro); otro día, su mediodía, que no se corre de fecha en ningún
 * formato y se muestra solo como día. Sin día, `null`: vale la fecha de subida.
 */
export function capturedInstant(day: string): string | null {
  if (!day) return null
  if (day === regionToday()) return new Date().toISOString()
  return instantFromClinicValue(`${day}T12:00`)
}

/** El día (`yyyy-mm-dd`, en la zona de la clínica) de la fecha de un archivo, para su selector. */
export function capturedDay(iso: string | null | undefined): string {
  return iso ? zonedDateOf(iso, activeOrgTimeZone()) : ""
}

/** Cómo se llama la fecha propia de un archivo: la de toma en una imagen, la del documento en lo demás. */
export function documentDateLabel(category: string): string {
  return isImageDocumentCategory(category) ? "Fecha de toma" : "Fecha del documento"
}

/**
 * «Tomada 30/09/2026» (una imagen), «Del 30/09/2026» (un papel) o «Subida 18/10/2026»
 * (sin fecha propia): solo el día, como el resto de los papeles.
 */
export function formatTakenAt(doc: {
  category?: string
  capturedAt?: string | null
  createdAt: string
}): string {
  if (!doc.capturedAt) return `Subida ${formatDate(doc.createdAt)}`
  return `${doc.category && !isImageDocumentCategory(doc.category) ? "Del" : "Tomada"} ${formatDate(doc.capturedAt)}`
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
