import { common, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import type { OdontogramState, PlanItem } from "../../lib/patients"
import { QueryErrorState } from "../../lib/query-error"
import { OdontogramStudio } from "../odontogram-studio"
import { NewEncounterButton } from "./new-encounter-button"
import { PlanLinkedPanel } from "./plan-linked-panel"

/**
 * Centro del trabajo clínico: el odontograma y, debajo, el plan enlazado pieza
 * por pieza. La pieza es el índice de hallazgos, indicaciones y actos.
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
  const [selection, setSelection] = useState<number[]>(initialTooth ? [initialTooth] : [])
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
    setSelection(teeth)
    // Si el clínico eligió otra pieza en el arco, el foco pedido deja de mandar:
    // así volver a pedir la misma pieza desde el plan la selecciona otra vez.
    setFocusTooth((current) =>
      current != null && teeth.length === 1 && teeth[0] === current ? current : undefined,
    )
  }, [])
  const handleDirty = useCallback((value: boolean) => {
    dirty.current = value
  }, [])
  const pickTooth = (tooth: number) => {
    if (dirty.current && !window.confirm(common.confirm.unsavedMessage)) return
    setFocusTooth(tooth)
  }

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
        plan.isPending ? (
          <LoadingState message="Cargando plan…" />
        ) : plan.isError ? (
          <QueryErrorState error={plan.error} onRetry={() => void plan.refetch()} />
        ) : (
          <PlanLinkedPanel
            items={plan.data.data}
            state={chart.data.data}
            selection={selection}
            onPickTooth={pickTooth}
            onOpenItem={onOpenItem}
            onOpenPlans={onOpenPlans}
          />
        )
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
