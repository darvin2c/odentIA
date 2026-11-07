import { describe, expect, it } from "vitest"
import { physicalScale } from "./tomography-slice"

describe("forma del corte", () => {
  it("un vóxel cúbico no estira nada", () => {
    expect(physicalScale({ colMm: 0.3, rowMm: 0.3 })).toEqual({ kx: 1, ky: 1 })
  })

  it("con cortes más gruesos que el píxel, las filas se estiran a sus mm", () => {
    expect(physicalScale({ colMm: 0.25, rowMm: 0.5 })).toEqual({ kx: 1, ky: 2 })
    expect(physicalScale({ colMm: 0.5, rowMm: 0.25 })).toEqual({ kx: 2, ky: 1 })
  })

  it("sin espaciado conocido no inventa una forma", () => {
    expect(physicalScale({ colMm: 0, rowMm: 0 })).toEqual({ kx: 1, ky: 1 })
  })
})
