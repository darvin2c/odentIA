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
 * - Claude va aparte (`modelo-claude.ts`, con el SDK oficial) y se elige con
 *   `GESTORIA_LLM_PROVIDER=anthropic`; OpenAI sigue por omisión.
 * - Las pruebas usan un modelo controlado (`scriptedModel`); el de desarrollo (`fake`) responde
 *   por reglas sin red. Ninguno cuenta como medición.
 */

import {
  CLAUDE_DEFAULT_EFFORT,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  type ClaudeEffort,
  claudeModel,
} from "./modelo-claude.js"

export interface ToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: ToolCall[]
      /**
       * La respuesta tal como la dio el proveedor (`ModelReply.raw`), para devolvérsela igual en
       * el paso siguiente: Claude pide su razonamiento intacto entre herramientas. Solo la lee el
       * adaptador que la produjo; los demás la ignoran.
       */
      raw?: unknown
    }
  | { role: "tool"; content: string; tool_call_id: string }

export interface ToolDef {
  type: "function"
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage {
  /** Toda la entrada, contando la leída de la caché y la escrita en ella. */
  input: number
  /** La entrada leída de la caché. */
  cached: number
  output: number
  /** La entrada escrita en la caché (Claude la cobra a 1,25×; OpenAI no la informa). */
  written?: number
}

export interface ModelReply {
  content: string | null
  toolCalls: ToolCall[]
  usage: Usage
  /** Lo que el proveedor pide recibir de vuelta tal cual (ver `ChatMessage.raw`). */
  raw?: unknown
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  /** «auto» por omisión; «none» para que solo escriba. */
  toolChoice?: "auto" | "none"
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
 * Claude: la tabla de modelos de Anthropic (2026-11-03), con la caché escrita a 1,25× de la
 * entrada (vida de 5 minutos) y la leída a 0,1× en Haiku y 0,05× en Sonnet y Opus. Haiku 5.5
 * cuesta 0,50 / 2,50 pasados los 100 000 tokens de entrada; Sofi nunca llega ahí (lee 30
 * mensajes), así que aquí va el precio corto.
 */
const PRICES: Record<string, { input: number; cached: number; written?: number; output: number }> =
  {
    "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
    "claude-haiku-5-5": { input: 0.1, cached: 0.01, written: 0.125, output: 0.5 },
    "claude-sonnet-5-5": { input: 2, cached: 0.1, written: 2.5, output: 10 },
    "claude-opus-5-5": { input: 4, cached: 0.2, written: 5, output: 20 },
  }

/**
 * El nombre con que se busca el precio: el adaptador de Claude se llama «claude-…@low», con el
 * esfuerzo, para que cada respuesta anote cómo se pidió; el precio no depende del esfuerzo.
 */
const priceName = (model: string) => model.split("@")[0]!

/** Lo que costó una llamada, en millonésimas de USD; null si no se conoce el precio. */
export function costMicros(model: string, usage: Usage): number | null {
  const price = PRICES[priceName(model)]
  if (!price) return null
  const written = usage.written ?? 0
  const fresh = Math.max(0, usage.input - usage.cached - written)
  const usd =
    (fresh * price.input +
      usage.cached * price.cached +
      written * (price.written ?? price.input) +
      usage.output * price.output) /
    1e6
  return Math.round(usd * 1_000_000)
}

export function addUsage(a: Usage, b: Usage): Usage {
  const written = (a.written ?? 0) + (b.written ?? 0)
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    ...(written ? { written } : {}),
  }
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
        // `raw` es de otro proveedor: OpenAI no lo recibe.
        messages: request.messages.map((m) =>
          m.role === "assistant" && "raw" in m ? { ...m, raw: undefined } : m,
        ),
        ...(request.tools?.length
          ? { tools: request.tools, tool_choice: request.toolChoice ?? "auto" }
          : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
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
 * El modelo de desarrollo (`GESTORIA_LLM_MODEL=fake`): sin red ni costo. Busca en el catálogo lo
 * que escribió el cliente y contesta con lo que devolvió la búsqueda. Sirve para ver la pantalla
 * de prueba en local; no vende ni negocia, y no cuenta como medición.
 */
export function fakeModel(): ChatModel {
  return {
    name: "fake",
    async complete(request) {
      const last = request.messages.at(-1)
      if (last?.role === "user") {
        return {
          content: null,
          toolCalls: [toolCall("buscar_productos", { texto: last.content.slice(0, 120) })],
          usage: NO_USAGE,
        }
      }
      if (last?.role === "tool") {
        const found = JSON.parse(last.content) as {
          productos?: {
            nombre: string
            precio: string
            variantes: { opciones: string; stock: number }[]
          }[]
        }
        const first = found.productos?.[0]
        const content = first
          ? `Tenemos ${first.nombre}: ${first.precio}. Quedan ${first.variantes
              .filter((v) => v.stock > 0)
              .map((v) => v.opciones)
              .join(", ")}. ¿Cuál te gusta?`
          : "No encontré eso en el catálogo. ¿Me cuentas qué buscas?"
        return { content, toolCalls: [], usage: NO_USAGE }
      }
      return { content: "¿En qué te ayudo?", toolCalls: [], usage: NO_USAGE }
    },
  }
}

export interface ModelEnv {
  GESTORIA_LLM_MODEL?: string
  GESTORIA_OPENAI_API_KEY?: string
  GESTORIA_OPENAI_BASE_URL?: string
  /** «openai» (por omisión, como en producción) o «anthropic». */
  GESTORIA_LLM_PROVIDER?: string
  GESTORIA_ANTHROPIC_API_KEY?: string
  GESTORIA_ANTHROPIC_MODEL?: string
  GESTORIA_ANTHROPIC_EFFORT?: string
  NODE_ENV?: string
}

/**
 * El modelo según el entorno. Sin clave (y sin `fake`), null: Sofi no responde y la pantalla lo
 * dice. En producción no arranca con `fake`: le respondería a una tienda de verdad por reglas.
 *
 * Con `GESTORIA_LLM_PROVIDER=anthropic`, Claude (`modelo-claude.ts`): el modelo y el esfuerzo de
 * `GESTORIA_ANTHROPIC_MODEL` y `GESTORIA_ANTHROPIC_EFFORT`. En producción pide su clave; en
 * desarrollo, sin ella, el SDK toma la credencial de `ant auth login`.
 */
export function modelFromEnv(env: ModelEnv): ChatModel | null {
  const name = env.GESTORIA_LLM_MODEL?.trim() || SOFI_MODEL
  if (name === "fake") {
    if (env.NODE_ENV === "production")
      throw new Error("gestoria-api: GESTORIA_LLM_MODEL=fake no se usa en producción")
    return fakeModel()
  }
  const provider = env.GESTORIA_LLM_PROVIDER?.trim() || "openai"
  if (provider === "anthropic") {
    const model = env.GESTORIA_ANTHROPIC_MODEL?.trim() || CLAUDE_DEFAULT_MODEL
    if (!(CLAUDE_MODELS as readonly string[]).includes(model))
      throw new Error(
        `gestoria-api: GESTORIA_ANTHROPIC_MODEL no es uno de ${CLAUDE_MODELS.join(", ")}`,
      )
    const effort = env.GESTORIA_ANTHROPIC_EFFORT?.trim() || CLAUDE_DEFAULT_EFFORT
    if (!CLAUDE_EFFORTS.includes(effort as ClaudeEffort))
      throw new Error(`gestoria-api: GESTORIA_ANTHROPIC_EFFORT es ${CLAUDE_EFFORTS.join(", ")}`)
    const apiKey = env.GESTORIA_ANTHROPIC_API_KEY?.trim()
    if (!apiKey && env.NODE_ENV === "production") return null
    return claudeModel({ model, effort: effort as ClaudeEffort, ...(apiKey ? { apiKey } : {}) })
  }
  if (provider !== "openai")
    throw new Error("gestoria-api: GESTORIA_LLM_PROVIDER es «openai» o «anthropic»")
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
