import { answeredOf, COMMON_INTERVIEW, type ProductInterview } from "../product-hooks.js"

/**
 * La entrevista de odentIA: lo común y sus antecedentes odontológicos. Lo que
 * se declaró de la boca en el registro («Tu boca») entra con sus mismas claves.
 */
export const dentalInterview: ProductInterview = {
  check: (answers) => answers,
  declared(health, today) {
    const dental = answeredOf(health.dental)
    return {
      ...COMMON_INTERVIEW.declared(health, today),
      ...(Object.keys(dental).length ? { antecedentesOdontologicos: dental } : {}),
    }
  },
}
