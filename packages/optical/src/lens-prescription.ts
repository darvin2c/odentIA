import { EYES, type Eye, parseRefraction, type Refraction, refractionText } from "./eye-exam.js"

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

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; path: string }
const fail = (error: string, path: string): { ok: false; error: string; path: string } => ({ ok: false, error, path })

function millimeters(value: unknown, min: number, max: number): number | null | "invalid" {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return "invalid"
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return "invalid"
  return Math.round(value * 10) / 10
}

/** Los lentes de una receta, validados por su tipo. Al menos un ojo con algo graduado. */
export function parsePrescriptionLenses(kind: PrescriptionKind, input: unknown): Parsed<PrescriptionLenses> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return fail("Escribe la graduación de al menos un ojo", "lentes")
  const raw = input as Record<string, unknown>
  const extra = Object.keys(raw).find((key) => key !== "od" && key !== "oi")
  if (extra) return fail(`La receta no tiene el ojo ${extra}`, "lentes")
  const out: PrescriptionLenses = {}
  for (const { key: eye, short } of EYES) {
    const value = raw[eye]
    if (value === null || value === undefined) continue
    if (typeof value !== "object" || Array.isArray(value)) return fail(`${short}: debe ser un objeto`, `lentes.${eye}`)
    const { curvaBase, diametro, marca, ...refraction } = value as Record<string, unknown>
    if (kind === "anteojos" && (curvaBase !== undefined || diametro !== undefined || marca !== undefined))
      return fail(`${short}: la curva base, el diámetro y la marca son de los lentes de contacto`, `lentes.${eye}`)
    const parsed = parseRefraction(refraction, eye, `lentes.${eye}`)
    if (!parsed.ok) return parsed
    const lens: ContactLens = { ...parsed.value }
    if (kind === "contacto") {
      const bc = millimeters(curvaBase, 7, 10)
      if (bc === "invalid") return fail(`Curva base ${short}: de 7,0 a 10,0 mm`, `lentes.${eye}.curvaBase`)
      if (bc !== null) lens.curvaBase = bc
      const dia = millimeters(diametro, 12, 16)
      if (dia === "invalid") return fail(`Diámetro ${short}: de 12,0 a 16,0 mm`, `lentes.${eye}.diametro`)
      if (dia !== null) lens.diametro = dia
      if (marca !== null && marca !== undefined && marca !== "") {
        if (typeof marca !== "string" || marca.trim().length > BRAND_MAX)
          return fail(`Marca ${short}: un texto de hasta ${BRAND_MAX} caracteres`, `lentes.${eye}.marca`)
        if (marca.trim()) lens.marca = marca.trim()
      }
    }
    if (Object.keys(lens).length) out[eye] = lens
  }
  if (!out.od && !out.oi) return fail("Escribe la graduación de al menos un ojo", "lentes")
  return { ok: true, value: out }
}

/** La receta de anteojos que propone un examen: su refracción tal cual; null si no midió ningún ojo. */
export function lensesFromExam(refraccion: Partial<Record<Eye, Refraction>> | undefined): PrescriptionLenses | null {
  if (!refraccion?.od && !refraccion?.oi) return null
  return { ...(refraccion.od ? { od: { ...refraccion.od } } : {}), ...(refraccion.oi ? { oi: { ...refraccion.oi } } : {}) }
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
