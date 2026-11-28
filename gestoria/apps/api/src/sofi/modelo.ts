import { devModel } from "./modelo-de-desarrollo.js"

/**
 * El modelo que escribe por Sofi (paso B5). Es el mismo proveedor y el mismo modelo que usan las
 * clínicas (OpenAI, `gpt-6-luna`), pero gestorIA no importa su código (ADR 0203): aquí va lo
 * mínimo, una llamada a Chat Completions con herramientas, por `fetch` y sin SDK. Si algo de esto
 * sirve a todos, se mueve a `shared/` en su propio cambio.
 *
 * - Sin redirecciones: el modelo solo habla con el proveedor configurado.
 * - Leer es seguro: un error de red, un 429 o un 5xx se reintenta una vez. Una credencial
 *   rechazada o una petición inválida no.
 * - La caché del proveedor es automática: el mensaje de sistema fijo va primero y sin cambios
 *   entre llamadas, así OpenAI lo lee de su caché (a 0,1× de la entrada).
 * - Las pruebas usan un modelo controlado (`scriptedModel`); el de desarrollo (`fake`) responde
 *   por reglas sin red. Ninguno cuenta como medición.
 */

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** Una parte de un mensaje del usuario: texto o una imagen (la IA de fotos, `ia-fotos.ts`). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string }

export interface ToolDef {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage {
  input: number
  cached: number
  output: number
}

export interface ModelReply {
  content: string | null
  toolCalls: ToolCall[]
  usage: Usage
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  /** «auto» por omisión; «none» para que solo escriba. */
  toolChoice?: "auto" | "none"
  /** Una respuesta con la forma de un JSON Schema (salida estructurada, `strict`). */
  responseFormat?: {
    type: "json_schema"
    json_schema: { name: string; strict: true; schema: Record<string, unknown> }
  }
  signal?: AbortSignal
}

export interface ChatModel {
  /** El nombre del modelo, como se anota en cada respuesta. */
  name: string
  complete(request: ChatRequest): Promise<ModelReply>
}

export class ModelError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message)
    this.name = "ModelError"
  }
}

/** El modelo de las clínicas (`AGENT_MODEL` de `packages/agent/src/llm.ts`), el mismo aquí. */
export const SOFI_MODEL = "gpt-6-luna"

/**
 * Precio de lista en USD por millón de tokens. gpt-6-luna: el de `AI_PRICES` de las clínicas
 * (`packages/agent/src/ai-usage.ts`, leído de la página de precios de OpenAI el 2026-10-17).
 */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
}

/** Lo que costó una llamada, en millonésimas de USD; null si no se conoce el precio. */
export function costMicros(model: string, usage: Usage): number | null {
  const price = PRICES[model]
  if (!price) return null
  const fresh = Math.max(0, usage.input - usage.cached)
  const usd =
    (fresh * price.input + usage.cached * price.cached + usage.output * price.output) / 1e6
  return Math.round(usd * 1_000_000)
}

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output }
}

export const NO_USAGE: Usage = { input: 0, cached: 0, output: 0 }

const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

export interface OpenAIOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  /** gpt-6-luna en Chat Completions rechaza herramientas si el razonamiento no va en «none». */
  reasoningEffort?: string
  timeoutMs?: number
  fetcher?: typeof fetch
}

export function openAIModel(options: OpenAIOptions): ChatModel {
  const model = options.model ?? SOFI_MODEL
  const url = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000

  async function once(request: ChatRequest): Promise<ModelReply> {
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        ...(request.tools?.length
          ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" }
          : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        reasoning_effort: options.reasoningEffort ?? "none",
      }),
    })
    if (!response.ok) {
      // Solo el mensaje publicado del proveedor, nunca el cuerpo entero.
      let detail = ""
      try {
        const body = (await response.json()) as { error?: { message?: unknown } }
        if (typeof body.error?.message === "string")
          detail = `: ${body.error.message.slice(0, 200)}`
      } catch {}
      throw new ModelError(`El proveedor respondió ${response.status}${detail}`, response.status)
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      }
    }
    const message = body.choices?.[0]?.message
    if (!message) throw new ModelError("El proveedor no devolvió una respuesta", null)
    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).filter((call) => call.type === "function"),
      usage: {
        input: body.usage?.prompt_tokens ?? 0,
        cached: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        output: body.usage?.completion_tokens ?? 0,
      },
    }
  }

  return {
    name: model,
    async complete(request) {
      try {
        return await once(request)
      } catch (error) {
        const status = error instanceof ModelError ? error.status : null
        const retry =
          !request.signal?.aborted &&
          (error instanceof ModelError ? status !== null && RETRY_STATUS.has(status) : true)
        if (!retry) throw error
        return once(request)
      }
    },
  }
}

/**
 * Un modelo controlado para las pruebas: responde, en orden, lo que se le dio. Cada respuesta
 * puede mirar lo que recibió (para comprobar qué vio el modelo).
 */
export function scriptedModel(
  steps: ((request: ChatRequest) => Partial<ModelReply>)[],
  name = "prueba",
): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    name,
    requests,
    async complete(request) {
      requests.push(structuredClone({ ...request, signal: undefined }))
      const step = steps.shift()
      if (!step) throw new ModelError("El modelo de prueba no tiene más respuestas", null)
      const reply = step(request)
      return {
        content: reply.content ?? null,
        toolCalls: reply.toolCalls ?? [],
        usage: reply.usage ?? { input: 1000, cached: 0, output: 50 },
      }
    },
  }
}

let callId = 0
/** Una llamada a una herramienta, para el modelo de prueba y el de desarrollo. */
export function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  callId += 1
  return {
    id: `call_${callId}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
}

/**
 * El modelo de desarrollo (`GESTORIA_LLM_MODEL=fake`): sin red ni costo, por reglas fijas con las
 * herramientas de verdad (`modelo-de-desarrollo.ts`). Sirve para ver la prueba en local y en los
 * recorridos; no cuenta como medición.
 */
export function fakeModel(): ChatModel {
  return devModel()
}

export interface ModelEnv {
  GESTORIA_LLM_MODEL?: string
  GESTORIA_OPENAI_API_KEY?: string
  GESTORIA_OPENAI_BASE_URL?: string
  NODE_ENV?: string
}

/**
 * El modelo según el entorno. Sin clave (y sin `fake`), null: Sofi no responde y la pantalla lo
 * dice. En producción no arranca con `fake`: le respondería a una tienda de verdad por reglas.
 */
export function modelFromEnv(env: ModelEnv): ChatModel | null {
  const name = env.GESTORIA_LLM_MODEL?.trim() || SOFI_MODEL
  if (name === "fake") {
    if (env.NODE_ENV === "production")
      throw new Error("gestoria-api: GESTORIA_LLM_MODEL=fake no se usa en producción")
    return fakeModel()
  }
  const apiKey = env.GESTORIA_OPENAI_API_KEY?.trim()
  if (!apiKey) return null
  return openAIModel({
    apiKey,
    model: name,
    ...(env.GESTORIA_OPENAI_BASE_URL?.trim()
      ? { baseUrl: env.GESTORIA_OPENAI_BASE_URL.trim() }
      : {}),
  })
}
