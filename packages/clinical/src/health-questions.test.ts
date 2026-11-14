import { describe, expect, it } from "vitest"
import { declaredMedicineAtc, HABITUAL_MEDICATIONS, MEDICATION_CLASSES, medicationClassOf } from "./allergens.js"
import {
  ageInYears,
  DEFAULT_REGISTRATION_CONFIG,
  declaredHealthAnswered,
  isChildAge,
  newRegistrationQuestions,
  OPTIONAL_ONLY_REGISTRATION_FIELDS,
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
    ] as const)
      expect(DEFAULT_REGISTRATION_CONFIG.fields[key]).toBe("optional")
    // Lo que ya era opcional o no se pedía sigue igual.
    expect(DEFAULT_REGISTRATION_CONFIG.fields.medications).toBe("optional")
    expect(DEFAULT_REGISTRATION_CONFIG.fields["medical.alcohol"]).toBe("hidden")
  })

  it("a quien administra una clínica que ya existía se le dicen las preguntas nuevas de su producto", () => {
    expect(newRegistrationQuestions(1, "dental").map((item) => item.key)).toEqual([
      "dental.corazon",
      "dental.problemaAnestesia",
      "anticoagulants",
      "boneMedicines",
      "medical.lactancia",
      "medical.tabaco",
      "dental.biberon",
      "dental.chupon",
      "dental.dulcesEntreComidas",
      "dental.pastaConFluor",
      "dental.quienCepilla",
      "visit.reason",
      "visit.pain",
      "visit.more",
    ])
    // Quien ya vio las de la entrega 6 ve solo las de un niño, y solo en odentIA, y las de antes de cada cita.
    expect(newRegistrationQuestions(2, "dental").map((item) => item.key)).toEqual([
      "dental.biberon",
      "dental.chupon",
      "dental.dulcesEntreComidas",
      "dental.pastaConFluor",
      "dental.quienCepilla",
      "visit.reason",
      "visit.pain",
      "visit.more",
    ])
    // Lo de antes de cada cita es de los tres productos.
    const visit = ["visit.reason", "visit.pain", "visit.more"]
    expect(newRegistrationQuestions(2, "medical").map((item) => item.key)).toEqual(visit)
    // latidIA ya preguntaba la lactancia y el tabaco: para ella son nuevas solo las dos medicinas.
    expect(newRegistrationQuestions(1, "medical").map((item) => item.key)).toEqual(["anticoagulants", "boneMedicines", ...visit])
    expect(newRegistrationQuestions(1, "optical").map((item) => item.key)).toEqual(["anticoagulants", "boneMedicines", ...visit])
    expect(newRegistrationQuestions(REGISTRATION_QUESTIONS_VERSION, "dental")).toEqual([])
  })

  it("lo dental queda en odentIA; la lactancia y el tabaco, en odentIA y latidIA; nada de eso en vistIA", () => {
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
    ])
    expect(asked("medical")).toEqual(["anticoagulants", "boneMedicines", "medical.lactancia", "medical.tabaco", "medical.alcohol"])
    expect(asked("optical")).toEqual(["anticoagulants", "boneMedicines"])
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

describe("lo de un niño, para quien lo cuida (menores de 12)", () => {
  const thiago: RegistrationAnswers = {
    demographics: { displayName: "Thiago Quispe", birthDate: "2020-05-10", sex: "M" },
    respondent: "representative",
    representative: {
      displayName: "Carla Ramos",
      relationship: "guardian",
      relationshipDetail: "Madre, padre o tutor",
      phone: "+51999999999",
      docType: "DNI",
      docNumber: "45678912",
    },
    privacyAccepted: true,
    health: {
      allergies: { state: "none", items: [] },
      conditions: { state: "recorded", items: [{ name: "Asma" }] },
      medications: { state: "unanswered", items: [] },
      dental: { biberon: "ya_no", chupon: "dedo", dulcesEntreComidas: "4_o_mas", pastaConFluor: "si", quienCepilla: "solo" },
    },
  }

  it("un niño es quien no ha cumplido 12; sin la edad no se supone", () => {
    expect(isChildAge(6)).toBe(true)
    expect(isChildAge(11)).toBe(true)
    expect(isChildAge(12)).toBe(false)
    expect(isChildAge(null)).toBe(false)
    expect(isChildAge(undefined)).toBe(false)
  })

  it("al niño no se le pregunta embarazo, lactancia, tabaco ni alcohol; al adulto, sí", () => {
    for (const key of ["personal.embarazo", "medical.lactancia", "medical.tabaco", "medical.alcohol"] as const) {
      expect(registrationFieldApplies(key, { sex: "F", age: 6 })).toBe(false)
      expect(registrationFieldApplies(key, { sex: null, age: 11 })).toBe(false)
      expect(registrationFieldApplies(key, { sex: "F", age: 30 })).toBe(true)
    }
    // De 12 a 17 sigue como hasta hoy (fuera de esta entrega).
    expect(registrationFieldApplies("medical.tabaco", { sex: "M", age: 15 })).toBe(true)
  })

  it("biberón y chupón, solo hasta los 6 años: a un niño de 8 no se le preguntan", () => {
    expect(registrationFieldApplies("dental.biberon", { sex: "M", age: 6 })).toBe(true)
    expect(registrationFieldApplies("dental.chupon", { sex: "M", age: 6 })).toBe(true)
    expect(registrationFieldApplies("dental.biberon", { sex: "M", age: 8 })).toBe(false)
    expect(registrationFieldApplies("dental.chupon", { sex: "F", age: 8 })).toBe(false)
    // Dulces, flúor y quién le cepilla, a todo menor de 12.
    expect(registrationFieldApplies("dental.dulcesEntreComidas", { sex: "M", age: 8 })).toBe(true)
    expect(registrationFieldApplies("dental.pastaConFluor", { sex: "M", age: 11 })).toBe(true)
    expect(registrationFieldApplies("dental.quienCepilla", { sex: "M", age: 8 })).toBe(true)
    // A un adulto, o sin la edad, «de pequeño» no se pregunta.
    expect(registrationFieldApplies("dental.quienCepilla", { sex: "F", age: 30 })).toBe(false)
    expect(registrationFieldApplies("dental.dulcesEntreComidas", { sex: null, age: null })).toBe(false)
  })

  it("«de pequeño» nace en «Opcional», es solo de odentIA y nunca es obligatorio", () => {
    expect(DEFAULT_REGISTRATION_CONFIG.fields["dental.quienCepilla"]).toBe("optional")
    expect(registrationFieldAsked(config, "dental.biberon", "PE", "dental")).toBe(true)
    expect(registrationFieldAsked(config, "dental.biberon", "PE", "medical")).toBe(false)
    expect(registrationFieldAsked(config, "dental.biberon", "PE", "optical")).toBe(false)
    expect(OPTIONAL_ONLY_REGISTRATION_FIELDS).toContain("dental.pastaConFluor")
  })

  it("C3 · Carla registra a Thiago, 6 años: lo de un niño se acepta y lo de un adulto no", () => {
    expect(validateRegistrationAnswers(config, thiago, publicContext)).toEqual({})
    const withAdult = { ...thiago, health: { ...thiago.health, medical: { tabaco: "nunca" as const } } }
    expect(validateRegistrationAnswers(config, withAdult, publicContext)).toHaveProperty("health.medical.tabaco")
    // A los 8 años, el biberón ya no se pregunta y no se acepta.
    const eight = { ...thiago, demographics: { ...thiago.demographics, birthDate: "2018-05-10" } }
    expect(validateRegistrationAnswers(config, eight, publicContext)).toHaveProperty("health.dental.biberon")
    // A un adulto no se le acepta «de pequeño».
    expect(
      validateRegistrationAnswers(config, withHealth({ dental: { quienCepilla: "solo" } }), publicContext),
    ).toHaveProperty("health.dental.quienCepilla")
    expect(
      registrationAnswersSchema.safeParse({ ...thiago, health: { dental: { dulcesEntreComidas: "mucho" } } }).success,
    ).toBe(false)
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
