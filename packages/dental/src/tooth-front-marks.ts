/**
 * Qué se dibuja de frente en una pieza según sus hallazgos vigentes. Cada símbolo va donde la
 * NTS 188 lo pone (en la corona, en la raíz o a la altura de los ápices), con nuestro diente:
 * el gráfico de la norma ya es una vista de frente. Rojo y azul como en el arco
 * (`findingColor`); lo que no tiene color (registro previo en revisión, estado sin elegir) no se
 * dibuja. Las caras palatina y lingual, las fosas y fisuras y los sellantes no se ven de frente:
 * esos quedan en el arco de arriba (mesa del 23 nov 2026, voz clínica).
 */
import { findingColor } from "./findings.js"
import { mesialIsRight } from "./tooth-front.js"
import type { FindingDetails } from "./types.js"

export type Paint = "red" | "blue"

/** Lo mínimo de un hallazgo que hace falta para dibujarlo. */
export interface FrontEntry {
  id: string
  toothNumber: number
  condition: string
  surface?: string | null
  details?: FindingDetails | null
  needsReview?: boolean
}

export type FrontZone = "edge" | "mesial" | "distal" | "face"

export interface FrontSurfaceMark {
  zone: FrontZone
  paint: Paint
  /** fill: caries y restauración; contour: restauración temporal y defecto del esmalte; wear: desgaste. */
  style: "fill" | "contour" | "wear"
}

export interface FrontMarks {
  /**
   * Qué hay en el lugar de la pieza: la pieza, nada (ausente), lo que la repone (póntico del
   * puente, implante, diente de la prótesis) o solo su raíz (remanente radicular).
   */
  body: "tooth" | "missing" | "pontic" | "implant" | "denture" | "remnant" | "none"
  /** Color de lo que la repone o de la ausencia. */
  bodyPaint?: Paint
  /** Corrimiento hacia la raíz (+) o hacia el plano oclusal (−), en altos de corona. */
  shift: number
  /** Inclinación de la corona en grados: + hacia mesial. */
  tilt: number
  /** Tamaño de la corona (macrodoncia, microdoncia). */
  size: number
  peg?: Paint
  crown?: Paint
  canals?: Paint
  post?: Paint
  pulpotomy?: Paint
  /** El implante lleva corona encima. */
  implantCrown?: Paint
  surfaces: FrontSurfaceMark[]
  fracture?: Paint
  mobility?: { paint: Paint; grade?: number }
  rotation?: { paint: Paint; clockwise: boolean }
  arrow?: { kind: "erupting" | "extruded" | "intruded"; paint: Paint }
  gemination?: Paint
  bracket?: Paint
  /** Círculo sobre el número (geminación, fusión). */
  ringNumber?: Paint
  /** La pieza no erupcionada (impactada): queda dentro de la encía. */
  buried: boolean
}

function paintOf(entry: FrontEntry): Paint | null {
  return findingColor({
    condition: entry.condition,
    details: entry.details ?? undefined,
    needsReview: entry.needsReview,
  })
}

const FACE: Record<string, FrontZone | null> = {
  occlusal: "edge",
  incisal: "edge",
  facial: "face",
  buccal: "face",
  mesial: "mesial",
  distal: "distal",
  palatal: null,
  lingual: null,
}

/** Los hallazgos que reponen la pieza: se dibuja lo que la repone, no la ausencia. */
const REPLACES = new Set([
  "fixed_partial_denture",
  "implant",
  "complete_denture",
  "removable_partial_denture",
])

/**
 * Lo que se dibuja de frente en `tooth` con sus hallazgos vigentes, del más nuevo al más viejo: si
 * la misma cosa se anotó dos veces (el perno, primero bien y después roto), manda la más nueva.
 */
export function frontMarksOf(tooth: number, entries: readonly FrontEntry[]): FrontMarks {
  const marks: FrontMarks = {
    body: "tooth",
    shift: 0,
    tilt: 0,
    size: 1,
    surfaces: [],
    buried: false,
  }
  const painted = entries.flatMap((entry) => {
    const paint = paintOf(entry)
    return paint ? [{ entry, paint }] : []
  })
  const find = (condition: string) => painted.find(({ entry }) => entry.condition === condition)
  const missing = find("missing_tooth") ?? find("edentulous_arch")
  const bridge = find("fixed_partial_denture")
  const implant = find("implant")
  const denture = find("complete_denture") ?? find("removable_partial_denture")
  const abutment = bridge?.entry.details?.abutmentTeeth?.includes(tooth) === true
  if (implant) {
    marks.body = "implant"
    marks.bodyPaint = implant.paint
    const crown = find("crown") ?? find("temporary_crown")
    // El implante que es pilar de un puente lleva la corona del puente.
    const cover = crown?.paint ?? (bridge && abutment ? bridge.paint : undefined)
    if (cover) marks.implantCrown = cover
  } else if (bridge && !abutment) {
    marks.body = "pontic"
    marks.bodyPaint = bridge.paint
  } else if (denture && (missing || denture.entry.condition === "complete_denture")) {
    marks.body = "denture"
    marks.bodyPaint = denture.paint
  } else if (find("edentulous_arch")) {
    marks.body = "none"
    marks.bodyPaint = find("edentulous_arch")!.paint
  } else if (missing) {
    marks.body = "missing"
    marks.bodyPaint = missing.paint
  } else if (find("root_remnant")) {
    marks.body = "remnant"
    marks.bodyPaint = find("root_remnant")!.paint
  }
  // La pieza que no está (o que solo es raíz) no lleva lo de la corona.
  const hasCrown = marks.body === "tooth"
  const mesialRight = mesialIsRight(tooth)
  for (const { entry, paint } of painted) {
    const details = entry.details ?? {}
    switch (entry.condition) {
      case "crown":
      case "temporary_crown":
        if (hasCrown || (bridge && abutment)) marks.crown ??= paint
        break
      case "fixed_partial_denture":
        // Los pilares llevan su corona, del color del puente.
        if (abutment) marks.crown = marks.crown ?? paint
        break
      case "root_canal_treatment":
        if (marks.body === "tooth" || marks.body === "remnant") marks.canals ??= paint
        break
      case "post_and_core":
        if (marks.body === "tooth" || marks.body === "remnant") marks.post ??= paint
        break
      case "pulpotomy":
        if (hasCrown) marks.pulpotomy ??= paint
        break
      case "caries":
      case "definitive_restoration":
      case "temporary_restoration":
      case "tooth_wear":
      case "enamel_development_defect": {
        if (!hasCrown) break
        const zone = entry.surface ? FACE[entry.surface] : null
        if (!zone) break
        const style =
          entry.condition === "tooth_wear"
            ? "wear"
            : entry.condition === "temporary_restoration" ||
                entry.condition === "enamel_development_defect"
              ? "contour"
              : "fill"
        marks.surfaces.push({ zone, paint, style })
        break
      }
      case "fracture":
        if (hasCrown || marks.body === "remnant") marks.fracture ??= paint
        break
      case "pathological_mobility":
        marks.mobility ??= {
          paint,
          grade: Number.isInteger(details.grade) ? (details.grade as number) : undefined,
        }
        break
      case "rotation":
        if (hasCrown)
          marks.rotation ??= { paint, clockwise: details.direction !== "counterclockwise" }
        break
      case "erupting_tooth":
        if (hasCrown) {
          marks.arrow ??= { kind: "erupting", paint }
          marks.shift = Math.max(marks.shift, 0.45)
        }
        break
      case "extruded_tooth":
        if (hasCrown) {
          marks.arrow ??= { kind: "extruded", paint }
          marks.shift = -0.22
        }
        break
      case "intruded_tooth":
        if (hasCrown) {
          marks.arrow ??= { kind: "intruded", paint }
          marks.shift = Math.max(marks.shift, 0.28)
        }
        break
      case "impaction":
        if (hasCrown) {
          marks.buried = true
          marks.shift = Math.max(marks.shift, 1.15)
          // La tercera molar retenida suele estar inclinada hacia mesial (Winter).
          if (tooth % 10 === 8) marks.tilt = 18
        }
        break
      case "ectopic_tooth":
        if (hasCrown) marks.shift = Math.max(marks.shift, 0.4)
        break
      case "abnormal_position": {
        if (!hasCrown) break
        const positions = details.positions ?? []
        if (positions.includes("mesial")) marks.tilt = 9
        else if (positions.includes("distal")) marks.tilt = -9
        break
      }
      case "macrodontia":
        if (hasCrown) marks.size = 1.15
        break
      case "microdontia":
        if (hasCrown) marks.size = 0.78
        break
      case "peg_tooth":
        if (hasCrown) marks.peg ??= paint
        break
      case "gemination":
        if (hasCrown) {
          marks.gemination = paint
          marks.ringNumber = paint
        }
        break
      case "fusion":
        marks.ringNumber = paint
        break
      case "fixed_orthodontic_appliance":
        if (hasCrown || marks.body === "pontic") marks.bracket ??= paint
        break
      default:
        break
    }
  }
  // El signo de la inclinación se da hacia mesial: en el dibujo, mesial puede ser izquierda.
  if (!mesialRight) marks.tilt = -marks.tilt
  return marks
}

/** Lo que una fila dibuja entre piezas o a lo largo de un tramo. */
export interface FrontRowMark {
  kind:
    | "bridge"
    | "fusion"
    | "diastema"
    | "transposition"
    | "supernumerary"
    | "orthodontic_wire"
    | "removable_orthodontic"
    | "denture_lines"
    | "edentulous_line"
  paint: Paint
  /** Las piezas del tramo o del par que están en la fila, en el orden en que se ven. */
  teeth: number[]
  /**
   * Parte del par o del tramo está en otra fila (una arcada en dos filas de 8: el diastema entre la
   * 11 y la 21 queda partido en la línea media). Se dibuja la mitad del lado de esa línea.
   */
  split: boolean
}

const ROW_KINDS: Record<string, FrontRowMark["kind"]> = {
  fixed_partial_denture: "bridge",
  fusion: "fusion",
  diastema: "diastema",
  transposition: "transposition",
  supernumerary_tooth: "supernumerary",
  fixed_orthodontic_appliance: "orthodontic_wire",
  removable_orthodontic_appliance: "removable_orthodontic",
  complete_denture: "denture_lines",
  removable_partial_denture: "denture_lines",
  edentulous_arch: "edentulous_line",
}

/**
 * Lo de par, tramo o arcada que se dibuja a lo largo de una fila (puentes, fusiones, diastemas,
 * aparatos, prótesis), una vez por hallazgo, con las piezas de la fila que abarca.
 */
export function frontRowMarksOf(
  row: readonly number[],
  entriesOf: (tooth: number) => readonly FrontEntry[],
): FrontRowMark[] {
  const seen = new Set<string>()
  const marks: FrontRowMark[] = []
  for (const tooth of row) {
    for (const entry of entriesOf(tooth)) {
      const kind = ROW_KINDS[entry.condition]
      if (!kind || seen.has(entry.id)) continue
      seen.add(entry.id)
      const paint = paintOf(entry)
      if (!paint) continue
      const related = entry.details?.relatedTeeth?.length
        ? entry.details.relatedTeeth
        : [entry.toothNumber]
      const teeth = row.filter((item) => related.includes(item))
      if (teeth.length === 0) continue
      marks.push({ kind, paint, teeth, split: related.some((item) => !row.includes(item)) })
    }
  }
  return marks
}
