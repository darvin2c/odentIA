import { describe, expect, it } from "vitest"
import { dentalCatalog } from "./dental/catalog"
import { medicalCatalog } from "./medical/catalog"
import { everydayServiceVariants } from "./search-text"

describe("buscar un servicio como lo dicen los pacientes", () => {
  it("«limpieza» también busca la profilaxis en odentIA, y lo demás de la búsqueda se conserva", () => {
    const words = dentalCatalog.everydayWords
    expect(everydayServiceVariants("limpieza", words)).toEqual(["profilaxis", "destartraje", "tartrectomia"])
    expect(everydayServiceVariants("Curación simple", words)).toContain("restauracion simple")
    expect(everydayServiceVariants("profilaxis", words)).toEqual([])
  })
  it("cada producto con sus palabras: latidIA no busca odontología", () => {
    expect(everydayServiceVariants("limpieza", medicalCatalog.everydayWords)).toEqual([])
    expect(everydayServiceVariants("chequeo", medicalCatalog.everydayWords)).toContain("consulta")
  })
  it("las palabras del lenguaje no rompen la búsqueda", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(everydayServiceVariants(word, dentalCatalog.everydayWords)).toEqual([])
    }
  })
})
