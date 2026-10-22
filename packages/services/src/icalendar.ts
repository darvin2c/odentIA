/**
 * La cita como evento de calendario (issue 46, ADR 0081): iCalendar según
 * RFC 5545 y, cuando viaja en un correo, los métodos de RFC 5546 (`REQUEST`
 * para reservar o mover, `CANCEL` para cancelar). Un mismo `UID` por cita y un
 * `SEQUENCE` que crece hacen que Google, Apple u Outlook actualicen o borren el
 * evento que ya tienen en vez de añadir otro.
 *
 * La hora va en la zona de la sede (`TZID`) con su `VTIMEZONE`, que RFC 5545
 * exige junto a cada `TZID`. Se arma con la base de zonas del sistema (Intl):
 * sus cambios de hora en los meses alrededor de la cita, sin reglas propias.
 */

export type CalendarMethod = "REQUEST" | "CANCEL"

export interface CalendarPerson {
  email: string
  name?: string | null
}

export interface CalendarEvent {
  uid: string
  /** Revisión del evento (RFC 5545 §3.8.7.4): crece con cada cambio. */
  sequence: number
  start: Date
  end: Date
  /** Zona IANA de la sede («America/Lima»). */
  timeZone: string
  summary: string
  location?: string | null
  description?: string | null
  cancelled?: boolean
  /** Momento en que se arma el archivo (`DTSTAMP`). */
  stamp: Date
  /** Quien invita y a quién: obligatorios con método (RFC 5546 §3.2). */
  organizer?: CalendarPerson
  attendee?: CalendarPerson
}

const PRODID = "-//odentIA//Citas//ES"

/** Texto según RFC 5545 §3.3.11: barra, punto y coma, coma y salto de línea escapados. */
export function escapeCalendarText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r\n|\r|\n/g, "\\n")
}

/**
 * Plegado de RFC 5545 §3.1: ninguna línea pasa de 75 octetos sin contar el
 * CRLF; la que sigue empieza con un espacio. Nunca parte un carácter UTF-8.
 */
export function foldCalendarLine(line: string): string {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let current = ""
  let size = 0
  let limit = 75
  for (const char of line) {
    const bytes = encoder.encode(char).length
    if (size + bytes > limit) {
      parts.push(current)
      current = ""
      size = 0
      // La línea que sigue lleva el espacio del plegado, que también cuenta.
      limit = 74
    }
    current += char
    size += bytes
  }
  parts.push(current)
  return parts.join("\r\n ")
}

/** Un valor de parámetro (CN): entre comillas, sin comillas dentro (RFC 5545 §3.2). */
function paramText(value: string): string {
  return `"${value.replace(/["\r\n]/g, "")}"`
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0")
}

/** Fecha y hora en UTC (`20261023T150000Z`). */
function utcStamp(instant: Date): string {
  return `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}Z`
}

/** Minutos que la zona suma a UTC en ese instante (Lima: −300). */
function offsetMinutes(timeZone: string, instant: Date): number {
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
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  const wall = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"))
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000)
}

/** La hora de reloj de la zona (`20261023T100000`), para `DTSTART;TZID=…`. */
function localStamp(instant: Date, offset: number): string {
  return utcStamp(new Date(instant.getTime() + offset * 60_000)).slice(0, -1)
}

/** «-0500», «+0530» (RFC 5545 §3.3.14). */
function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
}

const DAY_MS = 86_400_000

/** Los cambios de hora de la zona entre dos instantes, con su minuto exacto. */
function transitions(timeZone: string, from: Date, to: Date): { at: Date; before: number; after: number }[] {
  const found: { at: Date; before: number; after: number }[] = []
  let previous = Math.floor(from.getTime() / 60_000) * 60_000
  let previousOffset = offsetMinutes(timeZone, new Date(previous))
  for (let at = previous + DAY_MS; at <= to.getTime() + DAY_MS; at += DAY_MS) {
    const offset = offsetMinutes(timeZone, new Date(at))
    if (offset !== previousOffset) {
      // El minuto del cambio, por bisección dentro de ese día (en minutos enteros).
      let low = previous / 60_000
      let high = at / 60_000
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2)
        if (offsetMinutes(timeZone, new Date(middle * 60_000)) === previousOffset) low = middle
        else high = middle
      }
      found.push({ at: new Date(high * 60_000), before: previousOffset, after: offset })
    }
    previous = at
    previousOffset = offset
  }
  return found
}

/**
 * El `VTIMEZONE` de la zona para las fechas de la cita: los cambios de hora de
 * un año antes a un año después, cada uno con la hora de reloj en que empieza
 * (en la hora de antes, RFC 5545 §3.6.5). Una zona sin cambios es una sola
 * observancia `STANDARD` con su desfase.
 */
function timezoneLines(timeZone: string, start: Date, end: Date): string[] {
  const changes = transitions(timeZone, new Date(start.getTime() - 366 * DAY_MS), new Date(end.getTime() + 366 * DAY_MS))
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`]
  if (changes.length === 0) {
    const offset = offsetText(offsetMinutes(timeZone, start))
    lines.push("BEGIN:STANDARD", "DTSTART:19700101T000000", `TZOFFSETFROM:${offset}`, `TZOFFSETTO:${offset}`, "END:STANDARD")
  } else {
    // El horario de verano es el desfase mayor de los dos.
    const largest = Math.max(...changes.map((change) => change.after))
    for (const change of changes) {
      const kind = change.after === largest && change.after > change.before ? "DAYLIGHT" : "STANDARD"
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${localStamp(change.at, change.before)}`,
        `TZOFFSETFROM:${offsetText(change.before)}`,
        `TZOFFSETTO:${offsetText(change.after)}`,
        `END:${kind}`,
      )
    }
  }
  lines.push("END:VTIMEZONE")
  return lines
}

/**
 * El archivo `.ics` de un evento. Sin método es para guardar (la descarga);
 * con método es la invitación de un correo y lleva quién invita y a quién,
 * sin pedir respuesta (`RSVP=FALSE`): la cita ya está reservada.
 */
export function calendarFile(event: CalendarEvent, method?: CalendarMethod): string {
  if (method && (!event.organizer || !event.attendee)) throw new Error("Una invitación lleva quién invita y a quién")
  const person = (property: string, who: CalendarPerson, extra = "") =>
    `${property}${who.name ? `;CN=${paramText(who.name)}` : ""}${extra}:mailto:${who.email}`
  const cancelled = event.cancelled || method === "CANCEL"
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    ...(method ? [`METHOD:${method}`] : []),
    ...timezoneLines(event.timeZone, event.start, event.end),
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${utcStamp(event.stamp)}`,
    `DTSTART;TZID=${event.timeZone}:${localStamp(event.start, offsetMinutes(event.timeZone, event.start))}`,
    `DTEND;TZID=${event.timeZone}:${localStamp(event.end, offsetMinutes(event.timeZone, event.end))}`,
    `SUMMARY:${escapeCalendarText(event.summary)}`,
    ...(event.location ? [`LOCATION:${escapeCalendarText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeCalendarText(event.description)}`] : []),
    `STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    ...(method && event.organizer && event.attendee
      ? [
          person("ORGANIZER", event.organizer),
          person("ATTENDEE", event.attendee, ";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE"),
        ]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ]
  return `${lines.map(foldCalendarLine).join("\r\n")}\r\n`
}
