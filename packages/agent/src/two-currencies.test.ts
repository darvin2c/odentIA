/**
 * Lo que lee el modelo en una clínica con segunda moneda y que la comprobación
 * antes de enviar deja salir justo lo que se le da. Una clínica de una moneda lee
 * lo mismo de siempre: lo fija `product-prompts.test.ts`, carácter por carácter,
 * y aquí, que el mismo dato sin segunda moneda no trae nada nuevo.
 */
import type { AgentClinicData, AgentConfig, AgentServiceInfo, OrgLocale } from "@odentia/services"
import {
  agentTextsFor,
  formatAgentClinicData,
  formatClinicSearch,
  formatOrgMoneyToday,
  withTodayValueRule,
} from "@odentia/services"
import { describe, expect, it } from "vitest"
import { receptionPrompt } from "./graph"
import { verifyReply } from "./verify"

const ONE: OrgLocale = {
  countryCode: "PE",
  currency: "PEN",
  timezone: "America/Lima",
  locale: "es-PE",
}
const TWO: OrgLocale = { ...ONE, secondCurrency: "USD", exchangeFactor: "3.75" }
const NOW = new Date("2026-11-02T15:00:00Z")

const exact = (priceCents: number, currency: string) => ({
  disclosure: "exacto" as const,
  priceCents,
  currency,
  evaluation: null,
})
const service = (id: string, name: string, price: AgentServiceInfo["price"]): AgentServiceInfo => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  name,
  specialty: null,
  kind: null,
  durationMin: 60,
  price,
})

const SERVICES: AgentServiceInfo[] = [
  service("1", "Implante", exact(100_000, "USD")),
  service("2", "Limpieza", exact(15_000, "PEN")),
  service("3", "Corona", {
    disclosure: "desde",
    priceCents: 40_000,
    currency: "USD",
    evaluation: { name: "Evaluación", priceCents: 5_000, currency: "USD", disclosure: "exacto" },
  }),
]
const DATA: AgentClinicData = {
  hours: [],
  professionals: [],
  services: SERVICES,
  promotions: [
    {
      id: "p",
      name: "Sonrisa",
      endsAt: null,
      conditions: null,
      items: [
        {
          serviceName: "Implante",
          disclosure: "exacto",
          priceCents: 90_000,
          currency: "USD",
          tariffCents: 100_000,
          serviceDisclosure: "exacto",
        },
      ],
    },
  ],
  informs: true,
}
const spaced = (text: string) => text.replace(/\u00a0/g, " ")
const said = (zone: OrgLocale) => spaced(formatAgentClinicData(DATA, zone).join("\n"))
const SOURCE = (zone: OrgLocale) => [
  { source: "Conocimiento publicado de la clínica", text: said(zone) },
]

describe("lo que lee el modelo con dos monedas", () => {
  it("cada precio en su moneda, con lo que vale hoy en la del negocio", async () => {
    await expect(said(TWO)).toMatchFileSnapshot("./__golden__/clinica-dos-monedas.txt")
  })

  it("con una moneda, el mismo dato no trae ni el aproximado ni la regla", () => {
    const text = said(ONE)
    expect(text).not.toContain("hoy")
    expect(text).not.toContain("también en")
    expect(text).toContain(
      "- Implante (id 00000000-0000-4000-8000-000000000001), 60 min: USD 1,000.00\n",
    )
    // Una clínica con otra moneda, sin cambio guardado, tampoco dice un valor que no tiene.
    expect(spaced(formatOrgMoneyToday(100_000, "USD", { ...ONE, secondCurrency: "USD" }))).toBe(
      "USD 1,000.00",
    )
    expect(withTodayValueRule("Sin saldo pendiente.")).toBe("Sin saldo pendiente.")
  })

  it("el manual no cambia con la segunda moneda: lo que cambia va con los datos", () => {
    const config = {
      personaName: "Sofi",
      treatment: "tu",
      tone: "cercano",
      emojis: "pocos",
      about: "",
      disabledFunctions: [],
      functionNotes: {},
    } as unknown as AgentConfig
    const texts = agentTextsFor("dental")
    const facts = { tools: new Set(["send_reply"]), services: "lista" as const }
    expect(receptionPrompt(TWO, config, facts, texts)).toBe(
      receptionPrompt(ONE, config, facts, texts),
    )
  })

  it("lo aproximado no lleva céntimos y solo es de la otra moneda", () => {
    expect(spaced(formatOrgMoneyToday(9_900, "USD", TWO))).toBe("USD 99.00 (hoy, unos S/ 371)")
    expect(spaced(formatOrgMoneyToday(15_000, "PEN", TWO))).toBe("S/ 150.00")
    expect(spaced(formatOrgMoneyToday(0, "USD", TWO))).toBe("USD 0.00")
    // Pesos sin decimales: USD 100 a 950 son $ 95.000, sin dividir de más.
    const chile: OrgLocale = {
      countryCode: "CL",
      currency: "CLP",
      timezone: "America/Santiago",
      locale: "es-CL",
      secondCurrency: "USD",
      exchangeFactor: "9.5",
    }
    expect(spaced(formatOrgMoneyToday(10_000, "USD", chile))).toMatch(/\(hoy, unos \$\s?95\.000\)$/)
  })

  it("una herramienta que trae lo que vale hoy lleva la regla", () => {
    const line = `- Saldo pendiente: ${formatOrgMoneyToday(100_000, "USD", TWO)}.`
    expect(withTodayValueRule(line)).toContain("no prometas ese valor para un pago futuro")
    const search = formatClinicSearch(
      {
        services: SERVICES.slice(0, 1),
        promotions: [],
        professionals: [],
        more: { services: 0, promotions: 0, professionals: 0 },
      },
      TWO,
    )
    expect(spaced(search)).toContain("USD 1,000.00 (hoy, unos S/ 3,750)")
  })
})

describe("lo que dice sale si es lo que se le dio", () => {
  const check = (reply: string, zone: OrgLocale = TWO) =>
    verifyReply(reply, SOURCE(zone), zone, NOW).unsupported.map((item) => item.value)

  it("el precio en su moneda con su aproximado", () => {
    expect(check("El implante cuesta USD 1,000 (hoy, unos S/ 3,750).")).toEqual([])
    expect(check("La limpieza cuesta S/ 150.")).toEqual([])
    expect(check("La corona va desde USD 400 (hoy, desde S/ 1,500 aprox.).")).toEqual([])
    expect(check("La evaluación cuesta USD 50 (hoy, unos S/ 188).")).toEqual([])
    expect(
      check(
        "Con la promoción Sonrisa, el implante queda en USD 900 (hoy, unos S/ 3,375), ahorras USD 100.",
      ),
    ).toEqual([])
  })

  it("otro cambio, otra moneda o un mínimo dicho como precio no salen", () => {
    expect(check("El implante cuesta USD 1,000 (hoy, unos S/ 3,800).")).toEqual(["S/ 3,800"])
    expect(check("El implante cuesta S/ 1,000.")).toEqual([
      "S/ 1,000 (ese importe está en otra moneda)",
    ])
    expect(check("La corona cuesta S/ 1,500.")).toEqual([
      "S/ 1,500 (es un mínimo: dilo con «desde»)",
    ])
    expect(check("Implante USD 1,000 y limpieza S/ 150: en total USD 1,150.")).toEqual([
      "USD 1,150",
    ])
  })
})
