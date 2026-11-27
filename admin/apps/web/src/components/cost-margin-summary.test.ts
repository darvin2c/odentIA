import { describe, expect, it } from "vitest"
import type { ClinicCostMargin } from "./cost-margin"
import { summaryOf } from "./cost-margin-summary"

describe("«Costo y margen» con un producto elegido", () => {
  const clinic = (organizationId: string, chargedCents: number, costMicros: number): ClinicCostMargin => ({
    organizationId,
    organizationName: organizationId,
    period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z", credit: "mes" },
    currency: "USD",
    planName: null,
    founder: organizationId === "fundadora",
    chargedCents,
    aiMicros: costMicros,
    storageMicros: 0,
    fixedMicros: 0,
    costMicros,
    marginPct: null,
    commissionCents: 0,
    marginAfterCommissionPct: null,
    aiShareBps: null,
    alarm: false,
    idle: false,
    sellerName: null,
    unpricedCalls: 0,
    lines: [],
  })

  it("suma solo sus clínicas: la Ayuda de las apps no es de ningún producto de clínicas", () => {
    const summary = summaryOf([clinic("a", 2900, 5_000_000), clinic("fundadora", 0, 1_000_000)])
    expect(summary.apps).toEqual([])
    expect(summary).toMatchObject({
      founders: 1,
      chargedCents: 2900,
      costMicros: 6_000_000,
      aiMicros: 6_000_000,
      marginPct: 79,
    })
  })
})
