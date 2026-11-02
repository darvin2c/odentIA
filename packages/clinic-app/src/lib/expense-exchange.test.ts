import { describe, expect, it } from "vitest"
import { currencyChoices, expenseRateWords, readExpenseMoney } from "./expense-exchange"
import type { OrgSecondCurrency } from "./org"

const second: OrgSecondCurrency = {
  currency: "USD",
  rate: "3.75",
  factor: "3.75",
  at: null,
  byName: null,
}
const base = { second, business: "PEN", tenderText: "", rateText: "3.75", locale: "es-PE" }

describe("lo que se lee del formulario de un gasto", () => {
  it("sin otra moneda no se pregunta nada y el cuerpo no lleva nada de más", () => {
    expect(
      readExpenseMoney({
        ...base,
        second: null,
        cents: 50_000,
        currency: "PEN",
        payIn: "PEN",
        tenderText: "1",
        rateText: "3",
      }),
    ).toEqual({
      asks: false,
      payIn: "PEN",
      crossed: false,
      needsRate: false,
      outCents: 50_000,
      tenderError: null,
      rateError: null,
      frozen: null,
      body: {},
    })
  })

  it("en moneda del negocio de punta a punta tampoco hay nada que congelar", () => {
    const money = readExpenseMoney({ ...base, cents: 50_000, currency: "PEN", payIn: "PEN" })
    expect(money).toMatchObject({
      asks: true,
      crossed: false,
      needsRate: false,
      outCents: 50_000,
      frozen: null,
      body: {},
    })
  })

  it("en la otra moneda pide el cambio y dice cuánto vale", () => {
    const money = readExpenseMoney({ ...base, cents: 50_000, currency: "USD", payIn: "USD" })
    expect(money).toMatchObject({
      needsRate: true,
      outCents: 50_000,
      body: { exchangeRate: "3.75" },
    })
    expect(money.frozen?.businessCents).toBe(187_500)
    expect(
      readExpenseMoney({ ...base, rateText: "", cents: 50_000, currency: "USD", payIn: "USD" })
        .rateError,
    ).toBe("Escribe el cambio")
  })

  it("pagar una compra en dólares con soles: lo que salió dice el cambio y lo que vale", () => {
    const money = readExpenseMoney({
      ...base,
      tenderText: "5,640.00",
      cents: 150_000,
      currency: "USD",
      payIn: "PEN",
    })
    expect(money).toMatchObject({
      crossed: true,
      needsRate: false,
      payIn: "PEN",
      outCents: 564_000,
      body: { tenderCents: 564_000, tenderCurrency: "PEN" },
      frozen: { exchangeRate: "3.76", businessCents: 564_000 },
    })
    expect(
      readExpenseMoney({ ...base, cents: 150_000, currency: "USD", payIn: "PEN" }).tenderError,
    ).toBe("Escribe lo que salió.")
    expect(
      readExpenseMoney({ ...base, tenderText: "x", cents: 150_000, currency: "USD", payIn: "PEN" })
        .tenderError,
    ).toMatch(/no se entiende/)
  })

  it("solo con lo que se tenía a favor no sale dinero: no se pide nada", () => {
    const money = readExpenseMoney({ ...base, cents: 0, currency: "USD", payIn: "PEN" })
    expect(money).toMatchObject({ outCents: 0, tenderError: null, rateError: null, body: {} })
  })

  it("una compra en una tercera moneda no pregunta con qué se paga", () => {
    const money = readExpenseMoney({ ...base, cents: 10, currency: "EUR", payIn: "PEN" })
    expect(money).toMatchObject({
      asks: false,
      payIn: "EUR",
      crossed: false,
      needsRate: false,
      body: {},
    })
  })

  it("las monedas por su nombre y el cambio de un gasto, en cualquier sentido", () => {
    expect(currencyChoices(["PEN"], "es-PE")).toEqual([{ value: "PEN", label: "Soles" }])
    const words = "S/ 3.76 por USD 1".replace(/\s/g, " ")
    const plain = (text: string) => text.replace(/\s/g, " ")
    expect(
      plain(
        expenseRateWords(
          { exchangeRate: "3.76", currency: "USD", tenderCurrency: "PEN" },
          "PEN",
          "es-PE",
        ),
      ),
    ).toBe(words)
    expect(
      plain(
        expenseRateWords(
          { exchangeRate: "3.76", currency: "PEN", tenderCurrency: "USD" },
          "PEN",
          "es-PE",
        ),
      ),
    ).toBe(words)
  })
})
