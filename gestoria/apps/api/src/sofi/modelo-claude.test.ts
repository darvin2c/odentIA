/**
 * El adaptador de Claude contra un servidor de mentira (nunca la red): lo que se le pide a la API
 * (caché, razonamiento, esfuerzo, reintento en el servidor), cómo se lee lo que responde (texto,
 * herramientas, uso, negativas) y que el razonamiento vuelve intacto entre herramientas. No dice
 * nada de cómo vende Claude: eso lo mide `eval-sofi.ts`.
 */
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { CLAUDE_DEFAULT_MODEL, claudeModel } from "./modelo-claude.js"
import {
  type ChatMessage,
  costMicros,
  ModelError,
  modelFromEnv,
  openAIModel,
  type ToolDef,
} from "./modelo.js"

interface Seen {
  body: Record<string, unknown>
  headers: Record<string, string | string[] | undefined>
}

/** Lo que responde el servidor en cada llamada: un mensaje completo, o un estado de error. */
type Step =
  | {
      content: Record<string, unknown>[]
      stop?: string
      stopDetails?: Record<string, unknown>
      model?: string
      usage?: Record<string, number>
    }
  | { status: number }

let server: Server
let baseURL = ""
let seen: Seen[] = []
let steps: Step[] = []

/** El mensaje, como eventos SSE de la API de mensajes. */
function sse(step: Exclude<Step, { status: number }>, requested: string): string {
  const events: [string, unknown][] = []
  const usage: Record<string, number> = {
    input_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...step.usage,
  }
  events.push([
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg_prueba",
        type: "message",
        role: "assistant",
        model: step.model ?? requested,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    },
  ])
  step.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
      ])
      events.push([
        "content_block_delta",
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      ])
    } else if (block.type === "tool_use") {
      events.push([
        "content_block_start",
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
      ])
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      ])
    } else if (block.type === "thinking") {
      events.push([
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      ])
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
      ])
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }])
  })
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: {
        stop_reason: step.stop ?? "end_turn",
        stop_sequence: null,
        stop_details: step.stopDetails ?? null,
      },
      usage: { output_tokens: usage.output_tokens ?? 20 },
    },
  ])
  events.push(["message_stop", { type: "message_stop" }])
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("")
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>
      seen.push({ body, headers: req.headers })
      const step = steps.shift()
      if (!step) {
        res.writeHead(500).end()
        return
      }
      if ("status" in step) {
        res
          .writeHead(step.status, { "content-type": "application/json" })
          .end(JSON.stringify({ type: "error", error: { type: "api_error", message: "falló" } }))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(step, String(body.model)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  seen = []
  steps = []
})

const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "buscar_productos",
      description: "Busca",
      parameters: { type: "object", properties: { texto: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "cotizar",
      description: "Cotiza",
      parameters: { type: "object", properties: {} },
    },
  },
]

const silent = () => {}
const model = (name = CLAUDE_DEFAULT_MODEL, effort: "low" | "medium" = "low") =>
  claudeModel({
    model: name,
    effort,
    apiKey: "clave-de-prueba",
    baseURL,
    log: silent,
    timeoutMs: 5_000,
  })

const SOFI: ChatMessage[] = [
  { role: "system", content: "REGLAS" },
  { role: "system", content: "DATOS DE LA TIENDA" },
  { role: "user", content: "¿Cuánto cuesta la zapatilla?" },
]

describe("el adaptador de Claude", () => {
  it("pide con caché, razonamiento adaptativo y esfuerzo, sin temperatura, y lee la herramienta", async () => {
    steps.push({
      content: [
        { type: "thinking", signature: "firma-1" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "buscar_productos",
          input: { texto: "zapatilla" },
        },
      ],
      stop: "tool_use",
      usage: {
        input_tokens: 40,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300,
        output_tokens: 60,
      },
    })
    const reply = await model().complete({ messages: SOFI, tools: TOOLS, temperature: 0 })

    const body = seen[0]!.body
    expect(body.model).toBe("claude-haiku-5-5")
    expect(body.stream).toBe(true)
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    })
    expect(body.output_config).toEqual({ effort: "low" })
    expect(body.tool_choice).toEqual({ type: "auto" })
    // Cuatro marcas: la última herramienta, las reglas, los datos y el último mensaje.
    const tools = body.tools as Record<string, unknown>[]
    expect(tools.map((t) => t.cache_control ?? null)).toEqual([null, { type: "ephemeral" }])
    expect(tools[0]).toMatchObject({
      name: "buscar_productos",
      input_schema: TOOLS[0]!.function.parameters,
      eager_input_streaming: true,
    })
    expect(body.system).toEqual([
      { type: "text", text: "REGLAS", cache_control: { type: "ephemeral" } },
      { type: "text", text: "DATOS DE LA TIENDA", cache_control: { type: "ephemeral" } },
    ])
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "¿Cuánto cuesta la zapatilla?",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ])
    // Haiku no tiene reintento en el servidor.
    expect(body.fallbacks).toBeUndefined()
    expect(String(seen[0]!.headers["anthropic-beta"])).not.toContain("server-side-fallback")

    expect(reply.toolCalls).toEqual([
      {
        id: "toolu_1",
        type: "function",
        function: { name: "buscar_productos", arguments: '{"texto":"zapatilla"}' },
      },
    ])
    expect(reply.content).toBeNull()
    expect(reply.usage).toEqual({ input: 2340, cached: 2000, output: 60, written: 300 })
  })

  it("devuelve el razonamiento intacto y junta las respuestas de las herramientas", async () => {
    steps.push(
      {
        content: [
          { type: "thinking", signature: "firma-1" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "buscar_productos",
            input: { texto: "zapatilla" },
          },
          { type: "tool_use", id: "toolu_2", name: "cotizar", input: {} },
        ],
        stop: "tool_use",
      },
      { content: [{ type: "text", text: "Cuesta S/ 129." }] },
    )
    const m = model()
    const messages: ChatMessage[] = [...SOFI]
    const first = await m.complete({ messages, tools: TOOLS })
    messages.push({
      role: "assistant",
      content: first.content,
      tool_calls: first.toolCalls,
      raw: first.raw,
    })
    messages.push({ role: "tool", tool_call_id: "toolu_1", content: '{"ok":true}' })
    messages.push({ role: "tool", tool_call_id: "toolu_2", content: '{"ok":true}' })
    const second = await m.complete({ messages, tools: TOOLS })
    expect(second.content).toBe("Cuesta S/ 129.")

    const sent = seen[1]!.body.messages as { role: string; content: Record<string, unknown>[] }[]
    expect(sent).toHaveLength(3)
    expect(sent[1]!.role).toBe("assistant")
    expect(sent[1]!.content[0]).toMatchObject({ type: "thinking", signature: "firma-1" })
    expect(sent[1]!.content[0]!.cache_control).toBeUndefined()
    // Las dos respuestas, en un solo mensaje, con la marca de caché en la última.
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' },
        {
          type: "tool_result",
          tool_use_id: "toolu_2",
          content: '{"ok":true}',
          cache_control: { type: "ephemeral" },
        },
      ],
    })
    // El primer mensaje del cliente ya no lleva marca: lo que se guarda entre pasos no cambia.
    expect(sent[0]!.content[0]!.cache_control).toBeUndefined()
  })

  it("una conversación que empieza en Sofi empieza igual por el cliente", async () => {
    steps.push({ content: [{ type: "text", text: "Hola" }] })
    await model().complete({
      messages: [
        { role: "system", content: "REGLAS" },
        { role: "assistant", content: "Hola, soy Sofi." },
        { role: "user", content: "Hola" },
      ],
    })
    const sent = seen[0]!.body.messages as { role: string }[]
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user"])
  })

  it("Sonnet y Opus piden el reintento del servidor; una negativa es un error", async () => {
    steps.push({
      content: [],
      stop: "refusal",
      stopDetails: { type: "refusal", category: "cyber", explanation: null },
    })
    const error = await model("claude-sonnet-5-5", "medium")
      .complete({ messages: SOFI })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).message).toContain("cyber")
    expect(seen[0]!.body.fallbacks).toBe("default")
    expect(String(seen[0]!.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01")
    expect(seen[0]!.body.output_config).toEqual({ effort: "medium" })
  })

  it("una respuesta cortada no sale", async () => {
    steps.push({ content: [{ type: "text", text: "Cuesta S/" }], stop: "max_tokens" })
    await expect(model().complete({ messages: SOFI })).rejects.toThrow("cortada")
  })

  it("un 500 se reintenta una vez; un 400 no", async () => {
    steps.push({ status: 500 }, { content: [{ type: "text", text: "Hola" }] })
    expect((await model().complete({ messages: SOFI })).content).toBe("Hola")
    expect(seen).toHaveLength(2)

    seen = []
    steps.push({ status: 400 }, { content: [{ type: "text", text: "no debería" }] })
    const error = await model()
      .complete({ messages: SOFI })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ModelError)
    expect((error as ModelError).status).toBe(400)
    expect(seen).toHaveLength(1)
  })

  it("cuenta en el registro qué modelo respondió, una vez por modelo", async () => {
    const lines: string[] = []
    const m = claudeModel({
      model: "claude-opus-5-5",
      effort: "low",
      apiKey: "x",
      baseURL,
      log: (l) => lines.push(l),
    })
    steps.push(
      { content: [{ type: "text", text: "a" }] },
      { content: [{ type: "text", text: "b" }] },
    )
    await m.complete({ messages: SOFI })
    await m.complete({ messages: SOFI })
    expect(lines).toEqual([
      "gestoria-api: Sofi con Claude: respondió claude-opus-5-5 (pedido claude-opus-5-5, esfuerzo low)",
    ])
    expect(m.name).toBe("claude-opus-5-5@low")
  })
})

describe("el costo y el entorno", () => {
  it("cobra cada parte a su precio, con la caché escrita y la leída", () => {
    const usage = {
      input: 1_000_000 + 2_000_000 + 400_000,
      cached: 2_000_000,
      written: 400_000,
      output: 100_000,
    }
    // Haiku: 1 M × 0,10 + 2 M × 0,01 + 0,4 M × 0,125 + 0,1 M × 0,50 = 0,22 USD.
    expect(costMicros("claude-haiku-5-5@low", usage)).toBe(220_000)
    // Sonnet: 2 + 0,2 + 1 + 1 = 4,2 USD; Opus, el doble.
    expect(costMicros("claude-sonnet-5-5@medium", usage)).toBe(4_200_000)
    expect(costMicros("claude-opus-5-5@low", usage)).toBe(8_400_000)
    // OpenAI, igual que antes.
    expect(costMicros("gpt-6-luna", { input: 1_000_000, cached: 0, output: 0 })).toBe(100_000)
  })

  it("OpenAI sigue por omisión; Claude solo si se pide", () => {
    expect(modelFromEnv({ GESTORIA_OPENAI_API_KEY: "k" })?.name).toBe("gpt-6-luna")
    expect(
      modelFromEnv({ GESTORIA_OPENAI_API_KEY: "k", GESTORIA_LLM_PROVIDER: "openai" })?.name,
    ).toBe("gpt-6-luna")
    expect(
      modelFromEnv({ GESTORIA_LLM_PROVIDER: "anthropic", GESTORIA_ANTHROPIC_API_KEY: "k" })?.name,
    ).toBe("claude-haiku-5-5@low")
    expect(
      modelFromEnv({
        GESTORIA_LLM_PROVIDER: "anthropic",
        GESTORIA_ANTHROPIC_API_KEY: "k",
        GESTORIA_ANTHROPIC_MODEL: "claude-sonnet-5-5",
        GESTORIA_ANTHROPIC_EFFORT: "medium",
      })?.name,
    ).toBe("claude-sonnet-5-5@medium")
    // En producción, sin su clave, Sofi no responde (no toma otra credencial de la máquina).
    expect(modelFromEnv({ GESTORIA_LLM_PROVIDER: "anthropic", NODE_ENV: "production" })).toBeNull()
    expect(() =>
      modelFromEnv({ GESTORIA_LLM_PROVIDER: "anthropic", GESTORIA_ANTHROPIC_MODEL: "claude-3" }),
    ).toThrow()
    expect(() =>
      modelFromEnv({ GESTORIA_LLM_PROVIDER: "anthropic", GESTORIA_ANTHROPIC_EFFORT: "nada" }),
    ).toThrow()
    expect(() => modelFromEnv({ GESTORIA_LLM_PROVIDER: "gemini" })).toThrow()
  })

  it("OpenAI no recibe lo que es de Claude", async () => {
    let sent: { messages: Record<string, unknown>[] } | null = null
    const m = openAIModel({
      apiKey: "k",
      fetcher: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)) as typeof sent
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        })
      }) as typeof fetch,
    })
    await m.complete({
      messages: [
        ...SOFI,
        { role: "assistant", content: "Hola", raw: [{ type: "thinking" }] },
        { role: "user", content: "?" },
      ],
    })
    expect(sent!.messages[3]).toEqual({ role: "assistant", content: "Hola" })
  })
})
