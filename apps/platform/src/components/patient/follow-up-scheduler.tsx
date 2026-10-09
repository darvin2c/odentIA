import { Button, Field, FieldLabel, Input } from "@odentia/ui"
import {
  FormDrawer,
  minutesToInstant,
  SCHEDULE_STATUS_LABELS,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useId, useState } from "react"
import {
  type AgendaAppointment,
  type AgendaResources,
  type AgendaServiceOption,
  type AvailableSlot,
  invalidateAppointmentQueries,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import {
  formatDateTime,
  mutationMessage,
  type SchedulableControl,
  type ScheduleFollowUpBody,
  scheduleFollowUpApi,
  scheduleFollowUpFromCoordinationApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { AgendaSlotPicker } from "../agenda-slot-picker"
import { ChoiceSelect } from "../ui/choice-select"

/** Quién reserva: el clínico desde la ficha clínica o quien agenda desde la coordinación. */
export type FollowUpSchedulerScope = "clinical" | "coordination"

export function FollowUpScheduler({
  patientId,
  control,
  onClose,
  scope = "clinical",
}: {
  patientId: string
  control: SchedulableControl
  onClose: () => void
  scope?: FollowUpSchedulerScope
}) {
  const canWriteClinical = usePermission("clinical.write")
  const canWriteAppointments = usePermission("appointments.write")
  const canSchedule =
    canWriteAppointments && (scope === "coordination" || canWriteClinical)
  const resources = useQuery({
    queryKey: ["agenda-resources"],
    queryFn: () => apiFetch<{ data: AgendaResources }>("/api/agenda/resources"),
    enabled: canSchedule,
  })
  if (canSchedule && resources.data)
    return (
      <ScheduleForm
        patientId={patientId}
        control={control}
        resources={resources.data.data}
        onClose={onClose}
        scope={scope}
      />
    )
  return (
    <FormDrawer
      open
      title="Programar control"
      description={control.title}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        onClose()
      }}
      submitLabel="Cerrar"
    >
      {!canSchedule ? (
        <p role="alert">
          {scope === "coordination"
            ? "Necesitas permiso de agenda para programar este control."
            : "Necesitas permisos de escritura clínica y de agenda para programar este control."}
        </p>
      ) : resources.isError ? (
        <p role="alert">
          No se pudieron cargar los recursos de agenda.{" "}
          <Button type="button" variant="outline" onClick={() => void resources.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : (
        <p role="status">Cargando recursos de agenda…</p>
      )}
    </FormDrawer>
  )
}

function ScheduleForm({
  patientId,
  control,
  resources,
  onClose,
  scope,
}: {
  patientId: string
  control: SchedulableControl
  resources: AgendaResources
  onClose: () => void
  scope: FollowUpSchedulerScope
}) {
  const uid = useId()
  const client = useQueryClient()
  const [mode, setMode] = useState<"reserve" | "link">("reserve")
  const [serviceId, setServiceId] = useState("")
  const [slot, setSlot] = useState<AvailableSlot | null>(null)
  const [appointmentId, setAppointmentId] = useState("")
  const [date, setDate] = useState(() => {
    const today = zonedDateOf(new Date().toISOString(), resources.timeZone)
    const due = zonedDateOf(control.dueAt, resources.timeZone)
    return due > today ? due : today
  })
  const [error, setError] = useState<string | null>(null)
  const services = useQuery({
    queryKey: ["services", "agenda-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const appointments = useQuery({
    queryKey: ["follow-up-appointments", patientId, resources.branchId, date],
    enabled: mode === "link" && /^\d{4}-\d{2}-\d{2}$/.test(date),
    queryFn: async () => {
      const params = new URLSearchParams({
        branchId: resources.branchId,
        from: minutesToInstant(date, 0, resources.timeZone),
        to: minutesToInstant(date, 1440, resources.timeZone),
      })
      const response = await apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
      return response.data.filter(
        (item) =>
          item.patientId === patientId &&
          (item.status === "programada" || item.status === "confirmada"),
      )
    },
  })
  const schedule = useMutation({
    mutationFn: async () => {
      if (
        control.patientId !== patientId ||
        control.status !== "pendiente" ||
        control.appointment?.status === "atendida"
      ) {
        throw new Error("El control cambió. Revisa su situación actual antes de programarlo.")
      }
      let body: ScheduleFollowUpBody
      if (mode === "link") {
        if (
          !appointmentId ||
          appointments.isFetching ||
          appointments.isError ||
          !appointments.data?.some((item) => item.id === appointmentId)
        )
          throw new Error("Selecciona una cita vigente de este paciente.")
        body = { appointmentId }
      } else {
        if (!slot?.chairId)
          throw new Error("Selecciona un hueco disponible con profesional y sillón.")
        body = {
          appointment: {
            branchId: resources.branchId,
            dentistUserId: slot.dentistUserId,
            chairId: slot.chairId,
            serviceId: serviceId || undefined,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          },
        }
      }
      return scope === "coordination"
        ? scheduleFollowUpFromCoordinationApi(patientId, control.id, body)
        : scheduleFollowUpApi(patientId, control.id, body)
    },
    onSuccess: async () => {
      await invalidateAppointmentQueries(client)
      onClose()
    },
    onError: (cause) => {
      setError(mutationMessage(cause))
      void client.invalidateQueries({ queryKey: ["agenda-slots"] })
      void client.invalidateQueries({ queryKey: ["follow-up-appointments", patientId] })
    },
  })
  return (
    <FormDrawer
      open
      title="Programar control"
      description={`${control.title} · ${resources.branchName}`}
      error={error}
      isSubmitting={schedule.isPending}
      isDirty
      submitLabel={mode === "reserve" ? "Reservar y vincular control" : "Vincular cita al control"}
      onClose={() => {
        if (!schedule.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        schedule.mutate()
      }}
    >
      <fieldset disabled={schedule.isPending} className="grid min-w-0 gap-4">
        <p className="text-sm text-muted-foreground">
          La reserva no completa el control. Su cierre requiere una atención finalizada y un
          resultado clínico.
        </p>
        {control.legacyScheduledAt && !control.appointment && (
          <p role="status" className="text-sm">
            Sin reserva verificada. Fecha histórica: {formatDateTime(control.legacyScheduledAt)}.
            Concilia el control reservando o vinculando una cita explícitamente.
          </p>
        )}
        <Field>
          <FieldLabel htmlFor={`${uid}-mode`}>Cómo programar</FieldLabel>
          <ChoiceSelect
            id={`${uid}-mode`}
            className="w-full"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as "reserve" | "link")
              setError(null)
            }}
          >
            <option value="reserve">Reservar una nueva cita</option>
            <option value="link">Vincular una cita existente del paciente</option>
          </ChoiceSelect>
        </Field>
        <div hidden={mode !== "reserve"}>
          <fieldset disabled={mode !== "reserve"} className="grid min-w-0 gap-4">
            <Field>
              <FieldLabel htmlFor={`${uid}-service`}>Servicio (opcional)</FieldLabel>
              <ChoiceSelect
                id={`${uid}-service`}
                className="w-full"
                value={serviceId}
                onChange={(event) => {
                  setServiceId(event.target.value)
                  setSlot(null)
                }}
              >
                <option value="">Sin servicio · elegir duración</option>
                {(services.data?.data ?? []).map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </ChoiceSelect>
              {services.isError && (
                <p role="alert" className="text-sm">
                  No se pudo cargar el catálogo. Puedes reservar sin servicio o{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void services.refetch()}
                  >
                    reintentar
                  </button>
                  .
                </p>
              )}
            </Field>
            <AgendaSlotPicker
              branchId={resources.branchId}
              timeZone={resources.timeZone}
              day={date}
              professionals={resources.professionals}
              serviceId={serviceId}
              selected={slot}
              onSelect={setSlot}
              onCriteriaChange={() => setSlot(null)}
              disabled={schedule.isPending}
            />
            {slot && (
              <p role="status" className="text-sm">
                Selección:{" "}
                {new Date(slot.startsAt).toLocaleString("es-PE", { timeZone: resources.timeZone })}{" "}
                · {slot.dentistName} · {slot.chairName}. La disponibilidad se confirma al reservar.
              </p>
            )}
          </fieldset>
        </div>
        {mode === "link" && (
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor={`${uid}-date`}>
                Fecha de la cita · {resources.timeZone}
              </FieldLabel>
              <Input
                id={`${uid}-date`}
                type="date"
                required
                value={date}
                onChange={(event) => {
                  setDate(event.target.value)
                  setAppointmentId("")
                }}
              />
            </Field>
            {appointments.isFetching ? (
              <p role="status">Buscando citas del paciente…</p>
            ) : appointments.isError ? (
              <p role="alert">
                No se pudieron cargar las citas.{" "}
                <Button type="button" variant="outline" onClick={() => void appointments.refetch()}>
                  Reintentar
                </Button>
              </p>
            ) : (
              <Field>
                <FieldLabel htmlFor={`${uid}-appointment`}>Cita del paciente</FieldLabel>
                <ChoiceSelect
                  id={`${uid}-appointment`}
                  className="w-full"
                  value={appointmentId}
                  onChange={(event) => setAppointmentId(event.target.value)}
                  required
                >
                  <option value="">Seleccionar cita explícitamente</option>
                  {(appointments.data ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {new Date(item.startsAt).toLocaleTimeString("es-PE", {
                        timeZone: resources.timeZone,
                      })}{" "}
                      · {item.dentistName} · {item.chairName} ·{" "}
                      {SCHEDULE_STATUS_LABELS[item.status]}
                    </option>
                  ))}
                </ChoiceSelect>
                {appointments.data?.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    Sin citas programadas o confirmadas del paciente en esta sede y fecha. Elige
                    otro día o reserva una nueva cita.
                  </p>
                )}
              </Field>
            )}
          </div>
        )}
      </fieldset>
    </FormDrawer>
  )
}
