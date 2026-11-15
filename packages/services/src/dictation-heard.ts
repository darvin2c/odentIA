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
  const wanted = heardWords(said, vocabulary).map((item) => item.word)
  if (!wanted.length) return ""
  const heard = heardWords(transcript, vocabulary)
  for (let index = 0; index + wanted.length <= heard.length; index += 1) {
    if (!wanted.every((word, offset) => heard[index + offset]?.word === word)) continue
    const first = heard[index] as HeardWord
    const last = heard[index + wanted.length - 1] as HeardWord
    return transcript.slice(first.start, last.end)
  }
  return ""
}
