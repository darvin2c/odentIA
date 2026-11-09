import { describe, expect, it } from "vitest"
import {
  APP_SURFACES,
  brandColorName,
  brandEmailColors,
  brandPalette,
  contrastRatio,
  dominantColors,
  normalizeBrandColor,
  PRODUCT_BRAND_COLORS,
  SUGGESTED_BRAND_COLORS,
  suggestedBrandColors,
} from "./brand-color.js"

/** Colores de todo el círculo y de todas las luces, más los casos de los bordes. */
function sampleColors(): string[] {
  const out = ["#000000", "#ffffff", "#fefefe", "#facc15", "#808080", "#e11d48", "#0e7490", "#6d3fc0"]
  for (let r = 0; r <= 255; r += 51)
    for (let g = 0; g <= 255; g += 51)
      for (let b = 0; b <= 255; b += 51)
        out.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`)
  return out
}

describe("brandPalette", () => {
  it("cualquier color se lee: texto, botón y tintes llegan a 4,5:1 en claro y en oscuro", () => {
    for (const hex of sampleColors()) {
      const { light, dark, paper } = brandPalette(hex)
      expect(contrastRatio(light.primary, "#ffffff"), `${hex} texto en claro`).toBeGreaterThanOrEqual(4.5)
      // También sobre lo secundario (botón secundario, menú al pasar el mouse), lo más exigente.
      expect(contrastRatio(light.primary, APP_SURFACES.light.secondary), `${hex} texto sobre secundario`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.primary, APP_SURFACES.dark.secondary), `${hex} texto oscuro sobre secundario`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(light.fill, light.fillForeground), `${hex} botón en claro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(light.fillHover, light.fillForeground), `${hex} botón al pasar el mouse`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.fillHover, dark.fillForeground), `${hex} botón oscuro al pasar el mouse`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(light.softForeground, light.soft), `${hex} tinte en claro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.primary, APP_SURFACES.dark.card), `${hex} texto en oscuro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.primaryForeground, dark.primary), `${hex} sobre el primario oscuro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.fill, dark.fillForeground), `${hex} botón en oscuro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(dark.softForeground, dark.soft), `${hex} tinte en oscuro`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(paper, "#ffffff"), `${hex} papel`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("el tinte del menú activo se nota también con un color claro, en claro y en oscuro", () => {
    for (const hex of ["#7cc4ec", "#6ee7b7", "#facc15", "#1d5fa8", "#1e3a8a"]) {
      const { light, dark } = brandPalette(hex)
      expect(contrastRatio(light.soft, "#ffffff"), `${hex} en claro`).toBeGreaterThanOrEqual(1.18)
      expect(contrastRatio(dark.soft, APP_SURFACES.dark.background), `${hex} en oscuro`).toBeGreaterThanOrEqual(1.4)
    }
  })

  it("el color de fábrica de cada producto queda tal cual", () => {
    for (const hex of Object.values(PRODUCT_BRAND_COLORS)) {
      const palette = brandPalette(hex)
      expect(palette.light.primary).toBe(hex)
      expect(palette.light.fill).toBe(hex)
      expect(palette.light.fillForeground).toBe("#ffffff")
      expect(palette.lightened).toBe(false)
    }
  })

  it("un color claro conserva el relleno exacto con letra oscura y oscurece solo el texto", () => {
    const palette = brandPalette("#facc15")
    expect(palette.light.fill).toBe("#facc15")
    expect(palette.light.fillForeground).toBe(APP_SURFACES.light.foreground)
    expect(palette.light.primary).not.toBe("#facc15")
    expect(palette.lightened).toBe(true)
    expect(palette.nearWhite).toBe(false)
  })

  it("un color fuerte lleva letra blanca: el naranja se oscurece apenas, no se cambia a letra oscura", () => {
    for (const hex of ["#ea580c", "#f97316", "#ef4444", "#ec4899"]) {
      const { light, dark } = brandPalette(hex)
      expect(light.fillForeground, hex).toBe("#ffffff")
      expect(dark.fillForeground, `${hex} en oscuro`).toBe("#ffffff")
      expect(contrastRatio(light.fill, "#ffffff"), hex).toBeGreaterThanOrEqual(4.5)
    }
    // Sigue siendo naranja: un punto más tostado.
    expect(brandPalette("#ea580c").light.fill).toBe("#cc4d0a")
  })

  it("un color claro, que habría que cambiar demasiado, sigue exacto con letra oscura", () => {
    for (const hex of ["#facc15", "#38bdf8", "#6ee7b7", "#a78bfa", "#14b8a6"]) {
      const { light } = brandPalette(hex)
      expect(light.fill, hex).toBe(hex)
      expect(light.fillForeground, hex).toBe(APP_SURFACES.light.foreground)
    }
  })

  it("letra oscura solo cuando la blanca pediría cambiar el color más de una cuarta parte", () => {
    for (const hex of sampleColors()) {
      const { light, nearWhite } = brandPalette(hex)
      if (nearWhite || light.fillForeground === "#ffffff") continue
      const value = Number.parseInt(hex.slice(1), 16)
      const darker = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((c) => Math.round(c * 0.76))
      const darkerHex = `#${darker.map((c) => c.toString(16).padStart(2, "0")).join("")}`
      expect(contrastRatio(darkerHex, "#ffffff"), hex).toBeLessThan(4.5)
    }
  })

  it("casi blanco no se usa como relleno: sale el tono legible y se avisa", () => {
    const palette = brandPalette("#fefefe")
    expect(palette.nearWhite).toBe(true)
    expect(palette.light.fill).toBe(palette.light.primary)
    expect(palette.light.fillForeground).toBe("#ffffff")
  })

  it("avisa el rojo de los errores, no el naranja ni el rosa", () => {
    expect(brandPalette("#e11d48").reddish).toBe(true)
    expect(brandPalette("#b42323").reddish).toBe(true)
    expect(brandPalette("#ea580c").reddish).toBe(false)
    expect(brandPalette("#db2777").reddish).toBe(false)
    expect(brandPalette("#808080").reddish).toBe(false)
  })
})

describe("los grises de la app", () => {
  it("no siguen a la marca: el color elegido no trae grises propios", () => {
    for (const hex of ["#ea580c", "#db2777", "#1d5fa8", "#666666"]) expect(Object.keys(brandPalette(hex)), hex).not.toContain("neutrals")
  })

  it("son grises sin tono: ni azulados ni del color de la marca", () => {
    for (const hex of [...Object.values(APP_SURFACES.light), ...Object.values(APP_SURFACES.dark)]) {
      expect(hex.slice(1, 3), hex).toBe(hex.slice(3, 5))
      expect(hex.slice(3, 5), hex).toBe(hex.slice(5, 7))
    }
  })
})

describe("los sugeridos", () => {
  it("son doce, sin repetir, y ninguno se parece al rojo", () => {
    expect(SUGGESTED_BRAND_COLORS).toHaveLength(12)
    expect(new Set(SUGGESTED_BRAND_COLORS.map((color) => color.hex)).size).toBe(12)
    for (const color of SUGGESTED_BRAND_COLORS) expect(brandPalette(color.hex).reddish, color.name).toBe(false)
  })

  it("el de fábrica va primero en cada producto", () => {
    expect(suggestedBrandColors("dental")[0]).toMatchObject({ hex: PRODUCT_BRAND_COLORS.dental, factory: true })
    const medical = suggestedBrandColors("medical")
    expect(medical[0]).toMatchObject({ hex: PRODUCT_BRAND_COLORS.medical, factory: true })
    expect(medical).toHaveLength(12)
    expect(medical.filter((color) => color.factory)).toHaveLength(1)
  })
})

describe("brandColorName", () => {
  it("nombra los del logo con palabras de todos los días", () => {
    expect(brandColorName("#1d5fa8")).toBe("Azul")
    expect(brandColorName("#7cc4ec")).toBe("Celeste")
    expect(brandColorName("#ea580c")).toBe("Naranja")
    expect(brandColorName("#15803d")).toBe("Verde")
    expect(brandColorName("#6ee7b7")).toBe("Menta")
    expect(brandColorName("#7c3aed")).toBe("Morado")
    expect(brandColorName("#334155")).toBe("Gris")
  })
})

describe("brandEmailColors", () => {
  it("el botón del correo es el de la app, y los enlaces se leen sobre la tarjeta blanca y la oscura", () => {
    for (const hex of ["#ea580c", "#7cc4ec", "#1d5fa8", "#fefefe"]) {
      const { light, dark } = brandPalette(hex)
      const mail = brandEmailColors(hex)
      expect(mail).toMatchObject({ boton: light.fill, botonTinta: light.fillForeground, enlace: light.primary })
      expect(mail.oscuro).toEqual({ boton: dark.fill, botonTinta: dark.fillForeground, enlace: dark.primary })
      expect(contrastRatio(mail.botonTinta, mail.boton), hex).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(mail.enlace, "#ffffff"), hex).toBeGreaterThanOrEqual(4.5)
      // La tarjeta oscura del correo (`.tarjeta` en el molde).
      expect(contrastRatio(mail.oscuro.enlace, "#171e2b"), hex).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe("dominantColors", () => {
  it("de una foto ofrece hasta los que se pidan, sin grises y sin el mismo color con otra luz", () => {
    const pixel = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(255)
    const block = (hex: string, count: number) => Array.from({ length: count }, () => pixel(hex)).flat()
    const photo = [
      ...block("#ea580c", 40),
      ...block("#1d5fa8", 30),
      ...block("#22a06b", 20),
      ...block("#e2e2e2", 60),
      ...block("#ec5a10", 10),
    ]
    expect(dominantColors(photo, 4)).toHaveLength(2)
    const four = dominantColors(photo, 4, 4)
    expect(four).toHaveLength(3)
    expect(four[0]).toBe("#ea580c")
  })
})

describe("normalizeBrandColor", () => {
  it("acepta el código con o sin #, en mayúsculas, y rechaza lo demás", () => {
    expect(normalizeBrandColor("#1D5FA8")).toBe("#1d5fa8")
    expect(normalizeBrandColor(" 1d5fa8 ")).toBe("#1d5fa8")
    expect(normalizeBrandColor("#1d5fa")).toBeNull()
    expect(normalizeBrandColor("azul")).toBeNull()
  })
})
