import { describe, expect, it } from "vitest"
import { dentalDiagnosisPattern, isDentalDiagnosis, isUrgentDiagnosis } from "./diagnoses"
import { phaseForTreatment } from "./treatment-templates"

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

describe("la fase «Urgencia» que propone el diagnóstico", () => {
  it("dolor, infección aguda o trauma en la CIE-10 (con subcódigos) y en la CIE-11; lo crónico no", () => {
    for (const code of ["K04.0", "K04.01", "K04.4", "K04.7", "K05.2", "K10.2", "K10.3", "K12.2", "S02.5", "S03.2"])
      expect(isUrgentDiagnosis("ICD-10-PE", code), code).toBe(true)
    for (const code of ["K04.1", "K04.5", "K04.6", "K04.8", "K02.1", "K08.3", "K05.3"])
      expect(isUrgentDiagnosis("ICD-10", code), code).toBe(false)
    for (const code of ["DA09.0", "DA09.70", "DA09.62", "DA0C.0", "DA06.1", "DA01.30", "NA0D.03", "NA0D.15"])
      expect(isUrgentDiagnosis("ICD-11", code), code).toBe(true)
    for (const code of ["DA09.1", "DA09.61", "DA09.71", "DA08.0"]) expect(isUrgentDiagnosis("ICD-11", code), code).toBe(false)
    // En la CIE-10-ES, K05.2 es la periodontitis agresiva.
    expect(isUrgentDiagnosis("ICD-10-ES", "K05.21")).toBe(false)
  })

  it("adelanta solo lo básico y lo quirúrgico; lo rehabilitador nunca", () => {
    const pulpitis = [{ system: "ICD-10-PE", code: "K04.0" }]
    expect(phaseForTreatment("endodoncia", pulpitis)).toBe("urgencia")
    expect(phaseForTreatment("cirugia", pulpitis)).toBe("urgencia")
    expect(phaseForTreatment("protesis", pulpitis)).toBe("rehabilitadora")
    expect(phaseForTreatment("restauradora", [{ system: "ICD-10-PE", code: "K02.1" }])).toBe("basica")
    expect(phaseForTreatment("cirugia", [{ system: "ICD-10-PE", code: "K08.3" }])).toBe("quirurgica")
  })
})
