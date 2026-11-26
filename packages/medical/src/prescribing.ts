import { findMedication, type MedicationEntry } from "@odentia/clinical"
import type { MedicalHistory } from "./history.js"

/**
 * Lo que la receta de latidIA revisa además de lo que revisa toda receta
 * (issue 229, decisión 12):
 * - los controlados no salen en la receta común: van en la receta oficial
 *   de cada país (convenciones de la ONU de 1961 y 1971, abajo);
 * - a un menor de 12 años se le pide su peso, para la dosis: sin él, avisa y
 *   deja emitir (26 nov: lo clínico lo decide quien receta; ninguna norma
 *   citada en el repo lo exige).
 * El embarazo, la lactancia, lo contraindicado en el embarazo y un AINE con un
 * anticoagulante nacieron aquí y ahora son de toda receta (`prescribingAlerts`
 * de @odentia/clinical), igual en odentIA. Las alergias y el duplicado por
 * código ATC, también (`allergyWarnings`, `duplicateWarnings`).
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

/** A un menor de esta edad se le pide su peso para recetarle (avisa, no frena). */
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
  /** Lo que impide emitir: un controlado (norma). */
  errors: string[]
  /** Lo que avisa y deja emitir: falta el peso de un niño. */
  warnings: string[]
  /** Si la receta pide el peso (menor de 12 años). */
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
  for (const item of items) {
    const name = item.genericName.trim()
    if (!name) continue
    const controlled = prefixOf(CONTROLLED_ATC, findMedication(name, context.medications)?.atc)
    if (controlled)
      errors.push(
        `${capitalized(name)} es ${controlled}, un medicamento controlado: no va en la receta común, usa la receta oficial.`,
      )
  }
  const age = ageInYears(context.birthDate, context.today)
  const weightRequired = age !== null && age < WEIGHT_REQUIRED_UNDER_YEARS
  if (weightRequired && (weightKg === null || !(weightKg > 0)))
    warnings.push(
      `Aviso: tiene ${age} ${age === 1 ? "año" : "años"} y la receta va sin su peso. Con su peso se revisa la dosis.`,
    )
  return { errors, warnings, weightRequired }
}
