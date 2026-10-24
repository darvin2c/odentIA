/**
 * El archivo de calendario de una cita (issue 46, ADR 0081): el mismo para la
 * descarga del portal, la de «Su enlace» y el adjunto de los avisos por correo.
 *
 * - `UID` es el id de la cita, así cada copia es el mismo evento.
 * - `SEQUENCE` sale de `appointment.version` (empieza en 1; el evento, en 0):
 *   sube al mover o cancelar, y también por cambios que no tocan la hora, lo
 *   que RFC 5545 permite (solo pide que no baje).
 * - Sin datos clínicos: el título es «Cita en <clínica>», sin el servicio,
 *   porque los calendarios se sincronizan con terceros.
 */
import { productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { branchAddressColumns, branchAddressWriter, branchDirectionsWriter, branchShortLinkWriter } from "./branches.js"
import { clinicDisplayName } from "./clinic-identity.js"
import { notFound } from "./errors.js"
import { calendarFile, type CalendarEvent, type CalendarMethod, type CalendarPerson } from "./icalendar.js"
import { findOrgLocale, orgProduct } from "./locale.js"

export const APPOINTMENT_CALENDAR_MIME = "text/calendar"
export const APPOINTMENT_CALENDAR_FILENAME = "cita.ics"

/** El evento de una cita, con lo que dice la sede: dónde, con quién y cómo llegar. */
export async function appointmentCalendarEvent(tx: Db, orgId: string, appointmentId: string, now = new Date()): Promise<CalendarEvent> {
  const [row] = await tx
    .select({
      id: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      version: appointment.version,
      branchName: branch.name,
      branchSlug: branch.slug,
      branchAddress: branchAddressColumns,
      branchPlaceId: branch.googlePlaceId,
      branchTimeZone: branch.timezone,
      professionalName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.professionalUserId))
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  if (!row) throw notFound("Cita")
  const address = (await branchAddressWriter(tx, orgId))(row.branchAddress)
  // «Cómo llegar»: el enlace corto de la clínica si hay dirección pública; si no, el mapa.
  const directions =
    (address ? (await branchShortLinkWriter(tx, orgId))(row.branchSlug) : null) ??
    (await branchDirectionsWriter(tx, orgId))({ address: row.branchAddress, placeId: row.branchPlaceId })
  return {
    uid: `${row.id}@odentia`,
    sequence: Math.max(0, row.version - 1),
    start: row.startsAt,
    end: row.endsAt,
    timeZone: row.branchTimeZone ?? (await findOrgLocale(tx, orgId)).timezone,
    summary: `Cita en ${(await clinicDisplayName(tx, orgId)) || "la clínica"}`,
    location: [`Sede ${row.branchName}`, address].filter(Boolean).join(", "),
    description: [`Con ${row.professionalName}`, directions ? `Cómo llegar: ${directions}` : null].filter(Boolean).join("\n"),
    cancelled: row.status === "cancelada",
    stamp: now,
  }
}

/** El `.ics` para guardar: lo que descargan el portal y «Su enlace». */
export async function appointmentCalendarDownload(tx: Db, orgId: string, appointmentId: string): Promise<string> {
  return calendarFile(await appointmentCalendarEvent(tx, orgId, appointmentId), undefined, await platformOf(tx, orgId))
}

/**
 * La invitación que viaja en el aviso por correo: `REQUEST` al reservar o
 * mover, `CANCEL` al cancelar (RFC 5546). Invita el buzón de la clínica que
 * envía el correo y el invitado es quien lo recibe.
 */
export async function appointmentCalendarInvite(
  tx: Db,
  orgId: string,
  appointmentId: string,
  people: { organizer: CalendarPerson; attendee: CalendarPerson },
  now = new Date(),
): Promise<{ text: string; method: CalendarMethod }> {
  const event = await appointmentCalendarEvent(tx, orgId, appointmentId, now)
  const method: CalendarMethod = event.cancelled ? "CANCEL" : "REQUEST"
  return { text: calendarFile({ ...event, ...people }, method, await platformOf(tx, orgId)), method }
}

/** La plataforma de la clínica, para el archivo (issue 229). */
async function platformOf(tx: Db, orgId: string): Promise<string> {
  return productWords(await orgProduct(tx, orgId)).name
}
