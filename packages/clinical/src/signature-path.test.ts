import { describe, expect, it } from "vitest"
import { signaturePath } from "./signature-path.js"

describe("el dibujo de una firma", () => {
  it("se recorta a lo que ocupa, sin deformarlo", () => {
    // Una diagonal de 500 × 500 unidades en un recuadro de 22 × 7 mide 11 × 3,5.
    const path = signaturePath([[[100, 200], [600, 700]]])
    expect(path).toMatchObject({ width: 11, height: 3.5 })
    expect(path?.d.startsWith("M0 0")).toBe(true)
  })

  it("une los puntos con curvas y cada trazo empieza aparte", () => {
    const path = signaturePath([
      [[0, 0], [100, 100], [200, 0]],
      [[300, 0], [400, 0]],
    ])
    expect(path?.d.match(/M/g)).toHaveLength(2)
    expect(path?.d).toContain("Q")
  })

  it("sin nada que dibujar no hay trazado", () => {
    expect(signaturePath(null)).toBeNull()
    expect(signaturePath([])).toBeNull()
    expect(signaturePath([[[10, 10]]])).toBeNull()
  })
})
