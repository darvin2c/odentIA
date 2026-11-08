import { brandPalette } from "@odentia/clinical"
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
    expect(css).toContain(`:root:root:root,:root:root:root .theme-light{--primary:${light.primary};`)
    expect(css).toContain(`:root:root:root.dark{--primary:${dark.primary};`)
    // Lo que se ve como papel sigue claro con la app en oscuro: su regla pesa más que la de `.dark` en la raíz.
    expect(css).toContain(`:root:root:root .theme-light{--primary:${light.primary};`)
    // El botón conserva el celeste exacto con letra oscura; el texto usa el tono legible.
    expect(css).toContain("--primary-fill:#7cc4ec;--primary-fill-foreground:#0f172a")
    // Lo del asistente sigue a la clínica; los estados y la identidad del producto no se tocan.
    expect(css).toContain(`--agent-soft:${light.agentSoft}`)
    expect(css).not.toMatch(/--(destructive|success|warning|identity-accent|chart-\d)/)
  })
})
