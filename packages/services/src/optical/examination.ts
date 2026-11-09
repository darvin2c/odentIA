import {
  ACUITY_FIELDS,
  EYES,
  eyeExamLines,
  HEALTH_PARTS,
  HEALTH_STATE_LABELS,
  parseEyeExam,
  readEyeExam,
  refractionText,
} from "@odentia/optical"
import { invalidField } from "../errors.js"
import type { ExamObservation, ProductExamination } from "../product-hooks.js"

/**
 * El examen de la vista de vistIA (entrega 3 del plan): lo valida
 * `parseEyeExam` y cada error va junto a su dato («examination.refraccion.od.eje»).
 * En la copia de la historia, una línea por parte; en FHIR, una observación por
 * dato medido de cada ojo, sin inventar lo que no se midió.
 */
export const opticalExamination: ProductExamination = {
  parse(input) {
    const parsed = parseEyeExam(input)
    if (!parsed.ok) throw invalidField(parsed.path ? `examination.${parsed.path}` : "examination", parsed.error)
    return parsed.value ? { ...parsed.value } : null
  },
  recordLines: (value) => eyeExamLines(readEyeExam(value)),
  observations(value) {
    const exam = readEyeExam(value)
    if (!exam) return []
    const out: ExamObservation[] = []
    for (const { key: eye, short } of EYES) {
      for (const field of ACUITY_FIELDS) {
        const reading = exam.agudeza?.[eye]?.[field.key]
        if (reading) out.push({ key: `agudeza-${eye}-${field.key}`, text: `Agudeza visual ${short}, ${field.label.toLowerCase()}`, value: reading, interpretation: null })
      }
      const refraction = refractionText(exam.refraccion?.[eye])
      if (refraction) out.push({ key: `refraccion-${eye}`, text: `Refracción ${short}`, value: refraction, interpretation: null })
      const pressure = exam.salud?.presion?.[eye]
      if (pressure !== undefined) out.push({ key: `presion-${eye}`, text: `Presión intraocular ${short}`, value: `${pressure} mmHg`, interpretation: null })
    }
    for (const { key, label } of HEALTH_PARTS) {
      const entry = exam.salud?.[key]
      if (!entry) continue
      out.push({
        key: `salud-${key}`,
        text: label,
        value: entry.estado === "no_realizado" ? null : (entry.nota ?? HEALTH_STATE_LABELS[entry.estado]),
        interpretation: entry.estado === "sin_alteraciones" ? "N" : entry.estado === "con_hallazgos" ? "A" : null,
      })
    }
    return out
  },
}
