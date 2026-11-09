/**
 * «No contesta · volver a llamar» al seguir un presupuesto entregado (QA de la ficha del 9 nov):
 * recepción llama, no contesta, y anota cuándo volver a llamar. No es una respuesta: el
 * presupuesto sigue esperando la suya y queda una tarea de recepción con esa fecha (la de
 * Tareas), que se cierra sola cuando se anota qué respondió.
 */
import { Button, toast } from "@odentia/ui"
import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { apiFetch } from "../../../lib/api"
import { PLAN_QUERY_KEYS } from "../../../lib/budgets"
import { usePermission } from "../../../lib/crm"
import { activeOrgLocale } from "../../../lib/locale"
import { errorMessage } from "../../agenda/shared"

/** «Mañana», «En 3 días» o «En una semana», sin caer en domingo. */
const CHOICES = [
  { days: 1, label: "Mañana" },
  { days: 3, label: "En 3 días" },
  { days: 7, label: "En una semana" },
] as const

function callDay(days: number): Date {
  const date = new Date()
  date.setDate(date.getDate() + days)
  if (date.getDay() === 0) date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date
}

export function BudgetNoAnswer({
  patientId,
  budgetId,
  onSaved,
  onCancel,
}: {
  patientId: string
  budgetId: string
  onSaved: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  const canTask = usePermission("tasks.write")
  const queryClient = useQueryClient()
  const [days, setDays] = useState<number>(3)
  const [saving, setSaving] = useState(false)
  if (!canTask) return null
  const day = callDay(days)
  const dayWords = day
    .toLocaleDateString(activeOrgLocale(), { weekday: "short", day: "numeric", month: "short" })
    .replace(/\./g, "")
  const save = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/patients/${patientId}/budgets/${budgetId}/no-answer`, {
        method: "POST",
        body: JSON.stringify({ callAgainAt: day.toISOString() }),
      })
      await Promise.all([
        ...PLAN_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key, patientId] })),
        queryClient.invalidateQueries({ queryKey: ["people"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      ])
      toast.success(`Queda para volver a llamar el ${dayWords}`)
      onSaved()
    } catch (cause) {
      toast.error(errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-semibold">¿Cuándo vuelves a llamar?</legend>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map((choice) => (
          <Button
            key={choice.days}
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-8"
            variant={days === choice.days ? "default" : "outline"}
            aria-pressed={days === choice.days}
            onClick={() => setDays(choice.days)}
          >
            {choice.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={saving} onClick={() => void save()}>
          {`Guardar: volver a llamar el ${dayWords}`}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </fieldset>
  )
}
