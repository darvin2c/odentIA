/**
 * El próximo control en el Resumen (QA del 6 nov, X3): «Qué sigue» dice una sola
 * cosa y, con un presupuesto por responder, el control no se veía en ningún
 * lado. Va en su propia fila, con su fecha y «Reservar cita»; vencido sin cita,
 * en «Pendientes». Si «Qué sigue» ya habla del control, no se repite. Lo que
 * dice sale de la coordinación (`nextControl`): las reglas son del servidor.
 */
import { Button } from "@odentia/ui"
import { zonedDateOf } from "@odentia/ui-patterns"
import { useState } from "react"
import { controlDay, controlNeedsBooking, type NextControl, nextControlPlace } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { activeOrgTimeZone } from "../../lib/locale"
import { appointmentWhen } from "../../lib/patient-appointments"
import { usePersonArchived } from "../../lib/person-archived"
import { openAppointmentAnywhere } from "../agenda/schedule-host"
import { ScheduleControl } from "./plan/next-step-action"
import { usePlanNextStep } from "./plan/plan-next"
import { useTreatmentCoordination } from "./plan/plan-coordination"
import { SummaryCard } from "./resumen-tab"

/**
 * «Toca el 18 nov» o «Tocaba el …» si su día ya pasó, y qué lo cumple: su
 * atención de hoy, su cita, o que falta reservarla. Un control reservado cuya
 * cita ya no está en pie dice «sin cita reservada» (revisión del 7 nov).
 */
export function nextControlDetail(control: NextControl, now: Date = new Date()): string {
  const timeZone = activeOrgTimeZone()
  const past = control.overdue || zonedDateOf(control.dueAt, timeZone) < zonedDateOf(now.toISOString(), timeZone)
  const due = `${past ? "Tocaba el" : "Toca el"} ${controlDay(control.dueAt, now)}`
  if (control.today) return `${due} · se cumple con su atención de hoy`
  if (control.appointment) return `${due} · cita el ${appointmentWhen(control.appointment)}`
  if (control.status === "programado") return `${due} · sin cita reservada`
  return control.overdue ? `${due} · sin cita por venir` : `${due} · falta reservar la cita`
}

/** El próximo control y dónde va en el Resumen; nada mientras «Qué sigue» o el control cargan. */
export function useNextControl(patientId: string, enabled = true): {
  control: NextControl | null
  place: ReturnType<typeof nextControlPlace>
  /** Todavía se pregunta: «Pendientes» no dice que no hay nada. */
  loading: boolean
} {
  const canRead = usePermission("appointments.read") && enabled
  const coordination = useTreatmentCoordination(patientId, canRead)
  const nextStep = usePlanNextStep(patientId, canRead)
  const loading = coordination.isLoading || nextStep.isLoading
  if (!canRead || loading || !coordination.data || nextStep.isPending) return { control: null, place: null, loading }
  const control = coordination.data.data.nextControl ?? null
  return { control, place: nextControlPlace(control, nextStep.data?.data.kind ?? null), loading }
}

/** El botón del control: «Ver la cita» si tiene una que lo cumple; si no, «Reservar cita». */
export function NextControlAction({
  patientId,
  control,
}: {
  patientId: string
  control: NextControl
}): React.JSX.Element | null {
  const canBook = usePermission("appointments.write")
  const archived = usePersonArchived()
  const [scheduling, setScheduling] = useState(false)
  if (control.appointment) {
    const id = control.appointment.id
    return (
      <Button type="button" size="sm" variant="outline" onClick={() => openAppointmentAnywhere(id)}>
        Ver la cita
      </Button>
    )
  }
  if (!canBook || archived || !controlNeedsBooking(control)) return null
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setScheduling(true)}>
        Reservar cita
      </Button>
      {scheduling ? (
        <ScheduleControl patientId={patientId} followUpId={control.id} onClose={() => setScheduling(false)} />
      ) : null}
    </>
  )
}

/** La fila «Próximo control» del Resumen; nada si va en «Pendientes» o ya lo dice «Qué sigue». */
export function NextControlCard({ patientId }: { patientId: string }): React.JSX.Element | null {
  const { control, place } = useNextControl(patientId)
  if (!control || place !== "fila") return null
  return (
    <SummaryCard title="Próximo control" action={<NextControlAction patientId={patientId} control={control} />}>
      <div className="flex flex-col gap-1 text-sm">
        <p className="line-clamp-2 font-medium">{control.title}</p>
        <p className="text-muted-foreground">{nextControlDetail(control)}</p>
      </div>
    </SummaryCard>
  )
}
