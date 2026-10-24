import { HumanMessage } from "@langchain/core/messages"
import { reportReplyUse } from "./ai-usage.js"
import {
  createConfiguredChatModel,
  describeProviderProblem,
  type LlmProblemCode,
  type LlmSpec,
  llmModelName,
  type PlatformLlm,
  resolveLlmSpec,
} from "./llm.js"

/**
 * «El modelo responde» (tablero 3 de la fase 4): una llamada mínima al modelo
 * que escribe con la cuenta de odentIA. La usan el encendido de Recepción, el
 * resumen del agente e Integraciones; el servidor rechaza encender si no
 * responde. Modelo y cuenta son de la plataforma, así que el resultado vale
 * para toda clínica y se guarda 10 minutos por proceso: abrir y cerrar el
 * cajón no repite la llamada.
 */
export const MODEL_CHECK_TTL_MS = 10 * 60_000

/** Lo justo para saber si contesta: sin reintentos y con un plazo corto. */
const PROBE_TIMEOUT_MS = 10_000

export interface ModelCheckResult {
  /** Nombre exacto del modelo comprobado (`fake` en desarrollo). */
  model: string
  responds: boolean
  /**
   * Por qué no responde: detalle técnico para odentIA (soporte y registros).
   * La clínica nunca lo ve: no puede arreglar una clave, un saldo o un rechazo.
   */
  problem: { code: LlmProblemCode; detail: string } | null
  checkedAt: string
}

/** La llamada mínima: resuelve sin error si el modelo contestó. */
export type ModelProbe = (spec: LlmSpec) => Promise<void>

export interface ModelChecker {
  /** Comprueba el modelo; con `fresh` ignora lo guardado («Volver a comprobar»). */
  check(options?: { fresh?: boolean }): Promise<ModelCheckResult>
  /** Lo guardado y vigente, sin llamar a nadie. */
  peek(): ModelCheckResult | null
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
  let saved: { result: ModelCheckResult; at: number } | null = null
  // Dos pantallas que preguntan a la vez comparten la misma llamada.
  let running: Promise<ModelCheckResult> | null = null

  async function run(): Promise<ModelCheckResult> {
    let problem: ModelCheckResult["problem"] = null
    const model = llmModelName(platform)
    try {
      await probe(resolveLlmSpec(platform))
    } catch (error) {
      const described = describeProviderProblem(error)
      problem = { code: described.code, detail: described.detail }
    }
    const at = now()
    const result: ModelCheckResult = { model, responds: problem === null, problem, checkedAt: new Date(at).toISOString() }
    saved = { result, at }
    return result
  }

  function peek(): ModelCheckResult | null {
    return saved && now() - saved.at < ttlMs ? saved.result : null
  }

  return {
    peek,
    check({ fresh = false } = {}) {
      if (!fresh) {
        const hit = peek()
        if (hit) return Promise.resolve(hit)
      }
      if (running) return running
      const pending = run().finally(() => {
        running = null
      })
      running = pending
      return pending
    },
  }
}

/** Lo que entrega el servidor a la pantalla: si responde. Nunca el detalle técnico. */
export interface AgentModelStatus {
  responds: boolean
  checkedAt: string
}
