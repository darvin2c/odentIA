import { describe, expect, it } from "vitest"
import { geoapifyProvider, googlePlacesProvider } from "./address-suggestions.js"

/** Un `fetch` de mentira que guarda lo que se le pidió y responde lo dado. */
function fakeFetch(answers: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const body = answers.shift()
    return new Response(JSON.stringify(body), { status: body === undefined ? 500 : 200 })
  }) as typeof fetch
  return { impl, calls }
}

describe("adaptadores de sugerencias de direcciones (issue 36)", () => {
  it("Google: sugiere con sesión y país, y al elegir pide solo la dirección", async () => {
    const { impl, calls } = fakeFetch([
      {
        suggestions: [
          {
            placePrediction: {
              placeId: "ChIJ-smile",
              structuredFormat: { mainText: { text: "Dental Smile Miraflores" }, secondaryText: { text: "Av. José Larco 345, Miraflores, Perú" } },
              types: ["clinician", "health", "point_of_interest", "establishment"],
            },
          },
          { placePrediction: { placeId: "ChIJ-larco", structuredFormat: { mainText: { text: "Av. José Larco 345" } }, types: ["street_address"] } },
          { queryPrediction: { text: { text: "dentistas" } } },
        ],
      },
      {
        id: "ChIJ-smile",
        formattedAddress: "Av. José Larco 345, Miraflores 15074, Perú",
        addressComponents: [
          { longText: "345", shortText: "345", types: ["street_number"] },
          { longText: "Avenida José Larco", shortText: "Av. José Larco", types: ["route"] },
          { longText: "Miraflores", shortText: "Miraflores", types: ["locality", "political"] },
          { longText: "Provincia de Lima", shortText: "Provincia de Lima", types: ["administrative_area_level_2", "political"] },
          { longText: "Provincia de Lima", shortText: "LMA", types: ["administrative_area_level_1", "political"] },
          { longText: "Perú", shortText: "PE", types: ["country", "political"] },
          { longText: "15074", shortText: "15074", types: ["postal_code"] },
        ],
      },
    ])
    const google = googlePlacesProvider("clave", impl)
    const found = await google.suggest({ text: "dental smile", country: "PE", language: "es", session: "s-1" })
    expect(found).toEqual([
      { id: "ChIJ-smile", main: "Dental Smile Miraflores", secondary: "Av. José Larco 345, Miraflores, Perú", isPlace: true, address: null },
      { id: "ChIJ-larco", main: "Av. José Larco 345", secondary: null, isPlace: false, address: null },
    ])
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ input: "dental smile", sessionToken: "s-1", languageCode: "es", includedRegionCodes: ["pe"] })
    expect(new Headers(calls[0]?.init?.headers).get("X-Goog-Api-Key")).toBe("clave")

    const address = await google.resolve?.({ id: "ChIJ-smile", language: "es", session: "s-1" })
    expect(address).toEqual({
      line: "Av. José Larco 345",
      city: "Miraflores",
      district: "Provincia de Lima",
      regionName: "Provincia de Lima",
      regionCode: "LMA",
      postalCode: "15074",
      country: "PE",
      placeId: "ChIJ-smile",
    })
    // El detalle más barato: solo dirección (Place Details Essentials), en la misma sesión.
    expect(calls[1]?.url).toContain("sessionToken=s-1")
    expect(new Headers(calls[1]?.init?.headers).get("X-Goog-FieldMask")).toBe("id,formattedAddress,addressComponents")
  })

  it("Geoapify: cada sugerencia ya trae su dirección; sin respuesta, lanza para que el servicio calle", async () => {
    const { impl, calls } = fakeFetch([
      {
        results: [
          {
            place_id: "geo-1",
            address_line1: "Jirón Las Begonias 120",
            address_line2: "San Isidro, Lima, Perú",
            street: "Jirón Las Begonias",
            housenumber: "120",
            city: "San Isidro",
            county: "Lima",
            state: "Lima Metropolitana",
            state_code: "LMA",
            postcode: "15073",
            country_code: "pe",
            result_type: "building",
          },
          { place_id: "geo-2", address_line1: "San Isidro", address_line2: "Lima, Perú", city: "San Isidro", country_code: "pe", result_type: "city" },
        ],
      },
    ])
    const geoapify = geoapifyProvider("clave", impl)
    const found = await geoapify.suggest({ text: "Jr. Las Begonias 1", country: "PE", language: "es", session: "s-2" })
    expect(found[0]).toEqual({
      id: "geo-1",
      main: "Jirón Las Begonias 120",
      secondary: "San Isidro, Lima, Perú",
      isPlace: false,
      address: {
        line: "Jirón Las Begonias 120",
        city: "San Isidro",
        district: "Lima",
        regionName: "Lima Metropolitana",
        regionCode: "LMA",
        postalCode: "15073",
        country: "PE",
        placeId: null,
      },
    })
    // Una ciudad sin calle no llena «Calle y número».
    expect(found[1]?.address?.line).toBeNull()
    const url = new URL(calls[0]?.url ?? "")
    expect(url.searchParams.get("filter")).toBe("countrycode:pe")
    expect(url.searchParams.get("lang")).toBe("es")
    await expect(geoapify.suggest({ text: "algo", country: "PE", language: "es", session: "s-3" })).rejects.toThrow()
  })
})
