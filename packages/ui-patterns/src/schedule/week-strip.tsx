/**
 * Franja semanal del teléfono: los siete días de la semana del día visible,
 * con su carga (hasta tres puntos) y el día bajo el pulgar resaltado. Tocar
 * un día salta a él (`scrollToDate` en la vista); al cruzar de semana en el
 * stream la franja se re-centra sola porque sigue al día visible.
 */

import { cn } from "@odentia/ui"

import { formatDateLong, formatDayShort, weekDates, zonedDateOf } from "./time.js"
import type { ScheduleEntry } from "./types.js"

export interface ScheduleWeekStripProps {
  /** Día visible en el stream: define la semana que se muestra. */
  date: string
  /** Citas cargadas, para los puntos de carga por día. */
  entries?: ScheduleEntry[]
  timeZone?: string
  /** Día de hoy ya resuelto (fecha civil): se distingue con un subrayado. */
  nowDate?: string
  onSelect?: (date: string) => void
  className?: string
}

export function ScheduleWeekStrip({
  date,
  entries = [],
  timeZone,
  nowDate,
  onSelect,
  className,
}: ScheduleWeekStripProps) {
  const counts = new Map<string, number>()
  if (timeZone) {
    for (const entry of entries) {
      const day = zonedDateOf(entry.start, timeZone)
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }
  }

  return (
    <nav
      aria-label="Semana visible"
      className={cn("flex gap-1 border-b bg-background px-2 py-1.5", className)}
    >
      {weekDates(date).map((day) => {
        const active = day === date
        const count = Math.min(counts.get(day) ?? 0, 3)
        const [weekday, dayNumber] = formatDayShort(day).split(" ")
        return (
          <button
            key={day}
            type="button"
            aria-label={formatDateLong(day)}
            aria-current={active ? "date" : undefined}
            onClick={() => onSelect?.(day)}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center rounded-lg px-1 py-1 transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <span className="text-[10px] leading-tight">{weekday}</span>
            <span
              className={cn(
                "text-sm leading-tight font-medium tabular-nums",
                day === nowDate && "underline decoration-2 underline-offset-2",
              )}
            >
              {dayNumber}
            </span>
            <span
              aria-hidden
              className={cn(
                "h-1.5 text-[8px] leading-none tracking-tight",
                active ? "text-primary-foreground" : "text-primary/70",
              )}
            >
              {"●".repeat(count)}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
