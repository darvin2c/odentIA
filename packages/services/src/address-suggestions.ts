/**
 * Sugerencias de direcciones (issue 36, ADR 0077). Al escribir «Calle y
 * número», la sede busca en Google Places (encuentra también la clínica por
 * su nombre, y su ficha abre «Cómo llegar») y el paciente en Geoapify, sobre
 * OpenStreetMap, que cuesta mucho menos. Los proveedores son adaptadores: el
 * núcleo solo conoce la dirección internacional que devuelven.
 *
 * Todo pasa por el servidor: al proveedor le llega solo lo escrito, sin
 * nombre, sin clínica y sin que su código corra en la página. Lo que se
 * guarda es lo que la persona deja en el formulario; de Google, solo el
 * identificador del lugar. Sin clave, sin respuesta o pasado el tope del día,
 * no hay sugerencias y los campos son los de siempre.
 */
import { clinicalProfileFor, regionFromMap } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { addressLookupDay } from "@odentia/db/schema/org"
import { sql } from "drizzle-orm"
import { findOrgCountry, findOrgLocale } from "./locale.js"

/** Para qué se busca: la dirección de una sede o la de una persona. */
export type AddressPurpose = "sede" | "paciente"

/** Búsquedas por clínica y día (decisión 6 del lienzo): unas 30 direcciones de sede y 100 de pacientes. */
export const ADDRESS_DAILY_LIMIT: Record<AddressPurpose, number> = { sede: 200, paciente: 600 }

/** La dirección que entrega un mapa, antes de llevar la región a la lista del país. */
export interface MapAddress {
  line: string | null
  city: string | null
  district: string | null
  regionName: string | null
  /** Código de la región como lo da el mapa: «LIM» o «PE-LIM». */
  regionCode: string | null
  postalCode: string | null
  /** ISO 3166-1 alfa-2. */
  country: string | null
  /** La ficha del lugar en Google (Place ID); null en los demás. */
  placeId: string | null
}

export interface MapSuggestion {
  id: string
  main: string
  secondary: string | null
  /** Un negocio con nombre: la clínica encontrada por cómo aparece en el mapa. */
  isPlace: boolean
  /** La dirección ya armada, si el proveedor la entrega con la sugerencia. */
  address: MapAddress | null
}

/** Un proveedor de sugerencias: adaptador intercambiable. */
export interface AddressProvider {
  /** La mención que sus condiciones piden al pie de la lista. */
  attribution: string
  suggest(input: { text: string; country: string | null; language: string; session: string }): Promise<MapSuggestion[]>
  /** La dirección de una sugerencia que no la trae (Google): cierra la sesión de búsqueda. */
  resolve?(input: { id: string; language: string; session: string }): Promise<MapAddress | null>
}

/** La dirección lista para el formulario, en la forma común y con la región de la lista del país. */
export interface SuggestedAddress {
  line: string | null
  city: string | null
  district: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  placeId: string | null
}

export interface AddressSuggestion {
  id: string
  main: string
  secondary: string | null
  isPlace: boolean
  address: SuggestedAddress | null
}

export interface AddressSuggestions {
  /** false: sin proveedor, sin respuesta o pasado el tope: los campos de siempre. */
  available: boolean
  attribution: string | null
  suggestions: AddressSuggestion[]
}

function fit(country: string | null, found: MapAddress): SuggestedAddress {
  const profile = clinicalProfileFor(country)
  return {
    line: found.line,
    city: found.city,
    district: found.district,
    region: regionFromMap(profile, { name: found.regionName, code: found.regionCode, country: found.country }),
    postalCode: found.postalCode,
    country: found.country,
    placeId: found.placeId,
  }
}

/** Cuenta una búsqueda de la clínica; false si ya pasó el tope del día. */
async function spend(tx: Db, orgId: string, purpose: AddressPurpose): Promise<boolean> {
  const [row] = await tx
    .insert(addressLookupDay)
    .values({ organizationId: orgId, day: sql`current_date`, purpose, searches: 1 })
    .onConflictDoUpdate({
      target: [addressLookupDay.organizationId, addressLookupDay.day, addressLookupDay.purpose],
      set: { searches: sql`${addressLookupDay.searches} + 1` },
    })
    .returning({ searches: addressLookupDay.searches })
  return (row?.searches ?? 0) <= ADDRESS_DAILY_LIMIT[purpose]
}

async function languageOf(tx: Db, orgId: string): Promise<string> {
  return (await findOrgLocale(tx, orgId)).locale.split("-")[0] || "es"
}

function quiet(error: unknown): void {
  // Solo el tipo: el mensaje puede llevar lo escrito.
  console.error(`address-suggestions: ${error instanceof Error ? error.name : "error desconocido"}`)
}

/**
 * Sugerencias para lo escrito en «Calle y número». Desde la tercera letra;
 * cada llamada cuenta para el tope del día de la clínica.
 */
export async function suggestAddresses(
  tx: Db,
  orgId: string,
  provider: AddressProvider | null | undefined,
  purpose: AddressPurpose,
  input: { text: string; session: string },
): Promise<AddressSuggestions> {
  if (!provider) return { available: false, attribution: null, suggestions: [] }
  const text = input.text.trim().slice(0, 200)
  if (text.length < 3) return { available: true, attribution: provider.attribution, suggestions: [] }
  if (!(await spend(tx, orgId, purpose))) return { available: false, attribution: null, suggestions: [] }
  const country = await findOrgCountry(tx, orgId)
  try {
    const found = await provider.suggest({ text, country, language: await languageOf(tx, orgId), session: input.session })
    return {
      available: true,
      attribution: provider.attribution,
      suggestions: found.slice(0, 5).map((item) => ({
        id: item.id,
        main: item.main,
        secondary: item.secondary,
        isPlace: item.isPlace,
        address: item.address ? fit(country, item.address) : null,
      })),
    }
  } catch (error) {
    quiet(error)
    return { available: false, attribution: null, suggestions: [] }
  }
}

/** La dirección de la sugerencia elegida, cuando no vino con ella (Google). */
export async function resolveAddress(
  tx: Db,
  orgId: string,
  provider: AddressProvider | null | undefined,
  purpose: AddressPurpose,
  input: { id: string; session: string },
): Promise<SuggestedAddress | null> {
  if (!provider?.resolve) return null
  if (!(await spend(tx, orgId, purpose))) return null
  try {
    const found = await provider.resolve({ id: input.id, language: await languageOf(tx, orgId), session: input.session })
    return found ? fit(await findOrgCountry(tx, orgId), found) : null
  } catch (error) {
    quiet(error)
    return null
  }
}

/** Búsquedas de pacientes de hoy en todo odentIA: lo que mira la administración frente al plan de Geoapify. */
export async function addressSearchesToday(ownerTx: Db, purpose: AddressPurpose): Promise<number> {
  const rows = (await ownerTx.execute(
    sql`select coalesce(sum(searches), 0)::int as total from address_lookup_day where day = current_date and purpose = ${purpose}`,
  )) as unknown as Array<{ total: number }>
  return rows[0]?.total ?? 0
}

type Fetch = typeof fetch

const TIMEOUT_MS = 4000

async function getJson(fetchImpl: Fetch, url: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Google Places (New): Autocomplete con sesión y Place Details Essentials al
 * elegir (solo dirección, el campo más barato). Un negocio trae su nombre.
 */
export function googlePlacesProvider(apiKey: string, fetchImpl: Fetch = fetch): AddressProvider {
  return {
    attribution: "Google Maps",
    async suggest({ text: input, country, language, session }) {
      const body = await getJson(fetchImpl, "https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
        body: JSON.stringify({
          input,
          sessionToken: session,
          languageCode: language,
          ...(country ? { includedRegionCodes: [country.toLowerCase()] } : {}),
        }),
      })
      const suggestions = (body as { suggestions?: Array<{ placePrediction?: Record<string, unknown> }> }).suggestions ?? []
      return suggestions.flatMap((item) => {
        const prediction = item.placePrediction as
          | {
              placeId?: string
              structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } }
              text?: { text?: string }
              types?: string[]
            }
          | undefined
        const id = prediction?.placeId
        const main = text(prediction?.structuredFormat?.mainText?.text) ?? text(prediction?.text?.text)
        if (!id || !main) return []
        const types = prediction?.types ?? []
        return [
          {
            id,
            main,
            secondary: text(prediction?.structuredFormat?.secondaryText?.text),
            isPlace: types.includes("establishment") || types.includes("point_of_interest"),
            address: null,
          },
        ]
      })
    },
    async resolve({ id, language, session }) {
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?languageCode=${encodeURIComponent(language)}&sessionToken=${encodeURIComponent(session)}`
      const body = (await getJson(fetchImpl, url, {
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "id,formattedAddress,addressComponents" },
      })) as {
        id?: string
        formattedAddress?: string
        addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>
      }
      const parts = body.addressComponents ?? []
      const part = (type: string) => parts.find((item) => item.types?.includes(type))
      const route = text(part("route")?.shortText) ?? text(part("route")?.longText)
      const number = text(part("street_number")?.longText)
      // La primera parte de la dirección completa respeta el orden del país («Av. José Larco 345»).
      const first = text(body.formattedAddress?.split(",")[0])
      const line = first && route && first.includes(number ?? route) ? first : [route, number].filter(Boolean).join(" ") || null
      return {
        line,
        city:
          text(part("locality")?.longText) ??
          text(part("sublocality_level_1")?.longText) ??
          text(part("administrative_area_level_3")?.longText),
        district: text(part("administrative_area_level_2")?.longText),
        regionName: text(part("administrative_area_level_1")?.longText),
        regionCode: text(part("administrative_area_level_1")?.shortText),
        postalCode: text(part("postal_code")?.longText),
        country: text(part("country")?.shortText)?.toUpperCase() ?? null,
        placeId: text(body.id) ?? id,
      }
    },
  }
}

/**
 * Proveedor de demostración para desarrollo y e2e (`GOOGLE_MAPS_API_KEY=fake`,
 * `GEOAPIFY_API_KEY=fake`): sin red, devuelve lo escrito con un número y un
 * barrio fijo de Lima. Como Google, el de la sede ofrece también un negocio y
 * su dirección llega al elegirlo. No acredita a ningún proveedor real.
 */
export function fakeAddressProvider(kind: "google" | "geoapify"): AddressProvider {
  const address = (line: string): MapAddress => ({
    line,
    city: "Miraflores",
    district: "Lima",
    regionName: "Provincia de Lima",
    regionCode: null,
    postalCode: "15074",
    country: "PE",
    placeId: kind === "google" ? "fake-place" : null,
  })
  const street = (input: string) => `${input.replace(/\d+\s*$/, "").trim()} 345`
  return {
    attribution: kind === "google" ? "Google Maps (prueba)" : "Powered by Geoapify · © OpenStreetMap (prueba)",
    async suggest({ text: input }) {
      const line = street(input)
      const found: MapSuggestion[] = [
        { id: `fake:${line}`, main: line, secondary: "Miraflores, Lima, Perú", isPlace: false, address: kind === "geoapify" ? address(line) : null },
      ]
      if (kind === "google")
        found.unshift({ id: "fake-place", main: "Clínica de prueba Miraflores", secondary: `${line}, Miraflores, Perú`, isPlace: true, address: null })
      return found
    },
    ...(kind === "google"
      ? {
          async resolve({ id }: { id: string }) {
            return address(id === "fake-place" ? "Av. José Larco 345" : id.replace(/^fake:/, ""))
          },
        }
      : {}),
  }
}

/** Geoapify (OpenStreetMap): cada sugerencia ya trae la dirección; no hay un detalle aparte. */
export function geoapifyProvider(apiKey: string, fetchImpl: Fetch = fetch): AddressProvider {
  return {
    attribution: "Powered by Geoapify · © OpenStreetMap",
    async suggest({ text: input, country, language }) {
      const params = new URLSearchParams({ text: input, lang: language, limit: "5", format: "json", apiKey })
      if (country) params.set("filter", `countrycode:${country.toLowerCase()}`)
      const body = (await getJson(fetchImpl, `https://api.geoapify.com/v1/geocode/autocomplete?${params.toString()}`, {})) as {
        results?: Array<Record<string, unknown>>
      }
      return (body.results ?? []).flatMap((result, index) => {
        const main = text(result.address_line1)
        if (!main) return []
        const street = text(result.street)
        return [
          {
            id: text(result.place_id) ?? `geoapify-${index}`,
            main,
            secondary: text(result.address_line2),
            isPlace: result.result_type === "amenity",
            address: {
              line: street ? main : null,
              city: text(result.city) ?? text(result.district) ?? text(result.suburb),
              district: text(result.county),
              regionName: text(result.state),
              regionCode: text(result.state_code),
              postalCode: text(result.postcode),
              country: text(result.country_code)?.toUpperCase() ?? null,
              placeId: null,
            },
          },
        ]
      })
    },
  }
}
