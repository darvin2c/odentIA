import { describe, expect, it } from "vitest"
import { billingStartText, offerOf, trialFaq } from "./offer"
import type { PlanPrices, Pricing, Terms } from "./pricing"

/** Un plan de ejemplo: las cifras reales salen de la administración. */
const plan = (price: number): PlanPrices => ({
  name: "Plan",
  currency: "USD",
  plan: price,
  credit: price,
  conversation: 0.5,
  consultation: 0.5,
  recovered: 2,
  tiers: { informa: 0.1, gestiona: 0.5, agenda: 1, simple: 0.1, estandar: 0.2, completa: 0.5 },
  argos: null,
  storage: null,
  trialCredit: 100,
  trialDays: 30,
})
const terms = { trialDays: 30 } as Terms
const INVITATION: Pricing = {
  list: plan(29),
  founders: { ...plan(0), discountPercent: 50, guaranteeMonths: 12 },
  signupMode: "invitacion",
  terms,
}
const OPEN: Pricing = { ...INVITATION, signupMode: "abierta" }

describe("la oferta cuenta una sola historia", () => {
  it("con invitación es la de Fundadores: sin cuota, con el regalo, y el plan sigue solo al terminar la prueba", () => {
    expect(offerOf(INVITATION)).toEqual({ founder: true, gift: "USD 100", trial: "30 días", noFee: true, discount: "50 % menos en cada trabajo durante 12 meses" })
    const [card, end] = trialFaq(INVITATION, "clínica")
    expect(card?.a).toContain("La tarjeta no se pide")
    expect(end?.a).toContain("no activas nada")
    expect(end?.a).toContain("50 % menos en cada trabajo durante 12 meses")
    expect(billingStartText(INVITATION)).toContain("sin que actives nada")
  })

  it("con el alta abierta, el plan se elige; sin elegirlo, solo lectura sin perder datos", () => {
    const [card, end] = trialFaq(OPEN, "óptica")
    expect(card?.a).toContain("30 días con USD 100 de crédito")
    expect(end?.a).toContain("solo lectura")
    expect(billingStartText(OPEN)).toContain("el día que lo eliges")
  })

  it("ninguna de las dos promete «activar el plan» ni pide tarjeta para seguir", () => {
    for (const pricing of [INVITATION, OPEN]) {
      const text = [...trialFaq(pricing, "clínica").map((item) => item.a), billingStartText(pricing)].join(" ")
      expect(text).not.toMatch(/activas el plan|activar el plan|tarjeta solo se pide/)
    }
  })
})
