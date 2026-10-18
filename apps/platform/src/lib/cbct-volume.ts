import type * as dicomParser from "dicom-parser"
import { DicomUnsupportedError, openDicom } from "./dicom"

/**
 * El volumen de una tomografía en la memoria del navegador (ADR 0056): los
 * cortes de la serie mayor, ordenados por su posición (Image Position Patient
 * sobre la normal del corte), como enteros de 16 bits en unidades de modalidad
 * (HU en una tomografía calibrada). Las vistas son remuestreos de este volumen.
 *
 * Ejes del volumen: x = columna del corte (de la derecha a la izquierda del
 * paciente en un axial estándar), y = fila (de adelante hacia atrás) y z =
 * corte (de abajo hacia arriba). Las medidas se dan en mm del volumen.
 */

export interface CbctVolume {
  nx: number
  ny: number
  nz: number
  /** mm por vóxel en x, y, z. */
  sx: number
  sy: number
  sz: number
  data: Int16Array
  range: { min: number; max: number }
  presets: Record<BrightnessPreset, WindowLevel>
}

export type BrightnessPreset = "hueso" | "diente" | "blando"
export interface WindowLevel {
  center: number
  width: number
}

export class CbctTooLargeError extends Error {}

export interface VolumeSource {
  index: number
  url: string
  sizeBytes: number
  seriesInstanceUid: string
}

type Vec3 = [number, number, number]

function floats(ds: dicomParser.DataSet, tag: string, n: number): number[] | null {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const value = ds.floatString(tag, i)
    if (value === undefined || !Number.isFinite(value)) return null
    out.push(value)
  }
  return out
}

/** Primer ítem de una secuencia, o null. */
function item(ds: dicomParser.DataSet | undefined, tag: string): dicomParser.DataSet | null {
  return ds?.elements[tag]?.items?.[0]?.dataSet ?? null
}

interface FrameGeometry {
  position: Vec3 | null
  normal: Vec3
  rowMm: number | null
  colMm: number | null
}

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * Geometría de un cuadro: posición, normal del plano y espaciado. En los CT de
 * varios cuadros (Enhanced CT, PS3.3 C.7.6.16) vive en los grupos funcionales.
 */
function frameGeometry(ds: dicomParser.DataSet, frame: number): FrameGeometry {
  const perFrame = ds.elements.x52009230?.items?.[frame]?.dataSet
  const shared = item(ds, "x52009229")
  const orientation =
    floats(ds, "x00200037", 6) ??
    (perFrame ? floats(item(perFrame, "x00209116") ?? ds, "x00200037", 6) : null) ??
    (shared ? floats(item(shared, "x00209116") ?? ds, "x00200037", 6) : null) ?? [1, 0, 0, 0, 1, 0]
  const position =
    (perFrame ? floats(item(perFrame, "x00209113") ?? ds, "x00200032", 3) : null) ??
    floats(ds, "x00200032", 3)
  const spacing =
    floats(ds, "x00280030", 2) ??
    (shared ? floats(item(shared, "x00289110") ?? ds, "x00280030", 2) : null) ??
    (perFrame ? floats(item(perFrame, "x00289110") ?? ds, "x00280030", 2) : null)
  const row = orientation.slice(0, 3) as Vec3
  const col = orientation.slice(3, 6) as Vec3
  return {
    position: position as Vec3 | null,
    normal: cross(row, col),
    rowMm: spacing?.[0] ?? null,
    colMm: spacing?.[1] ?? null,
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Otsu de tres clases sobre un histograma: los dos umbrales que mejor separan
 * aire, tejido blando y tejido duro (hueso y dientes).
 */
function otsu3(hist: Uint32Array): [number, number] {
  const n = hist.length
  const count = new Float64Array(n + 1)
  const sum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    count[i + 1] = count[i]! + hist[i]!
    sum[i + 1] = sum[i]! + i * hist[i]!
  }
  const part = (a: number, b: number) => {
    const w = count[b + 1]! - count[a]!
    return w ? (sum[b + 1]! - sum[a]!) ** 2 / w : 0
  }
  let best = -1
  let cut: [number, number] = [Math.floor(n / 3), Math.floor((2 * n) / 3)]
  for (let t1 = 0; t1 < n - 2; t1++)
    for (let t2 = t1 + 1; t2 < n - 1; t2++) {
      const between = part(0, t1) + part(t1 + 1, t2) + part(t2 + 1, n - 1)
      if (between > best) {
        best = between
        cut = [t1, t2]
      }
    }
  return cut
}

/**
 * Brillos calculados con los grises de este estudio (ADR 0056): la CBCT no
 * tiene una escala común entre equipos. Otsu de tres clases separa aire,
 * tejido blando y tejido duro; con eso, «Tejido blando» va del límite con el
 * aire al límite con el hueso, «Hueso» del tejido blando al 85 % de lo duro
 * (el hueso en grises y los dientes casi blancos) y «Diente» de la mitad de lo
 * duro a su máximo (esmalte, dentina y pulpa).
 */
export function computePresets(data: Int16Array, range: { min: number; max: number }): Record<BrightnessPreset, WindowLevel> {
  const span = Math.max(1, range.max - range.min + 1)
  const bins = Math.min(4096, span)
  const scale = bins / span
  const hist = new Uint32Array(bins)
  const stride = Math.max(1, Math.floor(data.length / 2_000_000))
  for (let i = stride >> 1; i < data.length; i += stride) hist[Math.min(bins - 1, Math.floor((data[i]! - range.min) * scale))]!++
  // Umbrales en un histograma grueso (256) para que el Otsu de tres clases sea rápido.
  const coarseBins = Math.min(256, bins)
  const factor = bins / coarseBins
  const coarse = new Uint32Array(coarseBins)
  for (let i = 0; i < bins; i++) coarse[Math.min(coarseBins - 1, Math.floor(i / factor))]! += hist[i]!
  const [c1, c2] = otsu3(coarse)
  const t1 = Math.round((c1 + 1) * factor)
  const t2 = Math.round((c2 + 1) * factor)
  const value = (bin: number) => range.min + bin / scale
  const classPercentile = (from: number, to: number, p: number) => {
    let total = 0
    for (let i = from; i < to; i++) total += hist[i]!
    if (!total) return null
    let acc = 0
    for (let i = from; i < to; i++) {
      acc += hist[i]!
      if (acc >= total * p) return value(i)
    }
    return value(to - 1)
  }
  const window = (low: number, high: number): WindowLevel => ({
    center: (low + high) / 2,
    width: Math.max(1, high - low),
  })
  const softMid = classPercentile(t1, t2, 0.5) ?? value(t1)
  const hard = (p: number) => classPercentile(t2, bins, p) ?? range.max
  return {
    blando: window(value(t1), value(t2)),
    hueso: window(softMid, hard(0.85)),
    diente: window(hard(0.5), hard(0.999)),
  }
}

/** Memoria que el navegador puede dedicar al volumen (`navigator.deviceMemory` en GB, si lo dice). */
function memoryBudget(): number {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
  return Math.min(1.5 * 1024 ** 3, gb * 1024 ** 3 * 0.25)
}

export interface LoadProgress {
  done: number
  total: number
}

/** El último volumen abierto, para que reabrir la misma tomografía sea inmediato. */
let cached: { key: string; volume: CbctVolume } | null = null

/**
 * Descarga los cortes de la serie mayor (de a seis), los decodifica con los
 * mismos códecs del visor 2D y arma el volumen. Lanza `CbctTooLargeError` si no
 * cabe en la memoria de este dispositivo.
 */
export async function loadCbctVolume(
  key: string,
  sources: readonly VolumeSource[],
  options: { onProgress?: (progress: LoadProgress) => void; signal?: AbortSignal } = {},
): Promise<CbctVolume> {
  if (cached?.key === key) return cached.volume
  const bySeries = new Map<string, VolumeSource[]>()
  for (const source of sources)
    bySeries.set(source.seriesInstanceUid, [...(bySeries.get(source.seriesInstanceUid) ?? []), source])
  const series = [...bySeries.values()].sort((a, b) => b.length - a.length)[0] ?? []
  if (!series.length) throw new DicomUnsupportedError("La tomografía no tiene cortes")

  let volume: Int16Array | null = null
  let nx = 0
  let ny = 0
  let nz = 0
  let rowMm = 1
  let colMm = 1
  const positions: (number | null)[] = []
  const instance: number[] = []
  let filled = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  const place = async (file: ReturnType<typeof openDicom>, frame: number, slot: number) => {
    const image = await file.decode(frame)
    if (!image.values) throw new DicomUnsupportedError("La tomografía está en color: descárgala")
    if (!volume) {
      nx = image.width
      ny = image.height
      const bytes = nx * ny * nz * 2
      if (bytes > memoryBudget()) throw new CbctTooLargeError("La tomografía no cabe en la memoria de este dispositivo")
      try {
        volume = new Int16Array(nx * ny * nz)
      } catch {
        throw new CbctTooLargeError("La tomografía no cabe en la memoria de este dispositivo")
      }
    }
    if (image.width !== nx || image.height !== ny)
      throw new DicomUnsupportedError("Los cortes de la tomografía no tienen el mismo tamaño")
    const geometry = frameGeometry(file.dataset, frame)
    if (geometry.rowMm && geometry.colMm) {
      rowMm = geometry.rowMm
      colMm = geometry.colMm
    }
    const p = geometry.position
    positions[slot] = p ? p[0] * geometry.normal[0] + p[1] * geometry.normal[1] + p[2] * geometry.normal[2] : null
    instance[slot] = file.dataset.intString("x00200013") ?? slot
    const base = slot * nx * ny
    const values = image.values
    const target = volume as Int16Array
    for (let i = 0; i < values.length; i++) {
      const v = Math.max(-32768, Math.min(32767, Math.round(values[i]!)))
      target[base + i] = v
      if (v < min) min = v
      if (v > max) max = v
    }
    filled++
    options.onProgress?.({ done: filled, total: nz })
  }

  const fetchBuffer = async (source: VolumeSource) => {
    const response = await fetch(source.url, { signal: options.signal })
    if (!response.ok) throw new Error(`No se pudo leer un corte (${response.status})`)
    return response.arrayBuffer()
  }

  if (series.length === 1) {
    // Un solo archivo de muchos cuadros (CT mejorado).
    const file = openDicom(await fetchBuffer(series[0]!))
    nz = file.frames
    for (let frame = 0; frame < file.frames; frame++) await place(file, frame, frame)
  } else {
    nz = series.length
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(6, series.length) }, async () => {
        while (next < series.length) {
          const slot = next++
          const file = openDicom(await fetchBuffer(series[slot]!))
          if (file.frames !== 1)
            throw new DicomUnsupportedError("La serie mezcla archivos de varios cuadros: descárgala")
          await place(file, 0, slot)
        }
      }),
    )
  }
  if (!volume) throw new DicomUnsupportedError("La tomografía no tiene cortes")
  const data: Int16Array = volume

  // Orden de abajo hacia arriba por la posición sobre la normal (o el número de instancia).
  const order = Array.from({ length: nz }, (_, i) => i)
  const byPosition = positions.every((p) => p !== null)
  order.sort((a, b) => (byPosition ? positions[a]! - positions[b]! : instance[a]! - instance[b]!))
  const plane = nx * ny
  if (order.some((slot, i) => slot !== i)) {
    const sorted = new Int16Array(plane * nz)
    order.forEach((slot, i) => {
      sorted.set(data.subarray(slot * plane, (slot + 1) * plane), i * plane)
    })
    data.set(sorted)
  }
  const gaps = byPosition
    ? order.slice(1).map((slot, i) => Math.abs(positions[slot]! - positions[order[i]!]!))
    : []
  const sz = median(gaps.filter((gap) => gap > 0)) || colMm
  const range = { min, max }
  const result: CbctVolume = {
    nx,
    ny,
    nz,
    sx: colMm,
    sy: rowMm,
    sz,
    data,
    range,
    presets: computePresets(data, range),
  }
  cached = { key, volume: result }
  return result
}

export type Plane = "axial" | "coronal" | "sagittal"

export interface PlaneImage {
  width: number
  height: number
  values: Int16Array
  /** mm por píxel en columnas y filas. */
  colMm: number
  rowMm: number
}

/** Cantidad de cortes de un plano. */
export function planeCount(volume: CbctVolume, plane: Plane): number {
  return plane === "axial" ? volume.nz : plane === "coronal" ? volume.ny : volume.nx
}

/**
 * Un corte ortogonal. Axial: visto desde los pies (derecha del paciente a la
 * izquierda de la imagen, adelante arriba). Coronal y sagital: arriba es arriba
 * del paciente; el sagital tiene adelante a la izquierda.
 */
export function planeImage(volume: CbctVolume, plane: Plane, index: number): PlaneImage {
  const { nx, ny, nz, data } = volume
  const at = Math.max(0, Math.min(planeCount(volume, plane) - 1, Math.round(index)))
  if (plane === "axial") {
    return { width: nx, height: ny, values: data.subarray(at * nx * ny, (at + 1) * nx * ny), colMm: volume.sx, rowMm: volume.sy }
  }
  if (plane === "coronal") {
    const values = new Int16Array(nx * nz)
    for (let r = 0; r < nz; r++) {
      const base = (nz - 1 - r) * nx * ny + at * nx
      values.set(data.subarray(base, base + nx), r * nx)
    }
    return { width: nx, height: nz, values, colMm: volume.sx, rowMm: volume.sz }
  }
  const values = new Int16Array(ny * nz)
  for (let r = 0; r < nz; r++) {
    const base = (nz - 1 - r) * nx * ny
    for (let y = 0; y < ny; y++) values[r * ny + y] = data[base + y * nx + at]!
  }
  return { width: ny, height: nz, values, colMm: volume.sy, rowMm: volume.sz }
}

/** Ventana lineal (PS3.3 C.11.2.1.2) a píxeles RGBA. */
export function windowToRgba(
  values: ArrayLike<number>,
  window: WindowLevel,
  invert = false,
  out = new Uint8ClampedArray(values.length * 4),
): Uint8ClampedArray {
  const c = window.center - 0.5
  const w = Math.max(1, window.width - 1)
  for (let i = 0; i < values.length; i++) {
    let g = (((values[i] ?? 0) - c) / w + 0.5) * 255
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

/** Distancia en mm entre dos puntos de una imagen de plano. */
export function planeDistanceMm(image: Pick<PlaneImage, "colMm" | "rowMm">, a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot((b.x - a.x) * image.colMm, (b.y - a.y) * image.rowMm)
}

/** Ángulo en grados en el vértice `b` (tres puntos), con el espaciado del plano. */
export function planeAngleDeg(
  image: Pick<PlaneImage, "colMm" | "rowMm">,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const u = [(a.x - b.x) * image.colMm, (a.y - b.y) * image.rowMm]
  const v = [(c.x - b.x) * image.colMm, (c.y - b.y) * image.rowMm]
  const dot = u[0]! * v[0]! + u[1]! * v[1]!
  const norm = Math.hypot(u[0]!, u[1]!) * Math.hypot(v[0]!, v[1]!)
  return norm ? (Math.acos(Math.max(-1, Math.min(1, dot / norm))) * 180) / Math.PI : 0
}

/** Arma un volumen a partir de cortes ya en memoria (pruebas y demostración). */
export function volumeFromSlices(
  slices: readonly Int16Array[],
  geometry: { nx: number; ny: number; sx: number; sy: number; sz: number },
): CbctVolume {
  const plane = geometry.nx * geometry.ny
  const data = new Int16Array(plane * slices.length)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  slices.forEach((slice, k) => {
    data.set(slice, k * plane)
    for (const v of slice) {
      if (v < min) min = v
      if (v > max) max = v
    }
  })
  const range = { min, max }
  return { ...geometry, nz: slices.length, data, range, presets: computePresets(data, range) }
}
