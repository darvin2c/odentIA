/**
 * La «Entrevista de salud» de la ficha (`patient_anamnesis.answers`) dicha en
 * palabras, para la copia de la historia: aquí, lo común a todos los productos
 * (los antecedentes personales). Lo de cada producto lo suma su dominio
 * (`@odentia/dental`, `@odentia/medical`) con la misma forma.
 */

/** Un dato de la entrevista: su nombre y lo respondido, en palabras. */
export interface InterviewEntry {
  /** La ruta del dato en la entrevista («antecedentesPersonales.embarazo»). */
  key: string
  label: string
  value: string
}

type Rec = Record<string, unknown>
const recordOf = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {}
const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/** Lo que se escribe en «Personales», en el orden de la pantalla. */
const PERSONAL_TEXTS = [
  ["hospitalizaciones", "Hospitalizaciones"],
  ["cirugias", "Cirugías"],
  ["transfusiones", "Transfusiones"],
] as const

/**
 * Lo que la entrevista guardaba antes como texto libre y hoy vive en otro lugar
 * (las listas de enfermedades y medicación, la atención): una entrevista que
 * nadie volvió a guardar lo conserva, y la copia lo dice como registro anterior.
 */
const EARLIER_TEXTS = [
  ["antecedentesPersonales.enfermedades", "Enfermedades"],
  ["antecedentesPersonales.medicacionHabitual", "Medicación habitual"],
  ["antecedentesFamiliares", "Antecedentes familiares"],
  ["motivoConsulta", "Motivo de consulta"],
  ["tiempoEnfermedad", "Tiempo de enfermedad"],
  ["diagnosticoPresuntivo", "Diagnóstico presuntivo"],
] as const

/**
 * Los antecedentes personales de la entrevista, en el orden de la pantalla. El
 * embarazo va con las semanas que se dijeron ese día (odentIA lo pregunta aquí;
 * latidIA, en su grupo propio, con fecha). Lo que no se respondió no sale.
 */
export function commonInterviewEntries(answers: unknown): InterviewEntry[] {
  const all = recordOf(answers)
  const personal = recordOf(all.antecedentesPersonales)
  const out: InterviewEntry[] = []
  for (const [key, label] of PERSONAL_TEXTS) {
    const value = textOf(personal[key])
    if (value) out.push({ key: `antecedentesPersonales.${key}`, label, value })
  }
  if (typeof personal.embarazo === "boolean") {
    const weeks = personal.semanasEmbarazo
    out.push({
      key: "antecedentesPersonales.embarazo",
      label: "Embarazo",
      value: personal.embarazo
        ? `Sí${typeof weeks === "number" ? `, ${weeks} ${weeks === 1 ? "semana" : "semanas"} al registrarlo` : ""}`
        : "No",
    })
  }
  for (const [key, label] of EARLIER_TEXTS) {
    const [group, field] = key.split(".")
    const value = textOf(field ? recordOf(all[group as string])[field] : all[key])
    if (value) out.push({ key, label: `${label} (registro anterior)`, value })
  }
  return out
}
