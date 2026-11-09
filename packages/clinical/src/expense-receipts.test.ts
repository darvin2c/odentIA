import { describe, expect, it } from "vitest"
import { expenseReceiptType, expenseReceiptTypes, NO_RECEIPT_TYPE, suggestedReceiptType } from "./expense-receipts.js"

describe("el comprobante de un gasto, por país (ADR 0167)", () => {
  it("en el Perú es la tabla 10 de SUNAT, con su código oficial", () => {
    expect(expenseReceiptTypes("PE").map((type) => type.code).sort()).toEqual(["01", "02", "03", "12", "14"])
    expect(expenseReceiptType("pe", "01")).toMatchObject({ label: "Factura", asksTaxId: true })
    expect(expenseReceiptType("PE", "99")).toBeNull()
  })

  it("en otro país, sin su tabla cargada, los papeles de siempre y sin códigos inventados", () => {
    expect(expenseReceiptTypes("CL").every((type) => !/^\d+$/.test(type.code))).toBe(true)
  })

  it("propone el papel que suele traer cada tipo de gasto", () => {
    expect(suggestedReceiptType("PE", "Servicios")).toBe("14")
    expect(suggestedReceiptType("PE", "Laboratorio")).toBe("01")
    expect(suggestedReceiptType("PE", "Materiales")).toBe("03")
    expect(suggestedReceiptType("PE", "Personal")).toBe(NO_RECEIPT_TYPE)
  })
})
