import { describe, expect, it } from "vitest"
import { everydayServiceVariants } from "./search-text"

const WORDS = { limpieza: ["profilaxis", "destartraje"], chequeo: ["consulta"] }

describe("buscar un servicio como lo dicen los pacientes", () => {
  it("cada palabra de todos los días por las del catálogo, y lo demás de la búsqueda se conserva", () => {
    expect(everydayServiceVariants("limpieza", WORDS)).toEqual(["profilaxis", "destartraje"])
    expect(everydayServiceVariants("Chequeo general", WORDS)).toEqual(["consulta general"])
    expect(everydayServiceVariants("profilaxis", WORDS)).toEqual([])
  })
  it("también a medio escribir, desde cuatro letras, como el resto de la búsqueda (QA del 8 nov)", () => {
    expect(everydayServiceVariants("limpi", WORDS)).toEqual(["profilaxis", "destartraje"])
    expect(everydayServiceVariants("cheq general", WORDS)).toEqual(["consulta general"])
    expect(everydayServiceVariants("lim", WORDS)).toEqual([])
  })
  it("las palabras del lenguaje no rompen la búsqueda", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(everydayServiceVariants(word, WORDS)).toEqual([])
    }
  })
})
