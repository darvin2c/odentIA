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

/**
 * Los diagnósticos de dolor, infección aguda o trauma: lo que se indica por
 * uno de ellos se propone en la fase «Urgencia» (`phaseForTreatment`). Con
 * sus subcódigos. En la CIE-10 de la OMS y del MINSA: K04.0 pulpitis, K04.4
 * periodontitis apical aguda originada en la pulpa, K04.7 absceso periapical
 * sin fístula, K05.2 periodontitis aguda (absceso periodontal, pericoronaritis
 * aguda), K10.2 afecciones inflamatorias de los maxilares, K10.3 alveolitis,
 * K12.2 celulitis y absceso de boca, S02.5 fractura de diente y S03.2
 * luxación de diente (con la avulsión). No lo son por sí solos la necrosis
 * (K04.1), la periodontitis apical crónica (K04.5), el absceso con fístula
 * (K04.6, crónico), el quiste (K04.8), la caries ni la raíz retenida (K08.3).
 * Fuentes: AAE, Consensus Conference Recommended Diagnostic Terminology,
 * J Endod 2009;35:1634 (pulpa y periápice, sintomático o no); SDCEP,
 * Management of Acute Dental Problems, 2013 (infección que se disemina y
 * trauma); IADT 2020 (trauma).
 */
const URGENT_ICD10_SHARED: readonly RegExp[] = [
  /^K04\.[047]/,
  /^K10\.[23]/,
  /^K12\.2/,
  /^S02\.5/,
  /^S03\.2/,
]
const URGENT_ICD10: readonly RegExp[] = [...URGENT_ICD10_SHARED, /^K05\.2/]
/**
 * Lo mismo en la CIE-11 MMS, leído en su archivo oficial (2026-01, el de
 * `@odentia/db`) y no convertido desde la CIE-10 (ADR 0041): DA09.0 pulpitis,
 * DA09.70 periodontitis apical aguda originada en la pulpa, DA09.60 y DA09.62
 * absceso periapical con afectación facial y sin fístula (no DA09.61, con
 * fístula), DA0C.0 periodontitis aguda, DA0C.4 absceso del periodonto, DA0B.6
 * pericoronitis (la CIE-11 no la separa en aguda y crónica), DA06.0
 * afecciones inflamatorias y DA06.1 alveolitis de los maxilares, DA01.30
 * celulitis o absceso de los tejidos blandos de la boca y NA0D lesión de
 * dientes o estructuras de soporte (fracturas, luxaciones y avulsión).
 */
const URGENT_ICD11: readonly RegExp[] = [
  /^DA09\.(0|70|60|62)$/,
  /^DA0C\.[04]$/,
  /^DA0B\.6$/,
  /^DA06\.[01]$/,
  /^DA01\.30$/,
  /^NA0D(\.|$)/,
]
/**
 * La CIE-10-ES (preparada, sin cargar) sigue a la CIE-10-CM, donde K05.2 es la
 * periodontitis agresiva y no la aguda: ahí K05.2 no propone urgencia.
 */
const URGENT_ICD10_ES: readonly RegExp[] = URGENT_ICD10_SHARED

export function isUrgentDiagnosis(system: string | null | undefined, code: string | null | undefined): boolean {
  if (!code) return false
  const value = code.trim().toUpperCase()
  const rules = system === "ICD-11" ? URGENT_ICD11 : system === "ICD-10-ES" ? URGENT_ICD10_ES : URGENT_ICD10
  return rules.some((rule) => rule.test(value))
}
