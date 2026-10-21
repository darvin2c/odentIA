/**
 * Barra de la agenda: cuándo se está mirando (flechas, «Hoy» y el periodo
 * rotulado con su resumen) y cómo (conmutador de vista y filtros). Lo que más
 * se usa, a la izquierda; lo que se cambia poco, a la derecha.
 *
 * El conmutador de vista son pestañas (`Tabs`), la misma pieza que Finanzas e
 * Inventario: cambiar de vista es siempre una pestaña.
 */

import { Button, cn, Tabs, TabsList, TabsTrigger } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type * as React from "react"

import { DataRefreshMarker } from "../loading-state.js"
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
  /**
   * Control que ocupa el lugar del rótulo cuando el periodo se puede elegir
   * (un botón con el mismo texto que abre el calendario).
   */
  rangeControl?: React.ReactNode
  /** Lo que conviene saber del periodo («18 citas · 5 por confirmar»). */
  summary?: string
  /** Se están volviendo a pedir datos que ya están en pantalla: lo dice sin quitarlos. */
  refreshing?: boolean
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
  rangeControl,
  summary,
  refreshing = false,
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
        {rangeControl ?? (
          <span className="min-w-0 truncate text-lg font-bold tracking-tight">{rangeLabel}</span>
        )}
        {summary ? <span className="text-sm text-muted-foreground">{summary}</span> : null}
        {refreshing ? <DataRefreshMarker /> : null}
      </div>

      {hasViews ? (
        <Tabs
          value={view ?? null}
          onValueChange={(next) => onViewChange?.(String(next))}
          className={cn(stretchViews ? "w-full" : "ml-auto")}
        >
          <TabsList aria-label="Vista de la agenda" className={cn(stretchViews && "w-full")}>
            {views.map((option) => (
              <TabsTrigger
                key={option.id}
                value={option.id}
                className={cn(stretchViews && "h-10")}
              >
                {option.icon}
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
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
