import { describe, expect, it } from "vitest"
import { owedOf, receiptHere } from "./plan"

/**
 * «Plan y pagos» nombra «Subir comprobante» solo cuando el botón está: con algo por pagar, con
 * cómo pagarlo y con gestorIA conectada a la administración (la QA lo vio dicho sin el botón).
 */

const charge = (status: string, amountCents: number, paidCents: number) => ({
  id: `c-${status}-${paidCents}`,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  amountCents,
  paidCents,
  currency: "USD",
  status,
  dueAt: null,
  lines: [],
})
const yape = { code: "yape", name: "Yape", instructions: null }

describe("lo que se debe de un cobro", () => {
  it("es lo que falta pagar; anulado o revertido no se debe", () => {
    expect(owedOf(charge("pendiente", 2140, 0))).toBe(2140)
    expect(owedOf(charge("parcial", 2140, 1000))).toBe(1140)
    expect(owedOf(charge("pagada", 1900, 1900))).toBe(0)
    expect(owedOf(charge("anulada", 1900, 0))).toBe(0)
    expect(owedOf(charge("reversada", 1900, 0))).toBe(0)
  })
})

describe("cuándo la página nombra «Subir comprobante»", () => {
  const due = { charges: [charge("pendiente", 2140, 0)], paymentMethods: [yape] }
  it("con algo por pagar, cómo pagarlo y la administración conectada", () => {
    expect(receiptHere(due, true)).toBe(true)
  })
  it("no sin la administración, sin formas de pago ni sin nada por pagar", () => {
    expect(receiptHere(due, false)).toBe(false)
    expect(receiptHere({ ...due, paymentMethods: [] }, true)).toBe(false)
    expect(receiptHere({ ...due, charges: [charge("pagada", 1900, 1900)] }, true)).toBe(false)
  })
})
