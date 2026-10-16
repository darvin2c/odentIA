/**
 * Escritura simple de PDF para los papeles clínicos (consentimiento, receta y
 * orden): texto con saltos de línea y de página, títulos, listas y recuadros de
 * firma. Módulo interno: no se reexporta desde el índice del paquete.
 */
import { type PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib"

export type Strokes = number[][][]

export const A4: [number, number] = [595.28, 841.89]
export const MARGIN = 50
export const INK = rgb(0.07, 0.09, 0.15)
export const MUTED = rgb(0.4, 0.42, 0.47)

/**
 * Las fuentes estándar de PDF codifican WinAnsi (Latin-1): cubre el español.
 * Lo que no cabe (emojis, otros alfabetos) se sustituye para no fallar.
 */
export function safe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\u0009\u000A -~ -ÿ•]/g, "?")
}

export class Writer {
  page: PDFPage
  y: number
  constructor(
    private readonly pdf: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = pdf.addPage(A4)
    this.y = A4[1] - MARGIN
  }
  private ensure(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.pdf.addPage(A4)
      this.y = A4[1] - MARGIN
    }
  }
  text(
    value: string,
    opts: { size?: number; bold?: boolean; color?: typeof INK; indent?: number } = {},
  ) {
    const size = opts.size ?? 10
    const font = opts.bold ? this.bold : this.regular
    const width = A4[0] - MARGIN * 2 - (opts.indent ?? 0)
    for (const paragraph of safe(value).split("\n")) {
      const words = paragraph.split(/\s+/).filter(Boolean)
      let line = ""
      const flush = () => {
        this.ensure(size + 4)
        this.page.drawText(line, {
          x: MARGIN + (opts.indent ?? 0),
          y: this.y - size,
          size,
          font,
          color: opts.color ?? INK,
        })
        this.y -= size + 4
        line = ""
      }
      for (const word of words) {
        const next = line ? `${line} ${word}` : word
        if (font.widthOfTextAtSize(next, size) > width && line) {
          flush()
          line = word
        } else line = next
      }
      if (line) flush()
      if (words.length === 0) this.y -= size / 2
    }
  }
  gap(height = 8) {
    this.y -= height
  }
  heading(value: string) {
    this.gap(6)
    this.text(value, { size: 11, bold: true })
  }
  list(items: string[]) {
    for (const item of items) this.text(`• ${item}`, { indent: 10 })
  }
  /** Firma manuscrita (trazos 0–1000) en un recuadro de 220×70. */
  signature(label: string, strokes: Strokes | null, caption: string) {
    const w = 220
    const h = 70
    this.ensure(h + 40)
    this.text(label, { size: 9, bold: true })
    const top = this.y
    this.page.drawRectangle({
      x: MARGIN,
      y: top - h,
      width: w,
      height: h,
      borderColor: MUTED,
      borderWidth: 0.5,
    })
    for (const stroke of strokes ?? []) {
      for (let i = 1; i < stroke.length; i++) {
        const [x1, y1] = stroke[i - 1] as [number, number]
        const [x2, y2] = stroke[i] as [number, number]
        this.page.drawLine({
          start: { x: MARGIN + (x1 / 1000) * w, y: top - (y1 / 1000) * h },
          end: { x: MARGIN + (x2 / 1000) * w, y: top - (y2 / 1000) * h },
          thickness: 1,
          color: INK,
        })
      }
    }
    this.y = top - h - 4
    this.text(caption, { size: 8, color: MUTED })
  }
}

export function strokesOf(value: unknown): Strokes | null {
  if (value && typeof value === "object" && "strokes" in value && Array.isArray(value.strokes))
    return value.strokes as Strokes
  return null
}

/** Formato y zona del establecimiento; sin perfil, valores neutros (nunca un país). */
export type Zone = { locale: string; timezone: string }

export function when(value: Date | string | null | undefined, zone: Zone): string {
  if (!value) return "-"
  return new Date(value).toLocaleString(zone.locale, {
    timeZone: zone.timezone,
    dateStyle: "long",
    timeStyle: "short",
  })
}
