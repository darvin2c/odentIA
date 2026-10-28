import { describe, expect, it } from "vitest"
import { fitHistory, HISTORY_CHARS, HISTORY_HEAD } from "./attention"

const said = (count: number, size = 20) => Array.from({ length: count }, (_, i) => ({ id: i, body: `${i}`.padEnd(size, ".") }))

describe("lo que Sofi lee de la atención (ADR 0104)", () => {
  it("una atención normal entra entera, por larga que sea en pedazos", () => {
    const items = said(150)
    expect(fitHistory(items)).toEqual({ items, omitted: 0 })
  })

  it("si no cabe, conserva cómo empezó y lo último, y cuenta lo que deja fuera", () => {
    const items = said(100, 500)
    const fitted = fitHistory(items)
    expect(fitted.omitted).toBeGreaterThan(0)
    expect(fitted.items.length + fitted.omitted).toBe(100)
    expect(fitted.items.slice(0, HISTORY_HEAD).map((item) => item.id)).toEqual([0, 1, 2, 3])
    expect(fitted.items.at(-1)?.id).toBe(99)
    // Sin huecos en lo último: es lo que se está conversando.
    const tail = fitted.items.slice(HISTORY_HEAD).map((item) => item.id)
    expect(tail).toEqual(Array.from({ length: tail.length }, (_, i) => 100 - tail.length + i))
    const size = fitted.items.reduce((sum, item) => sum + item.body.length + 40, 0)
    expect(size).toBeLessThanOrEqual(HISTORY_CHARS)
  })

  it("el último mensaje va siempre, aunque solo él pase del tope", () => {
    const items = [...said(6), { id: 99, body: "x".repeat(HISTORY_CHARS * 2) }]
    const fitted = fitHistory(items)
    expect(fitted.items.at(-1)?.id).toBe(99)
    expect(fitted.items.slice(0, HISTORY_HEAD).map((item) => item.id)).toEqual([0, 1, 2, 3])
    expect(fitted.omitted).toBe(2)
  })
})
