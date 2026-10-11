import { createConfiguredChatModel, type LlmSpec } from "../llm.js"
import { createBaselineDecisionModel } from "./baseline.js"
import { createFakeDecisionModel } from "./fake.js"
import { createJevDecisionModel } from "./jev.js"
import { createOpenAiDecisionModel } from "./openai.js"
import { DecisionError, type DecisionModel } from "./port.js"

export * from "./port.js"
export * from "./points.js"
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
  /** Plazo total por llamada; acota también a la línea base. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

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
  const timeoutMs = platform.timeoutMs ?? DEFAULT_TIMEOUT_MS
  switch (provider) {
    case "none":
      return null
    case "baseline": {
      if (chat.source === "fake") return createFakeDecisionModel()
      const model = await createConfiguredChatModel({ ...chat, maxRetries: 0, timeoutMs })
      return createBaselineDecisionModel(model, chat.modelName, timeoutMs)
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
