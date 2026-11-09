/**
 * El examen de la vista de vistIA (entrega 3 del plan): lo que el optómetra mide
 * en la atención, por ojo. Se guarda en `encounter.examination`, como el examen
 * físico de latidIA, y de él sale la receta de anteojos.
 *
 * - Agudeza visual sin y con corrección, de lejos y de cerca, en la notación de
 *   Snellen (20/20, o 6/6), decimal (1,0) o, cuando no lee la cartilla, cuenta
 *   dedos (CD), movimiento de manos (MM), percibe luz (PL) o no percibe luz (NPL).
 * - Refracción: esfera y cilindro en dioptrías, en pasos de 0,25 D (ISO 21987); el
 *   eje de 1° a 180°, que solo va con cilindro; la adición de cerca; el prisma en
 *   dioptrías prismáticas con su base.
 * - Distancia pupilar de cada ojo, en milímetros: monocular, como la pide el taller.
 * - Salud ocular: el examen externo, las pupilas, la presión del ojo (si la óptica
 *   tiene el equipo) y el fondo de ojo, o la constancia de que no se hizo.
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
  { key: "scLejos", label: "Sin corrección, de lejos" },
  { key: "ccLejos", label: "Con corrección, de lejos" },
  { key: "scCerca", label: "Sin corrección, de cerca" },
  { key: "ccCerca", label: "Con corrección, de cerca" },
] as const
export type AcuityField = (typeof ACUITY_FIELDS)[number]["key"]
export type Acuity = Partial<Record<AcuityField, string>>

export const PRISM_BASES = [
  { key: "arriba", label: "Base arriba" },
  { key: "abajo", label: "Base abajo" },
  { key: "adentro", label: "Base adentro (nasal)" },
  { key: "afuera", label: "Base afuera (temporal)" },
] as const
export type PrismBase = (typeof PRISM_BASES)[number]["key"]

/** La refracción de un ojo: lo que va a la receta. */
export interface Refraction {
  esfera?: number
  cilindro?: number
  eje?: number
  adicion?: number
  prisma?: number
  base?: PrismBase
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

export interface EyeExam {
  /** El apoderado presente cuando se examina a un menor (su nombre y su parentesco). */
  acompanante?: { nombre: string; parentesco?: string }
  /** Lo que importa para la vista: si ya usa lentes y lo que cuenta (golpes, cirugías, diabetes en la familia). */
  antecedentes?: { usaLentes?: UsesLenses; nota?: string }
  agudeza?: Partial<Record<Eye, Acuity>>
  refraccion?: Partial<Record<Eye, Refraction>>
  /** Distancia pupilar monocular, en milímetros. */
  dp?: Partial<Record<Eye, number>>
  salud?: Partial<Record<HealthPart, HealthEntry>> & {
    /** Presión intraocular en mmHg, si la óptica la mide. */
    presion?: Partial<Record<Eye, number>>
  }
}

/** Los textos cortos del examen, como los demás de la atención. */
export const EYE_NOTE_MAX = 1000

const SNELLEN = /^(20|6)\/(\d{1,3})$/
const DECIMAL = /^(?:0?[.,]\d{1,2}|[12](?:[.,]\d{1,2})?)$/
const LOW_VISION = ["CD", "MM", "PL", "NPL"] as const

/** La agudeza tal como se escribe, normalizada («20/20», «0,8», «CD»); null si no es una notación conocida. */
export function normalizeAcuity(text: string): string | null {
  const value = text.trim().toUpperCase().replace(/\s+/g, "")
  if (!value) return null
  if ((LOW_VISION as readonly string[]).includes(value)) return value
  const snellen = SNELLEN.exec(value)
  if (snellen) {
    const denominator = Number(snellen[2])
    return denominator > 0 && denominator <= 800 ? `${snellen[1]}/${denominator}` : null
  }
  if (DECIMAL.test(value)) {
    const decimal = Number(value.replace(",", "."))
    return decimal > 0 && decimal <= 2 ? value.replace(".", ",") : null
  }
  return null
}

/** La agudeza en fracción decimal (20/40 → 0,5), para comparar; null si es CD, MM, PL o NPL. */
export function acuityDecimal(value: string): number | null {
  const snellen = SNELLEN.exec(value)
  if (snellen) return Number(snellen[1]) / Number(snellen[2])
  if (DECIMAL.test(value)) return Number(value.replace(",", "."))
  return null
}

/** Una dioptría: en pasos de 0,25, dentro de lo que se fabrica. */
function diopter(value: unknown, min: number, max: number): number | null | "invalid" {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid"
  if (value < min || value > max || Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) return "invalid"
  return Math.round(value * 4) / 4
}

type Parsed<T> = { ok: true; value: T | null } | { ok: false; error: string; path: string }

const fail = (error: string, path: string): { ok: false; error: string; path: string } => ({ ok: false, error, path })

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string, path: string) {
  const extra = Object.keys(value).find((key) => !keys.includes(key))
  return extra ? fail(`${what} no tiene el campo ${extra}`, path) : null
}

function note(value: unknown, what: string, path: string): { ok: true; value: string | undefined } | { ok: false; error: string; path: string } {
  if (value === null || value === undefined) return { ok: true, value: undefined }
  if (typeof value !== "string") return fail(`${what}: es un texto`, path)
  const text = value.trim()
  if (text.length > EYE_NOTE_MAX) return fail(`${what}: hasta ${EYE_NOTE_MAX} caracteres`, path)
  return { ok: true, value: text || undefined }
}

const eyeLabel = (eye: Eye) => EYES.find((item) => item.key === eye)!.short

/** La refracción de un ojo, validada; la usa también la receta. */
export function parseRefraction(raw: unknown, eye: Eye, path: string): Parsed<Refraction> {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (!isObject(raw)) return fail(`Refracción ${eyeLabel(eye)}: debe ser un objeto`, path)
  const extra = onlyKeys(raw, ["esfera", "cilindro", "eje", "adicion", "prisma", "base"], `La refracción ${eyeLabel(eye)}`, path)
  if (extra) return extra
  const out: Refraction = {}
  const esfera = diopter(raw.esfera, -30, 30)
  if (esfera === "invalid") return fail(`Esfera ${eyeLabel(eye)}: de −30,00 a +30,00, en pasos de 0,25`, `${path}.esfera`)
  if (esfera !== null) out.esfera = esfera
  const cilindro = diopter(raw.cilindro, -10, 10)
  if (cilindro === "invalid") return fail(`Cilindro ${eyeLabel(eye)}: de −10,00 a +10,00, en pasos de 0,25`, `${path}.cilindro`)
  if (cilindro !== null && cilindro !== 0) out.cilindro = cilindro
  if (raw.eje !== null && raw.eje !== undefined && raw.eje !== "") {
    if (typeof raw.eje !== "number" || !Number.isInteger(raw.eje) || raw.eje < 1 || raw.eje > 180)
      return fail(`Eje ${eyeLabel(eye)}: un número entero de 1 a 180`, `${path}.eje`)
    if (out.cilindro === undefined) return fail(`Eje ${eyeLabel(eye)}: solo va con cilindro`, `${path}.eje`)
    out.eje = raw.eje
  } else if (out.cilindro !== undefined) {
    return fail(`Eje ${eyeLabel(eye)}: con cilindro hace falta el eje`, `${path}.eje`)
  }
  const adicion = diopter(raw.adicion, 0.25, 4)
  if (adicion === "invalid") return fail(`Adición ${eyeLabel(eye)}: de +0,25 a +4,00, en pasos de 0,25`, `${path}.adicion`)
  if (adicion !== null) out.adicion = adicion
  if (raw.prisma !== null && raw.prisma !== undefined && raw.prisma !== "") {
    const prisma = raw.prisma
    if (typeof prisma !== "number" || !Number.isFinite(prisma) || prisma <= 0 || prisma > 20 || Math.abs(prisma * 2 - Math.round(prisma * 2)) > 1e-9)
      return fail(`Prisma ${eyeLabel(eye)}: de 0,5 a 20 dioptrías prismáticas, en pasos de 0,5`, `${path}.prisma`)
    if (!PRISM_BASES.some((base) => base.key === raw.base)) return fail(`Prisma ${eyeLabel(eye)}: falta su base`, `${path}.base`)
    out.prisma = prisma
    out.base = raw.base as PrismBase
  } else if (raw.base !== null && raw.base !== undefined && raw.base !== "") {
    return fail(`Base ${eyeLabel(eye)}: solo va con prisma`, `${path}.base`)
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null }
}

/** Valida y limpia el examen; sin nada anotado, null. Los errores dicen la ruta del dato. */
export function parseEyeExam(input: unknown): Parsed<EyeExam> {
  if (input === null || input === undefined) return { ok: true, value: null }
  if (!isObject(input)) return fail("El examen debe ser un objeto", "")
  const extra = onlyKeys(input, ["acompanante", "antecedentes", "agudeza", "refraccion", "dp", "salud"], "El examen", "")
  if (extra) return extra
  const out: EyeExam = {}

  if (input.acompanante !== null && input.acompanante !== undefined) {
    const raw = input.acompanante
    if (!isObject(raw)) return fail("Quién acompaña debe ser un objeto", "acompanante")
    const bad = onlyKeys(raw, ["nombre", "parentesco"], "Quién acompaña", "acompanante")
    if (bad) return bad
    const name = note(raw.nombre, "Quién acompaña", "acompanante.nombre")
    if (!name.ok) return name
    const kin = note(raw.parentesco, "Su parentesco", "acompanante.parentesco")
    if (!kin.ok) return kin
    if (name.value && name.value.length > 200) return fail("Quién acompaña: hasta 200 caracteres", "acompanante.nombre")
    if (kin.value && !name.value) return fail("Escribe el nombre de quien acompaña", "acompanante.nombre")
    if (name.value) out.acompanante = { nombre: name.value, ...(kin.value ? { parentesco: kin.value.slice(0, 60) } : {}) }
  }

  if (input.antecedentes !== null && input.antecedentes !== undefined) {
    const raw = input.antecedentes
    if (!isObject(raw)) return fail("Los antecedentes deben ser un objeto", "antecedentes")
    const bad = onlyKeys(raw, ["usaLentes", "nota"], "Los antecedentes", "antecedentes")
    if (bad) return bad
    const antecedentes: NonNullable<EyeExam["antecedentes"]> = {}
    if (raw.usaLentes !== null && raw.usaLentes !== undefined && raw.usaLentes !== "") {
      if (!USES_LENSES.some((item) => item.key === raw.usaLentes)) return fail("Elige si usa lentes", "antecedentes.usaLentes")
      antecedentes.usaLentes = raw.usaLentes as UsesLenses
    }
    const text = note(raw.nota, "Antecedentes", "antecedentes.nota")
    if (!text.ok) return text
    if (text.value) antecedentes.nota = text.value
    if (Object.keys(antecedentes).length) out.antecedentes = antecedentes
  }

  if (input.agudeza !== null && input.agudeza !== undefined) {
    if (!isObject(input.agudeza)) return fail("La agudeza visual debe ser un objeto", "agudeza")
    const bad = onlyKeys(input.agudeza, ["od", "oi"], "La agudeza visual", "agudeza")
    if (bad) return bad
    const agudeza: NonNullable<EyeExam["agudeza"]> = {}
    for (const { key: eye } of EYES) {
      const raw = input.agudeza[eye]
      if (raw === null || raw === undefined) continue
      if (!isObject(raw)) return fail(`Agudeza ${eyeLabel(eye)}: debe ser un objeto`, `agudeza.${eye}`)
      const wrong = onlyKeys(raw, ACUITY_FIELDS.map((field) => field.key), `La agudeza ${eyeLabel(eye)}`, `agudeza.${eye}`)
      if (wrong) return wrong
      const acuity: Acuity = {}
      for (const { key, label } of ACUITY_FIELDS) {
        const value = raw[key]
        if (value === null || value === undefined || value === "") continue
        const normal = typeof value === "string" ? normalizeAcuity(value) : null
        if (!normal) return fail(`${label} ${eyeLabel(eye)}: como 20/20, 6/6, 0,8, CD, MM, PL o NPL`, `agudeza.${eye}.${key}`)
        acuity[key] = normal
      }
      if (Object.keys(acuity).length) agudeza[eye] = acuity
    }
    if (Object.keys(agudeza).length) out.agudeza = agudeza
  }

  if (input.refraccion !== null && input.refraccion !== undefined) {
    if (!isObject(input.refraccion)) return fail("La refracción debe ser un objeto", "refraccion")
    const bad = onlyKeys(input.refraccion, ["od", "oi"], "La refracción", "refraccion")
    if (bad) return bad
    const refraccion: NonNullable<EyeExam["refraccion"]> = {}
    for (const { key: eye } of EYES) {
      const parsed = parseRefraction(input.refraccion[eye], eye, `refraccion.${eye}`)
      if (!parsed.ok) return parsed
      if (parsed.value) refraccion[eye] = parsed.value
    }
    if (Object.keys(refraccion).length) out.refraccion = refraccion
  }

  if (input.dp !== null && input.dp !== undefined) {
    if (!isObject(input.dp)) return fail("La distancia pupilar debe ser un objeto", "dp")
    const bad = onlyKeys(input.dp, ["od", "oi"], "La distancia pupilar", "dp")
    if (bad) return bad
    const dp: NonNullable<EyeExam["dp"]> = {}
    for (const { key: eye } of EYES) {
      const value = input.dp[eye]
      if (value === null || value === undefined || value === "") continue
      if (typeof value !== "number" || value < 20 || value > 40 || Math.abs(value * 2 - Math.round(value * 2)) > 1e-9)
        return fail(`Distancia pupilar ${eyeLabel(eye)}: de 20 a 40 mm, en medios milímetros`, `dp.${eye}`)
      dp[eye] = value
    }
    if (Object.keys(dp).length) out.dp = dp
  }

  if (input.salud !== null && input.salud !== undefined) {
    if (!isObject(input.salud)) return fail("La salud del ojo debe ser un objeto", "salud")
    const bad = onlyKeys(input.salud, [...HEALTH_PARTS.map((part) => part.key), "presion"], "La salud del ojo", "salud")
    if (bad) return bad
    const salud: NonNullable<EyeExam["salud"]> = {}
    for (const { key, label } of HEALTH_PARTS) {
      const raw = input.salud[key]
      if (raw === null || raw === undefined) continue
      if (!isObject(raw) || !(HEALTH_STATES as readonly unknown[]).includes(raw.estado))
        return fail(`${label}: «Sin alteraciones», «Con hallazgos» o «No se hizo»`, `salud.${key}`)
      const text = note(raw.nota, label, `salud.${key}.nota`)
      if (!text.ok) return text
      const estado = raw.estado as HealthState
      // Sin alteraciones no lleva nota: si la tenía, se descarta al cambiar de estado.
      salud[key] = estado !== "sin_alteraciones" && text.value ? { estado, nota: text.value } : { estado }
    }
    if (input.salud.presion !== null && input.salud.presion !== undefined) {
      if (!isObject(input.salud.presion)) return fail("La presión del ojo debe ser un objeto", "salud.presion")
      const presion: Partial<Record<Eye, number>> = {}
      for (const { key: eye } of EYES) {
        const value = input.salud.presion[eye]
        if (value === null || value === undefined || value === "") continue
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 80)
          return fail(`Presión ${eyeLabel(eye)}: un número entero de mmHg, de 1 a 80`, `salud.presion.${eye}`)
        presion[eye] = value
      }
      if (Object.keys(presion).length) salud.presion = presion
    }
    if (Object.keys(salud).length) out.salud = salud
  }

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
  if (refraction.prisma !== undefined) {
    const base = PRISM_BASES.find((item) => item.key === refraction.base)?.label.toLowerCase() ?? ""
    parts.push(`${String(refraction.prisma).replace(".", ",")} Δ ${base}`)
  }
  return parts.join(" · ")
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
  if (exam.dp) {
    const dp = EYES.filter((eye) => exam.dp?.[eye.key] !== undefined).map(
      (eye) => `${eye.short} ${String(exam.dp![eye.key]).replace(".", ",")} mm`,
    )
    lines.push(`Distancia pupilar: ${dp.join(", ")}`)
  }
  for (const { key, label } of HEALTH_PARTS) {
    const entry = exam.salud?.[key]
    if (entry) lines.push(`${label}: ${HEALTH_STATE_LABELS[entry.estado].toLowerCase()}${entry.nota ? `. ${entry.nota}` : ""}`)
  }
  const pressure = exam.salud?.presion
  if (pressure) {
    const values = EYES.filter((eye) => pressure[eye.key] !== undefined).map((eye) => `${eye.short} ${pressure[eye.key]} mmHg`)
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
    const decimal = acuityDecimal(corrected)
    if (decimal === null) signs.push(`${short} solo ${corrected === "CD" ? "cuenta dedos" : corrected === "MM" ? "ve el movimiento de las manos" : corrected === "PL" ? "percibe luz" : "no percibe luz"}`)
    else if (decimal < LOW_CORRECTED) signs.push(`${short} no llega a 20/40 con corrección (${corrected})`)
  }
  return signs
}
