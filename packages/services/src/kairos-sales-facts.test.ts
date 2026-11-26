import { describe, expect, it } from "vitest"
import { kairosSalesFactsOf } from "./kairos-sales-facts.js"
import type { PublicPlanPrices, PublicPricing } from "./saas-founders.js"

/** Lo que Kairós lee de los precios: con su moneda, el alta libre y cómo cobra Clío (sin base). */

function plan(overrides: Partial<PublicPlanPrices>): PublicPlanPrices {
  return {
    code: "lista",
    name: "Clínica",
    currency: "USD",
    priceCents: 3900,
    creditCents: 3900,
    conversationMicros: 500_000,
    consultationMicros: 1_000_000,
    recoveryMicros: 2_000_000,
    tiers: {
      informa: 200_000,
      gestiona: 500_000,
      agenda: 1_000_000,
      simple: 300_000,
      estandar: 600_000,
      completa: 1_000_000,
    },
    argosIncludedQuestions: 50,
    argosPackQuestions: 100,
    argosPackMicros: 5_000_000,
    storageIncludedGb: 10,
    storageGbMicros: 300_000,
    trialCreditCents: 1000,
    trialDays: 14,
    ...overrides,
  }
}

const terms = {
  conversationWindowHours: 24,
  recoveryWindowDays: 30,
  reviewAutoPercent: 0,
  reviewAnswerDays: 5,
  halfCycleDays: 15,
  graceDays: 7,
  trialDays: 14,
  guaranteeNoticeDays: 30,
} as PublicPricing["terms"]

const pricing: PublicPricing = {
  list: plan({}),
  terms,
}

describe("kairosSalesFactsOf", () => {
  it("con plan de lista, se empieza gratis y al momento, sin invitación ni Fundadores", () => {
    const facts = kairosSalesFactsOf("medical", pricing)
    const prices = facts.prices.join("\n")
    expect(facts.prices).toContain("Se empieza gratis: se crea la cuenta y se abre tu consultorio al momento, sin invitación ni tarjeta.")
    expect(prices).not.toMatch(/Fundadores|por invitación|solicitar-invitacion/)
    expect(facts.facts.join("\n")).not.toMatch(/Fundadores|solicitar-invitacion/)
    expect(facts.percents).toEqual([])
  })

  it("cada importe va con su moneda y la moneda de los planes se dice una vez", () => {
    const facts = kairosSalesFactsOf("medical", pricing)
    expect(facts.prices).toContain("Todos los importes están en USD (dólares de Estados Unidos).")
    expect(facts.prices.join("\n")).toContain("Plan Clínica (precio de lista): USD 39 al mes")
    expect(facts.amounts.every((amount) => amount.currency === "USD")).toBe(true)
  })

  it("Clío cobra por consulta dictada, como en su web", () => {
    const prices = kairosSalesFactsOf("medical", pricing).prices.join("\n")
    expect(prices).toContain(
      "Clínica: Clío cobra por cada consulta que deja lista con el dictado: USD 0,30 una consulta simple, USD 0,60 una estándar, USD 1 una completa; si se descarta su borrador, no se cobra.",
    )
  })

  it("sin plan de lista no promete abrir la cuenta por la web", () => {
    const closed = kairosSalesFactsOf("optical", { ...pricing, list: null })
    expect(closed.prices).toContain(
      "Todavía no se abren cuentas nuevas de vistIA por la web: para empezar, el equipo de Sallca agenda una presentación.",
    )
    expect(closed.prices.join("\n")).not.toMatch(/Se empieza gratis|Fundadores/)
    expect(closed.amounts).toEqual([])
  })
})
