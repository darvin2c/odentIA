import { describe, expect, it } from "vitest"
import { moveInGrid, niceTicks, rangeTicks, scaleLevel, sparkPoints, waterfallBars } from "./chart-math.js"

describe("niceTicks", () => {
  it("cubre el máximo con pasos redondos", () => {
    expect(niceTicks(48_200)).toEqual([0, 20_000, 40_000, 60_000])
    expect(niceTicks(9)).toEqual([0, 5, 10])
    expect(niceTicks(100)).toEqual([0, 50, 100])
  })

  it("sin datos devuelve un eje mínimo en vez de dividir por cero", () => {
    expect(niceTicks(0)).toEqual([0, 1])
  })
})

describe("rangeTicks", () => {
  it("cubre los datos con pasos redondos sin empezar en cero", () => {
    expect(rangeTicks(76, 142)).toEqual([75, 100, 125, 150])
    expect(rangeTicks(62, 68)).toEqual([62, 64, 66, 68])
  })

  it("un solo valor queda con aire arriba y abajo", () => {
    expect(rangeTicks(62, 62)).toEqual([57.5, 60, 62.5, 65, 67.5])
    expect(rangeTicks(0, 0)).toEqual([0, 1])
  })
})

describe("scaleLevel", () => {
  it("el cero es el vacío y lo demás cae en uno de cuatro pasos", () => {
    expect(scaleLevel(0, 10)).toBe(0)
    expect(scaleLevel(0.1, 10)).toBe(1)
    expect(scaleLevel(5, 10)).toBe(2)
    expect(scaleLevel(7.6, 10)).toBe(4)
    expect(scaleLevel(10, 10)).toBe(4)
  })
})

describe("moveInGrid", () => {
  it("las flechas se quedan dentro de la cuadrícula", () => {
    expect(moveInGrid({ row: 0, column: 0 }, "ArrowLeft", 7, 12)).toEqual({ row: 0, column: 0 })
    expect(moveInGrid({ row: 6, column: 3 }, "ArrowDown", 7, 12)).toEqual({ row: 6, column: 3 })
    expect(moveInGrid({ row: 2, column: 3 }, "End", 7, 12)).toEqual({ row: 2, column: 11 })
    expect(moveInGrid({ row: 2, column: 3 }, "Enter", 7, 12)).toBeNull()
  })
})

describe("sparkPoints", () => {
  it("una serie plana va al medio y los huecos quedan vacíos", () => {
    const points = sparkPoints([5, null, 5], 100, 30)
    expect(points[0]?.y).toBe(15)
    expect(points[1]).toBeNull()
  })

  it("el mayor queda arriba y el menor abajo", () => {
    const [low, high] = sparkPoints([1, 9], 100, 30)
    expect((low?.y ?? 0) > (high?.y ?? 0)).toBe(true)
  })
})

describe("waterfallBars", () => {
  it("baja desde el total paso a paso y el resultado sale de cero", () => {
    const { bars, low, high } = waterfallBars([
      { kind: "total", value: 100 },
      { kind: "less", value: 36 },
      { kind: "less", value: 39 },
      { kind: "result", value: 25 },
    ])
    expect(bars).toEqual([
      { from: 0, to: 100 },
      { from: 100, to: 64 },
      { from: 64, to: 25 },
      { from: 0, to: 25 },
    ])
    expect({ low, high }).toEqual({ low: 0, high: 100 })
  })

  it("si se gastó más de lo cobrado, la cascada baja de cero", () => {
    const { bars, low } = waterfallBars([
      { kind: "total", value: 50 },
      { kind: "less", value: 80 },
      { kind: "result", value: -30 },
    ])
    expect(bars[1]).toEqual({ from: 50, to: -30 })
    expect(low).toBe(-30)
  })
})
