/**
 * «Qué sigue» del plan: una frase y un botón que decide el servidor
 * (`/next-step`, la misma regla de Plan, Resumen, «Te espera» y el
 * Administrador). La pantalla no deduce el paso: lo muestra y, si el rol puede,
 * ofrece el botón.
 */
import { cn } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useId } from "react"
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
  const titleId = useId()
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
    // El color llama a actuar: sin nada que hacer aquí, es una tarjeta más.
    <section
      aria-labelledby={titleId}
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border p-4",
        step.action ? "border-primary/40 bg-primary/5" : "elevated bg-card",
      )}
    >
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
        <h2 id={titleId} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Qué sigue
        </h2>
        <span className="font-medium">{step.text}</span>
        {step.detail ? <span className="text-sm text-muted-foreground">{step.detail}</span> : null}
      </div>
      <NextStepButton patient={{ id: patientId, name: patientName }} step={step} />
    </section>
  )
}
