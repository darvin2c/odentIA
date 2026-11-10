/**
 * «Lo está pensando» con una aceptación parcial (repaso final de la ficha del 10 nov, M2):
 * aceptó la resina y dejó la profilaxis para después. La fila nombraba la resina y decía el
 * total (S/ 340); recepción llamaba por algo ya aceptado. Sin base: solo la regla.
 */
import { describe, expect, it } from "vitest"
import type { BudgetWithTotals } from "./budgets.js"
import { awaitingLines, awaitingLinesText } from "./plan-next.js"

type Line = BudgetWithTotals["items"][number]
const line = (planItemId: string, decision: string, cents: number | null, optionId = "a"): Line =>
  ({ planItemId, decision, lineTotalCents: cents, currency: "PEN", optionId }) as Line
const option = (id: string, decision = "pendiente", isRecommended = false) =>
  ({ id, decision, isRecommended }) as BudgetWithTotals["options"][number]

describe("lo que espera respuesta de un presupuesto", () => {
  it("con una parte aceptada, solo lo que falta responder y lo que suma eso", () => {
    const budget = {
      options: [option("a")],
      items: [line("resina", "aceptado", 220_00), line("profilaxis", "pospuesto", 120_00)],
    }
    const open = awaitingLines(budget)
    expect(open?.map((row) => row.planItemId)).toEqual(["profilaxis"])
    expect(awaitingLinesText(open!, "es-PE", "Profilaxis")).toMatch(/^Profilaxis · S\/\s?120\.00$/)
  })

  it("sin nada respondido, se habla del presupuesto entero", () => {
    const budget = {
      options: [option("a")],
      items: [line("resina", "pendiente", 220_00), line("profilaxis", "pendiente", 120_00)],
    }
    expect(awaitingLines(budget)).toBeNull()
  })

  it("con dos opciones, solo las líneas de la elegida", () => {
    const budget = {
      options: [option("a", "elegida"), option("b", "no_elegida")],
      items: [
        line("endodoncia", "aceptado", 450_00, "a"),
        line("corona", "pospuesto", 900_00, "a"),
        line("exodoncia", "pendiente", 150_00, "b"),
      ],
    }
    expect(awaitingLines(budget)?.map((row) => row.planItemId)).toEqual(["corona"])
  })

  it("si falta un precio, lo dice", () => {
    expect(awaitingLinesText([line("x", "pendiente", null)], "es-PE", "")).toBe(
      "1 tratamiento · falta algún precio",
    )
  })
})
