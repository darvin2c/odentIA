import { findingDefinition } from "@odentia/dental"
import { describe, expect, it } from "vitest"
import { variantChipLabel } from "./odontogram-notation"

const PERU = { standard: "NTS 188", shortName: "NTS 188", authority: "MINSA", strictVariants: false, signedOdontogram: true }

// Lienzo del 24 nov: «CDP» solo no lo entiende todo el que empieza.
describe("la pastilla de cada variante", () => {
  const caries = findingDefinition("caries")!.variants!
  it("con la norma, el nombre corto y la sigla", () => {
    expect(caries.map((variant) => variantChipLabel(PERU, variant))).toEqual([
      "Mancha blanca · MB",
      "Esmalte · CE",
      "Dentina · CD",
      "Pulpa · CDP",
    ])
  })

  it("sin la norma, su nombre, como antes; y la fractura, que no tiene sigla, por su tipo", () => {
    expect(variantChipLabel(null, caries[2]!)).toBe("Lesión de caries a nivel de la dentina")
    const fracture = findingDefinition("fracture")!.variants!
    expect(fracture.map((variant) => variantChipLabel(PERU, variant))).toContain("Esmalte y dentina")
  })
})
