import { describe, expect, it } from "vitest"
import type { FormTemplate } from "./clinical-forms"
import {
  answerWords,
  appearsWords,
  formRowTitle,
  lookedCount,
  lookFirst,
  offerActionWords,
  offersView,
  draftOf,
  formsBelowOffers,
  reusableAnswer,
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

  it("«Otra ficha…» está siempre: sin ninguna ofrecida queda sola, en una línea", () => {
    expect(offersView([{ today: null }], true)).toBe("lista")
    expect(offersView([], true)).toBe("solo-otra")
    // Quien no puede empezar una no ve una salida que no puede usar.
    expect(offersView([], false)).toBe("nada")
    // Mientras llegan, no se dice nada.
    expect(offersView(undefined, true)).toBe("nada")
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
  // Sin repetir: «Ficha de ortodoncia», no «Ficha · Ficha de ortodoncia».
  expect(formRowTitle({ source: "staff", templateTitle: "Ficha de ortodoncia" })).toBe("Ficha de ortodoncia")
  expect(formRowTitle({ source: "staff", templateTitle: "Evaluación de endodoncia" })).toBe("Ficha · Evaluación de endodoncia")
  expect(formRowTitle({ source: "portal", templateTitle: "Cuestionario previo a la cita" })).toBe(
    "Lo que respondió el paciente · Cuestionario previo a la cita",
  )
})

// QA del 14 nov (U5): «Otra ficha…» dejaba empezar otra igual a la que estaba a medias.
describe("una ficha a medias se ve una sola vez", () => {
  const draft = { id: "r1", templateId: "t1", templateTitle: "Ficha de odontopediatría", status: "borrador" as const, source: "staff" as const }
  it("«Otra ficha…» abre la que ya está a medias, también si era de otra versión", () => {
    expect(draftOf({ id: "t1", title: "Ficha de odontopediatría" }, [draft])).toBe("r1")
    expect(draftOf({ id: "t2", title: "Ficha de odontopediatría" }, [draft])).toBe("r1")
    expect(draftOf({ id: "t3", title: "Ficha de ortodoncia" }, [draft])).toBeNull()
    expect(draftOf({ id: "t1", title: "Ficha de odontopediatría" }, [{ ...draft, status: "finalizado" }])).toBeNull()
  })
  it("Documentos no repite la que ya se ofrece arriba a medias; la finalizada sí queda", () => {
    const forms = [draft, { id: "r2", status: "finalizado" as const }]
    const offers = [{ today: { responseId: "r1", status: "borrador" as const } }, { today: { responseId: "r2", status: "finalizado" as const } }]
    expect(formsBelowOffers(forms, offers).map((form) => form.id)).toEqual(["r2"])
    expect(formsBelowOffers(forms, undefined).map((form) => form.id)).toEqual(["r1", "r2"])
  })
})

// QA del 14 nov (clínica H1): en la sesión 2 o el control se reescribía todo, incluida la pieza.
it("«Usar» copia la respuesta anterior si la pregunta de hoy la admite, y nunca una firma", () => {
  expect(reusableAnswer({ type: "pieza" }, { type: "pieza" }, 36)).toBe(36)
  expect(reusableAnswer({ type: "opcion_unica", options: ["Clase I", "Clase III"] }, { type: "opcion_unica" }, "Clase II")).toBeUndefined()
  expect(reusableAnswer({ type: "opcion_multiple", options: ["No tiene", "Anterior"] }, { type: "opcion_multiple" }, ["Anterior", "Lateral"])).toEqual(["Anterior"])
  expect(reusableAnswer({ type: "numero" }, { type: "texto" }, "5")).toBeUndefined()
  expect(reusableAnswer({ type: "firma" }, { type: "firma" }, { strokes: [] })).toBeUndefined()
  expect(reusableAnswer({ type: "texto" }, { type: "texto" }, "")).toBeUndefined()
})

// QA del 14 nov (desarrollo H8, UX U7): el total cambiaba al dejar de usar una, y la que faltaba quedaba al final.
it("«Miraste N de 4» no cambia de total con una apagada, y la que falta mirar va primero", () => {
  const mine = [template({ key: "propia", fromProduct: false, looked: true })]
  const off = [template({ key: "a", fromProduct: true, looked: true, inUse: false })]
  const toLook = [template({ key: "b", fromProduct: true, looked: false })]
  const seen = [template({ key: "c", fromProduct: true, looked: true })]
  const old = [template({ key: "d", fromProduct: true, looked: true, status: "archivado" })]
  expect(lookedCount([mine, off, toLook, seen, old])).toEqual({ looked: 3, total: 4 })
  expect(lookFirst([mine, off, toLook, seen]).map((versions) => versions[0]?.key)).toEqual(["b", "propia", "a", "c"])
})
