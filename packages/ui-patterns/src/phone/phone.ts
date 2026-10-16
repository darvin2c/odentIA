import {
  type CountryCode,
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
} from "libphonenumber-js"
import { formatCountry, formatLocale } from "../locale.js"
import { detectedTimeZone, zonesForCountry } from "../time-zone/time-zone.js"

/**
 * Núcleo de teléfono: el formato canónico es E.164 (`+51987654321`) y todo lo
 * demás —agrupamiento, país, validez— sale de los metadatos de
 * `libphonenumber-js`. No hay patrones de país escritos a mano: donde existe
 * estándar se usa el estándar (ver AGENTS.md).
 *
 * Por qué E.164 y no el texto con máscara: es lo que guardan `contact.phone` y
 * `patient.phone`, y de ahí dependen la deduplicación de pacientes
 * (`findPatientDuplicates`) y la identidad de canal (`wa:51911222333`). La
 * máscara es solo presentación.
 */

export type { CountryCode }
export { getCountryCallingCode }

/** Región (país) de una etiqueta BCP 47, completada con CLDR: `es-PE` → `PE`. */
function regionOfLocale(tag: string | undefined): CountryCode | undefined {
  if (!tag || typeof Intl.Locale !== "function") return undefined
  try {
    return normalizeCountry(new Intl.Locale(tag).maximize().region)
  } catch {
    return undefined
  }
}

let zoneCountries: Map<string, CountryCode> | null = null
/** País al que el runtime atribuye una zona (`America/Lima` → `PE`), si es uno solo. */
function countryOfTimeZone(zone: string | undefined): CountryCode | undefined {
  if (!zone) return undefined
  if (!zoneCountries) {
    zoneCountries = new Map()
    const shared = new Set<string>()
    for (const code of getCountries()) {
      for (const each of zonesForCountry(code)) {
        if (zoneCountries.has(each)) shared.add(each)
        else zoneCountries.set(each, code)
      }
    }
    // Una zona de varios países no dice cuál: no se adivina.
    for (const each of shared) zoneCountries.delete(each)
  }
  return zoneCountries.get(zone)
}

/**
 * País de partida del teléfono y de los selectores de país: el de la clínica
 * cuando la app lo fijó (`setFormatRegion({ country })`); si no, el de su
 * formato regional (`es-PE`); y sin clínica (alta de una organización, página
 * pública sin región), el del entorno: el de su zona horaria y, al final, el de
 * su idioma según CLDR. Nunca un país escrito en el código.
 */
export function regionCountry(): CountryCode {
  return (
    normalizeCountry(formatCountry()) ??
    regionOfLocale(formatLocale()) ??
    countryOfTimeZone(detectedTimeZone()) ??
    regionOfLocale(Intl.DateTimeFormat().resolvedOptions().locale) ??
    // «und» (idioma sin determinar) también tiene región probable en CLDR.
    regionOfLocale("und") ??
    (getCountries()[0] as CountryCode)
  )
}

export interface PhoneMeta {
  /**
   * E.164 listo para persistir. `null` mientras lo tecleado no sea un número
   * aceptable (ni posible ni válido): lo incompleto no viaja como teléfono.
   */
  e164: string | null
  /** País del número interpretado (el del propio número si trae prefijo). */
  country: CountryCode | undefined
  /** Dígitos tecleados, sin separadores ni prefijo internacional. */
  digits: string
  /** Texto tal como se ve en el campo (con máscara). */
  national: string
  isPossible: boolean
  isValid: boolean
}

/** `"pe"`/`"co"` → `"PE"`/`undefined`: solo códigos ISO-3166-1 que tengan plan. */
export function normalizeCountry(value: string | null | undefined): CountryCode | undefined {
  const code = value?.trim().toUpperCase()
  return code && isSupportedCountry(code) ? code : undefined
}

export function phoneDigits(display: string): string {
  return display.replace(/\D/g, "")
}

function parseNumber(display: string, country?: CountryCode) {
  const trimmed = display.trim()
  const digits = phoneDigits(trimmed)
  if (!digits) return undefined
  // El `+` lo pone la máscara (modo internacional) o el usuario al pegar.
  return trimmed.includes("+")
    ? parsePhoneNumberFromString(`+${digits}`)
    : parsePhoneNumberFromString(digits, country)
}

/** Estado interpretado de lo que hay en el campo, listo para emitir al formulario. */
export function phoneMeta(display: string, country?: CountryCode): PhoneMeta {
  const parsed = parseNumber(display, country)
  // `parse` es tolerante: devuelve un número aunque le falten dígitos
  // (`"987"` → `+51987`). Solo se emite cuando el estándar lo acepta, para que
  // lo incompleto viaje como «sin teléfono» y no como un número a medias que
  // otro proceso podría llegar a persistir.
  const isPossible = parsed?.isPossible() ?? false
  const isValid = parsed?.isValid() ?? false
  return {
    e164: parsed && (isPossible || isValid) ? parsed.number : null,
    country: parsed?.country ?? country,
    digits: phoneDigits(display),
    national: display,
    isPossible,
    isValid,
  }
}

/** E.164 de lo tecleado, o `null` si todavía no es un número aceptable. */
export function toE164(display: string, country?: CountryCode): string | null {
  return phoneMeta(display, country).e164
}

/** País de un E.164 ya persistido, si el número lo declara. */
export function countryOf(value: string): CountryCode | undefined {
  return parsePhoneNumberFromString(value)?.country
}

/**
 * Lectura nacional de un número guardado (`+51987654321` → `987 654 321`).
 * El texto que va al campo lo termina de pintar la máscara; aquí solo se usa el
 * formato nacional que dicta el estándar (y si el dato no es un número, se
 * devuelve tal cual para no perder un valor heredado).
 */
export function nationalText(value: string): string {
  return parsePhoneNumberFromString(value)?.formatNational() ?? value
}

/**
 * Lectura internacional de un número guardado (`+51987654100` →
 * `+51 987 654 100`), para mostrarlo fuera de un campo.
 */
export function internationalText(value: string): string {
  return parsePhoneNumberFromString(value)?.formatInternational() ?? value
}

/**
 * Lee un texto pegado con prefijo internacional (`+54 9 11 2345 6789`) y
 * devuelve el país que declara. Sin `+` no se interpreta: un número nacional
 * suelto pertenece al país del selector, y adivinarlo sería inventar.
 */
export function readInternational(
  text: string,
): { country: CountryCode; e164: string } | undefined {
  const value = text.trim()
  if (!value.startsWith("+")) return undefined
  const parsed = parsePhoneNumberFromString(value)
  return parsed?.country ? { country: parsed.country, e164: parsed.number } : undefined
}

/** Valida un E.164 ya persistido (para `refine` de Zod o guardas de pantalla). */
export function isValidE164(value: string | null | undefined): boolean {
  return value ? isValidPhoneNumber(value) : false
}

export interface CountryOption {
  value: CountryCode
  label: string
  callingCode: string
}

const regionNames = new Map<string, Intl.DisplayNames>()
const collators = new Map<string, Intl.Collator>()
const optionCache = new Map<string, CountryOption[]>()

function namesOf(locale: string | undefined): Intl.DisplayNames {
  const key = locale ?? ""
  const cached = regionNames.get(key)
  if (cached) return cached
  // Los nombres de país los aporta el runtime: no mantenemos diccionario propio.
  // Sin formato fijado, el del entorno.
  const names = new Intl.DisplayNames(locale ? [locale] : [], { type: "region" })
  regionNames.set(key, names)
  return names
}

export function countryLabel(code: CountryCode, locale = formatLocale()): string {
  return namesOf(locale).of(code) ?? code
}

/**
 * Opciones del selector de país: el país por defecto primero y el resto por
 * nombre en `locale`. `countries` acota la lista cuando la organización solo
 * atiende unos pocos países.
 */
export function countryOptions(
  defaultCountry: CountryCode,
  countries?: readonly CountryCode[],
  locale = formatLocale(),
): CountryOption[] {
  const codes = [...(countries?.length ? countries : getCountries())].sort()
  const localeKey = locale ?? ""
  const cacheKey = `${localeKey}|${defaultCountry}|${codes.join(",")}`
  const cached = optionCache.get(cacheKey)
  if (cached) return cached

  const collator = collators.get(localeKey) ?? new Intl.Collator(locale, { sensitivity: "base" })
  collators.set(localeKey, collator)
  const option = (code: CountryCode): CountryOption => ({
    value: code,
    label: countryLabel(code, locale),
    callingCode: getCountryCallingCode(code),
  })
  const rest = codes
    .filter((code) => code !== defaultCountry)
    .sort((a, b) => collator.compare(countryLabel(a, locale), countryLabel(b, locale)))
  const options = (codes.includes(defaultCountry) ? [defaultCountry, ...rest] : rest).map(option)
  optionCache.set(cacheKey, options)
  return options
}
