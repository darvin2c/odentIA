/**
 * «Llegó» y «Deshacer» (ADR 0032): la misma operación desde la Agenda, el
 * cajón de la cita e Inicio. El aviso flotante dice quién llegó y ofrece
 * deshacerlo; si la cita era «No vino» y su hora ya está ocupada, lo dice con
 * las palabras del servidor y ofrece «Reagendar».
 */
import { toast } from "@odentia/ui"
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

export function useAppointmentArrival(options: {
  /** Reagendar a la persona cuando su hora ya está ocupada; sin esto el aviso solo lo dice. */
  onRebook?: (patient: { id: string; name: string }) => void
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
        toast.success(`Llegó ${result.data.patientName}`, {
          action: { label: "Deshacer", onClick: () => mutation.mutate({ id: input.id, arrived: false }) },
        })
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
