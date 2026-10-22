/**
 * «Atiendes la cita de la Dra. Ana Torres» (ADR 0032, tablero 7): dentro de la
 * atención, cuando quien la lleva no es el profesional de su cita (quien cubre
 * a otro). Lee la cita con el permiso de la agenda; sin cita, sin permiso o si
 * coincide el profesional, no dice nada.
 */
import { useQuery } from "@tanstack/react-query"
import { type AgendaAppointment, professionalSaid } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"

export function AttendingForNotice({
  appointmentId,
  encounterDentistUserId,
}: {
  appointmentId: string | null
  /** Quien lleva la atención. */
  encounterDentistUserId: string
}) {
  const canSeeAgenda = usePermission("appointments.read")
  const query = useQuery({
    queryKey: ["agenda-appointment", appointmentId],
    enabled: canSeeAgenda && Boolean(appointmentId),
    queryFn: () => apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${appointmentId}`),
  })
  const visit = query.data?.data
  if (!visit || visit.dentistUserId === encounterDentistUserId) return null
  return (
    <p role="note" className="rounded-lg bg-info-soft px-3 py-2 text-sm text-foreground">
      Atiendes la cita de {professionalSaid(visit.dentistName, { full: true })}
    </p>
  )
}
