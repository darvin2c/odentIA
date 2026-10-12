import { TREATMENT_PHASE_LABELS, TREATMENT_PHASES, type TreatmentPhase } from "@odentia/clinical"
import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp } from "lucide-react"
import { useId, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "../../lib/budgets"
import { NEXT_ACTION_LABELS } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { type PlanItem, planStatusLabel, type TreatmentJourneySummary } from "../../lib/patients"
import { activeOrgLocale } from "../../lib/locale"

const CLOSED = ["realizado", "cancelado", "reemplazado"]

const PHASE_HINTS: Record<TreatmentPhase, string> = {
  urgencia: "Dolor, infección, trauma",
  basica: "Control de caries y periodonto",
  quirurgica: "Exodoncias, cirugía e implantes",
  rehabilitadora: "Prótesis, coronas, ortodoncia",
  mantenimiento: "Controles periódicos",
}

function site(item: PlanItem): string {
  if (item.toothNumber != null) return `Pieza ${item.toothNumber}`
  if (item.quadrant != null) return `Cuadrante ${item.quadrant}`
  if (item.arch) return item.arch === "upper" ? "Arcada superior" : "Arcada inferior"
  return "Boca completa"
}

function statusVariant(status: string): "success" | "outline" | "secondary" {
  if (status === "realizado") return "success"
  if (CLOSED.includes(status)) return "secondary"
  return "outline"
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Plan de tratamiento por fases y en orden de ejecución. Cada tratamiento
 * tiene un solo estado, la decisión como atributo, su progreso por sesiones y
 * el siguiente paso. Reordenar es por botones (teclado), no por arrastre.
 */
export function PlanPhases({
  patientId,
  items,
  journeys,
  selectedId,
  onSelect,
}: {
  patientId: string
  items: PlanItem[]
  journeys: TreatmentJourneySummary[]
  selectedId: string
  onSelect: (itemId: string) => void
}): React.JSX.Element {
  const plansQuery = useQuery({
    queryKey: ["treatment-plans", patientId],
    queryFn: () => fetchTreatmentPlans(patientId),
  })
  // El orden es propio de cada plan: con varios planes, uno debajo del otro.
  const planIds = [...new Set(items.map((item) => item.planId))]
  const plans = plansQuery.data?.data ?? []
  const ordered = [...planIds].sort((a, b) => {
    const pa = plans.find((p) => p.plan.id === a)?.plan.createdAt ?? ""
    const pb = plans.find((p) => p.plan.id === b)?.plan.createdAt ?? ""
    return pb.localeCompare(pa)
  })
  return (
    <div className="flex flex-col gap-4">
      {ordered.map((planId) => {
        const info = plans.find((p) => p.plan.id === planId)
        return (
          <PlanPhasesGroup
            key={planId}
            patientId={patientId}
            title={
              info
                ? `${info.plan.title} · abierto el ${new Date(info.plan.createdAt).toLocaleDateString(activeOrgLocale(), { day: "2-digit", month: "short", year: "numeric" })}`
                : "Plan de tratamiento"
            }
            items={items.filter((item) => item.planId === planId)}
            journeys={journeys}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )
      })}
      <p className="text-xs text-muted-foreground">
        La fase se propone por el tipo de servicio y se puede cambiar. Cada procedimiento registrado
        en una atención suma una sesión.
      </p>
    </div>
  )
}

function PlanPhasesGroup({
  patientId,
  title,
  items,
  journeys,
  selectedId,
  onSelect,
}: {
  patientId: string
  title: string
  items: PlanItem[]
  journeys: TreatmentJourneySummary[]
  selectedId: string
  onSelect: (itemId: string) => void
}): React.JSX.Element {
  const headingId = useId()
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  const [planning, setPlanning] = useState<PlanItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const nextOf = new Map(journeys.map((row) => [row.item.id, row]))
  const move = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: "up" | "down" }) =>
      apiFetch(`/api/patients/${patientId}/plan/items/${id}/planning`, {
        method: "PATCH",
        body: JSON.stringify({ move: direction }),
      }),
    onSuccess: () => {
      setError(null)
      return queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? (cause.shape.message ?? cause.message) : String(cause)),
  })

  const active = items.filter((item) => !["cancelado", "reemplazado"].includes(item.status))
  const done = active.filter((item) => item.status === "realizado").length
  const inProgress = active.filter((item) => item.status === "en_curso").length
  const undecided = active.filter((item) => item.decisionStatus === "pendiente").length
  const byPhase = TREATMENT_PHASES.map((phase) => ({
    phase,
    rows: items
      .filter((item) => (item.phase ?? "basica") === phase)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
  }))
  let position = 0

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-4 elevated rounded-xl border bg-card p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="font-heading text-base font-medium">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">
          {plural(active.length, "tratamiento", "tratamientos")} ·{" "}
          {plural(done, "realizado", "realizados")} · {inProgress} en curso · {undecided} por
          decidir · progreso {done} de {active.length}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col gap-5">
        {byPhase.map(({ phase, rows }, phaseIndex) =>
          rows.length === 0 ? null : (
            <div key={phase} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                Fase {phaseIndex + 1} · {TREATMENT_PHASE_LABELS[phase]}{" "}
                <span className="font-normal text-muted-foreground">· {PHASE_HINTS[phase]}</span>
              </h3>
              <ol className="flex flex-col divide-y rounded-lg border">
                {rows.map((item, index) => {
                  position += 1
                  const closed = CLOSED.includes(item.status)
                  const next = nextOf.get(item.id)?.nextAction
                  const selected = item.id === selectedId
                  const planned = item.plannedSessions ?? 1
                  const sessions = item.sessionsDone ?? 0
                  return (
                    <li
                      key={item.id}
                      className={`flex flex-wrap items-center gap-3 px-3 py-2.5 ${
                        selected ? "bg-muted shadow-[inset_2px_0_0_0_var(--color-primary)]" : ""
                      }`}
                    >
                      <span className="w-5 text-sm tabular-nums text-muted-foreground">
                        {position}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={`text-sm font-medium ${closed && item.status !== "realizado" ? "line-through" : ""}`}
                        >
                          {item.title} · {site(item)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {[
                            item.diagnosisCode,
                            planDecisionLabel(item.decisionStatus),
                            `${sessions} de ${plural(planned, "sesión", "sesiones")}`,
                            !closed && next ? NEXT_ACTION_LABELS[next] : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      <Badge variant={statusVariant(item.status)}>
                        {planStatusLabel(item.status)}
                      </Badge>
                      <div className="flex items-center gap-1">
                        {canWrite && !closed ? (
                          <>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Subir «${item.title}»`}
                              disabled={index === 0 || move.isPending}
                              onClick={() => move.mutate({ id: item.id, direction: "up" })}
                            >
                              <ArrowUp aria-hidden className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Bajar «${item.title}»`}
                              disabled={index === rows.length - 1 || move.isPending}
                              onClick={() => move.mutate({ id: item.id, direction: "down" })}
                            >
                              <ArrowDown aria-hidden className="size-4" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setPlanning(item)}
                            >
                              Planificar…
                            </Button>
                          </>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          aria-pressed={selected}
                          onClick={() => onSelect(item.id)}
                        >
                          {selected ? "Abierto abajo" : "Ver"}
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          ),
        )}
      </div>
      {planning ? (
        <PlanningDrawer
          key={planning.id}
          patientId={patientId}
          item={planning}
          onClose={() => setPlanning(null)}
        />
      ) : null}
    </section>
  )
}

function PlanningDrawer({
  patientId,
  item,
  onClose,
}: {
  patientId: string
  item: PlanItem
  onClose: () => void
}) {
  const uid = useId()
  const queryClient = useQueryClient()
  const [phase, setPhase] = useState<TreatmentPhase>(item.phase ?? "basica")
  const [sessions, setSessions] = useState(String(item.plannedSessions ?? 1))
  const done = item.sessionsDone ?? 0
  const sessionsNumber = Number(sessions)
  const sessionsValid =
    Number.isInteger(sessionsNumber) && sessionsNumber >= Math.max(1, done) && sessionsNumber <= 60
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/plan/items/${item.id}/planning`, {
        method: "PATCH",
        body: JSON.stringify({ phase, plannedSessions: sessionsNumber }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
      onClose()
    },
  })
  return (
    <FormDrawer
      open
      title="Planificar tratamiento"
      description={`${item.title} · ${site(item)}`}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault()
        if (sessionsValid) save.mutate()
      }}
      isSubmitting={save.isPending}
      isDirty={phase !== (item.phase ?? "basica") || sessions !== String(item.plannedSessions ?? 1)}
      submitDisabled={!sessionsValid}
      submitLabel="Guardar planificación"
      error={
        save.error instanceof ApiError
          ? (save.error.shape.message ?? "No se pudo guardar.")
          : save.error
            ? "No se pudo guardar."
            : null
      }
    >
      <div className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`${uid}-phase`}>Fase</FieldLabel>
          <Select
            value={phase}
            items={TREATMENT_PHASE_LABELS}
            onValueChange={(value) => {
              if (value) setPhase(value as TreatmentPhase)
            }}
          >
            <SelectTrigger id={`${uid}-phase`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREATMENT_PHASES.map((value) => (
                <SelectItem key={value} value={value}>
                  {TREATMENT_PHASE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Al cambiar de fase, el tratamiento pasa al final de la nueva.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${uid}-sessions`}>Sesiones previstas</FieldLabel>
          <Input
            id={`${uid}-sessions`}
            type="number"
            inputMode="numeric"
            min={Math.max(1, done)}
            max={60}
            className="w-28"
            value={sessions}
            aria-invalid={!sessionsValid}
            onChange={(event) => setSessions(event.target.value)}
          />
          <FieldDescription>
            {done > 0
              ? `Ya se hicieron ${plural(done, "sesión", "sesiones")}: no pueden preverse menos.`
              : "Entre 1 y 60."}
          </FieldDescription>
        </Field>
      </div>
    </FormDrawer>
  )
}
