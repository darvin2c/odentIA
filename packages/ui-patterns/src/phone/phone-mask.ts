import { type MaskitoOptions, maskitoTransform } from "@maskito/core"
import { maskitoPhone } from "@maskito/phone"
import { getExampleNumber } from "libphonenumber-js"
import examples from "libphonenumber-js/examples.mobile"
import metadata from "libphonenumber-js/min/metadata"
import { type CountryCode, phoneDigits } from "./phone.js"

/**
 * Máscara del teléfono. La genera `@maskito/phone` desde los **mismos**
 * metadatos de `libphonenumber-js` que validan el número, así que el
 * agrupamiento (`987 654 321`, `(01) 1234567`) no es un patrón que
 * mantengamos a mano y sigue al país elegido.
 *
 * El campo muestra **siempre el número nacional**: el prefijo internacional no
 * se teclea, lo lleva el selector de país (`PE +51`). Pegar un número con
 * prefijo de otro país cambia el selector y conserva los dígitos nacionales
 * (ver `PhoneInput`), que es lo que hace coherente que el prefijo viva ahí.
 *
 * Cada campo recibe sus propias opciones: la máscara guarda estado interno
 * (plantilla en curso) y compartir la instancia entre campos lo contaminaría.
 */
export function phoneMaskOptions(country: CountryCode): Required<MaskitoOptions> {
  return maskitoPhone({
    countryIsoCode: country,
    metadata,
    strict: true,
    separator: " ",
    format: "NATIONAL",
  })
}

/**
 * Dígitos nacionales tal como los pinta la máscara del país. Es la forma
 * canónica del texto del campo cuando el valor no viene del teclado: valor
 * guardado, cambio de país o pegado de un número de otro país.
 */
export function maskNationalDigits(digits: string, country: CountryCode): string {
  if (!digits) return ""
  return maskitoTransform(
    { value: digits, selection: [digits.length, digits.length] },
    phoneMaskOptions(country),
  ).value
}

const placeholders = new Map<CountryCode, string>()

/**
 * Ejemplo móvil del país con el agrupamiento de la máscara (`987 654 321`),
 * para que el campo enseñe la máscara antes de teclear nada. Sale de los
 * ejemplos oficiales de `libphonenumber-js`, no de un patrón propio: hay países
 * cuyo formato nacional lleva prefijos (Argentina: `011 15-2345-6789`) y un
 * relleno con nueves no los reproduciría.
 */
export function phonePlaceholder(country: CountryCode): string {
  const cached = placeholders.get(country)
  if (cached !== undefined) return cached

  const example = getExampleNumber(country, examples)
  const placeholder = example
    ? maskNationalDigits(phoneDigits(example.formatNational()), country)
    : ""
  placeholders.set(country, placeholder)
  return placeholder
}
