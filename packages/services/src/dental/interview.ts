import { declaredLactationAndTobacco } from "@odentia/clinical"
import { childhoodLines, dentalHabitsErrors, dentalInterviewErrors } from "@odentia/dental"
import { fieldsError } from "../errors.js"
import { answeredOf, COMMON_INTERVIEW, type ProductInterview } from "../product-hooks.js"

/**
 * La entrevista de odentIA: lo común (con el embarazo y su fecha) y sus
 * antecedentes odontológicos. Lo que se declaró de la boca en el registro
 * («Tu boca») entra con sus mismas claves.
 */
export const dentalInterview: ProductInterview = {
  check(answers, today) {
    // Cada error a su dato, con el nombre que tiene en el cuerpo (`anamnesis.answers.…`).
    const error = fieldsError({ ...dentalInterviewErrors(answers), ...dentalHabitsErrors(answers) }, (key) => `anamnesis.answers.${key}`)
    if (error) throw error
    return COMMON_INTERVIEW.check(answers, today)
  },
  declared(health, today) {
    // El corazón y la anestesia van con lo de su boca; la lactancia y el tabaco, con la forma de
    // latidIA (`declaredLactationAndTobacco`), junto al embarazo que arma lo común.
    const dental = answeredOf(health.dental)
    const common = COMMON_INTERVIEW.declared(health, today)
    const { embarazoLactancia, habitos } = declaredLactationAndTobacco(health.medical, today)
    const pregnancy = { ...((common.embarazoLactancia as Record<string, unknown> | undefined) ?? {}), ...embarazoLactancia }
    return {
      ...common,
      ...(Object.keys(pregnancy).length ? { embarazoLactancia: pregnancy } : {}),
      ...(habitos ? { habitos } : {}),
      ...(Object.keys(dental).length ? { antecedentesOdontologicos: dental } : {}),
    }
  },
  // Lo que contó quien cuida a un niño, «de pequeño», se lee sin clics en la atención (mesa del 13 nov, entrega 7).
  declaredLines: (health) => childhoodLines(health.dental),
}
