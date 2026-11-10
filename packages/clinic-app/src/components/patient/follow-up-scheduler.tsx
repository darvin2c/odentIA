import { Button } from "@odentia/ui"
import {
  FormDrawer,
  LoadingState,
  minutesToInstant,
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
  type AgendaAvailability,
  type AgendaResources,
  invalidateAppointmentQueries,
} from "../../lib/agenda"
import { useActiveBranch } from "../../lib/active-branch"
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
import { EMPTY_WHEN, exceptionFlags, useWhen, WHEN_FIELD_MAP, WhenFields } from "../agenda/when"
import { ServiceSelect } from "../service-select"

/** Hasta cuántos días después de su fecha se miran las citas en pie para ofrecer «Usar esa cita». */
const STANDING_DAYS = 90
const DAY_MS = 86_400_000

/** Cuántos días desde que toca el control se busca la primera hora libre que se propone. */
const PROPOSAL_DAYS = 28
const SNAP_MS = 15 * 60_000

/** Lo que se propone al abrir: el día y, si lo tiene libre, quien lo indicó. */
export interface ControlProposal {
  /** Día (AAAA-MM-DD, en la zona de la sede) de la primera hora libre. */
  date: string
  /** Quien lo indicó, si atiende en la sede y tiene hora libre en el plazo; si no, cualquiera. */
  professionalUserId: string | null
}

/**
 * El día y con quién se abre «Programar control» (QA del 10 nov, B4 y B5): la primera hora
 * libre desde que toca el control, nunca un día en que nadie atiende ni una hora que ya pasó.
 * `free` ya viene sin lo pasado y solo con quien tiene horario en la sede. Primero quien lo
 * indicó, si tiene hora en el plazo; si no tiene horario aquí o no le queda nada, cualquiera.
 * Sin nada libre en el plazo, null: se abre como antes, en el día que toca.
 */
export function proposeControlSlot(
  availability: Pick<AgendaAvailability, "free" | "professionals" | "timeZone">,
  options: { indicatedBy: string | null; durationMin: number },
): ControlProposal | null {
  const minutes = options.durationMin * 60_000
  const slots = availability.free
    .map((item) => ({
      who: item.professionalUserId,
      // Como la agenda: el bloque arranca en el siguiente cuarto de hora.
      start: Math.ceil(Date.parse(item.startsAt) / SNAP_MS) * SNAP_MS,
      end: Date.parse(item.endsAt),
    }))
    .filter((item) => item.end - item.start >= SNAP_MS)
    .sort((a, b) => a.start - b.start)
  const first = (rows: typeof slots) =>
    rows.find((item) => item.end - item.start >= minutes) ?? rows[0] ?? null
  const attends =
    options.indicatedBy !== null &&
    availability.professionals.some((item) => item.id === options.indicatedBy)
  const own = attends ? first(slots.filter((item) => item.who === options.indicatedBy)) : null
  const pick = own ?? first(slots)
  if (!pick) return null
  return {
    date: zonedDateOf(new Date(pick.start).toISOString(), availability.timeZone),
    professionalUserId: own ? options.indicatedBy : null,
  }
}

/** Quién reserva: el clínico desde la ficha clínica o quien agenda desde la coordinación. */
export type FollowUpSchedulerScope = "clinical" | "coordination"

export function FollowUpScheduler({
  patientId,
  control,
  onClose,
  scope = "clinical",
  branchId,
}: {
  patientId: string
  control: SchedulableControl
  onClose: () => void
  scope?: FollowUpSchedulerScope
  /**
   * La sede donde se reserva. Desde una cita, la de esa cita; si no, la de la
   * atención donde se indicó el control y, sin ella, la sede con la que se
   * trabaja, la misma de la Agenda (antes siempre la primera de la clínica,
   * aunque no tuviera horarios: QA del 6 nov).
   */
  branchId?: string
}) {
  const canWriteClinical = usePermission("clinical.write")
  const canWriteAppointments = usePermission("appointments.write")
  const canSchedule =
    canWriteAppointments && (scope === "coordination" || canWriteClinical)
  const active = useActiveBranch()
  const sede = branchId ?? control.branchId ?? active.branchId
  const resources = useQuery({
    queryKey: ["agenda-resources", sede ?? null],
    queryFn: () =>
      apiFetch<{ data: AgendaResources }>(`/api/agenda/resources${sede ? `?branchId=${encodeURIComponent(sede)}` : ""}`),
    enabled: canSchedule,
  })
  // La primera hora libre desde que toca el control, antes de abrir el «cuándo» (QA del 10 nov,
  // B4 y B5): sin esto se abría en el día del control aunque fuera domingo, o hoy con horas pasadas.
  const loaded = resources.data?.data
  const [span] = useState(() => {
    const now = Date.now()
    const from = Math.max(now, Date.parse(control.dueAt) || now)
    return { now, from }
  })
  const proposalQuery = useQuery({
    queryKey: [
      "agenda-availability",
      "control-proposal",
      loaded?.branchId ?? null,
      control.id,
      span.from,
    ],
    queryFn: () => {
      const tz = loaded!.timeZone
      // Desde el comienzo del día en que toca (o desde ahora, si ya pasó): lo pasado no viene libre.
      const from = minutesToInstant(zonedDateOf(new Date(span.from).toISOString(), tz), 0, tz)
      const to = new Date(
        Math.max(Date.parse(from), span.now) + PROPOSAL_DAYS * DAY_MS,
      ).toISOString()
      const params = new URLSearchParams({ branchId: loaded!.branchId, from, to })
      return apiFetch<{ data: AgendaAvailability }>(`/api/agenda/availability?${params}`)
    },
    enabled: canSchedule && loaded !== undefined,
    staleTime: 30_000,
  })
  if (canSchedule && loaded && (proposalQuery.data || proposalQuery.isError)) {
    const indicatedBy =
      loaded.professionals.find((item) => item.id === control.originProfessionalUserId)?.id ?? null
    const proposal = proposalQuery.data
      ? proposeControlSlot(proposalQuery.data.data, {
          indicatedBy,
          durationMin: loaded.defaultDurationMin,
        })
      : null
    return (
      <ScheduleForm
        patientId={patientId}
        control={control}
        resources={loaded}
        onClose={onClose}
        scope={scope}
        proposal={proposal}
      />
    )
  }
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
  proposal,
}: {
  patientId: string
  control: SchedulableControl
  resources: AgendaResources
  onClose: () => void
  scope: FollowUpSchedulerScope
  /** La primera hora libre desde que toca; null si no se pudo saber o no hay ninguna en el plazo. */
  proposal: ControlProposal | null
}) {
  const client = useQueryClient()
  const timeZone = resources.timeZone
  const now = useScheduleNow()
  const today = zonedDateOf(now, timeZone)
  // El servicio elegido, para la duración del bloque; el dato del formulario es su id.
  const [service, setService] = useState<ServiceCatalogItem | null>(null)
  // «Usar esa cita» es un botón por cita, no el formulario: su rechazo va junto a esa cita.
  const [useError, setUseError] = useState<{ appointmentId: string; message: string } | null>(null)
  const origin = resources.professionals.find((item) => item.id === control.originProfessionalUserId) ?? null
  // Con propuesta, quien lo indicó solo si tiene hora libre; sin ella, como antes.
  const indicatedBy = proposal ? (proposal.professionalUserId === origin?.id ? origin : null) : origin
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
    // Se abre en la primera hora libre desde que toca el control; sin ella, en el día en que toca.
    date: proposal?.date ?? zonedDateOf(control.dueAt, timeZone),
    // Con servicio, la agenda ofrece solo a quien lo atiende (ADR 0039).
    serviceId: service?.id || undefined,
    // Primero quien lo indicó, si atiende en esta sede: el control lo suele hacer quien lo pidió
    // (QA del 9 nov, repaso 3: proponía a otro). Se cambia a «Cualquiera» con un toque.
    ...(indicatedBy ? { professionalUserId: indicatedBy.id, professionalLabel: indicatedBy.label } : {}),
  })
  // Si ya tiene una cita en pie desde que el control toca (su ventana), se ofrece usarla en vez
  // de reservar otra, en cualquier sede: esa visita lo cumple (ADR 0152).
  const [range] = useState(() => {
    const now = Date.now()
    const from = Math.max(now, Date.parse(control.windowFrom) || now)
    const until = Math.max(now, Date.parse(control.dueAt) || now) + STANDING_DAYS * DAY_MS
    return { from: new Date(from).toISOString(), to: new Date(until).toISOString() }
  })
  const standing = useQuery({
    queryKey: ["follow-up-appointments", patientId, range.from],
    queryFn: () => {
      const params = new URLSearchParams({
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
          // Fuera del horario de quien lo indicó, como en «Nueva cita»: lo avisado se reserva igual.
          ...exceptionFlags(when.exception),
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
