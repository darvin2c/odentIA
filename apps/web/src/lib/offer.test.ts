import { describe, expect, it } from "vitest"
import {
  afterTrialText,
  billingStartText,
  chargeFaq,
  feeText,
  offerOf,
  splitGift,
  startNote,
  startText,
  trialFaq,
  trialText,
} from "./offer"
import type { PlanPrices, Pricing, Terms } from "./pricing"

/** Un plan de ejemplo: las cifras reales salen de la administración. */
const plan = (price: number, credit = price): PlanPrices => ({
  name: "Plan",
  currency: "USD",
  plan: price,
  credit,
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
const LIST: Pricing = { list: plan(59), terms }
const NO_FEE: Pricing = { list: plan(0), terms }
const NO_PLAN: Pricing = { list: null, terms }

describe("la oferta cuenta una sola historia", () => {
  it("con el plan de lista: la prueba con su regalo y, después, la cuota que vuelve como crédito", () => {
    expect(offerOf(LIST)).toEqual({ gift: "USD 100", trial: "30 días", fee: "USD 59", credit: "USD 59", noFee: false })
    expect(trialText(LIST)).toBe("30 días con USD 100 de regalo para tus agentes")
    expect(feeText(LIST)).toBe("USD 59 al mes, que vuelven enteros como crédito")
    expect(afterTrialText(LIST)).toBe("Después, USD 59 al mes que vuelven como crédito.")
    expect(startNote(LIST)).toBe(
      "Empieza hoy, sin tarjeta: 30 días con USD 100 de regalo para tus agentes. Después, USD 59 al mes que vuelven como crédito.",
    )
    expect(startText(LIST, "sin límite de usuarios")).toBe(
      "30 días con USD 100 de regalo para tus agentes, sin tarjeta y sin límite de usuarios. Después, USD 59 al mes que vuelven como crédito.",
    )
  })

  it("si el crédito no es toda la cuota, no promete que vuelve entera", () => {
    const pricing: Pricing = { list: plan(59, 30), terms }
    expect(feeText(pricing)).toBe("USD 59 al mes, con USD 30 de crédito para tus agentes")
    expect(afterTrialText(pricing)).toBe("Después, USD 59 al mes, con USD 30 de crédito para tus agentes.")
  })

  it("un plan sin cuota no habla de una cuota que no existe", () => {
    expect(offerOf(NO_FEE).noFee).toBe(true)
    expect(feeText(NO_FEE)).toBe("Sin cuota: pagas lo que hacen tus agentes")
    expect(afterTrialText(NO_FEE)).toBe("Después, pagas solo lo que hacen tus agentes.")
    expect(chargeFaq(NO_FEE, "pacientes").a).not.toMatch(/crédito|cuota/)
  })

  it("sin plan publicado no hay prueba ni cifras que prometer", () => {
    expect(trialText(NO_PLAN)).toBeNull()
    expect(startNote(NO_PLAN)).toBeNull()
    expect(startText(NO_PLAN, "sin límite de usuarios")).toBeNull()
    expect(chargeFaq(NO_PLAN, "clientes").a).not.toMatch(/USD|Para probarlo/)
  })

  it("al terminar la prueba se elige el plan; sin elegirlo, solo lectura sin perder datos y los agentes en pausa", () => {
    const [card, end] = trialFaq(LIST, "clínica")
    expect(card?.a).toContain("No te pedimos tarjeta, ni ahora ni después")
    expect(end?.a).toContain("Plan y pagos")
    expect(end?.a).toContain("7 y 2 días antes")
    expect(end?.a).toContain("tu clínica queda en solo lectura, sin perder ningún dato, y los agentes se pausan hasta que lo elijas")
    expect(billingStartText()).toContain("el día que lo eliges")
  })

  it("nada promete «activar el plan», una tarjeta para seguir ni el programa que terminó", () => {
    for (const pricing of [LIST, NO_FEE, NO_PLAN]) {
      const text = [...trialFaq(pricing, "clínica").map((item) => item.a), billingStartText(), chargeFaq(pricing, "pacientes").a].join(" ")
      expect(text).not.toMatch(/activas el plan|activar el plan|tarjeta solo se pide|Fundador|invitación|pagamos nosotros/)
    }
  })

  it("el regalo se parte del texto para pintarlo en ámbar", () => {
    expect(splitGift("30 días con USD 100 de regalo", "USD 100")).toEqual(["30 días con ", "USD 100", " de regalo"])
    expect(splitGift("Sin regalo", null)).toEqual(["Sin regalo", null, ""])
  })
})
