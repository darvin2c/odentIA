/**
 * Lo que la receta avisa sin frenar en todos los productos (QA final de formularios, Y1 y D5 de la
 * voz clínica): era solo de latidIA y se mueve aquí para que odentIA lo use igual. Decide quien
 * receta: se avisa como una alergia y la receta guarda que vio el aviso (ADR 0143).
 * - Con embarazo o lactancia registrados, lo recuerda con su fecha.
 * - Lo contraindicado en el embarazo, por su grupo ATC.
 * - Un AINE desde la semana 20 del embarazo (FDA, comunicación del 15 oct 2020).
 * - Un AINE con un anticoagulante o un antiagregante (grupo ATC B01A): más riesgo de sangrado
 *   (SDCEP, «Management of Dental Patients Taking Anticoagulants or Antiplatelet Drugs», 2015).
 * Las interacciones entre medicamentos en general quedan fuera: piden una base con licencia.
 */

import { MEDICATION_CLASSES, medicationClassOf, type TakenMedication } from "./allergens.js"
import { findMedication, type MedicationEntry } from "./medications.js"
import { pregnancyToday } from "./pregnancy.js"
import { upperFirst } from "./product-words.js"

/**
 * Lo que está contraindicado en el embarazo, por su grupo ATC, dicho como se lee en el aviso: los
 * efectos en el feto están bien establecidos y aparecen en las fichas técnicas.
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

/** Los AINE (M01A) y la aspirina como analgésico (N02BA): la aspirina de 100 mg diaria es antiagregante (B01AC). */
const NSAID_ATC = ["M01A", "N02BA"] as const
/** Desde esta semana del embarazo se evitan los AINE (FDA, 2020). */
export const NSAID_AVOID_FROM_WEEK = 20

const prefixOf = (list: ReadonlyArray<readonly [string, string]>, atc: string | undefined): string | null =>
  atc ? (list.find(([prefix]) => atc.startsWith(prefix))?.[1] ?? null) : null

/** «13/11/2026»: el día en que se registró. */
function civilDay(iso: string): string {
  const [year, month, day] = iso.split("-")
  return `${day}/${month}/${year}`
}

/** La lactancia de la entrevista (`embarazoLactancia.lactancia`, la forma común): el día en que se dijo «sí». */
function lactationOf(interview: unknown): { saidOn: string } | null {
  const group = interview && typeof interview === "object" ? (interview as Record<string, unknown>).embarazoLactancia : null
  const lactancia = group && typeof group === "object" ? (group as Record<string, unknown>).lactancia : null
  if (!lactancia || typeof lactancia !== "object") return null
  const { estado, fecha } = lactancia as Record<string, unknown>
  return estado === "si" && typeof fecha === "string" ? { saidOn: fecha } : null
}

export interface PrescribingSituation {
  /** La entrevista de salud guardada (la última versión), con el embarazo y la lactancia en su forma común. */
  interview: unknown
  /** El día de la clínica (AAAA-MM-DD). */
  today: string
  /** Lo que toma hoy, con su código ATC si se sabe (`currentMedicationsOf`). */
  taking: readonly TakenMedication[]
  /** El día en que se anotó un embarazo guardado sin fecha (`legacyPregnancySaidOn`), si se sabe. */
  legacySaidOn?: string | null
}

/** Lo que la receta avisa (decide quien receta) y lo que solo recuerda, para lo que se va a recetar. */
export function prescribingAlerts(
  situation: PrescribingSituation,
  items: ReadonlyArray<{ genericName: string }>,
  medications: readonly MedicationEntry[],
): { warnings: string[]; reminders: string[] } {
  const warnings: string[] = []
  const reminders: string[] = []
  // La misma regla que la franja de la ficha (`pregnancyToday`): en pie hasta la semana 42 y, después,
  // «por confirmar». La receta nunca deja de avisar en silencio: con el embarazo por confirmar sigue
  // avisando lo contraindicado, con esas palabras, hasta que alguien actualice sus antecedentes.
  const pregnancy = pregnancyToday(situation.interview, situation.today, { legacySaidOn: situation.legacySaidOn ?? null })
  const weeks = pregnancy?.weeksToday ?? null
  const unconfirmed = pregnancy?.state === "por_confirmar"
  const said = pregnancy?.saidOn ? civilDay(pregnancy.saidOn) : null
  if (pregnancy)
    reminders.push(
      unconfirmed
        ? `Embarazo por confirmar${said ? ` (registrado el ${said})` : ""}: ya pasó el tiempo de un embarazo. Pregúntale y actualiza sus antecedentes; mientras tanto se sigue avisando lo contraindicado en el embarazo.`
        : `Está embarazada${weeks === null ? "" : `, ${weeks} semanas`}${said ? ` (registrado el ${said})` : ""}: revisa que cada medicamento sea seguro en el embarazo.`,
    )
  const lactation = lactationOf(situation.interview)
  if (lactation)
    reminders.push(
      `Da de lactar (registrado el ${civilDay(lactation.saidOn)}): revisa que cada medicamento sea compatible con la lactancia.`,
    )
  const pregnantWords = unconfirmed
    ? "tiene un embarazo por confirmar"
    : `está embarazada${weeks === null ? "" : ` (${weeks} semanas)`}`
  // Anticoagulantes y antiagregantes: su clase va con el código (lo que dijo o eligió el equipo).
  const thinners = situation.taking.filter((medicine) => medicationClassOf(medicine.atcCode) === "anticoagulants")
  for (const item of items) {
    const name = item.genericName.trim()
    if (!name) continue
    const atc = findMedication(name, medications)?.atc
    const avoid = pregnancy ? prefixOf(PREGNANCY_CONTRAINDICATED, atc) : null
    if (avoid) warnings.push(`${upperFirst(name)}: ${pregnantWords} y ${avoid} en el embarazo (ATC ${atc}).`)
    const nsaid = !!atc && NSAID_ATC.some((prefix) => atc.startsWith(prefix))
    if (!nsaid) continue
    // Sin las semanas no se sabe si ya pasó la 20: se avisa igual.
    if (pregnancy && (unconfirmed || weeks === null || weeks >= NSAID_AVOID_FROM_WEEK))
      warnings.push(`${upperFirst(name)}: ${pregnantWords} y los AINE se evitan desde la semana ${NSAID_AVOID_FROM_WEEK} del embarazo (ATC ${atc}).`)
    if (thinners.length > 0)
      warnings.push(
        `${upperFirst(name)}: toma ${thinners.map((medicine) => medicine.name).join(" y ")} (${MEDICATION_CLASSES.anticoagulants.label.toLocaleLowerCase("es")} o antiagregante) y los AINE aumentan el riesgo de sangrado; el paracetamol es la alternativa habitual.`,
      )
  }
  return { warnings, reminders }
}
