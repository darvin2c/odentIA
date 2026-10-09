import * as dicomParser from "dicom-parser"

/**
 * Lectura de imágenes DICOM 2D para el visor básico (PS3.5/PS3.3): sintaxis
 * nativas Little Endian (implícita y explícita) y JPEG Baseline (8 bits),
 * monocromas (MONOCHROME1/2) o RGB. Aplica la transformación de modalidad
 * (Rescale Slope/Intercept) y lee la ventana sugerida y el espaciado de píxel
 * (Pixel Spacing o, en intraorales, Imager Pixel Spacing) para medir en mm.
 * Otras compresiones (JPEG-LS, JPEG 2000, RLE) se informan como no soportadas.
 */

const NATIVE = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"])
const JPEG_BASELINE = new Set(["1.2.840.10008.1.2.4.50", "1.2.840.10008.1.2.4.51"])
const SYNTAX_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
  "1.2.840.10008.1.2.4.57": "JPEG sin pérdida",
  "1.2.840.10008.1.2.4.70": "JPEG sin pérdida",
  "1.2.840.10008.1.2.4.80": "JPEG-LS",
  "1.2.840.10008.1.2.4.81": "JPEG-LS",
  "1.2.840.10008.1.2.4.90": "JPEG 2000",
  "1.2.840.10008.1.2.4.91": "JPEG 2000",
  "1.2.840.10008.1.2.5": "RLE",
}

export interface DicomImage {
  width: number
  height: number
  /** Valores de modalidad (tras slope/intercept) de un canal; null si es RGB. */
  values: Float32Array | null
  /** Píxeles RGBA listos para pintar cuando la imagen es en color. */
  rgba: Uint8ClampedArray | null
  monochrome1: boolean
  window: { center: number; width: number }
  range: { min: number; max: number }
  /** mm por píxel (fila, columna); null si el archivo no lo declara. */
  pixelSpacing: [number, number] | null
  frames: number
  meta: {
    modality: string | null
    studyDate: string | null
    manufacturer: string | null
    bodyPart: string | null
    transferSyntax: string
  }
}

export class DicomUnsupportedError extends Error {}

function str(ds: dicomParser.DataSet, tag: string): string | null {
  const value = ds.string(tag)?.trim()
  return value ? value : null
}

function spacing(ds: dicomParser.DataSet): [number, number] | null {
  for (const tag of ["x00280030", "x00181164"]) {
    const row = ds.floatString(tag, 0)
    const col = ds.floatString(tag, 1)
    if (row && col && row > 0 && col > 0) return [row, col]
  }
  return null
}

async function decodeJpegFrame(bytes: Uint8Array): Promise<ImageData> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }))
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Sin contexto 2D")
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
}

export async function decodeDicom(buffer: ArrayBuffer): Promise<DicomImage> {
  const ds = dicomParser.parseDicom(new Uint8Array(buffer))
  const syntax = str(ds, "x00020010") ?? "1.2.840.10008.1.2"
  const rows = ds.uint16("x00280010") ?? 0
  const cols = ds.uint16("x00280011") ?? 0
  if (!rows || !cols) throw new DicomUnsupportedError("El archivo DICOM no contiene una imagen")
  const samples = ds.uint16("x00280002") ?? 1
  const photometric = str(ds, "x00280004") ?? "MONOCHROME2"
  const bitsAllocated = ds.uint16("x00280100") ?? 16
  const signed = (ds.uint16("x00280103") ?? 0) === 1
  const slope = ds.floatString("x00281053") ?? 1
  const intercept = ds.floatString("x00281052") ?? 0
  const frames = ds.intString("x00280008") ?? 1
  const pixel = ds.elements.x7fe00010
  if (!pixel) throw new DicomUnsupportedError("El archivo DICOM no tiene datos de píxel")
  const meta = {
    modality: str(ds, "x00080060"),
    studyDate: str(ds, "x00080020"),
    manufacturer: str(ds, "x00080070"),
    bodyPart: str(ds, "x00180015"),
    transferSyntax: syntax,
  }
  const base = {
    width: cols,
    height: rows,
    monochrome1: photometric === "MONOCHROME1",
    pixelSpacing: spacing(ds),
    frames,
    meta,
  }

  let values: Float32Array | null = null
  let rgba: Uint8ClampedArray | null = null
  const count = rows * cols
  if (NATIVE.has(syntax)) {
    const bytes = ds.byteArray
    if (samples === 3) {
      // RGB entrelazado (Planar Configuration 0) o por planos (1), 8 bits.
      const planar = (ds.uint16("x00280006") ?? 0) === 1
      rgba = new Uint8ClampedArray(count * 4)
      for (let i = 0; i < count; i++) {
        const at = (c: number) =>
          bytes[pixel.dataOffset + (planar ? c * count + i : i * 3 + c)] ?? 0
        rgba[i * 4] = at(0)
        rgba[i * 4 + 1] = at(1)
        rgba[i * 4 + 2] = at(2)
        rgba[i * 4 + 3] = 255
      }
    } else {
      values = new Float32Array(count)
      const view = new DataView(bytes.buffer, bytes.byteOffset + pixel.dataOffset)
      for (let i = 0; i < count; i++) {
        const raw =
          bitsAllocated === 8
            ? signed
              ? view.getInt8(i)
              : view.getUint8(i)
            : signed
              ? view.getInt16(i * 2, true)
              : view.getUint16(i * 2, true)
        values[i] = raw * slope + intercept
      }
    }
  } else if (JPEG_BASELINE.has(syntax)) {
    const frame = dicomParser.readEncapsulatedImageFrame(
      ds,
      pixel,
      0,
      dicomParser.createJPEGBasicOffsetTable(ds, pixel),
    )
    const image = await decodeJpegFrame(new Uint8Array(frame))
    if (samples === 3) rgba = image.data
    else {
      values = new Float32Array(count)
      for (let i = 0; i < count; i++) values[i] = (image.data[i * 4] ?? 0) * slope + intercept
    }
  } else {
    throw new DicomUnsupportedError(
      `Compresión ${SYNTAX_NAMES[syntax] ?? syntax} no soportada en el visor: descarga el archivo para abrirlo en el software del equipo.`,
    )
  }

  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  if (values) {
    for (const v of values) {
      if (v < min) min = v
      if (v > max) max = v
    }
  } else {
    min = 0
    max = 255
  }
  const center = ds.floatString("x00281050", 0)
  const width = ds.floatString("x00281051", 0)
  const window =
    center !== undefined && width !== undefined && width > 0
      ? { center, width }
      : { center: (min + max) / 2, width: Math.max(1, max - min) }
  return { ...base, values, rgba, window, range: { min, max } }
}

/**
 * Píxeles RGBA de la imagen con la ventana (nivel/ancho) aplicada, según la
 * función lineal de PS3.3 C.11.2.1.2; MONOCHROME1 se muestra invertida.
 */
export function renderDicom(
  image: DicomImage,
  options: { center: number; width: number; invert: boolean },
): Uint8ClampedArray {
  if (image.rgba) {
    if (!options.invert) return image.rgba
    const out = new Uint8ClampedArray(image.rgba)
    for (let i = 0; i < out.length; i += 4) {
      out[i] = 255 - (out[i] ?? 0)
      out[i + 1] = 255 - (out[i + 1] ?? 0)
      out[i + 2] = 255 - (out[i + 2] ?? 0)
    }
    return out
  }
  const values = image.values!
  const out = new Uint8ClampedArray(values.length * 4)
  const c = options.center - 0.5
  const w = Math.max(1, options.width - 1)
  const invert = options.invert !== image.monochrome1
  for (let i = 0; i < values.length; i++) {
    const v = values[i] ?? 0
    let g = ((v - c) / w + 0.5) * 255
    if (g < 0) g = 0
    else if (g > 255) g = 255
    if (invert) g = 255 - g
    out[i * 4] = g
    out[i * 4 + 1] = g
    out[i * 4 + 2] = g
    out[i * 4 + 3] = 255
  }
  return out
}

/** Distancia entre dos puntos (en píxeles de imagen) en mm, o null sin calibración. */
export function distanceMm(
  image: Pick<DicomImage, "pixelSpacing">,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number | null {
  if (!image.pixelSpacing) return null
  const [rowMm, colMm] = image.pixelSpacing
  return Math.hypot((b.x - a.x) * colMm, (b.y - a.y) * rowMm)
}
