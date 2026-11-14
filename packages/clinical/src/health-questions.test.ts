import { describe, expect, it } from "vitest"
import { declaredMedicineAtc, HABITUAL_MEDICATIONS, MEDICATION_CLASSES, medicationClassOf } from "./allergens.js"
import {
  ageInYears,
  DEFAULT_REGISTRATION_CONFIG,
  declaredHealthAnswered,
  newRegistrationQuestions,
  REGISTRATION_QUESTIONS_VERSION,
  type RegistrationAnswers,
  registrationAnswersSchema,
  registrationFieldApplies,
  registrationFieldAsked,
  validateRegistrationAnswers,
} from "./patient-registration.js"

// Los datos de salud que sumó la mesa del 13 nov (entrega 6): qué se pregunta, a quién y en qué producto.
const config = { ...DEFAULT_REGISTRATION_CONFIG, enabled: true, privacyNotice: "Aviso de demostración" }
const adult: RegistrationAnswers = {
  demographics: { displayName: "Marta Ríos", birthDate: "1960-03-12", phone: "+51999999999" },
  respondent: "patient",
  privacyAccepted: true,
  health: {
    allergies: { state: "unanswered", items: [] },
    conditions: { state: "unknown", items: [] },
    medications: { state: "none", items: [] },
  },
}
const publicContext = { mode: "public", today: "2026-11-13", countryCode: "PE" } as const
const withHealth = (overrides: Partial<NonNullable<RegistrationAnswers["health"]>>): RegistrationAnswers => ({
  ...adult,
  health: { ...adult.health, ...overrides },
})

describe("los datos de salud nuevos", () => {
  it("nacen en «Opcional»: una clínica nueva los trae encendidos y una que ya existía los recibe igual", () => {
    for (const key of [
      "anticoagulants",
      "boneMedicines",
      "dental.corazon",
      "dental.problemaAnestesia",
      "medical.lactancia",
      "medical.tabaco",
      // QA del 14 nov (C4): el alcohol, también en «Opcional».
      "medical.alcohol",
    ] as const)
      expect(DEFAULT_REGISTRATION_CONFIG.fields[key]).toBe("optional")
    // Lo que ya era opcional sigue igual.
    expect(DEFAULT_REGISTRATION_CONFIG.fields.medications).toBe("optional")
  })

  it("a quien administra una clínica que ya existía se le dicen las preguntas nuevas de su producto", () => {
    expect(newRegistrationQuestions(1, "dental").map((item) => item.key)).toEqual([
      "dental.corazon",
      "dental.problemaAnestesia",
      "anticoagulants",
      "boneMedicines",
      "medical.lactancia",
      "medical.tabaco",
      "medical.alcohol",
    ])
    // latidIA ya preguntaba la lactancia, el tabaco y el alcohol: para ella son nuevas solo las dos
    // medicinas. vistIA no las pregunta (C5).
    expect(newRegistrationQuestions(1, "medical").map((item) => item.key)).toEqual(["anticoagulants", "boneMedicines"])
    expect(newRegistrationQuestions(1, "optical").map((item) => item.key)).toEqual([])
    expect(newRegistrationQuestions(REGISTRATION_QUESTIONS_VERSION, "dental")).toEqual([])
  })

  it("lo dental queda en odentIA; las medicinas, la lactancia, el tabaco y el alcohol, en odentIA y latidIA; nada de eso en vistIA", () => {
    const fields = Object.fromEntries(
      Object.keys(config.fields).map((key) => [
        key,
        key === "displayName" || key === "birthDate" || key === "phone" ? "required" : "optional",
      ]),
    ) as typeof config.fields
    const asked = (product: "dental" | "medical" | "optical") =>
      (
        [
          "dental.corazon",
          "dental.problemaAnestesia",
          "anticoagulants",
          "boneMedicines",
          "medical.lactancia",
          "medical.tabaco",
          "medical.alcohol",
        ] as const
      ).filter((key) => registrationFieldAsked({ fields }, key, "PE", product))
    expect(asked("dental")).toEqual([
      "dental.corazon",
      "dental.problemaAnestesia",
      "anticoagulants",
      "boneMedicines",
      "medical.lactancia",
      "medical.tabaco",
      "medical.alcohol",
    ])
    expect(asked("medical")).toEqual(["anticoagulants", "boneMedicines", "medical.lactancia", "medical.tabaco", "medical.alcohol"])
    expect(asked("optical")).toEqual([])
  })

  it("«Tus medicinas»: Sí con cuál, No o No sé; «cuál» solo con el Sí", () => {
    const ok = withHealth({
      anticoagulants: { state: "recorded", detail: "warfarina 5 mg" },
      boneMedicines: { state: "none" },
      medications: { state: "unknown", items: [] },
    })
    expect(validateRegistrationAnswers(config, ok, publicContext)).toEqual({})
    expect(
      registrationAnswersSchema.safeParse(withHealth({ anticoagulants: { state: "none", detail: "warfarina" } })).success,
    ).toBe(false)
    // Sin decir cuál también vale: la marca sale de la respuesta, no del nombre.
    expect(validateRegistrationAnswers(config, withHealth({ anticoagulants: { state: "recorded" } }), publicContext)).toEqual({})
  })

  it("lo «Obligatorio» se le exige solo a quien llena el formulario, y lo que la clínica no pregunta no se acepta", () => {
    const required = {
      ...config,
      fields: { ...config.fields, anticoagulants: "required" as const, "dental.corazon": "required" as const },
    }
    expect(validateRegistrationAnswers(required, adult, publicContext)).toMatchObject({
      "health.anticoagulants": "Este dato es obligatorio",
      "health.dental.corazon": "Este dato es obligatorio",
    })
    expect(
      validateRegistrationAnswers(required, withHealth({ anticoagulants: { state: "unanswered" } }), publicContext),
    ).toHaveProperty("health.anticoagulants")
    const answered = withHealth({
      anticoagulants: { state: "none" },
      dental: { corazon: { riesgoEndocarditis: "no", antibioticoPrevio: "no_sabe" } },
    })
    expect(validateRegistrationAnswers(required, answered, publicContext)).toEqual({})
    // Recepción registra sin nada de eso: ninguna pregunta de salud impide el alta.
    expect(
      validateRegistrationAnswers(
        { ...required, version: 1 },
        {
          demographics: { displayName: "Ana Ruiz", birthDate: "1990-01-01", phone: "+51999999999" },
          respondent: "staff",
          privacyAccepted: false,
        },
        { ...publicContext, mode: "internal" },
      ),
    ).toEqual({})
    const hidden = {
      ...config,
      fields: { ...config.fields, boneMedicines: "hidden" as const, "dental.problemaAnestesia": "hidden" as const },
    }
    expect(validateRegistrationAnswers(hidden, withHealth({ boneMedicines: { state: "none" } }), publicContext)).toHaveProperty(
      "health.boneMedicines",
    )
    expect(
      validateRegistrationAnswers(hidden, withHealth({ dental: { problemaAnestesia: "no" } }), publicContext),
    ).toHaveProperty("health.dental.problemaAnestesia")
    // En latidIA, el corazón «antes del dentista» no se pregunta.
    expect(
      validateRegistrationAnswers(config, withHealth({ dental: { corazon: { riesgoEndocarditis: "no" } } }), {
        ...publicContext,
        product: "medical",
      }),
    ).toHaveProperty("health.dental.corazon")
  })

  it("cuántos cigarrillos se dice solo de quien fuma", () => {
    const parses = (medical: NonNullable<NonNullable<RegistrationAnswers["health"]>["medical"]>) =>
      registrationAnswersSchema.safeParse(withHealth({ medical })).success
    expect(parses({ tabaco: "fuma", cigarrillos: "10_o_mas" })).toBe(true)
    expect(parses({ tabaco: "fuma" })).toBe(true)
    expect(parses({ tabaco: "dejo", cigarrillos: "menos_10" })).toBe(false)
    expect(parses({ cigarrillos: "menos_10" })).toBe(false)
  })

  it("el embarazo y la lactancia se preguntan solo a mujeres de 12 a 55 años; sin el dato, no se supone", () => {
    expect(registrationFieldApplies("medical.lactancia", { sex: "F", age: 30 })).toBe(true)
    expect(registrationFieldApplies("medical.lactancia", { sex: "M", age: 30 })).toBe(false)
    expect(registrationFieldApplies("personal.embarazo", { sex: "F", age: 66 })).toBe(false)
    expect(registrationFieldApplies("personal.embarazo", { sex: "F", age: 11 })).toBe(false)
    expect(registrationFieldApplies("personal.embarazo", { sex: null, age: null })).toBe(true)
    expect(registrationFieldApplies("anticoagulants", { sex: "M", age: 8 })).toBe(true)
    expect(ageInYears("1960-11-14", "2026-11-13")).toBe(65)
    expect(ageInYears("1960-11-13", "2026-11-13")).toBe(66)
    expect(ageInYears("sin fecha", "2026-11-13")).toBeNull()
  })

  it("decir solo que no toma anticoagulantes ya es una declaración", () => {
    expect(declaredHealthAnswered(undefined)).toBe(false)
    expect(declaredHealthAnswered({ allergies: { state: "unanswered", items: [] } })).toBe(false)
    expect(declaredHealthAnswered({ anticoagulants: { state: "none" } })).toBe(true)
    expect(declaredHealthAnswered({ dental: { problemaAnestesia: "no" } })).toBe(true)
    expect(declaredHealthAnswered({ medical: { tabaco: "nunca" } })).toBe(true)
  })
})

describe("las marcas «Anticoagulante» y «Huesos» salen del grupo ATC, no del nombre escrito", () => {
  it("un código es de su clase si empieza por el del grupo (B01A, M05B)", () => {
    expect(MEDICATION_CLASSES.anticoagulants.atc).toBe("B01A")
    expect(MEDICATION_CLASSES.boneMedicines.atc).toBe("M05B")
    expect(medicationClassOf("B01AA03")).toBe("anticoagulants")
    expect(medicationClassOf("B01A")).toBe("anticoagulants")
    expect(medicationClassOf("M05BA04")).toBe("boneMedicines")
    expect(medicationClassOf("N02BE01")).toBeNull()
    expect(medicationClassOf(null)).toBeNull()
  })

  it("lo dicho al responder «Sí» lleva el código de su medicamento si es de la lista y de esa clase; si no, el del grupo", () => {
    expect(declaredMedicineAtc("anticoagulants", "Warfarina")).toBe("B01AA03")
    expect(declaredMedicineAtc("anticoagulants", "warfarina 5 mg")).toBe("B01A")
    expect(declaredMedicineAtc("anticoagulants", "Sintrom")).toBe("B01A")
    expect(declaredMedicineAtc("anticoagulants", "")).toBe("B01A")
    expect(declaredMedicineAtc("boneMedicines", "ácido alendrónico")).toBe("M05BA04")
    expect(declaredMedicineAtc("boneMedicines", "alendronato 70 mg semanal")).toBe("M05B")
    // Un medicamento de otra clase escrito en esta pregunta no cambia la respuesta: sigue siendo de la clase.
    expect(declaredMedicineAtc("boneMedicines", "warfarina")).toBe("M05B")
    // Los de la lista habitual quedan cada uno en su clase.
    const inClass = (group: "anticoagulants" | "boneMedicines") =>
      HABITUAL_MEDICATIONS.filter((entry) => medicationClassOf(entry.atc) === group).map((entry) => entry.dci)
    expect(inClass("anticoagulants")).toEqual(
      expect.arrayContaining(["warfarina", "acenocumarol", "clopidogrel", "rivaroxabán", "apixabán"]),
    )
    expect(inClass("boneMedicines")).toEqual(["ácido alendrónico", "ácido zoledrónico", "denosumab"])
  })
})
