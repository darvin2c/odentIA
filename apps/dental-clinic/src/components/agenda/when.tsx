import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
} from "@odentia/ui"
import {
  addDays,
  DataRefreshMarker,
  DatePickerButton,
  dayRangeOf,
  formatDateLong,
  formatMonthLong,
  formatSpan,
  hourLabel,
  minutesToInstant,
  type ScheduleAvailability,
  type ScheduleColumn,
  ScheduleDayStrip,
  type ScheduleRangeMarker,
  ScheduleRangePicker,
  type ScheduleRangeState,
  scheduleRangeState,
  type ScheduleRangeValue,
  ScheduleResourceChips,
  weekDates,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, ChevronDown } from "lucide-react"
import * as React from "react"
import type { AgendaAvailability } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { rangeSaid, shortName } from "./shared"

/** El bloque se mueve de cuarto en cuarto de hora, como en la rejilla. */
const SNAP_MS = 15 * 60000

/** Duraciones que ofrece el menú, la vía para cambiarla sin arrastrar. */
const DURATIONS = [15, 30, 45, 60, 90, 120]

const minutesBetween = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 60000)

export interface WhenInput {
  branchId: string
  timeZone: string
  today: string
  now: string
  toneOf: (id: string) => ScheduleColumn["tone"]
  /** Lo que dura el bloque cuando se coloca solo o al tocar un hueco. */
  duration: number
  /** Día en que se abre. */
  date?: string
  /** A quién se mira al abrir (null = cualquiera). */
  dentistUserId?: string | null
  /** Hueco ya elegido antes de abrir (tocado en la rejilla). */
  startsAt?: string
  /**
   * Reprogramar: la cita que se mueve. Su hueco cuenta como libre, se marca
   * dónde está y el bloque se propone en otro sitio.
   */
  moving?: { id: string; dentistUserId: string; startsAt: string; endsAt: string }
  /** Falso mientras el «cuándo» no está a la vista: no se consulta nada. */
  enabled?: boolean
  /** Con servicio, la agenda ofrece solo a quien lo atiende (ADR 0039). */
  serviceId?: string
}

export interface WhenState {
  input: WhenInput
  team: ScheduleColumn[]
  lanes: ScheduleColumn[]
  free: ScheduleAvailability[]
  open: ScheduleAvailability[]
  date: string
  week: string[]
  dentistFilter: string | null
  /** Lo elegido, si sigue valiendo para el día y el profesional que se miran. */
  shown: ScheduleRangeValue | null
  state: ScheduleRangeState | null
  professional: ScheduleColumn | undefined
  chosenMinutes: number
  /** Próximo hueco de quien se eligió, desde ahora. */
  nextFree: { startsAt: string; endsAt: string } | null
  /** Si el servicio tiene quien lo atienda en la sede: la agenda solo ofrece a esas personas. */
  attending: { specialtyName: string } | null
  /** «09:00 a 13:00» por cada turno de quien se eligió ese día. */
  hoursThatDay: string[]
  loading: boolean
  failed: boolean
  ready: boolean
  marker: ScheduleRangeMarker | undefined
  choose: (value: ScheduleRangeValue) => void
  goToDate: (date: string) => void
  pickDentist: (id: string | null) => void
  /** Cambia la duración conservando la hora de inicio. */
  resize: (minutes: number) => void
  refetch: () => void
}

/**
 * El «cuándo» de una cita, igual al reservar y al reprogramar: a quién se
 * mira, qué día y el bloque sobre las horas libres que devuelve el servicio.
 */
export function useWhen(input: WhenInput): WhenState {
  const { branchId, timeZone, today, toneOf, duration, moving } = input
  const [dentistFilter, setDentistFilter] = React.useState<string | null>(
    input.dentistUserId ?? null,
  )
  const [date, setDate] = React.useState(input.date && input.date > today ? input.date : today)
  const [value, setValue] = React.useState<ScheduleRangeValue | null>(() =>
    input.startsAt && input.dentistUserId
      ? {
          columnId: input.dentistUserId,
          start: input.startsAt,
          end: new Date(Date.parse(input.startsAt) + duration * 60000).toISOString(),
        }
      : null,
  )
  const week = React.useMemo(() => weekDates(date), [date])
  const from = minutesToInstant(week[0] ?? date, 0, timeZone)
  const to = minutesToInstant(addDays(week[6] ?? date, 1), 0, timeZone)
  const ignore = moving?.id
  const serviceId = input.serviceId
  const availabilityQuery = useQuery({
    queryKey: ["agenda-availability", branchId, from, to, ignore ?? null, serviceId ?? null],
    queryFn: () =>
      apiFetch<{ data: AgendaAvailability }>(
        `/api/agenda/availability?branchId=${branchId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${ignore ? `&ignoreAppointmentId=${ignore}` : ""}${serviceId ? `&serviceId=${serviceId}` : ""}`,
      ),
    enabled: input.enabled ?? true,
    placeholderData: (previous) => previous,
  })
  const availability = availabilityQuery.data?.data
  const team = React.useMemo(
    (): ScheduleColumn[] =>
      (availability?.professionals ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        tone: toneOf(item.id),
      })),
    [availability, toneOf],
  )
  // Si quien se miraba no atiende el servicio elegido, se ve a quienes sí lo atienden.
  const lanes = React.useMemo(
    () =>
      dentistFilter && team.some((item) => item.id === dentistFilter)
        ? team.filter((item) => item.id === dentistFilter)
        : team,
    [team, dentistFilter],
  )
  const free = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.free ?? []).map((item) => ({
        columnId: item.dentistUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const open = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.open ?? []).map((item) => ({
        columnId: item.dentistUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const movingFrom = moving ? Date.parse(moving.startsAt) : 0
  const movingTo = moving ? Date.parse(moving.endsAt) : 0
  const movingDentist = moving?.dentistUserId

  /** Primer hueco del día donde cabe la cita entre quienes se miran; si no cabe entera, el primero que haya. */
  const firstFit = React.useCallback(
    (day: string, columns: ScheduleColumn[], minutes: number): ScheduleRangeValue | null => {
      const ids = new Set(columns.map((item) => item.id))
      const sameDay = free
        .filter((item) => ids.has(item.columnId) && dayRangeOf(item.start, item.end, day, timeZone))
        .flatMap((item) => {
          const start = Date.parse(item.start)
          const end = Date.parse(item.end)
          // Al reprogramar, el sitio donde ya está la cita no se propone: se parte el tramo.
          if (item.columnId === movingDentist && start < movingTo && end > movingFrom) {
            return [
              { columnId: item.columnId, start, end: movingFrom },
              { columnId: item.columnId, start: movingTo, end },
            ]
          }
          return [{ columnId: item.columnId, start, end }]
        })
        // Lo libre de hoy empieza «ahora»: el bloque arranca en el siguiente cuarto de hora.
        .map((item) => ({ ...item, start: Math.ceil(item.start / SNAP_MS) * SNAP_MS }))
        .filter((item) => item.end - item.start >= SNAP_MS)
        .sort((a, b) => a.start - b.start)
      const fits = sameDay.filter((item) => item.end - item.start >= minutes * 60000)
      // Mover suele ser «un poco más tarde»: primero lo que viene después de la cita.
      // Una cita que se mueve no se encoge: si no cabe entera, no se propone nada.
      const pick =
        fits.find((item) => item.start >= movingTo) ?? fits[0] ?? (moving ? undefined : sameDay[0])
      if (!pick) return null
      return {
        columnId: pick.columnId,
        start: new Date(pick.start).toISOString(),
        end: new Date(Math.min(pick.start + minutes * 60000, pick.end)).toISOString(),
      }
    },
    [free, timeZone, moving, movingDentist, movingFrom, movingTo],
  )
  // Mientras la persona no haya movido el bloque, se propone el primer hueco de lo que mira.
  const touched = React.useRef(Boolean(input.startsAt && input.dentistUserId))
  const seedPending = React.useRef(touched.current)
  const autoDate = React.useRef(!touched.current && !moving)
  React.useEffect(() => {
    if (!availability) return
    if (seedPending.current) {
      // El hueco tocado en la rejilla puede ser más corto que una cita regular: el bloque toma el hueco.
      seedPending.current = false
      setValue((current) => {
        if (!current) return current
        const room = free.find(
          (item) =>
            item.columnId === current.columnId &&
            item.start <= current.start &&
            item.end > current.start,
        )
        return room && room.end < current.end ? { ...current, end: room.end } : current
      })
      return
    }
    if (touched.current) return
    const fit = firstFit(date, lanes, duration)
    if (!fit && autoDate.current && date === today) {
      // Al abrir, si ese día ya no queda nada, se va al próximo día con hueco.
      autoDate.current = false
      const ids = new Set(lanes.map((item) => item.id))
      const next = availability.professionals
        .flatMap((item) => (ids.has(item.id) && item.nextFree ? [item.nextFree.startsAt] : []))
        .sort()[0]
      const nextDate = next ? zonedDateOf(next, timeZone) : date
      if (nextDate !== date) {
        setDate(nextDate)
        return
      }
    }
    autoDate.current = false
    setValue(fit)
  }, [availability, free, date, lanes, duration, firstFit, timeZone, today])

  const choose = (next: ScheduleRangeValue) => {
    touched.current = true
    setValue(next)
  }
  // El bloque de otro día o de alguien que ya no se mira deja de valer.
  const shown =
    value &&
    zonedDateOf(value.start, timeZone) === date &&
    lanes.some((item) => item.id === value.columnId)
      ? value
      : null
  const marker = React.useMemo((): ScheduleRangeMarker | undefined => {
    if (!moving) return undefined
    const range = dayRangeOf(moving.startsAt, moving.endsAt, date, timeZone)
    return range
      ? {
          columnId: moving.dentistUserId,
          start: moving.startsAt,
          end: moving.endsAt,
          label: `Ahora está aquí, ${hourLabel(range.startMinutes)}`,
        }
      : undefined
  }, [moving, date, timeZone])

  return {
    input,
    team,
    lanes,
    free,
    open,
    date,
    week,
    dentistFilter,
    shown,
    state: shown ? scheduleRangeState(shown, { free, open, timeZone }) : null,
    professional: team.find((item) => item.id === shown?.columnId),
    chosenMinutes: shown ? minutesBetween(shown.start, shown.end) : duration,
    nextFree:
      availability?.professionals.find((item) => item.id === shown?.columnId)?.nextFree ?? null,
    attending: availability?.attending ? { specialtyName: availability.attending.specialtyName } : null,
    hoursThatDay: shown
      ? open
          .filter((item) => item.columnId === shown.columnId)
          .flatMap((item) => {
            const range = dayRangeOf(item.start, item.end, date, timeZone)
            return range
              ? [`${hourLabel(range.startMinutes)} a ${hourLabel(range.endMinutes)}`]
              : []
          })
      : [],
    loading: availabilityQuery.isLoading || availabilityQuery.isPlaceholderData,
    failed: availabilityQuery.isError,
    ready: availability !== undefined,
    marker,
    choose,
    goToDate: (next) => {
      touched.current = false
      setDate(next)
    },
    pickDentist: (next) => {
      touched.current = false
      setDentistFilter(next)
    },
    resize: (minutes) => {
      if (!value) return
      choose({ ...value, end: new Date(Date.parse(value.start) + minutes * 60000).toISOString() })
    },
    refetch: () => void availabilityQuery.refetch(),
  }
}

/**
 * Los campos del «cuándo»: profesional, días de la semana, horas libres y lo
 * elegido en una línea. Al reprogramar, el profesional y la duración ya están
 * decididos: solo se elige día y hora, y cambiar de profesional queda a un toque.
 */
export function WhenFields({ when }: { when: WhenState }) {
  const { timeZone, today, now, duration } = when.input
  const { date, week, shown, state, professional } = when
  const moving = when.input.moving != null
  const [changing, setChanging] = React.useState(false)
  const current = when.team.find((item) => item.id === when.input.moving?.dentistUserId)
  return (
    <>
      {moving && !changing ? (
        <div className="flex flex-wrap items-center gap-x-2">
          <span className="min-w-0 flex-1 text-sm">
            <span className="text-muted-foreground">Con </span>
            <span className="font-semibold">{current?.label ?? "su profesional"}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="-mr-2.5 text-primary"
            onClick={() => setChanging(true)}
          >
            Cambiar de profesional
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <span className="text-sm font-medium">Profesional</span>
          <ScheduleResourceChips
            wrap
            label="Profesional"
            resources={when.team}
            formatLabel={(item) => shortName(item.label)}
            value={when.dentistFilter && when.team.some((item) => item.id === when.dentistFilter) ? when.dentistFilter : null}
            allLabel="Cualquiera"
            onChange={when.pickDentist}
          />
        </div>
      )}

      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm font-medium">Cuándo</span>
          <DatePickerButton
            size="sm"
            align="end"
            min={today}
            value={date}
            onChange={when.goToDate}
            aria-label="Ir a otra fecha"
          >
            <CalendarDays aria-hidden />
            <span className="first-letter:uppercase">
              {formatMonthLong(date)}
            </span>
          </DatePickerButton>
        </div>
        <ScheduleDayStrip
          dates={week.slice(0, 6).includes(date) ? week.slice(0, 6) : week}
          value={date}
          today={today}
          onChange={when.goToDate}
          onPrevious={() => when.goToDate(addDays(date, -7) < today ? today : addDays(date, -7))}
          onNext={() => when.goToDate(addDays(date, 7))}
        />
        {!when.ready && !when.failed ? (
          <Skeleton className="h-56 w-full rounded-2xl" />
        ) : when.team.length === 0 && when.ready ? (
          <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
            Ningún profesional tiene horario en esta sede. Sin horario no se puede reservar.
          </p>
        ) : (
          <ScheduleRangePicker
            label={`Horas del ${formatDateLong(date).toLocaleLowerCase("es")}`}
            lanes={when.lanes}
            date={date}
            timeZone={timeZone}
            free={when.free}
            open={when.open}
            value={shown}
            onChange={when.choose}
            defaultMinutes={duration}
            resizable={!moving}
            marker={when.marker}
            now={now}
          />
        )}
        {shown ? (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-bold">
                {rangeSaid(shown.start, shown.end, timeZone, today)}
              </span>{" "}
              <span className="text-muted-foreground">con {professional?.label}</span>
            </span>
            {moving ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Dura ${formatSpan(when.chosenMinutes)}. Cambiar la duración`}
                    />
                  }
                >
                  {formatSpan(when.chosenMinutes)}
                  <ChevronDown aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {DURATIONS.map((minutes) => (
                    <DropdownMenuItem key={minutes} onClick={() => when.resize(minutes)}>
                      {formatSpan(minutes)}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ) : when.loading ? (
          <DataRefreshMarker message="Buscando horas libres…" />
        ) : (
          <p className="text-sm text-muted-foreground">
            {moving
              ? "Ese día no queda un hueco donde quepa la cita. Prueba otro día."
              : "No queda nada libre este día. Prueba otro día u otro profesional."}
          </p>
        )}
        {state === "taken" ? (
          <p role="alert" className="text-sm text-destructive">
            A esa hora {professional?.label} ya está ocupado. Mueve el bloque a una zona blanca.
          </p>
        ) : state === "outside" ? (
          <p className="text-sm text-warning">
            Esa hora queda fuera del horario de {professional?.label}.
          </p>
        ) : null}
        {when.failed ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo consultar la disponibilidad.{" "}
            <Button type="button" variant="outline" size="sm" onClick={when.refetch}>
              Reintentar
            </Button>
          </p>
        ) : null}
      </div>
    </>
  )
}
