import { afterEach, describe, expect, it } from "vitest"
import { setOrgLocale } from "./locale"
import { formatPortalDate, isPortalSessionActive, type PortalBudget, portalBudgetTotalText } from "./portal"

afterEach(() => {
  setOrgLocale(undefined)
})

describe("portal: fechas de la clínica y sesiones que sirven", () => {
  it("dice la hora en la zona de la clínica, o en la de la sede si se da, no en la del navegador", () => {
    // 15:00 UTC son las 10:00 en Lima y las 9:00 en Ciudad de México.
    setOrgLocale("es-PE", "America/Lima")
    expect(formatPortalDate("2026-10-20T15:00:00.000Z")).toContain("10:00")
    expect(
      formatPortalDate("2026-10-20T15:00:00.000Z", { timeZone: "America/Mexico_City" }),
    ).toContain("9:00")
  })

  it("una sesión cerrada no está activa aunque aún no venza", () => {
    const now = Date.parse("2026-10-20T15:00:00.000Z")
    const open = { expiresAt: "2026-10-21T15:00:00.000Z", revokedAt: null }
    expect(isPortalSessionActive(open, now)).toBe(true)
    expect(isPortalSessionActive({ ...open, revokedAt: "2026-10-20T14:00:00.000Z" }, now)).toBe(
      false,
    )
    expect(isPortalSessionActive({ ...open, expiresAt: "2026-10-20T14:00:00.000Z" }, now)).toBe(
      false,
    )
  })
})

// QA del 26 nov (desarrollo, H3): con dos caminos sin elegir, la lista decía «S/ 650.00», el de la A.
describe("el total de un presupuesto en la lista", () => {
  const option = (id: string, totalCents: number, decision = "pendiente") => ({ id, label: id, isRecommended: false, decision, totalCents })
  const budget = (options: PortalBudget["options"]) => ({ currency: "PEN", locale: "es-PE", totalCents: 65000, options }) as unknown as PortalBudget

  it("con varias opciones y ninguna elegida dice el de cada una, no uno como si fuera el del presupuesto", () => {
    const text = portalBudgetTotalText(budget([option("A", 65000), option("B", 15000)]))
    expect(text).toMatch(/^2 opciones: .*650.* o .*150/)
  })

  it("con una sola, o con una elegida, dice el total", () => {
    expect(portalBudgetTotalText(budget([option("A", 65000)]))).not.toContain("opciones")
    expect(portalBudgetTotalText(budget([option("A", 65000, "elegida"), option("B", 15000, "no_elegida")]))).not.toContain("opciones")
  })
})
