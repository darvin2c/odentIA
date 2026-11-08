import type { DiagnosisSystemKey } from "@odentia/clinical"

/**
 * Lo del ojo primero en el buscador de diagnósticos de vistIA: con «miopía» o
 * «conjuntivitis» sale antes lo que se ve en una óptica. Lo demás sigue a un paso.
 *
 * - CIE-10: enfermedades del ojo y sus anexos (H00–H59), que incluye los
 *   trastornos de la refracción y la acomodación (H52) y la baja visión (H54).
 * - CIE-11: el capítulo 09, enfermedades del sistema visual (9A–9E).
 */
const EYE_ICD10 = "^H[0-5]"
const EYE_ICD11 = "^9[A-E]"

/** Una expresión regular de PostgreSQL: lo del ojo primero. */
export function opticalDiagnosisPattern(system: DiagnosisSystemKey): string {
  return system === "ICD-11" ? EYE_ICD11 : EYE_ICD10
}
