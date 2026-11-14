/**
 * «Odontológicos y hábitos» de la entrevista de salud de odentIA
 * (`antecedentesOdontologicos`). Lo mismo dice la pantalla antes de guardar y
 * el servidor al recibirlo: cada error con la ruta de su dato en la entrevista.
 */

import { CIGARETTE_BANDS, INTERVIEW_ANSWERS, TOBACCO_ANSWERS } from "@odentia/clinical"

/** Cuántos hábitos se registran como mucho. */
export const DENTAL_HABITS_MAX = 10
/** Cepillados al día: de 0 a este número. */
export const DENTAL_BRUSHINGS_MAX = 10

/**
 * Los datos de la boca que no pasan, por su ruta en la entrevista
 * («antecedentesOdontologicos.cepilladosAlDia») → qué corregir. Vacío si todo
 * está bien o no se respondió.
 */
export function dentalInterviewErrors(answers: Record<string, unknown>): Record<string, string> {
  const group = answers.antecedentesOdontologicos
  if (!group || typeof group !== "object" || Array.isArray(group)) return {}
  const errors: Record<string, string> = {}
  const { cepilladosAlDia, habitos } = group as Record<string, unknown>
  if (
    cepilladosAlDia !== undefined &&
    cepilladosAlDia !== null &&
    (typeof cepilladosAlDia !== "number" ||
      !Number.isInteger(cepilladosAlDia) ||
      cepilladosAlDia < 0 ||
      cepilladosAlDia > DENTAL_BRUSHINGS_MAX)
  ) {
    errors["antecedentesOdontologicos.cepilladosAlDia"] =
      `Cepillados al día: escribe un número entero de 0 a ${DENTAL_BRUSHINGS_MAX}.`
  }
  if (Array.isArray(habitos) && habitos.length > DENTAL_HABITS_MAX) {
    errors["antecedentesOdontologicos.habitos"] =
      `Hábitos: escribe como mucho ${DENTAL_HABITS_MAX}, separados por coma.`
  }
  const { corazon, problemaAnestesia } = group as Record<string, unknown>
  const isAnswer = (value: unknown) => value === undefined || (INTERVIEW_ANSWERS as readonly unknown[]).includes(value)
  if (corazon !== undefined) {
    const heart = corazon && typeof corazon === "object" ? (corazon as Record<string, unknown>) : null
    if (!heart || !isAnswer(heart.riesgoEndocarditis) || !isAnswer(heart.antibioticoPrevio))
      errors["antecedentesOdontologicos.corazon"] = "Corazón: elige Sí, No o No sabe."
  }
  if (!isAnswer(problemaAnestesia))
    errors["antecedentesOdontologicos.problemaAnestesia"] = "Problemas con la anestesia: elige Sí, No o No sabe."
  return errors
}

/**
 * Los hábitos de odentIA en la entrevista (`habitos`, la forma de latidIA): si
 * fuma y, de quien fuma, cuánto. Lo demás de ese grupo no es de odentIA.
 */
export function dentalHabitsErrors(answers: Record<string, unknown>): Record<string, string> {
  const group = answers.habitos
  if (group === undefined) return {}
  if (!group || typeof group !== "object" || Array.isArray(group)) return { habitos: "Hábitos: revisa lo escrito." }
  const { tabaco, cigarrillos, ...rest } = group as Record<string, unknown>
  const errors: Record<string, string> = {}
  if (tabaco !== undefined && !(TOBACCO_ANSWERS as readonly unknown[]).includes(tabaco))
    errors["habitos.tabaco"] = "Tabaco: elige una opción."
  if (cigarrillos !== undefined && (tabaco !== "fuma" || !(CIGARETTE_BANDS as readonly unknown[]).includes(cigarrillos)))
    errors["habitos.cigarrillos"] = "Cuántos al día se dice solo de quien fuma."
  if (Object.keys(rest).length) errors.habitos = "Hábitos: solo el tabaco y cuánto fuma."
  return errors
}
