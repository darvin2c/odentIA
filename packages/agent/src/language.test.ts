import { describe, expect, it } from "vitest"
import { languageOf } from "./language"

describe("el idioma de lo que escribe la persona y de la respuesta (auditoría del ADR 0104)", () => {
  it("distingue el inglés del español en mensajes de WhatsApp", () => {
    expect(languageOf("Hi! I've had a toothache for a few days. Do you have an appointment this week?")).toBe("en")
    expect(languageOf("Thursday at 11 works for me. Could you also let me know how much the evaluation costs?")).toBe("en")
    expect(languageOf("hola, quisiera saber cuánto cuesta una limpieza y si tienen cita mañana")).toBe("es")
    expect(languageOf("Emily, tengo disponible la evaluación este jueves 29 de octubre a las 11:00 a. m. en Miraflores")).toBe("es")
  })

  it("una respuesta en inglés con nombres en español sigue siendo inglés", () => {
    expect(languageOf("Thursday at 11:00 am works at our Miraflores branch with Dr. Luis Prado, and the «Evaluación gratis» promotion applies to you.")).toBe("en")
  })

  it("lo corto o mezclado no se adivina", () => {
    expect(languageOf("ok")).toBeNull()
    expect(languageOf("sí")).toBeNull()
    expect(languageOf("👍")).toBeNull()
    expect(languageOf(null)).toBeNull()
  })
})
