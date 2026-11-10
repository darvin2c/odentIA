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

// Repaso final de la ficha del 10 nov (B10): «evalua» decía «Ningún servicio activo coincide».
it("odentIA: «evaluación», con o sin tilde y a medio escribir, también busca la consulta", () => {
  for (const q of ["evaluación", "evaluacion", "evalua"])
    expect(everydayServiceVariants(q, dentalCatalog.everydayWords)).toContain("consulta")
})
