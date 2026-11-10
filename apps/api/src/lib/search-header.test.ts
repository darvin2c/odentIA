import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { SEARCH_HEADER, searchFromHeader } from "./search-header.js"

describe("lo buscado en la cabecera (QA de la ficha del 10 nov, M4)", () => {
  const app = new Hono()
  app.use("*", searchFromHeader())
  app.get("/api/people", (c) => c.json({ q: c.req.query("q") ?? null, ver: c.req.query("ver") ?? null }))

  it("la ruta lee `q` como siempre, sin que viaje en la dirección", async () => {
    const res = await app.request("/api/people?ver=todos", {
      headers: { [SEARCH_HEADER]: encodeURIComponent("Peña Núñez +44") },
    })
    expect(await res.json()).toEqual({ q: "Peña Núñez +44", ver: "todos" })
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  it("sin cabecera no cambia nada, y una cabecera ilegible se rechaza", async () => {
    expect(await (await app.request("/api/people?q=Ana")).json()).toEqual({ q: "Ana", ver: null })
    const bad = await app.request("/api/people", { headers: { [SEARCH_HEADER]: "%E0%A4%A" } })
    expect(bad.status).toBe(400)
  })
})
