import { describe, expect, it } from "vitest"
import { currencyFractionDigits, formatMoney, formatMoneyInput, parseMoney } from "./money.js"

describe("importes en unidad menor ISO 4217", () => {
  it("conserva las unidades de monedas con cero, dos, tres y cuatro decimales", () => {
    expect(currencyFractionDigits("CLP")).toBe(0)
    expect(currencyFractionDigits("PEN")).toBe(2)
    expect(currencyFractionDigits("KWD")).toBe(3)
    expect(currencyFractionDigits("CLF")).toBe(4)
    expect(parseMoney("1.500", "CLP", "es-CL")).toBe(1500)
    expect(parseMoney("120.50", "PEN", "es-PE")).toBe(12050)
    expect(parseMoney("1.501", "KWD", "en-US")).toBe(1501)
    expect(parseMoney("1,0001", "CLF", "es-CL")).toBe(10001)
  })

  it("muestra y permite editar la coma decimal sin multiplicar el importe por cien", () => {
    expect(formatMoneyInput(12050, "EUR", "es-ES")).toBe("120,50")
    expect(parseMoney("120,50", "EUR", "es-ES")).toBe(12050)
    expect(formatMoney(12050, "EUR", "es-ES")).toBe("120,50\u00a0€")
    expect(formatMoneyInput(1500, "CLP", "es-CL")).toBe("1500")
  })

  it("solo retira agrupaciones válidas; un separador erróneo no cambia silenciosamente el precio", () => {
    expect(parseMoney("1,234.56", "USD", "en-US")).toBe(123456)
    expect(parseMoney("1\u202f234,56", "EUR", "fr-FR")).toBe(123456)
    expect(parseMoney("12,34,567.89", "INR", "en-IN")).toBe(123456789)
    expect(() => parseMoney("120,50", "PEN", "es-PE")).toThrow()
    expect(() => parseMoney("120.50", "EUR", "es-ES")).toThrow()
    expect(() => parseMoney("12,34.56", "USD", "en-US")).toThrow()
  })

  it("rechaza fracciones no representables, vacío, negativos y códigos no ISO", () => {
    expect(() => parseMoney("10.555", "PEN", "es-PE")).toThrow()
    expect(() => parseMoney("10,5", "CLP", "es-CL")).toThrow()
    expect(() => parseMoney(" ", "PEN", "es-PE")).toThrow()
    expect(() => parseMoney("-5", "PEN", "es-PE")).toThrow()
    expect(() => currencyFractionDigits("ZZZ")).toThrow()
  })

  it("no redondea ni desborda el entero persistido", () => {
    expect(parseMoney("21474836.47", "USD", "en-US")).toBe(2147483647)
    expect(() => parseMoney("21474836.48", "USD", "en-US")).toThrow()
    expect(parseMoney("0.29", "USD", "en-US")).toBe(29)
    expect(parseMoney("0", "USD", "en-US")).toBe(0)
  })
})
