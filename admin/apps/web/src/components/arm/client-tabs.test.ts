import { describe, expect, it } from "vitest"
import { clientTabsFor, openClientTab, phaseTab, shownClientTabs } from "./client-tabs"

const rules = (over: Partial<Parameters<typeof clientTabsFor>[0]> = {}) => ({
  phase: "por_vender" as const,
  hasAccount: false,
  isAdmin: true,
  openSupportCases: 0,
  ...over,
})

describe("las pestañas de la ficha por su fase (ADR 0196)", () => {
  it("por vender: Resumen, Conversaciones, Historial, Venta y Documentos; nada en «Más»", () => {
    expect(clientTabsFor(rules())).toEqual({
      tabs: ["resumen", "conversaciones", "historial", "venta", "documentos"],
      more: [],
    })
    // Decidida sin cuenta, sigue siendo la Venta.
    expect(clientTabsFor(rules({ phase: "perdido" })).tabs).toContain("venta")
    expect(clientTabsFor(rules({ phase: "no_por_ahora" })).tabs).toContain("venta")
  })

  it("en alta: Alta a la vista y Plan y pagos para Administración; Venta, Uso y Soporte en «Más»", () => {
    expect(clientTabsFor(rules({ phase: "en_alta", hasAccount: true }))).toEqual({
      tabs: ["resumen", "conversaciones", "historial", "alta", "pagos", "documentos"],
      more: ["venta", "uso", "soporte"],
    })
    expect(clientTabsFor(rules({ phase: "en_alta", hasAccount: true, isAdmin: false }))).toEqual({
      tabs: ["resumen", "historial", "alta", "documentos"],
      more: ["venta", "uso", "soporte"],
    })
  })

  it("activa: Uso a la vista; Soporte sale solo con casos abiertos", () => {
    expect(
      clientTabsFor(rules({ phase: "activo", hasAccount: true, openSupportCases: 2 })),
    ).toEqual({
      tabs: ["resumen", "conversaciones", "historial", "uso", "pagos", "soporte", "documentos"],
      more: ["venta", "alta"],
    })
    expect(phaseTab("activo")).toBe("uso")
    expect(phaseTab("en_alta")).toBe("alta")
  })

  it("una pestaña que no toca, aunque llegue en el enlace, abre el Resumen; Personas también", () => {
    expect(
      openClientTab("pagos", rules({ phase: "activo", hasAccount: true, isAdmin: false })),
    ).toBe("resumen")
    expect(openClientTab("uso", rules())).toBe("resumen")
    expect(openClientTab("conversaciones", rules({ isAdmin: false }))).toBe("resumen")
    expect(openClientTab("contactos", rules())).toBe("resumen")
    expect(openClientTab(undefined, rules())).toBe("resumen")
    expect(openClientTab("venta", rules({ isAdmin: false }))).toBe("venta")
    // Lo de «Más» y Soporte sin casos abiertos se abren igual con su enlace.
    expect(openClientTab("venta", rules({ phase: "activo", hasAccount: true }))).toBe("venta")
    expect(openClientTab("soporte", rules({ phase: "activo", hasAccount: true }))).toBe("soporte")
    expect(openClientTab("soporte", rules())).toBe("resumen")
  })

  it("lo abierto desde «Más» se ve junto a la pestaña de su fase y sale del menú", () => {
    const layout = clientTabsFor(rules({ phase: "en_alta", hasAccount: true }))
    expect(shownClientTabs(layout, "uso")).toEqual({
      tabs: ["resumen", "conversaciones", "historial", "alta", "uso", "pagos", "documentos"],
      more: ["venta", "soporte"],
    })
    expect(shownClientTabs(layout, "historial")).toBe(layout)
  })
})
