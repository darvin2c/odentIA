import { FINDINGS, type FindingDefinition } from "@odentia/dental"
import { normalizeSearchText } from "@odentia/ui-patterns"

/**
 * Cómo se dice en la clínica lo que la norma (NTS 188) llama de otro modo: «resina» es una
 * restauración, «funda» una corona. «Endodoncia» es además un tratamiento: el hallazgo es el
 * tratamiento de conducto que la pieza ya tiene (en azul), y el buscador ofrece también agregarla al plan.
 * Los nombres de todos los días («curación», «funda», «resto radicular») son de uso común en el Perú.
 * Lo temporal se dice igual con «temporal» o «provisional»: «curación temporal» es la restauración
 * temporal, no la definitiva.
 */
const FINDING_SYNONYMS: Partial<Record<string, readonly string[]>> = {
  definitive_restoration: ["resina", "obturacion", "curacion"],
  temporary_restoration: ["curacion temporal", "obturacion temporal", "curacion provisional", "obturacion provisional"],
  root_remnant: ["resto radicular"],
  crown: ["funda"],
  temporary_crown: ["funda temporal", "funda provisional", "corona provisional"],
  root_canal_treatment: ["endodoncia", "conducto"],
}

/**
 * Los hallazgos que se dicen así. Lo escrito que trae un sinónimo entero se queda con el más largo
 * («curación temporal» lleva «curación», y es la temporal); solo si no trae ninguno, vale lo que
 * se está escribiendo («cura» es las dos).
 */
function findingsSaidAs(query: string): Set<string> {
  if (query.length < ELSEWHERE_MIN) return new Set()
  const entries = Object.entries(FINDING_SYNONYMS) as [string, readonly string[]][]
  const contained = entries.map(
    ([code, words]) => [code, Math.max(0, ...words.filter((word) => query.includes(word)).map((word) => word.length))] as const,
  )
  const longest = Math.max(0, ...contained.map(([, length]) => length))
  if (longest > 0) return new Set(contained.filter(([, length]) => length === longest).map(([code]) => code))
  return new Set(entries.filter(([, words]) => words.some((word) => word.includes(query))).map(([code]) => code))
}

/**
 * Lo que se cuenta y no se observa en la pieza: es el motivo de consulta. Cada palabra con cómo se
 * dice en la frase («El dolor es el motivo de consulta»).
 */
const REASON_WORDS: ReadonlyArray<readonly [word: string, said: string]> = [
  ["dolor", "El dolor"],
  ["duele", "El dolor"],
  ["molestia", "La molestia"],
  ["sensibilidad", "La sensibilidad"],
  ["hinchazon", "La hinchazón"],
  ["hinchado", "La hinchazón"],
  ["hinchada", "La hinchazón"],
  ["sangrado de encias", "El sangrado de encías"],
  ["sangran las encias", "El sangrado de encías"],
  ["sangrado", "El sangrado"],
]

/** Desde cuántas letras se busca fuera de los hallazgos: con menos, «pu» no es nada todavía. */
const ELSEWHERE_MIN = 3
/** Desde cuántas letras una palabra a medio escribir ya es del motivo («dolo»). */
const REASON_MIN = 4

export interface FindingSearch {
  /** Lo escrito, sin tildes ni mayúsculas. */
  query: string
  /** Los hallazgos que coinciden por su nombre, sus variantes o cómo se dicen. */
  findings: readonly FindingDefinition[]
  /** «El dolor»: es el motivo de consulta, no un hallazgo; null si no lo es. */
  reason: string | null
  /**
   * Buscar también en diagnósticos y tratamientos: ningún hallazgo se llama así (puede que uno se
   * diga así, como «endodoncia»). Con el motivo, no: el dolor no es un diagnóstico.
   */
  elsewhere: boolean
}

/** Lo que dice el buscador de «¿Qué observas?» para lo escrito. */
export function searchFindings(text: string): FindingSearch {
  const query = normalizeSearchText(text.trim()).replace(/\s+/g, " ")
  if (!query) return { query, findings: FINDINGS, reason: null, elsewhere: false }
  const byName = FINDINGS.filter((finding) => normalizeSearchText(finding.label).includes(query))
  const named = new Set(byName.map((finding) => finding.code))
  const saidAs = findingsSaidAs(query)
  const otherwise = FINDINGS.filter(
    (finding) =>
      !named.has(finding.code) &&
      ((finding.variants ?? []).some((variant) =>
        normalizeSearchText(variant.label).includes(query),
      ) ||
        saidAs.has(finding.code)),
  )
  const reason =
    query.length >= REASON_MIN
      ? (REASON_WORDS.find(([word]) => word.startsWith(query) || query.includes(word))?.[1] ?? null)
      : null
  return {
    query,
    findings: [...byName, ...otherwise],
    reason,
    elsewhere: reason === null && byName.length === 0 && query.length >= ELSEWHERE_MIN,
  }
}
