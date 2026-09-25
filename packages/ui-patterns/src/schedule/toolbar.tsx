/**
 * Barra de la agenda: contexto (sede y zona horaria ya rotuladas), rango
 * visible, navegación por flechas y «Hoy», conmutador de vista y UNA acción
 * principal. Una acción sólida por pantalla, la regla de UX del repo.
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
  /** Rango visible, ya rotulado («Lunes 21 de setiembre»). */
  rangeLabel: string
  onPrevious?: () => void
  onNext?: () => void
  onToday?: () => void
  views?: ScheduleViewOption[]
  view?: string
  onViewChange?: (id: string) => void
  /** La única acción sólida de la pantalla («Nueva cita»). */
  action?: React.ReactNode
  className?: string
}

export function ScheduleToolbar({
  context,
  rangeLabel,
  onPrevious,
  onNext,
  onToday,
  views,
  view,
  onViewChange,
  action,
  className,
}: ScheduleToolbarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {context ? <div className="flex min-w-0 flex-col gap-0.5">{context}</div> : null}

      <div className="flex items-center gap-1">
        {onPrevious ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onPrevious}
            aria-label="Anterior"
          >
            <ChevronLeft />
          </Button>
        ) : null}
        <span className="min-w-0 truncate px-1 text-sm font-medium">{rangeLabel}</span>
        {onNext ? (
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={onNext}
            aria-label="Siguiente"
          >
            <ChevronRight />
          </Button>
        ) : null}
        {onToday ? (
          <Button type="button" variant="outline" size="sm" onClick={onToday}>
            Hoy
          </Button>
        ) : null}
      </div>

      {views && views.length > 0 ? (
        <fieldset className="ml-auto flex min-w-0 gap-0.5 border-0 p-0">
          <legend className="sr-only">Vista de la agenda</legend>
          {views.map((option) => {
            const active = option.id === view
            return (
              <Button
                key={option.id}
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={active}
                onClick={() => onViewChange?.(option.id)}
              >
                {option.icon}
                <span className="hidden sm:inline">{option.label}</span>
              </Button>
            )
          })}
        </fieldset>
      ) : null}

      {action ? <div className={views && views.length > 0 ? "" : "ml-auto"}>{action}</div> : null}
    </div>
  )
}
