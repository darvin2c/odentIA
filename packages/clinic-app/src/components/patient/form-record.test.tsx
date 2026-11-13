import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FormRecord } from "../../lib/patients"
import { FormRecordView } from "./form-record"

const form: FormRecord = {
  id: "f1",
  title: "Evaluación de endodoncia",
  version: 2,
  byWords: "Lo llenó Dra. Ana Torres · finalizado el 13 de noviembre de 2026, 15:02",
  sections: [
    {
      id: "examen",
      title: "Examen",
      items: [
        { id: "pruebas", label: "Pruebas de vitalidad", words: "Frío +, Percusión +" },
        { id: "sangrado", label: "Sangrado al sondaje", words: null },
      ],
    },
  ],
  addenda: [{ id: "a1", text: "La prueba al frío se repitió.", authorName: "Dra. Ana Torres", createdAt: "2026-11-13T20:20:00.000Z" }],
}

// QA de formularios del 13 nov: la atención firmada no mostraba lo anotado en su formulario.
describe("un formulario finalizado dentro de su atención", () => {
  it("se lee entero: título y versión, quién y cuándo, cada pregunta con su respuesta y sus adendas", () => {
    const page = renderToStaticMarkup(<FormRecordView form={form} />)
    for (const said of [
      "Evaluación de endodoncia",
      "versión 2",
      "Lo llenó Dra. Ana Torres · finalizado el 13 de noviembre de 2026, 15:02",
      "Pruebas de vitalidad",
      "Frío +, Percusión +",
      "Adendas",
      "La prueba al frío se repitió.",
    ])
      expect(page).toContain(said)
  })

  it("una pregunta que se hizo y quedó sin responder lo dice, no desaparece", () => {
    const page = renderToStaticMarkup(<FormRecordView form={form} />)
    expect(page).toContain("Sangrado al sondaje")
    expect(page).toContain("Sin respuesta")
  })

  it("sin adendas no anuncia ninguna", () => {
    expect(renderToStaticMarkup(<FormRecordView form={{ ...form, addenda: [] }} />)).not.toContain("Adendas")
  })
})
