/** Piezas comunes de la agenda: huecos del servidor y formas de decir cuándo. */
import {
  addDays,
  dayMinutesIn,
  formatDayShort,
  hourLabel,
  minutesToInstant,
  type ScheduleSlotChoice,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import * as React from "react"
import type { AvailableSlot, AvailableSlotsResult } from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"

/** Duración que se busca cuando la cita no lleva servicio. */
export const DEFAULT_SLOT_MINUTES = 30
/** Días que cubre una búsqueda de huecos. */
const SEARCH_DAYS = 7

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.shape.message ?? error.message
  return error instanceof Error ? error.message : String(error)
}

/** «Dra. Ana Torres» → «Dra. Ana»: lo que cabe en una ficha. */
export function shortName(label: string): string {
  return label.split(/\s+/).slice(0, 2).join(" ")
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("es") + text.slice(1)

/** «lun 12» sin punto, para decir un día en una frase. */
export function dayShort(date: string): string {
  return formatDayShort(date).replace(".", "")
}

/** «hoy a las 11:00» o «el mar 13 a las 09:00». */
export function whenSaid(startISO: string, timeZone: string, today: string): string {
  const date = zonedDateOf(startISO, timeZone)
  const day =
    date === today ? "hoy" : date === addDays(today, 1) ? "mañana" : `el ${dayShort(date)}`
  return `${day} a las ${hourLabel(dayMinutesIn(startISO, timeZone))}`
}

/** «Hoy, de 11:30 a 12:00» o «Mar 13, de 09:00 a 09:30». */
export function rangeSaid(
  startISO: string,
  endISO: string,
  timeZone: string,
  today: string,
): string {
  const date = zonedDateOf(startISO, timeZone)
  const day = date === today ? "Hoy" : capitalize(dayShort(date))
  return `${day}, de ${hourLabel(dayMinutesIn(startISO, timeZone))} a ${hourLabel(dayMinutesIn(endISO, timeZone))}`
}

const slotId = (slot: AvailableSlot) => `${slot.startsAt}|${slot.dentistUserId}|${slot.chairId}`

export interface AgendaSlots {
  choices: ScheduleSlotChoice[]
  /** Hueco del servidor detrás de una opción elegida. */
  slotOf: (id: string | null) => AvailableSlot | null
  /** Opción que empieza en ese instante (con ese profesional, si se indica). */
  choiceAt: (startsAt: string, dentistUserId?: string | null) => ScheduleSlotChoice | null
  isLoading: boolean
  isError: boolean
  truncated: boolean
  refetch: () => void
}

/**
 * Huecos reservables desde `fromDate`. Los calcula el servidor con las mismas
 * reglas que valida la reserva; aquí solo se piden y se rotulan.
 */
export function useAgendaSlots(input: {
  branchId: string
  timeZone: string
  fromDate: string
  dentistUserId: string | null
  serviceId?: string | null
  durationMin?: number
  enabled?: boolean
}): AgendaSlots {
  const { branchId, timeZone, fromDate, dentistUserId, serviceId } = input
  const durationMin = input.durationMin ?? DEFAULT_SLOT_MINUTES
  const query = useQuery({
    queryKey: [
      "agenda-slots",
      branchId,
      fromDate,
      dentistUserId,
      serviceId ?? null,
      serviceId ? null : durationMin,
    ],
    enabled: input.enabled ?? true,
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: minutesToInstant(fromDate, 0, timeZone),
        to: minutesToInstant(addDays(fromDate, SEARCH_DAYS), 0, timeZone),
      })
      if (dentistUserId) params.set("dentistUserId", dentistUserId)
      if (serviceId) params.set("serviceId", serviceId)
      else params.set("durationMin", String(durationMin))
      return apiFetch<{ data: AvailableSlotsResult }>(`/api/agenda/slots?${params}`)
    },
    placeholderData: (previous) => previous,
  })
  const result = query.data?.data
  return React.useMemo(() => {
    // Sin sillón libre el hueco no se puede reservar: no se ofrece.
    const slots = (result?.slots ?? []).filter((slot) => slot.chairId)
    const byId = new Map(slots.map((slot) => [slotId(slot), slot]))
    const choices = slots.map((slot) => ({
      id: slotId(slot),
      start: slot.startsAt,
      end: slot.endsAt,
      resourceLabel: dentistUserId ? undefined : shortName(slot.dentistName),
    }))
    return {
      choices,
      slotOf: (id) => (id ? (byId.get(id) ?? null) : null),
      choiceAt: (startsAt, dentist) => {
        const at = Date.parse(startsAt)
        const slot = slots.find(
          (item) =>
            Date.parse(item.startsAt) === at && (!dentist || item.dentistUserId === dentist),
        )
        return slot ? (choices.find((choice) => choice.id === slotId(slot)) ?? null) : null
      },
      isLoading: query.isFetching,
      isError: query.isError,
      truncated: result?.truncated ?? false,
      refetch: () => void query.refetch(),
    }
  }, [result, dentistUserId, query.isFetching, query.isError, query.refetch])
}
