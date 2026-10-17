import { describe, expect, it } from "vitest"
import { usd } from "./pricing"
import { CLINIC_SIZES, computeValue, DEFAULT_VALUE_INPUT, sizeOf } from "./value"

describe("lo que pagas y lo que recuperas", () => {
  it("el ejemplo de la web: se pierden USD 1.560 y se pagan USD 306", () => {
    const v = computeValue(DEFAULT_VALUE_INPUT)
    expect(v.lost).toBe(24)
    expect(v.recovered).toBe(9)
    expect(v.withoutUs).toBe(1560)
    expect(v.withUs).toBe(306)
    expect(v.coveredByPlan).toBe(29)
    expect(v.ratio.toFixed(1)).toBe("5.1")
    expect(v.worthIt).toBe(true)
  })

  it("con poco uso se paga solo el plan, que el crédito cubre", () => {
    const v = computeValue({ ...DEFAULT_VALUE_INPUT, writers: 10, overdue: 0, consultations: 0 })
    expect(v.usage).toBe(5)
    expect(v.coveredByPlan).toBe(5)
    expect(v.withUs).toBe(29)
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
    const [p, m, g] = CLINIC_SIZES.map((s) => computeValue(s.input))
    expect(p.withoutUs).toBeLessThan(m.withoutUs)
    expect(m.withoutUs).toBeLessThan(g.withoutUs)
    expect(p.withUs).toBeLessThan(g.withUs)
  })
})
