import { describe, expect, it } from "vitest"
import { amountsWords, compactMoney, methodsCashNote, type ReportFinance } from "./reports"

describe("la cifra corta de un gráfico", () => {
  it("usa los decimales de su moneda: 45.000 pesos chilenos no son 450", () => {
    expect(compactMoney(45_000, "CLP", "es-CL")).toBe(
      new Intl.NumberFormat("es-CL", { notation: "compact", maximumFractionDigits: 1 }).format(
        45_000,
      ),
    )
    expect(compactMoney(45_000, "COP", "es-CO")).toBe(
      new Intl.NumberFormat("es-CO", { notation: "compact", maximumFractionDigits: 1 }).format(
        45_000,
      ),
    )
    expect(compactMoney(4_500_000, "PEN", "es-PE")).toBe(
      new Intl.NumberFormat("es-PE", { notation: "compact", maximumFractionDigits: 1 }).format(
        45_000,
      ),
    )
  })
})

describe("lo que se debe por moneda", () => {
  it("cada cifra lleva su símbolo", () => {
    expect(
      amountsWords(
        [
          { currency: "PEN", cents: 1_240_000 },
          { currency: "USD", cents: 300_000 },
        ],
        "es-PE",
      ),
    ).toMatch(/^S\/\s?12,400\.00 y (US\$|USD)\s?3,000\.00$/)
  })
})

describe("el efectivo frente a los cierres de caja", () => {
  const data = (byMethod: ReportFinance["byMethod"]) => ({
    byMethod,
    currency: "PEN",
    locale: "es-PE",
  })

  it("con una moneda dice lo de siempre", () => {
    const methods = [{ label: "Efectivo", cash: true, cents: 10_000 }]
    expect(methodsCashNote(data({ methods, closures: { count: 0, cashCents: 0 } }))).toBe(
      "Aún no hay cierres de caja en este periodo para comparar el efectivo.",
    )
    expect(methodsCashNote(data({ methods: [], closures: { count: 0, cashCents: 0 } }))).toBeNull()
    expect(methodsCashNote(data({ methods, closures: { count: 1, cashCents: 10_000 } }))).toBe(
      "El efectivo coincide con los cierres de caja del periodo.",
    )
    expect(methodsCashNote(data({ methods, closures: { count: 1, cashCents: 9_000 } }))).toMatch(
      /^El efectivo \(S\/\s?100\.00\) no coincide con los cierres de caja \(S\/\s?90\.00\): puede haber una caja sin cerrar o un cierre que abarca días de otro periodo\.$/,
    )
  })

  it("con dos monedas compara lo que entró en cada una con su caja, no el valor en soles", () => {
    const methods = [
      {
        label: "Efectivo",
        cash: true,
        cents: 475_000,
        entered: [
          { currency: "PEN", cents: 100_000, valueCents: 100_000 },
          { currency: "USD", cents: 100_000, valueCents: 375_000 },
        ],
      },
      {
        label: "Tarjeta",
        cash: false,
        cents: 37_500,
        entered: [{ currency: "USD", cents: 10_000, valueCents: 37_500 }],
      },
    ]
    expect(
      methodsCashNote(
        data({
          methods,
          closures: {
            count: 1,
            cashCents: 100_000,
            others: [{ currency: "USD", count: 1, cashCents: 100_000 }],
          },
        }),
      ),
    ).toBe("El efectivo coincide con los cierres de caja del periodo.")
    expect(
      methodsCashNote(
        data({
          methods,
          closures: {
            count: 1,
            cashCents: 100_000,
            others: [{ currency: "USD", count: 1, cashCents: 90_000 }],
          },
        }),
      ),
    ).toMatch(
      /^El efectivo en dólares \((US\$|USD)\s?1,000\.00\) no coincide con los cierres de esa caja \((US\$|USD)\s?900\.00\): /,
    )
    // Cerrada solo la de soles: falta la de dólares.
    expect(methodsCashNote(data({ methods, closures: { count: 1, cashCents: 100_000 } }))).toMatch(
      /^El efectivo en dólares/,
    )
  })
})
