/**
 * Resumen del día por estado: cuántas citas hay de cada tipo. Cada ficha es
 * también el filtro de la lista, así el número y la acción son la misma cosa.
 * En teléfono la fila se desplaza de lado en vez de apilarse.
 */

import { cn } from "@odentia/ui"
import { ListChecks } from "lucide-react"
import type * as React from "react"

import { SCHEDULE_AGENDA_LABELS, StatusIcon } from "./status.js"
import type { ScheduleStatus } from "./types.js"

const PLURAL: Record<ScheduleStatus, string> = {
  programada: "Por confirmar",
  confirmada: "Confirmadas",
  atendida: "Atendidas",
  no_asistio: "No asistieron",
  cancelada: "Canceladas",
}

const TILE_ICON_SURFACE: Record<ScheduleStatus, string> = {
  programada: "bg-warning-soft",
  confirmada: "bg-success-soft",
  atendida: "bg-secondary",
  no_asistio: "bg-danger-soft",
  cancelada: "bg-muted",
}

export interface ScheduleStatusSummaryProps {
  /** Citas por estado, contadas sobre todo el día y no sobre lo filtrado. */
  counts: Partial<Record<ScheduleStatus, number>>
  /** Estado elegido; null = todas. */
  value: ScheduleStatus | null
  onChange: (value: ScheduleStatus | null) => void
  /** Estados que siempre tienen ficha; el resto aparece solo si tiene citas. */
  statuses?: ScheduleStatus[]
  className?: string
}

export function ScheduleStatusSummary({
  counts,
  value,
  onChange,
  statuses = ["programada", "confirmada", "atendida"],
  className,
}: ScheduleStatusSummaryProps) {
  const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0)
  const optional: ScheduleStatus[] = ["no_asistio", "cancelada"]
  const shown = [
    ...statuses,
    ...optional.filter((status) => !statuses.includes(status) && (counts[status] ?? 0) > 0),
  ]
  const tile = (
    key: string,
    pressed: boolean,
    count: number,
    label: string,
    icon: React.ReactNode,
    onSelect: () => void,
  ) => (
    <button
      key={key}
      type="button"
      aria-pressed={pressed}
      onClick={onSelect}
      className={cn(
        "flex h-[68px] min-w-36 shrink-0 items-center gap-3 rounded-2xl border bg-card px-3.5 text-left outline-none transition-colors sm:min-w-0",
        "hover:border-agent-border focus-visible:ring-2 focus-visible:ring-ring",
        pressed && "border-primary bg-agent-soft ring-1 ring-primary",
      )}
    >
      {icon}
      <span className="flex flex-col">
        <span className="text-[22px] leading-6 font-bold tabular-nums">{count}</span>
        <span className="text-[13px] text-muted-foreground">{label}</span>
      </span>
    </button>
  )
  return (
    <fieldset
      className={cn(
        // En teléfono se desplaza de lado sin barra visible; no encoge dentro de una columna con scroll.
        "flex min-w-0 shrink-0 gap-2.5 overflow-x-auto border-0 p-0 [scrollbar-width:none] sm:grid sm:grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] sm:overflow-visible [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <legend className="sr-only">Citas del día por estado</legend>
      {tile(
        "todas",
        value === null,
        total,
        "Todas",
        <span className="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-soft-foreground">
          <ListChecks aria-hidden className="size-[18px]" />
        </span>,
        () => onChange(null),
      )}
      {shown.map((status) =>
        tile(
          status,
          value === status,
          counts[status] ?? 0,
          (counts[status] ?? 0) === 1 ? SCHEDULE_AGENDA_LABELS[status] : PLURAL[status],
          <span
            className={cn(
              "flex size-[38px] shrink-0 items-center justify-center rounded-full",
              TILE_ICON_SURFACE[status],
            )}
          >
            <StatusIcon status={status} className="size-[18px]" />
          </span>,
          () => onChange(value === status ? null : status),
        ),
      )}
    </fieldset>
  )
}
