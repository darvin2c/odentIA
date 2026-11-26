import { describe, expect, it } from "vitest"
import { countryOfDevice } from "./device-country"

const CODES = ["AR", "ES", "MX", "PE", "US"]

describe("countryOfDevice", () => {
  it("«es» a secas en Lima es Perú, no España", () => {
    expect(countryOfDevice("es", "America/Lima", CODES)).toBe("PE")
  })
  it("la región escrita en el idioma manda", () => {
    expect(countryOfDevice("es-MX", "America/Lima", CODES)).toBe("MX")
  })
  it("«es-419» no es un país: se usa la zona", () => {
    expect(countryOfDevice("es-419", "America/Argentina/Buenos_Aires", CODES)).toBe("AR")
  })
  it("en Madrid sí es España", () => {
    expect(countryOfDevice("es", "Europe/Madrid", CODES)).toBe("ES")
  })
  it("sin pistas, ninguno: se elige", () => {
    expect(countryOfDevice("es", "Asia/Tokyo", CODES)).toBe("")
    expect(countryOfDevice("es", undefined, CODES)).toBe("")
  })
  it("un país que no está en la lista no se propone", () => {
    expect(countryOfDevice("es-CO", "America/Bogota", CODES)).toBe("")
  })
})
