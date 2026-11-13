import { describe, expect, it } from "vitest"
import { clientTabsFor, openClientTab } from "./client-tabs"

describe("las pestañas de la ficha del cliente", () => {
  it("sin cuenta: Resumen, Historial, Contactos, Venta y Documentos", () => {
    expect(clientTabsFor({ hasAccount: false, isAdmin: true })).toEqual([
      "resumen",
      "historial",
      "contactos",
      "venta",
      "documentos",
    ])
  })

  it("con cuenta se suman Alta, Plan y pagos, Uso y Soporte; Plan y pagos solo para Administración", () => {
    expect(clientTabsFor({ hasAccount: true, isAdmin: true })).toEqual([
      "resumen",
      "historial",
      "contactos",
      "venta",
      "alta",
      "pagos",
      "uso",
      "soporte",
      "documentos",
    ])
    expect(clientTabsFor({ hasAccount: true, isAdmin: false })).not.toContain("pagos")
    expect(clientTabsFor({ hasAccount: true, isAdmin: false })).toContain("alta")
  })

  it("una pestaña que no toca, aunque llegue en el enlace, abre el Resumen", () => {
    expect(openClientTab("pagos", { hasAccount: true, isAdmin: false })).toBe("resumen")
    expect(openClientTab("uso", { hasAccount: false, isAdmin: true })).toBe("resumen")
    expect(openClientTab("venta", { hasAccount: false, isAdmin: false })).toBe("venta")
    expect(openClientTab(undefined, { hasAccount: true, isAdmin: true })).toBe("resumen")
  })
})
