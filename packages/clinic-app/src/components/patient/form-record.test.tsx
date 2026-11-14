import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { FormRecord } from "../../lib/patients"
import { FormRecordView } from "./form-record"

const form: FormRecord = {
  id: "f1",
  title: "Evaluación de endodoncia",
  version: 2,
  byWords: "Lo llenó Dra. Ana Torres · lo finalizó Dra. Ana Torres el 13 de noviembre de 2026, 15:02",
  addendaTitle: "Adendas",
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
      "Lo llenó Dra. Ana Torres · lo finalizó Dra. Ana Torres el 13 de noviembre de 2026, 15:02",
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

  it("lo que el equipo precisó sobre lo que envió el paciente se llama «Correcciones»", () => {
    const page = renderToStaticMarkup(<FormRecordView form={{ ...form, addendaTitle: "Correcciones" }} />)
    expect(page).toContain("Correcciones")
    expect(page).not.toContain("Adendas")
  })

  // QA de la entrega 2 (14 nov).
  it("la corrección dice su motivo, si lo tiene; lo que dejó sin responder el paciente dice «No respondió»", () => {
    const page = renderToStaticMarkup(
      <FormRecordView
        form={{
          ...form,
          source: "portal",
          addendaTitle: "Correcciones",
          addenda: [{ ...form.addenda[0]!, reason: "Lo confirmó en consulta" }],
        }}
      />,
    )
    expect(page).toContain("Motivo: Lo confirmó en consulta")
    expect(page).toContain("No respondió")
    expect(page).not.toContain("Sin respuesta")
  })

  it("en la atención firmada solo lleva lo agregado hasta la firma: lo de después va tras «Firmó…»", () => {
    const later = { id: "a2", text: "Agregado después de firmar.", authorName: "Dra. Ana Torres", createdAt: "2026-11-13T21:00:00.000Z" }
    const page = renderToStaticMarkup(
      <FormRecordView form={{ ...form, addenda: [...form.addenda, later] }} addendaUntil="2026-11-13T20:30:00.000Z" />,
    )
    expect(page).toContain("La prueba al frío se repitió.")
    expect(page).not.toContain("Agregado después de firmar.")
  })
})
