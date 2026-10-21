import { describe, expect, it } from "vitest"
import { clinicalProfileFor } from "./country-profiles.js"
import {
  directionsUrl,
  normalizePostalAddress,
  placeDirectionsUrl,
  postalAddressErrors,
  postalAddressText,
  regionFromMap,
} from "./postal-address.js"

const peru = clinicalProfileFor("PE")
const colombia = clinicalProfileFor("CO")

describe("dirección internacional de sedes y personas (issue 36)", () => {
  it("se escribe en una línea con la región por su nombre y el país solo si es otro", () => {
    expect(
      postalAddressText(peru, { line: "Av. José Larco 345", city: "Miraflores", district: "Lima", region: "PE-LMA", country: "PE" }),
    ).toBe("Av. José Larco 345 · Miraflores, Lima Metropolitana")
    // Sin lista de regiones se dice lo escrito; el código postal y el país, si no es el de la clínica.
    expect(
      postalAddressText(colombia, { line: "Calle 93 # 11-26", city: "Bogotá", region: "Bogotá D. C.", postalCode: "110221", country: "CO" }),
    ).toBe("Calle 93 # 11-26 · Bogotá, Bogotá D. C. · 110221")
    expect(postalAddressText(peru, { line: "Av. Corrientes 1234", city: "Buenos Aires", country: "AR" }, { language: "es" })).toBe(
      "Av. Corrientes 1234 · Buenos Aires · Argentina",
    )
    expect(postalAddressText(peru, {})).toBeNull()
  })

  it("la región se elige de la lista del país; lo ya guardado que no cambia no se vuelve a juzgar", () => {
    expect(postalAddressErrors(peru, { region: "PE-LMA" })).toEqual({})
    expect(postalAddressErrors(peru, { region: "Lima" })).toEqual({ region: "Elige el departamento de la lista" })
    expect(postalAddressErrors(peru, { region: "Lima" }, { region: "Lima" })).toEqual({})
    // Un país sin lista acepta lo escrito.
    expect(postalAddressErrors(colombia, { region: "Antioquia" })).toEqual({})
    expect(postalAddressErrors(colombia, { postalCode: "#" })).toEqual({ postalCode: "El código postal tiene de 2 a 12 letras o números" })
    expect(postalAddressErrors(colombia, { country: "Colombia" })).toEqual({ country: "Elige el país de la lista" })
  })

  it("la región que dice un mapa se pasa a la de la lista del país, por código o por nombre", () => {
    expect(regionFromMap(peru, { name: "Provincia de Lima" })).toBe("PE-LMA")
    expect(regionFromMap(peru, { name: "Lima" })).toBe("PE-LIM")
    expect(regionFromMap(peru, { name: "Provincia Constitucional del Callao" })).toBe("PE-CAL")
    expect(regionFromMap(peru, { name: "Departamento de Cusco" })).toBe("PE-CUS")
    expect(regionFromMap(peru, { name: "Lo que sea", code: "ARE" })).toBe("PE-ARE")
    expect(regionFromMap(peru, { name: "Lo que sea", code: "PE-PIU" })).toBe("PE-PIU")
    expect(regionFromMap(peru, { name: "Atlantis" })).toBeNull()
    // Un lugar de otro país no toma una región de la lista de la clínica.
    expect(regionFromMap(peru, { name: "Antioquia", country: "CO" })).toBeNull()
    // Sin lista, el nombre tal cual.
    expect(regionFromMap(colombia, { name: "Antioquia", code: "ANT" })).toBe("Antioquia")
  })

  it("lista para guardar: sin espacios sobrantes y con el país de la clínica si hay dirección", () => {
    expect(normalizePostalAddress(peru, { line: "  Av. Larco 1 ", city: "", country: null })).toEqual({
      line: "Av. Larco 1",
      city: null,
      district: null,
      region: null,
      postalCode: null,
      country: "PE",
    })
    expect(normalizePostalAddress(peru, {}).country).toBeNull()
    expect(normalizePostalAddress(peru, { line: "x", country: "co" }).country).toBe("CO")
  })

  it("«Cómo llegar» abre Google Maps con la dirección escrita y, si se conoce, la ficha del lugar", () => {
    expect(directionsUrl({ text: "Dental Smile, Av. José Larco 345, Miraflores" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Dental+Smile%2C+Av.+Jos%C3%A9+Larco+345%2C+Miraflores",
    )
    expect(directionsUrl({ text: "Dental Smile", placeId: "ChIJ123" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Dental+Smile&query_place_id=ChIJ123",
    )
    // La sede: el nombre de la clínica, su dirección y el país siempre; sin calle ni ciudad, nada.
    expect(
      placeDirectionsUrl(peru, { name: "Dental Smile", address: { line: "Av. José Larco 345", city: "Miraflores", region: "PE-LMA" } }),
    ).toBe(
      "https://www.google.com/maps/search/?api=1&query=Dental+Smile%2C+Av.+Jos%C3%A9+Larco+345%2C+Miraflores%2C+Lima+Metropolitana%2C+Per%C3%BA",
    )
    expect(placeDirectionsUrl(peru, { name: "Dental Smile", address: { region: "PE-LMA" } })).toBeNull()
  })
})
