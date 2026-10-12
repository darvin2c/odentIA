/**
 * Formato regional con el que el paquete escribe fechas, horas, números y
 * nombres (BCP 47) y zona horaria con la que resuelve «hoy» (IANA).
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

export interface FormatRegion {
  /** BCP 47 (`es-CL`); vacío = el del entorno. */
  locale?: string | null
  /** IANA (`America/Santiago`); vacío = la del entorno. */
  timeZone?: string | null
}

export function setFormatRegion(region: FormatRegion): void {
  locale = region.locale?.trim() || undefined
  timeZone = region.timeZone?.trim() || undefined
}

/** Formato vigente o `undefined` (el del entorno). */
export function formatLocale(): string | undefined {
  return locale
}

/** Zona horaria vigente o `undefined` (la del entorno). */
export function formatTimeZone(): string | undefined {
  return timeZone
}
