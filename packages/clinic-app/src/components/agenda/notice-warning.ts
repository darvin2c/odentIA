import { toast } from "@odentia/ui"
import { type AgendaAppointment, type NoticeChange, noticeWarning } from "../../lib/agenda"

const warningId = (appointmentId: string) => `aviso-sin-llegar-${appointmentId}`

/**
 * Si el aviso del cambio no le llegará por algo de la persona (no hay por dónde, o pidió no recibir
 * mensajes), lo dice aparte, con la cita, y queda a la vista hasta cerrarlo: el aviso flotante de
 * siempre dura unos segundos. Uno por cita: mover otra vez lo reemplaza. Va antes del aviso de
 * siempre, para que su «Deshacer» quede encima.
 */
export function warnUnsentNotice(appointment: Pick<AgendaAppointment, "id" | "notice" | "patientName">, about: NoticeChange): void {
  const text = noticeWarning(appointment, about)
  if (text) toast.warning(text, { id: warningId(appointment.id), duration: Number.POSITIVE_INFINITY, closeButton: true })
}

/** «Deshacer» un movimiento: la cita vuelve a donde estaba y ya no hay nada que avisarle a mano. */
export function dismissUnsentNotice(appointmentId: string): void {
  toast.dismiss(warningId(appointmentId))
}
