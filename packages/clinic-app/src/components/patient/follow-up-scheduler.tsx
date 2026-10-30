import { Button } from "@odentia/ui"
import {
  FormDrawer,
  LoadingState,
  scheduleToneAt,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
  useScheduleNow,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import {
  type AgendaAppointment,
  type AgendaResources,
  invalidateAppointmentQueries,
} from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import {
  formatDateTime,
  type SchedulableControl,
  type ScheduleFollowUpBody,
  scheduleFollowUpApi,
  scheduleFollowUpFromCoordinationApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import type { ServiceCatalogItem } from "../../lib/services"
import { rangeSaid, shortName, whenSaid } from "../agenda/shared"
import { EMPTY_WHEN, useWhen, WHEN_FIELD_MAP, WhenFields } from "../agenda/when"
import { ServiceSelect } from "../service-select"

/** Hasta cuándo se miran las citas en pie del paciente para ofrecer «Usar esa cita». */
const STANDING_DAYS = 90

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
        <LoadingState message="Cargando la agenda…" />
      )}
    </FormDrawer>
  )
}

/**
 * Programar un control es asignarle una cita: el mismo «cuándo» de Nueva cita.
 * Si la persona ya tiene una cita en pie, se ofrece usarla en vez de reservar otra.
 */
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
  const client = useQueryClient()
  const timeZone = resources.timeZone
  const now = useScheduleNow()
  const today = zonedDateOf(now, timeZone)
  // El servicio elegido, para la duración del bloque; el dato del formulario es su id.
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  // «Usar esa cita» es un botón por cita, no el formulario: su rechazo va junto a esa cita.
  const [useError, setUseError] = useState<{ appointmentId: string; message: string } | null>(null)
  const toneOf = useMemo(() => {
    const index = new Map(resources.professionals.map((item, at) => [item.id, at]))
    return (id: string) => scheduleToneAt(index.get(id) ?? 0)
  }, [resources])
  const when = useWhen({
    branchId: resources.branchId,
    timeZone,
    today,
    now,
    toneOf,
    duration: service?.durationMin ?? resources.defaultDurationMin,
    // Se abre en el día en que toca el control, si aún no pasó.
    date: zonedDateOf(control.dueAt, timeZone),
    // Con servicio, la agenda ofrece solo a quien lo atiende (ADR 0039).
    serviceId: service?.id || undefined,
  })
  // Si ya tiene citas en pie, se ofrece usar una en vez de reservar otra.
  const [range] = useState(() => ({
    from: new Date().toISOString(),
    to: new Date(Date.now() + STANDING_DAYS * 86_400_000).toISOString(),
  }))
  const standing = useQuery({
    queryKey: ["follow-up-appointments", patientId, resources.branchId, range.from],
    queryFn: () => {
      const params = new URLSearchParams({
        branchId: resources.branchId,
        from: range.from,
        to: range.to,
        status: "programada,confirmada",
        patientId,
      })
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const existing = (standing.data?.data ?? [])
    .filter((item) => item.patientId === patientId)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 3)

  const schedule = useMutation({
    mutationFn: async (body: ScheduleFollowUpBody) => {
      if (
        control.patientId !== patientId ||
        control.status !== "pendiente" ||
        control.appointment?.status === "atendida"
      ) {
        throw new Error("El control cambió. Revisa su situación actual antes de programarlo.")
      }
      return scope === "coordination"
        ? scheduleFollowUpFromCoordinationApi(patientId, control.id, body)
        : scheduleFollowUpApi(patientId, control.id, body)
    },
    onSuccess: async () => {
      await invalidateAppointmentQueries(client)
      onClose()
    },
    onError: () => {
      // Si alguien tomó el hueco, lo libre se vuelve a pedir.
      when.refetch()
      void client.invalidateQueries({ queryKey: ["follow-up-appointments", patientId] })
    },
  })
  const form = useAppForm({
    // El «cuándo» lo valida `WhenFields` con lo que ve en las horas.
    defaultValues: { serviceId: "", when: EMPTY_WHEN },
    onSubmit: async () => {
      const target = when.shown
      if (!target) return
      setUseError(null)
      // Sin unidad dental: la asigna la agenda, como en Nueva cita.
      await schedule.mutateAsync({
        appointment: {
          branchId: resources.branchId,
          professionalUserId: target.columnId,
          serviceId: service?.id || undefined,
          startsAt: target.start,
          endsAt: target.end,
        },
      })
    },
  })
  const surface = useFormSurface(form, {
    // La cita va dentro de `appointment` en el cuerpo: cada rechazo de la agenda, a su sitio del «cuándo».
    fieldMap: (key) => {
      const own = key.replace(/^appointment\./, "")
      return own === "serviceId" ? "serviceId" : WHEN_FIELD_MAP[own]
    },
  })
  const target = when.shown
  return (
    <FormDrawer
      {...surface}
      open
      title="Programar control"
      description={`${control.title} · ${resources.branchName}`}
      isSubmitting={schedule.isPending}
      isDirty
      submitLabel={target ? `Reservar ${whenSaid(target.start, timeZone, today)}` : "Reservar cita"}
      onClose={() => {
        if (!schedule.isPending) onClose()
      }}
    >
      <div className="grid min-w-0 gap-4">
        {control.legacyScheduledAt && !control.appointment && (
          <p role="status" className="text-sm">
            Este control tenía una fecha anotada a mano, {formatDateTime(control.legacyScheduledAt)},
            sin cita en la agenda. Asígnale una cita para que quede programado.
          </p>
        )}
        {existing.map((item) => (
          <div
            key={item.id}
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-2xl border bg-muted/40 p-3"
          >
            <span className="min-w-0 flex-1 text-sm">
              <span className="text-muted-foreground">Ya tiene una cita</span>
              <br />
              <span className="font-bold">
                {rangeSaid(item.startsAt, item.endsAt, timeZone, today)}
              </span>{" "}
              <span className="text-muted-foreground">con {shortName(item.professionalName)}</span>
            </span>
            <SubmitButton
              variant="outline"
              size="sm"
              className="bg-card"
              disabled={schedule.isPending}
              pending={
                schedule.isPending &&
                schedule.variables !== undefined &&
                "appointmentId" in schedule.variables &&
                schedule.variables.appointmentId === item.id
              }
              onClick={() => {
                setUseError(null)
                schedule.mutate(
                  { appointmentId: item.id },
                  {
                    onError: (cause) =>
                      setUseError({ appointmentId: item.id, message: submitErrorMessage(cause) }),
                  },
                )
              }}
            >
              Usar esa cita
            </SubmitButton>
            {useError?.appointmentId === item.id ? (
              <p role="alert" className="w-full text-sm text-destructive">
                {useError.message}
              </p>
            ) : null}
          </div>
        ))}
        <form.AppField name="serviceId">
          {(field) => (
            <field.Control id="control-servicio" label="Servicio (opcional)">
              {(fieldControl) => (
                <ServiceSelect
                  id={fieldControl.id}
                  invalid={fieldControl.invalid}
                  aria-describedby={fieldControl.describedBy}
                  onBlur={fieldControl.onBlur}
                  placeholder="Buscar servicio (opcional)…"
                  value={field.state.value}
                  onChange={(next) => {
                    setService(next)
                    field.handleChange(next?.id ?? "")
                    // Con servicio, el bloque toma lo que dura el servicio.
                    when.resize(next?.durationMin ?? resources.defaultDurationMin)
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <WhenFields form={form} fields="when" when={when} />
        <p className="text-xs text-muted-foreground">
          Reservar no cierra el control: se cierra cuando se atiende a la persona.
        </p>
      </div>
    </FormDrawer>
  )
}
