/**
 * Periodontograma (issue 49, ADR 0054): sondaje por pieza FDI y sitio, índices y
 * la propuesta de clasificación de 2017 (AAP/EFP, Papapanou y otros, J Clin
 * Periodontol 2018). Dominio puro: el servicio guarda con estas reglas y la
 * pantalla dibuja con ellas. Es internacional; nada depende del país.
 *
 * Convenciones (decididas en el lienzo, tablero 12):
 * - Seis sitios por pieza en orden fijo: tres por fuera y tres por dentro
 *   (palatino arriba, lingual abajo).
 * - Recesión con signo: positiva si el borde de la encía quedó hacia la raíz
 *   (se ve raíz) y negativa si queda sobre la corona. Pérdida de inserción
 *   (NIC) = profundidad + recesión.
 * - Furca de Hamp (1, 2 y 3) y movilidad de Miller (0 a 3).
 * - Placa de O'Leary (1972): cuatro caras por pieza, aparte del sondaje.
 * - Los implantes se sondean pero quedan fuera de los índices de las piezas.
 */
import { FDI_ADULT, FDI_ADULT_ROWS, isUpperTooth } from "./anatomy.js"
import type { FindingRecord } from "./types.js"

/** Sitios de sondaje, en el orden en que se guardan los seis valores de cada pieza. */
export const PERIODONTAL_SITES = [
  "mesiobuccal",
  "buccal",
  "distobuccal",
  "mesiolingual",
  "lingual",
  "distolingual",
] as const
export type PeriodontalSite = (typeof PERIODONTAL_SITES)[number]
export const PERIODONTAL_SITE_COUNT = PERIODONTAL_SITES.length

/** Sitios entre dientes (mesial y distal de cada cara): los que definen el estadio. */
export const INTERDENTAL_SITE_INDEXES: readonly number[] = [0, 2, 3, 5]
/** Sitios del centro de cada cara. */
export const MID_SITE_INDEXES: readonly number[] = [1, 4]

/** Caras del índice de placa de O'Leary, en el orden en que se guardan. */
export const PLAQUE_FACES = ["buccal", "lingual", "mesial", "distal"] as const
export type PlaqueFace = (typeof PLAQUE_FACES)[number]

/** Entradas de furca que puede tener una pieza (Hamp). */
export const FURCATION_ENTRIES = [
  "buccal",
  "lingual",
  "mesiopalatal",
  "distopalatal",
  "mesial",
  "distal",
] as const
export type FurcationEntry = (typeof FURCATION_ENTRIES)[number]
/** Hamp: 1 entra menos de 3 mm; 2 más de 3 mm sin atravesar; 3 atraviesa. */
export type FurcationGrade = 1 | 2 | 3
export type FurcationRecord = Partial<Record<FurcationEntry, FurcationGrade>>

/** Movilidad de Miller, de 0 a 3: la misma escala que la sigla M1–M3 del odontograma. */
export const MOBILITY_MAX = 3
export const PROBING_DEPTH_MAX_MM = 15
export const RECESSION_MIN_MM = -10
export const RECESSION_MAX_MM = 15

/** Estado de un implante (clasificación de 2017, condiciones periimplantarias). */
export const PERI_IMPLANT_CONDITIONS = ["health", "mucositis", "peri_implantitis"] as const
export type PeriImplantCondition = (typeof PERI_IMPLANT_CONDITIONS)[number]

/** Diagnóstico periodontal que confirma el odontólogo. */
export const PERIODONTAL_DIAGNOSES = ["health", "gingivitis", "periodontitis"] as const
export type PeriodontalDiagnosis = (typeof PERIODONTAL_DIAGNOSES)[number]
export const PERIODONTITIS_STAGES = [1, 2, 3, 4] as const
export type PeriodontitisStage = (typeof PERIODONTITIS_STAGES)[number]
export const PERIODONTITIS_GRADES = ["A", "B", "C"] as const
export type PeriodontitisGrade = (typeof PERIODONTITIS_GRADES)[number]
/** Extensión: localizada (menos del 30 % de las piezas), generalizada o patrón molar-incisivo. */
export const PERIODONTAL_EXTENTS = ["localized", "generalized", "molar_incisor"] as const
export type PeriodontalExtent = (typeof PERIODONTAL_EXTENTS)[number]

/**
 * Pérdida de inserción entre dientes que define cada estadio: I desde 1 mm, II
 * desde 3 mm, III y IV desde 5 mm. La extensión cuenta solo las piezas que
 * llegan a la del estadio del paciente, como aclararon los autores de la
 * clasificación (Sanz, Papapanou, Tonetti y otros, J Clin Periodontol 2020;
 * decisión 7 del lienzo): contar cualquier pérdida haría «generalizada» casi
 * cualquier periodontitis.
 */
export const STAGE_DEFINING_LOSS_MM: Readonly<Record<PeriodontitisStage, number>> = { 1: 1, 2: 3, 3: 5, 4: 5 }
/** Un sitio mejoró o empeoró cuando la bolsa cambia al menos esto; menos puede ser la sonda. */
export const SITE_CHANGE_THRESHOLD_MM = 2

export interface PeriodontalToothRecord {
  toothNumber: number
  /** «Saltar pieza»: se dejó sin medir a propósito. */
  skipped: boolean
  /** Profundidad de sondaje en mm por sitio; null sin medir. */
  probingDepth: (number | null)[]
  /** Recesión con signo en mm por sitio; null sin medir. */
  recession: (number | null)[]
  bleeding: boolean[]
  suppuration: boolean[]
  mobility: number | null
  furcation: FurcationRecord
  /** Placa por cara (O'Leary); null si no se marcó. */
  plaque: boolean[] | null
  /** Solo implantes: lo que confirmó el odontólogo. */
  periImplant: PeriImplantCondition | null
}

/** Lo que se envía al guardar una pieza; lo que falta queda sin medir. */
export interface PeriodontalToothInput {
  toothNumber: number
  skipped?: boolean
  probingDepth?: (number | null)[]
  recession?: (number | null)[]
  bleeding?: boolean[]
  suppuration?: boolean[]
  mobility?: number | null
  furcation?: FurcationRecord
  plaque?: boolean[] | null
  periImplant?: PeriImplantCondition | null
}

/** Piezas del periodontograma: dentición permanente. */
export function isPeriodontalTooth(toothNumber: number): boolean {
  return FDI_ADULT.includes(toothNumber)
}

/** Entradas de furca de la pieza: molares (dos o tres) y primer premolar superior (dos). */
export function furcationEntriesFor(toothNumber: number): readonly FurcationEntry[] {
  if (!isPeriodontalTooth(toothNumber)) return []
  const digit = toothNumber % 10
  const upper = isUpperTooth(toothNumber)
  if (digit >= 6) return upper ? ["buccal", "mesiopalatal", "distopalatal"] : ["buccal", "lingual"]
  if (digit === 4 && upper) return ["mesial", "distal"]
  return []
}

/** Una pieza sin medir. */
export function emptyPeriodontalTooth(toothNumber: number): PeriodontalToothRecord {
  return {
    toothNumber,
    skipped: false,
    probingDepth: Array(PERIODONTAL_SITE_COUNT).fill(null),
    recession: Array(PERIODONTAL_SITE_COUNT).fill(null),
    bleeding: Array(PERIODONTAL_SITE_COUNT).fill(false),
    suppuration: Array(PERIODONTAL_SITE_COUNT).fill(false),
    mobility: null,
    furcation: {},
    plaque: null,
    periImplant: null,
  }
}

/** Completa lo que falta de la entrada con una pieza sin medir. */
export function normalizePeriodontalTooth(input: PeriodontalToothInput): PeriodontalToothRecord {
  const base = emptyPeriodontalTooth(input.toothNumber)
  return {
    toothNumber: input.toothNumber,
    skipped: input.skipped ?? false,
    probingDepth: input.probingDepth ?? base.probingDepth,
    recession: input.recession ?? base.recession,
    bleeding: input.bleeding ?? base.bleeding,
    suppuration: input.suppuration ?? base.suppuration,
    mobility: input.mobility ?? null,
    furcation: input.furcation ?? {},
    plaque: input.plaque ?? null,
    periImplant: input.periImplant ?? null,
  }
}

function checkMeasures(
  label: string,
  values: unknown,
  min: number,
  max: number,
  errors: string[],
): void {
  if (!Array.isArray(values) || values.length !== PERIODONTAL_SITE_COUNT) {
    errors.push(`${label}: se esperan ${PERIODONTAL_SITE_COUNT} sitios`)
    return
  }
  for (const value of values) {
    if (value === null) continue
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      errors.push(`${label}: cada sitio va en milímetros enteros, de ${min} a ${max}`)
      return
    }
  }
}

function checkFlags(label: string, values: unknown, length: number, errors: string[]): void {
  if (!Array.isArray(values) || values.length !== length || values.some((v) => typeof v !== "boolean")) {
    errors.push(`${label}: se esperan ${length} marcas`)
  }
}

/** Errores de una pieza, en palabras para quien la registra; vacío si es válida. */
export function validatePeriodontalTooth(
  input: PeriodontalToothInput,
  options: { implant: boolean },
): string[] {
  const errors: string[] = []
  if (!isPeriodontalTooth(input.toothNumber)) {
    errors.push("El periodontograma usa las piezas permanentes (FDI 11 a 48)")
    return errors
  }
  const tooth = normalizePeriodontalTooth(input)
  checkMeasures("Profundidad de sondaje", tooth.probingDepth, 0, PROBING_DEPTH_MAX_MM, errors)
  checkMeasures("Recesión", tooth.recession, RECESSION_MIN_MM, RECESSION_MAX_MM, errors)
  checkFlags("Sangrado", tooth.bleeding, PERIODONTAL_SITE_COUNT, errors)
  checkFlags("Supuración", tooth.suppuration, PERIODONTAL_SITE_COUNT, errors)
  if (tooth.mobility !== null && (!Number.isInteger(tooth.mobility) || tooth.mobility < 0 || tooth.mobility > MOBILITY_MAX)) {
    errors.push("Movilidad: de 0 a 3 (Miller)")
  }
  if (typeof tooth.furcation !== "object" || tooth.furcation === null || Array.isArray(tooth.furcation)) {
    errors.push("Furca: formato inválido")
  } else {
    const allowed = options.implant ? [] : furcationEntriesFor(input.toothNumber)
    for (const [entry, grade] of Object.entries(tooth.furcation)) {
      if (!(allowed as readonly string[]).includes(entry)) {
        errors.push(`La pieza ${input.toothNumber} no tiene furca ${entry}`)
      } else if (grade !== 1 && grade !== 2 && grade !== 3) {
        errors.push("Furca: grado 1, 2 o 3 (Hamp)")
      }
    }
  }
  if (tooth.plaque !== null) {
    if (options.implant) errors.push("La placa de O'Leary se marca en piezas, no en implantes")
    else checkFlags("Placa", tooth.plaque, PLAQUE_FACES.length, errors)
  }
  if (tooth.periImplant !== null) {
    if (!options.implant) errors.push("El estado periimplantario es solo de implantes")
    else if (!(PERI_IMPLANT_CONDITIONS as readonly string[]).includes(tooth.periImplant)) {
      errors.push("Estado periimplantario inválido")
    }
  }
  if (tooth.skipped && tooth.probingDepth.some((v) => v !== null)) {
    errors.push("Una pieza saltada no lleva medidas")
  }
  return errors
}

/** Pérdida de inserción de un sitio: profundidad + recesión; null si falta una. */
export function attachmentLoss(probingDepth: number | null, recession: number | null): number | null {
  if (probingDepth === null || recession === null) return null
  return probingDepth + recession
}

/**
 * Piezas a sondear y cuáles son implantes, según el odontograma vigente: las
 * ausentes (y las de una arcada sin dientes) no se piden (decisión 4).
 */
export function periodontalDentition(activeFindings: readonly FindingRecord[]): {
  teeth: number[]
  implants: number[]
} {
  const absent = new Set<number>()
  const implants = new Set<number>()
  for (const finding of activeFindings) {
    if (finding.condition === "missing_tooth") absent.add(finding.toothNumber)
    if (finding.condition === "edentulous_arch") {
      // Arcada sin dientes: ninguna pieza de esa arcada se sondea (los implantes sí).
      const upper = isUpperTooth(finding.toothNumber)
      for (const tooth of FDI_ADULT) if (isUpperTooth(tooth) === upper) absent.add(tooth)
    }
    if (finding.condition === "implant") implants.add(finding.toothNumber)
  }
  for (const tooth of implants) absent.delete(tooth)
  const teeth = FDI_ADULT_ROWS.flat().filter((tooth) => !absent.has(tooth))
  return { teeth, implants: teeth.filter((tooth) => implants.has(tooth)) }
}

/**
 * Orden fijo de sondaje, sin saltos de un lado a otro: arriba por fuera de la
 * 18 a la 28, arriba por dentro de la 28 a la 18, abajo por dentro de la 48 a
 * la 38 y abajo por fuera de la 38 a la 48. Solo las piezas que se sondean.
 */
export function probingSequence(teeth: readonly number[]): Array<{ toothNumber: number; face: "buccal" | "lingual" }> {
  const present = new Set(teeth)
  const [upper, lower] = FDI_ADULT_ROWS as [readonly number[], readonly number[]]
  const pass = (row: readonly number[], face: "buccal" | "lingual") =>
    row.filter((tooth) => present.has(tooth)).map((toothNumber) => ({ toothNumber, face }))
  return [
    ...pass(upper, "buccal"),
    ...pass([...upper].reverse(), "lingual"),
    ...pass(lower, "lingual"),
    ...pass([...lower].reverse(), "buccal"),
  ]
}

export interface PeriodontalSiteRef {
  toothNumber: number
  site: PeriodontalSite
  value: number
}

export interface PeriodontalSummary {
  /** Piezas (sin implantes) con al menos un sitio medido. */
  teethMeasured: number
  sitesMeasured: number
  bleedingSites: number
  /** Porcentaje de sitios que sangran, entero; null sin sitios medidos. */
  bleedingPercent: number | null
  suppurationSites: number
  sitesFrom4mm: number
  sitesFrom6mm: number
  maxProbingDepth: number | null
  /** El peor sitio entre dientes por pérdida de inserción. */
  worstInterdentalLoss: PeriodontalSiteRef | null
  /** La mayor pérdida de inserción entre dientes de cada pieza medida (sin implantes). */
  interdentalLossByTooth: Record<number, number>
  /** O'Leary: caras con placa sobre caras marcadas; null si no se marcó la placa. */
  plaque: { faces: number; withPlaque: number; percent: number } | null
  maxMobility: number | null
  maxFurcation: FurcationGrade | null
  implants: Array<{ toothNumber: number; bleedingSites: number; suppurationSites: number; maxProbingDepth: number | null }>
  /** Piezas que se debían sondear y no tienen ningún sitio medido ni se saltaron. */
  pendingTeeth: number[]
}

function percent(part: number, whole: number): number | null {
  return whole ? Math.round((100 * part) / whole) : null
}

/** Índices del periodontograma. `expectedTeeth` son las que se debían sondear. */
export function summarizePeriodontal(
  teeth: readonly PeriodontalToothRecord[],
  implantTeeth: readonly number[],
  expectedTeeth: readonly number[] = [],
): PeriodontalSummary {
  const implantSet = new Set(implantTeeth)
  let sitesMeasured = 0
  let bleedingSites = 0
  let suppurationSites = 0
  let sitesFrom4mm = 0
  let sitesFrom6mm = 0
  let maxProbingDepth: number | null = null
  let worst: PeriodontalSiteRef | null = null
  let plaqueFaces = 0
  let plaqueWith = 0
  let maxMobility: number | null = null
  let maxFurcation: FurcationGrade | null = null
  let teethMeasured = 0
  const lossByTooth: Record<number, number> = {}
  const implants: PeriodontalSummary["implants"] = []
  const touched = new Set<number>()
  for (const tooth of teeth) {
    const measured = tooth.probingDepth.some((v) => v !== null)
    if (measured || tooth.skipped) touched.add(tooth.toothNumber)
    if (implantSet.has(tooth.toothNumber)) {
      let bleeding = 0
      let suppuration = 0
      let max: number | null = null
      tooth.probingDepth.forEach((pd, i) => {
        if (pd === null) return
        if (tooth.bleeding[i]) bleeding++
        if (tooth.suppuration[i]) suppuration++
        max = max === null ? pd : Math.max(max, pd)
      })
      if (measured) implants.push({ toothNumber: tooth.toothNumber, bleedingSites: bleeding, suppurationSites: suppuration, maxProbingDepth: max })
      continue
    }
    if (measured) teethMeasured++
    tooth.probingDepth.forEach((pd, i) => {
      if (pd === null) return
      sitesMeasured++
      if (tooth.bleeding[i]) bleedingSites++
      if (tooth.suppuration[i]) suppurationSites++
      if (pd >= 4) sitesFrom4mm++
      if (pd >= 6) sitesFrom6mm++
      maxProbingDepth = maxProbingDepth === null ? pd : Math.max(maxProbingDepth, pd)
      if (!INTERDENTAL_SITE_INDEXES.includes(i)) return
      const loss = attachmentLoss(pd, tooth.recession[i] ?? null)
      if (loss === null) return
      if (worst === null || loss > worst.value) {
        worst = { toothNumber: tooth.toothNumber, site: PERIODONTAL_SITES[i]!, value: loss }
      }
      lossByTooth[tooth.toothNumber] = Math.max(lossByTooth[tooth.toothNumber] ?? loss, loss)
    })
    if (tooth.plaque) {
      plaqueFaces += tooth.plaque.length
      plaqueWith += tooth.plaque.filter(Boolean).length
    }
    if (tooth.mobility !== null) maxMobility = maxMobility === null ? tooth.mobility : Math.max(maxMobility, tooth.mobility)
    for (const grade of Object.values(tooth.furcation)) {
      if (grade && (maxFurcation === null || grade > maxFurcation)) maxFurcation = grade
    }
  }
  return {
    teethMeasured,
    sitesMeasured,
    bleedingSites,
    bleedingPercent: percent(bleedingSites, sitesMeasured),
    suppurationSites,
    sitesFrom4mm,
    sitesFrom6mm,
    maxProbingDepth,
    worstInterdentalLoss: worst,
    interdentalLossByTooth: lossByTooth,
    plaque: plaqueFaces ? { faces: plaqueFaces, withPlaque: plaqueWith, percent: percent(plaqueWith, plaqueFaces)! } : null,
    maxMobility,
    maxFurcation,
    implants,
    pendingTeeth: expectedTeeth.filter((tooth) => !touched.has(tooth)),
  }
}

/** Lo que agrega el odontólogo para clasificar: no sale del sondaje. */
export interface PeriodontalClassificationInputs {
  /** Pérdida de hueso en la radiografía, en la pieza más afectada (%). */
  boneLossPercent?: number | null
  /** Piezas perdidas por la periodontitis. */
  teethLostToPeriodontitis?: number | null
  /** Cigarrillos al día; 0 si no fuma. */
  cigarettesPerDay?: number | null
  diabetes?: boolean | null
  /** Última hemoglobina glicada (%), si tiene diabetes. */
  hba1c?: number | null
}

export type PeriodontalMissingInput = "boneLossPercent" | "teethLostToPeriodontitis" | "smoking" | "diabetes"

/**
 * Cómo está hoy quien ya tiene diagnosticada una periodontitis (clasificación
 * de 2017): estable, en remisión o inestable. Es lo que se mira en cada
 * reevaluación y mantenimiento; el estadio y el grado no bajan con el tratamiento.
 */
export const PERIODONTITIS_STATUSES = ["stable", "remission", "unstable"] as const
export type PeriodontitisStatus = (typeof PERIODONTITIS_STATUSES)[number]

/** La periodontitis confirmada en una visita anterior de la misma persona. */
export interface PreviousPeriodontitis {
  stage: PeriodontitisStage
  grade: PeriodontitisGrade
  extent: PeriodontalExtent
  /** Fecha de esa visita como se lee, para decirla en las razones. */
  date?: string | null
}

export interface PeriodontalProposal {
  diagnosis: PeriodontalDiagnosis
  stage: PeriodontitisStage | null
  grade: PeriodontitisGrade | null
  extent: PeriodontalExtent | null
  /** Solo si ya tenía periodontitis diagnosticada: cómo está hoy. */
  status: PeriodontitisStatus | null
  /** Por qué, en palabras para el odontólogo. */
  reasons: string[]
  /** Datos que conviene revisar antes de confirmar, como la recesión anotada en 0. */
  warnings: string[]
  /** Lo que falta para que la propuesta sea completa. */
  missing: PeriodontalMissingInput[]
  implants: Array<{ toothNumber: number; condition: PeriImplantCondition }>
}

const MOLAR_INCISOR_TEETH = new Set([16, 26, 36, 46, 11, 12, 21, 22, 31, 32, 41, 42])
const SITE_WORDS = ["mesial por fuera", "centro por fuera", "distal por fuera", "mesial por dentro", "centro por dentro", "distal por dentro"]
const STAGE_WORD = ["", "I", "II", "III", "IV"]
const GRADE_RANK: Record<PeriodontitisGrade, number> = { A: 0, B: 1, C: 2 }
const EXTENT_RANK: Record<PeriodontalExtent, number> = { localized: 0, molar_incisor: 1, generalized: 2 }
const EXTENT_WORD: Record<PeriodontalExtent, string> = { localized: "localizada", generalized: "generalizada", molar_incisor: "con patrón molar-incisivo" }
const STATUS_WORD: Record<PeriodontitisStatus, string> = { stable: "estable", remission: "en remisión", unstable: "inestable" }

function rowNeighbors(a: number, b: number): boolean {
  for (const row of FDI_ADULT_ROWS) {
    const i = row.indexOf(a)
    const j = row.indexOf(b)
    if (i >= 0 && j >= 0) return Math.abs(i - j) === 1
  }
  return false
}

function hasNonAdjacentPair(teeth: readonly number[]): boolean {
  for (let i = 0; i < teeth.length; i++) {
    for (let j = i + 1; j < teeth.length; j++) {
      if (!rowNeighbors(teeth[i]!, teeth[j]!)) return true
    }
  }
  return false
}

/**
 * Pérdida de inserción entre dientes que se puede dar por comprobada: con
 * bolsa de 4 mm o más o con raíz visible (decisión 8). Si la encía está en su
 * lugar y se anota 0, bolsa más recesión exagera la pérdida en 1 o 2 mm. Como
 * la definición de vigilancia de CDC/AAP (Eke y otros, J Periodontol 2012), que
 * pide bolsa además de pérdida, odentIA no propone periodontitis solo con eso.
 * Se aparta a propósito de la definición de caso de 2017, que cuenta desde 1 mm.
 */
function provenInterdentalLoss(tooth: PeriodontalToothRecord, site: number): number | null {
  const pd = tooth.probingDepth[site] ?? null
  const rec = tooth.recession[site] ?? null
  const loss = attachmentLoss(pd, rec)
  if (loss === null || loss < 1 || pd === null || rec === null) return null
  return pd >= 4 || rec >= 1 ? loss : null
}

/** Aviso cuando ninguna recesión está en negativo: casi siempre es la encía en su lugar anotada como 0. */
function recessionWarnings(natural: readonly PeriodontalToothRecord[]): string[] {
  let zeros = 0
  let negatives = 0
  for (const tooth of natural) {
    for (const rec of tooth.recession) {
      if (rec === 0) zeros++
      if (rec !== null && rec < 0) negatives++
    }
  }
  return zeros > 0 && negatives === 0
    ? ["Ninguna recesión está anotada en negativo. Si la encía cubre parte de la corona, anótala en negativo (−1, −2): con 0, la pérdida de inserción sale mayor de lo que es."]
    : []
}

interface SiteRef {
  toothNumber: number
  site: number
  value: number
}

/**
 * Estado de quien ya tiene periodontitis (2017): inestable con una bolsa de
 * 5 mm o más, o de 4 mm que sangra; si no, estable si sangra menos del 10 %
 * de los sitios y en remisión si sangra más.
 */
export function periodontitisStatus(
  teeth: readonly PeriodontalToothRecord[],
  implantTeeth: readonly number[],
): { status: PeriodontitisStatus; reason: string } {
  const implantSet = new Set(implantTeeth)
  let deepest: SiteRef | null = null
  let bleedingAt4: SiteRef | null = null
  let sites = 0
  let bleedingSites = 0
  for (const tooth of teeth) {
    if (implantSet.has(tooth.toothNumber)) continue
    for (let i = 0; i < tooth.probingDepth.length; i++) {
      const pd = tooth.probingDepth[i] ?? null
      if (pd === null) continue
      sites++
      if (tooth.bleeding[i]) bleedingSites++
      if (pd >= 5 && (deepest === null || pd > deepest.value)) deepest = { toothNumber: tooth.toothNumber, site: i, value: pd }
      if (pd === 4 && tooth.bleeding[i] && bleedingAt4 === null) bleedingAt4 = { toothNumber: tooth.toothNumber, site: i, value: pd }
    }
  }
  const exact = sites ? (100 * bleedingSites) / sites : 0
  const shown = Math.round(exact)
  if (deepest) {
    return { status: "unstable", reason: `Inestable: la ${deepest.toothNumber}, ${SITE_WORDS[deepest.site]}, tiene una bolsa de ${deepest.value} mm (5 mm o más).` }
  }
  if (bleedingAt4) {
    return { status: "unstable", reason: `Inestable: la ${bleedingAt4.toothNumber}, ${SITE_WORDS[bleedingAt4.site]}, tiene una bolsa de 4 mm que sangra.` }
  }
  if (exact < 10) {
    return { status: "stable", reason: `Estable: sangra el ${shown} % de los sitios (menos del 10 %) y ninguna bolsa pasa de 4 mm ni las de 4 mm sangran.` }
  }
  return { status: "remission", reason: `En remisión: ninguna bolsa pasa de 4 mm ni las de 4 mm sangran, pero sangra el ${shown} % de los sitios (10 % o más).` }
}

/**
 * Propuesta de clasificación (2017). odentIA no diagnostica: propone con sus
 * razones y el odontólogo confirma o cambia (decisión 5). Sin pérdida de
 * inserción comprobada propone salud o gingivitis con el sangrado. Quien ya
 * tenía periodontitis la sigue teniendo: el estadio, el grado y la extensión no
 * bajan, y se propone además cómo está hoy (estable, en remisión o inestable).
 */
export function proposePeriodontalClassification(
  teeth: readonly PeriodontalToothRecord[],
  implantTeeth: readonly number[],
  inputs: PeriodontalClassificationInputs,
  ageYears: number | null,
  /** Piezas naturales en boca según el odontograma; si falta, las del periodontograma. */
  remainingTeeth: number | null = null,
  /** La periodontitis confirmada en una visita anterior, si la hay. */
  previous: PreviousPeriodontitis | null = null,
): PeriodontalProposal {
  const summary = summarizePeriodontal(teeth, implantTeeth)
  const implantSet = new Set(implantTeeth)
  const natural = teeth.filter((tooth) => !implantSet.has(tooth.toothNumber))
  const implants: PeriodontalProposal["implants"] = summary.implants.map((implant) => ({
    toothNumber: implant.toothNumber,
    // La periimplantitis exige ver pérdida de hueso en la radiografía: la decide el odontólogo.
    condition: implant.bleedingSites > 0 || implant.suppurationSites > 0 ? "mucositis" : "health",
  }))
  const warnings = recessionWarnings(natural)
  // Caso de periodontitis: pérdida comprobada entre dientes en dos piezas no
  // vecinas, o de 3 mm o más con bolsa de más de 3 mm por fuera o por dentro en dos piezas.
  const interdentalTeeth: number[] = []
  const facialTeeth: number[] = []
  const provenByTooth: Record<number, number> = {}
  let calculatedOnly = false
  for (const tooth of natural) {
    let facial = false
    tooth.probingDepth.forEach((pd, i) => {
      const loss = attachmentLoss(pd, tooth.recession[i] ?? null)
      if (loss === null || pd === null) return
      if (INTERDENTAL_SITE_INDEXES.includes(i)) {
        const proven = provenInterdentalLoss(tooth, i)
        if (proven !== null) provenByTooth[tooth.toothNumber] = Math.max(provenByTooth[tooth.toothNumber] ?? proven, proven)
        else if (loss >= 1) calculatedOnly = true
      }
      if (MID_SITE_INDEXES.includes(i) && loss >= 3 && pd > 3) facial = true
    })
    if (provenByTooth[tooth.toothNumber] !== undefined) interdentalTeeth.push(tooth.toothNumber)
    if (facial) facialTeeth.push(tooth.toothNumber)
  }
  const isPeriodontitis = hasNonAdjacentPair(interdentalTeeth) || facialTeeth.length >= 2

  if (!isPeriodontitis && !previous) {
    const bleeding = summary.bleedingPercent ?? 0
    const deepest = summary.maxProbingDepth ?? 0
    const notEnough = calculatedOnly
      ? ["Hay pérdida de inserción calculada entre dientes, pero sin bolsas de 4 mm o más ni raíz visible no alcanza para proponer periodontitis."]
      : []
    if (bleeding < 10 && deepest <= 3) {
      return {
        diagnosis: "health",
        stage: null,
        grade: null,
        extent: null,
        status: null,
        reasons: [`Salud: sangra el ${bleeding} % de los sitios (menos del 10 %) y ninguna bolsa pasa de 3 mm.`, ...notEnough],
        warnings,
        missing: [],
        implants,
      }
    }
    const generalized = bleeding > 30
    return {
      diagnosis: "gingivitis",
      stage: null,
      grade: null,
      extent: generalized ? "generalized" : "localized",
      status: null,
      reasons: [
        `Gingivitis ${generalized ? "generalizada" : "localizada"}: sangra el ${bleeding} % de los sitios (${generalized ? "más del 30 %" : "10 % o más"}) sin pérdida de inserción comprobada entre dientes.`,
        ...notEnough,
      ],
      warnings,
      missing: [],
      implants,
    }
  }

  const reasons: string[] = []
  const missing: PeriodontalMissingInput[] = []
  const worst = Math.max(0, ...Object.values(provenByTooth))
  let stage: PeriodontitisStage = worst >= 5 ? 3 : worst >= 3 ? 2 : 1
  let grade: PeriodontitisGrade = "B"
  let extent: PeriodontalExtent = "localized"

  if (isPeriodontitis) {
    // Estadio: la pérdida de inserción entre dientes manda; la complejidad y las
    // piezas perdidas lo suben, nunca lo bajan.
    const stageReasons: string[] = [`pierde ${worst} mm de inserción entre dientes`]
    const lost = inputs.teethLostToPeriodontitis
    if (lost === null || lost === undefined) missing.push("teethLostToPeriodontitis")
    else if (lost >= 5) {
      stage = 4
      stageReasons.push(`perdió ${lost} piezas por la enfermedad (5 o más)`)
    } else if (lost >= 1) {
      // Sin piezas perdidas solo caben los estadios I y II.
      if (stage < 3) stage = 3
      stageReasons.push(`perdió ${lost} pieza${lost === 1 ? "" : "s"} por la enfermedad (menos de 5)`)
    } else stageReasons.push("no perdió piezas por la enfermedad")
    const bone = inputs.boneLossPercent
    if (bone === null || bone === undefined) missing.push("boneLossPercent")
    else {
      const byBone: PeriodontitisStage = bone > 33 ? 3 : bone >= 15 ? 2 : 1
      if (byBone > stage) {
        stage = byBone
        stageReasons.push(`la radiografía muestra un ${bone} % de pérdida de hueso`)
      }
    }
    const complex: string[] = []
    if ((summary.maxProbingDepth ?? 0) >= 6) complex.push("bolsas de 6 mm o más")
    if ((summary.maxFurcation ?? 0) >= 2) complex.push(`una furca grado ${summary.maxFurcation === 3 ? "III" : "II"}`)
    if (complex.length && stage < 3) stage = 3
    if (complex.length) stageReasons.push(`tiene ${complex.join(" y ")}`)
    const remaining = remainingTeeth ?? natural.length
    if (stage === 3 && worst >= 5 && ((summary.maxMobility ?? 0) >= 2 || (remaining > 0 && remaining < 20))) {
      stage = 4
      stageReasons.push(
        (summary.maxMobility ?? 0) >= 2
          ? "hay movilidad grado 2 o más, que suele pedir una rehabilitación compleja"
          : `le quedan ${remaining} piezas (menos de 20)`,
      )
    }
    reasons.push(`Estadio ${STAGE_WORD[stage]} porque ${stageReasons.join(", ")}.`)

    // Grado: B salvo evidencia; el hueso perdido por año de edad y los factores de riesgo lo mueven.
    const gradeReasons: string[] = []
    if (bone !== null && bone !== undefined && ageYears !== null && ageYears > 0) {
      const ratio = bone / ageYears
      const shown = ratio.toFixed(2).replace(".", ",")
      if (ratio < 0.25) grade = "A"
      else if (ratio > 1) grade = "C"
      gradeReasons.push(`${bone} % de hueso entre ${ageYears} años da ${shown} (${ratio < 0.25 ? "menos de 0,25" : ratio > 1 ? "más de 1" : "entre 0,25 y 1"})`)
    } else gradeReasons.push("sin la radiografía se parte del grado B")
    const cigarettes = inputs.cigarettesPerDay
    if (cigarettes === null || cigarettes === undefined) missing.push("smoking")
    else if (cigarettes >= 10) {
      grade = "C"
      gradeReasons.push("fuma 10 cigarrillos o más al día")
    } else if (cigarettes > 0) {
      if (grade === "A") grade = "B"
      gradeReasons.push("fuma menos de 10 cigarrillos al día")
    } else gradeReasons.push("no fuma")
    if (inputs.diabetes === null || inputs.diabetes === undefined) missing.push("diabetes")
    else if (inputs.diabetes) {
      if (inputs.hba1c !== null && inputs.hba1c !== undefined && inputs.hba1c >= 7) {
        grade = "C"
        gradeReasons.push("tiene diabetes con hemoglobina glicada de 7 % o más")
      } else {
        if (grade === "A") grade = "B"
        gradeReasons.push("tiene diabetes con hemoglobina glicada menor de 7 %")
      }
    }
    reasons.push(`Grado ${grade} porque ${gradeReasons.join(", ")}.`)

    // Extensión (decisión 7): las piezas medidas que llegan a la pérdida de su
    // estadio. Si el estadio subió por complejidad o por piezas perdidas sin que
    // ninguna llegue a esa pérdida, cuentan las que tienen la peor.
    const threshold = Math.max(1, Math.min(STAGE_DEFINING_LOSS_MM[stage], worst))
    const involved = Object.entries(provenByTooth)
      .filter(([, loss]) => loss >= threshold)
      .map(([tooth]) => Number(tooth))
    const share = percent(involved.length, summary.teethMeasured) ?? 0
    extent = share >= 30 ? "generalized" : "localized"
    if (involved.length && involved.every((tooth) => MOLAR_INCISOR_TEETH.has(tooth))) extent = "molar_incisor"
    reasons.push(
      extent === "molar_incisor"
        ? `Patrón molar-incisivo: solo los primeros molares y los incisivos llegan a la pérdida de su estadio (${threshold} mm o más entre dientes).`
        : `${extent === "generalized" ? "Generalizada" : "Localizada"} porque ${involved.length} de ${summary.teethMeasured} piezas (${share} %) llegan a la pérdida de su estadio, ${threshold} mm o más entre dientes (${extent === "generalized" ? "30 % o más" : "menos del 30 %"}).`,
    )
  }

  let status: PeriodontitisStatus | null = null
  if (previous) {
    // Quien tuvo periodontitis la sigue teniendo: se parte de lo confirmado y
    // solo sube si el sondaje de hoy muestra algo peor. El grado necesita la
    // radiografía y los factores de riesgo: se mantiene. Lo que ya se agregó
    // para decidirlo no se vuelve a pedir.
    const computedReasons = [...reasons]
    const computedStage = isPeriodontitis ? stage : 1
    const computedExtent: PeriodontalExtent = isPeriodontitis ? extent : "localized"
    const rose = computedStage > previous.stage
    const widened = EXTENT_RANK[computedExtent] > EXTENT_RANK[previous.extent]
    missing.length = 0
    reasons.length = 0
    stage = rose ? computedStage : previous.stage
    grade = previous.grade
    extent = widened ? computedExtent : previous.extent
    reasons.push(
      `Estadio ${STAGE_WORD[previous.stage]}, grado ${previous.grade} y ${EXTENT_WORD[previous.extent]} vienen${previous.date ? ` del ${previous.date}` : " del diagnóstico anterior"}: el diagnóstico no baja con el tratamiento.`,
    )
    const stageReason = computedReasons.find((reason) => reason.startsWith("Estadio"))
    const extentReason = computedReasons.find((reason) => /^(Generalizada|Localizada|Patrón)/.test(reason))
    if (rose && stageReason) reasons.push(`Sube: ${stageReason.charAt(0).toLowerCase()}${stageReason.slice(1)}`)
    if (widened && extentReason) reasons.push(`Se extiende: ${extentReason.charAt(0).toLowerCase()}${extentReason.slice(1)}`)
    const current = periodontitisStatus(teeth, implantTeeth)
    status = current.status
    reasons.push(current.reason)
  }
  return { diagnosis: "periodontitis", stage, grade, extent, status, reasons, warnings, missing, implants }
}

/** Lo que confirma el odontólogo; se guarda tal cual, aunque difiera de la propuesta. */
export interface PeriodontalClassification extends PeriodontalClassificationInputs {
  diagnosis: PeriodontalDiagnosis
  stage?: PeriodontitisStage | null
  grade?: PeriodontitisGrade | null
  extent?: PeriodontalExtent | null
  /** Solo periodontitis ya diagnosticada antes: cómo está hoy. */
  status?: PeriodontitisStatus | null
}

export function validatePeriodontalClassification(input: PeriodontalClassification): string[] {
  return periodontalClassificationIssues(input).map((issue) => issue.message)
}

/** Un error de la clasificación con su dato (el nombre que tiene en el cuerpo). */
export interface PeriodontalClassificationIssue {
  field:
    | "diagnosis"
    | "stage"
    | "grade"
    | "extent"
    | "status"
    | "boneLossPercent"
    | "teethLostToPeriodontitis"
    | "cigarettesPerDay"
    | "hba1c"
  message: string
}

/** Lo mismo que `validatePeriodontalClassification`, cada error con su dato. */
export function periodontalClassificationIssues(input: PeriodontalClassification): PeriodontalClassificationIssue[] {
  const issues: PeriodontalClassificationIssue[] = []
  const add = (field: PeriodontalClassificationIssue["field"], message: string) => issues.push({ field, message })
  if (!(PERIODONTAL_DIAGNOSES as readonly string[]).includes(input.diagnosis)) {
    add("diagnosis", "Diagnóstico periodontal inválido")
    return issues
  }
  const isPeriodontitis = input.diagnosis === "periodontitis"
  if (isPeriodontitis) {
    if (!(PERIODONTITIS_STAGES as readonly number[]).includes(input.stage as number)) add("stage", "Falta el estadio (I a IV)")
    if (!(PERIODONTITIS_GRADES as readonly string[]).includes(input.grade as string)) add("grade", "Falta el grado (A, B o C)")
    if (!(PERIODONTAL_EXTENTS as readonly string[]).includes(input.extent as string)) add("extent", "Falta la extensión")
    if (input.status != null && !(PERIODONTITIS_STATUSES as readonly string[]).includes(input.status)) add("status", "Estado inválido")
  } else {
    if (input.stage != null || input.grade != null)
      add(input.stage != null ? "stage" : "grade", "El estadio y el grado son solo de la periodontitis")
    if (input.status != null) add("status", "Estable, en remisión o inestable son solo de la periodontitis")
    if (input.diagnosis === "gingivitis" && !["localized", "generalized"].includes(input.extent as string)) {
      add("extent", "La gingivitis es localizada o generalizada")
    }
    if (input.diagnosis === "health" && input.extent != null) add("extent", "La salud no lleva extensión")
  }
  const range = (
    field: PeriodontalClassificationIssue["field"],
    value: number | null | undefined,
    min: number,
    max: number,
    integer = true,
  ) => {
    if (value === null || value === undefined) return
    if (integer && !Number.isInteger(value)) add(field, "Escribe un número entero, sin decimales.")
    else if (value < min || value > max) add(field, `Escribe un valor de ${min} a ${max}.`)
  }
  range("boneLossPercent", input.boneLossPercent, 0, 100)
  range("teethLostToPeriodontitis", input.teethLostToPeriodontitis, 0, 32)
  range("cigarettesPerDay", input.cigarettesPerDay, 0, 200)
  range("hba1c", input.hba1c, 3, 20, false)
  if (input.hba1c != null && input.diabetes !== true) add("hba1c", "La hemoglobina glicada va con diabetes")
  return issues
}

/** El diagnóstico en palabras: va en la nota del diagnóstico de la atención. */
export function periodontalDiagnosisLabel(
  input: Pick<PeriodontalClassification, "diagnosis" | "stage" | "grade" | "extent" | "status">,
): string {
  if (input.diagnosis === "health") return "Salud periodontal (AAP/EFP 2017)"
  if (input.diagnosis === "gingivitis") {
    return `Gingivitis inducida por biopelícula, ${input.extent === "generalized" ? "generalizada" : "localizada"} (AAP/EFP 2017)`
  }
  const parts = [`Periodontitis estadio ${STAGE_WORD[input.stage ?? 0] ?? ""}`, `grado ${input.grade ?? ""}`]
  if (input.extent) parts.push(EXTENT_WORD[input.extent])
  if (input.status) parts.push(STATUS_WORD[input.status])
  return `${parts.join(", ")} (AAP/EFP 2017)`
}

/**
 * Código del diagnóstico periodontal en la lista de la clínica, para que
 * «Confirmar diagnóstico» deje también el diagnóstico de la atención. Ninguna
 * de las dos listas trae la clasificación de 2017: en la CIE-10 se usa K05.3
 * («periodontitis crónica», la que no es aguda) y K05.1 («gingivitis
 * crónica»); la CIE-11 no tiene la periodontitis ni la gingivitis por
 * biopelícula, así que va «otra especificada» (DA0C.Y y DA0B.Y) con el detalle
 * en la nota. La salud no lleva código.
 */
export function periodontalDiagnosisCode(system: string, diagnosis: PeriodontalDiagnosis): string | null {
  if (diagnosis === "health") return null
  if (system === "ICD-11") return diagnosis === "periodontitis" ? "DA0C.Y" : "DA0B.Y"
  if (system.startsWith("ICD-10")) return diagnosis === "periodontitis" ? "K05.3" : "K05.1"
  return null
}

export interface PeriodontalSiteChange {
  toothNumber: number
  site: PeriodontalSite
  before: number
  after: number
  delta: number
}

/** Sitios que mejoraron o empeoraron entre dos visitas (bolsa, en mm). */
export function comparePeriodontal(
  before: readonly PeriodontalToothRecord[],
  after: readonly PeriodontalToothRecord[],
  threshold = SITE_CHANGE_THRESHOLD_MM,
): { improved: PeriodontalSiteChange[]; worsened: PeriodontalSiteChange[]; compared: number } {
  const previous = new Map(before.map((tooth) => [tooth.toothNumber, tooth]))
  const improved: PeriodontalSiteChange[] = []
  const worsened: PeriodontalSiteChange[] = []
  let compared = 0
  for (const tooth of after) {
    const old = previous.get(tooth.toothNumber)
    if (!old) continue
    tooth.probingDepth.forEach((pd, i) => {
      const was = old.probingDepth[i]
      if (pd === null || was === null || was === undefined) return
      compared++
      const change = { toothNumber: tooth.toothNumber, site: PERIODONTAL_SITES[i]!, before: was, after: pd, delta: pd - was }
      if (change.delta <= -threshold) improved.push(change)
      else if (change.delta >= threshold) worsened.push(change)
    })
  }
  return { improved, worsened, compared }
}

/** Cada sitio en palabras, en el orden en que se guardan. */
export const PERIODONTAL_SITE_WORDS: readonly string[] = SITE_WORDS
/** Caras de O'Leary en palabras, en el orden en que se guardan. */
export const PLAQUE_FACE_WORDS: readonly string[] = ["por fuera", "por dentro", "mesial", "distal"]
export const PERIODONTAL_DIAGNOSIS_WORDS: Readonly<Record<PeriodontalDiagnosis, string>> = {
  health: "Salud periodontal",
  gingivitis: "Gingivitis",
  periodontitis: "Periodontitis",
}
export const PERIODONTAL_EXTENT_WORDS: Readonly<Record<PeriodontalExtent, string>> = EXTENT_WORD
export const PERIODONTITIS_STATUS_WORDS: Readonly<Record<PeriodontitisStatus, string>> = STATUS_WORD
export const PERI_IMPLANT_WORDS: Readonly<Record<PeriImplantCondition, string>> = {
  health: "Salud periimplantaria",
  mucositis: "Mucositis periimplantaria",
  peri_implantitis: "Periimplantitis",
}

/** «Estadio III · Grado B · Generalizada · Inestable»: la clasificación en corto, para una ficha o un chip. */
export function periodontalClassificationShort(
  input: Pick<PeriodontalClassification, "diagnosis" | "stage" | "grade" | "extent" | "status">,
): string {
  const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
  if (input.diagnosis !== "periodontitis") {
    const extent = input.diagnosis === "gingivitis" && input.extent ? ` · ${cap(EXTENT_WORD[input.extent])}` : ""
    return `${PERIODONTAL_DIAGNOSIS_WORDS[input.diagnosis]}${extent}`
  }
  const parts = [`Estadio ${STAGE_WORD[input.stage ?? 0] ?? ""}`, `Grado ${input.grade ?? ""}`]
  if (input.extent) parts.push(cap(EXTENT_WORD[input.extent]))
  if (input.status) parts.push(cap(STATUS_WORD[input.status]))
  return parts.join(" · ")
}

export interface PeriodontalProbingStep {
  toothNumber: number
  face: "buccal" | "lingual"
}

const FACE_SITES: Readonly<Record<PeriodontalProbingStep["face"], readonly number[]>> = {
  buccal: [0, 1, 2],
  lingual: [3, 4, 5],
}

/** Los tres sitios de una cara en el orden en que se guardan (mesial, centro, distal). */
export function faceSiteIndexes(face: PeriodontalProbingStep["face"]): readonly number[] {
  return FACE_SITES[face]
}

/**
 * Pasos de la secuencia de sondaje (pieza y cara) sin ningún sitio medido. Una
 * pieza saltada no falta: se dejó sin medir a propósito.
 */
export function pendingProbing(
  teeth: readonly PeriodontalToothRecord[],
  expectedTeeth: readonly number[],
): PeriodontalProbingStep[] {
  const byTooth = new Map(teeth.map((tooth) => [tooth.toothNumber, tooth]))
  return probingSequence(expectedTeeth).filter(({ toothNumber, face }) => {
    const tooth = byTooth.get(toothNumber)
    if (!tooth) return true
    if (tooth.skipped) return false
    return FACE_SITES[face].every((i) => tooth.probingDepth[i] === null)
  })
}

/** «arriba por fuera», «abajo por dentro»: el tramo de la secuencia de un paso. */
export function probingPassWords(step: PeriodontalProbingStep): string {
  return `${isUpperTooth(step.toothNumber) ? "arriba" : "abajo"} ${step.face === "buccal" ? "por fuera" : "por dentro"}`
}

/**
 * Lo que falta sondear en palabras, por tramos seguidos de la secuencia:
 * «abajo por fuera, de la 43 a la 47; arriba por dentro, la 21». Null si no
 * falta nada; «todo» si no se midió ninguna cara.
 */
export function pendingProbingWords(
  teeth: readonly PeriodontalToothRecord[],
  expectedTeeth: readonly number[],
): string | null {
  const sequence = probingSequence(expectedTeeth)
  const pending = pendingProbing(teeth, expectedTeeth)
  if (pending.length === 0) return null
  if (pending.length === sequence.length) return "todo"
  const key = (step: PeriodontalProbingStep) => `${step.toothNumber}:${step.face}`
  const missing = new Set(pending.map(key))
  const groups: PeriodontalProbingStep[][] = []
  let current: PeriodontalProbingStep[] = []
  sequence.forEach((step, i) => {
    const previous = sequence[i - 1]
    const samePass = previous !== undefined && probingPassWords(previous) === probingPassWords(step)
    if (!missing.has(key(step)) || !samePass) {
      if (current.length) groups.push(current)
      current = []
    }
    if (missing.has(key(step))) current.push(step)
  })
  if (current.length) groups.push(current)
  // Los tramos del mismo recorrido van juntos: «abajo por fuera, la 42 y de la 44 a la 46».
  const passes: Array<{ pass: string; ranges: string[] }> = []
  for (const group of groups) {
    const first = group[0]!
    const last = group.at(-1)!
    const range = group.length === 1 ? `la ${first.toothNumber}` : `de la ${first.toothNumber} a la ${last.toothNumber}`
    const pass = probingPassWords(first)
    const open = passes.at(-1)
    if (open?.pass === pass) open.ranges.push(range)
    else passes.push({ pass, ranges: [range] })
  }
  return passes
    .map(({ pass, ranges }) => `${pass}, ${ranges.length > 1 ? `${ranges.slice(0, -1).join(", ")} y ${ranges.at(-1)}` : ranges[0]}`)
    .join("; ")
}
