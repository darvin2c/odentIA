/**
 * «Qué sigue» del Resumen: todo lo que le toca a la persona en una sola lista
 * (QA del 8 nov, propuesta 5). Antes eran tres tarjetas que no se veían entre
 * sí («Qué sigue», «Próxima cita» y «Próximo control»), con dos «Reservar
 * cita» y un control sin motivo.
 *
 * - Su próxima cita va en la cabecera de la ficha (mesa del 9 nov): aquí no se repite.
 * - Lo que sigue, en el orden y con las palabras del servidor
 *   (`/next-steps`, la regla de «Qué sigue»; el control vencido va primero).
 *   Cada fila con su botón, que actúa ahí mismo; el primero, destacado.
 *
 * La pantalla no deduce nada: cada rol recibe lo suyo (caja, sin agenda ni
 * control) y el botón solo si puede hacerlo.
 */
import { Button } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { useId } from "react"
import { useScheduleNow } from "@odentia/ui-patterns"
import { visitName } from "../../lib/agenda"
import type { AgendaAppointment } from "../../lib/agenda"
import { fetchPlanNextSteps } from "../../lib/budgets"
import { appointmentLine, isInClinic, nextAppointment, usePatientAppointments } from "../../lib/patient-appointments"
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

/**
 * La próxima cita, como la lee la ficha; `null` si quien mira no ve la agenda.
 * La cabecera la dice y «Qué sigue» la usa para no repetir «Ver la cita»: las
 * dos leen la misma consulta.
 */
export function usePersonUpcoming(patientId: string | null, canAppointments: boolean): UpcomingState | null {
  const appointments = usePatientAppointments(patientId ?? "none", canAppointments && Boolean(patientId))
  // El reloj de la Agenda: quien está en la sala sigue en la sala y su espera avanza.
  const now = useScheduleNow()
  if (!canAppointments) return null
  return {
    appointment: appointments.data ? nextAppointment(appointments.data.data, Date.parse(now)) : null,
    loading: Boolean(patientId) && appointments.isPending,
    failed: appointments.isError,
    onRetry: () => void appointments.refetch(),
    now,
  }
}

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
  upcomingId,
}: {
  patientId: string
  /** Para «Nueva cita»: la persona ya puesta. */
  patientName: string
  /** La próxima cita, que ya está en la cabecera con su «Ver la cita». */
  upcomingId?: string
}): React.JSX.Element | null {
  const titleId = useId()
  const query = usePlanNextSteps(patientId)
  const steps = query.data?.data ?? []
  // «Ver la cita» de la próxima cita ya está arriba: la fila que diría lo mismo no lo repite.
  const shownAction = (step: (typeof steps)[number]) =>
    step.action && (step.kind === "sin_objeto" || !(step.action.appointmentId && step.action.appointmentId === upcomingId))
      ? step.action
      : null
  // Sin color ni botón destacado: el principal es el de la cabecera, y el primero de la
  // lista puede no estar disponible (enviar sin WhatsApp ni correo; segunda mesa del 8 nov).
  return (
    <section aria-labelledby={titleId} className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-6">
      <div className="flex min-w-0 flex-col gap-1">
        {/* El alto de las otras tarjetas del Resumen: su esqueleto no salta. */}
        <div className="flex min-h-8 items-center">
          <h2 id={titleId} className="font-heading text-base font-medium">
            Qué sigue
          </h2>
        </div>
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
          {steps.map((step) => (
            <li
              key={`${step.kind}-${step.action?.followUpId ?? step.action?.budgetId ?? step.action?.planItemIds?.join() ?? step.text}`}
              className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
            >
              {/* El texto tiene un ancho mínimo: el botón baja de línea en vez de dejarlo en una columna. */}
              <div className="min-w-0 flex-[1_1_16rem]">
                <p className="text-sm font-medium">{step.text}</p>
                {step.detail ? <p className="text-sm text-muted-foreground">{step.detail}</p> : null}
                <StepNotice notice={step.notice} />
              </div>
              {shownAction(step) ? (
                <NextStepButton
                  patient={{ id: patientId, name: patientName }}
                  step={step}
                  size="sm"
                  variant="outline"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Un aviso de la fila en su propio renglón, que se distingue sin frenar (segunda mesa del 9 nov). */
export function StepNotice({ notice }: { notice?: string | null }): React.JSX.Element | null {
  if (!notice) return null
  return (
    <p className="mt-1 flex items-start gap-1.5 text-sm text-warning">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{notice}</span>
    </p>
  )
}

/**
 * «Próxima cita: lun 9 nov 10:00 · Resina · Dra. Ríos · Por confirmar» con
 * «Ver la cita»; si está en la sala, su momento («Llegó 10:02 · espera 6 min»).
 * Sin cita, «Sin cita por venir»: reservar una cualquiera está en la cabecera.
 */
export function UpcomingLine({ appointment, loading, failed, onRetry, now }: UpcomingState): React.JSX.Element {
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
  const here = isInClinic(appointment, at.getTime())
  const state = here ? null : visitName(appointment.visit)
  return (
    <p className="text-sm">
      {/* Ya en la clínica no es «la próxima»: es la de ahora. */}
      <span className="text-muted-foreground">{here ? "Su cita de hoy: " : "Próxima cita: "}</span>
      {[line, state].filter(Boolean).join(" · ")}
      {" · "}
      <Button type="button" variant="link" className="h-auto p-0" onClick={() => openAppointmentAnywhere(appointment.id)}>
        Ver la cita
      </Button>
    </p>
  )
}
