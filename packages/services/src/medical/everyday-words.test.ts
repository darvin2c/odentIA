import { expect, it } from "vitest"
import { everydayServiceVariants } from "../search-text"
import { medicalCatalog } from "./catalog"

it("latidIA: «chequeo» busca la consulta, y no busca odontología", () => {
  expect(everydayServiceVariants("chequeo", medicalCatalog.everydayWords)).toContain("consulta")
  expect(everydayServiceVariants("limpieza", medicalCatalog.everydayWords)).toEqual([])
})

it("latidIA: «vacu» ya busca la inmunización (QA del 8 nov)", () => {
  expect(everydayServiceVariants("vacu", medicalCatalog.everydayWords)).toEqual(["inmunizacion"])
})
