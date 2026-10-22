import type { DiagnosisSystemKey } from "@odentia/clinical"

/**
 * Lo odontológico de cada lista, para mostrarlo primero en el buscador. En la
 * CIE-10: el capítulo de la cavidad bucal, glándulas salivales y maxilares
 * (K00–K14), fracturas y luxaciones de dientes y maxilares (S02.5, S02.6,
 * S03.0, S03.2), heridas del labio y la boca (S01.5), fisuras labiopalatinas
 * (Q35–Q37), herpes y candidiasis de la boca (B00.2, B37.0), tumores del labio
 * y la boca (C00–C06, D10.0–D10.3) y los Z de examen y prótesis dental (Z01.2,
 * Z46.3, Z97.2). En la CIE-11, lo mismo con sus códigos: las afecciones del
 * complejo bucofacial (DA00–DA0F), las anomalías del desarrollo de los dientes
 * y la boca (LA30, LA31), las fisuras labiopalatinas (LA40–LA42), las lesiones
 * de los dientes (NA0D), la fractura de la mandíbula (NA02.7), la
 * gingivoestomatitis herpética (1F00.02), la candidiasis bucal (1F23.0), los
 * tumores malignos del labio y la boca (2B60–2B66) y el examen, la prótesis y
 * la ortodoncia (QA00.8, QB31.2, QB31.3, QB51.A, QB93).
 */
const DENTAL_ICD10: readonly RegExp[] = [
  /^K(0\d|1[0-4])(\.|$)/,
  /^S02\.[56]/,
  /^S03\.[02]/,
  /^S01\.5/,
  /^Q3[5-7](\.|$)/,
  /^B00\.2/,
  /^B37\.0/,
  /^C0[0-6](\.|$)/,
  /^D10\.[0-3]/,
  /^Z01\.2/,
  /^Z46\.3/,
  /^Z97\.2/,
]
const DENTAL_ICD11: readonly RegExp[] = [
  /^DA0/,
  /^LA3[01](\.|$)/,
  /^LA4[0-2](\.|$)/,
  /^NA0D/,
  /^NA02\.7/,
  /^1F00\.02/,
  /^1F23\.0/,
  /^2B6[0-6](\.|$)/,
  /^QA00\.8/,
  /^QB31\.[23]/,
  /^QB51\.A/,
  /^QB93(\.|$)/,
]

export function isDentalDiagnosis(system: DiagnosisSystemKey, code: string): boolean {
  const rules = system === "ICD-11" ? DENTAL_ICD11 : DENTAL_ICD10
  return rules.some((rule) => rule.test(code))
}

/**
 * Lo mismo como una expresión regular de PostgreSQL, para ordenar el buscador
 * de diagnósticos en la base: lo odontológico primero.
 */
export function dentalDiagnosisPattern(system: DiagnosisSystemKey): string {
  return (system === "ICD-11" ? DENTAL_ICD11 : DENTAL_ICD10)
    .map((rule) => `(?:${rule.source})`)
    .join("|")
}
