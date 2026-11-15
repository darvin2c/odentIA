import { describe, expect, it } from "vitest"
import { personalDataSentWords } from "./personal-data-form"

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
})
