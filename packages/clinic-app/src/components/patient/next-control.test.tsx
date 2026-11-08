import { afterEach, describe, expect, it } from "vitest"
import { controlDay, controlNeedsBooking, type NextControl } from "../../lib/clinical-journey"
import { setOrgLocale } from "../../lib/locale"
import { nextControlDetail } from "./next-control"

const control = (over: Partial<NextControl>): NextControl => ({
  id: "c",
  title: "Profilaxis semestral",
  dueAt: "2026-11-18T15:00:00.000Z",
  status: "pendiente",
  overdue: false,
  appointment: null,
  ...over,
})
const now = new Date("2026-11-07T17:00:00.000Z")

afterEach(() => setOrgLocale(undefined, undefined))

describe("lo que dice el Resumen del próximo control (revisión del 7 nov)", () => {
  it("la fecha va en el formato corto de la ficha, con el año solo si no es de este", () => {
    setOrgLocale("es-PE", "America/Lima")
    expect(controlDay("2026-11-18T15:00:00.000Z", now)).toBe("18 nov")
    expect(controlDay("2027-05-06T15:00:00.000Z", now)).toBe("6 may 2027")
    expect(nextControlDetail(control({}), now)).toBe("Toca el 18 nov · falta reservar la cita")
  })
  it("con la persona hoy en la clínica, se cumple con su atención de hoy y no falta reservar nada", () => {
    setOrgLocale("es-PE", "America/Lima")
    const today = control({ dueAt: "2026-11-04T15:00:00.000Z", today: true, appointment: { id: "a", startsAt: "2026-11-07T15:00:00.000Z" } })
    expect(nextControlDetail(today, now)).toBe("Tocaba el 4 nov · se cumple con su atención de hoy")
    expect(controlNeedsBooking(today)).toBe(false)
  })
  it("reservado sin una cita en pie dice «sin cita reservada» y se puede reservar", () => {
    setOrgLocale("es-PE", "America/Lima")
    const lost = control({ status: "programado", dueAt: "2026-11-04T15:00:00.000Z" })
    expect(nextControlDetail(lost, now)).toBe("Tocaba el 4 nov · sin cita reservada")
    expect(controlNeedsBooking(lost)).toBe(true)
  })
})
