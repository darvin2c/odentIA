/** Citas de un paciente para su ficha: la agenda es la fuente, no la última atención. */
import { SCHEDULE_AGENDA_LABELS } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { type AgendaAppointment, type AppointmentStatus, visitLabel } from "./agenda"
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

/** La persona está en la clínica por esa cita: llegó (sala de espera) o está en atención. */
export function isInClinic(appointment: Pick<AgendaAppointment, "visit">): boolean {
  return appointment.visit === "llego" || appointment.visit === "en_atencion"
}

/**
 * Una cita vigente: reservada y por venir, o la de hoy por la que la persona ya
 * está en la clínica aunque haya pasado su hora (QA del 6 nov, U6: a quien
 * estaba en la sala de espera la ficha le decía «Próxima cita: Ninguna»). Una
 * cita cancelada o con inasistencia no es una reserva vigente.
 */
export function isUpcoming(appointment: AgendaAppointment, now = Date.now()): boolean {
  if (isInClinic(appointment)) return true
  return (
    (appointment.status === "programada" || appointment.status === "confirmada") &&
    new Date(appointment.endsAt).getTime() >= now
  )
}

/** Próxima reserva vigente, o null. */
export function nextAppointment(
  appointments: AgendaAppointment[],
  now = Date.now(),
): AgendaAppointment | null {
  return (
    appointments
      .filter((appointment) => isUpcoming(appointment, now))
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
export function appointmentLine(appointment: AgendaAppointment, now: Date = new Date()): string {
  return [
    appointmentWhen(appointment),
    isInClinic(appointment) ? visitLabel(appointment, { now: now.toISOString(), timeZone: activeOrgTimeZone() }) : null,
    appointment.serviceName ?? appointment.reason,
    appointment.professionalName,
  ]
    .filter(Boolean)
    .join(" · ")
}
