import { describe, expect, it } from "vitest"
import { addDays, dayKey, dayStart, oneSlotPerStart, windowDays, windowRange } from "./booking-days"

describe("los días de «Su enlace»", () => {
  it("cuenta los días en la zona de la sede, también al cruzar de mes y de año", () => {
    expect(dayKey("2026-10-30T03:00:00.000Z", "America/Lima")).toBe("2026-10-29")
    expect(addDays("2026-10-29", 7)).toBe("2026-11-05")
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02")
    expect(addDays("2026-11-03", -7)).toBe("2026-10-27")
    expect(windowDays("2026-10-29")).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"])
  })

  it("sabe cuándo empieza el día de la sede, con cambio de hora o sin él", () => {
    expect(dayStart("2026-11-03", "America/Lima").toISOString()).toBe("2026-11-03T05:00:00.000Z")
    // Madrid deja el horario de verano el 25 de octubre de 2026: ese día empieza aún en UTC+2.
    expect(dayStart("2026-10-25", "Europe/Madrid").toISOString()).toBe("2026-10-24T22:00:00.000Z")
    expect(dayStart("2026-10-26", "Europe/Madrid").toISOString()).toBe("2026-10-25T23:00:00.000Z")
  })

  it("pide al servidor desde ahora y nunca más de 7 días", () => {
    const now = new Date("2026-10-29T21:00:00.000Z")
    expect(windowRange("2026-10-29", "America/Lima", now)).toEqual({ from: "2026-10-29T21:00:00.000Z", to: "2026-11-05T05:00:00.000Z" })
    expect(windowRange("2026-11-03", "America/Lima", now)).toEqual({ from: "2026-11-03T05:00:00.000Z", to: "2026-11-10T05:00:00.000Z" })
    // La semana que cruza el cambio de hora dura una hora más: se recorta a lo que admite el servidor.
    const madrid = windowRange("2026-10-20", "Europe/Madrid", new Date("2026-10-01T00:00:00.000Z"))
    expect(madrid.from).toBe("2026-10-19T22:00:00.000Z")
    expect(Date.parse(madrid.to) - Date.parse(madrid.from)).toBe(7 * 86_400_000)
  })

  it("con «Cualquiera» ofrece cada hora una vez, con el primero que entrega el servidor", () => {
    const slots = [
      { startsAt: "2026-11-03T14:00:00.000Z", professionalUserId: "ana" },
      { startsAt: "2026-11-03T14:00:00.000Z", professionalUserId: "luis" },
      { startsAt: "2026-11-03T14:30:00.000Z", professionalUserId: "luis" },
    ]
    expect(oneSlotPerStart(slots).map((slot) => slot.professionalUserId)).toEqual(["ana", "luis"])
  })
})
