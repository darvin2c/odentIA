/**
 * Color, sigla, validación y vigencia de hallazgos del odontograma.
 * Reglas conservadoras fundadas en la NTS 188: todo valor desconocido,
 * incompatible o fuera de anatomía se rechaza (fail closed) con mensajes en español.
 */
import {
  FDI_ADULT_ROWS,
  FDI_CHILD_ROWS,
  isPrimaryTooth,
  isUpperTooth,
  isValidTooth,
  SURFACES,
  surfacesForTooth,
} from "./anatomy.js"
import { findingDefinition } from "./catalog.js"
import type { FindingDetails, FindingInput, FindingRecord } from "./types.js"

interface ColorEntry {
  condition: string
  details?: FindingDetails
  needsReview?: boolean
}

/**
 * Color clínico del hallazgo: rojo/azul normativos o null cuando no hay color
 * (observación libre, revisión pendiente o falta el dato que define el color).
 * Nunca usa `status`: el color deriva del código clínico, no del flujo de trabajo.
 */
export function findingColor(entry: ColorEntry): "red" | "blue" | null {
  if (entry.needsReview) return null
  const def = findingDefinition(entry.condition)
  if (!def) return null
  if (def.color === "red") return "red"
  if (def.color === "blue") return "blue"
  if (def.color === "quality") {
    if (entry.details?.quality === "good") return "blue"
    if (entry.details?.quality === "poor") return "red"
    return null
  }
  return null
}

const FIXED_ABBREVIATIONS: Record<string, string> = {
  temporary_crown: "CT",
  deep_pits_fissures: "FFP",
  impaction: "I",
  implant: "IMP",
  macrodontia: "MAC",
  microdontia: "MIC",
  ectopic_tooth: "E",
  supernumerary_tooth: "S",
  pulpotomy: "PP",
  root_remnant: "RR",
  sealant: "S",
  tooth_wear: "DES",
}

const VARIANT_ABBREVIATED: Record<string, true> = {
  crown: true,
  enamel_development_defect: true,
  caries: true,
  missing_tooth: true,
  definitive_restoration: true,
  root_canal_treatment: true,
}

const POSITION_LETTERS: Record<string, string> = {
  mesial: "M",
  distal: "D",
  buccal: "V",
  palatal: "P",
  lingual: "L",
}

const POSITION_ORDER = ["mesial", "distal", "buccal", "palatal", "lingual"]

/**
 * Sigla oficial del hallazgo según variante y datos ("M3", "D+L", "CDP"...).
 * Sin sigla normada devuelve "" (símbolo gráfico o texto libre, nunca "Otro").
 */
export function findingAbbreviation(entry: ColorEntry): string {
  const details = entry.details ?? {}
  const fixed = Object.hasOwn(FIXED_ABBREVIATIONS, entry.condition)
    ? FIXED_ABBREVIATIONS[entry.condition]
    : undefined
  if (fixed !== undefined) return fixed
  if (Object.hasOwn(VARIANT_ABBREVIATED, entry.condition)) {
    const variant = findingDefinition(entry.condition)?.variants?.find(
      (item) => item.value === details.variant,
    )
    return variant?.abbreviation ?? ""
  }
  if (entry.condition === "pathological_mobility") {
    return Number.isInteger(details.grade) && (details.grade as number) >= 1
      ? `M${details.grade}`
      : "M"
  }
  if (entry.condition === "abnormal_position") {
    const positions = Array.isArray(details.positions) ? details.positions : []
    return POSITION_ORDER.filter((position) => positions.includes(position))
      .map((position) => POSITION_LETTERS[position])
      .join("+")
  }
  return ""
}

const KNOWN_DETAIL_KEYS: Record<string, true> = {
  variant: true,
  quality: true,
  grade: true,
  direction: true,
  positions: true,
  relatedTeeth: true,
  abutmentTeeth: true,
  clinicallyObserved: true,
  drawing: true,
  specifications: true,
  observations: true,
}

const POSITION_VALUES: Record<string, true> = {
  mesial: true,
  distal: true,
  buccal: true,
  palatal: true,
  lingual: true,
}

/** Trazos máximos por dibujo y puntos máximos por trazo (cota de guarda de UI). */
const MAX_DRAWING_STROKES = 64
const MAX_STROKE_POINTS = 512
/** Longitud máxima de textos libres (especificaciones, observaciones, nota). */
const MAX_TEXT = 2000

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) return undefined
  return value as string[]
}

function archRowOf(toothNumber: number): readonly number[] {
  const rows = [...FDI_ADULT_ROWS, ...FDI_CHILD_ROWS]
  return rows.find((row) => row.includes(toothNumber)) ?? []
}

/** Valida la forma del dibujo libre; devuelve verdadero si es finito y acotado. */
function pushDrawingErrors(errors: string[], drawing: unknown, minPoints: number): boolean {
  if (!Array.isArray(drawing) || drawing.length === 0) {
    errors.push("El dibujo del hallazgo es inválido.")
    return false
  }
  if (drawing.length > MAX_DRAWING_STROKES) {
    errors.push(`El dibujo supera el máximo de ${MAX_DRAWING_STROKES} trazos.`)
    return false
  }
  let ok = true
  for (const stroke of drawing) {
    if (!Array.isArray(stroke) || stroke.length < minPoints || stroke.length > MAX_STROKE_POINTS) {
      errors.push("Cada trazo del dibujo requiere puntos [x, y] válidos.")
      ok = false
      break
    }
    for (const point of stroke) {
      if (
        !Array.isArray(point) ||
        point.length !== 2 ||
        typeof point[0] !== "number" ||
        typeof point[1] !== "number" ||
        !Number.isFinite(point[0]) ||
        !Number.isFinite(point[1]) ||
        point[0] < 0 ||
        point[0] > 100 ||
        point[1] < 0 ||
        point[1] > 100
      ) {
        errors.push("Cada punto del dibujo debe ser [x, y] con valores finitos de 0 a 100.")
        ok = false
        break
      }
    }
    if (!ok) break
  }
  return ok
}

/**
 * Valida un registro de hallazgo nuevo. Devuelve la lista de errores en español;
 * vacía significa válido. Es fail closed: condición desconocida, anatomía inválida,
 * variante/calidad/grado/dirección/posición incompatibles, superficies ajenas a la
 * pieza, tramos no contiguos, arcadas incompletas, evidencia clínica faltante,
 * dibujo ausente o campos no reconocidos producen error.
 */
export function validateFinding(input: FindingInput): string[] {
  const errors: string[] = []
  const toothOk = isValidTooth(input.toothNumber)
  if (!toothOk) {
    errors.push(`Pieza FDI inválida: "${input.toothNumber}".`)
  }
  const def = findingDefinition(input.condition)
  if (!def) {
    errors.push(`Condición desconocida: "${input.condition}".`)
    return errors
  }

  const rawDetails: unknown = input.details ?? {}
  if (typeof rawDetails !== "object" || rawDetails === null || Array.isArray(rawDetails)) {
    errors.push("Los detalles del hallazgo son inválidos.")
    return errors
  }
  const details = rawDetails as FindingDetails
  for (const key of Object.keys(details)) {
    if (!Object.hasOwn(KNOWN_DETAIL_KEYS, key))
      errors.push(`Campo no reconocido en detalles: "${key}".`)
  }

  // Superficies: solo el alcance `surface` las admite; siempre contra la anatomía.
  let surfaces: string[] = []
  if (input.surfaces !== undefined && input.surfaces !== null) {
    if (!Array.isArray(input.surfaces)) {
      errors.push("Las superficies del hallazgo son inválidas.")
    } else {
      surfaces = input.surfaces
    }
  }
  const seenSurface: Record<string, true> = {}
  for (const surface of surfaces) {
    if (typeof surface !== "string" || !SURFACES.includes(surface)) {
      errors.push(`Superficie desconocida: "${surface}".`)
      continue
    }
    if (seenSurface[surface]) errors.push(`Superficie duplicada: "${surface}".`)
    seenSurface[surface] = true
    if (toothOk && !surfacesForTooth(input.toothNumber).some((valid) => valid === surface)) {
      errors.push(`La superficie ${surface} no corresponde a la pieza ${input.toothNumber}.`)
    }
  }
  if (def.scope !== "surface" && surfaces.length > 0) {
    errors.push(`El hallazgo "${def.label}" no admite superficies.`)
  }

  // Variante: obligatoria cuando el catálogo la define; prohibida si no.
  const variantPresent = isPresent(details.variant)
  if (def.variants) {
    if (!variantPresent) {
      errors.push(`El hallazgo "${def.label}" requiere variante (sigla oficial).`)
    } else if (!def.variants.some((item) => item.value === details.variant)) {
      errors.push(`Variante desconocida para "${def.label}": "${details.variant}".`)
    }
  } else if (variantPresent) {
    errors.push(`El hallazgo "${def.label}" no admite variante.`)
  }

  // Calidad: obligatoria en color dual (buen/mal estado); prohibida en color fijo.
  const qualityPresent = isPresent(details.quality)
  if (def.color === "quality") {
    if (details.quality !== "good" && details.quality !== "poor") {
      errors.push(`El hallazgo "${def.label}" requiere el estado (buen estado o mal estado).`)
    }
  } else if (qualityPresent) {
    errors.push(`El hallazgo "${def.label}" tiene color normativo fijo y no admite estado.`)
  }

  // Grado de movilidad: entero >= 1. No existe M0 patológico.
  const gradePresent = details.grade !== undefined && details.grade !== null
  if (input.condition === "pathological_mobility") {
    if (!gradePresent) {
      errors.push(`La movilidad patológica requiere el grado (número arábigo).`)
    } else if (details.grade === 0) {
      errors.push("El grado 0 no es movilidad patológica (no existe M0).")
    } else if (!Number.isInteger(details.grade) || (details.grade as number) < 1) {
      errors.push("El grado de movilidad debe ser un entero mayor o igual a 1.")
    }
  } else if (gradePresent) {
    errors.push(`El hallazgo "${def.label}" no admite grado.`)
  }

  // Dirección del giro: obligatoria en giroversión.
  const directionPresent = isPresent(details.direction)
  if (input.condition === "rotation") {
    if (details.direction !== "clockwise" && details.direction !== "counterclockwise") {
      errors.push("La giroversión requiere la dirección del giro.")
    }
  } else if (directionPresent) {
    errors.push(`El hallazgo "${def.label}" no admite dirección.`)
  }

  // Posiciones: obligatorias en posición anormal, compatibles con la arcada.
  if (input.condition === "abnormal_position") {
    const positions = asStringList(details.positions)
    if (!positions || positions.length === 0) {
      errors.push(`La posición anormal requiere al menos una posición (M/D/V/P/L).`)
    } else {
      const seenPosition = new Set<string>()
      for (const position of positions) {
        if (!Object.hasOwn(POSITION_VALUES, position)) {
          errors.push(`Posición desconocida: "${position}".`)
          continue
        }
        if (seenPosition.has(position)) errors.push(`Posición duplicada: "${position}".`)
        seenPosition.add(position)
        if (toothOk && position === "palatal" && !isUpperTooth(input.toothNumber)) {
          errors.push(`La posición palatinizada solo corresponde a piezas superiores.`)
        }
        if (toothOk && position === "lingual" && isUpperTooth(input.toothNumber)) {
          errors.push(`La posición lingualizada solo corresponde a piezas inferiores.`)
        }
      }
    }
  } else if (asStringList(details.positions)?.length) {
    errors.push(`El hallazgo "${def.label}" no admite posiciones.`)
  } else if (details.positions !== undefined && details.positions !== null) {
    errors.push(`Las posiciones del hallazgo "${def.label}" son inválidas.`)
  }

  // Piezas relacionadas según alcance.
  const relatedRaw = details.relatedTeeth
  const abutmentRaw = details.abutmentTeeth
  let related: number[] | undefined
  if (relatedRaw !== undefined && relatedRaw !== null) {
    if (!Array.isArray(relatedRaw)) {
      errors.push("Las piezas relacionadas del hallazgo son inválidas.")
    } else {
      related = relatedRaw
    }
  }
  let abutments: number[] | undefined
  if (abutmentRaw !== undefined && abutmentRaw !== null) {
    if (!Array.isArray(abutmentRaw)) {
      errors.push("Los pilares del hallazgo son inválidos.")
    } else {
      abutments = abutmentRaw
    }
  }
  const relatedList = related ?? []
  const abutmentList = abutments ?? []

  if (def.scope === "tooth" || def.scope === "surface") {
    if (relatedList.length > 0) {
      errors.push(
        `El hallazgo "${def.label}" es de pieza individual y no admite piezas relacionadas.`,
      )
    }
    if (abutmentList.length > 0) {
      errors.push(`El hallazgo "${def.label}" no admite pilares.`)
    }
  } else if (def.scope === "pair") {
    if (abutmentList.length > 0) {
      errors.push(`El hallazgo "${def.label}" no admite pilares.`)
    }
    if (
      relatedList.length !== 2 ||
      (toothOk && !relatedList.includes(input.toothNumber)) ||
      relatedList.some((tooth) => !isValidTooth(tooth)) ||
      relatedList[0] === relatedList[1]
    ) {
      errors.push(
        `El hallazgo "${def.label}" relaciona exactamente dos piezas válidas incluyendo la pieza ${input.toothNumber}.`,
      )
    } else if (
      isPrimaryTooth(relatedList[0]) !== isPrimaryTooth(relatedList[1]) ||
      isUpperTooth(relatedList[0]) !== isUpperTooth(relatedList[1])
    ) {
      errors.push(`El par de "${def.label}" debe ser de la misma arcada y dentición.`)
    } else if (input.condition !== "transposition") {
      // Diastema, fusión y supernumeraria ocurren entre piezas adyacentes;
      // la transposición puede involucrar piezas no adyacentes.
      const row = archRowOf(relatedList[0])
      const gap = Math.abs(row.indexOf(relatedList[0]) - row.indexOf(relatedList[1]))
      if (gap !== 1) errors.push(`El par de "${def.label}" debe ser de piezas adyacentes.`)
    }
  } else if (def.scope === "span") {
    for (const tooth of relatedList) {
      if (!isValidTooth(tooth)) errors.push(`Pieza relacionada inválida: "${tooth}".`)
    }
    const validRelated = relatedList.filter((tooth) => isValidTooth(tooth))
    const unique = [...new Set(validRelated)]
    if (unique.length !== validRelated.length) {
      errors.push("Las piezas del tramo no deben duplicarse.")
    }
    // La prótesis parcial removible puede reemplazar una sola pieza; el resto exige tramo.
    const minSpan = input.condition === "removable_partial_denture" ? 1 : 2
    if (!toothOk || !relatedList.includes(input.toothNumber) || unique.length < minSpan) {
      errors.push(
        `El hallazgo "${def.label}" requiere el tramo de piezas incluyendo la pieza ${input.toothNumber}.`,
      )
    } else {
      const row = archRowOf(input.toothNumber)
      if (!unique.every((tooth) => row.includes(tooth))) {
        errors.push(`El tramo de "${def.label}" debe ser de la misma arcada y dentición.`)
      } else {
        const indices = unique.map((tooth) => row.indexOf(tooth)).sort((a, b) => a - b)
        const contiguous = indices.every((index, i) => i === 0 || index === indices[i - 1] + 1)
        if (!contiguous) errors.push(`El tramo de "${def.label}" debe ser contiguo.`)
      }
    }
    if (input.condition === "fixed_partial_denture") {
      // La norma solo dibuja los pilares; un voladizo puede sostenerse en uno.
      const pillarsOk =
        abutmentList.length >= 1 &&
        new Set(abutmentList).size === abutmentList.length &&
        abutmentList.every((tooth) => isValidTooth(tooth) && relatedList.includes(tooth))
      if (!pillarsOk) errors.push("El puente requiere al menos un pilar válido dentro del tramo.")
    } else if (abutmentList.length > 0) {
      errors.push(`El hallazgo "${def.label}" no admite pilares.`)
    }
  } else {
    // Alcance `arch`: el hallazgo abarca la arcada completa de la pieza.
    if (abutmentList.length > 0) {
      errors.push(`El hallazgo "${def.label}" no admite pilares.`)
    }
    if (toothOk) {
      const expected = [...archRowOf(input.toothNumber)].sort((a, b) => a - b)
      const actual = [...new Set(relatedList.filter((tooth) => isValidTooth(tooth)))].sort(
        (a, b) => a - b,
      )
      const complete =
        relatedList.every((tooth) => isValidTooth(tooth)) &&
        actual.length === expected.length &&
        actual.every((tooth, i) => tooth === expected[i])
      if (!complete) {
        errors.push(`El hallazgo "${def.label}" abarca la arcada completa de la pieza.`)
      }
      if (new Set(relatedList).size !== relatedList.length) {
        errors.push("Las piezas de la arcada no deben duplicarse.")
      }
    } else if (relatedList.length > 0) {
      errors.push(`El hallazgo "${def.label}" abarca la arcada completa de la pieza.`)
    }
  }

  // Evidencia clínica directa cuando la norma la exige.
  if (details.clinicallyObserved !== undefined && typeof details.clinicallyObserved !== "boolean") {
    errors.push("La observación clínica debe ser verdadero o falso.")
  } else if (def.requiresEvidence && details.clinicallyObserved !== true) {
    errors.push(`El hallazgo "${def.label}" solo se registra con observación clínica directa.`)
  }

  // Dibujo: mínimo dos puntos por trazo; la forma observada de un hallazgo de
  // superficie registrado solo con dibujo exige tres (cierre de forma). En
  // alcance `surface` basta con superficies o trazo. Siempre finito y acotado.
  const drawingPresent = details.drawing !== undefined && details.drawing !== null
  const drawingOnlyShape = def.scope === "surface" && surfaces.length === 0
  const minPoints = drawingOnlyShape ? 3 : 2
  if (drawingPresent && def.scope !== "surface" && !def.requiresDrawing) {
    errors.push(
      `El hallazgo "${def.label}" se representa con su símbolo normativo, no con trazos libres.`,
    )
  } else if (drawingPresent) {
    const drawingOk = pushDrawingErrors(errors, details.drawing, minPoints)
    if (!drawingOk) {
      if (input.condition === "fracture") {
        errors.push("La fractura dental requiere el trazo de la fractura (al menos dos puntos).")
      } else if (drawingOnlyShape) {
        errors.push(
          `El dibujo de "${def.label}" requiere al menos tres puntos por trazo para cerrar la forma observada.`,
        )
      }
    }
  } else if (input.condition === "fracture") {
    errors.push("La fractura dental requiere el trazo de la fractura (al menos dos puntos).")
  }
  if (drawingOnlyShape && !drawingPresent) {
    errors.push(
      `El hallazgo "${def.label}" requiere superficies o el dibujo de la forma observada.`,
    )
  }

  // Especificaciones: obligatorias en corona temporal (material) y fluorosis (clasificación).
  if (details.specifications !== undefined && typeof details.specifications !== "string") {
    errors.push("Las especificaciones del hallazgo son inválidas.")
  } else {
    const specifications = (details.specifications ?? "").trim()
    if (specifications.length > MAX_TEXT) {
      errors.push(`Las especificaciones superan el máximo de ${MAX_TEXT} caracteres.`)
    }
    if (input.condition === "temporary_crown" && specifications === "") {
      errors.push(`La corona temporal requiere el material en especificaciones.`)
    }
    if (details.variant === "fluorosis" && specifications === "") {
      errors.push("La fluorosis requiere la clasificación utilizada en especificaciones.")
    }
  }
  if (details.observations !== undefined && typeof details.observations !== "string") {
    errors.push("Las observaciones del hallazgo son inválidas.")
  } else if ((details.observations ?? "").length > MAX_TEXT) {
    errors.push(`Las observaciones superan el máximo de ${MAX_TEXT} caracteres.`)
  }
  // La observación clínica es texto libre: exige observaciones o nota no vacías.
  if (input.condition === "clinical_observation") {
    const observations = typeof details.observations === "string" ? details.observations.trim() : ""
    const note = typeof input.note === "string" ? input.note.trim() : ""
    if (observations === "" && note === "") {
      errors.push("La observación clínica requiere observaciones o nota.")
    }
  }

  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") {
    errors.push("La nota del hallazgo es inválida.")
  } else if (typeof input.note === "string" && input.note.length > MAX_TEXT) {
    errors.push(`La nota supera el máximo de ${MAX_TEXT} caracteres.`)
  }
  for (const [field, label] of [
    ["diagnosisCode", "El código diagnóstico"],
    ["encounterId", "La atención"],
  ] as const) {
    const value = input[field]
    if (value !== undefined && value !== null && value !== "" && typeof value !== "string") {
      errors.push(`${label} del hallazgo es inválido.`)
    }
  }
  return errors
}

function timeOf(value: string | Date | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const time = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/**
 * Hallazgos vigentes a la fecha de corte (ISO; por defecto ahora).
 * El registro es append-only: coexisten todas las entradas válidas registradas
 * hasta la fecha; se excluyen las pendientes de revisión, las anuladas a esa
 * fecha (voidedAt o estado voided) y las tratadas a esa fecha (resolvedAt). Sin latest-wins por cara. Orden
 * determinista por creación e identificador.
 */
export function activeFindingsAsOf<T extends FindingRecord>(
  history: readonly T[],
  iso?: string,
): T[] {
  const cutoff = iso === undefined ? Date.now() : Date.parse(iso)
  if (!Number.isFinite(cutoff)) return []
  return history
    .filter((record) => {
      const created = timeOf(record.createdAt)
      if (created !== undefined && created > cutoff) return false
      if (record.needsReview) return false
      const hasVoidedAt = record.voidedAt !== undefined && record.voidedAt !== null
      const voided = hasVoidedAt ? timeOf(record.voidedAt) : undefined
      if (record.status === "voided") {
        // Proyección de anulación: el hallazgo estuvo vigente hasta su anulación.
        if (voided !== undefined && voided > cutoff) return true
        return false
      }
      // voidedAt presente pero ilegible: exclusión conservadora del gráfico.
      if (hasVoidedAt && (voided === undefined || voided <= cutoff)) return false
      // Tratado: estuvo vigente hasta que se realizó su tratamiento.
      if (record.resolvedAt !== undefined && record.resolvedAt !== null) {
        const resolved = timeOf(record.resolvedAt)
        if (resolved === undefined || resolved <= cutoff) return false
      }
      return true
    })
    .sort((a, b) => {
      const byTime =
        (timeOf(a.createdAt) ?? Number.NEGATIVE_INFINITY) -
        (timeOf(b.createdAt) ?? Number.NEGATIVE_INFINITY)
      if (byTime !== 0) return byTime
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}
