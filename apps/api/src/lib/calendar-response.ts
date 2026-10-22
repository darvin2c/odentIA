import { APPOINTMENT_CALENDAR_FILENAME, APPOINTMENT_CALENDAR_MIME } from "@odentia/services"

/** El `.ics` de una cita como descarga (issue 46): sin caché ni referer, como lo demás de las páginas públicas. */
export function calendarResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      "Content-Type": `${APPOINTMENT_CALENDAR_MIME}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${APPOINTMENT_CALENDAR_FILENAME}"`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}
