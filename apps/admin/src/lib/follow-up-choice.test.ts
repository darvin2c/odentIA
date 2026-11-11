import { describe, expect, it } from "vitest"
import { openingFollowUpChoice } from "./follow-up-choice"

describe("lo que viene elegido al abrir una solicitud", () => {
  it("con una fecha pendiente de hoy en adelante, «Mantener»", () => {
    expect(openingFollowUpChoice("2026-11-13", "2026-11-13")).toBe("mantener")
    expect(openingFollowUpChoice("2026-11-20", "2026-11-13")).toBe("mantener")
  })

  it("con una fecha que ya pasó («Tocaba el…»), «Mañana»: anotar no cierra el seguimiento sin elegirlo", () => {
    expect(openingFollowUpChoice("2026-11-12", "2026-11-13")).toBe("manana")
  })

  it("sin fecha pendiente, o antes de saber qué día es hoy, nada", () => {
    expect(openingFollowUpChoice(null, "2026-11-13")).toBeNull()
    expect(openingFollowUpChoice("2026-11-12", null)).toBeNull()
  })
})
