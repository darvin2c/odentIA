import { describe, expect, it } from "vitest"
import { linkFromText } from "./marca"

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
