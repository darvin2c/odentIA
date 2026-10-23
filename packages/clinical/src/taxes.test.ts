import { describe, expect, it } from "vitest"
import { assertTaxRate, includedTaxCents, resolveOrgTaxes, taxProfileFor } from "./taxes.js"

describe("el impuesto de lo que cobra la clínica", () => {
  it("separa el impuesto incluido en el precio, redondeado por línea", () => {
    expect(includedTaxCents(11_800, 1800)).toBe(1800)
    expect(includedTaxCents(5_900, 1800)).toBe(900)
    // Un pago a cuenta de 450,00: 381,36 más 68,64.
    expect(includedTaxCents(45_000, 1800)).toBe(6864)
    expect(includedTaxCents(59_500, 1900)).toBe(9500)
    expect(includedTaxCents(12_000, 0)).toBe(0)
  })

  it("propone lo de cada país sin que la clínica toque nada", () => {
    const peru = resolveOrgTaxes("PE")
    expect(peru?.name).toBe("IGV")
    expect(peru?.servicios).toMatchObject({ category: "S", rateBps: 1800, label: "IGV 18 %", isDefault: true })
    expect(peru?.productos).toMatchObject({ category: "S", rateBps: 1800 })
    expect(peru?.legalFormPending).toBe(false)

    // Chile y Colombia: la atención no lleva IVA; los productos, 19 %.
    expect(resolveOrgTaxes("CL")?.servicios).toMatchObject({ category: "E", rateBps: 0, label: "Exento de IVA" })
    expect(resolveOrgTaxes("CO")?.servicios).toMatchObject({ category: "O", rateBps: 0, label: "Excluido de IVA" })
    expect(resolveOrgTaxes("CO")?.productos).toMatchObject({ category: "S", rateBps: 1900 })

    // Un país sin su norma cargada no tiene impuesto que separar.
    expect(resolveOrgTaxes("AR")).toBeNull()
    expect(resolveOrgTaxes(null)).toBeNull()
  })

  it("en México la atención depende de cómo está constituida la clínica", () => {
    const pending = resolveOrgTaxes("MX")
    expect(pending?.legalFormPending).toBe(true)
    expect(pending?.servicios).toMatchObject({ category: "E", rateBps: 0 })
    const mercantil = resolveOrgTaxes("MX", { legalForm: "sociedad_mercantil" })
    expect(mercantil?.legalFormPending).toBe(false)
    expect(mercantil?.servicios).toMatchObject({ category: "S", rateBps: 1600, isDefault: true })
  })

  it("la clínica puede cambiarlo y la tarjeta sabe qué venía puesto", () => {
    const frontera = resolveOrgTaxes("MX", { legalForm: "persona_fisica", productos: { category: "S", rateBps: 800 } })
    expect(frontera?.productos).toMatchObject({ label: "IVA 8 %", isDefault: false, choiceKey: "iva8" })
    const otra = resolveOrgTaxes("PE", { servicios: { category: "S", rateBps: 1250 } }, "es-PE")
    expect(otra?.servicios).toMatchObject({ label: "IGV 12.5 %", isDefault: false, choiceKey: null })
  })

  it("rechaza tasas que no tienen sentido", () => {
    expect(() => assertTaxRate({ category: "S", rateBps: 0 })).toThrow()
    expect(() => assertTaxRate({ category: "S", rateBps: 9000 })).toThrow()
    expect(() => assertTaxRate({ category: "E", rateBps: 1800 })).toThrow()
    expect(assertTaxRate({ category: "O", rateBps: 0 })).toEqual({ category: "O", rateBps: 0 })
    expect(taxProfileFor("pe")?.name).toBe("IGV")
  })
})
