import { findMedication, type MedicationEntry } from "@odentia/clinical"
import { dayWords, type MedicalHistory, pregnancyWeeks } from "./history.js"

/**
 * Lo que la receta de latidIA revisa además de las alergias (issue 229,
 * decisión 12):
 * - los controlados no salen en la receta común: van en la receta oficial
 *   de cada país;
 * - con embarazo o lactancia registrados, lo recuerda, y lo contraindicado
 *   en el embarazo se receta solo con motivo, como una alergia;
 * - a un menor de 12 años se le receta con su peso.
 * Las interacciones entre medicamentos quedan fuera: piden una base con
 * licencia.
 */

/**
 * Estupefacientes y psicotrópicos de las convenciones de la ONU de 1961 y
 * 1971, por su grupo ATC: opioides, benzodiazepinas y afines, barbitúricos y
 * estimulantes. Cada país los receta en su formulario oficial; la regla es la
 * misma en todos, la más prudente.
 */
const CONTROLLED_ATC: ReadonlyArray<readonly [prefix: string, words: string]> = [
  ["N02A", "un opioide"],
  ["R05DA04", "un opioide"],
  ["N05BA", "una benzodiazepina"],
  ["N05CD", "una benzodiazepina"],
  ["N03AE", "una benzodiazepina"],
  ["N05CF", "un hipnótico del grupo del zolpidem"],
  ["N05CA", "un barbitúrico"],
  ["N03AA", "un barbitúrico"],
  ["N06BA", "un estimulante"],
  ["N01AX03", "un anestésico disociativo"],
]

/**
 * Lo que está contraindicado en el embarazo, por su grupo ATC, dicho como se
 * lee en el aviso: los efectos en el feto están bien establecidos y aparecen
 * en las fichas técnicas.
 */
const PREGNANCY_CONTRAINDICATED: ReadonlyArray<readonly [prefix: string, words: string]> = [
  ["C09A", "los IECA están contraindicados"],
  ["C09B", "los IECA están contraindicados"],
  ["C09C", "los ARA II están contraindicados"],
  ["C09D", "los ARA II están contraindicados"],
  ["C10AA", "las estatinas están contraindicadas"],
  ["B01AA", "los antagonistas de la vitamina K están contraindicados"],
  ["J01AA", "las tetraciclinas están contraindicadas"],
  ["D10BA", "los retinoides están contraindicados"],
  ["A02BB01", "el misoprostol está contraindicado"],
  ["N03AG01", "el ácido valproico está contraindicado"],
  ["L04AX03", "el metotrexato está contraindicado"],
  ["L01BA01", "el metotrexato está contraindicado"],
]

/** A un menor de esta edad se le receta con su peso. */
export const WEIGHT_REQUIRED_UNDER_YEARS = 12

function prefixOf(
  list: ReadonlyArray<readonly [string, string]>,
  atc: string | undefined,
): string | null {
  if (!atc) return null
  return list.find(([prefix]) => atc.startsWith(prefix))?.[1] ?? null
}

function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase("es") + text.slice(1)
}

/** Años cumplidos a una fecha (AAAA-MM-DD), o null sin fecha de nacimiento. */
export function ageInYears(birthDate: string | null | undefined, today: string): number | null {
  if (!birthDate || !/^\d{4}-\d{2}-\d{2}/.test(birthDate)) return null
  const [by, bm, bd] = birthDate.slice(0, 10).split("-").map(Number) as [number, number, number]
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number]
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0)
}

export interface PrescribingContext {
  /** Los antecedentes médicos guardados (`readMedicalHistory`). */
  history: MedicalHistory
  birthDate: string | null | undefined
  /** El día de la clínica (AAAA-MM-DD). */
  today: string
  medications: readonly MedicationEntry[]
}

export interface PrescribingCheck {
  /** Lo que impide emitir: un controlado, o falta el peso de un niño. */
  errors: string[]
  /** Lo que se receta solo con motivo, como una alergia: contraindicado en el embarazo. */
  warnings: string[]
  /** Lo que se recuerda sin bloquear: el embarazo y la lactancia registrados, con su fecha. */
  reminders: string[]
  /** Si la receta lleva el peso (menor de 12 años). */
  weightRequired: boolean
}

/** Las reglas de la receta para lo que se va a recetar (las DCI) y el peso escrito. */
export function checkPrescription(
  context: PrescribingContext,
  items: ReadonlyArray<{ genericName: string }>,
  weightKg: number | null,
): PrescribingCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const reminders: string[] = []
  const embarazo = context.history.embarazoLactancia?.embarazo
  const lactancia = context.history.embarazoLactancia?.lactancia
  const weeks = pregnancyWeeks(context.history, context.today)
  // Un embarazo que por sus semanas ya habría terminado no se da por vigente: se pide actualizarlo.
  const pregnant = embarazo?.estado === "si" && (weeks === null || weeks <= 42)
  if (embarazo?.estado === "si")
    reminders.push(
      pregnant
        ? `Está embarazada${weeks === null ? "" : `, ${weeks} semanas`} (registrado el ${dayWords(embarazo.fecha)}): revisa que cada medicamento sea seguro en el embarazo.`
        : `El embarazo registrado el ${dayWords(embarazo.fecha)} ya habría terminado: actualiza sus antecedentes.`,
    )
  if (lactancia?.estado === "si")
    reminders.push(
      `Da de lactar (registrado el ${dayWords(lactancia.fecha)}): revisa que cada medicamento sea compatible con la lactancia.`,
    )
  for (const item of items) {
    const name = item.genericName.trim()
    if (!name) continue
    const atc = findMedication(name, context.medications)?.atc
    const controlled = prefixOf(CONTROLLED_ATC, atc)
    if (controlled)
      errors.push(
        `${capitalized(name)} es ${controlled}, un medicamento controlado: no va en la receta común, usa la receta oficial.`,
      )
    const avoid = pregnant ? prefixOf(PREGNANCY_CONTRAINDICATED, atc) : null
    if (avoid)
      warnings.push(
        `${capitalized(name)}: está embarazada${weeks === null ? "" : ` (${weeks} semanas)`} y ${avoid} en el embarazo (ATC ${atc}).`,
      )
  }
  const age = ageInYears(context.birthDate, context.today)
  const weightRequired = age !== null && age < WEIGHT_REQUIRED_UNDER_YEARS
  if (weightRequired && (weightKg === null || !(weightKg > 0)))
    errors.push(`Tiene ${age} ${age === 1 ? "año" : "años"}: escribe su peso para recetarle.`)
  return { errors, warnings, reminders, weightRequired }
}
