import { HumanMessage } from "@langchain/core/messages"
import { AGENT_LLM_IDS, type AgentLlm } from "@odentia/services"
import { reportReplyUse } from "./ai-usage.js"
import { createConfiguredChatModel, describeProviderProblem, type LlmProblemCode, type LlmSpec, type PlatformLlm, resolveLlmSpec } from "./llm.js"

/**
 * «El modelo responde» (tablero 3 de la fase 4): una llamada mínima al modelo
 * que eligió la clínica con la cuenta de odentIA. La usan el encendido de
 * Recepción, el resumen del agente e Integraciones; el servidor rechaza
 * encender si no responde. Las cuentas son de la plataforma, así que el
 * resultado vale para toda clínica que use ese modelo y se guarda 10 minutos
 * por proceso: abrir y cerrar el cajón no repite la llamada.
 */
export const MODEL_CHECK_TTL_MS = 10 * 60_000

/** Lo justo para saber si contesta: sin reintentos y con un plazo corto. */
const PROBE_TIMEOUT_MS = 10_000

export interface ModelCheckResult {
  llm: AgentLlm
  responds: boolean
  /**
   * Por qué no responde: detalle técnico para odentIA (soporte y registros).
   * La clínica nunca lo ve: no puede arreglar una clave, un saldo o un rechazo.
   */
  problem: { code: Exclude<LlmProblemCode, "DAILY_LIMIT">; detail: string } | null
  checkedAt: string
}

/** La llamada mínima: resuelve sin error si el modelo contestó. */
export type ModelProbe = (spec: LlmSpec) => Promise<void>

export interface ModelChecker {
  /** Comprueba el modelo; con `fresh` ignora lo guardado («Volver a comprobar»). */
  check(llm: AgentLlm, options?: { fresh?: boolean }): Promise<ModelCheckResult>
  /** Lo guardado y vigente, sin llamar a nadie. */
  peek(llm: AgentLlm): ModelCheckResult | null
}

const defaultProbe: ModelProbe = async (spec) => {
  const model = await createConfiguredChatModel({ ...spec, maxRetries: 0, timeoutMs: Math.min(spec.timeoutMs, PROBE_TIMEOUT_MS) })
  const reply = await model.invoke([new HumanMessage("Responde solo: ok")])
  reportReplyUse(spec.provider, spec.modelName, reply)
}

export function createModelChecker(
  platform: PlatformLlm,
  options: { ttlMs?: number; now?: () => number; probe?: ModelProbe } = {},
): ModelChecker {
  const ttlMs = options.ttlMs ?? MODEL_CHECK_TTL_MS
  const now = options.now ?? Date.now
  const probe = options.probe ?? defaultProbe
  const saved = new Map<AgentLlm, { result: ModelCheckResult; at: number }>()
  // Dos pantallas que preguntan a la vez comparten la misma llamada.
  const running = new Map<AgentLlm, Promise<ModelCheckResult>>()

  async function run(llm: AgentLlm): Promise<ModelCheckResult> {
    let problem: ModelCheckResult["problem"] = null
    try {
      await probe(resolveLlmSpec({ llm }, platform))
    } catch (error) {
      const described = describeProviderProblem(error)
      problem = { code: described.code === "DAILY_LIMIT" ? "PROVIDER_REJECTED" : described.code, detail: described.detail }
    }
    const at = now()
    const result: ModelCheckResult = { llm, responds: problem === null, problem, checkedAt: new Date(at).toISOString() }
    saved.set(llm, { result, at })
    return result
  }

  function peek(llm: AgentLlm): ModelCheckResult | null {
    const hit = saved.get(llm)
    return hit && now() - hit.at < ttlMs ? hit.result : null
  }

  return {
    peek,
    check(llm, { fresh = false } = {}) {
      if (!fresh) {
        const hit = peek(llm)
        if (hit) return Promise.resolve(hit)
      }
      const inFlight = running.get(llm)
      if (inFlight) return inFlight
      const pending = run(llm).finally(() => running.delete(llm))
      running.set(llm, pending)
      return pending
    },
  }
}

/** El otro modelo que puede elegir la clínica (hay dos, ADR 0022). */
export function otherAgentLlm(llm: AgentLlm): AgentLlm | null {
  return AGENT_LLM_IDS.find((id) => id !== llm) ?? null
}

/** Lo que entrega el servidor a la pantalla: si responde y, si no, si el otro sí. Nunca el detalle técnico. */
export interface AgentModelStatus {
  llm: AgentLlm
  responds: boolean
  /** Solo cuando el elegido no responde: si el otro sí (para «Usar el otro»). */
  other: { llm: AgentLlm; responds: boolean } | null
  checkedAt: string
}

/**
 * Comprueba el modelo elegido y, si no responde, el otro. Devuelve también
 * los que fallaron para que quien llama avise a odentIA.
 */
export async function checkAgentModels(
  checker: ModelChecker,
  llm: AgentLlm,
  options: { fresh?: boolean } = {},
): Promise<{ status: AgentModelStatus; failed: ModelCheckResult[] }> {
  const current = await checker.check(llm, options)
  if (current.responds) return { status: { llm, responds: true, other: null, checkedAt: current.checkedAt }, failed: [] }
  const otherLlm = otherAgentLlm(llm)
  const other = otherLlm ? await checker.check(otherLlm, options) : null
  return {
    status: {
      llm,
      responds: false,
      other: other ? { llm: other.llm, responds: other.responds } : null,
      checkedAt: current.checkedAt,
    },
    failed: [current, ...(other && !other.responds ? [other] : [])],
  }
}
