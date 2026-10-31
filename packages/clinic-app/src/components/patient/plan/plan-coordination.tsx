/**
 * Lo que recepción ve del plan sin leer la ficha clínica (vista de
 * `treatment-coordination.ts`): los tratamientos con su título y estado, y los
 * controles con «Reservar cita». Nunca diagnósticos, piezas, importes ni notas.
 */
import { Badge, Button } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { CoordinationRowsSkeleton } from "../../skeletons/person-sections"
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { planDecisionLabel } from "../../../lib/budgets"
import {
  fetchTreatmentCoordination,
  formatDate,
  formatDateTime,
  type SchedulableControl,
} from "../../../lib/clinical-journey"
import { usePermission } from "../../../lib/crm"
import { planStatusLabel } from "../../../lib/patients"
import { QueryErrorState } from "../../../lib/query-error"
import { FollowUpScheduler } from "../follow-up-scheduler"
import { openAppointmentAnywhere } from "../../agenda/schedule-host"

/** Una cita cancelada o con inasistencia deja el control otra vez por reservar. */
export function hasLiveAppointment(control: SchedulableControl): boolean {
  return control.appointment?.status === "programada" || control.appointment?.status === "confirmada"
}

export function useTreatmentCoordination(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["treatment-coordination", patientId],
    queryFn: () => fetchTreatmentCoordination(patientId),
    enabled,
    retry: false,
  })
}

export function CoordinationTreatments({ patientId }: { patientId: string }): React.JSX.Element {
  const canRead = usePermission("appointments.read")
  const query = useTreatmentCoordination(patientId, canRead)
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando tratamientos…">
        <CoordinationRowsSkeleton />
      </SkeletonRegion>
    )
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const { treatments } = query.data.data
  if (treatments.length === 0)
    return <p className="text-sm text-muted-foreground">Sin tratamientos abiertos.</p>
  return (
    <ul className="flex flex-col divide-y rounded-xl border">
      {treatments.map((treatment) => (
        <li key={treatment.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <span className="min-w-0 font-medium">{treatment.title}</span>
          <span className="flex flex-wrap gap-2">
            <Badge variant={treatment.decision === "aceptado" ? "success" : "outline"}>
              {planDecisionLabel(treatment.decision)}
            </Badge>
            <Badge variant="secondary">{planStatusLabel(treatment.status)}</Badge>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function CoordinationControls({
  patientId,
  scheduleFollowUpId,
}: {
  patientId: string
  /** «Reservar» desde «Qué sigue»: abre la reserva de ese control. */
  scheduleFollowUpId?: string | null
}): React.JSX.Element {
  const canRead = usePermission("appointments.read")
  const canBook = usePermission("appointments.write")
  const query = useTreatmentCoordination(patientId, canRead)
  const [scheduling, setScheduling] = useState<SchedulableControl | null>(null)
  // El pedido de «Qué sigue» se atiende una vez: cerrar la reserva no la vuelve a abrir.
  const [handled, setHandled] = useState<string | null>(null)
  const followUps = query.data?.data.followUps ?? []
  const requested =
    scheduleFollowUpId && scheduleFollowUpId !== handled
      ? (followUps.find((row) => row.id === scheduleFollowUpId) ?? null)
      : null
  const open = scheduling ?? requested
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando controles…">
        <CoordinationRowsSkeleton />
      </SkeletonRegion>
    )
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  return (
    <>
      {followUps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin controles por reservar.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {followUps.map((control) => {
            const live = hasLiveAppointment(control)
            return (
              <li key={control.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{control.title}</span>
                  <span className="text-muted-foreground">
                    {live && control.appointment
                      ? `Con cita · ${formatDateTime(control.appointment.startsAt)}`
                      : `Por reservar · desde el ${formatDate(control.dueAt)}`}
                  </span>
                </div>
                {live && control.appointment ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => control.appointment && openAppointmentAnywhere(control.appointment.id)}
                  >
                    Ver cita
                  </Button>
                ) : canBook && control.status === "pendiente" ? (
                  <Button size="sm" onClick={() => setScheduling(control)}>
                    Reservar cita
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {open ? (
        <FollowUpScheduler
          patientId={patientId}
          control={open}
          scope="coordination"
          onClose={() => {
            setScheduling(null)
            if (requested) setHandled(requested.id)
            void query.refetch()
          }}
        />
      ) : null}
    </>
  )
}
