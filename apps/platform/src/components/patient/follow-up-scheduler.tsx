import { Button } from "@odentia/ui"
import {
  FormDrawer,
  LoadingState,
  scheduleToneAt,
  SubmitButton,
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
  mutationMessage,
  type SchedulableControl,
  type ScheduleFollowUpBody,
  scheduleFollowUpApi,
  scheduleFollowUpFromCoordinationApi,
} from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import type { ServiceCatalogItem } from "../../lib/services"
import { rangeSaid, shortName, whenSaid } from "../agenda/shared"
import { useWhen, WhenFields } from "../agenda/when"
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
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  const serviceId = service?.id ?? ""
  const [error, setError] = useState<string | null>(null)
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
    serviceId: serviceId || undefined,
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
    onError: (cause) => {
      setError(mutationMessage(cause))
      // Si alguien tomó el hueco, lo libre se vuelve a pedir.
      when.refetch()
      void client.invalidateQueries({ queryKey: ["follow-up-appointments", patientId] })
    },
  })
  const target = when.shown
  return (
    <FormDrawer
      open
      title="Programar control"
      description={`${control.title} · ${resources.branchName}`}
      error={error}
      isSubmitting={schedule.isPending}
      isDirty
      submitDisabled={!target || when.state !== "free"}
      submitLabel={target ? `Reservar ${whenSaid(target.start, timeZone, today)}` : "Reservar cita"}
      onClose={() => {
        if (!schedule.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        setError(null)
        if (!target) return
        // Sin sillón: lo asigna la agenda, como en Nueva cita.
        schedule.mutate({
          appointment: {
            branchId: resources.branchId,
            dentistUserId: target.columnId,
            serviceId: serviceId || undefined,
            startsAt: target.start,
            endsAt: target.end,
          },
        })
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
              <span className="text-muted-foreground">con {shortName(item.dentistName)}</span>
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
                setError(null)
                schedule.mutate({ appointmentId: item.id })
              }}
            >
              Usar esa cita
            </SubmitButton>
          </div>
        ))}
        <ServiceSelect
          id="control-servicio"
          label="Servicio (opcional)"
          value={serviceId}
          onChange={(next) => {
            setService(next)
            // Con servicio, el bloque toma lo que dura el servicio.
            when.resize(next?.durationMin ?? resources.defaultDurationMin)
          }}
        />
        <WhenFields when={when} />
        <p className="text-xs text-muted-foreground">
          Reservar no cierra el control: se cierra cuando se atiende a la persona.
        </p>
      </div>
    </FormDrawer>
  )
}
