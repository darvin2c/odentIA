/**
 * «Qué sigue» del Resumen: todo lo que le toca a la persona en una sola lista
 * (QA del 8 nov, propuesta 5). Antes eran tres tarjetas que no se veían entre
 * sí («Qué sigue», «Próxima cita» y «Próximo control»), con dos «Reservar
 * cita» y un control sin motivo.
 *
 * - Arriba, su próxima cita como contexto (no es una tarea): las filas la nombran.
 * - Debajo, lo que sigue, en el orden y con las palabras del servidor
 *   (`/next-steps`, la regla de «Qué sigue»; el control vencido va primero).
 *   Cada fila con su botón, que actúa ahí mismo; el primero, destacado.
 *
 * La pantalla no deduce nada: cada rol recibe lo suyo (caja, sin agenda ni
 * control) y el botón solo si puede hacerlo.
 */
import { Button, cn } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
import { visitName } from "../../lib/agenda"
import type { AgendaAppointment } from "../../lib/agenda"
import { fetchPlanNextSteps } from "../../lib/budgets"
import { appointmentLine, isInClinic } from "../../lib/patient-appointments"
import { QueryErrorState } from "../../lib/query-error"
import { openAppointmentAnywhere } from "../agenda/schedule-host"
import { LastVisitLinesSkeleton } from "../skeletons/person-sections"
import { NextStepButton } from "./plan/next-step-action"

/** Lo que sigue, en una lista: comparte caché con «Qué sigue» del Plan (se invalida con él). */
export function usePlanNextSteps(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ["plan-next", patientId, "lista"],
    queryFn: () => fetchPlanNextSteps(patientId),
    enabled,
    retry: false,
  })
}

/** La próxima cita, como la lee la ficha; `null` si quien mira no ve la agenda. */
export interface UpcomingState {
  appointment: AgendaAppointment | null
  loading: boolean
  failed: boolean
  onRetry: () => void
  /** El reloj de la Agenda: «espera N min» avanza solo. */
  now: string
}

export function NextUpCard({
  patientId,
  patientName,
  upcoming,
}: {
  patientId: string
  /** Para «Nueva cita»: la persona ya puesta. */
  patientName: string
  upcoming: UpcomingState | null
}): React.JSX.Element {
  const titleId = useId()
  const query = usePlanNextSteps(patientId)
  const steps = query.data?.data ?? []
  // «Ver la cita» de la próxima cita ya está arriba: la fila que diría lo mismo no lo repite.
  const shownAction = (step: (typeof steps)[number]) =>
    step.action && !(step.action.appointmentId && step.action.appointmentId === upcoming?.appointment?.id) ? step.action : null
  // El color llama a actuar: solo si la primera fila tiene algo que hacer aquí, y ese botón va destacado.
  const actionable = Boolean(steps[0] && shownAction(steps[0]))
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border p-6",
        actionable ? "border-primary/40 bg-primary/5" : "elevated bg-card",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {/* El alto de las otras tarjetas del Resumen: su esqueleto no salta. */}
        <div className="flex min-h-8 items-center">
          <h2 id={titleId} className="font-heading text-base font-medium">
            Qué sigue
          </h2>
        </div>
        {upcoming ? <UpcomingLine {...upcoming} /> : null}
      </div>
      {query.isPending ? (
        <SkeletonRegion message="Consultando qué sigue…">
          <LastVisitLinesSkeleton />
        </SkeletonRegion>
      ) : query.isError ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada por hacer en su plan.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {steps.map((step, index) => (
            <li
              key={`${step.kind}-${step.action?.followUpId ?? step.action?.budgetId ?? step.action?.planItemIds?.join() ?? index}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              {/* El texto tiene un ancho mínimo: el botón baja de línea en vez de dejarlo en una columna. */}
              <div className="min-w-0 flex-[1_1_16rem]">
                <p className="text-sm font-medium">{step.text}</p>
                {step.detail ? <p className="text-sm text-muted-foreground">{step.detail}</p> : null}
              </div>
              {shownAction(step) ? (
                <NextStepButton
                  patient={{ id: patientId, name: patientName }}
                  step={step}
                  size="sm"
                  variant={index === 0 ? "default" : "outline"}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * «Próxima cita: lun 9 nov 10:00 · Resina · Dra. Ríos · Por confirmar» con
 * «Ver la cita»; si está en la sala, su momento («Llegó 10:02 · espera 6 min»).
 * Sin cita, «Sin cita por venir»: reservar una cualquiera está en la cabecera.
 */
function UpcomingLine({ appointment, loading, failed, onRetry, now }: UpcomingState): React.JSX.Element {
  if (loading) return <p className="text-sm text-muted-foreground">Próxima cita: consultando…</p>
  if (failed)
    return (
      <p className="text-sm text-muted-foreground">
        No se pudo consultar su próxima cita ·{" "}
        <Button type="button" variant="link" className="h-auto p-0" onClick={onRetry}>
          Reintentar
        </Button>
      </p>
    )
  if (!appointment) return <p className="text-sm text-muted-foreground">Sin cita por venir</p>
  const at = new Date(now)
  const line = appointmentLine(appointment, at)
  // Confirmada o por confirmar, salvo que ya esté aquí (la línea ya dice su momento).
  const state = isInClinic(appointment, at.getTime()) ? null : visitName(appointment.visit)
  return (
    <p className="text-sm">
      <span className="text-muted-foreground">Próxima cita: </span>
      {[line, state].filter(Boolean).join(" · ")}
      {" · "}
      <Button type="button" variant="link" className="h-auto p-0" onClick={() => openAppointmentAnywhere(appointment.id)}>
        Ver la cita
      </Button>
    </p>
  )
}
