import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { offerRemoval } from "./form-offers"

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
    expect(detail).toContain("describedBy={[previous && before ? beforeId : null, said ? saidId : null].filter(Boolean).join(\" \") || undefined}")
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

// Verificación del 14 nov: el aviso de «No tiene» no estaba unido a la casilla «Obligatorio».
it("el aviso de «No tiene» queda unido a la casilla «Obligatorio»", () => {
  const panel = source("../settings/form-templates-panel.tsx")
  expect(panel).toContain("requiredWithoutNone(field) ? noneWarningId : null")
  expect(panel).toContain("<p id={noneWarningId}")
})

// Pedido del 15 nov: no había cómo sacar una ficha agregada por error. Vacía, «Quitar» sin preguntar
// (con «Deshacer»); con algo escrito o propuesto por Clío, «Descartar…» con su motivo.
describe("sacar de la atención la ficha de hoy", () => {
  it("vacía se quita; con una respuesta o con algo de Clío, se descarta con su motivo", () => {
    expect(offerRemoval({ status: "borrador", answers: { a: null, b: "", c: [] } }, 0)).toBe("Quitar")
    expect(offerRemoval({ status: "borrador", answers: {} }, 0)).toBe("Quitar")
    expect(offerRemoval({ status: "borrador", answers: { a: 3 } }, 0)).toBe("Descartar…")
    expect(offerRemoval({ status: "borrador", answers: {} }, 2)).toBe("Descartar…")
  })
  it("la finalizada no se quita ni se descarta, y sin la de hoy no hay nada que sacar", () => {
    expect(offerRemoval({ status: "finalizado", answers: {} }, 0)).toBeNull()
    expect(offerRemoval(null, 0)).toBeNull()
  })
  it("las dos son el descarte de siempre, con su traza: no hay otra operación", () => {
    const offers = source("./form-offers.tsx")
    expect(offers).toContain("discardFormResponse(offer.today.responseId, EMPTY_REMOVED_REASON)")
    expect(offers).toContain("<DiscardFormDialog")
  })
})
