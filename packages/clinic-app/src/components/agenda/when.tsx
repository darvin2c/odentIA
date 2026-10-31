import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  FieldError,
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
  useFieldControl,
  weekDates,
  withFieldGroup,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { CalendarDays, ChevronDown } from "lucide-react"
import * as React from "react"
import type { AgendaAvailability } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { appWords } from "../../lib/product-words"
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
  professionalUserId?: string | null
  /** Hueco ya elegido antes de abrir (tocado en la rejilla). */
  startsAt?: string
  /**
   * Reprogramar: la cita que se mueve. Su hueco cuenta como libre, se marca
   * dónde está y el bloque se propone en otro sitio.
   */
  moving?: { id: string; professionalUserId: string; startsAt: string; endsAt: string }
  /**
   * Nombre de quien se eligió, para poder reservar con alguien que no tiene
   * horario en la sede: no llega con la disponibilidad.
   */
  professionalLabel?: string
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
  professionalFilter: string | null
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
  pickProfessional: (id: string | null) => void
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
  const [professionalFilter, setProfessionalFilter] = React.useState<string | null>(
    input.professionalUserId ?? null,
  )
  const [date, setDate] = React.useState(input.date && input.date > today ? input.date : today)
  const [value, setValue] = React.useState<ScheduleRangeValue | null>(() =>
    input.startsAt && input.professionalUserId
      ? {
          columnId: input.professionalUserId,
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
  const seedProfessional = input.professionalUserId
  const seedLabel = input.professionalLabel
  const team = React.useMemo((): ScheduleColumn[] => {
    const listed: ScheduleColumn[] = (availability?.professionals ?? []).map((item) => ({
      id: item.id,
      label: item.label,
      tone: toneOf(item.id),
    }))
    return seedProfessional && seedLabel && !listed.some((item) => item.id === seedProfessional)
      ? [...listed, { id: seedProfessional, label: seedLabel, tone: toneOf(seedProfessional) }]
      : listed
  }, [availability, toneOf, seedProfessional, seedLabel])
  // Si quien se miraba no atiende el servicio elegido, se ve a quienes sí lo atienden.
  const lanes = React.useMemo(
    () =>
      professionalFilter && team.some((item) => item.id === professionalFilter)
        ? team.filter((item) => item.id === professionalFilter)
        : team,
    [team, professionalFilter],
  )
  const free = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.free ?? []).map((item) => ({
        columnId: item.professionalUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const open = React.useMemo(
    (): ScheduleAvailability[] =>
      (availability?.open ?? []).map((item) => ({
        columnId: item.professionalUserId,
        start: item.startsAt,
        end: item.endsAt,
      })),
    [availability],
  )
  const movingFrom = moving ? Date.parse(moving.startsAt) : 0
  const movingTo = moving ? Date.parse(moving.endsAt) : 0
  const movingProfessional = moving?.professionalUserId

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
          if (item.columnId === movingProfessional && start < movingTo && end > movingFrom) {
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
    [free, timeZone, moving, movingProfessional, movingFrom, movingTo],
  )
  // Mientras la persona no haya movido el bloque, se propone el primer hueco de lo que mira.
  const touched = React.useRef(Boolean(input.startsAt && input.professionalUserId))
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
          columnId: moving.professionalUserId,
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
    professionalFilter,
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
    pickProfessional: (next) => {
      touched.current = false
      setProfessionalFilter(next)
    },
    resize: (minutes) => {
      if (!value) return
      choose({ ...value, end: new Date(Date.parse(value.start) + minutes * 60000).toISOString() })
    },
    refetch: () => void availabilityQuery.refetch(),
  }
}

/**
 * Lo que se le dice al servidor de una excepción ya avisada. La hora ocupada puede
 * caer también fuera del horario, y al revés: con una se aceptan las dos.
 */
export function exceptionFlags(
  exception: "outside" | "taken" | null | undefined,
): { outsideSchedule?: true; overrideBusy?: true } {
  return exception ? { outsideSchedule: true, overrideBusy: true } : {}
}

/** El «cuándo» en el formulario que lo usa (bajo `when`): los datos se llaman como en el cuerpo. */
export interface WhenValues {
  startsAt: string
  professionalUserId: string
}

export const EMPTY_WHEN: WhenValues = { startsAt: "", professionalUserId: "" }

/**
 * Dónde cae cada rechazo de reservar o mover: la hora, o quien atiende. La
 * unidad dental la pone la agenda con el hueco, así que su choque se dice
 * junto a la hora (el mensaje nombra la unidad).
 */
export const WHEN_FIELD_MAP: Record<string, string> = {
  startsAt: "when.startsAt",
  endsAt: "when.startsAt",
  roomId: "when.startsAt",
  professionalUserId: "when.professionalUserId",
}

/** Lo que impide enviar el hueco elegido, dicho junto a las horas; nada si se puede. */
function slotProblem(when: WhenState): string | undefined {
  const { shown } = when
  const moving = when.input.moving
  if (!shown) return moving ? "Elige la nueva hora: toca un hueco libre." : "Elige la hora: toca un hueco libre."
  // Fuera de horario o sobre algo ocupado no es un error: se avisa junto a las horas y se puede seguir.
  if (!moving) return undefined
  if (
    shown.columnId === moving.professionalUserId &&
    Date.parse(shown.start) === Date.parse(moving.startsAt) &&
    Date.parse(shown.end) === Date.parse(moving.endsAt)
  ) {
    return "La cita ya está a esa hora. Mueve el bloque a la nueva hora."
  }
  return undefined
}

/**
 * Los campos del «cuándo»: profesional, días de la semana, horas libres y lo
 * elegido en una línea. Al reprogramar, el profesional y la duración ya están
 * decididos: solo se elige día y hora, y cambiar de profesional queda a un toque.
 *
 * Va en el formulario que reserva o mueve (`fields="when"`): lo elegido se
 * copia a `when.startsAt` y `when.professionalUserId`, y lo que diga el
 * servidor de la hora, la unidad o el profesional se dice en su sitio
 * (`WHEN_FIELD_MAP`).
 */
export const WhenFields = withFieldGroup({
  defaultValues: EMPTY_WHEN,
  props: {} as { when: WhenState },
  render: function WhenFieldsRender({ group, when }) {
    const start = when.shown?.start ?? ""
    const columnId = when.shown?.columnId ?? ""
    // Lo elegido pasa al formulario sin contar como cambio: al cambiarlo se borra lo que dijo el servidor.
    React.useEffect(() => {
      group.setFieldValue("startsAt", start, { dontUpdateMeta: true })
      group.setFieldValue("professionalUserId", columnId, { dontUpdateMeta: true })
    }, [group, start, columnId])
    const problem = slotProblem(when)
    return (
      <>
        <group.AppField name="professionalUserId">{() => <WhenProfessional when={when} />}</group.AppField>
        <group.AppField name="startsAt" validators={{ onSubmit: () => problem }}>
          {() => <WhenSlot when={when} />}
        </group.AppField>
      </>
    )
  },
})

/** Quién atiende: las fichas del equipo o, al reprogramar, el de la cita con «Cambiar». */
function WhenProfessional({ when }: { when: WhenState }) {
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  const moving = when.input.moving != null
  const [changing, setChanging] = React.useState(false)
  const current = when.team.find((item) => item.id === when.input.moving?.professionalUserId)
  const error = control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null
  return moving && !changing ? (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-2">
        <span id={control.id} className="min-w-0 flex-1 text-sm" aria-describedby={control.describedBy}>
          <span className="text-muted-foreground">Con </span>
          <span className="font-semibold">{current?.label ?? "su profesional"}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-2.5 text-primary"
          aria-invalid={control.invalid || undefined}
          aria-describedby={control.describedBy}
          onClick={() => setChanging(true)}
        >
          Cambiar de profesional
        </Button>
      </div>
      {error}
    </div>
  ) : (
    <div className="grid gap-2">
      <span className="text-sm font-medium">Profesional</span>
      <ScheduleResourceChips
        wrap
        aria-label="Profesional"
        id={control.id}
        invalid={control.invalid}
        aria-describedby={control.describedBy}
        onBlur={control.onBlur}
        resources={when.team}
        formatLabel={(item) => shortName(item.label)}
        value={when.professionalFilter && when.team.some((item) => item.id === when.professionalFilter) ? when.professionalFilter : null}
        allLabel="Cualquiera"
        onChange={when.pickProfessional}
      />
      {error}
    </div>
  )
}

/** El día y las horas: el bloque sobre lo libre, lo elegido en una línea y por qué no vale. */
function WhenSlot({ when }: { when: WhenState }) {
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  const { timeZone, today, now, duration } = when.input
  const { date, week, shown, state, professional } = when
  const moving = when.input.moving != null
  return (
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
          aria-label={`Horas del ${formatDateLong(date).toLocaleLowerCase("es")}`}
          id={control.id}
          invalid={control.invalid}
          aria-describedby={control.describedBy}
          onBlur={control.onBlur}
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
          marginMinutes={120}
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
      {/* Tras enviar, lo que impide reservar o mover se dice aquí una sola vez, unido a las horas. */}
      {control.invalid ? (
        <FieldError id={errorId} errors={errors.map((message) => ({ message }))} />
      ) : state === "taken" || state === "outside" ? (
        <div role="status" className="grid gap-1.5 rounded-xl bg-warning-soft p-3 text-sm text-warning">
          <p>
            <strong className="font-bold">
              {state === "taken"
                ? `A esa hora ${professional?.label} tiene otra cita o está bloqueado.`
                : `Es fuera del horario de ${professional?.label}.`}
            </strong>{" "}
            {state === "outside"
              ? when.hoursThatDay.length > 0
                ? `Ese día atiende de ${when.hoursThatDay.join(" y de ")}. `
                : "Ese día no atiende. "
              : ""}
            {state === "taken"
              ? `Se reserva igual en otra ${appWords().room.one}, queda marcada y le llega un aviso.`
              : "Se reserva igual, queda marcada y le llega un aviso."}
          </p>
          {when.nextFree ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2.5 justify-self-start text-warning"
              onClick={() => {
                const next = when.nextFree
                if (!next || !shown) return
                when.goToDate(zonedDateOf(next.startsAt, timeZone))
                when.choose({
                  columnId: shown.columnId,
                  start: next.startsAt,
                  end: new Date(
                    Math.min(Date.parse(next.startsAt) + when.chosenMinutes * 60000, Date.parse(next.endsAt)),
                  ).toISOString(),
                })
              }}
            >
              Usar su próximo hueco: {rangeSaid(when.nextFree.startsAt, when.nextFree.endsAt, timeZone, today)}
            </Button>
          ) : null}
        </div>
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
  )
}
