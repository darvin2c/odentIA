import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { APP_SURFACES, brandPalette, contrastRatio } from "@odentia/clinical"
import { describe, expect, it } from "vitest"
import { clinicColorCss, clinicColorStyles } from "./clinic-color"

describe("el color de la clínica en la cabecera", () => {
  it("sin color elegido no escribe nada: queda el del producto", () => {
    expect(clinicColorCss(null)).toBeNull()
    expect(clinicColorStyles({ brandColor: null })).toEqual([])
    expect(clinicColorStyles(undefined)).toEqual([])
  })

  it("no escribe lo que no es un color: nada se inyecta en la hoja", () => {
    expect(clinicColorCss("red;}body{display:none")).toBeNull()
    expect(clinicColorCss("#1D5FA8")).toBeNull()
  })

  it("redefine la marca en claro, en oscuro y en el papel, con más peso que la marca del producto", () => {
    const css = clinicColorCss("#7cc4ec") ?? ""
    const { light, dark } = brandPalette("#7cc4ec")
    // `:root:root:root` (0,3,0) pesa más que `:root[data-brand="latidia"]` (0,2,0) y que `.dark`.
    expect(css).toContain(`:root:root:root{--primary:${light.primary};`)
    expect(css).toContain(`:root:root:root.dark{--primary:${dark.primary};`)
    // Lo que se ve como papel sigue claro con la app en oscuro: su regla pesa más que la de `.dark` en la raíz.
    expect(css).toContain(`:root:root:root .theme-light{--primary:${light.primary};`)
    // Los grises no siguen a la marca: quedan los de la hoja, sin tono, en claro, en oscuro y en el papel.
    expect(css).not.toMatch(/--(canvas|background|foreground|card|popover|muted|secondary|accent|border|input|sidebar)(-foreground|-border|-accent)?:/)
    // El botón conserva el celeste exacto con letra oscura (la tinta de la app); el texto usa el tono legible.
    expect(css).toContain(`--primary-fill:#7cc4ec;--primary-fill-foreground:${APP_SURFACES.light.foreground}`)
    // Lo del asistente sigue a la clínica; los estados y la identidad del producto no se tocan.
    expect(css).toContain(`--agent-soft:${light.agentSoft}`)
    expect(css).not.toMatch(/--(destructive|success|warning|identity-accent|chart-\d)/)
  })

  it("el color se mide contra los mismos grises que pinta la hoja", () => {
    // Si alguien cambia un gris en `globals.css`, el contraste del color de cada clínica
    // se seguiría calculando contra el viejo: esta prueba lo avisa.
    const sheet = readFileSync(createRequire(import.meta.url).resolve("@odentia/ui/globals.css"), "utf8")
    const block = (pattern: RegExp) => sheet.match(pattern)?.[1] ?? ""
    // Falla si el gris no está escrito como #rrggbb: medir contra un valor vacío daría negro y pasaría.
    const token = (rules: string, name: string) => {
      const value = rules.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`))?.[1]
      if (!value) throw new Error(`--${name} no es un #rrggbb en globals.css`)
      return value
    }
    const light = block(/:root,\s*\.theme-light\s*\{([^}]*)\}/)
    const dark = block(/\n\.dark\s*\{([^}]*)\}/)
    expect(token(light, "foreground")).toBe(APP_SURFACES.light.foreground)
    expect(token(light, "secondary")).toBe(APP_SURFACES.light.secondary)
    expect(token(dark, "background")).toBe(APP_SURFACES.dark.background)
    expect(token(dark, "card")).toBe(APP_SURFACES.dark.card)
    expect(token(dark, "secondary")).toBe(APP_SURFACES.dark.secondary)
    // El texto gris se lee (4,5:1) sobre cada fondo donde va, en claro y en oscuro, y el borde
    // de campos, casillas y opciones se ve (3:1, WCAG 1.4.11): el relleno solo no marca el campo.
    for (const [rules, surfaces] of [
      [light, ["canvas", "muted", "secondary", "card", "sidebar"]],
      [dark, ["canvas", "muted", "secondary", "card", "sidebar"]],
    ] as const) {
      const text = token(rules, "muted-foreground")
      const field = token(rules, "input-border")
      for (const surface of surfaces) {
        expect(contrastRatio(text, token(rules, surface)), `texto gris sobre ${surface}`).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(field, token(rules, surface)), `borde de campo sobre ${surface}`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})
