/**
 * «Odontológicos y hábitos» de la entrevista de salud de odentIA
 * (`antecedentesOdontologicos`). Lo mismo dice la pantalla antes de guardar y
 * el servidor al recibirlo: cada error con la ruta de su dato en la entrevista.
 */

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
  return errors
}
