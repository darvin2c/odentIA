import { toast } from "@odentia/ui"
import { type AgendaAppointment, noticeWarning } from "../../lib/agenda"

/**
 * Si el aviso del cambio no le llegará por algo de la persona (no hay por dónde, o pidió no recibir
 * mensajes), lo dice aparte y queda a la vista hasta cerrarlo, como lo demás que no debe perderse
 * al reservar: el aviso flotante de siempre dura unos segundos.
 */
export function warnUnsentNotice(appointment: Pick<AgendaAppointment, "notice" | "patientName">): void {
  const text = noticeWarning(appointment)
  if (text) toast.warning(text, { duration: Number.POSITIVE_INFINITY, closeButton: true })
}
