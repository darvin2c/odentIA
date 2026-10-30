/**
 * Un proveedor de OpenAI de mentira para las pruebas: un servidor local que
 * guarda cada petición tal como llegó y responde lo que diga la prueba. Sirve
 * para ver qué recibe el proveedor (el corte de caché, el camino) sin una
 * cuenta real. Es común: las pruebas de cada producto lo usan desde su carpeta.
 */
import { once } from "node:events"
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http"
import { expect } from "vitest"

export interface Received {
  url: string | undefined
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

/** Servidor local que hace de proveedor: responde lo que diga `reply` según la petición número n (y su ruta). */
export async function fakeProvider(reply: (n: number, response: ServerResponse, url: string | undefined) => void) {
  const requests: Received[] = []
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> })
    reply(requests.length, response, request.url)
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

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

/** La llamada a una herramienta, como la devuelve cada camino de OpenAI. */
export function toolCallReply(response: ServerResponse, url: string | undefined, name: string) {
  if (url === "/v1/responses")
    return json(response, 200, {
      id: "resp_1",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-6-luna",
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "{}", status: "completed" }],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    })
  json(response, 200, {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1,
    model: "gpt-6-luna",
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  })
}

/** El primer bloque del mensaje de sistema tal como llegó: `input` en /v1/responses, `messages` en Chat Completions. */
export const systemBlock = (request: Received | undefined) =>
  ((request?.body.input ?? request?.body.messages) as Array<{ content: unknown[] }> | undefined)?.[0]?.content[0]

/** Un bloque con el corte de caché explícito. */
export const cacheMarked = (type: "text" | "input_text", text: unknown = expect.any(String)) => ({ type, text, prompt_cache_breakpoint: { mode: "explicit" } })
