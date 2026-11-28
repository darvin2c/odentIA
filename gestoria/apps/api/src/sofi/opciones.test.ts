/**
 * Lo que la tienda elige para Sofi (ADR 0234), sin base: el horario en la zona de la tienda y qué
 * cede una cotización frente a lo que la tienda deja ofrecer.
 */
import { describe, expect, it } from "vitest"
import { bargainOf, isObjection } from "./herramientas.js"
import {
  DEFAULT_CHOICES,
  daysWords,
  hourWords,
  notAllowedWords,
  offerKindsOf,
  offerNotAllowed,
  styleFacts,
  teamHoursInput,
  teamNow,
} from "./opciones.js"
import { SOFI_RULES } from "./sofi.js"

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

describe("lo que Sofi lee de cómo habla y de lo que no puede dar", () => {
  const TONES = ["cercana", "formal", "directa"] as const
  // Lo que imita el modelo: un ejemplo que saluda la hace saludar en cada mensaje, y uno que abre
  // con «¡Sí!» la hace decir que sí antes de decir que no.
  const exampleOf = (tone: (typeof TONES)[number]) => {
    const [line] = styleFacts({ ...DEFAULT_CHOICES, tone })
    return /«([^»]+)»/.exec(line!)![1]!
  }

  it("los ejemplos de tono no empiezan con un saludo ni con un sí", () => {
    for (const tone of TONES) {
      const example = exampleOf(tone)
      expect(example, tone).not.toMatch(/^¡?\s*(hola|buen[oa]s|qué tal)/i)
      expect(example, tone).not.toMatch(/^¡?\s*(sí|claro|listo|por supuesto)(?!\p{L})/iu)
    }
  })

  it("a lo que la tienda no deja dar, no abre con «¡Sí!» ni «¡Claro!»", () => {
    const noDiscount = { ...DEFAULT_CHOICES, offerDiscount: false }
    const words = notAllowedWords("descuento", noDiscount)
    expect(words).toContain("La tienda no deja ofrecer un descuento.")
    expect(words).toContain("sin abrir con «¡Sí!» ni «¡Claro!»")
    expect(words).toContain("Puedes ofrecer: envío gratis o más barato; un regalo.")
    const nothing = notAllowedWords("descuento", {
      ...noDiscount,
      offerShipping: false,
      offerGift: false,
    })
    expect(nothing).toContain("sin abrir con «¡Sí!» ni «¡Claro!»")
    // Y la regla de negociar dice lo mismo para cualquier pedido que no puede dar.
    expect(SOFI_RULES).toContain("sin abrir con «¡Sí!» ni «¡Claro!»")
  })
})

describe("la duda de la clienta, antes de ofrecer (Sofi no regala el precio)", () => {
  it("preguntar el precio no es una duda; «caro», «lo pienso» u otra tienda sí", () => {
    for (const asks of [
      "¿Cuánto cuesta la zapatilla blanca?",
      "¿cuál es el precio?",
      "¿y el envío a Surco cuánto es?",
      "La quiero en 38",
      // Preguntas de todos los días que no son una duda por el precio.
      "¿La tienes en otra talla?",
      "¿Tienen la de caña baja?",
      "¿El envío es gratis?",
      "¿Llega en menos de 3 días?",
      "Es para regalo",
      "No sé si me queda",
      "No encontré mi talla",
      "¿Me pasas un presupuesto?",
      "¿Tienen crema para la cara?",
    ])
      expect(isObjection(asks), asks).toBe(false)
    for (const doubts of [
      "Uy, está caro",
      "¿me lo dejas en 110?",
      "mmm lo voy a pensar",
      "¿tienen descuento?",
      "En otra tienda está más barato",
      "¿me regalas el envío?",
      "¿Y si me bajas 10 soles?",
    ])
      expect(isObjection(doubts), doubts).toBe(true)
  })

  it("la duda cuenta solo después de oír un precio", () => {
    const early = bargainOf(
      [
        { author: "cliente", text: "Está caro todo aquí" },
        { author: "sofi", text: "Cuesta S/ 129." },
      ],
      "PEN",
    )
    expect(early).toEqual({ pricesSaid: [12900], objection: null })
    const late = bargainOf(
      [
        { author: "sofi", text: "Cuesta S/ 129." },
        { author: "cliente", text: "Uy, está caro" },
      ],
      "PEN",
    )
    expect(late.objection).toBe("Uy, está caro")
  })
})
