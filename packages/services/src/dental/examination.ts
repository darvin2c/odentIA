import { validation } from "../errors.js"
import type { ProductExamination } from "../product-hooks.js"

const EXAMINATION_EXTRAORAL = ["atm", "ganglios", "labios"] as const
const EXAMINATION_INTRAORAL = [
  "encias",
  "lengua",
  "paladar",
  "pisoBoca",
  "carrillos",
  "orofaringe",
] as const
const EXAMINATION_HYGIENE = ["buena", "regular", "mala"] as const

/** Examen clínico con la estructura del examenClinico de anamnesis; vacíos se recortan, grupos vacíos se omiten. */
function assertExamination(input: unknown): Record<string, unknown> | null {
  if (input === null || input === undefined) return null
  if (typeof input !== "object" || Array.isArray(input))
    throw validation("examination debe ser un objeto")
  const given = input as Record<string, unknown>
  const unknownKey = Object.keys(given).find(
    (key) => !["extraoral", "intraoral", "higieneOral"].includes(key),
  )
  if (unknownKey) throw validation(`examination.${unknownKey} no es un campo válido`)
  const out: Record<string, unknown> = {}
  for (const [group, allowed] of [
    ["extraoral", EXAMINATION_EXTRAORAL],
    ["intraoral", EXAMINATION_INTRAORAL],
  ] as const) {
    const value = given[group]
    if (value === undefined || value === null) continue
    if (typeof value !== "object" || Array.isArray(value))
      throw validation(`examination.${group} debe ser un objeto`)
    const cleaned: Record<string, string> = {}
    for (const [key, raw] of Object.entries(value)) {
      if (!(allowed as readonly string[]).includes(key))
        throw validation(`examination.${group}.${key} no es un campo válido`)
      if (typeof raw !== "string") throw validation(`examination.${group}.${key} debe ser texto`)
      const trimmed = raw.trim()
      if (trimmed) {
        if (trimmed.length > 500)
          throw validation(`examination.${group}.${key} debe tener hasta 500 caracteres`)
        cleaned[key] = trimmed
      }
    }
    if (Object.keys(cleaned).length > 0) out[group] = cleaned
  }
  const hygiene = given.higieneOral
  if (hygiene !== undefined && hygiene !== null) {
    if (!(EXAMINATION_HYGIENE as readonly unknown[]).includes(hygiene)) {
      throw validation("examination.higieneOral debe ser buena, regular o mala")
    }
    out.higieneOral = hygiene
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * El examen de la boca de odentIA (extraoral, intraoral e higiene oral), que
 * hasta el issue 229 era el de toda atención. La copia de la historia y su
 * exportación aún no lo llevan, como antes.
 */
export const dentalExamination: ProductExamination = {
  parse: assertExamination,
  recordLines: () => [],
  observations: () => [],
}
