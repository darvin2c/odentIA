import { formatMoney } from "@odentia/clinical"
import { addDays, dayMinutesIn, formatDayShort, hourLabel, zonedDateOf } from "@odentia/ui-patterns"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

/**
 * Helpers puros de la UI comercial (sin red ni estado global). Toda fecha se
 * dice y se elige en la zona de la clínica, no en la del navegador: desde otro
 * país, una tarea vence a la misma hora para todos.
 */

/** ¿La fecha ya pasó? null/ausente/inválido nunca vence. */
export function isOverdue(iso: string | null | undefined, now: number = Date.now()): boolean {
  if (!iso) return false
  const time = new Date(iso).getTime()
  return !Number.isNaN(time) && time < now
}

/**
 * Fecha y hora corta, en el formato y la zona de la clínica
 * («12/09/2026, 02:30 p. m.»). null/ausente/inválido → "Sin fecha".
 */
export function formatDueAt(iso: string | null | undefined, timeZone: string = activeOrgTimeZone()): string {
  if (!iso) return "Sin fecha"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Sin fecha"
  return date.toLocaleString(activeOrgLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  })
}

/**
 * Cuándo vence, con palabras y en la zona de la clínica: «hoy, 15:00»,
 * «mañana», «ayer», «jue 17». Sin hora cuando es medianoche o el final del día.
 */
export function dueWords(
  iso: string | null | undefined,
  now: number = Date.now(),
  timeZone: string = activeOrgTimeZone(),
): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "sin fecha"
  const day = zonedDateOf(iso, timeZone)
  const today = zonedDateOf(new Date(now).toISOString(), timeZone)
  const minutes = dayMinutesIn(iso, timeZone)
  const time = minutes > 0 && minutes < 23 * 60 + 59 ? `, ${hourLabel(minutes)}` : ""
  if (day === today) return `hoy${time}`
  if (day === addDays(today, 1)) return `mañana${time}`
  if (day === addDays(today, -1)) return `ayer${time}`
  return `${formatDayShort(day)}${time}`
}

/**
 * Importe con la moneda congelada del registro y el formato de la clínica.
 * Sin locale (perfil aún cargando) o sin importe devuelve null: cada
 * superficie muestra su estado neutro en vez de inventar un precio.
 */
export function moneyText(amountCents: number | null, currency: string, locale?: string): string | null {
  if (amountCents === null || !locale) return null
  try {
    return formatMoney(amountCents, currency, locale)
  } catch {
    return null
  }
}
