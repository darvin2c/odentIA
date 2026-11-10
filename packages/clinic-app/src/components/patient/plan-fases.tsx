import {
  budgetOptionLabel,
  diagnosisCodeLabel,
  isLeftOut,
} from "@odentia/clinical"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@odentia/ui"
import { FormDrawer, submitErrorMessage, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react"
import { useId, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { fetchTreatmentPlans, planDecisionLabel } from "../../lib/budgets"
import { formatDateTime, NEXT_ACTION_LABELS } from "../../lib/clinical-journey"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale } from "../../lib/locale"
import { type PlanItem, planStatusLabel, type TreatmentJourneySummary } from "../../lib/patients"
import { productUi } from "../../product/product-ui"
import { useBudgetFormat } from "./plan/budget-parts"
import {
  groupPlanPaths,
  joinTitles,
  lowerFirst,
  type PlanPathGroup,
  pathCountWord,
  pathTotal,
} from "./plan/plan-paths"

const CLOSED = ["realizado", "cancelado", "reemplazado"]

/** « · Pieza 16», « · Boca completa» o, si el producto no registra el «dónde» (latidIA), nada. */
function site(item: PlanItem): string {
  if (item.toothNumber != null) return ` · Pieza ${item.toothNumber}`
  if (item.quadrant != null) return ` · Cuadrante ${item.quadrant}`
  if (item.arch) return item.arch === "upper" ? " · Arcada superior" : " · Arcada inferior"
  // Indicado sin decir la pieza: se define al hacerlo (no es toda la boca).
  if (item.scope === "tooth" || item.scope === "surfaces") return " · Pieza por definir"
  return productUi().site ? " · Boca completa" : ""
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
  /** «Falta otra sesión» de lo realizado: el tratamiento que se está por reabrir. */
  const [reopening, setReopening] = useState<PlanItem | null>(null)
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
    onError: (cause) => setError(submitErrorMessage(cause)),
  })

  // Lo que compite entre caminos espera a que elija: fuera de las fases y del avance.
  const undecidedPaths = items.filter(
    (item) =>
      item.path != null &&
      !item.path.chosen &&
      (item.decisionStatus === "pendiente" || item.decisionStatus === "pospuesto"),
  )
  const pathGroups = groupPlanPaths(undecidedPaths)
  const inPaths = new Set(undecidedPaths.map((item) => item.id))
  // El camino que no eligió queda plegado al final, por si se quiere consultar.
  const notChosen = items.filter((item) => item.decisionStatus === "no_elegida")
  const phased = items.filter(
    (item) => !inPaths.has(item.id) && item.decisionStatus !== "no_elegida",
  )
  // El avance cuenta solo lo que se hará.
  const active = phased.filter(
    (item) =>
      !["cancelado", "reemplazado"].includes(item.status) && !isLeftOut(item.decisionStatus),
  )
  const done = active.filter((item) => item.status === "realizado").length
  const inProgress = active.filter((item) => item.status === "en_curso").length
  // Por decidir: lo que espera respuesta y cada pieza con caminos (una decisión, no un tratamiento).
  const undecided =
    active.filter(
      (item) => item.decisionStatus === "pendiente" || item.decisionStatus === "pospuesto",
    ).length + pathGroups.length
  // Las fases del producto, en orden (odentIA: de la urgencia al mantenimiento).
  const { phases, defaultPhase } = productUi().plan
  const byPhase = phases.map((phase) => ({
    phase,
    rows: phased
      .filter((item) => (item.phase ?? defaultPhase) === phase.key)
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
      {pathGroups.map((group) => (
        <PathsPending key={group.budgetId} group={group} />
      ))}
      <div className="flex flex-col gap-5">
        {byPhase.map(({ phase, rows }, phaseIndex) =>
          rows.length === 0 ? null : (
            <div key={phase.key} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">
                Fase {phaseIndex + 1} · {phase.label}{" "}
                <span className="font-normal text-muted-foreground">· {phase.hint}</span>
              </h3>
              <ol className="flex flex-col divide-y rounded-lg border">
                {rows.map((item, index) => {
                  position += 1
                  const closed = CLOSED.includes(item.status)
                  const next = nextOf.get(item.id)?.nextAction
                  // Con la cita de su próxima sesión ya reservada, se dice cuándo es (QA del 9 nov, repaso 3).
                  const bookedAt = nextOf.get(item.id)?.nextAppointmentAt ?? null
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
                      {/* Con poco ancho (390 px), las acciones bajan a otra línea y el nombre no se
                          aplasta una palabra por línea (QA del 9 nov, repaso 3). */}
                      <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
                        <span
                          className={`text-sm font-medium ${closed && item.status !== "realizado" ? "line-through" : ""}`}
                        >
                          {item.title}
                          {site(item)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {[
                            // Con su nombre, como la Historia (repaso de la ficha del 9 nov).
                            item.diagnosisCode
                              ? (item.diagnosisName ?? diagnosisCodeLabel(item.diagnosisSystem, item.diagnosisCode))
                              : null,
                            // Con una revisión enviada, lo que espera es el precio nuevo. Lo realizado
                            // ya no dice «Aceptado»: una etiqueta por renglón.
                            item.newTermsPending
                              ? "Precio nuevo por responder"
                              : item.status === "realizado"
                                ? null
                                : planDecisionLabel(item.decisionStatus),
                            // Lo de una sola sesión no dice «0 de 1 sesión»: solo lo de varias.
                            // Lo que se terminó antes de sus previstas lo dice: por eso no ofrece «Falta otra sesión».
                            item.status === "realizado" && sessions < planned
                              ? `Se terminó en la sesión ${sessions} de ${planned}`
                              : planned > 1 || sessions > planned
                                ? `${sessions} de ${plural(planned, "sesión", "sesiones")}`
                                : null,
                            !closed && bookedAt && (next === "iniciar" || next === "continuar")
                              ? `${planned > 1 ? `Sesión ${sessions + 1}` : "Su cita"}: ${formatDateTime(bookedAt)}`
                              : // Lo que espera a otro de la misma pieza no se empieza todavía: dice
                                // tras qué va (repaso final de la atención, B14), como «Qué sigue».
                                !closed && next === "iniciar" && item.waitsFor
                                ? `Va después de ${lowerFirst(item.waitsFor.title)}`
                                : !closed && next
                                  ? NEXT_ACTION_LABELS[next]
                                  : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                      {/* «Pendiente» junto a «Aceptado · Iniciar la primera sesión» o a «Lo está
                          pensando · Registrar la decisión» eran dos etiquetas para lo mismo: lo que
                          no empezó lo dice su renglón (repaso final de la ficha, B12). */}
                      {item.status === "pendiente" ? null : (
                        <Badge variant={statusVariant(item.status)}>
                          {planStatusLabel(item.status)}
                        </Badge>
                      )}
                      <div className="ml-auto flex flex-wrap items-center gap-1">
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
                        {/* Lo que se terminó al llegar a sus sesiones previstas puede necesitar otra (ADR 0164).
                            Es la excepción, no lo que sigue: va como acción secundaria, sin borde
                            (repaso final de la atención, B14). */}
                        {canWrite && item.canAddSession ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            aria-label={`Falta otra sesión en «${item.title}${site(item)}»`}
                            onClick={() => setReopening(item)}
                          >
                            Falta otra sesión…
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant={selected ? "default" : "outline"}
                          aria-pressed={selected}
                          onClick={() => onSelect(item.id)}
                        >
                          {selected ? "Abierto" : "Ver"}
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
      {notChosen.length > 0 ? <NotChosenPath items={notChosen} /> : null}
      {planning ? (
        <PlanningDrawer
          key={planning.id}
          patientId={patientId}
          item={planning}
          onClose={() => setPlanning(null)}
        />
      ) : null}
      {reopening ? (
        <AnotherSessionDialog
          key={reopening.id}
          patientId={patientId}
          item={reopening}
          onClose={() => setReopening(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * Una pieza por decidir entre dos o tres caminos (conservar o extraer): cada
 * camino en una línea, con su suma si se puede sumar. No se agenda ni cuenta
 * en el avance hasta que elija.
 */
function PathsPending({ group }: { group: PlanPathGroup }): React.JSX.Element {
  const { money } = useBudgetFormat()
  const headingId = useId()
  const thinking = group.items.some((item) => item.decisionStatus === "pospuesto")
  const count = pathCountWord(group.pathCount)
  const heading = group.site
    ? `${group.site} · por decidir entre ${count} opciones`
    : `Por decidir entre ${count} opciones`
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/30 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          {heading}
        </h3>
        <Badge variant={thinking ? "warning" : "secondary"}>
          {thinking ? "Lo está pensando" : "Por responder"}
        </Badge>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {group.paths.map((path) => {
          const titles = joinTitles(path.items.map((item) => item.title))
          const words = path.name
            ? `${path.name}: ${lowerFirst(titles)}`
            : titles || budgetOptionLabel(path.position)
          const total = pathTotal(path.items)
          return (
            <li key={path.position}>
              {words}
              {total ? (
                <span className="tabular-nums"> · {money(total.cents, total.currency)}</span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        Fuera de las fases hasta que elija: no se agenda ni cuenta en el avance.
      </p>
    </section>
  )
}

/** Lo del camino que no eligió: no se hará, pero se puede consultar. */
function NotChosenPath({ items }: { items: PlanItem[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2">
      <CollapsibleTrigger
        render={
          <Button type="button" variant="ghost" size="sm" className="group self-start">
            La opción que no eligió · {open ? "Ocultar" : "Ver"}
            <ChevronDown
              aria-hidden
              className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
            />
          </Button>
        }
      />
      <CollapsibleContent>
        <ul className="flex flex-col divide-y rounded-lg border text-sm text-muted-foreground">
          {items.map((item) => (
            <li key={item.id} className="px-3 py-2">
              {item.title}
              {site(item)}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * «Falta otra sesión» de un tratamiento realizado: vuelve a «En curso» con una
 * sesión prevista más y sale otra vez en «Por agendar». Lo firmado y lo cobrado
 * no cambian y reabrir no crea ningún cargo (`reopenPlanItemForSession`). Si esa
 * sesión se cobra lo decide la firma con su regla (`finalizeEncounter`): lo que se
 * cobra una vez ya está cubierto y lo aceptado por sesión tiene su tope; solo lo
 * que va por sesión sin un tope aceptado se cobra. Por eso el diálogo no lo
 * promete y lo deja al cierre. Se confirma porque cambia lo que ve recepción.
 */
function AnotherSessionDialog({
  patientId,
  item,
  onClose,
}: {
  patientId: string
  item: PlanItem
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const next = (item.sessionsDone ?? 0) + 1
  const reopen = useMutation({
    mutationFn: () =>
      apiFetch(`/api/patients/${patientId}/plan/items/${item.id}/another-session`, { method: "POST" }),
    onSuccess: async () => {
      await Promise.all(
        // También los presupuestos: su línea decía «Realizado» hasta recargar (QA del 8 nov).
        ["plan-items", "treatment-plans", "treatment-plan", "patient-summary", "plan-next", "treatment-coordination", "budgets", "budget"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key, patientId] }),
        ),
      )
      onClose()
    },
  })
  return (
    <AlertDialog open onOpenChange={(open) => (!open && !reopen.isPending ? onClose() : undefined)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>¿Le falta otra sesión?</AlertDialogTitle>
          <AlertDialogDescription>
            {`${item.title}${site(item)} vuelve a «En curso» y queda la sesión ${next} por agendar. Reabrirlo no cobra nada: lo firmado y lo cobrado hasta hoy no cambian. Al firmar esa sesión se dice si se cobra.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {reopen.error ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(reopen.error)}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reopen.isPending}>Cancelar</AlertDialogCancel>
          <Button type="button" disabled={reopen.isPending} onClick={() => reopen.mutate()}>
            {reopen.isPending ? "Guardando…" : "Sí, falta otra sesión"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const queryClient = useQueryClient()
  const { phases, defaultPhase } = productUi().plan
  const done = item.sessionsDone ?? 0
  const least = Math.max(1, done)
  const sessionsRule =
    done > 0 ? `Ya se hicieron ${plural(done, "sesión", "sesiones")}: no pueden preverse menos.` : "Entre 1 y 60."
  const save = useMutation({
    mutationFn: (body: { phase: string; plannedSessions: number }) =>
      apiFetch(`/api/patients/${patientId}/plan/items/${item.id}/planning`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  })
  const form = useAppForm({
    defaultValues: { phase: item.phase ?? defaultPhase, plannedSessions: String(item.plannedSessions ?? 1) },
    validators: {
      onSubmit: z.object({
        phase: z.string().refine((value) => phases.some((option) => option.key === value), "Elige una fase."),
        plannedSessions: z.string().refine((value) => {
          const sessions = /^\d{1,2}$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
          return Number.isInteger(sessions) && sessions >= least && sessions <= 60
        }, `Escribe un número de sesiones entre ${least} y 60.`),
      }),
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({ phase: value.phase, plannedSessions: Number(value.plannedSessions.trim()) })
      await queryClient.invalidateQueries({ queryKey: ["plan-items", patientId] })
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Planificar tratamiento"
      description={`${item.title}${site(item)}`}
      onClose={onClose}
      submitLabel="Guardar planificación"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="phase">
          {(field) => (
            <field.SelectField
              label="Fase"
              description="Al cambiar de fase, el tratamiento pasa al final de la nueva."
              options={phases.map((option) => ({ value: option.key, label: option.label }))}
            />
          )}
        </form.AppField>
        <form.AppField name="plannedSessions">
          {(field) => (
            <field.TextField
              label="Sesiones previstas"
              description={sessionsRule}
              type="number"
              inputMode="numeric"
              min={least}
              max={60}
              inputClassName="w-28"
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
