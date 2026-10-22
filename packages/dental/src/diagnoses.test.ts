import { describe, expect, it } from "vitest"
import { dentalDiagnosisPattern, isDentalDiagnosis } from "./diagnoses"

describe("lo odontológico de cada lista de diagnósticos", () => {
  it("reconoce la boca en la CIE-10 y en la CIE-11", () => {
    expect(isDentalDiagnosis("ICD-10", "K02")).toBe(true)
    expect(isDentalDiagnosis("ICD-10", "K02.1")).toBe(true)
    expect(isDentalDiagnosis("ICD-10", "B00.2")).toBe(true)
    expect(isDentalDiagnosis("ICD-10", "K93.8")).toBe(false)
    expect(isDentalDiagnosis("ICD-11", "DA08.0")).toBe(true)
    expect(isDentalDiagnosis("ICD-11", "1F00.02")).toBe(true)
    expect(isDentalDiagnosis("ICD-11", "BA00")).toBe(false)
  })

  it("la expresión para la base dice lo mismo que las reglas", () => {
    for (const system of ["ICD-10", "ICD-11"] as const) {
      const pattern = new RegExp(dentalDiagnosisPattern(system))
      for (const code of [
        "K02.1",
        "K93.8",
        "S02.5",
        "Q36",
        "DA08.0",
        "NA0D",
        "QB93.1",
        "BA00",
        "2B60.1",
      ])
        expect(pattern.test(code)).toBe(isDentalDiagnosis(system, code))
    }
  })
})
