import { z } from "zod"
import {
  assertAnswerShape,
  choiceConfidence,
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
    if (signal.aborted) throw new DecisionError("PROVIDER", "OpenAI Decisions no completó la respuesta dentro del plazo")
    return null
  }
}

/**
 * Adaptador de la Decisions API de OpenAI (beta pública desde octubre de
 * 2026): POST {baseUrl}/decisions con `input`, `questions` (predicate /
 * choice / score) y respuestas con probabilidades y confianza; una pregunta
 * puede volver como `refusal`. Contrato según developers.openai.com.
 */
export interface OpenAiDecisionsConfig {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("predicate"), name: z.string().nullable(), probability: z.number() }),
  z.object({
    type: z.literal("choice"),
    name: z.string().nullable(),
    choice: z.union([z.string(), z.boolean()]),
    probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean()]), probability: z.number() })).optional(),
    confidence: z.number().optional(),
  }),
  z.object({
    type: z.literal("score"),
    name: z.string().nullable(),
    score: z.number(),
    probabilities: z.array(z.object({ value: z.number(), label: z.string().optional(), probability: z.number() })).optional(),
    confidence: z.number().optional(),
  }),
  z.object({ type: z.literal("refusal"), name: z.string().nullable() }),
])

const responseSchema = z.object({
  model: z.string(),
  answers: z.array(answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number().optional() }).optional(),
})

function toOpenAiQuestion(q: DecisionQuestion): Record<string, unknown> {
  switch (q.kind) {
    case "yesno":
      return { type: "predicate", name: q.id, instructions: q.instructions }
    case "choice":
      return { type: "choice", name: q.id, instructions: q.instructions, choices: q.options.map((o) => ({ value: o.value, ...(o.description ? { description: o.description } : {}) })) }
    case "score":
      return { type: "score", name: q.id, instructions: q.instructions, levels: q.levels.map((l) => ({ label: l.label, ...(l.description ? { description: l.description } : {}) })) }
  }
}

export function createOpenAiDecisionModel(config: OpenAiDecisionsConfig): DecisionModel {
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")
  const model = config.model ?? "gpt-6-luna"
  const doFetch = config.fetch ?? fetch
  return {
    provider: "openai_decisions",
    reportsProbabilities: true,
    async decide(state, questions, opts) {
      const startedAt = Date.now()
      const { status, raw } = await withDeadline(config.timeoutMs ?? 5_000, opts?.signal, async (signal) => {
        try {
          const response = await doFetch(`${baseUrl}/decisions`, {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model, input: state, questions: questions.map(toOpenAiQuestion) }),
            signal,
            redirect: "error",
          })
          return { status: response.status, raw: response.ok ? await readJson(response, signal) : null }
        } catch (error) {
          throw new DecisionError("PROVIDER", `OpenAI Decisions no respondió: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
      if (status < 200 || status >= 300) {
        throw new DecisionError([400, 401, 403, 404].includes(status) ? "CONFIG" : "PROVIDER", `OpenAI Decisions respondió HTTP ${status}`, status)
      }
      const parsed = responseSchema.safeParse(raw)
      if (!parsed.success) throw new DecisionError("SHAPE", "La respuesta de OpenAI Decisions no tiene la forma esperada")
      // Se empareja por nombre; el orden solo vale cuando el proveedor no nombra y devuelve una respuesta por pregunta.
      const byIndex = parsed.data.answers.length === questions.length && parsed.data.answers.every((a) => a.name === null)
      const answers = questions.map((q, index): DecisionResult["answers"][number] => {
        const a = byIndex ? parsed.data.answers[index] : parsed.data.answers.find((x) => x.name === q.id)
        if (!a || a.type === "refusal") return { id: q.id, kind: "declined" }
        if (a.type === "predicate") return assertAnswerShape(q, { id: q.id, kind: "yesno", probability: clamp01(a.probability) ?? 0 })
        if (a.type === "choice") {
          const probabilities = a.probabilities
            ? Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability]))
            : null
          return assertAnswerShape(q, {
            id: q.id,
            kind: "choice",
            choice: String(a.choice),
            probabilities,
            confidence: clamp01(a.confidence) ?? (probabilities ? choiceConfidence(probabilities) : null),
          })
        }
        return assertAnswerShape(q, {
          id: q.id,
          kind: "score",
          score: a.score,
          probabilities: a.probabilities ? [...a.probabilities].sort((x, y) => x.value - y.value).map((p) => p.probability) : null,
          confidence: clamp01(a.confidence),
        })
      })
      return {
        answers,
        model: parsed.data.model,
        usage: parsed.data.usage ? { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens ?? 0 } : null,
        latencyMs: Date.now() - startedAt,
      }
    },
  }
}
