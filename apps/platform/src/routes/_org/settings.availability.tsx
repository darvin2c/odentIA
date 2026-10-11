import { createFileRoute } from '@tanstack/react-router'
import { Button, Input, toast } from "@odentia/ui"
import {
  dayMinutesIn,
  formatDateLong,
  hourLabel,
  PageHeader,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  WEEKDAY_LABELS,
  minutesLabel,
  type AgendaResources,
  type ProfessionalSchedule,
  type ScheduleBlock,
} from "../../lib/agenda"
import { AbsenceForm } from "../../components/agenda/absence-form"
import { ChairForm } from "../../components/agenda/chair-form"
import { BranchSwitcher } from "../../components/branch-switcher"
import { ChoiceSelect } from "../../components/ui/choice-select"
import { useActiveBranch } from "../../lib/active-branch"
import { usePermission } from "../../lib/crm"
import { sameDraft, usePageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/availability")({
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    ...search,
    branch: typeof search.branch === "string" ? search.branch : undefined,
  }),
  component: AvailabilityPage,
})

interface TurnDraft {
  key: number
  weekday: number
  from: string
  to: string
}

let turnSeq = 1

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? (error.shape.message ?? error.message) : String(error)
}

function toMinutes(label: string): number {
  const [hours = 0, minutes = 0] = label.split(":").map(Number)
  return hours * 60 + minutes
}

function AvailabilityPage() {
  const queryClient = useQueryClient()
  const canConfigure = usePermission("settings.write")
  // La misma sede que la Agenda: la del enlace o la última elegida.
  const sede = useActiveBranch()
  const resourcesQuery = useQuery({
    queryKey: ["agenda-resources", sede.branchId ?? null],
    enabled: sede.ready,
    queryFn: () =>
      apiFetch<{ data: AgendaResources }>(
        `/api/agenda/resources${sede.branchId ? `?branchId=${encodeURIComponent(sede.branchId)}` : ""}`,
      ),
  })
  const resources = resourcesQuery.data?.data
  const [dentistId, setDentistId] = React.useState("")
  const professionalId = dentistId || resources?.professionals[0]?.id || ""

  const scheduleQuery = useQuery({
    queryKey: ["professional-schedule", resources?.branchId, professionalId],
    enabled: Boolean(resources?.branchId && professionalId),
    queryFn: () =>
      apiFetch<{ data: ProfessionalSchedule }>(
        `/api/agenda/schedules?branchId=${resources?.branchId}&dentistUserId=${professionalId}`,
      ),
  })
  const [turns, setTurns] = React.useState<TurnDraft[]>([])
  const [loadedFor, setLoadedFor] = React.useState("")
  const [baseline, setBaseline] = React.useState<TurnDraft[]>([])
  const draftGuard = usePageDraftGuard(!sameDraft(
    turns.map(({ weekday, from, to }) => ({ weekday, from, to })),
    baseline.map(({ weekday, from, to }) => ({ weekday, from, to })),
  ))
  const loadedKey = `${resources?.branchId}:${professionalId}`
  React.useEffect(() => {
    const rules = scheduleQuery.data?.data.rules
    if (!rules || loadedFor === loadedKey) return
    const loadedTurns = rules.map((rule) => ({
      key: turnSeq++,
      weekday: rule.weekday,
      from: minutesLabel(rule.startMin),
      to: minutesLabel(rule.endMin),
    }))
    setTurns(loadedTurns)
    setBaseline(loadedTurns)
    setLoadedFor(loadedKey)
  }, [scheduleQuery.data, loadedFor, loadedKey])

  const [error, setError] = React.useState("")
  const saveMutation = useMutation({
    mutationFn: (submitted: TurnDraft[]) => {
      const rules = submitted.map((turn) => {
        const startMin = toMinutes(turn.from)
        const endMin = toMinutes(turn.to)
        if (endMin <= startMin) throw new Error("Cada turno debe terminar después de iniciar.")
        return { weekday: turn.weekday, startMin, endMin }
      })
      return apiFetch("/api/agenda/schedules", {
        method: "PUT",
        body: JSON.stringify({ branchId: resources?.branchId, dentistUserId: professionalId, rules }),
      })
    },
    onSuccess: async (_result, submitted) => {
      setBaseline(submitted)
      toast.success("Horario guardado.")
      setError("")
      await queryClient.invalidateQueries({ queryKey: ["professional-schedule"] })
    },
    onError: (cause) => setError(errorMessage(cause)),
  })

  const weekFrom = React.useMemo(() => new Date().toISOString(), [])
  const weekTo = React.useMemo(() => new Date(Date.now() + 60 * 86_400_000).toISOString(), [])
  const blocksQuery = useQuery({
    queryKey: ["schedule-blocks", resources?.branchId],
    enabled: Boolean(resources?.branchId),
    queryFn: () =>
      apiFetch<{ data: ScheduleBlock[] }>(
        `/api/agenda/blocks?branchId=${resources?.branchId}&from=${encodeURIComponent(weekFrom)}&to=${encodeURIComponent(weekTo)}`,
      ),
  })
  const [blockForm, setBlockForm] = React.useState(false)
  const [chairForm, setChairForm] = React.useState(false)
  const invalidateBlocks = () => queryClient.invalidateQueries({ queryKey: ["schedule-blocks"] })

  return (
    <div className="grid gap-4">
      {draftGuard.dialog}
      <PageHeader
        title="Horarios y bloqueos"
        subtitle={
          resources ? (
            <>
              <BranchSwitcher
                branches={sede.branches}
                value={resources.branchId}
                fallbackName={resources.branchName}
                onChange={(id) =>
                  draftGuard.requestLeave(() => {
                    sede.choose(id)
                    setDentistId("")
                    setLoadedFor("")
                    setTurns([])
                    setBaseline([])
                  })
                }
              />
              <span className="truncate">, zona {resources.timeZone}</span>
            </>
          ) : (
            "Horario semanal por profesional, bloqueos y ausencias de la sede."
          )
        }
      />
      {!resources ? (
        <p className="text-sm text-muted-foreground">Cargando recursos…</p>
      ) : (
        <>
          <section className="grid gap-3 rounded-xl border bg-background p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">Horario semanal</h2>
              <ChoiceSelect
                aria-label="Profesional"
                className="w-auto min-w-48"
                value={professionalId}
                onChange={(event) => {
                  const nextId = event.target.value
                  draftGuard.requestLeave(() => {
                    setDentistId(nextId)
                    setLoadedFor("")
                    setTurns([])
                    setBaseline([])
                  })
                }}
              >
                {resources.professionals.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </ChoiceSelect>
              <span className="text-xs text-muted-foreground">
                Sin turnos guardados, el profesional no ofrece huecos.
              </span>
            </div>
            {WEEKDAY_LABELS.map((label, weekday) => (
              <div key={label} className="grid gap-2 border-t pt-2 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <span className="w-10 text-sm font-medium">{label}</span>
                  {canConfigure && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setTurns((current) => [
                          ...current,
                          { key: turnSeq++, weekday, from: "09:00", to: "13:00" },
                        ])
                      }
                    >
                      Añadir turno
                    </Button>
                  )}
                </div>
                {turns.filter((turn) => turn.weekday === weekday).length === 0 && (
                  <p className="text-xs text-muted-foreground">Sin atención.</p>
                )}
                {turns
                  .filter((turn) => turn.weekday === weekday)
                  .map((turn) => (
                    <div key={turn.key} className="flex items-center gap-2">
                      <Input
                        aria-label={`Inicio ${label}`}
                        type="time"
                        className="h-8 w-32"
                        disabled={!canConfigure}
                        value={turn.from}
                        onChange={(event) =>
                          setTurns((current) =>
                            current.map((item) =>
                              item.key === turn.key ? { ...item, from: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      <span className="text-sm text-muted-foreground">a</span>
                      <Input
                        aria-label={`Fin ${label}`}
                        type="time"
                        className="h-8 w-32"
                        disabled={!canConfigure}
                        value={turn.to}
                        onChange={(event) =>
                          setTurns((current) =>
                            current.map((item) =>
                              item.key === turn.key ? { ...item, to: event.target.value } : item,
                            ),
                          )
                        }
                      />
                      {canConfigure && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setTurns((current) => current.filter((item) => item.key !== turn.key))
                          }
                        >
                          Quitar
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
            ))}
            {error && <p className="text-sm text-destructive">{error}</p>}
            {canConfigure && (
              <div>
                <Button disabled={saveMutation.isPending} onClick={() => saveMutation.mutate(turns)}>
                  Guardar horario
                </Button>
              </div>
            )}
          </section>

          <section className="grid gap-3 rounded-xl border bg-background p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">Sillones</h2>
              <span className="text-xs text-muted-foreground">Cada cita ocupa un sillón.</span>
              {canConfigure && (
                <Button variant="outline" size="sm" onClick={() => setChairForm(true)}>
                  Añadir sillón
                </Button>
              )}
            </div>
            {resources.chairs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Esta sede aún no tiene sillones: sin al menos uno no se puede reservar.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {resources.chairs.map((chair) => (
                  <li key={chair.id} className="rounded-lg border px-3 py-1.5 text-sm">
                    {chair.label}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="grid gap-3 rounded-xl border bg-background p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-medium">Ausencias y bloqueos</h2>
              <span className="text-xs text-muted-foreground">
                Vacaciones, permisos, feriados y cierres de los próximos 60 días.
              </span>
              {canConfigure && (
                <Button variant="outline" size="sm" onClick={() => setBlockForm(true)}>
                  Nueva ausencia
                </Button>
              )}
            </div>
            {(blocksQuery.data?.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin ausencias en el período.</p>
            ) : (
              <ul className="grid gap-2">
                {(blocksQuery.data?.data ?? []).map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    timeZone={resources.timeZone}
                    canConfigure={canConfigure}
                    onDeleted={invalidateBlocks}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {chairForm && resources && (
        <ChairForm
          branchId={resources.branchId}
          branchName={resources.branchName}
          suggestedName={`Sillón ${resources.chairs.length + 1}`}
          onClose={() => setChairForm(false)}
          onSaved={async () => {
            setChairForm(false)
            await queryClient.invalidateQueries({ queryKey: ["agenda-resources"] })
          }}
        />
      )}
      {blockForm && resources && (
        <AbsenceForm
          branchId={resources.branchId}
          timeZone={resources.timeZone}
          today={zonedDateOf(new Date().toISOString(), resources.timeZone)}
          professionals={resources.professionals}
          chairs={resources.chairs}
          onClose={() => setBlockForm(false)}
          onSaved={async () => {
            setBlockForm(false)
            await invalidateBlocks()
          }}
        />
      )}
    </div>
  )
}

/** «Del lunes 12 de octubre al viernes 16 de octubre» o «Lunes 12 de octubre, de 12:00 a 14:00». */
function blockWhen(block: ScheduleBlock, timeZone: string): string {
  const first = zonedDateOf(block.startsAt, timeZone)
  const last = zonedDateOf(new Date(Date.parse(block.endsAt) - 1).toISOString(), timeZone)
  const startMinutes = dayMinutesIn(block.startsAt, timeZone)
  const endMinutes = dayMinutesIn(block.endsAt, timeZone)
  const wholeDays = startMinutes === 0 && endMinutes === 0
  if (first === last) {
    return wholeDays
      ? `${formatDateLong(first)}, todo el día`
      : `${formatDateLong(first)}, de ${hourLabel(startMinutes)} a ${hourLabel(endMinutes)}`
  }
  const lower = (text: string) => text.toLocaleLowerCase("es")
  return wholeDays
    ? `Del ${lower(formatDateLong(first))} al ${lower(formatDateLong(last))}`
    : `Del ${lower(formatDateLong(first))} ${hourLabel(startMinutes)} al ${lower(formatDateLong(last))} ${hourLabel(endMinutes)}`
}

function BlockRow({
  block,
  timeZone,
  canConfigure,
  onDeleted,
}: {
  block: ScheduleBlock
  timeZone: string
  canConfigure: boolean
  onDeleted: () => Promise<void>
}) {
  const [error, setError] = React.useState("")
  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/agenda/blocks/${block.id}`, { method: "DELETE" }),
    onSuccess: async () => onDeleted(),
    onError: (cause) => setError(errorMessage(cause)),
  })
  const scope = block.dentistName ?? (block.chairId ? "Un sillón" : "Toda la sede")
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-2 text-sm">
      <span className="font-medium">
        {block.reason ?? (block.kind === "ausencia" ? "Ausencia" : "Bloqueo")}
      </span>
      <span>{scope}</span>
      <span className="text-muted-foreground">{blockWhen(block, timeZone)}</span>
      <span className="flex-1" />
      {canConfigure && (
        <Button variant="ghost" size="sm" onClick={() => deleteMutation.mutate()}>
          Eliminar
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </li>
  )
}
