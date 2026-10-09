import { describe, expect, it } from "vitest"
import { humanize, label } from "./glossary"

describe("glosario", () => {
  it("traduce códigos conocidos de cada dominio", () => {
    expect(label("imagen", "bitewing")).toBe("Radiografía interproximal (bitewing)")
    expect(label("consentimiento", "anulado")).toBe("Anulado")
    expect(label("documento", "foto_clinica")).toBe("Foto clínica")
    expect(label("conversacion", "open")).toBe("Abierta")
  })
  it("nunca muestra un código crudo con guiones bajos", () => {
    expect(label("formulario", "en_revision")).toBe("En revision")
    expect(humanize("no_requiere")).toBe("No requiere")
    expect(label("alergia", null)).toBe("—")
  })
})
