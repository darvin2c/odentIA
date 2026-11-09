import { EYES, type Eye, Issues, type Parsed, readRefraction, type Refraction, refractionText } from "./eye-exam.js"

/**
 * La receta de lentes de vistIA (entrega 3 del plan): dos tipos, de anteojos y
 * de lentes de contacto, que van aparte porque un lente de contacto lleva además
 * su curva base, su diámetro y su marca, y su graduación no es la del anteojo.
 *
 * - De la óptica: sale del examen de la vista y la firma el optómetra que examinó.
 * - Externa: la que trae el cliente de su oftalmólogo. Se transcribe con quién la
 *   firmó, su fecha y su foto, y queda «Transcrita, sin verificar» hasta que la
 *   revise un optómetra. Sin verificar no impide vender: se informa.
 *
 * Una receta vencida tampoco impide vender: se avisa y la óptica decide.
 */

export const PRESCRIPTION_KINDS = [
  { key: "anteojos", label: "Anteojos" },
  { key: "contacto", label: "Lentes de contacto" },
] as const
export type PrescriptionKind = (typeof PRESCRIPTION_KINDS)[number]["key"]

export const PRESCRIPTION_SOURCES = [
  { key: "examen", label: "De la óptica" },
  { key: "externa", label: "Externa" },
] as const
export type PrescriptionSource = (typeof PRESCRIPTION_SOURCES)[number]["key"]

/** Un lente de contacto: la refracción con su curva base, su diámetro y su marca. */
export interface ContactLens extends Refraction {
  /** Curva base, en milímetros (7,0 a 10,0). */
  curvaBase?: number
  /** Diámetro, en milímetros (12,0 a 16,0). */
  diametro?: number
  marca?: string
}

export interface PrescriptionLenses {
  od?: Refraction | ContactLens
  oi?: Refraction | ContactLens
}

/**
 * Cuánto vale una receta si quien la emite no dice otra cosa: un año. Lo que dura
 * de verdad (de adulto, de niño, de lentes de contacto) se confirma con la primera
 * óptica real (pendiente del plan); la óptica cambia la fecha en cada receta.
 */
export const DEFAULT_VALID_MONTHS = 12

const BRAND_MAX = 120

function millimeters(value: unknown, min: number, max: number): number | null | "invalid" {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "invalid"
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return "invalid"
  return Math.round(value * 10) / 10
}

const PRISM_KEYS = ["prisma", "base", "prisma2", "base2"] as const

/**
 * Los lentes de una receta, validados por su tipo, con todos sus errores a la vez.
 * Al menos un ojo con algo graduado. Un lente de contacto no lleva prisma: se
 * mueve con el ojo, y el prisma se corrige con anteojos.
 */
export function parsePrescriptionLenses(kind: PrescriptionKind, input: unknown): Parsed<PrescriptionLenses> {
  const issues = new Issues()
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    issues.add("lentes", "Escribe la graduación de al menos un ojo")
    return issues.failure()
  }
  const raw = input as Record<string, unknown>
  const extra = Object.keys(raw).find((key) => key !== "od" && key !== "oi")
  if (extra) issues.add("lentes", `La receta no tiene el ojo ${extra}`)
  const out: PrescriptionLenses = {}
  for (const { key: eye, short } of EYES) {
    const value = raw[eye]
    if (value === null || value === undefined) continue
    const at = `lentes.${eye}`
    if (typeof value !== "object" || Array.isArray(value)) {
      issues.add(at, `${short}: debe ser un objeto`)
      continue
    }
    const { curvaBase, diametro, marca, ...refraction } = value as Record<string, unknown>
    if (kind === "anteojos" && (curvaBase !== undefined || diametro !== undefined || marca !== undefined))
      issues.add(at, `${short}: la curva base, el diámetro y la marca son de los lentes de contacto`)
    if (kind === "contacto") {
      const prism = PRISM_KEYS.find((key) => refraction[key] !== undefined && refraction[key] !== null && refraction[key] !== "")
      if (prism) issues.add(`${at}.${prism}`, `${short}: un lente de contacto no lleva prisma; va en la receta de anteojos`)
    }
    const lens: ContactLens = { ...readRefraction(refraction, eye, at, issues) }
    if (kind === "contacto") {
      const bc = millimeters(curvaBase, 7, 10)
      if (bc === "invalid") issues.add(`${at}.curvaBase`, `Curva base ${short}: de 7,0 a 10,0 mm`)
      else if (bc !== null) lens.curvaBase = bc
      const dia = millimeters(diametro, 12, 16)
      if (dia === "invalid") issues.add(`${at}.diametro`, `Diámetro ${short}: de 12,0 a 16,0 mm`)
      else if (dia !== null) lens.diametro = dia
      if (marca !== null && marca !== undefined && marca !== "") {
        if (typeof marca !== "string" || marca.trim().length > BRAND_MAX)
          issues.add(`${at}.marca`, `Marca ${short}: un texto de hasta ${BRAND_MAX} caracteres`)
        else if (marca.trim()) lens.marca = marca.trim()
      }
    }
    if (Object.keys(lens).length) out[eye] = lens
  }
  if (issues.any) return issues.failure()
  if (!out.od && !out.oi) {
    issues.add("lentes", "Escribe la graduación de al menos un ojo")
    return issues.failure()
  }
  return { ok: true, value: out }
}

/** La distancia al ojo con que se compensa un lente de contacto, en milímetros (la del anteojo). */
export const VERTEX_DISTANCE_MM = 12
/** Desde cuántas dioptrías cambia la graduación al pasar del anteojo al ojo (por debajo, menos de 0,25). */
export const VERTEX_FROM_DIOPTERS = 4

const quarter = (value: number) => Math.round(value * 4) / 4

/** Un meridiano del anteojo llevado a la córnea: F / (1 − d·F), en pasos de 0,25 desde ±4,00. */
function atCornea(power: number, vertexMm: number): number {
  if (Math.abs(power) < VERTEX_FROM_DIOPTERS) return power
  return quarter(power / (1 - (vertexMm / 1000) * power))
}

/**
 * La graduación del lente de contacto que propone la del anteojo: cada meridiano
 * compensado por la distancia al ojo (un −8,00 pasa a −7,25 y un +6,00 a +6,50),
 * sin prisma. Es una propuesta: el optómetra la revisa con la prueba del lente.
 */
export function contactLensFromSpectacle(refraction: Refraction, vertexMm = VERTEX_DISTANCE_MM): ContactLens {
  const out: ContactLens = {}
  const sphere = refraction.esfera ?? 0
  if (refraction.cilindro !== undefined && refraction.eje !== undefined) {
    const first = atCornea(sphere, vertexMm)
    const cylinder = quarter(atCornea(sphere + refraction.cilindro, vertexMm) - first)
    if (refraction.esfera !== undefined || first !== 0) out.esfera = first
    if (cylinder !== 0) {
      out.cilindro = cylinder
      out.eje = refraction.eje
    }
  } else if (refraction.esfera !== undefined) {
    out.esfera = atCornea(refraction.esfera, vertexMm)
  }
  if (refraction.adicion !== undefined) out.adicion = refraction.adicion
  return out
}

/**
 * La receta que propone un examen: de anteojos, su refracción tal cual; de lentes
 * de contacto, la compensada sin prisma. null si no midió ningún ojo.
 */
export function lensesFromExam(
  refraccion: Partial<Record<Eye, Refraction>> | undefined,
  kind: PrescriptionKind = "anteojos",
): PrescriptionLenses | null {
  if (!refraccion?.od && !refraccion?.oi) return null
  const out: PrescriptionLenses = {}
  for (const { key: eye } of EYES) {
    const refraction = refraccion[eye]
    if (!refraction) continue
    const lens = kind === "contacto" ? contactLensFromSpectacle(refraction) : { ...refraction }
    if (Object.keys(lens).length) out[eye] = lens
  }
  return out.od || out.oi ? out : null
}

/** Un ojo de la receta en una línea, con lo del lente de contacto. */
export function lensText(lens: Refraction | ContactLens | undefined): string {
  if (!lens) return ""
  const contact = lens as ContactLens
  const extra = [
    contact.curvaBase !== undefined ? `CB ${String(contact.curvaBase).replace(".", ",")}` : "",
    contact.diametro !== undefined ? `Ø ${String(contact.diametro).replace(".", ",")}` : "",
    contact.marca ?? "",
  ].filter(Boolean)
  return [refractionText(lens), ...extra].filter(Boolean).join(" · ")
}

/** La fecha hasta la que vale una receta emitida `issuedOn` (AAAA-MM-DD), por defecto en un año. */
export function defaultValidUntil(issuedOn: string, months = DEFAULT_VALID_MONTHS): string {
  const [year, month, day] = issuedOn.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(year, month - 1 + months, day))
  // El 29 de febrero de un año que no lo tiene pasa al último día del mes.
  if (date.getUTCDate() !== day) date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}

/** El estado de una receta para quien la usa: vigente, vencida o sin verificar (se informa; no impide vender). */
export function prescriptionNotices(
  prescription: { source: PrescriptionSource; verifiedAt: string | null; validUntil: string },
  today: string,
): string[] {
  const notices: string[] = []
  if (prescription.validUntil < today) notices.push(`Venció el ${formatDay(prescription.validUntil)}: conviene un examen nuevo.`)
  if (prescription.source === "externa" && !prescription.verifiedAt)
    notices.push("Transcrita, sin verificar: un optómetra todavía no la revisó.")
  return notices
}

/** «12/03/2026». */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-")
  return `${day}/${month}/${year}`
}
