/**
 * Dominio de zona horaria: selector con búsqueda y valor canónico IANA.
 *
 * Todo sale del runtime (`Intl`): la lista de zonas, el desfase, la etiqueta GMT
 * y las zonas de un país con `Intl.Locale.timeZones`. Los helpers puros viven en
 * `time-zone.ts` para que una pantalla, la agenda o un esquema de validación
 * puedan usarlos sin montar el componente.
 */

export {
  canonicalTimeZone,
  detectedTimeZone,
  localTimeIn,
  type TimeZoneInfo,
  type TimeZoneMeta,
  type TimeZoneOption,
  timeZoneInfo,
  timeZoneMeta,
  timeZoneOption,
  timeZoneOptions,
  zonesForCountry,
} from "./time-zone.js"
export { TimeZoneSelect, type TimeZoneSelectProps } from "./time-zone-select.js"
