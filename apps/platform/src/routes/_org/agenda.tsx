import { Button, FieldLabel, FieldLegend, FieldSet, Input, toast } from "@odentia/ui"
import {
  addDays,
  conflictLabel,
  dayMinutesIn,
  FilterBar,
  type FilterDef,
  FormDrawer,
  findScheduleConflicts,
  formatDayShort,
  hourLabel,
  minutesToInstant,
  PageHeader,
  PageShell,
  ResourceSelect,
  type ResourceSelectOption,
  SCHEDULE_STATUS_LABELS,
  type ScheduleColumn,
  type ScheduleEntry,
  ScheduleTimeline,
  type ScheduleTimelineApi,
  StatusDot,
  useListSearch,
  useScheduleNow,
  weekDates,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import * as React from "react"
import type {
  AgendaAppointment,
  AgendaResources,
  AgendaServiceOption,
  AppointmentStatus,
  AvailableSlot,
  AvailableSlotsResult,
  WaitlistEntry,
  WaitlistPriority,
} from "../../lib/agenda"
import { ApiError, apiFetch } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import { fetchCrmContext } from "../../lib/crm-workspace"
export const Route = createFileRoute("/_org/agenda")({
  validateSearch: (search: Record<string, unknown>) => ({
    ...search,
    patientId: typeof search.patientId === "string" ? search.patientId : undefined,
    contactId: typeof search.contactId === "string" ? search.contactId : undefined,
    conversationId: typeof search.conversationId === "string" ? search.conversationId : undefined,
  }),
  component: AgendaPage,
})

type GroupMode = "professionals" | "chairs"
interface AppointmentContext {
  patientId: string
  patientName: string
  conversationId?: string
}

const FILTER_KEYS = ["professionals", "chairs", "status"] as const
const SELECT =
  "h-8 shrink-0 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"

/** Filtro multi: sin valor = todos, "none" = ninguno, CSV = subconjunto. */
function matchesResourceFilter(selected: string | null | undefined, id: string): boolean {
  if (!selected) return true
  if (selected === "none") return false
  return selected.split(",").includes(id)
}

const weekAround = (date: string) =>
  Array.from({ length: 15 }, (_, index) => addDays(date, index - 7))

const STATUS_OPTIONS = (Object.keys(SCHEDULE_STATUS_LABELS) as AppointmentStatus[]).map(
  (value) => ({
    value,
    label: SCHEDULE_STATUS_LABELS[value],
    leading: <StatusDot status={value} />,
  }),
)

/** Intervalo de la ventana cargada: una semana antes y después del día visible. */
function windowRange(day: string, timeZone: string): { from: string; to: string } {
  return {
    from: minutesToInstant(addDays(day, -7), 0, timeZone),
    to: minutesToInstant(addDays(day, 8), 0, timeZone),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? (error.shape.message ?? error.message) : String(error)
}

function AgendaPage() {
  const queryClient = useQueryClient()
  const { get, setParam, setParams } = useListSearch()
  const [zoom, setZoom] = React.useState(150)

  const resourcesQuery = useQuery({
    queryKey: ["agenda-resources"],
    queryFn: () => apiFetch<{ data: AgendaResources }>("/api/agenda/resources"),
  })
  const resources = resourcesQuery.data?.data
  const branchId = resources?.branchId
  const TZ = resources?.timeZone ?? "America/Lima"

  const now = useScheduleNow()
  const today = zonedDateOf(now, TZ)
  const day = /^\d{4}-\d{2}-\d{2}$/.test(get("date") ?? "") ? (get("date") as string) : today
  const group: GroupMode = get("group") === "chairs" ? "chairs" : "professionals"
  const [dates, setDates] = React.useState<string[]>(() => weekAround(day))
  const [editor, setEditor] = React.useState<{ appointment?: AgendaAppointment; context?: AppointmentContext } | null>(null)
  const [message, setMessage] = React.useState("")
  const [navigation, setNavigation] = React.useState(0)
  const scrolledDay = React.useRef<string | null>(null)
  const navigating = React.useRef(true)
  const previousSurface = React.useRef("")
  const targetDay = React.useRef(day)
  const previousNavigation = React.useRef(navigation)
  targetDay.current = day
  const canWrite = usePermission("appointments.write")
  const requested = Route.useSearch()
  const contextualPatient = useQuery({
    queryKey: ["crm-context", requested.contactId, requested.conversationId ?? "todas"],
    enabled: canWrite && !!requested.contactId && !!requested.patientId,
    queryFn: () => fetchCrmContext(requested.contactId!, requested.conversationId),
  })
  const patientLink = contextualPatient.data?.data.contact.patients.find(item => item.id === requested.patientId)
  const openedRequest = React.useRef<string | null>(null)
  React.useEffect(() => {
    const key = requested.contactId && requested.patientId
      ? `${requested.contactId}:${requested.patientId}:${requested.conversationId ?? ""}` : null
    if (!key) openedRequest.current = null
    if (key && key !== openedRequest.current && patientLink && resources && canWrite) {
      openedRequest.current = key
      setEditor({ context: { patientId: patientLink.id, patientName: patientLink.displayName, conversationId: requested.conversationId } })
    }
  }, [requested.contactId, requested.patientId, requested.conversationId, patientLink, resources, canWrite])
  const closeEditor = () => {
    setEditor(null)
    if (editor?.context) setParams({ patientId: undefined, contactId: undefined, conversationId: undefined })
  }

  const range = React.useMemo(() => windowRange(day, TZ), [day, TZ])
  const appointmentsQuery = useQuery({
    queryKey: ["agenda", branchId, range.from, range.to],
    enabled: branchId != null,
    queryFn: () =>
      apiFetch<{ data: AgendaAppointment[] }>(
        `/api/appointments?branchId=${branchId ?? ""}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
    placeholderData: (previous) => previous,
  })
  const appointments = React.useMemo(() => appointmentsQuery.data?.data ?? [], [appointmentsQuery])
  const byId = React.useMemo(
    () => new Map(appointments.map((appointment) => [appointment.id, appointment])),
    [appointments],
  )

  // Los conflictos se calculan antes de filtrar: una cita oculta sigue ocupando.
  const conflicts = React.useMemo(
    () =>
      findScheduleConflicts(
        appointments.map((item) => ({
          id: item.id,
          start: item.startsAt,
          end: item.endsAt,
          status: item.status,
          professionalId: item.dentistUserId,
          chairId: item.chairId,
        })),
      ),
    [appointments],
  )
  const resourceWarnings = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of appointments) {
      if (zonedDateOf(item.startsAt, TZ) !== day || !conflicts.has(item.id)) continue
      counts.set(item.dentistUserId, (counts.get(item.dentistUserId) ?? 0) + 1)
      counts.set(item.chairId, (counts.get(item.chairId) ?? 0) + 1)
    }
    return counts
  }, [appointments, conflicts, day, TZ])

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agenda"] }),
      queryClient.invalidateQueries({ queryKey: ["agenda-resources"] }),
    ])

  const moveMutation = useMutation({
    mutationFn: (input: {
      id: string
      expectedVersion: number
      startsAt: string
      endsAt: string
      dentistUserId?: string
      chairId?: string
    }) =>
      apiFetch<{ data: AgendaAppointment }>(`/api/appointments/${input.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: input.expectedVersion,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          dentistUserId: input.dentistUserId,
          chairId: input.chairId,
        }),
      }),
    onSuccess: async (result) => {
      setMessage(`Cita de ${result.data.patientName} reprogramada.`)
      await invalidate()
    },
    onError: async (error) => {
      toast.error(errorMessage(error))
      await invalidate()
    },
  })

  const filters: FilterDef[] = React.useMemo(
    () => [
      {
        key: "professionals",
        label: "Profesionales",
        type: "multi",
        emptyMeansAll: true,
        options: (resources?.professionals ?? []).map((item) => ({
          value: item.id,
          label: item.label,
        })),
      },
      {
        key: "chairs",
        label: "Sillones",
        type: "multi",
        options: (resources?.chairs ?? []).map((item) => ({
          value: item.id,
          label: item.label,
        })),
      },
      { key: "status", label: "Estado", type: "select", options: STATUS_OPTIONS },
    ],
    [resources],
  )
  const professionalsFilter = get("professionals")
  const chairsFilter = get("chairs")
  const status = get("status")

  const visible = React.useMemo(
    () =>
      appointments
        .filter(
          (item) =>
            matchesResourceFilter(professionalsFilter, item.dentistUserId) &&
            matchesResourceFilter(chairsFilter, item.chairId) &&
            (!status || item.status === status),
        )
        .map((item): ScheduleEntry => {
          const conflict = conflicts.get(item.id)
          const context = [item.serviceName ?? item.reason, item.dentistName, item.chairName]
            .filter(Boolean)
            .join(" · ")
          return {
            id: item.id,
            columnId: group === "professionals" ? item.dentistUserId : item.chairId,
            title: item.patientName,
            subtitle: context,
            start: item.startsAt,
            end: item.endsAt,
            status: item.status,
            warning: conflictLabel(conflict),
          }
        }),
    [appointments, professionalsFilter, chairsFilter, status, conflicts, group],
  )
  const daily = visible.filter((entry) => zonedDateOf(entry.start, TZ) === day)

  const columns = React.useMemo((): ScheduleColumn[] => {
    const base =
      group === "professionals"
        ? (resources?.professionals ?? []).map((item) => ({ id: item.id, label: item.label }))
        : (resources?.chairs ?? []).map((item) => ({ id: item.id, label: item.label }))
    return base
      .filter((column) =>
        matchesResourceFilter(
          group === "professionals" ? professionalsFilter : chairsFilter,
          column.id,
        ),
      )
      .map((column) => ({
        ...column,
        warning: resourceWarnings.has(column.id)
          ? `${resourceWarnings.get(column.id)} citas con solapamiento este día`
          : undefined,
      }))
  }, [group, resources, professionalsFilter, chairsFilter, resourceWarnings])
  const hasColumns = columns.length > 0
  // Un montaje nuevo informa su origen antes de aplicar la fecha pedida; se ignora.
  if (previousSurface.current !== `${group}:${hasColumns}`) navigating.current = true
  const dateLoaded = dates.includes(day)
  const api = React.useRef<ScheduleTimelineApi | null>(null)
  const navigate = (date: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return
    navigating.current = true
    scrolledDay.current = null
    if (date === day) setNavigation((value) => value + 1)
    else setParam("date", date)
  }
  const reportVisibleDay = React.useCallback(
    (date: string) => {
      if (navigating.current || date === targetDay.current) return
      scrolledDay.current = date
      setParam("date", date, { replace: true })
    },
    [setParam],
  )
  React.useEffect(() => {
    const requested = previousNavigation.current !== navigation
    previousNavigation.current = navigation
    const surface = `${group}:${hasColumns}`
    const changedSurface = previousSurface.current !== surface
    previousSurface.current = surface
    if (!dateLoaded) {
      navigating.current = true
      setDates(weekAround(day))
      return
    }
    if (!hasColumns) {
      navigating.current = true
      return
    }
    if (requested || scrolledDay.current !== day || changedSurface) {
      api.current?.scrollToDate(day, undefined, "auto")
    }
    scrolledDay.current = null
    navigating.current = false
  }, [day, group, hasColumns, navigation, dateLoaded])
  const extend = React.useCallback(
    (edge: "start" | "end") => {
      setDates((current) =>
        edge === "start"
          ? [addDays(current[0] ?? day, -2), addDays(current[0] ?? day, -1), ...current]
          : [
              ...current,
              addDays(current[current.length - 1] ?? day, 1),
              addDays(current[current.length - 1] ?? day, 2),
            ],
      )
    },
    [day],
  )

  return (
    <PageShell fill className="gap-3 text-foreground">
      <PageHeader
        title="Agenda"
        subtitle={
          resources ? `${resources.branchName} · ${formatDayShort(day)}` : "Cargando recursos…"
        }
        actions={canWrite ? (
          <Button aria-label="Nueva cita" onClick={() => setEditor({})}>
            <Plus className="size-4" />
            <span className="hidden sm:inline">Nueva cita</span>
          </Button>
        ) : undefined
        }
      />
      {requested.patientId && (contextualPatient.error || (contextualPatient.isSuccess && !patientLink)) && (
        <p role="alert" className="px-4 text-sm text-destructive">
          No se pudo preparar la cita: comprueba el vínculo del paciente y vuelve a abrir el caso.
        </p>
      )}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-xl border bg-background px-3 py-2 sm:px-4">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Día anterior"
            onClick={() => navigate(addDays(day, -1))}
          >
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate(today)}>
            Hoy
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Día siguiente"
            onClick={() => navigate(addDays(day, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
        <input
          className={SELECT}
          type="date"
          aria-label="Ir a fecha"
          value={day}
          onChange={(event) => navigate(event.target.value)}
        />
        <select
          aria-label="Ver por"
          className={SELECT}
          value={group}
          onChange={(event) => setParams({ group: event.target.value })}
        >
          <option value="professionals">Por profesional</option>
          <option value="chairs">Por sillón</option>
        </select>
        <select
          aria-label="Escala"
          className={SELECT}
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        >
          <option value={90}>Escala compacta</option>
          <option value={150}>Escala normal</option>
          <option value={240}>Escala ampliada</option>
        </select>
        <FilterBar
          filters={filters}
          sortOptions={[]}
          showSearch={false}
          resetKeys={[...FILTER_KEYS]}
          inlineFrom="lg"
          className="ml-auto min-w-0 bg-transparent p-0 lg:min-w-[480px] lg:flex-1"
        />
      </div>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {!resources ? (
          <div className="grid min-h-0 flex-1 place-content-center rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            Cargando agenda…
          </div>
        ) : !hasColumns ? (
          <div className="grid min-h-0 flex-1 place-content-center gap-3 overflow-auto rounded-xl border border-dashed p-6 text-center">
            <h3 className="font-medium">No hay recursos seleccionados</h3>
            <p className="text-sm text-muted-foreground">
              Ajusta los filtros o crea sillones y profesionales en la sucursal.
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ScheduleTimeline
              className="max-h-full min-h-0"
              mobileLayout="focus"
              dates={dates}
              columns={columns}
              entries={visible}
              timeZone={TZ}
              now={now}
              hourWidth={zoom}
              rowHeight={104}
              autoScrollToNow={false}
              apiRef={api}
              onVisibleDateChange={reportVisibleDay}
              onDateRequest={navigate}
              onExtendDays={extend}
              onEntryClick={(entry) => {
                const appointment = byId.get(entry.id)
                if (appointment) setEditor({ appointment })
              }}
              onEntryMove={(entry, move) => {
                const appointment = byId.get(entry.id)
                if (!appointment) return
                moveMutation.mutate({
                  id: appointment.id,
                  expectedVersion: appointment.version,
                  startsAt: move.start,
                  endsAt: move.end,
                  dentistUserId:
                    group === "professionals" && move.columnId !== appointment.dentistUserId
                      ? move.columnId
                      : undefined,
                  chairId:
                    group === "chairs" && move.columnId !== appointment.chairId
                      ? move.columnId
                      : undefined,
                })
              }}
              onEntryResize={(entry, resize) => {
                const appointment = byId.get(entry.id)
                if (!appointment) return
                moveMutation.mutate({
                  id: appointment.id,
                  expectedVersion: appointment.version,
                  startsAt: resize.start,
                  endsAt: resize.end,
                })
              }}
            />
          </div>
        )}
        {hasColumns && daily.length === 0 && !appointmentsQuery.isLoading && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
            <span>
              {professionalsFilter || chairsFilter || status
                ? "No hay citas para este día con los filtros actuales."
                : "No hay citas para este día."}
            </span>
            {professionalsFilter || chairsFilter || status ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setParams(Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])))
                }
              >
                Restablecer filtros
              </Button>
            ) : null}
          </div>
        )}
      </main>
      {resources && branchId && (
        <WaitlistPanel
          branchId={branchId}
          timeZone={TZ}
          resources={resources}
          day={day}
          onChanged={async () => {
            await invalidate()
          }}
        />
      )}
      <span role="status" className="sr-only">
        {message}
      </span>
      {editor && resources && (
        <AppointmentEditor
          key={editor.appointment?.id ?? "new"}
          appointment={editor.appointment}
          context={editor.context}
          day={day}
          timeZone={TZ}
          resources={resources}
          onClose={closeEditor}
          onSaved={async (text) => {
            setMessage(text)
            closeEditor()
            await invalidate()
            await queryClient.invalidateQueries({ queryKey: ["crm-context"] })
          }}
        />
      )}
    </PageShell>
  )
}

interface DraftValues {
  patientId: string
  dentistUserId: string
  chairId: string
  serviceId: string
  date: string
  from: string
  to: string
  reason: string
  status: AppointmentStatus
}

function AppointmentEditor({
  appointment,
  context,
  day,
  timeZone,
  resources,
  onClose,
  onSaved,
}: {
  appointment?: AgendaAppointment
  context?: AppointmentContext
  day: string
  timeZone: string
  resources: AgendaResources
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const initial = React.useMemo((): DraftValues => {
    if (appointment) {
      return {
        patientId: appointment.patientId,
        dentistUserId: appointment.dentistUserId,
        chairId: appointment.chairId,
        serviceId: appointment.serviceId ?? "",
        date: zonedDateOf(appointment.startsAt, timeZone),
        from: hourLabel(dayMinutesIn(appointment.startsAt, timeZone)),
        to: hourLabel(dayMinutesIn(appointment.endsAt, timeZone)),
        reason: appointment.reason ?? "",
        status: appointment.status,
      }
    }
    const nowMinutes = dayMinutesIn(new Date().toISOString(), timeZone)
    const from = Math.min(Math.max(Math.ceil(nowMinutes / 30) * 30, 8 * 60), 19 * 60)
    return {
      patientId: context?.patientId ?? "",
      dentistUserId: resources.professionals[0]?.id ?? "",
      chairId: resources.chairs[0]?.id ?? "",
      serviceId: "",
      date: day,
      from: hourLabel(from),
      to: hourLabel(from + 30),
      reason: "",
      status: "programada",
    }
  }, [appointment, context, day, timeZone, resources])
  const [values, setValues] = React.useState(initial)
  const [error, setError] = React.useState("")
  const [patientQuery, setPatientQuery] = React.useState("")

  const patientsQuery = useQuery({
    queryKey: ["patients", "agenda-picker", patientQuery],
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
    // La cita abierta conserva su paciente aunque la búsqueda no lo devuelva.
    if (appointment && !options.some((option) => option.id === appointment.patientId)) {
      options.unshift({ id: appointment.patientId, label: appointment.patientName })
    }
    if (context && !options.some(option => option.id === context.patientId)) {
      options.unshift({ id: context.patientId, label: context.patientName })
    }
    return options
  }, [patientsQuery.data, appointment, context])

  const professionalOptions = resources.professionals.map((item) => ({
    id: item.id,
    label: item.label,
  }))
  const chairOptions = resources.chairs.map((item) => ({
    id: item.id,
    label: item.label,
    detail: "Sede actual",
  }))
  const serviceOptions = (servicesQuery.data?.data ?? []).map((service) => ({
    id: service.id,
    label: service.name,
    detail: service.durationMin ? `${service.durationMin} min` : undefined,
  }))

  const save = useMutation({
    mutationFn: async () => {
      const parseMinutes = (label: string) => {
        const [hours = 0, minutes = 0] = label.split(":").map(Number)
        return hours * 60 + minutes
      }
      const startMinutes = parseMinutes(values.from)
      const endMinutes = parseMinutes(values.to)
      if (!values.patientId) throw new Error("Elige un paciente.")
      if (!values.dentistUserId) throw new Error("Elige un profesional.")
      if (!values.chairId) throw new Error("Elige un sillón.")
      if (endMinutes <= startMinutes) throw new Error("El fin debe ser posterior al inicio.")
      const startsAt = minutesToInstant(values.date, startMinutes, timeZone)
      const endsAt = minutesToInstant(values.date, endMinutes, timeZone)
      const reason = values.reason.trim() || undefined
      const serviceId = values.serviceId || null
      if (appointment) {
        let version = appointment.version
        const timeChanged = startsAt !== appointment.startsAt || endsAt !== appointment.endsAt
        const resourceChanged =
          values.dentistUserId !== appointment.dentistUserId ||
          values.chairId !== appointment.chairId
        if (timeChanged || resourceChanged) {
          const moved = await apiFetch<{ data: AgendaAppointment }>(
            `/api/appointments/${appointment.id}/move`,
            {
              method: "POST",
              body: JSON.stringify({
                expectedVersion: version,
                startsAt,
                endsAt,
                dentistUserId: values.dentistUserId,
                chairId: values.chairId,
              }),
            },
          )
          version = moved.data.version
        }
        await apiFetch(`/api/appointments/${appointment.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            expectedVersion: version,
            reason: reason ?? null,
            serviceId,
            status: values.status,
          }),
        })
        return "Cita actualizada."
      }
      await apiFetch("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          patientId: values.patientId,
          dentistUserId: values.dentistUserId,
          chairId: values.chairId,
          serviceId: serviceId ?? undefined,
          startsAt,
          durationMin: endMinutes - startMinutes,
          reason,
          conversationId: context?.conversationId,
          source: context?.conversationId ? "conversacion" : "recepcion",
        }),
      })
      return "Cita creada."
    },
    onSuccess: async (text) => {
      toast.success(text)
      await onSaved(text)
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  return (
    <FormDrawer
      open
      title={appointment ? "Detalle de la cita" : "Nueva cita"}
      description="Registra o ajusta una cita de la sede."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty
      error={error || null}
      submitLabel={appointment ? "Guardar cambios" : "Crear cita"}
    >
      <div className="grid gap-4">
        {context ? (
          <div>
            <FieldLabel>Paciente del caso</FieldLabel>
            <p className="text-sm font-medium">{context.patientName}</p>
          </div>
        ) : (
          <ResourceSelect
            id="cita-paciente"
            label="Paciente"
            options={patientOptions}
            value={values.patientId}
            onChange={(patientId) => setValues((prev) => ({ ...prev, patientId }))}
            onQueryChange={setPatientQuery}
          />
        )}
        <ResourceSelect
          id="cita-profesional"
          label="Profesional"
          options={professionalOptions}
          value={values.dentistUserId}
          onChange={(dentistUserId) => setValues((prev) => ({ ...prev, dentistUserId }))}
        />
        <ResourceSelect
          id="cita-sillon"
          label="Sillón"
          options={chairOptions}
          value={values.chairId}
          onChange={(chairId) => setValues((prev) => ({ ...prev, chairId }))}
        />
        <ResourceSelect
          id="cita-servicio"
          label="Servicio (opcional)"
          options={serviceOptions}
          value={values.serviceId}
          onChange={(serviceId) => setValues((prev) => ({ ...prev, serviceId }))}
        />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="grid gap-2">
            <FieldLabel htmlFor="cita-fecha">Fecha</FieldLabel>
            <Input
              id="cita-fecha"
              type="date"
              required
              value={values.date}
              onChange={(event) => setValues((prev) => ({ ...prev, date: event.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <FieldLabel htmlFor="cita-inicio">Inicio</FieldLabel>
            <Input
              id="cita-inicio"
              type="time"
              required
              step={300}
              value={values.from}
              onChange={(event) => setValues((prev) => ({ ...prev, from: event.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <FieldLabel htmlFor="cita-fin">Fin</FieldLabel>
            <Input
              id="cita-fin"
              type="time"
              required
              step={300}
              value={values.to}
              onChange={(event) => setValues((prev) => ({ ...prev, to: event.target.value }))}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <FieldLabel htmlFor="cita-motivo">Motivo (opcional)</FieldLabel>
          <Input
            id="cita-motivo"
            value={values.reason}
            maxLength={500}
            onChange={(event) => setValues((prev) => ({ ...prev, reason: event.target.value }))}
          />
        </div>
        {appointment && (
          <FieldSet className="grid gap-2">
            <FieldLegend className="text-sm font-medium">Estado</FieldLegend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(SCHEDULE_STATUS_LABELS) as AppointmentStatus[]).map((option) => (
                <FieldLabel
                  key={option}
                  className={`flex items-center gap-2 rounded-lg border p-2 text-sm ${
                    values.status === option ? "border-primary bg-primary/5" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="appointment-status"
                    className="size-4"
                    checked={values.status === option}
                    onChange={() => setValues((prev) => ({ ...prev, status: option }))}
                  />
                  <StatusDot status={option} />
                  {SCHEDULE_STATUS_LABELS[option]}
                </FieldLabel>
              ))}
            </div>
          </FieldSet>
        )}
      </div>
    </FormDrawer>
  )
}

const PRIORITY_OPTIONS: WaitlistPriority[] = ["alta", "normal", "baja"]

/** Lista de espera de la sede: registro, ofrecimiento de huecos y reserva. */
function WaitlistPanel({
  branchId,
  timeZone,
  resources,
  day,
  onChanged,
}: {
  branchId: string
  timeZone: string
  resources: AgendaResources
  day: string
  onChanged: () => Promise<void>
}) {
  const canOperate = usePermission("appointments.write")
  const [open, setOpen] = React.useState(false)
  const [offerFor, setOfferFor] = React.useState<WaitlistEntry | null>(null)
  const [formOpen, setFormOpen] = React.useState(false)
  const waitlistQuery = useQuery({
    queryKey: ["agenda-waitlist", branchId],
    queryFn: () =>
      apiFetch<{ data: WaitlistEntry[] }>(
        `/api/agenda/waitlist?branchId=${branchId}&status=en_espera,ofrecida`,
      ),
  })
  const entries = waitlistQuery.data?.data ?? []
  return (
    <section className="shrink-0 rounded-xl border bg-background">
      <div className="flex flex-wrap items-center gap-2 p-3 sm:px-4">
        <h2 className="font-medium">Lista de espera</h2>
        <span className="text-xs text-muted-foreground">
          {entries.length === 0 ? "Sin pendientes" : `${entries.length} en espera`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {canOperate && (
            <Button variant="outline" size="sm" onClick={() => setFormOpen(true)}>
              Añadir
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen((value) => !value)}>
            {open ? "Ocultar" : "Ver"}
          </Button>
        </div>
      </div>
      {open && (
        <ul className="grid gap-2 border-t p-3 sm:px-4">
          {entries.length === 0 && (
            <li className="text-sm text-muted-foreground">No hay pacientes en espera.</li>
          )}
          {entries.map((entry) => (
            <WaitlistRow
              key={entry.id}
              entry={entry}
              timeZone={timeZone}
              canOperate={canOperate}
              onOffer={() => setOfferFor(entry)}
              onChanged={async () => {
                await waitlistQuery.refetch()
                await onChanged()
              }}
            />
          ))}
        </ul>
      )}
      {formOpen && (
        <WaitlistForm
          branchId={branchId}
          resources={resources}
          onClose={() => setFormOpen(false)}
          onSaved={async () => {
            setFormOpen(false)
            await waitlistQuery.refetch()
          }}
        />
      )}
      {offerFor && (
        <SlotOfferPicker
          entry={offerFor}
          branchId={branchId}
          timeZone={timeZone}
          day={day}
          professionals={resources.professionals}
          onClose={() => setOfferFor(null)}
          onSaved={async () => {
            setOfferFor(null)
            await waitlistQuery.refetch()
            await onChanged()
          }}
        />
      )}
    </section>
  )
}

function WaitlistRow({
  entry,
  timeZone,
  canOperate,
  onOffer,
  onChanged,
}: {
  entry: WaitlistEntry
  timeZone: string
  canOperate: boolean
  onOffer: () => void
  onChanged: () => Promise<void>
}) {
  const [error, setError] = React.useState("")
  const run = useMutation({
    mutationFn: (action: "book" | "cancel") =>
      apiFetch(`/api/agenda/waitlist/${entry.id}/${action}`, { method: "POST", body: "{}" }),
    onSuccess: async (_data, action) => {
      toast.success(action === "book" ? "Cita confirmada." : "Espera cancelada.")
      await onChanged()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  const subject = entry.patientName ?? entry.contactName ?? "Sin nombre"
  return (
    <li className="grid gap-1 rounded-lg border p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{subject}</span>
        <span className="text-xs text-muted-foreground">Prioridad {entry.priority}</span>
        <span className="text-xs text-muted-foreground">
          {entry.status === "ofrecida" ? "Hueco ofrecido" : "En espera"}
        </span>
        {entry.serviceName && <span className="text-xs">{entry.serviceName}</span>}
        {entry.dentistName && <span className="text-xs text-muted-foreground">{entry.dentistName}</span>}
      </div>
      {entry.notes && <p className="text-xs text-muted-foreground">{entry.notes}</p>}
      {entry.offeredStartsAt && entry.offeredEndsAt && (
        <p className="text-xs">
          Ofrecido:{" "}
          {new Date(entry.offeredStartsAt).toLocaleString("es-PE", { timeZone })} →{" "}
          {new Date(entry.offeredEndsAt).toLocaleTimeString("es-PE", { timeZone })}
        </p>
      )}
      {canOperate && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={onOffer}>
            Ofrecer hueco
          </Button>
          {entry.status === "ofrecida" && (
            <Button variant="outline" size="sm" onClick={() => run.mutate("book")}>
              Confirmar reserva
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => run.mutate("cancel")}>
            Cancelar espera
          </Button>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </li>
  )
}

function WaitlistForm({
  branchId,
  resources,
  onClose,
  onSaved,
}: {
  branchId: string
  resources: AgendaResources
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [patientId, setPatientId] = React.useState("")
  const [patientQuery, setPatientQuery] = React.useState("")
  const [dentistUserId, setDentistUserId] = React.useState("")
  const [serviceId, setServiceId] = React.useState("")
  const [priority, setPriority] = React.useState<WaitlistPriority>("normal")
  const [notes, setNotes] = React.useState("")
  const [error, setError] = React.useState("")
  const patientsQuery = useQuery({
    queryKey: ["patients", "waitlist-picker", patientQuery],
    queryFn: () =>
      apiFetch<{ data: { id: string; displayName: string }[] }>(
        `/api/patients?q=${encodeURIComponent(patientQuery)}&limit=20`,
      ),
    placeholderData: (previous) => previous,
  })
  const servicesQuery = useQuery({
    queryKey: ["services", "waitlist-picker"],
    queryFn: () => apiFetch<{ data: AgendaServiceOption[] }>("/api/services?limit=100"),
  })
  const save = useMutation({
    mutationFn: async () => {
      if (!patientId) throw new Error("Elige un paciente.")
      await apiFetch("/api/agenda/waitlist", {
        method: "POST",
        body: JSON.stringify({
          branchId,
          patientId,
          dentistUserId: dentistUserId || null,
          serviceId: serviceId || null,
          priority,
          notes: notes.trim() || undefined,
        }),
      })
    },
    onSuccess: async () => {
      toast.success("Espera registrada.")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title="Añadir a lista de espera"
      description="Registra un paciente pendiente de hueco en esta sede."
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        setError("")
        save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty
      error={error || null}
      submitLabel="Registrar espera"
    >
      <div className="grid gap-4">
        <ResourceSelect
          id="espera-paciente"
          label="Paciente"
          options={(patientsQuery.data?.data ?? []).map((patient) => ({
            id: patient.id,
            label: patient.displayName,
          }))}
          value={patientId}
          onChange={setPatientId}
          onQueryChange={setPatientQuery}
        />
        <ResourceSelect
          id="espera-profesional"
          label="Profesional preferido (opcional)"
          options={[{ id: "", label: "Sin preferencia" }].concat(
            resources.professionals.map((item) => ({ id: item.id, label: item.label })),
          )}
          value={dentistUserId}
          onChange={setDentistUserId}
        />
        <ResourceSelect
          id="espera-servicio"
          label="Servicio (opcional)"
          options={[{ id: "", label: "Sin servicio" }].concat(
            (servicesQuery.data?.data ?? []).map((service) => ({ id: service.id, label: service.name })),
          )}
          value={serviceId}
          onChange={setServiceId}
        />
        <div className="grid gap-2">
          <FieldLabel htmlFor="espera-prioridad">Prioridad</FieldLabel>
          <select
            id="espera-prioridad"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={priority}
            onChange={(event) => setPriority(event.target.value as WaitlistPriority)}
          >
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === "alta" ? "Alta" : option === "baja" ? "Baja" : "Normal"}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <FieldLabel htmlFor="espera-notas">Notas (opcional)</FieldLabel>
          <Input
            id="espera-notas"
            value={notes}
            maxLength={500}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>
    </FormDrawer>
  )
}

/** Busca huecos reales y ofrece uno a la espera con el mismo servicio. */
function SlotOfferPicker({
  entry,
  branchId,
  timeZone,
  day,
  professionals,
  onClose,
  onSaved,
}: {
  entry: WaitlistEntry
  branchId: string
  timeZone: string
  day: string
  professionals: { id: string; label: string }[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [date, setDate] = React.useState(day)
  const [dentistUserId, setDentistUserId] = React.useState(entry.dentistUserId ?? "")
  const [error, setError] = React.useState("")
  const range = React.useMemo(() => {
    const from = minutesToInstant(date, 0, timeZone)
    const to = minutesToInstant(date, 24 * 60, timeZone)
    return { from, to }
  }, [date, timeZone])
  const slotsQuery = useQuery({
    queryKey: ["agenda-slots", branchId, date, dentistUserId, entry.serviceId],
    queryFn: () => {
      const params = new URLSearchParams({
        branchId,
        from: range.from,
        to: range.to,
      })
      if (dentistUserId) params.set("dentistUserId", dentistUserId)
      if (entry.serviceId) params.set("serviceId", entry.serviceId)
      return apiFetch<{ data: AvailableSlotsResult }>(`/api/agenda/slots?${params.toString()}`)
    },
  })
  const result = slotsQuery.data?.data
  const slots = result?.slots ?? []
  const offer = useMutation({
    mutationFn: (slot: AvailableSlot) =>
      apiFetch(`/api/agenda/waitlist/${entry.id}/offer`, {
        method: "POST",
        body: JSON.stringify({
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          dentistUserId: slot.dentistUserId,
          chairId: slot.chairId,
        }),
      }),
    onSuccess: async () => {
      toast.success("Hueco ofrecido.")
      await onSaved()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })
  return (
    <FormDrawer
      open
      title="Ofrecer hueco"
      description={`Huecos reales para ${entry.patientName ?? entry.contactName ?? "la espera"}${entry.serviceName ? ` · ${entry.serviceName}` : ""}.`}
      onClose={onClose}
      onSubmit={(event) => event.preventDefault()}
      isSubmitting={offer.isPending}
      isDirty={false}
      error={error || null}
      submitLabel="Cerrar"
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Fecha de búsqueda"
            type="date"
            className="h-8 w-40"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
          <select
            aria-label="Profesional"
            className={SELECT}
            value={dentistUserId}
            onChange={(event) => setDentistUserId(event.target.value)}
          >
            <option value="">Todos</option>
            {professionals.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        {slotsQuery.isLoading && <p className="text-sm text-muted-foreground">Buscando huecos…</p>}
        {!slotsQuery.isLoading && slots.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Sin huecos ese día. El profesional necesita horario configurado y agenda libre.
          </p>
        )}
        {result?.truncated && (
          <p className="text-sm text-muted-foreground">
            Se muestran los primeros huecos; acota la fecha para ver más.
          </p>
        )}
        <ul className="grid gap-2">
          {slots.map((slot) => (
            <li
              key={`${slot.startsAt}:${slot.dentistUserId}:${slot.chairId}`}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
            >
              <span className="font-medium">
                {new Date(slot.startsAt).toLocaleTimeString("es-PE", { timeZone })} →{" "}
                {new Date(slot.endsAt).toLocaleTimeString("es-PE", { timeZone })}
              </span>
              <span className="text-muted-foreground">{slot.dentistName}</span>
              {slot.chairName && <span className="text-muted-foreground">{slot.chairName}</span>}
              <Button
                variant="outline"
                size="sm"
                disabled={offer.isPending}
                onClick={() => {
                  setError("")
                  offer.mutate(slot)
                }}
              >
                Ofrecer
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </FormDrawer>
  )
}
