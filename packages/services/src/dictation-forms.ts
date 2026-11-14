import type { Db } from "@odentia/db"
import { clinicalFormResponse } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq } from "drizzle-orm"
import { assertAnswers, assertFormSchema, conditionMet, type FormFieldDef, isEmptyAnswer as isEmpty } from "./clinical-forms.js"
import { ServiceError } from "./errors.js"
import type { ProductSite } from "./product-hooks.js"
import { productHooks } from "./products.js"

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
}

/**
 * Las preguntas que Clío puede proponer en esta atención: las vacías de las
 * fichas del equipo en borrador (empezadas: una ficha solo ofrecida no cuenta,
 * decisión 4 del 14 nov), de los tipos que se comprueban con la frase. Una que
 * depende de otra ya respondida de forma que la oculta no se pregunta. Sin
 * fichas empezadas devuelve una lista vacía y el dictado queda como siempre.
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
      if (!isEmpty(answers[field.id])) return
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
export function saidNumbers(text: string, options: { roman?: "todos" | "largos" } = {}): number[] {
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
    const negative = word === "menos"
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
 * revisar: se ve en la pregunta y lo elige el profesional.
 */
export function prepareFormAnswer(
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
  const heard = saidNumbers(said, { roman: "largos" })
  const ready = (value: unknown): PreparedFormAnswer => ({ payload: { ...base, value }, status: "lista", note: null })
  const review = (value: unknown, note: string): PreparedFormAnswer => ({ payload: { ...base, value }, status: "por_revisar", note })
  const option = (spoken: string) => (question.options ?? []).find((item) => plain(item) === plain(spoken)) ?? null
  /** La opción, si lo que la distingue de las otras (su clase, su grado, su división) se dijo. */
  const chosen = (value: string): { ok: true } | { ok: false; note: string } => {
    const numbers = optionNumbers(value)
    if (containsAll(heard, numbers)) return { ok: true }
    const known = numbers.filter((number) => containsAll(heard, [number]))
    const close = (question.options ?? []).filter((item) => containsAll(optionNumbers(item), known))
    const between = close.length >= 2 ? `no alcanza para elegir entre ${close.map((item) => `«${item}»`).join(" y ")}` : "elige tú la opción"
    return { ok: false, note: `Dijiste «${shortSaid(said)}»: ${between}. Elige tú.` }
  }

  switch (question.type) {
    case "booleano": {
      const word = plain(raw)
      if (TRUE_WORDS.has(word)) return ready(true)
      if (FALSE_WORDS.has(word)) return NEGATION.test(plain(said)) ? ready(false) : null
      return null
    }
    case "opcion_unica": {
      const value = option(raw)
      if (!value) return null
      const check = chosen(value)
      return check.ok ? ready(value) : review(null, check.note)
    }
    case "opcion_multiple": {
      const values = [...new Set((list.length ? list : raw ? [raw] : []).map(option).filter((item): item is string => item !== null))]
      const kept = values.filter((value) => chosen(value).ok)
      if (kept.length) return ready(kept)
      const failed = values.map(chosen).find((check) => !check.ok)
      return failed && !failed.ok ? review(null, failed.note) : null
    }
    case "numero":
    case "escala":
    case "pieza": {
      const number = Number(raw.replace(",", "."))
      if (!raw || !Number.isFinite(number)) return null
      // El número tiene que estar en lo dicho: nunca uno que el modelo dedujo o convirtió.
      if (!containsAll(heard, [number])) return null
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
 * Escribe en la ficha la respuesta que propuso Clío, con la validación de
 * siempre, solo si la pregunta sigue vacía: lo que escribió la persona gana y
 * la propuesta se descarta. Una pregunta que depende de otra aún sin la
 * respuesta que la muestra no se escribe en silencio (`assertAnswers` la
 * dejaría vacía): pide responder primero esa. `answerParent` intenta aceptar la
 * propuesta pendiente de la pregunta de la que depende.
 */
export async function answerFormFromDictation(
  tx: Db,
  orgId: string,
  actorUserId: string,
  payload: Record<string, unknown>,
  answerParent: (fieldId: string) => Promise<boolean>,
): Promise<FormAnswerOutcome> {
  const responseId = String(payload["responseId"] ?? "")
  const fieldId = String(payload["fieldId"] ?? "")
  const lock = async () => {
    const [row] = await tx
      .select()
      .from(clinicalFormResponse)
      .where(and(eq(clinicalFormResponse.organizationId, orgId), eq(clinicalFormResponse.id, responseId)))
      .for("update")
      .limit(1)
    return row
  }
  let current = await lock()
  if (!current || current.status !== "borrador" || current.source !== "staff") {
    return { written: false, note: "La ficha ya no está a medias: no se escribió nada." }
  }
  const schema = assertFormSchema(current.templateSnapshot)
  const fields = schema.sections.flatMap((section) => section.fields)
  const field = fields.find((item) => item.id === fieldId)
  if (!field) return { written: false, note: "Esa pregunta ya no está en la ficha." }
  let answers = { ...((current.answers ?? {}) as Record<string, unknown>) }
  if (!isEmpty(answers[fieldId])) return { written: false, note: `«${field.label}» ya tenía respuesta: quedó la que estaba.` }
  if (field.showIf && !conditionMet(field.showIf, answers[field.showIf.field])) {
    const parent = fields.find((item) => item.id === field.showIf?.field)
    const accepted = isEmpty(answers[field.showIf.field]) && (await answerParent(field.showIf.field))
    if (accepted) {
      current = await lock()
      answers = { ...((current?.answers ?? {}) as Record<string, unknown>) }
    }
    if (!accepted || !conditionMet(field.showIf, answers[field.showIf.field])) {
      throw new ServiceError("FORM_ANSWER_DEPENDS", 409, `Primero responde «${parent?.label ?? "la pregunta de la que depende"}»: esta pregunta depende de ella.`)
    }
  }
  const site: ProductSite = (await productHooks(tx, orgId)).site
  const validated = assertAnswers(schema, { ...answers, [fieldId]: payload["value"] }, { requireAll: false, site })
  await tx
    .update(clinicalFormResponse)
    .set({ answers: validated, updatedAt: new Date() })
    .where(and(eq(clinicalFormResponse.organizationId, orgId), eq(clinicalFormResponse.id, responseId)))
  // Quién y cuándo ya viven en la sugerencia; aquí solo de qué pregunta, sin el valor clínico.
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "form_response.update",
    entity: "clinical_form_response",
    entityId: responseId,
    metadata: { field: fieldId, by: "clio" },
  })
  return { written: true, responseId }
}
