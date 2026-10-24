import { beforeAll, describe, expect, it } from "vitest"
import { bareProduct, declareProduct } from "../product/product-ui"
import { conversationStatusLabel, humanize, label } from "./glossary"

// Los nombres de las categorías de documentos son del producto (issue 229).
beforeAll(() => declareProduct(bareProduct("dental")))

describe("glosario", () => {
  it("traduce códigos conocidos de cada dominio", () => {
    expect(label("imagen", "bitewing")).toBe("Radiografía interproximal (bitewing)")
    expect(label("consentimiento", "anulado")).toBe("Anulado")
    expect(label("documento", "foto_clinica")).toBe("Foto clínica")
    expect(label("conversacion", "open")).toBe("Abierta")
  })
  it("una conversación está abierta o cerrada, y cerrada dice por qué", () => {
    expect(conversationStatusLabel("open", null, "Sofi")).toBe("Abierta")
    expect(conversationStatusLabel("closed", null, "Sofi")).toBe("Cerrada")
    expect(conversationStatusLabel("closed", { reason: "sin_respuesta", byName: null }, "Sofi")).toBe("Cerrada · sin respuesta del paciente")
    expect(conversationStatusLabel("closed", { reason: "resuelta", byName: null }, "Sofi")).toBe("Cerrada · resuelta por Sofi")
    expect(conversationStatusLabel("closed", { reason: "equipo", byName: "Rosa" }, "Sofi")).toBe("Cerrada · resuelta por Rosa")
    expect(conversationStatusLabel("closed", { reason: "manual", byName: "Luis" }, "Sofi")).toBe("Cerrada · por Luis")
  })
  it("nunca muestra un código crudo con guiones bajos", () => {
    expect(label("formulario", "en_revision")).toBe("En revision")
    expect(humanize("no_requiere")).toBe("No requiere")
    expect(label("alergia", null)).toBe("—")
  })
})
