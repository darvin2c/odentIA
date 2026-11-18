import { describe, expect, it } from "vitest"
import {
  type AnesthesiaCondition,
  epinephrineCheckOf,
  isCardiacCondition,
  isHypertension,
  LOCAL_ANESTHETICS,
  localAnesthesiaWords,
  localAnestheticOf,
  maxLocalAnestheticDose,
} from "./local-anesthesia.js"
import { bloodPressureAlert } from "./vitals.js"

describe("la dosis máxima por peso (QA del 16 nov, B5)", () => {
  it("Mateo, 22 kg, con lidocaína: 96,8 mg, unos 2,6 cartuchos", () => {
    expect(
      localAnesthesiaWords({
        weightKg: 22,
        anesthetic: "lidocaina-2-epinefrina",
        ageYears: 7,
        epinephrine: null,
      }),
    ).toEqual({
      dose: "Máximo para 22 kg con lidocaína 2 % con epinefrina (cartucho de 1,8 mL): 96,8 mg, unos 2,6 cartuchos",
      warnings: [],
    })
  })

  it("con mepivacaína al 3 %, el mismo niño son 1,7 cartuchos, no 2,6", () => {
    expect(maxLocalAnestheticDose(22, localAnestheticOf("mepivacaina-3")!)).toEqual({
      mg: 96.8,
      cartridges: 1.7,
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

  it("el máximo se redondea hacia abajo y no pasa el tope: 15 kg con articaína son 1,4 cartuchos, no 1,5 (R11)", () => {
    expect(maxLocalAnestheticDose(15, localAnestheticOf("articaina-4-epinefrina")!)).toMatchObject({ mg: 105, cartridges: 1.4 })
  })

  it("en un adulto llega al tope y lo dice", () => {
    const words = localAnesthesiaWords({
      weightKg: 80,
      anesthetic: "lidocaina-2-epinefrina",
      ageYears: 40,
      epinephrine: null,
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
      epinephrine: null,
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
        epinephrine: null,
      }),
    ).toEqual({
      dose: null,
      warnings: [],
    })
  })

  const check = (input: {
    conditions?: AnesthesiaCondition[]
    asaClass?: string | null
    vitals?: { presionSistolica: number; presionDiastolica: number } | null
    ageYears?: number | null
  }) =>
    epinephrineCheckOf({
      conditions: input.conditions ?? [],
      asaClass: input.asaClass ?? null,
      vitals: input.vitals ?? null,
      ageYears: input.ageYears ?? 60,
    })
  const warn = (epinephrine: ReturnType<typeof epinephrineCheckOf> | null, anesthetic = "lidocaina-2-epinefrina") =>
    localAnesthesiaWords({ weightKg: 70, anesthetic, ageYears: 60, epinephrine }).warnings
  const hta = { name: "Hipertensión esencial", diagnosisSystem: "ICD-10", diagnosisCode: "I10" }
  const fa = { name: "Fibrilación auricular", diagnosisSystem: "ICD-10", diagnosisCode: "I48" }
  const cap = (why: string) =>
    `Por ${why}, la epinefrina hasta 0,04 mg por sesión: unos 2,2 cartuchos de este anestésico.`

  it("en un cardiópata avisa el tope de epinefrina, y sin vasoconstrictor no", () => {
    const epinephrine = check({ conditions: [fa], asaClass: "II" })
    expect(warn(epinephrine)).toEqual([cap("su fibrilación auricular (I48)")])
    expect(warn(epinephrine, "mepivacaina-3")).toEqual([])
  })

  // QA del 16 nov, Q10 (Gloria): ASA III puesta por el odontólogo y ninguna enfermedad registrada.
  // El aviso decía «Con su corazón…»: un motivo que la ficha no tiene.
  it("el tope de epinefrina dice su motivo verdadero: la ASA, la enfermedad, la presión o varias", () => {
    expect(warn(check({ asaClass: "III" }))).toEqual([cap("su ASA III")])
    expect(warn(check({ conditions: [fa], asaClass: "IV" }))).toEqual([cap("su ASA IV y su fibrilación auricular (I48)")])
    expect(
      warn(check({ conditions: [fa, hta], asaClass: "III", vitals: { presionSistolica: 165, presionDiastolica: 100 } })),
    ).toEqual([cap("su ASA III, su fibrilación auricular (I48) y la presión de hoy (165/100)")])
    // Sin nada de eso: no hay tope que avisar.
    expect(check({ asaClass: "II" }).cap).toBeNull()
    expect(check({}).cap).toBeNull()
    expect(warn(null)).toEqual([])
  })

  // Reglas clínicas del 18 nov, caso C2 (Rodrigo): la hipertensión controlada no limita la epinefrina.
  it("la hipertensión con ASA II y la presión de hoy controlada no lleva tope", () => {
    const today = check({ conditions: [hta], asaClass: "II", vitals: { presionSistolica: 130, presionDiastolica: 85 } })
    expect(today).toEqual({ cap: null, takePressure: null })
    expect(warn(today)).toEqual([])
  })

  it("la presión de hoy de 160/95 o más lleva el tope, y lo dice", () => {
    expect(warn(check({ conditions: [hta], asaClass: "II", vitals: { presionSistolica: 165, presionDiastolica: 100 } }))).toEqual([
      cap("la presión de hoy (165/100)"),
    ])
    // Basta la diastólica (150/95), y también sin hipertensión registrada.
    expect(check({ vitals: { presionSistolica: 150, presionDiastolica: 95 } }).cap).toEqual({
      conditions: [],
      asaClass: null,
      pressure: "150/95",
    })
    expect(check({ vitals: { presionSistolica: 159, presionDiastolica: 94 } }).cap).toBeNull()
    // En un niño de 10 años la presión del adulto no vale.
    expect(check({ vitals: { presionSistolica: 165, presionDiastolica: 100 }, ageYears: 10 }).cap).toBeNull()
  })

  it("la fibrilación auricular (I48) lleva el tope aun con ASA II; escrita sin código, no", () => {
    expect(check({ conditions: [fa], asaClass: "II" }).cap).toEqual({
      conditions: ["fibrilación auricular (I48)"],
      asaClass: null,
      pressure: null,
    })
    expect(check({ conditions: [{ name: "Fibrilación auricular" }], asaClass: "II" }).cap).toBeNull()
  })

  it("la hipertensión sin la presión de hoy pide tomarla antes de anestesiar, sin tope", () => {
    const today = check({ conditions: [hta], asaClass: "II" })
    expect(today).toEqual({ cap: null, takePressure: "hipertensión esencial (I10)" })
    expect(warn(today)).toEqual(["Con su hipertensión esencial (I10), toma la presión antes de anestesiar."])
    // Con cualquier anestésico: no es por la epinefrina sola.
    expect(warn(today, "mepivacaina-3")).toEqual(["Con su hipertensión esencial (I10), toma la presión antes de anestesiar."])
  })

  // latidIA no pide la ASA: llega nula, y vale lo demás.
  it("sin ASA (latidIA), la hipertensión sola no lleva tope y la cardiopatía sí", () => {
    expect(check({ conditions: [hta], vitals: { presionSistolica: 128, presionDiastolica: 80 } }).cap).toBeNull()
    expect(check({ conditions: [{ name: "Insuficiencia cardiaca", diagnosisSystem: "ICD-10", diagnosisCode: "I50.0" }] }).cap?.conditions).toEqual([
      "insuficiencia cardiaca (I50.0)",
    ])
  })

  // Revisión de las reglas clínicas del 18 nov: la cardiopatía hipertensiva con insuficiencia
  // cardiaca no es «hipertensión»; lleva el tope, aunque la ASA sea II y la presión de hoy esté bien.
  it("la cardiopatía hipertensiva con insuficiencia cardiaca lleva tope; la hipertensión sin ella, no", () => {
    const vitals = { presionSistolica: 128, presionDiastolica: 80 }
    const capOf = (diagnosisCode: string, diagnosisSystem = "ICD-10") =>
      check({ conditions: [{ name: "Cardiopatía", diagnosisSystem, diagnosisCode }], asaClass: "II", vitals }).cap
    for (const code of ["I11.0", "I13.0", "I13.2"]) expect(capOf(code)?.conditions).toEqual([`cardiopatía (${code})`])
    for (const code of ["I10", "I11.9", "I12.0", "I12.9", "I13.1", "I15.0", "I15.9"]) expect(capOf(code)).toBeNull()
    expect(capOf("BA00", "ICD-11")).toBeNull()
    expect(capOf("BA01", "ICD-11")?.conditions).toEqual(["cardiopatía (BA01)"])
    // Sigue pidiendo tomar la presión si no se tomó hoy.
    expect(check({ conditions: [{ name: "Cardiopatía hipertensiva", diagnosisSystem: "ICD-10", diagnosisCode: "I11.0" }], asaClass: "II" }).takePressure).toBe(
      "cardiopatía hipertensiva (I11.0)",
    )
  })

  it("cada anestésico tiene su tope y su dosis por kilo", () => {
    for (const anesthetic of LOCAL_ANESTHETICS) {
      expect(anesthetic.mgPerKg).toBeGreaterThan(0)
      expect(anesthetic.maxMg).toBeGreaterThan(0)
    }
  })

  it("la hipertensión se reconoce por su código, aparte de la cardiopatía", () => {
    expect(isHypertension("ICD-10", "I10")).toBe(true)
    expect(isHypertension("ICD-10", "I15.0")).toBe(true)
    expect(isHypertension("ICD-10", "I48")).toBe(false)
    expect(isHypertension("ICD-11", "BA00")).toBe(true)
    expect(isHypertension("ICD-11", "BC81")).toBe(false)
    expect(isHypertension(null, null)).toBe(false)
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
