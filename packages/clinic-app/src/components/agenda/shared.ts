/** Piezas comunes de la agenda: formas de decir cuándo y de leer un error. */
import {
  addDays,
  dayMinutesIn,
  formatDayShort,
  hourLabel,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { ApiError } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? error.message
  return error instanceof Error ? error.message : String(error)
}

/** «Dra. Ana Torres» → «Dra. Ana»: lo que cabe en una ficha. */
export function shortName(label: string): string {
  return label.split(/\s+/).slice(0, 2).join(" ")
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("es") + text.slice(1)

/** «lun 12» sin punto, para decir un día en una frase. */
export function dayShort(date: string): string {
  return formatDayShort(date).replace(".", "")
}

/** «hoy a las 11:00» o «el mar 13 a las 09:00». */
export function whenSaid(startISO: string, timeZone: string, today: string): string {
  const date = zonedDateOf(startISO, timeZone)
  const day =
    date === today ? "hoy" : date === addDays(today, 1) ? "mañana" : `el ${dayShort(date)}`
  return `${day} a las ${hourLabel(dayMinutesIn(startISO, timeZone))}`
}

/** «Hoy, de 11:30 a 12:00» o «Mar 13, de 09:00 a 09:30». */
/** «nov» de un día «YYYY-MM-DD», en el idioma de la clínica. */
function monthShort(date: string): string {
  const [year, month, day] = date.split("-").map(Number)
  return new Intl.DateTimeFormat(activeOrgLocale(), { month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(year!, month! - 1, day!, 12)))
    .replace(".", "")
}

export function rangeSaid(
  startISO: string,
  endISO: string,
  timeZone: string,
  today: string,
): string {
  const date = zonedDateOf(startISO, timeZone)
  // Lejos de esta semana, con su mes: «Mar 3» de una cita pasada se leía como 3 de marzo.
  const far = date < addDays(today, -6) || date > addDays(today, 6)
  const day = date === today ? "Hoy" : capitalize(far ? `${dayShort(date)} ${monthShort(date)}` : dayShort(date))
  return `${day}, de ${hourLabel(dayMinutesIn(startISO, timeZone))} a ${hourLabel(dayMinutesIn(endISO, timeZone))}`
}
