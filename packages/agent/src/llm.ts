import { ChatOpenAI } from "@langchain/openai"
import { ServiceError } from "@odentia/services"
import { FakeChatModel } from "./fake-model.js"

/** Códigos de problema del proveedor. */
export type LlmProblemCode = "API_KEY_REQUIRED" | "PROVIDER_REJECTED" | "PROVIDER_QUOTA"

/** La plataforma no puede usar el modelo (le falta la cuenta del proveedor). */
export class LlmConfigError extends Error {
  constructor(
    public readonly code: "API_KEY_REQUIRED",
    message: string,
  ) {
    super(message)
    this.name = "LlmConfigError"
  }
}

export type LlmProvider = "openai"

/** Cuenta de odentIA en un proveedor. */
export interface ProviderAccount {
  apiKey: string
  /** Solo si no es la API pública del proveedor (una pasarela propia de odentIA). */
  baseUrl?: string
}

/**
 * Cuentas de la plataforma (entorno de API y worker). La clínica no trae la
 * suya ni elige modelo: odentIA pone la cuenta y el modelo (ADR 0052).
 */
export interface PlatformLlm {
  /** Desarrollo y pruebas (`LLM_MODEL=fake`): el modelo determinista, sin proveedor. */
  fake?: boolean
  openai?: ProviderAccount
  timeoutMs?: number
  maxRetries?: number
}

/**
 * El modelo que escribe, el mismo para toda clínica (ADR 0052; en pantalla,
 * `AGENT_MODEL_LABEL` de los servicios). odentIA lo cambia aquí y la clínica
 * no tiene que hacer nada.
 */
export const AGENT_MODEL = {
  provider: "openai",
  /** Nombre exacto del modelo en el proveedor; la clínica nunca lo ve. */
  modelName: "gpt-6-luna",
  // gpt-6-luna en chat/completions rechaza herramientas si el razonamiento no va en `none`.
  reasoningEffort: "none",
  /**
   * Recepción piensa antes de responder: sin razonar, el modelo volvía a pedir
   * lo que la persona acababa de decir o cambiaba el trato (auditoría del
   * ADR 0104). Con razonamiento, gpt-6-luna va por /v1/responses
   * (`createConfiguredChatModel`); la simulación usa el mismo.
   */
  receptionReasoning: "low",
} as const satisfies { provider: LlmProvider; modelName: string; reasoningEffort: string; receptionReasoning: "low" | "medium" | "high" }

/** Modelo efectivo de una corrida: una sola fuente para proveedor, modelo y cuenta. */
export interface LlmSpec {
  provider: LlmProvider | "fake"
  modelName: string
  apiKey?: string
  baseUrl?: string
  timeoutMs: number
  maxRetries: number
  reasoningEffort?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 2

/** Nombre con que la corrida registra el modelo, aun antes de resolver la cuenta. */
export function llmModelName(platform: PlatformLlm): string {
  return platform.fake ? "fake" : AGENT_MODEL.modelName
}

/**
 * Resuelve el modelo que escribe con la cuenta de odentIA. Único resolvedor
 * para corrida, simulación, dictado, Administrador y evaluaciones. Sin la
 * clave lanza `LlmConfigError`.
 */
export function resolveLlmSpec(platform: PlatformLlm): LlmSpec {
  const common = {
    timeoutMs: platform.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: platform.maxRetries ?? DEFAULT_MAX_RETRIES,
  }
  if (platform.fake) return { ...common, provider: "fake", modelName: "fake" }
  const account = platform.openai
  if (!account?.apiKey) {
    throw new LlmConfigError("API_KEY_REQUIRED", "La plataforma no tiene la clave de OpenAI configurada (LLM_OPENAI_API_KEY)")
  }
  return {
    ...common,
    provider: AGENT_MODEL.provider,
    modelName: AGENT_MODEL.modelName,
    apiKey: account.apiKey,
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    reasoningEffort: AGENT_MODEL.reasoningEffort,
  }
}

/** Variables de entorno de las cuentas de la plataforma (API, worker y evaluaciones). */
export interface PlatformLlmEnv {
  /** Solo `fake` tiene efecto: el modelo determinista de desarrollo y pruebas. */
  LLM_MODEL?: string
  LLM_OPENAI_API_KEY?: string
  LLM_OPENAI_BASE_URL?: string
  LLM_TIMEOUT_MS?: number | string
  LLM_MAX_RETRIES?: number | string
}

function account(apiKey: string | undefined, baseUrl: string | undefined): ProviderAccount | undefined {
  if (!apiKey?.trim()) return undefined
  return { apiKey: apiKey.trim(), ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}) }
}

function numberOf(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function platformLlmFromEnv(env: PlatformLlmEnv): PlatformLlm {
  const openai = account(env.LLM_OPENAI_API_KEY, env.LLM_OPENAI_BASE_URL)
  const timeoutMs = numberOf(env.LLM_TIMEOUT_MS)
  const maxRetries = numberOf(env.LLM_MAX_RETRIES)
  return {
    ...(env.LLM_MODEL?.trim() === "fake" ? { fake: true } : {}),
    ...(openai ? { openai } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  }
}

/**
 * Producción no arranca con el modelo de demostración: cada paciente
 * recibiría «Te atiendo enseguida» y nadie lo atendería. La imagen fija
 * `NODE_ENV=production` también en las vistas previas de cada PR, que se
 * distinguen por sus canales simulados (`CHANNEL_SENDER_MODE=mock` en el
 * worker, `CHANNEL_VALIDATE_EXTERNAL=false` en la API): ahí ningún mensaje
 * llega a una persona y `fake` sigue permitido. Devuelve el motivo para el
 * error de arranque, o null.
 */
export function fakeModelStartProblem(env: { LLM_MODEL?: string | undefined; NODE_ENV?: string | undefined }, channelsLive: boolean): string | null {
  if (env.LLM_MODEL?.trim() !== "fake") return null
  if (env.NODE_ENV !== "production" || !channelsLive) return null
  return "LLM_MODEL=fake es el modelo de demostración: en producción, con canales reales, el servidor no arranca con él"
}

/**
 * Fetch sin redirecciones: el modelo solo habla con el proveedor que fija
 * odentIA, nunca con otro destino al que una respuesta lo mande.
 */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" })

/**
 * Modelo concreto del spec. No se leen variables del proceso que el SDK
 * tomaría por su cuenta (organización o proyecto de OpenAI): todo sale del
 * spec. `fake` es el modelo determinista de dev/e2e. Con `explicitCache`,
 * OpenAI guarda en su caché solo hasta lo marcado con
 * `prompt_cache_breakpoint` (el dictado); sin él, además escribe lo último de
 * cada llamada, a 1,25× de la entrada, aunque no se vuelva a leer. Con
 * `temperature` 0 la misma pregunta tiende a dar la misma respuesta (Argos).
 *
 * Con `reasoning` el modelo piensa antes de responder: gpt-6-luna no acepta
 * herramientas con razonamiento en chat/completions, así que va por
 * /v1/responses, sin temperatura y con la caché automática del proveedor:
 * `explicitCache` no se envía, y un corte propio va en un bloque `input_text`
 * con `prompt_cache_breakpoint`, porque a uno `text` LangChain le quita la
 * marca (así lo hace Recepción, ADR 0104).
 */
export async function createConfiguredChatModel(
  spec: LlmSpec,
  options: { explicitCache?: boolean; temperature?: number; reasoning?: "low" | "medium" | "high" } = {},
) {
  if (spec.provider === "fake") return new FakeChatModel({})
  const reasoning = options.reasoning
  const modelKwargs = reasoning
    ? // También directo: LangChain no se lo envía a un modelo que no reconoce por su nombre.
      { reasoning: { effort: reasoning } }
    : {
        // Directo en la petición: LangChain solo envía `reasoning` a los modelos que reconoce por su
        // nombre (o1…, gpt-5…) y gpt-6-luna no está en esa lista.
        ...(spec.reasoningEffort ? { reasoning_effort: spec.reasoningEffort } : {}),
        // LangChain 1.5.3 no conoce esta opción: también va directo en la petición.
        ...(options.explicitCache ? { prompt_cache_options: { mode: "explicit" } } : {}),
      }
  return new ChatOpenAI({
    model: spec.modelName,
    apiKey: spec.apiKey,
    timeout: spec.timeoutMs,
    maxRetries: spec.maxRetries,
    ...(reasoning ? { useResponsesApi: true } : {}),
    ...(options.temperature !== undefined && !reasoning ? { temperature: options.temperature } : {}),
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
    configuration: {
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      organization: null,
      project: null,
      fetch: noRedirectFetch,
    },
  })
}

/** El cuerpo de error del proveedor: OpenAI `{ error: { code, message } }`. */
function providerBody(error: unknown): { code?: unknown; type?: unknown; message?: unknown } | null {
  const body = (error as { error?: unknown } | null)?.error
  if (!body || typeof body !== "object") return null
  const nested = (body as { error?: unknown }).error
  return (nested && typeof nested === "object" ? nested : body) as { code?: unknown; type?: unknown; message?: unknown }
}

function providerCode(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === "string") return direct
  const body = providerBody(error)
  if (typeof body?.code === "string") return body.code
  return typeof body?.type === "string" ? body.type : null
}

function providerStatus(error: unknown): number | null {
  if (error instanceof ServiceError) return null
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" ? status : null
}

/** Mensaje publicado por el proveedor en su JSON de error, sin el cuerpo crudo. */
function providerMessage(error: unknown): string | null {
  const message = providerBody(error)?.message
  return typeof message === "string" ? message.slice(0, 200) : null
}

/** Sin saldo o sin cuota: OpenAI responde `insufficient_quota` (429) o 402. */
function isQuotaProblem(error: unknown): boolean {
  const status = providerStatus(error)
  return status === 402 || providerCode(error) === "insufficient_quota"
}

/**
 * Un error del proveedor que no se arregla reintentando: credencial
 * rechazada, sin permiso, modelo inexistente, petición inválida o cuota
 * agotada. Se identifica por el estado HTTP del SDK; un ServiceError propio
 * también lleva `status` y no es del proveedor.
 */
export function isProviderConfigError(error: unknown): boolean {
  if (error instanceof LlmConfigError) return true
  const status = providerStatus(error)
  if (status !== null && [400, 401, 402, 403, 404].includes(status)) return true
  return isQuotaProblem(error)
}

/** Problema del proveedor que no se arregla reintentando, sin el cuerpo crudo de la respuesta. */
export function describeProviderProblem(error: unknown): { code: LlmProblemCode; detail: string } {
  if (error instanceof LlmConfigError) return { code: error.code, detail: error.message }
  const status = providerStatus(error)
  const message = providerMessage(error)
  return {
    code: isQuotaProblem(error) ? "PROVIDER_QUOTA" : "PROVIDER_REJECTED",
    detail: `${status !== null ? `HTTP ${status}` : "sin respuesta"}${message ? `: ${message}` : ""}`,
  }
}
