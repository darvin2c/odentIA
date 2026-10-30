import { documentCheckToken } from "@odentia/services"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { createPublicDocumentsRoute } from "./public-documents.js"

const KEY = Buffer.alloc(32, 3)

/** Sin base a propósito: lo que no pasa la firma no llega a tocarla. */
function app() {
  const route = new Hono()
  route.route("/", createPublicDocumentsRoute({ db: {} as never, secretsKey: KEY, remoteAddress: () => "198.51.100.7" }))
  return route
}

describe("comprobar un documento", () => {
  it("un token inválido o alterado es el mismo 404, sin caché", async () => {
    const good = documentCheckToken(KEY, "org_a", "prescription", "11111111-1111-4111-8111-111111111111")
    const route = app()
    const bodies = new Set<string>()
    for (const token of ["basura", `${good}x`, `x${good}`, good.split(".")[0]!]) {
      const response = await route.request(`/${token}`)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const { error } = (await response.json()) as { error: { code: string; message: string } }
      bodies.add(`${error.code}:${error.message}`)
    }
    expect(bodies.size).toBe(1)
  })

  it("corta a quien insiste", async () => {
    const route = app()
    let last = 0
    for (let i = 0; i < 61; i++) last = (await route.request("/basura")).status
    expect(last).toBe(429)
  })
})
