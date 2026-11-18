/**
 * «Añadir un tratamiento al plan» con «sacar muela» (verificación del 18 nov, H5): se busca
 * «exodoncia», y la búsqueda también trae lo que la nombra en medio («Alveoloplastia sin
 * exodoncias»), antes que las exodoncias. Dicho de otro modo, solo lo que se llama así.
 */
import { expect, it } from "vitest"
import { namedAsSaid } from "./service-picker"

const found = [
  { name: "Alveoloplastia con exodoncias, 1 a 3 dientes" },
  { name: "Alveoloplastia sin exodoncias, 1 a 3 dientes" },
  { name: "Exodoncia de pieza impactada en hueso" },
  { name: "Exodoncia simple" },
]

it("«sacar muela» trae solo las exodoncias, no la alveoloplastia", () => {
  expect(namedAsSaid(found, "exodoncia", "sacar muela").map((row) => row.name)).toEqual([
    "Exodoncia de pieza impactada en hueso",
    "Exodoncia simple",
  ])
})

it("escrito tal cual, todo lo que trae el servidor y en su orden", () => {
  expect(namedAsSaid(found, "exodoncia", "exodoncia ")).toEqual(found)
  expect(namedAsSaid(found, "", "")).toEqual(found)
})
