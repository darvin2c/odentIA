/**
 * Formato regional con el que el paquete escribe fechas, horas, números y
 * nombres (BCP 47), zona horaria con la que resuelve «hoy» (IANA) y país de la
 * clínica (ISO 3166-1), del que parten el teléfono y los selectores de país.
 *
 * El paquete no conoce a la clínica ni importa nada de las apps: la app que lo
 * usa fija estos valores cuando carga el perfil de la organización
 * (`setFormatRegion`). Mientras nadie los fije valen `undefined`, que para
 * `Intl` es el formato y la zona del entorno (navegador): nunca se asume el de
 * un país. Los formateadores se crean al formatear, no a nivel de módulo, para
 * no quedar fijados antes de conocer la clínica.
 */
let locale: string | undefined
let timeZone: string | undefined
let country: string | undefined

export interface FormatRegion {
  /** BCP 47 (`es-CL`); vacío = el del entorno. */
  locale?: string | null
  /** IANA (`America/Santiago`); vacío = la del entorno. */
  timeZone?: string | null
  /** ISO 3166-1 alfa-2 (`CL`); vacío = el que diga el formato o el entorno. */
  country?: string | null
}

export function setFormatRegion(region: FormatRegion): void {
  locale = region.locale?.trim() || undefined
  timeZone = region.timeZone?.trim() || undefined
  country = region.country?.trim().toUpperCase() || undefined
}

/** Formato vigente o `undefined` (el del entorno). */
export function formatLocale(): string | undefined {
  return locale
}

/** Zona horaria vigente o `undefined` (la del entorno). */
export function formatTimeZone(): string | undefined {
  return timeZone
}

/** País de la clínica tal como lo fijó la app, o `undefined` si no lo fijó. */
export function formatCountry(): string | undefined {
  return country
}
