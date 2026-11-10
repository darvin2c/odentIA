import { describe, expect, it } from "vitest"
import {
  afterDaysWords,
  finishControlTitle,
  gapWords,
  parseFinishControls,
  parseSessionGapDays,
} from "./finish-controls.js"

describe("controles al terminar", () => {
  it("valida, ordena por plazo y rechaza dos el mismo día", () => {
    expect(
      parseFinishControls([
        { afterDays: 365, title: " Control  radiográfico " },
        { afterDays: 30, title: "Control clínico" },
      ]),
    ).toEqual([
      { afterDays: 30, title: "Control clínico" },
      { afterDays: 365, title: "Control radiográfico" },
    ])
    expect(() =>
      parseFinishControls([
        { afterDays: 30, title: "Uno" },
        { afterDays: 30, title: "Otro" },
      ]),
    ).toThrow(/mismo plazo/)
    expect(() => parseFinishControls([{ afterDays: 0, title: "Control" }])).toThrow(/plazo/)
    expect(() => parseFinishControls("x")).toThrow()
  })

  it("la espera entre sesiones: 0 a 120 o nula", () => {
    expect(parseSessionGapDays(null)).toBeNull()
    expect(parseSessionGapDays(7)).toBe(7)
    expect(() => parseSessionGapDays(121)).toThrow()
    expect(() => parseSessionGapDays(2.5)).toThrow()
  })

  it("nombra todas las piezas en un solo control", () => {
    expect(finishControlTitle("Control radiográfico de la endodoncia", ["46"])).toBe(
      "Control radiográfico de la endodoncia · pieza 46",
    )
    expect(finishControlTitle("Control radiográfico de la endodoncia", ["46", "36", "46"])).toBe(
      "Control radiográfico de la endodoncia · piezas 46 y 36",
    )
    expect(finishControlTitle("Control", [])).toBe("Control")
  })

  it("dice el plazo en palabras", () => {
    expect(afterDaysWords(365)).toBe("al año")
    expect(afterDaysWords(30)).toBe("al mes")
    expect(afterDaysWords(180)).toBe("a los 6 meses")
    expect(afterDaysWords(14)).toBe("a las 2 semanas")
    expect(gapWords(7)).toBe("una semana")
    expect(gapWords(10)).toBe("10 días")
  })
})
