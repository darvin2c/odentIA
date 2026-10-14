import { HumanMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { ServiceError } from "@odentia/services"
import { type Dispatcher, fetch as undiciFetch } from "undici"
import { FakeChatModel } from "./fake-model.js"
import { dispatcherFor, LlmConfigError, type LlmProblemCode, parseSafeBaseUrl } from "./llm-endpoint.js"

export { LlmConfigError } from "./llm-endpoint.js"

/** Credenciales de la plataforma (entorno de API y worker). */
export interface PlatformLlm {
  modelName: string
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  maxRetries?: number
  /** dev/e2e: admite http y destinos privados (servidores locales de prueba). */
  allowInsecureBaseUrl?: boolean
  /**
   * Esfuerzo de razonamiento que se pide al modelo de la plataforma
   * (`reasoning_effort`). Sin indicar no se envía. Algunos modelos (gpt-6-luna
   * en chat/completions) rechazan herramientas si no va `none`.
   */
  reasoningEffort?: string
}

/** Proveedor propio de una organización, ya descifrado. */
export interface OrgLlmSecrets {
  baseUrl: string
  apiKey: string
}

/** Modelo efectivo de una corrida: una sola fuente para clave y URL. */
export interface LlmSpec {
  modelName: string
  source: "platform" | "organization" | "fake"
  apiKey?: string
  baseUrl?: string
  timeoutMs: number
  maxRetries: number
  allowInsecureBaseUrl: boolean
  /** Solo para el modelo de la plataforma; el propio de una clínica no lo recibe. */
  reasoningEffort?: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 2

/**
 * Prefijos de initChatModel: `openai:` selecciona el protocolo compatible con
 * OpenAI (el único instalado); los demás se rechazan con un error explícito
 * en vez de fallar al instanciar con un mensaje opaco.
 */
const KNOWN_PROTOCOLS = new Set([
  "openai",
  "anthropic",
  "azure_openai",
  "bedrock",
  "cohere",
  "deepseek",
  "fireworks",
  "google-genai",
  "google-vertexai",
  "groq",
  "mistralai",
  "ollama",
  "perplexity",
  "together",
  "xai",
])

/** Nombre del modelo tal como lo espera el endpoint, validando el protocolo. */
export function resolveModelName(modelName: string): string {
  const trimmed = modelName.trim()
  const match = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(trimmed)
  if (!match || !KNOWN_PROTOCOLS.has(match[1]!.toLowerCase())) return trimmed
  const protocol = match[1]!.toLowerCase()
  if (protocol === "openai") return match[2]!.trim()
  throw new LlmConfigError(
    "PROTOCOL_UNSUPPORTED",
    `El protocolo ${protocol} no está instalado: usa un endpoint compatible con OpenAI (prefijo openai: o sin prefijo)`,
  )
}

/**
 * Resuelve el modelo efectivo: proveedor propio de la organización (URL y
 * clave como par) o el de la plataforma; `model` de la organización
 * sobrescribe el nombre en ambos casos. `override` solo en simulación.
 */
export function resolveLlmSpec(
  cfg: { model: string | null },
  orgSecrets: OrgLlmSecrets | null,
  platform: PlatformLlm,
  override?: string | null,
): LlmSpec {
  const common = {
    timeoutMs: platform.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: platform.maxRetries ?? DEFAULT_MAX_RETRIES,
    allowInsecureBaseUrl: platform.allowInsecureBaseUrl ?? false,
  }
  const requested = override?.trim() || cfg.model?.trim() || ""
  if (orgSecrets) {
    if (!requested) {
      throw new LlmConfigError("MODEL_REQUIRED", "Con proveedor propio hay que indicar el modelo")
    }
    const modelName = resolveModelName(requested)
    if (modelName === "fake") return { modelName, source: "fake", ...common }
    return { modelName, source: "organization", apiKey: orgSecrets.apiKey, baseUrl: orgSecrets.baseUrl, ...common }
  }
  const modelName = resolveModelName(requested || platform.modelName)
  if (modelName === "fake") return { modelName, source: "fake", ...common }
  if (!platform.apiKey) {
    throw new LlmConfigError("API_KEY_REQUIRED", "La plataforma no tiene clave de proveedor configurada (LLM_API_KEY)")
  }
  return {
    modelName,
    source: "platform",
    apiKey: platform.apiKey,
    baseUrl: platform.baseUrl,
    ...common,
    ...(platform.reasoningEffort ? { reasoningEffort: platform.reasoningEffort } : {}),
  }
}

/**
 * Fetch sin redirecciones y, para proveedores de organización, con la
 * dirección fijada al conectar. El dispatcher solo lo entiende el fetch del
 * propio undici (el global de Node lleva otra versión empaquetada).
 */
function fetchFor(dispatcher: Dispatcher | undefined): typeof fetch {
  if (!dispatcher) return (input, init) => fetch(input, { ...init, redirect: "error" })
  const pinned = (input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, { ...init, redirect: "error", dispatcher })
  return pinned as unknown as typeof fetch
}

/**
 * Modelo concreto para el endpoint compatible con OpenAI del spec. La URL de
 * una organización se valida en cada construcción y su conexión solo sale
 * hacia direcciones públicas; la de la plataforma la fija el operador. No se
 * leen OPENAI_ORGANIZATION ni OPENAI_PROJECT del proceso: irían al endpoint
 * que eligió la organización. `fake` es el modelo determinista de dev/e2e.
 */
export async function createConfiguredChatModel(spec: LlmSpec) {
  if (spec.source === "fake") return new FakeChatModel({})
  let dispatcher: Dispatcher | undefined
  if (spec.source === "organization" && spec.baseUrl) {
    parseSafeBaseUrl(spec.baseUrl, { allowInsecure: spec.allowInsecureBaseUrl })
    dispatcher = dispatcherFor({ allowInsecure: spec.allowInsecureBaseUrl })
  }
  return new ChatOpenAI({
    model: spec.modelName,
    apiKey: spec.apiKey,
    timeout: spec.timeoutMs,
    maxRetries: spec.maxRetries,
    // Directo en la petición: LangChain solo envía `reasoning` a los modelos que reconoce por su
    // nombre (o1…, gpt-5…) y gpt-6-luna no está en esa lista.
    ...(spec.reasoningEffort ? { modelKwargs: { reasoning_effort: spec.reasoningEffort } } : {}),
    configuration: {
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      organization: null,
      project: null,
      fetch: fetchFor(dispatcher),
    },
  })
}

function providerCode(error: unknown): string | null {
  const direct = (error as { code?: unknown } | null)?.code
  if (typeof direct === "string") return direct
  const nested = (error as { error?: { code?: unknown } } | null)?.error?.code
  return typeof nested === "string" ? nested : null
}

function providerStatus(error: unknown): number | null {
  if (error instanceof ServiceError) return null
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === "number" ? status : null
}

/** Mensaje publicado por el proveedor en su JSON de error, sin el cuerpo crudo. */
function providerMessage(error: unknown): string | null {
  const nested = (error as { error?: { message?: unknown } } | null)?.error?.message
  return typeof nested === "string" ? nested.slice(0, 200) : null
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
  return providerCode(error) === "insufficient_quota"
}

/** Problema del proveedor que no se arregla reintentando, sin el cuerpo crudo de la respuesta. */
export function describeProviderProblem(error: unknown): { code: LlmProblemCode; detail: string } {
  if (error instanceof LlmConfigError) return { code: error.code, detail: error.message }
  const status = providerStatus(error)
  const quota = status === 402 || providerCode(error) === "insufficient_quota"
  const message = providerMessage(error)
  return {
    code: quota ? "PROVIDER_QUOTA" : "PROVIDER_REJECTED",
    detail: `${status !== null ? `HTTP ${status}` : "sin respuesta"}${message ? `: ${message}` : ""}`,
  }
}

export interface LlmConnectionTest {
  ok: boolean
  latencyMs: number
  /** Modelo que reportó el proveedor, si lo hizo. */
  model: string | null
  error: string | null
}

/**
 * Prueba de conexión: una petición mínima con tiempo límite corto y sin
 * reintentos. No acredita que el modelo admita herramientas ni su calidad.
 */
export async function testLlmConnection(spec: LlmSpec, timeoutMs = 15_000): Promise<LlmConnectionTest> {
  const startedAt = Date.now()
  try {
    const model = await createConfiguredChatModel({ ...spec, timeoutMs, maxRetries: 0 })
    const reply = await model.invoke([new HumanMessage("Responde únicamente: OK")])
    const meta = (reply.response_metadata ?? {}) as { model_name?: unknown; model?: unknown }
    const reported = typeof meta.model_name === "string" ? meta.model_name : typeof meta.model === "string" ? meta.model : null
    return { ok: true, latencyMs: Date.now() - startedAt, model: reported, error: null }
  } catch (error) {
    const detail =
      error instanceof LlmConfigError
        ? error.message
        : providerStatus(error) !== null
          ? describeProviderProblem(error).detail
          : "el proveedor no respondió o la respuesta no es válida"
    return { ok: false, latencyMs: Date.now() - startedAt, model: null, error: detail }
  }
}
