import { conditionLabel, findingColor } from "@odentia/clinical"
import { Badge, Button } from "@odentia/ui"
import { planDecisionLabel } from "../../lib/budgets"
import {
  type OdontogramState,
  type PlanItem,
  planStatusLabel,
  winnersAsOf,
} from "../../lib/patients"

const CLOSED_STATUS = new Set(["realizado", "cancelado"])
const DISCARDED_DECISION = new Set(["rechazado", "reemplazado"])

function scopeLabel(item: PlanItem): string {
  if (item.toothNumber) return `Pieza ${item.toothNumber}`
  if (item.quadrant) return `Cuadrante ${item.quadrant}`
  if (item.arch) return `Arcada ${item.arch}`
  return "Boca completa"
}

/** Hallazgos por tratar (rojo normativo) cuya pieza no tiene ninguna indicación abierta. */
function findingsWithoutPlan(
  state: OdontogramState,
  open: PlanItem[],
): Array<{ id: string; tooth: number; label: string }> {
  const planned = new Set(open.map((item) => item.toothNumber).filter(Boolean))
  const byId = new Map(state.history.map((entry) => [entry.id, entry]))
  const current = winnersAsOf(state.history)
  const result: Array<{ id: string; tooth: number; label: string }> = []
  for (const [tooth, toothState] of Object.entries(current.teeth)) {
    const number = Number(tooth)
    if (planned.has(number)) continue
    for (const entryId of toothState.entries) {
      const entry = byId.get(entryId)
      if (!entry || entry.needsReview || findingColor(entry) !== "red") continue
      result.push({ id: entry.id, tooth: number, label: conditionLabel(entry.condition) })
    }
  }
  return result.sort((a, b) => a.tooth - b.tooth)
}

/**
 * Plan junto al odontograma: cada indicación abierta señala su pieza y cada
 * pieza seleccionada resalta sus indicaciones. La gestión completa (alternativas,
 * presupuestos, avance) sigue en sus secciones; aquí solo se orienta.
 */
export function PlanLinkedPanel({
  items,
  state,
  selection,
  onPickTooth,
  onOpenItem,
  onOpenPlans,
}: {
  items: PlanItem[]
  state: OdontogramState
  selection: number[]
  onPickTooth: (tooth: number) => void
  onOpenItem: (itemId: string) => void
  onOpenPlans: () => void
}) {
  const open = items.filter(
    (item) => !CLOSED_STATUS.has(item.status) && !DISCARDED_DECISION.has(item.decisionStatus),
  )
  const done = items.filter((item) => item.status === "realizado").length
  const unplanned = findingsWithoutPlan(state, open)

  return (
    <section
      className="flex min-w-0 flex-col gap-4 elevated rounded-xl border bg-card p-6"
      aria-labelledby="plan-vinculado"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="plan-vinculado" className="font-heading text-base font-medium">
            Plan de tratamiento
          </h2>
          <p className="text-sm text-muted-foreground">
            {open.length} por hacer · {done} realizado{done === 1 ? "" : "s"}. Elige una indicación
            para ver su pieza en el odontograma.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={onOpenPlans}>
          Planes y presupuestos
        </Button>
      </div>

      {open.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin indicaciones abiertas. Los tratamientos se indican durante una atención.
        </p>
      ) : (
        <ul className="flex flex-col divide-y">
          {open.map((item) => {
            const tooth = item.toothNumber
            const active = tooth != null && selection.includes(tooth)
            return (
              <li
                key={item.id}
                className={`flex flex-wrap items-center justify-between gap-3 py-3 ${active ? "-mx-3 rounded-lg bg-primary-soft px-3" : ""}`}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{item.title}</span>
                  <span className="text-sm text-muted-foreground">
                    {scopeLabel(item)}
                    {item.surfaces.length > 0 ? ` · ${item.surfaces.length} superficie(s)` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={item.decision === "aceptado" ? "success" : "outline"}>
                    {planDecisionLabel(item.decision)}
                  </Badge>
                  <Badge variant="secondary">{planStatusLabel(item.status)}</Badge>
                  {tooth != null ? (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={active}
                      onClick={() => onPickTooth(tooth)}
                    >
                      Ver pieza {tooth}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => onOpenItem(item.id)}>
                    Ver tratamiento
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {unplanned.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning-soft p-4">
          <p className="text-sm font-medium text-warning">
            {unplanned.length === 1
              ? "1 hallazgo por tratar sin indicación en el plan"
              : `${unplanned.length} hallazgos por tratar sin indicación en el plan`}
          </p>
          <ul className="flex flex-wrap gap-2">
            {unplanned.map((finding) => (
              <li key={finding.id}>
                <Button size="sm" variant="outline" onClick={() => onPickTooth(finding.tooth)}>
                  Pieza {finding.tooth} · {finding.label}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
