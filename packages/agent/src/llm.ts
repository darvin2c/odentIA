import { ChatAnthropic } from "@langchain/anthropic"
import { ChatOpenAI } from "@langchain/openai"
import { AGENT_LLM_IDS, type AgentLlm, DEFAULT_AGENT_LLM, isAgentLlm, ServiceError } from "@odentia/services"
import { FakeChatModel } from "./fake-model.js"

/** Códigos de problema del proveedor; `DAILY_LIMIT` lo emite la corrida, no la configuración. */
export type LlmProblemCode = "API_KEY_REQUIRED" | "PROVIDER_REJECTED" | "PROVIDER_QUOTA" | "DAILY_LIMIT"

/** La plataforma no puede usar el modelo elegido (le falta la cuenta de ese proveedor). */
export class LlmConfigError extends Error {
  constructor(
    public readonly code: "API_KEY_REQUIRED",
    message: string,
  ) {
    super(message)
    this.name = "LlmConfigError"
  }
}

export type LlmProvider = "openai" | "anthropic"

/** Cuenta de odentIA en un proveedor. */
export interface ProviderAccount {
  apiKey: string
  /** Solo si no es la API pública del proveedor (una pasarela propia de odentIA). */
  baseUrl?: string
}

/**
 * Cuentas de la plataforma (entorno de API y worker). La clínica no trae la
 * suya: elige uno de los modelos de `AGENT_LLMS` y odentIA pone la cuenta.
 */
export interface PlatformLlm {
  /** Desarrollo y pruebas (`LLM_MODEL=fake`): el modelo determinista, sin proveedor. */
  fake?: boolean
  openai?: ProviderAccount
  anthropic?: ProviderAccount
  timeoutMs?: number
  maxRetries?: number
}

interface LlmCatalogEntry {
  provider: LlmProvider
  /** Nombre exacto del modelo en el proveedor; la clínica nunca lo ve. */
  modelName: string
  /** `reasoning_effort` que viaja en cada petición (OpenAI). */
  reasoningEffort?: string
  /** Tope de salida por llamada (Anthropic lo exige). */
  maxTokens?: number
  /**
   * Esfuerzo de razonamiento (Anthropic, `output_config.effort`). Haiku 5.5
   * piensa por defecto con esfuerzo medio y lo pensado se cobra como salida.
   */
  effort?: "low" | "medium" | "high"
}

/**
 * Lo que hay detrás de cada opción que elige la clínica (`AGENT_LLMS` de los
 * servicios: id y etiqueta). odentIA cambia aquí el modelo o sus opciones;
 * la clínica no tiene que hacer nada. Motivos en
 * `docs/decisions/0022-la-clinica-elige-entre-dos-modelos-de-odentia.md`.
 */
export const LLM_CATALOG: Record<AgentLlm, LlmCatalogEntry> = {
  // gpt-6-luna en chat/completions rechaza herramientas si el razonamiento no va en `none`.
  chatgpt_6: { provider: "openai", modelName: "gpt-6-luna", reasoningEffort: "none" },
  // 2048 sobra para una respuesta de chat o una llamada a herramienta. Responder
  // a un paciente o llamar a una herramienta no necesita pensar mucho: esfuerzo bajo.
  claude_5_5: { provider: "anthropic", modelName: "claude-haiku-5-5", maxTokens: 2048, effort: "low" },
}

/** Variable de entorno con la clave de cada proveedor: el error la nombra. */
const ACCOUNT_ENV: Record<LlmProvider, { key: string; label: string }> = {
  openai: { key: "LLM_OPENAI_API_KEY", label: "OpenAI" },
  anthropic: { key: "LLM_ANTHROPIC_API_KEY", label: "Anthropic" },
}

/** Modelo efectivo de una corrida: una sola fuente para proveedor, modelo y cuenta. */
export interface LlmSpec {
  /** La opción que eligió la clínica. */
  llm: AgentLlm
  provider: LlmProvider | "fake"
  modelName: string
  apiKey?: string
  baseUrl?: string
  timeoutMs: number
  maxRetries: number
  reasoningEffort?: string
  maxTokens?: number
  effort?: "low" | "medium" | "high"
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_RETRIES = 2

/** Nombre con que la corrida registra el modelo, aun antes de resolver la cuenta. */
export function llmModelName(llm: AgentLlm, platform: PlatformLlm): string {
  return platform.fake ? "fake" : LLM_CATALOG[llm].modelName
}

/**
 * Resuelve el modelo que eligió la clínica con la cuenta de odentIA en su
 * proveedor. Único resolvedor para corrida, simulación, dictado y
 * Administrador. Sin la clave de ese proveedor lanza `LlmConfigError`.
 */
export function resolveLlmSpec(cfg: { llm: AgentLlm }, platform: PlatformLlm): LlmSpec {
  const common = {
    llm: cfg.llm,
    timeoutMs: platform.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: platform.maxRetries ?? DEFAULT_MAX_RETRIES,
  }
  if (platform.fake) return { ...common, provider: "fake", modelName: "fake" }
  const entry = LLM_CATALOG[cfg.llm]
  const account = platform[entry.provider]
  if (!account?.apiKey) {
    const env = ACCOUNT_ENV[entry.provider]
    throw new LlmConfigError("API_KEY_REQUIRED", `La plataforma no tiene la clave de ${env.label} configurada (${env.key})`)
  }
  return {
    ...common,
    provider: entry.provider,
    modelName: entry.modelName,
    apiKey: account.apiKey,
    ...(account.baseUrl ? { baseUrl: account.baseUrl } : {}),
    ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}),
    ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
    ...(entry.effort ? { effort: entry.effort } : {}),
  }
}

/** Variables de entorno de las cuentas de la plataforma (API, worker y evaluaciones). */
export interface PlatformLlmEnv {
  /** Solo `fake` tiene efecto: el modelo determinista de desarrollo y pruebas. */
  LLM_MODEL?: string
  LLM_OPENAI_API_KEY?: string
  LLM_OPENAI_BASE_URL?: string
  LLM_ANTHROPIC_API_KEY?: string
  LLM_ANTHROPIC_BASE_URL?: string
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
  const anthropic = account(env.LLM_ANTHROPIC_API_KEY, env.LLM_ANTHROPIC_BASE_URL)
  const timeoutMs = numberOf(env.LLM_TIMEOUT_MS)
  const maxRetries = numberOf(env.LLM_MAX_RETRIES)
  return {
    ...(env.LLM_MODEL?.trim() === "fake" ? { fake: true } : {}),
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
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
 * Evaluaciones: el modelo que se pide con `--llm=` (por defecto el de toda
 * clínica) y las cuentas que se le pasan.
 */
export function evalLlmSpec(requested: string | undefined, platform: PlatformLlm): LlmSpec {
  const llm = requested ?? DEFAULT_AGENT_LLM
  if (!isAgentLlm(llm)) throw new Error(`Modelo desconocido: ${llm} (${AGENT_LLM_IDS.join(" | ")})`)
  return resolveLlmSpec({ llm }, platform)
}

/**
 * Fetch sin redirecciones: el modelo solo habla con el proveedor que fija
 * odentIA, nunca con otro destino al que una respuesta lo mande.
 */
const noRedirectFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: "error" })

/**
 * Modelo concreto del spec. No se leen variables del proceso que el SDK
 * tomaría por su cuenta (organización o proyecto de OpenAI, URL de
 * Anthropic): todo sale del spec. `fake` es el modelo determinista de dev/e2e.
 * Con `explicitCache`, OpenAI guarda en su caché solo hasta lo marcado con
 * `prompt_cache_breakpoint` (el dictado); sin él, además escribe lo último de
 * cada llamada, a 1,25× de la entrada, aunque no se vuelva a leer. Anthropic
 * siempre guarda solo lo marcado.
 */
export async function createConfiguredChatModel(spec: LlmSpec, options: { explicitCache?: boolean } = {}) {
  if (spec.provider === "fake") return new FakeChatModel({})
  if (spec.provider === "anthropic") {
    return new ChatAnthropic({
      model: spec.modelName,
      apiKey: spec.apiKey,
      maxRetries: spec.maxRetries,
      maxTokens: spec.maxTokens ?? 2048,
      ...(spec.effort ? { outputConfig: { effort: spec.effort } } : {}),
      // Sin URL propia, la pública: nunca la de ANTHROPIC_BASE_URL del proceso.
      anthropicApiUrl: spec.baseUrl ?? "https://api.anthropic.com",
      clientOptions: { timeout: spec.timeoutMs, fetch: noRedirectFetch },
    })
  }
  const modelKwargs = {
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
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
    configuration: {
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      organization: null,
      project: null,
      fetch: noRedirectFetch,
    },
  })
}

/** El cuerpo de error del proveedor: OpenAI `{ error: { code, message } }`; Anthropic `{ type, error: { type, message } }`. */
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

/**
 * Sin saldo o sin cuota: OpenAI responde `insufficient_quota` (429) o 402;
 * Anthropic, `billing_error` o un 400 que dice que el crédito no alcanza.
 */
function isQuotaProblem(error: unknown): boolean {
  const status = providerStatus(error)
  const code = providerCode(error)
  if (status === 402 || code === "insufficient_quota" || code === "billing_error") return true
  return status === 400 && /credit balance/i.test(providerMessage(error) ?? "")
}

/**
 * Un error del proveedor que no se arregla reintentando: credencial
 * rechazada, sin permiso, modelo inexistente, petición inválida o cuota
 * agotada. Se identifica por el estado HTTP del SDK (OpenAI y Anthropic lo
 * exponen igual); un ServiceError propio también lleva `status` y no es del
 * proveedor.
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
