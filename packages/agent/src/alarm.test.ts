import { describe, expect, it } from "vitest"
import { hasAlarmSignal } from "./alarm.js"

describe("señales de alarma (ADR 0084)", () => {
  it("reconoce una emergencia dicha como la escribe la gente, con o sin tildes", () => {
    for (const text of [
      "Me duele mucho el pecho",
      "tengo un dolor en el pecho desde hace rato",
      "siento opresión en el pecho",
      "no puedo respirar bien",
      "a mi mamá le falta el aire",
      "me estoy ahogando",
      "mi hijo se desmayó",
      "perdió el conocimiento",
      "está convulsionando",
      "me sacaron la muela y no para de sangrar",
      "tengo un sangrado abundante",
      "se me hinchó la cara después de la anestesia",
      "se me cierra la garganta",
      "se le cayó la mitad de la cara",
      "ya no quiero vivir, pienso en quitarme la vida",
      "a veces pienso en el suicidio",
      "me quiero morir",
      "ME DUELE EL PECHO",
    ]) {
      expect(hasAlarmSignal(text), text).toBe(true)
    }
  })

  it("no se dispara con lo de todos los días: una falsa alarma cuesta un aviso de más", () => {
    for (const text of [
      "Hola, quiero una cita para limpieza",
      "me sangra un poco la encía al cepillarme",
      "me duele la muela desde ayer",
      "me quiero morir de lo que cuesta",
      "¿cuánto cuesta una resina?",
      "tengo la cara un poco hinchada por la muela",
      "",
      null,
      undefined,
    ]) {
      expect(hasAlarmSignal(text), String(text)).toBe(false)
    }
  })
})
