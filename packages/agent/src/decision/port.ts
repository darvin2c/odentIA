/**
 * Puerto de decisión: preguntas tipadas sobre un estado y respuestas con
 * probabilidades. Un modelo de decisión no genera texto; el flujo de
 * control, las reglas y los efectos siguen en código. La confianza solo
 * puede endurecer la autonomía configurada, nunca relajarla.
 */
export type DecisionQuestion =
  | { id: string; kind: "yesno"; instructions: string; criteria?: { yes: string; no: string } }
  | { id: string; kind: "choice"; instructions: string; options: Array<{ value: string; description?: string }> }
  | { id: string; kind: "score"; instructions: string; levels: Array<{ label: string; description?: string }> }

export type DecisionAnswer =
  | { id: string; kind: "yesno"; probability: number }
  | { id: string; kind: "choice"; choice: string; probabilities: Record<string, number> | null; confidence: number | null }
  | { id: string; kind: "score"; score: number; probabilities: number[] | null; confidence: number | null }
  /** El proveedor se negó a responder esa pregunta; nunca se interpreta como un valor. */
  | { id: string; kind: "declined" }

export interface DecisionResult {
  answers: DecisionAnswer[]
  /** Identificador versionado que reportó el proveedor. */
  model: string
  usage: { inputTokens: number; outputTokens: number } | null
  latencyMs: number
}

export interface DecisionModel {
  provider: "jev" | "openai_decisions" | "baseline" | "fake"
  /** false: las respuestas no traen distribución y la confianza es null. */
  reportsProbabilities: boolean
  decide(state: string, questions: DecisionQuestion[], opts?: { signal?: AbortSignal }): Promise<DecisionResult>
}

export class DecisionError extends Error {
  constructor(
    public readonly code: "CONFIG" | "PROVIDER" | "SHAPE",
    message: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "DecisionError"
  }
}

/**
 * Confianza de una elección derivada de su distribución, como la define
 * TypeSafe: 1 si toda la probabilidad cae en una opción, 0 si es uniforme.
 */
export function choiceConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities)
  const n = values.length
  if (n < 2) return 1
  const max = Math.max(...values)
  return Math.max(0, Math.min(1, (max - 1 / n) / (1 - 1 / n)))
}

export function clamp01(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null
}

/**
 * Ejecuta una llamada con plazo total (cabeceras y cuerpo) y señal externa
 * opcional; una señal ya abortada corta antes de empezar y el listener se
 * retira al terminar.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new DecisionError("PROVIDER", "Llamada cancelada antes de empezar")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Comprueba que la respuesta del proveedor corresponde a la pregunta; si no, el contrato está roto. */
export function assertAnswerShape(question: DecisionQuestion, answer: DecisionAnswer): DecisionAnswer {
  if (answer.kind === "declined") return answer
  if (answer.kind !== question.kind) {
    throw new DecisionError("SHAPE", `La respuesta a ${question.id} es de tipo ${answer.kind}, se esperaba ${question.kind}`)
  }
  if (answer.kind === "choice" && question.kind === "choice" && !question.options.some((o) => o.value === answer.choice)) {
    throw new DecisionError("SHAPE", `La respuesta a ${question.id} no es una de sus opciones`)
  }
  if (answer.kind === "score" && question.kind === "score" && (answer.score < 0 || answer.score > question.levels.length - 1)) {
    throw new DecisionError("SHAPE", `La puntuación de ${question.id} está fuera de sus niveles`)
  }
  return answer
}

/** Respuesta de una pregunta por id, tipada; `declined` o ausente devuelven null. */
export function answerOf<K extends DecisionAnswer["kind"]>(
  result: DecisionResult,
  id: string,
  kind: K,
): Extract<DecisionAnswer, { kind: K }> | null {
  const found = result.answers.find((a) => a.id === id)
  return found && found.kind === kind ? (found as Extract<DecisionAnswer, { kind: K }>) : null
}
