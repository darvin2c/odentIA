/**
 * El precio de un pedido (tablero 14), sin base: los ejemplos del lienzo, con soles.
 */
import { describe, expect, it } from "vitest"
import {
  autoUnit,
  autoUnitCents,
  floorOf,
  floorUnitCents,
  lowestQuote,
  negotiatedUntil,
  type QuoteLine,
  quote,
} from "./precio.js"

/** La zapatilla de S/ 129 con mínimo S/ 100. */
const zapatilla = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  quantity: 1,
  listUnitCents: 12900,
  autoUnitCents: 12900,
  floorUnitCents: 10000,
  unitCents: null,
  gift: false,
  ...over,
})
/** Los montos de `Intl` llevan espacio duro: se comparan con espacio normal. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/\s/g, " "))
const reparto = { listCents: 1000, maxDiscountCents: 1000, freeFromCents: null, chargedCents: null }

describe("el precio sin negociar", () => {
  it("va la promoción o el precio por cantidad, el mejor para el cliente, nunca los dos", () => {
    const base = {
      listUnitCents: 12900,
      minPriceCents: 10000,
      percentOff: 10,
      quantityPrices: [{ minQuantity: 2, unitPriceCents: 11000 }],
    }
    expect(autoUnitCents(base, 1)).toBe(11610) // 10 % menos
    expect(autoUnitCents(base, 2)).toBe(11000) // por cantidad, sin sumar el 10 %
    expect(autoUnitCents({ ...base, percentOff: 20 }, 2)).toBe(10320) // la promoción es mejor
  })

  it("sin mínimo, o con un mínimo sobre el precio, no se negocia", () => {
    expect(floorUnitCents(12900, null)).toBe(12900)
    expect(floorUnitCents(8900, 10000)).toBe(8900)
    expect(floorUnitCents(12900, 10000)).toBe(10000)
  })
})

describe("lo que se cede sale de un solo margen (tablero 14)", () => {
  it("sin negociar: lista más envío, y el precio no vence", () => {
    const result = quote([zapatilla()], reparto, "PEN")
    expect(result.ok && result.quote).toMatchObject({
      totalCents: 13900,
      marginCents: 2900,
      marginUsedCents: 0,
      negotiated: false,
    })
  })

  it("envío gratis y S/ 9 menos: paga S/ 120, usó S/ 19 de 29", () => {
    const result = quote([zapatilla({ unitCents: 12000 })], { ...reparto, chargedCents: 0 }, "PEN")
    expect(result.ok && result.quote).toMatchObject({
      totalCents: 12000,
      discountCents: 900,
      marginUsedCents: 1900,
      negotiated: true,
    })
  })

  it("solo descuento: hasta S/ 100 más el envío, nunca menos", () => {
    const ok = quote([zapatilla({ unitCents: 10000 })], reparto, "PEN")
    expect(ok.ok && ok.quote.totalCents).toBe(11000)
    const below = quote([zapatilla({ unitCents: 9900 })], reparto, "PEN")
    expect(plain(below)).toEqual({
      ok: false,
      fields: { "lines.0.unitCents": "No puede bajar de S/ 100, el mínimo" },
    })
  })

  it("el envío gratis encima del mínimo no cabe: lo que entra nunca queda bajo el mínimo", () => {
    const result = quote([zapatilla({ unitCents: 10000 })], { ...reparto, chargedCents: 0 }, "PEN")
    expect(result.ok).toBe(false)
    expect(!result.ok && result.fields.deliveryCents).toMatch(/margen|mínimo/)
  })

  it("un producto sin mínimo no se rebaja, ni regala el envío", () => {
    const fixed = zapatilla({ floorUnitCents: 12900 })
    expect(plain(quote([{ ...fixed, unitCents: 12000 }], reparto, "PEN"))).toEqual({
      ok: false,
      fields: { "lines.0.unitCents": "No se negocia: va a S/ 129" },
    })
    expect(quote([fixed], { ...reparto, chargedCents: 0 }, "PEN").ok).toBe(false)
  })

  it("el envío se rebaja solo hasta lo que dice su forma de entrega", () => {
    const result = quote(
      [zapatilla()],
      { ...reparto, maxDiscountCents: 500, chargedCents: 0 },
      "PEN",
    )
    expect(plain(result)).toEqual({
      ok: false,
      fields: { deliveryCents: "Este envío se rebaja hasta S/ 5" },
    })
  })

  it("desde el monto de «gratis desde», el envío es gratis sin gastar margen", () => {
    const result = quote(
      [zapatilla({ quantity: 2 })],
      { ...reparto, maxDiscountCents: null, freeFromCents: 25000 },
      "PEN",
    )
    expect(result.ok && result.quote).toMatchObject({
      deliveryCents: 0,
      deliveryFreeByPolicy: true,
      marginUsedCents: 0,
      totalCents: 25800,
    })
  })

  it("un regalo vale su mínimo y sale del margen de lo que se compra", () => {
    const medias = zapatilla({
      listUnitCents: 1500,
      autoUnitCents: 1500,
      floorUnitCents: 1000,
      gift: true,
    })
    const result = quote([zapatilla(), medias], reparto, "PEN")
    expect(result.ok && result.quote).toMatchObject({
      giftCents: 1000,
      marginUsedCents: 1000,
      totalCents: 13900,
    })
    expect(quote([medias], reparto, "PEN").ok).toBe(false)
  })
})

describe("hasta cuándo vale un precio negociado", () => {
  const now = new Date("2026-11-26T23:40:00Z")

  it("24 horas, o la hora que ya se le prometió si es antes", () => {
    expect(negotiatedUntil(now)?.toISOString()).toBe("2026-11-27T23:40:00.000Z")
    const promised = new Date("2026-11-27T20:00:00Z")
    expect(negotiatedUntil(now, promised)?.toISOString()).toBe(promised.toISOString())
    // Nunca más de 24 horas, aunque se haya dicho otra cosa.
    expect(negotiatedUntil(now, new Date("2026-11-29T00:00:00Z"))?.toISOString()).toBe(
      "2026-11-27T23:40:00.000Z",
    )
  })

  it("una hora prometida que ya pasó no se renueva", () => {
    expect(negotiatedUntil(now, new Date("2026-11-26T23:00:00Z"))).toBeNull()
  })
})

describe("el precio de la ficha (lienzo «La ficha del producto»)", () => {
  const base = {
    listUnitCents: 12900,
    minPriceCents: 9900,
    percentOff: null,
    quantityPrices: [{ minQuantity: 2, unitPriceCents: 11500 }],
    wholesale: { minQuantity: 6, unitPriceCents: 8500 },
  }

  it("la revendedora paga el por mayor desde sus unidades, aunque quede bajo el mínimo, y no se negocia más", () => {
    expect(autoUnit(base, 5)).toEqual({ cents: 11500, reason: "cantidad" })
    expect(autoUnit(base, 6)).toEqual({ cents: 8500, reason: "mayor" })
    // Bajo el mínimo: ese es su precio y ya no baja.
    expect(floorOf(base, 8500)).toBe(8500)
  })

  it("una promoción de un color o una talla es un porcentaje más: va la mejor, sin sumarse", () => {
    expect(autoUnit({ ...base, percentOff: 30 }, 1)).toEqual({ cents: 9030, reason: "promocion" })
    expect(autoUnit({ ...base, percentOff: 5 }, 2)).toEqual({ cents: 11500, reason: "cantidad" })
  })

  it("el combo baja lo que combina si va junto; nunca se suma con la promoción", () => {
    expect(autoUnit({ ...base, comboPercentOff: 10 }, 1)).toEqual({ cents: 11610, reason: "combo" })
    expect(autoUnit({ ...base, comboPercentOff: 10, percentOff: 20 }, 1)).toEqual({
      cents: 10320,
      reason: "promocion",
    })
  })

  it("en liquidación el mínimo es el precio: no se negocia", () => {
    expect(floorOf({ ...base, clearance: true }, 12900)).toBe(12900)
    expect(floorOf(base, 12900)).toBe(9900)
  })

  const offers = { delivery: true, discount: true, secondUnit: false, gift: false }

  it("Sofi solo cede lo que el producto deja ofrecer; el equipo negocia como siempre", () => {
    const noDiscount = zapatilla({ unitCents: 11000, offers: { ...offers, discount: false } })
    expect(quote([noDiscount], reparto, "PEN").ok).toBe(true)
    const sofi = quote([noDiscount], reparto, "PEN", { byAgent: true })
    expect(sofi.ok).toBe(false)
    // Con la 2.ª unidad, rebaja si lleva dos o más.
    const second = { ...offers, discount: false, secondUnit: true }
    expect(
      quote([zapatilla({ quantity: 2, unitCents: 11450, offers: second })], reparto, "PEN", {
        byAgent: true,
      }).ok,
    ).toBe(true)
    // Con solo la 2.ª unidad, la rebaja es la de una unidad por cada dos, no la de todas.
    expect(
      quote([zapatilla({ quantity: 3, unitCents: 10000, offers: second })], reparto, "PEN", {
        byAgent: true,
      }).ok,
    ).toBe(false)
    expect(
      quote([zapatilla({ quantity: 3, unitCents: 11934, offers: second })], reparto, "PEN", {
        byAgent: true,
      }).ok,
    ).toBe(true)
    // Sin envío para ofrecer, no lo pone; sin regalo, no regala.
    const noDelivery = zapatilla({ offers: { ...offers, delivery: false } })
    expect(quote([noDelivery], { ...reparto, chargedCents: 0 }, "PEN", { byAgent: true }).ok).toBe(
      false,
    )
    const gift = zapatilla({ gift: true, floorUnitCents: 1000 })
    expect(
      quote([zapatilla({ offers }), { ...gift, offers }], reparto, "PEN", { byAgent: true }).ok,
    ).toBe(false)
    expect(
      quote([zapatilla({ offers: { ...offers, gift: true } }), gift], reparto, "PEN", {
        byAgent: true,
      }).ok,
    ).toBe(true)
  })

  it("lo menos que cobraría Sofi es el mínimo más el envío: el margen es uno solo", () => {
    const line = {
      quantity: 1,
      listUnitCents: 12900,
      autoUnitCents: 12900,
      floorUnitCents: 10000,
      offers,
    }
    const delivery = { listCents: 1000, maxDiscountCents: 1000, freeFromCents: null }
    const lowest = lowestQuote(line, delivery, "PEN")
    expect(lowest.ok && lowest.quote.totalCents).toBe(11000)
    expect(lowest.ok && lowest.quote.marginUsedCents).toBe(2900)
    // Sin rebaja, pone el envío con el margen.
    const deliveryOnly = lowestQuote(
      { ...line, offers: { ...offers, discount: false } },
      delivery,
      "PEN",
    )
    expect(deliveryOnly.ok && deliveryOnly.quote.totalCents).toBe(12900)
    expect(deliveryOnly.ok && deliveryOnly.quote.deliveryCents).toBe(0)
    // Si bajar al mínimo le quita el envío gratis desde un monto, conviene no bajarlo.
    const freeFrom = lowestQuote(
      { ...line, autoUnitCents: 10000, listUnitCents: 10000, floorUnitCents: 9000 },
      { listCents: 2000, maxDiscountCents: null, freeFromCents: 10000 },
      "PEN",
    )
    expect(freeFrom.ok && freeFrom.quote.totalCents).toBe(10000)
    // Sin mínimo, no cede nada.
    const fixed = lowestQuote({ ...line, floorUnitCents: 12900 }, delivery, "PEN")
    expect(fixed.ok && fixed.quote.totalCents).toBe(13900)
  })
})
