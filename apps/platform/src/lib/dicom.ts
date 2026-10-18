import * as dicomParser from "dicom-parser"
import {
  type DecodedFrame,
  decodeJpeg2000,
  decodeJpegBaseline,
  decodeJpegExtended12,
  decodeJpegLossless,
  decodeJpegLs,
} from "./dicom-codecs"
import { decodeRleFrame } from "./dicom-rle"

/**
 * Lectura de imágenes DICOM 2D para el visor (PS3.5/PS3.3): sintaxis nativas
 * (Little Endian implícita y explícita, Big Endian explícita), RLE, JPEG
 * (baseline de 8 bits, extendido de 12 bits y sin pérdida), JPEG-LS y JPEG
 * 2000, monocromas (MONOCHROME1/2) o en color (RGB, YBR_FULL), con uno o
 * varios cuadros. Aplica la transformación de modalidad (Rescale
 * Slope/Intercept) y lee la ventana sugerida y el espaciado de píxel (Pixel
 * Spacing o, en intraorales, Imager Pixel Spacing) para medir en mm.
 *
 * Lo que no se puede leer bien se informa con `DicomUnsupportedError`: el
 * visor nunca pinta una imagen mal decodificada.
 */

const LITTLE_ENDIAN = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"])
const BIG_ENDIAN = "1.2.840.10008.1.2.2"
const RLE = "1.2.840.10008.1.2.5"
type Codec = (bytes: Uint8Array) => Promise<DecodedFrame>
/** Sintaxis encapsuladas que se decodifican y su códec (PS3.5 §A.4). */
const CODECS: Record<string, Codec> = {
  "1.2.840.10008.1.2.4.50": decodeJpegBaseline,
  "1.2.840.10008.1.2.4.51": decodeJpegExtended12,
  "1.2.840.10008.1.2.4.57": decodeJpegLossless,
  "1.2.840.10008.1.2.4.70": decodeJpegLossless,
  "1.2.840.10008.1.2.4.80": decodeJpegLs,
  "1.2.840.10008.1.2.4.81": decodeJpegLs,
  "1.2.840.10008.1.2.4.90": decodeJpeg2000,
  "1.2.840.10008.1.2.4.91": decodeJpeg2000,
}
/** Las que JPEG y JPEG 2000 entregan ya en RGB, aunque el archivo diga YBR. */
const DECODER_GIVES_RGB = new Set([
  "1.2.840.10008.1.2.4.50",
  "1.2.840.10008.1.2.4.51",
  "1.2.840.10008.1.2.4.90",
  "1.2.840.10008.1.2.4.91",
])
const UNSUPPORTED_NAMES: Record<string, string> = {
  "1.2.840.10008.1.2.1.99": "Deflate",
  "1.2.840.10008.1.2.4.201": "JPEG 2000 de alto rendimiento (HTJ2K)",
  "1.2.840.10008.1.2.4.202": "JPEG 2000 de alto rendimiento (HTJ2K)",
  "1.2.840.10008.1.2.4.203": "JPEG 2000 de alto rendimiento (HTJ2K)",
  "1.2.840.10008.1.2.4.100": "video MPEG-2",
  "1.2.840.10008.1.2.4.101": "video MPEG-2",
  "1.2.840.10008.1.2.4.102": "video MPEG-4",
  "1.2.840.10008.1.2.4.103": "video MPEG-4",
  "1.2.840.10008.1.2.4.104": "video MPEG-4",
  "1.2.840.10008.1.2.4.105": "video MPEG-4",
  "1.2.840.10008.1.2.4.106": "video MPEG-4",
  "1.2.840.10008.1.2.4.107": "video HEVC",
  "1.2.840.10008.1.2.4.108": "video HEVC",
}
const DOWNLOAD_HINT = "descarga el archivo para abrirlo en el software del equipo."

export interface DicomImage {
  width: number
  height: number
  /** Valores de modalidad (tras slope/intercept) de un canal; null si es en color. */
  values: Float32Array | null
  /** Píxeles RGBA listos para pintar cuando la imagen es en color. */
  rgba: Uint8ClampedArray | null
  monochrome1: boolean
  window: { center: number; width: number }
  range: { min: number; max: number }
  /** mm por píxel (fila, columna); null si el archivo no lo declara. */
  pixelSpacing: [number, number] | null
  frames: number
  /** Cuadro mostrado, desde 0. */
  frame: number
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

function unsupported(what: string): DicomUnsupportedError {
  return new DicomUnsupportedError(`${what} no soportado en el visor: ${DOWNLOAD_HINT}`)
}

interface PixelFormat {
  rows: number
  cols: number
  samples: number
  bitsAllocated: number
  bitsStored: number
  signed: boolean
  planar: boolean
}

/** Bytes del cuadro encapsulado (PS3.5 §A.4), con o sin tabla de desplazamientos. */
function encapsulatedFrame(ds: dicomParser.DataSet, pixel: dicomParser.Element, frame: number, frames: number) {
  const fragments = pixel.fragments ?? []
  if (pixel.basicOffsetTable?.length) return dicomParser.readEncapsulatedImageFrame(ds, pixel, frame)
  if (frames === 1) return dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixel, 0, fragments.length)
  if (fragments.length === frames) return dicomParser.readEncapsulatedPixelDataFromFragments(ds, pixel, frame, 1)
  const syntax = str(ds, "x00020010") ?? ""
  if (syntax.startsWith("1.2.840.10008.1.2.4.5") || syntax.startsWith("1.2.840.10008.1.2.4.7")) {
    // JPEG sin tabla: los cuadros se separan buscando sus marcadores.
    const table = dicomParser.createJPEGBasicOffsetTable(ds, pixel)
    return dicomParser.readEncapsulatedImageFrame(ds, pixel, frame, table)
  }
  throw new DicomUnsupportedError(
    `No se pudieron separar los cuadros del archivo: ${DOWNLOAD_HINT}`,
  )
}

/**
 * Muestras crudas del cuadro como enteros sin escalar: los bits fuera de Bits
 * Stored se descartan y, si el valor es con signo, se extiende el signo
 * (PS3.5 §8.1.1).
 */
function storedValues(raw: ArrayLike<number>, format: PixelFormat): Int32Array {
  const out = new Int32Array(raw.length)
  const bits = format.bitsStored
  const mask = bits >= 32 ? -1 : (1 << bits) - 1
  const shift = 32 - bits
  for (let i = 0; i < raw.length; i++) {
    const v = (raw[i] ?? 0) & mask
    out[i] = format.signed ? (v << shift) >> shift : v
  }
  return out
}

/** Muestras nativas del cuadro, en su orden de bytes. */
function nativeSamples(ds: dicomParser.DataSet, pixel: dicomParser.Element, format: PixelFormat, frame: number, littleEndian: boolean) {
  const count = format.rows * format.cols * format.samples
  const bytesPerSample = format.bitsAllocated / 8
  const start = pixel.dataOffset + frame * count * bytesPerSample
  if (start + count * bytesPerSample > pixel.dataOffset + pixel.length) {
    throw new DicomUnsupportedError(`El archivo está incompleto: faltan píxeles del cuadro. ${DOWNLOAD_HINT}`)
  }
  const view = new DataView(ds.byteArray.buffer, ds.byteArray.byteOffset + start, count * bytesPerSample)
  const raw = new Uint16Array(count)
  for (let i = 0; i < count; i++) raw[i] = bytesPerSample === 1 ? view.getUint8(i) : view.getUint16(i * 2, littleEndian)
  return raw
}

/** Convierte YBR_FULL a RGB (PS3.3 C.7.6.3.1.2). */
function ybrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  return [
    y + 1.402 * (cr - 128),
    y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128),
    y + 1.772 * (cb - 128),
  ]
}

/** Un archivo DICOM ya leído: sus cuadros se decodifican cuando se piden. */
export interface DicomFile {
  dataset: dicomParser.DataSet
  frames: number
  decode(frame: number): Promise<DicomImage>
}

/** Lee la cabecera una sola vez; útil para recorrer muchos cuadros del mismo archivo. */
export function openDicom(buffer: ArrayBuffer): DicomFile {
  const ds = dicomParser.parseDicom(new Uint8Array(buffer))
  return {
    dataset: ds,
    frames: Math.max(1, ds.intString("x00280008") ?? 1),
    decode: (frame) => decodeFrame(ds, frame),
  }
}

export async function decodeDicom(buffer: ArrayBuffer, frame = 0): Promise<DicomImage> {
  return openDicom(buffer).decode(frame)
}

async function decodeFrame(ds: dicomParser.DataSet, frame: number): Promise<DicomImage> {
  const syntax = str(ds, "x00020010") ?? "1.2.840.10008.1.2"
  const rows = ds.uint16("x00280010") ?? 0
  const cols = ds.uint16("x00280011") ?? 0
  if (!rows || !cols) throw new DicomUnsupportedError("El archivo DICOM no contiene una imagen")
  const samples = ds.uint16("x00280002") ?? 1
  const photometric = str(ds, "x00280004") ?? "MONOCHROME2"
  const bitsAllocated = ds.uint16("x00280100") ?? 16
  const format: PixelFormat = {
    rows,
    cols,
    samples,
    bitsAllocated,
    bitsStored: ds.uint16("x00280101") ?? bitsAllocated,
    signed: (ds.uint16("x00280103") ?? 0) === 1,
    planar: (ds.uint16("x00280006") ?? 0) === 1,
  }
  const slope = ds.floatString("x00281053") ?? 1
  const intercept = ds.floatString("x00281052") ?? 0
  const frames = Math.max(1, ds.intString("x00280008") ?? 1)
  if (!Number.isInteger(frame) || frame < 0 || frame >= frames) {
    throw new DicomUnsupportedError(`El archivo no tiene el cuadro ${frame + 1}`)
  }
  const pixel = ds.elements.x7fe00010
  if (!pixel) throw new DicomUnsupportedError("El archivo DICOM no tiene datos de píxel")
  const monochrome = photometric === "MONOCHROME1" || photometric === "MONOCHROME2"
  const color = samples === 3 && (photometric === "RGB" || photometric.startsWith("YBR_"))
  if (!(monochrome && samples === 1) && !color) throw unsupported(`El color ${photometric}`)
  if (bitsAllocated !== 8 && bitsAllocated !== 16) throw unsupported(`Una imagen de ${bitsAllocated} bits`)
  if (color && bitsAllocated !== 8) throw unsupported("El color de más de 8 bits")
  const meta = {
    modality: str(ds, "x00080060"),
    studyDate: str(ds, "x00080020"),
    manufacturer: str(ds, "x00080070"),
    bodyPart: str(ds, "x00180015"),
    transferSyntax: syntax,
  }

  // Muestras del cuadro, entrelazadas (RGBRGB… en color) y en el espacio de color del archivo.
  let raw: ArrayLike<number>
  let rgbFromDecoder = false
  if (LITTLE_ENDIAN.has(syntax) || syntax === BIG_ENDIAN) {
    raw = nativeSamples(ds, pixel, format, frame, syntax !== BIG_ENDIAN)
  } else if (syntax === RLE) {
    const bytes = encapsulatedFrame(ds, pixel, frame, frames)
    try {
      raw = decodeRleFrame(new Uint8Array(bytes), format)
    } catch {
      throw new DicomUnsupportedError(`No se pudo descomprimir la imagen RLE: ${DOWNLOAD_HINT}`)
    }
  } else {
    const codec = CODECS[syntax]
    if (!codec) throw unsupported(`La compresión ${UNSUPPORTED_NAMES[syntax] ?? syntax}`)
    if (color && !DECODER_GIVES_RGB.has(syntax) && photometric !== "RGB" && photometric !== "YBR_FULL") {
      throw unsupported(`El color ${photometric}`)
    }
    let decoded: DecodedFrame
    try {
      decoded = await codec(new Uint8Array(encapsulatedFrame(ds, pixel, frame, frames)))
    } catch (error) {
      if (error instanceof DicomUnsupportedError) throw error
      throw new DicomUnsupportedError(`No se pudo descomprimir la imagen: ${DOWNLOAD_HINT}`)
    }
    // Lo que entrega el códec debe coincidir con lo que declara el archivo.
    if (decoded.width !== cols || decoded.height !== rows || decoded.components !== samples) {
      throw new DicomUnsupportedError(`La imagen comprimida no coincide con lo que declara el archivo: ${DOWNLOAD_HINT}`)
    }
    raw = decoded.samples
    rgbFromDecoder = color && DECODER_GIVES_RGB.has(syntax)
  }

  const count = rows * cols
  let values: Float32Array | null = null
  let rgba: Uint8ClampedArray | null = null
  if (color) {
    // Las nativas pueden venir por planos (Planar Configuration 1); RLE y los códecs, entrelazadas.
    const planar = format.planar && (LITTLE_ENDIAN.has(syntax) || syntax === BIG_ENDIAN)
    const ybr = !rgbFromDecoder && photometric === "YBR_FULL"
    if (!rgbFromDecoder && photometric !== "RGB" && !ybr) throw unsupported(`El color ${photometric}`)
    rgba = new Uint8ClampedArray(count * 4)
    for (let i = 0; i < count; i++) {
      const at = (c: number) => raw[planar ? c * count + i : i * 3 + c] ?? 0
      const [r, g, b] = ybr ? ybrToRgb(at(0), at(1), at(2)) : [at(0), at(1), at(2)]
      rgba[i * 4] = r
      rgba[i * 4 + 1] = g
      rgba[i * 4 + 2] = b
      rgba[i * 4 + 3] = 255
    }
  } else {
    const stored = storedValues(raw, format)
    values = new Float32Array(count)
    for (let i = 0; i < count; i++) values[i] = (stored[i] ?? 0) * slope + intercept
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
  return {
    width: cols,
    height: rows,
    values,
    rgba,
    monochrome1: photometric === "MONOCHROME1",
    window,
    range: { min, max },
    pixelSpacing: spacing(ds),
    frames,
    frame,
    meta,
  }
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
