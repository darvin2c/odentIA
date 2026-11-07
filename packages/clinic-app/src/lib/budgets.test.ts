import { describe, expect, it } from "vitest"
import { type BudgetLine, type BudgetOption, budgetPaths, commonPlanItemIds } from "./budgets"

function option(id: string, position: number, extra: Partial<BudgetOption> = {}): BudgetOption {
  return {
    id,
    position,
    label: `Opción ${String.fromCharCode(64 + position)}`,
    isRecommended: false,
    decision: "pendiente",
    lineCount: 0,
    totalCents: null,
    acceptedCents: null,
    tariffTotalCents: null,
    discountCents: null,
    ...extra,
  }
}

function line(optionId: string, planItemId: string, priceCents: number, extra: Partial<BudgetLine> = {}): BudgetLine {
  return {
    id: `${optionId}-${planItemId}`,
    planId: "plan",
    budgetId: "budget",
    optionId,
    planItemId,
    serviceId: null,
    title: planItemId,
    scope: "tooth",
    toothNumber: 46,
    surfaces: [],
    quadrant: null,
    arch: null,
    priceCents,
    tariffPriceCents: priceCents,
    priceReason: null,
    promotionId: null,
    promotionName: null,
    promotionMode: null,
    billingMode: "treatment",
    sessionsPlanned: null,
    lineTotalCents: priceCents,
    tariffLineTotalCents: priceCents,
    lineDiscountCents: null,
    currency: "PEN",
    decision: "pendiente",
    itemStatus: "planificado",
    ...extra,
  }
}

// Ana: la resina 36 y la profilaxis van en los dos caminos; la 46 se conserva o se extrae.
const ana = {
  options: [option("extraer", 2), option("conservar", 1, { isRecommended: true })],
  items: [
    line("conservar", "resina", 150_00, { toothNumber: 36 }),
    line("conservar", "profilaxis", 80_00, { scope: "general", toothNumber: null }),
    line("conservar", "endodoncia", 600_00),
    line("conservar", "corona", 900_00),
    line("extraer", "resina", 150_00, { toothNumber: 36 }),
    line("extraer", "profilaxis", 80_00, { scope: "general", toothNumber: null }),
    line("extraer", "exodoncia", 200_00),
    line("extraer", "implante", 2500_00),
  ],
}

describe("commonPlanItemIds", () => {
  it("es común lo que está en todas las opciones con las mismas condiciones", () => {
    expect([...commonPlanItemIds(ana.items, 2)].sort()).toEqual(["profilaxis", "resina"])
  })

  it("con otro precio, otro cobro, otras sesiones u otra promoción en un camino ya no es común", () => {
    const changes: Array<Partial<BudgetLine>> = [
      { priceCents: 120_00 },
      { billingMode: "session" },
      { sessionsPlanned: 3 },
      { promotionId: "promo" },
    ]
    for (const change of changes) {
      const items = ana.items.map((entry) =>
        entry.optionId === "extraer" && entry.planItemId === "resina" ? { ...entry, ...change } : entry,
      )
      expect(commonPlanItemIds(items, 2).has("resina")).toBe(false)
    }
  })

  it("con tres caminos, lo que está solo en dos no es común", () => {
    const items = [line("a", "x", 100), line("b", "x", 100), line("a", "y", 50), line("b", "y", 50), line("c", "y", 50)]
    expect([...commonPlanItemIds(items, 3)]).toEqual(["y"])
  })
})

describe("budgetPaths", () => {
  it("lo común va una vez y cada camino, en su orden, con lo suyo", () => {
    const view = budgetPaths(ana)
    expect(view.common.map((entry) => entry.planItemId)).toEqual(["resina", "profilaxis"])
    // Una vez cada tratamiento, con la línea de la opción que vale (la recomendada).
    expect(view.common.every((entry) => entry.optionId === "conservar")).toBe(true)
    expect(view.paths.map((path) => path.option.id)).toEqual(["conservar", "extraer"])
    expect(view.paths.map((path) => path.own.map((entry) => entry.planItemId))).toEqual([
      ["endodoncia", "corona"],
      ["exodoncia", "implante"],
    ])
    expect(view.exclusive.map((entry) => entry.planItemId)).toEqual(["endodoncia", "corona", "exodoncia", "implante"])
  })

  it("un tratamiento con otro precio en cada camino es de los caminos, y cuenta una vez", () => {
    const items = ana.items.map((entry) =>
      entry.optionId === "extraer" && entry.planItemId === "profilaxis" ? { ...entry, priceCents: 60_00 } : entry,
    )
    const view = budgetPaths({ ...ana, items })
    expect(view.common.map((entry) => entry.planItemId)).toEqual(["resina"])
    expect(view.paths[1]?.own.map((entry) => entry.planItemId)).toEqual(["profilaxis", "exodoncia", "implante"])
    expect(view.exclusive.filter((entry) => entry.planItemId === "profilaxis")).toHaveLength(1)
  })
})
