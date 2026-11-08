import { describe, expect, it } from "vitest"
import { refundLines } from "./finance-collect"

// QA del 6 nov (M14): el ticket dice «queda a favor», «A favor» está en cero y la
// cuenta no decía adónde fueron los S/ 20.
describe("lo devuelto de un cobro, en la cuenta", () => {
  it("dice cuánto, cuándo y por qué, junto al cobro", () => {
    const lines = refundLines(
      [{ id: "r", amountCents: 2000, currency: "PEN", refundedAt: "2026-11-06T17:26:00.000Z", reason: "Devolución parcial del adelanto" }],
      (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`,
      () => "6 de noviembre",
    )
    expect(lines).toEqual(["Se devolvieron PEN 20.00 el 6 de noviembre · Devolución parcial del adelanto"])
  })
  it("sin devoluciones no dice nada", () => {
    expect(refundLines(undefined, () => "", () => "")).toEqual([])
  })
})
