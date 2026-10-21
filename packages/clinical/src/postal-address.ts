/**
 * Dirección internacional (HL7 FHIR Address) de una sede o de una persona
 * (issue 36, ADR 0036): la misma forma en todo odentIA. Lo que cambia con el
 * país (cómo se llama cada nivel, si hay lista de regiones, si se pide código
 * postal) lo dice el perfil del país; aquí no hay nada de un país concreto.
 */
import { type ClinicalCountryProfile, regionOption } from "./country-profiles.js"
import { ISO_COUNTRY_RE } from "./identity.js"

export interface PostalAddress {
  /** Calle y número (FHIR Address.line). */
  line?: string | null
  /** Ciudad o localidad (FHIR Address.city): el distrito en Perú. */
  city?: string | null
  /** Nivel entre región y ciudad (FHIR Address.district): la provincia en Perú. */
  district?: string | null
  /** Región: código ISO 3166-2 si el país tiene lista; si no, su nombre. */
  region?: string | null
  postalCode?: string | null
  /** País ISO 3166-1 alfa-2. */
  country?: string | null
}

export type PostalAddressField = keyof PostalAddress

const POSTAL_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/

const LIMITS: Record<Exclude<PostalAddressField, "country">, number> = {
  line: 300,
  city: 100,
  district: 100,
  region: 100,
  postalCode: 20,
}

function clean(value: string | null | undefined): string | null {
  const text = value?.trim()
  return text ? text : null
}

/** El nombre de la región: el de la lista del país o, sin lista, lo escrito. */
export function regionName(profile: ClinicalCountryProfile, region: string | null | undefined): string | null {
  if (!region) return null
  return regionOption(profile, region)?.label ?? region
}

/** Nombre del país en el idioma pedido; el código si el entorno no lo conoce. */
export function countryDisplayName(code: string, language = "es"): string {
  try {
    return new Intl.DisplayNames([language], { type: "region", fallback: "none" }).of(code) ?? code
  } catch {
    return code
  }
}

/**
 * La dirección en una línea: «Av. José Larco 345 · Miraflores, Lima» en Perú;
 * «Calle 93 # 11-26 · Bogotá, Bogotá D. C. · 110221» en Colombia. El país
 * solo se dice si no es el de la clínica; la referencia, si se pasa.
 */
export function postalAddressText(
  profile: ClinicalCountryProfile,
  address: PostalAddress,
  options: { reference?: string | null; language?: string } = {},
): string | null {
  const place = [clean(address.city), regionName(profile, clean(address.region))].filter(Boolean).join(", ")
  const country = clean(address.country)?.toUpperCase()
  const parts = [
    clean(address.line),
    place || null,
    clean(address.postalCode),
    country && country !== profile.country ? countryDisplayName(country, options.language) : null,
    clean(options.reference) ? `Ref.: ${clean(options.reference)}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

/**
 * Lista para guardar: textos recortados (vacío = null) y el país en
 * mayúsculas; si hay dirección y no se eligió país, el de la clínica.
 */
export function normalizePostalAddress(profile: ClinicalCountryProfile, address: PostalAddress): Required<PostalAddress> {
  const out: Required<PostalAddress> = {
    line: clean(address.line),
    city: clean(address.city),
    district: clean(address.district),
    region: clean(address.region),
    postalCode: clean(address.postalCode),
    country: clean(address.country)?.toUpperCase() ?? null,
  }
  const hasAddress = out.line || out.city || out.district || out.region || out.postalCode
  if (hasAddress && !out.country) out.country = profile.country
  return out
}

/**
 * Lo que hay que arreglar, campo por campo: la región de la lista del país,
 * el código postal y el país ISO. Lo ya guardado que no cambia (`previous`)
 * no se vuelve a juzgar por el país de la clínica. Los mensajes dicen qué
 * hacer, nunca «formato inválido».
 */
export function postalAddressErrors(
  profile: ClinicalCountryProfile,
  address: PostalAddress,
  previous?: PostalAddress,
): Partial<Record<PostalAddressField, string>> {
  const errors: Partial<Record<PostalAddressField, string>> = {}
  for (const [field, max] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS, number]>) {
    const value = clean(address[field])
    if (value && value.length > max) errors[field] = `Escribe como mucho ${max} caracteres`
  }
  const country = clean(address.country)
  if (country && !ISO_COUNTRY_RE.test(country.toUpperCase())) errors.country = "Elige el país de la lista"
  const postalCode = clean(address.postalCode)
  if (postalCode && !errors.postalCode && !POSTAL_CODE_RE.test(postalCode))
    errors.postalCode = "El código postal tiene de 2 a 12 letras o números"
  const region = clean(address.region)
  const unchanged = previous !== undefined && clean(previous.region) === region
  if (profile.address.regions && region && !unchanged && !regionOption(profile, region))
    errors.region = `Elige el ${profile.address.regionLabel.toLowerCase()} de la lista`
  return errors
}

/**
 * «Cómo llegar»: abre Google Maps en la dirección escrita y, si se conoce, en
 * la ficha del lugar (Maps URLs: sin clave ni costo). No viaja nada más que
 * la dirección, y solo cuando la persona toca el enlace.
 */
export function directionsUrl(target: { text: string; placeId?: string | null }): string {
  const params = new URLSearchParams({ api: "1", query: target.text })
  if (target.placeId) params.set("query_place_id", target.placeId)
  return `https://www.google.com/maps/search/?${params.toString()}`
}

/**
 * «Cómo llegar» a un lugar (una sede): su nombre y su dirección completa,
 * con el país siempre, para que el mapa la encuentre; y su ficha si se eligió
 * de Google. Sin calle ni ciudad no hay a dónde llevar: null.
 */
export function placeDirectionsUrl(
  profile: ClinicalCountryProfile,
  place: { name?: string | null; address: PostalAddress; placeId?: string | null },
): string | null {
  const { address } = place
  if (!clean(address.line) && !clean(address.city)) return null
  const country = clean(address.country)?.toUpperCase() ?? profile.country
  const text = [
    clean(place.name),
    clean(address.line),
    clean(address.city),
    regionName(profile, clean(address.region)),
    country ? countryDisplayName(country) : null,
  ]
    .filter(Boolean)
    .join(", ")
  return directionsUrl({ text, placeId: place.placeId })
}
