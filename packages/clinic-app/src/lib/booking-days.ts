/**
 * Los días de «Su enlace» en la zona de la sede (`2026-11-03`): la fila de 7
 * días, lo que se le pide al servidor para verla y un horario por hora con
 * «Cualquiera». Solo fechas: qué horario está libre lo dice siempre el servidor.
 */

/** Cuántos días se ven a la vez. */
export const WINDOW_DAYS = 7

/** El día de un instante en la zona de la sede. */
export function dayKey(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant))
}

/** El día que queda `days` días después (o antes, si es negativo). */
export function addDays(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10)
}

/** Cuánto le lleva la hora de la zona a UTC en ese instante. */
function offsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0)
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"))
  return wall - Math.floor(instant.getTime() / 1000) * 1000
}

/** El instante en que empieza `day` en la zona de la sede. */
export function dayStart(day: string, timeZone: string): Date {
  const midnight = Date.parse(`${day}T00:00:00Z`)
  // Dos pasadas: la diferencia con UTC puede cambiar ese mismo día (cambio de hora).
  let guess = midnight
  for (let pass = 0; pass < 2; pass++) guess = midnight - offsetMs(new Date(guess), timeZone)
  return new Date(guess)
}

/** Los días que se ven desde `start`. */
export function windowDays(start: string): string[] {
  return Array.from({ length: WINDOW_DAYS }, (_, index) => addDays(start, index))
}

/**
 * Lo que se le pide al servidor para ver esos días: desde que empieza el
 * primero, o desde `now` si ya empezó, y nunca más de 7 días (lo que admite).
 */
export function windowRange(start: string, timeZone: string, now: Date): { from: string; to: string } {
  const from = Math.max(dayStart(start, timeZone).getTime(), now.getTime())
  const to = Math.min(dayStart(addDays(start, WINDOW_DAYS), timeZone).getTime(), from + WINDOW_DAYS * 86_400_000)
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

/**
 * Un horario por hora de inicio, para «Cualquiera»: si varios lo tienen libre
 * se ofrece una vez, con el primero que entrega el servidor.
 */
export function oneSlotPerStart<T extends { startsAt: string }>(slots: readonly T[]): T[] {
  const seen = new Set<string>()
  return slots.filter((slot) => {
    if (seen.has(slot.startsAt)) return false
    seen.add(slot.startsAt)
    return true
  })
}
