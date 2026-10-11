import { type KnowledgeEntryItem, scoreKnowledgeMatch } from "@odentia/services"
import { answerOf, type DecisionQuestion, type DecisionResult } from "./port.js"

/**
 * Elección de conocimiento: el modelo de decisión dice qué respuestas
 * oficiales aplican al último mensaje, y solo esas viajan completas al modelo
 * que escribe. No decide ningún acto: si se equivoca, el que escribe aún tiene
 * el índice y la búsqueda. Versionada como el triaje: cambiar la redacción o
 * el orden de las opciones invalida los umbrales medidos.
 */
export const KNOWLEDGE_SELECT_VERSION = "knowledge.v1"
export const KNOWLEDGE_SELECT_QUESTION = "topic"
/** Opciones por pregunta que admiten los proveedores, dejando sitio a «ninguna». */
export const KNOWLEDGE_SELECT_MAX_OPTIONS = 250
/** Desde esta probabilidad el tema elegido se da por bueno y no se trae nada más. */
export const KNOWLEDGE_CONFIDENT = 0.6
/** Por debajo de esto una opción no se considera candidata. */
const KNOWLEDGE_CANDIDATE = 0.15
const KNOWLEDGE_MAX_PICKS = 3
const NONE = "none"

const optionValue = (index: number) => `k${index + 1}`

/**
 * Respuestas que entran en la pregunta. Con más de las que admite el
 * proveedor, se quedan las que más se parecen por palabras: es un filtro
 * previo, no la elección.
 */
export function knowledgeCandidates(entries: KnowledgeEntryItem[], latest: string): KnowledgeEntryItem[] {
  if (entries.length <= KNOWLEDGE_SELECT_MAX_OPTIONS) return entries
  return entries
    .map((entry, index) => ({ entry, index, score: scoreKnowledgeMatch(latest, entry) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, KNOWLEDGE_SELECT_MAX_OPTIONS)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.entry)
}

export function knowledgeQuestion(candidates: KnowledgeEntryItem[]): DecisionQuestion {
  return {
    id: KNOWLEDGE_SELECT_QUESTION,
    kind: "choice",
    instructions:
      "Which official answer of the dental clinic, if any, answers the latest message from the contact? Choose `none` when no listed answer applies or the message is not a question about the clinic.",
    options: [
      ...candidates.map((entry, index) => ({
        value: optionValue(index),
        description: [entry.title, ...entry.askForms].join(" / ").slice(0, 240),
      })),
      { value: NONE, description: "No listed answer applies." },
    ],
  }
}

export interface KnowledgeSelection {
  /** Respuestas que viajan completas en este turno. */
  picked: KnowledgeEntryItem[]
  /**
   * `seguro`: basta con lo elegido. `ninguno`: el mensaje no pide conocimiento.
   * `duda`: se paga más (todo el conocimiento si cabe, o elige el que escribe).
   */
  verdict: "seguro" | "duda" | "ninguno"
  /** Probabilidad de la opción más alta; nulo si el proveedor no entrega distribución. */
  top: number | null
}

/** Lee la respuesta del modelo de decisión. Sin distribución no hay certeza: siempre es duda. */
export function readKnowledgeSelection(result: DecisionResult, candidates: KnowledgeEntryItem[]): KnowledgeSelection {
  const answer = answerOf(result, KNOWLEDGE_SELECT_QUESTION, "choice")
  if (!answer) return { picked: [], verdict: "duda", top: null }
  const byValue = new Map(candidates.map((entry, index) => [optionValue(index), entry]))
  if (!answer.probabilities) {
    const entry = byValue.get(answer.choice)
    return { picked: entry ? [entry] : [], verdict: "duda", top: null }
  }
  const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])
  const [topValue, topProbability] = ranked[0] ?? [NONE, 0]
  if (topValue === NONE) {
    return { picked: [], verdict: topProbability >= KNOWLEDGE_CONFIDENT ? "ninguno" : "duda", top: topProbability }
  }
  const picked = ranked
    .filter(([value, probability]) => value !== NONE && probability >= KNOWLEDGE_CANDIDATE)
    .slice(0, KNOWLEDGE_MAX_PICKS)
    .map(([value]) => byValue.get(value))
    .filter((entry): entry is KnowledgeEntryItem => entry !== undefined)
  return { picked, verdict: topProbability >= KNOWLEDGE_CONFIDENT ? "seguro" : "duda", top: topProbability }
}

/** Qué se eligió, para el libro de decisiones: títulos y veredicto, nunca el texto del interlocutor. */
export function knowledgeOutcome(selection: KnowledgeSelection, candidates: number): Record<string, unknown> {
  return {
    verdict: selection.verdict,
    top: selection.top,
    picked: selection.picked.map((entry) => entry.title),
    candidates,
  }
}
