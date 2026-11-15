import { describe, expect, it } from "vitest"
import { kairosSalesFactsOf } from "./kairos-sales-facts.js"
import type { PublicPlanPrices, PublicPricing } from "./saas-founders.js"

/** Lo que Kairós lee de los precios: con su moneda, Fundadores y cómo cobra Clío (sin base). */

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
  waitlistAnswerDays: 3,
  guaranteeNoticeDays: 30,
} as PublicPricing["terms"]

const pricing: PublicPricing = {
  list: plan({}),
  founders: {
    ...plan({
      code: "fundadores",
      name: "Fundadores",
      priceCents: 0,
      creditCents: 0,
      tiers: {
        informa: 100_000,
        gestiona: 250_000,
        agenda: 500_000,
        simple: 150_000,
        estandar: 300_000,
        completa: 500_000,
      },
      trialCreditCents: 2000,
      trialDays: 30,
    }),
    discountPercent: 50,
    guaranteeMonths: 12,
  },
  signupMode: "invitacion",
  terms,
}

describe("kairosSalesFactsOf", () => {
  it("dice qué es Fundadores, cuánto se ahorra y que hoy se entra con él", () => {
    const facts = kairosSalesFactsOf("medical", pricing)
    const prices = facts.prices.join("\n")
    expect(prices).toContain("es el plan de las clínicas que entran por invitación")
    expect(prices).toContain(
      "Lo que se ahorra con Fundadores: paga 50 % menos en cada trabajo de los agentes que el precio de lista durante 12 meses.",
    )
    expect(prices).toContain("Hoy se entra por invitación, con el plan Fundadores")
    expect(facts.percents).toEqual([50])
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

  it("sin invitación ni Fundadores no lo nombra", () => {
    const open = kairosSalesFactsOf("dental", { ...pricing, founders: null, signupMode: "abierta" })
    expect(open.prices.join("\n")).not.toMatch(/Fundadores/)
  })
})
