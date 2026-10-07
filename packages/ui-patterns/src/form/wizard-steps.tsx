import { cn } from "@odentia/ui"
import { CheckIcon } from "lucide-react"

/**
 * Indicador de pasos para asistentes (wizards) de 2–5 pasos.
 * Círculos numerados + etiquetas, con conector entre pasos. Solo los pasos
 * ya visitados son clicables (navegación hacia atrás); el resto se muestra
 * deshabilitado. El paso actual lleva `aria-current="step"`.
 */
export type WizardStep = {
  /** Identificador estable del paso (key de React). */
  id: string
  /** Etiqueta visible en español (p. ej. "Paciente"). */
  label: string
}

export type WizardStepsProps = {
  steps: readonly WizardStep[]
  /** Índice numérico del paso actual (0-based). */
  current: number
  /** Índices visitados (solo lectura); solo estos habilitan clic. */
  visited: readonly number[]
  onGo: (index: number) => void
  className?: string
  /** Etiqueta accesible del nav. Por defecto en español. */
  ariaLabel?: string
}

export function WizardSteps({
  steps,
  current,
  visited,
  onGo,
  className,
  ariaLabel = "Progreso del asistente",
}: WizardStepsProps) {
  return (
    <nav aria-label={ariaLabel} className={className}>
      <ol className="flex items-start gap-1 overflow-x-auto sm:gap-2">
        {steps.map((step, index) => {
          const isCurrent = index === current
          const isVisited = visited.includes(index)
          const isDone = isVisited && index < current
          const clickable = isVisited && !isCurrent
          return (
            <li key={step.id} className="flex min-w-0 flex-1 items-start">
              <button
                type="button"
                disabled={!clickable}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`${index + 1}. ${step.label}${isCurrent ? " (paso actual)" : isDone ? " (completado)" : ""}`}
                onClick={() => onGo(index)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  clickable && "cursor-pointer hover:bg-surface-muted/70",
                  !clickable && "cursor-default",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                    isCurrent && "border-primary bg-primary text-primary-foreground",
                    isDone && "border-primary/40 bg-primary/10 text-primary",
                    !isCurrent && !isDone && "border-border bg-muted text-muted-foreground",
                  )}
                >
                  {isDone ? <CheckIcon className="size-3.5" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate text-xs font-medium",
                    isCurrent
                      ? "text-foreground underline underline-offset-4"
                      : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
              </button>
              {index < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mx-1 mt-3.5 h-px min-w-3 flex-1 sm:mx-2",
                    index < current ? "bg-primary/40" : "bg-border",
                  )}
                />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
