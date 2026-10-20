import { describe, expect, it } from "vitest"
import { findInventoryUnit, quantityWords, stockWords, unitFor } from "./inventory-units.js"

describe("unidades del inventario", () => {
  it("dice la unidad en singular o plural", () => {
    expect(unitFor(1, "guante")).toBe("guante")
    expect(unitFor(2, "guante")).toBe("guantes")
    expect(unitFor(-3, "jeringa")).toBe("jeringas")
    expect(unitFor(2, "unidad")).toBe("unidades")
    expect(unitFor(2, "lápiz")).toBe("lápices")
    expect(unitFor(2, "sobre")).toBe("sobres")
  })

  it("escribe la cantidad con el separador de la clínica", () => {
    expect(quantityWords(1100, "guante", "en-US")).toBe("1,100 guantes")
  })

  it("dice también las unidades de compra cuando el factor es exacto", () => {
    const glove = { unit: "guante", purchaseUnit: "caja", purchaseFactor: 100 }
    expect(stockWords(1100, glove, "en-US")).toBe("1,100 guantes · 11 cajas")
    expect(stockWords(1050, glove, "en-US")).toBe("1,050 guantes")
    expect(stockWords(0, glove, "en-US")).toBe("0 guantes")
  })

  it("guarda el código internacional solo cuando existe", () => {
    expect(findInventoryUnit(" Caja ")?.code).toBe("XBX")
    expect(findInventoryUnit("mililitro")?.system).toBe("UCUM")
    expect(findInventoryUnit("guante")?.code).toBeNull()
    expect(findInventoryUnit("ampolla")).toBeNull()
  })
})
