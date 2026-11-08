import { describe, expect, it } from "vitest"
import { discountFromWords, returnMethodWords, showAllLabel } from "./commissions"

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
