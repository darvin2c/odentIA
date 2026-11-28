import { describe, expect, it } from "vitest"
import {
  bubble,
  clock,
  firstChoice,
  localTotals,
  mediaFor,
  type Showcase,
  shownPrice,
  swatch,
  variantOf,
} from "./vitrina"

/** La página de la zapatilla de lona como la da el servidor (solo lo vendible). */
function page(over: Partial<Showcase["product"]> = {}): Showcase {
  const variant = (color: string, size: string, extra = {}) => ({
    id: `${color}-${size}`,
    color,
    size,
    priceCents: 12900,
    listCents: 12900,
    available: true,
    left: null,
    promotion: null,
    ...extra,
  })
  return {
    store: {
      name: "Calzados Rosa",
      color: "#be185d",
      currency: "PEN",
      link: "calzadosrosa",
      deliveries: [
        {
          id: "d1",
          name: "Reparto en Lima",
          eta: "Mañana",
          cost: "fijo",
          priceCents: 1000,
          zones: [],
          freeFromCents: 25000,
        },
      ],
      payments: ["Yape", "Tarjeta con enlace"],
    },
    product: {
      id: "p1",
      name: "Zapatilla de lona",
      category: "Zapatillas",
      description: "",
      slug: "zapatilla-de-lona",
      visible: true,
      state: "disponible",
      stateText: null,
      rowLabel: "Color",
      columnLabel: "Talla",
      colors: [
        { value: "blanca", hex: "#ffffff", hex2: null },
        { value: "negra", hex: "#1f1f1f", hex2: null },
      ],
      sizes: ["35", "38"],
      variants: [
        variant("blanca", "35", {
          available: false,
        }),
        variant("blanca", "38"),
        variant("negra", "35", {
          priceCents: 9030,
          promotion: { name: "Liquidación talla 35", percentOff: 30, endsOn: "2026-12-07" },
        }),
        variant("negra", "38", { priceCents: 11900, listCents: 11900, left: 2 }),
      ],
      quantityPrices: [],
      answers: [],
      facts: [{ label: "Cómo calza", value: "Normal" }],
      combina: [],
      ...over,
    },
    media: {
      photos: [
        { id: "f1", color: "blanca", width: 1, height: 1, miniatura: "b-m", vitrina: "b-v" },
        { id: "f2", color: "negra", width: 1, height: 1, miniatura: "n-m", vitrina: "n-v" },
      ],
      videos: [],
      expiresAt: null,
    },
  }
}

describe("la página del producto en la vitrina", () => {
  it("abre en el primer color que tiene algo para vender, sin talla elegida", () => {
    expect(firstChoice(page())).toEqual({ color: "blanca", size: null })
    const soldOut = page()
    soldOut.product.variants = soldOut.product.variants.map((v) =>
      v.color === "blanca" ? { ...v, available: false } : v,
    )
    expect(firstChoice(soldOut).color).toBe("negra")
  })

  it("sin talla no hay variante; el precio que se ve no es el de la promoción de una talla", () => {
    const p = page()
    expect(variantOf(p, { color: "negra", size: null })).toBeNull()
    expect(shownPrice(p, { color: "negra", size: null })?.priceCents).toBe(11900)
    expect(variantOf(p, { color: "negra", size: "35" })?.priceCents).toBe(9030)
  })

  it("la foto del color elegido va primero", () => {
    expect(mediaFor(page(), "negra").photos.map((f) => f.id)).toEqual(["f2", "f1"])
  })

  it("lo que dice Sofi junto a la foto sale de la ficha", () => {
    const p = page()
    expect(bubble(p, { color: "negra", size: "38" }).text).toBe("Quedan 2 en tu 38 en negra.")
    expect(bubble(p, { color: "blanca", size: "35" })).toEqual({
      text: "En negra sí hay 35.",
      action: { label: "Ver en negra", color: "negra" },
    })
    expect(bubble(p, { color: "negra", size: null }).text).toBe(
      "Liquidación talla 35: 30 % menos hasta el 7.",
    )
    expect(bubble(p, { color: "blanca", size: null }).text).toBe("Cómo calza: normal.")
    expect(
      bubble(page({ stateText: "Por encargo · llega en 5 días" }), { color: "blanca", size: null })
        .text,
    ).toBe("Por encargo · llega en 5 días.")
  })

  it("la muestra bicolor va en diagonal", () => {
    expect(swatch("#ffffff", null)).toBe("#ffffff")
    expect(swatch("#ffffff", "#000000")).toContain(
      "linear-gradient(135deg, #ffffff 50%, #000000 50%)",
    )
  })

  it("el carrito antes del pedido: el envío gratis desde el monto de la tienda", () => {
    const p = page()
    const delivery = p.store.deliveries[0]!
    const one = localTotals(p, [{ variantId: "negra-38", quantity: 1 }], delivery)
    expect(one).toMatchObject({
      subtotal: 11900,
      shipping: 1000,
      total: 12900,
      missingForFree: 13100,
    })
    const three = localTotals(p, [{ variantId: "negra-38", quantity: 3 }], delivery)
    expect(three).toMatchObject({ subtotal: 35700, shipping: 0, free: true, missingForFree: null })
  })

  it("el reloj de lo acordado", () => {
    expect(clock(86_399_000)).toBe("23:59:59")
    expect(clock(-5)).toBe("00:00:00")
  })
})
