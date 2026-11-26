import { describe, expect, it } from "vitest"
import { lookableRequest, SUPPORT_LOOK_MS } from "./support-look"

const NOW = Date.parse("2026-11-25T15:31:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const asked = (over: Partial<Parameters<typeof lookableRequest>[0][number]> = {}) => ({
  id: "r1",
  type: "soporte.entrar",
  status: "hecho",
  mine: true,
  createdAt: ago(60_000),
  ...over,
})

describe("«Mirar la tienda (solo mirar)» en la administración (ADR 0219)", () => {
  it("va en el pedido de entrar de quien lo pidió, ya llegado a la tienda", () => {
    expect(lookableRequest([asked()], NOW)).toBe("r1")
  })

  it("nunca a otra persona del equipo, ni antes de llegar, ni si falló, ni en otro pedido", () => {
    expect(lookableRequest([asked({ mine: false })], NOW)).toBeNull()
    expect(lookableRequest([asked({ status: "pendiente" })], NOW)).toBeNull()
    expect(lookableRequest([asked({ status: "fallo" })], NOW)).toBeNull()
    expect(lookableRequest([asked({ type: "equipo.quitar" })], NOW)).toBeNull()
  })

  it("se apaga cuando ya no puede estar por aceptar ni vigente, y va solo en el más nuevo", () => {
    expect(lookableRequest([asked({ createdAt: ago(SUPPORT_LOOK_MS + 1) })], NOW)).toBeNull()
    expect(
      lookableRequest(
        [asked({ id: "nuevo" }), asked({ id: "viejo", createdAt: ago(3_600_000) })],
        NOW,
      ),
    ).toBe("nuevo")
  })
})
