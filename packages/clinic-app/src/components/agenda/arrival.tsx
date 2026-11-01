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
  /** Para «Reagendar» cuando la cita no se puede recuperar. */
  patient?: { id: string; name: string }
}

export interface VisitStatusInput {
  id: string
  status: "confirmada" | "no_asistio"
}

/** Lo que se dice al confirmar una cita o marcar que no vino, en la fila y en el cajón: de quién, y si el agente le avisa. */
export function announceVisitStatus(appointment: Pick<AgendaAppointment, "patientName" | "status" | "notice">): string {
  const text = appointment.status === "confirmada" ? `Cita de ${appointment.patientName} confirmada` : `Cita de ${appointment.patientName}: no vino`
  toast.success(text, appointment.notice?.queued ? { description: "El agente le avisa y le ofrece otra fecha." } : undefined)
  return text
}

/** «Confirmar cita» y «No vino» desde una fila, sin abrir la cita: en la Agenda y en Inicio, la misma. */
export function useAppointmentVisitStatus(options: { onDone?: (text: string) => void } = {}) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: VisitStatusInput) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/status`, { method: "POST", body: JSON.stringify({ status: input.status }) }),
    onSuccess: async (result) => {
      options.onDone?.(announceVisitStatus(result.data))
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
  onRebook?: (patient: { id: string; name: string }) => void
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
        body: JSON.stringify({ arrived: input.arrived }),
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
