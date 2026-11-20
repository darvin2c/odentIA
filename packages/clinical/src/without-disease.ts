/**
 * «Sin enfermedad»: la visita en la que no hay enfermedad también lleva su diagnóstico, con un
 * código del capítulo de los factores que motivan el contacto con los servicios de salud (CIE-10
 * capítulo XXI, Z00–Z99; CIE-11 capítulo 24, QA–QF). La doctora no inventa una enfermedad para
 * poder firmar: elige el chequeo, la consulta sin hallazgos o el control con un toque (mesa del
 * cierre de la atención, 19 nov 2026). Cada atajo sale solo si la lista de la clínica trae su
 * código, y lo registrado con uno de ellos no queda como problema activo de la persona.
 */
import type { DiagnosisSystemKey } from "./diagnoses.js"

/**
 * Cuándo sale un atajo: siempre, si ya tuvo un tratamiento (o la visita cumple un control),
 * o si tiene un tratamiento de prótesis o de ortodoncia.
 */
export type WithoutDiseaseWhen = "siempre" | "tratado" | "protesis" | "ortodoncia"

export interface WithoutDiseaseRule {
  key: string
  /** Lo que dice el botón: corto, en las palabras de quien atiende. */
  label: string
  /** El código en cada lista; la CIE-10 del MINSA y la de la OMS comparten los del capítulo XXI. */
  codes: Partial<Record<DiagnosisSystemKey, string>>
  when: WithoutDiseaseWhen
  /** Solo para adultos (18 o más) o solo para menores; sin él, a cualquier edad. */
  ages?: "adulto" | "menor"
}

const icd10 = (code: string): Partial<Record<DiagnosisSystemKey, string>> => ({
  "ICD-10": code,
  "ICD-10-PE": code,
  "ICD-10-ES": code,
})

/** «Sin hallazgos»: consultó y no se encontró nada (Z71.1; en CIE-11, QA1C, su par). */
const NOTHING_FOUND: WithoutDiseaseRule = {
  key: "sin-hallazgos",
  label: "Sin hallazgos",
  codes: { ...icd10("Z71.1"), "ICD-11": "QA1C" },
  when: "siempre",
}

/** El control después de un tratamiento (Z09.8; en CIE-11, QA07.Y). */
const AFTER_TREATMENT: WithoutDiseaseRule = {
  key: "control",
  label: "Control después de un tratamiento",
  codes: { ...icd10("Z09.8"), "ICD-11": "QA07.Y" },
  when: "tratado",
}

/** odentIA: el chequeo, sin hallazgos, el control, la prótesis y la ortodoncia. */
export const DENTAL_WITHOUT_DISEASE: readonly WithoutDiseaseRule[] = [
  { key: "chequeo", label: "Chequeo", codes: { ...icd10("Z01.2"), "ICD-11": "QA00.8" }, when: "siempre" },
  NOTHING_FOUND,
  AFTER_TREATMENT,
  { key: "protesis", label: "Ajuste de prótesis", codes: { ...icd10("Z46.3"), "ICD-11": "QB31.3" }, when: "protesis" },
  { key: "ortodoncia", label: "Control de ortodoncia", codes: { ...icd10("Z46.4"), "ICD-11": "QB31.2" }, when: "ortodoncia" },
]

/** latidIA: el examen general del adulto o el control del niño, sin hallazgos y el control. */
export const MEDICAL_WITHOUT_DISEASE: readonly WithoutDiseaseRule[] = [
  {
    key: "chequeo",
    label: "Examen médico general",
    codes: { ...icd10("Z00.0"), "ICD-11": "QA00.0" },
    when: "siempre",
    ages: "adulto",
  },
  {
    key: "chequeo-nino",
    label: "Control de salud del niño",
    codes: { ...icd10("Z00.1"), "ICD-11": "QA00.1" },
    when: "siempre",
    ages: "menor",
  },
  NOTHING_FOUND,
  AFTER_TREATMENT,
]

export interface WithoutDiseaseContext {
  system: DiagnosisSystemKey
  /** Años cumplidos el día de la visita; sin fecha de nacimiento, null (sale el de adultos). */
  ageYears: number | null
  /** Ya tuvo un tratamiento realizado, o la visita cumple un control. */
  treated: boolean
  protesis: boolean
  ortodoncia: boolean
}

/** Los atajos que le corresponden a esta visita, con el código de la lista de la clínica. */
export function withoutDiseaseOptions(
  rules: readonly WithoutDiseaseRule[],
  context: WithoutDiseaseContext,
): Array<{ key: string; label: string; code: string }> {
  const minor = context.ageYears !== null && context.ageYears < 18
  return rules.flatMap((rule) => {
    const code = rule.codes[context.system]
    if (!code) return []
    if (rule.ages === "adulto" && minor) return []
    if (rule.ages === "menor" && !minor) return []
    if (rule.when === "tratado" && !context.treated) return []
    if (rule.when === "protesis" && !context.protesis) return []
    if (rule.when === "ortodoncia" && !context.ortodoncia) return []
    return [{ key: rule.key, label: rule.label, code }]
  })
}

/** ¿Es uno de los códigos de «Sin enfermedad» en esa lista? Lo registrado con él no queda activo. */
export function isWithoutDiseaseCode(
  rules: readonly WithoutDiseaseRule[],
  system: string,
  code: string,
): boolean {
  return rules.some((rule) => rule.codes[system as DiagnosisSystemKey] === code)
}
