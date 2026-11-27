import { describe, expect, it } from "vitest"
import { brandPalette, clinicColorCss, PRODUCT_BRAND_COLORS, SUGGESTED_BRAND_COLORS, suggestedBrandColors } from "./brand-color.js"
import { CLINICAL_PRODUCTS } from "./products.js"

// La cuenta del color se prueba en `@odentia/ui/lib/brand-color`; aquí, lo de las clínicas.
describe("el color de cada producto", () => {
  it("el color de fábrica de cada producto queda tal cual", () => {
    for (const hex of Object.values(PRODUCT_BRAND_COLORS)) {
      const palette = brandPalette(hex)
      expect(palette.light.primary).toBe(hex)
      expect(palette.light.fill).toBe(hex)
      expect(palette.light.fillForeground).toBe("#ffffff")
      expect(palette.lightened).toBe(false)
    }
  })

  it("la clínica sin color elegido, o con uno que no es un color, no escribe reglas", () => {
    expect(clinicColorCss(null)).toBeNull()
    expect(clinicColorCss("azul")).toBeNull()
    expect(clinicColorCss("#1d5fa8")).toContain("--primary:")
  })
})

describe("los sugeridos", () => {
  it("son doce, sin repetir, y ninguno se parece al rojo", () => {
    expect(SUGGESTED_BRAND_COLORS).toHaveLength(12)
    expect(new Set(SUGGESTED_BRAND_COLORS.map((color) => color.hex)).size).toBe(12)
    for (const color of SUGGESTED_BRAND_COLORS) expect(brandPalette(color.hex).reddish, color.name).toBe(false)
  })

  it("el de fábrica va primero en cada producto, una sola vez y sin perder ninguno", () => {
    for (const product of CLINICAL_PRODUCTS) {
      const colors = suggestedBrandColors(product)
      expect(colors[0], product).toMatchObject({ hex: PRODUCT_BRAND_COLORS[product], factory: true })
      expect(colors, product).toHaveLength(12)
      expect(colors.filter((color) => color.factory), product).toHaveLength(1)
      expect(new Set(colors.map((color) => color.hex)).size, product).toBe(12)
    }
    // odentIA conserva el orden de siempre.
    expect(suggestedBrandColors("dental").map((color) => color.hex)).toEqual(SUGGESTED_BRAND_COLORS.map((color) => color.hex))
    expect(suggestedBrandColors("optical")[0]?.name).toBe("Verde")
  })
})

