import { Button, toast } from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { invalidateAppointmentQueries } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { activeOrgTimeZone } from "../../lib/locale"
import { whenSaid } from "../agenda/shared"

/** Una cita por venir que se reservó para lo que hoy quedó hecho (el servidor la dice al firmar). */
export interface FreedAppointment {
  id: string
  version: number
  startsAt: string
  professionalName: string | null
  wasFor: string
}

/**
 * «Su cita del lun 16 era para esta sesión» (QA del 10 nov, M1): la sesión se hizo antes y la cita
 * quedó sin objeto. Se ofrece usarla para lo que sigue (lo aceptado por reservar, con su servicio)
 * o liberarla (se cancela como cualquier cita, por la clínica). Sin elegir, queda como estaba y
 * en la Agenda ya no dice una sesión que no existe.
 */
export function FinalizedFreedAppointments({
  appointments,
  next,
  canBook,
  onChanged,
}: {
  appointments: FreedAppointment[]
  /** Lo aceptado que falta reservar, para «Usarla para…»: el primero. */
  next: { planItemId: string; title: string } | null
  canBook: boolean
  onChanged: (id: string, result: "usada" | "liberada") => void
}): React.JSX.Element | null {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<Record<string, "usada" | "liberada">>({})
  // Lo que se le puso a cada cita: después de usarla, `next` ya no lo ofrece.
  const [usedFor, setUsedFor] = useState<Record<string, string>>({})
  if (appointments.length === 0) return null
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone() }).format(
    new Date(),
  )
  const act = async (appointment: FreedAppointment, how: "usada" | "liberada") => {
    setBusy(appointment.id)
    try {
      if (how === "usada" && next)
        await apiFetch(`/api/appointments/${appointment.id}/reuse`, {
          method: "POST",
          body: JSON.stringify({
            expectedVersion: appointment.version,
            planItemId: next.planItemId,
          }),
        })
      else
        await apiFetch(`/api/appointments/${appointment.id}/status`, {
          method: "POST",
          body: JSON.stringify({ status: "cancelada", cancelReason: "clinica" }),
        })
      setDone((current) => ({ ...current, [appointment.id]: how }))
      if (how === "usada" && next) setUsedFor((current) => ({ ...current, [appointment.id]: next.title }))
      onChanged(appointment.id, how)
      void invalidateAppointmentQueries(queryClient)
    } catch (cause) {
      toast.error(submitErrorMessage(cause))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
      {appointments.map((appointment) => {
        const when = whenSaid(appointment.startsAt, activeOrgTimeZone(), today)
        const withWhom = appointment.professionalName ? ` con ${appointment.professionalName}` : ""
        const state = done[appointment.id]
        return (
          <div key={appointment.id} className="flex flex-col gap-2 text-sm">
            {state ? (
              <p role="status">
                {state === "usada"
                  ? `Su cita ${when}${withWhom} ahora es para ${usedFor[appointment.id] ?? "lo que sigue"}.`
                  : `Su cita ${when}${withWhom} quedó liberada.`}
              </p>
            ) : (
              <>
                <p>
                  Su cita {when}
                  {withWhom} era para {appointment.wasFor}, que hoy se terminó.
                </p>
                {canBook ? (
                  <div className="flex flex-wrap gap-2">
                    {next ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void act(appointment, "usada")}
                      >
                        Usarla para {next.title}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void act(appointment, "liberada")}
                    >
                      Liberarla
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    Recepción la verá para liberarla o usarla.
                  </p>
                )}
                {canBook ? (
                  <p className="text-xs text-muted-foreground">
                    Liberarla la cancela como cualquier cita que cancela la clínica; si tiene los
                    avisos prendidos, se le avisa.
                  </p>
                ) : null}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
