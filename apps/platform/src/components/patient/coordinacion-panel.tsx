import { Badge, Button, buttonVariants } from "@odentia/ui"
import { EmptyState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ClipboardCheck } from "lucide-react"
import { useState } from "react"
import {
  fetchTreatmentCoordination,
  formatDate,
  formatDateTime,
  type SchedulableControl,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { planDecisionLabel } from "../../lib/budgets"
import { planStatusLabel } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { FollowUpScheduler } from "./follow-up-scheduler"

/** Una cita cancelada o con inasistencia deja el control otra vez por reservar. */
function hasLiveAppointment(control: SchedulableControl): boolean {
  return (
    control.appointment?.status === "programada" || control.appointment?.status === "confirmada"
  )
}

export function useTreatmentCoordination(patientId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["treatment-coordination", patientId],
    queryFn: () => fetchTreatmentCoordination(patientId),
    enabled,
    retry: false,
  })
}

/**
 * Coordinación del tratamiento para quien agenda: qué control falta reservar,
 * qué presupuesto espera respuesta y qué sigue abierto. Sin odontograma,
 * diagnósticos, piezas ni importes.
 */
export function CoordinacionPanel({ patientId }: { patientId: string }) {
  const canRead = usePermission("appointments.read")
  const canBook = usePermission("appointments.write")
  const query = useTreatmentCoordination(patientId, canRead)
  const [scheduling, setScheduling] = useState<SchedulableControl | null>(null)

  if (query.isPending) return <LoadingState message="Cargando coordinación…" />
  if (query.isError)
    return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />

  const { followUps, budgetsAwaitingDecision, treatments } = query.data.data
  if (followUps.length + budgetsAwaitingDecision.length + treatments.length === 0)
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="Nada por coordinar"
        description="Este paciente no tiene controles por reservar, presupuestos por decidir ni tratamientos abiertos."
      />
    )

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Vista de coordinación: estados y fechas para agendar y hacer seguimiento. El detalle clínico
        y los importes los ven el equipo clínico y caja.
      </p>

      <section className="elevated rounded-xl border bg-card p-6" aria-labelledby="coord-controles">
        <h2 id="coord-controles" className="font-heading text-base font-medium">
          Controles
        </h2>
        {followUps.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin controles abiertos.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {followUps.map((control) => {
              const live = hasLiveAppointment(control)
              return (
                <li
                  key={control.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{control.title}</span>
                    <span className="text-muted-foreground">
                      {live && control.appointment
                        ? `Cita ${formatDateTime(control.appointment.startsAt)}`
                        : `Corresponde el ${formatDate(control.dueAt)}`}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={live ? "success" : "warning"}>
                      {live ? "Con cita" : "Por reservar"}
                    </Badge>
                    {live && control.appointment ? (
                      <Link
                        to="/agenda"
                        search={{ appointmentId: control.appointment.id }}
                        className={buttonVariants({ size: "sm", variant: "outline" })}
                      >
                        Ver en agenda
                      </Link>
                    ) : canBook && control.status === "pendiente" ? (
                      <Button size="sm" onClick={() => setScheduling(control)}>
                        Reservar control
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section
        className="elevated rounded-xl border bg-card p-6"
        aria-labelledby="coord-presupuestos"
      >
        <h2 id="coord-presupuestos" className="font-heading text-base font-medium">
          Presupuestos sin decisión
        </h2>
        {budgetsAwaitingDecision.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Ninguno espera respuesta.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {budgetsAwaitingDecision.map((budget) => (
              <li
                key={budget.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{budget.title}</span>
                  <span className="text-muted-foreground">
                    {budget.presentedAt
                      ? `Presentado el ${formatDate(budget.presentedAt)}`
                      : "Presentado"}
                  </span>
                </div>
                <Badge variant="warning">Espera respuesta</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="elevated rounded-xl border bg-card p-6"
        aria-labelledby="coord-tratamientos"
      >
        <h2 id="coord-tratamientos" className="font-heading text-base font-medium">
          Tratamientos abiertos
        </h2>
        {treatments.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Sin tratamientos abiertos.</p>
        ) : (
          <ul className="mt-2 flex flex-col divide-y">
            {treatments.map((treatment) => (
              <li
                key={treatment.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
              >
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
        )}
      </section>

      {scheduling ? (
        <FollowUpScheduler
          patientId={patientId}
          control={scheduling}
          scope="coordination"
          onClose={() => {
            setScheduling(null)
            void query.refetch()
          }}
        />
      ) : null}
    </div>
  )
}
