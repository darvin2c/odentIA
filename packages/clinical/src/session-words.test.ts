import { describe, expect, it } from "vitest"
import { doneSessionWords, sessionWords, showsSession } from "./session-words.js"

describe("la sesión de un tratamiento, dicha igual en todas partes", () => {
  it("«sesión 2 de 2» y, si se pasa, «sesión 3 (2 previstas)»", () => {
    expect(sessionWords(2, 2)).toBe("sesión 2 de 2")
    expect(sessionWords(3, 2)).toBe("sesión 3 (2 previstas)")
    expect(showsSession(1, 1)).toBe(false)
    expect(showsSession(2, 1)).toBe(true)
  })

  // Tercer repaso del 9 nov (E8 y E12): la Historia decía «Se hizo: Endodoncia» sin
  // decir que terminó, y la pieza, «Realizado» con la endodoncia aún en curso.
  it("una sesión hecha dice cuál es y, en la que lo terminó, que terminó", () => {
    expect(doneSessionWords(1, 2, false)).toBe("sesión 1 de 2")
    expect(doneSessionWords(2, 2, true)).toBe("sesión 2 de 2 · tratamiento terminado")
    // Terminado antes de sus previstas.
    expect(doneSessionWords(1, 2, true)).toBe("sesión 1 de 2 · tratamiento terminado")
    expect(doneSessionWords(3, 2, false)).toBe("sesión 3 (2 previstas)")
  })

  it("lo de una sola sesión no dice su sesión", () => {
    expect(doneSessionWords(1, 1, true)).toBeNull()
    expect(doneSessionWords(1, 1, false)).toBeNull()
  })
})
