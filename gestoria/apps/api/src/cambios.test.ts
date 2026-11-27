/**
 * Las cifras del cambio o la devolución después de entregar (tablero 17), sin base: el precio de lo
 * que se lleva, lo que vuelve y la diferencia, y el aviso que se abre en WhatsApp.
 */
import { describe, expect, it } from "vitest"
import { exchangeNotice, exchangeTotals, takePrices } from "./cambios.js"

const sandalia = "p-sandalia"
const correa = "p-correa"
const take = (productId: string, over: Partial<Parameters<typeof takePrices>[0][number]> = {}) => ({
  productId,
  quantity: 1,
  listUnitCents: 12900,
  autoUnitCents: 12900,
  floorUnitCents: 12900,
  ...over,
})

describe("el precio de lo que se lleva", () => {
  it("otra talla del mismo producto cuesta lo que pagó por la que vuelve", () => {
    // Pagó la 38 en promoción (S/ 99); hoy la 39 está a S/ 129 y se negocia hasta S/ 90.
    const prices = takePrices(
      [take(sandalia, { floorUnitCents: 9000 })],
      [{ productId: sandalia, quantity: 1, unitCents: 9900 }],
    )
    expect(prices).toEqual([9900])
  })

  it("nunca baja del mínimo ni pasa del precio de hoy", () => {
    expect(
      takePrices(
        [take(sandalia, { floorUnitCents: 10000 })],
        [{ productId: sandalia, quantity: 1, unitCents: 8000 }],
      ),
    ).toEqual([10000])
    expect(
      takePrices(
        [take(sandalia, { autoUnitCents: 11000, floorUnitCents: 10000 })],
        [{ productId: sandalia, quantity: 1, unitCents: 12900 }],
      ),
    ).toEqual([11000])
  })

  it("otro producto, o lo que fue de regalo, va al precio de hoy", () => {
    expect(
      takePrices(
        [take(correa, { autoUnitCents: 3000, floorUnitCents: 2500 })],
        [{ productId: sandalia, quantity: 1, unitCents: 12900 }],
      ),
    ).toEqual([3000])
    expect(
      takePrices(
        [take(sandalia, { floorUnitCents: 9000 })],
        [{ productId: sandalia, quantity: 1, unitCents: 0 }],
      ),
    ).toEqual([12900])
  })
})

describe("la diferencia", () => {
  it("Andrea cambia la 38 por la 39 y paga el envío: falta cobrar S/ 12", () => {
    const totals = exchangeTotals(
      [{ ...take(sandalia), unitCents: 12900 }],
      [{ productId: sandalia, quantity: 1, unitCents: 12900 }],
      { listCents: 1200, storePays: false },
    )
    expect(totals).toMatchObject({
      subtotalCents: 12900,
      creditCents: 12900,
      deliveryListCents: 1200,
      deliveryCents: 1200,
      totalCents: 1200,
      discountCents: 0,
    })
  })

  it("si la tienda paga el envío y es lo mismo, no hay nada que cobrar", () => {
    const totals = exchangeTotals(
      [{ ...take(sandalia), unitCents: 12900 }],
      [{ productId: sandalia, quantity: 1, unitCents: 12900 }],
      { listCents: 1200, storePays: true },
    )
    expect(totals).toMatchObject({ deliveryCents: 0, deliveryListCents: 1200, totalCents: 0 })
  })

  it("una devolución queda bajo cero: es lo que la tienda devuelve", () => {
    const totals = exchangeTotals([], [{ productId: sandalia, quantity: 1, unitCents: 12900 }], {
      listCents: 0,
      storePays: false,
    })
    expect(totals).toMatchObject({ subtotalCents: 0, creditCents: 12900, totalCents: -12900 })
  })

  it("lo que se lleva al precio de lo que vuelve cuenta como descuento, dentro del margen", () => {
    const totals = exchangeTotals(
      [{ ...take(sandalia, { floorUnitCents: 9000 }), unitCents: 9900 }],
      [{ productId: sandalia, quantity: 1, unitCents: 9900 }],
      { listCents: 0, storePays: false },
    )
    expect(totals).toMatchObject({ discountCents: 3000, marginCents: 3900, totalCents: 0 })
  })
})

describe("el aviso del cambio", () => {
  const base = {
    customerName: "Andrea Castillo",
    number: "0171",
    back: ["Sandalia beige 38"],
    takes: ["Sandalia beige 39"],
    deliverOn: "2026-11-28",
    pickup: false,
    dueCents: 1200,
    refundCents: 0,
    payOnDelivery: true,
    currency: "PEN",
  }

  it("dice qué vuelve, qué se lleva, cuándo pasan y lo que falta pagar", () => {
    const text = exchangeNotice(base)
    expect(text).toContain("Hola Andrea, anotamos tu cambio (pedido 0171)")
    expect(text).toContain("vuelve Sandalia beige 38 y te llevas Sandalia beige 39.")
    expect(text).toContain("Pasamos el ")
    expect(text).toMatch(/Falta pagar S\/\s?12 al entregar\.$/)
  })

  it("en una devolución, lo que se le devuelve", () => {
    const text = exchangeNotice({
      ...base,
      takes: [],
      deliverOn: null,
      dueCents: 0,
      refundCents: 12900,
      payOnDelivery: false,
    })
    expect(text).toMatch(
      /^Hola Andrea, anotamos tu devolución \(pedido 0171\): vuelve Sandalia beige 38\. Te devolvemos S\/\s?129\.$/,
    )
  })

  it("si lo trae a la tienda, la espera ahí", () => {
    expect(exchangeNotice({ ...base, pickup: true, dueCents: 0 })).toContain(
      "Te esperamos en la tienda el ",
    )
  })
})
