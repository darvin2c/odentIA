import { describe, expect, it } from "vitest"

import { layoutOverlaps } from "./layout.js"

interface Item {
  id: string
  start: number
  end: number
}

function item(id: string, start: number, end: number): Item {
  return { id, start, end }
}

const rangeOf = (entry: Item) => ({ startMinutes: entry.start, endMinutes: entry.end })

describe("layoutOverlaps", () => {
  it("sin solapes cada cita tiene su carril completo", () => {
    const placements = layoutOverlaps([item("a", 480, 540), item("b", 600, 660)], rangeOf)
    expect(placements.map((p) => [p.item.id, p.lane, p.lanes])).toEqual([
      ["a", 0, 1],
      ["b", 0, 1],
    ])
  })

  it("dos citas solapadas comparten el ancho", () => {
    const placements = layoutOverlaps([item("a", 480, 540), item("b", 510, 570)], rangeOf)
    expect(placements.find((p) => p.item.id === "a")).toMatchObject({ lane: 0, lanes: 2 })
    expect(placements.find((p) => p.item.id === "b")).toMatchObject({ lane: 1, lanes: 2 })
  })

  it("el subcarril se libera cuando termina la cita que lo ocupaba", () => {
    // a: 8:00-9:00, b: 8:30-9:30, c: 9:00-10:00. c no toca a a: reutiliza su carril.
    const placements = layoutOverlaps(
      [item("a", 480, 540), item("b", 510, 570), item("c", 540, 600)],
      rangeOf,
    )
    expect(placements.find((p) => p.item.id === "c")).toMatchObject({ lane: 0, lanes: 2 })
  })

  it("tocar no es solapar: una cita que empieza cuando otra termina va entera", () => {
    const placements = layoutOverlaps([item("a", 480, 540), item("b", 540, 600)], rangeOf)
    expect(placements.every((p) => p.lanes === 1)).toBe(true)
  })

  it("tres citas a la vez necesitan tres subcarriles", () => {
    const placements = layoutOverlaps(
      [item("a", 480, 600), item("b", 500, 620), item("c", 520, 640)],
      rangeOf,
    )
    expect(placements.every((p) => p.lanes === 3)).toBe(true)
    expect(placements.map((p) => p.lane)).toEqual([0, 1, 2])
  })
})
