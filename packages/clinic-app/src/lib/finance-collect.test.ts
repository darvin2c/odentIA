import { describe, expect, it } from "vitest"
import { paidCommissionWarnings, refundLines } from "./finance-collect"

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

describe("anular un ticket con la comisión ya pagada", () => {
  const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`

  it("quien administra comisiones lee de quién y cuánto quedará por descontar", () => {
    expect(
      paidCommissionWarnings(
        { commissionPaid: true, paidCommissions: [{ professionalUserId: "u1", professionalName: "Dr. Luis Prado", currency: "PEN", cents: 21000 }] },
        money,
      ),
    ).toEqual(["La comisión de Dr. Luis Prado ya se pagó: quedará PEN 210.00 por descontar de su próximo pago."])
  })

  it("caja, que no ve a quién se le paga, solo que se descontará", () => {
    expect(paidCommissionWarnings({ commissionPaid: true }, money)).toEqual([
      "Una comisión de este cobro ya se pagó: se descontará del próximo pago.",
    ])
  })

  it("sin comisión pagada, nada", () => {
    expect(paidCommissionWarnings({ commissionPaid: false }, money)).toEqual([])
    expect(paidCommissionWarnings({}, money)).toEqual([])
  })
})
