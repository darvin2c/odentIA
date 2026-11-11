/**
 * «Llegó» y «Deshacer» (ADR 0032): la misma operación desde la Agenda, el
 * cajón de la cita e Inicio. El aviso flotante dice quién llegó y ofrece
 * deshacerlo; si la cita era «No vino» y su hora ya está ocupada, lo dice con
 * las palabras del servidor y ofrece «Reagendar».
 */
import { toast } from "@odentia/ui"
import { isUnconfirmedSubmit } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type AgendaAppointment, invalidateAppointmentQueries } from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"
import { errorMessage } from "./shared"

export interface ArrivalInput {
  id: string
  arrived: boolean
  /** La versión de la cita que la pantalla mostraba: si otra persona la cambió antes, el servidor lo dice y no la toca. */
  version?: number
  /** Para «Reagendar» cuando la cita no se puede recuperar. */
  patient?: { id: string; name: string }
}

export interface VisitStatusInput {
  id: string
  /** «atendida» es «Vino»: la cita pasada queda atendida sin abrir otra atención (decisión B1). */
  status: "confirmada" | "no_asistio" | "atendida"
  /** La versión que vio la pantalla: si otra persona la cambió, el servidor no la pisa. */
  expectedVersion?: number
}

/** «Deshacer» de «Vino»: la cita vuelve a «Sin cerrar» mientras nadie registró su atención. */
export function undoCame(id: string): Promise<{ data: AgendaAppointment }> {
  return apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${id}/came`, {
    method: "POST",
    body: JSON.stringify({ undo: true }),
  })
}

/**
 * Lo que se dice al confirmar una cita, marcar que no vino o que vino, en la
 * fila y en el cajón: de quién, si el agente le avisa y, en «Vino», «Deshacer».
 */
export function announceVisitStatus(
  appointment: Pick<AgendaAppointment, "id" | "patientName" | "status" | "notice">,
  options: { onUndone?: () => void } = {},
): string {
  const text =
    appointment.status === "confirmada"
      ? `Cita de ${appointment.patientName} confirmada`
      : appointment.status === "atendida"
        ? `Cita de ${appointment.patientName}: vino, queda atendida`
        : `Cita de ${appointment.patientName}: no vino`
  toast.success(text, {
    ...(appointment.notice?.queued ? { description: "El agente le avisa y le ofrece otra fecha." } : {}),
    ...(appointment.status === "atendida"
      ? {
          // Tiempo para leerlo y deshacerlo, como los demás «Deshacer» de la app.
          duration: 10_000,
          description: "Lo que se hizo lo registra su profesional: le aparece en «Te espera».",
          action: {
            label: "Deshacer",
            onClick: () =>
              void undoCame(appointment.id)
                .then(() => {
                  toast.success(`Se deshizo «Vino» de ${appointment.patientName}`)
                  options.onUndone?.()
                })
                .catch((cause) => toast.error(errorMessage(cause))),
          },
        }
      : {}),
  })
  return text
}

/** «Confirmar cita», «No vino» y «Vino» desde una fila, sin abrir la cita: en la Agenda y en Inicio, la misma. */
export function useAppointmentVisitStatus(options: { onDone?: (text: string) => void } = {}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: VisitStatusInput) =>
      input.status === "atendida"
        ? apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/came`, {
            method: "POST",
            body: JSON.stringify(input.expectedVersion ? { expectedVersion: input.expectedVersion } : {}),
          })
        : apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/status`, {
            method: "POST",
            body: JSON.stringify({ status: input.status, expectedVersion: input.expectedVersion }),
          }),
    onSuccess: async (result) => {
      options.onDone?.(
        announceVisitStatus(result.data, { onUndone: () => void invalidateAppointmentQueries(queryClient) }),
      )
      await invalidateAppointmentQueries(queryClient)
    },
    onError: async (cause) => {
      // Sin confirmación no se sabe si se aplicó: la agenda muestra cómo quedó.
      toast.error(isUnconfirmedSubmit(cause) ? "No pudimos confirmar el cambio. La agenda muestra cómo quedó; revísala antes de repetirlo." : errorMessage(cause))
      await invalidateAppointmentQueries(queryClient)
    },
  })
}

export function useAppointmentArrival(options: {
  /** Reagendar a la persona cuando su hora ya está ocupada; sin esto el aviso solo lo dice. */
  onRebook?: (patient: { id: string; name: string }, from?: { serviceId?: string | null; professionalUserId?: string | null }) => void
  /**
   * El aviso ofrece «Deshacer»; no donde la pantalla ya lo tiene a la vista (el
   * cajón de la cita): un solo «Deshacer» por pantalla.
   */
  undoInToast?: boolean
} = {}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (input: ArrivalInput) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/arrival`, {
        method: "POST",
        body: JSON.stringify({ arrived: input.arrived, ...(input.version ? { expectedVersion: input.version } : {}) }),
      }),
    onSuccess: async (result, input) => {
      await invalidateAppointmentQueries(queryClient)
      if (input.arrived) {
        toast.success(
          `Llegó ${result.data.patientName}`,
          options.undoInToast === false
            ? undefined
            : { action: { label: "Deshacer", onClick: () => mutation.mutate({ id: input.id, arrived: false }) } },
        )
      } else {
        toast.success(`Se deshizo la llegada de ${result.data.patientName}`)
      }
    },
    onError: async (cause, input) => {
      const rebook = options.onRebook
      const patient = input.patient
      const taken = cause instanceof ApiError && cause.shape.code === "APPOINTMENT_CONFLICT"
      toast.error(errorMessage(cause), {
        action: taken && rebook && patient ? { label: "Reagendar", onClick: () => rebook(patient) } : undefined,
      })
      await invalidateAppointmentQueries(queryClient)
    },
  })
  return mutation
}
