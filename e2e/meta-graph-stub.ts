import { createServer, type IncomingMessage } from "node:http"

/**
 * Meta de mentira para los canales de la administración (solo el harness): la
 * API lleva lo que iría a graph.facebook.com a este servidor
 * (`ADMIN_META_GRAPH_URL`, que en producción no arranca). Acepta cada envío
 * con un id nuevo, da el nombre de quien escribe por Instagram o Messenger y
 * sirve los archivos («media-…») como CSV. `GET /__enviados` devuelve lo que
 * recibió, para que un recorrido mire qué salió. No acredita la Graph API real.
 */
export interface MetaGraphStub {
  url: string
  close: () => Promise<void>
}

const CSV = "nombre,telefono\nPaciente Ficticio,900000000\n"

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

export async function startMetaGraphStub(): Promise<MetaGraphStub> {
  const sent: Array<{ path: string; body: unknown }> = []
  let seq = 0
  let base = ""
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub")
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    try {
      if (request.method === "GET" && url.pathname === "/__enviados") return json(200, sent)
      if (request.method === "GET" && url.pathname.startsWith("/descarga/")) {
        response.writeHead(200, { "content-type": "text/csv" })
        response.end(CSV)
        return
      }
      if (request.method === "POST" && url.pathname.endsWith("/messages")) {
        const raw = await bodyOf(request)
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {}
        sent.push({ path: url.pathname, body })
        seq += 1
        // WhatsApp responde `messages[0].id`; Messenger (y Instagram por la página), `message_id`.
        return json(200, {
          messaging_product: "whatsapp",
          messages: [{ id: `wamid.stub-${seq}` }],
          recipient_id: "stub",
          message_id: `mid.stub-${seq}`,
        })
      }
      if (request.method === "GET") {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "")
        if (id.startsWith("media-"))
          return json(200, {
            id,
            url: `${base}/descarga/${encodeURIComponent(id)}`,
            mime_type: "text/csv",
            file_size: CSV.length,
          })
        return json(200, { id, name: "Melissa Ortega", username: "dra.melissa.ortodoncia" })
      }
      return json(404, { error: { message: "No existe en la Meta de mentira" } })
    } catch (error) {
      json(500, { error: { message: String(error) } })
    }
  })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve())
  await promise
  // No retiene al supervisor: se va con él.
  server.unref()
  const address = server.address()
  if (typeof address !== "object" || address === null)
    throw new Error("La Meta de mentira no arrancó")
  base = `http://127.0.0.1:${address.port}`
  return {
    url: base,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
