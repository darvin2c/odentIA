/**
 * Barra de la agenda, en una sola fila: dónde y cuándo se mira (sede, flechas,
 * «Hoy» y el periodo rotulado con su resumen) y, a la derecha, cómo (filtros y
 * conmutador de vista). Lo que no cabe salta de línea; en el teléfono la pantalla
 * deja solo el periodo y el conmutador.
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
  /** Contexto de la vista: la sede. */
  context?: React.ReactNode
  /** Periodo visible, ya rotulado («Lunes 21 de setiembre»). */
  rangeLabel: string
  /**
   * Control que ocupa el lugar del rótulo cuando el periodo se puede elegir
   * (un botón con el mismo texto que abre el calendario).
   */
  rangeControl?: React.ReactNode
  /** Lo que conviene saber del periodo («11 citas · 4 por confirmar»). */
  summary?: React.ReactNode
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
  /** Búsqueda y filtros de la vista, antes del conmutador. */
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
  filters,
  action,
  className,
}: ScheduleToolbarProps) {
  const hasViews = views != null && views.length > 0
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2", className)}>
      {context ? <div className="flex min-w-0 items-center gap-2">{context}</div> : null}

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

      {/* El periodo cede sitio antes de que la barra salte a otra fila; con una columna al lado, sí salta. */}
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-x-2 overflow-hidden p-0.5 sm:min-w-60">
        {rangeControl ?? (
          <span className="min-w-0 truncate text-lg font-bold tracking-tight">{rangeLabel}</span>
        )}
        {summary ? <span className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">{summary}</span> : null}
        {refreshing ? <DataRefreshMarker /> : null}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {filters}
        {hasViews ? (
          <Tabs value={view ?? null} onValueChange={(next) => onViewChange?.(String(next))}>
            <TabsList aria-label="Vista de la agenda">
              {views.map((option) => (
                <TabsTrigger key={option.id} value={option.id} className="px-2 sm:px-2.5">
                  {/* En el teléfono no caben ícono y texto junto a la fecha: queda el texto. */}
                  {option.icon ? <span className="contents max-sm:hidden">{option.icon}</span> : null}
                  {option.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : null}
        {action}
      </div>
    </div>
  )
}
