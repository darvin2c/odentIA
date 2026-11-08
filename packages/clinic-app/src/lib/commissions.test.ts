import { describe, expect, it } from "vitest"
import { debtClosureWords, discountFromWords, returnMethodWords, showAllLabel, summaryAmountWords, summaryDiscountWords } from "./commissions"

const lines = (counted: number, voided: number) => [
  ...Array.from({ length: counted }, () => ({ voidedAfterPaid: false })),
  ...Array.from({ length: voided }, () => ({ voidedAfterPaid: true })),
]

describe("«Ver los N cobros» cuenta lo mismo que el encabezado", () => {
  it("sin anulados, todos", () => {
    expect(showAllLabel(lines(16, 0))).toBe("Ver los 16 cobros")
  })

  it("el anulado después de pagado va aparte: el encabezado dice 15 cobros", () => {
    expect(showAllLabel(lines(15, 1))).toBe("Ver los 15 cobros y el anulado")
    expect(showAllLabel(lines(15, 2))).toBe("Ver los 15 cobros y los 2 anulados")
    expect(showAllLabel(lines(1, 1))).toBe("Ver el cobro y el anulado")
    expect(showAllLabel(lines(0, 5))).toBe("Ver los 5 anulados")
  })
})

it("lo que debe dice de qué pago se descuenta, y cuánto si no alcanza para todo", () => {
  const october = { year: 2026, month: 10 }
  expect(discountFromWords({ owedCents: 12000, currency: "PEN", discountFrom: { ...october, cents: 12000 } }, "es-PE")).toBe(
    "Se descuenta del pago de octubre de 2026, que tiene cobros por pagar.",
  )
  expect(discountFromWords({ owedCents: 30000, currency: "PEN", discountFrom: { ...october, cents: 15000 } }, "es-PE")).toMatch(
    /^Se descuentan S\/\s?150\.00 del pago de octubre de 2026, que tiene cobros por pagar, y el resto, de los próximos pagos\.$/,
  )
  expect(discountFromWords({ owedCents: 12000, currency: "PEN", discountFrom: null }, "es-PE")).toBe("Se descuenta del próximo pago.")
})

it("el medio de lo devuelto, para una frase", () => {
  expect(returnMethodWords("10")).toBe("en efectivo")
  expect(returnMethodWords("30")).toBe("por transferencia")
  expect(returnMethodWords("48")).toBe("con tarjeta")
  expect(returnMethodWords(null)).toBe("")
})

describe("el mes que le descuenta lo que debe dice lo mismo en la clínica y en «Mis honorarios»", () => {
  const october = {
    status: "por_pagar" as const,
    currency: "PEN",
    commissionCents: 555100,
    paidCents: 0,
    discountCents: 21000,
    pendingCents: 534100,
    owedCents: 0,
    discountFrom: null,
  }

  it("lo que se le pagará y el descuento, no la comisión entera", () => {
    expect(summaryAmountWords(october, "es-PE")).toMatch(/^Falta S\/\s?5,341\.00$/)
    expect(summaryDiscountWords(october, "es-PE")).toMatch(/^S\/\s?210\.00 por descontar$/)
  })

  it("sin descuento ni pago a cuenta, la comisión", () => {
    const plain = { ...october, discountCents: 0, pendingCents: 555100 }
    expect(summaryAmountWords(plain, "es-PE")).toMatch(/^S\/\s?5,551\.00$/)
    expect(summaryDiscountWords(plain, "es-PE")).toBeNull()
  })
})

it("por qué «Ya pagado» supera la comisión: lo devolvió o se dio por saldado, con su día", () => {
  const day = () => "8 de noviembre"
  expect(debtClosureWords({ settlementId: "s", kind: "devuelto", cents: 21000, settledAt: "2026-11-08T15:00:00Z", notes: "Lo trajo" }, "PEN", "es-PE", day)).toMatch(
    /^Devolvió S\/\s?210\.00 el 8 de noviembre$/,
  )
  expect(debtClosureWords({ settlementId: "s", kind: "saldado", cents: 21000, settledAt: "2026-11-08T15:00:00Z", notes: "Ya no trabaja aquí" }, "PEN", "es-PE", day)).toMatch(
    /^Se dio por saldado S\/\s?210\.00 el 8 de noviembre: Ya no trabaja aquí$/,
  )
})
