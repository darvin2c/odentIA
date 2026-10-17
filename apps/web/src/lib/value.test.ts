import { describe, expect, it } from "vitest"
import { usd } from "./pricing"
import { computeValue, DEFAULT_VALUE_INPUT } from "./value"

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
