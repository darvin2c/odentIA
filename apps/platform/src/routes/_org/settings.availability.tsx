import { createFileRoute, Link } from "@tanstack/react-router"
import { Badge, Button, FieldLabel, RadioGroup, RadioGroupItem, cn, toast } from "@odentia/ui"
import {
  dayMinutesIn,
  formatDateLong,
  formatSpan,
  hourLabel,
  PageHeader,
  ScheduleResourceChips,
  scheduleToneAt,
  zonedDateOf,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import * as React from "react"
import { apiFetch } from "../../lib/api"
import type { AgendaAppointment, AgendaResources, ScheduleBlock } from "../../lib/agenda"
import { AbsenceForm, type AbsenceScope } from "../../components/agenda/absence-form"
import { ChairForm } from "../../components/agenda/chair-form"
import { useWeeklySchedule, WeeklyScheduleFields } from "../../components/agenda/schedule-editor"
import { errorMessage, shortName } from "../../components/agenda/shared"
import { BranchSwitcher } from "../../components/branch-switcher"
import { useActiveBranch } from "../../lib/active-branch"
import { usePermission } from "../../lib/crm"
import { usePageDraftGuard } from "../../lib/page-draft-guard"

export const Route = createFileRoute("/_org/settings/availability")({
  validateSearch: (search: Record<string, unknown>): { branch?: string } => ({
    ...search,
    branch: typeof search.branch === "string" ? search.branch : undefined,
  }),
  component: AvailabilityPage,
})

/** Duraciones que se ofrecen para una cita regular (las mismas que valida el servicio). */
const REGULAR_MINUTES = [15, 30, 45, 60, 90, 120]

/** Hasta cuándo se listan ausencias, feriados y cierres. */
const AHEAD_DAYS = 60

const CARD = "grid content-start gap-3 rounded-xl border bg-background p-3 sm:p-4"

function GroupTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mt-2 grid gap-0.5">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="text-sm text-muted-foreground">{hint}</p>
    </div>
  )
}

function CardHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-2">
      <h3 className="min-w-0 flex-1 font-semibold">{title}</h3>
      {action}
    </div>
  )
}

/**
 * Horarios y ausencias de una sede, en dos grupos: lo de cada profesional (su
 * horario de la semana y los días que no viene) y lo de la sede (sillones,
 * duración de una cita regular, feriados y cierres).
 */
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
  const professionals = React.useMemo(
    () =>
      (resources?.professionals ?? []).map((item, index) => ({
        id: item.id,
        label: item.label,
        tone: scheduleToneAt(index),
      })),
    [resources],
  )
  const [dentistId, setDentistId] = React.useState("")
  const professional = professionals.find((item) => item.id === dentistId) ?? professionals[0]
  const professionalId = professional?.id ?? ""

  const schedule = useWeeklySchedule({ branchId: resources?.branchId, dentistUserId: professionalId })
  const draftGuard = usePageDraftGuard(schedule.dirty)

  const range = React.useMemo(
    () => ({
      from: new Date().toISOString(),
      to: new Date(Date.now() + AHEAD_DAYS * 86_400_000).toISOString(),
    }),
    [],
  )
  const blocksQuery = useQuery({
    queryKey: ["schedule-blocks", resources?.branchId],
    enabled: Boolean(resources?.branchId),
    queryFn: () =>
      apiFetch<{ data: ScheduleBlock[] }>(
        `/api/agenda/blocks?branchId=${resources?.branchId}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  })
  const blocks = blocksQuery.data?.data ?? []
  const absences = blocks.filter((block) => block.dentistUserId === professionalId)
  const closures = blocks.filter((block) => block.dentistUserId === null)
  // Citas en pie del profesional: las que caen en una ausencia hay que moverlas.
  const standingQuery = useQuery({
    queryKey: ["agenda", "ausencias", resources?.branchId, professionalId, range.from],
    enabled: Boolean(resources?.branchId && professionalId && absences.length > 0),
    queryFn: () => {
      const params = new URLSearchParams({
        branchId: resources?.branchId ?? "",
        from: range.from,
        to: range.to,
        status: "programada,confirmada",
        professionals: professionalId,
      })
      return apiFetch<{ data: AgendaAppointment[] }>(`/api/appointments?${params}`)
    },
  })
  const insideOf = (block: ScheduleBlock) =>
    (standingQuery.data?.data ?? []).filter(
      (item) =>
        Date.parse(item.endsAt) > Date.parse(block.startsAt) &&
        Date.parse(item.startsAt) < Date.parse(block.endsAt),
    )

  const [absenceForm, setAbsenceForm] = React.useState<AbsenceScope | null>(null)
  const [chairForm, setChairForm] = React.useState(false)
  const invalidateBlocks = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["schedule-blocks"] }),
      queryClient.invalidateQueries({ queryKey: ["agenda-availability"] }),
    ])
  }

  const durationMutation = useMutation({
    mutationFn: (minutes: number) =>
      apiFetch("/api/agenda/settings", {
        method: "PUT",
        body: JSON.stringify({ branchId: resources?.branchId, defaultDurationMin: minutes }),
      }),
    onSuccess: async (_result, minutes) => {
      toast.success(`Una cita regular dura ${formatSpan(minutes)}`)
      await queryClient.invalidateQueries({ queryKey: ["agenda-resources"] })
      await queryClient.invalidateQueries({ queryKey: ["agenda-availability"] })
    },
    onError: (error) => toast.error(errorMessage(error)),
  })
  // Mientras se guarda se muestra lo elegido; si falla, vuelve lo que hay en el servidor.
  const regularMinutes =
    durationMutation.isPending && durationMutation.variables !== undefined
      ? durationMutation.variables
      : (resources?.defaultDurationMin ?? 60)

  return (
    <div className="grid gap-4">
      {draftGuard.dialog}
      <PageHeader
        title="Horarios y ausencias"
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
                  })
                }
              />
              <span className="truncate">, zona {resources.timeZone}</span>
            </>
          ) : (
            "El horario y las ausencias de cada profesional, y lo que vale para toda la sede."
          )
        }
      />
      {!resources ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : (
        <>
          <GroupTitle
            title="De cada profesional"
            hint="Su horario de la semana y los días que no viene."
          />
          {professional ? (
            <>
              <ScheduleResourceChips
                wrap
                label="Profesional"
                resources={professionals}
                formatLabel={(item) => shortName(item.label)}
                value={professionalId}
                onChange={(next) => {
                  if (!next || next === professionalId) return
                  draftGuard.requestLeave(() => setDentistId(next))
                }}
              />

              <section className={CARD}>
                <CardHead title={`Horario semanal de ${professional.label}`} />
                <WeeklyScheduleFields schedule={schedule} canEdit={canConfigure} />
                {schedule.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {schedule.error}
                  </p>
                ) : null}
                {canConfigure ? (
                  <div>
                    <Button
                      disabled={!schedule.dirty || schedule.saving}
                      onClick={() => schedule.save()}
                    >
                      Guardar horario
                    </Button>
                  </div>
                ) : null}
              </section>

              <section className={CARD}>
                <CardHead
                  title={`Ausencias de ${professional.label}`}
                  action={
                    canConfigure ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setAbsenceForm({
                            kind: "person",
                            dentistUserId: professional.id,
                            name: professional.label,
                          })
                        }
                      >
                        <Plus aria-hidden />
                        Nueva ausencia
                      </Button>
                    ) : null
                  }
                />
                {absences.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Sin vacaciones ni permisos en los próximos {AHEAD_DAYS} días.
                  </p>
                ) : (
                  <ul className="grid">
                    {absences.map((block) => {
                      const inside = insideOf(block)
                      const first = inside[0]
                      return (
                        <BlockRow
                          key={block.id}
                          block={block}
                          timeZone={resources.timeZone}
                          canConfigure={canConfigure}
                          onDeleted={invalidateBlocks}
                          note={
                            first ? (
                              <Link
                                to="/agenda"
                                search={{
                                  view: "lista",
                                  date: zonedDateOf(first.startsAt, resources.timeZone),
                                  who: professional.id,
                                  branch: resources.branchId,
                                }}
                                className="text-sm font-bold text-warning-foreground underline-offset-4 hover:underline"
                              >
                                {inside.length === 1
                                  ? "1 cita por mover"
                                  : `${inside.length} citas por mover`}
                              </Link>
                            ) : null
                          }
                        />
                      )
                    })}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Esta sede aún no tiene profesionales. Añádelos en Equipo y permisos.
            </p>
          )}

          <GroupTitle
            title="De la sede"
            hint={`Vale para todos los profesionales de ${resources.branchName}.`}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <section className={CARD}>
              <CardHead
                title="Sillones"
                action={
                  canConfigure ? (
                    <Button variant="outline" size="sm" onClick={() => setChairForm(true)}>
                      <Plus aria-hidden />
                      Añadir sillón
                    </Button>
                  ) : null
                }
              />
              {resources.chairs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Esta sede aún no tiene sillones: sin al menos uno no se puede reservar.
                </p>
              ) : (
                <ul className="flex flex-wrap items-start gap-2">
                  {resources.chairs.map((chair) => (
                    <li key={chair.id} className="rounded-lg border px-3 py-1.5 text-sm">
                      {chair.label}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={CARD}>
              <h3 id="duracion-regular" className="flex min-h-9 items-center font-semibold">
                Duración de una cita regular
              </h3>
              <RadioGroup
                aria-labelledby="duracion-regular"
                className="flex flex-wrap gap-2"
                disabled={!canConfigure || durationMutation.isPending}
                value={String(regularMinutes)}
                onValueChange={(next) => durationMutation.mutate(Number(next))}
              >
                {REGULAR_MINUTES.map((minutes) => (
                  <FieldLabel
                    key={minutes}
                    className={cn(
                      "flex h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
                      regularMinutes === minutes && "border-primary bg-primary-soft",
                    )}
                  >
                    <RadioGroupItem value={String(minutes)} />
                    {formatSpan(minutes)}
                  </FieldLabel>
                ))}
              </RadioGroup>
              <p className="text-sm text-muted-foreground">
                Lo que dura una cita sin servicio. Con servicio manda su duración, y al reservar se
                puede cambiar estirando el bloque.
              </p>
            </section>
          </div>

          <section className={CARD}>
            <CardHead
              title="Feriados y cierres"
              action={
                canConfigure ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAbsenceForm({ kind: "branch", name: resources.branchName })}
                  >
                    <Plus aria-hidden />
                    Nuevo feriado o cierre
                  </Button>
                ) : null
              }
            />
            {closures.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Sin feriados ni cierres en los próximos {AHEAD_DAYS} días.
              </p>
            ) : (
              <ul className="grid">
                {closures.map((block) => (
                  <BlockRow
                    key={block.id}
                    block={block}
                    timeZone={resources.timeZone}
                    canConfigure={canConfigure}
                    onDeleted={invalidateBlocks}
                    scope={
                      resources.chairs.find((chair) => chair.id === block.chairId)?.label ??
                      "toda la sede"
                    }
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {chairForm && resources ? (
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
      ) : null}
      {absenceForm && resources ? (
        <AbsenceForm
          branchId={resources.branchId}
          timeZone={resources.timeZone}
          today={zonedDateOf(new Date().toISOString(), resources.timeZone)}
          scope={absenceForm}
          chairs={resources.chairs}
          onClose={() => setAbsenceForm(null)}
          onSaved={async () => {
            setAbsenceForm(null)
            await invalidateBlocks()
          }}
        />
      ) : null}
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
  scope,
  note,
}: {
  block: ScheduleBlock
  timeZone: string
  canConfigure: boolean
  onDeleted: () => Promise<void>
  /** A qué alcanza un cierre: toda la sede o un sillón. */
  scope?: string
  /** Aviso de la fila: citas que quedaron dentro. */
  note?: React.ReactNode
}) {
  const [error, setError] = React.useState("")
  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/agenda/blocks/${block.id}`, { method: "DELETE" }),
    onSuccess: async () => onDeleted(),
    onError: (cause) => setError(errorMessage(cause)),
  })
  const reason = block.reason ?? (block.kind === "ausencia" ? "Ausencia" : "Cierre")
  const when = blockWhen(block, timeZone)
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 text-sm last:border-b-0">
      <Badge variant="soft">{reason}</Badge>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{when}</span>
        {scope ? <span className="text-muted-foreground"> · {scope}</span> : null}
      </span>
      {note}
      {canConfigure ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-label={`Quitar ${reason}: ${when}`}
          disabled={deleteMutation.isPending}
          onClick={() => deleteMutation.mutate()}
        >
          Quitar
        </Button>
      ) : null}
      {error ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </li>
  )
}
