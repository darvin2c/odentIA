import { declaredLactationAndTobacco } from "@odentia/clinical"
import { dentalHabitsErrors, dentalInterviewEntries, dentalInterviewErrors, dentalInterviewItems } from "@odentia/dental"
import { fieldsError } from "../errors.js"
import { answeredOf, COMMON_INTERVIEW, type ProductInterview } from "../product-hooks.js"

/**
 * La entrevista de odentIA: lo común (con el embarazo y su fecha) y sus
 * antecedentes odontológicos. Lo que se declaró de la boca en el registro
 * («Tu boca») entra con sus mismas claves.
 */
export const dentalInterview: ProductInterview = {
  check(answers, today) {
    // Cada error a su dato, con el nombre que tiene en el cuerpo (`anamnesis.answers.…`).
    const error = fieldsError({ ...dentalInterviewErrors(answers), ...dentalHabitsErrors(answers) }, (key) => `anamnesis.answers.${key}`)
    if (error) throw error
    return COMMON_INTERVIEW.check(answers, today)
  },
  declared(health, today) {
    // El corazón y la anestesia van con lo de su boca; la lactancia y el tabaco, con la forma de
    // latidIA (`declaredLactationAndTobacco`), junto al embarazo que arma lo común.
    const dental = answeredOf(health.dental)
    const common = COMMON_INTERVIEW.declared(health, today)
    const { embarazoLactancia, habitos } = declaredLactationAndTobacco(health.medical, today)
    const pregnancy = { ...((common.embarazoLactancia as Record<string, unknown> | undefined) ?? {}), ...embarazoLactancia }
    return {
      ...common,
      ...(Object.keys(pregnancy).length ? { embarazoLactancia: pregnancy } : {}),
      ...(habitos ? { habitos } : {}),
      ...(Object.keys(dental).length ? { antecedentesOdontologicos: dental } : {}),
    }
  },
  record: (answers, today, reading) => [
    ...COMMON_INTERVIEW.record(answers, today, reading),
    ...dentalInterviewEntries(answers),
    // El corazón, la anestesia, el tabaco, el alcohol y la lactancia, con la clave donde están en la
    // entrevista: así la copia sabe quién lo dijo (QA de la entrega 6).
    ...(answers && typeof answers === "object" && !Array.isArray(answers) ? dentalInterviewItems(answers as Record<string, unknown>) : []).map(
      (item) => {
        const [label, ...rest] = item.text.split(": ")
        const day = item.saidOn ? ` (lo dijo el ${item.saidOn.split("-").reverse().join("/")})` : ""
        return { key: DENTAL_ITEM_ENTRY_KEY[item.key], label: label ?? item.key, value: `${rest.join(": ")}${day}` }
      },
    ),
  ],
}

/** Dónde está cada dato en la entrevista: la clave con que la copia sabe quién lo dijo. */
const DENTAL_ITEM_ENTRY_KEY = {
  corazon: "antecedentesOdontologicos.corazon",
  anestesia: "antecedentesOdontologicos.problemaAnestesia",
  tabaco: "habitos.tabaco",
  alcohol: "habitos.alcohol",
  lactancia: "embarazoLactancia.lactancia",
} as const
