/**
 * El examen de la vista de vistIA (entrega 3 del plan): lo que el optómetra mide
 * en la atención, por ojo. Se guarda en `encounter.examination`, como el examen
 * físico de latidIA, y de él sale la receta de anteojos.
 *
 * - Agudeza visual sin y con corrección, de lejos y de cerca, en la notación de
 *   Snellen (20/20 o 6/6, con la línea parcial: 20/25+1), decimal (1,0), de cerca
 *   también Jaeger (J1), N (N5) o M (0,5M) y, cuando no lee la cartilla, cuenta
 *   dedos (CD, o CD 1 m), movimiento de manos (MM), percibe luz (PL) o no percibe
 *   luz (NPL).
 * - Refracción: esfera y cilindro en dioptrías, en pasos de 0,25 D (ISO 21987); el
 *   eje de 1° a 180°, que solo va con cilindro; la adición de cerca (hasta +12,00,
 *   la de baja visión); el prisma en dioptrías prismáticas con su base, y un
 *   segundo en el otro eje si es compuesto.
 * - Distancia pupilar: la monocular de cada ojo (la que pide el taller) y la
 *   binocular de lejos y de cerca, en milímetros.
 * - Salud ocular: el examen externo, las pupilas, la presión del ojo (si la óptica
 *   tiene el equipo, con un decimal) y el fondo de ojo, o la constancia de que no
 *   se hizo.
 * - Quién acompaña: el apoderado presente cuando se examina a un menor.
 *
 * Nada de esto frena la atención: lo que conviene mirar un oftalmólogo se informa
 * (`referralSigns`) y el optómetra decide.
 */

export const EYES = [
  { key: "od", label: "Ojo derecho", short: "OD" },
  { key: "oi", label: "Ojo izquierdo", short: "OI" },
] as const
export type Eye = (typeof EYES)[number]["key"]

export const ACUITY_FIELDS = [
  { key: "scLejos", label: "Sin corrección, de lejos", near: false },
  { key: "ccLejos", label: "Con corrección, de lejos", near: false },
  { key: "scCerca", label: "Sin corrección, de cerca", near: true },
  { key: "ccCerca", label: "Con corrección, de cerca", near: true },
] as const
export type AcuityField = (typeof ACUITY_FIELDS)[number]["key"]
export type Acuity = Partial<Record<AcuityField, string>>

export const PRISM_BASES = [
  { key: "arriba", label: "Base arriba", axis: "vertical" },
  { key: "abajo", label: "Base abajo", axis: "vertical" },
  { key: "adentro", label: "Base adentro (nasal)", axis: "horizontal" },
  { key: "afuera", label: "Base afuera (temporal)", axis: "horizontal" },
] as const
export type PrismBase = (typeof PRISM_BASES)[number]["key"]

/**
 * La refracción de un ojo: lo que va a la receta. El prisma puede ser compuesto
 * (FHIR VisionPrescription admite varios por ojo): `prisma2` con su base en el
 * otro eje, uno horizontal y otro vertical.
 */
export interface Refraction {
  esfera?: number
  cilindro?: number
  eje?: number
  adicion?: number
  prisma?: number
  base?: PrismBase
  prisma2?: number
  base2?: PrismBase
}

export const HEALTH_PARTS = [
  { key: "externo", label: "Examen externo" },
  { key: "pupilas", label: "Pupilas" },
  { key: "fondo", label: "Fondo de ojo" },
] as const
export type HealthPart = (typeof HEALTH_PARTS)[number]["key"]

export const HEALTH_STATES = ["sin_alteraciones", "con_hallazgos", "no_realizado"] as const
export type HealthState = (typeof HEALTH_STATES)[number]
export const HEALTH_STATE_LABELS: Record<HealthState, string> = {
  sin_alteraciones: "Sin alteraciones",
  con_hallazgos: "Con hallazgos",
  no_realizado: "No se hizo",
}

export interface HealthEntry {
  estado: HealthState
  /** Con hallazgos, lo encontrado; sin hacerlo, por qué (opcional). */
  nota?: string
}

export const USES_LENSES = [
  { key: "no", label: "No usa" },
  { key: "anteojos", label: "Anteojos" },
  { key: "contacto", label: "Lentes de contacto" },
  { key: "ambos", label: "Anteojos y lentes de contacto" },
] as const
export type UsesLenses = (typeof USES_LENSES)[number]["key"]

/**
 * La distancia pupilar, en milímetros: la monocular de cada ojo (la que pide el
 * taller para centrar), y la binocular de lejos y la de cerca cuando se mide con
 * regla o con el pupilómetro.
 */
export interface PupillaryDistance {
  od?: number
  oi?: number
  binocular?: number
  cerca?: number
}

export const PD_FIELDS = [
  { key: "od", label: "Monocular OD", min: 20, max: 40 },
  { key: "oi", label: "Monocular OI", min: 20, max: 40 },
  { key: "binocular", label: "Binocular de lejos", min: 40, max: 80 },
  { key: "cerca", label: "Binocular de cerca", min: 38, max: 78 },
] as const

export interface EyeExam {
  /** El apoderado presente cuando se examina a un menor (su nombre y su parentesco). */
  acompanante?: { nombre: string; parentesco?: string }
  /** Lo que importa para la vista: si ya usa lentes y lo que cuenta (golpes, cirugías, diabetes en la familia). */
  antecedentes?: { usaLentes?: UsesLenses; nota?: string }
  agudeza?: Partial<Record<Eye, Acuity>>
  refraccion?: Partial<Record<Eye, Refraction>>
  dp?: PupillaryDistance
  salud?: Partial<Record<HealthPart, HealthEntry>> & {
    /** Presión intraocular en mmHg, si la óptica la mide. */
    presion?: Partial<Record<Eye, number>>
  }
}

/** Los textos cortos del examen, como los demás de la atención. */
export const EYE_NOTE_MAX = 1000

/** Snellen en pies o en metros, con la línea parcial («20/25+1», «6/6−2»). */
const SNELLEN = /^(20|6)\/(\d{1,3})([+-][1-5])?$/
const DECIMAL = /^(?:0?[.,]\d{1,2}|[12](?:[.,]\d{1,2})?)$/
const LOW_VISION = ["CD", "MM", "PL", "NPL"] as const
/** Cuenta dedos o movimiento de manos a una distancia: «CD 1 m», «MM 50 cm». */
const LOW_VISION_AT = /^(CD|MM)A?(\d{1,3}(?:[.,]\d{1,2})?)(M|CM)$/
/** De cerca: Jaeger («J1», «J2+»), la N de los puntos tipográficos («N5») o la M («0,5M»). */
const JAEGER = /^J(\d{1,2})(\+?)$/
const N_POINTS = /^N(\d{1,2}(?:[.,]5)?)$/
const M_UNITS = /^(\d{1,2}(?:[.,]\d{1,2})?)M$/

/**
 * La agudeza tal como se escribe, normalizada («20/20», «20/25+1», «0,8», «CD 1 m»
 * y, de cerca, «J1», «N5» o «0,5M»); null si no es una notación conocida.
 */
export function normalizeAcuity(text: string, near = false): string | null {
  const value = text.trim().toUpperCase().replace(/\s+/g, "").replace("−", "-")
  if (!value) return null
  if ((LOW_VISION as readonly string[]).includes(value)) return value
  const at = LOW_VISION_AT.exec(value)
  if (at) {
    const distance = Number(at[2]!.replace(",", "."))
    if (distance <= 0) return null
    return `${at[1]} ${at[2]!.replace(".", ",")} ${at[3]!.toLowerCase()}`
  }
  const snellen = SNELLEN.exec(value)
  if (snellen) {
    const denominator = Number(snellen[2])
    if (denominator <= 0 || denominator > 800) return null
    return `${snellen[1]}/${denominator}${snellen[3] ?? ""}`
  }
  if (DECIMAL.test(value)) {
    const decimal = Number(value.replace(",", "."))
    return decimal > 0 && decimal <= 2 ? value.replace(".", ",") : null
  }
  if (!near) return null
  const jaeger = JAEGER.exec(value)
  if (jaeger) {
    const line = Number(jaeger[1])
    return line >= 1 && line <= 16 ? `J${line}${jaeger[2]}` : null
  }
  const points = N_POINTS.exec(value)
  if (points) {
    const size = Number(points[1]!.replace(",", "."))
    return size >= 4 && size <= 48 ? `N${points[1]!.replace(".", ",")}` : null
  }
  const units = M_UNITS.exec(value)
  if (units) {
    const size = Number(units[1]!.replace(",", "."))
    return size >= 0.25 && size <= 20 ? `${units[1]!.replace(".", ",")}M` : null
  }
  return null
}

/** La agudeza en fracción decimal (20/40 → 0,5), para comparar; null si no se puede (CD, MM, PL, NPL o de cerca). */
export function acuityDecimal(value: string): number | null {
  const snellen = SNELLEN.exec(value)
  if (snellen) return Number(snellen[1]) / Number(snellen[2])
  if (DECIMAL.test(value)) return Number(value.replace(",", "."))
  return null
}

/** Lo que dice una agudeza de baja visión, en palabras; null si no lo es. */
function lowVisionWords(value: string): string | null {
  if (value.startsWith("NPL")) return "no percibe luz"
  if (value.startsWith("PL")) return "percibe luz"
  if (value.startsWith("CD")) return value === "CD" ? "cuenta dedos" : `cuenta dedos a ${value.slice(3)}`
  if (value.startsWith("MM")) return value === "MM" ? "ve el movimiento de las manos" : `ve el movimiento de las manos a ${value.slice(3)}`
  return null
}

/** Una dioptría: en pasos de 0,25, dentro de lo que se fabrica. */
function diopter(value: unknown, min: number, max: number): number | null | "invalid" {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid"
  if (value < min || value > max || Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) return "invalid"
  return Math.round(value * 4) / 4
}

/**
 * Lo que no se pudo guardar: cada error junto a su dato (ADR 0113), todos a la
 * vez. `error` y `path` son los del primero, para quien solo muestra uno.
 */
export type ParseFailure = { ok: false; error: string; path: string; errors: Record<string, string> }
export type Parsed<T> = { ok: true; value: T | null } | ParseFailure

/** Junta los errores de un examen o una receta, uno por dato. */
export class Issues {
  readonly errors: Record<string, string> = {}
  add(path: string, message: string): void {
    this.errors[path] ??= message
  }
  get any(): boolean {
    return Object.keys(this.errors).length > 0
  }
  failure(): ParseFailure {
    const [path, error] = Object.entries(this.errors)[0]!
    return { ok: false, error, path, errors: { ...this.errors } }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const blank = (value: unknown) => value === null || value === undefined || value === ""

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string, path: string, issues: Issues): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  if (extra) issues.add(path, `${what} no tiene el campo ${extra}`)
}

function note(value: unknown, what: string, path: string, issues: Issues): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== "string") {
    issues.add(path, `${what}: es un texto`)
    return undefined
  }
  const text = value.trim()
  if (text.length > EYE_NOTE_MAX) {
    issues.add(path, `${what}: hasta ${EYE_NOTE_MAX} caracteres`)
    return undefined
  }
  return text || undefined
}

const eyeLabel = (eye: Eye) => EYES.find((item) => item.key === eye)!.short
const baseAxis = (base: PrismBase) => PRISM_BASES.find((item) => item.key === base)!.axis

/** Un prisma: de 0,25 a 20 dioptrías prismáticas, en pasos de 0,25, con su base. */
function prism(
  amount: unknown,
  base: unknown,
  label: string,
  path: { amount: string; base: string },
  issues: Issues,
): { amount: number; base: PrismBase } | null {
  if (blank(amount)) {
    if (!blank(base)) issues.add(path.base, `Base ${label}: solo va con prisma`)
    return null
  }
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 20 || Math.abs(amount * 4 - Math.round(amount * 4)) > 1e-9) {
    issues.add(path.amount, `Prisma ${label}: de 0,25 a 20 dioptrías prismáticas, en pasos de 0,25`)
    return null
  }
  if (!PRISM_BASES.some((item) => item.key === base)) {
    issues.add(path.base, `Prisma ${label}: falta su base`)
    return null
  }
  return { amount, base: base as PrismBase }
}

/** La refracción de un ojo, validada; la usa también la receta. Los errores van a `issues`. */
export function readRefraction(raw: unknown, eye: Eye, path: string, issues: Issues): Refraction | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) {
    issues.add(path, `Refracción ${eyeLabel(eye)}: debe ser un objeto`)
    return null
  }
  const label = eyeLabel(eye)
  onlyKeys(raw, ["esfera", "cilindro", "eje", "adicion", "prisma", "base", "prisma2", "base2"], `La refracción ${label}`, path, issues)
  const out: Refraction = {}
  const esfera = diopter(raw.esfera, -30, 30)
  if (esfera === "invalid") issues.add(`${path}.esfera`, `Esfera ${label}: de −30,00 a +30,00, en pasos de 0,25`)
  else if (esfera !== null) out.esfera = esfera
  const cilindro = diopter(raw.cilindro, -10, 10)
  if (cilindro === "invalid") issues.add(`${path}.cilindro`, `Cilindro ${label}: de −10,00 a +10,00, en pasos de 0,25`)
  else if (cilindro !== null && cilindro !== 0) out.cilindro = cilindro
  if (!blank(raw.eje)) {
    if (typeof raw.eje !== "number" || !Number.isInteger(raw.eje) || raw.eje < 1 || raw.eje > 180)
      issues.add(`${path}.eje`, `Eje ${label}: un número entero de 1 a 180`)
    else if (out.cilindro === undefined && cilindro !== "invalid") issues.add(`${path}.eje`, `Eje ${label}: solo va con cilindro`)
    else out.eje = raw.eje
  } else if (out.cilindro !== undefined) {
    issues.add(`${path}.eje`, `Eje ${label}: con cilindro hace falta el eje`)
  }
  // Hasta +12,00: la adición de baja visión pasa de las +4,00 de la presbicia.
  const adicion = diopter(raw.adicion, 0.25, 12)
  if (adicion === "invalid") issues.add(`${path}.adicion`, `Adición ${label}: de +0,25 a +12,00, en pasos de 0,25`)
  else if (adicion !== null) out.adicion = adicion
  const first = prism(raw.prisma, raw.base, label, { amount: `${path}.prisma`, base: `${path}.base` }, issues)
  if (first) {
    out.prisma = first.amount
    out.base = first.base
  }
  const second = prism(raw.prisma2, raw.base2, `${label} (el segundo)`, { amount: `${path}.prisma2`, base: `${path}.base2` }, issues)
  if (second) {
    if (!first) issues.add(`${path}.prisma2`, `Prisma ${label}: el segundo va con el primero`)
    else if (baseAxis(second.base) === baseAxis(first.base))
      issues.add(`${path}.base2`, `Prisma ${label}: el segundo va en el otro eje (uno horizontal y otro vertical)`)
    else {
      out.prisma2 = second.amount
      out.base2 = second.base
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** La refracción de un ojo, validada, con todos sus errores. */
export function parseRefraction(raw: unknown, eye: Eye, path: string): Parsed<Refraction> {
  const issues = new Issues()
  const value = readRefraction(raw, eye, path, issues)
  return issues.any ? issues.failure() : { ok: true, value }
}

/** Una medida en milímetros, en pasos de medio milímetro. */
function halfMillimeters(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && value >= min && value <= max && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
}

/** La distancia pupilar, validada; la usa también la receta. */
export function readPupillaryDistance(raw: unknown, path: string, issues: Issues): PupillaryDistance | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) {
    issues.add(path, "La distancia pupilar debe ser un objeto")
    return null
  }
  onlyKeys(raw, PD_FIELDS.map((field) => field.key), "La distancia pupilar", path, issues)
  const out: PupillaryDistance = {}
  for (const field of PD_FIELDS) {
    const value = raw[field.key]
    if (blank(value)) continue
    if (!halfMillimeters(value, field.min, field.max))
      issues.add(`${path}.${field.key}`, `Distancia pupilar ${field.label.toLowerCase()}: de ${field.min} a ${field.max} mm, en medios milímetros`)
    else out[field.key] = value as number
  }
  return Object.keys(out).length ? out : null
}

/** Valida y limpia el examen; sin nada anotado, null. Cada error dice la ruta de su dato, todos a la vez. */
export function parseEyeExam(input: unknown): Parsed<EyeExam> {
  if (input === null || input === undefined) return { ok: true, value: null }
  const issues = new Issues()
  if (!isObject(input)) {
    issues.add("", "El examen debe ser un objeto")
    return issues.failure()
  }
  onlyKeys(input, ["acompanante", "antecedentes", "agudeza", "refraccion", "dp", "salud"], "El examen", "", issues)
  const out: EyeExam = {}

  if (input.acompanante !== null && input.acompanante !== undefined) {
    const raw = input.acompanante
    if (!isObject(raw)) issues.add("acompanante", "Quién acompaña debe ser un objeto")
    else {
      onlyKeys(raw, ["nombre", "parentesco"], "Quién acompaña", "acompanante", issues)
      const name = note(raw.nombre, "Quién acompaña", "acompanante.nombre", issues)
      const kin = note(raw.parentesco, "Su parentesco", "acompanante.parentesco", issues)
      if (name && name.length > 200) issues.add("acompanante.nombre", "Quién acompaña: hasta 200 caracteres")
      else if (kin && !name) issues.add("acompanante.nombre", "Escribe el nombre de quien acompaña")
      else if (name) out.acompanante = { nombre: name, ...(kin ? { parentesco: kin.slice(0, 60) } : {}) }
    }
  }

  if (input.antecedentes !== null && input.antecedentes !== undefined) {
    const raw = input.antecedentes
    if (!isObject(raw)) issues.add("antecedentes", "Los antecedentes deben ser un objeto")
    else {
      onlyKeys(raw, ["usaLentes", "nota"], "Los antecedentes", "antecedentes", issues)
      const antecedentes: NonNullable<EyeExam["antecedentes"]> = {}
      if (!blank(raw.usaLentes)) {
        if (!USES_LENSES.some((item) => item.key === raw.usaLentes)) issues.add("antecedentes.usaLentes", "Elige si usa lentes")
        else antecedentes.usaLentes = raw.usaLentes as UsesLenses
      }
      const text = note(raw.nota, "Antecedentes", "antecedentes.nota", issues)
      if (text) antecedentes.nota = text
      if (Object.keys(antecedentes).length) out.antecedentes = antecedentes
    }
  }

  if (input.agudeza !== null && input.agudeza !== undefined) {
    if (!isObject(input.agudeza)) issues.add("agudeza", "La agudeza visual debe ser un objeto")
    else {
      onlyKeys(input.agudeza, ["od", "oi"], "La agudeza visual", "agudeza", issues)
      const agudeza: NonNullable<EyeExam["agudeza"]> = {}
      for (const { key: eye } of EYES) {
        const raw = input.agudeza[eye]
        if (raw === null || raw === undefined) continue
        if (!isObject(raw)) {
          issues.add(`agudeza.${eye}`, `Agudeza ${eyeLabel(eye)}: debe ser un objeto`)
          continue
        }
        onlyKeys(raw, ACUITY_FIELDS.map((field) => field.key), `La agudeza ${eyeLabel(eye)}`, `agudeza.${eye}`, issues)
        const acuity: Acuity = {}
        for (const { key, label, near } of ACUITY_FIELDS) {
          const value = raw[key]
          if (blank(value)) continue
          const normal = typeof value === "string" ? normalizeAcuity(value, near) : null
          if (!normal)
            issues.add(
              `agudeza.${eye}.${key}`,
              near
                ? `${label} ${eyeLabel(eye)}: como 20/20, 0,8, J1, N5, 0,5M o CD`
                : `${label} ${eyeLabel(eye)}: como 20/20, 20/25+1, 6/6, 0,8, CD 1 m, MM, PL o NPL`,
            )
          else acuity[key] = normal
        }
        if (Object.keys(acuity).length) agudeza[eye] = acuity
      }
      if (Object.keys(agudeza).length) out.agudeza = agudeza
    }
  }

  if (input.refraccion !== null && input.refraccion !== undefined) {
    if (!isObject(input.refraccion)) issues.add("refraccion", "La refracción debe ser un objeto")
    else {
      onlyKeys(input.refraccion, ["od", "oi"], "La refracción", "refraccion", issues)
      const refraccion: NonNullable<EyeExam["refraccion"]> = {}
      for (const { key: eye } of EYES) {
        const value = readRefraction(input.refraccion[eye], eye, `refraccion.${eye}`, issues)
        if (value) refraccion[eye] = value
      }
      if (Object.keys(refraccion).length) out.refraccion = refraccion
    }
  }

  const dp = readPupillaryDistance(input.dp, "dp", issues)
  if (dp) out.dp = dp

  if (input.salud !== null && input.salud !== undefined) {
    if (!isObject(input.salud)) issues.add("salud", "La salud del ojo debe ser un objeto")
    else {
      onlyKeys(input.salud, [...HEALTH_PARTS.map((part) => part.key), "presion"], "La salud del ojo", "salud", issues)
      const salud: NonNullable<EyeExam["salud"]> = {}
      for (const { key, label } of HEALTH_PARTS) {
        const raw = input.salud[key]
        if (raw === null || raw === undefined) continue
        if (!isObject(raw) || !(HEALTH_STATES as readonly unknown[]).includes(raw.estado)) {
          issues.add(`salud.${key}`, `${label}: «Sin alteraciones», «Con hallazgos» o «No se hizo»`)
          continue
        }
        const text = note(raw.nota, label, `salud.${key}.nota`, issues)
        const estado = raw.estado as HealthState
        // Sin alteraciones no lleva nota: si la tenía, se descarta al cambiar de estado.
        salud[key] = estado !== "sin_alteraciones" && text ? { estado, nota: text } : { estado }
      }
      if (input.salud.presion !== null && input.salud.presion !== undefined) {
        if (!isObject(input.salud.presion)) issues.add("salud.presion", "La presión del ojo debe ser un objeto")
        else {
          const presion: Partial<Record<Eye, number>> = {}
          for (const { key: eye } of EYES) {
            const value = input.salud.presion[eye]
            if (blank(value)) continue
            // Con un decimal: el tonómetro de aire y el de rebote dan 15,5.
            if (typeof value !== "number" || value < 1 || value > 80 || Math.abs(value * 10 - Math.round(value * 10)) > 1e-9)
              issues.add(`salud.presion.${eye}`, `Presión ${eyeLabel(eye)}: de 1 a 80 mmHg, con un decimal como mucho`)
            else presion[eye] = value
          }
          if (Object.keys(presion).length) salud.presion = presion
        }
      }
      if (Object.keys(salud).length) out.salud = salud
    }
  }

  if (issues.any) return issues.failure()
  return { ok: true, value: Object.keys(out).length > 0 ? out : null }
}

/** Lo guardado, leído sin fallar: lo que no se entiende no se muestra. */
export function readEyeExam(value: unknown): EyeExam | null {
  const parsed = parseEyeExam(value)
  return parsed.ok ? parsed.value : null
}

/** Una dioptría como se escribe en una receta: con signo y dos decimales («+1,25», «−0,50», «Neutro»). */
export function diopterText(value: number | undefined): string {
  if (value === undefined) return ""
  if (value === 0) return "Neutro"
  const sign = value > 0 ? "+" : "−"
  return `${sign}${Math.abs(value).toFixed(2).replace(".", ",")}`
}

/** La refracción de un ojo en una línea: «−1,25 −0,50 × 180 · Add +2,00 · 1 Δ base adentro». */
export function refractionText(refraction: Refraction | undefined): string {
  if (!refraction) return ""
  const parts: string[] = []
  const lens = [diopterText(refraction.esfera ?? (refraction.cilindro !== undefined ? 0 : undefined))]
  if (refraction.cilindro !== undefined) lens.push(`${diopterText(refraction.cilindro)} × ${refraction.eje}°`)
  if (lens.join("")) parts.push(lens.filter(Boolean).join(" "))
  if (refraction.adicion !== undefined) parts.push(`Add ${diopterText(refraction.adicion)}`)
  const prisms = [
    [refraction.prisma, refraction.base],
    [refraction.prisma2, refraction.base2],
  ] as const
  const prismText = prisms
    .filter(([amount]) => amount !== undefined)
    .map(([amount, base]) => `${String(amount).replace(".", ",")} Δ ${PRISM_BASES.find((item) => item.key === base)?.label.toLowerCase() ?? ""}`)
  if (prismText.length) parts.push(prismText.join(" + "))
  return parts.join(" · ")
}

/** La distancia pupilar en una línea: «OD 31,5 mm, OI 32 mm · binocular 63,5 mm · de cerca 60 mm». */
export function pupillaryDistanceText(dp: PupillaryDistance | null | undefined): string {
  if (!dp) return ""
  const mm = (value: number) => `${String(value).replace(".", ",")} mm`
  const monocular = EYES.filter((eye) => dp[eye.key] !== undefined).map((eye) => `${eye.short} ${mm(dp[eye.key]!)}`)
  return [
    monocular.join(", "),
    dp.binocular !== undefined ? `binocular ${mm(dp.binocular)}` : "",
    dp.cerca !== undefined ? `de cerca ${mm(dp.cerca)}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** El examen en la historia, en líneas; sin nada anotado, ninguna. */
export function eyeExamLines(exam: EyeExam | null): string[] {
  if (!exam) return []
  const lines: string[] = []
  if (exam.acompanante)
    lines.push(`Acompaña: ${exam.acompanante.nombre}${exam.acompanante.parentesco ? ` (${exam.acompanante.parentesco})` : ""}`)
  const uses = exam.antecedentes?.usaLentes
  if (uses || exam.antecedentes?.nota) {
    const usesText = uses ? `Usa: ${USES_LENSES.find((item) => item.key === uses)!.label.toLowerCase()}` : ""
    lines.push(`Antecedentes: ${[usesText, exam.antecedentes?.nota].filter(Boolean).join(". ")}`)
  }
  for (const { key: eye, short } of EYES) {
    const acuity = exam.agudeza?.[eye]
    if (acuity) {
      const parts = ACUITY_FIELDS.filter((field) => acuity[field.key]).map(
        (field) => `${field.label.toLowerCase()} ${acuity[field.key]}`,
      )
      lines.push(`Agudeza visual ${short}: ${parts.join(", ")}`)
    }
  }
  for (const { key: eye, short } of EYES) {
    const text = refractionText(exam.refraccion?.[eye])
    if (text) lines.push(`Refracción ${short}: ${text}`)
  }
  const dpText = pupillaryDistanceText(exam.dp)
  if (dpText) lines.push(`Distancia pupilar: ${dpText}`)
  for (const { key, label } of HEALTH_PARTS) {
    const entry = exam.salud?.[key]
    if (entry) lines.push(`${label}: ${HEALTH_STATE_LABELS[entry.estado].toLowerCase()}${entry.nota ? `. ${entry.nota}` : ""}`)
  }
  const pressure = exam.salud?.presion
  if (pressure) {
    const values = EYES.filter((eye) => pressure[eye.key] !== undefined).map(
      (eye) => `${eye.short} ${String(pressure[eye.key]).replace(".", ",")} mmHg`,
    )
    lines.push(`Presión del ojo: ${values.join(", ")}`)
  }
  return lines
}

/** El resumen del bloque: «Refracción de los dos ojos», «Agudeza visual anotada». */
export function eyeExamSummary(exam: EyeExam | null): string {
  if (!exam) return ""
  const refracted = EYES.filter((eye) => exam.refraccion?.[eye.key]).length
  if (refracted === 2) return "Refracción de los dos ojos"
  if (refracted === 1) return "Refracción de un ojo"
  if (exam.agudeza) return "Agudeza visual anotada"
  return "Examen anotado"
}

/** La presión del ojo desde la que se informa: por encima del rango habitual (10 a 21 mmHg). */
export const HIGH_PRESSURE = 21
/** La agudeza con corrección por debajo de la cual se informa: no llega a 20/40 con lentes. */
export const LOW_CORRECTED = 0.5

/**
 * Lo que conviene que vea un oftalmólogo, en palabras: la presión alta del ojo, el
 * fondo de ojo o las pupilas con hallazgos, una agudeza que no mejora con lentes o
 * que solo cuenta dedos o ve luz. Se informa, no frena: el optómetra decide si deriva.
 */
export function referralSigns(exam: EyeExam | null): string[] {
  if (!exam) return []
  const signs: string[] = []
  for (const { key: eye, short } of EYES) {
    const pressure = exam.salud?.presion?.[eye]
    if (pressure !== undefined && pressure > HIGH_PRESSURE) signs.push(`Presión del ojo alta en ${short} (${pressure} mmHg)`)
  }
  if (exam.salud?.fondo?.estado === "con_hallazgos") signs.push("Fondo de ojo con hallazgos")
  if (exam.salud?.pupilas?.estado === "con_hallazgos") signs.push("Pupilas con hallazgos")
  for (const { key: eye, short } of EYES) {
    const corrected = exam.agudeza?.[eye]?.ccLejos
    if (!corrected) continue
    const low = lowVisionWords(corrected)
    if (low) {
      signs.push(`${short} solo ${low}`)
      continue
    }
    const decimal = acuityDecimal(corrected)
    if (decimal !== null && decimal < LOW_CORRECTED) signs.push(`${short} no llega a 20/40 con corrección (${corrected})`)
  }
  return signs
}
