import { describe, expect, it } from "vitest"
import { centsToMajor, majorToCents, readMajor } from "./money"

describe("montos escritos en Plan y pagos (issue 36)", () => {
  it("se leen con los separadores de la clínica, los mismos con que se muestran", () => {
    // En Chile el punto agrupa miles: «50.000» son cincuenta mil, no cincuenta.
    expect(majorToCents("50.000", "CLP", "es-CL")).toBe(50000)
    // En dólares: los decimales del peso colombiano cambian según la versión de ICU (0 o 2).
    expect(majorToCents("1.500.000", "USD", "es-CO")).toBe(150000000)
    expect(majorToCents("1500.50", "USD", "es-PE")).toBe(150050)
    expect(majorToCents("1500,50", "USD", "es-CO")).toBe(150050)
  })

  it("lo que no es un importe mayor que cero no se acepta", () => {
    expect(majorToCents("0", "USD", "es-PE")).toBeNull()
    expect(majorToCents("diez", "USD", "es-PE")).toBeNull()
    expect(majorToCents("10.555", "USD", "es-PE")).toBeNull()
  })

  it("dice por qué no vale lo escrito, no solo que no vale", () => {
    expect(readMajor("10.555", "USD", "es-PE")).toEqual({ ok: false, error: "Esta moneda admite hasta 2 decimales." })
    expect(readMajor("0", "USD", "es-PE")).toEqual({ ok: false, error: "El importe debe ser mayor que cero." })
    expect(readMajor("12,50", "USD", "es-CO")).toEqual({ ok: true, cents: 1250 })
  })

  it("lo guardado vuelve al campo en el mismo formato", () => {
    expect(centsToMajor(150050, "USD", "es-CO")).toBe("1500,50")
    expect(majorToCents(centsToMajor(150050, "USD", "es-CO"), "USD", "es-CO")).toBe(150050)
    expect(centsToMajor(50000, "CLP", "es-CL")).toBe("50000")
  })
})
