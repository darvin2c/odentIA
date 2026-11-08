/** Citas de un paciente para su ficha: la agenda es la fuente, no la última atención. */
import { dayMinutesIn, hourLabel, SCHEDULE_AGENDA_LABELS, zonedDateOf } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { type AgendaAppointment, type AppointmentStatus, isUnclosed, visitLabel, visitName } from "./agenda"
import { apiFetch } from "./api"
import { activeOrgLocale, activeOrgTimeZone } from "./locale"

/** Un nombre por estado en toda la aplicación (ADR 0032): los mismos de la Agenda. */
export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = SCHEDULE_AGENDA_LABELS

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Ventana fija alrededor de hoy: la ficha muestra historial reciente y lo próximo. */
function patientWindow(): { from: string; to: string } {
  const now = Date.now()
  return {
    from: new Date(now - 3 * YEAR_MS).toISOString(),
    to: new Date(now + 2 * YEAR_MS).toISOString(),
  }
}

export function usePatientAppointments(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["patient-appointments", patientId],
    queryFn: () => {
      const { from, to } = patientWindow()
      const params = new URLSearchParams({ patientId, from, to })
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
    enabled,
    retry: false,
  })
}

/** Llegó o está en atención por esa cita, sea del día que sea. */
function arrivedOrAttending(appointment: Pick<AgendaAppointment, "visit">): boolean {
  return appointment.visit === "llego" || appointment.visit === "en_atencion"
}

/**
 * La persona está hoy en la clínica por esa cita: llegó (sala de espera) o está
 * en atención, y la cita es de hoy en la zona de la clínica. Un «Llegó» o una
 * atención en borrador de otro día no es estar aquí: es una cita pasada sin
 * cerrar (revisión del 7 nov).
 */
export function isInClinic(
  appointment: Pick<AgendaAppointment, "visit" | "startsAt">,
  now: number = Date.now(),
  timeZone: string = activeOrgTimeZone(),
): boolean {
  return (
    arrivedOrAttending(appointment) &&
    zonedDateOf(appointment.startsAt, timeZone) === zonedDateOf(new Date(now).toISOString(), timeZone)
  )
}

/**
 * Ya pasó y nadie la cerró: su hora pasó sin llegada ni atención (la regla de la
 * Agenda, `isUnclosed`) o llegó o se abrió su atención un día anterior y sigue así.
 */
export function isPastUnclosed(
  appointment: Pick<AgendaAppointment, "visit" | "startsAt" | "endsAt">,
  now: number = Date.now(),
  timeZone: string = activeOrgTimeZone(),
): boolean {
  if (arrivedOrAttending(appointment)) return !isInClinic(appointment, now, timeZone)
  return isUnclosed(appointment, new Date(now).toISOString())
}

/** Lo que la ficha dice del momento de una cita: «Sin cerrar» si pasó sin cerrarse; si no, su momento. */
export function appointmentVisitWord(
  appointment: Pick<AgendaAppointment, "visit" | "startsAt" | "endsAt">,
  now: number = Date.now(),
  timeZone: string = activeOrgTimeZone(),
): string {
  return isPastUnclosed(appointment, now, timeZone) ? "Sin cerrar" : visitName(appointment.visit)
}

/**
 * Una cita vigente: reservada y por venir, o la de hoy por la que la persona ya
 * está en la clínica aunque haya pasado su hora (QA del 6 nov, U6: a quien
 * estaba en la sala de espera la ficha le decía «Próxima cita: Ninguna»). Una
 * cita cancelada o con inasistencia no es una reserva vigente, y una de otro día
 * en que llegó o se abrió su atención tampoco.
 */
export function isUpcoming(appointment: AgendaAppointment, now = Date.now(), timeZone: string = activeOrgTimeZone()): boolean {
  if (arrivedOrAttending(appointment)) return isInClinic(appointment, now, timeZone)
  return (
    (appointment.status === "programada" || appointment.status === "confirmada") &&
    new Date(appointment.endsAt).getTime() >= now
  )
}

/** Próxima reserva vigente, o null. */
export function nextAppointment(
  appointments: AgendaAppointment[],
  now = Date.now(),
  timeZone: string = activeOrgTimeZone(),
): AgendaAppointment | null {
  return (
    appointments
      .filter((appointment) => isUpcoming(appointment, now, timeZone))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null
  )
}

export function appointmentWhen(appointment: Pick<AgendaAppointment, "startsAt">): string {
  return new Date(appointment.startsAt).toLocaleString(activeOrgLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Lo que la ficha dice de su próxima cita: cuándo, qué y con quién y, si ya está
 * en la clínica, su momento como en la Agenda («Llegó 12:26 · espera 6 min»).
 */
export function appointmentLine(
  appointment: AgendaAppointment,
  now: Date = new Date(),
  timeZone: string = activeOrgTimeZone(),
): string {
  // En la clínica, la hora como en la Agenda: «Hoy 21:30 · Llegó 23:07 · espera 10 min».
  const here = isInClinic(appointment, now.getTime(), timeZone)
  return [
    here ? `Hoy ${hourLabel(dayMinutesIn(appointment.startsAt, timeZone))}` : appointmentWhen(appointment),
    here ? visitLabel(appointment, { now: now.toISOString(), timeZone }) : null,
    appointment.serviceName ?? appointment.reason,
    appointment.professionalName,
  ]
    .filter(Boolean)
    .join(" · ")
}
