import { Button, Field, FieldLabel, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { EmptyState, ErrorState, LoadingState, useFieldContext, useFieldControl } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { z } from "zod"
import { ApiError } from "../../lib/api"
import { dayKey } from "../../lib/booking-days"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"

/**
 * La semana de horarios libres de las páginas públicas: «Su enlace» para
 * reservar, cambiar su cita o agendar lo que aceptó, y el portal para
 * cambiar la cita. En pantalla ancha la semana se ve entera, un día por
 * columna; en teléfono, un día a la vez con mañana y tarde. Solo muestra lo
 * que el servidor entrega libre: nunca calcula disponibilidad.
 */
export interface WeekSlot {
  startsAt: string
  endsAt: string
  professionalUserId: string
  professionalName: string
  roomId: string | null
}

const DAY_MS = 86_400_000
const WEEK_DAYS = 7
/** Cuántas semanas hacia adelante se puede mirar. */
export const MAX_WEEKS = 8
/** Sin preferencia de profesional: se ofrece cada hora con quien la tenga libre. */
export const ANYONE = "cualquiera"

export { dayKey }

export function hourOf(instant: string, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(instant)))
}

export function timeLabel(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(instant))
}

export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function longDay(instant: string, timeZone: string): string {
  return capital(new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(instant)))
}

export function shortDay(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric" }).format(new Date(instant))
}

function monthName(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, month: "long" }).format(new Date(instant)).toLowerCase()
}

function dayParts(instant: string, timeZone: string): { weekday: string; number: string } {
  const parts = new Intl.DateTimeFormat(activeOrgLocale(), { timeZone, weekday: "long", day: "numeric" }).formatToParts(new Date(instant))
  return {
    weekday: capital(parts.find((part) => part.type === "weekday")?.value ?? ""),
    number: parts.find((part) => part.type === "day")?.value ?? "",
  }
}

/** El lunes de la semana que se mira, en la hora del dispositivo. */
function weekStart(offset: number): Date {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7) + offset * WEEK_DAYS)
  return start
}

export interface UseWeekSlotsOptions {
  /** Identifica la consulta: cambia con la sede o la cita. */
  queryKey: readonly unknown[]
  fetchSlots: (range: { from: string; to: string }) => Promise<{ slots: WeekSlot[]; timeZone: string }>
  enabled: boolean
  /** Zona de la sede mientras aún no llegan los horarios. */
  fallbackTimeZone?: string | null
}

/** El estado de la semana que se mira: semana, día, profesional y los horarios de cada día. */
export function useWeekSlots(options: UseWeekSlotsOptions) {
  const queryClient = useQueryClient()
  const [week, setWeek] = useState(0)
  const [day, setDay] = useState<string | null>(null)
  const [professional, setProfessional] = useState<string>(ANYONE)
  // La semana que se mira: de lunes a domingo, sin lo que ya pasó.
  const range = useMemo(() => {
    const start = weekStart(week)
    const now = new Date()
    now.setMinutes(0, 0, 0)
    return {
      start: start.toISOString(),
      from: new Date(Math.max(start.getTime(), now.getTime())).toISOString(),
      to: new Date(start.getTime() + WEEK_DAYS * DAY_MS).toISOString(),
    }
  }, [week])
  const query = useQuery({
    queryKey: [...options.queryKey, range.from],
    queryFn: () => options.fetchSlots({ from: range.from, to: range.to }),
    enabled: options.enabled,
    retry: false,
  })
  const timeZone = query.data?.timeZone ?? options.fallbackTimeZone ?? activeOrgTimeZone()
  const allSlots = query.data?.slots ?? []
  // Con quién: los profesionales que tienen algún horario libre esta semana.
  const professionals = useMemo(() => {
    const byId = new Map<string, string>()
    for (const slot of allSlots) byId.set(slot.professionalUserId, slot.professionalName)
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es"))
  }, [allSlots])
  const professionalFilter = professionals.some((item) => item.id === professional) ? professional : ANYONE
  // Un horario por hora de inicio: sin preferencia, si varios profesionales lo tienen libre se ofrece una sola vez.
  // Se muestran los días de la semana que aún no pasaron; sábado y domingo, solo si la clínica atiende.
  const days = useMemo(() => {
    const byDay = new Map<string, WeekSlot[]>()
    const seen = new Set<string>()
    for (const slot of allSlots) {
      if (professionalFilter !== ANYONE && slot.professionalUserId !== professionalFilter) continue
      if (seen.has(slot.startsAt)) continue
      seen.add(slot.startsAt)
      const key = dayKey(slot.startsAt, timeZone)
      byDay.set(key, [...(byDay.get(key) ?? []), slot])
    }
    const today = dayKey(new Date().toISOString(), timeZone)
    return Array.from({ length: WEEK_DAYS }, (_, index) => {
      // Al mediodía, para que el día no cambie al pasarlo a la zona de la sede.
      const instant = new Date(new Date(range.start).getTime() + index * DAY_MS + DAY_MS / 2).toISOString()
      const key = dayKey(instant, timeZone)
      return { key, instant, weekend: index >= 5, slots: byDay.get(key) ?? [] }
    }).filter((item) => item.key >= today && (!item.weekend || item.slots.length > 0))
  }, [allSlots, professionalFilter, range.start, timeZone])
  const activeDay = days.find((item) => item.key === day && item.slots.length > 0) ?? days.find((item) => item.slots.length > 0)
  const withWhom = professionalFilter === ANYONE ? null : (professionals.find((item) => item.id === professionalFilter)?.name ?? null)
  return {
    query,
    week,
    timeZone,
    professionals,
    professionalFilter,
    days,
    activeDay,
    withWhom,
    range,
    setDay,
    setProfessional: (value: string) => {
      setProfessional(value)
      setDay(null)
    },
    changeWeek: (next: number) => {
      setWeek(Math.min(MAX_WEEKS, Math.max(0, next)))
      setDay(null)
    },
    reset: () => {
      setWeek(0)
      setDay(null)
      setProfessional(ANYONE)
    },
    /** Ese horario pudo ocuparse mientras elegía: se vuelve a pedir lo libre. */
    refresh: () => void queryClient.invalidateQueries({ queryKey: [...options.queryKey] }),
  }
}

export type WeekSlotsState = ReturnType<typeof useWeekSlots>

/** «Profesional»: cualquiera o uno de los que tienen horarios esta semana. */
export function ProfessionalSelect({ state, id, onChange }: { state: WeekSlotsState; id: string; onChange?: () => void }) {
  if (state.professionals.length === 0) return null
  return (
    <Field>
      <FieldLabel htmlFor={id}>Profesional</FieldLabel>
      <Select
        value={state.professionalFilter}
        onValueChange={(value) => {
          state.setProfessional(value ?? ANYONE)
          onChange?.()
        }}
      >
        <SelectTrigger id={id} className="min-h-11 w-full">
          <SelectValue>
            {state.professionalFilter === ANYONE ? "Cualquier profesional" : (state.professionals.find((item) => item.id === state.professionalFilter)?.name ?? "")}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANYONE}>Cualquier profesional</SelectItem>
          {state.professionals.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/**
 * Los horarios libres de la semana que se mira. El botón que reserva o
 * cambia lo pone la página: este bloque solo deja elegir. Si falta elegir o
 * el horario se ocupó, `error` lo dice dentro del bloque, sobre los horarios.
 */
export function WeekSlotsGrid({
  state,
  chosen,
  onChoose,
  minutes,
  error = null,
}: {
  state: WeekSlotsState
  chosen: WeekSlot | null
  onChoose: (slot: WeekSlot | null) => void
  minutes: number | null
  /** Lo que hay que corregir en la elección, con el id que la enlaza (`aria-describedby`). */
  error?: { id: string; message: string } | null
}) {
  const { timeZone, days, activeDay, week, withWhom, query } = state
  const morning = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) < 12) ?? []
  const afternoon = activeDay?.slots.filter((slot) => hourOf(slot.startsAt, timeZone) >= 12) ?? []
  // El título nombra la semana de calendario (de lunes a viernes, o hasta el fin de semana si se atiende),
  // aunque de la semana en curso ya no se muestren los días que pasaron.
  const monday = new Date(new Date(state.range.start).getTime() + DAY_MS / 2).toISOString()
  const lastShown = days[days.length - 1]
  const weekEnd = lastShown?.weekend ? lastShown.instant : new Date(new Date(monday).getTime() + 4 * DAY_MS).toISOString()
  const weekTitle = `Semana del ${dayParts(monday, timeZone).number} al ${dayParts(weekEnd, timeZone).number} de ${monthName(weekEnd, timeZone)}`
  const emptyDays = days.filter((item) => item.slots.length === 0).map((item) => longDay(item.instant, timeZone).split(" de ")[0]?.toLowerCase() ?? "")
  const changeWeek = (next: number) => {
    state.changeWeek(next)
    onChoose(null)
  }
  const pick = (slot: WeekSlot) => {
    state.setDay(dayKey(slot.startsAt, timeZone))
    onChoose(slot)
  }
  const slotButton = (slot: WeekSlot, compact: boolean) => {
    const active = chosen?.startsAt === slot.startsAt && chosen.professionalUserId === slot.professionalUserId
    return (
      <Button
        key={`${slot.startsAt}-${slot.professionalUserId}`}
        type="button"
        variant={active ? "default" : "outline"}
        className={compact ? "min-h-10 w-full px-1 text-sm" : "min-h-11"}
        aria-pressed={active}
        aria-label={`${longDay(slot.startsAt, timeZone)}, ${timeLabel(slot.startsAt, timeZone)}`}
        onClick={() => pick(slot)}
      >
        {timeLabel(slot.startsAt, timeZone)}
      </Button>
    )
  }
  return (
    <section
      aria-label="Horarios libres"
      aria-invalid={error ? true : undefined}
      aria-describedby={error?.id}
      tabIndex={error ? -1 : undefined}
      className="flex min-w-0 flex-col gap-4 rounded-2xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <p className="font-semibold">{weekTitle}</p>
          <p className="text-sm text-muted-foreground">
            {[withWhom ? `Con ${withWhom}` : "Con quien tenga libre", minutes ? `horarios de ${minutes} minutos` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="icon" className="size-11" aria-label="Semana anterior" disabled={week === 0} onClick={() => changeWeek(week - 1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon" className="size-11" aria-label="Semana siguiente" disabled={week >= MAX_WEEKS} onClick={() => changeWeek(week + 1)}>
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      {error ? (
        <p id={error.id} role="alert" className="text-sm font-medium text-destructive">
          {error.message}
        </p>
      ) : null}

      {query.isPending ? (
        <LoadingState kind="indeterminate" message="Buscando horarios libres…" />
      ) : query.isError ? (
        <ErrorState title="No pudimos cargar los horarios" message="Vuelve a intentarlo en un momento." onRetry={() => void query.refetch()} />
      ) : activeDay === undefined ? (
        <EmptyState
          title="No quedan horarios esta semana"
          description={withWhom ? "Prueba con otro profesional o mira la semana siguiente." : "Mira la semana siguiente o escríbenos por el chat y te ayudamos."}
          actionLabel={week < MAX_WEEKS ? "Ver la semana siguiente" : undefined}
          onAction={week < MAX_WEEKS ? () => changeWeek(week + 1) : undefined}
        />
      ) : (
        <>
          {/* Pantalla ancha: la semana entera, un día por columna. */}
          <div className="hidden gap-2 lg:grid" style={{ gridTemplateColumns: `repeat(${Math.max(days.length, 5)}, minmax(0, 1fr))` }} data-testid="semana">
            {days.map((item) => {
              const parts = dayParts(item.instant, timeZone)
              const selected = chosen !== null && dayKey(chosen.startsAt, timeZone) === item.key
              return (
                <fieldset key={item.key} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" aria-label={longDay(item.instant, timeZone)}>
                  <div className={`flex flex-col items-center rounded-xl py-2 ${selected ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    <span className="text-xs">{parts.weekday}</span>
                    <span className="text-lg font-semibold">{parts.number}</span>
                  </div>
                  {item.slots.length === 0 ? (
                    <p className="rounded-xl border border-dashed p-2 text-center text-xs text-muted-foreground">No quedan horarios</p>
                  ) : (
                    item.slots.map((slot) => slotButton(slot, true))
                  )}
                </fieldset>
              )
            })}
          </div>

          {/* Teléfono: un día a la vez, con los días en una sola fila. */}
          <div className="flex flex-col gap-4 lg:hidden">
            <ScrollArea horizontal className="min-w-0">
              <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0 pb-2" aria-label="Día">
                {days.map((item) => {
                  const parts = dayParts(item.instant, timeZone)
                  const empty = item.slots.length === 0
                  const active = activeDay.key === item.key
                  return (
                    <Button
                      key={item.key}
                      type="button"
                      variant={active ? "default" : "outline"}
                      className="flex h-16 min-w-14 max-w-24 flex-1 flex-col gap-0.5 px-1"
                      disabled={empty}
                      aria-pressed={active}
                      aria-label={`${longDay(item.instant, timeZone)}${empty ? ", no quedan horarios" : ""}`}
                      onClick={() => {
                        state.setDay(item.key)
                        onChoose(null)
                      }}
                    >
                      <span className="text-xs">{parts.weekday.slice(0, 3)}</span>
                      <span className="text-lg font-semibold">{parts.number}</span>
                    </Button>
                  )
                })}
              </fieldset>
            </ScrollArea>
            {emptyDays.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {emptyDays.length === 1
                  ? `El ${emptyDays[0]} no quedan horarios.`
                  : `El ${emptyDays.slice(0, -1).join(", el ")} y el ${emptyDays[emptyDays.length - 1]} no quedan horarios.`}
              </p>
            ) : null}
            {[
              { label: "Mañana", slots: morning },
              { label: "Tarde", slots: afternoon },
            ]
              .filter((group) => group.slots.length > 0)
              .map((group) => (
                <fieldset key={group.label} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
                  <legend className="mb-2 p-0 text-sm font-semibold text-muted-foreground">{group.label}</legend>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{group.slots.map((slot) => slotButton(slot, false))}</div>
                </fieldset>
              ))}
            {chosen ? <p className="text-sm text-muted-foreground">Con {chosen.professionalName}.</p> : null}
          </div>
          <p className="text-sm text-muted-foreground">Solo se muestran los horarios libres. Si alguien toma uno mientras eliges, te avisamos antes de reservar.</p>
        </>
      )}
    </section>
  )
}

/**
 * La semana de horarios como campo de `useAppForm` (`form.AppField name="slot"`):
 * el valor es el horario elegido y su error («Elige un día y una hora», «Ese
 * horario acaba de ocuparse») se dice dentro del bloque.
 */
export function WeekSlotsField({ state, minutes }: { state: WeekSlotsState; minutes: number | null }) {
  const field = useFieldContext<WeekSlot | null>()
  const { control, errors, errorId } = useFieldControl({ hasDescription: false })
  return (
    <WeekSlotsGrid
      state={state}
      chosen={field.state.value}
      onChoose={(slot) => field.handleChange(slot)}
      minutes={minutes}
      error={control.invalid ? { id: errorId, message: errors.join(" ") } : null}
    />
  )
}

/** Lo que se dice cuando el horario elegido dejó de estar libre. */
export const SLOT_TAKEN = "Ese horario acaba de ocuparse. Elige otro de la lista."

/** Los rechazos de disponibilidad: otra cita, un bloqueo o sin unidad libre a esa hora. */
const AVAILABILITY_CODES: Record<string, true> = { APPOINTMENT_CONFLICT: true, SCHEDULE_BLOCKED: true, NO_ROOM: true }

/**
 * El servidor rechazó el horario porque ya no está libre (y no por otra cosa,
 * que se dice con sus palabras): se vuelve a pedir lo libre y se dice en el
 * bloque de horarios. Devuelve el error para el campo `slot`, o el mismo si no lo es.
 */
export function slotTakenError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409 || !AVAILABILITY_CODES[error.shape.code ?? ""]) return error
  return new ApiError(409, { ...error.shape, message: SLOT_TAKEN, fields: { slot: SLOT_TAKEN } })
}

/** Lo que el servidor dice del horario (`startsAt`, quién o dónde) va al bloque de horarios. */
export const SLOT_FIELD_MAP = { startsAt: "slot", professionalUserId: "slot", roomId: "slot" } as const

/** Elegir un horario es obligatorio: se dice dentro del bloque. */
export const chosenSlotSchema = (message: string) =>
  z.custom<WeekSlot | null>().refine((slot) => slot !== null, message)
