import { plain } from "./dictation-heard.js"

/*
 * ---------- El diagnóstico que contradice lo dictado ----------
 *
 * Los nombres de la CIE traen calificativos que van de a dos: con o sin algo
 * («Absceso periapical con fístula» y «… sin fístula»), agudo o crónico
 * («Periodontitis apical aguda…» y «… crónica»). Si el nombre del diagnóstico
 * que propone Clío dice uno y lo dictado dice el otro, el diagnóstico queda por
 * revisar y, si la lista de la clínica tiene el hermano que calza, se propone
 * ese (prueba con voz del 15 nov, c4b, v07: con «presenta fístula a nivel
 * apical», Clío propuso K04.7 «Absceso periapical sin fístula», listo; lo dicho
 * era K04.6). Lo decide el profesional: solo se avisa y se propone.
 */

/** Lo que el nombre del diagnóstico propuesto dice y lo dictado contradice. */
export interface DiagnosisClash {
  /** Lo del nombre que no calza: «sin fístula», «aguda». */
  named: string
  /** Lo dictado que lo contradice, tal cual: «presenta fístula», «crónico». */
  said: string
  /** La palabra del nombre que cambia y la que lleva el hermano que calza («sin» → «con», «aguda» → «crónica»). */
  from: string
  to: string
  /** Lo dictado también dice lo del nombre («no hay fístula… presenta fístula»): se revisa sin proponer otro. */
  unsure: boolean
}

/** Agudo o crónico, en cualquier género y número («aguda», «crónicos»): su raíz, o `null`. */
const courseOf = (word: string) => (word.startsWith("agud") ? "agud" : word.startsWith("cronic") ? "cronic" : null)
/** La misma palabra con el curso contrario: «aguda» → «cronica», «crónicos» → «agudos». */
const otherCourse = (word: string) => (courseOf(word) === "agud" ? word.replace(/^agud/, "cronic") : word.replace(/^cronic/, "agud"))

/** Lo que sigue a «con» o «sin» en un nombre y no es un hallazgo que se dicte: «sin especificación», «sin mención de…». */
const NOT_A_FINDING = new Set(["especificacion", "especificada", "especificado", "especificar", "mencion", "diagnostico", "quejas", "otra", "otras", "otro", "otros"])

/** Lo que niega lo que viene después: «no hay fístula», «sin fístula», «ni fístula», «ausencia de fístula». */
const NEGATES = new Set(["no", "sin", "ni", "niega", "niegan", "ausencia", "tampoco", "descarta", "descartan", "ningun", "ninguna", "ninguno"])
/** Lo que puede ir entre la negación y lo negado: «no se observa fístula», «no presenta signos de fístula». */
const BETWEEN = new Set(["hay", "habia", "hubo", "existe", "existen", "se", "le", "observa", "observan", "ve", "ven", "aprecia", "aprecian", "evidencia", "evidencian", "encuentra", "encuentran", "presenta", "presentan", "tiene", "tienen", "de", "la", "el", "los", "las", "una", "un", "signo", "signos", "dato", "datos"])
/** Lo que niega lo que va antes: «fístula tampoco», «fístula negativa». */
const NEGATES_BEFORE = new Set(["tampoco", "negativa", "negativo", "ausente", "descartada", "descartado"])

/** Las palabras de un texto, sin tildes, con dónde están, oración por oración: una negación no cruza un punto. */
function sentencesWords(text: string): Array<Array<{ word: string; start: number; end: number }>> {
  return text.split(/(?<=[.;!?\n])/).reduce<{ at: number; out: Array<Array<{ word: string; start: number; end: number }>> }>(
    ({ at, out }, sentence) => ({
      at: at + sentence.length,
      out: [...out, [...sentence.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({ word: plain(match[0]), start: at + match.index, end: at + match.index + match[0].length }))],
    }),
    { at: 0, out: [] },
  ).out
}

/** ¿Es esa palabra el término? Por sus cinco primeras letras: «fístula», «fistulizado». */
const sameTerm = (word: string, term: string) => word.length >= 4 && word.slice(0, 5) === term.slice(0, 5)

/**
 * Lo que un texto dice del término: si lo nombra afirmándolo o negándolo, con la frase de cada caso.
 * «sin dolor presenta fístula» lo afirma: el «sin» es del dolor.
 */
function mentions(text: string, term: string): { affirmed: string | null; denied: string | null } {
  let affirmed: string | null = null
  let denied: string | null = null
  for (const words of sentencesWords(text)) {
    words.forEach((item, index) => {
      if (!sameTerm(item.word, term)) return
      let back = index - 1
      while (back >= 0 && BETWEEN.has(words[back]?.word ?? "")) back -= 1
      const before = words[back]
      const after = words[index + 1]
      // «fístula no» al final de su oración también la niega; seguida de otra cosa («fístula no hay tumefacción») no se sabe de qué es.
      const negated = (before && NEGATES.has(before.word)) || (after && (NEGATES_BEFORE.has(after.word) || (after.word === "no" && index + 2 === words.length)))
      const first = negated && before && NEGATES.has(before.word) ? before : (words[Math.max(0, index - 1)] ?? item)
      const last = negated && after && !(before && NEGATES.has(before.word)) ? after : item
      const phrase = text.slice(first.start, last.end)
      if (negated) denied ??= phrase
      else affirmed ??= phrase
    })
  }
  return { affirmed, denied }
}

/**
 * Lo que el nombre `title` del diagnóstico propuesto dice y lo dictado contradice, o `null`. `phrase`:
 * lo que citó Clío para ese diagnóstico. `dictated`: lo demás que se dictó, de lo más cerca a lo más
 * lejos (la pausa, el final de la anterior, lo ya propuesto en la atención): con o sin algo se decide con
 * lo primero que lo nombra. Agudo o crónico, solo con la frase del diagnóstico: «gingivitis crónica»
 * dicho de otra cosa no cambia la periodontitis aguda.
 */
export function diagnosisClash(title: string, phrase: string, dictated: readonly string[] = []): DiagnosisClash | null {
  const words = plain(title).split(/[^a-z0-9]+/).filter(Boolean)
  const said = sentencesWords(phrase).flat()
  for (const [index, word] of words.entries()) {
    const course = courseOf(word)
    if (!course) continue
    const theOther = said.find((item) => courseOf(item.word) !== null && courseOf(item.word) !== course)
    if (theOther && !said.some((item) => courseOf(item.word) === course)) {
      return { named: titleWord(title, index), said: phrase.slice(theOther.start, theOther.end), from: word, to: otherCourse(word), unsure: false }
    }
  }
  for (const [index, word] of words.entries()) {
    if (word !== "con" && word !== "sin") continue
    const term = words[index + 1]
    if (!term || term.length < 4 || NOT_A_FINDING.has(term)) continue
    // Lo primero que lo nombra decide: la frase del diagnóstico, después la pausa, después lo anterior.
    const found = [phrase, ...dictated].map((text) => mentions(text, term)).find((item) => item.affirmed || item.denied)
    if (!found) continue
    const contradicts = word === "sin" ? found.affirmed : found.denied
    if (!contradicts) continue
    return { named: `${titleWord(title, index)} ${titleWord(title, index + 1)}`, said: contradicts, from: word, to: word === "sin" ? "con" : "sin", unsure: Boolean(word === "sin" ? found.denied : found.affirmed) }
  }
  return null
}

/** La palabra `index` del nombre, como está escrita («fístula», no «fistula»). */
function titleWord(title: string, index: number): string {
  return [...title.matchAll(/[\p{L}\p{N}]+/gu)][index]?.[0] ?? ""
}

/** Las palabras que dicen qué es un diagnóstico, sin sus calificativos ni las de enlace. */
const LINKS = new Set(["con", "sin", "de", "del", "la", "las", "el", "los", "en", "por", "y", "o", "a", "e", "no"])
const coreOf = (title: string) =>
  new Set(
    plain(title)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !LINKS.has(word) && courseOf(word) === null)
      .map((word) => word.slice(0, 5)),
  )

/**
 * El hermano que calza con lo dictado, entre `candidates` (códigos de la misma lista): el que tiene la
 * palabra contraria (`clash.to`) y dice lo mismo que el propuesto en lo demás («Absceso periapical con
 * fístula» por «… sin fístula»; «Periodontitis apical crónica» por «Periodontitis apical aguda
 * originada en la pulpa»). Primero el de su mismo nombre con esa palabra cambiada; si no, el único
 * cuyo nombre está dentro del otro, primero en su misma categoría. Nunca una categoría. `null`: no hay
 * uno solo, o lo dictado dice las dos cosas.
 */
export function diagnosisSibling<T extends { code: string; title: string; isCategory?: boolean }>(
  proposed: { code: string; title: string },
  clash: DiagnosisClash,
  candidates: readonly T[],
): T | null {
  if (clash.unsure) return null
  const own = plain(proposed.title).split(/[^a-z0-9]+/).filter(Boolean)
  const at = own.indexOf(clash.from)
  const wanted = [...own.slice(0, at), clash.to, ...own.slice(at + 1)].join(" ")
  const course = courseOf(clash.to)
  const says = (word: string) => (course ? courseOf(word) === course : word === clash.to)
  const pool = candidates.filter((item) => item.code !== proposed.code && !item.isCategory && plain(item.title).split(/[^a-z0-9]+/).some(says))
  const exact = pool.filter((item) => plain(item.title).split(/[^a-z0-9]+/).filter(Boolean).join(" ") === wanted)
  if (exact.length === 1) return exact[0] ?? null
  const mine = coreOf(proposed.title)
  const inside = (a: Set<string>, b: Set<string>) => a.size > 0 && [...a].every((word) => b.has(word))
  const fits = pool.filter((item) => {
    const theirs = coreOf(item.title)
    return inside(theirs, mine) || inside(mine, theirs)
  })
  const category = (code: string) => code.split(".")[0]
  const near = fits.filter((item) => category(item.code) === category(proposed.code))
  if (near.length === 1) return near[0] ?? null
  return fits.length === 1 ? (fits[0] ?? null) : null
}

/** La palabra con la que se buscan los hermanos en la lista: la primera que dice qué es («absceso», «periodontitis»). */
export function diagnosisHead(title: string): string {
  return (
    plain(title)
      .split(/[^a-z0-9]+/)
      .find((word) => word.length >= 4 && !LINKS.has(word) && courseOf(word) === null) ?? ""
  )
}

/** Con qué palabras se buscan en la lista los hermanos del propuesto: lo que es y el calificativo contrario («crónic», en cualquier género). */
export const diagnosisSearchWords = (title: string, clash: DiagnosisClash): string[] => [diagnosisHead(title), courseOf(clash.to) ?? clash.to].filter(Boolean)
