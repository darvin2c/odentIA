import { describe, expect, it } from "vitest"
import { followUpHint, openingFollowUpChoice } from "./follow-up-choice"

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

describe("lo que dice el cajón que pasa en Inicio", () => {
  it("con fecha vuelve a salir; si es solo de administración, solo para ella", () => {
    expect(followUpHint({ nextDay: "2026-11-18", invitationSoon: false, adminOnly: false })).toBe("Ese día vuelve a salir en Inicio.")
    expect(followUpHint({ nextDay: "2026-11-18", invitationSoon: false, adminOnly: true })).toBe(
      "Ese día vuelve a salir en Inicio, solo para Administración.",
    )
  })

  it("sin fecha no vuelve, salvo que su invitación por vencer o vencida la tenga ahí igual", () => {
    expect(followUpHint({ nextDay: null, invitationSoon: false, adminOnly: false })).toBe("Sin fecha, no vuelve a salir en Inicio.")
    expect(followUpHint({ nextDay: null, invitationSoon: true, adminOnly: false })).toBe(
      "Sin fecha, no sale en Inicio por el seguimiento. Mientras su invitación esté por vencer o vencida, sigue en «Prospectos por responder».",
    )
    expect(followUpHint({ nextDay: "2026-11-18", invitationSoon: true, adminOnly: false })).toContain("sigue en «Prospectos por responder»")
  })
})
