// El país de partida de un formulario público, sin clínica que lo diga. Un navegador en «es» a secas
// no dice el país, y CLDR lo completa como España: por eso primero la región escrita en el idioma
// (`es-PE`), después la zona horaria (`America/Lima` → Perú) y, si ninguna lo dice, ninguno: se elige.
// Es el mismo orden que usa la app (`regionCountry` de @odentia/ui-patterns, issue 107), sin traer
// libphonenumber a la web: solo las zonas de los países que ofrece el formulario.

/**
 * Zona horaria → país, solo de los países de la lista y solo zonas de un único país. Un navegador en
 * «es» a secas no dice el país, y CLDR lo completa como España; la zona sí lo dice (`America/Lima` →
 * Perú). Es el mismo orden que usa la app (`regionCountry` de @odentia/ui-patterns, issue 107).
 */
export const ZONE_COUNTRY: Record<string, string> = {
  "America/Argentina/Buenos_Aires": "AR",
  "America/Buenos_Aires": "AR",
  "America/Argentina/Cordoba": "AR",
  "America/Argentina/Mendoza": "AR",
  "America/La_Paz": "BO",
  "America/Santiago": "CL",
  "America/Bogota": "CO",
  "America/Costa_Rica": "CR",
  "America/Guayaquil": "EC",
  "America/El_Salvador": "SV",
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Guatemala": "GT",
  "America/Tegucigalpa": "HN",
  "America/Mexico_City": "MX",
  "America/Monterrey": "MX",
  "America/Tijuana": "MX",
  "America/Cancun": "MX",
  "America/Merida": "MX",
  "America/Hermosillo": "MX",
  "America/Mazatlan": "MX",
  "America/Chihuahua": "MX",
  "America/Managua": "NI",
  "America/Panama": "PA",
  "America/Asuncion": "PY",
  "America/Lima": "PE",
  "America/Puerto_Rico": "PR",
  "America/Santo_Domingo": "DO",
  "America/Montevideo": "UY",
  "America/Caracas": "VE",
}

/** La región escrita en el idioma; si no, la de la zona horaria; solo si está en `codes`. */
export function countryOfDevice(
  language: string,
  timeZone: string | undefined,
  codes: readonly string[],
): string {
  const listed = (code: string | undefined) => (code && codes.includes(code) ? code : "")
  let fromLanguage = ""
  try {
    fromLanguage = listed(new Intl.Locale(language).region)
  } catch {
    // Una etiqueta inválida no dice nada: se sigue con la zona.
  }
  return fromLanguage || listed(timeZone ? ZONE_COUNTRY[timeZone] : undefined)
}
