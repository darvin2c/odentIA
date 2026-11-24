import { describe, expect, it } from "vitest"
import { snapshotDays } from "./odontogram-studio"

// Lienzo del 24 nov: «Ver estado al» ofrecía cada momento con segundos; ahora, un día por línea.
describe("«Ver estado al» por día", () => {
  const instants = [
    "2026-11-03T16:22:26Z",
    "2026-11-23T15:01:00Z",
    "2026-11-23T15:20:00Z",
    "2026-11-23T16:45:00Z",
    "2026-11-24T14:00:00Z",
  ]

  it("un día por línea, del más nuevo al más viejo, con cómo quedó al terminar ese día", () => {
    const days = snapshotDays(instants, "2026-11-25")
    expect(days.map((day) => day.value)).toEqual([
      "2026-11-24T14:00:00Z",
      "2026-11-23T16:45:00Z",
      "2026-11-03T16:22:26Z",
    ])
    expect(days[1]?.label).toMatch(/3 cambios$/)
    expect(days[2]?.label).toMatch(/1 cambio$/)
  })

  it("hoy no va: es lo mismo que «Actual»", () => {
    expect(snapshotDays(instants, "2026-11-24").map((day) => day.value)).not.toContain("2026-11-24T14:00:00Z")
  })
})
