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

  it("una posible rabia es una alarma en los dos productos: la mordedura de un animal o un murciélago que pudo tocarla", () => {
    for (const product of ["dental", "medical"] as const) {
      const signals = agentTextsFor(product).alarmSignals
      for (const text of [
        // La ronda de latidIA con casos nuevos al azar (auditoría del 29-oct).
        "me desperte y habia un murcielago en mi dormitorio, estaba en el piso y ya no esta, creo q salio por la ventana 😰",
        "Hola, encontré un murciélago en mi cuarto cuando desperté 😰",
        "necesito saber si voy alla o a emergencias por lo del murcielago",
        "un murciélago me arañó",
        "creo que me mordió algún animal mientras dormía",
        "me mordió un perro en la pierna",
        "Me mordió ayer un perro de la calle",
        "a mi hijo lo mordió un perro en la boca y se le movió un diente",
        "a mi hija le mordió el gato del vecino",
        "un perro mordió a mi hijo",
        "el gato de mi vecina me mordió la mano",
        "fui mordida por un perro callejero",
        "¿atienden mordeduras de perro?",
      ]) {
        expect(hasAlarmSignal(text, signals), `${product}: ${text}`).toBe(true)
      }
      for (const text of [
        // Lo que una clínica dental oye de mascotas y mordidas.
        "mi gato mordió y rompió el protector bucal de mi hermano 😭",
        "a mi gato se le ocurrio morder el protector bucal de mi hermano",
        "mi perro me mordió la placa",
        "el retenedor lo mordió mi perro",
        "me duele más al morder",
        "tengo la mordida cruzada",
        "me mordí la lengua",
        "mi hijo me mordió jugando",
        // Sin mordida ni contacto.
        "el perro casi me mordió",
        "el perro no me mordió, solo me ladró",
        "me arañó mi gato",
        "me picó un zancudo",
        "vi un murciélago en el patio",
        "me voy a la selva y hay murciélagos, ¿ponen la vacuna antirrábica?",
        "¿pueden sellar un formulario de salud para mi gato?",
        "me da rabia esperar tanto",
      ]) {
        expect(hasAlarmSignal(text, signals), `${product}: ${text}`).toBe(false)
      }
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
      "mi bebé tiene 6 meses, está con 39.5 de fiebre y desde la mañana no quiere lactar",
      "no quiere lactar mi bebito desde ayer",
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
