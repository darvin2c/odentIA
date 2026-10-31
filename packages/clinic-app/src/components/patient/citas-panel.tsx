import { Badge, Button } from "@odentia/ui"
import { EmptyState, SkeletonRegion } from "@odentia/ui-patterns"
import { CalendarDays } from "lucide-react"
import { useId } from "react"
import { type AgendaAppointment, visitName } from "../../lib/agenda"
import { usePermission } from "../../lib/crm"
import {
  appointmentWhen,
  isUpcoming,
  usePatientAppointments,
} from "../../lib/patient-appointments"
import { QueryErrorState } from "../../lib/query-error"
import { openAppointmentAnywhere, openBookingAnywhere } from "../agenda/schedule-host"
import { CitasSkeleton } from "../skeletons/person-sections"

function statusVariant(appointment: AgendaAppointment): "success" | "warning" | "outline" | "soft" {
  if (appointment.status === "confirmada" || appointment.status === "atendida") return "success"
  if (appointment.status === "no_asistio" || appointment.status === "cancelada") return "warning"
  return isUpcoming(appointment) ? "soft" : "outline"
}

function AppointmentRow({ appointment }: { appointment: AgendaAppointment }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{appointmentWhen(appointment)}</span>
        <span className="break-words text-muted-foreground">
          {[appointment.serviceName ?? appointment.reason, appointment.professionalName]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* El momento de la cita con el mismo nombre que en la Agenda: también «Llegó» o «En atención». */}
        <Badge variant={statusVariant(appointment)}>{visitName(appointment.visit)}</Badge>
        {/* La cita se abre al lado, con sus acciones de siempre: la pestaña sigue a la vista. */}
        <Button type="button" size="sm" variant="outline" onClick={() => openAppointmentAnywhere(appointment.id)}>
          Ver cita
        </Button>
      </div>
    </li>
  )
}

/** Citas del paciente: lo reservado y lo ocurrido, con salida a la agenda para gestionarlas. */
export function CitasPanel({ patientId, patientName, conversationId }: { patientId: string; patientName: string; conversationId?: string }) {
  // En «Contexto» pueden ir dos paneles juntos: el de la persona y el de a quien lleva.
  const titleId = useId()
  const canRead = usePermission("appointments.read")
  const canWrite = usePermission("appointments.write")
  const query = usePatientAppointments(patientId, canRead)
  // «Nueva cita» al lado: la pestaña Citas sigue a la vista.
  const book = () => openBookingAnywhere({ patient: { id: patientId, name: patientName }, lockedPatient: true, conversationId })

  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando citas…">
        <CitasSkeleton
          action={
            canWrite ? (
              <Button size="sm" onClick={book}>
                Reservar cita
              </Button>
            ) : undefined
          }
        />
      </SkeletonRegion>
    )
  if (query.isError)
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />

  const all = query.data.data
  const upcoming = all
    .filter((item) => isUpcoming(item))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const past = all
    .filter((item) => !isUpcoming(item))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt))

  if (all.length === 0)
    return (
      <EmptyState
        icon={CalendarDays}
        title="Sin citas"
        description="Este paciente no tiene citas reservadas ni pasadas en la agenda."
        actionLabel={canWrite ? "Reservar cita" : undefined}
        onAction={canWrite ? book : undefined}
      />
    )

  return (
    <div className="flex flex-col gap-4">
      <section className="elevated rounded-xl border bg-card p-6" aria-labelledby={`${titleId}-proximas`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${titleId}-proximas`} className="font-heading text-base font-medium">
            Próximas citas
          </h2>
          {canWrite ? (
            <Button size="sm" onClick={book}>
              Reservar cita
            </Button>
          ) : null}
        </div>
        {upcoming.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin citas reservadas.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {upcoming.map((appointment) => (
              <AppointmentRow key={appointment.id} appointment={appointment} />
            ))}
          </ul>
        )}
      </section>
      {past.length > 0 ? (
        <section
          className="elevated rounded-xl border bg-card p-6"
          aria-labelledby={`${titleId}-anteriores`}
        >
          <h2 id={`${titleId}-anteriores`} className="font-heading text-base font-medium">
            Citas anteriores
          </h2>
          <ul className="mt-2 flex flex-col divide-y">
            {past.map((appointment) => (
              <AppointmentRow key={appointment.id} appointment={appointment} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
