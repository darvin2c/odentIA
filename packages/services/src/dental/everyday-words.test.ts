import { expect, it } from "vitest"
import { everydayServiceVariants } from "../search-text"
import { dentalCatalog } from "./catalog"

it("odentIA: «limpieza» busca la profilaxis y «curación» la restauración", () => {
  expect(everydayServiceVariants("limpieza", dentalCatalog.everydayWords)).toContain("profilaxis")
  expect(everydayServiceVariants("Curación simple", dentalCatalog.everydayWords)).toContain("restauracion simple")
})

it("odentIA: «extrac» ya busca la exodoncia y «endo» no cambia nada (QA del 8 nov)", () => {
  expect(everydayServiceVariants("extrac", dentalCatalog.everydayWords)).toEqual(["exodoncia"])
  expect(everydayServiceVariants("Extracción", dentalCatalog.everydayWords)).toEqual(["exodoncia"])
  expect(everydayServiceVariants("extracciones", dentalCatalog.everydayWords)).toEqual(["exodoncia"])
  expect(everydayServiceVariants("endo", dentalCatalog.everydayWords)).toEqual([])
  // Con menos de cuatro letras no se ensancha: «con» es de consulta, no de conducto.
  expect(everydayServiceVariants("con", dentalCatalog.everydayWords)).toEqual([])
})
