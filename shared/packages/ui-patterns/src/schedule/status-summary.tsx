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
  no_asistio: "No vinieron",
  cancelada: "Canceladas",
}

export interface ScheduleStatusSummaryProps {
  /** Citas por estado, contadas sobre todo el día y no sobre lo filtrado. */
  counts: Partial<Record<ScheduleStatus, number>>
  /** Estado elegido; null = todas. */
  value: ScheduleStatus | null
  onChange: (value: ScheduleStatus | null) => void
  /** Estados que siempre tienen ficha; el resto aparece solo si tiene citas. */
  statuses?: ScheduleStatus[]
  /** Falso cuando no hay sitio para «Todas»: tocar la ficha activa ya vuelve a todas. */
  withAll?: boolean
  className?: string
}

export function ScheduleStatusSummary({
  counts,
  value,
  onChange,
  statuses = ["programada", "confirmada", "atendida"],
  withAll = true,
  className,
}: ScheduleStatusSummaryProps) {
  const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0)
  const optional: ScheduleStatus[] = ["no_asistio", "cancelada"]
  const shown = [
    // Sin «Todas» la fila va justa de sitio: lo que no tiene citas no se ofrece.
    ...statuses.filter((status) => withAll || (counts[status] ?? 0) > 0 || value === status),
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
        "flex h-11 shrink-0 items-center gap-2 rounded-full border bg-card px-3 text-sm font-semibold whitespace-nowrap outline-none transition-colors sm:h-9",
        "hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
        pressed && "border-primary bg-primary-soft text-primary-soft-foreground ring-1 ring-primary",
      )}
    >
      {icon}
      <span className="font-bold tabular-nums">{count}</span>
      {label}
    </button>
  )
  return (
    <fieldset
      className={cn(
        // Una fila delgada: en teléfono se desplaza de lado sin barra visible.
        "flex min-w-0 shrink-0 gap-1.5 overflow-x-auto border-0 p-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <legend className="sr-only">Citas por estado</legend>
      {withAll
        ? tile("todas", value === null, total, "Todas", <ListChecks aria-hidden className="size-4 text-primary" />, () => onChange(null))
        : null}
      {shown.map((status) =>
        tile(
          status,
          value === status,
          counts[status] ?? 0,
          (counts[status] ?? 0) === 1 ? SCHEDULE_AGENDA_LABELS[status] : PLURAL[status],
          <StatusIcon status={status} className="size-4" />,
          () => onChange(value === status ? null : status),
        ),
      )}
    </fieldset>
  )
}
