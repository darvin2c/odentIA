import { Button } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import type { OdontogramState, PlanItem } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { OdontogramStudio } from "./odontogram-studio"
import { NewEncounterButton } from "../patient/new-encounter-button"

const CLOSED = new Set(["realizado", "cancelado"])
const DISCARDED = new Set(["rechazado", "reemplazado"])

/** «3 tratamientos por hacer · 1 realizado». */
function planWords(items: PlanItem[]): string {
  const open = items.filter((item) => !CLOSED.has(item.status) && !DISCARDED.has(item.decisionStatus)).length
  const done = items.filter((item) => item.status === "realizado").length
  if (open === 0 && done === 0) return "Todavía no tiene tratamientos indicados."
  return `${open} ${open === 1 ? "tratamiento" : "tratamientos"} por hacer · ${done} ${done === 1 ? "realizado" : "realizados"}`
}

/**
 * Centro del trabajo clínico: el odontograma. El plan vive en su sección
 * (fase 3): debajo solo queda cuánto falta y «Ver en Plan».
 */
export function OdontogramaTab({
  patientId,
  initialTooth,
  birthDate,
  onOpenItem,
  onOpenPlans,
}: {
  patientId: string
  initialTooth?: number
  birthDate?: string | null
  onOpenItem: (itemId: string) => void
  onOpenPlans: () => void
}) {
  const queryClient = useQueryClient()
  const [focusTooth, setFocusTooth] = useState(initialTooth)
  const dirty = useRef(false)
  // Un enlace nuevo (p. ej. Historia → pieza) manda sobre la selección local.
  useEffect(() => setFocusTooth(initialTooth), [initialTooth])

  const chart = useQuery({
    queryKey: ["odontogram", patientId],
    queryFn: () => apiFetch<{ data: OdontogramState }>(`/api/patients/${patientId}/odontogram`),
  })
  const plan = useQuery({
    queryKey: ["plan-items", patientId],
    queryFn: () => apiFetch<{ data: PlanItem[] }>(`/api/patients/${patientId}/plan`),
  })

  const handleSelection = useCallback((teeth: number[]) => {
    // Si el clínico eligió otra pieza en el arco, el foco pedido deja de mandar:
    // así volver a pedir la misma pieza desde el plan la selecciona otra vez.
    setFocusTooth((current) =>
      current != null && teeth.length === 1 && teeth[0] === current ? current : undefined,
    )
  }, [])
  const handleDirty = useCallback((value: boolean) => {
    dirty.current = value
  }, [])

  if (chart.isPending) return <LoadingState message="Cargando odontograma…" />
  if (chart.isError)
    return <QueryErrorState error={chart.error} onRetry={() => void chart.refetch()} />

  const studio = (
    <OdontogramStudio
      patientId={patientId}
      state={chart.data.data}
      initialTooth={focusTooth}
      birthDate={birthDate}
      onSelectionChange={handleSelection}
      onDirtyChange={handleDirty}
      onChanged={() => queryClient.invalidateQueries({ queryKey: ["odontogram", patientId] })}
      belowChart={
        // El plan vive en Plan: aquí solo cuánto queda y el camino para verlo.
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">
            {plan.isPending || plan.isError
              ? "Los tratamientos de esta persona están en Plan."
              : planWords(plan.data.data)}
          </p>
          <Button size="sm" variant="outline" onClick={onOpenPlans}>
            Ver en Plan
          </Button>
        </div>
      }
    />
  )
  // Sin hallazgos, el vacío dice dónde se registran y lleva a atender (ADR 0035).
  if (chart.data.data.history.length > 0) return studio
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4">
        <p className="text-sm">Sin hallazgos. Se registran dentro de una atención</p>
        <NewEncounterButton patientId={patientId} variant="outline" size="sm" />
      </div>
      {studio}
    </div>
  )
}
