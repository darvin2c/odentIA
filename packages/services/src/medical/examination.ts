import {
  EXAM_STATE_LABELS,
  examLines,
  examReadings,
  parseSystemsExam,
  readSystemsExam,
} from "@odentia/medical"
import { validation } from "../errors.js"
import type { ProductExamination } from "../product-hooks.js"

/**
 * El examen por sistemas de latidIA (issue 229, decisión 5): lo no marcado
 * queda «No examinado» en la copia de la historia y, en FHIR, sin valor y con
 * `not-performed`.
 */
export const medicalExamination: ProductExamination = {
  parse(input) {
    const parsed = parseSystemsExam(input)
    if (!parsed.ok) throw validation(parsed.error)
    return parsed.value ? { ...parsed.value } : null
  },
  recordLines: (value) => examLines(readSystemsExam(value)),
  observations(value) {
    const exam = readSystemsExam(value)
    // Una atención sin examen no exporta diez sistemas sin examinar.
    if (!exam) return []
    return examReadings(exam).map((reading) => ({
      key: reading.key,
      text: reading.label,
      value:
        reading.state === "no_examinado"
          ? null
          : (reading.finding ?? EXAM_STATE_LABELS[reading.state]),
      interpretation:
        reading.state === "sin_alteraciones" ? "N" : reading.state === "con_hallazgos" ? "A" : null,
    }))
  },
}
