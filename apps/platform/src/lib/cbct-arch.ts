import type { CbctVolume, PlaneImage } from "./cbct-volume"

/**
 * El arco dental de una tomografía y lo que se arma con él (ADR 0055): la
 * panorámica reconstruida (reformateo curvo con grosor) y los cortes
 * transversales, perpendiculares al arco. Coordenadas del arco en vóxeles del
 * corte axial (x = columna, y = fila); distancias en mm.
 */

export type Point = { x: number; y: number }

export interface ArchProposal {
  /** Cinco puntos sobre el arco, de la derecha a la izquierda del paciente. */
  control: Point[]
  /** Corte axial donde se ve mejor el arco (el centro de la banda oclusal). */
  z: number
}

export interface CurveSample {
  x: number
  y: number
  /** Normal unitaria hacia afuera (vestibular), en vóxeles por mm. */
  nx: number
  ny: number
  /** Tangente unitaria (de derecha a izquierda del paciente), en vóxeles por mm. */
  tx: number
  ty: number
  /** Distancia sobre el arco desde su inicio, en mm. */
  s: number
}

/** Mínimos cuadrados de y = a·x² + b·x + c. */
function fitParabola(points: readonly Point[]): [number, number, number] | null {
  let s0 = 0
  let s1 = 0
  let s2 = 0
  let s3 = 0
  let s4 = 0
  let t0 = 0
  let t1 = 0
  let t2 = 0
  for (const { x, y } of points) {
    const x2 = x * x
    s0 += 1
    s1 += x
    s2 += x2
    s3 += x2 * x
    s4 += x2 * x2
    t0 += y
    t1 += x * y
    t2 += x2 * y
  }
  // Regla de Cramer sobre las ecuaciones normales.
  const det = (m: number[]) =>
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  const A = [s4, s3, s2, s3, s2, s1, s2, s1, s0]
  const d = det(A)
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null
  const a = det([t2, s3, s2, t1, s2, s1, t0, s1, s0]) / d
  const b = det([s4, t2, s2, s3, t1, s1, s2, t0, s0]) / d
  const c = det([s4, s3, t2, s3, s2, t1, s2, s1, t0]) / d
  return [a, b, c]
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 0
}

/**
 * Propone el arco (decisión 2): busca la banda de cortes con más esmalte,
 * proyecta su máximo y ajusta una parábola a lo brillante, dos veces para
 * descartar lo que queda lejos. Devuelve null si no hay un arco claro.
 */
export function detectArch(volume: CbctVolume): ArchProposal | null {
  const { nx, ny, nz, data } = volume
  // Solo el esmalte: lo más brillante del brillo «Diente», sin la dentina ni la cortical.
  const threshold = volume.presets.diente.center + volume.presets.diente.width / 4
  const plane = nx * ny
  const counts = new Uint32Array(nz)
  for (let z = 0; z < nz; z++) {
    let n = 0
    for (let i = z * plane; i < (z + 1) * plane; i += 3) if (data[i]! > threshold) n++
    counts[z] = n
  }
  let best = 0
  for (let z = 1; z < nz; z++) if (counts[z]! > counts[best]!) best = z
  if (!counts[best]) return null
  const half = Math.max(2, Math.round(8 / volume.sz))
  const z0 = Math.max(0, best - half)
  const z1 = Math.min(nz - 1, best + half)
  const mip = new Int16Array(plane).fill(-32768)
  for (let z = z0; z <= z1; z++) {
    const base = z * plane
    for (let i = 0; i < plane; i++) if (data[base + i]! > mip[i]!) mip[i] = data[base + i]!
  }
  // Puntos en mm para que la parábola no dependa del vóxel.
  let points: Point[] = []
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) if (mip[y * nx + x]! > threshold) points.push({ x: x * volume.sx, y: y * volume.sy })
  if (points.length < 60) return null
  let fit = fitParabola(points)
  for (let pass = 0; pass < 2 && fit; pass++) {
    const [a, b, c] = fit
    const residuals = points.map((p) => Math.abs(p.y - (a * p.x * p.x + b * p.x + c)))
    const cut = Math.max(2, 2.5 * percentile([...residuals].sort((m, n) => m - n), 0.5))
    points = points.filter((_, i) => residuals[i]! <= cut)
    fit = fitParabola(points)
  }
  if (!fit) return null
  const [a, b, c] = fit
  const xs = points.map((p) => p.x).sort((m, n) => m - n)
  const left = percentile(xs, 0.01)
  const right = percentile(xs, 0.99)
  const residual = percentile(
    points.map((p) => Math.abs(p.y - (a * p.x * p.x + b * p.x + c))).sort((m, n) => m - n),
    0.5,
  )
  // Un arco: abre hacia atrás (y crece), mide más de 3 cm de ancho y la parábola lo sigue
  // a menos de medio molar. Un arco real no es una parábola, el esmalte es la cáscara de
  // coronas de 8 a 10 mm y el de arriba va por delante del de abajo: en la tomografía de
  // 3D Slicer el residuo es de 3 a 4,6 mm según el umbral; lo que no es un arco pasa de 10.
  if (a <= 0 || right - left < 30 || residual > 6) return null
  const control = Array.from({ length: 5 }, (_, k) => {
    const x = left + ((right - left) * k) / 4
    return { x: x / volume.sx, y: (a * x * x + b * x + c) / volume.sy }
  })
  return { control, z: best }
}

/** Catmull-Rom centrípeto simple entre puntos de control (en vóxeles). */
function catmullRom(control: readonly Point[], steps: number): Point[] {
  const pts = [control[0]!, ...control, control[control.length - 1]!]
  const out: Point[] = []
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1]!, pts[i]!, pts[i + 1]!, pts[i + 2]!]
    for (let k = 0; k < steps; k++) {
      const t = k / steps
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) })
    }
  }
  out.push(control[control.length - 1]!)
  return out
}

/**
 * Muestras del arco cada `stepMm`, con su tangente y su normal hacia afuera.
 * Afuera es lejos del interior de la U (la lengua).
 */
export function sampleCurve(volume: CbctVolume, control: readonly Point[], stepMm = volume.sx): CurveSample[] {
  if (control.length < 2) return []
  const dense = catmullRom(control, 200)
  const mm = dense.map((p) => ({ x: p.x * volume.sx, y: p.y * volume.sy }))
  const lengths = [0]
  for (let i = 1; i < mm.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(mm[i]!.x - mm[i - 1]!.x, mm[i]!.y - mm[i - 1]!.y))
  const total = lengths[lengths.length - 1]!
  // Un punto dentro de la U: el centro de los extremos, corrido hacia atrás.
  const inner = {
    x: (mm[0]!.x + mm[mm.length - 1]!.x) / 2,
    y: Math.max(mm[0]!.y, mm[mm.length - 1]!.y) + 10,
  }
  const out: CurveSample[] = []
  let j = 0
  for (let s = 0; s <= total; s += stepMm) {
    while (j < lengths.length - 2 && lengths[j + 1]! < s) j++
    const span = lengths[j + 1]! - lengths[j]! || 1
    const t = (s - lengths[j]!) / span
    const a = mm[j]!
    const b = mm[j + 1]!
    const px = a.x + (b.x - a.x) * t
    const py = a.y + (b.y - a.y) * t
    let tx = (b.x - a.x) / span
    let ty = (b.y - a.y) / span
    const norm = Math.hypot(tx, ty) || 1
    tx /= norm
    ty /= norm
    let nx = -ty
    let ny = tx
    if (nx * (px - inner.x) + ny * (py - inner.y) < 0) {
      nx = -nx
      ny = -ny
    }
    out.push({ x: px / volume.sx, y: py / volume.sy, tx: tx / volume.sx, ty: ty / volume.sy, nx: nx / volume.sx, ny: ny / volume.sy, s })
  }
  return out
}

/** Valor del volumen en (x, y) del corte z, con interpolación bilineal. */
function bilinear(volume: CbctVolume, x: number, y: number, z: number): number {
  const { nx, ny, data } = volume
  if (x < 0 || y < 0 || x > nx - 1 || y > ny - 1) return volume.range.min
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(nx - 1, x0 + 1)
  const y1 = Math.min(ny - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const base = z * nx * ny
  const v00 = data[base + y0 * nx + x0]!
  const v10 = data[base + y0 * nx + x1]!
  const v01 = data[base + y1 * nx + x0]!
  const v11 = data[base + y1 * nx + x1]!
  return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
}

export interface CrossImage extends PlaneImage {
  /** Corte (z) de la primera fila: la fila r está en z = zTop − r. */
  zTop: number
}

/** Filas de `zFrom` a `zTo` dentro del volumen, con la de arriba primero. */
function rowsWithin(volume: CbctVolume, zFrom: number, zTo: number): { low: number; zTop: number; height: number } {
  const low = Math.max(0, Math.min(volume.nz - 1, Math.round(zFrom)))
  const zTop = Math.max(low, Math.min(volume.nz - 1, Math.round(zTo)))
  return { low, zTop, height: zTop - low + 1 }
}

/**
 * Panorámica reconstruida: para cada punto del arco y cada corte, el promedio
 * a lo largo de la normal en `thicknessMm` (como una radiografía panorámica).
 * La derecha del paciente queda a la izquierda; arriba es arriba. Entre los
 * cortes `zFrom` y `zTo` (todo el alto si no se dicen).
 */
export function panorama(
  volume: CbctVolume,
  curve: readonly CurveSample[],
  thicknessMm = 12,
  zFrom = 0,
  zTo = volume.nz - 1,
): CrossImage {
  const width = curve.length
  const { zTop, height } = rowsWithin(volume, zFrom, zTo)
  const values = new Int16Array(width * height)
  const step = Math.min(volume.sx, volume.sy)
  const offsets: number[] = []
  for (let o = -thicknessMm / 2; o <= thicknessMm / 2 + 1e-9; o += step) offsets.push(o)
  for (let i = 0; i < width; i++) {
    const c = curve[i]!
    for (let r = 0; r < height; r++) {
      let sum = 0
      for (const o of offsets) sum += bilinear(volume, c.x + c.nx * o, c.y + c.ny * o, zTop - r)
      values[r * width + i] = Math.round(sum / offsets.length)
    }
  }
  const spacing = curve.length > 1 ? curve[1]!.s - curve[0]!.s : volume.sx
  return { width, height, values, colMm: spacing, rowMm: volume.sz, zTop }
}

/**
 * Alto de la panorámica: los dos maxilares, como en una radiografía panorámica
 * (de 4 cm bajo el plano oclusal a 4,5 cm sobre él). Una tomografía de campo
 * grande trae también la órbita y la base del cráneo, que achican los dientes.
 */
export function panoramaRows(volume: CbctVolume, occlusalZ: number): [number, number] {
  return [occlusalZ - Math.round(40 / volume.sz), occlusalZ + Math.round(45 / volume.sz)]
}

/**
 * Corte transversal en la muestra `index` del arco: de lingual (izquierda) a
 * vestibular (derecha), `halfWidthMm` a cada lado, entre los cortes `zFrom` y
 * `zTo` (todo el alto si no se dicen).
 */
export function crossSection(
  volume: CbctVolume,
  curve: readonly CurveSample[],
  index: number,
  halfWidthMm = 16,
  zFrom = 0,
  zTo = volume.nz - 1,
): CrossImage {
  const c = curve[Math.max(0, Math.min(curve.length - 1, Math.round(index)))]!
  const step = Math.min(volume.sx, volume.sy)
  const width = Math.round((2 * halfWidthMm) / step) + 1
  const { zTop, height } = rowsWithin(volume, zFrom, zTo)
  const values = new Int16Array(width * height)
  for (let col = 0; col < width; col++) {
    const o = col * step - halfWidthMm
    const x = c.x + c.nx * o
    const y = c.y + c.ny * o
    for (let r = 0; r < height; r++) values[r * width + col] = Math.round(bilinear(volume, x, y, zTop - r))
  }
  return { width, height, values, colMm: step, rowMm: volume.sz, zTop }
}

/**
 * Alto que muestran los transversales: el maxilar de la pieza elegida, desde un
 * poco más allá del plano oclusal hasta 36 mm hacia la raíz.
 */
export function jawRows(volume: CbctVolume, occlusalZ: number, jaw: "upper" | "lower"): [number, number] {
  const mm = (value: number) => Math.round(value / volume.sz)
  return jaw === "lower"
    ? [occlusalZ - mm(36), occlusalZ + mm(8)]
    : [occlusalZ - mm(8), occlusalZ + mm(36)]
}

/** Ancho mesiodistal típico por posición (1 = incisivo central … 7 = segundo molar), en mm. */
const TOOTH_WIDTH = { upper: [8.5, 6.5, 7.5, 7, 6.5, 10, 9], lower: [5.5, 6, 7, 7, 7.5, 11, 10.5] }

/**
 * Dónde cae una pieza (FDI) sobre el arco, aproximado con los anchos típicos y
 * el largo de cada lado del arco. Sirve para «Ir a la pieza»: después se ajusta
 * con el control de los cortes.
 */
export function toothIndex(curve: readonly CurveSample[], fdi: number): number | null {
  const quadrant = Math.floor(fdi / 10)
  const position = fdi % 10
  if (quadrant < 1 || quadrant > 4 || position < 1 || position > 7 || curve.length < 2) return null
  const widths = quadrant <= 2 ? TOOTH_WIDTH.upper : TOOTH_WIDTH.lower
  const total = curve[curve.length - 1]!.s
  // La línea media: el punto más adelantado del arco (el de menor y).
  let mid = 0
  for (let i = 1; i < curve.length; i++) if (curve[i]!.y < curve[mid]!.y) mid = i
  const sMid = curve[mid]!.s
  const right = quadrant === 1 || quadrant === 4
  const sideLength = right ? sMid : total - sMid
  const sum = widths.reduce((n, w) => n + w, 0)
  const before = widths.slice(0, position - 1).reduce((n, w) => n + w, 0)
  const along = ((before + widths[position - 1]! / 2) / sum) * sideLength
  const s = right ? sMid - along : sMid + along
  let best = 0
  for (let i = 1; i < curve.length; i++) if (Math.abs(curve[i]!.s - s) < Math.abs(curve[best]!.s - s)) best = i
  return best
}

/** La pieza más cercana a una muestra del arco (para «Corte N · pieza 36»). */
export function toothAt(curve: readonly CurveSample[], index: number, jaw: "upper" | "lower"): number | null {
  const candidates = jaw === "upper" ? [1, 2] : [4, 3]
  let best: { fdi: number; d: number } | null = null
  for (const q of candidates)
    for (let p = 1; p <= 7; p++) {
      const fdi = q * 10 + p
      const at = toothIndex(curve, fdi)
      if (at === null) continue
      const d = Math.abs(at - index)
      if (!best || d < best.d) best = { fdi, d }
    }
  return best?.fdi ?? null
}
