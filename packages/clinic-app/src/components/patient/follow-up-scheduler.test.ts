import { describe, expect, it } from "vitest"
import { proposeControlSlot } from "./follow-up-scheduler"

const TZ = "America/Lima"
const professionals = [
  { id: "hugo", label: "Hugo Paredes", nextFree: null },
  { id: "jose", label: "José Ramírez", nextFree: null },
]

describe("la hora que propone «Programar control» (QA del 10 nov, B4 y B5)", () => {
  it("quien lo indicó sin horario en la sede no se propone: va la primera hora libre de quien atiende", () => {
    // El control toca el domingo 9 de mayo; nadie atiende el domingo y el dueño no tiene horario.
    const proposal = proposeControlSlot(
      {
        timeZone: TZ,
        professionals,
        free: [
          {
            professionalUserId: "jose",
            startsAt: "2027-05-10T15:00:00.000Z",
            endsAt: "2027-05-10T18:00:00.000Z",
          },
          {
            professionalUserId: "hugo",
            startsAt: "2027-05-10T14:00:00.000Z",
            endsAt: "2027-05-10T17:00:00.000Z",
          },
        ],
      },
      { indicatedBy: "dueno", durationMin: 30 },
    )
    expect(proposal).toEqual({ date: "2027-05-10", professionalUserId: null })
  })

  it("quien lo indicó, si atiende y tiene hora en el plazo, va primero aunque otro tenga antes", () => {
    const proposal = proposeControlSlot(
      {
        timeZone: TZ,
        professionals,
        free: [
          {
            professionalUserId: "jose",
            startsAt: "2026-11-10T14:00:00.000Z",
            endsAt: "2026-11-10T18:00:00.000Z",
          },
          {
            professionalUserId: "hugo",
            startsAt: "2026-11-12T14:00:00.000Z",
            endsAt: "2026-11-12T18:00:00.000Z",
          },
        ],
      },
      { indicatedBy: "hugo", durationMin: 30 },
    )
    expect(proposal).toEqual({ date: "2026-11-12", professionalUserId: "hugo" })
  })

  it("un tramo que no alcanza la duración no se elige si hay otro donde cabe", () => {
    const proposal = proposeControlSlot(
      {
        timeZone: TZ,
        professionals,
        free: [
          // Martes 10 a las 20:45 de Lima: quedan 15 minutos.
          {
            professionalUserId: "jose",
            startsAt: "2026-11-11T01:45:00.000Z",
            endsAt: "2026-11-11T02:00:00.000Z",
          },
          {
            professionalUserId: "jose",
            startsAt: "2026-11-11T14:00:00.000Z",
            endsAt: "2026-11-11T16:00:00.000Z",
          },
        ],
      },
      { indicatedBy: null, durationMin: 45 },
    )
    expect(proposal).toEqual({ date: "2026-11-11", professionalUserId: null })
  })

  it("sin nada libre en el plazo no propone: se abre como antes", () => {
    expect(
      proposeControlSlot(
        { timeZone: TZ, professionals, free: [] },
        { indicatedBy: "hugo", durationMin: 30 },
      ),
    ).toBeNull()
  })
})
