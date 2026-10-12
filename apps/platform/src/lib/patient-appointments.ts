/** Citas de un paciente para su ficha: la agenda es la fuente, no la última atención. */
import { useQuery } from "@tanstack/react-query"
import type { AgendaAppointment, AppointmentStatus } from "./agenda"
import { apiFetch } from "./api"
import { activeOrgLocale } from "./locale"

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentStatus, string> = {
  programada: "Programada",
  confirmada: "Confirmada",
  atendida: "Atendida",
  no_asistio: "No asistió",
  cancelada: "Cancelada",
}

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

/** Una cita cancelada o con inasistencia no es una reserva vigente. */
export function isUpcoming(appointment: AgendaAppointment, now = Date.now()): boolean {
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

export function appointmentWhen(appointment: AgendaAppointment): string {
  return new Date(appointment.startsAt).toLocaleString(activeOrgLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}
