import { describe, expect, it } from "vitest"
import { dispensedUnit, weightDoseMg } from "./medications.js"

describe("la cantidad y la dosis por peso de la receta", () => {
  it("la cantidad se cuenta en lo que entrega la farmacia", () => {
    expect(dispensedUnit("tableta", 10)).toBe("tabletas")
    expect(dispensedUnit("jarabe", 1)).toBe("frasco")
    expect(dispensedUnit("Crema", 2)).toBe("tubos")
    expect(dispensedUnit("otra cosa", 2)).toBeNull()
  })

  it("una dosis por peso dice cuántos mg son por toma; sin peso o sin «mg/kg», nada", () => {
    expect(weightDoseMg("15 mg/kg cada 8 horas", 18)).toBe(270)
    expect(weightDoseMg("7,5 mg / kg", 12.4)).toBe(93)
    expect(weightDoseMg("15 mg/kg", null)).toBeNull()
    expect(weightDoseMg("1 tableta", 18)).toBeNull()
  })
})
