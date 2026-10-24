import type { DiagnosisSystemKey } from "@odentia/clinical"

/**
 * Los capítulos de la atención primaria, para mostrarlos primero en el
 * buscador de latidIA (issue 229, entrega 8): con «dolor» o «infección» sale
 * antes lo que se ve en un consultorio que una causa externa, una
 * malformación, una afección perinatal o un tumor, que siguen a un paso.
 *
 * - CIE-10: infecciosas (A–B), anemias y de la sangre (D50–D89), endocrinas
 *   (E), mentales (F), del sistema nervioso (G), del ojo y del oído (H),
 *   circulatorias (I), respiratorias (J), digestivas (K), de la piel (L),
 *   osteomusculares (M), genitourinarias (N), embarazo (O), síntomas (R) y
 *   factores que influyen en la salud (Z). Quedan después tumores (C–D48),
 *   perinatales (P), malformaciones (Q), traumatismos (S–T), causas externas
 *   (V–Y) y U.
 * - CIE-11, los mismos capítulos: 01 (1A–1H), 03 (3A–3C), 05 (5A–5D), 06
 *   (6A–6E), 08 (8A–8E), 09 (9A–9E), 10 (AA–AC), 11 (BA–BE), 12 (CA–CB), 13
 *   (DA–DE), 14 (EA–EM), 15 (FA–FC), 16 (GA–GC), 18 (JA–JB), 21 (MA–MH) y 24
 *   (QA–QF).
 */
const PRIMARY_CARE_ICD10 = "^([ABEFGHIJKLMNORZ]|D[5-8])"
const PRIMARY_CARE_ICD11 =
  "^(1[A-H]|3[A-C]|5[A-D]|6[A-E]|8[A-E]|9[A-E]|A[A-C]|B[A-E]|C[AB]|D[A-E]|E[A-M]|F[A-C]|G[A-C]|J[AB]|M[A-H]|Q[A-F])"

/** Una expresión regular de PostgreSQL: lo de atención primaria primero. */
export function medicalDiagnosisPattern(system: DiagnosisSystemKey): string {
  return system === "ICD-11" ? PRIMARY_CARE_ICD11 : PRIMARY_CARE_ICD10
}
