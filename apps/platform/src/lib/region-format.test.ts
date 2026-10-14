import { describe, expect, it } from "vitest"
import {
  currencyLabel,
  currencyOptions,
  displayLanguage,
  localeLabel,
  localeOptions,
  regionPreview,
} from "./region-format"

/** Los espacios de `Intl` son duros o estrechos según el entorno: se comparan como espacios. */
const plain = (text: string | undefined) => text?.replace(/[\u00a0\u202f]/g, " ")

describe("los códigos se guardan y los nombres se leen", () => {
  it("la moneda se lee con su nombre y su código, y la guardada nunca falta", () => {
    expect(currencyLabel("PEN", "es")).toBe("Sol peruano (PEN)")
    // Un código que el entorno no nombra se lee tal cual, no como error.
    expect(currencyLabel("ZZZ", "es")).toBe("ZZZ")
    const options = currencyOptions("es", "ZZZ")
    expect(options.find((option) => option.value === "USD")?.label).toBe(
      "Dólar estadounidense (USD)",
    )
    expect(options.some((option) => option.value === "ZZZ")).toBe(true)
    // Por nombre, no por código.
    const labels = options
      .filter((option) => option.label !== option.value)
      .map((option) => option.label)
    expect(labels).toEqual(
      [...labels].sort(new Intl.Collator("es", { sensitivity: "base" }).compare),
    )
  })

  it("el formato se lee como idioma y región, en el orden que da el servidor", () => {
    expect(localeLabel("es-PE", "es")).toBe("Español (Perú)")
    expect(localeLabel("pt-BR", "es")).toBe("Portugués (Brasil)")
    const options = localeOptions(["es-PE", "en-PE"], "es-CL", "es")
    expect(options.map((option) => option.value)).toEqual(["es-PE", "en-PE", "es-CL"])
    expect(options[2]?.label).toBe("Español (Chile)")
    // El guardado no se repite si ya está entre los ofrecidos.
    expect(localeOptions(["es-PE", "en-PE"], "en-PE", "es")).toHaveLength(2)
  })

  it("los nombres van en español aunque la clínica escriba sus fechas en otro idioma", () => {
    expect(displayLanguage("es-CL")).toBe("es-CL")
    expect(displayLanguage("en-US")).toBe("es")
    expect(displayLanguage(undefined)).toBe("es")
  })
})

describe("así se verán", () => {
  const now = new Date("2026-10-13T15:42:00Z")

  it("escribe la fecha, la hora y el importe con lo elegido, en la zona elegida", () => {
    const peru = regionPreview(now, { locale: "es-PE", timeZone: "America/Lima", currency: "PEN" })
    expect(peru?.date).toBe("13/10/2026")
    expect(plain(peru?.time)).toMatch(/^10:42/)
    expect(plain(peru?.amount)).toBe("S/ 1,250.00")
    // Otra zona cambia la hora y puede cambiar el día; otra moneda, los decimales.
    const tokyo = regionPreview(now, { locale: "es-CL", timeZone: "Asia/Tokyo", currency: "CLP" })
    expect(tokyo?.date).toBe("14-10-2026")
    expect(plain(tokyo?.time)).toMatch(/^12:42 a/)
    expect(plain(tokyo?.amount)).toBe("$1.250")
  })

  it("no inventa un ejemplo si falta elegir algo o no es válido", () => {
    expect(
      regionPreview(now, { locale: "es-PE", timeZone: "America/Lima", currency: "" }),
    ).toBeNull()
    expect(regionPreview(now, { locale: "es-PE", timeZone: "", currency: "PEN" })).toBeNull()
    expect(
      regionPreview(now, { locale: "es-PE", timeZone: "Marte/Olimpo", currency: "PEN" }),
    ).toBeNull()
    expect(
      regionPreview(now, { locale: "es-PE", timeZone: "America/Lima", currency: "ZZZ" }),
    ).toBeNull()
  })
})
