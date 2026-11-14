import { describe, expect, it } from "vitest"
import { unrecordedParts } from "./encounter-detail-view"

/** Una atención firmada con diagnóstico, evolución e indicaciones, sin procedimientos ni archivos. */
const signed = {
  diagnoses: 1,
  procedures: 0,
  evolution: true,
  indications: true,
  issuedPrescription: false,
  showDocuments: true,
  documents: 0,
  forms: 0,
}

// QA de formularios del 13 nov: la atención firmada decía «Sin registrar: procedimientos ni
// documentos» aunque en ella se había llenado y finalizado un formulario.
describe("«Sin registrar» de la atención firmada", () => {
  it("con un formulario finalizado en ella ya no dice que faltan documentos", () => {
    expect(unrecordedParts(signed)).toEqual(["procedimientos", "documentos"])
    expect(unrecordedParts({ ...signed, forms: 1 })).toEqual(["procedimientos"])
  })

  it("un archivo subido o una receta emitida también cuentan como documento", () => {
    expect(unrecordedParts({ ...signed, documents: 1 })).toEqual(["procedimientos"])
    expect(unrecordedParts({ ...signed, indications: false, issuedPrescription: true })).toEqual(["procedimientos"])
  })

  it("en la página de la atención, que lista sus documentos aparte, no se dice que faltan", () => {
    expect(unrecordedParts({ ...signed, showDocuments: false })).toEqual(["procedimientos"])
  })

  it("sin nada registrado lo dice todo", () => {
    expect(
      unrecordedParts({ ...signed, diagnoses: 0, evolution: false, indications: false }),
    ).toEqual(["diagnóstico", "procedimientos", "evolución", "indicaciones", "documentos"])
  })
})
