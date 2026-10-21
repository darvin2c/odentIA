import { describe, expect, it } from "vitest"
import { centsToMajor, majorToCents } from "./money"

describe("montos escritos en Plan y pagos (issue 36)", () => {
  it("se leen con los separadores de la clínica, los mismos con que se muestran", () => {
    // En Chile el punto agrupa miles: «50.000» son cincuenta mil, no cincuenta.
    expect(majorToCents("50.000", "CLP", "es-CL")).toBe(50000)
    expect(majorToCents("1.500.000", "COP", "es-CO")).toBe(150000000)
    expect(majorToCents("1500.50", "USD", "es-PE")).toBe(150050)
    expect(majorToCents("1500,50", "USD", "es-CO")).toBe(150050)
  })

  it("lo que no es un importe mayor que cero no se acepta", () => {
    expect(majorToCents("0", "USD", "es-PE")).toBeNull()
    expect(majorToCents("diez", "USD", "es-PE")).toBeNull()
    expect(majorToCents("10.555", "USD", "es-PE")).toBeNull()
  })

  it("lo guardado vuelve al campo en el mismo formato", () => {
    expect(centsToMajor(150050, "USD", "es-CO")).toBe("1500,50")
    expect(majorToCents(centsToMajor(150050, "USD", "es-CO"), "USD", "es-CO")).toBe(150050)
    expect(centsToMajor(50000, "CLP", "es-CL")).toBe("50000")
  })
})
