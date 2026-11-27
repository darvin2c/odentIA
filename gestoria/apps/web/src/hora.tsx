import { useMemo } from "react"

/**
 * «Hora de la tienda» (lienzo «gestorIA como odentIA», tableros 3 y 10): con ella se cuentan
 * «hoy», «mañana», los reportes y las promociones, la misma para todo el equipo aunque alguien
 * esté en otro país. Se elige en Configuración › Datos de la tienda (`configuracion.tsx`).
 */

/**
 * Las de la región primero, como las monedas al crear la tienda; después, todas. Buenos Aires se
 * llama distinto según el navegador: va la que conozca.
 */
const FIRST = [
  ["America/Lima"],
  ["America/Bogota"],
  ["America/Guayaquil"],
  ["America/La_Paz"],
  ["America/Santiago"],
  ["America/Argentina/Buenos_Aires", "America/Buenos_Aires"],
  ["America/Mexico_City"],
  ["America/Caracas"],
  ["Europe/Madrid"],
]

/** «Lima (UTC−5)»: la ciudad de la zona y cuánto va de UTC hoy. */
export function zoneLabel(zone: string, now = new Date()): string {
  const city = (zone.split("/").at(-1) ?? zone).replaceAll("_", " ")
  let offset = ""
  try {
    offset =
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? ""
  } catch {
    return city
  }
  const utc = offset.replace("GMT", "UTC").replace("-", "−")
  return `${city} (${utc})`
}

export function useZones(current: string) {
  return useMemo(() => {
    // Un navegador viejo que no da la lista ofrece al menos las de la región.
    const all =
      typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : FIRST.map(([zone]) => zone as string)
    const option = (zone: string) => ({ value: zone, label: zoneLabel(zone) })
    const firstZones = FIRST.flatMap((names) => names.find((zone) => all.includes(zone)) ?? [])
    const first = firstZones.map(option)
    const rest = all
      .filter((zone) => !firstZones.includes(zone))
      .map(option)
      .sort((a, b) => a.label.localeCompare(b.label, "es"))
    const zones = [...first, ...rest]
    // La guardada siempre está en la lista, aunque el navegador no la conozca.
    if (!zones.some((z) => z.value === current)) zones.unshift(option(current))
    return zones
  }, [current])
}
