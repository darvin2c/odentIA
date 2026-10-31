/**
 * «Qué sigue» del plan: una frase y un botón que decide el servidor
 * (`/next-step`, la misma regla de Plan, Resumen, «Te espera» y el
 * Administrador). La pantalla no deduce el paso: lo muestra y, si el rol puede,
 * ofrece el botón.
 */
import { SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { fetchPlanNextStep } from "../../../lib/budgets"
import { QueryErrorState } from "../../../lib/query-error"
import { PlanNextSkeleton } from "../../skeletons/person-sections"
import { NextStepButton } from "./next-step-action"

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
  patientName,
}: {
  patientId: string
  /** Para «Nueva cita»: la persona ya puesta. */
  patientName: string
}): React.JSX.Element {
  const query = usePlanNextStep(patientId)
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando qué sigue…">
        <PlanNextSkeleton />
      </SkeletonRegion>
    )
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const step = query.data.data
  return (
    <section
      aria-label="Qué sigue"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-primary/40 bg-primary/5 p-4"
    >
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Qué sigue</span>
        <span className="font-medium">{step.text}</span>
        {step.detail ? <span className="text-sm text-muted-foreground">{step.detail}</span> : null}
      </div>
      <NextStepButton patient={{ id: patientId, name: patientName }} step={step} />
    </section>
  )
}
