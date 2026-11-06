import { describe, expect, it } from "vitest"
import { notFound } from "./errors"

describe("notFound", () => {
  it("concuerda con la primera palabra", () => {
    expect(notFound("Cita").message).toBe("Cita no encontrada")
    expect(notFound("Conversación de la persona").message).toBe("Conversación de la persona no encontrada")
    expect(notFound("Especialidad").message).toBe("Especialidad no encontrada")
    expect(notFound("Sede").message).toBe("Sede no encontrada")
    expect(notFound("Anamnesis").message).toBe("Anamnesis no encontrada")
    expect(notFound("Paciente").message).toBe("Paciente no encontrado")
    expect(notFound("Tema").message).toBe("Tema no encontrado")
    expect(notFound("Odontograma firmado").message).toBe("Odontograma firmado no encontrado")
    expect(notFound("Ítem del plan").message).toBe("Ítem del plan no encontrado")
  })
})
