/**
 * Lo de cada persona del equipo para las presentaciones (Equipo): su horario
 * para presentaciones (franjas por día de la semana, en hora de Lima), su sala
 * fija de videollamada y sus ausencias (días completos o unas horas). Kairós
 * agenda solo dentro de ese horario, fuera de las ausencias y sin chocar con
 * otra presentación; la sala va en la confirmación y el recordatorio.
 *
 * Lo suyo lo cambia cada persona; lo de otra, solo Administración. Lo exige el
 * servidor (`/api/admin/access/team/:userId/…`): aquí solo se muestra lo que
 * dice. Una ausencia que choca con presentaciones lo dice al guardarla, y
 * Kairós las deja en Hoy para decidir («Pasar a…» o «Pedir otra hora»): nada
 * se mueve solo.
 */
import { Button, FieldError, FieldGroup, toast } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import {
  common,
  ErrorState,
  FormDrawer,
  fieldErrorMessages,
  LoadingState,
  PageNotice,
  submitErrorMessage,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { api } from "../lib/api"
import { supportDay, supportTime } from "../lib/support-words"
import { invalidateArm } from "./arm/hoy-links"
import { addDays, limaDay, limaInstant } from "./arm/sale-words"
import { DayField } from "./arm/task-drawer"

const enc = encodeURIComponent

/* ---------- Lo que dice el servidor ---------- */

const absenceSchema = z.object({
  id: z.string(),
  userId: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  reason: z.string().nullable(),
})
export type StaffAbsence = z.infer<typeof absenceSchema>

const hourSchema = z.object({
  weekday: z.number().int(),
  startMin: z.number().int(),
  endMin: z.number().int(),
})
export type StaffHour = z.infer<typeof hourSchema>

export const staffScheduleSchema = z.object({
  userId: z.string(),
  name: z.string(),
  meetingUrl: z.string().nullable(),
  hours: z.array(hourSchema),
  absences: z.array(absenceSchema),
})
export type StaffSchedule = z.infer<typeof staffScheduleSchema>

const conflictSchema = z.object({
  taskId: z.string(),
  clientId: z.string(),
  clientName: z.string(),
  startsAt: z.string(),
})
export type AbsenceConflict = z.infer<typeof conflictSchema>
const addedSchema = z.object({ absence: absenceSchema, conflicts: z.array(conflictSchema) })

export const staffScheduleKey = (userId: string) => ["admin", "staff-schedule", userId] as const

export function useStaffSchedule(userId: string, enabled = true) {
  return useQuery({
    queryKey: staffScheduleKey(userId),
    enabled: enabled && Boolean(userId),
    queryFn: async () =>
      staffScheduleSchema.parse(
        await api<unknown>(`/api/admin/access/team/${enc(userId)}/schedule`),
      ),
  })
}

/* ---------- Palabras ---------- */

/** La semana se lee de lunes a domingo; `weekday` es el del servidor (0 = domingo, en Lima). */
export const WEEK: ReadonlyArray<{ weekday: number; short: string; long: string }> = [
  { weekday: 1, short: "Lun", long: "lunes" },
  { weekday: 2, short: "Mar", long: "martes" },
  { weekday: 3, short: "Mié", long: "miércoles" },
  { weekday: 4, short: "Jue", long: "jueves" },
  { weekday: 5, short: "Vie", long: "viernes" },
  { weekday: 6, short: "Sáb", long: "sábado" },
  { weekday: 0, short: "Dom", long: "domingo" },
]

/** «09:00» de los minutos desde la medianoche (lo que guarda `TimeSelect`). */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

export function timeToMinutes(time: string): number {
  const [h = 0, m = 0] = time.split(":").map(Number)
  return h * 60 + m
}

/** «9:00», «15:30»: como se lee en una frase. */
const clockWords = (minutes: number) => minutesToTime(minutes).replace(/^0(\d)/, "$1")

const rangesWords = (ranges: StaffHour[]) =>
  ranges.map((range) => `${clockWords(range.startMin)} a ${clockWords(range.endMin)}`).join(" y ")

/**
 * El horario en una línea: los días seguidos con las mismas franjas van juntos
 * («Lun a vie, 9:00 a 13:00 y 15:00 a 18:00 · Sáb, 10:00 a 12:00»).
 */
export function hoursSummary(hours: StaffHour[]): string {
  const groups: Array<{ first: string; last: string; words: string }> = []
  let previous: number | null = null
  for (const [position, day] of WEEK.entries()) {
    const ranges = hours
      .filter((range) => range.weekday === day.weekday)
      .sort((a, b) => a.startMin - b.startMin)
    if (ranges.length === 0) continue
    const words = rangesWords(ranges)
    const last = groups.at(-1)
    if (last && last.words === words && previous === position - 1) last.last = day.short
    else groups.push({ first: day.short, last: day.short, words })
    previous = position
  }
  return groups
    .map((group) =>
      group.first === group.last
        ? `${group.first}, ${group.words}`
        : `${group.first} a ${group.last.toLowerCase()}, ${group.words}`,
    )
    .join(" · ")
}

/** Medianoche de Lima (UTC−5 todo el año, sin horario de verano). */
const isLimaMidnight = (iso: string) => supportTime(iso) === "00:00"

/**
 * Una ausencia en palabras: «Del lun 23 nov al mié 25 nov · Vacaciones» (días
 * completos) o «El mar 24 nov, de 15:00 a 17:00» (unas horas).
 */
export function absenceWords(
  absence: Pick<StaffAbsence, "startsAt" | "endsAt" | "reason">,
): string {
  const { startsAt, endsAt } = absence
  let when: string
  if (isLimaMidnight(startsAt) && isLimaMidnight(endsAt)) {
    const first = limaDay(new Date(startsAt))
    const last = limaDay(new Date(Date.parse(endsAt) - 1))
    when =
      first === last
        ? `El ${supportDay(startsAt)}`
        : `Del ${supportDay(startsAt)} al ${supportDay(new Date(Date.parse(endsAt) - 1).toISOString())}`
  } else if (limaDay(new Date(startsAt)) === limaDay(new Date(endsAt))) {
    when = `El ${supportDay(startsAt)}, de ${supportTime(startsAt)} a ${supportTime(endsAt)}`
  } else {
    when = `Del ${supportDay(startsAt)}, ${supportTime(startsAt)}, al ${supportDay(endsAt)}, ${supportTime(endsAt)}`
  }
  return absence.reason ? `${when} · ${absence.reason}` : when
}

/** Lo que se dice al guardar una ausencia que choca (el ítem de Hoy es de Administración). */
export function conflictWords(count: number, isAdmin: boolean): string {
  const hoy = isAdmin ? "Hoy" : "Hoy de Administración"
  return count === 1
    ? `Choca con 1 presentación: queda en ${hoy} para decidir`
    : `Choca con ${count} presentaciones: quedan en ${hoy} para decidir`
}

/** La línea de la persona en Equipo: su horario, su sala y si está o estará ausente. */
export function scheduleLineWords(schedule: StaffSchedule, now: Date = new Date()): string[] {
  const lines = [
    schedule.hours.length
      ? `Presenta: ${hoursSummary(schedule.hours)}`
      : "Sin horario para presentaciones: Kairós no le agenda",
    schedule.meetingUrl ? "Con su sala de videollamada" : "Sin sala de videollamada",
  ]
  const next = schedule.absences[0]
  if (next) {
    const now_ = now.getTime()
    lines.push(
      Date.parse(next.startsAt) <= now_
        ? `Ausente ahora · ${absenceWords(next)}`
        : `Ausente: ${absenceWords(next)}`,
    )
  }
  return lines
}

/** Las líneas de la persona en Equipo (su horario, su sala, su próxima ausencia). */
export function StaffScheduleLine({ userId }: { userId: string }) {
  const schedule = useStaffSchedule(userId)
  if (!schedule.data) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {scheduleLineWords(schedule.data).map((line) => (
        <p key={line} className="[overflow-wrap:anywhere]">
          {line}
        </p>
      ))}
    </div>
  )
}

/** De días completos o de unas horas, a los instantes que guarda el servidor (Lima). */
export function absenceRange(values: AbsenceValues): { startsAt: string; endsAt: string } {
  if (values.kind === "dias")
    return {
      startsAt: limaInstant(values.fromDay, "00:00"),
      endsAt: limaInstant(addDays(values.toDay || values.fromDay, 1), "00:00"),
    }
  return {
    startsAt: limaInstant(values.day, values.startTime),
    endsAt: limaInstant(values.day, values.endTime),
  }
}

/* ---------- Horario y sala ---------- */

interface TurnDraft {
  key: number
  weekday: number
  from: string
  to: string
}
let turnSeq = 1

const scheduleFormSchema = z
  .object({
    turns: z.array(
      z.object({ key: z.number(), weekday: z.number(), from: z.string(), to: z.string() }),
    ),
    meetingUrl: z
      .string()
      .trim()
      .max(500, "Usa como máximo 500 caracteres")
      .refine((value) => value === "" || /^https:\/\/\S+$/.test(value), {
        message: "Pega el enlace de tu sala: empieza con https://",
      }),
  })
  .superRefine(({ turns }, ctx) => {
    turns.forEach((turn, index) => {
      if (timeToMinutes(turn.to) <= timeToMinutes(turn.from))
        ctx.addIssue({
          code: "custom",
          path: ["turns", index, "to"],
          message: "La franja tiene que terminar después de empezar",
        })
    })
  })

/** `hours.3` (lo que rechaza el servidor) → `turns[3].to`, el campo de esa franja. */
function scheduleField(serverField: string): string | undefined {
  const match = /^hours\.(\d+)$/.exec(serverField)
  if (match) return `turns[${match[1]}].to`
  return serverField === "meetingUrl" ? "meetingUrl" : undefined
}

const draftsOf = (hours: StaffHour[]): TurnDraft[] =>
  [...hours]
    .sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin)
    .map((range) => ({
      key: turnSeq++,
      weekday: range.weekday,
      from: minutesToTime(range.startMin),
      to: minutesToTime(range.endMin),
    }))

const sameHours = (a: StaffHour[], b: StaffHour[]) =>
  JSON.stringify([...a].sort((x, y) => x.weekday - y.weekday || x.startMin - y.startMin)) ===
  JSON.stringify([...b].sort((x, y) => x.weekday - y.weekday || x.startMin - y.startMin))

export interface StaffScheduleDrawerProps {
  userId: string
  /** El nombre de la persona, para el título mientras llega lo suyo. */
  name: string
  /** Es quien mira: el título le habla de tú. */
  self: boolean
  isAdmin: boolean
  onClose: () => void
}

/** «Horario y sala»: el horario, la sala y las ausencias de una persona, en un cajón ancho. */
export function StaffScheduleDrawer(props: StaffScheduleDrawerProps) {
  const schedule = useStaffSchedule(props.userId)
  if (!schedule.data)
    return (
      <FormDrawer
        open
        onClose={props.onClose}
        title={props.self ? "Tu horario y tu sala" : `Horario y sala de ${props.name}`}
        onSubmit={(event) => event.preventDefault()}
        isLoading={schedule.isPending}
        hideSubmit
        cancelLabel={common.actions.close}
      >
        {schedule.isError ? (
          <ErrorState
            title="No pude cargar su horario"
            error={schedule.error}
            onRetry={() => void schedule.refetch()}
          />
        ) : (
          <LoadingState message="Cargando el horario…" />
        )}
      </FormDrawer>
    )
  return <ScheduleForm {...props} schedule={schedule.data} />
}

const WIDE = "data-[swipe-axis=x]:sm:[--drawer-content-width:min(42rem,calc(100vw-2rem))]"

function ScheduleForm({
  schedule,
  self,
  isAdmin,
  onClose,
}: StaffScheduleDrawerProps & { schedule: StaffSchedule }) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = React.useState(false)
  /** Lo que chocó con la última ausencia que se guardó: se dice aquí hasta cerrar. */
  const [clash, setClash] = React.useState<AbsenceConflict[]>([])
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: staffScheduleKey(schedule.userId) })
    invalidateArm(queryClient, null)
  }
  // Lo guardado es el valor inicial, una sola vez: las claves de las franjas son nuevas en cada
  // llamada y, recalculadas en cada render, el formulario se volvería a poner sin parar.
  const [initial] = React.useState(() => ({
    turns: draftsOf(schedule.hours),
    meetingUrl: schedule.meetingUrl ?? "",
  }))
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: scheduleFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const hours = value.turns.map((turn) => ({
        weekday: turn.weekday,
        startMin: timeToMinutes(turn.from),
        endMin: timeToMinutes(turn.to),
      }))
      const url = value.meetingUrl.trim()
      const base = `/api/admin/access/team/${enc(schedule.userId)}`
      if (!sameHours(hours, schedule.hours))
        await api(`${base}/hours`, { method: "PUT", body: JSON.stringify({ hours }) })
      if (url !== (schedule.meetingUrl ?? ""))
        await api(`${base}/meeting-url`, {
          method: "PUT",
          body: JSON.stringify({ url: url || null }),
        })
      refresh()
      toast.success("Guardado: Kairós ofrece presentaciones con este horario")
      formApi.reset(value)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: scheduleField })
  const remove = useMutation({
    mutationFn: (absenceId: string) =>
      api(`/api/admin/access/team/absences/${enc(absenceId)}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh()
      setClash([])
      toast.success("Ausencia quitada")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const first = schedule.name.trim().split(/\s+/)[0] || schedule.name

  return (
    <>
      <FormDrawer
        {...surface}
        open
        onClose={onClose}
        title={self ? "Tu horario y tu sala" : `Horario y sala de ${first}`}
        description={
          self
            ? "Kairós agenda presentaciones de 45 minutos solo dentro de tu horario."
            : `Kairós agenda presentaciones de 45 minutos con ${first} solo dentro de su horario.`
        }
        submitLabel="Guardar horario y sala"
        cancelLabel={common.actions.cancel}
        className={WIDE}
      >
        <div className="flex flex-col gap-6">
          <section aria-labelledby="horario-titulo" className="flex flex-col gap-2">
            <h3 id="horario-titulo" className="text-sm font-semibold">
              Horario para presentaciones
            </h3>
            <p className="text-sm text-muted-foreground">
              En hora de Lima. Se ofrecen desde 2 horas después y hasta 14 días, a las :00 y a las
              :30.
            </p>
            <WeekFields form={form} />
          </section>
          <section aria-labelledby="sala-titulo" className="flex flex-col gap-2">
            <h3 id="sala-titulo" className="text-sm font-semibold">
              Sala de videollamada
            </h3>
            <FieldGroup>
              <form.AppField name="meetingUrl">
                {(field) => (
                  <field.TextField
                    id="sala-enlace"
                    label="Enlace de la sala (opcional)"
                    description="El enlace fijo de tu sala de Meet, Zoom o Teams. Va en la confirmación y en el recordatorio de cada presentación."
                    type="url"
                    inputMode="url"
                    placeholder="https://meet.google.com/abc-defg-hij"
                    maxLength={500}
                    autoComplete="off"
                  />
                )}
              </form.AppField>
            </FieldGroup>
          </section>
          <section aria-labelledby="ausencias-titulo" className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id="ausencias-titulo" className="text-sm font-semibold">
                Ausencias
              </h3>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => setAdding(true)}
              >
                <Plus aria-hidden />
                Agregar ausencia
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Se guardan al momento. Mientras no está, Kairós no le agenda y sus tareas salen en Hoy
              del resto.
            </p>
            {clash.length > 0 ? (
              <PageNotice tone="alarma" label={conflictWords(clash.length, isAdmin)}>
                {clash
                  .map(
                    (item) =>
                      `${item.clientName}, el ${supportDay(item.startsAt)} a las ${supportTime(item.startsAt)}`,
                  )
                  .join(" · ")}
                . Nada se mueve solo: se pasan a otra persona o se pide otra hora.
              </PageNotice>
            ) : null}
            {schedule.absences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No tiene ausencias por venir.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {schedule.absences.map((absence) => (
                  <li
                    key={absence.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere]">
                      {absenceWords(absence)}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={remove.isPending}
                      aria-label={`Quitar la ausencia: ${absenceWords(absence)}`}
                      onClick={() => remove.mutate(absence.id)}
                    >
                      Quitar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </FormDrawer>
      {adding ? (
        <AbsenceDrawer
          userId={schedule.userId}
          name={self ? null : first}
          isAdmin={isAdmin}
          onSaved={(conflicts) => {
            setClash(conflicts)
            refresh()
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  )
}

/** La semana con sus franjas: «+ Franja» por día y «×» para quitar una. */
// biome-ignore lint/suspicious/noExplicitAny: el formulario de `ScheduleForm`, con `turns`.
function WeekFields({ form }: { form: any }) {
  const idBase = React.useId()
  const turns = useStore(
    form.store,
    (state: { values: { turns: TurnDraft[] } }) => state.values.turns,
  )
  const submitted = useStore(
    form.store,
    (state: { submissionAttempts: number }) => state.submissionAttempts > 0,
  )
  const indexed = turns.map((turn, index) => ({ turn, index }))
  return (
    <form.Field name="turns" mode="array">
      {/* biome-ignore lint/suspicious/noExplicitAny: el campo de la lista de franjas. */}
      {(weekField: any) => (
        <div className="grid">
          {WEEK.map((day) => {
            const ofDay = indexed.filter((item) => item.turn.weekday === day.weekday)
            const dayId = `${idBase}-${day.weekday}`
            return (
              <fieldset
                key={day.weekday}
                aria-labelledby={dayId}
                className="flex min-w-0 items-start gap-2 border-b py-2 last:border-b-0"
              >
                <span id={dayId} className="flex h-10 w-9 shrink-0 items-center text-sm font-bold">
                  <span aria-hidden>{day.short}</span>
                  <span className="sr-only">{day.long}</span>
                </span>
                <div className="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1.5">
                  {ofDay.length === 0 ? (
                    <span className="flex h-10 items-center text-sm text-muted-foreground">
                      No presenta
                    </span>
                  ) : null}
                  {ofDay.map(({ turn, index }) => (
                    <TurnRow
                      key={turn.key}
                      form={form}
                      index={index}
                      turn={turn}
                      day={day}
                      submitted={submitted}
                      errorId={`${idBase}-${turn.key}-error`}
                    />
                  ))}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-0.5 shrink-0 gap-1 px-2 text-primary"
                  aria-label={`Agregar una franja el ${day.long}`}
                  disabled={turns.length >= 50}
                  onClick={() => {
                    // La segunda franja del día empieza por la tarde: lo habitual es el horario partido.
                    const last = ofDay.at(-1)?.turn
                    const from = last ? Math.min(timeToMinutes(last.to) + 120, 20 * 60) : 9 * 60
                    weekField.pushValue({
                      key: turnSeq++,
                      weekday: day.weekday,
                      from: minutesToTime(from),
                      to: minutesToTime(Math.min(from + 240, 23 * 60 + 45)),
                    })
                  }}
                >
                  <Plus aria-hidden />
                  {/* En el teléfono solo el «+»: la palabra no cabe junto a la franja. */}
                  <span className="hidden sm:inline">Franja</span>
                </Button>
              </fieldset>
            )
          })}
        </div>
      )}
    </form.Field>
  )
}

function TurnRow({
  form,
  index,
  turn,
  day,
  submitted,
  errorId,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: el formulario de `ScheduleForm`, con `turns`.
  form: any
  index: number
  turn: TurnDraft
  day: (typeof WEEK)[number]
  submitted: boolean
  errorId: string
}) {
  return (
    <form.Field name={`turns[${index}].from`}>
      {/* biome-ignore lint/suspicious/noExplicitAny: el campo «desde» de la franja. */}
      {(fromField: any) => (
        <form.Field name={`turns[${index}].to`}>
          {/* biome-ignore lint/suspicious/noExplicitAny: el campo «hasta» de la franja. */}
          {(toField: any) => {
            const errors = fieldErrorMessages(toField.state.meta.errors)
            const invalid = errors.length > 0 && (toField.state.meta.isBlurred || submitted)
            return (
              <div className="grid gap-1">
                <div className="flex items-center gap-1.5">
                  <TimeSelect
                    aria-label={`${day.long}, desde`}
                    className="h-10 w-[92px] px-2.5"
                    value={turn.from}
                    onChange={(next) => {
                      fromField.handleChange(next)
                      fromField.handleBlur()
                    }}
                  />
                  <span className="text-sm text-muted-foreground">a</span>
                  <TimeSelect
                    aria-label={`${day.long}, hasta`}
                    className="h-10 w-[92px] px-2.5"
                    min={minutesToTime(Math.min(timeToMinutes(turn.from) + 15, 23 * 60 + 45))}
                    invalid={invalid}
                    aria-describedby={invalid ? errorId : undefined}
                    value={turn.to}
                    onChange={(next) => {
                      toField.handleChange(next)
                      toField.handleBlur()
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground"
                    aria-label={`Quitar la franja de ${turn.from} a ${turn.to} del ${day.long}`}
                    onClick={() => form.removeFieldValue("turns", index)}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
                {invalid ? (
                  <FieldError id={errorId} errors={errors.map((message) => ({ message }))} />
                ) : null}
              </div>
            )
          }}
        </form.Field>
      )}
    </form.Field>
  )
}

/* ---------- Agregar una ausencia ---------- */

export interface AbsenceValues {
  kind: "dias" | "horas"
  fromDay: string
  toDay: string
  day: string
  startTime: string
  endTime: string
  reason: string
}

const absenceFormSchema = z
  .object({
    kind: z.enum(["dias", "horas"]),
    fromDay: z.string(),
    toDay: z.string(),
    day: z.string(),
    startTime: z.string(),
    endTime: z.string(),
    reason: z.string().trim().max(200, "Usa como máximo 200 caracteres"),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "dias") {
      if (!value.fromDay)
        ctx.addIssue({ code: "custom", path: ["fromDay"], message: "Elige desde qué día" })
      if (value.toDay && value.fromDay && value.toDay < value.fromDay)
        ctx.addIssue({
          code: "custom",
          path: ["toDay"],
          message: "El último día va después del primero",
        })
      return
    }
    if (!value.day) ctx.addIssue({ code: "custom", path: ["day"], message: "Elige el día" })
    if (!value.startTime)
      ctx.addIssue({ code: "custom", path: ["startTime"], message: "Elige desde qué hora" })
    if (!value.endTime || (value.startTime && value.endTime <= value.startTime))
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "Elige una hora después del inicio",
      })
  })

const KINDS = [
  { value: "dias", label: "Días completos" },
  { value: "horas", label: "Unas horas" },
] as const

function AbsenceDrawer({
  userId,
  name,
  isAdmin,
  onSaved,
  onClose,
}: {
  userId: string
  /** El nombre de la persona si no es quien mira. */
  name: string | null
  isAdmin: boolean
  onSaved: (conflicts: AbsenceConflict[]) => void
  onClose: () => void
}) {
  const today = limaDay()
  const [initial] = React.useState<AbsenceValues>(() => ({
    kind: "dias",
    fromDay: addDays(today, 1),
    toDay: addDays(today, 1),
    day: today,
    startTime: "15:00",
    endTime: "17:00",
    reason: "",
  }))
  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: absenceFormSchema },
    onSubmit: async ({ value, formApi }) => {
      const range = absenceRange(value)
      const added = addedSchema.parse(
        await api<unknown>(`/api/admin/access/team/${enc(userId)}/absences`, {
          method: "POST",
          body: JSON.stringify({ ...range, reason: value.reason.trim() || null }),
        }),
      )
      onSaved(added.conflicts)
      if (added.conflicts.length > 0) toast.warning(conflictWords(added.conflicts.length, isAdmin))
      else toast.success("Ausencia guardada: no choca con ninguna presentación")
      formApi.reset(value)
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (field) =>
      field === "startsAt"
        ? form.state.values.kind === "dias"
          ? "fromDay"
          : "startTime"
        : field === "endsAt"
          ? form.state.values.kind === "dias"
            ? "toDay"
            : "endTime"
          : field,
  })
  const kind = useStore(form.store, (state) => state.values.kind)
  const fromDay = useStore(form.store, (state) => state.values.fromDay)
  return (
    <FormDrawer
      {...surface}
      open
      dock={false}
      onClose={onClose}
      title="Agregar ausencia"
      description={name ? `De ${name}. Nada se mueve solo.` : "Nada se mueve solo."}
      submitLabel="Guardar ausencia"
      cancelLabel={common.actions.cancel}
    >
      <FieldGroup>
        <form.AppField name="kind">
          {(field) => (
            <field.Group legend="Cuánto tiempo">
              {() => (
                <ToggleGroup
                  aria-label="Cuánto tiempo"
                  value={[field.state.value]}
                  onValueChange={(next: unknown[]) => {
                    const picked = KINDS.find((option) => option.value === next[0])
                    if (picked) field.handleChange(picked.value)
                  }}
                  spacing={1}
                  className="flex-wrap justify-start"
                >
                  {KINDS.map((option) => (
                    <ToggleGroupItem
                      key={option.value}
                      value={option.value}
                      className="h-auto min-h-9 rounded-3xl border px-3 py-1.5 text-sm aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:font-semibold"
                    >
                      {option.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </field.Group>
          )}
        </form.AppField>
        {kind === "dias" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <DayField form={form} name="fromDay" id="ausencia-desde" label="Desde" min={today} />
            <DayField
              form={form}
              name="toDay"
              id="ausencia-hasta"
              label="Hasta (incluido)"
              min={fromDay || today}
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            <DayField form={form} name="day" id="ausencia-dia" label="Día" min={today} />
            <form.AppField name="startTime">
              {(field) => (
                <field.Control id="ausencia-hora-desde" label="Desde">
                  {(control) => (
                    <TimeSelect
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      value={field.state.value}
                      onChange={(next) => {
                        field.handleChange(next)
                        field.handleBlur()
                      }}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
            <form.AppField name="endTime">
              {(field) => (
                <field.Control id="ausencia-hora-hasta" label="Hasta">
                  {(control) => (
                    <TimeSelect
                      id={control.id}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      value={field.state.value}
                      onChange={(next) => {
                        field.handleChange(next)
                        field.handleBlur()
                      }}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          </div>
        )}
        <form.AppField name="reason">
          {(field) => (
            <field.TextField
              id="ausencia-motivo"
              label="Motivo (opcional)"
              description="Lo ve el equipo en Hoy, por ejemplo «Vacaciones» o «Médico»."
              maxLength={200}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}
