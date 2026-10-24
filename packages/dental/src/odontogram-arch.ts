/**
 * Geometría del arco del odontograma (issue 150): una herradura por arcada,
 * más ancha que alta, con las muelas del fondo un poco hacia adentro y las dos
 * arcadas juntas al centro (la 18 sobre la 48). Las piezas van a igual
 * distancia sobre la curva y crecen hasta llenarla sin pisarse. Todo en px del
 * dibujo, que mide 10 de ancho por 9 de alto.
 */

export const ARCH_ASPECT = 0.9

/** Exponente de la superelipse: lados casi rectos y frente redondeado. */
const SHAPE_N = 2.8
/** Cuánto se cierran las puntas de cada arcada hacia adentro. */
const TUCK = 0.15
/** Del borde de la corona al centro de su número. */
const LABEL_PX = 8

export type ArchRows = { upper: readonly number[]; lower: readonly number[] }

export interface ArchTooth {
  tooth: number
  /** Centro de la pieza. */
  x: number
  y: number
  /** Ancho a lo largo del arco y alto hacia afuera (la corona mide 18 × 15). */
  w: number
  h: number
  /** Giro en grados: la cara vestibular mira hacia afuera del arco. */
  rotation: number
  /** Centro del número. */
  labelX: number
  labelY: number
  inner: boolean
}

export interface ArchGum {
  /** Trazo por el centro de las piezas; se dibuja con borde redondeado. */
  d: string
  width: number
  inner: boolean
}

export interface ArchLayout {
  width: number
  height: number
  teeth: ArchTooth[]
  gums: ArchGum[]
}

type Point = { x: number; y: number }

/**
 * Media superelipse de la punta derecha del paciente (izquierda del dibujo) a
 * la izquierda, pasando por el frente; y > 0 es hacia afuera de la arcada. Lo
 * más ancho llega a «a» aunque las puntas se cierren.
 */
function halfArch(a: number, b: number, tuck: number): Point[] {
  const steps = 900
  const pts: Point[] = []
  for (let k = 0; k <= steps; k++) {
    const t = Math.PI - (Math.PI * k) / steps
    const c = Math.cos(t)
    const s = Math.abs(Math.sin(t))
    pts.push({
      x: Math.sign(c) * Math.abs(c) ** (2 / SHAPE_N) * (1 - tuck * (1 - s) ** 2),
      y: b * s ** (2 / SHAPE_N),
    })
  }
  const widest = Math.max(...pts.map((p) => Math.abs(p.x)))
  return pts.map((p) => ({ x: (p.x * a) / widest, y: p.y }))
}

/** Normal hacia afuera: la tangente girada 90° (la curva va de izquierda a derecha). */
function normals(pts: readonly Point[]): Point[] {
  return pts.map((_, i) => {
    const q = pts[Math.max(0, i - 1)]!
    const r = pts[Math.min(pts.length - 1, i + 1)]!
    const length = Math.hypot(r.x - q.x, r.y - q.y) || 1
    return { x: -(r.y - q.y) / length, y: (r.x - q.x) / length }
  })
}

/** Contorno paralelo hacia adentro, a una distancia fija. */
function inset(pts: readonly Point[], distance: number): Point[] {
  const nm = normals(pts)
  return pts.map((p, i) => ({ x: p.x - nm[i]!.x * distance, y: p.y - nm[i]!.y * distance }))
}

function polyline(pts: readonly Point[]) {
  const nm = normals(pts)
  const acc = [0]
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const length = acc[acc.length - 1]!
  return {
    length,
    /** Punto y normal a una distancia dada desde la punta izquierda. */
    at(distance: number): Point & { nx: number; ny: number } {
      let lo = 1
      let hi = pts.length - 1
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (acc[mid]! < distance) lo = mid + 1
        else hi = mid
      }
      const f = (distance - acc[lo - 1]!) / Math.max(1e-9, acc[lo]! - acc[lo - 1]!)
      const p = pts[lo - 1]!
      const q = pts[lo]!
      const nx = nm[lo - 1]!.x + (nm[lo]!.x - nm[lo - 1]!.x) * f
      const ny = nm[lo - 1]!.y + (nm[lo]!.y - nm[lo - 1]!.y) * f
      const n = Math.hypot(nx, ny) || 1
      return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f, nx: nx / n, ny: ny / n }
    },
  }
}

/**
 * Posición de cada pieza para un dibujo de `width` px. Con `inner` (dentición
 * mixta) las temporales van en una herradura más chica dentro de la otra; los
 * números de las permanentes pasan afuera para no mezclarse con las temporales.
 */
export function archLayout(width: number, outer: ArchRows, inner?: ArchRows): ArchLayout {
  const W = width
  const H = W * ARCH_ASPECT
  const inside = !inner
  const count = Math.max(outer.upper.length, outer.lower.length)
  let t = W * 0.12
  let h = t / 1.2
  let gap = 0
  let a = 0
  let b = 0
  let curve: Point[] = []
  // El tamaño de la pieza depende del largo de la curva y la curva del margen
  // que deja la pieza: unas pocas vueltas bastan para que se estabilice.
  for (let i = 0; i < 6; i++) {
    h = t / 1.2
    gap = t + 0.012 * W
    a = W / 2 - (inside ? t / 2 + 2 : h / 2 + LABEL_PX + 9)
    b = (H - gap) / 2 - (inside ? h / 2 + 2 : h / 2 + LABEL_PX + 8)
    curve = halfArch(a, b, TUCK)
    const fit = (polyline(curve).length / (count - 1)) * 0.97 - 0.005 * W
    t = Math.min(W * (count <= 10 ? 0.13 : 0.1), fit)
  }
  const yUpper = (H - gap) / 2
  const yLower = (H + gap) / 2
  const teeth: ArchTooth[] = []
  const gums: ArchGum[] = []

  const place = (row: readonly number[], lower: boolean, ring: "outer" | "inner") => {
    if (row.length === 0) return
    const size = ring === "inner" ? t * 0.8 : t
    const depth = size / 1.2
    let pts = curve
    if (ring === "inner") {
      // La herradura interior sigue la misma U sin cerrar las puntas, para que
      // no se enrosque donde se cierra la exterior.
      const tuckShift = a - Math.abs(curve[0]!.x)
      pts = inset(halfArch(a, b, 0), h / 2 + (inside ? LABEL_PX + 13 : 3) + depth / 2 + 0.01 * W + (inside ? 0 : tuckShift))
    }
    const line = polyline(pts)
    const start = Math.max(0, (size + 0.012 * W - gap) / 2)
    const sign = lower ? 1 : -1
    const base = lower ? yLower : yUpper
    const labelSign = ring === "inner" || inside ? -1 : 1
    const labelOffset = depth / 2 + (ring === "inner" ? LABEL_PX - 2 : LABEL_PX)
    row.forEach((tooth, i) => {
      const p = line.at(row.length === 1 ? line.length / 2 : start + (i / (row.length - 1)) * (line.length - 2 * start))
      const x = W / 2 + p.x
      const y = base + sign * p.y
      const nx = p.nx
      const ny = sign * p.ny
      teeth.push({
        tooth,
        x,
        y,
        w: size,
        h: depth,
        rotation: (Math.atan2(ny, nx) * 180) / Math.PI - 90,
        labelX: x + nx * labelSign * labelOffset,
        labelY: y + ny * labelSign * labelOffset,
        inner: ring === "inner",
      })
    })
    const d = pts
      .filter((_, i) => i % 6 === 0 || i === pts.length - 1)
      .map((p, i) => `${i ? "L" : "M"}${(W / 2 + p.x).toFixed(1)} ${(base + sign * p.y).toFixed(1)}`)
      .join(" ")
    gums.push({ d, width: depth + 10, inner: ring === "inner" })
  }

  place(outer.upper, false, "outer")
  place(outer.lower, true, "outer")
  if (inner) {
    place(inner.upper, false, "inner")
    place(inner.lower, true, "inner")
  }
  return { width: W, height: H, teeth, gums }
}

/**
 * Pieza a la que lleva una tecla dentro del arco. `rows` va de arriba abajo
 * tal como se ve: arcada superior, temporales superiores, temporales
 * inferiores y arcada inferior. ← → recorren la fila en el orden en que se ve;
 * ↑ ↓ pasan a la fila de al lado, a la pieza en la misma posición.
 */
export function archNeighbor(rows: readonly (readonly number[])[], tooth: number, key: string): number | null {
  const r = rows.findIndex((row) => row.includes(tooth))
  if (r < 0) return null
  const row = rows[r]!
  const i = row.indexOf(tooth)
  switch (key) {
    case "ArrowLeft":
      return row[Math.max(0, i - 1)] ?? null
    case "ArrowRight":
      return row[Math.min(row.length - 1, i + 1)] ?? null
    case "Home":
      return row[0] ?? null
    case "End":
      return row[row.length - 1] ?? null
    case "ArrowUp":
    case "ArrowDown": {
      const next = rows[r + (key === "ArrowUp" ? -1 : 1)]
      if (!next || next.length === 0) return null
      const j = row.length <= 1 ? 0 : Math.round((i * (next.length - 1)) / (row.length - 1))
      return next[j] ?? null
    }
    default:
      return null
  }
}
