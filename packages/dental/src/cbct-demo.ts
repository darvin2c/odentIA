/**
 * Tomografía de haz cónico de DEMOSTRACIÓN: un fantoma sintético de los dos
 * maxilares (hueso cortical y esponjoso, 27 piezas con esmalte, dentina y
 * pulpa, la 36 ausente con su reborde, los dos conductos dentarios hasta el
 * agujero mentoniano y los senos maxilares), guardado como serie CT de PS3.3
 * A.3, un archivo por corte axial. Con `dentition: "primary"` es la boca de un
 * niño: las 20 piezas de leche (51 a 85) en un arco más chico. No es de un
 * paciente: sirve para la semilla y las pruebas del visor.
 *
 * Coordenadas del paciente en mm según DICOM (LPS: +x a la izquierda del
 * paciente, +y hacia atrás, +z hacia arriba), con el plano oclusal en z = 0.
 * Valores en unidades Hounsfield; se guardan como HU + 1000 en 12 bits.
 */

export type CbctDentition = "permanent" | "primary"

/** Arco: y = front + curve · x² (parábola), en el plano axial, hasta |x| = maxX. */
interface ArchShape {
  front: number
  curve: number
  maxX: number
}

interface DentitionShape {
  /** Ancho mesiodistal de cada pieza desde la línea media, en mm. */
  widths: { upper: readonly number[]; lower: readonly number[] }
  rootLengths: { upper: readonly number[]; lower: readonly number[] }
  /** Alto de la corona, en mm. */
  crown: number
  /** Posición (1 = incisivo central) desde la que las piezas son molares. */
  molarFrom: number
  /** Cuadrantes FDI: derecha del paciente (−x) e izquierda. */
  quadrants: { upper: readonly [number, number]; lower: readonly [number, number] }
  /** Piezas ausentes (FDI) y el tramo del arco donde queda su reborde. */
  missing: ReadonlySet<number>
  arch: ArchShape
}

const DENTITIONS: Record<CbctDentition, DentitionShape> = {
  permanent: {
    widths: { upper: [5.5, 6, 7, 7, 7, 10, 9.5], lower: [5.5, 6, 7, 7, 7, 10, 9.5] },
    rootLengths: { upper: [13, 13, 17, 14, 14, 13, 13], lower: [12.5, 12.5, 16, 14, 14, 14, 13.5] },
    crown: 7.6,
    molarFrom: 6,
    quadrants: { upper: [1, 2], lower: [4, 3] },
    // La del ejemplo del implante.
    missing: new Set([36]),
    arch: { front: -20, curve: 0.035, maxX: 34 },
  },
  primary: {
    // Medias de 52 niños (Martínez de Pinillos, Zenodo, doi:10.5281/zenodo.17619010,
    // CC BY 4.0): las mismas de «Ir a la pieza» en el visor.
    widths: { upper: [5.03, 4.87, 6.18, 7.12, 8.93], lower: [3.82, 4.29, 5.65, 8.24, 10.06] },
    // Raíces y coronas de leche: más cortas que las permanentes.
    rootLengths: { upper: [10, 11, 13, 10, 11], lower: [9, 10, 11.5, 9.5, 11] },
    crown: 6,
    molarFrom: 4,
    quadrants: { upper: [5, 6], lower: [8, 7] },
    missing: new Set(),
    arch: { front: -16, curve: 0.06, maxX: 24 },
  },
}

export interface ArchPoint {
  x: number
  y: number
  /** Longitud del arco desde la línea media (negativa a la derecha del paciente). */
  s: number
}

/** Puntos de la línea media del arco, cada 0,1 mm de x, de derecha a izquierda. */
function archTable(arch: ArchShape): ArchPoint[] {
  const out: ArchPoint[] = []
  let s = 0
  let prev: { x: number; y: number } | null = null
  const half: ArchPoint[] = []
  for (let x = 0; x <= arch.maxX + 1e-9; x += 0.1) {
    const y = arch.front + arch.curve * x * x
    if (prev) s += Math.hypot(x - prev.x, y - prev.y)
    half.push({ x, y, s })
    prev = { x, y }
  }
  for (let i = half.length - 1; i > 0; i--) {
    const p = half[i]!
    out.push({ x: -p.x, y: p.y, s: -p.s })
  }
  return out.concat(half)
}

export interface DemoTooth {
  /** Número FDI. */
  fdi: number
  jaw: "upper" | "lower"
  /** Centro sobre el arco. */
  s: number
  width: number
  rootLength: number
  crown: number
  molar: boolean
}

/** Las piezas del fantoma con su posición sobre el arco (las ausentes no figuran). */
export function cbctDemoTeeth(dentition: CbctDentition = "permanent"): DemoTooth[] {
  const shape = DENTITIONS[dentition]
  const teeth: DemoTooth[] = []
  for (const jaw of ["upper", "lower"] as const) {
    for (const side of [-1, 1] as const) {
      let s = 0
      shape.widths[jaw].forEach((width, i) => {
        const center = s + width / 2
        s += width
        const quadrant = shape.quadrants[jaw][side < 0 ? 0 : 1]!
        const fdi = quadrant * 10 + i + 1
        if (shape.missing.has(fdi)) return
        teeth.push({
          fdi,
          jaw,
          s: side * center,
          width,
          rootLength: shape.rootLengths[jaw][i]!,
          crown: shape.crown,
          molar: i + 1 >= shape.molarFrom,
        })
      })
    }
  }
  return teeth
}

/** Tramos del arco (|s|, del lado izquierdo) donde falta una pieza de abajo: ahí queda el reborde. */
function lowerGaps(shape: DentitionShape): Array<[number, number]> {
  const gaps: Array<[number, number]> = []
  let s = 0
  shape.widths.lower.forEach((width, i) => {
    if (shape.missing.has(shape.quadrants.lower[1] * 10 + i + 1)) gaps.push([s + 0.5, s + width + 0.5])
    s += width
  })
  return gaps
}

export interface CbctPhantomOptions {
  /** Columnas y filas del corte. */
  size?: number
  slices?: number
  voxelMm?: number
  seed?: number
  /** «primary»: la boca de un niño, con las piezas de leche. */
  dentition?: CbctDentition
}

export interface CbctPhantom {
  size: number
  slices: number
  voxelMm: number
  /** Esquina del primer vóxel (x, y) y z de cada corte, en mm. */
  origin: [number, number]
  sliceZ: number[]
  /** Valores guardados (HU + 1000) de cada corte, fila por fila. */
  data: Uint16Array[]
}

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smoothstep = (edge0: number, edge1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Genera el volumen. Con los valores por omisión: 200 × 200 × 180 vóxeles de 0,4 mm (80 × 80 × 72 mm). */
export function generateCbctPhantom(options: CbctPhantomOptions = {}): CbctPhantom {
  const size = options.size ?? 200
  const slices = options.slices ?? 180
  const v = options.voxelMm ?? 0.4
  const random = rng(options.seed ?? 34)
  const dentition = options.dentition ?? "permanent"
  const shape = DENTITIONS[dentition]
  const { front, curve, maxX } = shape.arch
  const x0 = -(size * v) / 2
  const y0 = -(size * v) / 2 + 2
  const zBottom = -38
  const arch = archTable(shape.arch)
  const teeth = cbctDemoTeeth(dentition)
  // Detrás del último molar ya no hay reborde.
  const archEnd = Math.max(...teeth.map((t) => Math.abs(t.s) + t.width / 2))
  // En las proporciones del adulto: el conducto desde los 22 mm de 52 y el borde inferior sube hasta los 50.
  const canalFrom = (archEnd * 22) / 52
  const chinTo = (archEnd * 50) / 52
  const gaps = lowerGaps(shape)

  // Por cada columna (x, y): punto más cercano del arco, distancia con signo
  // (positiva hacia afuera, del lado de la mejilla) y piezas cercanas.
  const n2 = size * size
  const archS = new Float32Array(n2)
  const archD = new Float32Array(n2)
  const inside = new Uint8Array(n2)
  for (let r = 0; r < size; r++) {
    const y = y0 + r * v
    for (let c = 0; c < size; c++) {
      const x = x0 + c * v
      let best = Number.POSITIVE_INFINITY
      let bestS = 0
      let bestY = 0
      // El arco es monótono en x: basta mirar alrededor de la misma x.
      const center = Math.round((x + maxX) / 0.1)
      for (let k = Math.max(0, center - 400); k < Math.min(arch.length, center + 400); k += 2) {
        const p = arch[k]!
        const d = (p.x - x) ** 2 + (p.y - y) ** 2
        if (d < best) {
          best = d
          bestS = p.s
          bestY = p.y
        }
      }
      const at = r * size + c
      archS[at] = bestS
      // Afuera del arco = delante de la curva (y menor que la curva en esa x).
      const curveY = front + curve * x * x
      const outward = y < curveY ? 1 : -1
      archD[at] = Math.sqrt(best) * outward
      inside[at] = y > curveY && Math.abs(x) < maxX && y < bestY + 30 ? 1 : 0
    }
  }

  const sliceZ: number[] = []
  const data: Uint16Array[] = []
  for (let k = 0; k < slices; k++) {
    const z = zBottom + k * v
    sliceZ.push(z)
    const out = new Uint16Array(n2)
    for (let r = 0; r < size; r++) {
      const y = y0 + r * v
      for (let c = 0; c < size; c++) {
        const x = x0 + c * v
        const at = r * size + c
        const s = archS[at]!
        const d = archD[at]!
        const sideS = Math.abs(s)
        const beyondArch = sideS > archEnd // detrás del último molar
        let hu = -1000
        // Partes blandas: la cara, más ancha arriba.
        if ((x / 46) ** 2 + ((y - 4) / 44) ** 2 + (z / 52) ** 2 < 1) hu = 35

        // Maxilar superior: reborde alveolar y cuerpo hasta el piso de los senos.
        if (z > 9 && z < 40 && !beyondArch) {
          const half = 4 + 3 * smoothstep(9, 22, z)
          if (Math.abs(d) < half) hu = Math.abs(d) > half - 1.5 || z < 10.5 ? 1300 : 420
        }
        // Paladar duro y base del maxilar (por dentro del arco).
        if (inside[at] && z > 19 && z < 23.5) hu = 1150
        if (z >= 23.5 && z < 40 && Math.abs(x) < 33 && y > -16 && y < 22 && (inside[at] || Math.abs(d) < 7)) {
          hu = hu > 1000 ? hu : 380
          // Senos maxilares y fosas nasales: aire.
          for (const sx of [-21, 21]) {
            if (((x - sx) / 11) ** 2 + ((y - 7) / 12) ** 2 + ((z - 33) / 8) ** 2 < 1) hu = -950
          }
          if (Math.abs(x) < 6 && y > -12 && z > 25) hu = -900
        }

        // Mandíbula: cuerpo con su cortical y el conducto dentario.
        const ridge = s > 0 && gaps.some(([from, to]) => sideS > from && sideS < to) ? -11.5 : -9.5 // reborde de la ausente
        const bottom = -36 + 2 * smoothstep(0, chinTo, sideS)
        if (z < ridge && z > bottom && !beyondArch) {
          const half = 3.5 + 2.6 * smoothstep(ridge, ridge - 11, z) - 0.6 * smoothstep(bottom + 5, bottom, z)
          if (Math.abs(d) < half) {
            const shell = Math.abs(d) > half - 1.7 || z < bottom + 1.8 || z > ridge - 0.9
            hu = shell ? 1450 : 470
            // Conducto: de la rama (atrás) al agujero mentoniano.
            if (sideS > canalFrom) {
              const zc = -27 + (sideS - canalFrom) * 0.12
              const dc = Math.hypot(d + 0.6, z - zc)
              if (dc < 1.3) hu = 60
              else if (dc < 1.8) hu = 950
            }
          }
        }

        // Piezas: la más cercana sobre el arco, con corona, raíz y pulpa.
        for (const tooth of teeth) {
          const ds = s - tooth.s
          if (Math.abs(ds) > tooth.width / 2 + 0.5) continue
          const upper = tooth.jaw === "upper"
          // Altura medida desde el plano oclusal hacia la raíz.
          const h = upper ? z - 0.4 : -z - 0.4
          const crown = tooth.crown
          if (h < 0 || h > crown + tooth.rootLength) continue
          const molar = tooth.molar
          const mdHalf = tooth.width / 2 - 0.4
          const blHalf = molar ? (dentition === "primary" ? 4.2 : 5) : tooth.width <= 6 ? 3.2 : 3.8
          let inTooth = false
          let pulp = false
          let enamel = false
          if (h <= crown) {
            // Corona: algo más angosta en el borde oclusal.
            const taper = 0.82 + 0.18 * smoothstep(0, 2.5, h)
            const e = (ds / (mdHalf * taper)) ** 2 + (d / (blHalf * taper)) ** 2
            inTooth = e < 1
            enamel = inTooth && (e > 0.62 || h < 1.2)
            pulp = (ds / (mdHalf * 0.3)) ** 2 + (d / (blHalf * 0.32)) ** 2 < 1 && h > crown * 0.46
          } else {
            const t = (h - crown) / tooth.rootLength
            const shrink = 0.62 * (1 - t) + 0.18
            if (molar) {
              // Dos raíces (mesial y distal) que se separan hacia el ápice.
              for (const offset of [-1, 1]) {
                const cx = offset * mdHalf * (0.42 + 0.12 * t)
                const e = ((ds - cx) / (mdHalf * 0.36 * (1 - 0.5 * t))) ** 2 + (d / (blHalf * shrink)) ** 2
                if (e < 1) {
                  inTooth = true
                  pulp = pulp || e < 0.05
                }
              }
            } else {
              const e = (ds / (mdHalf * shrink)) ** 2 + (d / (blHalf * shrink)) ** 2
              inTooth = e < 1
              pulp = e < 0.06
            }
          }
          if (inTooth) {
            hu = pulp ? 120 : enamel ? 2850 : 1750
            break
          }
        }
        hu += (random() + random() + random() - 1.5) * 40
        out[at] = Math.max(0, Math.min(4095, Math.round(hu + 1000)))
      }
    }
    data.push(out)
  }
  return { size, slices, voxelMm: v, origin: [x0, y0], sliceZ, data }
}
