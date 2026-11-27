/**
 * Lo que la tienda elige para Sofi (ADR 0234), sin base: el horario en la zona de la tienda y qué
 * cede una cotización frente a lo que la tienda deja ofrecer.
 */
import { describe, expect, it } from "vitest"
import {
  DEFAULT_CHOICES,
  daysWords,
  hourWords,
  offerKindsOf,
  offerNotAllowed,
  teamHoursInput,
  teamNow,
} from "./opciones.js"

const LIMA = "America/Lima"
const hours = { days: [1, 2, 3, 4, 5, 6], from: "09:00", to: "19:00" }

describe("el horario del equipo", () => {
  it("se dice como lo dice la tienda", () => {
    expect(daysWords([1, 2, 3, 4, 5, 6])).toBe("lunes a sábado")
    expect(daysWords([1, 3, 5])).toBe("lunes, miércoles y viernes")
    expect(daysWords([1, 2, 3, 4, 5, 6, 7])).toBe("todos los días")
    expect(hourWords("09:00")).toBe("9 a. m.")
    expect(hourWords("19:30")).toBe("7:30 p. m.")
    expect(hourWords("12:00")).toBe("12 p. m.")
  })

  it("mira la hora de la tienda, no la del servidor", () => {
    // Martes 24 de noviembre de 2026.
    expect(teamNow(hours, LIMA, new Date("2026-11-24T15:00:00Z"))).toEqual({
      open: true,
      back: null,
    })
    // 7:30 a. m. en Lima: vuelve hoy.
    expect(teamNow(hours, LIMA, new Date("2026-11-24T12:30:00Z")).back).toBe(
      "hoy desde las 9 a. m.",
    )
    // 8 p. m. del martes en Lima (ya miércoles en UTC): vuelve mañana.
    expect(teamNow(hours, LIMA, new Date("2026-11-25T01:00:00Z")).back).toBe(
      "mañana desde las 9 a. m.",
    )
    // Sábado 8 p. m.: el domingo no atiende, vuelve el lunes.
    expect(teamNow(hours, LIMA, new Date("2026-11-29T01:00:00Z")).back).toBe(
      "el lunes desde las 9 a. m.",
    )
    // Sin horario, no se dice cuándo.
    expect(teamNow(null, LIMA, new Date())).toEqual({ open: true, back: null })
  })

  it("no acepta un cierre antes de la apertura ni días vacíos", () => {
    expect(teamHoursInput.safeParse({ ...hours, to: "08:00" }).success).toBe(false)
    expect(teamHoursInput.safeParse({ ...hours, days: [] }).success).toBe(false)
    expect(teamHoursInput.parse({ ...hours, days: [6, 1, 1] }).days).toEqual([1, 6])
  })
})

describe("lo que Sofi puede ofrecer", () => {
  const quote = {
    deliveryCents: 1000,
    deliveryListCents: 1000,
    deliveryFreeByPolicy: false,
    giftCents: 0,
    discountCents: 0,
    lines: [{ quantity: 1, gift: false }],
  } as unknown as Parameters<typeof offerKindsOf>[0]

  it("lee qué cede cada cotización", () => {
    expect(offerKindsOf(quote, DEFAULT_CHOICES)).toEqual([])
    expect(offerKindsOf({ ...quote, deliveryCents: 0 }, DEFAULT_CHOICES)).toEqual(["envio"])
    // El envío gratis por el monto es la regla de la tienda: no es una oferta.
    expect(
      offerKindsOf({ ...quote, deliveryCents: 0, deliveryFreeByPolicy: true }, DEFAULT_CHOICES),
    ).toEqual([])
    expect(offerKindsOf({ ...quote, discountCents: 900, giftCents: 300 }, DEFAULT_CHOICES)).toEqual(
      ["descuento", "regalo"],
    )
  })

  it("lo que la tienda apaga no se ofrece; la rebaja por dos vale solo si lleva dos", () => {
    const noDiscount = { ...DEFAULT_CHOICES, offerDiscount: false, offerSecond: true }
    expect(offerNotAllowed(["descuento"], noDiscount)).toBe("descuento")
    const two = { ...quote, discountCents: 900, lines: [{ quantity: 2, gift: false }] }
    const kinds = offerKindsOf(two as typeof quote, noDiscount)
    expect(kinds).toEqual(["segundo"])
    expect(offerNotAllowed(kinds, noDiscount)).toBeNull()
    expect(offerNotAllowed(["envio"], { ...DEFAULT_CHOICES, offerShipping: false })).toBe("envio")
  })
})
