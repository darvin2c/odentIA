import { describe, expect, it } from "vitest"
import {
  CASH_TERMS,
  cashTermLabel,
  cashTermLeaves,
  cashClosedWords,
  cashTermShort,
  type DayMovement,
  financeKeys,
  groupDayMovements,
  voidedCashNote,
} from "./finance-cash"
import { accountBalances, accountBalanceTitle, amountHelpText, partialSplitWords, sentence } from "./finance-collect"
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

describe("la cuenta del paciente con dos monedas", () => {
  const row = (currency: string, porCobrar: number, aFavor = 0, saldo = porCobrar - aFavor) => ({
    currency,
    porCobrar,
    pagado: 0,
    aFavor,
    saldo,
  })

  it("la otra moneda sale solo si tiene algo; la del negocio, siempre", () => {
    const paid = [row("PEN", 0), row("USD", 0)]
    expect(accountBalances(paid, "PEN", "USD").map((item) => item.currency)).toEqual(["PEN"])
    expect(accountBalances([row("PEN", 0), row("USD", 0, 500)], "PEN", "USD")).toHaveLength(2)
    // Con una sola moneda, todo como antes.
    expect(accountBalances(paid, "PEN", null)).toHaveLength(2)
    expect(accountBalances([], "PEN", "USD")).toEqual([row("PEN", 0)])
  })

  it("cada bloque se titula con su moneda dicha", () => {
    expect(accountBalanceTitle("USD", "es-PE", "USD")).toBe("Dólares")
    expect(accountBalanceTitle("EUR", "es-PE", null)).toBe("EUR")
  })
})

describe("lo que dice el importe al cobrar", () => {
  const base = {
    hasSecond: true,
    advance: false,
    pay: "PEN",
    debt: "USD",
    cancels: 100_000,
    due: 100_000,
    locale: "es-PE",
  }
  const spaced = (text: string) => text.replace(/ /g, " ")

  it("si también debe en la otra moneda, dice en cuál queda al día", () => {
    expect(spaced(amountHelpText({ ...base, owesOther: true }))).toBe(
      "Cancela USD 1,000.00: queda al día en dólares.",
    )
    expect(spaced(amountHelpText({ ...base, owesOther: false }))).toBe(
      "Cancela USD 1,000.00: queda al día.",
    )
    expect(amountHelpText({ ...base, hasSecond: false, owesOther: false })).toBe(
      "Si paga una parte, el resto queda por cobrar.",
    )
  })
})

describe("al cerrar una caja", () => {
  it("dice cuál se cerró y cuál falta, si la otra tiene movimientos", () => {
    expect(cashClosedWords("USD", "PEN", "es-PE")).toBe("Caja de dólares cerrada. Falta cerrar la de soles.")
    expect(cashClosedWords("USD", null, "es-PE")).toBe("Caja de dólares cerrada.")
    expect(cashClosedWords(null, null, "es-PE")).toBe("Caja cerrada.")
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
    // Lo que volvió de gastos (o una comisión devuelta) más de lo gastado entra, con su nombre.
    expect(cashTermLeaves(expenses, -30000)).toBe(false)
    expect(cashTermLabel(expenses, -30000)).toBe("Volvió de gastos y comisiones")
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

describe("lo devuelto de comisiones que se anuló, en Caja", () => {
  const voided = {
    id: "v1",
    kind: "gasto",
    direction: "ingreso",
    concept: "Devolución de comisiones",
    currency: "PEN",
    amountCents: 21000,
    createdAt: "2026-11-08T15:00:00.000Z",
    voidedAt: "2026-11-08T16:00:00.000Z",
    voidReason: "Era de otro",
  }

  it("no desaparece: queda tachado con su motivo, como un ticket anulado, y no cuenta como gasto", () => {
    const entries = groupDayMovements([], [], [voided])
    expect(entries).toEqual([
      expect.objectContaining({ type: "gasto", concept: "Devolución de comisiones", leaves: false, amountCents: 21000, voided: { reason: "Era de otro" } }),
    ])
  })

  it("el desglose del efectivo lo explica, en su caja", () => {
    const money = (cents: number) => `S/ ${(cents / 100).toFixed(2)}`
    expect(voidedCashNote([voided], "PEN", money)).toBe("La devolución de comisiones de S/ 210.00 se anuló: ya no suma en la caja.")
    expect(voidedCashNote([voided], "USD", money)).toBeNull()
    expect(voidedCashNote(undefined, "PEN", money)).toBeNull()
  })
})

it("un pago parcial de varios conceptos dice a cuál va, lo más antiguo primero (QA del 9 nov, repaso 3)", () => {
  const items = [
    { description: "Consulta", saldoCents: 5000 },
    { description: "Endodoncia", saldoCents: 45000 },
  ]
  const spaced = (text: string) => text.replace(/ /g, " ")
  expect(spaced(partialSplitWords(items, 20000, "PEN", "es-PE") ?? "")).toBe(
    "Va primero a lo más antiguo: Consulta S/ 50.00 · Endodoncia S/ 150.00.",
  )
  // Todo, nada o un solo concepto: no hay reparto que decir.
  expect(partialSplitWords(items, 50000, "PEN", "es-PE")).toBeNull()
  expect(partialSplitWords(items, 0, "PEN", "es-PE")).toBeNull()
  expect(partialSplitWords(items.slice(0, 1), 2000, "PEN", "es-PE")).toBeNull()
  // Lo que tiene a favor se usa primero: 100 nuevos y 50 a favor.
  expect(spaced(partialSplitWords(items, 10000, "PEN", "es-PE", 5000) ?? "")).toBe(
    "Con lo que tiene a favor, va primero a lo más antiguo: Consulta S/ 50.00 · Endodoncia S/ 100.00.",
  )
  expect(partialSplitWords(items, 45000, "PEN", "es-PE", 5000)).toBeNull()
})
