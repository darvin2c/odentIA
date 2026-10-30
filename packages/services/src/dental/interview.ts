import { dentalInterviewErrors } from "@odentia/dental"
import { fieldsError } from "../errors.js"
import { answeredOf, COMMON_INTERVIEW, type ProductInterview } from "../product-hooks.js"

/**
 * La entrevista de odentIA: lo común y sus antecedentes odontológicos. Lo que
 * se declaró de la boca en el registro («Tu boca») entra con sus mismas claves.
 */
export const dentalInterview: ProductInterview = {
  check(answers) {
    // Cada error a su dato, con el nombre que tiene en el cuerpo (`anamnesis.answers.…`).
    const error = fieldsError(dentalInterviewErrors(answers), (key) => `anamnesis.answers.${key}`)
    if (error) throw error
    return answers
  },
  declared(health, today) {
    const dental = answeredOf(health.dental)
    return {
      ...COMMON_INTERVIEW.declared(health, today),
      ...(Object.keys(dental).length ? { antecedentesOdontologicos: dental } : {}),
    }
  },
}
