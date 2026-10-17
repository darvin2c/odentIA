import {
  Button,
  cn,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  FormDrawer,
  type ScheduleColumn,
  ScheduleResourceChips,
  TimeSelect,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Plus, X } from "lucide-react"
import * as React from "react"
import { minutesLabel, type ProfessionalSchedule } from "../../lib/agenda"
import { apiFetch } from "../../lib/api"
import { errorMessage, shortName } from "./shared"

interface TurnDraft {
  key: number
  weekday: number
  from: string
  to: string
}

let turnSeq = 1

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

export interface WeeklySchedule {
  turns: TurnDraft[]
  /** Falso mientras llega el horario de quien se eligió. */
  ready: boolean
  /** El horario no llegó: se dice y se ofrece reintentar, no se espera para siempre. */
  failed: boolean
  retry: () => void
  dirty: boolean
  saving: boolean
  error: string
  add: (weekday: number) => void
  change: (key: number, field: "from" | "to", value: string) => void
  remove: (key: number) => void
  save: () => void
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
 * «Horario para escribir» del agente (decisión 18 v3): el mismo editor.
 */
export function useWeeklyTurns(input: {
  /** Qué semana es: al cambiar, se vuelve a cargar lo guardado. */
  key: string
  /** Lo guardado; indefinido mientras llega. */
  rules: WeeklyRule[] | undefined
  failed: boolean
  retry: () => void
  save: (rules: WeeklyRule[]) => Promise<unknown>
  savedMessage: string
  onSaved?: () => void | Promise<void>
}): WeeklySchedule {
  const { key, rules, failed, retry, save: persist, savedMessage, onSaved } = input
  const [turns, setTurns] = React.useState<TurnDraft[]>([])
  const [baseline, setBaseline] = React.useState<TurnDraft[]>([])
  const [loadedFor, setLoadedFor] = React.useState("")
  const [error, setError] = React.useState("")
  React.useEffect(() => {
    if (!rules || loadedFor === key) return
    const loaded = rules.map((rule) => ({
      key: turnSeq++,
      weekday: rule.weekday,
      from: minutesLabel(rule.startMin),
      to: minutesLabel(rule.endMin),
    }))
    setTurns(loaded)
    setBaseline(loaded)
    setLoadedFor(key)
    setError("")
  }, [rules, loadedFor, key])

  const save = useMutation({
    mutationFn: (submitted: TurnDraft[]) => {
      const next = submitted.map((turn) => {
        const startMin = toMinutes(turn.from)
        const endMin = toMinutes(turn.to)
        if (endMin <= startMin) throw new Error("Cada turno debe terminar después de empezar.")
        return { weekday: turn.weekday, startMin, endMin }
      })
      return persist(next)
    },
    onSuccess: async (_result, submitted) => {
      setBaseline(submitted)
      setError("")
      toast.success(savedMessage)
      await onSaved?.()
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  const ready = loadedFor === key
  return {
    turns: ready ? turns : [],
    ready,
    failed: !ready && failed,
    retry,
    dirty: ready && !sameTurns(turns, baseline),
    saving: save.isPending,
    error,
    add: (weekday) =>
      setTurns((current) => {
        // El segundo turno del día empieza por la tarde: lo habitual es el horario partido.
        const last = current.filter((turn) => turn.weekday === weekday).at(-1)
        const from = last ? Math.min(toMinutes(last.to) + 120, 22 * 60) : 9 * 60
        const next = {
          key: turnSeq++,
          weekday,
          from: minutesLabel(from),
          to: minutesLabel(Math.min(from + 240, 23 * 60 + 45)),
        }
        return [...current, next]
      }),
    change: (turnKey, field, value) =>
      setTurns((current) =>
        current.map((turn) => (turn.key === turnKey ? { ...turn, [field]: value } : turn)),
      ),
    remove: (turnKey) => setTurns((current) => current.filter((turn) => turn.key !== turnKey)),
    save: () => save.mutate(turns),
  }
}

/**
 * El horario semanal de un profesional en una sede: sus turnos, como borrador
 * hasta guardar. Es el mismo en la agenda y en Configuración.
 */
export function useWeeklySchedule(input: {
  branchId: string | undefined
  dentistUserId: string
  onSaved?: () => void | Promise<void>
}): WeeklySchedule {
  const { branchId, dentistUserId, onSaved } = input
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ["professional-schedule", branchId, dentistUserId],
    enabled: Boolean(branchId && dentistUserId),
    queryFn: () =>
      apiFetch<{ data: ProfessionalSchedule }>(
        `/api/agenda/schedules?branchId=${branchId}&dentistUserId=${dentistUserId}`,
      ),
  })
  return useWeeklyTurns({
    key: `${branchId}:${dentistUserId}`,
    rules: query.data?.data.rules,
    failed: query.isError,
    retry: () => void query.refetch(),
    save: (rules) =>
      apiFetch("/api/agenda/schedules", {
        method: "PUT",
        body: JSON.stringify({ branchId, dentistUserId, rules }),
      }),
    savedMessage: "Horario guardado",
    onSaved: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["professional-schedule"] }),
        queryClient.invalidateQueries({ queryKey: ["agenda-availability"] }),
      ])
      await onSaved?.()
    },
  })
}

/** Los días de la semana con sus turnos. En el panel van uno bajo otro; en la página, en fila. */
export function WeeklyScheduleFields({
  schedule,
  canEdit,
  stacked = false,
  emptyLabel = "No atiende",
  unit = "turno",
}: {
  schedule: WeeklySchedule
  canEdit: boolean
  stacked?: boolean
  /** Lo que dice un día sin turnos: «No atiende», «No escribimos». */
  emptyLabel?: string
  /** Cómo se llama cada tramo: «turno» en la agenda, «tramo» al escribir. */
  unit?: string
}) {
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
  return (
    <div className="grid">
      {WEEK.map((day) => {
        const turns = schedule.turns.filter((turn) => turn.weekday === day.weekday)
        return (
          <div
            key={day.weekday}
            className="flex items-start gap-2 border-b py-2 last:border-b-0"
          >
            <span className="flex h-10 w-8 shrink-0 items-center text-sm font-bold">
              {day.short}
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
              {turns.map((turn) => (
                <div key={turn.key} className="flex items-center gap-1.5">
                  <TimeSelect
                    aria-label={`${day.long}, desde`}
                    className={TIME_FIELD}
                    disabled={!canEdit}
                    value={turn.from}
                    onChange={(next) => schedule.change(turn.key, "from", next)}
                  />
                  <span className="text-sm text-muted-foreground">a</span>
                  <TimeSelect
                    aria-label={`${day.long}, hasta`}
                    className={TIME_FIELD}
                    disabled={!canEdit}
                    value={turn.to}
                    onChange={(next) => schedule.change(turn.key, "to", next)}
                  />
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      aria-label={`Quitar el ${unit} de ${turn.from} a ${turn.to} del ${day.long}`}
                      onClick={() => schedule.remove(turn.key)}
                    >
                      <X aria-hidden />
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
            {canEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="mt-0.5 shrink-0 gap-1 px-2 text-primary"
                aria-label={`Añadir ${unit} el ${day.long}`}
                onClick={() => schedule.add(day.weekday)}
              >
                <Plus aria-hidden />
                {unit.charAt(0).toUpperCase() + unit.slice(1)}
              </Button>
            ) : null}
          </div>
        )
      })}
    </div>
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
  const [dentistId, setDentistId] = React.useState(professionals[0]?.id ?? "")
  /** A quién se quiere pasar con cambios sin guardar. */
  const [pending, setPending] = React.useState<string | null>(null)
  const schedule = useWeeklySchedule({ branchId, dentistUserId: dentistId, onSaved })
  const current = professionals.find((item) => item.id === dentistId)
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
            <span className="text-sm font-medium">Profesional</span>
            <ScheduleResourceChips
              wrap
              label="Profesional"
              resources={professionals}
              formatLabel={(item) => shortName(item.label)}
              value={dentistId}
              onChange={(next) => {
                if (!next || next === dentistId) return
                if (schedule.dirty) setPending(next)
                else setDentistId(next)
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
          if (pending) setDentistId(pending)
          setPending(null)
        }}
      />
    </>
  )
}
