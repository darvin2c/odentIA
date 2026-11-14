import { describe, expect, it } from "vitest"
import {
  healthQuestionsToAsk,
  type KnownHealthInput,
  knownHealthQuestions,
  medicationAlertWords,
  medicineClassAnswers,
} from "./health-asked.js"
import { DEFAULT_REGISTRATION_CONFIG } from "./patient-registration.js"

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
      label: "Huesos: alendronato",
      group: "boneMedicines",
    })
    expect(medicationAlertWords({ name: "Anticoagulante (no dijo cuál)", atcCode: "B01A" }).label).toBe(
      "Anticoagulante (no dijo cuál)",
    )
    expect(medicationAlertWords({ name: "Sintrom", atcCode: null })).toEqual({ label: "Toma Sintrom", group: null })
  })
})
