import type { BaseMessage } from "@langchain/core/messages"
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { Runnable } from "@langchain/core/runnables"
import { z } from "zod"
import { assertAnswerShape, DecisionError, type DecisionModel, type DecisionQuestion, type DecisionResult, withDeadline } from "./port.js"

/**
 * Línea base: el LLM de conversación responde las preguntas en JSON. No
 * entrega probabilidades (confianza null): sirve para comparar a los
 * modelos de decisión y como respaldo cuando una organización no tiene uno.
 * Debe recibir un modelo sin reintentos y con su propio plazo.
 */
export function createBaselineDecisionModel(
  model: Runnable<BaseMessage[], AIMessage>,
  modelName: string,
  timeoutMs = 5_000,
): DecisionModel {
  return {
    provider: "baseline",
    reportsProbabilities: false,
    async decide(state, questions, opts) {
      const startedAt = Date.now()
      const spec = questions
        .map((q) => {
          // Los mismos criterios que recibe Jev: el respaldo decide con la misma regla.
          if (q.kind === "yesno") {
            return `- "${q.id}": true or false. ${q.instructions}${q.criteria ? ` True: ${q.criteria.yes} False: ${q.criteria.no}` : ""}`
          }
          if (q.kind === "choice") {
            return `- "${q.id}": exactly one of ${q.options.map((o) => JSON.stringify(o.value)).join(", ")}. ${q.instructions}${q.options.some((o) => o.description) ? ` Options: ${q.options.map((o) => `${o.value} = ${o.description ?? o.value}`).join("; ")}.` : ""}`
          }
          return `- "${q.id}": an integer from 0 to ${q.levels.length - 1} (${q.levels.map((l, i) => `${i} = ${l.description ?? l.label}`).join("; ")}). ${q.instructions}`
        })
        .join("\n")
      const reply = await withDeadline(timeoutMs, opts?.signal, (signal) =>
        model.invoke(
          [
            new SystemMessage(
              `You answer bounded questions about a state and reply with a single JSON object and nothing else. Keys and allowed values:\n${spec}`,
            ),
            new HumanMessage(`State:\n${state}`),
          ],
          { signal, timeout: timeoutMs },
        ),
      )
      const text =
        typeof reply.content === "string"
          ? reply.content
          : reply.content
              .map((part) => (typeof part === "string" ? part : part.type === "text" ? part.text : ""))
              .join("\n")
      const match = /\{[\s\S]*\}/.exec(text)
      let raw: unknown
      try {
        raw = JSON.parse(match?.[0] ?? "")
      } catch {
        throw new DecisionError("SHAPE", "La línea base no devolvió JSON")
      }
      const parsed = z.record(z.string(), z.unknown()).safeParse(raw)
      if (!parsed.success) throw new DecisionError("SHAPE", "La línea base no devolvió un objeto")
      const answers = questions.map((q): DecisionResult["answers"][number] => {
        const value = parsed.data[q.id]
        if (q.kind === "yesno") {
          if (typeof value !== "boolean") return { id: q.id, kind: "declined" }
          return { id: q.id, kind: "yesno", probability: value ? 1 : 0 }
        }
        if (q.kind === "choice") {
          const choice = typeof value === "string" ? value : null
          if (!choice || !q.options.some((o) => o.value === choice)) return { id: q.id, kind: "declined" }
          return assertAnswerShape(q, { id: q.id, kind: "choice", choice, probabilities: null, confidence: null })
        }
        const score = typeof value === "number" && Number.isInteger(value) && value >= 0 && value < q.levels.length ? value : null
        if (score === null) return { id: q.id, kind: "declined" }
        return { id: q.id, kind: "score", score, probabilities: null, confidence: null }
      })
      const meta = (reply.usage_metadata ?? {}) as { input_tokens?: unknown; output_tokens?: unknown }
      const usage =
        typeof meta.input_tokens === "number" && typeof meta.output_tokens === "number"
          ? { inputTokens: meta.input_tokens, outputTokens: meta.output_tokens }
          : null
      return { answers, model: modelName, usage, latencyMs: Date.now() - startedAt }
    },
  }
}

export type { DecisionQuestion }
