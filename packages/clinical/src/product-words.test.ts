import { describe, expect, it } from "vitest"
import { productWords, upperFirst } from "./product-words.js"

describe("las palabras de cada producto (entrega 3 del issue 229)", () => {
  it("odentIA por defecto, latidIA con las suyas", () => {
    expect(productWords()).toEqual(productWords("dental"))
    expect(productWords("dental")).toMatchObject({
      name: "odentIA",
      brand: "odentia",
      place: { one: "clínica", indefinite: "una clínica" },
      clinician: { label: "Odontólogo", one: "odontólogo", many: "odontólogos" },
      room: { one: "unidad dental", many: "unidades dentales" },
    })
    expect(productWords("medical")).toMatchObject({
      name: "latidIA",
      brand: "latidia",
      place: { one: "consultorio", indefinite: "un consultorio" },
      clinician: { label: "Médico", one: "médico", many: "médicos" },
      room: { one: "sala", many: "salas" },
    })
  })

  it("los ejemplos de latidIA no hablan de odontología (revisión final del issue 229)", () => {
    const medical = JSON.stringify({ ...productWords("medical").examples, ...productWords("medical").clioTiers })
    for (const word of [/pieza/i, /odonto/i, /ortodoncia|endodoncia/i, /limpieza/i, /cepillo/i, /dental/i, /presupuesto/i]) {
      expect(medical).not.toMatch(word)
    }
  })

  it("la primera letra en mayúscula, también con tilde", () => {
    expect(upperFirst("unidad dental")).toBe("Unidad dental")
    expect(upperFirst("órdenes")).toBe("Órdenes")
    expect(upperFirst("")).toBe("")
  })
})
