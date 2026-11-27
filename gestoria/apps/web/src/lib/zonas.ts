import type { DeliveryMethod, DeliveryZone, OpeningHours } from "./tienda"

/**
 * Lo que la pantalla de Entregas sabe de las zonas (lienzo «gestorIA · Configuración, de nuevo»,
 * tablero 7). Los distritos y sus nombres los manda el servidor (`distritos.ts` de la API, con
 * sus códigos UBIGEO del INEI); aquí solo va dónde se dibuja cada uno en el mapa y cómo se dicen
 * las reglas. Qué vale y qué no lo decide el servidor.
 */

export interface District {
  code: string
  name: string
  short: string
  province: "Lima" | "Callao"
  ipsos: string
}

export type FailedTrip = "primera_tienda" | "clienta" | "tienda"

export interface DeliverySetup {
  deliveries: DeliveryMethod[]
  slots: { start: number; end: number; label: string }[]
  shipFrom: string | null
  failedTrip: FailedTrip
  timeZone: string
  template: boolean
  districts: District[]
}

/**
 * El mapa esquemático: cada distrito en su lugar aproximado, en una rejilla de 11 columnas y 13
 * filas (columna, fila). No es un mapa de calles: el mar queda al oeste, el norte arriba.
 */
export const MAP_COLUMNS = 11
export const MAP_ROWS = 13
export const MAP_PLACES: Record<string, [number, number]> = {
  "150102": [4, 0],
  "150139": [3, 1],
  "150125": [5, 1],
  "150106": [6, 1],
  "070106": [2, 2],
  "070107": [3, 2],
  "150117": [5, 2],
  "150110": [6, 2],
  "070101": [2, 3],
  "070103": [3, 3],
  "150135": [4, 3],
  "150112": [5, 3],
  "150132": [7, 3],
  "150118": [9, 3],
  "070105": [0, 4],
  "070104": [1, 4],
  "070102": [2, 4],
  "150105": [4, 4],
  "150101": [5, 4],
  "150128": [6, 4],
  "150111": [7, 4],
  "150137": [8, 4],
  "150107": [10, 4],
  "150136": [2, 5],
  "150121": [3, 5],
  "150113": [4, 5],
  "150116": [5, 5],
  "150115": [6, 5],
  "150134": [7, 5],
  "150103": [8, 5],
  "150120": [3, 6],
  "150131": [4, 6],
  "150141": [5, 6],
  "150130": [6, 6],
  "150114": [7, 6],
  "150109": [9, 6],
  "150122": [4, 7],
  "150140": [6, 7],
  "150104": [4, 8],
  "150108": [5, 8],
  "150133": [6, 8],
  "150143": [7, 8],
  "150142": [6, 9],
  "150119": [7, 9],
  "150123": [8, 9],
  "150126": [7, 10],
  "150127": [8, 10],
  "150129": [8, 11],
  "150138": [9, 11],
  "150124": [9, 12],
}

/**
 * El color de cada zona, en su orden (después de la sexta se repiten). Nunca es la única señal:
 * cada distrito dice su número de zona y su nombre.
 */
export const ZONE_TONES = [
  "border-sky-500 bg-sky-100 dark:bg-sky-950",
  "border-emerald-500 bg-emerald-100 dark:bg-emerald-950",
  "border-amber-500 bg-amber-100 dark:bg-amber-950",
  "border-violet-500 bg-violet-100 dark:bg-violet-950",
  "border-rose-500 bg-rose-100 dark:bg-rose-950",
  "border-zinc-500 bg-zinc-200 dark:bg-zinc-800",
]

export const zoneTone = (index: number) => ZONE_TONES[index % ZONE_TONES.length] ?? ""

/** La zona de cada distrito (su posición en la lista), por su código. */
export function zoneOfDistrict(zones: DeliveryZone[]): Map<string, number> {
  const map = new Map<string, number>()
  zones.forEach((zone, index) => {
    for (const code of zone.districts) map.set(code, index)
  })
  return map
}

/** Las zonas con un distrito movido a otra (o a ninguna, con `null`): un distrito, una zona. */
export function moveDistrict(
  zones: DeliveryZone[],
  code: string,
  to: number | null,
): DeliveryZone[] {
  return zones.map((zone, index) => {
    const rest = zone.districts.filter((d) => d !== code)
    return { ...zone, districts: index === to ? [...rest, code] : rest }
  })
}

/** «1 p. m.», «10:30 a. m.». */
export function clockText(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24
  const m = minutes % 60
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "a. m." : "p. m."}`
}

/** «10 a. m. – 1 p. m.», «2 – 6 p. m.». */
export function rangeText(start: number, end: number): string {
  const from = clockText(start)
  const to = clockText(end)
  return from.slice(-5) === to.slice(-5) ? `${from.slice(0, -6)} – ${to}` : `${from} – ${to}`
}

export const WEEKDAYS = [
  { value: 1, short: "Lun", name: "lunes" },
  { value: 2, short: "Mar", name: "martes" },
  { value: 3, short: "Mié", name: "miércoles" },
  { value: 4, short: "Jue", name: "jueves" },
  { value: 5, short: "Vie", name: "viernes" },
  { value: 6, short: "Sáb", name: "sábado" },
  { value: 7, short: "Dom", name: "domingo" },
]

function listText(words: string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} y ${words.at(-1)}` : (words[0] ?? "")
}

/** «Martes y viernes». */
export function weekdaysText(days: number[]): string {
  const text = listText(days.map((day) => WEEKDAYS[day - 1]?.name ?? ""))
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Cuándo llega lo de una zona, como lo lee la tienda. */
export function leadText(zone: Pick<DeliveryZone, "lead" | "cutoff" | "weekdays">): string {
  if (zone.lead === "hoy") return `Hoy, si pide antes de la ${clockText(zone.cutoff ?? 0)}`
  if (zone.lead === "dias") return weekdaysText(zone.weekdays)
  return "Al día siguiente"
}

/** «Lun a sáb · 10 a. m. – 7 p. m.». */
export function hoursText(hours: OpeningHours): string {
  const days = [...hours.days].sort((a, b) => a - b)
  const consecutive = days.every((day, i) => i === 0 || day === (days[i - 1] ?? 0) + 1)
  const name = (day: number) => WEEKDAYS[day - 1]?.short ?? ""
  const dayText =
    days.length > 2 && consecutive
      ? `${name(days[0] ?? 1)} a ${name(days.at(-1) ?? 7).toLowerCase()}`
      : listText(days.map(name))
  return `${dayText} · ${rangeText(hours.opens, hours.closes)}`
}

export const READY_TEXT = {
  "1h": "1 hora",
  "2h": "2 horas",
  dia_siguiente: "Al día siguiente",
} as const

export const FAILED_TRIP_TEXT: Record<FailedTrip, string> = {
  primera_tienda: "La primera vez lo asumo yo; el siguiente viaje lo paga ella",
  clienta: "Cada viaje lo paga ella",
  tienda: "Lo asumo siempre",
}

/** La misma regla, dicha a quien anota «No se entregó» (puede no ser quien la eligió). */
export const FAILED_TRIP_NOTE: Record<FailedTrip, string> = {
  primera_tienda: "la primera vez la tienda asume el viaje; el siguiente lo paga la clienta",
  clienta: "cada viaje que se repite lo paga la clienta",
  tienda: "la tienda asume siempre el viaje que se repite",
}

/** Las agencias de siempre; otra se escribe. Solo dan el número: se sigue en su web. */
export const AGENCY_SITES: Record<string, string | null> = {
  Shalom: "https://rastrea.shalom.pe",
  "Olva Courier": "https://www.olvacourier.com",
  Marvisur: null,
}

/** La web donde se sigue un envío de esa agencia, o null si no la conocemos. */
export function agencySite(agency: string | null): string | null {
  return agency ? (AGENCY_SITES[agency] ?? null) : null
}

/** Las zonas que nombra una lista: «La Victoria, Lince, Miraflores y 14 más». */
export function districtsText(codes: string[], names: Map<string, string>, shown = 4): string {
  const list = codes.map((code) => names.get(code) ?? code)
  if (list.length === 0) return "Sin distritos"
  if (list.length <= shown) return listText(list)
  return `${list.slice(0, shown).join(", ")} y ${list.length - shown} más`
}

/**
 * El cuerpo completo de una forma de entrega para guardarla (el servidor la recibe entera): lo
 * que ya tiene, con lo que cambia.
 */
export function methodBody(method: DeliveryMethod, change: Partial<DeliveryMethod> = {}) {
  const { id: _, ...rest } = { ...method, ...change }
  return rest
}
