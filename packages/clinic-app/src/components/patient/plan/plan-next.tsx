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
import { usePlanNextSteps } from "../next-up"
import { NextStepButton } from "./next-step-action"

export function usePlanNextStep(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ["plan-next", patientId],
    queryFn: () => fetchPlanNextStep(patientId),
    enabled,
    retry: false,
  })
}

/**
 * «Qué sigue» del Plan: la misma lista del Resumen, con un botón en cada fila
 * (QA de la ficha del 8 nov: el Plan tenía tres botones para reservar lo mismo;
 * ahora se reserva aquí y en ningún otro lugar del Plan). El primero, destacado.
 */
export function PlanNextCard({
  patientId,
  patientName,
}: {
  patientId: string
  /** Para «Nueva cita»: la persona ya puesta. */
  patientName: string
}): React.JSX.Element {
  const titleId = useId()
  const query = usePlanNextSteps(patientId)
  if (query.isPending)
    return (
      <SkeletonRegion message="Cargando qué sigue…">
        <PlanNextSkeleton />
      </SkeletonRegion>
    )
  if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
  const steps = query.data.data
  const acting = steps.some((step) => step.action)
  return (
    // El color llama a actuar: sin nada que hacer aquí, es una tarjeta más.
    <section
      aria-labelledby={titleId}
      className={cn("flex flex-col gap-2 rounded-xl border p-4", acting ? "border-primary/40 bg-primary/5" : "elevated bg-card")}
    >
      <h2 id={titleId} className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Qué sigue
      </h2>
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nada pendiente en el plan</p>
      ) : (
        <ul className="flex flex-col divide-y divide-primary/15">
          {steps.map((step, index) => (
            <li
              key={`${step.kind}-${step.action?.appointmentId ?? step.action?.followUpId ?? step.action?.budgetId ?? step.action?.planItemIds?.join() ?? step.text}`}
              className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
                <span className="font-medium">{step.text}</span>
                {step.detail ? <span className="text-sm text-muted-foreground">{step.detail}</span> : null}
              </div>
              <NextStepButton
                patient={{ id: patientId, name: patientName }}
                step={step}
                size="sm"
                variant={index === 0 ? "default" : "outline"}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
