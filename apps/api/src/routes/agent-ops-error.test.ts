import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import * as schema from "@odentia/db/schema/index"
import { type Storage, secretsKeyFromEnv } from "@odentia/services"
import { drizzle } from "drizzle-orm/postgres-js"
import { Hono } from "hono"
import postgres from "postgres"
import { expect, it } from "vitest"
import { errorBody } from "../lib/error.js"
import { createAgentOpsRoute } from "./agent-ops.js"

const unusedStorage: Storage = {
  putAvatar: async () => { throw new Error("No corresponde usar almacenamiento en la autorización") },
  deleteByUrl: async () => {},
  putAttachment: async () => { throw new Error("No corresponde crear adjuntos") },
  attachmentUrl: async () => { throw new Error("No corresponde consultar adjuntos") },
  deleteAttachment: async () => {},
  putPatientDocument: async () => { throw new Error("No corresponde crear documentos") },
  putPatientAvatar: async () => { throw new Error("No corresponde crear avatares") },
}

it.each([
  { endpoint: "decision", body: { decision: "aprobada" } },
  { endpoint: "execute", body: undefined },
  { endpoint: "confirm", body: { contactId: randomUUID() } },
])("la pérdida real de conexión en $endpoint llega al manejador global, no a un 404", async ({ endpoint, body }) => {
  // Reservar y cerrar un puerto propio provoca ECONNREFUSED real, sin
  // un mock de DB ni un servidor que imite su protocolo.
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Falta el puerto de prueba")
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const client = postgres(`postgres://app:prueba@127.0.0.1:${address.port}/prueba`, { max: 1, connect_timeout: 1 })
  const failures: Error[] = []
  const app = new Hono<{ Variables: { orgId: string; userId: string; memberRole: string } }>()
  app.use("*", async (c, next) => {
    c.set("orgId", "org-prueba")
    c.set("userId", "operadora")
    c.set("memberRole", "owner")
    await next()
  })
  app.onError((error, c) => {
    failures.push(error)
    return c.json(errorBody(c, "INTERNAL", "Error interno"), 500)
  })
  app.route("/agent", createAgentOpsRoute({
    db: drizzle(client, { schema }), storage: unusedStorage, secretsKey: secretsKeyFromEnv("ee".repeat(32)),
    validateExternal: false, webhookBaseUrl: "https://api.example.test", llm: { fake: true },
  }))
  try {
    const response = await app.request(`/agent/proposals/${randomUUID()}/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: "INTERNAL" } })
    expect(failures).toHaveLength(1)
  } finally {
    await client.end({ timeout: 1 })
  }
})
