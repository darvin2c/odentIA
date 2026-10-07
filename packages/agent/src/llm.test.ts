import { once } from "node:events"
import { createServer } from "node:http"
import { HumanMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { expect, it } from "vitest"
import { z } from "zod"
import { createConfiguredChatModel } from "./llm.js"

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
    const model = await createConfiguredChatModel("openai:proveedor/modelo", {
      apiKey: "clave-sintetica-de-prueba",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
