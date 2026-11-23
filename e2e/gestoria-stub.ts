import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"

/**
 * gestorIA de mentira para lo que la administración le pide (ADR 0213; solo el harness): la API
 * y el worker le mandan los pedidos a este servidor (`GESTORIA_CONTRACT_URL`, con un secreto de
 * la corrida). Responde como respondería gestorIA: dejar entrar a soporte y abrir una cuenta,
 * «hecho»; quitar a una persona, «falló» porque es el único Dueño. `GET /__pedidos` devuelve lo
 * que recibió. No acredita el gestorIA real: ese se prueba con su propio recorrido.
 */
export interface GestoriaStub {
  url: string
  secret: string
  close: () => Promise<void>
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

const ANSWERS: Record<string, { status: "hecho" | "fallo"; message: string }> = {
  "soporte.entrar": {
    status: "hecho",
    message: "Pedido a la tienda: su Dueño o un Administrador decide si entras.",
  },
  "cuenta.abrir": { status: "hecho", message: "Tienda abierta: su dueño ya puede entrar." },
  "equipo.quitar": {
    status: "fallo",
    message: "Es el único Dueño de la tienda: antes, la tienda tiene que tener otro Dueño.",
  },
}

export async function startGestoriaStub(): Promise<GestoriaStub> {
  const received: Array<{ id: string; type: string }> = []
  const secret = `whsec_${randomBytes(32).toString("base64")}`
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub")
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" })
      response.end(JSON.stringify(value))
    }
    try {
      if (request.method === "GET" && url.pathname === "/__pedidos") return json(200, received)
      if (request.method === "POST" && url.pathname === "/acuerdo/pedidos") {
        const id = String(request.headers["webhook-id"] ?? "")
        if (!id || !request.headers["webhook-signature"])
          return json(401, { message: "Firma inválida" })
        const type = String((JSON.parse(await bodyOf(request)) as { type?: unknown }).type ?? "")
        const answer = ANSWERS[type]
        if (!answer) return json(400, { message: "Pedido ilegible" })
        received.push({ id, type })
        return json(200, answer)
      }
      return json(404, { message: "No existe en el gestorIA de mentira" })
    } catch (error) {
      json(500, { message: String(error) })
    }
  })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => resolve())
  await promise
  server.unref()
  const address = server.address()
  if (typeof address !== "object" || address === null)
    throw new Error("El gestorIA de mentira no arrancó")
  return {
    url: `http://127.0.0.1:${address.port}`,
    secret,
    close: () => new Promise<void>((done) => server.close(() => done())),
  }
}
