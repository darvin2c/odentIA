import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Checkbox,
  toast,
} from "@odentia/ui"
import { submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { type ComponentProps, useId, useState } from "react"
import { type AgendaAppointment, invalidateAppointmentQueries } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { PLAN_QUERY_KEYS } from "../../lib/budgets"
import { activeOrgTimeZone } from "../../lib/locale"
import { warnUnsentNotice } from "../agenda/notice-warning"
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
  const [releasing, setReleasing] = useState<FreedAppointment | null>(null)
  const act = async (appointment: FreedAppointment, how: "usada" | "liberada", notify = false) => {
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
      else await releaseAppointment(appointment.id, notify, whenSaid(appointment.startsAt, activeOrgTimeZone(), today))
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
                      onClick={() => setReleasing(appointment)}
                    >
                      Liberarla
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground">
                    Recepción la verá para liberarla o usarla.
                  </p>
                )}
              </>
            )}
          </div>
        )
      })}
      <ReleaseDialog
        // Uno por cita: «Avisarle» no queda marcado de la anterior (revisión de la entrega 12).
        key={releasing?.id ?? "ninguna"}
        open={releasing !== null}
        when={releasing ? whenSaid(releasing.startsAt, activeOrgTimeZone(), today) : ""}
        busy={busy !== null}
        onCancel={() => setReleasing(null)}
        onConfirm={(notify) => {
          const appointment = releasing
          setReleasing(null)
          if (appointment) void act(appointment, "liberada", notify)
        }}
      />
    </div>
  )
}

/**
 * Liberar la cita sin objeto la cancela por la clínica. No se le avisa salvo que el equipo lo
 * marque (mesa de la entrega 12: ningún mensaje sale sin que el equipo lo elija), y se dice.
 */
async function releaseAppointment(id: string, notify: boolean, when: string | undefined): Promise<void> {
  const result = await apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${id}/status`, {
    method: "POST",
    body: JSON.stringify({ status: "cancelada", cancelReason: "clinica", ...(notify ? {} : { notice: false }) }),
  })
  // Marcó avisarle y no le llegará: se dice aparte y queda a la vista.
  if (notify) warnUnsentNotice(result.data, { change: "cancelada", when })
}

function ReleaseDialog({
  open,
  when,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean
  when: string
  busy: boolean
  onCancel: () => void
  onConfirm: (notify: boolean) => void
}): React.JSX.Element {
  const id = useId()
  const [notify, setNotify] = useState(false)
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Liberar su cita {when}?</AlertDialogTitle>
          <AlertDialogDescription>
            Se cancela y la hora queda libre para otra persona. Si no marcas «Avisarle», no le llega
            nada: avísale tú si hace falta.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label htmlFor={id} className="flex min-h-11 items-center gap-2 text-sm">
          <Checkbox id={id} checked={notify} onCheckedChange={(next) => setNotify(next === true)} />
          Avisarle que se canceló (si la clínica tiene cómo escribirle)
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <Button type="button" disabled={busy} onClick={() => onConfirm(notify)}>
            Liberarla
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * «Usarla para la exodoncia» y «Liberarla» de la cita sin objeto, desde «Qué sigue» y la cita
 * (QA del 10 nov, M1): lo mismo que ofrece el cierre, mientras nadie elija.
 */
export function FreedAppointmentButtons({
  appointmentId,
  version,
  startsAt,
  reuse,
  size = "sm",
  onDone,
}: {
  appointmentId: string
  version: number
  startsAt?: string
  reuse?: { planItemId: string; title: string } | null
  size?: ComponentProps<typeof Button>["size"]
  onDone?: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const run = async (how: "usada" | "liberada", notify = false) => {
    setBusy(true)
    try {
      if (how === "usada" && reuse)
        await apiFetch(`/api/appointments/${appointmentId}/reuse`, {
          method: "POST",
          body: JSON.stringify({ expectedVersion: version, planItemId: reuse.planItemId }),
        })
      else await releaseAppointment(appointmentId, notify, startsAt ? whenSaid(startsAt, activeOrgTimeZone(), today) : undefined)
      toast.success(how === "usada" ? `Su cita ahora es para ${reuse?.title ?? "lo que sigue"}` : "Cita liberada")
      await invalidateAppointmentQueries(queryClient)
      await Promise.all(
        [...PLAN_QUERY_KEYS, "patient-appointments"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      )
      onDone?.()
    } catch (cause) {
      toast.error(submitErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: activeOrgTimeZone() }).format(new Date())
  return (
    <>
      {reuse ? (
        <Button type="button" size={size} disabled={busy} onClick={() => void run("usada")}>
          Usarla para {reuse.title}
        </Button>
      ) : null}
      <Button type="button" size={size} variant={reuse ? "outline" : "default"} disabled={busy} onClick={() => setReleasing(true)}>
        Liberarla
      </Button>
      <ReleaseDialog
        key={releasing ? "abierto" : "cerrado"}
        open={releasing}
        when={startsAt ? whenSaid(startsAt, activeOrgTimeZone(), today) : ""}
        busy={busy}
        onCancel={() => setReleasing(false)}
        onConfirm={(notify) => {
          setReleasing(false)
          void run("liberada", notify)
        }}
      />
    </>
  )
}
