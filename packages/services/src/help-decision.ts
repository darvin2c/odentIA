import type { AdminAnswer, AdminDecider, AdminQuestion } from "./admin-request.js"
import { type HelpFaq, type HelpTopic, helpTopicForScreen, helpTopicLabel } from "./help-guide.js"
import { scoreKnowledgeMatch } from "./knowledge.js"
import { clinicWord, type ProductAgentTexts, productName } from "./product-agent.js"

/**
 * La Ayuda elige su respuesta (ADR 0146, estudio X8, opción b): el modelo de
 * decisión dice qué texto de la guía responde la pregunta de alguien del
 * equipo —una pregunta frecuente o el párrafo de una pantalla—, que no está en
 * la guía o que es de las cifras de la clínica (eso lo responde Argos). Lo que
 * se muestra es siempre el texto de la guía tal cual: el modelo no redacta
 * nada. Al proveedor viajan la pregunta y el nombre de la pantalla, nada de la
 * clínica.
 *
 * Versionada como `knowledge.v1` del agente: cambiar la redacción o el orden
 * de las opciones invalida lo medido con `eval:ayuda`, y
 * `product-prompts.test.ts` del agente lo atrapa (`__golden__/ayuda.json`).
 */
export const HELP_SELECT_VERSION = "help.v1"
export const HELP_SELECT_QUESTION = "help"
/**
 * Las opciones de la guía que caben: el mismo total que `knowledge.v1` del
 * agente (250 y «ninguna»), con sitio para «ninguna» y «datos». Una prueba del
 * agente las mantiene iguales.
 */
export const HELP_SELECT_MAX_OPTIONS = 249
/**
 * Desde esta probabilidad se muestra lo elegido. Medido con Jev el 2026-11-06
 * (ADR 0146): es el único umbral de la curva que cumple los cuatro mínimos del
 * estudio en los bancos de ajuste, y se confirmó una vez en los ciegos.
 */
export const HELP_CONFIDENT = 0.9
/** Una segunda respuesta se muestra junto a la primera desde esta probabilidad: la pregunta tenía dos partes. */
export const HELP_SECOND = 0.25
/** «¿Querías decir…?» ofrece como mucho estas. */
export const HELP_OFFERED = 3
/** Por debajo de esto una opción no se ofrece en la duda. */
const HELP_CANDIDATE = 0.05
const NONE = "none"
const DATA = "data"
const DESCRIPTION_CHARS = 240

/** El modelo de decisión, con la misma forma que el de los pedidos a Argos. */
export type HelpDecider = AdminDecider

/** Lo que la guía puede responder: una pregunta frecuente o el párrafo de una pantalla. */
export type HelpOption = { kind: "faq"; topic: HelpTopic; faq: HelpFaq } | { kind: "tema"; topic: HelpTopic }

/** Todas las respuestas de una guía: primero sus preguntas frecuentes y después sus pantallas, en el orden de la guía. */
export function helpOptions(topics: readonly HelpTopic[]): HelpOption[] {
  return [
    ...topics.flatMap((topic) => (topic.faqs ?? []).map((faq): HelpOption => ({ kind: "faq", topic, faq }))),
    ...topics.map((topic): HelpOption => ({ kind: "tema", topic })),
  ]
}

const optionValue = (option: HelpOption, index: number) => `${option.kind === "faq" ? "f" : "t"}${index + 1}`

const asEntry = (option: HelpOption) =>
  option.kind === "faq"
    ? { title: option.faq.q, body: option.faq.a, askForms: option.faq.forms ?? [] }
    : { title: helpTopicLabel(option.topic), body: option.topic.purpose, askForms: option.topic.terms }

/**
 * Las respuestas que entran en la pregunta. Con más de las que admite el
 * proveedor se quedan las que más se parecen por palabras: es un filtro previo,
 * no la elección. Hoy la guía entra entera.
 */
export function helpCandidates(options: readonly HelpOption[], question: string): HelpOption[] {
  if (options.length <= HELP_SELECT_MAX_OPTIONS) return [...options]
  return options
    .map((option, index) => ({ option, index, score: scoreKnowledgeMatch(question, asEntry(option)) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, HELP_SELECT_MAX_OPTIONS)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.option)
}

/**
 * Cómo ve Jev cada opción. Una pregunta frecuente va con su pantalla, porque
 * muchas solo se entienden en ella («¿Quién puede recibir lo que llega?»), y
 * con sus formas de preguntar; una pantalla, con su nombre y el comienzo de su
 * párrafo. Una pregunta general no es de ninguna pantalla.
 */
function describe(option: HelpOption): string {
  if (option.kind === "tema") return `Pantalla ${helpTopicLabel(option.topic)}: ${option.topic.purpose}`.slice(0, DESCRIPTION_CHARS)
  const asked = [option.faq.q, ...(option.faq.forms ?? [])].join(" / ")
  // Una pregunta general (el manual, el celular) responde solo eso: no es la respuesta por defecto.
  return (option.faq.general ? `Pregunta general, solo si pregunta esto: ${asked}` : `${helpTopicLabel(option.topic)}: ${asked}`).slice(0, DESCRIPTION_CHARS)
}

export function helpQuestion(candidates: readonly HelpOption[], texts: ProductAgentTexts): AdminQuestion {
  const product = productName(texts)
  return {
    id: HELP_SELECT_QUESTION,
    kind: "choice",
    instructions: `Alguien del equipo de una ${clinicWord(texts)} escribe en la Ayuda de ${product}. ¿Qué texto de la guía responde exactamente lo que escribió? Elige una pregunta frecuente si su respuesta es lo que pregunta; una pantalla si su párrafo, leído tal cual, responde la pregunta (por ejemplo, qué es esa pantalla, para qué sirve o que ahí se hace lo que pregunta) y ninguna pregunta frecuente lo hace mejor. Si no pregunta cómo hacer algo en ${product} (un saludo, una broma, una pregunta de salud, de cocina o de cualquier otro tema), o si nada de la lista lo responde, elige «ninguna»: no la acerques a la respuesta más general.`,
    options: [
      ...candidates.map((option, index) => ({ value: optionValue(option, index), description: describe(option) })),
      {
        value: DATA,
        description: "Pregunta por las cifras o los datos de su clínica (cuánto, cuántos, quién, por qué un número suyo es el que es o no coincide con el de otra pantalla): lo responden sus datos, no la guía.",
      },
      {
        value: NONE,
        description: `Ninguna: no es una pregunta sobre cómo hacer algo en ${product} (saludos, bromas, salud, recetas, consejos u otros temas), o nada de la lista la responde.`,
      },
    ],
  }
}

/** El nombre de la pantalla donde está la persona, como en el menú; nulo si la guía no la conoce. Nunca la ruta con sus ids. */
export function helpScreenName(path: string, topics: readonly HelpTopic[]): string | null {
  const topic = helpTopicForScreen(path, topics)
  return topic ? helpTopicLabel(topic) : null
}

/** Lo que viaja al proveedor: la pregunta y el nombre de la pantalla. Nada de la clínica ni de pacientes. */
export function helpState(question: string, screen: string | null): string {
  return screen ? `Pantalla: ${screen}\nPregunta: ${question}` : `Pregunta: ${question}`
}

export interface HelpSelection {
  /**
   * `seguro`: se muestra `shown` tal cual. `duda`: «¿Querías decir…?» con
   * `offered`. `ninguna`: no está en la guía. `datos`: es de las cifras de la
   * clínica (Argos).
   */
  verdict: "seguro" | "duda" | "ninguna" | "datos"
  /** Una respuesta, o dos si la pregunta tenía dos partes. */
  shown: HelpOption[]
  /** Hasta `HELP_OFFERED` respuestas para elegir, de la más probable a la menos. */
  offered: HelpOption[]
  /** Probabilidad de la opción más alta; nula si el proveedor no entrega distribución. */
  top: number | null
}

type ChoiceAnswer = Extract<AdminAnswer, { kind: "choice" }>
const isChoice = (answer: AdminAnswer): answer is ChoiceAnswer => answer.kind === "choice" && "choice" in answer

/**
 * Lee la respuesta del modelo de decisión con un umbral (`confident`): la
 * medición lo recorre entero sobre las mismas respuestas. Primero lo más
 * probable: «ninguna» o «datos» con el umbral, o una respuesta de la guía con
 * el umbral; si no, «ninguna» y «datos» sumadas con el umbral son «ninguna»; si
 * no, duda. Sin distribución no hay certeza: lo elegido se ofrece, nunca se
 * afirma.
 */
export function readHelpSelection(
  result: { answers: readonly AdminAnswer[] },
  candidates: readonly HelpOption[],
  confident = HELP_CONFIDENT,
): HelpSelection {
  const answer = result.answers.filter(isChoice).find((item) => item.id === HELP_SELECT_QUESTION)
  if (!answer) return { verdict: "duda", shown: [], offered: [], top: null }
  const byValue = new Map(candidates.map((option, index) => [optionValue(option, index), option]))
  if (!answer.probabilities) {
    const option = byValue.get(answer.choice)
    return { verdict: "duda", shown: [], offered: option ? [option] : [], top: null }
  }
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
  const [topValue, top] = ranked[0] ?? [NONE, 0]
  const guide = ranked.flatMap(([value, probability]) => {
    const option = byValue.get(value)
    return option ? [{ option, probability }] : []
  })
  const offered = guide
    .filter((item) => item.probability >= HELP_CANDIDATE)
    .slice(0, HELP_OFFERED)
    .map((item) => item.option)
  if ((topValue === NONE || topValue === DATA) && top >= confident) {
    return { verdict: topValue === NONE ? "ninguna" : "datos", shown: [], offered: [], top }
  }
  const [first, second] = guide
  if (first && first.probability >= confident) {
    const shown = second && second.probability >= HELP_SECOND ? [first.option, second.option] : [first.option]
    return { verdict: "seguro", shown, offered: [], top }
  }
  // «Ninguna» y «datos» dicen lo mismo de la guía: que no la responde. Juntas
  // pasan el umbral aunque ninguna lo pase sola: no está en la guía. La salida
  // a Argos pide su propia certeza.
  const away = (answer.probabilities[NONE] ?? 0) + (answer.probabilities[DATA] ?? 0)
  if (away >= confident) return { verdict: "ninguna", shown: [], offered: [], top }
  return { verdict: "duda", shown: [], offered, top }
}

/** El texto que se muestra, tal cual está en la guía: la respuesta de la pregunta frecuente o el párrafo de la pantalla. */
export function helpAnswerText(option: HelpOption, place: string = helpTopicLabel(option.topic)): string {
  if (option.kind === "faq") return option.faq.a
  return `En ${place}. ${option.topic.purpose}`
}
