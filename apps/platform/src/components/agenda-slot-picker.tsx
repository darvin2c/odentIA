import { Button, Field, FieldLabel, Input } from "@odentia/ui"
import { dayMinutesIn, hourLabel, minutesToInstant, ResourceSelect } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useId, useState } from "react"
import type { AvailableSlot, AvailableSlotsResult } from "../lib/agenda"
import { apiFetch } from "../lib/api"

/** Disponibilidad de la agenda compartida por reservas y ofrecimientos de espera. */
export function AgendaSlotPicker({
  branchId,
  timeZone,
  day,
  professionals,
  serviceId,
  initialProfessionalId,
  disabled,
  selected,
  onSelect,
  onCriteriaChange,
  actionLabel = "Seleccionar",
}: {
  branchId: string
  timeZone: string
  day: string
  professionals: { id: string; label: string }[]
  serviceId?: string | null
  initialProfessionalId?: string | null
  disabled?: boolean
  selected?: AvailableSlot | null
  onSelect: (slot: AvailableSlot) => void
  onCriteriaChange?: () => void
  actionLabel?: string
}) {
  const uid = useId()
  const [date, setDate] = useState(day)
  const [dentistUserId, setDentistUserId] = useState(initialProfessionalId ?? "")
  const [durationMin, setDurationMin] = useState("30")
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
  const validDuration = Number(durationMin) > 0 && Number(durationMin) <= 480
  const slotsQuery = useQuery({
    queryKey: [
      "agenda-slots",
      branchId,
      date,
      dentistUserId,
      serviceId,
      serviceId ? null : durationMin,
    ],
    enabled: validDate && (Boolean(serviceId) || validDuration),
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: minutesToInstant(date, 0, timeZone),
        to: minutesToInstant(date, 1440, timeZone),
      })
      if (dentistUserId) params.set("dentistUserId", dentistUserId)
      if (serviceId) params.set("serviceId", serviceId)
      else params.set("durationMin", durationMin)
      return apiFetch<{ data: AvailableSlotsResult }>(`/api/agenda/slots?${params}`)
    },
  })
  const result = slotsQuery.data?.data
  const slots = result?.slots ?? []
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3">
      <legend className="mb-2 text-sm font-medium">Disponibilidad · {timeZone}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${uid}-date`}>Fecha de búsqueda</FieldLabel>
          <Input
            id={`${uid}-date`}
            type="date"
            required
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              onCriteriaChange?.()
            }}
          />
        </Field>
        <ResourceSelect
          id={`${uid}-professional`}
          label="Profesional"
          options={[{ id: "", label: "Todos" }, ...professionals]}
          value={dentistUserId}
          onChange={(id) => {
            setDentistUserId(id)
            onCriteriaChange?.()
          }}
        />
        {!serviceId && (
          <Field>
            <FieldLabel htmlFor={`${uid}-duration`}>Duración (minutos)</FieldLabel>
            <Input
              id={`${uid}-duration`}
              type="number"
              min={1}
              max={480}
              required
              value={durationMin}
              onChange={(event) => {
                setDurationMin(event.target.value)
                onCriteriaChange?.()
              }}
            />
          </Field>
        )}
      </div>
      {slotsQuery.isFetching && (
        <p role="status" className="text-sm text-muted-foreground">
          Buscando huecos…
        </p>
      )}
      {slotsQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo consultar la disponibilidad.{" "}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void slotsQuery.refetch()}
          >
            Reintentar
          </Button>
        </p>
      ) : (
        slotsQuery.isSuccess &&
        slots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Sin huecos ese día. Elige otra fecha o profesional; se necesita un horario configurado y
            agenda libre.
          </p>
        )
      )}
      {result?.truncated && (
        <p className="text-sm text-muted-foreground">
          Se muestran los primeros huecos; acota la búsqueda por profesional.
        </p>
      )}
      <ul className="grid max-h-72 gap-2 overflow-y-auto">
        {slots.map((slot) => {
          const isSelected =
            selected?.startsAt === slot.startsAt &&
            selected?.dentistUserId === slot.dentistUserId &&
            selected?.chairId === slot.chairId
          return (
            <li
              key={`${slot.startsAt}:${slot.dentistUserId}:${slot.chairId}`}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
            >
              <span className="font-medium">
                {hourLabel(dayMinutesIn(slot.startsAt, timeZone))} →{" "}
                {hourLabel(dayMinutesIn(slot.endsAt, timeZone))}
              </span>
              <span>
                {slot.dentistName} · {slot.chairName ?? "Sin sillón"}
              </span>
              <Button
                type="button"
                size="sm"
                variant={isSelected ? "default" : "outline"}
                aria-pressed={isSelected}
                disabled={disabled || !slot.chairId || slotsQuery.isFetching || slotsQuery.isError}
                onClick={() => onSelect(slot)}
              >
                {isSelected ? "Seleccionado" : actionLabel}
              </Button>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}
