import { describe, expect, it } from "vitest"
import { colorChoices, GESTORIA_COLOR, initialsOf, linkFromText, pickProblem } from "./marca"

describe("el nombre del link, como se guarda", () => {
  it("sin tildes, eñes, mayúsculas ni espacios", () => {
    expect(linkFromText("Calzados Rosa")).toBe("calzados-rosa")
    expect(linkFromText("Niñas & Moda Perú")).toBe("ninas-moda-peru")
    expect(linkFromText("  --Hoja   Viva!! ")).toBe("hoja-viva")
  })

  it("mientras se escribe deja el guion del final; nunca pasa de 63", () => {
    expect(linkFromText("calzados ", true)).toBe("calzados-")
    expect(linkFromText("a".repeat(80))).toHaveLength(63)
  })
})

describe("lo que se elige en Tu marca", () => {
  it("el logo acepta SVG; la portada, solo fotos; nada de más de 20 MB", () => {
    expect(pickProblem({ type: "image/svg+xml", size: 2000 }, "logo")).toBeNull()
    expect(pickProblem({ type: "image/svg+xml", size: 2000 }, "portada")).toMatch(/no es una foto/)
    expect(pickProblem({ type: "application/pdf", size: 2000 }, "logo")).toMatch(/no es una imagen/)
    expect(pickProblem({ type: "image/png", size: 21 * 1024 * 1024 }, "logo")).toMatch(/20 MB/)
  })

  it("los colores son los del logo, con el elegido primero; sin logo, el de gestorIA", () => {
    expect(colorChoices(["#fbcfe8", "#be185d"], "#be185d")).toEqual(["#be185d", "#fbcfe8"])
    expect(colorChoices(["#be185d"], "#123456")).toEqual(["#123456", "#be185d"])
    expect(colorChoices([], GESTORIA_COLOR)).toEqual([GESTORIA_COLOR])
  })

  it("sin logo, las iniciales del nombre", () => {
    expect(initialsOf("Calzados Rosa")).toBe("CR")
    expect(initialsOf("  ")).toBe("?")
  })
})
