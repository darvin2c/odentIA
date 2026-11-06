import { expect, it } from "vitest"
import { everydayServiceVariants } from "../search-text"
import { dentalCatalog } from "./catalog"

it("odentIA: «limpieza» busca la profilaxis y «curación» la restauración", () => {
  expect(everydayServiceVariants("limpieza", dentalCatalog.everydayWords)).toContain("profilaxis")
  expect(everydayServiceVariants("Curación simple", dentalCatalog.everydayWords)).toContain("restauracion simple")
})
