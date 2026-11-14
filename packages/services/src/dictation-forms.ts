import type { Db } from "@odentia/db"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { and, desc, eq } from "drizzle-orm"
import { assertFormSchema, conditionMet, type FormFieldDef, isEmptyAnswer as isEmpty, updateFormResponseDraft } from "./clinical-forms.js"
import { ServiceError } from "./errors.js"
import type { ProductSite } from "./product-hooks.js"

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
export async function dictationFormQuestions(tx: Db, orgId: string, encounterId: string): Promise<DictationFormQuestion[]> {
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
    .limit(DICTATION_MAX_FORMS)
  // Las elegidas, en el orden en que se empezaron: el número de cada pregunta no salta entre pausas.
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  return formQuestionsOf(rows.map((row) => ({ id: row.id, title: row.title, snapshot: row.snapshot, answers: (row.answers ?? {}) as Record<string, unknown> })))
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

const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()

const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
}
const TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
}
const TENS: Record<string, number> = {
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
}
const ROMAN: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 }

/**
 * Los números que se dijeron en una frase, con sus repeticiones: en cifras
 * («6», «6,5», «-2»), en palabras («seis», «cuarenta y seis», «veintiséis»,
 * «seis y medio», «seis coma cinco», «menos dos») y, con `roman`, en romanos
 * sueltos («Clase II»: así se escriben las opciones; «largos», solo los de dos
 * letras o más, para lo dictado).
 */
export function saidNumbers(text: string, options: { roman?: "todos" | "largos"; articles?: boolean } = {}): number[] {
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
    // «al menos dos», «por lo menos dos»: no es un número negativo.
    const negative = word === "menos" && words[index - 1] !== "al" && words[index - 1] !== "lo"
    const at = negative ? index + 1 : index
    const read = readNumber(words, at)
    if (!read) continue
    let value = read.value
    let next = read.next
    // «seis y medio», «seis coma cinco», «seis punto cinco».
    if (words[next] === "y" && words[next + 1] === "medio") {
      value += 0.5
      next += 2
    } else if ((words[next] === "coma" || words[next] === "punto") && words[next + 1] !== undefined) {
      const decimal = readNumber(words, next + 1)
      if (decimal && decimal.value < 100) {
        value = Number(`${Math.trunc(value)}.${decimal.value}`)
        next = decimal.next
      }
    }
    found.push(negative ? -value : value)
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

/** «No», «sin», «niega»…: un «No» solo se propone si se negó en voz alta. El silencio no es «No». */
const NEGATION = /\b(no|sin|niega|niegan|negativ[oa]s?|ausente|ausencia|ningun[oa]?|nunca|tampoco|descarta)\b/
/** ¿Se negó algo en la frase? «sin embargo» no niega nada. */
const denies = (said: string) => NEGATION.test(plain(said).replace(/\bsin embargo\b/g, ""))
/** Una opción que dice que no hay nada: «No», «No tiene», «Negativa», «Ninguno», «Ausente». */
const isNegativeOption = (option: string) => /^(no|sin|ningun[oa]?|nada|negativ[oa]|ausente)\b/.test(plain(option))

/** Palabras que no distinguen una pregunta ni una opción. */
const FILLER = new Set(["del", "las", "los", "con", "por", "para", "que", "una", "uno", "angle", "mas"])
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
  // Solo las hermanas del mismo tipo y con las mismas opciones: a las demás ya las distingue el valor.
  const twins = (question.siblings ?? []).filter(
    (item) => item.type === question.type && JSON.stringify(item.options ?? null) === JSON.stringify(question.options ?? null),
  )
  for (const twin of twins) {
    const theirs = labelStems(twin.label)
    const shared = own.filter((stem) => theirs.includes(stem))
    const diff = own.filter((stem) => !theirs.includes(stem))
    if (shared.length >= 1 && diff.length >= 1 && diff.length <= 2 && !diff.some((stem) => said.has(stem))) return false
  }
  const [head, ...rest] = own
  if (head && rest.length && said.has(head) && !rest.some((stem) => said.has(stem))) return false
  return true
}

/** Otra unidad de la misma magnitud dicha en la frase: no se convierte, no se propone. */
const OTHER_UNITS: Record<string, RegExp> = {
  mm: /\b(centimetros?|cm|metros?)\b/,
  cm: /\b(milimetros?|mm|metros?)\b/,
  kg: /\b(gramos?|libras?)\b/,
  g: /\b(kilos?|kilogramos?|kg)\b/,
}

const TRUE_WORDS = new Set(["si", "true", "verdadero"])
const FALSE_WORDS = new Set(["no", "false", "falso"])

/** Una sugerencia de ficha lista para guardar: su valor ya tipado, o por revisar con su motivo. */
export interface PreparedFormAnswer {
  payload: Record<string, unknown>
  status: "lista" | "por_revisar"
  note: string | null
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
  draft: { payload: Record<string, unknown>; sourceText?: string | undefined },
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
): PreparedFormAnswer | null {
  const proposed = checkFormAnswer(draft, questions, site)
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!proposed || question?.answered === undefined) return proposed
  const value = proposed.payload["value"]
  if (value === null || value === undefined || sameAnswer(value, question.answered)) return null
  const now = formAnswerWords({ value: question.answered, unit: question.unit })
  return { payload: proposed.payload, status: "por_revisar", note: `Ya dice «${now}». Si cambió, cámbiala tú en la ficha.` }
}

/** La misma respuesta, sin mirar el orden de varias opciones. */
function sameAnswer(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : value)
  return norm(a) === norm(b)
}

function checkFormAnswer(
  draft: { payload: Record<string, unknown>; sourceText?: string | undefined },
  questions: readonly DictationFormQuestion[],
  site: ProductSite,
): PreparedFormAnswer | null {
  const said = (draft.sourceText ?? "").trim()
  // Sin frase comprobada no se guarda: es lo que la persona ve para decidir.
  if (!said) return null
  const question = questions.find((item) => item.number === draft.payload["question"])
  if (!question) return null
  const raw = typeof draft.payload["answer"] === "string" ? draft.payload["answer"].trim() : ""
  const list = Array.isArray(draft.payload["answers"]) ? draft.payload["answers"].filter((item): item is string => typeof item === "string" && !!item.trim()) : []
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
  const spoken = new Set(stemsOf(said))
  // La frase tiene que hablar de esta pregunta: el lado, canina o molar, superior o inferior.
  if (!talksAbout(question, spoken)) return null
  const labelSaid = labelStems(question.label).some((stem) => spoken.has(stem))
  const ready = (value: unknown): PreparedFormAnswer => ({ payload: { ...base, value }, status: "lista", note: null })
  const review = (value: unknown, note: string): PreparedFormAnswer => ({ payload: { ...base, value }, status: "por_revisar", note })
  const option = (text: string) => (question.options ?? []).find((item) => plain(item) === plain(text)) ?? null
  const options = question.options ?? []
  const ownStems = (item: string) => stemsOf(item)
  const fullySaid = (item: string) => ownStems(item).length > 0 && ownStems(item).every((stem) => spoken.has(stem))
  const score = (item: string) => ownStems(item).filter((stem) => spoken.has(stem)).length
  const listNumbers = options.flatMap(optionNumbers)
  const elige = (between: string[]) =>
    `Dijiste «${shortSaid(said)}»: ${between.length >= 2 ? `no alcanza para elegir entre ${between.map((item) => `«${item}»`).join(" y ")}` : "elige tú la opción"}. Elige tú.`
  /**
   * ¿Lo dicho elige esta opción? `null`: no la dijo (no se propone). Una opción
   * que dice que no hay nada exige una negación dicha y que se nombre la
   * pregunta. Una con número, ese número dicho (sin contar «un» ni «una»); su
   * número es solo un rótulo («1 · Definitivamente negativa») si se dijeron sus
   * palabras, ninguna otra calza con más de lo dicho y no se dijo un número de
   * la lista. Las demás, por sus palabras: en una sola, la que más calza, sin
   * empate; en varias, la que tiene dicha una palabra que es solo suya.
   */
  const chosen = (value: string, single: boolean): { ok: true } | { ok: false; note: string } | null => {
    if (isNegativeOption(value)) return denies(said) && labelSaid ? { ok: true } : null
    const numbers = optionNumbers(value)
    if (numbers.length) {
      if (containsAll(heardForOptions, numbers)) return { ok: true }
      const better = options.some((item) => item !== value && fullySaid(item) && ownStems(item).length > ownStems(value).length)
      if (fullySaid(value) && !better && !heardForOptions.some((number) => listNumbers.includes(number))) return { ok: true }
      const known = numbers.filter((number) => containsAll(heardForOptions, [number]))
      if (!known.length && !score(value)) return null
      return { ok: false, note: elige(options.filter((item) => containsAll(optionNumbers(item), known))) }
    }
    if (single) {
      const mine = score(value)
      if (!mine) return null
      const best = Math.max(...options.map(score))
      const tied = options.filter((item) => score(item) === best)
      if (mine < best) return null
      return tied.length === 1 ? { ok: true } : { ok: false, note: elige(tied) }
    }
    const unique = ownStems(value).filter((stem) => !options.some((item) => item !== value && ownStems(item).includes(stem)))
    return (unique.length ? unique.some((stem) => spoken.has(stem)) : fullySaid(value)) ? { ok: true } : null
  }

  switch (question.type) {
    case "booleano": {
      const word = plain(raw)
      // Sí o no, de esta pregunta: si no se la nombra, no se sabe a qué responde.
      if (!labelSaid) return null
      if (TRUE_WORDS.has(word)) return denies(said) ? review(null, `Dijiste «${shortSaid(said)}»: ¿es sí o no? Elige tú.`) : ready(true)
      if (FALSE_WORDS.has(word)) return denies(said) ? ready(false) : null
      return null
    }
    case "opcion_unica": {
      const value = option(raw)
      if (!value) return null
      const check = chosen(value, true)
      if (!check) return null
      return check.ok ? ready(value) : review(null, check.note)
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
      const number = Number(raw.replace(",", "."))
      if (!raw || !Number.isFinite(number)) return null
      // El número tiene que estar en lo dicho: nunca uno que el modelo dedujo o convirtió.
      // La pieza también se dice dígito a dígito («la cuatro seis»), como en el odontograma.
      if (!containsAll(question.type === "pieza" ? toothNumbersIn(said) : heard, [number])) return null
      const unit = question.unit ? OTHER_UNITS[plain(question.unit)] : undefined
      if (unit?.test(plain(said))) return null
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
      return ready(number)
    }
  }
}

/** La respuesta de una ficha, dicha corta: «Sí», «Clase I», «6 mm», «Rx periapical y Rx panorámica». */
export function formAnswerWords(payload: Record<string, unknown>): string {
  const value = payload["value"]
  if (typeof value === "boolean") return value ? "Sí" : "No"
  if (typeof value === "number") return `${String(value).replace(".", ",")}${typeof payload["unit"] === "string" && payload["unit"] ? ` ${payload["unit"]}` : ""}`
  if (Array.isArray(value)) return value.join(", ")
  if (typeof value === "string") return value
  return "sin proponer"
}

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
  if (!isEmpty(answers[fieldId])) {
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
