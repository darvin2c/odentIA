import { describe, expect, it } from "vitest"
import { healthCheckQuestion } from "../patient/registration-questionnaire"
import { answeredFor, healthAnswerWords, personalDataSentWords } from "./personal-data-form"

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

  // K1: el enlace de Lucía no tenía su fecha; respondió su mamá. Lo que escribió en el envío decide.
  it("si respondió por ella, «Listo, Carmen» con el nombre de Lucía, y con la fecha que escribió", () => {
    const lucia = { firstName: "Lucía", age: null, respondentFirstName: null, missing: [{ key: "birthDate", label: "Fecha de nacimiento" }] }
    const answers = {
      demographics: { displayName: "", birthDate: "2023-03-02" },
      respondent: "representative" as const,
      representative: { displayName: "Carmen Paredes Ruiz", relationship: "guardian" as const, relationshipDetail: "Madre, padre o tutor" },
      privacyAccepted: true,
    }
    const said = answeredFor(lucia, answers, "2026-11-14")
    expect(said).toMatchObject({ age: 3, respondentFirstName: "Carmen", forOther: true })
    expect(personalDataSentWords(said, "Dental Smile", "con-salud")).toEqual({
      title: "Listo, Carmen",
      text: "Dental Smile ya tiene los datos de Lucía y su salud.",
    })
    // Una adulta por quien respondió su hija: también se le habla a quien respondió.
    const rosa = answeredFor({ ...lucia, firstName: "Rosa" }, { ...answers, demographics: { displayName: "", birthDate: "1950-02-01" } }, "2026-11-14")
    expect(personalDataSentWords(rosa, "Dental Smile", "con-salud").title).toBe("Listo, Carmen")
    // Si dijo «Soy Lucía», se le habla a ella.
    const herself = answeredFor({ ...lucia, firstName: "Marta" }, { ...answers, respondent: "patient", demographics: { displayName: "", birthDate: "1990-01-01" } }, "2026-11-14")
    expect(personalDataSentWords(herself, "Dental Smile", "con-salud").title).toBe("Listo, Marta")
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
    expect(healthCheckQuestion(null, "2026-11-13T19:27:00.000Z")).toBe(
      "¿Cambió algo en tu salud o en tus medicinas desde tu última visita (13 nov)?",
    )
    expect(healthCheckQuestion("Thiago", "2026-11-13T19:27:00.000Z")).toBe(
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