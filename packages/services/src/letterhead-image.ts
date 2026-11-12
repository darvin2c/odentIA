/**
 * La hoja membretada que llega como imagen (la carga de la configuración, ADR 0104 y
 * 0182): lo que en la clínica mide el navegador con pdf.js, aquí lo mide el servidor
 * sobre los píxeles de la imagen, con las mismas reglas que `detectMargins` de
 * `clinic-app/src/lib/letterhead.ts`: el diseño de arriba y el de abajo terminan donde
 * aparece un hueco sin tinta de 10 mm, lo claro (una marca de agua) no cuenta y queda
 * debajo del texto, y a los costados cuenta una franja que baja por casi todo el alto.
 * Devuelve las franjas y la miniatura en PNG, como las recorta el navegador.
 */
import { clampLetterheadMargins, type LetterheadMargins, letterheadImagePage, PT_PER_MM } from "@odentia/clinical"
import sharp from "sharp"

const MM_PER_PT = 1 / PT_PER_MM
/** El ancho al que se mide y se recorta: unas 150 ppp en una A4, como en el navegador. */
const RENDER_WIDTH_PX = 1240
const DEFAULT_MARGINS = { topMm: 15, bottomMm: 12, leftMm: 19, rightMm: 19 }
const GAP_MM = 7
const BLANK_RUN_MM = 10
const INK_LUMINANCE = 0.8

export interface MeasuredLetterhead {
  page: { widthPt: number; heightPt: number }
  /** Ya con los límites del servidor (`clampLetterheadMargins`). */
  margins: LetterheadMargins
  topBand: Uint8Array
  bottomBand: Uint8Array
  thumbnail: Uint8Array
}

/** Mide una hoja que es una imagen (PNG o JPG) y recorta sus franjas. */
export async function measureLetterheadImage(bytes: Uint8Array): Promise<MeasuredLetterhead> {
  const meta = await sharp(bytes).metadata()
  if (!meta.width || !meta.height) throw new Error("La hoja no es una imagen que se pueda leer")
  const page = letterheadImagePage(meta.width, meta.height)
  const widthPt = page.width
  const heightPt = page.height
  // Sobre blanco, como se imprime: lo transparente no es tinta.
  const rendered = sharp(bytes).flatten({ background: "#ffffff" }).resize({ width: RENDER_WIDTH_PX })
  const { data, info } = await rendered.clone().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  const margins = clampLetterheadMargins({ widthPt, heightPt }, detect(data, width, height, channels, widthPt, heightPt))
  const pxPerMm = height / (heightPt * MM_PER_PT)
  const topPx = Math.min(height, Math.max(1, Math.round(margins.topMm * pxPerMm)))
  const bottomPx = Math.min(height, Math.max(1, Math.round(margins.bottomMm * pxPerMm)))
  const png = (pipeline: sharp.Sharp) => pipeline.png().toBuffer().then((buffer) => new Uint8Array(buffer))
  const base = await rendered.clone().png().toBuffer()
  const [topBand, bottomBand, thumbnail] = await Promise.all([
    png(sharp(base).extract({ left: 0, top: 0, width, height: topPx })),
    png(sharp(base).extract({ left: 0, top: height - bottomPx, width, height: bottomPx })),
    png(sharp(base).resize({ width: 240 })),
  ])
  return { page: { widthPt, heightPt }, margins, topBand, bottomBand, thumbnail }
}

function detect(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  widthPt: number,
  heightPt: number,
): LetterheadMargins {
  const mmPerPx = (heightPt * MM_PER_PT) / height
  const ink = (x: number, y: number) => {
    const i = (y * width + x) * channels
    return (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255 < INK_LUMINANCE
  }
  const rowHasInk = (y: number) => {
    let count = 0
    for (let x = 0; x < width; x += 2) if (ink(x, y) && ++count > 2) return true
    return false
  }
  const blankRun = Math.round(BLANK_RUN_MM / mmPerPx)
  const designEdge = (rows: number[]): number | null => {
    let last: number | null = null
    let blank = 0
    for (const y of rows) {
      if (rowHasInk(y)) {
        last = y
        blank = 0
      } else if (last !== null && ++blank >= blankRun) break
    }
    return last
  }
  const topInk = designEdge(Array.from({ length: Math.floor(height * 0.45) }, (_, y) => y))
  const bottomInk = designEdge(Array.from({ length: Math.floor(height * 0.4) }, (_, i) => height - 1 - i))
  const topMm = topInk === null ? DEFAULT_MARGINS.topMm : (topInk + 1) * mmPerPx + GAP_MM
  const bottomMm = bottomInk === null ? DEFAULT_MARGINS.bottomMm : (height - bottomInk) * mmPerPx + GAP_MM
  const fromY = Math.min(height - 1, Math.round(topMm / mmPerPx))
  const toY = Math.max(fromY + 1, height - Math.round(bottomMm / mmPerPx))
  const columnBand = (x: number) => {
    let count = 0
    let seen = 0
    for (let y = fromY; y < toY; y += 4) {
      seen++
      if (ink(x, y)) count++
    }
    return seen > 0 && count / seen > 0.6
  }
  const sideEdge = (columns: number[]): number | null => {
    let last: number | null = null
    for (const x of columns) if (columnBand(x)) last = x
    return last
  }
  const mmPerPxX = (widthPt * MM_PER_PT) / width
  const leftInk = sideEdge(Array.from({ length: Math.floor(width * 0.3) }, (_, x) => x))
  const rightInk = sideEdge(Array.from({ length: Math.floor(width * 0.3) }, (_, i) => width - 1 - i))
  const leftMm = Math.max(DEFAULT_MARGINS.leftMm, leftInk === null ? 0 : (leftInk + 1) * mmPerPxX + GAP_MM)
  const rightMm = Math.max(DEFAULT_MARGINS.rightMm, rightInk === null ? 0 : (width - rightInk) * mmPerPxX + GAP_MM)
  const half = (value: number) => Math.round(value * 2) / 2
  return { topMm: half(topMm), bottomMm: half(bottomMm), leftMm: half(leftMm), rightMm: half(rightMm) }
}
