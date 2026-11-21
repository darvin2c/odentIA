import { describe, expect, it } from "vitest"
import { appendDictated } from "./dictated-text.js"

describe("appendDictated", () => {
  it("agrega después de lo que hay, en otra línea", () => {
    expect(appendDictated("Se anestesió la 36.", "Se colocó la resina.", "evolution")).toBe("Se anestesió la 36.\nSe colocó la resina.")
  })

  it("con el campo vacío queda solo lo dictado", () => {
    expect(appendDictated(null, "Dolor al masticar", "reason")).toBe("Dolor al masticar")
    expect(appendDictated("   ", "Dolor al masticar", "reason")).toBe("Dolor al masticar")
  })

  it("el tiempo de enfermedad es un solo valor: queda lo último, con lo de antes entre paréntesis, nunca juntos con «;»", () => {
    expect(appendDictated("3 días", "una semana", "illnessDuration")).toBe("una semana (antes: 3 días)")
    // Un tercero no anida paréntesis: queda lo último y lo inmediatamente anterior.
    expect(appendDictated("una semana (antes: 3 días)", "dos semanas", "illnessDuration")).toBe("dos semanas (antes: una semana)")
    // Lo mismo otra vez no cambia nada.
    expect(appendDictated("una semana (antes: 3 días)", "una semana", "illnessDuration")).toBe("una semana (antes: 3 días)")
  })

  it("no repite si el campo ya dice exactamente lo mismo", () => {
    expect(appendDictated("Dolor al masticar\n", " Dolor al masticar", "reason")).toBe("Dolor al masticar")
  })

  it("lo parecido no es lo mismo: «dolor» dentro de otra frase se agrega igual", () => {
    expect(appendDictated("Dolor de muela", "Dolor", "reason")).toBe("Dolor de muela\nDolor")
    expect(appendDictated("Se anestesió la 36.", "Se anestesió la 37.", "evolution")).toBe("Se anestesió la 36.\nSe anestesió la 37.")
  })

  it("nada dictado no borra lo que hay", () => {
    expect(appendDictated("Dolor de muela", "  ", "reason")).toBe("Dolor de muela")
  })
})
