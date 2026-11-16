import { describe, expect, it } from "vitest"
import {
  isCardiacCondition,
  LOCAL_ANESTHETICS,
  localAnesthesiaWords,
  localAnestheticOf,
  maxLocalAnestheticDose,
} from "./local-anesthesia.js"
import { bloodPressureAlert } from "./vitals.js"

describe("la dosis máxima por peso (QA del 16 nov, B5)", () => {
  it("Mateo, 22 kg, con lidocaína: 96,8 mg, unos 2,7 cartuchos", () => {
    expect(
      localAnesthesiaWords({
        weightKg: 22,
        anesthetic: "lidocaina-2-epinefrina",
        ageYears: 7,
        cardiac: false,
      }),
    ).toEqual({
      dose: "Máximo para 22 kg con lidocaína 2 % con epinefrina (cartucho de 1,8 mL): 96,8 mg, unos 2,7 cartuchos",
      warnings: [],
    })
  })

  it("con mepivacaína al 3 %, el mismo niño son 1,8 cartuchos, no 2,7", () => {
    expect(maxLocalAnestheticDose(22, localAnestheticOf("mepivacaina-3")!)).toEqual({
      mg: 96.8,
      cartridges: 1.8,
      capped: false,
    })
  })

  it("articaína 7 mg/kg y prilocaína 6 mg/kg", () => {
    expect(maxLocalAnestheticDose(22, localAnestheticOf("articaina-4-epinefrina")!)).toMatchObject({
      mg: 154,
      cartridges: 2.1,
    })
    expect(maxLocalAnestheticDose(22, localAnestheticOf("prilocaina-4")!)).toMatchObject({
      mg: 132,
      cartridges: 1.8,
    })
  })

  it("en un adulto llega al tope y lo dice", () => {
    const words = localAnesthesiaWords({
      weightKg: 80,
      anesthetic: "lidocaina-2-epinefrina",
      ageYears: 40,
      cardiac: false,
    })
    expect(words.dose).toBe(
      "Máximo para 80 kg con lidocaína 2 % con epinefrina (cartucho de 1,8 mL): 300 mg (el tope), unos 8,3 cartuchos",
    )
  })

  it("un niño de 3 años con articaína: avisa y se puede seguir", () => {
    const words = localAnesthesiaWords({
      weightKg: 15,
      anesthetic: "articaina-4-epinefrina",
      ageYears: 3,
      cardiac: false,
    })
    expect(words.warnings).toEqual(["La articaína no se recomienda en menores de 4 años."])
    expect(words.dose).toContain("105 mg")
  })

  it("sin peso no inventa un máximo", () => {
    expect(
      localAnesthesiaWords({
        weightKg: null,
        anesthetic: "lidocaina-2-epinefrina",
        ageYears: 45,
        cardiac: false,
      }),
    ).toEqual({
      dose: null,
      warnings: [],
    })
  })

  it("en un cardiópata avisa el tope de epinefrina, y sin vasoconstrictor no", () => {
    expect(
      localAnesthesiaWords({
        weightKg: 70,
        anesthetic: "lidocaina-2-epinefrina",
        ageYears: 60,
        cardiac: true,
      }).warnings,
    ).toEqual([
      "Con su corazón, la epinefrina hasta 0,04 mg por sesión: unos 2,2 cartuchos de este anestésico.",
    ])
    expect(
      localAnesthesiaWords({
        weightKg: 70,
        anesthetic: "mepivacaina-3",
        ageYears: 60,
        cardiac: true,
      }).warnings,
    ).toEqual([])
  })

  it("cada anestésico tiene su tope y su dosis por kilo", () => {
    for (const anesthetic of LOCAL_ANESTHETICS) {
      expect(anesthetic.mgPerKg).toBeGreaterThan(0)
      expect(anesthetic.maxMg).toBeGreaterThan(0)
    }
  })

  it("la cardiopatía se reconoce por su código", () => {
    expect(isCardiacCondition("ICD-10", "I10")).toBe(true)
    expect(isCardiacCondition("ICD-10", "I50.0")).toBe(true)
    expect(isCardiacCondition("ICD-10", "I63.9")).toBe(false)
    expect(isCardiacCondition("ICD-10", "E11")).toBe(false)
    expect(isCardiacCondition("ICD-11", "BA00")).toBe(true)
    expect(isCardiacCondition(null, null)).toBe(false)
  })
})

describe("la presión alta avisa sin trabar (QA del 16 nov, B4)", () => {
  it("Gloria, 62 años, 185/115: repite la toma, lo electivo se suele diferir y con síntomas es urgencia", () => {
    expect(bloodPressureAlert({ presionSistolica: 185, presionDiastolica: 115 }, 62)).toBe(
      "Aviso: 185/115 mmHg. Repite la toma. Con 180/110 o más, lo electivo se suele diferir. Con dolor de pecho, dolor de cabeza fuerte o falta de aire, es una urgencia.",
    )
  })

  it("una sola de las dos alta basta", () => {
    expect(bloodPressureAlert({ presionSistolica: 182, presionDiastolica: 90 }, 50)).not.toBeNull()
    expect(bloodPressureAlert({ presionSistolica: 150, presionDiastolica: 112 }, 50)).not.toBeNull()
  })

  it("repite la toma y da 150/95: el aviso se va", () => {
    expect(bloodPressureAlert({ presionSistolica: 150, presionDiastolica: 95 }, 62)).toBeNull()
  })

  it("desde los 13 años; un niño de 9 no lleva el aviso del adulto", () => {
    expect(bloodPressureAlert({ presionSistolica: 185, presionDiastolica: 115 }, 9)).toBeNull()
    expect(bloodPressureAlert({ presionSistolica: 125, presionDiastolica: 80 }, 9)).toBeNull()
    expect(bloodPressureAlert({ presionSistolica: 185, presionDiastolica: 115 }, 13)).not.toBeNull()
  })

  it("sin la presión completa no dice nada; sin la edad avisa", () => {
    expect(bloodPressureAlert({ presionSistolica: 185 }, 62)).toBeNull()
    expect(bloodPressureAlert(null, 62)).toBeNull()
    expect(
      bloodPressureAlert({ presionSistolica: 185, presionDiastolica: 115 }, null),
    ).not.toBeNull()
  })
})
