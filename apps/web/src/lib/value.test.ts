import { describe, expect, it } from "vitest"
import { type PlanPrices, usd, type ValuePrices, valuePricesOf } from "./pricing"
import { CLINIC_SIZES, computeValue, DEFAULT_VALUE_INPUT, sizeOf } from "./value"

/** Un plan de ejemplo con los precios por tipo (ADR 0085), por un factor: los reales salen de la administración. */
function planOf(factor: number, plan: number): ValuePrices {
  const p = (value: number) => Math.round(value * factor * 1000) / 1000
  const prices: PlanPrices = {
    name: "Plan",
    currency: "USD",
    plan,
    credit: plan,
    conversation: p(0.5),
    consultation: p(0.5),
    recovered: p(2),
    tiers: { informa: p(0.1), gestiona: p(0.5), agenda: p(1), simple: p(0.1), estandar: p(0.2), completa: p(0.5) },
    argos: { included: 300, packQuestions: 100, pack: p(3) },
    storage: { includedGb: 20, perGb: p(0.2) },
    trialCredit: 100,
    trialDays: 30,
  }
  return valuePricesOf(prices)!
}
const LIST = planOf(1, 29)
/** Un Fundador de ejemplo: sin cuota y con 50 % menos en todo. */
const FOUNDER = planOf(0.5, 0)

describe("el precio promedio de cada acción", () => {
  it("sale de la mezcla de tipos de la clínica mediana del estudio", () => {
    // 50 informan, 50 gestionan y 25 de sus citas se dan; 40 simples, 35 estándar y 25 completas.
    expect(LIST.conversation).toBeCloseTo(0.425)
    expect(LIST.consultation).toBeCloseTo(0.235)
    expect(LIST.tiers).toMatchObject({ informa: 0.1, agenda: 1, completa: 0.5 })
  })
})

describe("lo que pagas y lo que recuperas", () => {
  it("el ejemplo de la web: se pierden USD 1.560 y se pagan USD 216, como la Clínica Sonrisa del estudio", () => {
    const v = computeValue(DEFAULT_VALUE_INPUT, LIST)
    expect(v.lost).toBe(24)
    expect(v.recovered).toBe(9)
    expect(v.withoutUs).toBe(1560)
    // Sofi 127,50 + Clío 70,50 + 9 citas recuperadas a USD 2.
    expect(v.withUs).toBeCloseTo(216)
    expect(v.coveredByPlan).toBe(29)
    expect(v.ratio.toFixed(1)).toBe("7.2")
    expect(v.worthIt).toBe(true)
  })

  it("con poco uso se paga solo el plan, que el crédito cubre", () => {
    const v = computeValue({ ...DEFAULT_VALUE_INPUT, writers: 10, noShows: 0, consultations: 0 }, LIST)
    expect(v.usage).toBeCloseTo(4.25)
    expect(v.coveredByPlan).toBeCloseTo(4.25)
    expect(v.withUs).toBe(29)
  })

  it("un Fundador sin cuota paga solo lo que hacen sus agentes", () => {
    const v = computeValue({ ...DEFAULT_VALUE_INPUT, writers: 100, noShows: 0, consultations: 80 }, FOUNDER)
    expect(v.usage).toBeCloseTo(30.65)
    expect(v.coveredByPlan).toBe(0)
    expect(v.withUs).toBeCloseTo(30.65)
  })

  it("los importes van con punto de miles y coma decimal", () => {
    expect(usd(1560)).toBe("USD 1.560")
    expect(usd(0.5)).toBe("USD 0,50")
    expect(usd(29)).toBe("USD 29")
  })
})

describe("tamaños de clínica", () => {
  it("cada tamaño se reconoce y, al tocar un número, ya no es ninguno", () => {
    for (const size of CLINIC_SIZES) expect(sizeOf(size.input)).toBe(size.id)
    expect(sizeOf(DEFAULT_VALUE_INPUT)).toBe("mediana")
    expect(sizeOf({ ...DEFAULT_VALUE_INPUT, writers: 301 })).toBeNull()
  })

  it("más grande, más se pierde y más se paga", () => {
    const [p, m, g] = CLINIC_SIZES.map((s) => computeValue(s.input, LIST))
    expect(p.withoutUs).toBeLessThan(m.withoutUs)
    expect(m.withoutUs).toBeLessThan(g.withoutUs)
    expect(p.withUs).toBeLessThan(g.withUs)
  })
})
