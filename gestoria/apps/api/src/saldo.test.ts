/**
 * El pago doble (ADR 0221), sin base: un pago en partes no lo es; solo lo que pasa del total. El
 * saldo mismo lo calcula la base (`order_balance`) y se prueba con ella en `@gestoria/db`.
 */
import { describe, expect, it } from "vitest"
import { overIfConfirmed, unpaidBalance } from "./saldo.js"

describe("cuándo un pago es «Pago doble»", () => {
  it("Diana: S/ 37 después de S/ 80 de un pedido de S/ 117 no pasa del total", () => {
    const balance = { ...unpaidBalance(11700), confirmedCents: 8000, pendingCents: 3700 }
    expect(overIfConfirmed(balance, 11700, { amountCents: 3700, status: "por_confirmar" })).toBe(0)
  })

  it("el mismo total dos veces pasa del total por todo el pago", () => {
    const balance = { ...unpaidBalance(13900), confirmedCents: 13900, dueCents: 0 }
    expect(overIfConfirmed(balance, 13900, { amountCents: 13900, status: "por_confirmar" })).toBe(
      13900,
    )
  })

  it("solo cuenta lo que espera a una persona", () => {
    const balance = { ...unpaidBalance(13900), confirmedCents: 13900, dueCents: 0 }
    expect(overIfConfirmed(balance, 13900, { amountCents: 13900, status: "confirmado" })).toBe(0)
  })

  it("sin pagos, se debe el total", () => {
    expect(unpaidBalance(11700)).toEqual({
      confirmedCents: 0,
      pendingCents: 0,
      dueCents: 11700,
      overCents: 0,
      paid: false,
    })
  })
})
