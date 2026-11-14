import { declaredPregnancy } from "@odentia/clinical"
import { parseMedicalHistory } from "@odentia/medical"
import { invalidField, validation } from "../errors.js"
import { answeredOf, type ProductInterview } from "../product-hooks.js"

/**
 * La entrevista de latidIA (issue 229, decisión 13): lo común más embarazo y
 * lactancia con su fecha, gineco-obstétricos, hábitos y vacunas.
 */
export const medicalInterview: ProductInterview = {
  check(answers, today) {
    const parsed = parseMedicalHistory(answers, today)
    // El error va a su dato, con el nombre que tiene en el cuerpo (`anamnesis.answers.habitos.cigarrillosDia`).
    if (!parsed.ok)
      throw parsed.field ? invalidField(`anamnesis.answers.${parsed.field}`, parsed.error) : validation(parsed.error)
    return parsed.value
  },
  declared(health, today) {
    // El embarazo del registro va con la fecha en que se dijo, para que la receta sepa si sigue vigente
    // (la forma común, `declaredPregnancy`).
    const { statement, rest: personal } = declaredPregnancy(answeredOf(health.personal), today)
    const medical = health.medical ?? {}
    const pregnancy = {
      ...(statement ? { embarazo: statement } : {}),
      ...(typeof medical.lactancia === "boolean"
        ? { lactancia: { estado: medical.lactancia ? "si" : "no", fecha: today } }
        : {}),
    }
    const habits = answeredOf({ tabaco: medical.tabaco, alcohol: medical.alcohol })
    return {
      ...(Object.keys(personal).length ? { antecedentesPersonales: personal } : {}),
      ...(Object.keys(pregnancy).length ? { embarazoLactancia: pregnancy } : {}),
      ...(Object.keys(habits).length ? { habitos: habits } : {}),
    }
  },
}
