import { describe, expect, it } from "vitest"
import { allergySeverityWord, bySeverity } from "./allergies"
import type { Allergy } from "./patients"

const allergy = (substance: string, severity: string, criticality?: string): Allergy => ({
  id: substance,
  substance,
  severity,
  criticality,
  isActive: true,
})

describe("alergias, de la más grave a la menos", () => {
  it("lo severo y la criticidad alta van primero, y lo que no se sabe antes que lo moderado", () => {
    const sorted = [
      allergy("látex", "leve"),
      allergy("polen", "desconocida"),
      allergy("amoxicilina", "moderada"),
      allergy("ibuprofeno", "leve", "alta"),
      allergy("penicilina", "severa"),
    ].sort(bySeverity)
    expect(sorted.map((row) => row.substance)).toEqual(["ibuprofeno", "penicilina", "polen", "amoxicilina", "látex"])
  })

  it("dice qué tan fuerte fue solo si se sabe", () => {
    expect(allergySeverityWord(allergy("a", "severa"))).toBe("severa")
    expect(allergySeverityWord(allergy("a", "moderada"))).toBe("moderada")
    expect(allergySeverityWord(allergy("a", "desconocida"))).toBe("")
    expect(allergySeverityWord(allergy("a", "desconocida", "alta"))).toBe("de criticidad alta")
    expect(allergySeverityWord(allergy("a", "severa", "alta"))).toBe("severa")
  })
})
