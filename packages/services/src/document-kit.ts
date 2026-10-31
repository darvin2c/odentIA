/**
 * El kit único de los papeles del paciente (ADR 0115): receta, orden, descanso,
 * consentimiento, presupuesto, ticket, devolución, historia y registro de
 * actividades salen de aquí, con el mismo membrete, pie, tablas y firma.
 *
 * - El papel es de la clínica: tinta casi negra, gris y reglas finas, sin el
 *   color de odentIA. El color queda solo para ANULADO y REVOCADO.
 * - Noto Sans y Noto Serif embebidas (OFL en `src/assets/fonts/`): sin red al
 *   imprimir y con nombres reales sin transliterar.
 * - Lo que la fuente no cubre (un emoji, otro alfabeto) sale como `?`: el sistema
 *   nunca traba el trabajo por un carácter.
 * - Hoja A4 o Carta, con salto de página y encabezado corto; térmica de 58 u 80 mm,
 *   un rollo recortado al contenido.
 * - Medidas en puntos: los diseños están en píxeles de una hoja de 794 de ancho,
 *   así que 1 px son 0,75 pt. Nada menor que 9 pt (12 px).
 *
 * Módulo interno: no se reexporta desde el índice del paquete.
 */

import { readFileSync } from "node:fs"
import fontkit, { type Font } from "@pdf-lib/fontkit"
import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, type RGB, rgb } from "pdf-lib"
import QRCode from "qrcode"

// --- La clínica en el papel ----------------------------------------------------

export interface DocumentLogo {
  bytes: Uint8Array
  kind: "png" | "jpg"
}

/** Lo que el papel dice de la clínica; lo arma `document-clinic.ts`. */
export interface DocumentClinic {
  tradeName: string
  legalName: string | null
  fiscalDocType: string | null
  fiscalDocNumber: string | null
  address: string | null
  phone: string | null
  branchName: string | null
  logo: DocumentLogo | null
  locale: string
  timezone: string
  sheetSize: string
  receiptWidth: string
}

// --- Formatos ------------------------------------------------------------------

export interface DocFormat {
  width: number
  height: number
  /** Margen a los lados. */
  margin: number
  /** Papel térmico: un rollo recortado al contenido, sin páginas ni pie. */
  exactFit: boolean
}

const MM = 72 / 25.4

export function sheetFormat(paper: string): DocFormat {
  const sheet = paper.trim().toLowerCase()
  if (sheet === "carta" || sheet === "letter")
    return { width: 612, height: 792, margin: 54, exactFit: false }
  // A4 si no se dice otra cosa: el papel nunca traba una impresión.
  return { width: 595.28, height: 841.89, margin: 54, exactFit: false }
}

/** Un rollo largo: al terminar se recorta a lo escrito. */
export function thermalFormat(width: string): DocFormat {
  const millimeters = width.trim() === "58" ? 58 : 80
  return {
    width: millimeters * MM,
    height: 14_000,
    margin: millimeters === 58 ? 8 : 12,
    exactFit: true,
  }
}

/** Ticket y devolución: la térmica de la clínica, u hoja si se pide. */
export function ticketFormat(
  clinic: Pick<DocumentClinic, "receiptWidth">,
  paper?: string | null,
): DocFormat {
  return paper ? sheetFormat(paper) : thermalFormat(clinic.receiptWidth)
}

/** Lo demás: la hoja de la clínica, u otra si se pide. */
export function documentFormat(
  clinic: Pick<DocumentClinic, "sheetSize">,
  paper?: string | null,
): DocFormat {
  return sheetFormat(paper ?? clinic.sheetSize)
}

// --- Letra ---------------------------------------------------------------------

export type Face = "sans" | "sansMedium" | "sansSemi" | "sansBold" | "serif" | "serifMedium"

const FONT_FILES: Record<Face, string> = {
  sans: "NotoSans-Regular.ttf",
  sansMedium: "NotoSans-Medium.ttf",
  sansSemi: "NotoSans-SemiBold.ttf",
  sansBold: "NotoSans-Bold.ttf",
  serif: "NotoSerif-SemiBold.ttf",
  serifMedium: "NotoSerif-Medium.ttf",
}

const FACES = Object.keys(FONT_FILES) as Face[]

/** Tamaños del papel: los del sistema de diseño (px × 0,75). */
export const SIZE = {
  title: 24,
  titleBudget: 22.5,
  total: 19.5,
  h2: 18,
  h2small: 15,
  read: 12,
  table: 11.25,
  dense: 10.5,
  second: 9.75,
  label: 9,
} as const

const FONT_DATA = new Map<Face, { bytes: Uint8Array; font: Font }>()

function fontData(face: Face): { bytes: Uint8Array; font: Font } {
  let data = FONT_DATA.get(face)
  if (!data) {
    const bytes = readFileSync(new URL(`./assets/fonts/${FONT_FILES[face]}`, import.meta.url))
    data = { bytes, font: fontkit.create(bytes) }
    FONT_DATA.set(face, data)
  }
  return data
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * El texto que esta letra puede escribir: cada carácter que no cubre (un emoji con
 * todas sus partes cuenta como uno) sale como `?`, sin error. Los blancos
 * heredados pasan a espacios y los caracteres de control se quitan.
 */
export function printable(value: string, face: Face = "sans"): string {
  const { font } = fontData(face)
  const clean = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\t/g, " ")
  let out = ""
  for (const { segment } of GRAPHEMES.segment(clean)) {
    if (segment === "\n" || segment === " ") {
      out += segment
      continue
    }
    const points = [...segment].map((char) => char.codePointAt(0) ?? 0)
    if (points.every((code) => code < 0x20 || code === 0x7f)) continue
    out += points.every((code) => font.hasGlyphForCodePoint(code)) ? segment : "?"
  }
  return out
}

// --- Color ---------------------------------------------------------------------

const hex = (value: number): RGB =>
  rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255)

export type Tone = "ink" | "gray" | "soft" | "alert" | "white"

const SHEET_TONES: Record<Tone, RGB> = {
  ink: hex(0x0f172a),
  gray: hex(0x475569),
  soft: hex(0x334155),
  alert: hex(0x991b1b),
  white: hex(0xffffff),
}
const BLACK = hex(0x000000)
/** En la térmica no hay grises: todo es negro. */
const THERMAL_TONES: Record<Tone, RGB> = {
  ink: BLACK,
  gray: BLACK,
  soft: BLACK,
  alert: BLACK,
  white: hex(0xffffff),
}
const RULE = hex(0xcbd5e1)
const HAIR = hex(0xe2e8f0)
const FIELD = hex(0x64748b)

// --- Texto medido --------------------------------------------------------------

/** Un trozo de texto: cadena sola, o con su letra, tono o tamaño. */
export type Inline = string | { text: string; face?: Face; tone?: Tone; size?: number }

export interface TextStyle {
  size?: number
  face?: Face
  tone?: Tone
  /** Interlínea, en veces el tamaño. */
  leading?: number
  align?: "left" | "right" | "center"
}

interface Segment {
  text: string
  face: Face
  tone: Tone
  size: number
  width: number
}

/** Una línea lista para escribir, con su alto. */
export interface Line {
  segments: Segment[]
  width: number
  height: number
  size: number
  gapBefore: number
  align: "left" | "right" | "center"
}

/** Lo que se escribe en una celda o una columna: bloques de texto o una casilla para marcar. */
export type Block =
  | ({ inlines: Inline | Inline[]; gapBefore?: number } & TextStyle)
  | { checkbox: true; size?: number; gapBefore?: number }

export type Cell = Inline | Block[]

export interface TableColumn {
  label: string
  /** Ancho en puntos; sin él, reparte lo que queda. */
  width?: number
  align?: "left" | "right" | "center"
  /** Espacio a la derecha de la columna. */
  pad?: number
}

export interface TableOptions {
  columns: TableColumn[]
  rows: Cell[][]
  /** Alto de relleno arriba y abajo de cada fila. */
  rowPad?: number
  size?: number
  /** Regla de cierre en tinta. */
  closed?: boolean
  /** Sin reglas entre filas: una lista de datos con su nombre. */
  plain?: boolean
  /** Encabezado propio: se dibuja en lugar del de las columnas y se repite al pasar de página. */
  head?: () => void
}

export interface SignedBlockInput {
  name: string
  /** «Cirujano dentista · COP 12345». */
  credential: string | null
  /** La fecha y hora de emisión, ya escrita. */
  at: string
  /** La dirección para comprobarlo; sin ella, sin QR. */
  checkUrl?: string | null
}

export type Strokes = number[][][]

export interface PenSignature {
  heading: string
  strokes: Strokes | null
  lines: Array<{ text: string; strong?: boolean }>
}

export interface KitOptions {
  /** Título del PDF y del encabezado corto. */
  title: string
  /** Lo que va al pie a la derecha: «Receta N.º 12». */
  docLabel: string
  /** A quién pertenece: el nombre del paciente; nulo en lo que no es de un paciente. */
  patientLabel?: string | null
  /** Nota legal al pie, si la lleva. */
  legalNote?: string | null
  /** Fecha de creación del PDF (la de firma, en lo firmado). */
  createdAt?: Date
}

const TOP = 42
const BOTTOM = 24
const FOOTER_GAP = 12
const THERMAL_PAD = 12

function lineHeightOf(size: number, leading: number): number {
  return size * leading
}

function baselineOf(top: number, size: number, height: number): number {
  // Noto: 1,069 sobre la línea base y 0,293 debajo.
  return top - (height - 1.362 * size) / 2 - 1.069 * size
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word))
  const letters = words
    .slice(0, 2)
    .map((word) => [...(word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")][0] ?? "")
  return letters.join("").toLocaleUpperCase("es")
}

export class DocumentKit {
  readonly pdf: PDFDocument
  readonly format: DocFormat
  readonly clinic: DocumentClinic
  page: PDFPage
  y: number
  /** Lo que quedó escrito en cada pie, en orden. */
  footers: string[] = []

  private readonly fonts: Record<Face, PDFFont>
  private readonly options: KitOptions
  private readonly tones: Record<Tone, RGB>
  private readonly logoImage: PDFImage | null
  private bottomLimit = 0
  private freshTop = Number.NaN
  private footerHeight = 0
  private legalLines: Line[] = []

  private constructor(
    pdf: PDFDocument,
    clinic: DocumentClinic,
    format: DocFormat,
    options: KitOptions,
    fonts: Record<Face, PDFFont>,
    logoImage: PDFImage | null,
  ) {
    this.pdf = pdf
    this.clinic = clinic
    this.format = format
    this.options = options
    this.fonts = fonts
    this.logoImage = logoImage
    this.tones = format.exactFit ? THERMAL_TONES : SHEET_TONES
    this.page = pdf.addPage([format.width, format.height])
    this.y = format.height - (format.exactFit ? THERMAL_PAD : TOP)
    this.measureFooter()
    this.bottomLimit = format.exactFit ? THERMAL_PAD : BOTTOM + this.footerHeight + FOOTER_GAP
  }

  /** Un papel nuevo con su membrete ya escrito. */
  static async open(
    clinic: DocumentClinic,
    format: DocFormat,
    options: KitOptions,
  ): Promise<DocumentKit> {
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    pdf.setTitle(printable(options.title))
    pdf.setProducer(printable(clinic.tradeName))
    pdf.setCreator(printable(clinic.tradeName))
    if (options.createdAt) {
      pdf.setCreationDate(options.createdAt)
      pdf.setModificationDate(options.createdAt)
    }
    const entries = await Promise.all(
      FACES.map(
        async (face) =>
          [face, await pdf.embedFont(fontData(face).bytes, { subset: true })] as const,
      ),
    )
    let logoImage: PDFImage | null = null
    if (clinic.logo && !format.exactFit) {
      try {
        logoImage =
          clinic.logo.kind === "png"
            ? await pdf.embedPng(clinic.logo.bytes)
            : await pdf.embedJpg(clinic.logo.bytes)
      } catch {
        // Una imagen dañada no rompe el papel: salen las iniciales.
        logoImage = null
      }
    }
    const kit = new DocumentKit(
      pdf,
      clinic,
      format,
      options,
      Object.fromEntries(entries) as Record<Face, PDFFont>,
      logoImage,
    )
    kit.letterhead()
    return kit
  }

  // --- Geometría ---------------------------------------------------------------

  get left(): number {
    return this.format.margin
  }
  get right(): number {
    return this.format.width - this.format.margin
  }
  get width(): number {
    return this.right - this.left
  }
  get thermal(): boolean {
    return this.format.exactFit
  }
  get pageCount(): number {
    return this.pdf.getPageCount()
  }
  /** Lo que cabe en una página entera debajo del encabezado corto. */
  private get pageRoom(): number {
    return this.format.height - TOP - 40 - this.bottomLimit
  }

  gap(height = 8): void {
    if (this.y - height < this.bottomLimit) {
      this.newPage()
      return
    }
    this.y -= height
  }

  /** Lo que sigue necesita este alto junto: si no cabe, pasa de página. */
  ensure(height: number): void {
    if (this.y - height < this.bottomLimit) this.newPage()
  }

  /** Cuánto queda en esta página. */
  room(): number {
    return this.y - this.bottomLimit
  }

  newPage(): void {
    if (this.thermal) return
    this.page = this.pdf.addPage([this.format.width, this.format.height])
    this.y = this.format.height - TOP
    this.shortHeader()
    this.freshTop = this.y
  }

  /** Nada escrito todavía bajo el encabezado corto de esta página. */
  get atPageTop(): boolean {
    return this.y === this.freshTop
  }

  /**
   * Lo que sigue va abajo del todo, sobre el pie (la firma del emisor). Si no cabe
   * en esta página, pasa a la siguiente; nunca se pisa.
   */
  anchorBottom(height: number): void {
    if (this.thermal) return
    this.ensure(height + 2)
    this.y = this.bottomLimit + height + 2
  }

  rule(
    options: { tone?: "ink" | "rule" | "hair"; thickness?: number; gapAfter?: number } = {},
  ): void {
    const color = options.tone === "ink" ? this.tones.ink : options.tone === "hair" ? HAIR : RULE
    const thickness = options.thickness ?? 0.75
    if (this.y - thickness < this.bottomLimit) this.newPage()
    this.page.drawLine({
      start: { x: this.left, y: this.y },
      end: { x: this.right, y: this.y },
      thickness,
      color: this.thermal ? BLACK : color,
    })
    this.y -= thickness + (options.gapAfter ?? 0)
  }

  color(tone: Tone): RGB {
    return this.tones[tone]
  }

  // --- Texto -------------------------------------------------------------------

  /** Cuánto ocupa este texto en una línea. */
  textWidth(value: string, face: Face, size: number): number {
    return this.fonts[face].widthOfTextAtSize(printable(value, face), size)
  }

  /** Cuánto cabe en una página nueva. */
  freshPageRoom(): number {
    return this.pageRoom
  }

  /** Parte el texto en líneas para ese ancho. */
  lay(inlines: Inline | Inline[], width: number, style: TextStyle = {}): Line[] {
    const size = style.size ?? SIZE.table
    const leading = style.leading ?? 1.45
    const baseFace = style.face ?? "sans"
    const baseTone = style.tone ?? "ink"
    const align = style.align ?? "left"
    const parts = Array.isArray(inlines) ? inlines : [inlines]
    const lines: Line[] = []
    let segments: Segment[] = []
    let used = 0
    let maxSize = size
    const flush = () => {
      lines.push({
        segments,
        width: used,
        size: maxSize,
        height: lineHeightOf(maxSize, leading),
        gapBefore: 0,
        align,
      })
      segments = []
      used = 0
      maxSize = size
    }
    const add = (text: string, face: Face, tone: Tone, partSize: number) => {
      const font = this.fonts[face]
      const last = segments[segments.length - 1]
      if (last && last.face === face && last.tone === tone && last.size === partSize) {
        last.text += text
        const fresh = font.widthOfTextAtSize(last.text, partSize)
        used += fresh - last.width
        last.width = fresh
      } else {
        const w = font.widthOfTextAtSize(text, partSize)
        segments.push({ text, face, tone, size: partSize, width: w })
        used += w
      }
      if (partSize > maxSize) maxSize = partSize
    }
    let pendingSpace = false
    for (const part of parts) {
      const piece = typeof part === "string" ? { text: part } : part
      const face = piece.face ?? baseFace
      const tone = piece.tone ?? baseTone
      const partSize = piece.size ?? size
      const font = this.fonts[face]
      const text = printable(piece.text, face)
      const paragraphs = text.split("\n")
      if (/^\s/.test(text)) pendingSpace = true
      paragraphs.forEach((paragraph, index) => {
        if (index > 0) {
          flush()
          pendingSpace = false
        }
        const words = paragraph.split(/ +/).filter(Boolean)
        for (const word of words) {
          const space =
            pendingSpace && segments.length > 0 ? font.widthOfTextAtSize(" ", partSize) : 0
          const wordWidth = font.widthOfTextAtSize(word, partSize)
          if (segments.length > 0 && used + space + wordWidth > width) {
            flush()
            pendingSpace = false
          }
          if (wordWidth > width) {
            // Una huella o una dirección larga: se parte por caracteres.
            let chunk = ""
            for (const char of word) {
              if (
                font.widthOfTextAtSize(chunk + char, partSize) > width - used &&
                (chunk || segments.length > 0)
              ) {
                if (chunk) add(chunk, face, tone, partSize)
                flush()
                chunk = ""
              }
              chunk += char
            }
            if (chunk) add(chunk, face, tone, partSize)
          } else {
            add(pendingSpace && segments.length > 0 ? ` ${word}` : word, face, tone, partSize)
          }
          pendingSpace = true
        }
      })
      // Lo que sigue se pega a esto salvo que haya un espacio de por medio.
      pendingSpace = /\s$/.test(text)
    }
    if (segments.length > 0 || lines.length === 0) flush()
    return lines
  }

  private drawLineAt(line: Line, x: number, top: number, width: number): void {
    const baseline = baselineOf(top, line.size, line.height)
    let cursor =
      line.align === "right"
        ? x + width - line.width
        : line.align === "center"
          ? x + (width - line.width) / 2
          : x
    for (const segment of line.segments) {
      if (segment.text) {
        this.page.drawText(segment.text, {
          x: cursor,
          y: baseline,
          size: segment.size,
          font: this.fonts[segment.face],
          color: this.tones[segment.tone],
        })
      }
      cursor += segment.width
    }
  }

  /** Texto corrido, con salto de página línea a línea. */
  text(
    inlines: Inline | Inline[],
    style: TextStyle & { indent?: number; width?: number } = {},
  ): void {
    const indent = style.indent ?? 0
    const width = style.width ?? this.width - indent
    for (const line of this.lay(inlines, width, style)) {
      this.ensure(line.height)
      this.drawLineAt(line, this.left + indent, this.y, width)
      this.y -= line.height
    }
  }

  /** Título o subtítulo, sin quedar solo al final de la página. */
  heading(
    value: string,
    style: TextStyle & { before?: number; after?: number; keep?: number } = {},
  ): void {
    const size = style.size ?? SIZE.h2small
    const lines = this.lay(value, this.width, { face: "serif", leading: 1.25, ...style, size })
    const height = lines.reduce((sum, line) => sum + line.height, 0)
    const before = style.before ?? 10
    if (this.y - before - height - (style.keep ?? 30) < this.bottomLimit) this.newPage()
    else this.y -= before
    for (const line of lines) {
      this.drawLineAt(line, this.left, this.y, this.width)
      this.y -= line.height
    }
    this.y -= style.after ?? 4
  }

  /** Subtítulo en letra normal: «Indicaciones», «Declaración». */
  subheading(value: string, style: TextStyle & { before?: number; after?: number } = {}): void {
    this.heading(value, {
      face: "sansBold",
      size: SIZE.table,
      leading: 1.4,
      before: 8,
      after: 1,
      ...style,
    })
  }

  bullets(items: string[], style: TextStyle = {}): void {
    const size = style.size ?? SIZE.table
    for (const item of items) {
      const lines = this.lay(item, this.width - 14, { ...style, size })
      lines.forEach((line, index) => {
        this.ensure(line.height)
        if (index === 0) {
          this.page.drawText("•", {
            x: this.left + 3,
            y: baselineOf(this.y, line.size, line.height),
            size,
            font: this.fonts.sans,
            color: this.tones[style.tone ?? "ink"],
          })
        }
        this.drawLineAt(line, this.left + 14, this.y, this.width - 14)
        this.y -= line.height
      })
    }
  }

  /** Una fila con texto a la izquierda y a la derecha. */
  spread(left: Inline | Inline[], right: Inline | Inline[], style: TextStyle = {}): void {
    const rightLines = this.lay(right, this.width * 0.5, { ...style, align: "right" })
    const rightWidth = Math.max(0, ...rightLines.map((line) => line.width))
    const leftLines = this.lay(left, Math.max(this.width - rightWidth - 12, this.width * 0.3), {
      ...style,
      align: "left",
    })
    const height = Math.max(
      leftLines.reduce((sum, line) => sum + line.height, 0),
      rightLines.reduce((sum, line) => sum + line.height, 0),
    )
    this.ensure(height)
    const top = this.y
    let cursor = top
    for (const line of leftLines) {
      this.drawLineAt(line, this.left, cursor, this.width)
      cursor -= line.height
    }
    cursor = top
    for (const line of rightLines) {
      this.drawLineAt(line, this.left, cursor, this.width)
      cursor -= line.height
    }
    this.y = top - height
  }

  /** Título a la izquierda y sus datos a la derecha, sobre la misma base. */
  titleWithDetails(
    title: string,
    details: Array<{ text: string; strong?: boolean }>,
    size: number = SIZE.title,
  ): void {
    const detailLines = details.flatMap((item) =>
      this.lay(item.text, this.width * 0.5, {
        align: "right",
        size: item.strong ? SIZE.read : SIZE.second,
        face: item.strong ? "sansSemi" : "sans",
        tone: item.strong ? "ink" : "gray",
        leading: 1.4,
      }),
    )
    const detailWidth = Math.max(0, ...detailLines.map((line) => line.width))
    const titleLines = this.lay(title, this.width - detailWidth - 18, {
      face: "serif",
      size,
      leading: 1.15,
    })
    const titleHeight = titleLines.reduce((sum, line) => sum + line.height, 0)
    const detailHeight = detailLines.reduce((sum, line) => sum + line.height, 0)
    const height = Math.max(titleHeight, detailHeight)
    this.ensure(height)
    const top = this.y
    let cursor = top - (height - titleHeight)
    for (const line of titleLines) {
      this.drawLineAt(line, this.left, cursor, this.width)
      cursor -= line.height
    }
    cursor = top - (height - detailHeight)
    for (const line of detailLines) {
      this.drawLineAt(line, this.left, cursor, this.width)
      cursor -= line.height
    }
    this.y = top - height
  }

  /** Datos en rejilla entre dos reglas: «Paciente», «DNI», «Edad». */
  facts(
    cells: Array<{
      label: string
      value: string
      sub?: string
      span?: number
      strong?: boolean
      bold?: boolean
    }>,
    columns: number,
    options: { size?: number; pad?: number } = {},
  ): void {
    const size = options.size ?? SIZE.table
    const pad = options.pad ?? 10
    const gapX = 13
    const unit = (this.width - gapX * (columns - 1)) / columns
    type Placed = { lines: Line[]; x: number; width: number }
    const rows: Placed[][] = []
    let row: Placed[] = []
    let column = 0
    for (const cell of cells) {
      const span = Math.min(cell.span ?? 1, columns)
      if (column + span > columns) {
        rows.push(row)
        row = []
        column = 0
      }
      const width = unit * span + gapX * (span - 1)
      const lines = [
        ...this.lay(cell.label, width, { size: SIZE.label, tone: "gray", leading: 1.35 }),
        ...this.lay(cell.value, width, {
          size,
          face: cell.bold ? "sansBold" : cell.strong ? "sansSemi" : "sans",
          leading: 1.4,
        }),
        ...(cell.sub
          ? this.lay(cell.sub, width, { size: SIZE.second, tone: "gray", leading: 1.4 })
          : []),
      ]
      row.push({ lines, x: this.left + (unit + gapX) * column, width })
      column += span
    }
    if (row.length > 0) rows.push(row)
    const heights = rows.map((placed) =>
      Math.max(...placed.map((cell) => cell.lines.reduce((sum, line) => sum + line.height, 0))),
    )
    const total =
      heights.reduce((sum, height) => sum + height, 0) + (rows.length - 1) * 10 + pad * 2
    this.ensure(total + 2)
    this.rule()
    this.y -= pad
    rows.forEach((placed, index) => {
      const top = this.y
      for (const cell of placed) {
        let cursor = top
        for (const line of cell.lines) {
          this.drawLineAt(line, cell.x, cursor, cell.width)
          cursor -= line.height
        }
      }
      this.y = top - (heights[index] ?? 0) - (index < rows.length - 1 ? 10 : 0)
    })
    this.y -= pad
    this.rule()
  }

  // --- Tablas ------------------------------------------------------------------

  private columnWidths(columns: TableColumn[]): number[] {
    const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
    const free = columns.filter((column) => column.width == null).length
    const flex = free > 0 ? Math.max(this.width - fixed, 0) / free : 0
    return columns.map((column) => column.width ?? flex)
  }

  private layCell(
    cell: Cell,
    width: number,
    column: TableColumn,
    size: number,
  ): Array<Line | { checkbox: number; gapBefore: number }> {
    const blocks: Block[] = Array.isArray(cell) ? (cell as Block[]) : [{ inlines: cell as Inline }]
    const out: Array<Line | { checkbox: number; gapBefore: number }> = []
    for (const block of blocks) {
      if ("checkbox" in block) {
        out.push({ checkbox: block.size ?? 12, gapBefore: block.gapBefore ?? 0 })
        continue
      }
      const lines = this.lay(block.inlines, width, {
        size,
        leading: 1.4,
        align: column.align ?? "left",
        ...block,
      })
      lines.forEach((line, index) => {
        if (index === 0 && block.gapBefore) line.gapBefore = block.gapBefore
      })
      out.push(...lines)
    }
    return out
  }

  /**
   * Tabla con filas que no se cortan mientras quepan en una página; una fila más
   * larga que una página sigue en la siguiente. El encabezado se repite.
   */
  table(options: TableOptions): void {
    const { columns, rows } = options
    const widths = this.columnWidths(columns)
    const size = options.size ?? SIZE.dense
    const rowPad = options.rowPad ?? 5
    const hasHead = columns.some((column) => column.label)
    const padOf = (index: number) => columns[index]?.pad ?? (index < columns.length - 1 ? 8 : 0)
    const drawHead = () => {
      if (options.head) {
        options.head()
        return
      }
      if (!hasHead) return
      const heads = columns.map((column, index) =>
        this.lay(column.label, Math.max(widths[index]! - padOf(index), 1), {
          size: SIZE.label,
          face: "sansSemi",
          tone: "gray",
          leading: 1.3,
          align: column.align ?? "left",
        }),
      )
      const height = Math.max(
        ...heads.map((lines) => lines.reduce((sum, line) => sum + line.height, 0)),
      )
      const top = this.y
      let x = this.left
      heads.forEach((lines, index) => {
        let cursor = top
        for (const line of lines) {
          this.drawLineAt(line, x, cursor, Math.max(widths[index]! - padOf(index), 1))
          cursor -= line.height
        }
        x += widths[index]!
      })
      this.y = top - height - 3
      this.rule({ tone: "ink" })
    }
    const headHeight = hasHead ? SIZE.label * 1.3 + 4 : 0
    // Sin caber el encabezado y una fila, la tabla empieza en la siguiente página.
    const firstRow = rows[0]
    if (firstRow) {
      const firstHeight = this.cellsHeight(firstRow, columns, widths, size, padOf) + rowPad * 2
      this.ensure(headHeight + Math.min(firstHeight, 60))
    }
    drawHead()
    rows.forEach((row, rowIndex) => {
      const laid = row.map((cell, index) =>
        this.layCell(cell, Math.max(widths[index]! - padOf(index), 1), columns[index]!, size),
      )
      const height = Math.max(...laid.map((items) => this.itemsHeight(items))) + rowPad * 2
      const closes = rowIndex === rows.length - 1 && options.closed !== false
      if (this.y - height < this.bottomLimit && height <= this.pageRoom) {
        this.newPage()
        drawHead()
      }
      this.y -= rowPad
      this.drawRowSliced(laid, widths, padOf, drawHead)
      this.y -= rowPad
      if (!options.plain) this.rule({ tone: closes ? "ink" : "hair" })
    })
  }

  private itemsHeight(items: Array<Line | { checkbox: number; gapBefore: number }>): number {
    return items.reduce(
      (sum, item) =>
        sum + ("checkbox" in item ? item.checkbox + item.gapBefore : item.height + item.gapBefore),
      0,
    )
  }

  private cellsHeight(
    row: Cell[],
    columns: TableColumn[],
    widths: number[],
    size: number,
    padOf: (index: number) => number,
  ): number {
    return Math.max(
      ...row.map((cell, index) =>
        this.itemsHeight(
          this.layCell(cell, Math.max(widths[index]! - padOf(index), 1), columns[index]!, size),
        ),
      ),
    )
  }

  private drawRowSliced(
    laid: Array<Array<Line | { checkbox: number; gapBefore: number }>>,
    widths: number[],
    padOf: (index: number) => number,
    drawHead: () => void,
  ): void {
    const remaining = laid.map((items) => [...items])
    while (remaining.some((items) => items.length > 0)) {
      const top = this.y
      let lowest = top
      let x = this.left
      remaining.forEach((items, index) => {
        const width = Math.max(widths[index]! - padOf(index), 1)
        let cursor = top
        while (items.length > 0) {
          const item = items[0]!
          const height =
            "checkbox" in item ? item.checkbox + item.gapBefore : item.height + item.gapBefore
          if (cursor - height < this.bottomLimit) break
          cursor -= item.gapBefore
          if ("checkbox" in item) {
            const boxX = x + (width - item.checkbox) / 2
            this.page.drawRectangle({
              x: boxX,
              y: cursor - item.checkbox,
              width: item.checkbox,
              height: item.checkbox,
              borderColor: this.tones.ink,
              borderWidth: 0.75,
            })
            cursor -= item.checkbox
          } else {
            this.drawLineAt(item, x, cursor, width)
            cursor -= item.height
          }
          items.shift()
        }
        if (cursor < lowest) lowest = cursor
        x += widths[index]!
      })
      this.y = lowest
      if (remaining.some((items) => items.length > 0)) {
        this.newPage()
        drawHead()
      }
    }
  }

  /** «Total» a la izquierda y el importe en letra grande a la derecha. */
  total(
    left: Inline | Inline[],
    amount: string,
    options: { size?: number; before?: number } = {},
  ): void {
    const size = options.size ?? SIZE.total
    if (this.thermal) {
      this.spread(
        left,
        { text: amount, face: "sansBold", size: SIZE.h2small },
        { face: "sansBold", size: SIZE.h2small, leading: 1.3 },
      )
      return
    }
    const amountWidth = this.fonts.serif.widthOfTextAtSize(printable(amount, "serif"), size)
    const lines = this.lay(left, this.width - amountWidth - 18, { size: SIZE.table, leading: 1.4 })
    const height = Math.max(
      size * 1.25,
      lines.reduce((sum, line) => sum + line.height, 0),
    )
    this.y -= options.before ?? 6
    this.ensure(height)
    const top = this.y
    let cursor = top - Math.max(0, height - lines.reduce((sum, line) => sum + line.height, 0))
    for (const line of lines) {
      this.drawLineAt(line, this.left, cursor, this.width)
      cursor -= line.height
    }
    const amountLine = this.lay(amount, this.width, {
      face: "serif",
      size,
      leading: 1.25,
      align: "right",
    })[0]
    if (amountLine)
      this.drawLineAt(amountLine, this.left, top - (height - amountLine.height), this.width)
    this.y = top - height
  }

  /** Dos columnas de secciones cortas: «Si decide no tratarse», «Qué no incluye». */
  grid(
    cells: Array<{ title: string; body: string | string[] }>,
    options: { columns?: number; size?: number } = {},
  ): void {
    const columns = options.columns ?? 2
    const size = options.size ?? SIZE.dense
    const gapX = 21
    const width = (this.width - gapX * (columns - 1)) / columns
    const layOne = (cell: { title: string; body: string | string[] }) => {
      const title = this.lay(cell.title, width, { face: "sansBold", size, leading: 1.35 })
      const body: Array<{ line: Line; bullet: boolean }> = []
      if (Array.isArray(cell.body)) {
        for (const item of cell.body) {
          this.lay(item, width - 12, { size, leading: 1.42 }).forEach((line, index) => {
            body.push({ line, bullet: index === 0 })
          })
        }
      } else {
        for (const line of this.lay(cell.body, width, { size, leading: 1.42 }))
          body.push({ line, bullet: false })
      }
      const isList = Array.isArray(cell.body)
      const height =
        title.reduce((sum, line) => sum + line.height, 0) +
        body.reduce((sum, item) => sum + item.line.height, 0)
      return { title, body, height, isList }
    }
    for (let start = 0; start < cells.length; start += columns) {
      const row = cells.slice(start, start + columns).map(layOne)
      const height = Math.max(...row.map((cell) => cell.height))
      if (height > this.pageRoom) {
        // Una sección larguísima: sigue como texto corrido, sin cortarse.
        for (const cell of cells.slice(start, start + columns)) {
          this.subheading(cell.title, { size })
          if (Array.isArray(cell.body)) this.bullets(cell.body, { size })
          else this.text(cell.body, { size })
        }
        continue
      }
      this.ensure(height)
      const top = this.y
      row.forEach((cell, index) => {
        const x = this.left + (width + gapX) * index
        let cursor = top
        for (const line of cell.title) {
          this.drawLineAt(line, x, cursor, width)
          cursor -= line.height
        }
        for (const { line, bullet } of cell.body) {
          if (bullet) {
            this.page.drawText("•", {
              x: x + 2,
              y: baselineOf(cursor, line.size, line.height),
              size,
              font: this.fonts.sans,
              color: this.tones.ink,
            })
          }
          this.drawLineAt(line, cell.isList ? x + 12 : x, cursor, cell.isList ? width - 12 : width)
          cursor -= line.height
        }
      })
      this.y = top - height - 10
    }
  }

  // --- Recuadros ---------------------------------------------------------------

  private frame(
    x: number,
    y: number,
    width: number,
    height: number,
    border: RGB,
    thickness: number,
    dashed = false,
  ): void {
    this.page.drawRectangle({
      x,
      y,
      width,
      height,
      borderColor: border,
      borderWidth: thickness,
      ...(dashed ? { borderDashArray: [4, 3] } : {}),
    })
  }

  /** ANULADA, REVOCADO, BORRADOR o un aviso en recuadro. */
  stateBox(input: {
    kind: "alert" | "draft" | "note"
    title: string
    detail?: string | null
  }): void {
    const tone: Tone = input.kind === "alert" ? "alert" : "ink"
    const padX = 12
    const padY = 8
    const inner = this.width - padX * 2
    const titleLines = this.lay(input.title, inner, {
      face: "sansBold",
      size: input.kind === "note" ? SIZE.table : SIZE.h2,
      tone,
      leading: 1.3,
    })
    const detailLines = input.detail
      ? this.lay(input.detail, inner, { size: SIZE.dense, tone, leading: 1.4 })
      : []
    const height =
      [...titleLines, ...detailLines].reduce((sum, line) => sum + line.height, 0) + padY * 2
    this.ensure(height + 2)
    const top = this.y
    this.frame(
      this.left,
      top - height,
      this.width,
      height,
      this.tones[tone],
      1.5,
      input.kind === "draft",
    )
    let cursor = top - padY
    for (const line of [...titleLines, ...detailLines]) {
      this.drawLineAt(line, this.left + padX, cursor, inner)
      cursor -= line.height
    }
    this.y = top - height
  }

  /** Un recuadro con cuerpo escrito: la declaración, las señales de alarma. */
  panel(input: { title?: string; body: string; thickness?: number; size?: number }): void {
    const size = input.size ?? SIZE.table
    const padX = 14
    const padY = 11
    const inner = this.width - padX * 2
    const title = input.title
      ? this.lay(input.title, inner, { face: "sansBold", size, leading: 1.35 })
      : []
    const body = this.lay(input.body, inner, { size, leading: 1.45 })
    const height = [...title, ...body].reduce((sum, line) => sum + line.height, 0) + padY * 2
    if (height > this.pageRoom) {
      if (input.title) this.subheading(input.title)
      this.text(input.body, { size })
      return
    }
    this.ensure(height + 2)
    const top = this.y
    this.frame(this.left, top - height, this.width, height, this.tones.ink, input.thickness ?? 0.75)
    let cursor = top - padY
    for (const line of [...title, ...body]) {
      this.drawLineAt(line, this.left + padX, cursor, inner)
      cursor -= line.height
    }
    this.y = top - height
  }

  // --- QR ----------------------------------------------------------------------

  /** QR vectorial: nada de imágenes, se imprime nítido a cualquier tamaño. */
  qr(url: string, x: number, top: number, size: number): void {
    const code = QRCode.create(url, { errorCorrectionLevel: "M" })
    const count = code.modules.size
    const module = size / count
    const path: string[] = []
    for (let row = 0; row < count; row++) {
      for (let column = 0; column < count; column++) {
        if (code.modules.get(row, column)) path.push(`M${column} ${row}h1v1h-1z`)
      }
    }
    this.page.drawSvgPath(path.join(""), {
      x,
      y: top,
      scale: module,
      color: this.thermal ? BLACK : this.tones.ink,
    })
  }

  /** «Firmado electrónicamente», con su QR para comprobarlo. */
  signedBlockHeight(input: Pick<SignedBlockInput, "credential" | "checkUrl">): number {
    const padY = 9
    const lines =
      SIZE.label * 1.35 +
      SIZE.table * 1.4 +
      (input.credential ? SIZE.second * 1.4 : 0) +
      SIZE.second * 1.4
    return Math.max(lines, input.checkUrl ? 54 : 0) + padY * 2
  }

  signedBlock(input: SignedBlockInput): void {
    const padX = 10.5
    const padY = 9
    const height = this.signedBlockHeight(input)
    this.ensure(height + 2)
    const top = this.y
    if (!this.thermal) this.frame(this.left, top - height, this.width, height, RULE, 0.75)
    const textWidth = this.width - padX * 2 - (input.checkUrl ? 180 : 0)
    let cursor = top - padY
    const rows: Array<[string, TextStyle]> = [
      [
        "Firmado electrónicamente",
        { size: SIZE.label, face: "sansSemi", tone: "gray", leading: 1.35 },
      ],
      [input.name, { size: SIZE.table, face: "sansSemi", leading: 1.4 }],
      ...(input.credential
        ? [
            [input.credential, { size: SIZE.second, tone: "gray", leading: 1.4 }] as [
              string,
              TextStyle,
            ],
          ]
        : []),
      [input.at, { size: SIZE.second, tone: "gray", leading: 1.4 }],
    ]
    for (const [value, style] of rows) {
      const line = this.lay(value, textWidth, style)[0]
      if (!line) continue
      this.drawLineAt(line, this.left + padX, cursor, textWidth)
      cursor -= line.height
    }
    if (input.checkUrl) {
      const qrSize = 54
      const qrX = this.right - padX - qrSize
      const qrTop = top - (height - qrSize) / 2
      this.qr(input.checkUrl, qrX, qrTop, qrSize)
      const caption = this.lay("Escanee para comprobar que sigue vigente", 112, {
        size: SIZE.label,
        tone: "gray",
        leading: 1.35,
        align: "right",
      })
      const captionHeight = caption.reduce((sum, line) => sum + line.height, 0)
      let captionTop = top - (height - captionHeight) / 2
      for (const line of caption) {
        this.drawLineAt(line, qrX - 8 - 112, captionTop, 112)
        captionTop -= line.height
      }
    }
    this.y = top - height
  }

  // --- Firmas ------------------------------------------------------------------

  /** Línea para firmar a mano: «Recibí conforme» y «Fecha». */
  signLine(caption: string, second?: string): void {
    const height = 44
    this.ensure(height + SIZE.second * 1.4)
    this.y -= height - SIZE.second * 1.4
    const top = this.y
    const secondWidth = second ? this.width * 0.25 : 0
    const gapX = second ? 21 : 0
    const mainWidth = second
      ? this.width - secondWidth - gapX
      : this.thermal
        ? this.width
        : this.width * 0.6
    // Devuelve dónde termina: en un rollo angosto el texto puede ocupar dos renglones.
    const draw = (x: number, width: number, value: string): number => {
      this.page.drawLine({
        start: { x, y: top },
        end: { x: x + width, y: top },
        thickness: 0.75,
        color: this.tones.ink,
      })
      let cursor = top - 3
      for (const line of this.lay(value, width, {
        size: SIZE.second,
        tone: "gray",
        leading: 1.4,
      })) {
        this.drawLineAt(line, x, cursor, width)
        cursor -= line.height
      }
      return cursor
    }
    const mainEnd = draw(this.left, mainWidth, caption)
    const secondEnd = second ? draw(this.left + mainWidth + gapX, secondWidth, second) : mainEnd
    this.y = Math.min(mainEnd, secondEnd)
  }

  private penColumnHeight(signature: PenSignature, width: number, boxHeight: number): number {
    const heading = this.lay(signature.heading, width, {
      face: "sansSemi",
      size: SIZE.table,
      leading: 1.4,
    })
    const lines = signature.lines.flatMap((item) =>
      this.lay(item.text, width, { size: item.strong ? SIZE.table : SIZE.second, leading: 1.4 }),
    )
    return [...heading, ...lines].reduce((sum, line) => sum + line.height, 0) + boxHeight + 10
  }

  /** Firmas con su trazo en columnas; un trazo vacío deja el recuadro para firmar en papel. */
  penSignatures(signatures: PenSignature[], options: { boxHeight?: number } = {}): void {
    const columns = Math.max(signatures.length, 1)
    const gapX = 21
    const width = (this.width - gapX * (columns - 1)) / columns
    const boxHeight = options.boxHeight ?? 66
    const height = Math.max(
      ...signatures.map((signature) => this.penColumnHeight(signature, width, boxHeight)),
    )
    this.ensure(height)
    const top = this.y
    signatures.forEach((signature, index) => {
      const x = this.left + (width + gapX) * index
      let cursor = top
      for (const line of this.lay(signature.heading, width, {
        face: "sansSemi",
        size: SIZE.table,
        leading: 1.4,
      })) {
        this.drawLineAt(line, x, cursor, width)
        cursor -= line.height
      }
      cursor -= 4
      const boxTop = cursor
      if (signature.strokes && signature.strokes.length > 0) {
        // El recuadro donde se firmó mide 22 × 7: en una columna más ancha el trazo no se estira.
        const penWidth = Math.min(width, (boxHeight * 22) / 7)
        for (const stroke of signature.strokes) {
          for (let point = 1; point < stroke.length; point++) {
            const from = stroke[point - 1] as [number, number]
            const to = stroke[point] as [number, number]
            this.page.drawLine({
              start: {
                x: x + (from[0] / 1000) * penWidth,
                y: boxTop - (from[1] / 1000) * boxHeight,
              },
              end: { x: x + (to[0] / 1000) * penWidth, y: boxTop - (to[1] / 1000) * boxHeight },
              thickness: 1.25,
              color: this.tones.ink,
            })
          }
        }
        this.page.drawLine({
          start: { x, y: boxTop - boxHeight },
          end: { x: x + width, y: boxTop - boxHeight },
          thickness: 0.75,
          color: this.tones.ink,
        })
      } else {
        this.frame(x, boxTop - boxHeight, width, boxHeight, FIELD, 0.75)
      }
      cursor = boxTop - boxHeight - 6
      for (const item of signature.lines) {
        for (const line of this.lay(item.text, width, {
          size: item.strong ? SIZE.table : SIZE.second,
          face: item.strong ? "sansSemi" : "sans",
          tone: item.strong ? "ink" : "gray",
          leading: 1.4,
        })) {
          this.drawLineAt(line, x, cursor, width)
          cursor -= line.height
        }
      }
    })
    this.y = top - height
  }

  /** «Elijo la opción ☐ A ☐ B ☐ Lo voy a pensar», en una fila que salta si no cabe. */
  choiceRow(label: string, choices: string[]): void {
    const box = 13.5
    const size = SIZE.table
    const rowHeight = 20
    this.ensure(rowHeight)
    const baseTop = this.y
    let top = baseTop
    let x = this.left
    const drawLabel = (value: string, at: number) => {
      const line = this.lay(value, this.width, { face: "sansSemi", size, leading: 1.4 })[0]
      if (line) this.drawLineAt(line, at, top - (box - line.height) / 2, this.width)
    }
    drawLabel(label, x)
    x += this.textWidth(label, "sansSemi", size) + 15
    for (const choice of choices) {
      const width = box + 4.5 + this.textWidth(choice, "sansSemi", size)
      if (x + width > this.right) {
        top -= rowHeight
        x = this.left
      }
      this.page.drawRectangle({
        x,
        y: top - box,
        width: box,
        height: box,
        borderColor: this.tones.ink,
        borderWidth: 0.75,
      })
      drawLabel(choice, x + box + 4.5)
      x += width + 15
    }
    this.y = top - rowHeight
  }

  /** «Responda desde su celular»: el recuadro con el QR del enlace. */
  qrPanel(input: { url: string | null; title: string; body: string }): void {
    const padX = 9
    const padY = 7.5
    const qrSize = input.url ? 54 : 0
    const offset = input.url ? qrSize + 10.5 : 0
    const inner = this.width - padX * 2 - offset
    const title = this.lay(input.title, inner, {
      face: "sansBold",
      size: SIZE.dense,
      leading: 1.35,
    })
    const body = this.lay(input.body, inner, { size: SIZE.second, tone: "soft", leading: 1.4 })
    const textHeight = [...title, ...body].reduce((sum, line) => sum + line.height, 0)
    const height = Math.max(textHeight, qrSize) + padY * 2
    this.ensure(height + 2)
    const top = this.y
    this.frame(this.left, top - height, this.width, height, this.tones.ink, 1.5)
    if (input.url) this.qr(input.url, this.left + padX, top - (height - qrSize) / 2, qrSize)
    let cursor = top - (height - textHeight) / 2
    for (const line of [...title, ...body]) {
      this.drawLineAt(line, this.left + padX + offset, cursor, inner)
      cursor -= line.height
    }
    this.y = top - height
  }

  /** La grilla de un sitio: casilla por casilla, con las marcadas en tinta. */
  siteChart(rows: Array<Array<{ label: string; marked: boolean }>>): void {
    const cellWidth = 24
    const cellHeight = 19.5
    const gap = 2.25
    const padY = 7.5
    const height = rows.length * cellHeight + (rows.length - 1) * gap + padY * 2
    this.ensure(height + 2)
    const top = this.y
    this.frame(this.left, top - height, this.width, height, RULE, 0.75)
    rows.forEach((row, rowIndex) => {
      const rowWidth = row.length * cellWidth + (row.length - 1) * gap
      const scale = rowWidth > this.width - 8 ? (this.width - 8) / rowWidth : 1
      const startX = this.left + (this.width - rowWidth * scale) / 2
      const y = top - padY - rowIndex * (cellHeight + gap) - cellHeight
      row.forEach((cell, index) => {
        const x = startX + index * (cellWidth + gap) * scale
        this.page.drawRectangle({
          x,
          y,
          width: cellWidth * scale,
          height: cellHeight,
          ...(cell.marked ? { color: this.tones.ink } : { borderColor: RULE, borderWidth: 0.75 }),
        })
        const line = this.lay(cell.label, cellWidth * scale, {
          size: SIZE.label,
          face: cell.marked ? "sansBold" : "sans",
          tone: cell.marked ? "white" : "gray",
          leading: 1.3,
          align: "center",
        })[0]
        if (line)
          this.drawLineAt(
            line,
            x,
            y + cellHeight - (cellHeight - line.height) / 2,
            cellWidth * scale,
          )
      })
    })
    this.y = top - height
  }

  // --- Membrete y pie ----------------------------------------------------------

  /** «Dental Smile S.A.C. · RUC 20601234567». */
  private fiscalLine(): string {
    const { legalName, fiscalDocType, fiscalDocNumber } = this.clinic
    const fiscal = fiscalDocNumber
      ? [fiscalDocType, fiscalDocNumber].filter(Boolean).join(" ")
      : null
    return [legalName && legalName !== this.clinic.tradeName ? legalName : null, fiscal]
      .filter(Boolean)
      .join(" · ")
  }

  private letterhead(): void {
    if (this.thermal) {
      this.thermalLetterhead()
      return
    }
    const clinic = this.clinic
    const rightItems = [clinic.branchName, clinic.address, clinic.phone].filter(
      (item): item is string => !!item,
    )
    const rightMax = this.width * 0.42
    const rightLines = rightItems.flatMap((item) =>
      this.lay(item, rightMax, { size: SIZE.second, tone: "gray", leading: 1.4, align: "right" }),
    )
    const rightWidth = Math.max(0, ...rightLines.map((line) => line.width))
    const rightHeight = rightLines.reduce((sum, line) => sum + line.height, 0)
    let markWidth = 39
    if (this.logoImage) {
      const ratio = this.logoImage.width / this.logoImage.height
      markWidth = Math.min(72, 39 * ratio)
    }
    const nameWidth = Math.max(this.width - rightWidth - 18 - markWidth - 10.5, this.width * 0.25)
    const nameLines = this.lay(clinic.tradeName, nameWidth, {
      face: "serif",
      size: 16.5,
      leading: 1.2,
    })
    const fiscal = this.fiscalLine()
    const fiscalLines = fiscal
      ? this.lay(fiscal, nameWidth, { size: SIZE.second, tone: "gray", leading: 1.35 })
      : []
    const nameHeight = [...nameLines, ...fiscalLines].reduce((sum, line) => sum + line.height, 0)
    const height = Math.max(39, nameHeight, rightHeight)
    const top = this.y
    const bottom = top - height
    if (this.logoImage) {
      const ratio = this.logoImage.width / this.logoImage.height
      const drawHeight = Math.min(39, markWidth / ratio)
      this.page.drawImage(this.logoImage, {
        x: this.left,
        y: bottom + (height - drawHeight) / 2,
        width: markWidth,
        height: drawHeight,
      })
    } else {
      const boxY = bottom + (height - 39) / 2
      this.page.drawRectangle({
        x: this.left,
        y: boxY,
        width: 39,
        height: 39,
        color: this.tones.ink,
      })
      const initials = this.lay(initialsOf(clinic.tradeName) || "·", 39, {
        face: "serif",
        size: 15,
        tone: "white",
        leading: 1.2,
        align: "center",
      })[0]
      if (initials) this.drawLineAt(initials, this.left, boxY + 39 - (39 - initials.height) / 2, 39)
    }
    let cursor = top - (height - nameHeight) / 2
    for (const line of [...nameLines, ...fiscalLines]) {
      this.drawLineAt(line, this.left + markWidth + 10.5, cursor, nameWidth)
      cursor -= line.height
    }
    cursor = bottom + rightHeight
    for (const line of rightLines) {
      this.drawLineAt(line, this.right - rightMax, cursor, rightMax)
      cursor -= line.height
    }
    this.y = bottom - 10.5
    this.rule({ tone: "ink", thickness: 1.5 })
  }

  private thermalLetterhead(): void {
    const clinic = this.clinic
    const center: TextStyle = { align: "center", size: SIZE.label, leading: 1.35 }
    this.text(clinic.tradeName, { face: "serif", size: 14.25, align: "center", leading: 1.25 })
    const fiscal = this.fiscalLine()
    if (fiscal) this.text(fiscal, center)
    for (const item of [clinic.branchName, clinic.address, clinic.phone])
      if (item) this.text(item, center)
    this.y -= 6
    this.rule({ tone: "ink", thickness: 1.5 })
  }

  /** Desde la página 2: el nombre de la clínica y el título del documento. */
  private shortHeader(): void {
    const name = this.lay(this.clinic.tradeName, this.width * 0.55, {
      face: "serif",
      size: 12.75,
      leading: 1.25,
    })[0]
    const title = this.lay(this.options.title, this.width * 0.42, {
      size: SIZE.second,
      tone: "gray",
      leading: 1.3,
      align: "right",
    })[0]
    const height = Math.max(name?.height ?? 0, title?.height ?? 0)
    const top = this.y
    if (name) this.drawLineAt(name, this.left, top, this.width)
    if (title) this.drawLineAt(title, this.left, top - (height - title.height), this.width)
    this.y = top - height - 7.5
    this.rule({ tone: "ink", thickness: 1.5 })
    this.y -= 13
  }

  private footerRight(page: number, pages: number): string {
    return [this.options.docLabel, this.options.patientLabel, `Página ${page} de ${pages}`]
      .filter(Boolean)
      .join(" · ")
  }

  private measureFooter(): void {
    if (this.thermal) {
      this.footerHeight = 0
      return
    }
    const right = this.footerRight(999, 999)
    const rightWidth = Math.min(
      this.fonts.sans.widthOfTextAtSize(printable(right), SIZE.label),
      this.width,
    )
    const note = this.options.legalNote?.trim()
    const leftWidth = Math.max(this.width - rightWidth - 18, this.width * 0.35)
    this.legalLines = note
      ? this.lay(note, leftWidth, { size: SIZE.label, tone: "gray", leading: 1.35 })
      : []
    const rightLines = this.lay(right, Math.min(this.width - 18, this.width), {
      size: SIZE.label,
      leading: 1.35,
    })
    this.footerHeight =
      6 +
      Math.max(
        this.legalLines.reduce((sum, line) => sum + line.height, 0),
        rightLines.reduce((sum, line) => sum + line.height, 0),
      )
  }

  private drawFooters(): void {
    const pages = this.pdf.getPages()
    pages.forEach((page, index) => {
      const text = this.footerRight(index + 1, pages.length)
      this.footers.push(text)
      this.page = page
      const top = BOTTOM + this.footerHeight
      page.drawLine({
        start: { x: this.left, y: top },
        end: { x: this.right, y: top },
        thickness: 0.75,
        color: RULE,
      })
      let cursor = top - 6
      for (const line of this.legalLines) {
        this.drawLineAt(line, this.left, cursor, this.width)
        cursor -= line.height
      }
      const legalWidth = Math.max(0, ...this.legalLines.map((line) => line.width))
      cursor = top - 6
      for (const line of this.lay(text, this.width - (legalWidth ? legalWidth + 18 : 0), {
        size: SIZE.label,
        tone: "gray",
        leading: 1.35,
        align: "right",
      })) {
        this.drawLineAt(line, this.left, cursor, this.width)
        cursor -= line.height
      }
    })
  }

  /** Termina el papel: pie con su número de página, o recorte del rollo. */
  async finish(): Promise<Uint8Array> {
    if (this.thermal) {
      const note = this.options.legalNote?.trim()
      if (note) {
        this.y -= 6
        this.rule({ tone: "ink" })
        this.y -= 4
        this.text(note, { align: "center", size: SIZE.label, leading: 1.35 })
      }
      const height = this.format.height - this.y + THERMAL_PAD
      const bottom = this.y - THERMAL_PAD
      // Se corta la caja de la hoja, no el contenido: el rollo empieza arriba.
      this.page.setMediaBox(0, bottom, this.format.width, height)
      this.page.setCropBox(0, bottom, this.format.width, height)
    } else {
      this.drawFooters()
    }
    return this.pdf.save({ useObjectStreams: false })
  }
}

// --- Fechas y cantidades -------------------------------------------------------

export type Zone = Pick<DocumentClinic, "locale" | "timezone">

/** «30 de octubre de 2026». */
export function dayWords(value: Date | string, zone: Zone): string {
  // Una fecha sin hora (AAAA-MM-DD) es ese día, en cualquier zona.
  const civil = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  return new Intl.DateTimeFormat(zone.locale, {
    timeZone: civil ? "UTC" : zone.timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(civil ? new Date(`${value}T00:00:00Z`) : new Date(value))
}

/** «30 de octubre de 2026, 10:24». */
export function dayTimeWords(value: Date | string, zone: Zone): string {
  const date = new Date(value)
  const time = new Intl.DateTimeFormat(zone.locale, {
    timeZone: zone.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
  return `${dayWords(date, zone)}, ${time}`
}

/** «30/10/2026, 11:42»: lo corto de la térmica. */
export function shortDayTime(value: Date | string, zone: Zone): string {
  return new Intl.DateTimeFormat(zone.locale, {
    timeZone: zone.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

/** «HC-000001». */
export function chartNumber(patientNumber: number): string {
  return `HC-${String(patientNumber).padStart(6, "0")}`
}

/** «36 años»: la edad el día que se escribe, en la zona de la clínica. */
export function ageWords(
  birthDate: string | null | undefined,
  zone: Zone,
  at: Date = new Date(),
): string | null {
  if (!birthDate) return null
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)
  const [y1, m1, d1] = birthDate.split("-").map(Number) as [number, number, number]
  const [y2, m2, d2] = today.split("-").map(Number) as [number, number, number]
  let years = y2 - y1
  if (m2 < m1 || (m2 === m1 && d2 < d1)) years -= 1
  if (years < 0) return null
  if (years === 0) {
    const months = (y2 - y1) * 12 + m2 - m1 - (d2 < d1 ? 1 : 0)
    return months === 1 ? "1 mes" : `${Math.max(months, 0)} meses`
  }
  return years === 1 ? "1 año" : `${years} años`
}

const UNITS = [
  "cero",
  "uno",
  "dos",
  "tres",
  "cuatro",
  "cinco",
  "seis",
  "siete",
  "ocho",
  "nueve",
  "diez",
  "once",
  "doce",
  "trece",
  "catorce",
  "quince",
  "dieciséis",
  "diecisiete",
  "dieciocho",
  "diecinueve",
  "veinte",
  "veintiuno",
  "veintidós",
  "veintitrés",
  "veinticuatro",
  "veinticinco",
  "veintiséis",
  "veintisiete",
  "veintiocho",
  "veintinueve",
]
const TENS = [
  "",
  "",
  "",
  "treinta",
  "cuarenta",
  "cincuenta",
  "sesenta",
  "setenta",
  "ochenta",
  "noventa",
]
const HUNDREDS = [
  "",
  "ciento",
  "doscientos",
  "trescientos",
  "cuatrocientos",
  "quinientos",
  "seiscientos",
  "setecientos",
  "ochocientos",
  "novecientos",
]

/** Un entero en letras, como se escribe en una receta: «nueve», «ciento veinte». */
export function numberInWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999_999) return String(value)
  if (value < 30) return UNITS[value] ?? String(value)
  if (value < 100) {
    const rest = value % 10
    return `${TENS[Math.floor(value / 10)]}${rest ? ` y ${UNITS[rest]}` : ""}`
  }
  if (value === 100) return "cien"
  if (value < 1000) {
    const rest = value % 100
    return `${HUNDREDS[Math.floor(value / 100)]}${rest ? ` ${numberInWords(rest)}` : ""}`
  }
  const thousands = Math.floor(value / 1000)
  const rest = value % 1000
  return `${thousands === 1 ? "mil" : `${numberInWords(thousands)} mil`}${rest ? ` ${numberInWords(rest)}` : ""}`
}

export function strokesOf(value: unknown): Strokes | null {
  if (value && typeof value === "object" && "strokes" in value && Array.isArray(value.strokes))
    return value.strokes as Strokes
  return null
}
