import { describe, expect, it } from "vitest"
import { formsToStartOf, signOrder } from "./clio-form-proposals"
import type { DictationSuggestion } from "./dictation-session"

const item = (id: string, kind: DictationSuggestion["kind"], payload: Record<string, unknown> = {}): DictationSuggestion => ({
  id,
  kind,
  payload,
  sourceText: "",
  status: "lista",
  note: null,
  summary: "",
  voice: null,
  removal: null,
})

// Verificación de la entrega 11 (14 nov).
describe("lo de Clío al firmar y al dictar", () => {
  it("al firmar va lo de cada ficha junto y en su orden, después lo de la consulta", () => {
    const items = [
      item("pieza", "ficha", { responseId: "endo", order: 0 }),
      item("dolor", "ficha", { responseId: "endo", order: 1 }),
      item("relato", "nota"),
      item("k040", "diagnostico"),
      item("intensidad", "ficha", { responseId: "endo", order: 2 }),
    ]
    expect(signOrder(items).map((suggestion) => suggestion.id)).toEqual(["pieza", "dolor", "intensidad", "relato", "k040"])
  })

  it("el aviso de empezar una ficha solo sale si la atención no tiene ninguna empezada", () => {
    const offers = [{ title: "Ficha de ortodoncia", today: null }]
    expect(formsToStartOf(offers, [], "e1")).toEqual(["Ficha de ortodoncia"])
    // Empezada con «Otra ficha…»: no está entre las ofrecidas, pero ya hay una.
    expect(formsToStartOf(offers, [{ encounterId: "e1", source: "staff", status: "borrador" }], "e1")).toEqual([])
    expect(formsToStartOf([{ title: "Ficha de ortodoncia", today: { responseId: "r1" } }], [], "e1")).toEqual([])
  })
})
