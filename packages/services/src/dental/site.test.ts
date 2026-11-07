import { expect, it } from "vitest"
import { dentalProductSite } from "./site.js"

it("para quien firma, la pieza lleva su nombre: el número FDI y el diente que es", () => {
  const row = (tooth: number) => dentalProductSite.columns({ toothNumber: tooth })
  expect(dentalProductSite.words(row(38), "patient")).toBe("pieza 38 (tercer molar inferior izquierdo, muela del juicio)")
  expect(dentalProductSite.words(row(11), "patient")).toBe("pieza 11 (incisivo central superior derecho)")
  // En los papeles de la clínica sigue siendo el número.
  expect(dentalProductSite.words(row(38), "short")).toBe("pieza 38")
})
