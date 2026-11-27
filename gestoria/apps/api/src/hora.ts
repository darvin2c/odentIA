import { type Db, store } from "@gestoria/db"
import { eq } from "drizzle-orm"
import { z } from "zod"

/**
 * La hora de la tienda (ADR 0222): qué día es «hoy» se cuenta con la zona horaria de cada tienda
 * (IANA, «America/Lima»), nunca con la del servidor ni con la del navegador. La usan «Para
 * entregar hoy», los periodos de Reportes, las promociones (de un día a otro, inclusive), Argos y
 * lo que Sofi sabe de hoy. Un día va como en el calendario: «2026-11-25» (ISO 8601).
 */

/** La zona de una tienda que no eligió otra. */
export const DEFAULT_TIME_ZONE = "America/Lima"

const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

/** El reloj de una zona (se arma una vez por zona). Lanza si la zona no existe. */
function formatterOf(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    formatters.set(timeZone, format)
  }
  return format
}

/**
 * Una zona de IANA que el entorno sabe usar. No basta la lista de `Intl.supportedValuesOf`: cada
 * navegador nombra algunas zonas distinto que el servidor («America/Argentina/Buenos_Aires» o
 * «America/Buenos_Aires», «Asia/Kolkata» o «Asia/Calcutta») y las dos formas son válidas.
 */
export function isTimeZone(name: string): boolean {
  if (name.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(name))
    return false
  if (formatters.has(name)) return true
  try {
    // Sin guardarlo: lo que se escribe para probar no llena la memoria.
    new Intl.DateTimeFormat("en-US", { timeZone: name })
    return true
  } catch {
    return false
  }
}

export const timeZoneInput = z.object({
  timeZone: z.string().trim().refine(isTimeZone, "Elige una hora de la lista"),
})

function partsOf(timeZone: string, at: Date) {
  const format = formatterOf(timeZone)
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(at))
    if (part.type !== "literal") parts[part.type] = Number(part.value)
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>
}

const pad = (n: number, size = 2) => String(n).padStart(size, "0")

/** El día en la tienda en ese momento: «2026-11-25». */
export function dayIn(timeZone: string, at = new Date()): string {
  const p = partsOf(timeZone, at)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** Cuánto va la hora de la tienda delante de UTC en ese momento, en milisegundos. */
function offsetAt(timeZone: string, at: number): number {
  const p = partsOf(timeZone, new Date(at))
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUTC - Math.floor(at / 1000) * 1000
}

/**
 * El primer instante de ese día en la tienda (sus 00:00), como fecha absoluta. Donde el cambio de
 * hora salta la medianoche, el día empieza cuando el reloj vuelve a andar.
 */
export function startOfDay(timeZone: string, day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  const midnight = Date.UTC(y, m - 1, d)
  let at = midnight - offsetAt(timeZone, midnight)
  const again = midnight - offsetAt(timeZone, at)
  if (again !== at) at = again
  // Si a esa hora la tienda todavía está en el día anterior (la medianoche no existe), se avanza.
  while (dayIn(timeZone, new Date(at)) < day) at += 15 * 60_000
  // Y si ya era ese día antes (la hora se atrasó), se retrocede hasta su primer instante.
  while (dayIn(timeZone, new Date(at - 15 * 60_000)) === day) at -= 15 * 60_000
  return new Date(at)
}

/** El día que va `days` días después (o antes) de `day`, en el calendario. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10)
}

/** El día de la semana de `day`, con el lunes como 0 (ISO 8601). */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/**
 * Un momento exacto como lo dice la tienda, en su hora: «hoy a las 6:40 p. m.», «mañana a las
 * 6:40 p. m.» o «el sábado 28 a las 9:05 a. m.». Lo usa Sofi para el plazo de una oferta: la
 * clienta ve la misma hora que vence en el pedido.
 */
export function momentWords(timeZone: string, at: Date, now = new Date()): string {
  const plain = (text: string) => text.replace(/[  ]/g, " ")
  const time = plain(
    new Intl.DateTimeFormat("es-PE", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(at),
  )
  const day = dayIn(timeZone, at)
  const today = dayIn(timeZone, now)
  if (day === today) return `hoy a las ${time}`
  if (day === addDays(today, 1)) return `mañana a las ${time}`
  const date = plain(
    new Intl.DateTimeFormat("es-PE", { timeZone, weekday: "long", day: "numeric" }).format(at),
  )
  return `el ${date} a las ${time}`
}

/** La hora de la tienda y qué día es en ella, dentro de su transacción. */
export async function storeClockIn(tx: Db, storeId: string, now = new Date()) {
  const [row] = await tx
    .select({ timeZone: store.timeZone })
    .from(store)
    .where(eq(store.id, storeId))
  const timeZone = row && isTimeZone(row.timeZone) ? row.timeZone : DEFAULT_TIME_ZONE
  return { timeZone, today: dayIn(timeZone, now) }
}
