import { describe, expect, it } from "vitest"
import { bodySiteOf, dentalSiteOf, ISO_3950, NO_DENTAL_SITE, toothNumbersOfCodes } from "./index.js"

describe("sitio dental como sitio común (ISO 3950, ADR 0079)", () => {
  it("una pieza es su número FDI y las caras van como calificadores", () => {
    const site = bodySiteOf({ toothNumber: 16, surfaces: ["occlusal", "mesial"] })
    expect(site).toEqual({ system: ISO_3950, code: "16", qualifiers: ["occlusal", "mesial"] })
    expect(dentalSiteOf(site)).toEqual({ ...NO_DENTAL_SITE, toothNumber: 16, surfaces: ["occlusal", "mesial"] })
  })

  it("cuadrante y arcada son áreas: llevan un cero", () => {
    expect(bodySiteOf({ quadrant: 1 }).code).toBe("10")
    expect(bodySiteOf({ quadrant: 6 }).code).toBe("60")
    expect(bodySiteOf({ arch: "upper" }).code).toBe("01")
    expect(bodySiteOf({ arch: "lower" }).code).toBe("02")
    expect(dentalSiteOf({ system: ISO_3950, code: "30" }).quadrant).toBe(3)
    expect(dentalSiteOf({ system: ISO_3950, code: "02" }).arch).toBe("lower")
  })

  it("sin pieza ni área no hay sitio, y otro sistema no es un sitio dental", () => {
    expect(bodySiteOf({})).toEqual({ system: null, code: null, qualifiers: [] })
    expect(bodySiteOf(null)).toEqual({ system: null, code: null, qualifiers: [] })
    expect(dentalSiteOf({ system: null, code: null })).toEqual(NO_DENTAL_SITE)
    expect(dentalSiteOf({ system: "SNOMED-CT", code: "16" })).toEqual(NO_DENTAL_SITE)
    expect(dentalSiteOf({ system: ISO_3950, code: "00" })).toEqual(NO_DENTAL_SITE)
  })

  it("de una lista de códigos salen solo las piezas", () => {
    expect(toothNumbersOfCodes(["16", "10", "55", "02"])).toEqual([16, 55])
    expect(toothNumbersOfCodes(null)).toEqual([])
  })
})
