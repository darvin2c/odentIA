import { describe, expect, it } from "vitest"
import { treatmentOf, tutea } from "./treatment"

describe("el trato de quien escribe (auditoría del ADR 0104)", () => {
  it("reconoce a quien trata de usted, y a quien lo pide aunque se le escape un «porfa»", () => {
    expect(treatmentOf(["Buenas tardes, ¿podría indicarme cuánto cuesta la limpieza?"])).toBe("usted")
    expect(treatmentOf(["Le agradezco, ¿me podría confirmar la hora?"])).toBe("usted")
    expect(treatmentOf(["Por favor, tráteme de usted.", "y mándenme el precio porfa"])).toBe("usted")
  })

  it("con una forma de tú, o sin formas claras, no se distingue", () => {
    expect(treatmentOf(["¿Ustedes atienden los sábados?"])).toBeNull()
    expect(treatmentOf(["Disculpe", "¿me dices el precio porfa?"])).toBeNull()
    expect(treatmentOf(["hola, quiero una cita"])).toBeNull()
  })

  it("reconoce cuando la respuesta tutea y cuando no", () => {
    expect(tutea("Al confirmar, aceptas nuestro aviso de privacidad. ¿Te la reservo?")).toBe(true)
    expect(tutea("Antes de venir, completa tus datos aquí.")).toBe(true)
    expect(tutea("Sí, podemos evaluarte mañana a las 10:00.")).toBe(true)
    expect(tutea("Al confirmar, acepta nuestro aviso de privacidad. ¿Se la reservo?")).toBe(false)
    expect(tutea("La evaluación completa dura 30 minutos.")).toBe(false)
  })
})
