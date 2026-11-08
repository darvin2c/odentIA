import { describe, expect, it } from "vitest"
import { asaLabel } from "../../lib/patients"

// QA del 6 nov (B4): la ASA guardada no salía en ningún resumen.
describe("la clasificación ASA en el resumen de antecedentes", () => {
  it("se dice con su nombre", () => {
    expect(asaLabel("II")).toBe("ASA II · enfermedad sistémica leve")
  })
  it("sin clasificar, nada", () => {
    expect(asaLabel("")).toBeNull()
    expect(asaLabel(null)).toBeNull()
  })
})
