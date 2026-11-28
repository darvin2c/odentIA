/** El tope de pedidos en memoria (`limite.ts`): cuenta por clave y vuelve a empezar al pasar la ventana. */
import { describe, expect, it } from "vitest"
import { clientIp, createRateLimit } from "./limite.js"

describe("el tope de pedidos", () => {
  it("deja pasar hasta el tope por clave y vuelve a empezar en la ventana siguiente", () => {
    const limit = createRateLimit({ max: 2, windowMs: 1000 })
    expect([limit.hit("a", 0), limit.hit("a", 10), limit.hit("a", 20)]).toEqual([true, true, false])
    expect(limit.hit("b", 20)).toBe(true)
    expect(limit.hit("a", 1100)).toBe(true)
  })

  it("no crece sin fin: lleno de claves, empieza de cero", () => {
    const limit = createRateLimit({ max: 1, windowMs: 60_000, maxKeys: 2 })
    limit.hit("a", 0)
    limit.hit("b", 0)
    expect(limit.hit("a", 1)).toBe(false)
    expect(limit.hit("c", 1)).toBe(true)
    expect(limit.hit("a", 2)).toBe(true)
  })

  it("toma la IP de Cloudflare o la primera de x-forwarded-for", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9")
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe(
      "198.51.100.4",
    )
    expect(clientIp(new Headers())).toBe("local")
  })
})
