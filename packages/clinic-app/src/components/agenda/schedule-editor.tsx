import {
  Button,
  cn,
  FieldError,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  fieldErrorMessages,
  hourLabel,
  type ScheduleColumn,
  ScheduleResourceChips,
  submitForm,
  TimeSelect,
  useAppForm,
  useFormSubmitError,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, X } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import { minutesLabel, type ProfessionalSchedule } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { shortName } from "./shared"

/** Un turno del borrador: `key` solo sirve para la lista; el orden es el de `rules` al guardar. */
export interface TurnDraft {
  key: number
  weekday: number
  from: string
  to: string
}

let turnSeq = 1

/** Lo mismo que admite el servidor (`scheduleInput`: `rules.max(42)`). */
const MAX_TURNS = 42

/** La semana se lee de lunes a domingo; `weekday` es el del servicio (0 = domingo). */
const WEEK: Array<{ weekday: number; short: string; long: string }> = [
  { weekday: 1, short: "Lun", long: "lunes" },
  { weekday: 2, short: "Mar", long: "martes" },
  { weekday: 3, short: "Mié", long: "miércoles" },
  { weekday: 4, short: "Jue", long: "jueves" },
  { weekday: 5, short: "Vie", long: "viernes" },
  { weekday: 6, short: "Sáb", long: "sábado" },
  { weekday: 0, short: "Dom", long: "domingo" },
]

/** Hora de un turno: caja estrecha, para que el día quepa en una línea. */
const TIME_FIELD = "h-10 w-[92px] px-2.5"

function toMinutes(label: string): number {
  const [hours = 0, minutes = 0] = label.split(":").map(Number)
  return hours * 60 + minutes
}

const sameTurns = (a: TurnDraft[], b: TurnDraft[]) =>
  a.length === b.length &&
  a.every((turn, index) => {
    const other = b[index]
    return turn.weekday === other?.weekday && turn.from === other.from && turn.to === other.to
  })

/**
 * Las reglas del horario, con los mismos límites que el servidor: cada error
 * en el turno que hay que cambiar (`turns[3].to`), dicho con la palabra de la
 * pantalla («turno», «tramo»).
 */
function turnsSchema(unit: string, maxPerDay: number | undefined) {
  return z
    .object({
      turns: z.array(z.object({ key: z.number(), weekday: z.number(), from: z.string(), to: z.string() })),
    })
    .superRefine(({ turns }, ctx) => {
      const seen = new Set<string>()
      const byDay = new Map<number, number[]>()
      turns.forEach((turn, index) => {
        byDay.set(turn.weekday, [...(byDay.get(turn.weekday) ?? []), index])
        if (toMinutes(turn.to) <= toMinutes(turn.from)) {
          ctx.addIssue({
            code: "custom",
            path: ["turns", index, "to"],
            message: `El ${unit} termina antes de empezar: elige un «hasta» después de las ${hourLabel(toMinutes(turn.from))}.`,
          })
          return
        }
        const key = `${turn.weekday}:${turn.from}:${turn.to}`
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["turns", index, "to"], message: `Este ${unit} está repetido ese día.` })
        }
        seen.add(key)
      })
      if (turns.length > MAX_TURNS) {
        ctx.addIssue({ code: "custom", path: ["turns"], message: `Como mucho ${MAX_TURNS} ${unit}s en la semana.` })
      }
      if (maxPerDay !== undefined) {
        for (const indexes of byDay.values()) {
          const last = indexes.at(-1)
          if (indexes.length > maxPerDay && last !== undefined) {
            ctx.addIssue({ code: "custom", path: ["turns", last, "to"], message: `Como mucho ${maxPerDay} ${unit}s por día.` })
          }
        }
      }
    })
}

function useTurnsForm(input: {
  baseline: TurnDraft[]
  unit: string
  maxPerDay: number | undefined
  onSubmit: (turns: TurnDraft[]) => Promise<void>
}) {
  const { baseline, unit, maxPerDay, onSubmit } = input
  const schema = React.useMemo(() => turnsSchema(unit, maxPerDay), [unit, maxPerDay])
  return useAppForm({
    // Lo guardado es el valor inicial: `useAppForm` no lo pisa mientras se edita.
    defaultValues: { turns: baseline },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) => onSubmit(value.turns),
  })
}

type TurnsForm = ReturnType<typeof useTurnsForm>

export interface WeeklySchedule {
  /** El borrador; los turnos se leen y se cambian en él (`turns[i].from`/`to`). */
  form: TurnsForm
  turns: TurnDraft[]
  /** Cómo se llama cada tramo: «turno» en la agenda, «tramo» al escribir. */
  unit: string
  /** Cuántos caben en un mismo día; sin límite si no se dice. */
  maxPerDay?: number
  /** Falso mientras llega el horario de quien se eligió. */
  ready: boolean
  /** El horario no llegó: se dice y se ofrece reintentar, no se espera para siempre. */
  failed: boolean
  retry: () => void
  dirty: boolean
  saving: boolean
  /** Lo que no es de ningún turno (los errores de un turno se dicen bajo él). */
  error: string
  save: () => void
  /** Desde qué día vale el horario guardado; solo el de un profesional lo tiene. */
  validFrom?: string | null
}

/** Un turno guardado: día de la semana (0 = domingo) y minutos desde la medianoche. */
export interface WeeklyRule {
  weekday: number
  startMin: number
  endMin: number
}

/**
 * Una semana de turnos como borrador hasta guardar: la que se edita con
 * `WeeklyScheduleFields`. La usan el horario de cada profesional y el
 * «Horario de recontacto» del agente (decisión 18 v3): el mismo editor.
 */
export function useWeeklyTurns(input: {
  /** Qué semana es: al cambiar, se vuelve a cargar lo guardado. */
  key: string
  /** Lo guardado; indefinido mientras llega. */
  rules: WeeklyRule[] | undefined
  failed: boolean
  retry: () => void
  /** Guarda las reglas en el orden de `turns`; si el servidor rechaza, lanza. */
  save: (rules: WeeklyRule[]) => Promise<unknown>
  savedMessage: string
  onSaved?: () => void | Promise<void>
  /** Cómo se llama cada tramo en los mensajes; «turno» por defecto. */
  unit?: string
  /** Cuántos caben en un mismo día. */
  maxPerDay?: number
  /**
   * Qué turno señala un dato que rechaza el servidor (`rules[3].endMin` →
   * `turns[3].to`). Lo que no se traduce se dice junto a los botones.
   */
  fieldMap?: (serverField: string, turns: TurnDraft[]) => string | undefined
}): WeeklySchedule {
  const { key, rules, failed, retry, save: persist, savedMessage, onSaved, unit = "turno", maxPerDay, fieldMap } = input
  const [baseline, setBaseline] = React.useState<TurnDraft[]>([])
  const [loadedFor, setLoadedFor] = React.useState("")

  const save = useMutation({ mutationFn: persist })
  const form = useTurnsForm({
    baseline,
    unit,
    maxPerDay,
    onSubmit: async (submitted) => {
      await save.mutateAsync(
        submitted.map((turn) => ({ weekday: turn.weekday, startMin: toMinutes(turn.from), endMin: toMinutes(turn.to) })),
      )
      setBaseline(submitted)
      form.reset({ turns: submitted })
      toast.success(savedMessage)
      await onSaved?.()
    },
  })

  React.useEffect(() => {
    if (!rules || loadedFor === key) return
    const loaded = rules.map((rule) => ({
      key: turnSeq++,
      weekday: rule.weekday,
      from: minutesLabel(rule.startMin),
      to: minutesLabel(rule.endMin),
    }))
    setBaseline(loaded)
    form.reset({ turns: loaded })
    setLoadedFor(key)
  }, [rules, loadedFor, key, form])

  const turns = useStore(form.store, (state) => state.values.turns)
  const saving = useStore(form.store, (state) => state.isSubmitting)
  const error = useFormSubmitError(form)
  const ready = loadedFor === key
  return {
    form,
    turns: ready ? turns : [],
    unit,
    maxPerDay,
    ready,
    failed: !ready && failed,
    retry,
    dirty: ready && !sameTurns(turns, baseline),
    saving,
    error: error ?? "",
    save: () => {
      void submitForm(form, {
        fieldMap: fieldMap ? (serverField) => fieldMap(serverField, form.state.values.turns) : undefined,
      })
    },
  }
}

/** `rules[3].endMin` (cuerpo de `PUT /api/agenda/schedules`) → `turns[3].to`; `rules` → la semana. */
function scheduleField(serverField: string): string | undefined {
  if (serverField === "rules") return "turns"
  const match = /^rules\[(\d+)\]\.(weekday|startMin|endMin)$/.exec(serverField)
  if (!match) return undefined
  return `turns[${match[1]}].${match[2] === "startMin" ? "from" : "to"}`
}

/**
 * El horario semanal de un profesional en una sede: sus turnos, como borrador
 * hasta guardar. Es el mismo en la agenda y en Configuración.
 */
export function useWeeklySchedule(input: {
  branchId: string | undefined
  professionalUserId: string
  onSaved?: () => void | Promise<void>
}): WeeklySchedule {
  const { branchId, professionalUserId, onSaved } = input
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["professional-schedule", branchId, professionalUserId],
    enabled: Boolean(branchId && professionalUserId),
    queryFn: () =>
      apiFetch<{ data: ProfessionalSchedule }>(
        `/api/agenda/schedules?branchId=${branchId}&professionalUserId=${professionalUserId}`,
      ),
  })
  const turns = useWeeklyTurns({
    key: `${branchId}:${professionalUserId}`,
    rules: query.data?.data.rules,
    failed: query.isError,
    retry: () => void query.refetch(),
    save: (rules) =>
      apiFetch("/api/agenda/schedules", {
        method: "PUT",
        body: JSON.stringify({ branchId, professionalUserId, rules }),
      }),
    savedMessage: "Horario guardado",
    fieldMap: scheduleField,
    onSaved: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["professional-schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["agenda-availability"] }),
      ])
      await onSaved?.()
    },
  })
  return { ...turns, validFrom: query.data?.data.validFrom ?? null }
}

/**
 * Un turno: «desde» y «hasta», y debajo lo que falla en él. Cada hora se marca
 * si el error es suyo y apunta al mensaje del turno.
 */
function TurnRow({
  form,
  index,
  turn,
  day,
  unit,
  canEdit,
  submitted,
  idBase,
}: {
  form: TurnsForm
  index: number
  turn: TurnDraft
  day: (typeof WEEK)[number]
  unit: string
  canEdit: boolean
  submitted: boolean
  idBase: string
}) {
  const errorId = `${idBase}-${turn.key}-error`
  return (
    <form.Field name={`turns[${index}].from`}>
      {(fromField) => (
        <form.Field name={`turns[${index}].to`}>
          {(toField) => {
            const fromErrors = fieldErrorMessages(fromField.state.meta.errors)
            const toErrors = fieldErrorMessages(toField.state.meta.errors)
            const fromInvalid = fromErrors.length > 0 && (fromField.state.meta.isBlurred || submitted)
            const toInvalid = toErrors.length > 0 && (toField.state.meta.isBlurred || submitted)
            const messages = [...new Set([...(fromInvalid ? fromErrors : []), ...(toInvalid ? toErrors : [])])]
            return (
              <div className="grid gap-1">
                <div className="flex items-center gap-1.5">
                  <TimeSelect
                    aria-label={`${day.long}, desde`}
                    className={TIME_FIELD}
                    disabled={!canEdit}
                    invalid={fromInvalid}
                    aria-describedby={fromInvalid ? errorId : undefined}
                    value={turn.from}
                    onChange={(next) => {
                      fromField.handleChange(next)
                      fromField.handleBlur()
                    }}
                  />
                  <span className="text-sm text-muted-foreground">a</span>
                  <TimeSelect
                    aria-label={`${day.long}, hasta`}
                    className={TIME_FIELD}
                    disabled={!canEdit}
                    // «Hasta» ofrece desde un cuarto de hora después del inicio.
                    min={minutesLabel(Math.min(toMinutes(turn.from) + 15, 24 * 60 - 1))}
                    invalid={toInvalid}
                    aria-describedby={toInvalid ? errorId : undefined}
                    value={turn.to}
                    onChange={(next) => {
                      toField.handleChange(next)
                      toField.handleBlur()
                    }}
                  />
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      aria-label={`Quitar el ${unit} de ${turn.from} a ${turn.to} del ${day.long}`}
                      onClick={() => form.removeFieldValue("turns", index)}
                    >
                      <X aria-hidden />
                    </Button>
                  ) : null}
                </div>
                {messages.length > 0 ? (
                  <FieldError id={errorId} errors={messages.map((message) => ({ message }))} />
                ) : null}
              </div>
            )
          }}
        </form.Field>
      )}
    </form.Field>
  )
}

/** Los días de la semana con sus turnos. En el panel van uno bajo otro; en la página, en fila. */
export function WeeklyScheduleFields({
  schedule,
  canEdit,
  stacked = false,
  emptyLabel = "No atiende",
  unit = schedule.unit,
}: {
  schedule: WeeklySchedule
  canEdit: boolean
  stacked?: boolean
  /** Lo que dice un día sin turnos: «No atiende», «No escribimos». */
  emptyLabel?: string
  /** Cómo se llama cada tramo: «turno» en la agenda, «tramo» al escribir. */
  unit?: string
}) {
  const idBase = React.useId()
  const { form, maxPerDay } = schedule
  const submitted = useStore(form.store, (state) => state.submissionAttempts > 0)
  if (schedule.failed) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm text-destructive">
        No pudimos cargar el horario.
        <Button variant="outline" size="sm" onClick={schedule.retry}>
          Reintentar
        </Button>
      </p>
    )
  }
  if (!schedule.ready) {
    return (
      <div role="status" aria-label="Cargando el horario…" className="grid gap-2 py-2">
        {WEEK.map((day) => (
          <Skeleton key={day.weekday} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  const indexed = schedule.turns.map((turn, index) => ({ turn, index }))
  const weekFull = schedule.turns.length >= MAX_TURNS
  const weekFullId = `${idBase}-semana-llena`
  return (
    <form.Field name="turns" mode="array">
      {(weekField) => {
        const weekErrors = fieldErrorMessages(weekField.state.meta.errors)
        const weekErrorId = `${idBase}-semana-error`
        return (
          <div className="grid">
            {WEEK.map((day) => {
              const turns = indexed.filter((item) => item.turn.weekday === day.weekday)
              const dayFull = maxPerDay !== undefined && turns.length >= maxPerDay
              const dayId = `${idBase}-${day.weekday}`
              const dayFullId = `${dayId}-lleno`
              return (
                <fieldset
                  key={day.weekday}
                  aria-labelledby={dayId}
                  className="flex min-w-0 items-start gap-2 border-b py-2 last:border-b-0"
                >
                  <span id={dayId} className="flex h-10 w-8 shrink-0 items-center text-sm font-bold">
                    <span aria-hidden>{day.short}</span>
                    <span className="sr-only">{day.long.charAt(0).toUpperCase() + day.long.slice(1)}</span>
                  </span>
                  <div
                    className={cn(
                      "flex min-w-0 flex-1",
                      stacked ? "flex-col gap-1.5" : "flex-wrap gap-x-4 gap-y-1.5",
                    )}
                  >
                    {turns.length === 0 ? (
                      <span className="flex h-10 items-center text-sm text-muted-foreground">
                        {emptyLabel}
                      </span>
                    ) : null}
                    {turns.map(({ turn, index }) => (
                      <TurnRow
                        key={turn.key}
                        form={form}
                        index={index}
                        turn={turn}
                        day={day}
                        unit={unit}
                        canEdit={canEdit}
                        submitted={submitted}
                        idBase={idBase}
                      />
                    ))}
                    {canEdit && dayFull ? (
                      <p id={dayFullId} className="text-sm text-muted-foreground">
                        Como mucho {maxPerDay} {unit}s por día.
                      </p>
                    ) : null}
                  </div>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-0.5 shrink-0 gap-1 px-2 text-primary"
                      aria-label={`Añadir ${unit} el ${day.long}`}
                      // El tope no depende de un dato mal escrito: se dice a la vista por qué no se añade.
                      disabled={weekFull || dayFull}
                      aria-describedby={dayFull ? dayFullId : weekFull ? weekFullId : undefined}
                      onClick={() => {
                        // El segundo turno del día empieza por la tarde: lo habitual es el horario partido.
                        const last = turns.at(-1)?.turn
                        const from = last ? Math.min(toMinutes(last.to) + 120, 22 * 60) : 9 * 60
                        weekField.pushValue({
                          key: turnSeq++,
                          weekday: day.weekday,
                          from: minutesLabel(from),
                          to: minutesLabel(Math.min(from + 240, 23 * 60 + 45)),
                        })
                      }}
                    >
                      <Plus aria-hidden />
                      {unit.charAt(0).toUpperCase() + unit.slice(1)}
                    </Button>
                  ) : null}
                </fieldset>
              )
            })}
            {canEdit && weekFull ? (
              <p id={weekFullId} className="pt-2 text-sm text-muted-foreground">
                Caben {MAX_TURNS} {unit}s en la semana: quita uno para añadir otro.
              </p>
            ) : null}
            {submitted && weekErrors.length > 0 ? (
              <FieldError id={weekErrorId} errors={weekErrors.map((message) => ({ message }))} />
            ) : null}
          </div>
        )
      }}
    </form.Field>
  )
}

/**
 * Configurar el horario sin salir de la agenda: se elige al profesional y se
 * guardan sus turnos; la agenda se llena al lado. Sigue abierto tras guardar
 * para pasar al siguiente profesional.
 */
export function ScheduleDrawer({
  branchId,
  branchName,
  professionals,
  onClose,
  onSaved,
}: {
  branchId: string
  branchName: string
  professionals: ScheduleColumn[]
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [professionalId, setProfessionalId] = React.useState(professionals[0]?.id ?? "")
  /** A quién se quiere pasar con cambios sin guardar. */
  const [pending, setPending] = React.useState<string | null>(null)
  const schedule = useWeeklySchedule({ branchId, professionalUserId: professionalId, onSaved })
  const current = professionals.find((item) => item.id === professionalId)
  const professionalLabelId = React.useId()
  return (
    <>
      <FormDrawer
        open
        title="Horario de atención"
        description={`${branchName}. Cada profesional tiene el suyo.`}
        onClose={onClose}
        onSubmit={(event) => {
          event.preventDefault()
          schedule.save()
        }}
        isSubmitting={schedule.saving}
        isDirty={schedule.dirty}
        error={schedule.error || null}
        submitDisabled={!schedule.ready || !schedule.dirty}
        submitLabel="Guardar horario"
        cancelLabel={schedule.dirty ? "Cancelar" : "Cerrar"}
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <span id={professionalLabelId} className="text-sm font-medium">
              Profesional
            </span>
            <ScheduleResourceChips
              wrap
              aria-labelledby={professionalLabelId}
              resources={professionals}
              formatLabel={(item) => shortName(item.label)}
              value={professionalId}
              onChange={(next) => {
                if (!next || next === professionalId) return
                if (schedule.dirty) setPending(next)
                else setProfessionalId(next)
              }}
            />
          </div>
          <WeeklyScheduleFields schedule={schedule} canEdit stacked />
          <Link
            to="/settings/availability"
            search={{ branch: branchId }}
            className="justify-self-start text-sm font-bold text-primary underline-offset-4 hover:underline"
          >
            Ver toda la configuración
          </Link>
        </div>
      </FormDrawer>
      <ConfirmDialog
        open={pending !== null}
        title="Hay cambios sin guardar"
        description={`Si cambias de profesional se pierden los cambios en el horario de ${current?.label ?? "este profesional"}.`}
        confirmLabel="Descartar cambios"
        cancelLabel="Seguir editando"
        variant="destructive"
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) setProfessionalId(pending)
          setPending(null)
        }}
      />
    </>
  )
}
