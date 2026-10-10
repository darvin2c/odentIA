import { z } from "zod"
import {
  assertAnswerShape,
  clamp01,
  DecisionError,
  type DecisionModel,
  type DecisionQuestion,
  type DecisionResult,
  withDeadline,
} from "./port.js"

/** Lee el cuerpo dentro del plazo: si se agotó, es un fallo del proveedor, no de forma. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (signal.aborted) throw new DecisionError("PROVIDER", "Jev no completó la respuesta dentro del plazo")
    return null
  }
}

/**
 * Adaptador de Jev (TypeSafe AI): POST {baseUrl}/v1/systemone con un estado
 * y preguntas noul / choice / score. Contrato según docs.typesafe.ai/api
 * (octubre de 2026); fijar el modelo versionado, no el alias.
 */
export interface JevConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: z.number() }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
])

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
})

function toJevQuestion(q: DecisionQuestion): Record<string, unknown> {
  switch (q.kind) {
    case "yesno":
      return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: { true: q.criteria.yes, false: q.criteria.no } } : {}) }
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description ?? null])) }
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.levels.map((l) => l.description ?? l.label) }
  }
}

export function createJevDecisionModel(config: JevConfig): DecisionModel {
  const baseUrl = (config.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "")
  const model = config.model ?? "jev-1.13.0"
  const doFetch = config.fetch ?? fetch
  return {
    provider: "jev",
    reportsProbabilities: true,
    async decide(state, questions, opts) {
      const startedAt = Date.now()
      // El plazo cubre cabeceras y cuerpo: un proveedor que deja la respuesta a medias no cuelga la sombra.
      const { status, raw } = await withDeadline(config.timeoutMs ?? 5_000, opts?.signal, async (signal) => {
        try {
          const response = await doFetch(`${baseUrl}/v1/systemone`, {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ state, model, questions: Object.fromEntries(questions.map((q) => [q.id, toJevQuestion(q)])) }),
            signal,
            redirect: "error",
          })
          // Sin el cuerpo de un error: podría traer texto arbitrario del proveedor.
          return { status: response.status, raw: response.ok ? await readJson(response, signal) : null }
        } catch (error) {
          throw new DecisionError("PROVIDER", `Jev no respondió: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      if (status < 200 || status >= 300) {
        throw new DecisionError(status === 401 || status === 422 ? "CONFIG" : "PROVIDER", `Jev respondió HTTP ${status}`, status)
      }
      const parsed = responseSchema.safeParse(raw)
      if (!parsed.success) throw new DecisionError("SHAPE", "La respuesta de Jev no tiene la forma esperada")
      const answers = questions.map((q): DecisionResult["answers"][number] => {
        const a = parsed.data.answers[q.id]
        if (!a) return { id: q.id, kind: "declined" }
        if (a.type === "noul") return assertAnswerShape(q, { id: q.id, kind: "yesno", probability: clamp01(a.noul) ?? 0 })
        if (a.type === "choice") {
          return assertAnswerShape(q, { id: q.id, kind: "choice", choice: a.choice, probabilities: a.probabilities, confidence: clamp01(a.confidence) })
        }
        const ordered = Object.entries(a.probabilities)
          .sort(([x], [y]) => Number(x) - Number(y))
          .map(([, p]) => p)
        return assertAnswerShape(q, { id: q.id, kind: "score", score: a.score, probabilities: ordered, confidence: clamp01(a.confidence) })
      })
      return {
        answers,
        model: parsed.data.model,
        usage: parsed.data.usage ? { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens } : null,
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
