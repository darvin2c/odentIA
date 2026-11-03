import { describe, expect, it } from "vitest"
import {
  CASH_TERMS,
  cashTermLabel,
  cashTermLeaves,
  cashTermShort,
  type DayMovement,
  financeKeys,
  groupDayMovements,
} from "./finance-cash"
import { sentence } from "./finance-collect"
import { cashCollectedText, type WorkspaceCash } from "./workspace"
const movement = (over: Partial<DayMovement>): DayMovement => ({
  id: "m1",
  shiftId: "s1",
  direction: "ingreso",
  kind: "cobro",
  amountCents: 8000,
  currency: "USD",
  method: "Efectivo",
  methodTypeCode: "10",
  concept: "Ticket 12",
  patientPaymentId: "p1",
  expenseId: null,
  createdAt: "2026-11-02T14:00:00.000Z",
  ticketId: "t1",
  ticketNumber: 12,
  patientId: "pa1",
  patientName: "Carlos Vega",
  ...over,
})

describe("Inicio › Caja de hoy", () => {
  const cash = (collectedCents: number, second: number, tickets: number): WorkspaceCash => ({
    branchId: "s",
    branchName: "Sede",
    currency: "PEN",
    timezone: "America/Lima",
    collectedCents,
    secondCollected: { currency: "USD", cents: second },
    tickets,
    toCollect: [],
  })
  const spaced = (text: string) => text.replace(/ /g, " ")

  it("la otra moneda en cero no se dice", () => {
    expect(spaced(cashCollectedText(cash(0, 0, 0), "es-PE"))).toBe("Cobrado S/ 0.00 en 0 cobros")
    expect(spaced(cashCollectedText(cash(15000, 0, 1), "es-PE"))).toBe("Cobrado S/ 150.00 en 1 cobro")
    expect(spaced(cashCollectedText(cash(0, 8000, 1), "es-PE"))).toBe(
      "Cobrado S/ 0.00 + USD 80.00 en 1 cobro",
    )
  })
})

describe("las frases del cambio", () => {
  it("una hora que ya termina en punto no lleva otro", () => {
    expect(sentence("lo puso Ana a las 09:04 a. m.")).toBe("lo puso Ana a las 09:04 a. m.")
    expect(sentence("lo puso Ana a las 21:04")).toBe("lo puso Ana a las 21:04.")
  })
})

describe("la caja con dos monedas", () => {
  it("el vuelto de un cobro no es otro renglón: lo dice el renglón de su ticket", () => {
    const cancels = {
      currency: "PEN",
      totalCents: 30000,
      rate: "3.75",
      cashReceivedCents: 10000,
      changeCents: 7500,
      changeCurrency: "PEN",
    }
    const entries = groupDayMovements([
      movement({ cancels }),
      movement({ id: "m2", kind: "vuelto", amountCents: 2000 }),
      movement({ id: "m3", kind: "vuelto", direction: "egreso", amountCents: 7500, currency: "PEN" }),
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ type: "cobro", currency: "USD", totalCents: 8000, cancels })
  })

  it("lo que compensa un vuelto en una caja cerrada sí se ve, y puede entrar", () => {
    const entries = groupDayMovements([
      movement({ id: "m4", kind: "vuelto", amountCents: 7500, currency: "PEN", patientPaymentId: null, concept: "Compensación por anulación" }),
    ])
    expect(entries).toMatchObject([{ type: "vuelto", leaves: false, amountCents: 7500, currency: "PEN" }])
  })

  it("el vuelto va con su signo; los demás términos, con el de su renglón", () => {
    const change = CASH_TERMS.find((term) => term.key === "cashChangeCents")
    const expenses = CASH_TERMS.find((term) => term.key === "cashExpensesCents")
    if (!change || !expenses) throw new Error("Faltan términos")
    expect(cashTermLeaves(change, -7500)).toBe(true)
    expect(cashTermLeaves(change, 2000)).toBe(false)
    expect(cashTermLeaves(expenses, 0)).toBe(true)
    expect(cashTermLabel(change, -7500)).not.toBe(cashTermLabel(change, 2000))
    expect(cashTermLabel(expenses, 500)).toBe(expenses.label)
  })

  it("el vuelto cruzado dice sus dos monedas, en la caja y en su tarjeta", () => {
    const change = CASH_TERMS.find((term) => term.key === "cashChangeCents")!
    const soles = { box: "PEN", other: "USD", locale: "es-PE" }
    const dollars = { box: "USD", other: "PEN", locale: "es-PE" }
    expect(cashTermLabel(change, -7500, soles)).toBe("Vuelto en soles de cobros en dólares")
    expect(cashTermLabel(change, 2000, dollars)).toBe("Dólares que quedaron por vueltos dados en soles")
    expect(cashTermShort(change, 2000, dollars)).toBe("dólares que quedaron por vueltos dados en soles")
    expect(cashTermShort(change, -7500, soles)).toBe("vuelto en soles de cobros en dólares")
    // Lo demás, como siempre.
    const collected = CASH_TERMS.find((term) => term.key === "cashCollectedCents")!
    expect(cashTermShort(collected, 8000, dollars)).toBe("cobros")
  })

  it("cada caja se pide y se invalida aparte: sin moneda, la clave de siempre", () => {
    expect(financeKeys.cash("sede")).toEqual(["finance-cash", "sede"])
    expect(financeKeys.cash("sede", "USD")).toEqual(["finance-cash", "sede", "USD"])
  })
})
