/**
 * La «Entrevista de salud» de la ficha (`patient_anamnesis.answers`) dicha en
 * palabras, para la copia de la historia: aquí, lo común a todos los productos
 * (los antecedentes personales). Lo de cada producto lo suma su dominio
 * (`@odentia/dental`, `@odentia/medical`) con la misma forma.
 */
import { type PregnancyReading, pregnancyRecordOf, pregnancyToday } from "./pregnancy.js"

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
 * La clave del embarazo en la copia: una sola para sus dos formas, la de ahora
 * (`embarazoLactancia.embarazo`, con el día en que se dijo) y la de antes
 * (`antecedentesPersonales.embarazo`, sin fecha). Es común a los productos: el
 * que tiene su grupo propio de embarazo y lactancia no lo vuelve a decir.
 */
export const PREGNANCY_ENTRY_KEY = "embarazoLactancia.embarazo"

/** «13/11/2026»: un día de calendario, igual en cualquier zona. */
const dayWords = (day: string): string => day.split("-").reverse().join("/")
const weeksWords = (weeks: number): string => `${weeks} ${weeks === 1 ? "semana" : "semanas"}`

/**
 * El embarazo en palabras, con la regla común de si sigue en pie
 * (`pregnancyToday`): la semana a la fecha de la copia y, entre paréntesis, la
 * que se dijo y su día. Pasado su término o sin fecha ya no se afirma. null si
 * no se respondió.
 */
function pregnancyWords(answers: unknown, today: string, reading: PregnancyReading): string | null {
  const record = pregnancyRecordOf(answers)
  if (!record) return null
  if (record.estado === "no") return record.fecha ? `No · lo dijo el ${dayWords(record.fecha)}` : "No"
  const view = pregnancyToday(answers, today, reading)
  if (!view?.saidOn) return "Por confirmar: anotado sin fecha"
  const day = dayWords(view.saidOn)
  if (view.state === "por_confirmar")
    return `Por confirmar: lo dijo el ${day}${view.weeksSaid === null ? "" : `, con ${weeksWords(view.weeksSaid)},`} y ya pasó el tiempo de un embarazo`
  if (view.weeksToday === null) return `Sí · lo dijo el ${day}, sin las semanas`
  // La misma semana que dijo no se repite: «30 semanas a la fecha de esta copia (30 el …)» decía
  // dos veces lo mismo (QA de la entrega 2, como en la ficha).
  if (view.weeksSaid === view.weeksToday) return `Sí · ${weeksWords(view.weeksToday)} (lo dijo el ${day})`
  return `Sí · ${weeksWords(view.weeksToday)} a la fecha de esta copia (${view.weeksSaid === null ? "lo dijo" : weeksWords(view.weeksSaid)} el ${day})`
}

/**
 * Los antecedentes personales de la entrevista, en el orden de la pantalla, y
 * el embarazo, que es común a los productos. `today` es el día de la clínica;
 * `reading`, lo que se sabe de un embarazo guardado sin fecha. Lo que no se
 * respondió no sale.
 */
export function commonInterviewEntries(
  answers: unknown,
  today: string,
  reading: PregnancyReading = {},
): InterviewEntry[] {
  const all = recordOf(answers)
  const personal = recordOf(all.antecedentesPersonales)
  const out: InterviewEntry[] = []
  for (const [key, label] of PERSONAL_TEXTS) {
    const value = textOf(personal[key])
    if (value) out.push({ key: `antecedentesPersonales.${key}`, label, value })
  }
  const pregnancy = pregnancyWords(answers, today, reading)
  if (pregnancy) out.push({ key: PREGNANCY_ENTRY_KEY, label: "Embarazo", value: pregnancy })
  for (const [key, label] of EARLIER_TEXTS) {
    const [group, field] = key.split(".")
    const value = textOf(field ? recordOf(all[group as string])[field] : all[key])
    if (value) out.push({ key, label: `${label} (registro anterior)`, value })
  }
  return out
}
