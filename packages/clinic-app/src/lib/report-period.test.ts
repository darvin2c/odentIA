import { describe, expect, it } from "vitest"
import { isReportPeriod } from "./reports"

describe("un periodo del enlace", () => {
  it("acepta los de siempre, un mes y un rango de días que existen", () => {
    for (const period of ["este_mes", "mes_pasado", "2026-02", "2026-09-10..2026-09-25", "2024-02-29..2024-03-01"]) {
      expect(isReportPeriod(period)).toBe(true)
    }
  })
  it("no acepta un día que no existe, un rango al revés ni uno de más de dos años: se usa el de siempre", () => {
    for (const period of ["2026-02-30..2026-03-01", "2026-09-25..2026-09-10", "2020-01-01..2026-01-01", "1999-05", "2026-13", "ayer"]) {
      expect(isReportPeriod(period)).toBe(false)
    }
  })
})
