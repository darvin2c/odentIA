/**
 * «Odontológicos y hábitos» de la entrevista de salud de odentIA
 * (`antecedentesOdontologicos`). Lo mismo dice la pantalla antes de guardar y
 * el servidor al recibirlo: cada error con la ruta de su dato en la entrevista.
 */

import {
  CIGARETTE_BAND_LABELS,
  CIGARETTE_BANDS,
  type CigaretteBand,
  INTERVIEW_ANSWERS,
  TOBACCO_ANSWERS,
} from "@odentia/clinical"

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

const ANSWER_WORDS: Record<string, string> = { si: "sí", no: "no", no_sabe: "no sabe" }
const TOBACCO_WORDS: Record<string, string> = { nunca: "nunca fumó", fuma: "fuma", dejo: "lo dejó" }

/** Un dato de lo que odentIA suma a la entrevista, con la clave de quién lo dijo (`DECLARED_INTERVIEW`). */
export interface DentalInterviewItem {
  key: "corazon" | "anestesia" | "tabaco" | "lactancia"
  text: string
  /**
   * Lo que va arriba de la ficha y de la atención: el corazón, el antibiótico y la anestesia solo
   * con «Sí» o «No sabe», y la lactancia con «Sí». El tabaco no (se lee en Antecedentes).
   */
  alert: string | null
  /** El día en que se dijo la lactancia (AAAA-MM-DD), para decirlo con su fecha. */
  saidOn?: string
}

/**
 * Lo que odentIA suma a la entrevista, en palabras, para el resumen de
 * Antecedentes y la atención: el corazón, la anestesia, si fuma y la
 * lactancia. Lo que no se respondió no sale: nunca un «No» de lo que nadie dijo.
 */
export function dentalInterviewItems(answers: Record<string, unknown>): DentalInterviewItem[] {
  const rec = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const items: DentalInterviewItem[] = []
  const dental = rec(answers.antecedentesOdontologicos)
  const heart = rec(dental.corazon)
  const risk = typeof heart.riesgoEndocarditis === "string" ? heart.riesgoEndocarditis : null
  const antibiotic = typeof heart.antibioticoPrevio === "string" ? heart.antibioticoPrevio : null
  const heartParts = [
    risk ? `válvula, problema de nacimiento o endocarditis: ${ANSWER_WORDS[risk] ?? risk}` : "",
    antibiotic ? `antibiótico antes del dentista: ${ANSWER_WORDS[antibiotic] ?? antibiotic}` : "",
  ].filter(Boolean)
  const heartAlert = [
    risk === "si" ? "válvula, de nacimiento o endocarditis" : risk === "no_sabe" ? "no sabe si tiene válvula o endocarditis" : "",
    antibiotic === "si" ? "su médico le indicó antibiótico antes" : antibiotic === "no_sabe" ? "no sabe si debe tomar antibiótico antes" : "",
  ].filter(Boolean)
  if (heartParts.length)
    items.push({ key: "corazon", text: `Corazón: ${heartParts.join(" · ")}`, alert: heartAlert.length ? `Corazón: ${heartAlert.join(" · ")}` : null })
  if (typeof dental.problemaAnestesia === "string") {
    const answer = dental.problemaAnestesia
    items.push({
      key: "anestesia",
      text: `Problemas con la anestesia o sangrado tras una extracción: ${ANSWER_WORDS[answer] ?? answer}`,
      alert:
        answer === "si"
          ? "Tuvo problemas con la anestesia o sangró tras una extracción"
          : answer === "no_sabe"
            ? "Anestesia o sangrado tras una extracción: no sabe"
            : null,
    })
  }
  const habits = rec(answers.habitos)
  if (typeof habits.tabaco === "string") {
    const band = typeof habits.cigarrillos === "string" ? CIGARETTE_BAND_LABELS[habits.cigarrillos as CigaretteBand] : ""
    items.push({ key: "tabaco", text: `Tabaco: ${TOBACCO_WORDS[habits.tabaco] ?? habits.tabaco}${band ? `, ${band}` : ""}`, alert: null })
  }
  const lactation = rec(rec(answers.embarazoLactancia).lactancia)
  if (lactation.estado === "si" || lactation.estado === "no") {
    const saidOn = typeof lactation.fecha === "string" ? lactation.fecha : undefined
    items.push({
      key: "lactancia",
      text: `Lactancia: ${lactation.estado === "si" ? "sí" : "no"}`,
      alert: lactation.estado === "si" ? "Lactancia" : null,
      ...(saidOn ? { saidOn } : {}),
    })
  }
  return items
}

/** `dentalInterviewItems` solo en palabras. */
export function dentalInterviewLines(answers: Record<string, unknown>): string[] {
  return dentalInterviewItems(answers).map((item) => item.text)
}
