import { invalidField } from "./errors.js"

/** Contenido real admitido en adjuntos: imágenes fijas y PDF, nada ejecutable ni texto con marcado. */
export type SniffedFileKind = "jpeg" | "png" | "webp" | "pdf"

export interface SniffedFile {
  kind: SniffedFileKind
  mimeType: string
  ext: string
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  return prefix.every((byte, index) => bytes[index] === byte)
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
}

const SIGNATURES: {
  kind: SniffedFileKind
  mimeType: string
  ext: string
  match: (bytes: Uint8Array) => boolean
}[] = [
  {
    kind: "jpeg",
    mimeType: "image/jpeg",
    ext: "jpg",
    match: (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  },
  {
    kind: "png",
    mimeType: "image/png",
    ext: "png",
    match: (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { kind: "webp", mimeType: "image/webp", ext: "webp", match: isWebp },
  {
    kind: "pdf",
    mimeType: "application/pdf",
    ext: "pdf",
    match: (bytes) => startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
]

/**
 * Comprueba los bytes reales del archivo contra su MIME declarado. SVG, HTML
 * y cualquier texto con marcado no coinciden con ninguna firma y se rechazan:
 * nunca entran como «imagen». Lo usa soporte y lo reutiliza facturación para
 * comprobantes: un solo dueño, sin duplicar.
 */
export function sniffFileContent(bytes: Uint8Array, claimedMime: string): SniffedFile {
  const found = SIGNATURES.find((signature) => signature.match(bytes))
  if (!found || found.mimeType !== claimedMime) {
    // `file`: el nombre del campo multipart en todas las rutas que suben adjuntos.
    throw invalidField("file", "El archivo no es válido: se admite JPG, PNG, WebP o PDF reales")
  }
  return { kind: found.kind, mimeType: found.mimeType, ext: found.ext }
}
