import { describe, expect, it } from "vitest"
import {
  CASH_TERMS,
  cashTermLabel,
  cashTermLeaves,
  type DayMovement,
  financeKeys,
  groupDayMovements,
} from "./finance-cash"
import { type CollectTicketRow, crossTender } from "./finance-collect"

const tender = {
  currency: "USD",
  amountCents: 8000,
  rate: "3.75",
  businessCurrency: "PEN",
  otherCurrency: "USD",
  valueCents: 30000,
  changeCents: 7500,
  changeCurrency: "PEN",
}

const ticket = (currency: string, snapshotTender: typeof tender | null): Pick<CollectTicketRow, "currency" | "snapshot"> => ({
  currency,
  snapshot: { tender: snapshotTender } as CollectTicketRow["snapshot"],
})

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

describe("el ticket con dos monedas", () => {
  it("lleva el bloque solo si usa dos: entró en otra o el vuelto se dio en otra", () => {
    expect(crossTender(ticket("PEN", tender))).toEqual(tender)
    // Debe USD y paga USD con vuelto en dólares: una sola moneda, como siempre.
    const sameCurrency = { ...tender, changeCurrency: "USD" }
    expect(crossTender(ticket("USD", sameCurrency))).toBeNull()
    // Debe USD y paga USD con vuelto en soles: dos monedas.
    expect(crossTender(ticket("USD", tender))).toEqual(tender)
    expect(crossTender(ticket("PEN", null))).toBeNull()
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

  it("cada caja se pide y se invalida aparte: sin moneda, la clave de siempre", () => {
    expect(financeKeys.cash("sede")).toEqual(["finance-cash", "sede"])
    expect(financeKeys.cash("sede", "USD")).toEqual(["finance-cash", "sede", "USD"])
  })
})
