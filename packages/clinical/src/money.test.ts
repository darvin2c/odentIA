import { describe, expect, it } from "vitest"
import {
  cancelledCents,
  commissionCents,
  convertCents,
  currencyFractionDigits,
  currencyWord,
  exchangeFactor,
  exchangeRateWords,
  expenseExchange,
  formatExchangeRateInput,
  formatMoney,
  formatMoneyInput,
  frozenValueCents,
  impliedExchangeRate,
  moneyValue,
  normalizeExchangeRate,
  parseExchangeRate,
  parseMoney,
  refundTenderCents,
  roundMoneyValue,
  settleToDue,
  splitCents,
  sumMoneyValues,
} from "./money.js"

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

describe("el cambio de hoy", () => {
  it("tiene una sola forma: la que se guarda y la que entra en la huella del cobro", () => {
    expect(normalizeExchangeRate("3.750")).toBe("3.75")
    expect(normalizeExchangeRate("03.75")).toBe("3.75")
    expect(normalizeExchangeRate(" 950 ")).toBe("950")
    expect(normalizeExchangeRate("950.00")).toBe("950")
    expect(normalizeExchangeRate("0.004")).toBe("0.004")
    for (const bad of ["", "0", "0.00", "-3.75", "3,75", "3.7.5", "abc", "1234567890", "1.12345678901"]) {
      expect(() => normalizeExchangeRate(bad), bad).toThrow()
    }
  })

  it("se escribe con el formato de la clínica, sin adivinar separadores", () => {
    expect(parseExchangeRate("3.75", "es-PE")).toBe("3.75")
    expect(parseExchangeRate("3,75", "es-CL")).toBe("3.75")
    expect(parseExchangeRate("3.750,5", "es-CL")).toBe("3750.5")
    expect(() => parseExchangeRate("3,75", "es-PE")).toThrow()
    expect(() => parseExchangeRate("", "es-PE")).toThrow("Escribe el cambio")
    expect(formatExchangeRateInput("3.75", "es-CL")).toBe("3,75")
    expect(formatExchangeRateInput("3.75", "es-PE")).toBe("3.75")
  })

  it("el factor es por unidad menor: CLP y COP no tienen decimales", () => {
    expect(exchangeFactor("3.75", "PEN", "USD")).toBe("3.75")
    // 950 pesos por USD 1: el dólar tiene 100 unidades menores y el peso una.
    expect(exchangeFactor("950", "CLP", "USD")).toBe("9.5")
    expect(exchangeFactor("4000", "COP", "USD")).toBe("40")
    // 0.004 soles por peso: el peso es unidad entera y el sol tiene 100.
    expect(exchangeFactor("0.004", "PEN", "CLP")).toBe("0.4")
    expect(exchangeFactor("0.4", "PEN", "CLP")).toBe("40")
    expect(exchangeFactor("0.005", "CLP", "USD")).toBe("0.00005")
  })
})

describe("convertir y cuadrar", () => {
  const business = { businessCurrency: "PEN", factor: "3.75" }

  it("redondea half-up en las dos direcciones, por unidad menor", () => {
    expect(convertCents({ amountCents: 100000, from: "USD", to: "PEN", ...business })).toBe(375000)
    expect(convertCents({ amountCents: 375000, from: "PEN", to: "USD", ...business })).toBe(100000)
    expect(convertCents({ amountCents: 200000, from: "PEN", to: "USD", ...business })).toBe(53333)
    // 0.5 unidad menor sube, nunca al par: 1 × 2.5 = 2.5 → 3.
    expect(convertCents({ amountCents: 1, from: "USD", to: "PEN", businessCurrency: "PEN", factor: "2.5" })).toBe(3)
    expect(convertCents({ amountCents: 10000, from: "USD", to: "CLP", businessCurrency: "CLP", factor: "9.5" })).toBe(95000)
    expect(convertCents({ amountCents: 95000, from: "CLP", to: "USD", businessCurrency: "CLP", factor: "9.5" })).toBe(10000)
    expect(convertCents({ amountCents: 500, from: "USD", to: "USD", ...business })).toBe(500)
    expect(() => convertCents({ amountCents: 1, from: "USD", to: "EUR", ...business })).toThrow()
  })

  it("a una unidad menor o menos de lo que se debe, cancela justo lo que se debe", () => {
    expect(settleToDue(99999, 100000)).toBe(100000)
    expect(settleToDue(100000, 100000)).toBe(100000)
    expect(settleToDue(99998, 100000)).toBe(99998)
    expect(settleToDue(100001, 100000)).toBe(100001)
  })

  it("pagar lo que se propuso deja al día, también cuando de vuelta no da exacto", () => {
    const pen = { businessCurrency: "PEN", factor: "3.75" }
    // Debe USD 1,000 y paga S/ 3,750.
    expect(
      cancelledCents({
        paidCents: 375000,
        paidCurrency: "PEN",
        dueCents: 100000,
        currency: "USD",
        ...pen,
      }),
    ).toBe(100000)
    // Debe S/ 301.03: se proponen USD 80.27, que de vuelta son S/ 301.01.
    expect(
      cancelledCents({
        paidCents: 8027,
        paidCurrency: "USD",
        dueCents: 30103,
        currency: "PEN",
        ...pen,
      }),
    ).toBe(30103)
    // Debe S/ 301.00: los mismos USD 80.27 darían S/ 301.01, un centavo de más a favor.
    expect(
      cancelledCents({
        paidCents: 8027,
        paidCurrency: "USD",
        dueCents: 30100,
        currency: "PEN",
        ...pen,
      }),
    ).toBe(30100)
    // Lo pagado es otra cifra: se convierte y solo cuadra a una unidad o menos.
    expect(
      cancelledCents({
        paidCents: 37500,
        paidCurrency: "PEN",
        dueCents: 10001,
        currency: "USD",
        ...pen,
      }),
    ).toBe(10001)
    expect(
      cancelledCents({
        paidCents: 37500,
        paidCurrency: "PEN",
        dueCents: 20000,
        currency: "USD",
        ...pen,
      }),
    ).toBe(10000)
    // Sin deuda (un adelanto): S/ 2,000 quedan en USD 533.33.
    expect(
      cancelledCents({
        paidCents: 200000,
        paidCurrency: "PEN",
        dueCents: 0,
        currency: "USD",
        ...pen,
      }),
    ).toBe(53333)
    // En la misma moneda no hay conversión.
    expect(
      cancelledCents({
        paidCents: 5000,
        paidCurrency: "USD",
        dueCents: 9000,
        currency: "USD",
        ...pen,
      }),
    ).toBe(5000)
  })

  it("el cambio y la moneda en palabras, con el formato de la clínica", () => {
    expect(exchangeRateWords("3.75", "PEN", "USD", "es-PE")).toBe("S/ 3.75 por USD 1")
    expect(exchangeRateWords("950", "CLP", "USD", "es-CL")).toMatch(/^\$ 950 por US\$ 1$/)
    expect(currencyWord("PEN", "es-PE")).toBe("soles")
    expect(currencyWord("USD", "es-PE")).toBe("dólares")
    expect(currencyWord("CLP", "es-CL")).toBe("pesos")
  })

  it("el valor congelado: exacto en moneda del negocio", () => {
    const pen = { businessCurrency: "PEN", factor: "3.75" }
    // Debe USD 1,000 y paga S/ 3,750; paga USD.
    expect(frozenValueCents({ amountCents: 100000, currency: "USD", paidCents: 375000, paidCurrency: "PEN", ...pen })).toBe(375000)
    expect(frozenValueCents({ amountCents: 100000, currency: "USD", paidCents: 100000, paidCurrency: "USD", ...pen })).toBe(375000)
    // Debe S/ 300 y da un billete de USD 100: importe USD 80, cancela S/ 300.
    expect(frozenValueCents({ amountCents: 30000, currency: "PEN", paidCents: 8000, paidCurrency: "USD", ...pen })).toBe(30000)
    // Lo pagado en moneda del negocio manda aunque el cambio diga otra cosa.
    expect(frozenValueCents({ amountCents: 100000, currency: "USD", paidCents: 374998, paidCurrency: "PEN", ...pen })).toBe(374998)
  })
})

describe("lo que congela un gasto", () => {
  const business = "PEN"

  it("el cambio que resulta de lo pagado se dice como todo cambio, en cualquier sentido", () => {
    const dollars = { amountCents: 150_000, currency: "USD", businessCurrency: business }
    expect(impliedExchangeRate({ ...dollars, tenderCents: 564_000, tenderCurrency: "PEN" })).toBe(
      "3.76",
    )
    expect(
      impliedExchangeRate({
        amountCents: 37_600,
        currency: "PEN",
        tenderCents: 10_000,
        tenderCurrency: "USD",
        businessCurrency: business,
      }),
    ).toBe("3.76")
    // Lo que no da exacto se redondea: solo se muestra.
    expect(impliedExchangeRate({ ...dollars, tenderCents: 564_100, tenderCurrency: "PEN" })).toBe(
      "3.760667",
    )
    // Pesos sin decimales: 950 pesos por dólar, no 9.5.
    expect(
      impliedExchangeRate({
        amountCents: 10_000,
        currency: "USD",
        tenderCents: 95_000,
        tenderCurrency: "CLP",
        businessCurrency: "CLP",
      }),
    ).toBe("950")
    expect(() =>
      impliedExchangeRate({
        ...dollars,
        tenderCents: 1,
        tenderCurrency: "EUR",
        businessCurrency: "CLP",
      }),
    ).toThrow()
  })

  it("cruzar vale lo que está en moneda del negocio; sin cruzar, el importe por el cambio; en la del negocio, nada", () => {
    const lines = { businessCurrency: business }
    expect(
      expenseExchange({
        ...lines,
        amountCents: 150_000,
        currency: "USD",
        tender: { cents: 564_000, currency: "PEN" },
      }),
    ).toEqual({
      tender: { cents: 564_000, currency: "PEN" },
      exchangeRate: "3.76",
      businessCents: 564_000,
    })
    expect(
      expenseExchange({
        ...lines,
        amountCents: 37_600,
        currency: "PEN",
        tender: { cents: 10_000, currency: "USD" },
      }),
    ).toEqual({
      tender: { cents: 10_000, currency: "USD" },
      exchangeRate: "3.76",
      businessCents: 37_600,
    })
    expect(
      expenseExchange({ ...lines, amountCents: 50_000, currency: "USD", rate: "3.750" }),
    ).toEqual({
      tender: null,
      exchangeRate: "3.75",
      businessCents: 187_500,
    })
    expect(expenseExchange({ ...lines, amountCents: 50_000, currency: "PEN" })).toBeNull()
    expect(() => expenseExchange({ ...lines, amountCents: 50_000, currency: "USD" })).toThrow(
      "Escribe el cambio",
    )
  })
})

describe("la cuenta única del valor", () => {
  const value = (partCents: number, rest: Partial<Parameters<typeof moneyValue>[0]> = {}) =>
    moneyValue({ partCents, amountCents: 100000, valueCents: null, currency: "PEN", businessCurrency: "PEN", factor: null, ...rest })

  it("las partes de USD 1,000 que valen S/ 3,750 suman el valor exacto, sin redondear fila por fila", () => {
    const parts = [33333, 33333, 33334].map((partCents) =>
      value(partCents, { valueCents: 375000, currency: "USD" }),
    )
    expect(roundMoneyValue(sumMoneyValues(parts))).toBe(375000)
    // Cada fila redondeada sola también suma, pero la cuenta no depende de eso.
    const third = sumMoneyValues([value(33333, { valueCents: 100000, amountCents: 99999, currency: "USD" })])
    expect(third.num * 3n).toBe(third.den * 100000n)
  })

  it("sin valor vale la moneda del negocio o el factor; sin factor no hay valor", () => {
    expect(roundMoneyValue(value(15000)!)).toBe(15000)
    expect(roundMoneyValue(value(100000, { currency: "USD", factor: "3.75" })!)).toBe(375000)
    expect(value(100000, { currency: "USD" })).toBeNull()
    expect(roundMoneyValue(sumMoneyValues([value(100, { currency: "USD" }), value(50)]))).toBe(50)
  })

  it("un importe cero vale cero, sin dividir entre cero", () => {
    expect(roundMoneyValue(value(100, { amountCents: 0, valueCents: 5000, currency: "USD" })!)).toBe(0)
  })

  it("una moneda sin decimales: USD 100 a 950 pesos valen 95,000 pesos", () => {
    const factor = exchangeFactor("950", "CLP", "USD")
    expect(roundMoneyValue(value(10000, { currency: "USD", businessCurrency: "CLP", factor })!)).toBe(95000)
  })
})

describe("lo devuelto y la comisión", () => {
  it("la devolución sale en lo que entró y en proporción, sin importar en cuántas partes", () => {
    // S/ 300 cancelados con USD 80: devolver todo es USD 80, en una o varias veces.
    const whole = refundTenderCents({ tenderCents: 8000, amountCents: 30000, previousCents: 0, refundCents: 30000 })
    expect(whole).toBe(8000)
    let previous = 0
    let total = 0
    for (const refund of [10000, 7000, 3333, 9667]) {
      total += refundTenderCents({ tenderCents: 8000, amountCents: 30000, previousCents: previous, refundCents: refund })
      previous += refund
    }
    expect(total).toBe(8000)
    // Sin otra moneda T = A: sale lo mismo que se devuelve.
    expect(refundTenderCents({ tenderCents: 15000, amountCents: 15000, previousCents: 2000, refundCents: 3000 })).toBe(3000)
  })

  it("la comisión multiplica antes de dividir y coincide con la de una moneda", () => {
    expect(commissionCents({ appliedCents: 10000, amountCents: 10000, valueCents: 10000, rateBps: 4000 })).toBe(4000)
    expect(commissionCents({ appliedCents: 33333, amountCents: 100000, valueCents: 375000, rateBps: 3333 })).toBe(41662)
    // Más allá de 2^53 en el producto intermedio: con números de coma flotante se perdería.
    expect(
      commissionCents({ appliedCents: 2_000_000_000, amountCents: 2_100_000_000, valueCents: 2_147_483_647, rateBps: 9999 }),
    ).toBe(2_045_017_998)
  })

  it("reparte en proporción y el resto del redondeo va a la última fila", () => {
    expect(splitCents(100, [1, 1, 1])).toEqual([33, 33, 34])
    expect(splitCents(375000, [50000, 50000])).toEqual([187500, 187500])
    expect(splitCents(100, [0, 0])).toEqual([0, 100])
    const parts = splitCents(375001, [33333, 33333, 33334])
    expect(parts.reduce((acc, part) => acc + part, 0)).toBe(375001)
  })
})
