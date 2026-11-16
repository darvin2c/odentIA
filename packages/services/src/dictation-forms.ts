import { formAnswerWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq } from "drizzle-orm"
import { assertFormSchema, conditionMet, type FormFieldDef, isEmptyAnswer as isEmpty, updateFormResponseDraft } from "./clinical-forms.js"
import { asHeard, formVocabulary, type HeardVocabulary, NEGATION_WORDS, plain } from "./dictation-heard.js"
import { ServiceError } from "./errors.js"
import type { DictationDiagnosis, ProductSite } from "./product-hooks.js"

/*
 * ---------- Clío propone las respuestas de la ficha de consulta empezada ----------
 *
 * Entrega 11 de la mesa de formularios (13–14 nov 2026): mientras el profesional
 * dicta, Clío recibe las preguntas vacías de las fichas del equipo ya empezadas
 * en la atención y propone una respuesta solo si lo dictado la dice. Nada entra
 * a la ficha hasta que quien lleva la atención la acepta. Solo los tipos que se
 * comprueban con la frase: sí/no, una opción, varias, número, escala y pieza.
 * Texto y fecha, después y medidos aparte; firma, archivo y lo que pasa a
 * alergias, nunca.
 */

/** Los tipos de pregunta que Clío puede proponer: los que se comprueban contra la frase dicha. */
export const DICTATION_FORM_TYPES = ["booleano", "opcion_unica", "opcion_multiple", "numero", "escala", "pieza"] as const
export type DictationFormType = (typeof DICTATION_FORM_TYPES)[number]
/** Fichas que lee en una pausa: las tocadas más recientemente. */
export const DICTATION_MAX_FORMS = 2
/** Preguntas que lee en una pausa: el mismo tope que las sugerencias de un tramo. */
export const DICTATION_MAX_FORM_QUESTIONS = 40

/** Una pregunta vacía de una ficha empezada, como la lee Clío en la pausa. */
export interface DictationFormQuestion {
  /** Su número en la lista de la pausa (1, 2…): con él responde el modelo. */
  number: number
  responseId: string
  formTitle: string
  fieldId: string
  label: string
  type: DictationFormType
  options: string[] | null
  unit: string | null
  min: number | null
  max: number | null
  /** Su lugar en la ficha: al aceptar varias, la de la que depende otra va primero. */
  order: number
  /** La pregunta de la que depende, si la tiene (`showIf`). */
  dependsOn: { fieldId: string; label: string; equals: string | boolean } | null
  /**
   * Las etiquetas de las otras preguntas de la ficha: lo que distingue a esta de
   * una parecida (el lado, canina o molar, superior o inferior) tiene que estar
   * en la frase.
   */
  siblings?: Array<{ label: string; type: string; options: string[] | null }>
  /**
   * Lo que ya dice la pregunta, si está respondida. Clío la lee para que «corrijo,
   * es división uno» quede como propuesta por revisar: lo escrito no se cambia solo.
   */
  answered?: unknown
}

/**
 * Las preguntas que Clío puede proponer en esta atención: las de las fichas
 * del equipo en borrador (empezadas: una ficha solo ofrecida no cuenta,
 * decisión 4 del 14 nov), de los tipos que se comprueban con la frase. Las ya
 * respondidas van con lo que dicen (`answered`): solo se proponen si lo dictado
 * las cambia, y quedan por revisar. Una que depende de otra ya respondida de
 * forma que la oculta no se pregunta. Sin fichas empezadas devuelve una lista
 * vacía y el dictado queda como siempre.
 */
export async function dictationFormQuestions(
  tx: Db,
  orgId: string,
  encounterId: string,
  /** `open`: las fichas abiertas en pantalla, que se leen siempre, además del tope. */
  options: { open?: readonly string[] } = {},
): Promise<DictationFormQuestion[]> {
  const rows = await tx
    .select({
      id: clinicalFormResponse.id,
      title: clinicalFormResponse.templateTitle,
      snapshot: clinicalFormResponse.templateSnapshot,
      answers: clinicalFormResponse.answers,
      createdAt: clinicalFormResponse.createdAt,
    })
    .from(clinicalFormResponse)
    .where(
      and(
        eq(clinicalFormResponse.organizationId, orgId),
        eq(clinicalFormResponse.encounterId, encounterId),
        eq(clinicalFormResponse.status, "borrador"),
        eq(clinicalFormResponse.source, "staff"),
      ),
    )
    .orderBy(desc(clinicalFormResponse.updatedAt), desc(clinicalFormResponse.createdAt))
  // Las dos últimas tocadas y las abiertas en pantalla (QA del 14 nov, D23).
  const chosen = rows.filter((row, index) => index < DICTATION_MAX_FORMS || options.open?.includes(row.id))
  // Las elegidas, en el orden en que se empezaron: el número de cada pregunta no salta entre pausas.
  chosen.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return formQuestionsOf(chosen.map((row) => ({ id: row.id, title: row.title, snapshot: row.snapshot, answers: (row.answers ?? {}) as Record<string, unknown> })))
}

/**
 * Las preguntas que lee Clío de unas fichas empezadas, numeradas en ese orden.
 * Es la regla de `dictationFormQuestions` sin la base: la usa también la
 * medición (`eval:dictado` con fichas), para medir lo mismo que corre.
 */
export function formQuestionsOf(
  forms: ReadonlyArray<{ id: string; title: string | null; snapshot: unknown; answers: Record<string, unknown> }>,
): DictationFormQuestion[] {
  const questions: DictationFormQuestion[] = []
  for (const form of forms) {
    let fields: FormFieldDef[]
    try {
      fields = assertFormSchema(form.snapshot).sections.flatMap((section) => section.fields)
    } catch {
      continue
    }
    const answers = form.answers
    fields.forEach((field, order) => {
      if (questions.length >= DICTATION_MAX_FORM_QUESTIONS) return
      if (!(DICTATION_FORM_TYPES as readonly string[]).includes(field.type)) return
      const parent = field.showIf ? fields.find((item) => item.id === field.showIf?.field) : undefined
      // La que depende de una ya respondida que la oculta no se ve: no se pregunta.
      if (field.showIf && !isEmpty(answers[field.showIf.field]) && !conditionMet(field.showIf, answers[field.showIf.field])) return
      questions.push({
        number: questions.length + 1,
        responseId: form.id,
        formTitle: form.title ?? "Ficha",
        fieldId: field.id,
        label: field.label,
        type: field.type as DictationFormType,
        options: field.options ?? null,
        unit: field.unit ?? null,
        min: field.min ?? null,
        max: field.max ?? null,
        order,
        dependsOn: field.showIf && parent ? { fieldId: parent.id, label: parent.label, equals: field.showIf.equals } : null,
        siblings: fields.filter((item) => item.id !== field.id).map((item) => ({ label: item.label, type: item.type, options: item.options ?? null })),
        ...(isEmpty(answers[field.id]) ? {} : { answered: answers[field.id] }),
      })
    })
  }
  return questions
}

/* ---------- Comprobar lo propuesto contra la frase dicha ---------- */

/** De qué ficha son los términos de una pregunta: sus rótulos y opciones, los mismos para todas las de su ficha. */
const vocabularyKeys = new WeakMap<DictationFormQuestion, string>()
/** Los términos de cada ficha, por esa clave: salen de la plantilla, no de lo dictado. */
const vocabularies = new Map<string, HeardVocabulary>()

function vocabularyKeyOf(question: DictationFormQuestion): string {
  let key = vocabularyKeys.get(question)
  if (key === undefined) {
    key = [question, ...(question.siblings ?? [])]
      .flatMap((item) => [item.label, ...(item.options ?? [])])
      .sort()
      .join("\u0000")
    vocabularyKeys.set(question, key)
  }
  return key
}

/** Los términos de la ficha de una pregunta (su rótulo, sus opciones y los de sus hermanas), como los lee `asHeard`. */
export function heardVocabularyOf(question: DictationFormQuestion): HeardVocabulary {
  const key = vocabularyKeyOf(question)
  let vocabulary = vocabularies.get(key)
  if (!vocabulary) {
    if (vocabularies.size >= 100) vocabularies.clear()
    vocabulary = formVocabulary([question, ...(question.siblings ?? [])])
    vocabularies.set(key, vocabulary)
  }
  return vocabulary
}

/**
 * Lo último leído, por ficha y texto. Chrome no pone puntos: un tramo de
 * minutos es una sola oración, y en una pausa se lee con cada pregunta y cada
 * respuesta (medido el 15 nov: hasta 1,4 s por pausa sin esto). Solo en memoria
 * y pocas entradas, que la pausa siguiente reemplaza.
 */
const lastHeard = new Map<string, string>()
const LAST_HEARD = 32

/**
 * Lo dicho leído con los términos de la ficha de la pregunta (`asHeard`): «volar
 * derecha» es «molar derecha», «sé o d» es «ceod». Solo para comprobar; lo que
 * se muestra sigue siendo lo dictado (prueba con voz del 15 nov). Se lee una vez
 * en cada entrada (la propuesta, la oración de la red, el motivo); lo de adentro
 * recibe lo ya leído.
 */
function heardBy(question: DictationFormQuestion, text: string): string {
  if (!text) return text
  const key = `${vocabularyKeyOf(question)}\u0001${text}`
  const cached = lastHeard.get(key)
  if (cached !== undefined) return cached
  const heard = asHeard(text, heardVocabularyOf(question))
  if (lastHeard.size >= LAST_HEARD) lastHeard.delete(lastHeard.keys().next().value as string)
  lastHeard.set(key, heard)
  return heard
}

/** Las oraciones de lo dictado: la misma división para todo lo que mira una oración. */
const sentencesOf = (text: string) => text.split(/(?<=[.;!?\n])\s+/)

/** «A», «A o B», «A, B y C». */
const listOf = (names: readonly string[], last: "y" | "o") => (names.length > 1 ? `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}` : (names[0] ?? ""))

const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
}
const TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
}
const TENS: Record<string, number> = {
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
}
/** Cómo se dice cada unidad, sin tildes, por magnitud: la de una ficha y las otras de su magnitud, que no se convierten. */
const UNITS_SAID: Record<string, Record<string, readonly string[]>> = {
  longitud: { mm: ["mm", "milimetro", "milimetros"], cm: ["cm", "centimetro", "centimetros"], m: ["metro", "metros"] },
  masa: { kg: ["kg", "kilo", "kilos", "kilogramo", "kilogramos"], g: ["g", "gramo", "gramos"], lb: ["libra", "libras"] },
}
/** Las unidades que pueden ir entre el número y su «y medio» («quince kilos y medio»), o tras «medio» («medio milímetro»). */
const UNIT_WORDS = new Set(Object.values(UNITS_SAID).flatMap((units) => Object.values(units).flat()))
const wordsPattern = (words: readonly string[]) => new RegExp(`\\b(${words.join("|")})\\b`)
/** Por unidad de una ficha: cómo se dice («18 kg» nombra el peso) y cómo se dicen las otras de su magnitud (no se proponen). */
const UNIT_SAID: Record<string, RegExp> = {}
const OTHER_UNITS: Record<string, RegExp> = {}
for (const units of Object.values(UNITS_SAID)) {
  for (const [unit, words] of Object.entries(units)) {
    UNIT_SAID[unit] = wordsPattern(words)
    OTHER_UNITS[unit] = wordsPattern(Object.entries(units).flatMap(([other, said]) => (other === unit ? [] : said)))
  }
}
/** Las muletillas de quien dicta («digamos», «este», «a ver», «o sea»): no dicen nada de la pregunta (prueba con voz del 15 nov). */
const MULETILLAS = new Set(["digamos", "este", "eh", "ehh", "mmm", "emm", "osea", "sea", "ver", "bueno", "pues"])
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }
/**
 * Lo que dice que un número es un tiempo: «hace 2 años», «desde hace tres días». Un tiempo no
 * responde una intensidad, un conteo ni una medida en mm o kg (prueba con voz del 15 nov, c4, v07:
 * «Hace 2 años» quedaba lista como «Intensidad del dolor: 2»).
 */
const TIME_WORDS = new Set(["ano", "anos", "mes", "meses", "semana", "semanas", "dia", "dias", "hora", "horas", "minuto", "minutos", "segundo", "segundos"])

/**
 * Los números que se dijeron en una frase, con sus repeticiones: en cifras
 * («6», «6,5», «-2»), en palabras («seis», «cuarenta y seis», «veintiséis»,
 * «seis y medio», «seis coma cinco», «menos dos») y, con `roman`, en romanos
 * sueltos («Clase II»: así se escriben las opciones; «largos», solo los de dos
 * letras o más, para lo dictado). Con `times: false`, sin los que son un tiempo
 * («hace 2 años»: el número que sigue una unidad de tiempo).
 */
export function saidNumbers(text: string, options: { roman?: "todos" | "largos"; articles?: boolean; times?: boolean } = {}): number[] {
  const found: number[] = []
  if (options.roman) {
    // En lo dictado o escrito, una «I» suelta es casi siempre otra cosa: ahí solo los de dos letras o más («clase II»).
    const pattern = options.roman === "todos" ? /\b(I{1,3}|IV|VI{0,3}|IX|X)\b/g : /\b(II|III|IV|VI|VII|VIII|IX)\b/g
    for (const match of text.matchAll(pattern)) {
      const value = ROMAN[match[1] ?? ""]
      if (value !== undefined) found.push(value)
    }
  }
  // El punto queda solo como decimal («6.5»): el que cierra una frase («tres.») no es parte del número.
  const words = plain(text)
    .replace(/(\d),(\d)/g, "$1.$2")
    .split(/[^a-z0-9.-]+/)
    .map((word) => word.replace(/^[.-]+(?=\D)|\.+$/g, ""))
    .filter(Boolean)
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ""
    // «una clase dos», «un diente»: el artículo no es el número 1 cuando se elige una opción.
    if (options.articles === false && (word === "un" || word === "una")) continue
    // «medio milímetro»: la mitad de esa unidad.
    if (word === "medio" && UNIT_WORDS.has(words[index + 1] ?? "")) {
      found.push(0.5)
      continue
    }
    // «al menos dos», «por lo menos dos»: no es un número negativo.
    const negative = word === "menos" && words[index - 1] !== "al" && words[index - 1] !== "lo"
    const at = negative ? index + 1 : index
    const read = readNumber(words, at)
    if (!read) continue
    let value = read.value
    let next = read.next
    // «seis y medio», «seis coma cinco», «seis punto cinco».
    // «seis y medio», también con la unidad en medio: «quince kilos y medio».
    const half = UNIT_WORDS.has(words[next] ?? "") && words[next + 1] === "y" && words[next + 2] === "medio" ? next + 1 : next
    if (words[half] === "y" && words[half + 1] === "medio") {
      value += 0.5
      next = half + 2
    } else if ((words[next] === "coma" || words[next] === "punto") && words[next + 1] !== undefined) {
      const decimal = readNumber(words, next + 1)
      if (decimal && decimal.value < 100) {
        value = Number(`${Math.trunc(value)}.${decimal.value}`)
        next = decimal.next
      }
    }
    if (options.times !== false || !TIME_WORDS.has(words[next] ?? "")) found.push(negative ? -value : value)
    index = next - 1
  }
  return found
}

/**
 * Las piezas dichas dígito a dígito, como en el odontograma: «la cuatro seis»
 * es la 46, además de un 4 y un 6.
 */
function toothNumbersIn(text: string): number[] {
  const words = plain(text).split(/[^a-z0-9]+/).filter(Boolean)
  const digit = (word: string | undefined) => (word !== undefined && /^[1-9]$/.test(word) ? Number(word) : word !== undefined && word !== "un" && word !== "una" && word in UNITS ? (UNITS[word] ?? 0) : 0)
  const found = saidNumbers(text)
  for (let index = 0; index + 1 < words.length; index += 1) {
    const tens = digit(words[index])
    const unit = digit(words[index + 1])
    if (tens >= 1 && tens <= 8 && unit >= 1 && unit <= 8) found.push(tens * 10 + unit)
  }
  return found
}

/** Un número que empieza en `at`: cifras o palabras; `null` si ahí no hay uno. */
function readNumber(words: string[], at: number): { value: number; next: number } | null {
  const word = words[at]
  if (word === undefined) return null
  if (/^-?\d+(\.\d+)?$/.test(word)) return { value: Number(word), next: at + 1 }
  if (word === "cien") return { value: 100, next: at + 1 }
  // «ciento quince»: una talla en centímetros.
  if (word === "ciento") {
    const rest = readNumber(words, at + 1)
    return rest && rest.value < 100 ? { value: 100 + rest.value, next: rest.next } : { value: 100, next: at + 1 }
  }
  if (word in TEENS) return { value: TEENS[word] ?? 0, next: at + 1 }
  const joined = /^veinti(uno|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve)$/.exec(word)
  if (joined?.[1]) return { value: 20 + (UNITS[joined[1]] ?? 0), next: at + 1 }
  if (word in TENS) {
    const unit = words[at + 1] === "y" ? words[at + 2] : undefined
    if (unit !== undefined && unit in UNITS && UNITS[unit] !== 0) return { value: (TENS[word] ?? 0) + (UNITS[unit] ?? 0), next: at + 3 }
    return { value: TENS[word] ?? 0, next: at + 1 }
  }
  if (word in UNITS) return { value: UNITS[word] ?? 0, next: at + 1 }
  return null
}

/** ¿Están todos los de `wanted` entre los dichos, contando repeticiones? */
function containsAll(said: number[], wanted: number[]): boolean {
  const left = [...said]
  for (const value of wanted) {
    const at = left.findIndex((item) => Math.abs(item - value) < 1e-9)
    if (at < 0) return false
    left.splice(at, 1)
  }
  return true
}

/** Los números de una opción, también los romanos y los dichos en palabras («Clase II división 1»: 2 y 1). */
const optionNumbers = (option: string) => saidNumbers(option, { roman: "todos" })

/** Las negaciones de la frase (`NEGATION_WORDS`): «sin embargo» no niega nada. */
const negationsOf = (said: string) =>
  plain(said)
    .replace(/\bsin embargo\b/g, "")
    .split(/[^a-z]+/)
    .filter((word) => NEGATION_WORDS.has(word))

/** ¿Se negó algo en la frase? Un «No» solo se propone si se negó en voz alta: el silencio no es «No». */
const denies = (said: string) => negationsOf(said).length > 0
/** Una opción que dice que no hay nada: «No», «No tiene», «Negativa», «Ninguno», «Ausente». */
const isNegativeOption = (option: string) => /^(no|sin|ningun[oa]?|nada|negativ[oa]|ausente)\b/.test(plain(option))
/** Cómo se dice en la consulta lo que la opción nombra con su término: «se come las uñas» es onicofagia (prueba con voz del 15 nov). */
const SAID_AS: Record<string, RegExp> = {
  onicofagia: /\b(come|comia|muerde|mordia)n? las unas\b/,
  "succion digital": /\b(chupa|chupaba|succiona)n? (el|los) dedos?\b/,
  bruxismo: /\b(rechina|aprieta)n? los dientes\b/,
  "respiracion bucal": /\b(duerme|respira|respirando)n? (con la boca abierta|por la boca)\b/,
}
/** La opción de una prueba que dio positiva: «Positiva», «Positivo». */
const isPositiveOption = (option: string) => /^positiv[oa]\b/.test(plain(option))

/**
 * «Dolor a la percusión», «duele a la palpación», «dolor al palpar»: esa prueba
 * es positiva, como se dice en la clínica (medición del 15 nov). Solo si lo que
 * sigue al dolor es la pregunta («dolor a la percusión» no dice nada de la
 * palpación) y no se negó nada en la frase.
 */
function painOnTest(question: DictationFormQuestion, said: string): boolean {
  if (denies(said)) return false
  return [...plain(said).matchAll(PAIN_ON)].some((match) => isTestOf(question, match[1]))
}

/** El dolor a algo, sobre lo dicho sin tildes: «(sin) dolor a la percusión», «duele al palpar». */
const PAIN_ON = /\b(?:sin\s+)?(?:dolor|duele)\s+al?\s+(?:la\s+)?([a-z]+)/g
/** ¿Esa palabra es la de la pregunta? («percusión» de «Percusión», «palpar» de «Palpación».) */
const isTestOf = (question: DictationFormQuestion, word: string | undefined) => {
  const stem = stemsOf(word ?? "")[0]
  return !!stem && labelStems(question.label).includes(stem)
}

/** Palabras que no distinguen una pregunta ni una opción. */
const FILLER = new Set(["del", "las", "los", "con", "por", "para", "que", "una", "uno", "angle", "mas", "unos", "unas", "casi", "cerca", "alrededor", "aproximadamente", "aprox"])
/** Las raíces de las palabras de un texto (sus 5 primeras letras): «molares» y «molar», «desviada» y «desviación». */
const stemsOf = (text: string) => [
  ...new Set(
    plain(text)
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 3 && !FILLER.has(word))
      .map((word) => word.slice(0, 5)),
  ),
]

/** Las raíces de una etiqueta sin lo que va entre paréntesis («(Angle)», «(tracto sinusal)», «(mm)»). */
const labelStems = (label: string) => stemsOf(label.replace(/\([^)]*\)/g, " "))

/**
 * ¿La frase habla de esta pregunta? Lo que la distingue de una hermana del
 * mismo tipo (el lado, canina o molar, superior o inferior, CPOD o ceod) tiene
 * que estar dicho, y si se nombra su primera palabra («mordida») sin ninguna
 * de las otras («cruzada»), habla de otra cosa («mordida abierta»).
 */
function talksAbout(question: DictationFormQuestion, said: Set<string>): boolean {
  const own = labelStems(question.label)
  // Las hermanas del mismo tipo: «Clase canina derecha» y «Clase molar derecha» se distinguen por
  // «canina», aunque sus opciones no sean las mismas («la derecha en clase dos» no elige ninguna).
  // Si no comparten ninguna opción, la opción dicha ya dice cuál es («pulpitis irreversible» es
  // el diagnóstico pulpar, no el apical).
  const shares = (item: { options: string[] | null }) =>
    !question.options || !item.options || question.options.some((option) => item.options?.includes(option))
  const twins = (question.siblings ?? []).filter((item) => item.type === question.type && shares(item))
  for (const twin of twins) {
    const theirs = labelStems(twin.label)
    const shared = own.filter((stem) => theirs.includes(stem))
    const diff = own.filter((stem) => !theirs.includes(stem))
    if (shared.length >= 1 && diff.length >= 1 && diff.length <= 2 && !diff.some((stem) => said.has(stem))) return false
  }
  return true
}

/**
 * ¿La frase (ya leída, `heardBy`) nombra otra cosa con la primera palabra de la pregunta? «mordida
 * abierta» no es «Mordida cruzada», ni «riesgo de caries» es «Riesgo
 * estomatológico»: la palabra que sigue no es de la pregunta ni de sus opciones.
 * «intensidad ocho», «higiene regular» o «sondaje de cuatro» sí hablan de ella.
 */
function namesAnother(question: DictationFormQuestion, text: string): boolean {
  // Un sí o no se dice con su complemento («vacunas completas»): ahí no se mira.
  if (question.type === "booleano") return false
  const [head, ...rest] = labelStems(question.label)
  if (!head || rest.length === 0) return false
  // Lo que es de la ficha no nombra otra cosa: «desviada a la izquierda» es de la línea media.
  const ficha = (question.siblings ?? []).flatMap((item) => [...labelStems(item.label), ...(item.options ?? []).flatMap(stemsOf)])
  const known = new Set([...rest, ...(question.options ?? []).flatMap(stemsOf), ...ficha])
  const words = plain(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => (word.length >= 3 && !FILLER.has(word) && !MULETILLAS.has(word)) || /^[0-9]+$/.test(word))
  return words.some((word, index) => {
    if (stemsOf(word)[0] !== head) return false
    const next = words[index + 1]
    if (!next || /^[0-9]+$/.test(next) || saidNumbers(next).length > 0) return false
    const stem = stemsOf(next)[0]
    return !!stem && !known.has(stem)
  })
}

/** Un número dicho como aproximado: no se propone como exacto. */
const APPROXIMATE = /\b(al menos|por lo menos|mas de|menos de|unos|unas|aproximadamente|aprox|alrededor de|cerca de|casi)\b/

const TRUE_WORDS = new Set(["si", "true", "verdadero"])
const FALSE_WORDS = new Set(["no", "false", "falso"])

/** Una sugerencia de ficha lista para guardar: su valor ya tipado, o por revisar con su motivo. */
export interface PreparedFormAnswer {
  payload: Record<string, unknown>
  status: "lista" | "por_revisar"
  note: string | null
  /** La frase que se muestra, si no es la que citó Clío: la del número que se usó (`numberPhrase`). */
  said?: string
}

const shortSaid = (said: string) => (said.length > 80 ? `${said.slice(0, 77)}…` : said)

/**
 * Comprueba la respuesta que propuso Clío contra la pregunta y contra lo que
 * de verdad se dijo, y la deja tipada como la guarda la ficha. `null`: no se
 * propone (sin frase, otra pregunta, un número que no se dijo, un «No» que no
 * se negó, otra unidad). Lo que se dijo pero no alcanza para elegir (la clase
 * II sin su división), o un número fuera del rango de la pregunta, queda por
 * revisar: se ve en la pregunta y lo elige el profesional. Sobre una pregunta
 * ya respondida, solo si dice otra cosa, y siempre por revisar: lo escrito lo
 * cambia una persona.
 */
export function prepareFormAnswer(
  draft: FormAnswerDraft,
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  /** Lo dictado en la pausa: la oración de la frase dice de qué pregunta habla («CPOD: cinco cariados»). */
  transcript?: string,
): PreparedFormAnswer | null {
  const checked = checkWithWritten(draft, questions, site, transcript)
  if (!draft.reread || !checked) return checked
  // La segunda lectura de una oración de la red: solo un valor que calza, y siempre por revisar.
  // Sin valor no se propone: el aviso de la red se queda. Su frase tiene que estar en lo que la
  // oración dice de esa pregunta: sin puntos, la oración releída puede ser todo lo dictado, y en ella
  // «de 6 no perdón de 4 mm» es del overjet, no del overbite (prueba con voz del 15 nov, c3, v02).
  if (checked.payload["value"] == null) return null
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!question || !saidAboutQuestion(question, questions, site, draft.sourceText ?? "", transcript)) return null
  return { ...checked, payload: { ...checked.payload, reread: true }, status: "por_revisar", note: checked.note ?? REREAD_NOTE }
}

/**
 * ¿La frase habla de esta pregunta? La nombra («dolor a la percusión») o está en lo que su oración
 * dice de ella: si la oración nombra otra del mismo tipo de su ficha, entre el término de esta y el
 * de la otra (`spansOf`, como la red); si no, en cualquier parte de la oración.
 */
function saidAboutQuestion(question: DictationFormQuestion, questions: readonly DictationFormQuestion[], site: ProductSite, said: string, transcript: string | undefined): boolean {
  if (namesQuestion(question, heardBy(question, said), site)) return true
  const sentence = sentenceOf(transcript, said) || said
  const others = questions.filter(
    (other) => other !== question && other.responseId === question.responseId && other.type === question.type && namesQuestion(other, heardBy(other, sentence), site),
  )
  const phrase = plain(heardBy(question, said))
  return spansOf(question, others, heardBy(question, sentence)).some((span) => plain(span).includes(phrase))
}

/** La respuesta de ficha que propone Clío, con la frase de la que sale. */
export interface FormAnswerDraft {
  payload: Record<string, unknown>
  sourceText?: string | undefined
  /** De la segunda lectura de una oración que la red avisó (`formNetMisses`): queda por revisar. */
  reread?: boolean | undefined
}

/** Una sugerencia del dictado, de cualquier clase, como la miran las fichas. */
type FormDraftLike = FormAnswerDraft & { kind: string }

/** Lo que dice la propuesta de la segunda lectura en su pregunta. */
const REREAD_NOTE = "La leí de nuevo en lo que dictaste: revísala antes de confirmarla."

/** `prepareFormAnswer` sin la segunda lectura: la comprobación y lo ya escrito. */
function checkWithWritten(draft: FormAnswerDraft, questions: readonly DictationFormQuestion[], site: ProductSite, transcript?: string): PreparedFormAnswer | null {
  const question = questions.find((item) => item.number === draft.payload["question"])
  // La ficha de otra pieza no recibe lo dictado para esta (revisión final del 15 nov, A4).
  if (question && otherToothOf(question, questions, site, draft.sourceText, transcript) !== null) return null
  const proposed = checkFormAnswer(draft, questions, site, sentenceOf(transcript, draft.sourceText))
  if (!proposed || question?.answered === undefined) return proposed
  const value = proposed.payload["value"]
  if (value === null || value === undefined || sameAnswer(value, question.answered)) return null
  // Lo que cambia una respuesta ya escrita («corrijo, es división uno») queda siempre por revisar:
  // lo escrito lo cambia una persona, en su pregunta y de a una (revisión final del 15 nov,
  // decisión 2). No entra con «Confirmar las N» y al firmar viene desmarcada. Solo cambia si la
  // pregunta sigue diciendo lo que decía (`replaces`); si no, gana lo escrito.
  const now = formAnswerWords({ value: question.answered, unit: question.unit })
  return {
    ...proposed,
    payload: { ...proposed.payload, replaces: question.answered },
    status: "por_revisar",
    note: `Ya dice «${now}».`,
  }
}

/** Una respuesta de ficha que cambia lo ya escrito: queda por revisar y se cambia de a una. */
export const changesWrittenAnswer = (payload: Record<string, unknown>): boolean => payload["replaces"] !== undefined && payload["value"] != null


/** Lo que nombra una pieza delante de su número: «la 46», «pieza cuarenta y seis», «en la cuatro seis». */
const TOOTH_WORDS = new Set(["la", "pieza", "piezas", "diente", "molar", "premolar", "canino", "incisivo"])

/**
 * Las piezas que se nombran en un texto, solo con su palabra delante («en la
 * cuarenta y seis», «pieza 36», «la cuatro seis»): así «sondaje de doce» o
 * «quince sobre diez» no son piezas. Solo las que existen en el producto.
 */
function teethIn(text: string, site: ProductSite): number[] {
  const words = plain(text).split(/[^a-z0-9]+/).filter(Boolean)
  const found = new Set<number>()
  const valid = (value: number) => Number.isInteger(value) && value >= 11 && site.code(value) !== null
  for (let index = 1; index < words.length; index += 1) {
    if (!TOOTH_WORDS.has(words[index - 1] ?? "")) continue
    const read = readNumber(words, index)
    if (!read) continue
    // Dígito a dígito, como en el odontograma: «la cuatro seis» es la 46.
    const unit = read.value >= 1 && read.value <= 8 ? readNumber(words, read.next) : null
    const value = unit && unit.value >= 1 && unit.value <= 8 ? read.value * 10 + unit.value : read.value
    if (valid(value)) found.add(value)
  }
  return [...found]
}

/**
 * La pieza dicha cuando no es la de la ficha (revisión final del 15 nov, A4):
 * la ficha tiene su «Pieza» escrita (la 36) y lo dicho habla de otra (la 46).
 * Manda la oración de la frase; si no nombra ninguna, lo dictado en la pausa.
 * `null`: la ficha no tiene pieza escrita, o se habló de la suya.
 */
export function otherToothOf(
  question: DictationFormQuestion,
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  said: string | undefined,
  transcript: string | undefined,
): { form: number; said: number } | null {
  if (question.type === "pieza") return null
  const own = questions.find((item) => item.responseId === question.responseId && item.type === "pieza" && item.answered !== undefined)
  const form = Number(own?.answered)
  if (!own || !Number.isInteger(form)) return null
  const near = teethIn(`${sentenceOf(transcript, said)} ${said ?? ""}`, site)
  const teeth = near.length ? near : teethIn(transcript ?? "", site)
  const other = teeth.find((tooth) => tooth !== form)
  return other !== undefined && !teeth.includes(form) ? { form, said: other } : null
}

/**
 * Por qué lo dicho para una ficha no quedó como propuesta, para «No pude usar
 * esto»: la frase no se pierde en silencio (QA del 14 nov, D21).
 */
export function formAnswerDropReason(
  draft: FormAnswerDraft,
  questions: readonly DictationFormQuestion[],
  /** Con el producto y lo dictado en la pausa se dice también la pieza que no es la de la ficha. */
  where?: { site: ProductSite; transcript?: string | undefined },
): string | null {
  return dropReasonOf(draft, questions, where)?.why ?? null
}

/**
 * El motivo de lo parado y las preguntas que nombra, para «Usar en…» de «No
 * pude usar esto»: la suya, o ella y sus hermanas si no quedó claro cuál. Sin
 * ninguna cuando no hay dónde escribirlo (la pregunta ya no está libre, la
 * ficha es de otra pieza).
 */
function dropReasonOf(
  draft: FormAnswerDraft,
  questions: readonly DictationFormQuestion[],
  where?: { site: ProductSite; transcript?: string | undefined },
): { why: string; questions: number[] } | null {
  // Lo de la segunda lectura que no calzó no tiene otro motivo: la red sigue avisando su oración.
  if (draft.reread) return null
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!question) return { why: "Esa pregunta ya no estaba libre en la ficha: respóndela ahí.", questions: [] }
  const about = (why: string, numbers = [question.number]) => ({ why, questions: numbers })
  const said = draft.sourceText ?? ""
  // Lo que repite lo ya escrito («clase dos división dos» donde ya dice eso) no es algo que no se pudo usar.
  // Ni el pedazo de otra prueba («sin dolor» de «sin dolor a la percusión»): no era de esta pregunta.
  if (where && saysWritten(question, said, questions, where.site, sentenceOf(where.transcript, said), question.answered)) return null
  if (partOfOtherTest(question, said, sentenceOf(where?.transcript, said))) return null
  const tooth = where ? otherToothOf(question, questions, where.site, said, where.transcript) : null
  if (tooth) return about(`«${question.formTitle}» es de la ${tooth.form} y dijiste la ${tooth.said}: no la llené. Escríbelo tú o empieza otra ficha para la ${tooth.said}.`, [])
  // Lo que dice dos preguntas hermanas por igual («cariados tres»: ¿del CPOD o del ceod?) no se pierde
  // en silencio: se dice entre cuáles (revisión final del 15 nov, U5).
  const heard = heardBy(question, said)
  const spoken = new Set(stemsOf(heard))
  const own = labelStems(question.label)
  const twins = questions.filter((other) => {
    if (other === question || other.responseId !== question.responseId || other.type !== question.type) return false
    const theirs = labelStems(other.label)
    const shared = own.filter((stem) => theirs.includes(stem))
    const diff = own.filter((stem) => !theirs.includes(stem))
    // Hermanas que se distinguen en una sola palabra (CPOD o ceod), con todo lo demás dicho.
    return shared.length > 0 && shared.every((stem) => spoken.has(stem)) && diff.length === 1 && !diff.some((stem) => spoken.has(stem))
  })
  if (twins.length > 0) {
    const named = [question, ...twins]
    return about(`No quedó claro si era ${listOf(named.map((item) => `«${item.label}»`), "o")}: nómbrala o escríbela en la ficha.`, named.map((item) => item.number))
  }
  // El número de Clío que es lo dicho con menos decimales no se pierde en silencio, aunque la frase no
  // nombre la pregunta (prueba con voz del 15 nov, c5, v12: Chrome oyó «ese Este 0,99» y Clío propuso 0,9).
  if (fewerDecimals(question, draft, heard, sentenceOf(where?.transcript, said))) return about(`Dijiste «${shortSaid(said)}»: revisa los decimales.`)
  // La frase que no nombra la pregunta no era de la ficha («el diagnóstico es maloclusión clase dos»
  // no nombra «Clase molar derecha»): no se avisa como si lo fuera. La misma regla que la red (`labelNamed`).
  if (!labelNamed(question, heard, where?.site)) return null
  const unit = question.unit ? OTHER_UNITS[plain(question.unit)] : undefined
  if (question.unit && unit?.test(plain(said))) return about(`«${question.label}» va en ${question.unit}: dilo en ${question.unit} o escríbelo en la ficha.`)
  if (!talksAbout(question, spoken)) return about(`No quedó claro si era «${question.label}»: nómbrala (con su lado, si lo tiene) o escríbela en la ficha.`)
  return about(`No alcanzó para responder «${question.label}»: dilo con el valor o escríbelo en la ficha.`)
}

/** Cuántos decimales tiene un número. */
const decimalsOf = (value: number) => String(value).split(".")[1]?.length ?? 0

/**
 * ¿El número que propuso Clío no se dijo, pero sí uno con más decimales que da ese al cortarlo o
 * redondearlo? «0,99» oído y 0,9 propuesto; «quince kilos y medio» y 15. Chrome a veces escribe una
 * cifra de más; Clío a veces la quita.
 */
function fewerDecimals(question: DictationFormQuestion, draft: FormAnswerDraft, said: string, sentence: string): boolean {
  if (question.type !== "numero" && question.type !== "escala") return false
  const raw = String(draft.payload["answer"] ?? "").trim()
  const proposed = Number(raw.replace(",", "."))
  if (!raw || !Number.isFinite(proposed)) return false
  const numbers = saidNumbers(`${said} ${wordsAfter(said, sentence, 1)}`, { roman: "largos", times: false })
  if (numbers.includes(proposed)) return false
  const places = decimalsOf(proposed)
  const step = 10 ** -places
  // Cortado, lo dicho queda en [propuesto, propuesto + paso); redondeado, desde medio paso antes.
  return numbers.some((number) => decimalsOf(number) > places && number - proposed > -step / 2 - 1e-9 && number - proposed < step)
}

/**
 * ¿La frase dice lo que la pregunta ya tiene escrito? («overjet de seis» con 6
 * escrito.) Se comprueba como una propuesta de ese mismo valor: no hay nada que
 * cambiar ni que avisar.
 */
function saysWritten(
  question: DictationFormQuestion,
  said: string,
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  sentence: string,
  /** Lo que ya tiene: lo escrito, o lo que propone una sugerencia pendiente. */
  written: unknown,
): boolean {
  if (written === undefined || written === null) return false
  const payload = Array.isArray(written) ? { question: question.number, answers: written.map(String) } : { question: question.number, answer: String(written) }
  const check = checkFormAnswer({ payload, sourceText: said }, questions, site, sentence)
  return check?.status === "lista" && sameAnswer(check.payload["value"], written)
}

/** Lo dicho sin tildes y sin el dolor a otra prueba: «sin dolor a la percusión» no es de la pregunta «Dolor». */
const withoutOtherTests = (question: DictationFormQuestion, said: string) =>
  plain(said).replace(PAIN_ON, (phrase, test: string) => (isTestOf(question, test) ? phrase : " "))

/** ¿Lo dicho es un pedazo del dolor a otra prueba de su oración? («Sin dolor» de «Sin dolor a la percusión».) */
function partOfOtherTest(question: DictationFormQuestion, said: string, sentence: string): boolean {
  const part = plain(said).replace(/[\s.,;:!?…]+$/u, "")
  return !!part && [...plain(sentence).matchAll(PAIN_ON)].some((match) => !isTestOf(question, match[1]) && match[0].includes(part))
}

/**
 * ¿Lo dicho nombra la pregunta? Su rótulo sin lo de entre paréntesis (de
 * varias palabras, al menos dos dichas) o el nombre propio que lleva entre
 * paréntesis («Frankl», «IHO-S»), que basta solo; con el producto, la pieza
 * también se nombra con su número y su palabra delante («la 46», `teethIn`).
 * Una palabra dicha es la de la pregunta o una forma de ella («molares»,
 * «desviada»), no otra más larga que empieza igual: «conductometría» no es
 * «Conducta». La usan el motivo de lo parado y la red.
 */
function labelNamed(question: DictationFormQuestion, heard: string, site?: ProductSite): boolean {
  if (question.type === "pieza" && site && teethIn(heard, site).length) return true
  const words = meaningful(withoutOtherTests(question, heard))
  const spoken = (word: string) => words.some((item) => item.slice(0, 5) === word.slice(0, 5) && item.length <= word.length + 3)
  const own = meaningful(question.label.replace(/\([^)]*\)/g, " "))
  const proper = [...question.label.matchAll(/\(([^)]*)\)/g)].flatMap((match) => [...(match[1] ?? "").matchAll(/\p{Lu}[\p{L}-]*/gu)].flatMap((name) => meaningful(name[0])))
  // La palabra del rótulo que ninguna otra pregunta de la ficha tiene basta sola: «intensidad», «frío», «sondaje».
  const others = new Set((question.siblings ?? []).flatMap((item) => meaningful(item.label.replace(/\([^)]*\)/g, " ")).map((word) => word.slice(0, 5))))
  // No si también es de sus opciones: «clase» de «Clase molar derecha» está en «Clase II», y «maloclusión clase dos» no es de ella.
  const options = new Set((question.options ?? []).flatMap(stemsOf))
  const distinctive = own.filter((word) => !others.has(word.slice(0, 5)) && !options.has(word.slice(0, 5)))
  // Sola, con sus siete primeras letras: «odontograma» no es «odontológica».
  const close = (word: string) => words.some((item) => item.startsWith(word.slice(0, 7)) && item.length <= word.length + 3)
  return (own.length > 0 && own.filter(spoken).length >= Math.min(2, own.length)) || distinctive.some(close) || proper.some(spoken)
}

/**
 * ¿La oración nombra esta pregunta y no otra? `labelNamed`, más lo que la
 * distingue de una hermana, dicho (`talksAbout`), y su primera palabra no
 * nombra otra cosa (`namesAnother`).
 */
function namesQuestion(question: DictationFormQuestion, heard: string, site: ProductSite): boolean {
  if (!labelNamed(question, heard, site)) return false
  const sentence = withoutOtherTests(question, heard)
  return talksAbout(question, new Set(stemsOf(sentence))) && !namesAnother(question, sentence)
}

/**
 * ¿La oración dice un valor para esta pregunta? Un número, la pieza, una
 * palabra de sus opciones que no es del rótulo, una negación si tiene una
 * opción de «no» o el dolor a la prueba; un sí o no se dice con solo
 * afirmarlo. «Percusión igual que la vez pasada» nombra la pregunta sin decir
 * nada que se pueda escribir en ella.
 */
function saysValue(question: DictationFormQuestion, sentence: string): boolean {
  if (question.type === "booleano") return true
  if (question.type === "pieza") return toothNumbersIn(sentence).length > 0
  if (question.type === "numero" || question.type === "escala") return saidNumbers(sentence).length > 0
  const options = question.options ?? []
  const label = new Set(labelStems(question.label))
  const spoken = new Set(stemsOf(sentence))
  const heard = saidNumbers(sentence, { roman: "largos", articles: false })
  return options.some(
    (option) =>
      stemsOf(option).some((stem) => !label.has(stem) && spoken.has(stem)) ||
      optionNumbers(option).some((number) => heard.includes(number)) ||
      (isNegativeOption(option) && denies(sentence)) ||
      (isPositiveOption(option) && painOnTest(question, sentence)),
  )
}

/** «Parece de «Percusión»: revísala en la ficha.»; con varias, «… «Pieza» y «Percusión»: revísalas…». */
function looksLike(labels: string[]): string {
  return `Parece de ${listOf(labels.map((label) => `«${label}»`), "y")}: ${labels.length > 1 ? "revísalas" : "revísala"} en la ficha.`
}

/**
 * La red de seguridad de las fichas (medición del 15 nov): la oración de lo
 * dictado que nombra una pregunta de una ficha empezada, con un valor, y no
 * dejó propuesta ni aviso para ella en la pausa va a «No pude usar esto» con
 * esa pregunta. Así un dato de la ficha no se pierde en silencio aunque el
 * modelo no lo haya propuesto o su frase no se encuentre en lo dictado. Lo que
 * repite lo ya escrito, o lo que ya propone una sugerencia pendiente, no avisa.
 * `questions`: los números de las preguntas que nombra.
 */
export function formSentencesWithoutAnswer(
  transcript: string | undefined,
  questions: readonly DictationFormQuestion[],
  /** Las preguntas (su número) que ya quedaron propuestas o avisadas en esta pausa. */
  handled: ReadonlySet<number>,
  site: ProductSite,
  /** Lo que proponen las sugerencias de ficha pendientes de otras pausas, por pregunta. */
  pending: ReadonlyMap<number, unknown> = new Map(),
): Array<{ said: string; why: string; questions: number[] }> {
  const open = questions.filter((question) => !handled.has(question.number))
  if (!transcript?.trim() || !open.length) return []
  return sentencesOf(transcript).flatMap((sentence) => {
    const said = sentence.trim()
    if (!said) return []
    const named = open.filter((question) => {
      const heard = heardBy(question, said)
      if (!namesQuestion(question, heard, site) || !saysValue(question, heard)) return false
      if (saysWritten(question, said, questions, site, said, pending.has(question.number) ? pending.get(question.number) : question.answered)) return false
      // Si la oración nombra también otra del mismo tipo de su ficha, el valor tiene que estar cerca de
      // lo que distingue a esta: en «línea media superior centrada la inferior desviada dos
      // milímetros», los dos milímetros no son de la superior.
      const others = questions.filter(
        (other) => other !== question && other.responseId === question.responseId && other.type === question.type && namesQuestion(other, heardBy(other, said), site),
      )
      return !others.length || spansOf(question, others, heard).some((part) => saysValue(question, part))
    })
    if (!named.length) return []
    // La misma pregunta en dos fichas empezadas (el ceod) se nombra una vez.
    return [{ said, why: looksLike([...new Set(named.map((question) => question.label))]), questions: named.map((question) => question.number) }]
  })
}

/**
 * Lo que va a «No pude usar esto» de las respuestas de ficha de una pausa: lo
 * que la comprobación paró, por dato y con su motivo (revisión final del 15
 * nov, U5), y la oración que nombra una pregunta sin propuesta ni aviso (la
 * red, `formSentencesWithoutAnswer`). `ready`: si quedó como propuesta. Las
 * gemelas agregadas que no pasan no son algo que no se pudo usar. Lo usan el
 * servidor y la medición.
 */
export function formDropNotices<T extends FormDraftLike>(
  outcomes: ReadonlyArray<{ draft: T; ready: boolean }>,
  twins: ReadonlySet<T>,
  questions: readonly DictationFormQuestion[],
  where: { site: ProductSite; transcript?: string | undefined },
  /** Lo que proponen las sugerencias de ficha pendientes de otras pausas, por pregunta (`null`: por elegir). */
  pending: ReadonlyMap<number, unknown> = new Map(),
): Array<{ said: string; why: string; questions: number[]; by: "motivo" | "red" }> {
  const notices: Array<{ said: string; why: string; questions: number[]; by: "motivo" | "red" }> = []
  // Una pendiente por elegir ya dice «revísala»: no se avisa otra vez.
  const handled = new Set([...pending].flatMap(([number, value]) => (value == null ? [number] : [])))
  for (const { draft, ready } of outcomes) {
    if (draft.kind !== "ficha") continue
    const number = Number(draft.payload["question"])
    if (ready) handled.add(number)
    if (ready || twins.has(draft) || !draft.sourceText?.trim()) continue
    const reason = dropReasonOf(draft, questions, where)
    if (!reason) continue
    handled.add(number)
    const question = questions.find((item) => item.number === number)
    for (const said of formAnswerFragments(draft.sourceText, question)) notices.push({ said, why: reason.why, questions: reason.questions, by: "motivo" })
  }
  const proposed = new Map([...pending].filter(([, value]) => value != null))
  for (const item of formSentencesWithoutAnswer(where.transcript, questions, handled, where.site, proposed)) notices.push({ ...item, by: "red" })
  return notices
}

/**
 * Las oraciones de lo dictado que la red avisaría (`formDropNotices`, «Parece
 * de «X»»), con sus preguntas: las que Clío lee una vez más, solas, antes de
 * guardar la pausa. La misma cuenta que al guardar (las gemelas, el diagnóstico
 * que también es de la ficha y lo que ya proponen las pendientes); la usan la
 * atención y la medición.
 */
export function formNetMisses<T extends FormDraftLike>(
  drafts: readonly T[],
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  transcript: string | undefined,
  /** Lo que proponen las sugerencias de ficha pendientes de otras pausas, por pregunta (`pendingFormValues`). */
  pending: ReadonlyMap<number, unknown> = new Map(),
): Array<{ said: string; questions: number[] }> {
  if (!questions.length || !transcript?.trim()) return []
  const all = withDiagnosisFormAnswers(drafts, questions)
  const { drafts: expanded, twins } = withFormTwins(all, questions)
  for (const draft of all.slice(drafts.length)) twins.add(draft)
  const outcomes = expanded
    .filter((draft) => draft.kind === "ficha")
    .map((draft) => ({ draft, ready: prepareFormAnswer(draft, questions, site, transcript) !== null }))
  return formDropNotices(outcomes, twins, questions, { site, transcript }, pending).flatMap((notice) => (notice.by === "red" ? [{ said: notice.said, questions: notice.questions }] : []))
}

/**
 * Lo que proponen las sugerencias de ficha pendientes, por el número de su
 * pregunta en esta pausa (`null`: la que pide elegir). La red no avisa lo que
 * ya está propuesto.
 */
export function pendingFormValues(
  pending: ReadonlyArray<{ kind: string; payload: Record<string, unknown> }>,
  questions: readonly DictationFormQuestion[],
): Map<number, unknown> {
  return new Map(
    pending
      .filter((item) => item.kind === "ficha")
      .flatMap((item) => {
        const question = questions.find((one) => one.responseId === item.payload["responseId"] && one.fieldId === item.payload["fieldId"])
        return question ? [[question.number, item.payload["value"] ?? null] as const] : []
      }),
  )
}

/**
 * La parte de la frase que dice esta respuesta, para resaltarla por dato y no
 * por frase (revisión final del 15 nov, U5): en «cariados tres, perdidos uno,
 * obturados dos», lo del P es «perdidos uno». Cada parte es un tramo tal cual de
 * la frase, así se encuentra en lo dictado. Si ninguna parte nombra la
 * pregunta, la frase entera.
 */
export function formAnswerFragments(said: string, question: DictationFormQuestion | undefined): string[] {
  const whole = said.trim()
  if (!question || !whole) return whole ? [whole] : []
  const parts = whole
    .split(/[,;.:]\s*|\s+y\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return [whole]
  const label = labelStems(question.label)
  const options = (question.options ?? []).flatMap(stemsOf)
  const own = parts.filter((part) => stemsOf(heardBy(question, part)).some((stem) => label.includes(stem) || options.includes(stem)))
  return own.length ? own : [whole]
}

/**
 * La misma respuesta para la pregunta gemela de otra ficha empezada (el ceod
 * en la odontopediátrica y en la odontoestomatológica): la misma clave o el
 * mismo rótulo, con el mismo tipo y opciones. Cada una se vuelve a comprobar
 * contra lo dicho (QA del 14 nov, E27).
 */
export function formAnswerTwins<T extends { payload: Record<string, unknown> }>(draft: T, questions: readonly DictationFormQuestion[]): T[] {
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!question) return []
  const same = (other: DictationFormQuestion) =>
    other.responseId !== question.responseId &&
    (other.fieldId === question.fieldId || plain(other.label) === plain(question.label)) &&
    other.type === question.type &&
    JSON.stringify(other.options ?? null) === JSON.stringify(question.options ?? null)
  return questions.filter(same).map((other) => ({ ...draft, payload: { ...draft.payload, question: other.number } }))
}

/**
 * Lo dicho de una pausa con las gemelas de cada respuesta de ficha
 * (`formAnswerTwins`) detrás de la suya. `twins`: las agregadas, que si no se
 * comprueban no son algo que no se pudo usar. Lo usan el servidor y la medición.
 */
export function withFormTwins<T extends { kind: string; payload: Record<string, unknown> }>(
  drafts: readonly T[],
  questions: readonly DictationFormQuestion[],
): { drafts: T[]; twins: Set<T> } {
  const twins = new Set<T>()
  const all = drafts.flatMap((draft) => {
    if (draft.kind !== "ficha") return [draft]
    const more = formAnswerTwins(draft, questions)
    for (const twin of more) twins.add(twin)
    return [draft, ...more]
  })
  return { drafts: all, twins }
}

/** Una frase que solo corrige lo anterior («No, el overjet es de cuatro», «Perdón, de cuatro», «Corrijo: …»). */
const CORRECTION = /^(no,\s|perd[oó]n\b|corrijo\b|mejor dicho\b|me equivoqu)/

/** Las palabras que dicen algo de una frase: sin las cortas ni las de relleno. */
const meaningful = (text: string) =>
  plain(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !FILLER.has(word))

/**
 * El texto de la consulta sin lo que fue para una ficha (verificación del 14
 * nov): se quita la oración que es la frase de la ficha, o casi solo eso, y la
 * que solo corrige («perdón…», «no, es…», «corrijo…»). La oración que además
 * dice otra cosa («dolor espontáneo desde hace tres días») se queda entera: la
 * evolución no pierde lo que sí es suyo. De ella sale solo la parte que repite lo
 * examinado que tomó la ficha (`ficha`, prueba con voz del 15 nov, c4): el hábito
 * dicho como se dice en la consulta («se come las uñas», de una onicofagia
 * elegida) o la frase de una respuesta tal cual («Higiene oral regular, con placa
 * en los molares» deja «Placa en los molares»).
 */
export function withoutFormPhrases(
  text: string,
  formPhrases: readonly string[],
  /** Lo examinado que tomó la ficha en la pausa: las frases de sus respuestas y las opciones elegidas. */
  ficha: { phrases?: readonly string[]; options?: readonly string[] } = {},
): string {
  const phrases = formPhrases.map((phrase) => plain(phrase).replace(/[.;,]+$/, "").trim()).filter((phrase) => phrase.length >= 4)
  const covered = new Set(phrases.flatMap(meaningful).map((word) => word.slice(0, 5)))
  const examined = new Set((ficha.phrases ?? []).map(saidOf))
  const habits = (ficha.options ?? []).flatMap((option) => SAID_AS[plain(option)] ?? [])
  const repeats = (clause: string) => habits.some((pattern) => pattern.test(clause)) || (meaningful(clause).length >= 2 && examined.has(clause))
  const sentences = sentencesOf(text)
  const kept = sentences.filter((sentence) => {
    const said = saidOf(sentence)
    if (!said) return false
    if (CORRECTION.test(said) || asked(said)) return false
    const hits = phrases.filter((phrase) => said.includes(phrase) || phrase.includes(said))
    // Lo de la ficha dicho con otras palabras («Canino derecho clase 2» por «caninos el derecho clase 2»): casi
    // todas sus palabras son de lo que fue para la ficha.
    const words = meaningful(said)
    if (!hits.length) return !(words.length >= 2 && words.filter((word) => covered.has(word.slice(0, 5))).length >= Math.ceil(0.8 * words.length))
    const used = new Set(hits.flatMap(meaningful))
    // Lo que sigue a esa frase también puede ser de otra respuesta de la ficha («Presenta riesgo de caries
    // alto y colabora pero con miedo», prueba con voz del 15 nov, v08): cuenta solo lo que no es de ninguna.
    return words.filter((word) => !used.has(word) && !covered.has(word.slice(0, 5))).length >= 2
  })
  return kept
    .map((sentence) => withoutRepeatedClauses(sentence, repeats))
    .filter(Boolean)
    .join(" ")
    .trim()
}

/** Lo que sigue a una parte quitada y no se sostiene sin ella: «desde hace tres días», «que no la deja dormir». */
const LEANS_ON = /^(desde|hace|que|cuando|al|a|de|del|por|para|en|sin|segun|durante|hasta|tras|despues|antes|no|lo|la|le|se)\b/

/**
 * La oración sin sus partes (entre comas o «y») que repiten lo de la ficha (`repeats`, sobre la
 * parte sin tildes). Si lo que queda se apoya en lo quitado, la oración se queda entera; si no queda
 * nada, vacía.
 */
function withoutRepeatedClauses(sentence: string, repeats: (clause: string) => boolean): string {
  const clauses = sentence.trim().split(/,\s+|\s+y\s+/)
  if (clauses.length < 2) return sentence
  const drop = clauses.map((clause) => repeats(saidOf(clause)))
  if (!drop.some(Boolean)) return sentence
  if (drop.every(Boolean)) return ""
  if (clauses.some((_, index) => drop[index] && drop[index + 1] === false && LEANS_ON.test(saidOf(clauses[index + 1] ?? "")))) return sentence
  const rest = clauses
    .filter((_, index) => !drop[index])
    .join(", ")
    .replace(/^(y|e|con|pero|ademas|además|tambien|también)\s+/i, "")
  const out = rest.charAt(0).toUpperCase() + rest.slice(1)
  return /[.!?]$/.test(sentence.trim()) && !/[.!?]$/.test(out) ? `${out}.` : out
}

/** Una oración como se compara: sin tildes ni mayúsculas, sin la puntuación del final. */
const saidOf = (sentence: string) => plain(sentence).replace(/[.;,]+$/, "").trim()

/** Lo que se le preguntó al paciente («¿Te duele cuando comes?») no es de la historia (prueba con voz del 15 nov). */
const asked = (said: string) => said.startsWith("¿") || said.endsWith("?")

/**
 * El texto de la consulta sin fichas, sin las preguntas al paciente («¿Te duele cuando comes?»): solo
 * la oración que es una pregunta entera; «Refiere dolor al masticar, ¿verdad?» se queda. Si no hay
 * ninguna, el texto queda tal cual, con sus saltos de línea.
 */
function withoutAsked(text: string): string {
  const sentences = sentencesOf(text)
  const kept = sentences.filter((sentence) => !saidOf(sentence).startsWith("¿"))
  return kept.length === sentences.length ? text : kept.join(" ").trim()
}

/**
 * Lo dicho de una pausa con el texto de la consulta limpio de lo que fue para
 * una ficha: lo que quedó como propuesta o va a «No pude usar esto» con su
 * motivo. Lo que la ficha no tomó ni avisa se queda en la consulta, para no
 * perderlo. Una nota que queda vacía no se propone. Sin fichas empezadas solo
 * se quita lo que se le preguntó al paciente: eso no es de la historia en
 * ninguna pausa. Lo usan el servidor y la medición.
 */
export function withoutFormNotes<T extends FormDraftLike>(
  drafts: readonly T[],
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  transcript?: string,
): T[] {
  const clean = questions.length ? formPhrasesCleaner(drafts, questions, site, transcript) : withoutAsked
  return drafts.flatMap((draft) => (draft.kind === "nota" ? cleanNote(draft, clean) : [draft]))
}

/** La limpieza de la consulta con fichas: sin las frases de lo que fue para una ficha (`withoutFormPhrases`). */
function formPhrasesCleaner<T extends FormDraftLike>(
  drafts: readonly T[],
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  transcript?: string,
): (text: string) => string {
  // De la frase de una ficha, las oraciones que nombran su pregunta: si la frase abarca otra cosa
  // («… Se cementan brackets»), eso sigue siendo de la consulta.
  const answers = drafts
    .filter((draft) => draft.kind === "ficha" && draft.sourceText?.trim())
    .map((draft) => ({ draft, ready: prepareFormAnswer(draft, questions, site, transcript) }))
  // Lo examinado que tomó la ficha: sus frases y las opciones elegidas, sin lo que cuenta el paciente.
  const examined = answers.flatMap(({ draft, ready }) =>
    ready && ready.payload["value"] != null && !patientTells(String(ready.payload["label"] ?? "")) ? [{ said: draft.sourceText ?? "", value: ready.payload["value"] }] : [],
  )
  const ficha = {
    phrases: examined.map((item) => item.said),
    options: examined.flatMap((item) => [item.value].flat().filter((value): value is string => typeof value === "string")),
  }
  const phrases = answers.flatMap(({ draft, ready }) => {
    if (!ready && formAnswerDropReason(draft, questions) === null) return []
    const said = draft.sourceText ?? ""
    const parts = sentencesOf(said).filter((part) => part.trim())
    const question = questions.find((item) => item.number === draft.payload["question"])
    if (parts.length <= 1 || !question) return [said]
    const label = labelStems(question.label)
    return parts.filter((part) => stemsOf(heardBy(question, part)).some((stem) => label.includes(stem)))
  })
  return (text) => withoutFormPhrases(text, phrases, ficha)
}

/** Una nota con cada texto limpio; si queda vacía, no se propone. */
function cleanNote<T extends FormDraftLike>(draft: T, clean: (text: string) => string): T[] {
  const payload = Object.fromEntries(Object.entries(draft.payload).map(([key, value]) => [key, typeof value === "string" ? clean(value) : value]))
  const empty = Object.values(payload).every((value) => typeof value !== "string" || value === "")
  if (empty) return []
  return [{ ...draft, payload: Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== "")) }]
}

/** Una respuesta de ficha que nace de otra cosa dicha (un diagnóstico), no del modelo. */
export interface DerivedFormDraft {
  kind: "ficha"
  payload: Record<string, unknown>
  sourceText: string
}

/**
 * Un diagnóstico dicho que también pregunta una ficha empezada se propone en
 * los dos lugares, como el ceod (verificación del 14 nov): «pulpitis
 * irreversible sintomática» va a Diagnóstico y a «Diagnóstico pulpar». Solo una
 * opción de dos o más palabras, todas dichas, y la única de su pregunta; la
 * pregunta vacía que el modelo no respondió. Se comprueba como las demás.
 */
export function withDiagnosisFormAnswers<T extends FormDraftLike>(
  drafts: readonly T[],
  questions: readonly DictationFormQuestion[],
): Array<T | DerivedFormDraft> {
  const extra: DerivedFormDraft[] = []
  const answered = new Set(drafts.filter((draft) => draft.kind === "ficha").map((draft) => draft.payload["question"]))
  for (const draft of drafts) {
    if (draft.kind !== "diagnostico" || !draft.sourceText?.trim()) continue
    for (const question of questions) {
      if (question.type !== "opcion_unica" || question.answered !== undefined || answered.has(question.number)) continue
      const spoken = new Set(stemsOf(heardBy(question, draft.sourceText)))
      const hits = (question.options ?? []).filter((option) => {
        const stems = stemsOf(option)
        return stems.length >= 2 && stems.every((stem) => spoken.has(stem))
      })
      if (hits.length !== 1) continue
      answered.add(question.number)
      extra.push({ kind: "ficha", payload: { question: question.number, answer: hits[0] }, sourceText: draft.sourceText.trim() })
    }
  }
  return [...drafts, ...extra]
}

/** Un diagnóstico que nace de la respuesta de una ficha, no del modelo. */
export type DerivedDiagnosisDraft = Omit<DerivedFormDraft, "kind"> & { kind: "diagnostico" }

/**
 * La pieza de una ficha: la que se dijo en esta pausa (`answers`, ya comprobadas), la que propone una
 * pendiente de otra pausa (`pending`) o la ya escrita. null si no se sabe.
 */
function formTooth(
  responseId: unknown,
  answers: ReadonlyArray<Record<string, unknown>>,
  questions: readonly DictationFormQuestion[],
  pending?: ReadonlyMap<number, unknown>,
): number | null {
  const said = answers.find((payload) => payload["responseId"] === responseId && payload["type"] === "pieza")?.["value"]
  const question = questions.find((item) => item.responseId === responseId && item.type === "pieza")
  const value = said ?? (question ? (pending?.get(question.number) ?? question.answered) : undefined)
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

/**
 * La respuesta de una ficha que es un diagnóstico (`ProductForms.diagnoses`: «Necrosis pulpar» es
 * K04.1) va también a Diagnóstico si Clío no propuso uno de esa pregunta: a veces llena la ficha y no
 * Diagnóstico (prueba con voz del 15 nov, c5: en v06 faltó la pulpitis y en v07 no quedó ninguno).
 * Solo la respuesta que queda lista, con la pieza de su ficha y su misma frase; se comprueba como los
 * demás diagnósticos (`reviewDiagnosis`: el absceso crónico con la fístula negada pasa al que no la
 * tiene). No se propone si en la pausa, pendiente o confirmado (`known`) ya hay uno de los que da esa
 * pregunta: de la apical, K04.4 a K04.7, aunque Clío haya elegido otro. Devuelve solo los nuevos.
 */
export function withFormDiagnoses(
  drafts: readonly FormDraftLike[],
  questions: readonly DictationFormQuestion[],
  /** Las opciones que son un diagnóstico, con su código (`ProductForms.diagnoses`); sin ellas, nada. */
  codes: Readonly<Record<string, string>> | undefined,
  where: { site: ProductSite; transcript?: string | undefined; known?: readonly string[]; pending?: ReadonlyMap<number, unknown> },
): DerivedDiagnosisDraft[] {
  if (!codes || !questions.length) return []
  const byOption = optionCodes(codes)
  const codeOf = (value: unknown) => String(value ?? "").trim().toUpperCase()
  const known = [...(where.known ?? []), ...drafts.filter((draft) => draft.kind === "diagnostico").map((draft) => draft.payload["diagnosisCode"])].map(codeOf).filter(Boolean)
  // Las respuestas de ficha de la pausa que quedan listas, como las guarda el servidor.
  const answers = drafts.flatMap((draft) => {
    const ready = draft.kind === "ficha" ? prepareFormAnswer(draft, questions, where.site, where.transcript) : null
    return ready?.status === "lista" ? [{ draft, payload: ready.payload }] : []
  })
  const payloads = answers.map((item) => item.payload)
  const extra: DerivedDiagnosisDraft[] = []
  for (const { draft, payload } of answers) {
    const code = typeof payload["value"] === "string" ? byOption.get(plain(payload["value"])) : undefined
    if (!code) continue
    // Los códigos que da su pregunta: si ya hay uno, Diagnóstico ya tiene lo de esa pregunta.
    const options = questions.find((item) => item.responseId === payload["responseId"] && item.fieldId === payload["fieldId"])?.options ?? []
    const family = options.flatMap((option) => byOption.get(plain(option)) ?? [])
    if (known.some((have) => family.some((one) => have.startsWith(one)))) continue
    known.push(code)
    const tooth = formTooth(payload["responseId"], payloads, questions, where.pending)
    extra.push({ kind: "diagnostico", payload: { diagnosisCode: code, diagnosisType: "confirmed", ...(tooth === null ? {} : { toothNumber: tooth }) }, sourceText: draft.sourceText ?? "" })
  }
  return extra
}

/** Las opciones que son un diagnóstico, sin tildes ni mayúsculas, con su código. */
const optionCodes = (codes: Readonly<Record<string, string>>) => new Map(Object.entries(codes).map(([option, code]) => [plain(option), code]))

/** Una sugerencia de la atención como la lee `dictatedDiagnoses`: con su payload como lo guarda el servidor. */
export interface DiagnosedItem {
  kind: string
  payload: Record<string, unknown>
  status?: string
}

/**
 * Lo diagnosticado en la atención como lo leen los productos al elegir una prestación
 * (`DictationPatient.diagnoses`; odentIA: la endodoncia vital o no vital): los diagnósticos de la
 * pausa, pendientes o confirmados, con su código, su nombre y su sitio, y lo que responden las fichas
 * (lo listo de la pausa y de las pendientes, y lo ya escrito), con la pieza de su ficha y, si la
 * opción es un diagnóstico (`codes`), su código. Las de ficha llegan ya comprobadas.
 */
export function dictatedDiagnoses(
  items: readonly DiagnosedItem[],
  questions: readonly DictationFormQuestion[],
  options: { pending?: ReadonlyMap<number, unknown>; codes?: Readonly<Record<string, string>> | undefined } = {},
): DictationDiagnosis[] {
  // De una ficha, solo lo que quedó listo: lo que se revisa no decide nada.
  const answers = items.filter((item) => item.kind === "ficha" && item.status === "lista").map((item) => item.payload)
  const byOption = optionCodes(options.codes ?? {})
  const fromForm = (responseId: unknown, text: unknown): DictationDiagnosis[] => {
    if (typeof text !== "string" || !text.trim()) return []
    const tooth = formTooth(responseId, answers, questions, options.pending)
    return [{ code: byOption.get(plain(text)) ?? null, text, where: tooth === null ? {} : { toothNumber: tooth } }]
  }
  return [
    ...items.flatMap((item) =>
      item.kind === "diagnostico" ? [{ code: String(item.payload["diagnosisCode"] ?? ""), text: String(item.payload["description"] ?? ""), where: item.payload }] : [],
    ),
    ...answers.flatMap((payload) => fromForm(payload["responseId"], payload["value"])),
    ...questions.flatMap((question) => fromForm(question.responseId, question.answered)),
  ]
}

/** Lo que dice una oración de la consulta, para compararla: sus raíces y sus negaciones. */
function noteWords(sentence: string): { stems: string[]; negations: string[] } {
  return { stems: stemsOf(sentence), negations: [...new Set(negationsOf(sentence))].sort() }
}

/**
 * La nota de una pausa sin las oraciones que ya dice una nota pendiente de la atención: lo que cortó
 * la pausa llega otra vez al comienzo de lo nuevo (`withPauseBridge`) y Clío lo vuelve a contar
 * (prueba con voz del 15 nov, c5, v07: «el diente se le ha ido poniendo oscuro», dos veces en el
 * relato). Sale la oración de tres palabras o más que están todas en una misma oración pendiente,
 * con las mismas negaciones: «No refiere dolor» no repite «Refiere dolor». Si la nota queda vacía, no
 * se propone.
 */
export function withoutRepeatedNotes<T extends FormDraftLike>(drafts: readonly T[], pendingNotes: readonly string[]): T[] {
  const before = pendingNotes.flatMap(sentencesOf).map(noteWords)
  if (!before.length) return [...drafts]
  const repeated = (sentence: string) => {
    const now = noteWords(sentence)
    return now.stems.length >= 3 && before.some((old) => now.stems.every((stem) => old.stems.includes(stem)) && now.negations.join() === old.negations.join())
  }
  const clean = (text: string) => {
    const sentences = sentencesOf(text)
    const kept = sentences.filter((sentence) => !repeated(sentence))
    return kept.length === sentences.length ? text : kept.join(" ").trim()
  }
  return drafts.flatMap((draft) => (draft.kind === "nota" ? cleanNote(draft, clean) : [draft]))
}

/** La misma respuesta, sin mirar el orden de varias opciones. */
function sameAnswer(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : value)
  return norm(a) === norm(b)
}

/**
 * La oración de lo dictado que contiene la frase: «cinco cariados» en «CPOD:
 * cinco cariados, dos perdidos…» es del CPOD. Solo la oración, no la pausa
 * entera: «Clase canina derecha clase uno. Molar izquierda clase dos.» no se mezcla.
 */
function sentenceOf(transcript: string | undefined, said: string | undefined): string {
  if (!transcript || !said?.trim()) return ""
  const target = plain(said)
  return sentencesOf(transcript).find((sentence) => plain(sentence).includes(target)) ?? ""
}

/** Lo que se salta entre un número y su término, o tras una corrección: «uno con extracción», «obturados a ver 8», «no, perdón, de 4». */
const LINKS = new Set(["con", "de", "y", "a", "ver", "este", "eh", "digamos", "mmm", "no", "perdon"])

/** Las palabras sin tildes, con el decimal como punto («1,8» es 1.8), para leer números por su lugar. */
const tokensOf = (text: string) =>
  plain(text)
    .replace(/(\d),(\d)/g, "$1.$2")
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/\.+$/, ""))
    .filter(Boolean)

/** Las primeras palabras que siguen a lo dicho en su oración, sin tildes: el modelo a veces cita sin lo que viene después. */
function wordsAfter(said: string, sentence: string, count: number): string {
  const at = plain(sentence).indexOf(plain(said))
  return at >= 0 && said.trim() ? tokensOf(plain(sentence).slice(at + plain(said).length)).slice(0, count).join(" ") : ""
}

/** El primer número desde `from`, saltando hasta dos palabras de enlace en esa dirección. */
function numberNear(words: string[], from: number, step: 1 | -1): { value: number; next: number; at: number } | null {
  for (let at = from, skipped = 0; at >= 0 && at < words.length && skipped <= 2; at += step, skipped += 1) {
    const read = readNumber(words, at)
    if (read) return { ...read, at }
    if (!LINKS.has(words[at] ?? "")) return null
  }
  return null
}

/**
 * En «pesa 24 kg no 22 perdón» o «de 6 no perdón de 4», el número que va enseguida después del «no»,
 * el «perdón» o el «corrijo», con su «y medio». Mira también lo que sigue a lo dicho en su oración: el
 * modelo a veces cita «pesa 24 kg» sin la corrección. `null` si no se corrigió un número: «8 de 10 no
 * cede» no corrige nada.
 */
function correctedNumber(said: string, sentence = ""): number | null {
  const words = tokensOf(`${said} ${wordsAfter(said, sentence, 4)}`)
  for (let index = words.length - 1; index > 0; index -= 1) {
    if (!["no", "perdon", "corrijo"].includes(words[index] ?? "")) continue
    const fixed = numberNear(words, index + 1, 1)
    if (fixed && saidNumbers(words.slice(0, index).join(" ")).length) return saidNumbers(words.slice(fixed.at).join(" "))[0] ?? fixed.value
  }
  return null
}

/**
 * El número que lo dicho le da a esta pregunta cuando se dicen varias seguidas sin puntuación (prueba
 * con voz del 15 nov): cada número va con el término que tiene al lado, en el orden en que se dijo,
 * como «tres cariados uno con extracción indicada dos obturados» (número y término) o «cariados 4
 * obturados uno» (término y número); vale el orden con el que más términos tienen su número. Solo entre
 * preguntas de número de la misma ficha y unidad, por la palabra que es solo de cada una. `null` si no
 * hay dos términos dichos.
 *
 * `sure`: el orden lo dijeron los términos. Si los dos órdenes empatan («para confirmarse 6 perdidos 2
 * obturados 4 simplificado 1,8», prueba con voz del 15 nov: Chrome oyó mal «cariados»), vale el que
 * no deja un número suelto en el borde de lo dicho, donde ningún término mal oído pudo ir con él
 * (el 1,8 del final no tiene término después: el orden es término y número). Ese orden se deduce:
 * no es seguro, y si no da el número que propuso Clío, queda por revisar. `order`: con cuál se leyó.
 */
function pairedNumber(question: DictationFormQuestion, { words, terms }: NumberTerms): PairedNumber | null {
  const mine = terms.findIndex((term) => term.item === question)
  if (terms.length < 2 || mine < 0) return null
  const before = terms.map((term) => numberNear(words, term.start - 1, -1))
  const after = terms.map((term) => {
    const read = numberNear(words, term.end + 1, 1)
    // «obturados a ver 8 no 7», «de 6 no perdón de 4»: lo corregido enseguida, desde lo que sigue al «no».
    const fixed = read && ["no", "perdon"].includes(words[read.next] ?? "") ? numberNear(words, read.next + 1, 1) : null
    return fixed ?? read
  })
  const counted = (list: Array<{ value: number } | null>) => list.filter(Boolean).length
  const pick = (order: PairedNumber["order"], sure: boolean): PairedNumber => ({ value: (order === "antes" ? before : after)[mine]?.value ?? null, sure, order })
  // Ningún término con un número al lado («la inferior desviada a la izquierda dos milímetros»): el
  // orden no dice nada y vale lo que leyó Clío.
  if (!counted(before) && !counted(after)) return null
  if (counted(before) !== counted(after)) return pick(counted(before) > counted(after) ? "antes" : "despues", true)
  // Los números que ningún término toma en un orden, y si alguno queda en el borde del lado de su
  // término: sin nada dicho de ese lado, salvo palabras de enlace.
  const said = words.flatMap((word, at) => (LINKS.has(word) ? [] : [at]))
  const [first = words.length, last = -1] = [said[0], said.at(-1)]
  const numbers: Array<{ at: number; next: number }> = []
  for (let at = 0; at < words.length; ) {
    const number = readNumber(words, at)
    if (number) numbers.push({ at, next: number.next })
    at = number ? number.next : at + 1
  }
  const loose = (taken: Array<{ at: number } | null>) => numbers.filter((number) => !taken.some((item) => item?.at === number.at))
  // En «número y término», el suelto con nada dicho después; en «término y número», con nada dicho antes.
  const beforeLoose = loose(before).some((number) => number.next > last)
  const afterLoose = loose(after).some((number) => number.at <= first)
  if (beforeLoose !== afterLoose) return pick(beforeLoose ? "despues" : "antes", false)
  // Sin orden: solo un número a su lado es el suyo; con uno a cada lado, no se sabe.
  if (Boolean(before[mine]) !== Boolean(after[mine])) return pick(before[mine] ? "antes" : "despues", false)
  return { value: null, sure: false, order: "antes", ambiguous: before[mine] !== null }
}

/** El número de una pregunta por su lugar en lo dicho (`pairedNumber`). */
interface PairedNumber {
  value: number | null
  sure: boolean
  /** Sin orden, con un número a cada lado de su término: no se sabe cuál es el suyo. */
  ambiguous?: boolean
  /** Si el número va antes de su término («dos obturados») o después («obturados dos»). */
  order: "antes" | "despues"
}

/**
 * Los términos de las preguntas de número de la ficha que se dijeron en el texto, con dónde: la
 * palabra que es solo de cada una («cariados», «extracción indicada», «obturados»), entre las de la
 * misma ficha y unidad. `own`: la de esta pregunta (vacía si no tiene una suya).
 */
function numberTerms(question: DictationFormQuestion, questions: readonly DictationFormQuestion[], text: string) {
  const group = questions.filter((item) => item.responseId === question.responseId && item.type === "numero" && (item.unit ?? null) === (question.unit ?? null))
  const wordsOf = (item: DictationFormQuestion) => meaningful(item.label.replace(/\([^)]*\)/g, " "))
  const ownOf = (item: DictationFormQuestion) =>
    wordsOf(item).filter((word) => !group.some((other) => other !== item && wordsOf(other).some((theirs) => theirs.slice(0, 5) === word.slice(0, 5))))
  const words = tokensOf(text)
  const terms = group.flatMap((item) => {
    const term = ownOf(item)
    const start = words.findIndex((token) => termWord(token, term))
    if (start < 0) return []
    let end = start
    while (termWord(words[end + 1], term)) end += 1
    return [{ item, start, end }]
  })
  return { words, terms, own: ownOf(question) }
}

/** ¿Es la palabra del término («extraccion» de «extracción indicada»), con otra terminación? */
const termWord = (token: string | undefined, term: readonly string[]) => !!token && term.some((word) => token.slice(0, 5) === word.slice(0, 5) && token.length <= word.length + 3)

/** Cuántos decimales lleva un número dictado sin revisar: los índices y las medidas de una ficha llevan uno. */
const NUMBER_DECIMALS = 1

/**
 * El tramo de lo dictado, tal cual, con el número y su término juntos en el orden en que se dijeron
 * («uno con extracción indicada»). `null` si no se encuentra así: se muestra lo que citó Clío.
 */
function numberPhrase(text: string, value: number, term: readonly string[], order: PairedNumber["order"]): string | null {
  const found = [...text.matchAll(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu)]
  const words = found.map((match) => plain(match[0]).replace(/(\d),(\d)/g, "$1.$2"))
  for (let at = 0; at < words.length; at += 1) {
    const number = readNumber(words, at)
    if (!number || Math.abs(number.value - value) > 1e-9) continue
    const step = order === "antes" ? 1 : -1
    // Del lado del término, saltando hasta dos palabras de enlace («uno con extracción»).
    let near = order === "antes" ? number.next : at - 1
    for (let skipped = 0; skipped < 2 && LINKS.has(words[near] ?? ""); skipped += 1) near += step
    if (!termWord(words[near], term)) continue
    while (termWord(words[near + step], term)) near += step
    const [first, last] = order === "antes" ? [at, near] : [near, number.next - 1]
    const start = found[first]
    const end = found[last]
    if (start?.index === undefined || end?.index === undefined) return null
    return text.slice(start.index, end.index + end[0].length)
  }
  return null
}

type NumberTerms = ReturnType<typeof numberTerms>

/**
 * ¿El número es de otro término dicho, y el de esta pregunta no se oyó? En «descarriados uno con
 * extracción indicada» (Chrome oyó «tres cariados» así, prueba con voz del 15 nov) el «uno» va con la
 * extracción: no es de los cariados. Sin otro término al lado, el número dicho vale («déjame medir 7
 * mm» del overjet).
 */
function numberOfAnother(question: DictationFormQuestion, { words, terms, own }: NumberTerms, number: number): boolean {
  if (!own.length || terms.some((term) => term.item === question)) return false
  const same = (read: { value: number } | null) => !!read && Math.abs(read.value - number) < 1e-9
  return terms.some((term) => same(numberNear(words, term.start - 1, -1)) || same(numberNear(words, term.end + 1, 1)))
}

/**
 * Lo dicho cerca de esta pregunta cuando la oración nombra otras del mismo tipo: desde lo que la
 * distingue («superior»; un número, también dos palabras antes: «dos perdidos») hasta lo que distingue
 * a otra («inferior»). Sin comas, como
 * lo oye Chrome, es lo que separa el valor de una del de la otra. Sin nada suyo, la oración entera.
 */
function spansOf(question: DictationFormQuestion, others: readonly DictationFormQuestion[], heard: string): string[] {
  const mine = labelStems(question.label).filter((stem) => !others.some((other) => labelStems(other.label).includes(stem)))
  const theirs = new Set(others.flatMap((other) => labelStems(other.label)).filter((stem) => !labelStems(question.label).includes(stem)))
  const words = plain(heard).split(/\s+/).filter(Boolean)
  const stem = (word: string) => word.replace(/[^a-z0-9]/g, "").slice(0, 5)
  const spans = words.flatMap((word, index) => {
    if (!mine.includes(stem(word))) return []
    let start = index
    const back = question.type === "numero" || question.type === "escala" ? 2 : 0
    while (start > index - back && start > 0 && !theirs.has(stem(words[start - 1] ?? ""))) start -= 1
    let end = index + 1
    while (end < words.length && !theirs.has(stem(words[end] ?? ""))) end += 1
    return [words.slice(start, end).join(" ")]
  })
  return spans.length ? spans : [heard]
}

/** Cómo se dice también una palabra de un rótulo, por su raíz: «le duele como un nueve» nombra el dolor. */
const LABEL_SAID: Record<string, RegExp> = { dolor: /\b(duele|duelen|dolia|dolio|doler)\b/ }

/** Lo que cuenta el paciente (el dolor) es del relato aunque la ficha también lo tenga (verificación del 14 nov). */
const patientTells = (label: string) => labelStems(label).includes("dolor")

/**
 * Las preguntas de la ficha que pueden recibir un número: las de número, escala y pieza, y las
 * opciones numeradas («Grado 1», «3 · Positiva»). Entre ellas, lo que es solo de una la nombra.
 */
const takesNumber = (item: { type: string; options: readonly string[] | null }) =>
  item.type === "numero" || item.type === "escala" || item.type === "pieza" || (item.options ?? []).some((option) => optionNumbers(option).length > 0)

/**
 * ¿Lo dicho nombra la pregunta de este número? Un número queda listo solo así (prueba con voz del
 * 15 nov, c4, v07: «Hace 2 años» quedaba lista como «Intensidad del dolor: 2»). Como la red: la
 * frase la nombra (`namesQuestion`, con su rótulo o la palabra que solo ella tiene), o la nombra su
 * oración y la frase está en lo que la oración dice de ella (`spansOf`: en «superior centrada la
 * inferior desviada a la derecha eh medio milímetro», el medio milímetro es de la inferior). Entre
 * las que llevan un número, también lo que solo tiene esta: una palabra de su rótulo en la frase
 * («le duele como un nueve» es la intensidad del dolor), su unidad («18 kg» es el peso) o, en una
 * escala, «ocho de diez» con una palabra suya en la oración. `said` y `sentence`, ya leídos.
 */
function numberNamed(question: DictationFormQuestion, questions: readonly DictationFormQuestion[], site: ProductSite, said: string, sentence: string): boolean {
  if (namesQuestion(question, said, site)) return true
  // Las raíces de su rótulo que ninguna otra que lleva un número tiene, dichas o con su verbo («duele»).
  const theirs = new Set((question.siblings ?? []).filter(takesNumber).flatMap((other) => labelStems(other.label)))
  const own = labelStems(question.label).filter((stem) => !theirs.has(stem))
  const saysOwn = (text: string) => own.some((stem) => stemsOf(text).includes(stem) || LABEL_SAID[stem]?.test(plain(text)))
  if (saysOwn(said)) return true
  // Su unidad, si ninguna otra de la ficha va en ella.
  const unit = question.unit ? UNIT_SAID[plain(question.unit)] : undefined
  if (unit?.test(plain(said)) && !questions.some((other) => other !== question && other.responseId === question.responseId && other.unit === question.unit)) return true
  // En una escala, «ocho de diez» (su máximo), con lo suyo en la oración.
  const outOfMax = [...plain(said).matchAll(/\b(?:de|sobre) ([a-z0-9]+)/g)].some((match) => saidNumbers(match[1] ?? "")[0] === question.max)
  if (question.type === "escala" && outOfMax && saysOwn(sentence || said)) return true
  if (!sentence || !namesQuestion(question, sentence, site)) return false
  const others = questions.filter((other) => other !== question && other.responseId === question.responseId && other.type === question.type && namesQuestion(other, heardBy(other, sentence), site))
  const phrase = plain(said)
  return spansOf(question, others, sentence).some((span) => plain(span).includes(phrase))
}

function checkFormAnswer(
  draft: { payload: Record<string, unknown>; sourceText?: string | undefined },
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
  heardSentence = "",
): PreparedFormAnswer | null {
  const dictated = (draft.sourceText ?? "").trim()
  // Sin frase comprobada no se guarda: es lo que la persona ve para decidir.
  if (!dictated) return null
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!question) return null
  // Se comprueba con lo mal oído leído como el término de la ficha; lo que se le muestra a la
  // persona («Dijiste «…»») es lo dictado, tal cual.
  const said = heardBy(question, dictated)
  const sentence = heardBy(question, heardSentence)
  const list = Array.isArray(draft.payload["answers"]) ? draft.payload["answers"].filter((item): item is string => typeof item === "string" && !!item.trim()) : []
  // Una sola opción en la lista de varias, en una pregunta de una sola, es esa respuesta: el modelo a
  // veces la escribe ahí (medición del 15 nov, la segunda lectura). Se comprueba igual que las demás.
  const answer = typeof draft.payload["answer"] === "string" ? draft.payload["answer"].trim() : ""
  const raw = answer || (question.type !== "opcion_multiple" && list.length === 1 ? (list[0] ?? "").trim() : "")
  const base = {
    responseId: question.responseId,
    fieldId: question.fieldId,
    formTitle: question.formTitle,
    label: question.label,
    type: question.type,
    order: question.order,
    ...(question.unit ? { unit: question.unit } : {}),
    ...(question.dependsOn ? { dependsOn: question.dependsOn } : {}),
  }
  // Para un número, «un milímetro» es 1; para elegir una opción, «una clase dos» no dice «1».
  const heard = saidNumbers(said, { roman: "largos" })
  const heardForOptions = saidNumbers(said, { roman: "largos", articles: false })
  // El dolor a otra prueba es de esa prueba: «sin dolor a la percusión» no dice «Sin dolor».
  const spoken = new Set(stemsOf(withoutOtherTests(question, said)))
  // La frase (o su oración) tiene que hablar de esta pregunta: el lado, canina o molar, superior o inferior.
  const context = new Set([...spoken, ...stemsOf(withoutOtherTests(question, sentence))])
  if (!talksAbout(question, context) || namesAnother(question, said) || partOfOtherTest(question, said, sentence)) return null
  // La frase que nombra otra pregunta del mismo tipo de su ficha, y no esta, es de la otra: «Overbite
  // de tres, no, perdón, de dos y medio» no responde el overjet (medición del 15 nov, orto-21).
  const namesSibling = questions.some(
    (other) => other !== question && other.responseId === question.responseId && other.type === question.type && labelNamed(other, heardBy(other, dictated), site),
  )
  if (namesSibling && !labelNamed(question, said, site)) return null
  const labelSaid = labelStems(question.label).some((stem) => context.has(stem))
  const ready = (value: unknown): PreparedFormAnswer => ({ payload: { ...base, value }, status: "lista", note: null })
  const review = (value: unknown, note: string): PreparedFormAnswer => ({ payload: { ...base, value }, status: "por_revisar", note })
  // Entre cuáles opciones dudó: la pregunta las ofrece en botones y la persona elige con un toque.
  const between = (options: readonly string[], note: string): PreparedFormAnswer => ({
    payload: { ...base, value: null, ...(options.length >= 2 ? { choices: [...options] } : {}) },
    status: "por_revisar",
    note,
  })
  const option = (text: string) => {
    const exact = (question.options ?? []).find((item) => plain(item) === plain(text))
    if (exact || !/^\d+$/.test(text.trim())) return exact ?? null
    // Con las opciones numeradas («4 · Definitivamente positiva») el modelo a veces responde solo el
    // número: es la única que empieza con él. Se comprueba contra lo dicho como las demás.
    const numbered = (question.options ?? []).filter((item) => plain(item).split(/\D/)[0] === text.trim())
    return numbered.length === 1 ? (numbered[0] ?? null) : null
  }
  const options = question.options ?? []
  const ownStems = (item: string) => stemsOf(item)
  const fullySaid = (item: string) => ownStems(item).length > 0 && ownStems(item).every((stem) => spoken.has(stem))
  const score = (item: string) => ownStems(item).filter((stem) => spoken.has(stem)).length
  const listNumbers = options.flatMap(optionNumbers)
  const elige = (between: string[]) =>
    `Dijiste «${shortSaid(dictated)}»: ${between.length >= 2 ? `no alcanza para elegir entre ${between.map((item) => `«${item}»`).join(" y ")}` : "elige tú la opción"}. Elige tú.`
  /**
   * ¿Lo dicho elige esta opción? `null`: no la dijo (no se propone). Una opción
   * que dice que no hay nada exige una negación dicha y que se nombre la
   * pregunta. Una con número, ese número dicho (sin contar «un» ni «una»); su
   * número es solo un rótulo («1 · Definitivamente negativa») si se dijeron sus
   * palabras, ninguna otra calza con más de lo dicho y no se dijo un número de
   * la lista. Las demás, por sus palabras: en una sola, la que más calza, sin
   * empate; en varias, la que tiene dicha una palabra que es solo suya.
   */
  const chosen = (value: string, single: boolean): { ok: true } | { ok: false; note: string; between: string[] } | null => {
    if (isNegativeOption(value)) return denies(said) && labelSaid ? { ok: true } : null
    if (isPositiveOption(value) && painOnTest(question, said)) return { ok: true }
    if (SAID_AS[plain(value)]?.test(plain(said))) return { ok: true }
    const numbers = optionNumbers(value)
    if (numbers.length) {
      if (containsAll(heardForOptions, numbers)) return { ok: true }
      const better = options.some((item) => item !== value && fullySaid(item) && ownStems(item).length > ownStems(value).length)
      if (fullySaid(value) && !better && !heardForOptions.some((number) => listNumbers.includes(number))) return { ok: true }
      const known = numbers.filter((number) => containsAll(heardForOptions, [number]))
      if (!known.length && !score(value)) return null
      const among = options.filter((item) => containsAll(optionNumbers(item), known))
      return { ok: false, note: elige(among), between: among }
    }
    if (single) {
      const mine = score(value)
      if (!mine) return null
      // «Sin dolor» no compite con «dolor espontáneo» si no se negó nada.
      const rivals = options.filter((item) => !isNegativeOption(item) || denies(said))
      const best = Math.max(...rivals.map(score))
      const tied = rivals.filter((item) => score(item) === best)
      if (mine < best) return null
      return tied.length === 1 ? { ok: true } : { ok: false, note: elige(tied), between: tied }
    }
    const unique = ownStems(value).filter((stem) => !options.some((item) => item !== value && ownStems(item).includes(stem)))
    return (unique.length ? unique.some((stem) => spoken.has(stem)) : fullySaid(value)) ? { ok: true } : null
  }

  switch (question.type) {
    case "booleano": {
      const word = plain(raw)
      // Sí o no, de esta pregunta: si no se la nombra, no se sabe a qué responde.
      if (!labelSaid) return null
      if (TRUE_WORDS.has(word)) return denies(said) ? review(null, `Dijiste «${shortSaid(dictated)}»: ¿es sí o no? Elige tú.`) : ready(true)
      if (FALSE_WORDS.has(word)) return denies(said) ? ready(false) : null
      return null
    }
    case "opcion_unica": {
      const value = option(raw)
      if (!value) return null
      const check = chosen(value, true)
      if (!check) return null
      return check.ok ? ready(value) : between(check.between, check.note)
    }
    case "opcion_multiple": {
      const values = [...new Set((list.length ? list : raw ? [raw] : []).map(option).filter((item): item is string => item !== null))]
      const checks = values.map((value) => ({ value, check: chosen(value, false) }))
      const kept = checks.filter((item) => item.check?.ok).map((item) => item.value)
      if (kept.length) return ready(kept)
      const failed = checks.find((item) => item.check && !item.check.ok)?.check
      return failed && !failed.ok ? review(null, failed.note) : null
    }
    case "numero":
    case "escala":
    case "pieza": {
      const proposed = Number(raw.replace(",", "."))
      if (!raw || !Number.isFinite(proposed)) return null
      // El número tiene que estar en lo dicho: nunca uno que el modelo dedujo o convirtió.
      // La pieza también se dice dígito a dígito («la cuatro seis»), como en el odontograma.
      // Un tiempo («hace 2 años», también con la unidad después de la frase citada) no responde una
      // pregunta que no se mide en tiempo.
      const measuresTime = TIME_WORDS.has(plain(question.unit ?? ""))
      const numbers =
        question.type === "pieza" ? toothNumbersIn(said) : measuresTime ? heard : saidNumbers(`${said} ${wordsAfter(said, sentence, 1)}`, { roman: "largos", times: false })
      if (!containsAll(numbers, [proposed])) return null
      const unit = question.unit ? OTHER_UNITS[plain(question.unit)] : undefined
      if (unit?.test(plain(said))) return null
      // «Al menos dos», «unos tres»: lo aproximado no entra como exacto.
      if (question.type !== "pieza" && APPROXIMATE.test(plain(said))) return review(null, `Dijiste «${shortSaid(dictated)}»: es aproximado. Escríbelo tú.`)
      // Lo que se corrigió («24 kg no 22 perdón») y el orden sin puntuación («uno con extracción indicada dos
      // obturados»): vale el número que lo dicho le da a esta pregunta (prueba con voz del 15 nov).
      // El número de otro término dicho no es de esta pregunta, si su término no se oyó.
      const terms = question.type === "numero" ? numberTerms(question, questions, sentence || said) : null
      if (terms && numberOfAnother(question, terms, proposed)) return null
      const paired = terms ? pairedNumber(question, terms) : null
      const number = question.type === "pieza" ? proposed : (paired?.value ?? correctedNumber(said, sentence) ?? proposed)
      if (question.type === "pieza") {
        if (!Number.isInteger(number) || site.code(number) === null) return review(null, `${site.invalid(number) ?? "Esa pieza no existe"}. Elige tú.`)
        return ready(number)
      }
      const min = question.type === "escala" ? (question.min ?? 0) : question.min
      const max = question.type === "escala" ? (question.max ?? 10) : question.max
      const whole = question.type === "escala" && !Number.isInteger(number)
      if (whole || (min !== null && number < min) || (max !== null && number > max)) {
        const range = min !== null && max !== null ? `Va de ${min} a ${max}` : min !== null ? `Es de ${min} o más` : `Es de ${max} o menos`
        return review(null, `${range}${whole ? ", en números enteros" : ""}: dijiste ${String(number).replace(".", ",")}. Escríbelo tú.`)
      }
      // La frase que se muestra es la del número que se usó: «uno con extracción indicada», no la que
      // citó Clío con el número de al lado (prueba con voz del 15 nov, v08).
      const shown = paired?.value != null && terms && !containsAll(heard, [paired.value]) ? numberPhrase(heardSentence || dictated, paired.value, terms.own, paired.order) : null
      // Cuando lo dicho junta números y términos, el número va pegado a su término en el orden en que se
      // dijo (prueba con voz del 15 nov, v11: «para confirmarse 6 perdidos 2» no dejó claro si perdidos
      // es 6 o 2). Si ese orden se dedujo y no da lo que propuso Clío, o hay un número a cada lado, la
      // propone por revisar. Chrome a veces escribe una cifra de más («0,99» por «cero coma nueve», v12):
      // con más de un decimal, también.
      // Y queda lista solo si lo dicho nombra su pregunta (`numberNamed`): si no, Clío la propone y
      // la persona la revisa (prueba con voz del 15 nov, c4: «déjame medir 7 mm» no dice que es el overjet).
      const prepared =
        paired && (paired.ambiguous || (!paired.sure && paired.value !== null && paired.value !== proposed))
          ? review(number, `Dijiste «${shortSaid(shown ?? dictated)}»: no queda claro qué número es de «${question.label}». Revísala.`)
          : decimalsOf(number) > NUMBER_DECIMALS
            ? review(number, `Dijiste «${shortSaid(dictated)}»: revisa los decimales.`)
            : !(paired?.sure && paired.value !== null) && !numberNamed(question, questions, site, said, sentence)
              ? review(number, `Dijiste «${shortSaid(dictated)}» sin nombrar «${question.label}»: revísala.`)
              : ready(number)
      return shown ? { ...prepared, said: shown } : prepared
    }
  }
}

/** La respuesta de una ficha, dicha corta: la misma regla que la pantalla (`@odentia/clinical`). */
export { formAnswerWords }

/** Lo que pasó al aceptar una propuesta de ficha. */
export type FormAnswerOutcome =
  | { written: true; responseId: string }
  /** No se escribió nada: la propuesta se descarta y se dice por qué. */
  | { written: false; note: string }

/**
 * Escribe en la ficha la respuesta que propuso Clío como se guarda a mano
 * (`updateFormResponseDraft`: validación, permisos de la ficha y auditoría),
 * solo si la pregunta sigue vacía: lo que escribió la persona gana y la
 * propuesta se descarta con lo que quedó. Una pregunta que depende de otra: si
 * esa otra ya está respondida de forma que la oculta, la propuesta se descarta;
 * si está vacía, pide responderla primero. Nunca acepta la otra por su cuenta.
 */
export async function answerFormFromDictation(tx: Db, orgId: string, actorUserId: string, payload: Record<string, unknown>): Promise<FormAnswerOutcome> {
  const responseId = String(payload["responseId"] ?? "")
  const fieldId = String(payload["fieldId"] ?? "")
  const [current] = await tx
    .select()
    .from(clinicalFormResponse)
    .where(and(eq(clinicalFormResponse.organizationId, orgId), eq(clinicalFormResponse.id, responseId)))
    .for("update")
    .limit(1)
  if (!current || current.status !== "borrador" || current.source !== "staff") {
    return { written: false, note: "La ficha ya no está a medias: no se escribió nada." }
  }
  const fields = assertFormSchema(current.templateSnapshot).sections.flatMap((section) => section.fields)
  const field = fields.find((item) => item.id === fieldId)
  if (!field) return { written: false, note: "Esa pregunta ya no está en la ficha." }
  const answers = (current.answers ?? {}) as Record<string, unknown>
  const words = (value: unknown, unit?: string | null) => formAnswerWords({ value, unit })
  // Una corrección de lo ya escrito lo cambia solo si sigue diciendo lo que Clío vio.
  const replacing = payload["replaces"] !== undefined && sameAnswer(answers[fieldId], payload["replaces"])
  if (!isEmpty(answers[fieldId]) && !replacing) {
    return { written: false, note: `Clío proponía «${words(payload["value"], field.unit)}»; quedó «${words(answers[fieldId], field.unit)}», que ya estaba escrito.` }
  }
  if (field.showIf && !conditionMet(field.showIf, answers[field.showIf.field])) {
    const parent = fields.find((item) => item.id === field.showIf?.field)
    const label = parent?.label ?? "la pregunta de la que depende"
    if (!isEmpty(answers[field.showIf.field])) return { written: false, note: `«${label}» quedó en «${words(answers[field.showIf.field])}»: esta pregunta ya no va.` }
    throw new ServiceError("FORM_ANSWER_DEPENDS", 409, `Primero confirma o responde «${label}»: esta pregunta depende de ella.`)
  }
  // Quién y cuándo ya viven en la sugerencia; la auditoría dice de qué pregunta, sin el valor clínico.
  const saved = await updateFormResponseDraft(tx, orgId, actorUserId, responseId, {
    answers: { ...answers, [fieldId]: payload["value"] },
    auditMetadata: { field: fieldId, by: "clio" },
  })
  const rejected = saved.rejected[fieldId]
  if (rejected) return { written: false, note: `No se escribió: ${rejected}` }
  return { written: true, responseId }
}
