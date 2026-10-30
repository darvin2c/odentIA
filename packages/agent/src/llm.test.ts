import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { ChatOpenAI } from "@langchain/openai"
import { agentTextsFor } from "@odentia/services"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { argosMessages, argosModel, argosUnreadable } from "./argos.js"
import { FakeChatModel } from "./fake-model.js"
import {
  cachedPrompt,
  createConfiguredChatModel,
  describeProviderProblem,
  isProviderConfigError,
  AGENT_MODEL,
  LlmConfigError,
  platformLlmFromEnv,
  resolveLlmSpec,
  viaResponses,
} from "./llm.js"
import { cacheMarked, fakeProvider, json, systemBlock, toolCallReply } from "./test-provider.js"

const horario = tool(async () => "09:00", {
  name: "consultar_horario",
  description: "Consulta el horario de una sede",
  schema: z.object({ sede: z.string() }),
})

it("el modelo que escribe es uno solo, con la cuenta de OpenAI de odentIA", () => {
  expect(resolveLlmSpec({ openai: { apiKey: "clave-openai" } })).toEqual({
    provider: "openai",
    modelName: AGENT_MODEL.modelName,
    apiKey: "clave-openai",
    reasoningEffort: "none",
    timeoutMs: 60_000,
    maxRetries: 2,
  })
})

it("sin la clave de OpenAI el error dice qué variable falta", () => {
  try {
    resolveLlmSpec({})
    expect.unreachable()
  } catch (error) {
    expect(error).toBeInstanceOf(LlmConfigError)
    expect((error as LlmConfigError).code).toBe("API_KEY_REQUIRED")
    expect((error as LlmConfigError).message).toMatch(/OpenAI.*LLM_OPENAI_API_KEY/)
    expect(isProviderConfigError(error)).toBe(true)
    expect(describeProviderProblem(error)).toEqual({ code: "API_KEY_REQUIRED", detail: (error as Error).message })
  }
})

it("con LLM_MODEL=fake es el modelo determinista, sin cuentas", async () => {
  const spec = resolveLlmSpec({ fake: true })
  expect(spec).toMatchObject({ provider: "fake", modelName: "fake" })
  expect(await createConfiguredChatModel(spec)).toBeInstanceOf(FakeChatModel)
})

it("las cuentas de la plataforma se leen del entorno; LLM_MODEL solo vale para fake", () => {
  expect(platformLlmFromEnv({ LLM_MODEL: "fake" })).toEqual({ fake: true })
  expect(
    platformLlmFromEnv({
      LLM_MODEL: "gpt-6-luna",
      LLM_OPENAI_API_KEY: " clave-openai ",
      LLM_OPENAI_BASE_URL: "",
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
    const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
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

it("con razonamiento, ChatGPT 6 va por /v1/responses con el nivel pedido y sin temperatura, y sus herramientas siguen", async () => {
  const provider = await fakeProvider((n, response) => {
    json(response, 200, {
      id: `resp_${n}`,
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-6-luna",
      output: [
        { type: "function_call", id: "fc_1", call_id: "call_horario", name: "consultar_horario", arguments: '{"sede":"central"}', status: "completed" },
      ],
      usage: { input_tokens: 12, output_tokens: 30, total_tokens: 42, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 24 } },
    })
  })
  try {
    const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
    const model = await createConfiguredChatModel(spec, { explicitCache: true, temperature: 0, reasoning: "high" })
    if (!model.bindTools) throw new Error("El modelo no permite herramientas")
    const reply = await model.bindTools([horario], { tool_choice: "consultar_horario" }).invoke([new HumanMessage("¿A qué hora abre la sede central?")])
    expect(reply.tool_calls).toMatchObject([{ name: "consultar_horario", args: { sede: "central" } }])
    expect(reply.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 30, output_token_details: { reasoning: 24 } })
    // gpt-6-luna no acepta herramientas con razonamiento en chat/completions: va por responses.
    expect(provider.requests[0]?.url).toBe("/v1/responses")
    expect(provider.requests[0]?.body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "high" } })
    expect(provider.requests[0]?.body).not.toHaveProperty("temperature")
    expect(provider.requests[0]?.body).not.toHaveProperty("reasoning_effort")
  } finally {
    await provider.close()
  }
})

it("ChatGPT 6 con caché explícita recibe el corte en la parte fija y devuelve lo que escribió en ella", async () => {
  const provider = await fakeProvider((n, response) => {
    json(response, 200, {
      id: `chatcmpl-${n}`,
      object: "chat.completion",
      created: 1,
      model: "gpt-6-luna",
      choices: [{ index: 0, message: { role: "assistant", content: "Hola" }, finish_reason: "stop" }],
      // Primera pausa del dictado medida el 2026-10-17: escribe la parte fija y no lee nada.
      usage: { prompt_tokens: 2_093, completion_tokens: 90, total_tokens: 2_183, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2_022 } },
    })
  })
  try {
    const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
    const fixed = { type: "text", text: "Lo de toda la atención", prompt_cache_breakpoint: { mode: "explicit" } }
    const reply = await (await createConfiguredChatModel(spec, { explicitCache: true })).invoke([new SystemMessage({ content: [fixed] }), new HumanMessage("Lo de la pausa")])
    expect(provider.requests[0]?.body).toMatchObject({ reasoning_effort: "none", prompt_cache_options: { mode: "explicit" } })
    expect(((provider.requests[0]?.body.messages ?? []) as Array<{ content: unknown }>)[0]?.content).toEqual([fixed])
    // Desde LangChain OpenAI 1.5.9 llega lo escrito en la caché; antes se perdía y no se cobraba.
    expect(reply.usage_metadata).toMatchObject({ input_tokens: 2_093, output_tokens: 90, input_token_details: { cache_read: 0, cache_creation: 2_022 } })
    // Sin la opción (Recepción) OpenAI pone su corte solo: no se le pide otra cosa.
    await (await createConfiguredChatModel(spec)).invoke([new HumanMessage("Hola")])
    expect(provider.requests[1]?.body).not.toHaveProperty("prompt_cache_options")
  } finally {
    await provider.close()
  }
})

// El dictado de cada producto se prueba igual en su carpeta (`dental/dictation.test.ts`, `medical/dictation.test.ts`).
describe("el corte de la parte fija llega al proveedor por los dos caminos", () => {
  it("por /v1/responses va en un bloque input_text: a uno text LangChain 1.5.13 le quita el corte", async () => {
    const provider = await fakeProvider((_, response, url) => toolCallReply(response, url, "consultar_horario"))
    try {
      const spec = resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
      expect(viaResponses(await createConfiguredChatModel(spec, { explicitCache: true }))).toBe(false)
      const model = await createConfiguredChatModel(spec, { explicitCache: true, reasoning: "low" })
      expect(viaResponses(model)).toBe(true)
      await model.invoke([new SystemMessage({ content: cachedPrompt("openai", "Lo fijo", true) }), new HumanMessage("Lo que cambia")])
      // Así llegaba la parte fija de Argos y del dictado de latidIA: el corte se perdía por el camino.
      await model.invoke([new SystemMessage({ content: cachedPrompt("openai", "Lo fijo", false) }), new HumanMessage("Lo que cambia")])
      expect(provider.requests.map((request) => request.url)).toEqual(["/v1/responses", "/v1/responses"])
      expect(systemBlock(provider.requests[0])).toEqual(cacheMarked("input_text", "Lo fijo"))
      expect(systemBlock(provider.requests[1])).toEqual({ type: "input_text", text: "Lo fijo" })
      // Sin caché (el modelo de demostración), el texto solo.
      expect(cachedPrompt("fake", "Lo fijo", true)).toBe("Lo fijo")
    } finally {
      await provider.close()
    }
  })

  it("Argos piensa por /v1/responses y su parte fija llega con el corte; sin pensar va por Chat Completions, también con él", async () => {
    const provider = await fakeProvider((_, response, url) => toolCallReply(response, url, "responder"))
    try {
      const platform = { openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 }
      const texts = agentTextsFor("dental")
      const ask = { texts, question: "¿Cuánto cobré este mes?", key: "gestion" as const, now: new Date("2026-10-29T15:00:00Z"), zone: { timezone: "America/Lima", locale: "es-PE" } }
      // Como `askArgos`: con lo que piensa Argos (`ARGOS_REASONING`) y, para medir, sin pensar.
      for (const deps of [{ platform }, { platform, reasoning: "none" as const }]) {
        const model = await argosModel(deps, texts)
        if (!model) throw new Error("Argos se quedó sin modelo")
        await model.invoke(argosMessages(model.provider, ask, model.responses), "required")
      }
      expect(provider.requests.map((request) => request.url)).toEqual(["/v1/responses", "/v1/chat/completions"])
      expect(systemBlock(provider.requests[0])).toEqual(cacheMarked("input_text", expect.stringContaining("Cifras oficiales")))
      expect(systemBlock(provider.requests[1])).toEqual(cacheMarked("text", expect.stringContaining("Cifras oficiales")))
    } finally {
      await provider.close()
    }
  })
})

describe("Argos responde siempre con una herramienta", () => {
  const texts = agentTextsFor("dental")
  const ask = { texts, question: "¿Cuánto cobré este mes?", key: "gestion" as const, now: new Date("2026-10-30T15:00:00Z"), zone: { timezone: "America/Lima", locale: "es-PE" } }

  it("por los dos caminos el proveedor recibe que use una, y en el último turno, responder", async () => {
    const provider = await fakeProvider((_, response, url) => toolCallReply(response, url, "responder"))
    try {
      const platform = { openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 }
      for (const deps of [{ platform }, { platform, reasoning: "none" as const }]) {
        const model = await argosModel(deps, texts)
        if (!model) throw new Error("Argos se quedó sin modelo")
        for (const choice of ["required", "responder"]) await model.invoke(argosMessages(model.provider, ask, model.responses), choice)
      }
      expect(provider.requests.map((request) => request.body.tool_choice)).toEqual([
        // Como texto, LangChain 1.5.13 no envía «required» por /v1/responses: va con las tres en `allowed_tools`.
        { type: "allowed_tools", mode: "required", tools: ["buscar_nombres", "calcular", "responder"].map((name) => ({ type: "function", name })) },
        { type: "function", name: "responder" },
        "required",
        { type: "function", function: { name: "responder" } },
      ])
    } finally {
      await provider.close()
    }
  })

  it("lo que no se lee queda para medir tal como llegó: el texto sin herramienta o los campos que no caben", async () => {
    const provider = await fakeProvider((_, response) =>
      json(response, 200, {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-6-luna",
        output: [
          { type: "reasoning", id: "rs_1", summary: [] },
          { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "{periodo} cobraste {cobrado_dinero}.", annotations: [] }] },
        ],
        usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 } },
      }),
    )
    try {
      const model = await argosModel({ platform: { openai: { apiKey: "clave-sintetica", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 } }, texts)
      if (!model) throw new Error("Argos se quedó sin modelo")
      const reply = await model.invoke(argosMessages(model.provider, ask, model.responses), "required")
      expect(reply.tool_calls).toEqual([])
      expect(JSON.parse(argosUnreadable(reply))).toMatchObject({
        estado: "completed",
        salida: [{ type: "reasoning" }, { type: "message", content: [{ text: "{periodo} cobraste {cobrado_dinero}." }] }],
      })
      const call = { name: "responder", args: { tipo: "otra_cosa" } }
      expect(JSON.parse(argosUnreadable(reply, call, [{ code: "custom", path: ["tipo"], message: "no es una opción", input: "otra_cosa" }]))).toEqual({
        estado: "completed",
        llamada: "responder",
        campos: ["tipo: no es una opción"],
        args: { tipo: "otra_cosa" },
      })
    } finally {
      await provider.close()
    }
  })
})

it("los errores de OpenAI se reconocen como del proveedor: cuota agotada y modelo inexistente", async () => {
  const errors = [
    { status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } } },
    { status: 404, body: { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } } },
  ]
  const provider = await fakeProvider((n, response) => json(response, errors[n - 1]!.status, errors[n - 1]!.body))
  try {
    const spec = resolveLlmSpec({ openai: { apiKey: "clave", baseUrl: `${provider.origin}/v1` }, maxRetries: 0 })
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
