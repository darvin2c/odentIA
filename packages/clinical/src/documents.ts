/**
 * Imágenes y archivos clínicos: tipos de imagen diagnóstica, estado del
 * informe y detección del formato por contenido.
 *
 * Los subtipos siguen la nomenclatura radiológica odontológica habitual
 * (intraorales: periapical, interproximal o bitewing, oclusal; extraorales:
 * panorámica, cefalométrica; tomografía de haz cónico) y la fotografía clínica
 * intra y extraoral. La tomografía se guarda como archivo externo (DICOM o
 * exportación del equipo); no hay visor volumétrico.
 */

export const RADIOGRAPH_TYPES = [
  "periapical",
  "bitewing",
  "oclusal",
  "panoramica",
  "cefalometrica",
  "tomografia",
] as const
export const PHOTO_TYPES = ["foto_intraoral", "foto_extraoral"] as const
export const IMAGE_TYPES = [...RADIOGRAPH_TYPES, ...PHOTO_TYPES] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

export const IMAGE_TYPE_LABELS: Record<ImageType, string> = {
  periapical: "Radiografía periapical",
  bitewing: "Radiografía interproximal (bitewing)",
  oclusal: "Radiografía oclusal",
  panoramica: "Radiografía panorámica",
  cefalometrica: "Radiografía cefalométrica",
  tomografia: "Tomografía (CBCT)",
  foto_intraoral: "Foto intraoral",
  foto_extraoral: "Foto extraoral",
}

/** Categoría documental a la que pertenece cada tipo de imagen. */
export function imageTypeCategory(type: ImageType): "radiografia" | "foto_clinica" {
  return (RADIOGRAPH_TYPES as readonly string[]).includes(type) ? "radiografia" : "foto_clinica"
}

/**
 * Un tipo de imagen que se elige al subirla, con la categoría documental a la
 * que pertenece. Cada producto da los suyos (issue 229): odentIA, los de la
 * boca; latidIA, los de la medicina general.
 */
export interface ImagingType {
  value: string
  label: string
  category: "radiografia" | "foto_clinica"
}

/** Los de odentIA: radiografías dentales, tomografía de haz cónico y fotos intra y extraorales. */
export const DENTAL_IMAGING_TYPES: readonly ImagingType[] = IMAGE_TYPES.map((value) => ({
  value,
  label: IMAGE_TYPE_LABELS[value],
  category: imageTypeCategory(value),
}))

export function isImageType(value: unknown): value is ImageType {
  return typeof value === "string" && (IMAGE_TYPES as readonly string[]).includes(value)
}

/** Informe de la imagen: las radiografías se informan; la foto no lo requiere. */
export const REPORT_STATUSES = ["pendiente", "informado", "no_requiere"] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]
export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  pendiente: "Sin informar",
  informado: "Informada",
  no_requiere: "No requiere informe",
}

/** Formatos admitidos con su extensión de almacenamiento. */
export const DOCUMENT_FORMATS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/dicom": "dcm",
} as const
export type DocumentMime = keyof typeof DOCUMENT_FORMATS

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  return signature.every((b, i) => bytes[offset + i] === b)
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

/**
 * Formato real del archivo según sus primeros bytes (firmas de JPEG, PNG,
 * WebP/RIFF, PDF y el preámbulo DICOM «DICM» en el byte 128, PS3.10 §7.1).
 * Devuelve null si no es un formato admitido: la extensión o el tipo que
 * declara el navegador no bastan.
 */
export function sniffDocumentMime(bytes: Uint8Array): DocumentMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp"
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf"
  if (startsWith(bytes, ascii("DICM"), 128)) return "application/dicom"
  return null
}
