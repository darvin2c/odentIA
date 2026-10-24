import { agentTextsFor } from "@odentia/services"
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

  it("latidIA suma las de un consultorio; odentIA, ninguna", () => {
    const medical = agentTextsFor("medical").alarmSignals
    const urgent = [
      "estoy embarazada y estoy sangrando",
      "Tengo sangrado y estoy embarazada de 20 semanas",
      "ya no siento a mi bebé, estoy de 8 meses",
      "se me rompió la fuente",
      "mi hijo tiene los labios morados",
      "el bebé se puso morado",
      "mi papá no reacciona",
      "es el peor dolor de cabeza de mi vida",
      "vomité con sangre",
      "se tomó todas las pastillas",
      "creo que se envenenó",
    ]
    for (const text of urgent) {
      expect(hasAlarmSignal(text, medical), text).toBe(true)
      expect(hasAlarmSignal(text, agentTextsFor("dental").alarmSignals), text).toBe(false)
    }
    for (const text of [
      "estoy embarazada, ¿puedo sacar cita para control?",
      "me sangra la nariz a veces",
      "tengo un moretón morado en la pierna",
      "me duele la cabeza desde ayer",
      "vomité dos veces, ¿me pueden atender hoy?",
      "olvidé tomar mis pastillas",
      "mi bebé tiene fiebre desde anoche",
    ]) {
      expect(hasAlarmSignal(text, medical), text).toBe(false)
    }
  })
})
