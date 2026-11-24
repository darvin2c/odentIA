/*
 * ---------- Lo que el reconocimiento de voz oyó mal ----------
 *
 * Lo dictado lo escribe el reconocimiento de voz del navegador (el de Chrome,
 * gratis), que oye mal los términos de una ficha: «over byte» por overbite,
 * «sé o d» por ceod, «volar derecha» por molar derecha, «francol» por Frankl
 * (prueba con voz del 15 nov). Para comprobar lo dicho contra la ficha, cada
 * palabra se lee por cómo suena: si suena igual que un término de la ficha, o
 * es una de sus formas revisadas (`HEARD_AS`), cuenta como ese término. Solo
 * para comprobar: lo que se muestra como «lo que dijiste» sigue siendo lo
 * dictado, tal cual. Un número nunca se lee de otra palabra.
 */

/**
 * Las formas en que Chrome oyó cada término, cuando no suenan igual con la regla
 * de `phoneticKey`. Lista corta y revisable: cada entrada sale de lo que oyó en
 * la prueba con voz del 15 nov, y solo vale si una pregunta de la ficha tiene
 * ese término. No entran las que cambian el sentido: «descarriados» era «tres
 * cariados» (el número se lo comió el reconocimiento: leerlo «cariados» le daba
 * el número del término siguiente), ni «ser obturados» por «cero obturados»
 * (un número no se lee de otra palabra).
 */
const HEARD_AS: Readonly<Record<string, readonly string[]>> = {
  overjet: ["overjat", "overjaget"],
  frankl: ["francol", "franco"],
  molar: ["volar"],
  // Chrome perdió la «c» del «ce pe o de».
  cpod: ["p o d"],
}

/**
 * Las palabras que niegan algo dicho («no», «sin», «niega», «tampoco»…), sin tildes: las mismas para
 * las fichas (un «No» solo si se negó) y para el diagnóstico (lo negado no contradice «sin fístula»).
 */
export const NEGATION_WORDS: ReadonlySet<string> = new Set([
  "no", "ni", "sin", "niega", "niegan", "negativo", "negativa", "negativos", "negativas", "ausente", "ausencia",
  "ningun", "ninguno", "ninguna", "nunca", "tampoco", "descarta",
])

/** Sin tildes ni mayúsculas, con los espacios de un texto como uno solo: como se comparan lo dicho y la ficha. */
export const plain = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * Cómo suena una palabra en español, para comparar lo oído con un término: sin
 * tildes, la b y la v iguales, la s, la c (antes de e o i) y la z iguales, la ll
 * como y, la y sin vocal detrás como i («byte» suena «bite») y sin la h muda (la
 * ch se queda).
 */
export function phoneticKey(text: string): string {
  return plain(text)
    .replace(/[^a-zñ]/g, "")
    .replace(/ch/g, "ç")
    .replace(/h/g, "")
    .replace(/ç/g, "ch")
    .replace(/ll/g, "y")
    .replace(/v/g, "b")
    .replace(/z/g, "s")
    .replace(/c(?=[ei])/g, "s")
    .replace(/y(?![aeiou])/g, "i")
}

/** Los términos de una ficha con cómo suenan y sus formas revisadas. */
export interface HeardVocabulary {
  /** Los términos tal cual (sin tildes): lo que ya es un término no se cambia. */
  words: ReadonlySet<string>
  /** Cómo suena cada término; `null` si dos suenan igual (no se elige ninguno). */
  sounds: ReadonlyMap<string, string | null>
  /** Las formas revisadas de los términos de la ficha (`HEARD_AS`). */
  aliases: ReadonlyMap<string, string>
}

/** Los términos de unos textos (rótulos y opciones de una ficha): sus palabras de cuatro letras o más. */
export function heardVocabulary(texts: readonly string[]): HeardVocabulary {
  const words = new Set(
    texts
      .flatMap((text) => plain(text).split(/[^a-z0-9ñ]+/))
      .filter((word) => word.length >= 4 && !/\d/.test(word)),
  )
  const sounds = new Map<string, string | null>()
  for (const word of words) {
    const key = phoneticKey(word)
    sounds.set(key, sounds.has(key) && sounds.get(key) !== word ? null : word)
  }
  const aliases = new Map<string, string>()
  for (const [term, forms] of Object.entries(HEARD_AS)) {
    if (!words.has(term)) continue
    for (const form of forms) aliases.set(plain(form), term)
  }
  return { words, sounds, aliases }
}

/** Los términos de las preguntas de unas fichas: sus rótulos y sus opciones. */
export function formVocabulary(questions: ReadonlyArray<{ label: string; options: readonly string[] | null }>): HeardVocabulary {
  return heardVocabulary(questions.flatMap((question) => [question.label, ...(question.options ?? [])]))
}

/** Una palabra de lo dictado, con dónde está en el texto. */
interface Token {
  text: string
  start: number
  end: number
}

/** Una palabra leída: el término que se oyó, o la palabra tal cual, con el tramo del texto que ocupa. */
interface HeardWord {
  word: string
  start: number
  end: number
}

/** Hasta cuántas palabras seguidas se juntan: «c e o d», «over byte». */
const MAX_JOINED = 4

/**
 * Las palabras de un texto leídas con los términos de la ficha: de la más larga
 * a la más corta, unas palabras seguidas (solo con espacios entre ellas) que
 * son una forma revisada o que juntas suenan como un término se leen como ese
 * término. Las cifras no se juntan ni se cambian.
 */
function heardWords(text: string, vocabulary: HeardVocabulary): HeardWord[] {
  const tokens: Token[] = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }))
  const letters = (token: Token) => /^\p{L}+$/u.test(token.text)
  const joined = (from: number, count: number) =>
    tokens.slice(from, from + count).every((token, offset) => letters(token) && (offset === 0 || /^\s+$/.test(text.slice(tokens[from + offset - 1]?.end, token.start))))
  const read: HeardWord[] = []
  for (let index = 0; index < tokens.length; ) {
    let found: { term: string; count: number } | null = null
    for (let count = Math.min(MAX_JOINED, tokens.length - index); count >= 1 && !found; count -= 1) {
      if (!joined(index, count)) continue
      const words = tokens.slice(index, index + count).map((token) => plain(token.text))
      const together = words.join("")
      if (count === 1 && vocabulary.words.has(together)) break
      const alias = vocabulary.aliases.get(words.join(" "))
      const sound = vocabulary.sounds.get(phoneticKey(together))
      // Juntas, unas letras sueltas que son el término también lo son («c e o d»).
      const term = alias ?? (sound && (count > 1 || sound !== together) ? sound : null)
      if (term) found = { term, count }
    }
    const first = tokens[index] as Token
    if (found) {
      const last = tokens[index + found.count - 1] as Token
      read.push({ word: found.term, start: first.start, end: last.end })
      index += found.count
    } else {
      read.push({ word: plain(first.text), start: first.start, end: first.end })
      index += 1
    }
  }
  return read
}

/**
 * El texto con lo mal oído escrito como el término de la ficha («sé o d cinco»
 * → «ceod cinco»); lo demás queda igual, con su puntuación. Leerlo otra vez no
 * cambia nada.
 */
export function asHeard(text: string, vocabulary: HeardVocabulary): string {
  let out = ""
  let at = 0
  for (const word of heardWords(text, vocabulary)) {
    const original = text.slice(word.start, word.end)
    if (plain(original) === word.word) continue
    out += text.slice(at, word.start) + word.word
    at = word.end
  }
  return out + text.slice(at)
}

/**
 * La frase de lo dictado que dice lo mismo que `said` leída con los términos de
 * la ficha: si Clío escribió «molar derecha clase 2» donde Chrome oyó «volar
 * derecha clase 2», es «volar derecha clase 2», tal como está en lo dictado.
 * Vacío si no está: nunca se muestra una frase que no se dictó.
 */
export function groundHeard(said: string, transcript: string, vocabulary: HeardVocabulary): string {
  const found = findHeard(said, transcript, vocabulary)
  return found ? transcript.slice(found.start, found.end) : ""
}

/** Dónde está en lo dictado la frase que dice lo mismo que `said` (`groundHeard`); `null` si no está. */
function findHeard(said: string, transcript: string, vocabulary: HeardVocabulary): { start: number; end: number } | null {
  const wanted = heardWords(said, vocabulary).map((item) => item.word)
  if (!wanted.length) return null
  const heard = heardWords(transcript, vocabulary)
  for (let index = 0; index + wanted.length <= heard.length; index += 1) {
    if (!wanted.every((word, offset) => heard[index + offset]?.word === word)) continue
    const first = heard[index] as HeardWord
    const last = heard[index + wanted.length - 1] as HeardWord
    return { start: first.start, end: last.end }
  }
  return null
}

/**
 * La frase de lo dictado que dice `said` palabra por palabra, sin mirar tildes, mayúsculas ni
 * puntuación, y con cada palabra también por cómo suena (`groundHeard`): la voz de Chrome escribe
 * «tiene asma usa salbutamol» y Clío cita «Tiene asma, usa salbutamol.» (QA del 21 nov: el asma y
 * el losartán dichos se perdían por una coma o una tilde). Si la cita entera no está, valen sus
 * pedazos (entre comas o puntos) que sí están, y se devuelve lo dictado desde el primero hasta el
 * último: una frase seguida, tal como se dijo, nunca pedazos pegados. Vacío si no se dijo.
 */
export function groundWords(said: string, transcript: string): string {
  const clean = said.replace(/[«»“”"]/gu, "").trim()
  if (!clean || !transcript.trim()) return ""
  const vocabulary = heardVocabulary([clean])
  const whole = findHeard(clean, transcript, vocabulary)
  if (whole) return transcript.slice(whole.start, whole.end)
  const spans = clean
    .split(/\s*(?:\.{3}|[.,;:!?¿¡…])\s*/u)
    .filter((piece) => /[\p{L}\p{N}]{3,}/u.test(piece))
    .map((piece) => findHeard(piece, transcript, vocabulary))
    .filter((span): span is { start: number; end: number } => span !== null)
  if (!spans.length) return ""
  const start = Math.min(...spans.map((span) => span.start))
  const end = Math.max(...spans.map((span) => span.end))
  // Pedazos muy lejos uno de otro no son una frase: queda el más largo.
  if (end - start > clean.length * 2 + 20) {
    const longest = spans.reduce((best, span) => (span.end - span.start > best.end - best.start ? span : best))
    return transcript.slice(longest.start, longest.end)
  }
  return transcript.slice(start, end)
}

/*
 * ---------- La frase que corta una pausa ----------
 *
 * El dictado se ordena por tramos, cortados en las pausas de quien dicta, y una
 * pausa a veces cae a mitad de frase: «…frío sin respuesta calor» y, en el
 * tramo siguiente, «sin respuesta también percusión negativa…» (prueba con voz
 * del 15 nov, v07). Leído solo, el tramo nuevo no dice de qué es «sin
 * respuesta», y el anterior no dice nada de «calor»: se perdía sin aviso. Si el
 * nuevo sigue la frase, Clío y el servidor leen juntos el final del anterior y
 * el comienzo del nuevo.
 */

/** Cuántas palabras del final del tramo anterior se leen con el nuevo: lo que nombra la pregunta cortada. */
const BRIDGE_WORDS = 4

/**
 * Cómo empieza un tramo que sigue una frase: sin sujeto, con el valor de algo
 * ya nombrado («sin respuesta», «positiva», «grado uno», «también», «igual») o
 * con una medida («3 mm», «de 4»). No con «en la 46» ni «y…»: eso empieza
 * otra cosa, y leerlo con lo anterior la uniría a lo que no es suyo.
 */
const CONTINUES =
  /^(?:(?:este|eh+|m+|bueno|ya|pues|digamos|o sea|a ver)\s+)*(?:tambi[eé]n|igual|tampoco|sin|positiv[oa]s?|negativ[oa]s?|normal(?:es)?|aumentad[oa]s?|disminuid[oa]s?|ausentes?|presentes?|leves?|moderad[oa]s?|sever[oa]s?|grado|de\s+\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:mm|mil[ií]metros?|kg|kilos?|%|de\s+10))(?=[\s,.;]|$)/i

/**
 * El final del tramo anterior que se lee con el nuevo, si el nuevo sigue su
 * frase: sus últimas palabras, desde el último punto. Vacío si el anterior
 * cerró su frase o el nuevo empieza otra.
 */
export function pauseBridge(context: string, transcript: string): string {
  const before = context.trim()
  if (!before || /[.?!…]$/.test(before) || !CONTINUES.test(transcript.trim())) return ""
  const tail = before.split(/(?<=[.;?!…])\s+/).at(-1) ?? ""
  return tail.split(/\s+/).filter(Boolean).slice(-BRIDGE_WORDS).join(" ")
}

/**
 * Lo dictado en la pausa con el final del tramo anterior delante, si el nuevo
 * sigue su frase (`pauseBridge`): con eso se comprueban las frases que cita
 * Clío y mira la red de las fichas.
 */
export function withPauseBridge(context: string | undefined, transcript: string): string {
  const bridge = pauseBridge(context ?? "", transcript)
  return bridge ? `${bridge} ${transcript.trim()}` : transcript
}
