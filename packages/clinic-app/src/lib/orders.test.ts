import { describe, expect, it } from "vitest"
import { canSkipToReady, canVoid, nextStepOf, ORDER_STEPS, orderViewOf } from "./orders"

describe("los pasos de un pedido en la pantalla", () => {
  it("cada paso ofrece el siguiente, siempre hacia adelante", () => {
    for (const status of ORDER_STEPS.slice(0, -1)) {
      const next = nextStepOf(status)
      expect(next && ORDER_STEPS.indexOf(next.status)).toBe(ORDER_STEPS.indexOf(status) + 1)
    }
    expect(nextStepOf("listo")?.label).toBe("Entregar")
    expect(nextStepOf("entregado")).toBeNull()
    expect(nextStepOf("anulado")).toBeNull()
  })

  it("«Marcar listo» solo salta pasos, y lo entregado o anulado no se anula", () => {
    expect(
      ["por_enviar", "en_laboratorio"].every((status) => canSkipToReady(status as never)),
    ).toBe(true)
    expect(canSkipToReady("por_revisar")).toBe(false)
    expect(canVoid("listo")).toBe(true)
    expect(canVoid("entregado")).toBe(false)
    expect(canVoid("anulado")).toBe(false)
  })

  it("una vista que no existe abre «Abiertos»", () => {
    expect(orderViewOf("listos").status).toBe("listo")
    expect(orderViewOf("otra").value).toBe("abiertos")
    expect(orderViewOf(undefined).value).toBe("abiertos")
  })
})
