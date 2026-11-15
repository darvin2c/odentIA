/**
 * «Odontológicos y hábitos» de la entrevista de salud de odentIA
 * (`antecedentesOdontologicos`). Lo mismo dice la pantalla antes de guardar y
 * el servidor al recibirlo: cada error con la ruta de su dato en la entrevista.
 */

import {
  anesthesiaAnswersOf,
  anesthesiaAnswersSchema,
  anesthesiaTroubleWords,
  BOTTLE_ANSWERS,
  BRUSHER_ANSWERS,
  CIGARETTE_BAND_LABELS,
  CIGARETTE_BANDS,
  type CigaretteBand,
  INTERVIEW_ANSWERS,
  PACIFIER_ANSWERS,
  SWEETS_ANSWERS,
  type InterviewEntry,
  TOBACCO_ANSWERS,
} from "@odentia/clinical"

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
  // Lo de un niño en casa que contó quien lo cuida (entrega 7), con los nombres de Antecedentes.
  for (const entry of childhoodEntries(given)) add(entry.key, entry.label, entry.value.replace(/^./, (letter) => letter.toLocaleUpperCase("es")))
  return out
}

/** Lo de un niño en casa: cada respuesta con su nombre en Antecedentes. */
const CHILDHOOD_ENTRY_LABELS = [
  ["biberon", "Biberón o pecho para dormir"],
  ["chupon", "Chupón o dedo"],
  ["dulcesEntreComidas", "Dulces o jugos entre comidas"],
  ["pastaConFluor", "Pasta de dientes con flúor"],
  ["quienCepilla", "Quién le cepilla los dientes"],
] as const

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
  // La anestesia y el sangrado, cada uno con su respuesta (H9); lo guardado antes, una sola para los dos.
  if (!isAnswer(problemaAnestesia) && !anesthesiaAnswersSchema.safeParse(problemaAnestesia).success)
    errors["antecedentesOdontologicos.problemaAnestesia"] =
      "Anestesia y sangrado: elige Sí, No o No sabe, y qué pasó solo con el Sí a la anestesia."
  // «De pequeño»: cada respuesta, una de su lista.
  const childhood = group as Record<string, unknown>
  for (const [key, allowed, label] of CHILDHOOD_CHOICES) {
    const value = childhood[key]
    if (value !== undefined && !(allowed as readonly unknown[]).includes(value))
      errors[`antecedentesOdontologicos.${key}`] = `${label}: elige una opción.`
  }
  return errors
}

/** Lo de un niño que cuenta quien lo cuida, con sus respuestas posibles y su nombre. */
const CHILDHOOD_CHOICES = [
  ["biberon", BOTTLE_ANSWERS, "Biberón o pecho para dormir"],
  ["chupon", PACIFIER_ANSWERS, "Chupón o dedo"],
  ["dulcesEntreComidas", SWEETS_ANSWERS, "Dulces o jugos entre comidas"],
  ["pastaConFluor", INTERVIEW_ANSWERS, "Pasta con flúor"],
  ["quienCepilla", BRUSHER_ANSWERS, "Quién le cepilla"],
] as const

/** Cada respuesta de «de pequeño», como se lee en la atención y en Antecedentes. */
export const CHILDHOOD_WORDS = {
  biberon: { no: "no toma biberón", si: "toma biberón o pecho para dormir", ya_no: "ya no toma biberón" },
  chupon: { no: "no usa chupón ni se chupa el dedo", chupon: "usa chupón", dedo: "se chupa el dedo" },
  dulcesEntreComidas: { casi_nunca: "casi nunca", "1_a_3": "1 a 3 veces al día", "4_o_mas": "4 o más veces al día" },
  pastaConFluor: { si: "pasta con flúor", no: "pasta sin flúor", no_sabe: "no sabe si su pasta tiene flúor" },
  quienCepilla: { solo: "se cepilla sin ayuda", adulto: "lo cepilla un adulto", ambos: "se cepilla con ayuda de un adulto" },
} as const satisfies Record<(typeof CHILDHOOD_CHOICES)[number][0], Record<string, string>>

/**
 * Lo de un niño en casa, dato por dato y en palabras («Biberón o pecho para dormir: ya no toma
 * biberón»): la tarjeta de Antecedentes, «Revisa con…» de la atención, «Ver declaración original»
 * y la copia lo dicen igual. Lo que no se respondió no sale.
 */
export function childhoodEntries(dental: unknown): Array<{ key: (typeof CHILDHOOD_ENTRY_LABELS)[number][0]; label: string; value: string }> {
  const given = dental && typeof dental === "object" && !Array.isArray(dental) ? (dental as Record<string, unknown>) : {}
  return CHILDHOOD_ENTRY_LABELS.flatMap(([key, label]) => {
    const value = given[key]
    const words: Record<string, string> = CHILDHOOD_WORDS[key]
    const said = typeof value === "string" ? words[value] : undefined
    return said ? [{ key, label, value: said }] : []
  })
}

/**
 * Los hábitos de odentIA en la entrevista (`habitos`, la forma de latidIA): si
 * fuma y, de quien fuma, cuánto. Lo demás de ese grupo no es de odentIA.
 */
export function dentalHabitsErrors(answers: Record<string, unknown>): Record<string, string> {
  const group = answers.habitos
  if (group === undefined) return {}
  if (!group || typeof group !== "object" || Array.isArray(group)) return { habitos: "Hábitos: revisa lo escrito." }
  const { tabaco, cigarrillos, alcohol, ...rest } = group as Record<string, unknown>
  const errors: Record<string, string> = {}
  if (tabaco !== undefined && !(TOBACCO_ANSWERS as readonly unknown[]).includes(tabaco))
    errors["habitos.tabaco"] = "Tabaco: elige una opción."
  if (cigarrillos !== undefined && (tabaco !== "fuma" || !(CIGARETTE_BANDS as readonly unknown[]).includes(cigarrillos)))
    errors["habitos.cigarrillos"] = "Cuántos al día se dice solo de quien fuma."
  if (alcohol !== undefined && !(ALCOHOL_ANSWERS as readonly unknown[]).includes(alcohol))
    errors["habitos.alcohol"] = "Alcohol: elige una opción."
  if (Object.keys(rest).length) errors.habitos = "Hábitos: solo el tabaco, cuánto fuma y el alcohol."
  return errors
}

const ANSWER_WORDS: Record<string, string> = { si: "sí", no: "no", no_sabe: "no sabe" }
const TOBACCO_WORDS: Record<string, string> = { nunca: "nunca fumó", fuma: "fuma", dejo: "lo dejó" }
/** Lo que se responde del alcohol, como en latidIA. */
export const ALCOHOL_ANSWERS = ["no", "ocasional", "frecuente"] as const
const ALCOHOL_WORDS: Record<string, string> = { no: "no toma", ocasional: "de vez en cuando", frecuente: "con frecuencia" }

/** Un dato de lo que odentIA suma a la entrevista, con la clave de quién lo dijo (`DECLARED_INTERVIEW`). */
export interface DentalInterviewItem {
  key: "corazon" | "anestesia" | "sangrado" | "tabaco" | "alcohol" | "lactancia"
  /** Dónde está en la entrevista («habitos.tabaco»): la clave con que la copia sabe quién lo dijo. */
  path: string
  /** De qué preguntas de la persona sale (las claves de quién lo dijo): el corazón son dos. */
  said: Array<"corazon" | "antibiotico" | "anestesia" | "sangrado" | "tabaco" | "alcohol" | "lactancia">
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
    items.push({ key: "corazon", path: "antecedentesOdontologicos.corazon", said: ["corazon", "antibiotico"], text: `Corazón: ${heartParts.join(" · ")}`, alert: heartAlert.length ? `Corazón: ${heartAlert.join(" · ")}` : null })
  const { joint, anesthesia, what, bleeding } = anesthesiaAnswersOf(dental.problemaAnestesia)
  // Arriba va el «Sí» y el «No sabe»; el «No» se lee en Antecedentes.
  const alertOf = (answer: string, yes: string, unknown: string) => (answer === "si" ? yes : answer === "no_sabe" ? unknown : null)
  // Lo guardado antes con una sola pregunta para los dos: se lee como se preguntó.
  if (joint)
    items.push({
      key: "anestesia",
      path: "antecedentesOdontologicos.problemaAnestesia",
      said: ["anestesia"],
      text: `Problemas con la anestesia o sangrado tras una extracción: ${ANSWER_WORDS[joint]}`,
      alert: alertOf(joint, "Tuvo problemas con la anestesia o sangró tras una extracción", "Anestesia o sangrado tras una extracción: no sabe"),
    })
  // Desde la revisión final (H9), por separado y con qué pasó: con una warfarina, lo que importa es el sangrado.
  if (anesthesia) {
    const how = what ? anesthesiaTroubleWords(what) : null
    items.push({
      key: "anestesia",
      path: "antecedentesOdontologicos.problemaAnestesia.anestesia",
      said: ["anestesia"],
      text: `Problema con la anestesia: ${ANSWER_WORDS[anesthesia]}${how ? `, ${how}` : ""}`,
      alert: alertOf(anesthesia, `Problema con la anestesia${how ? `: ${how}` : ""}`, "Anestesia: no sabe si tuvo un problema"),
    })
  }
  if (bleeding)
    items.push({
      key: "sangrado",
      path: "antecedentesOdontologicos.problemaAnestesia.sangrado",
      said: ["sangrado"],
      text: `Sangrado largo tras una extracción: ${ANSWER_WORDS[bleeding]}`,
      alert: alertOf(bleeding, "Sangró mucho tras una extracción", "Sangrado tras una extracción: no sabe"),
    })
  const habits = rec(answers.habitos)
  if (typeof habits.tabaco === "string") {
    const band = typeof habits.cigarrillos === "string" ? CIGARETTE_BAND_LABELS[habits.cigarrillos as CigaretteBand] : ""
    items.push({ key: "tabaco", path: "habitos.tabaco", said: ["tabaco"], text: `Tabaco: ${TOBACCO_WORDS[habits.tabaco] ?? habits.tabaco}${band ? `, ${band}` : ""}`, alert: null })
  }
  if (typeof habits.alcohol === "string")
    items.push({ key: "alcohol", path: "habitos.alcohol", said: ["alcohol"], text: `Alcohol: ${ALCOHOL_WORDS[habits.alcohol] ?? habits.alcohol}`, alert: null })
  const lactation = rec(rec(answers.embarazoLactancia).lactancia)
  if (lactation.estado === "si" || lactation.estado === "no") {
    const saidOn = typeof lactation.fecha === "string" ? lactation.fecha : undefined
    items.push({
      key: "lactancia",
      path: "embarazoLactancia.lactancia",
      said: ["lactancia"],
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
