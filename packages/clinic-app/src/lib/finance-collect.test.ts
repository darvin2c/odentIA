import { describe, expect, it } from "vitest"
import { accountHeaderWords, balanceDetailWords, paidCommissionWarnings, pendingCostWords, refundLines } from "./finance-collect"

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

describe("el detalle del saldo en el Resumen (C19)", () => {
  const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`
  const row = (porCobrar: number, pagado: number, aFavor = 0) => ({
    currency: "PEN",
    porCobrar,
    pagado,
    aFavor,
    saldo: Math.max(porCobrar - aFavor, 0),
  })
  /** Un cargo abierto de S/ 650 con lo que ya se pagó de él. */
  const open = (paidCents: number, advancePaidCents = 0) => [
    { currency: "PEN", paidCents, advancePaidCents },
  ]
  it("con S/ 300 pagados no dice «sin pago aplicado»", () => {
    expect(balanceDetailWords(row(35000, 30000), money, open(30000))).toBe(
      "Debe: S/ 350.00 · Ya pagó: S/ 300.00",
    )
    expect(balanceDetailWords(row(65000, 0), money, open(0))).toBe("Cargos emitidos sin pago aplicado.")
    expect(balanceDetailWords(row(65000, 10000, 10000), money, open(0))).toBe(
      "Debe: S/ 650.00 · A favor: S/ 100.00 · Saldo: S/ 550.00",
    )
  })

  // Revisión del 16 nov (R5): el año pasado pagó S/ 1,200 completos y hoy tiene un cargo nuevo de
  // S/ 300 sin pagar. «Ya pagó» es de lo que debe ahora, no de todo lo pagado alguna vez.
  it("lo pagado de cargos ya cerrados no cuenta como «Ya pagó» de lo que debe ahora", () => {
    expect(balanceDetailWords(row(30000, 120000), money, open(0))).toBe("Cargos emitidos sin pago aplicado.")
    // El adelanto para el tratamiento sí es lo pagado de lo que debe.
    expect(balanceDetailWords(row(60000, 150000), money, open(0, 30000))).toBe(
      "Debe: S/ 600.00 · Ya pagó: S/ 300.00",
    )
    // Lo de otra moneda no se suma.
    expect(
      balanceDetailWords(row(30000, 120000), money, [{ currency: "USD", paidCents: 5000 }]),
    ).toBe("Cargos emitidos sin pago aplicado.")
  })
})

// QA en local del 19 nov: tras devolver S/ 20 de una resina de S/ 180 (lo devuelto queda a favor,
// ADR 0068), la cabecera decía «debe S/ 140.00», la tarjeta de Cobros «Debe S/ 160.00» y el
// renglón «Costó 160.00».
describe("la cuenta tras una devolución que quedó a favor", () => {
  const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`
  const afterReturn = { currency: "PEN", porCobrar: 16000, pagado: 2000, aFavor: 2000, saldo: 14000 }

  it("la cabecera dice lo mismo que la tarjeta: «Falta pagar S/ 140.00», no «debe»", () => {
    expect(accountHeaderWords([afterReturn], money)).toBe("falta pagar PEN 140.00")
  })
  it("sin nada a favor, «debe» es lo que dice la tarjeta en «Debe»", () => {
    expect(accountHeaderWords([{ currency: "PEN", porCobrar: 16000, pagado: 0, aFavor: 0, saldo: 16000 }], money)).toBe(
      "debe PEN 160.00",
    )
  })
  it("lo que le queda a favor se dice, como «Le queda a favor» de la tarjeta", () => {
    expect(accountHeaderWords([{ currency: "PEN", porCobrar: 0, pagado: 2000, aFavor: 2000, saldo: 0 }], money)).toBe(
      "tiene PEN 20.00 a favor",
    )
    expect(accountHeaderWords([{ currency: "PEN", porCobrar: 0, pagado: 0, aFavor: 0, saldo: 0 }], money)).toBe(
      "no debe nada",
    )
  })
  it("el renglón dice lo que costó y lo que se le devolvió", () => {
    const plain = (cents: number) => (cents / 100).toFixed(2)
    expect(pendingCostWords({ totalCents: 16000, paidCents: 0, returnedCents: 2000 }, plain)).toBe(
      "Costó 180.00 · se le devolvió 20.00 · pagó 0.00",
    )
    expect(pendingCostWords({ totalCents: 18000, paidCents: 2000 }, plain)).toBe("Costó 180.00 · pagó 20.00")
  })
})
