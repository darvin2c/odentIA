import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")

// QA del 14 nov (U1): el bloque quedaba dentro de Documentos, a casi tres pantallas.
describe("«Fichas para esta atención» en la atención", () => {
  it("va debajo de «Hoy viene a…» y antes de la consulta, no dentro de Documentos", () => {
    const editor = source("./encounter-editor.tsx")
    const visit = editor.indexOf("<EncounterVisitStrip")
    const offers = editor.indexOf("<FormOffersBox")
    const consulta = editor.indexOf('"consulta",', visit)
    expect(visit).toBeGreaterThan(-1)
    expect(offers).toBeGreaterThan(visit)
    expect(offers).toBeLessThan(consulta)
    expect(source("./encounter-documents.tsx")).not.toContain("<FormOffersBox")
  })
})

// QA del 14 nov (UX U2): la respuesta anterior no se oía con el lector de pantalla, y decía «al lado».
describe("la anterior, debajo de cada pregunta", () => {
  it("queda unida a su pregunta y dice «debajo», no «al lado»", () => {
    const detail = source("./formularios-tab.tsx")
    expect(detail).toContain("describedBy={previous && before ? beforeId : undefined}")
    expect(detail).toContain("<span id={beforeId}>")
    expect(detail).not.toMatch(/Al lado, la anterior/)
    expect(source("./form-fields.tsx")).toContain("[control.describedBy, describedBy]")
    expect(source("./form-offers.tsx")).not.toContain("se ve al lado")
  })
  it("al cerrar la ficha, el foco vuelve a su fila", () => {
    const offers = source("./form-offers.tsx")
    expect(offers).toContain("data-offer={offer.templateId}")
    expect(offers).toContain("onClose={close}")
  })
})
