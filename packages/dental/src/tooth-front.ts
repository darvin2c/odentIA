/**
 * La boca vista de frente (lienzo del 23 nov 2026, «Odontograma con raíz»): cada pieza con
 * su corona y su raíz dentro de la encía, para ver lo que el arco de arriba no muestra (el
 * perno, los conductos, el implante, el puente, el resto radicular, la pieza retenida).
 *
 * Medidas en mm por pieza (ancho mesiodistal, alto de la corona y largo de la raíz), tomadas
 * de las tablas de anatomía dental de uso común (Wheeler); cuántas raíces se ven de frente:
 * dos en el primer premolar superior y en los molares inferiores, tres en los superiores (dos
 * vestibulares y la palatina detrás). Todo en px de un dibujo a `scale` px por mm.
 */
import { isPrimaryTooth, isUpperTooth } from "./anatomy.js"

export type FrontKind = "incisor" | "canine" | "premolar" | "molar"

export interface FrontSpec {
  /** Ancho mesiodistal de la corona. */
  mm: number
  kind: FrontKind
  /** Raíces que se ven de frente. */
  roots: 1 | 2 | 3
  /** Largo de la raíz, en mm. */
  root: number
  /** Temporal: sus molares tienen raíces cortas, finas y abiertas. */
  primary?: boolean
}

type Row = Record<number, FrontSpec>

const PERMANENT: { upper: Row; lower: Row } = {
  upper: {
    1: { mm: 8.6, kind: "incisor", roots: 1, root: 13 },
    2: { mm: 6.6, kind: "incisor", roots: 1, root: 13 },
    3: { mm: 7.6, kind: "canine", roots: 1, root: 15 },
    4: { mm: 7, kind: "premolar", roots: 2, root: 14 },
    5: { mm: 6.6, kind: "premolar", roots: 1, root: 14 },
    6: { mm: 10.2, kind: "molar", roots: 3, root: 13 },
    7: { mm: 9.2, kind: "molar", roots: 3, root: 12 },
    8: { mm: 8.6, kind: "molar", roots: 3, root: 11 },
  },
  lower: {
    1: { mm: 5.3, kind: "incisor", roots: 1, root: 12.5 },
    2: { mm: 5.9, kind: "incisor", roots: 1, root: 14 },
    3: { mm: 7, kind: "canine", roots: 1, root: 14.5 },
    4: { mm: 7, kind: "premolar", roots: 1, root: 14 },
    5: { mm: 7.1, kind: "premolar", roots: 1, root: 14.5 },
    6: { mm: 11.2, kind: "molar", roots: 2, root: 14 },
    7: { mm: 10.5, kind: "molar", roots: 2, root: 13 },
    8: { mm: 10, kind: "molar", roots: 2, root: 11 },
  },
}

const PRIMARY: { upper: Row; lower: Row } = {
  upper: {
    1: { mm: 6.5, kind: "incisor", roots: 1, root: 10 },
    2: { mm: 5.2, kind: "incisor", roots: 1, root: 10 },
    3: { mm: 7, kind: "canine", roots: 1, root: 13 },
    4: { mm: 7.3, kind: "molar", roots: 3, root: 10 },
    5: { mm: 8.2, kind: "molar", roots: 3, root: 11 },
  },
  lower: {
    1: { mm: 4.2, kind: "incisor", roots: 1, root: 9 },
    2: { mm: 4.7, kind: "incisor", roots: 1, root: 10 },
    3: { mm: 5.9, kind: "canine", roots: 1, root: 11.5 },
    4: { mm: 7.8, kind: "molar", roots: 2, root: 9.5 },
    5: { mm: 9.9, kind: "molar", roots: 2, root: 10 },
  },
}

/**
 * El alto de la corona, el mismo en toda la fila: así los bordes y los cuellos quedan en línea y
 * la encía sigue un festón parejo, como en los odontogramas de frente. Con el alto real de cada
 * pieza (el canino más alto que el molar) la fila se veía desordenada (23 nov, en producción).
 */
function crownMm(tooth: number): number {
  return isPrimaryTooth(tooth) ? 6 : 9
}

/**
 * El ancho medio de una pieza permanente (mm): con él se suaviza la diferencia de anchos.
 */
const WIDTH_REF_MM = 7.9

/**
 * El ancho con que se dibuja la pieza, en mm: la media geométrica de su ancho real y el de una pieza
 * media. La muela sigue más ancha que la incisiva (1,45 veces y no 2,1), como en los odontogramas de
 * frente: con el ancho real la incisiva quedaba angosta para el dedo y la fila de 16 muy ancha, y el
 * arco, a la altura de su fila, se veía chico al lado (24 nov, en producción). El arco usa el mismo.
 */
export function drawnWidthMm(tooth: number): number {
  return Math.sqrt(frontSpecOf(tooth).mm * WIDTH_REF_MM)
}

/** Las medidas de la pieza FDI (permanente o temporal). */
export function frontSpecOf(tooth: number): FrontSpec {
  const primary = isPrimaryTooth(tooth)
  const table = primary ? PRIMARY : PERMANENT
  const spec = table[isUpperTooth(tooth) ? "upper" : "lower"][tooth % 10]
  if (!spec) throw new RangeError(`Pieza FDI inválida: ${tooth}`)
  return primary ? { ...spec, primary } : spec
}

/**
 * La pieza se dibuja a la derecha del paciente (cuadrantes 1, 4, 5 y 8) a la izquierda de la
 * pantalla, como se la mira de frente: su cara mesial mira a la derecha del dibujo.
 */
export function mesialIsRight(tooth: number): boolean {
  const quadrant = Math.trunc(tooth / 10)
  return quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8
}

const n = (value: number) => value.toFixed(1)

/**
 * Contorno de la corona vista de frente, con el borde incisal u oclusal en y = 0 y el cuello en
 * y = ch. Para las piezas de arriba el dibujo se refleja (la raíz sube).
 */
export function crownPath(kind: FrontKind, w: number, ch: number): string {
  const X = (f: number) => n(f * w)
  const Y = (f: number) => n(f * ch)
  switch (kind) {
    case "incisor":
      return `M${X(0.2)},${Y(1)} C${X(0.06)},${Y(0.78)} ${X(0.02)},${Y(0.42)} ${X(0.05)},${Y(0.12)} Q${X(0.07)},${Y(0.02)} ${X(0.18)},${Y(0.02)} L${X(0.82)},${Y(0.02)} Q${X(0.93)},${Y(0.02)} ${X(0.95)},${Y(0.12)} C${X(0.98)},${Y(0.42)} ${X(0.94)},${Y(0.78)} ${X(0.8)},${Y(1)} Q${X(0.5)},${Y(1.07)} ${X(0.2)},${Y(1)} Z`
    case "canine":
      return `M${X(0.22)},${Y(1)} C${X(0.05)},${Y(0.8)} ${X(0.02)},${Y(0.4)} ${X(0.1)},${Y(0.22)} Q${X(0.3)},${Y(0.08)} ${X(0.44)},${Y(0.03)} Q${X(0.5)},${Y(0)} ${X(0.56)},${Y(0.03)} Q${X(0.7)},${Y(0.08)} ${X(0.9)},${Y(0.22)} C${X(0.98)},${Y(0.4)} ${X(0.95)},${Y(0.8)} ${X(0.78)},${Y(1)} Q${X(0.5)},${Y(1.07)} ${X(0.22)},${Y(1)} Z`
    case "premolar":
      return `M${X(0.2)},${Y(1)} C${X(0.04)},${Y(0.8)} ${X(0.02)},${Y(0.42)} ${X(0.1)},${Y(0.26)} Q${X(0.28)},${Y(0.04)} ${X(0.5)},${Y(0.03)} Q${X(0.72)},${Y(0.04)} ${X(0.9)},${Y(0.26)} C${X(0.98)},${Y(0.42)} ${X(0.96)},${Y(0.8)} ${X(0.8)},${Y(1)} Q${X(0.5)},${Y(1.07)} ${X(0.2)},${Y(1)} Z`
    case "molar":
      return `M${X(0.14)},${Y(1)} C${X(0.03)},${Y(0.8)} ${X(0.01)},${Y(0.42)} ${X(0.06)},${Y(0.2)} Q${X(0.1)},${Y(0.06)} ${X(0.2)},${Y(0.05)} Q${X(0.27)},${Y(0.02)} ${X(0.34)},${Y(0.07)} Q${X(0.42)},${Y(0.14)} ${X(0.5)},${Y(0.11)} Q${X(0.58)},${Y(0.08)} ${X(0.64)},${Y(0.04)} Q${X(0.73)},${Y(0.01)} ${X(0.82)},${Y(0.05)} Q${X(0.92)},${Y(0.07)} ${X(0.95)},${Y(0.2)} C${X(0.99)},${Y(0.42)} ${X(0.97)},${Y(0.8)} ${X(0.86)},${Y(1)} Q${X(0.5)},${Y(1.06)} ${X(0.14)},${Y(1)} Z`
  }
}

/** Corona cónica de la pieza en clavija (NTS 6.1.21). */
export function pegCrownPath(w: number, ch: number): string {
  return `M${n(0.26 * w)},${n(ch)} C${n(0.2 * w)},${n(0.6 * ch)} ${n(0.4 * w)},${n(0.12 * ch)} ${n(0.5 * w)},${n(0.06 * ch)} C${n(0.6 * w)},${n(0.12 * ch)} ${n(0.8 * w)},${n(0.6 * ch)} ${n(0.74 * w)},${n(ch)} Z`
}

interface RootGeometry {
  /** La raíz palatina de los molares superiores, detrás de las otras. */
  back?: string
  front: string
  /** Centro de cada raíz a la vista (fracción del ancho), de mesial… al revés no importa. */
  centers: number[]
}

/** Raíces del cuello (y = ch) al ápice (y = ch + rl). */
export function rootPaths(spec: FrontSpec, w: number, ch: number, rl: number): RootGeometry {
  const X = (f: number) => n(f * w)
  const R = (f: number) => n(ch + f * rl)
  if (spec.roots === 1) {
    // Ancha en el cuello, como la corona, y se afina de a poco hasta un ápice redondeado.
    const a = 0.21
    const b = 0.79
    return {
      front: `M${X(a)},${n(ch - 1)} C${X(a - 0.01)},${R(0.4)} ${X(a + 0.1)},${R(0.8)} ${X(0.44)},${R(0.97)} Q${X(0.5)},${R(1.03)} ${X(0.56)},${R(0.97)} C${X(b - 0.1)},${R(0.8)} ${X(b + 0.01)},${R(0.4)} ${X(b)},${n(ch - 1)} Z`,
      centers: [0.5],
    }
  }
  if (spec.primary) return primaryMolarRoots(spec, w, ch, rl)
  // Dos raíces: el premolar se divide más abajo y más junto que el molar.
  const premolar = spec.kind === "premolar"
  const f = premolar ? 0.5 : 0.22
  const a = premolar ? 0.2 : 0.11
  const b = premolar ? 0.8 : 0.89
  const t = premolar ? 0.13 : 0.17
  const front = `M${X(a)},${n(ch - 1)} C${X(a - 0.02)},${R(0.45)} ${X(a + 0.02)},${R(0.86)} ${X(a + t * 0.55)},${R(0.97)} Q${X(a + t)},${R(1.03)} ${X(a + t * 1.5)},${R(0.95)} C${X(a + t * 1.9)},${R(0.78)} ${X(0.45)},${R(f + 0.2)} ${X(0.47)},${R(f)} Q${X(0.5)},${R(f - 0.07)} ${X(0.53)},${R(f)} C${X(0.55)},${R(f + 0.2)} ${X(b - t * 1.9)},${R(0.78)} ${X(b - t * 1.5)},${R(0.95)} Q${X(b - t)},${R(1.03)} ${X(b - t * 0.55)},${R(0.97)} C${X(b - 0.02)},${R(0.86)} ${X(b + 0.02)},${R(0.45)} ${X(b)},${n(ch - 1)} Z`
  const centers = [a + t, b - t]
  if (spec.roots === 2) return { front, centers }
  return {
    back: `M${X(0.3)},${n(ch - 1)} C${X(0.29)},${R(0.55)} ${X(0.4)},${R(1.03)} ${X(0.5)},${R(1.05)} C${X(0.6)},${R(1.03)} ${X(0.71)},${R(0.55)} ${X(0.7)},${n(ch - 1)} Z`,
    front,
    centers: [...centers, 0.5],
  }
}

/**
 * Las raíces del molar temporal: se separan casi en el cuello, son finas y se abren hasta el ancho
 * de la corona, porque abrazan al premolar que viene debajo (Wheeler, dentición temporal). Con la
 * forma del molar permanente se veían largas y paralelas (QA del 23 nov, voz clínica).
 */
function primaryMolarRoots(spec: FrontSpec, w: number, ch: number, rl: number): RootGeometry {
  const X = (f: number) => n(f * w)
  const R = (f: number) => n(ch + f * rl)
  const front = `M${X(0.15)},${n(ch - 1)} C${X(0.1)},${R(0.3)} ${X(0.02)},${R(0.62)} ${X(0.02)},${R(0.85)} Q${X(0.05)},${R(0.93)} ${X(0.11)},${R(0.84)} C${X(0.16)},${R(0.6)} ${X(0.38)},${R(0.22)} ${X(0.47)},${R(0.14)} Q${X(0.5)},${R(0.1)} ${X(0.53)},${R(0.14)} C${X(0.62)},${R(0.22)} ${X(0.84)},${R(0.6)} ${X(0.89)},${R(0.84)} Q${X(0.95)},${R(0.93)} ${X(0.98)},${R(0.85)} C${X(0.98)},${R(0.62)} ${X(0.9)},${R(0.3)} ${X(0.85)},${n(ch - 1)} Z`
  const centers = [0.07, 0.93]
  if (spec.roots === 2) return { front, centers }
  return {
    back: `M${X(0.38)},${n(ch - 1)} C${X(0.38)},${R(0.45)} ${X(0.45)},${R(0.82)} ${X(0.5)},${R(0.84)} C${X(0.55)},${R(0.82)} ${X(0.62)},${R(0.45)} ${X(0.62)},${n(ch - 1)} Z`,
    front,
    centers: [...centers, 0.5],
  }
}

/** Un conducto por raíz, desde la cámara hasta cerca del ápice (NTS 6.1.37: uno por conducto). */
export function canalPaths(spec: FrontSpec, w: number, ch: number, rl: number): string[] {
  const X = (f: number) => n(f * w)
  const R = (f: number) => n(ch + f * rl)
  if (spec.roots === 1) return [`M${X(0.5)},${n(0.45 * ch)} L${X(0.5)},${R(0.93)}`]
  const { centers } = rootPaths(spec, w, ch, rl)
  const [first, second] = centers as [number, number]
  const list = [
    `M${X(0.5)},${n(0.5 * ch)} Q${X(0.44)},${n(ch)} ${X(first)},${R(0.93)}`,
    `M${X(0.5)},${n(0.5 * ch)} Q${X(0.56)},${n(ch)} ${X(second)},${R(0.93)}`,
  ]
  if (spec.roots === 3) list.push(`M${X(0.5)},${n(0.5 * ch)} L${X(0.5)},${R(0.98)}`)
  return list
}

/**
 * Dónde va el perno (NTS 6.1.8): en la raíz mayor. En los molares superiores es la palatina,
 * que de frente queda al centro; en los inferiores, la distal; en las demás, la única o la de
 * al medio.
 */
export function postRootCenter(tooth: number, spec: FrontSpec): number {
  if (spec.roots === 1 || spec.roots === 3) return 0.5
  const { centers } = rootPaths(spec, 1, 1, 1)
  // El primer premolar superior: en una de sus dos raíces, no entre ellas (más allá de la
  // bifurcación el perno quedaría fuera de la pieza).
  if (spec.kind === "premolar") return centers[0] ?? 0.5
  // Molar inferior: la raíz distal, del lado contrario a la mesial.
  return mesialIsRight(tooth) ? Math.min(...centers) : Math.max(...centers)
}

/** Una pieza ubicada en su fila: x de su borde izquierdo, y del borde incisal u oclusal. */
export interface FrontTooth {
  tooth: number
  x: number
  w: number
  /** Alto de la corona y largo de la raíz, en px. */
  ch: number
  rl: number
  /** true: la raíz va hacia arriba (piezas de arriba). */
  up: boolean
  /** Lo que se toca, si es más ancho que la pieza: la de leche, el lugar de la que la reemplaza. */
  hit?: { x: number; w: number }
}

export interface FrontRow {
  teeth: FrontTooth[]
  /** Borde incisal u oclusal de toda la fila. */
  yOcc: number
  up: boolean
  /** La encía de la fila: envuelve las raíces, con el borde festoneado y las papilas. */
  gum: string
  /**
   * La encía por delante de las piezas: la franja del festón, que cubre el cuello de cada corona y
   * sube entre pieza y pieza (la papila), y su borde, para trazarlo.
   */
  gumFront: string
  gumLine: string
  /** Lo que ocupa la fila, de la punta de la raíz más larga al borde de las coronas. */
  top: number
  bottom: number
  left: number
  right: number
}

/** Espacio entre piezas vecinas y, más ancho, en la línea media. */
const GAP_MM = 0.1
const MIDLINE_MM = 0.6

/** El ancho de una fila en mm de dibujo, con sus espacios. */
export function frontRowWidthMm(teeth: readonly number[]): number {
  let total = 0
  teeth.forEach((tooth, i) => {
    total += drawnWidthMm(tooth)
    const next = teeth[i + 1]
    if (next !== undefined)
      total += Math.trunc(next / 10) !== Math.trunc(tooth / 10) ? MIDLINE_MM : GAP_MM
  })
  return total
}

/**
 * Ubica una fila de piezas (de izquierda a derecha como se ven) a `scale` px por mm de dibujo, desde
 * `left`, con el borde de las coronas en `yOcc`. Las de arriba llevan la raíz hacia arriba.
 */
export function frontRow(
  teeth: readonly number[],
  opts: {
    scale: number
    left: number
    yOcc: number
    /** Dónde va cada pieza (borde izquierdo y ancho de su lugar): la de leche, bajo la que la reemplaza. */
    slots?: ReadonlyMap<number, { x: number; w: number }>
  },
): FrontRow {
  const s = opts.scale
  const up = teeth.length > 0 && isUpperTooth(teeth[0]!)
  const dir = up ? -1 : 1
  let x = opts.left
  const placed: FrontTooth[] = []
  teeth.forEach((tooth, i) => {
    const spec = frontSpecOf(tooth)
    const w = drawnWidthMm(tooth) * s
    const slot = opts.slots?.get(tooth)
    if (slot) {
      // El molar de leche es más ancho que el premolar que lo reemplaza: no pasa de su lugar.
      const fit = Math.min(w, slot.w * 0.94)
      placed.push({
        tooth,
        x: slot.x + (slot.w - fit) / 2,
        w: fit,
        ch: crownMm(tooth) * s,
        rl: spec.root * s,
        up,
        hit: slot,
      })
      return
    }
    placed.push({ tooth, x, w, ch: crownMm(tooth) * s, rl: spec.root * s, up })
    const next = teeth[i + 1]
    if (next !== undefined)
      x += w + (Math.trunc(next / 10) !== Math.trunc(tooth / 10) ? MIDLINE_MM : GAP_MM) * s
  })
  const right = placed.length
    ? Math.max(...placed.map((p) => (p.hit ? p.hit.x + p.hit.w : p.x + p.w)))
    : opts.left
  const leftmost = placed.length
    ? Math.min(...placed.map((p) => (p.hit ? p.hit.x : p.x)))
    : opts.left
  const maxCh = Math.max(0, ...placed.map((p) => p.ch))
  const maxRl = Math.max(0, ...placed.map((p) => p.rl))
  // La encía termina poco después de la raíz más larga: más abajo era rosado de sobra.
  const reach = maxCh + maxRl + 2 * s
  const yOcc = opts.yOcc
  const far = yOcc + dir * reach
  // El festón: el borde de la encía sigue el cuello de cada pieza y sube entre pieza y pieza
  // (la papila), como en la boca.
  const cerv = (p: FrontTooth) => yOcc + dir * p.ch
  const pap = (p: FrontTooth) => cerv(p) - dir * 0.22 * p.ch
  const edge = 2.6 * s
  const gl = leftmost - edge
  const gr = right + edge
  // Los cuatro extremos de la encía, redondeados como en la boca: no una caja.
  const r = Math.min(9 * s, reach / 2.2)
  const rc = Math.min(3 * s, reach / 4)
  let d = ""
  let gumFront = ""
  let gumLine = ""
  if (placed.length > 0) {
    const first = placed[0]!
    const corner = `M${n(gl)},${n(pap(first) + dir * rc)} Q${n(gl)},${n(pap(first))} ${n(gl + rc)},${n(pap(first))}`
    d = ""
    placed.forEach((p, i) => {
      const prev = placed[i - 1]
      const next = placed[i + 1]
      const startY = prev ? (pap(prev) + pap(p)) / 2 : pap(p)
      if (!prev) d += ` L${n(p.x)},${n(startY)}`
      const endY = next ? (pap(p) + pap(next)) / 2 : pap(p)
      const endX = next ? (p.x + p.w + next.x) / 2 : p.x + p.w
      const midX = p.x + p.w / 2
      // Al medio de cada pieza el festón baja hasta el cuello: la corona se ve entera y la encía
      // asoma entre pieza y pieza (la papila), como en la boca.
      const midY = cerv(p) + dir * 0.02 * p.ch
      const sx = prev ? (prev.x + prev.w + p.x) / 2 : p.x
      d += ` C${n(sx + p.w * 0.22)},${n(startY)} ${n(midX - p.w * 0.28)},${n(midY)} ${n(midX)},${n(midY)}`
      d += ` C${n(midX + p.w * 0.28)},${n(midY)} ${n(endX - p.w * 0.22)},${n(endY)} ${n(endX)},${n(endY)}`
    })
    const last = placed.at(-1)!
    const festoon = d
    const end = ` L${n(gr - rc)},${n(pap(last))}`
    const closeCorner = ` Q${n(gr)},${n(pap(last))} ${n(gr)},${n(pap(last) + dir * rc)}`
    d = `${corner}${festoon}${end}${closeCorner}`
    d += ` L${n(gr)},${n(far - dir * r)} Q${n(gr)},${n(far)} ${n(gr - r)},${n(far)} L${n(gl + r)},${n(far)} Q${n(gl)},${n(far)} ${n(gl)},${n(far - dir * r)} Z`
    // La franja de adelante llega justo pasado el cuello: se ve el festón y la raíz sigue a la vista.
    const band = yOcc + dir * maxCh * 1.04
    gumFront = `${corner}${festoon}${end}${closeCorner} L${n(gr)},${n(band)} L${n(gl)},${n(band)} Z`
    gumLine = `M${n(gl + rc)},${n(pap(first))}${festoon}${end}`
  }
  return {
    teeth: placed,
    yOcc,
    up,
    gum: d,
    gumFront,
    gumLine,
    top: up ? far : yOcc,
    bottom: up ? yOcc : far,
    left: gl,
    right: gr,
  }
}
