# 0081 · La cita como evento de calendario

- **Fecha:** 2026-10-22
- **Estado:** aceptada (lote 1 del issue 46: invitación y descarga; la suscripción del profesional queda para el lote 2)

## Problema

La persona quiere tener su cita en su propio calendario (Google, Apple u Outlook), y cuando la cita se mueve o se cancela, el calendario tiene que cambiar con ella. Antes el archivo `.ics` lo armaba cada página en el navegador. Cada página usaba un identificador distinto: en el portal salía de la cita y en «Su enlace», del enlace. Además, el archivo no tenía versión ni zona horaria, y nunca llegaba por correo. Por eso la misma cita podía quedar dos veces en el calendario y una cancelación no la quitaba. Los calendarios se sincronizan con terceros, así que el evento no puede llevar datos clínicos.

## Decisión y motivo

- **Un solo generador en el servidor** (`icalendar.ts`, RFC 5545) y **un solo evento por cita** (`appointment-calendar.ts`). Lo usan la descarga del portal, la de «Su enlace» y el adjunto del correo:
  - el `UID` es el id de la cita;
  - el `SEQUENCE` sale de `appointment.version`, así que el calendario reemplaza el evento en vez de añadir otro;
  - la hora va en la zona de la sede (`TZID`) con su `VTIMEZONE`, armado con la base de zonas del sistema (Intl), sin reglas propias.
- **Por correo va como invitación** (RFC 5546): `REQUEST` al reservar o mover y `CANCEL` al cancelar. Invita el buzón de la clínica que envía el correo, y el invitado es quien lo recibe, con `RSVP=FALSE` porque la cita ya está reservada. Así el calendario la actualiza y la borra solo. La descarga no lleva método: es un archivo para guardar.
- **Solo en los tres avisos de cambio** (reservada, movida, cancelada) y solo por correo. El recordatorio no lo lleva, porque no cambia nada. WhatsApp tampoco: un enlace nuevo obliga a pedirle a Meta otras plantillas, y «Su enlace», que ya va en el mensaje, tiene «Añadir al calendario».
- **Sin datos clínicos:**
  - el título es «Cita en <clínica>», sin el servicio;
  - la ubicación es la sede y su dirección;
  - la descripción dice con quién es la cita y «Cómo llegar» (`/llegar/<sede>`, o el mapa si no hay dirección pública).

## Alternativas descartadas

- **Seguir armándolo en el navegador:** el correo no puede usarlo, y cada página volvería a tener su propio identificador.
- **Archivo para guardar también por correo (`PUBLISH` o sin método):** no muestra botones de respuesta, pero Google no quita el evento al cancelar, y el issue lo exige.
- **Una librería de iCalendar:** suma una dependencia para unas pocas líneas. Además, el escape, el plegado y la zona horaria quedan probados en `icalendar.test.ts`.
- **Hora en UTC sin `TZID`:** es válido, pero el issue pide la zona de la sede, y con ella algunos calendarios muestran la hora local de la clínica cuando quien la mira está de viaje.

## Consecuencias

- Gmail u Outlook pueden mostrar «¿Asistirás?» aunque se pida `RSVP=FALSE`. Si la persona responde, llega un correo a la Bandeja como cualquier otro: no se interpreta como confirmación.
- `SEQUENCE` también sube con cambios que no tocan la hora (por ejemplo, «Llegó»). RFC 5545 lo permite, porque solo exige que no baje.
- El `VTIMEZONE` cubre un año antes y otro después de la cita: basta para una cita y no hay que mantener reglas.
- Las pruebas comprueban la forma del archivo. Que Google, Apple y Outlook lo actualicen y lo borren solo se confirma enviando correos reales.
- Revisar si la clínica pide más detalle en el evento o si se suma la suscripción del profesional (lote 2), que necesitará su propio evento con menos datos.

## Referencias

- `packages/services/src/icalendar.ts`, `appointment-calendar.ts`; `deliverJob` en `automation.ts`; `getPortalAppointmentCalendar` (`portal.ts`) y `getBookingLinkCalendar` (`booking-links.ts`).
- `apps/api/src/routes/public-portal.ts` (`GET /appointments/:id/calendar`) y `public-booking.ts` (`POST /:slug/calendar`).
- Reemplaza la última frase del punto «No construido todavía» de la ADR 0014.
- Issue 46.
