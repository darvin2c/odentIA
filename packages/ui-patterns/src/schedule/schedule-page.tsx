import { Button, FieldLabel, FieldLegend, FieldSet, Input } from "@odentia/ui"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import * as React from "react"
import { FormDrawer } from "../form/form-drawer.js"
import { FilterBar, type FilterDef, SearchInput, useListSearch } from "../list-filtering/index.js"
import { PageShell } from "../page-shell.js"
import { normalizeSearchText } from "../text.js"
import { conflictLabel, findScheduleConflicts } from "./conflicts.js"
import { useScheduleNow } from "./now.js"
import {
  CHAIRS,
  type DemoAppointment,
  demoAppointments,
  FILTER_KEYS,
  GROUP_LABELS,
  matchesResource,
  moveAppointment,
  PROFESSIONALS,
  projectAppointment,
  RESOURCE_OPTIONS,
  type ResourceGroup,
  roomOf,
} from "./resource-demo.js"
import { ResourceSelect } from "./resource-select.js"
import { SCHEDULE_STATUS_LABELS, StatusDot } from "./status.js"
import { SCHEDULE_TIME_ZONE as TZ } from "./story-fixtures.js"
import { addDays, dayMinutesIn, hourLabel, minutesToInstant, zonedDateOf } from "./time.js"
import { ScheduleTimeline, type ScheduleTimelineApi } from "./timeline.js"
import type { ScheduleEntry, ScheduleStatus } from "./types.js"

const SELECT =
  "h-9 min-w-0 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
const weekAround = (date: string) =>
  Array.from({ length: 15 }, (_, index) => addDays(date, index - 7))
const FILTERS: FilterDef[] = [
  ...(["professionals", "chairs", "rooms"] as const).map((key) => ({
    key,
    label: GROUP_LABELS[key],
    type: "multi" as const,
    emptyMeansAll: true,
    options: RESOURCE_OPTIONS[key].map((item) => ({
      value: item.id,
      label: item.label + (item.detail ? ` · ${item.detail}` : ""),
    })),
  })),
  {
    key: "status",
    label: "Estado",
    type: "select",
    options: Object.entries(SCHEDULE_STATUS_LABELS).map(([value, label]) => ({
      value,
      label,
      leading: <StatusDot status={value as ScheduleStatus} />,
    })),
  },
]
type EditorState = { entry?: DemoAppointment }

export function SchedulePage() {
  const now = useScheduleNow(15_000)
  const today = zonedDateOf(now, TZ)
  const { get, setParam, setParams } = useListSearch()
  const day = get("date") ?? today
  const group: ResourceGroup = get("group") === "chairs" ? "chairs" : "professionals"
  const [dates, setDates] = React.useState(() => weekAround(day))
  const [changes, setChanges] = React.useState<Record<string, DemoAppointment>>({})
  const [zoom, setZoom] = React.useState(150)
  const [editor, setEditor] = React.useState<EditorState | null>(null)
  const [message, setMessage] = React.useState("")
  const [navigation, setNavigation] = React.useState(0)
  const api = React.useRef<ScheduleTimelineApi | null>(null)
  const scrolledDay = React.useRef<string | null>(null)
  const navigating = React.useRef(true)
  const previousSurface = React.useRef("")
  const targetDay = React.useRef(day)
  const previousNavigation = React.useRef(navigation)
  targetDay.current = day

  // Los overrides son canónicos y sobreviven a filtros, agrupaciones y ventanas de fechas.
  const appointments = React.useMemo(
    () => [
      ...dates.flatMap(demoAppointments).filter((entry) => !changes[entry.id]),
      ...Object.values(changes),
    ],
    [dates, changes],
  )
  const byId = React.useMemo(
    () => new Map(appointments.map((entry) => [entry.id, entry])),
    [appointments],
  )
  const conflicts = React.useMemo(() => findScheduleConflicts(appointments), [appointments])
  const resourceWarnings = React.useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of appointments) {
      if (!conflicts.has(entry.id) || zonedDateOf(entry.start, TZ) !== day) continue
      const id = group === "chairs" ? entry.chairId : entry.professionalId
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [appointments, conflicts, day, group])
  const professionals = get("professionals")
  const chairs = get("chairs")
  const rooms = get("rooms")
  const status = get("status")
  const query = normalizeSearchText(get("q") ?? "")
  const matching = React.useMemo(
    () =>
      appointments.filter(
        (entry) =>
          matchesResource(professionals, entry.professionalId) &&
          matchesResource(chairs, entry.chairId) &&
          matchesResource(rooms, roomOf(entry)) &&
          normalizeSearchText(`${entry.title} ${entry.subtitle ?? ""}`).includes(query),
      ),
    [appointments, professionals, chairs, rooms, query],
  )
  const visible = React.useMemo(
    () =>
      matching
        .filter((entry) => !status || entry.status === status)
        .map((entry) => ({
          ...projectAppointment(entry, group),
          warning: conflictLabel(conflicts.get(entry.id)),
          resourceLabel:
            group === "chairs"
              ? PROFESSIONALS.find((professional) => professional.id === entry.professionalId)
                  ?.label
              : CHAIRS.find((chair) => chair.id === entry.chairId)?.label,
        })),
    [matching, status, group, conflicts],
  )
  const daily = visible.filter((entry) => zonedDateOf(entry.start, TZ) === day)
  const groupSelection = get(group)
  const columns = RESOURCE_OPTIONS[group]
    .filter(
      (column) =>
        matchesResource(groupSelection, column.id) &&
        (group !== "chairs" ||
          matchesResource(rooms, CHAIRS.find((chair) => chair.id === column.id)?.roomId ?? "")),
    )
    .map((column) => ({
      ...column,
      warning: resourceWarnings.has(column.id)
        ? `${resourceWarnings.get(column.id)} citas con solapamiento este día`
        : undefined,
    }))
  const hasColumns = columns.length > 0
  // Un montaje nuevo informa su origen antes de aplicar la fecha pedida.
  // Ignoramos ese aviso inicial; nunca debe reemplazar la navegación del usuario.
  if (previousSurface.current !== `${group}:${hasColumns}`) navigating.current = true
  const dateLoaded = dates.includes(day)
  const clearFilters = () =>
    setParams(Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined])))
  const navigate = (date: string) => {
    if (!date) return
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
  const extend = React.useCallback((edge: "start" | "end") => {
    setDates((current) =>
      edge === "start"
        ? [addDays(current[0], -2), addDays(current[0], -1), ...current]
        : [
            ...current,
            addDays(current[current.length - 1], 1),
            addDays(current[current.length - 1], 2),
          ],
    )
  }, [])
  const update = (entry: DemoAppointment) =>
    setChanges((current) => ({ ...current, [entry.id]: entry }))
  const openEntry = (entry: ScheduleEntry) => setEditor({ entry: byId.get(entry.id) })

  return (
    <PageShell fill className="gap-3 text-foreground">
      <header className="min-w-0 shrink-0 rounded-xl border bg-background">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,360px)_auto]">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Sede Centro · Hora de Lima · Demo</p>
            <h1 className="text-xl font-semibold tracking-tight">Agenda del equipo</h1>
          </div>
          <div className="col-span-2 row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
            <SearchInput placeholder="Buscar persona o motivo" className="min-w-0" />
          </div>
          <Button
            className="col-start-2 row-start-1 lg:col-start-3"
            aria-label="Nueva cita"
            onClick={() => setEditor({})}
          >
            <Plus className="size-4" />
            <span className="hidden sm:inline">Nueva cita</span>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 sm:px-4">
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
            onChange={(event) => setParam("group", event.target.value)}
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
            filters={FILTERS}
            sortOptions={[]}
            showSearch={false}
            resetKeys={FILTER_KEYS}
            inlineFrom="lg"
            className="ml-auto min-w-0 bg-transparent p-0 lg:min-w-[480px] lg:flex-1"
          />
        </div>
      </header>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {!hasColumns ? (
          <div className="grid min-h-0 flex-1 place-content-center gap-3 overflow-auto rounded-xl border border-dashed p-6 text-center">
            <h3 className="font-medium">No hay recursos seleccionados</h3>
            <p className="text-sm text-muted-foreground">
              Las citas no se eliminan al ocultar recursos.
            </p>
            <Button variant="outline" onClick={clearFilters}>
              Restablecer filtros
            </Button>
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
              onEntryClick={openEntry}
              onEntryMove={(entry, move) => {
                const appointment = byId.get(entry.id)
                if (!appointment) return
                update(moveAppointment(appointment, move, group))
              }}
              onEntryResize={(entry, resize) => {
                const appointment = byId.get(entry.id)
                if (appointment) update({ ...appointment, start: resize.start, end: resize.end })
              }}
            />
          </div>
        )}
        {hasColumns && daily.length === 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed p-3 text-sm">
            <span>
              {professionals || chairs || rooms || status || query
                ? "No hay citas para este día con los filtros actuales."
                : "No hay citas para este día."}
            </span>
            {professionals || chairs || rooms || status || query ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Restablecer filtros
              </Button>
            ) : null}
          </div>
        )}
      </main>
      <span role="status" className="sr-only">
        {message}
      </span>
      {editor && (
        <EntryEditor
          key={editor.entry?.id ?? "new"}
          entry={editor.entry}
          date={day}
          onClose={() => setEditor(null)}
          onSave={(entry) => {
            update(entry)
            setEditor(null)
            navigate(zonedDateOf(entry.start, TZ))
            const hidden =
              !matchesResource(professionals, entry.professionalId) ||
              !matchesResource(chairs, entry.chairId) ||
              !matchesResource(rooms, roomOf(entry)) ||
              (status && status !== entry.status) ||
              !normalizeSearchText(`${entry.title} ${entry.subtitle ?? ""}`).includes(query)
            setMessage(
              `${entry.title}: cita guardada.${hidden ? " No visible con los filtros actuales." : ""}`,
            )
          }}
        />
      )}
    </PageShell>
  )
}

function EntryEditor({
  entry,
  date,
  onClose,
  onSave,
}: {
  entry?: DemoAppointment
  date: string
  onClose: () => void
  onSave: (entry: DemoAppointment) => void
}) {
  const [error, setError] = React.useState<string | null>(null)
  const [chairId, setChairId] = React.useState(entry?.chairId ?? CHAIRS[0].id)
  const [professionalId, setProfessionalId] = React.useState(
    entry?.professionalId ?? PROFESSIONALS[0].id,
  )
  const chair = CHAIRS.find((item) => item.id === chairId)
  const id = React.useId()
  return (
    <FormDrawer
      open
      className="max-sm:h-[90dvh] data-[swipe-axis=x]:sm:[--drawer-content-width:min(40rem,calc(100vw-2rem))]"
      title={entry ? "Detalle de la cita" : "Nueva cita"}
      description="Demostración local. No realiza una reserva ni comprueba disponibilidad clínica."
      onClose={onClose}
      error={error}
      submitLabel={entry ? "Guardar cambios" : "Crear cita"}
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget as HTMLFormElement)
        const minutes = (value: string) => {
          const [hour, minute] = value.split(":").map(Number)
          return hour * 60 + minute
        }
        const from = minutes(String(data.get("from")))
        const to = minutes(String(data.get("to")))
        if (to <= from) {
          setError("La hora final debe ser posterior al inicio.")
          return
        }
        const title = String(data.get("title") ?? "").trim()
        if (!title) {
          setError("Escribe el nombre de la persona.")
          return
        }
        if (!chair) {
          setError("Elige un sillón de la sede.")
          return
        }
        if (!PROFESSIONALS.some((item) => item.id === professionalId)) {
          setError("Elige un profesional.")
          return
        }
        const day = String(data.get("date"))
        onSave({
          id: entry?.id ?? crypto.randomUUID(),
          title,
          subtitle: String(data.get("subtitle") ?? "").trim(),
          professionalId,
          chairId,
          status: String(data.get("status")) as ScheduleStatus,
          start: minutesToInstant(day, from, TZ),
          end: minutesToInstant(day, to, TZ),
        })
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label htmlFor={`${id}-title`} className="grid gap-2 text-sm">
          Persona
          <Input
            id={`${id}-title`}
            name="title"
            required
            maxLength={100}
            defaultValue={entry?.title}
          />
        </label>
        <label htmlFor={`${id}-subtitle`} className="grid gap-2 text-sm">
          Motivo
          <Input
            id={`${id}-subtitle`}
            name="subtitle"
            maxLength={160}
            defaultValue={entry?.subtitle}
          />
        </label>
        <ResourceSelect
          id={`${id}-professional`}
          label="Profesional"
          options={PROFESSIONALS}
          value={professionalId}
          onChange={setProfessionalId}
        />
        <ResourceSelect
          id={`${id}-chair`}
          label="Sillón"
          options={CHAIRS}
          value={chairId}
          onChange={setChairId}
        />
        <p className="text-sm text-muted-foreground sm:col-span-2" role="status">
          Sala: {chair?.detail ?? "Selecciona un sillón"}
        </p>
        <label htmlFor={`${id}-date`} className="grid gap-2 text-sm">
          Fecha
          <Input
            id={`${id}-date`}
            name="date"
            type="date"
            required
            defaultValue={entry ? zonedDateOf(entry.start, TZ) : date}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label htmlFor={`${id}-from`} className="grid gap-2 text-sm">
            Inicio
            <Input
              id={`${id}-from`}
              name="from"
              type="time"
              required
              min="08:00"
              max="19:45"
              step={900}
              defaultValue={entry ? hourLabel(dayMinutesIn(entry.start, TZ)) : "09:00"}
            />
          </label>
          <label htmlFor={`${id}-to`} className="grid gap-2 text-sm">
            Fin
            <Input
              id={`${id}-to`}
              name="to"
              type="time"
              required
              min="08:15"
              max="20:00"
              step={900}
              defaultValue={entry ? hourLabel(dayMinutesIn(entry.end, TZ)) : "09:45"}
            />
          </label>
        </div>
        <FieldSet className="gap-2 sm:col-span-2">
          <FieldLegend className="mb-0 text-sm">Estado</FieldLegend>
          <div className="grid grid-cols-6 gap-2">
            {Object.entries(SCHEDULE_STATUS_LABELS).map(([value, label], index) => (
              <FieldLabel
                key={value}
                className={`flex min-h-12 w-full min-w-0 cursor-pointer flex-wrap items-center gap-2 rounded-lg border p-2 has-[:checked]:border-primary has-[:checked]:bg-primary/5 ${index < 3 ? "col-span-2" : "col-span-3"}`}
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  type="radio"
                  name="status"
                  required
                  value={value}
                  defaultChecked={(entry?.status ?? "programada") === value}
                />
                <StatusDot status={value as ScheduleStatus} />
                <span className="w-full text-xs sm:w-auto sm:text-sm">{label}</span>
              </FieldLabel>
            ))}
          </div>
        </FieldSet>
      </div>
    </FormDrawer>
  )
}
