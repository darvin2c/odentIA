/**
 * «Odontológicos y hábitos» de la entrevista de salud de odentIA
 * (`antecedentesOdontologicos`). Lo mismo dice la pantalla antes de guardar y
 * el servidor al recibirlo: cada error con la ruta de su dato en la entrevista.
 */

import type { InterviewEntry } from "@odentia/clinical"

/** Las opciones de la pantalla, con su nombre. */
const EXPERIENCE_WORDS: Record<string, string> = { positiva: "Positiva", regular: "Regular", traumatica: "Traumática" }
const ANXIETY_WORDS: Record<string, string> = { ninguna: "Ninguna", leve: "Leve", moderada: "Moderada", alta: "Alta" }

/**
 * «Odontológicos y hábitos» en palabras, en el orden de la pantalla, para la
 * copia de la historia. Lo que no se respondió no sale.
 */
export function dentalInterviewEntries(answers: unknown): InterviewEntry[] {
  const all = answers && typeof answers === "object" && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {}
  const group = all.antecedentesOdontologicos
  if (!group || typeof group !== "object" || Array.isArray(group)) return []
  const given = group as Record<string, unknown>
  const out: InterviewEntry[] = []
  const add = (key: string, label: string, value: string | null | undefined) => {
    if (value) out.push({ key: `antecedentesOdontologicos.${key}`, label, value })
  }
  const yesNo = (value: unknown) => (typeof value === "boolean" ? (value ? "Sí" : "No") : null)
  add("ultimaVisita", "Última visita", typeof given.ultimaVisita === "string" ? given.ultimaVisita.trim() : null)
  add("cepilladosAlDia", "Cepillados al día", typeof given.cepilladosAlDia === "number" ? String(given.cepilladosAlDia) : null)
  add("experienciaPrevia", "Experiencia previa", EXPERIENCE_WORDS[String(given.experienciaPrevia)])
  add("ansiedadDental", "Ansiedad dental", ANXIETY_WORDS[String(given.ansiedadDental)])
  add("hiloDental", "Hilo dental", yesNo(given.hiloDental))
  add("bruxismo", "Bruxismo", yesNo(given.bruxismo))
  add(
    "habitos",
    "Hábitos",
    Array.isArray(given.habitos) ? given.habitos.filter((item) => typeof item === "string" && item.trim()).join(", ") : null,
  )
  return out
}

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
