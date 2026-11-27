/**
 * El precio de un pedido (tablero 14), sin base: los ejemplos del lienzo, con soles.
 */
import { describe, expect, it } from "vitest"
import { autoUnitCents, floorUnitCents, negotiatedUntil, type QuoteLine, quote } from "./precio.js"

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
