import { findHabitualMedication } from "./allergens.js"
import { describe, expect, it } from "vitest"
import {
  allergiesSaidUnknownOf,
  healthQuestionsToAsk,
  type KnownHealthInput,
  knownHealthQuestions,
  medicationAlertWords,
  medicineClassAnswers,
  onlyAskedHealth,
} from "./health-asked.js"
import { DEFAULT_REGISTRATION_CONFIG, registrationFieldApplies } from "./patient-registration.js"

const nothing: KnownHealthInput = {
  bloodGroup: null,
  reviewStatus: { allergies: "unknown", conditions: "unknown", medications: "unknown" },
  activeAllergies: 0,
  medications: [],
  interview: null,
  declarations: [],
}
const dental = { countryCode: "PE", product: "dental" as const, person: { sex: "F", age: 40 } }

describe("se pregunta solo lo que falta, dato por dato", () => {
  it("una paciente con un antecedente anotado por el equipo: se le pregunta lo demás, no eso", () => {
    const known = knownHealthQuestions({
      ...nothing,
      reviewStatus: { allergies: "recorded", conditions: "unknown", medications: "unknown" },
      activeAllergies: 1,
    })
    const ask = healthQuestionsToAsk(DEFAULT_REGISTRATION_CONFIG, dental, known)
    expect(ask).not.toContain("allergies")
    expect(ask).toEqual(
      expect.arrayContaining(["conditions", "medications", "anticoagulants", "boneMedicines", "dental.corazon", "medical.lactancia"]),
    )
  })

  it("lo que respondió en una declaración, también un «No sé», ya no se le vuelve a preguntar", () => {
    const known = knownHealthQuestions({
      ...nothing,
      declarations: [
        {
          health: {
            anticoagulants: { state: "unknown" },
            boneMedicines: { state: "unanswered" },
            dental: { problemaAnestesia: "no" },
            medical: { tabaco: "nunca" },
          },
        },
      ],
    })
    expect(known.has("anticoagulants")).toBe(true)
    expect(known.has("boneMedicines")).toBe(false)
    expect(known.has("dental.problemaAnestesia")).toBe(true)
    expect(known.has("medical.tabaco")).toBe(true)
  })

  it("lo anotado en la entrevista y una medicina de la clase cuentan como sabido", () => {
    const known = knownHealthQuestions({
      ...nothing,
      medications: [{ atcCode: "B01AA03" }],
      interview: {
        embarazoLactancia: { lactancia: { estado: "no", fecha: "2026-11-01" } },
        habitos: { tabaco: "fuma" },
        antecedentesOdontologicos: { corazon: { riesgoEndocarditis: "no" } },
      },
    })
    for (const key of ["anticoagulants", "medical.lactancia", "medical.tabaco", "dental.corazon"] as const)
      expect(known.has(key)).toBe(true)
    expect(known.has("boneMedicines")).toBe(false)
    // «No toma ninguna medicina», anotado por el equipo, responde las dos clases.
    const none = knownHealthQuestions({ ...nothing, reviewStatus: { ...nothing.reviewStatus, medications: "none" } })
    expect(none.has("anticoagulants") && none.has("boneMedicines")).toBe(true)
  })

  it("a un hombre no se le pregunta la lactancia, y lo que la clínica no pide no se pregunta", () => {
    const ask = healthQuestionsToAsk(
      { fields: { ...DEFAULT_REGISTRATION_CONFIG.fields, boneMedicines: "hidden" } },
      { ...dental, person: { sex: "M", age: 40 } },
      new Set(),
    )
    expect(ask).not.toContain("medical.lactancia")
    expect(ask).not.toContain("personal.embarazo")
    expect(ask).not.toContain("boneMedicines")
    expect(ask).toContain("anticoagulants")
  })
})

describe("el enlace de un niño se lo pregunta a quien lo cuida", () => {
  it("a los 6 años: «de pequeño» sí, embarazo y tabaco no; a los 8, sin biberón ni chupón", () => {
    const six = healthQuestionsToAsk(DEFAULT_REGISTRATION_CONFIG, { ...dental, person: { sex: "M", age: 6 } }, new Set())
    expect(six).toEqual(
      expect.arrayContaining(["dental.biberon", "dental.chupon", "dental.dulcesEntreComidas", "dental.pastaConFluor", "dental.quienCepilla"]),
    )
    expect(six).not.toContain("medical.tabaco")
    expect(six).not.toContain("personal.embarazo")
    const eight = healthQuestionsToAsk(DEFAULT_REGISTRATION_CONFIG, { ...dental, person: { sex: "F", age: 8 } }, new Set())
    expect(eight).not.toContain("dental.biberon")
    expect(eight).not.toContain("dental.chupon")
    expect(eight).toContain("dental.quienCepilla")
    // En latidIA, lo de un niño de odentIA no se pregunta.
    const medical = healthQuestionsToAsk(
      DEFAULT_REGISTRATION_CONFIG,
      { ...dental, product: "medical", person: { sex: "M", age: 6 } },
      new Set(),
    )
    expect(medical.some((key) => key.startsWith("dental."))).toBe(false)
    expect(medical).not.toContain("medical.tabaco")
  })

  it("lo que su madre ya contó, o anotó el equipo en la entrevista, no se vuelve a preguntar", () => {
    const known = knownHealthQuestions({
      ...nothing,
      declarations: [{ health: { dental: { dulcesEntreComidas: "1_a_3" } } }],
      interview: { antecedentesOdontologicos: { quienCepilla: "adulto" } },
    })
    expect(known.has("dental.dulcesEntreComidas")).toBe(true)
    expect(known.has("dental.quienCepilla")).toBe(true)
    expect(known.has("dental.pastaConFluor")).toBe(false)
  })
})

describe("«No se le preguntó» no es «dijo que no»", () => {
  it("cada clase dice si toma, si dijo que no, si no sabe o si nadie se lo preguntó", () => {
    expect(medicineClassAnswers({ ...nothing, current: [] }).anticoagulants).toEqual({ answer: "unasked", said: false })
    const said = medicineClassAnswers({
      ...nothing,
      current: [{ atcCode: "M05B" }],
      declarations: [{ health: { anticoagulants: { state: "none" }, boneMedicines: { state: "recorded", detail: "alendronato" } } }],
    })
    expect(said.anticoagulants).toEqual({ answer: "no", said: true })
    expect(said.boneMedicines).toEqual({ answer: "yes", said: false })
    expect(
      medicineClassAnswers({ ...nothing, current: [], declarations: [{ health: { anticoagulants: { state: "unknown" } } }] })
        .anticoagulants,
    ).toEqual({ answer: "unknown", said: true })
    // El equipo anotó que no toma nada: no es lo que dijo ella.
    expect(
      medicineClassAnswers({ ...nothing, reviewStatus: { ...nothing.reviewStatus, medications: "none" }, current: [] })
        .boneMedicines,
    ).toEqual({ answer: "no", said: false })
  })

  it("la marca dice la clase con lo que toma, y «Sintrom» escrito sin código queda sin marca", () => {
    expect(medicationAlertWords({ name: "warfarina", dose: "5 mg", atcCode: "B01A" })).toEqual({
      label: "Anticoagulante: warfarina 5 mg",
      group: "anticoagulants",
    })
    expect(medicationAlertWords({ name: "alendronato", atcCode: "M05B" })).toEqual({
      label: "Medicina para los huesos: alendronato",
      group: "boneMedicines",
    })
    expect(medicationAlertWords({ name: "Anticoagulante (no dijo cuál)", atcCode: "B01A" }).label).toBe(
      "Anticoagulante (no dijo cuál)",
    )
    expect(medicationAlertWords({ name: "Sintrom", atcCode: null })).toEqual({ label: "Toma Sintrom", group: null })
  })
})

describe("de lo que envió desde su enlace, solo lo que se le preguntó", () => {
  it("lo que ya se sabía no se cambia; las semanas van con el embarazo y cuántos fuma con el tabaco", () => {
    expect(
      onlyAskedHealth(
        {
          allergies: { state: "none", items: [] },
          anticoagulants: { state: "recorded", detail: "warfarina" },
          personal: { embarazo: true, semanasEmbarazo: 20, cirugias: "No" },
          medical: { tabaco: "fuma", cigarrillos: "menos_10", lactancia: false },
        },
        ["anticoagulants", "personal.embarazo", "medical.tabaco"],
      ),
    ).toEqual({
      anticoagulants: { state: "recorded", detail: "warfarina" },
      personal: { embarazo: true, semanasEmbarazo: 20 },
      medical: { tabaco: "fuma", cigarrillos: "menos_10" },
    })
  })
})

// Revisión de la entrega 6 (14 nov): dos formas de terminar en «Anticoagulante: no toma» sin que fuera cierto.
describe("«no toma» solo cuando es cierto", () => {
  it("dijo que sí y ninguna medicina anotada lleva la clase: «dijo que toma», nunca «no toma»", () => {
    const declarations = [{ health: { anticoagulants: { state: "recorded" as const, detail: "Sintrom" } } }]
    // El equipo ya tenía «Sintrom» escrito a mano, sin código: lo de ella no sumó otra fila.
    expect(medicineClassAnswers({ ...nothing, declarations, current: [{ atcCode: null }] }).anticoagulants).toEqual({
      answer: "saidYes",
      said: true,
    })
    // Dijo que sí y el equipo la terminó: hoy no la toma.
    expect(
      medicineClassAnswers({ ...nothing, declarations, current: [], ended: [{ atcCode: "B01AA07" }] }).anticoagulants,
    ).toEqual({ answer: "no", said: false })
  })

  it("el «No» a «algún otro medicamento» no responde por el anticoagulante ni por los huesos", () => {
    const declarations = [
      { health: { anticoagulants: { state: "unknown" as const }, boneMedicines: { state: "unanswered" as const }, medications: { state: "none" as const, items: [] } } },
    ]
    const withNone = { ...nothing, reviewStatus: { ...nothing.reviewStatus, medications: "none" }, declarations }
    const classes = medicineClassAnswers({ ...withNone, current: [] })
    expect(classes.anticoagulants).toEqual({ answer: "unknown", said: true })
    // No es «no toma»: la saltó (QA del 15 nov, A12), y sigue sin saberse.
    expect(classes.boneMedicines).toEqual({ answer: "skipped", said: true })
    const known = knownHealthQuestions(withNone)
    expect(known.has("boneMedicines")).toBe(false)
    expect(known.has("medications")).toBe(true)
    // Un «no toma medicamentos» de antes, cuando era una sola pregunta, sí responde por las dos.
    const before = { ...nothing, reviewStatus: { ...nothing.reviewStatus, medications: "none" } }
    expect(medicineClassAnswers({ ...before, current: [] }).boneMedicines).toEqual({ answer: "no", said: false })
    expect(knownHealthQuestions(before).has("anticoagulants")).toBe(true)
  })

  it("un «tiene» que solo trae el anticoagulante no responde «¿algún otro medicamento?»", () => {
    const onlyClass = { ...nothing, reviewStatus: { ...nothing.reviewStatus, medications: "recorded" }, medications: [{ atcCode: "B01A" }] }
    expect(knownHealthQuestions(onlyClass).has("medications")).toBe(false)
    expect(knownHealthQuestions({ ...onlyClass, medications: [{ atcCode: "B01A" }, { atcCode: null }] }).has("medications")).toBe(true)
  })
})

// QA del 14 nov (B4, B11): a un niño de 7 años se le preguntaba si fuma; la regla de a quién le
// corresponde cada pregunta es una sola, la del servidor.
describe("a quién le corresponde cada pregunta", () => {
  it("el tabaco y el alcohol desde los 12 años; el embarazo y la lactancia, mujeres de 12 a 55", () => {
    expect(registrationFieldApplies("medical.tabaco", { age: 7 })).toBe(false)
    expect(registrationFieldApplies("medical.alcohol", { age: 7 })).toBe(false)
    expect(registrationFieldApplies("medical.tabaco", { age: 15 })).toBe(true)
    expect(registrationFieldApplies("personal.embarazo", { sex: "F", age: 61 })).toBe(false)
    expect(registrationFieldApplies("medical.lactancia", { sex: "M", age: 30 })).toBe(false)
    expect(registrationFieldApplies("personal.embarazo", { sex: "F", age: 30 })).toBe(true)
  })
})

// QA del 14 nov (C1): la aspirina y el clopidogrel son antiagregantes; la marca lo dice.
it("«Antiagregante» para el grupo B01AC y «Anticoagulante» para el resto", () => {
  expect(medicationAlertWords({ name: "clopidogrel", dose: "75 mg", atcCode: "B01AC04" }).label).toBe("Antiagregante: clopidogrel 75 mg")
  expect(medicationAlertWords({ name: "apixabán", dose: null, atcCode: "B01AF02" }).label).toBe("Anticoagulante: apixabán")
})

// QA del 14 nov (B3): la medicina para los huesos que tomó y ya no toma sigue contando.
it("de los huesos, la que tomó y ya no toma es «la tomó antes»; del anticoagulante, «no toma»", () => {
  const declarations = [
    { health: { boneMedicines: { state: "recorded" as const }, anticoagulants: { state: "recorded" as const } } },
  ]
  const answers = medicineClassAnswers({
    ...nothing,
    declarations,
    current: [],
    ended: [{ atcCode: "M05BA08" }, { atcCode: "B01AA03" }],
  })
  expect(answers.boneMedicines).toEqual({ answer: "took", said: true })
  expect(answers.anticoagulants).toEqual({ answer: "no", said: false })
})

// QA de formularios del 15 nov (K16; clínica A1 y Y4 de la 6): su «No sé» a las alergias se mostraba
// «no se le preguntó», como si nadie se lo hubiera preguntado.
describe("su «No sé» a las alergias es lo que dijo, no «no se le preguntó»", () => {
  const dontKnow = { at: "2026-11-13", health: { allergies: { state: "unknown" as const, items: [] } } }
  it("la última declaración que respondió las alergias dijo «No sé», y la ficha no sabe más", () => {
    expect(allergiesSaidUnknownOf({ reviewState: "unknown", activeAllergies: 0, declarations: [dontKnow] })).toBe(dontKnow)
    // «Nada cambió» o lo que no respondió las alergias no tapa su «No sé».
    expect(
      allergiesSaidUnknownOf({ reviewState: "unknown", activeAllergies: 0, declarations: [{ at: "2026-11-14", health: {} }, dontKnow] }),
    ).toBe(dontKnow)
  })
  it("no, si después dijo otra cosa, si el equipo lo anotó o si nadie se lo preguntó", () => {
    const saidNo = { at: "2026-11-14", health: { allergies: { state: "none" as const, items: [] } } }
    expect(allergiesSaidUnknownOf({ reviewState: "none", activeAllergies: 0, declarations: [saidNo, dontKnow] })).toBeNull()
    expect(allergiesSaidUnknownOf({ reviewState: "recorded", activeAllergies: 1, declarations: [dontKnow] })).toBeNull()
    expect(allergiesSaidUnknownOf({ reviewState: "unknown", activeAllergies: 1, declarations: [dontKnow] })).toBeNull()
    expect(allergiesSaidUnknownOf({ reviewState: "unknown", activeAllergies: 0, declarations: [] })).toBeNull()
  })
})

// QA de formularios del 15 nov (A12 y D3 del auditor): «Saltar» en «Tus medicinas» dejaba «Anticoagulante:
// no se le preguntó». Se le preguntó y no respondió.
describe("lo que saltó no es «no se le preguntó»", () => {
  it("se le preguntó la clase y no respondió: «skipped», de lo que dijo; respondida después, lo que respondió", () => {
    const skipped = { health: { anticoagulants: { state: "unanswered" as const }, boneMedicines: { state: "none" as const } } }
    const answers = medicineClassAnswers({ ...nothing, current: [], declarations: [skipped] })
    expect(answers.anticoagulants).toEqual({ answer: "skipped", said: true })
    expect(answers.boneMedicines).toEqual({ answer: "no", said: true })
    const later = { health: { anticoagulants: { state: "none" as const } } }
    expect(medicineClassAnswers({ ...nothing, current: [], declarations: [later, skipped] }).anticoagulants).toEqual({
      answer: "no",
      said: true,
    })
    // Una medicina de la clase anotada por el equipo responde por ella.
    expect(medicineClassAnswers({ ...nothing, current: [{ atcCode: "B01AA03" }], declarations: [skipped] }).anticoagulants).toEqual({
      answer: "yes",
      said: false,
    })
  })
})

it("la aspirina de todos los días es un antiagregante, no un anticoagulante (mesa del 25 nov, H4)", () => {
  const entry = findHabitualMedication("aspirina 100")
  expect(entry?.atc).toBe("B01AC06")
  expect(medicationAlertWords({ name: "aspirina", dose: "100 mg", atcCode: entry?.atc }).label).toBe("Antiagregante: aspirina 100 mg")
})
