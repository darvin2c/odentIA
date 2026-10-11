/** Contratos de la agenda con la API (`/api/agenda` y `/api/appointments`). */
import type { QueryClient } from "@tanstack/react-query"

/** Una cita afecta disponibilidad y seguimiento, también en superficies no montadas. */
export async function invalidateAppointmentQueries(client: QueryClient): Promise<void> {
  await Promise.all(
    [
      "agenda",
      "agenda-appointment",
      "agenda-availability",
      "agenda-resources",
      "agenda-search",
      "follow-up-appointments",
      "follow-ups",
      "patient-appointments",
      "patient-summary",
      "treatment-coordination",
      "treatment-journey",
      "workspace-home",
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  )
}

export type AppointmentStatus =
  | "programada"
  | "confirmada"
  | "atendida"
  | "no_asistio"
  | "cancelada"

export interface AgendaAppointment {
  id: string
  patientId: string
  patientName: string
  dentistUserId: string
  dentistName: string
  chairId: string
  chairName: string
  branchId: string
  serviceId: string | null
  serviceName: string | null
  status: AppointmentStatus
  startsAt: string
  endsAt: string
  reason: string | null
  version: number
}

export interface AgendaResources {
  branchId: string
  branchName: string
  timeZone: string
  professionals: { id: string; label: string }[]
  chairs: { id: string; label: string }[]
  /** Lo que dura una cita regular en la sede, en minutos. */
  defaultDurationMin: number
}

export interface AgendaServiceOption {
  id: string
  name: string
  durationMin: number | null
}

export interface ScheduleRule {
  id: string
  weekday: number
  startMin: number
  endMin: number
  isActive: boolean
}

export interface ProfessionalSchedule {
  branchId: string
  dentistUserId: string
  timeZone: string
  rules: ScheduleRule[]
}

export interface ScheduleBlock {
  id: string
  branchId: string
  dentistUserId: string | null
  dentistName: string | null
  chairId: string | null
  kind: "bloqueo" | "ausencia"
  reason: string | null
  startsAt: string
  endsAt: string
}

/** Lo que la agenda pinta como reservable (`GET /api/agenda/availability`). */
export interface AgendaAvailability {
  branchId: string
  timeZone: string
  professionals: {
    id: string
    label: string
    nextFree: { startsAt: string; endsAt: string; chairId: string | null } | null
  }[]
  defaultDurationMin: number
  open: { dentistUserId: string; startsAt: string; endsAt: string }[]
  /** Tramos en que cada profesional puede recibir una cita: su horario menos lo ocupado. */
  free: { dentistUserId: string; startsAt: string; endsAt: string }[]
  blocks: ScheduleBlock[]
}

/** Persona encontrada al buscar una cita, con sus próximas citas en pie. */
export interface AgendaSearchPerson {
  patientId: string
  patientName: string
  appointments: AgendaAppointment[]
}

export const WEEKDAY_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]

/** Minutos → "HH:MM" para los turnos del horario semanal. */
export function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}
