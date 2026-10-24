/**
 * El catálogo de latidIA (issue 229, entrega 8): los tipos de servicio de su
 * biblioteca y las especialidades con que nace un consultorio. Como en
 * odentIA (ADR 0069), los tipos son de uso interno: ordenan la biblioteca,
 * guardan las palabras de la calle del agente y dicen qué especialidad recibe
 * cada servicio; la clínica ve y edita la especialidad, nunca el tipo.
 */

export const MEDICAL_SERVICE_KINDS = [
  { key: "general", name: "Medicina general" },
  { key: "familiar", name: "Medicina familiar" },
  { key: "interna", name: "Medicina interna" },
  { key: "pediatria", name: "Pediatría" },
  { key: "ginecologia", name: "Ginecología y obstetricia" },
  { key: "prevencion", name: "Prevención" },
  { key: "procedimiento", name: "Procedimientos" },
  { key: "diagnostico", name: "Pruebas y ecografías" },
] as const
export type MedicalServiceKind = (typeof MEDICAL_SERVICE_KINDS)[number]["key"]
/** Las claves de los tipos, en su orden. */
export const MEDICAL_SERVICE_KIND_KEYS: readonly MedicalServiceKind[] = MEDICAL_SERVICE_KINDS.map(
  (item) => item.key,
)

/** Cómo pide la gente cada tipo: así «me falta el aire» encuentra la nebulización. */
export const MEDICAL_KIND_WORDS: Record<MedicalServiceKind, string> = {
  general: "consulta, médico, chequeo, fiebre, dolor, malestar",
  familiar: "médico de familia, control de toda la familia, planificación familiar",
  interna: "presión alta, diabetes, colesterol, enfermedades crónicas",
  pediatria: "niños, bebés, control del niño, pediatra",
  ginecologia: "ginecólogo, embarazo, control prenatal, Papanicolaou, anticonceptivos",
  prevencion: "vacuna, chequeo preventivo, examen anual",
  procedimiento: "inyección, nebulización, sutura, curación, uña encarnada",
  diagnostico: "electrocardiograma, ecografía, análisis, glucosa",
}

/**
 * Una especialidad con que nace el consultorio. `receives` son los tipos de
 * la biblioteca que la usan (cada tipo va a una sola); `kind` es el que toma
 * un servicio propio de esta especialidad.
 */
export interface MedicalSpecialty {
  key: string
  name: string
  kind: MedicalServiceKind
  receives: readonly MedicalServiceKind[]
}

/**
 * Las cinco con que nace todo consultorio (decisión 3 del issue 229), con
 * los nombres más comunes en la región. Medicina general no es una
 * especialidad, pero es la atención de casi todo consultorio: recibe además
 * los procedimientos y las pruebas. No sale de la norma de un país: es la
 * lista general de latidIA.
 */
export const MEDICAL_SPECIALTIES: readonly MedicalSpecialty[] = [
  {
    key: "medicina_general",
    name: "Medicina general",
    kind: "general",
    receives: ["general", "procedimiento", "diagnostico"],
  },
  {
    key: "medicina_familiar",
    name: "Medicina familiar",
    kind: "familiar",
    receives: ["familiar", "prevencion"],
  },
  { key: "medicina_interna", name: "Medicina interna", kind: "interna", receives: ["interna"] },
  { key: "pediatria", name: "Pediatría", kind: "pediatria", receives: ["pediatria"] },
  {
    key: "ginecologia_obstetricia",
    name: "Ginecología y obstetricia",
    kind: "ginecologia",
    receives: ["ginecologia"],
  },
]

/** La única fase del plan de latidIA: lo indicado se hace en el orden en que se indica. */
export const MEDICAL_PLAN_PHASE = "general"
