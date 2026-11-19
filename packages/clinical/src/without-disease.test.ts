import { describe, expect, it } from "vitest"
import {
  DENTAL_WITHOUT_DISEASE,
  isWithoutDiseaseCode,
  MEDICAL_WITHOUT_DISEASE,
  withoutDiseaseOptions,
} from "./without-disease.js"

const base = { system: "ICD-10-PE" as const, ageYears: 35, treated: false, protesis: false, ortodoncia: false }
const keys = (options: Array<{ key: string }>) => options.map((option) => option.key)

describe("«Sin enfermedad»: los atajos que le corresponden a la visita", () => {
  it("odentIA, primera visita: solo el chequeo y sin hallazgos, con el código de la lista de la clínica", () => {
    expect(withoutDiseaseOptions(DENTAL_WITHOUT_DISEASE, base)).toEqual([
      { key: "chequeo", label: "Chequeo", code: "Z01.2" },
      { key: "sin-hallazgos", label: "Sin hallazgos", code: "Z71.1" },
    ])
  })

  it("el control, la prótesis y la ortodoncia salen solo si le corresponden", () => {
    expect(keys(withoutDiseaseOptions(DENTAL_WITHOUT_DISEASE, { ...base, treated: true }))).toEqual([
      "chequeo",
      "sin-hallazgos",
      "control",
    ])
    expect(
      keys(withoutDiseaseOptions(DENTAL_WITHOUT_DISEASE, { ...base, treated: true, protesis: true, ortodoncia: true })),
    ).toEqual(["chequeo", "sin-hallazgos", "control", "protesis", "ortodoncia"])
  })

  it("con la CIE-11, sus códigos: QA00.8, QA1C, QA07.Y, QB31.3 y QB31.2", () => {
    const all = withoutDiseaseOptions(DENTAL_WITHOUT_DISEASE, {
      ...base,
      system: "ICD-11",
      treated: true,
      protesis: true,
      ortodoncia: true,
    })
    expect(all.map((option) => option.code)).toEqual(["QA00.8", "QA1C", "QA07.Y", "QB31.3", "QB31.2"])
  })

  it("latidIA elige por la edad: el examen del adulto o el control del niño (no el del adulto en un niño)", () => {
    expect(withoutDiseaseOptions(MEDICAL_WITHOUT_DISEASE, { ...base, ageYears: 6 })[0]).toEqual({
      key: "chequeo-nino",
      label: "Control de salud del niño",
      code: "Z00.1",
    })
    expect(withoutDiseaseOptions(MEDICAL_WITHOUT_DISEASE, { ...base, ageYears: 18 })[0]?.code).toBe("Z00.0")
    expect(withoutDiseaseOptions(MEDICAL_WITHOUT_DISEASE, { ...base, system: "ICD-11", ageYears: 6 })[0]?.code).toBe(
      "QA00.1",
    )
    // Sin fecha de nacimiento, el de adultos.
    expect(withoutDiseaseOptions(MEDICAL_WITHOUT_DISEASE, { ...base, ageYears: null })[0]?.code).toBe("Z00.0")
  })

  it("lo registrado con uno de estos códigos se reconoce, en su lista", () => {
    expect(isWithoutDiseaseCode(DENTAL_WITHOUT_DISEASE, "ICD-10", "Z01.2")).toBe(true)
    expect(isWithoutDiseaseCode(DENTAL_WITHOUT_DISEASE, "ICD-11", "QA00.8")).toBe(true)
    expect(isWithoutDiseaseCode(DENTAL_WITHOUT_DISEASE, "ICD-11", "Z01.2")).toBe(false)
    expect(isWithoutDiseaseCode(DENTAL_WITHOUT_DISEASE, "ICD-10", "K02.1")).toBe(false)
  })
})
