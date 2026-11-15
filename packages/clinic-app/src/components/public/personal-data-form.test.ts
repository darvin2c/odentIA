import { describe, expect, it } from "vitest"
import { healthAnswerWords, healthCheckQuestion, personalDataSentWords } from "./personal-data-form"

const adult = { firstName: "Marta", age: 66, respondentFirstName: null, missing: [] }
const thiago = { firstName: "Thiago", age: 6, respondentFirstName: "Carla", missing: [] }

describe("lo que dice «Su enlace» al terminar", () => {
  it("a la persona le habla a ella, como siempre", () => {
    expect(personalDataSentWords(adult, "Dental Smile", "con-salud")).toEqual({
      title: "Listo, Marta",
      text: "Dental Smile ya tiene lo que nos contaste de tu salud.",
    })
  })

  it("del enlace de un niño le habla a quien lo cuida, con el nombre del niño", () => {
    expect(personalDataSentWords(thiago, "Dental Smile", "con-salud")).toEqual({
      title: "Listo, Carla",
      text: "Dental Smile ya tiene lo que nos contaste de la salud de Thiago.",
    })
    expect(personalDataSentWords(thiago, "Dental Smile", "nada").text).toBe(
      "No nos contaste nada de la salud de Thiago. Si quieres, cuéntanoslo antes de venir o en la cita.",
    )
    expect(personalDataSentWords({ ...thiago, missing: [{ key: "birthDate", label: "Fecha de nacimiento" }] }, "Dental Smile", "con-salud").text).toBe(
      "Dental Smile ya tiene los datos de Thiago y su salud.",
    )
    expect(personalDataSentWords(thiago, "Dental Smile", "ya-enviado").text).toBe("Dental Smile ya tiene los datos de Thiago.")
    // Sin saber quién abrió el enlace, no se saluda al niño.
    expect(personalDataSentWords({ ...thiago, respondentFirstName: null }, "Dental Smile", "con-salud").title).toBe("Listo")
  })

  // Mesa de formularios del 13 nov, entrega 8 (C2): un envío, y quién lo lee antes de atenderla.
  it("con «Tu visita» dice todo lo que llegó y quién lo lee antes de atenderla", () => {
    const marta = { ...adult, missing: [{ key: "birthDate", label: "Fecha de nacimiento" }] }
    expect(personalDataSentWords(marta, "Dental Smile", "con-salud", { reader: "el Dr. Luis Prado", askedReason: true })).toEqual({
      title: "Listo, Marta",
      text: "Dental Smile ya tiene tus datos, tu salud y a qué vienes. Lo lee el Dr. Luis Prado antes de atenderte.",
    })
    // Solo su visita, en su sesión 2: se le dijo a qué viene.
    expect(personalDataSentWords(adult, "Dental Smile", "sin-salud", { reader: "la Dra. Ana Torres", askedReason: false }).text).toBe(
      "Dental Smile ya tiene lo de tu visita. Lo lee la Dra. Ana Torres antes de atenderte.",
    )
    expect(personalDataSentWords(thiago, "Dental Smile", "sin-salud", { reader: null, askedReason: true }).text).toBe(
      "Dental Smile ya tiene a qué viene Thiago.",
    )
  })
})

// Mesa de formularios del 13 nov, entrega 10 (C6): la pregunta no lista lo que dijo antes (decisión 9).
describe("¿Cambió algo?", () => {
  it("pregunta desde su última visita, con el día, y a quien cuida a un niño por el niño", () => {
    expect(healthCheckQuestion(adult, "2026-11-13T19:27:00.000Z")).toBe(
      "¿Cambió algo en tu salud o en tus medicinas desde tu última visita (13 nov)?",
    )
    expect(healthCheckQuestion(thiago, "2026-11-13T19:27:00.000Z")).toBe(
      "¿Cambió algo en la salud o en las medicinas de Thiago desde su última visita (13 nov)?",
    )
  })

  it("con «No» dice que ya lo sabe; al corregir, que lo de antes no se borra", () => {
    expect(healthAnswerWords(adult, "Dental Smile", "sin_cambios")).toEqual({
      title: "Listo, Marta",
      text: "Dental Smile ya sabe que nada cambió en tu salud ni en tus medicinas.",
    })
    expect(healthAnswerWords(thiago, "Dental Smile", "correccion")).toEqual({
      title: "Listo, Carla",
      text: "Dental Smile recibió tu corrección. Lo revisa quien atiende a Thiago; lo de antes no se borra.",
    })
  })
})