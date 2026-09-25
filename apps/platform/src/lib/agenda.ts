/** Contratos de la agenda con la API (`/api/agenda` y `/api/appointments`). */

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
}

export interface AgendaServiceOption {
  id: string
  name: string
  durationMin: number | null
}
