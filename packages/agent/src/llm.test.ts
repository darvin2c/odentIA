import { once } from "node:events"
import { createServer } from "node:http"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { fetch as undiciFetch } from "undici"
import { expect, it } from "vitest"
import { z } from "zod"
import { assertSafeBaseUrl, createPinnedDispatcher, isPrivateAddress, LlmConfigError, parseLlmBaseUrl } from "./llm-endpoint.js"
import { createConfiguredChatModel, resolveLlmSpec, resolveModelName, testLlmConnection } from "./llm.js"

it("ejecuta herramientas con un modelo real del SDK contra un endpoint compatible", async () => {
  const requests: Array<{
    url: string | undefined
    authorization: string | undefined
    body: {
      model: string
      tools: Array<{ function: { name: string } }>
      messages: Array<{ role: string; tool_call_id?: string; content: string | null }>
    }
  }> = []
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) })
    const message = requests.length === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_horario", type: "function", function: { name: "consultar_horario", arguments: '{"sede":"central"}' } }] }
      : { role: "assistant", content: "La sede abre a las 09:00." }
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ id: `chatcmpl-${requests.length}`, object: "chat.completion", created: 1, model: "proveedor/modelo", choices: [{ index: 0, message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("El servidor de prueba no abrió un puerto")
    const model = await createConfiguredChatModel({
      modelName: "proveedor/modelo",
      source: "organization",
      apiKey: "clave-sintetica-de-prueba",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 5_000,
      maxRetries: 0,
      allowInsecureBaseUrl: true,
    })
    if (!model.bindTools) throw new Error("El modelo no permite herramientas")
    const bound = model.bindTools([
      tool(async () => "09:00", { name: "consultar_horario", description: "Consulta el horario de una sede", schema: z.object({ sede: z.string() }) }),
    ])
    const input = new HumanMessage("¿A qué hora abre la sede central?")
    const reply = await bound.invoke([input])
    expect(reply.tool_calls).toEqual([{ id: "call_horario", name: "consultar_horario", args: { sede: "central" }, type: "tool_call" }])
    const final = await bound.invoke([input, reply, new ToolMessage({ tool_call_id: "call_horario", content: "09:00" })])
    expect(final.content).toBe("La sede abre a las 09:00.")
    expect(final.usage_metadata).toMatchObject({ input_tokens: 12, output_tokens: 6, total_tokens: 18 })
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.url).toBe("/v1/chat/completions")
      expect(request.authorization).toBe("Bearer clave-sintetica-de-prueba")
      expect(request.body.model).toBe("proveedor/modelo")
      expect(request.body.tools[0]?.function.name).toBe("consultar_horario")
    }
    expect(requests[1]?.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_horario", content: "09:00" })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it("la prueba de conexión reporta el fallo del proveedor sin reintentar, sin lanzar y sin el cuerpo crudo", async () => {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    // Un 500 sí sería reintentable: la prueba fija maxRetries en 0.
    response.writeHead(500, { "content-type": "text/html" })
    response.end("<html>traza interna con sk-secreta</html>")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  try {
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("El servidor de prueba no abrió un puerto")
    const result = await testLlmConnection({
      modelName: "modelo",
      source: "organization",
      apiKey: "clave-rechazada",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      timeoutMs: 5_000,
      maxRetries: 2,
      allowInsecureBaseUrl: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe("HTTP 500")
    expect(result.error).not.toContain("sk-secreta")
    expect(hits).toBe(1)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it("resuelve el nombre del modelo: openai: se quita y otros protocolos se rechazan con claridad", () => {
  expect(resolveModelName("openai:gpt-4o-mini")).toBe("gpt-4o-mini")
  expect(resolveModelName("gpt-4o-mini")).toBe("gpt-4o-mini")
  expect(resolveModelName("deepseek/deepseek-chat")).toBe("deepseek/deepseek-chat")
  // Un nombre con dos puntos que no es protocolo conocido se respeta tal cual.
  expect(resolveModelName("llama3:8b")).toBe("llama3:8b")
  expect(() => resolveModelName("anthropic:claude-sonnet-4-5")).toThrow(LlmConfigError)
  try {
    resolveModelName("google-genai:gemini")
  } catch (error) {
    expect((error as LlmConfigError).code).toBe("PROTOCOL_UNSUPPORTED")
  }
})

it("el proveedor propio es un par: nunca combina la URL de la organización con la clave de la plataforma", () => {
  const platform = { modelName: "gpt-4o-mini", apiKey: "clave-plataforma", baseUrl: "https://api.openai.com/v1" }
  const own = resolveLlmSpec({ model: "openai:modelo-propio" }, { baseUrl: "https://proveedor.example/v1", apiKey: "clave-propia" }, platform)
  expect(own).toMatchObject({ source: "organization", modelName: "modelo-propio", apiKey: "clave-propia", baseUrl: "https://proveedor.example/v1" })
  const shared = resolveLlmSpec({ model: "otro-modelo" }, null, platform)
  expect(shared).toMatchObject({ source: "platform", modelName: "otro-modelo", apiKey: "clave-plataforma", baseUrl: "https://api.openai.com/v1" })
  expect(resolveLlmSpec({ model: null }, null, platform).modelName).toBe("gpt-4o-mini")
  expect(resolveLlmSpec({ model: null }, null, { modelName: "fake" }).source).toBe("fake")
  expect(() => resolveLlmSpec({ model: null }, { baseUrl: "https://proveedor.example/v1", apiKey: "k" }, platform)).toThrow(/modelo/)
  expect(() => resolveLlmSpec({ model: "gpt-4o-mini" }, null, { modelName: "gpt-4o-mini" })).toThrow(/LLM_API_KEY/)
})

it("la URL base de un proveedor nunca apunta a la red interna", async () => {
  expect(isPrivateAddress("10.0.0.5")).toBe(true)
  expect(isPrivateAddress("172.20.1.1")).toBe(true)
  expect(isPrivateAddress("192.168.1.1")).toBe(true)
  expect(isPrivateAddress("169.254.169.254")).toBe(true)
  expect(isPrivateAddress("127.0.0.1")).toBe(true)
  expect(isPrivateAddress("::1")).toBe(true)
  expect(isPrivateAddress("::ffff:10.1.2.3")).toBe(true)
  expect(isPrivateAddress("fd12::1")).toBe(true)
  expect(isPrivateAddress("8.8.8.8")).toBe(false)
  expect(isPrivateAddress("2606:4700::1111")).toBe(false)
  expect(() => parseLlmBaseUrl("http://proveedor.example/v1")).toThrow(/https/)
  expect(() => parseLlmBaseUrl("https://user:pass@proveedor.example/v1")).toThrow(/credenciales/)
  expect(() => parseLlmBaseUrl("https://10.0.0.5/v1")).toThrow(/privada/)
  expect(() => parseLlmBaseUrl("https://localhost/v1")).toThrow(/privada/)
  expect(() => parseLlmBaseUrl("https://[::ffff:10.1.2.3]/v1")).toThrow(/privada/)
  await expect(assertSafeBaseUrl("https://localhost/v1")).rejects.toThrow(/privada/)
  await expect(assertSafeBaseUrl("https://127.0.0.1/v1")).rejects.toThrow(/privada/)
  // En dev/e2e se permiten servidores locales de prueba.
  expect(parseLlmBaseUrl("http://127.0.0.1:8080/v1", { allowInsecure: true }).port).toBe("8080")
  // Un literal público no necesita resolver nada.
  await expect(assertSafeBaseUrl("https://203.0.113.10/v1")).resolves.toBeInstanceOf(URL)
})

it("la conexión de un proveedor propio se fija a direcciones públicas al conectar", async () => {
  // El dispatcher resuelve el nombre en el momento de conectar y rechaza lo privado,
  // así una respuesta DNS que cambie después de validar no abre la red interna.
  const dispatcher = createPinnedDispatcher()
  try {
    // fetch envuelve el fallo de conexión; la causa es el rechazo de la dirección.
    const failure = await undiciFetch("http://localhost:8080/v1", { dispatcher }).then(
      () => null,
      (error: unknown) => error as Error & { cause?: Error },
    )
    expect(failure?.cause?.message ?? failure?.message).toMatch(/privada/)
  } finally {
    await dispatcher.close()
  }
})
