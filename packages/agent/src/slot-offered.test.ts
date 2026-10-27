/**
 * proponer_cita solo propone un hueco que salió de buscar_huecos (en el turno
 * o en lo que recuerda el caso). Visto en Probar: ofreció las 4:00 p. m. con
 * el Dr. Diego Salas, la persona dijo «ok, agéndame con Diego» y propuso las
 * 2:00 p. m., una hora que no venía de ningún hueco.
 */
import { describe, expect, it } from "vitest"
import { slotWasOffered } from "./tools"

const ROOM = "11111111-1111-4111-8111-111111111111"
const BRANCH = "22222222-2222-4222-8222-222222222222"
const slots = {
  text: [
    "Huecos libres, ordenados por hora…",
    `- miércoles, 28 de octubre, 16:00–16:30 con Dr. Diego Salas [startsAt 2026-10-28T21:00:00.000Z · sede ${BRANCH} · unidad dental ${ROOM} · profesional pro-diego]`,
    `- miércoles, 28 de octubre, 15:00–15:30 con Dra. Ana Torres [startsAt 2026-10-28T20:00:00.000Z · sede ${BRANCH} · unidad dental ${ROOM} · profesional pro-ana]`,
  ].join("\n"),
}
const hours = {
  text: "San Isidro: lunes a viernes de 9:00 a. m. a 1:00 p. m. y de 2:00 a 6:00 p. m.",
}

describe("slotWasOffered", () => {
  it("acepta el hueco ofrecido, con el inicio escrito en otra forma", () => {
    expect(
      slotWasOffered([hours, slots], {
        startsAt: "2026-10-28T16:00:00-05:00",
        professionalUserId: "pro-diego",
        roomId: ROOM,
      }),
    ).toBe(true)
  })

  it("rechaza una hora que no salió de ningún hueco, aunque esté en el horario de atención", () => {
    expect(
      slotWasOffered([hours, slots], {
        startsAt: "2026-10-28T19:00:00.000Z",
        professionalUserId: "pro-diego",
        roomId: ROOM,
      }),
    ).toBe(false)
  })

  it("rechaza el hueco de otro profesional o de otra unidad", () => {
    expect(
      slotWasOffered([slots], {
        startsAt: "2026-10-28T20:00:00.000Z",
        professionalUserId: "pro-diego",
        roomId: ROOM,
      }),
    ).toBe(false)
    expect(
      slotWasOffered([slots], {
        startsAt: "2026-10-28T21:00:00.000Z",
        professionalUserId: "pro-diego",
        roomId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toBe(false)
  })

  it("fuera del grafo, sin evidencia del turno, no hay con qué comparar", () => {
    expect(
      slotWasOffered(undefined, {
        startsAt: "2026-10-28T19:00:00.000Z",
        professionalUserId: "pro-diego",
        roomId: ROOM,
      }),
    ).toBe(true)
  })
})
