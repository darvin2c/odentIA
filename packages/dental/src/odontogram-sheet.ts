/**
 * El gráfico del odontograma de la norma (NTS 188-MINSA/DGIESP-2022, solo en
 * clínicas de Perú; ADR 0036) como dibujo puro: por cada fila, las piezas con su
 * franja de números, los recuadros de siglas, las coronas de 5 zonas, las raíces
 * y lo que cruza varias piezas (tramos y parejas). El gráfico va en negro (5.17) y
 * los hallazgos en rojo o azul (5.12 y 5.13).
 *
 * Devuelve primitivas (líneas, rectángulos, polígonos, trazos, círculos, elipses y
 * textos) en el orden en que se pintan, en unidades del dibujo de cada fila (una
 * pieza mide 60 de ancho, el eje y hacia abajo). Lo dibujan igual la pantalla (SVG)
 * y el servidor (el PDF del odontograma firmado): así la hoja que se ve, la que se
 * imprime y la que va en la copia de la historia no se separan. Las flechas son
 * triángulos ya calculados, porque el PDF no tiene marcadores.
 */
import { FDI_ADULT_ROWS, FDI_CHILD_ROWS, toothTypeOf } from "./anatomy.js"
import { findingAbbreviation, findingColor } from "./findings.js"
import { frontSpecOf } from "./tooth-front.js"
import type { FindingDetails } from "./types.js"

/** Lo que el dibujo necesita de cada hallazgo vigente (el servidor entrega la instantánea firmada). */
export interface SheetEntry {
  id: string
  toothNumber: number
  condition: string
  surface?: string | null
  details?: FindingDetails
  note?: string | null
  needsReview?: boolean
}

/** Las tintas de la norma: el gráfico en negro y los hallazgos en rojo o azul. */
export const SHEET_INK = {
  ink: "#111111",
  red: "#dc2626",
  blue: "#2563eb",
  paper: "#ffffff",
} as const

/** Cómo se pinta una primitiva; lo que no se dice no se pinta (sin relleno ni trazo). */
export interface SheetPaint {
  stroke?: string
  strokeWidth?: number
  fill?: string
  fillOpacity?: number
  cap?: "round"
  join?: "round"
}

export type SheetPoint = readonly [number, number]

export type SheetShape =
  | ({ kind: "line"; x1: number; y1: number; x2: number; y2: number } & SheetPaint)
  | ({
      kind: "rect"
      x: number
      y: number
      width: number
      height: number
      rx?: number
    } & SheetPaint)
  | ({ kind: "polygon"; points: SheetPoint[] } & SheetPaint)
  | ({ kind: "polyline"; points: SheetPoint[] } & SheetPaint)
  /** Un trazo con líneas y curvas (`M`, `L`, `Q`), con el eje y hacia abajo como en SVG. */
  | ({ kind: "path"; d: string } & SheetPaint)
  | ({ kind: "circle"; cx: number; cy: number; r: number } & SheetPaint)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number } & SheetPaint)
  | {
      kind: "text"
      x: number
      y: number
      text: string
      size: number
      fill: string
      /** Centrado en `x`. `central`: `y` es su medio; `alphabetic`: `y` es su línea base. */
      baseline: "central" | "alphabetic"
    }

export interface SheetRow {
  caption: string
  upper: boolean
  teeth: readonly number[]
  width: number
  height: number
  shapes: SheetShape[]
}

export interface OdontogramSheetScene {
  /** Permanente superior, temporal superior, temporal inferior y permanente inferior. */
  rows: SheetRow[]
  /** Lo que va en «Especificaciones» y en «Observaciones», una línea por renglón. */
  specifications: string[]
  observations: string[]
}

/** Las cuatro filas de la hoja, como se leen de frente a la persona. */
export const ODONTOGRAM_SHEET_ROWS: ReadonlyArray<{
  teeth: readonly number[]
  upper: boolean
  caption: string
}> = [
  { teeth: FDI_ADULT_ROWS[0] ?? [], upper: true, caption: "Dentición permanente superior" },
  { teeth: FDI_CHILD_ROWS[0] ?? [], upper: true, caption: "Dentición temporal superior" },
  { teeth: FDI_CHILD_ROWS[1] ?? [], upper: false, caption: "Dentición temporal inferior" },
  { teeth: FDI_ADULT_ROWS[1] ?? [], upper: false, caption: "Dentición permanente inferior" },
]

const { ink: INK, red: RED, blue: BLUE, paper: PAPER } = SHEET_INK

const SPAN_CONDITIONS: Record<string, true> = {
  fixed_partial_denture: true,
  complete_denture: true,
  removable_partial_denture: true,
  fixed_orthodontic_appliance: true,
  removable_orthodontic_appliance: true,
  edentulous_arch: true,
}

const PAIR_CONDITIONS: Record<string, true> = {
  diastema: true,
  supernumerary_tooth: true,
  transposition: true,
  fusion: true,
}

const FILL_CONDITIONS: Record<string, true> = { caries: true, definitive_restoration: true }
const CONTOUR_CONDITIONS: Record<string, true> = { temporary_restoration: true, tooth_wear: true }

/** Ancho de cada pieza en el dibujo. */
export const SHEET_CELL = 60
const CELL = SHEET_CELL
const NUM_H = 24
const ROOT_LEN = 26
const CROWN_W = 46
const CROWN_H = 44
const MID_MARGIN = 18

function paintOf(entry: SheetEntry): string | null {
  if (entry.needsReview) return null
  const color = findingColor(entry)
  if (color === "red") return RED
  if (color === "blue") return BLUE
  return null
}

/** La sigla del hallazgo; una variante que la norma no nombra no traba el dibujo. */
export function sheetAbbreviation(entry: SheetEntry): string {
  try {
    return findingAbbreviation(entry) ?? ""
  } catch {
    return ""
  }
}

function involvedTeeth(entry: SheetEntry): number[] {
  const related = entry.details?.relatedTeeth
  if (related && related.length > 0) return [...new Set([entry.toothNumber, ...related])]
  return [entry.toothNumber]
}

function isAnteriorTooth(tooth: number): boolean {
  const kind = toothTypeOf(tooth)
  return kind === "incisor" || kind === "canine"
}

interface GraphicEntry {
  entry: SheetEntry
  paint: string
}

function graphicOf(live: SheetEntry[], tooth: number): GraphicEntry[] {
  const out: GraphicEntry[] = []
  for (const entry of live) {
    if (entry.toothNumber !== tooth) continue
    const paint = paintOf(entry)
    if (paint) out.push({ entry, paint })
  }
  return out
}

interface CrownGeom {
  x: number
  y: number
  cx: number
}

/** Polígono de la zona de una superficie (claves en inglés) sobre la corona cuadrada. */
function zonePolygon(
  surface: string,
  tooth: number,
  index: number,
  count: number,
  g: CrownGeom,
): SheetPoint[] {
  const { x, y, cx } = g
  const yb = y + CROWN_H
  const mesialOnRight = index < count / 2
  const leftKey = mesialOnRight ? "distal" : "mesial"
  const outerKey = isAnteriorTooth(tooth) ? "facial" : "buccal"
  const quadrant = Math.trunc(tooth / 10)
  const upperQuadrant = quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6
  const innerKey = upperQuadrant ? "palatal" : "lingual"
  const centralKey = isAnteriorTooth(tooth) ? "incisal" : "occlusal"
  const ix0 = cx - 9
  const ix1 = cx + 9
  const iy0 = y + 14
  const iy1 = yb - 14
  const topKey = upperQuadrant ? outerKey : innerKey
  if (surface === topKey)
    return [
      [x, y],
      [x + CROWN_W, y],
      [ix1, iy0],
      [ix0, iy0],
    ]
  if (surface === (topKey === outerKey ? innerKey : outerKey))
    return [
      [x, yb],
      [x + CROWN_W, yb],
      [ix1, iy1],
      [ix0, iy1],
    ]
  if (surface === leftKey)
    return [
      [x, y],
      [ix0, iy0],
      [ix0, iy1],
      [x, yb],
    ]
  if (surface === centralKey)
    return [
      [ix0, iy0],
      [ix1, iy0],
      [ix1, iy1],
      [ix0, iy1],
    ]
  return [
    [x + CROWN_W, y],
    [ix1, iy0],
    [ix1, iy1],
    [x + CROWN_W, yb],
  ]
}

/**
 * La punta de flecha al final de un trazo, como el marcador de antes (6 × 5 en un
 * lugar de 4 × 3,4, apoyado en 4,6 · 2,5): un triángulo girado hacia donde termina.
 */
function arrowHead(tip: SheetPoint, from: SheetPoint, paint: string): SheetShape {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const s = 4 / 6
  const at = ([dx, dy]: SheetPoint): SheetPoint => {
    const px = dx * s
    const py = dy * s
    return [tip[0] + px * cos - py * sin, tip[1] + px * sin + py * cos]
  }
  return {
    kind: "polygon",
    points: [at([-4.2, -2.1]), at([1, 0]), at([-4.2, 2.1])],
    fill: paint,
  }
}

/** El centro de cada raíz de la pieza, como se dibujan: triángulos iguales bajo la corona. */
function rootCenters(g: CrownGeom, roots: number): number[] {
  return Array.from({ length: roots }, (_, r) => g.x + ((r + 0.5) * CROWN_W) / roots)
}

/**
 * Lo propio de cada hallazgo sobre su pieza: ausente, corona, endodoncia, giro… Lo que va «en la
 * raíz» va dentro de cada una (NTS 188: la endodoncia, una línea vertical en la raíz): con dos
 * raíces, el centro de la pieza es la furca, entre las dos.
 */
function crownSymbols(
  graphic: GraphicEntry[],
  g: CrownGeom,
  upper: boolean,
  mesialOnRight: boolean,
  roots: number,
): SheetShape[] {
  const { x, y, cx } = g
  const yb = y + CROWN_H
  const mid = y + CROWN_H / 2
  const centers = rootCenters(g, roots)
  // El espigo va en una sola raíz: la del centro con una o tres, la distal con dos (la de la
  // muela de abajo que lo recibe).
  const postX = roots === 2 ? (centers[mesialOnRight ? 0 : 1] ?? cx) : cx
  const out: SheetShape[] = []
  for (const { entry, paint } of graphic) {
    switch (entry.condition) {
      case "missing_tooth": {
        const line = { stroke: paint, strokeWidth: 2.4, cap: "round" } as const
        out.push(
          {
            kind: "line",
            x1: x + 4,
            y1: upper ? y - ROOT_LEN : y,
            x2: x + CROWN_W - 4,
            y2: upper ? yb : yb + ROOT_LEN,
            ...line,
          },
          {
            kind: "line",
            x1: x + CROWN_W - 4,
            y1: upper ? y - ROOT_LEN : y,
            x2: x + 4,
            y2: upper ? yb : yb + ROOT_LEN,
            ...line,
          },
        )
        break
      }
      case "crown":
      case "temporary_crown":
        out.push({
          kind: "rect",
          x: x - 2,
          y: y - 2,
          width: CROWN_W + 4,
          height: CROWN_H + 4,
          stroke: paint,
          strokeWidth: 1.8,
        })
        break
      case "post_and_core":
        out.push(
          {
            kind: "line",
            x1: postX,
            y1: upper ? y - ROOT_LEN : y,
            x2: postX,
            y2: upper ? yb : yb + ROOT_LEN,
            stroke: paint,
            strokeWidth: 1.8,
          },
          {
            kind: "rect",
            x: cx - 7,
            y: mid - 8,
            width: 14,
            height: 16,
            stroke: paint,
            strokeWidth: 1.8,
          },
        )
        break
      case "root_canal_treatment":
        for (const rx of centers)
          out.push({
            kind: "line",
            x1: rx,
            y1: upper ? y - ROOT_LEN : y,
            x2: rx,
            y2: upper ? yb : yb + ROOT_LEN,
            stroke: paint,
            strokeWidth: 2,
          })
        break
      case "pulpotomy":
        out.push({
          kind: "rect",
          x: cx - 6,
          y: y + 8,
          width: 12,
          height: 14,
          rx: 4,
          fill: paint,
          fillOpacity: 0.35,
          stroke: paint,
          strokeWidth: 1.6,
        })
        break
      case "rotation": {
        const clockwise = entry.details?.direction === "clockwise"
        const forward = upper ? !clockwise : clockwise
        const baseline = upper ? yb + 3 : y - 3
        const control: SheetPoint = [cx, upper ? yb + 18 : y - 18]
        const end: SheetPoint = [cx + (forward ? 12 : -12), baseline]
        out.push(
          {
            kind: "path",
            d: `M ${cx + (forward ? -12 : 12)} ${baseline} Q ${control[0]} ${control[1]} ${end[0]} ${end[1]}`,
            stroke: paint,
            strokeWidth: 1.6,
          },
          arrowHead(end, control, paint),
        )
        break
      }
      case "erupting_tooth": {
        const points = (
          [
            [0, 6],
            [-4, 14],
            [3, 20],
            [-2, 26],
            [1, 32],
          ] as const
        ).map(([dx, dy]): SheetPoint => [cx + dx, upper ? y + dy : yb - dy])
        out.push(
          {
            kind: "polyline",
            points,
            stroke: paint,
            strokeWidth: 1.6,
            cap: "round",
            join: "round",
          },
          arrowHead(points[points.length - 1]!, points[points.length - 2]!, paint),
        )
        break
      }
      case "sealant": {
        if (entry.details?.drawing?.length) break
        let sx = cx
        let sy = mid
        if (entry.surface === "mesial" || entry.surface === "distal")
          sx += ((entry.surface === "mesial") === mesialOnRight ? 1 : -1) * 16
        else if (entry.surface === "buccal" || entry.surface === "facial")
          sy = upper ? y + 7 : yb - 7
        else if (entry.surface === "palatal" || entry.surface === "lingual")
          sy = upper ? yb - 7 : y + 7
        out.push({
          kind: "path",
          d: `M${sx - 5},${sy + 2} L${sx - 1},${sy - 1} L${sx + 4},${sy + 2} M${sx - 1},${sy - 1} L${sx + 1},${sy - 4}`,
          stroke: paint,
          strokeWidth: 2,
          cap: "round",
        })
        break
      }
      case "peg_tooth":
        out.push({
          kind: "polygon",
          points: [
            [cx, upper ? y - ROOT_LEN - 10 : yb + ROOT_LEN + 10],
            [cx - 5, upper ? y - ROOT_LEN - 2 : yb + ROOT_LEN + 2],
            [cx + 5, upper ? y - ROOT_LEN - 2 : yb + ROOT_LEN + 2],
          ],
          stroke: paint,
          strokeWidth: 1.6,
        })
        break
      default:
        break
    }
  }
  return out
}

/** Trazos clínicos guardados: la mitad coronal va a la corona cuadrada y la radicular a las raíces. */
function drawingStrokes(graphic: GraphicEntry[], g: CrownGeom, upper: boolean): SheetShape[] {
  const { x, y } = g
  const mapPoint = (p: number[]): SheetPoint => {
    const px = ((p[0] ?? 0) * 24) / 100
    const py = ((p[1] ?? 0) * 28) / 100
    const mappedX = x + ((px - 5) / 14) * CROWN_W
    const mappedY =
      py <= 13.5
        ? upper
          ? y + CROWN_H - ((py - 2.5) / 11) * CROWN_H
          : y + ((py - 2.5) / 11) * CROWN_H
        : upper
          ? y - ((py - 13.5) / 14.5) * ROOT_LEN
          : y + CROWN_H + ((py - 13.5) / 14.5) * ROOT_LEN
    // Al décimo, como se guardaba el trazo en el dibujo.
    return [Number(mappedX.toFixed(1)), Number(mappedY.toFixed(1))]
  }
  return graphic.flatMap(({ entry, paint }): SheetShape[] => {
    const drawing = entry.details?.drawing
    if (!drawing) return []
    return drawing.flatMap((stroke): SheetShape[] => {
      if (stroke.length === 0) return []
      if (stroke.length === 1) {
        const [sx, sy] = mapPoint(stroke[0]!)
        return [{ kind: "circle", cx: sx, cy: sy, r: 1.6, fill: paint }]
      }
      return [
        {
          kind: "polyline",
          points: stroke.map(mapPoint),
          ...(FILL_CONDITIONS[entry.condition] && stroke.length >= 3 ? { fill: paint } : {}),
          stroke: paint,
          strokeWidth: 1.6,
          cap: "round",
          join: "round",
        },
      ]
    })
  })
}

interface SpanDraw {
  condition: string
  paint: string
  x0: number
  x1: number
  abutments: number[]
}

function spansFor(live: SheetEntry[], row: readonly number[]): SpanDraw[] {
  const out: SpanDraw[] = []
  const seen = new Set<string>()
  for (const entry of live) {
    if (!SPAN_CONDITIONS[entry.condition] || seen.has(entry.id)) continue
    const paint = paintOf(entry)
    if (!paint) continue
    seen.add(entry.id)
    const idxs = involvedTeeth(entry)
      .filter((t) => row.includes(t))
      .map((t) => row.indexOf(t))
      .sort((a, b) => a - b)
    if (idxs.length === 0) continue
    const abutments = (entry.details?.abutmentTeeth ?? [])
      .filter((t) => row.includes(t))
      .map((t) => row.indexOf(t) * CELL + CELL / 2)
    out.push({
      condition: entry.condition,
      paint,
      x0: idxs[0]! * CELL + 8,
      x1: idxs[idxs.length - 1]! * CELL + CELL - 8,
      abutments,
    })
  }
  return out
}

interface PairDraw {
  condition: string
  paint: string
  gap: number
  right: number
}

function pairsFor(live: SheetEntry[], row: readonly number[]): PairDraw[] {
  return live.flatMap((entry) => {
    if (!PAIR_CONDITIONS[entry.condition]) return []
    const paint = paintOf(entry)
    const indices = involvedTeeth(entry)
      .map((tooth) => row.indexOf(tooth))
      .sort((a, b) => a - b)
    if (!paint || indices.length !== 2 || indices[0]! < 0) return []
    return [{ condition: entry.condition, paint, gap: indices[0]!, right: indices[1]! }]
  })
}

function spanShapes(s: SpanDraw, crownLineY: number, apexY: number): SheetShape[] {
  const line = { stroke: s.paint, strokeWidth: 2.4, cap: "round" } as const
  if (s.condition === "edentulous_arch")
    return [{ kind: "line", x1: s.x0, y1: crownLineY, x2: s.x1, y2: crownLineY, ...line }]
  if (s.condition === "removable_orthodontic_appliance") {
    const points: SheetPoint[] = []
    let up = true
    for (let px = s.x0; px <= s.x1; px += 12) {
      points.push([px, apexY + (up ? -8 : 8)])
      up = !up
    }
    points.push([s.x1, apexY])
    return [{ kind: "polyline", points, ...line, strokeWidth: 2, join: "round" }]
  }
  if (s.condition === "fixed_orthodontic_appliance")
    return [
      { kind: "line", x1: s.x0, y1: apexY, x2: s.x1, y2: apexY, ...line },
      { kind: "rect", x: s.x0 - 7, y: apexY - 8, width: 14, height: 16, ...line },
      { kind: "rect", x: s.x1 - 7, y: apexY - 8, width: 14, height: 16, ...line },
      ...[s.x0, s.x1].map(
        (cx): SheetShape => ({
          kind: "path",
          d: `M${cx - 4},${apexY - 5} L${cx + 4},${apexY + 5} M${cx + 4},${apexY - 5} L${cx - 4},${apexY + 5}`,
          ...line,
        }),
      ),
    ]
  if (s.condition === "fixed_partial_denture")
    return [
      { kind: "line", x1: s.x0, y1: apexY, x2: s.x1, y2: apexY, ...line },
      ...s.abutments.map(
        (ax): SheetShape => ({
          kind: "line",
          x1: ax,
          y1: apexY - 12,
          x2: ax,
          y2: apexY + 12,
          ...line,
        }),
      ),
    ]
  return [
    { kind: "line", x1: s.x0, y1: apexY - 6, x2: s.x1, y2: apexY - 6, ...line },
    { kind: "line", x1: s.x0, y1: apexY + 6, x2: s.x1, y2: apexY + 6, ...line },
  ]
}

function pairShapes(p: PairDraw, numY: number, apexY: number, crownTop: number): SheetShape[] {
  const bx = ((p.gap + p.right + 1) * CELL) / 2
  if (p.condition === "fusion") {
    const leftX = p.gap * CELL + CELL / 2
    const rightX = p.right * CELL + CELL / 2
    return [
      { kind: "ellipse", cx: leftX + 9, cy: numY, rx: 23, ry: 14, stroke: p.paint, strokeWidth: 2 },
      {
        kind: "ellipse",
        cx: rightX - 9,
        cy: numY,
        rx: 23,
        ry: 14,
        stroke: p.paint,
        strokeWidth: 2,
      },
    ]
  }
  if (p.condition === "transposition") {
    const leftX = p.gap * CELL + CELL / 2
    const rightX = p.right * CELL + CELL / 2
    const control: SheetPoint = [bx, numY + 15]
    const curve = (from: number, to: number): SheetShape[] => [
      {
        kind: "path",
        d: `M ${from} ${numY - 7} Q ${bx} ${numY + 15} ${to} ${numY + 7}`,
        stroke: p.paint,
        strokeWidth: 1.8,
      },
      arrowHead([to, numY + 7], control, p.paint),
    ]
    return [...curve(leftX, rightX), ...curve(rightX, leftX)]
  }
  if (p.condition === "supernumerary_tooth")
    return [
      { kind: "circle", cx: bx, cy: apexY, r: 9, fill: PAPER, stroke: p.paint, strokeWidth: 2 },
      { kind: "text", x: bx, y: apexY, text: "S", size: 11, fill: p.paint, baseline: "central" },
    ]
  const my = crownTop + CROWN_H / 2
  return [
    {
      kind: "path",
      d: `M ${bx - 5} ${my - 12} Q ${bx + 3} ${my} ${bx - 5} ${my + 12}`,
      stroke: p.paint,
      strokeWidth: 2,
    },
    {
      kind: "path",
      d: `M ${bx + 5} ${my - 12} Q ${bx - 3} ${my} ${bx + 5} ${my + 12}`,
      stroke: p.paint,
      strokeWidth: 2,
    },
  ]
}

/** Una fila de la hoja: sus piezas y lo que tienen, en el orden en que se pintan. */
export function odontogramSheetRow(
  teeth: readonly number[],
  upper: boolean,
  live: SheetEntry[],
): Omit<SheetRow, "caption"> {
  const n = teeth.length
  const width = n * CELL
  const ownAbbr = teeth.map((tooth) => {
    const labels = new Map<string, { text: string; paint: string }>()
    for (const entry of live) {
      if (entry.toothNumber !== tooth || entry.needsReview) continue
      const text = sheetAbbreviation(entry)
      const paint = paintOf(entry)
      if (text && paint) labels.set(`${text}:${paint}`, { text, paint })
    }
    return [...labels.values()]
  })
  const maxAbbr = Math.max(1, ...ownAbbr.map((a) => a.length))
  const siglaH = 20 + 12 * maxAbbr
  const crownTop = upper ? siglaH + NUM_H + 12 + ROOT_LEN : MID_MARGIN
  const crownBottom = crownTop + CROWN_H
  const height = upper ? crownBottom + MID_MARGIN : crownBottom + ROOT_LEN + 12 + NUM_H + siglaH
  const numY = upper ? siglaH + NUM_H / 2 : crownBottom + ROOT_LEN + 12 + NUM_H / 2
  const siglaY = upper ? 0 : height - siglaH
  const apexY = upper ? crownTop - ROOT_LEN - 5 : crownBottom + ROOT_LEN + 5
  const crownLineY = (crownTop + crownBottom) / 2
  const geom = (i: number): CrownGeom => ({
    x: i * CELL + (CELL - CROWN_W) / 2,
    y: crownTop,
    cx: i * CELL + CELL / 2,
  })
  const shapes: SheetShape[] = []

  teeth.forEach((tooth, i) => {
    shapes.push({
      kind: "text",
      x: i * CELL + CELL / 2,
      y: numY,
      text: String(tooth),
      size: 13,
      fill: INK,
      baseline: "central",
    })
  })

  teeth.forEach((tooth, i) => {
    const g = geom(i)
    const graphic = graphicOf(live, tooth)
    const fills = new Map<string, string>()
    for (const { entry, paint } of graphic) {
      if (FILL_CONDITIONS[entry.condition] && entry.surface && !fills.has(entry.surface))
        fills.set(entry.surface, paint)
    }
    const contours = new Map<string, string>()
    for (const { entry, paint } of graphic) {
      if (CONTOUR_CONDITIONS[entry.condition] && entry.surface && !contours.has(entry.surface))
        contours.set(entry.surface, paint)
    }
    // Las raíces de cada pieza, como la vista de frente (`tooth-front.ts`, Wheeler): las muelas
    // de abajo tienen dos, las de arriba tres; el primer premolar de arriba, dos.
    const roots = frontSpecOf(tooth).roots
    for (let r = 0; r < roots; r++) {
      const x0 = g.x + (r * CROWN_W) / roots
      const x1 = x0 + CROWN_W / roots
      const baseY = upper ? g.y : g.y + CROWN_H
      const tipY = upper ? g.y - ROOT_LEN : g.y + CROWN_H + ROOT_LEN
      shapes.push({
        kind: "path",
        d: `M${x0},${baseY} L${(x0 + x1) / 2},${tipY} L${x1},${baseY}`,
        stroke: INK,
        strokeWidth: 1.6,
      })
    }
    shapes.push({
      kind: "rect",
      x: g.x,
      y: g.y,
      width: CROWN_W,
      height: CROWN_H,
      fill: PAPER,
      stroke: INK,
      strokeWidth: 1.6,
    })
    for (const [surface, paint] of fills)
      shapes.push({ kind: "polygon", points: zonePolygon(surface, tooth, i, n, g), fill: paint })
    const fine = { stroke: INK, strokeWidth: 0.8 } as const
    shapes.push(
      { kind: "rect", x: g.cx - 9, y: g.y + 14, width: 18, height: CROWN_H - 28, ...fine },
      { kind: "line", x1: g.x, y1: g.y, x2: g.cx - 9, y2: g.y + 14, ...fine },
      { kind: "line", x1: g.x + CROWN_W, y1: g.y, x2: g.cx + 9, y2: g.y + 14, ...fine },
      { kind: "line", x1: g.x, y1: g.y + CROWN_H, x2: g.cx - 9, y2: g.y + CROWN_H - 14, ...fine },
      {
        kind: "line",
        x1: g.x + CROWN_W,
        y1: g.y + CROWN_H,
        x2: g.cx + 9,
        y2: g.y + CROWN_H - 14,
        ...fine,
      },
    )
    for (const [surface, paint] of contours)
      shapes.push({
        kind: "polygon",
        points: zonePolygon(surface, tooth, i, n, g),
        stroke: paint,
        strokeWidth: 2,
      })
    shapes.push(...crownSymbols(graphic, g, upper, i < n / 2, roots))
    shapes.push(...drawingStrokes(graphic, g, upper))
    for (const { entry, paint } of graphic) {
      if (entry.condition !== "extruded_tooth" && entry.condition !== "intruded_tooth") continue
      const ay = upper ? g.y + CROWN_H + 5 : g.y - 5
      const outward = entry.condition === "extruded_tooth"
      const y1 = upper ? (outward ? ay : ay + 11) : outward ? ay : ay - 11
      const y2 = upper ? (outward ? ay + 11 : ay) : outward ? ay - 11 : ay
      shapes.push(
        { kind: "line", x1: g.cx, y1, x2: g.cx, y2, stroke: paint, strokeWidth: 1.6 },
        arrowHead([g.cx, y2], [g.cx, y1], paint),
      )
    }
  })

  teeth.forEach((_, i) => {
    shapes.push({
      kind: "rect",
      x: i * CELL,
      y: siglaY,
      width: CELL,
      height: siglaH,
      stroke: INK,
      strokeWidth: 1.3,
    })
  })
  teeth.forEach((tooth, i) => {
    for (const entry of live) {
      if (entry.toothNumber !== tooth || entry.condition !== "gemination") continue
      const paint = paintOf(entry)
      shapes.push({
        kind: "circle",
        cx: i * CELL + CELL / 2,
        cy: numY,
        r: 14,
        ...(paint ? { stroke: paint } : {}),
        strokeWidth: 2,
      })
    }
  })
  ownAbbr.forEach((labels, i) => {
    labels.forEach(({ text, paint }, line) => {
      shapes.push({
        kind: "text",
        x: i * CELL + CELL / 2,
        y: siglaY + 14 + line * 12,
        text,
        size: 10,
        fill: paint,
        baseline: "alphabetic",
      })
    })
  })
  for (const span of spansFor(live, teeth)) shapes.push(...spanShapes(span, crownLineY, apexY))
  for (const pair of pairsFor(live, teeth)) shapes.push(...pairShapes(pair, numY, apexY, crownTop))

  return { upper, teeth, width, height, shapes }
}

/**
 * La hoja entera: las cuatro filas y lo escrito en «Especificaciones» y
 * «Observaciones» (las notas de la hoja y las de cada hallazgo, una sola vez).
 */
export function odontogramSheetScene(
  entries: SheetEntry[],
  notes: { specifications?: string | null; observations?: string | null } = {},
): OdontogramSheetScene {
  const specLines: string[] = []
  if (notes.specifications) specLines.push(notes.specifications)
  const obsLines: string[] = []
  if (notes.observations) obsLines.push(notes.observations)
  for (const entry of entries) {
    const abbr = sheetAbbreviation(entry)
    const tag = `Pieza ${entry.toothNumber}${abbr ? ` ${abbr}` : ""}`
    const spec = entry.details?.specifications
    if (spec) specLines.push(`${tag}: ${spec}`)
    const obs = entry.details?.observations
    if (obs) obsLines.push(`${tag}: ${obs}`)
    if (entry.note)
      (entry.condition === "clinical_observation" ? obsLines : specLines).push(
        `${tag}: ${entry.note}`,
      )
    if (entry.needsReview) obsLines.push(`${tag}: registro previo en revisión.`)
  }
  return {
    rows: ODONTOGRAM_SHEET_ROWS.map((row) => ({
      caption: row.caption,
      ...odontogramSheetRow(row.teeth, row.upper, entries),
    })),
    // Una caries de dos caras se guarda como una fila por cara: su nota se escribe una sola vez.
    specifications: [...new Set(specLines)],
    observations: [...new Set(obsLines)],
  }
}

/** Los puntos de un polígono o un trazo como los escribe SVG («x,y x,y»). */
export function sheetPoints(points: readonly SheetPoint[]): string {
  return points.map(([x, y]) => `${x},${y}`).join(" ")
}
