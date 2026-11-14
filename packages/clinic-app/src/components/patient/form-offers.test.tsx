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
