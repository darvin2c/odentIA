import { describe, expect, it } from "vitest"
import type { BudgetWithTotals } from "../../../lib/budgets"
import type { PlanItem } from "../../../lib/patients"
import { quotableItems } from "./plan-budgets"

const item = (over: Partial<PlanItem>): PlanItem =>
  ({
    id: "i",
    planId: "plan",
    budgetId: null,
    decision: "pendiente",
    decisionStatus: "pendiente",
    status: "pendiente",
    priceCents: 100_00,
    ...over,
  }) as PlanItem

const budgets = (entries: Array<[string, string]>): Map<string, BudgetWithTotals> =>
  new Map(entries.map(([id, status]) => [id, { id, status } as BudgetWithTotals]))

// Repaso final de la ficha del 10 nov (M1): al anular el presupuesto que llevaba la opción que
// no eligió, la exodoncia de la 46 quedaba sin presupuesto y «Preparar presupuesto con lo
// pendiente (1)» la volvía a armar.
describe("lo pendiente que entra a un presupuesto nuevo", () => {
  it("la opción que no eligió no cuenta, aunque su presupuesto se haya anulado", () => {
    const rows = [
      item({ id: "exodoncia-sin-presupuesto", decision: "no_elegida" }),
      item({ id: "exodoncia-anulado", decision: "no_elegida", budgetId: "b" }),
    ]
    expect(quotableItems(rows, budgets([["b", "cancelado"]]))).toEqual([])
  })

  it("lo que no tiene presupuesto, lo que dijo que no y lo de un presupuesto anulado sí cuentan", () => {
    const rows = [
      item({ id: "nuevo" }),
      item({ id: "rechazado", decision: "rechazado", budgetId: "vigente" }),
      item({ id: "anulado", budgetId: "b" }),
      item({ id: "vigente", budgetId: "vigente" }),
    ]
    const ids = quotableItems(
      rows,
      budgets([
        ["b", "cancelado"],
        ["vigente", "presentado"],
      ]),
    ).map((row) => row.id)
    expect(ids).toEqual(["nuevo", "rechazado", "anulado"])
  })
})
