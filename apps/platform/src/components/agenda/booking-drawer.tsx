import { Button, FieldLabel, Input, toast } from "@odentia/ui"
import {
  FormDrawer,
  ResourceSelect,
  type ResourceSelectOption,
  type ScheduleColumn,
  type SchedulePreview,
  ScheduleResourceChips,
  ScheduleSlotChoices,
} from "@odentia/ui-patterns"
import { useMutation, useQuery } from "@tanstack/react-query"
import * as React from "react"
import type { AgendaAppointment, AgendaServiceOption } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { errorMessage, shortName, useAgendaSlots, whenSaid } from "./shared"

/** Con qué se abre «Nueva cita»: nada, un hueco tocado en la rejilla o un paciente. */
export interface BookingSeed {
  patient?: { id: string; name: string }
  /** El paciente viene de un caso: no se cambia aquí. */
  lockedPatient?: boolean
  conversationId?: string
  dentistUserId?: string | null
  /** Instante del hueco ya elegido. */
  startsAt?: string
  /** Día desde el que se buscan huecos. */
  date?: string
}

/**
 * Nueva cita: a quién y cuándo. El «cuándo» son huecos reales que devuelve el
 * servidor; no se escribe fecha ni hora y el sillón sale del propio hueco.
 */
export function BookingDrawer({
  seed,
  branchId,
  timeZone,
  today,
  team,
  onPreview,
  onClose,
  onSaved,
}: {
  seed: BookingSeed
  branchId: string
  timeZone: string
  today: string
  /** Profesionales que atienden en la sede. */
  team: ScheduleColumn[]
  /** La rejilla deja ver el hueco elegido antes de reservar. */
  onPreview: (preview: SchedulePreview | null) => void
  onClose: () => void
  onSaved: (appointment: AgendaAppointment) => Promise<void>
}) {
  const [patientId, setPatientId] = React.useState(seed.patient?.id ?? "")
  const [patientQuery, setPatientQuery] = React.useState("")
  const [serviceId, setServiceId] = React.useState("")
  const [dentistUserId, setDentistUserId] = React.useState<string | null>(
    seed.dentistUserId ?? null,
  )
  const [fromDate, setFromDate] = React.useState(
    seed.date && seed.date > today ? seed.date : today,
  )
  const [chosen, setChosen] = React.useState<string | null>(null)
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState("")

  const patientsQuery = useQuery({
    queryKey: ["patients", "agenda-picker", patientQuery],
    enabled: !seed.lockedPatient,
    queryFn: () =>
      apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients?q=${encodeURIComponent(patientQuery)}&limit=20`,
      ),
    placeholderData: (previous) => previous,
  })
  const servicesQuery = useQuery({
    queryKey: ["services", "agenda-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const patientOptions = React.useMemo((): ResourceSelectOption[] => {
    const options = (patientsQuery.data?.data ?? []).map((patient) => ({
      id: patient.id,
      label: patient.displayName,
    }))
    // El paciente con el que se abrió se conserva aunque la búsqueda no lo devuelva.
    if (seed.patient && !options.some((option) => option.id === seed.patient?.id)) {
      options.unshift({ id: seed.patient.id, label: seed.patient.name })
    }
    return options
  }, [patientsQuery.data, seed.patient])
  const patientName = patientOptions.find((option) => option.id === patientId)?.label

  const slots = useAgendaSlots({
    branchId,
    timeZone,
    fromDate,
    dentistUserId,
    serviceId: serviceId || null,
  })
  // El hueco con el que se abrió se elige en cuanto el servidor lo confirma libre.
  const seeded = React.useRef(false)
  React.useEffect(() => {
    if (seeded.current || !seed.startsAt || slots.isLoading) return
    const match = slots.choiceAt(seed.startsAt, seed.dentistUserId)
    if (match) setChosen(match.id)
    seeded.current = true
  }, [seed.startsAt, seed.dentistUserId, slots])
  const slot = slots.slotOf(chosen)

  React.useEffect(() => {
    onPreview(
      slot
        ? {
            columnId: slot.dentistUserId,
            start: slot.startsAt,
            end: slot.endsAt,
            title: patientName ?? "Nueva cita",
          }
        : null,
    )
  }, [slot, patientName, onPreview])
  React.useEffect(() => () => onPreview(null), [onPreview])

  const save = useMutation({
    mutationFn: () => {
      if (!patientId) throw new Error("Elige un paciente.")
      if (!slot?.chairId) throw new Error("Elige un hueco.")
      return apiFetch<{ data: AgendaAppointment }>("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId,
          dentistUserId: slot.dentistUserId,
          chairId: slot.chairId,
          serviceId: serviceId || undefined,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          reason: reason.trim() || undefined,
          conversationId: seed.conversationId,
          source: seed.conversationId ? "conversacion" : "recepcion",
        }),
      })
    },
    onSuccess: async (result) => {
      toast.success(`Cita reservada ${whenSaid(result.data.startsAt, timeZone, today)}`)
      await onSaved(result.data)
    },
    onError: (cause) => {
      setError(errorMessage(cause))
      // Si alguien tomó el hueco, la lista se vuelve a pedir.
      setChosen(null)
      slots.refetch()
    },
  })

  return (
    <FormDrawer
      open
      title="Nueva cita"
      description="Elige a quién y cuándo. El sillón se asigna con el hueco."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={Boolean((patientId && !seed.lockedPatient) || reason)}
      error={error || null}
      submitDisabled={!patientId || !slot}
      submitLabel={slot ? `Reservar ${whenSaid(slot.startsAt, timeZone, today)}` : "Reservar cita"}
    >
      <div className="grid gap-4">
        {seed.lockedPatient && seed.patient ? (
          <div>
            <FieldLabel>Paciente del caso</FieldLabel>
            <p className="text-sm font-medium">{seed.patient.name}</p>
          </div>
        ) : (
          <ResourceSelect
            id="cita-paciente"
            label="Paciente"
            options={patientOptions}
            value={patientId}
            onChange={setPatientId}
            onQueryChange={setPatientQuery}
          />
        )}
        <ResourceSelect
          id="cita-servicio"
          label="Servicio (opcional)"
          options={(servicesQuery.data?.data ?? []).map((service) => ({
            id: service.id,
            label: service.name,
            detail: service.durationMin ? `${service.durationMin} min` : undefined,
          }))}
          value={serviceId}
          onChange={(next) => {
            setServiceId(next)
            setChosen(null)
          }}
        />
        <div className="grid gap-2">
          <span className="text-sm font-medium">Profesional</span>
          <ScheduleResourceChips
            wrap
            label="Profesional"
            resources={team}
            formatLabel={(item) => shortName(item.label)}
            value={dentistUserId}
            allLabel="Cualquiera"
            onChange={(next) => {
              setDentistUserId(next)
              setChosen(null)
            }}
          />
        </div>
        <ScheduleSlotChoices
          slots={slots.choices}
          timeZone={timeZone}
          today={today}
          distinctTimes={dentistUserId === null}
          loading={slots.isLoading}
          value={chosen}
          onChange={(choice) => setChosen(choice.id)}
          action={
            <Input
              type="date"
              aria-label="Buscar huecos desde"
              className="h-8 w-auto"
              min={today}
              value={fromDate}
              onChange={(event) => {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) return
                setFromDate(event.target.value)
                setChosen(null)
              }}
            />
          }
          emptyLabel={
            team.length === 0
              ? "Ningún profesional tiene horario en esta sede. Configúralo en Ajustes para poder reservar."
              : "No hay huecos en esos días. Prueba otra fecha u otro profesional."
          }
        />
        {slots.isError ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo consultar la disponibilidad.{" "}
            <Button type="button" variant="outline" size="sm" onClick={slots.refetch}>
              Reintentar
            </Button>
          </p>
        ) : null}
        <div className="grid gap-2">
          <FieldLabel htmlFor="cita-motivo">Motivo (opcional)</FieldLabel>
          <Input
            id="cita-motivo"
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
    </FormDrawer>
  )
}
