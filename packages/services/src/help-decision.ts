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

/** Lo que se acaba de preguntar y responder en esa conversación, para entender «¿y cómo la creo?». */
export interface HelpPrevious {
  question: string
  /** La pantalla de lo que se le respondió, como en el menú; nula si no fue de una pantalla. */
  where: string | null
}

/**
 * Lo que viaja al proveedor: la pregunta, el nombre de la pantalla y, si viene
 * de otra, la pregunta anterior con la pantalla de su respuesta. Nada de la
 * clínica ni de pacientes.
 */
export function helpState(question: string, screen: string | null, previous: HelpPrevious | null = null): string {
  const before = previous
    ? `Antes preguntó: ${previous.question}${previous.where ? ` (se le respondió sobre ${previous.where})` : ""}\n`
    : ""
  return `${before}${screen ? `Pantalla: ${screen}\n` : ""}Pregunta: ${question}`
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

/* ---------- `help.v2`: Jev decide en dos pasos, y se redacta solo si hace falta (ADR 0178) ---------- */

/**
 * Con la guía completa las respuestas ya no caben en una pregunta (el tope del
 * proveedor es 250 opciones). Jev elige primero la categoría —un tema, o una
 * parte de un tema muy grande— y después la respuesta dentro de las categorías
 * elegidas. Cambiar la redacción de cualquiera de las tres preguntas, el orden
 * de sus opciones o un umbral invalida lo medido con `eval:ayuda`.
 */
export const HELP_FLOW_VERSION = "help.v2"
export const HELP_AREA_QUESTION = "help_area"
export const HELP_JOIN_QUESTION = "help_join"
/** La categoría de lo que no es de ninguna pantalla (quién es Ariadna, la contraseña, el celular). */
export const HELP_GENERAL_AREA = "general"
/** En cuántas categorías se busca como mucho antes de buscar en toda la guía. */
export const HELP_AREAS_MAX = 3
/** Las categorías elegidas tienen que sumar esto para darlas por buenas; si no, se busca en toda la guía. Por medir. */
export const HELP_AREA_COVER = 0.9
/** Desde esta probabilidad una respuesta es parte de lo que se redacta. Por medir. */
export const HELP_PART = 0.15
/** Con cuántas respuestas de la guía se redacta como mucho. */
export const HELP_PARTS_MAX = 3
/** Desde esta probabilidad se cree que las partes, juntas, responden la pregunta. Por medir. */
export const HELP_JOIN_CONFIDENT = 0.8
const AREA_DESCRIPTION_CHARS = 700
const AREA_PURPOSE_CHARS = 220
/** Lo redactado es corto: es una respuesta de la Ayuda, no un manual. */
export const HELP_WRITTEN_MAX_CHARS = 900

/** Una categoría de la guía: lo que Jev elige en el primer paso. */
export interface HelpArea {
  id: string
  /** Cómo se llama, como en el menú. */
  label: string
  /** De qué trata, para Jev: su párrafo y lo que se pregunta en ella. */
  about: string
}

const firstArea = (topic: HelpTopic): string => topic.areas?.[0]?.id ?? topic.id

/** La categoría de una respuesta: la suya, la primera de su tema, o «general» si no es de ninguna pantalla. */
export function helpAreaOf(option: HelpOption): string {
  if (option.kind === "tema") return firstArea(option.topic)
  return option.faq.area ?? (option.faq.general ? HELP_GENERAL_AREA : firstArea(option.topic))
}

/** Las categorías de una guía, en su orden: las de cada tema y, al final, lo general. */
export function helpAreas(topics: readonly HelpTopic[]): HelpArea[] {
  const options = helpOptions(topics)
  const asked = (area: string) =>
    options.flatMap((option) => (option.kind === "faq" && helpAreaOf(option) === area ? [option.faq.q] : [])).join(" / ")
  const describe = (text: string, area: string) => {
    const questions = asked(area)
    return (questions ? `${text.slice(0, AREA_PURPOSE_CHARS)} Se pregunta: ${questions}` : text).slice(0, AREA_DESCRIPTION_CHARS)
  }
  const areas = topics.flatMap((topic): HelpArea[] =>
    topic.areas
      ? topic.areas.map((area) => ({ id: area.id, label: `${helpTopicLabel(topic)} · ${area.label}`, about: describe(area.about, area.id) }))
      : [{ id: topic.id, label: helpTopicLabel(topic), about: describe(topic.purpose, topic.id) }],
  )
  const general = asked(HELP_GENERAL_AREA)
  return general
    ? [...areas, { id: HELP_GENERAL_AREA, label: "Preguntas generales", about: `No son de una pantalla. Se pregunta: ${general}`.slice(0, AREA_DESCRIPTION_CHARS) }]
    : areas
}

const areaValue = (index: number) => `c${index + 1}`

/** Primer paso: en qué parte de la guía está la respuesta. */
export function helpAreaQuestion(areas: readonly HelpArea[], texts: ProductAgentTexts): AdminQuestion {
  const product = productName(texts)
  return {
    id: HELP_AREA_QUESTION,
    kind: "choice",
    instructions: `Alguien del equipo de una ${clinicWord(texts)} escribe en la Ayuda de ${product}. ¿En qué parte de ${product} se hace lo que pregunta? Elige la parte donde está la respuesta, no donde está la persona ahora. Si puede estar en dos partes, reparte la probabilidad entre ellas. Si no pregunta cómo hacer algo en ${product} (un saludo, una broma, una pregunta de salud, de cocina o de cualquier otro tema), elige «ninguna».`,
    options: [
      ...areas.map((area, index) => ({ value: areaValue(index), description: `${area.label}: ${area.about}` })),
      {
        value: DATA,
        description: "Pregunta por las cifras o los datos de su clínica (cuánto, cuántos, quién, por qué un número suyo es el que es o no coincide con el de otra pantalla): lo responden sus datos, no la guía.",
      },
      { value: NONE, description: `Ninguna: no es una pregunta sobre cómo hacer algo en ${product}.` },
    ],
  }
}

export interface HelpAreaSelection {
  /** `areas`: se busca en `areas`. `ninguna` y `datos`, como en la elección de la respuesta. */
  verdict: "areas" | "ninguna" | "datos"
  /** De la más probable a la menos; vacío si Jev no dio probabilidades. */
  areas: HelpArea[]
  /** Las elegidas suman `HELP_AREA_COVER`: si la respuesta no está en ellas, no está cerca. */
  sure: boolean
  top: number | null
}

/**
 * Lee el primer paso. «Ninguna» y «datos» piden la misma certeza que al elegir
 * la respuesta. Si no, se toman las categorías más probables hasta sumar
 * `HELP_AREA_COVER` o llegar a `HELP_AREAS_MAX`. Sin probabilidades no hay
 * categoría segura: se busca en toda la guía.
 */
export function readHelpAreas(
  result: { answers: readonly AdminAnswer[] },
  areas: readonly HelpArea[],
  confident = HELP_CONFIDENT,
): HelpAreaSelection {
  const answer = result.answers.filter(isChoice).find((item) => item.id === HELP_AREA_QUESTION)
  if (!answer?.probabilities) return { verdict: "areas", areas: [], sure: false, top: null }
  const probabilities = answer.probabilities
  const byValue = new Map(areas.map((area, index) => [areaValue(index), area]))
  const ranked = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const [topValue, top] = ranked[0] ?? [NONE, 0]
  if ((topValue === NONE || topValue === DATA) && top >= confident) {
    return { verdict: topValue === NONE ? "ninguna" : "datos", areas: [], sure: true, top }
  }
  if ((probabilities[NONE] ?? 0) + (probabilities[DATA] ?? 0) >= confident) return { verdict: "ninguna", areas: [], sure: true, top }
  const picked: HelpArea[] = []
  let cover = 0
  for (const [value, probability] of ranked) {
    const area = byValue.get(value)
    if (!area) continue
    picked.push(area)
    cover += probability
    if (cover >= HELP_AREA_COVER || picked.length >= HELP_AREAS_MAX) break
  }
  return { verdict: "areas", areas: picked, sure: cover >= HELP_AREA_COVER, top }
}

/** Las respuestas de unas categorías, en el orden de la guía. */
export function helpOptionsIn(options: readonly HelpOption[], areas: ReadonlySet<string>): HelpOption[] {
  return options.filter((option) => areas.has(helpAreaOf(option)))
}

/**
 * Toda la guía en tandas que caben en una pregunta, sin partir una categoría:
 * es como se busca cuando el primer paso no fue seguro, o antes de decir que
 * algo no está. Una categoría que sola no cabe se recorta por palabras, como
 * siempre (`helpCandidates`).
 */
export function helpOptionBatches(options: readonly HelpOption[], skip: ReadonlySet<string> = new Set()): HelpOption[][] {
  const byArea = new Map<string, HelpOption[]>()
  for (const option of options) {
    const area = helpAreaOf(option)
    if (skip.has(area)) continue
    byArea.set(area, [...(byArea.get(area) ?? []), option])
  }
  const batches: HelpOption[][] = []
  let current: HelpOption[] = []
  for (const group of byArea.values()) {
    if (current.length > 0 && current.length + group.length > HELP_SELECT_MAX_OPTIONS) {
      batches.push(current)
      current = []
    }
    current = [...current, ...group]
  }
  if (current.length > 0) batches.push(current)
  // El orden de la guía dentro de cada tanda: las preguntas frecuentes antes que las pantallas.
  const order = new Map(options.map((option, index) => [option, index]))
  return batches.map((batch) => [...batch].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)))
}

/**
 * Las respuestas con que se redactaría: Jev no eligió una sola, pero entre dos
 * o tres de la guía suman la certeza. Si lo que falta para la certeza está en
 * «ninguna», no hay partes: eso es no saber, no una respuesta repartida.
 */
export function helpParts(
  result: { answers: readonly AdminAnswer[] },
  candidates: readonly HelpOption[],
  confident = HELP_CONFIDENT,
): HelpOption[] {
  const answer = result.answers.filter(isChoice).find((item) => item.id === HELP_SELECT_QUESTION)
  if (!answer?.probabilities) return []
  const byValue = new Map(candidates.map((option, index) => [optionValue(option, index), option]))
  const parts = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .flatMap(([value, probability]) => {
      const option = byValue.get(value)
      return option && probability >= HELP_PART ? [{ option, probability }] : []
    })
    .slice(0, HELP_PARTS_MAX)
  const sum = parts.reduce((total, part) => total + part.probability, 0)
  return parts.length >= 2 && sum >= confident ? parts.map((part) => part.option) : []
}

const partText = (option: HelpOption, index: number) =>
  `Texto ${index + 1} (${helpTopicLabel(option.topic)})${option.kind === "faq" ? ` · ${option.faq.q}` : ""}\n${helpAnswerText(option)}`

/** Lo que viaja para decidir si se redacta, y para redactar: la pregunta y los textos de la guía. Nada de la clínica. */
export function helpPartsState(question: string, parts: readonly HelpOption[]): string {
  return `Pregunta: ${question}\n\n${parts.map(partText).join("\n\n")}`
}

/**
 * ¿Vale redactar? Solo si los textos se completan: cada uno aporta una parte de
 * lo que se pregunta. Si son respuestas a preguntas distintas (la pregunta es
 * ambigua: «¿cómo anulo?»), se ofrecen para elegir, como siempre.
 */
export function helpJoinQuestion(texts: ProductAgentTexts): AdminQuestion {
  return {
    id: HELP_JOIN_QUESTION,
    kind: "yesno",
    instructions: `Alguien del equipo escribió una pregunta en la Ayuda de ${productName(texts)} y hay varios textos de la guía. ¿Leídos juntos, responden por completo lo que pregunta?`,
    criteria: {
      yes: "Cada texto aporta una parte de la respuesta y entre todos la completan, sin contradecirse.",
      no: "Los textos responden cosas distintas entre las que habría que elegir (la pregunta no dice cuál), o falta en ellos lo que pregunta.",
    },
  }
}

/** Lee el sí/no de `help_join`; sin respuesta, no. */
export function readHelpJoin(result: { answers: readonly AdminAnswer[] }): number {
  const answer = result.answers.find((item) => item.id === HELP_JOIN_QUESTION)
  return answer && "probability" in answer && typeof answer.probability === "number" ? answer.probability : 0
}

/** Quien redacta: recibe las instrucciones y lo que tiene delante, y devuelve el texto o nulo si no pudo. */
export type HelpWriter = (input: { system: string; user: string }) => Promise<string | null>

/** Las instrucciones de quien redacta. Solo une lo que la guía ya dice. */
export function helpWriteInstructions(texts: ProductAgentTexts): string {
  const product = productName(texts)
  return [
    `Eres Ariadna, la Ayuda de ${product}. Alguien del equipo de una ${clinicWord(texts)} hizo una pregunta y la guía la responde entre varios textos.`,
    "Escribe una sola respuesta, corta y directa, de tú, usando ÚNICAMENTE lo que dicen esos textos.",
    "Reglas:",
    "- No agregues ningún paso, botón, pantalla, rol, cifra ni plazo que no esté en los textos.",
    "- Copia los nombres de botones y pantallas tal cual, entre «».",
    "- Conserva cada «no», «solo», «nunca» y cada condición de los textos: no los suavices ni los inviertas.",
    "- Empieza por lo que responde la pregunta. Sin saludo, sin despedida, sin ofrecer más ayuda.",
    "- Texto corrido, sin listas, sin negritas, sin títulos ni enlaces. Cuatro frases como mucho.",
    "- Si con los textos no se puede responder, escribe solo: NO_SE",
  ].join("\n")
}

const QUOTED = /«([^»]+)»/g
const plainText = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ")

/**
 * Lo redactado se muestra solo si no trae nada que la guía no diga, comprobado
 * sin modelo: cada nombre entre «» y cada cifra están en los textos de origen,
 * cita al menos un nombre si los textos citan alguno, no pasa del largo y es
 * texto corrido. No ve un «no» que se volvió «sí»: por eso debajo se muestran
 * los textos de origen. Devuelve por qué no pasa, o nulo si pasa.
 */
export function helpWrittenProblem(written: string, parts: readonly HelpOption[]): string | null {
  const text = written.trim()
  if (!text || /^NO_SE\b/.test(text)) return "no_sabe"
  if (text.length > HELP_WRITTEN_MAX_CHARS) return "largo"
  if (/https?:\/\/|\*\*|^#|^\s*[-*•]\s|\n\s*\d+[.)]\s/m.test(text)) return "formato"
  const origin = parts.map((part) => helpAnswerText(part)).join("\n")
  const source = plainText(origin)
  const names = [...text.matchAll(QUOTED)].map((match) => plainText(match[1] ?? ""))
  if (names.some((name) => !source.includes(name))) return "nombre"
  if (names.length === 0 && /«[^»]+»/.test(origin)) return "sin_nombres"
  const numbers = text.match(/\d+(?:[.,]\d+)?/g) ?? []
  if (numbers.some((number) => !source.includes(number))) return "cifra"
  return null
}
