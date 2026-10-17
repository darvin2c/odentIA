import { reportAiUse } from "../ai-usage.js"
import { createConfiguredChatModel, type LlmSpec } from "../llm.js"
import { createBaselineDecisionModel } from "./baseline.js"
import { createFakeDecisionModel } from "./fake.js"
import { createJevDecisionModel } from "./jev.js"
import { createOpenAiDecisionModel } from "./openai.js"
import { DecisionError, type DecisionModel } from "./port.js"

export * from "./port.js"
export * from "./points.js"
export * from "./knowledge.js"
export { createBaselineDecisionModel } from "./baseline.js"
export { createFakeDecisionModel } from "./fake.js"
export { createJevDecisionModel } from "./jev.js"
export { createOpenAiDecisionModel } from "./openai.js"

export const DECISION_PROVIDERS = ["none", "baseline", "jev", "openai_decisions"] as const
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number]

/** Credenciales de plataforma de los modelos de decisión (entorno de API y worker). */
export interface PlatformDecisions {
  jev?: { apiKey: string; baseUrl?: string; model?: string }
  openai?: { apiKey: string; baseUrl?: string; model?: string }
  /** Plazo total por llamada; la línea base nunca baja de `CHAT_DECISION_TIMEOUT_MS`. */
  timeoutMs?: number
}

/**
 * Camino y conocimiento se deciden uno tras otro antes de responder: con Jev
 * colgado, lo peor son 4 s más de espera. Jev tarda 70–500 ms por decisión
 * (TypeSafe); `latency_ms` del libro de decisiones dice cuánto en la práctica.
 */
const DEFAULT_TIMEOUT_MS = 2_000
/**
 * El modelo que escribe no es un clasificador y tarda más: cuando responde
 * preguntas cerradas (línea base) no baja de este plazo aunque el de los
 * modelos de decisión sea menor.
 */
const CHAT_DECISION_TIMEOUT_MS = 5_000

/**
 * Toda clínica nace con Jev (ADR 0047): sin `JEV_API_KEY` cada mensaje se
 * atiende sin modelo de decisión y lo ajeno vuelve a cobrarse. API y worker lo
 * dicen al arrancar, sin detenerse (el agente sigue respondiendo), y cada
 * corrida abre o suma la clínica al caso «Modelo sin responder» de Soporte.
 * Con el modelo de demostración no hay cuenta real: no aplica.
 */
export function decisionKeyStartProblem(env: { JEV_API_KEY?: string | undefined; LLM_MODEL?: string | undefined }): string | null {
  if (env.LLM_MODEL?.trim() === "fake" || env.JEV_API_KEY?.trim()) return null
  return "Falta JEV_API_KEY: Jev es el modelo de decisión de toda clínica. Sin él, los mensajes ajenos a la clínica se atienden con el modelo que escribe y se cobran"
}

/**
 * Modelo de decisión de una organización. `baseline` construye un modelo de
 * chat propio sin reintentos y con el plazo de decisión (nunca reutiliza el
 * de la corrida); con el LLM falso es el modelo de decisión falso, así
 * dev/e2e siguen deterministas. Los comerciales exigen clave de plataforma.
 */
export async function createDecisionModel(
  provider: DecisionProvider,
  platform: PlatformDecisions,
  chat: LlmSpec,
): Promise<DecisionModel | null> {
  const model = await buildDecisionModel(provider, platform, chat)
  return model && model.provider !== "fake" ? metered(model) : model
}

/** Cada respuesta queda anotada en la operación medida con lo que reportó el proveedor. */
function metered(model: DecisionModel): DecisionModel {
  return {
    ...model,
    async decide(state, questions, opts) {
      const result = await model.decide(state, questions, opts)
      reportAiUse({
        provider: model.provider,
        model: result.model,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
      })
      return result
    },
  }
}

async function buildDecisionModel(
  provider: DecisionProvider,
  platform: PlatformDecisions,
  chat: LlmSpec,
): Promise<DecisionModel | null> {
  const timeoutMs = platform.timeoutMs ?? DEFAULT_TIMEOUT_MS
  switch (provider) {
    case "none":
      return null
    case "baseline": {
      if (chat.provider === "fake") return createFakeDecisionModel()
      const chatTimeoutMs = Math.max(timeoutMs, CHAT_DECISION_TIMEOUT_MS)
      const model = await createConfiguredChatModel({ ...chat, maxRetries: 0, timeoutMs: chatTimeoutMs })
      return createBaselineDecisionModel(model, chat.modelName, chatTimeoutMs)
    }
    case "jev":
      if (!platform.jev) throw new DecisionError("CONFIG", "La plataforma no tiene credenciales de Jev (JEV_API_KEY)")
      return createJevDecisionModel({ ...platform.jev, timeoutMs })
    case "openai_decisions":
      if (!platform.openai) {
        throw new DecisionError("CONFIG", "La plataforma no tiene credenciales de OpenAI Decisions (OPENAI_DECISIONS_API_KEY)")
      }
      return createOpenAiDecisionModel({ ...platform.openai, timeoutMs })
  }
}
