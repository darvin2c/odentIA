import { FINDINGS, type FindingDefinition } from "@odentia/dental"
import { normalizeSearchText } from "@odentia/ui-patterns"

/**
 * Cómo se dice en la clínica lo que la norma (NTS 188) llama de otro modo: «resina» es una
 * restauración, «funda» una corona. «Endodoncia» es además un tratamiento: el hallazgo es el
 * tratamiento de conducto que la pieza ya tiene (en azul), y el buscador ofrece también agregarla al plan.
 * Los nombres de todos los días («curación», «funda», «resto radicular») son de uso común en el Perú.
 */
const FINDING_SYNONYMS: Partial<Record<string, readonly string[]>> = {
  definitive_restoration: ["resina", "obturacion", "curacion"],
  root_remnant: ["resto radicular"],
  crown: ["funda"],
  root_canal_treatment: ["endodoncia", "conducto"],
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
  const otherwise = FINDINGS.filter(
    (finding) =>
      !named.has(finding.code) &&
      ((finding.variants ?? []).some((variant) =>
        normalizeSearchText(variant.label).includes(query),
      ) ||
        (query.length >= ELSEWHERE_MIN &&
          (FINDING_SYNONYMS[finding.code] ?? []).some(
            (word) => word.includes(query) || query.includes(word),
          ))),
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
