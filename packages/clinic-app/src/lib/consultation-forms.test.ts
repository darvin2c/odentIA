import { describe, expect, it } from "vitest"
import type { FormTemplate } from "./clinical-forms"
import {
  answerWords,
  appearsWords,
  formRowTitle,
  lookedCount,
  offerActionWords,
  offerStateWords,
  offerWhyWords,
  unlooked,
} from "./consultation-forms"

const template = (over: Partial<FormTemplate>): FormTemplate =>
  ({
    id: over.key ?? "t",
    key: "t",
    title: "Ficha",
    version: 1,
    status: "publicado",
    respondent: "staff",
    specialtyId: null,
    ...over,
  }) as FormTemplate

describe("fichas de consulta en Configuración", () => {
  it("«Miraste 1 de 4» cuenta solo las que vinieron con el producto, una por ficha", () => {
    const listed = [
      [template({ key: "a", fromProduct: true, looked: true }), template({ key: "a", version: 2, status: "borrador", fromProduct: true, looked: true })],
      [template({ key: "b", fromProduct: true, looked: false })],
      [template({ key: "c", fromProduct: true, looked: false })],
      [template({ key: "d", fromProduct: true, looked: false })],
      [template({ key: "propia", fromProduct: false, looked: true })],
    ]
    expect(lookedCount(listed)).toEqual({ looked: 1, total: 4 })
    // Una clínica sin fichas del producto no ve la cuenta.
    expect(lookedCount([[template({ key: "propia" })]])).toBeNull()
  })

  it("«Sin mirar» solo en la que vino con el producto y nadie abrió", () => {
    expect(unlooked(template({ fromProduct: true, looked: false }))).toBe(true)
    expect(unlooked(template({ fromProduct: true, looked: true }))).toBe(false)
    expect(unlooked(template({ fromProduct: false, looked: false }))).toBe(false)
  })

  it("dice dónde aparece sola: su especialidad, la edad, o que se elige en «Otra ficha…»", () => {
    expect(appearsWords({ specialtyId: "s", offeredUnderYears: 12 }, "Odontopediatría")).toBe(
      "Aparece en la atención de: Odontopediatría, y de cualquier menor de 12 años",
    )
    expect(appearsWords({ specialtyId: "s", offeredUnderYears: null }, "Ortodoncia")).toBe("Aparece en la atención de: Ortodoncia")
    expect(appearsWords({ specialtyId: null }, null)).toBe("No aparece sola: se elige en «Otra ficha…»")
  })
})

describe("fichas ofrecidas en la atención", () => {
  it("cada una dice por qué aparece", () => {
    expect(offerWhyWords({ why: "cita", specialtyName: "Ortodoncia", underYears: null })).toBe(
      "Por la especialidad de su cita: Ortodoncia",
    )
    expect(offerWhyWords({ why: "edad", specialtyName: "Odontopediatría", underYears: 12 })).toBe("Por su edad: menor de 12 años")
    expect(offerWhyWords({ why: "profesional", specialtyName: "Endodoncia", underYears: null })).toBe(
      "Por la especialidad de quien atiende: Endodoncia",
    )
  })

  it("un solo botón: empezar, seguir o ver la de hoy; nunca «pendiente»", () => {
    expect(offerActionWords({ today: null })).toBe("Empezar la de hoy")
    expect(offerActionWords({ today: { responseId: "r", status: "borrador" } })).toBe("Seguir con la de hoy")
    expect(offerActionWords({ today: { responseId: "r", status: "finalizado" } })).toBe("Ver la de hoy")
    expect(offerStateWords({ today: null })).toBeNull()
    expect(offerStateWords({ today: { responseId: "r", status: "borrador" } })).toBe("A medias")
  })

  it("la anterior se lee en palabras, con su unidad", () => {
    expect(answerWords({ type: "numero", unit: "mm" }, 5)).toBe("5 mm")
    expect(answerWords({ type: "opcion_multiple" }, ["Anterior", "Posterior derecha"])).toBe("Anterior, Posterior derecha")
    expect(answerWords({ type: "booleano" }, false)).toBe("No")
    expect(answerWords({ type: "texto" }, "")).toBe("—")
  })
})

it("en Documentos y en la Historia se llama «Ficha»; lo del paciente, como lo que es", () => {
  expect(formRowTitle({ source: "staff", templateTitle: "Ficha de ortodoncia" })).toBe("Ficha · Ficha de ortodoncia")
  expect(formRowTitle({ source: "portal", templateTitle: "Cuestionario previo a la cita" })).toBe(
    "Lo que respondió el paciente · Cuestionario previo a la cita",
  )
})
