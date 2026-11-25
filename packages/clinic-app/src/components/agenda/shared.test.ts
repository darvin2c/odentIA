import { describe, expect, it } from "vitest"
import { whenSaid } from "./shared"

const TZ = "America/Lima"

describe("whenSaid", () => {
  it("dice hoy, mañana o el día de esta semana sin mes", () => {
    expect(whenSaid("2026-11-23T22:00:00.000Z", TZ, "2026-11-23")).toBe("hoy a las 17:00")
    expect(whenSaid("2026-11-24T15:00:00.000Z", TZ, "2026-11-23")).toBe("mañana a las 10:00")
    expect(whenSaid("2026-11-27T14:00:00.000Z", TZ, "2026-11-23")).toBe("el vie 27 a las 09:00")
  })

  it("lejos de esta semana dice el mes, para no confundir el día", () => {
    expect(whenSaid("2027-01-12T14:00:00.000Z", TZ, "2026-11-23")).toMatch(/^el mar 12 ene a las 09:00$/)
    expect(whenSaid("2026-11-10T14:00:00.000Z", TZ, "2026-11-23")).toMatch(/^el mar 10 nov a las 09:00$/)
  })
})
