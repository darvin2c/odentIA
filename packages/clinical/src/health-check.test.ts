import { describe, expect, it } from "vitest"
import { addCalendarMonths, healthCheckDue } from "./health-check.js"

describe("¿Cambió algo? (mesa del 13 nov, entrega 10)", () => {
  const said = new Date("2026-11-13T19:27:00Z")

  it("se le pregunta cuando su última declaración tiene más de un mes", () => {
    expect(healthCheckDue(said, new Date("2027-02-18T15:00:00Z"))).toBe(true)
    expect(healthCheckDue(said, new Date("2026-12-13T19:28:00Z"))).toBe(true)
  })

  it("dentro del mes no se le pregunta: una sesión semanal no lo repite", () => {
    expect(healthCheckDue(said, new Date("2026-11-20T15:00:00Z"))).toBe(false)
    expect(healthCheckDue(said, new Date("2026-12-13T19:27:00Z"))).toBe(false)
  })

  it("sin ninguna declaración no se le pregunta esto", () => {
    expect(healthCheckDue(null, new Date("2027-05-18T15:00:00Z"))).toBe(false)
  })

  it("un mes desde el 31 de enero termina en el último día de febrero, no en marzo", () => {
    expect(addCalendarMonths(new Date("2027-01-31T10:00:00Z"), 1).toISOString()).toBe("2027-02-28T10:00:00.000Z")
    expect(addCalendarMonths(new Date("2028-01-31T10:00:00Z"), 1).toISOString()).toBe("2028-02-29T10:00:00.000Z")
    expect(addCalendarMonths(new Date("2026-12-15T10:00:00Z"), 1).toISOString()).toBe("2027-01-15T10:00:00.000Z")
  })
})
