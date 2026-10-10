/**
 * Barra de la agenda: cuándo se está mirando (flechas, «Hoy» y el periodo
 * rotulado con su resumen) y cómo (conmutador de vista y filtros). Lo que más
 * se usa, a la izquierda; lo que se cambia poco, a la derecha.
 *
 * El conmutador es un fieldset de botones con `aria-pressed`: `@odentia/ui`
 * no exporta el ToggleGroup del registry, así que la alternativa semántica
 * simple es la correcta.
 */

import { Button, cn } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type * as React from "react"

export interface ScheduleViewOption {
  id: string
  label: string
  icon?: React.ReactNode
}

export interface ScheduleToolbarProps {
  /** Contexto de la vista: sede y zona, ya rotulados. */
  context?: React.ReactNode
  /** Periodo visible, ya rotulado («Lunes 21 de setiembre»). */
  rangeLabel: string
  /** Lo que conviene saber del periodo («18 citas · 5 por confirmar»). */
  summary?: string
  onPrevious?: () => void
  onNext?: () => void
  onToday?: () => void
  /** Nombres de las flechas según el periodo («Día anterior», «Semana siguiente»). */
  previousLabel?: string
  nextLabel?: string
  views?: ScheduleViewOption[]
  view?: string
  onViewChange?: (id: string) => void
  /** El conmutador ocupa todo el ancho (teléfono). */
  stretchViews?: boolean
  /** Filtros de la vista, tras el conmutador. */
  filters?: React.ReactNode
  /** La única acción sólida de la pantalla («Nueva cita»). */
  action?: React.ReactNode
  className?: string
}

export function ScheduleToolbar({
  context,
  rangeLabel,
  summary,
  onPrevious,
  onNext,
  onToday,
  previousLabel = "Anterior",
  nextLabel = "Siguiente",
  views,
  view,
  onViewChange,
  stretchViews = false,
  filters,
  action,
  className,
}: ScheduleToolbarProps) {
  const hasViews = views != null && views.length > 0
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {context ? <div className="flex min-w-0 flex-col gap-0.5">{context}</div> : null}

      {onPrevious || onNext || onToday ? (
        <div className="flex shrink-0 items-center gap-1">
          {onPrevious ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onPrevious}
              aria-label={previousLabel}
            >
              <ChevronLeft />
            </Button>
          ) : null}
          {onToday ? (
            <Button type="button" variant="outline" onClick={onToday}>
              Hoy
            </Button>
          ) : null}
          {onNext ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={onNext}
              aria-label={nextLabel}
            >
              <ChevronRight />
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 truncate text-lg font-bold tracking-tight">{rangeLabel}</span>
        {summary ? <span className="text-sm text-muted-foreground">{summary}</span> : null}
      </div>

      {hasViews ? (
        <fieldset
          className={cn(
            "flex min-w-0 gap-0.5 rounded-xl border-0 bg-secondary p-[3px]",
            stretchViews ? "w-full" : "ml-auto",
          )}
        >
          <legend className="sr-only">Vista de la agenda</legend>
          {views.map((option) => {
            const active = option.id === view
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                onClick={() => onViewChange?.(option.id)}
                className={cn(
                  "flex items-center justify-center gap-1.5 rounded-[9px] px-4 text-[13px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  stretchViews ? "h-10 flex-1" : "h-[30px]",
                  active
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.icon}
                {option.label}
              </button>
            )
          })}
        </fieldset>
      ) : null}

      {filters ? (
        <div className={cn("flex min-w-0 items-center gap-2", !hasViews && "ml-auto")}>
          {filters}
        </div>
      ) : null}

      {action ? <div className={hasViews || filters ? "" : "ml-auto"}>{action}</div> : null}
    </div>
  )
}
