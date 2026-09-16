/** Anatomía FDI y superficies. Copia canónica: los consumidores importan de aquí. */
import type { Surface, ToothType } from "./types.js"

/** Norma del odontograma. */
export const ODONTOGRAM_STANDARD = "NTS 188-MINSA/DGIESP-2022"

/** Piezas FDI permanentes 11-18, 21-28, 31-38, 41-48. */
export const FDI_ADULT: readonly number[] = [
  11, 12, 13, 14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 26, 27, 28, 31, 32, 33, 34, 35, 36, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48,
]

/** Piezas FDI temporales 51-55, 61-65, 71-75, 81-85. */
export const FDI_CHILD: readonly number[] = [
  51, 52, 53, 54, 55, 61, 62, 63, 64, 65, 71, 72, 73, 74, 75, 81, 82, 83, 84, 85,
]

/** Dentición adulta: 32 piezas FDI (cuadrantes ordenados de derecha a izquierda). */
export const FDI_ADULT_ROWS: readonly (readonly number[])[] = [
  [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
]

/** Dentición temporal: 20 piezas FDI. */
export const FDI_CHILD_ROWS: readonly (readonly number[])[] = [
  [55, 54, 53, 52, 51, 61, 62, 63, 64, 65],
  [85, 84, 83, 82, 81, 71, 72, 73, 74, 75],
]

/** Las 52 piezas FDI válidas (permanentes + temporales). */
export const VALID_FDI_TEETH: readonly number[] = [...FDI_ADULT, ...FDI_CHILD]

/** Superficies en inglés. Cara externa: `facial` en anteriores, `buccal` en posteriores. */
export const SURFACES: readonly string[] = [
  "mesial",
  "distal",
  "buccal",
  "facial",
  "lingual",
  "palatal",
  "occlusal",
  "incisal",
]

/** Verdadero si es pieza FDI válida: entero con cuadrante 1-8; temporales (5-8) solo dígitos 1-5. */
export function isValidTooth(n: number): boolean {
  if (!Number.isInteger(n)) return false
  const abs = Math.abs(n)
  const quadrant = Math.trunc(abs / 10)
  const digit = abs % 10
  if (quadrant >= 1 && quadrant <= 4) return digit >= 1 && digit <= 8
  if (quadrant >= 5 && quadrant <= 8) return digit >= 1 && digit <= 5
  return false
}

/** Cuadrante FDI (1-8) o 0 si la pieza es inválida. */
function quadrantOf(toothNumber: number): number {
  if (!isValidTooth(toothNumber)) return 0
  return Math.trunc(Math.abs(toothNumber) / 10)
}

/** Verdadero si la pieza es del maxilar superior (cuadrantes 1, 2, 5, 6). */
export function isUpperTooth(toothNumber: number): boolean {
  const q = quadrantOf(toothNumber)
  return q === 1 || q === 2 || q === 5 || q === 6
}

/** Verdadero si la pieza es temporal (cuadrantes 5-8). */
export function isPrimaryTooth(toothNumber: number): boolean {
  const q = quadrantOf(toothNumber)
  return q >= 5 && q <= 8
}

/**
 * Tipo de pieza según el segundo dígito FDI: 1-2 incisivo, 3 canino, 4-5 premolar,
 * 6-8 molar. En dentición temporal no hay premolares: 54/55/64/65/74/75/84/85 son molares.
 */
export function toothTypeOf(toothNumber: number): ToothType {
  if (!isValidTooth(toothNumber)) throw new RangeError("Pieza FDI inválida")
  const digit = Math.abs(toothNumber) % 10
  if (digit === 1 || digit === 2) return "incisor"
  if (digit === 3) return "canine"
  if (digit === 4 || digit === 5) return isPrimaryTooth(toothNumber) ? "molar" : "premolar"
  return "molar"
}

/** Etiqueta en español de la superficie; el valor desconocido se devuelve tal cual. */
export function surfaceLabel(surface: string): string {
  switch (surface) {
    case "mesial":
      return "Mesial"
    case "distal":
      return "Distal"
    case "buccal":
      return "Vestibular"
    case "facial":
      return "Facial"
    case "lingual":
      return "Lingual"
    case "palatal":
      return "Palatina"
    case "occlusal":
      return "Oclusal"
    case "incisal":
      return "Incisal"
    default:
      return surface
  }
}

/**
 * Superficies válidas de la pieza: mesial, distal, cara externa (facial/labial en
 * anteriores, buccal/vestibular en posteriores) y palatina (superior) o lingual
 * (inferior); incisal en anteriores (incisivo/canino) u oclusal en posteriores
 * (premolar/molar, incluyendo molares temporales).
 */
export function surfacesForTooth(toothNumber: number): Surface[] {
  if (!isValidTooth(toothNumber)) throw new RangeError("Pieza FDI inválida")
  const type = toothTypeOf(toothNumber)
  const anterior = type === "incisor" || type === "canine"
  const surfaces: Surface[] = ["mesial", "distal", anterior ? "facial" : "buccal"]
  surfaces.push(isUpperTooth(toothNumber) ? "palatal" : "lingual")
  surfaces.push(anterior ? "incisal" : "occlusal")
  return surfaces
}

/** Nombre español de la pieza FDI, ej. 22 → "Incisivo lateral superior izquierdo". */
export function toothNameOf(toothNumber: number): string {
  const n = Math.abs(Math.trunc(toothNumber))
  const quadrant = Math.trunc(n / 10)
  const digit = n % 10
  let arcada: string
  switch (quadrant) {
    case 1:
    case 5:
      arcada = "superior derecho"
      break
    case 2:
    case 6:
      arcada = "superior izquierdo"
      break
    case 3:
    case 7:
      arcada = "inferior izquierdo"
      break
    case 4:
    case 8:
      arcada = "inferior derecho"
      break
    default:
      throw new RangeError("Pieza FDI inválida")
  }
  const temporal = quadrant >= 5 && quadrant <= 8
  let base: string
  switch (digit) {
    case 1:
      base = "Incisivo central"
      break
    case 2:
      base = "Incisivo lateral"
      break
    case 3:
      base = "Canino"
      break
    case 4:
      base = temporal ? "Primer molar" : "Primer premolar"
      break
    case 5:
      base = temporal ? "Segundo molar" : "Segundo premolar"
      break
    case 6:
      base = "Primer molar"
      break
    case 7:
      base = "Segundo molar"
      break
    case 8:
      base = "Tercer molar"
      break
    default:
      throw new RangeError("Pieza FDI inválida")
  }
  return `${base} ${arcada}`
}
