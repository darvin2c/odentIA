import { describe, expect, it } from "vitest"
import { confirmationReply } from "./appointment-confirm-words.js"

describe("la respuesta a quien confirma dice de quiénes son las citas", () => {
  it("las propias, con el texto de siempre", () => {
    expect(confirmationReply([{ patientName: "Rosa Quispe", self: true, was: "confirmada" }])).toBe("¡Listo! Tu cita quedó confirmada. Te esperamos.")
    expect(confirmationReply([{ patientName: "Rosa Quispe", self: true, was: "ya_confirmada" }])).toBe("Tu cita ya estaba confirmada. ¡Te esperamos!")
  })

  it("un padre que confirma las de sus hijos oye sus nombres", () => {
    expect(
      confirmationReply([
        { patientName: "Sofía Salas", self: false, was: "confirmada" },
        { patientName: "Pedro Salas", self: false, was: "confirmada" },
      ]),
    ).toBe("¡Listo! Confirmé las citas de Sofía y Pedro. Te esperamos.")
    expect(
      confirmationReply([
        { patientName: "Martín Salas", self: true, was: "confirmada" },
        { patientName: "Sofía Salas", self: false, was: "confirmada" },
      ]),
    ).toBe("¡Listo! Confirmé tu cita y la de Sofía. Te esperamos.")
    expect(
      confirmationReply([
        { patientName: "Sofía Salas", self: false, was: "confirmada" },
        { patientName: "Pedro Salas", self: false, was: "ya_confirmada" },
      ]),
    ).toBe("¡Listo! Confirmé la cita de Sofía. La cita de Pedro ya estaba confirmada. Te esperamos.")
    expect(confirmationReply([{ patientName: "Sofía Salas", self: false, was: "ya_confirmada" }])).toBe(
      "La cita de Sofía ya estaba confirmada. ¡Te esperamos!",
    )
  })
})
