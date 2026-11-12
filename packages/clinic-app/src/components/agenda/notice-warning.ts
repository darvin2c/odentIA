import { toast } from "@odentia/ui"
import { type AgendaAppointment, type NoticeChange, noticeWarning } from "../../lib/agenda"

const warningId = (appointmentId: string) => `aviso-sin-llegar-${appointmentId}`

/** Lo que dice ahora el aviso fijo de cada cita, y lo que decía antes de su último movimiento. */
const shown = new Map<string, string>()
const beforeMove = new Map<string, string | null>()
/** Las citas a las que, al reservarlas, tampoco les llegaba el recordatorio: moverlas lo sigue diciendo. */
const reminderToo = new Set<string>()

function show(appointmentId: string, text: string): void {
  shown.set(appointmentId, text)
  toast.warning(text, {
    id: warningId(appointmentId),
    duration: Number.POSITIVE_INFINITY,
    closeButton: true,
    onDismiss: () => shown.delete(appointmentId),
  })
}

/**
 * Si el aviso del cambio no le llegará por algo de la persona (no hay por dónde, o pidió no recibir
 * mensajes), lo dice aparte, con la cita, y queda a la vista hasta cerrarlo: el aviso flotante de
 * siempre dura unos segundos. Uno por cita: mover otra vez lo reemplaza. Va antes del aviso de
 * siempre, para que su «Deshacer» quede encima.
 */
export function warnUnsentNotice(appointment: Pick<AgendaAppointment, "id" | "notice" | "patientName">, about: NoticeChange): void {
  if (about.change === "movida") beforeMove.set(appointment.id, shown.get(appointment.id) ?? null)
  if (about.reminderToo) reminderToo.add(appointment.id)
  const text = noticeWarning(appointment, { ...about, reminderToo: about.reminderToo || reminderToo.has(appointment.id) })
  if (text) show(appointment.id, text)
}

/**
 * «Deshacer» un movimiento: vuelve lo que decía el aviso fijo antes de ese movimiento (el de un
 * movimiento anterior que tampoco le llegó), o se quita si no había ninguno: la cita volvió a
 * donde la persona sabía (QA del 11 nov).
 */
export function undoUnsentNotice(appointmentId: string): void {
  const before = beforeMove.get(appointmentId) ?? null
  beforeMove.delete(appointmentId)
  if (before) show(appointmentId, before)
  else {
    shown.delete(appointmentId)
    toast.dismiss(warningId(appointmentId))
  }
}
