import { once } from "node:events"
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http"
import { ChatAnthropic } from "@langchain/anthropic"
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { AGENT_LLMS } from "@odentia/services"
import { expect, it } from "vitest"
import { z } from "zod"
import { FakeChatModel } from "./fake-model.js"
import {
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  LLM_CATALOG,
  LlmConfigError,
  platformLlmFromEnv,
  resolveLlmSpec,
} from "./llm.js"

interface Received {
  url: string | undefined
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

/** Servidor local que hace de proveedor: responde lo que diga `reply` según la petición número n. */
async function fakeProvider(reply: (n: number, response: ServerResponse) => void) {
  const requests: Received[] = []
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> })
    reply(requests.length, response)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("El servidor de prueba no abrió un puerto")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const horario = tool(async () => "09:00", {
  name: "consultar_horario",
  description: "Consulta el horario de una sede",
  schema: z.object({ sede: z.string() }),
})

it("cada opción que ve la clínica tiene detrás su proveedor y su modelo", () => {
  expect(Object.keys(LLM_CATALOG).sort()).toEqual(AGENT_LLMS.map((option) => option.id).sort())
  const platform = { openai: { apiKey: "clave-openai" }, anthropic: { apiKey: "clave-anthropic" } }
  expect(resolveLlmSpec({ llm: "chatgpt_6" }, platform)).toMatchObject({
    llm: "chatgpt_6",
    provider: "openai",
    modelName: "gpt-6-luna",
    apiKey: "clave-openai",
    reasoningEffort: "none",
  })
  const claude = resolveLlmSpec({ llm: "claude_5_5" }, platform)
  expect(claude).toMatchObject({ llm: "claude_5_5", provider: "anthropic", modelName: "claude-haiku-5-5", apiKey: "clave-anthropic", maxTokens: 2048 })
  // El razonamiento en `none` es de gpt-6-luna; a Anthropic no se le envía.
  expect(claude.reasoningEffort).toBeUndefined()
  expect(claude.baseUrl).toBeUndefined()
})

it("sin la clave del proveedor del modelo elegido el error dice qué variable falta", () => {
  // La clave de un proveedor nunca sirve para el otro.
  const onlyAnthropic = { anthropic: { apiKey: "clave-anthropic" } }
  expect(() => resolveLlmSpec({ llm: "chatgpt_6" }, onlyAnthropic)).toThrow(LlmConfigError)
  expect(() => resolveLlmSpec({ llm: "chatgpt_6" }, onlyAnthropic)).toThrow(/LLM_OPENAI_API_KEY/)
  try {
    resolveLlmSpec({ llm: "claude_5_5" }, { openai: { apiKey: "clave-openai" } })
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError)
    expect((error as LlmConfigError).code).toBe("API_KEY_REQUIRED")
    expect((error as LlmConfigError).message).toMatch(/Anthropic.*LLM_ANTHROPIC_API_KEY/)
    expect(isProviderConfigError(error)).toBe(true)
    expect(describeProviderProblem(error)).toEqual({ code: "API_KEY_REQUIRED", detail: (error as Error).message })
  }
})

it("con LLM_MODEL=fake cualquier opción es el modelo determinista, sin cuentas", async () => {
  for (const { id } of AGENT_LLMS) {
    const spec = resolveLlmSpec({ llm: id }, { fake: true })
    expect(spec).toMatchObject({ llm: id, provider: "fake", modelName: "fake" })
    expect(await createConfiguredChatModel(spec)).toBeInstanceOf(FakeChatModel)
  }
})

it("las cuentas de la plataforma se leen del entorno; LLM_MODEL solo vale para fake", () => {
  expect(platformLlmFromEnv({ LLM_MODEL: "fake" })).toEqual({ fake: true })
  expect(
    platformLlmFromEnv({
      LLM_MODEL: "gpt-6-luna",
      LLM_OPENAI_API_KEY: " clave-openai ",
      LLM_OPENAI_BASE_URL: "",
      LLM_ANTHROPIC_API_KEY: "",
      LLM_ANTHROPIC_BASE_URL: "https://pasarela.example/anthropic",
      LLM_TIMEOUT_MS: "30000",
      LLM_MAX_RETRIES: 1,
    }),
  ).toEqual({ openai: { apiKey: "clave-openai" }, timeoutMs: 30_000, maxRetries: 1 })
})

it("ChatGPT 6 ejecuta herramientas con el SDK real de OpenAI y envía reasoning_effort none", async () => {
  const provider = await fakeProvider((n, response) => {
    const message =
      n === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_horario", type: "function", function: { name: "consultar_horario", arguments: '{"sede":"central"}' } }] }
        : { role: "assistant", content: "La sede abre a las 09:00." }
    json(response, 200, {
      id: `chatcmpl-${n}`,
      object: "chat.completion",
      created: 1,
      model: "gpt-6-luna",
      choices: [{ index: 0, message, finish_reason: n === 1 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    })
  })
  try {
    const spec = resolveLlmSpec({ llm: "chatgpt_6" }, { openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
    const model = await createConfiguredChatModel(spec)
    expect(model).toBeInstanceOf(ChatOpenAI)
    if (!model.bindTools) throw new Error("El modelo no permite herramientas")
    const bound = model.bindTools([horario])
    const input = new HumanMessage("¿A qué hora abre la sede central?")
    const reply = await bound.invoke([input])
    expect(reply.tool_calls).toEqual([{ id: "call_horario", name: "consultar_horario", args: { sede: "central" }, type: "tool_call" }])
    const final = await bound.invoke([input, reply, new ToolMessage({ tool_call_id: "call_horario", content: "09:00" })])
    expect(final.content).toBe("La sede abre a las 09:00.")
    expect(final.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 6, total_tokens: 18 })
    expect(provider.requests).toHaveLength(2)
    for (const request of provider.requests) {
      expect(request.url).toBe("/v1/chat/completions")
      expect(request.headers.authorization).toBe("Bearer clave-sintetica")
      // LangChain no envía `reasoning` a un nombre que no reconoce: va directo en la petición.
      expect(request.body).toMatchObject({ model: "gpt-6-luna", reasoning_effort: "none" })
      expect((request.body.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe("consultar_horario")
    }
  } finally {
    await provider.close()
  }
})

it("Claude 5.5 crea ChatAnthropic y enlaza las herramientas igual, con su tope de salida", async () => {
  const provider = await fakeProvider((n, response) => {
    const content =
      n === 1
        ? [{ type: "tool_use", id: "toolu_horario", name: "consultar_horario", input: { sede: "central" } }]
        : [{ type: "text", text: "La sede abre a las 09:00." }]
    json(response, 200, {
      id: `msg_${n}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content,
      stop_reason: n === 1 ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 6 },
    })
  })
  try {
    const spec = resolveLlmSpec({ llm: "claude_5_5" }, { anthropic: { apiKey: "clave-sintetica", baseUrl: provider.origin }, maxRetries: 0 })
    const model = await createConfiguredChatModel(spec)
    expect(model).toBeInstanceOf(ChatAnthropic)
    if (!model.bindTools) throw new Error("El modelo no permite herramientas")
    const bound = model.bindTools([horario])
    const input = new HumanMessage("¿A qué hora abre la sede central?")
    const reply = await bound.invoke([input])
    expect(reply.tool_calls).toEqual([{ id: "toolu_horario", name: "consultar_horario", args: { sede: "central" }, type: "tool_call" }])
    const final = await bound.invoke([input, reply, new ToolMessage({ tool_call_id: "toolu_horario", content: "09:00" })])
    expect(final.content).toBe("La sede abre a las 09:00.")
    expect(final.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 6 })
    expect(provider.requests).toHaveLength(2)
    for (const request of provider.requests) {
      expect(request.url).toBe("/v1/messages")
      expect(request.headers["x-api-key"]).toBe("clave-sintetica")
      // Responder o llamar a una herramienta no necesita pensar mucho: lo pensado se cobra como salida.
      expect(request.body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 2048, output_config: { effort: "low" } })
      expect(request.body).not.toHaveProperty("reasoning_effort")
      expect((request.body.tools as Array<{ name: string }>)[0]?.name).toBe("consultar_horario")
    }
  } finally {
    await provider.close()
  }
})

it("Claude 5.5 recibe marcada para su caché la parte fija del sistema y devuelve lo leído y lo escrito en ella", async () => {
  const provider = await fakeProvider((n, response) => {
    json(response, 200, {
      id: `msg_${n}`,
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "text", text: "Hola" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 600, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 400, output_tokens: 50 },
    })
  })
  try {
    const spec = resolveLlmSpec({ llm: "claude_5_5" }, { anthropic: { apiKey: "clave-sintetica", baseUrl: provider.origin }, maxRetries: 0 })
    const model = await createConfiguredChatModel(spec)
    const reply = await model.invoke([
      new SystemMessage({
        content: [
          { type: "text", text: "Lo de toda la clínica", cache_control: { type: "ephemeral" } },
          { type: "text", text: "Lo de este hilo" },
        ],
      }),
      new HumanMessage("Hola"),
    ])
    expect(provider.requests[0]?.body.system).toEqual([
      { type: "text", text: "Lo de toda la clínica", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Lo de este hilo" },
    ])
    // LangChain suma en input_tokens lo nuevo, lo leído y lo escrito; el costo los separa.
    expect(reply.usage_metadata).toMatchObject({ input_tokens: 3_000, output_tokens: 50, input_token_details: { cache_read: 2_000, cache_creation: 400 } })
  } finally {
    await provider.close()
  }
})

it("los errores de Anthropic se reconocen como del proveedor: credencial rechazada y sin crédito, sin reintentar", async () => {
  const errors = [
    { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    {
      status: 400,
      body: { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
    },
    { status: 402, body: { type: "error", error: { type: "billing_error", message: "Billing issue" } } },
  ]
  const provider = await fakeProvider((n, response) => json(response, errors[n - 1]!.status, errors[n - 1]!.body))
  try {
    const spec = resolveLlmSpec({ llm: "claude_5_5" }, { anthropic: { apiKey: "clave-rechazada", baseUrl: provider.origin }, maxRetries: 2 })
    const problems = []
    for (let i = 0; i < errors.length; i++) {
      const failure = await (await createConfiguredChatModel(spec)).invoke([new HumanMessage("Hola")]).then(
        () => null,
        (error: unknown) => error,
      )
      expect(isProviderConfigError(failure)).toBe(true)
      problems.push(describeProviderProblem(failure))
    }
    expect(problems).toEqual([
      { code: "PROVIDER_REJECTED", detail: "HTTP 401: invalid x-api-key" },
      { code: "PROVIDER_QUOTA", detail: "HTTP 400: Your credit balance is too low to access the Anthropic API." },
      { code: "PROVIDER_QUOTA", detail: "HTTP 402: Billing issue" },
    ])
    // Ninguno se reintentó: una petición por intento.
    expect(provider.requests).toHaveLength(errors.length)
  } finally {
    await provider.close()
  }
})

it("los errores de OpenAI siguen reconociéndose: cuota agotada y modelo inexistente", async () => {
  const errors = [
    { status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } } },
    { status: 404, body: { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } } },
  ]
  const provider = await fakeProvider((n, response) => json(response, errors[n - 1]!.status, errors[n - 1]!.body))
  try {
    const spec = resolveLlmSpec({ llm: "chatgpt_6" }, { openai: { apiKey: "clave", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
    const problems = []
    for (let i = 0; i < errors.length; i++) {
      const failure = await (await createConfiguredChatModel(spec)).invoke([new HumanMessage("Hola")]).then(
        () => null,
        (error: unknown) => error,
      )
      expect(isProviderConfigError(failure)).toBe(true)
      problems.push(describeProviderProblem(failure))
    }
    expect(problems).toEqual([
      { code: "PROVIDER_QUOTA", detail: "HTTP 429: You exceeded your current quota" },
      { code: "PROVIDER_REJECTED", detail: "HTTP 404: The model does not exist" },
    ])
  } finally {
    await provider.close()
  }
})
