import { describe, expect, it } from "vitest"
import { conversationStatusLabel, humanize, label } from "./glossary"

describe("glosario", () => {
  it("traduce códigos conocidos de cada dominio", () => {
    expect(label("imagen", "bitewing")).toBe("Radiografía interproximal (bitewing)")
    expect(label("consentimiento", "anulado")).toBe("Anulado")
    expect(label("documento", "foto_clinica")).toBe("Foto clínica")
    expect(label("conversacion", "open")).toBe("Abierta")
  })
  it("una conversación está abierta o cerrada, y cerrada dice por qué", () => {
    expect(conversationStatusLabel("open", null)).toBe("Abierta")
    expect(conversationStatusLabel("closed", null)).toBe("Cerrada")
    expect(conversationStatusLabel("closed", { reason: "sin_respuesta", byName: null })).toBe("Cerrada · sin respuesta del paciente")
    expect(conversationStatusLabel("closed", { reason: "resuelta", byName: null })).toBe("Cerrada · resuelta por el agente")
    expect(conversationStatusLabel("closed", { reason: "equipo", byName: "Rosa" })).toBe("Cerrada · resuelta por Rosa")
    expect(conversationStatusLabel("closed", { reason: "manual", byName: "Luis" })).toBe("Cerrada · por Luis")
  })
  it("nunca muestra un código crudo con guiones bajos", () => {
    expect(label("formulario", "en_revision")).toBe("En revision")
    expect(humanize("no_requiere")).toBe("No requiere")
    expect(label("alergia", null)).toBe("—")
  })
})
