/**
 * Dominio de teléfono: campo con máscara por país y valor canónico E.164.
 *
 * El formato y la validez salen de los metadatos de `libphonenumber-js`; la
 * máscara, de `@maskito/phone`, que se construye sobre esos mismos metadatos.
 * El prefijo internacional lo lleva el selector de país, no el teclado.
 *
 * Los helpers puros viven en `phone.ts` para que una pantalla o un esquema de
 * validación puedan usarlos sin montar el componente.
 */
export { CountrySelect, type CountrySelectProps } from "./country-select.js"
export {
  type CountryCode,
  type CountryOption,
  countryLabel,
  countryOf,
  countryOptions,
  getCountryCallingCode,
  internationalText,
  isValidE164,
  nationalText,
  normalizeCountry,
  type PhoneMeta,
  phoneDigits,
  phoneMeta,
  readInternational,
  regionCountry,
  toE164,
} from "./phone.js"
export { PhoneInput, type PhoneInputProps } from "./phone-input.js"
export { maskNationalDigits, phoneMaskOptions, phonePlaceholder } from "./phone-mask.js"
