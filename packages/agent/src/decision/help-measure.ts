import type { HelpOption, HelpSelection } from "./help.js"

/**
 * Cómo se cuenta lo que hizo la Ayuda con una pregunta del banco
 * (`help-preguntas.json` de los servicios), para `eval:ayuda`. Sin proveedor:
 * recibe lo que se eligió y lo compara con lo que la responde.
 */

/** Una pregunta del banco. `expected` es la pantalla (la etiqueta vieja); lo demás, la respuesta. */
export interface HelpBankItem {
  q: string
  expected: string[]
  producto?: "odentia" | "latidia"
  /** Ruta de la pantalla desde donde se preguntó, si se sabe. */
  pantalla?: string
  faqs?: string[]
  temas?: string[]
  es?: "ninguna" | "datos"
  /** La misma pregunta ya está en este banco de ajuste: no cuenta para confirmar. */
  repite?: string
}

export type HelpExpected = "respuesta" | "ninguna" | "datos"

export const helpExpectedOf = (item: HelpBankItem): HelpExpected => item.es ?? "respuesta"

export const helpOptionKey = (option: HelpOption): string => (option.kind === "faq" ? `faq:${option.faq.q}` : `tema:${option.topic.id}`)

const acceptedOf = (item: HelpBankItem) => new Set([...(item.faqs ?? []).map((q) => `faq:${q}`), ...(item.temas ?? []).map((id) => `tema:${id}`)])

/**
 * Qué pasó con una pregunta. Un «seguro» está bien solo si todo lo que muestra
 * corresponde: con dos respuestas y la segunda equivocada es `segunda-mal`, que
 * cuenta como seguro y mal.
 */
export type HelpOutcome =
  | "seguro-bien"
  | "seguro-mal"
  | "segunda-mal"
  | "duda-con"
  | "duda-sin"
  | "duda-calla"
  | "ninguna-bien"
  | "ninguna-mal"
  | "datos-bien"
  | "datos-mal"

export function helpOutcome(item: HelpBankItem, selection: HelpSelection): HelpOutcome {
  const expected = helpExpectedOf(item)
  const ok = acceptedOf(item)
  if (selection.verdict === "seguro") {
    const [first, ...rest] = selection.shown
    if (!first || !ok.has(helpOptionKey(first))) return "seguro-mal"
    return rest.every((option) => ok.has(helpOptionKey(option))) ? "seguro-bien" : "segunda-mal"
  }
  if (selection.verdict === "duda") {
    if (expected !== "respuesta") return "duda-calla"
    return selection.offered.some((option) => ok.has(helpOptionKey(option))) ? "duda-con" : "duda-sin"
  }
  if (selection.verdict === "ninguna") return expected === "ninguna" ? "ninguna-bien" : "ninguna-mal"
  return expected === "datos" ? "datos-bien" : "datos-mal"
}

/** Lo que se cuenta de un grupo de preguntas. `fallback`: el proveedor no respondió y decidió el respaldo sin Jev. */
export interface HelpTally {
  n: number
  answerable: number
  unanswerable: number
  data: number
  fallback: number
  /** Preguntas sin respuesta en la guía que recibieron una igual. */
  shownWithoutAnswer: number
  outcomes: Record<HelpOutcome, number>
}

const NO_OUTCOMES: Record<HelpOutcome, number> = {
  "seguro-bien": 0,
  "seguro-mal": 0,
  "segunda-mal": 0,
  "duda-con": 0,
  "duda-sin": 0,
  "duda-calla": 0,
  "ninguna-bien": 0,
  "ninguna-mal": 0,
  "datos-bien": 0,
  "datos-mal": 0,
}

export function tallyHelp(entries: ReadonlyArray<{ item: HelpBankItem; selection: HelpSelection; fallback: boolean }>): HelpTally {
  const tally: HelpTally = { n: 0, answerable: 0, unanswerable: 0, data: 0, fallback: 0, shownWithoutAnswer: 0, outcomes: { ...NO_OUTCOMES } }
  for (const { item, selection, fallback } of entries) {
    const expected = helpExpectedOf(item)
    tally.n += 1
    if (expected === "respuesta") tally.answerable += 1
    else {
      tally.unanswerable += 1
      if (selection.verdict === "seguro") tally.shownWithoutAnswer += 1
    }
    if (expected === "datos") tally.data += 1
    if (fallback) tally.fallback += 1
    tally.outcomes[helpOutcome(item, selection)] += 1
  }
  return tally
}

/**
 * Cota inferior de Wilson al 95 %: con pocas respuestas mostradas, un 100 %
 * dice poco. Nula sin ninguna.
 */
export function wilsonLower(hits: number, total: number, z = 1.96): number | null {
  if (total === 0) return null
  const p = hits / total
  const z2 = z * z
  return (p + z2 / (2 * total) - z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / (1 + z2 / total)
}

/** Mínimos para salir (estudio X8, «Qué exigir antes de salir»). */
export const HELP_MINIMUM = { shownRight: 0.95, quietWithoutAnswer: 0.95, resolved: 0.7, p95Ms: 2_000 } as const

export interface HelpMetrics {
  sure: number
  sureRight: number
  /** Incluye las de segunda respuesta equivocada. */
  sureWrong: number
  /** De lo que muestra como respuesta, cuánto corresponde; nulo si no mostró nada. */
  shownRight: number | null
  shownRightLow: number | null
  /** De las preguntas sin respuesta en la guía, cuántas no recibieron una (calla, duda, «ninguna» o «datos»). */
  quiet: number | null
  /** De las que tienen respuesta, cuántas se resuelven solas o con un toque. */
  resolved: number | null
  dataRight: number | null
}

const share = (hits: number, total: number) => (total === 0 ? null : hits / total)

/** Si cumple los cuatro mínimos. Sin llamadas a un proveedor (`p95Ms` nulo), la demora no cuenta. */
export function meetsHelpMinimum(metrics: HelpMetrics, p95Ms: number | null): boolean {
  const atLeast = (value: number | null, minimum: number) => value !== null && value >= minimum
  return (
    atLeast(metrics.shownRight, HELP_MINIMUM.shownRight) &&
    atLeast(metrics.quiet, HELP_MINIMUM.quietWithoutAnswer) &&
    atLeast(metrics.resolved, HELP_MINIMUM.resolved) &&
    (p95Ms === null || p95Ms <= HELP_MINIMUM.p95Ms)
  )
}

export function helpMetrics(tally: HelpTally): HelpMetrics {
  const o = tally.outcomes
  const sureRight = o["seguro-bien"]
  const sureWrong = o["seguro-mal"] + o["segunda-mal"]
  const sure = sureRight + sureWrong
  return {
    sure,
    sureRight,
    sureWrong,
    shownRight: share(sureRight, sure),
    shownRightLow: wilsonLower(sureRight, sure),
    quiet: share(tally.unanswerable - tally.shownWithoutAnswer, tally.unanswerable),
    resolved: share(sureRight + o["duda-con"], tally.answerable),
    dataRight: share(o["datos-bien"], tally.data),
  }
}
