import Anthropic from "@anthropic-ai/sdk"
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages"
import {
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  ModelError,
  type ModelReply,
  type ToolCall,
  type ToolDef,
} from "./modelo.js"

/**
 * El modelo que escribe por Sofi, con Claude (`GESTORIA_LLM_PROVIDER=anthropic`). Es la misma
 * conversación, las mismas herramientas y las mismas reglas que con OpenAI: este adaptador solo
 * traduce `ChatRequest` a la API de mensajes de Anthropic y la respuesta de vuelta. Las reglas de
 * precio siguen en el servidor (`precio.ts`, las herramientas y `revisar.ts`), nunca aquí.
 *
 * - El SDK oficial (`@anthropic-ai/sdk`), por streaming y con la respuesta completa al final.
 * - Razonamiento adaptativo con esfuerzo explícito (`low` por omisión: es un chat y `medium` no
 *   vendió mejor).
 * - Caché: las herramientas, las reglas fijas de Sofi y los datos de la tienda van primero y sin
 *   cambios entre llamadas, cada uno con su marca; la cuarta marca va en el último mensaje, para
 *   que cada paso de un turno lea de la caché lo que ya leyó el anterior.
 * - Su razonamiento vuelve intacto entre herramientas (`ModelReply.raw`): la API lo exige.
 * - Si Claude se niega (`stop_reason: "refusal"`), Sonnet y Opus reintentan en el servidor con el
 *   modelo que Anthropic elige (`fallbacks: "default"`); si igual se niega, es un error y Sofi pasa
 *   la conversación a una persona, como con cualquier otro fallo del modelo.
 * - Un error de red, un 429 o un 5xx se reintenta una vez (lo hace el SDK), y también una
 *   conexión que se corta a mitad de la respuesta; lo demás no.
 */

export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number]

export const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"] as const
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]
/**
 * El de Sofi con Claude si no se elige otro: Opus 5.5 con esfuerzo bajo fue el que mejor vendió en
 * `eval:sofi` (oferta a tiempo, tono y sin inventar), a unos US$ 0,055 por conversación; Sonnet 5.5
 * vendió un poco peor a la mitad, y Haiku 5.5, bastante peor. Con esfuerzo medio no mejoró ninguno.
 */
export const CLAUDE_DEFAULT_MODEL: ClaudeModelId = "claude-opus-5-5"
export const CLAUDE_DEFAULT_EFFORT: ClaudeEffort = "low"

/** Haiku no tiene reintento en el servidor; Sonnet 5.5 y Opus 5.5 sí. */
const WITH_FALLBACKS = new Set<string>(["claude-sonnet-5-5", "claude-opus-5-5"])

export interface ClaudeOptions {
  model?: string
  effort?: ClaudeEffort
  /** Sin clave, el SDK toma la credencial del entorno (`ant auth login` en desarrollo). */
  apiKey?: string
  baseURL?: string
  timeoutMs?: number
  maxTokens?: number
  /** Para las pruebas: el `fetch` que usa el SDK. */
  fetch?: typeof fetch
  /** Dónde cuenta que corrió (una línea por modelo). */
  log?: (line: string) => void
}

const ephemeral = { type: "ephemeral" } as const

/** Las herramientas de Sofi como las pide Claude; la última lleva la marca de caché. */
export function claudeTools(tools: ToolDef[]): BetaToolUnion[] {
  return tools.map((tool, i) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters as { type: "object" },
    // Llegan por partes mientras se escriben; `runTool` valida cada una con su esquema.
    eager_input_streaming: true,
    ...(i === tools.length - 1 ? { cache_control: ephemeral } : {}),
  }))
}

/**
 * La conversación como la pide Claude: los mensajes de sistema del principio van aparte, cada
 * uno con su marca de caché; las respuestas de las herramientas seguidas van en un solo mensaje
 * del cliente; y lo que Claude respondió antes vuelve tal cual (`raw`).
 */
export function claudeConversation(messages: ChatMessage[]): {
  system: BetaTextBlockParam[]
  messages: BetaMessageParam[]
} {
  const system: BetaTextBlockParam[] = []
  const out: BetaMessageParam[] = []
  let i = 0
  for (; i < messages.length && messages[i]!.role === "system"; i++)
    system.push({ type: "text", text: messages[i]!.content as string })
  // Dos marcas como mucho en el sistema (son cuatro en total): la primera (las reglas, iguales
  // en toda tienda) y la última (los datos de la tienda).
  if (system[0]) system[0].cache_control = ephemeral
  if (system.length > 1) system.at(-1)!.cache_control = ephemeral
  for (; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === "system" || m.role === "user") {
      // Un aviso del sistema a mitad de la conversación va como mensaje del cliente marcado,
      // igual que la comprobación de la tienda; hoy Sofi no lo usa.
      const text = m.role === "system" ? `[Sistema] ${m.content}` : m.content
      out.push({ role: "user", content: [{ type: "text", text }] })
    } else if (m.role === "tool") {
      const result: BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      }
      const last = out.at(-1)
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      )
        (last.content as BetaContentBlockParam[]).push(result)
      else out.push({ role: "user", content: [result] })
    } else if (m.role === "assistant" && Array.isArray(m.raw)) {
      out.push({ role: "assistant", content: m.raw as BetaContentBlockParam[] })
    } else if (m.role === "assistant") {
      const content: BetaContentBlockParam[] = []
      if (m.content?.trim()) content.push({ type: "text", text: m.content })
      for (const call of m.tool_calls ?? [])
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
        })
      if (content.length) out.push({ role: "assistant", content })
    }
  }
  // La conversación empieza por el cliente; si la ventana de 30 mensajes empieza en Sofi, se dice.
  if (out[0]?.role === "assistant")
    out.unshift({
      role: "user",
      content: [{ type: "text", text: "(Antes de esto, la conversación ya había empezado.)" }],
    })
  // La cuarta marca: lo último que se manda, para el paso siguiente del mismo turno.
  // Solo si es del cliente: sus bloques se arman de nuevo en cada llamada, y los de Claude (`raw`)
  // se guardan entre pasos y no deben quedar marcados.
  const final = out.at(-1)
  const lastBlocks = final?.role === "user" ? final.content : null
  if (Array.isArray(lastBlocks) && lastBlocks.length) {
    const block = lastBlocks.at(-1)!
    if (block.type === "text" || block.type === "tool_result")
      (block as { cache_control?: typeof ephemeral }).cache_control = ephemeral
  }
  return { system, messages: out }
}

/** Lo que Claude respondió, como lo lee Sofi. */
export function claudeReply(message: BetaMessage): ModelReply {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category
    throw new ModelError(`Claude no quiso responder${category ? ` (${category})` : ""}`, null)
  }
  if (message.stop_reason === "max_tokens")
    throw new ModelError("La respuesta de Claude quedó cortada", null)
  const blocks: BetaContentBlock[] = message.content
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }))
  const u = message.usage
  const cached = u.cache_read_input_tokens ?? 0
  const written = u.cache_creation_input_tokens ?? 0
  return {
    content: text || null,
    toolCalls,
    usage: {
      input: u.input_tokens + cached + written,
      cached,
      output: u.output_tokens,
      ...(written ? { written } : {}),
    },
    raw: blocks,
  }
}

/** Arma la petición de un `ChatRequest` (sin enviarla). */
export function claudeParams(
  model: string,
  effort: ClaudeEffort,
  maxTokens: number,
  request: ChatRequest,
): MessageCreateParamsStreaming {
  const { system, messages } = claudeConversation(request.messages)
  const fallbacks = WITH_FALLBACKS.has(model)
  return {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages,
    ...(request.tools?.length
      ? {
          tools: claudeTools(request.tools),
          tool_choice: { type: request.toolChoice ?? "auto" },
        }
      : {}),
    // Sin temperatura: Claude 5.5 rechaza un valor distinto del suyo. Sin descartar el
    // razonamiento: Opus 5.5 no lo permite; el esfuerzo decide cuánto piensa.
    thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    output_config: { effort },
    betas: [
      "thinking-binding-controls-2026-08-01",
      ...(fallbacks ? (["server-side-fallback-2026-07-01"] as const) : []),
    ],
    ...(fallbacks ? { fallbacks: "default" as const } : {}),
  }
}

export function claudeModel(options: ClaudeOptions = {}): ChatModel {
  const model = options.model ?? CLAUDE_DEFAULT_MODEL
  const effort = options.effort ?? CLAUDE_DEFAULT_EFFORT
  const maxTokens = options.maxTokens ?? 16_000
  const log = options.log ?? ((line: string) => console.log(line))
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? 30_000,
    maxRetries: 1,
  })
  const seen = new Set<string>()

  return {
    name: `${model}@${effort}`,
    async complete(request) {
      const once = () =>
        client.beta.messages
          .stream(claudeParams(model, effort, maxTokens, request), {
            ...(request.signal ? { signal: request.signal } : {}),
          })
          .finalMessage()
      let message: BetaMessage
      try {
        try {
          message = await once()
        } catch (error) {
          // El SDK reintenta lo que falla antes de responder; una conexión cortada a mitad de la
          // respuesta, no. Leer no tiene efectos afuera: se intenta una vez más.
          const cut =
            !(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIConnectionError
          if (!cut || error instanceof Anthropic.APIUserAbortError || request.signal?.aborted)
            throw error
          message = await once()
        }
      } catch (error) {
        if (error instanceof Anthropic.APIUserAbortError) throw error
        if (error instanceof Anthropic.APIError && error.status !== undefined)
          // Solo el mensaje del proveedor, nunca la petición.
          throw new ModelError(
            `El proveedor respondió ${error.status}: ${String(error.message).slice(0, 200)}`,
            error.status ?? null,
          )
        throw new ModelError(
          `No se pudo hablar con Claude: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`,
          null,
        )
      }
      // Una línea por modelo que de verdad respondió: así consta qué camino corrió.
      if (!seen.has(message.model)) {
        seen.add(message.model)
        log(
          `gestoria-api: Sofi con Claude: respondió ${message.model} (pedido ${model}, esfuerzo ${effort})`,
        )
      }
      return claudeReply(message)
    },
  }
}
