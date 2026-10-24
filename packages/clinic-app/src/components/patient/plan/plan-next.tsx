/**
 * «Qué sigue» del plan: una frase y un botón que decide el servidor
 * (`/next-step`, la misma regla de Plan, Resumen, «Te espera» y el
 * Administrador). La pantalla no deduce el paso: lo muestra y, si el rol puede,
 * ofrece el botón.
 */
import { Button } from "@odentia/ui"
import { Skeleton } from "@odentia/ui"
import { useQuery } from "@tanstack/react-query"
import { fetchPlanNextStep, type PlanNextStep } from "../../../lib/budgets"
import { QueryErrorState } from "../../../lib/query-error"
import { BudgetSendButton } from "./budget-send"

export function usePlanNextStep(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ["plan-next", patientId],
    queryFn: () => fetchPlanNextStep(patientId),
    enabled,
    retry: false,
  })
}

export function PlanNextCard({
  patientId,
  onAction,
}: {
  patientId: string
  /** Lo que hace el botón que no es enviar: abrir la respuesta, agendar o reservar el control. */
  onAction: (step: PlanNextStep) => void
}): React.JSX.Element {
  const query = usePlanNextStep(patientId)
  if (query.isPending)
    return (
      <div className="rounded-xl border bg-card p-4" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
      </div>
    )
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const step = query.data.data
  return (
    <section
      aria-label="Qué sigue"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Qué sigue</span>
        <span className="font-medium">{step.text}</span>
        {step.detail ? <span className="text-sm text-muted-foreground">{step.detail}</span> : null}
      </div>
      {step.action ? (
        step.kind === "enviar" && step.action.budgetId ? (
          <BudgetSendButton patientId={patientId} budgetId={step.action.budgetId} showRecipient={false} />
        ) : (
          <Button type="button" onClick={() => onAction(step)}>
            {step.action.label}
          </Button>
        )
      ) : null}
    </section>
  )
}
