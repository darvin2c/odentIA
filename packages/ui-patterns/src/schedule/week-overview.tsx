/**
 * Semana de un recurso en teléfono: una tarjeta por día con una barra que
 * reparte la jornada en libre, ocupado y sin atención, y el total de horas
 * libres. Responde «¿qué día hay sitio?» sin una rejilla de seis columnas, que
 * en una pantalla estrecha no se lee. Tocar un día lleva a su vista Día.
 */

import { cn } from "@odentia/ui"

import { type DaySegment, formatSpan, freeMinutesOf } from "./occupancy.js"
import { formatDateLong, formatDayShort, hourLabel } from "./time.js"

export interface ScheduleWeekDay {
  date: string
  /** Citas del día que siguen en pie. */
  count: number
  /** Reparto de la jornada (ver `daySegments`). */
  segments: DaySegment[]
  /** Aclaración breve junto al recuento («bloqueo hasta las 10:00»). */
  note?: string
}

export interface ScheduleWeekOverviewProps {
  days: ScheduleWeekDay[]
  today?: string
  onSelect: (date: string) => void
  className?: string
}

const SEGMENT_CLASS: Record<DaySegment["kind"], string> = {
  free: "bg-primary",
  busy: "bg-input",
  past: "bg-input",
  closed: "bg-muted",
}

const HATCH =
  "repeating-linear-gradient(135deg, var(--muted-foreground) 0 1px, transparent 1px 4px)"

/** «Libre a las 11:00, 12:00 y 13:30», para quien no ve la barra. */
function freeSummary(segments: DaySegment[]): string {
  const starts = segments
    .filter((segment) => segment.kind === "free")
    .map((segment) => hourLabel(segment.startMinutes))
  if (starts.length === 0) return "Sin tiempo libre"
  if (starts.length === 1) return `Libre desde las ${starts[0]}`
  return `Libre a las ${starts.slice(0, -1).join(", ")} y ${starts[starts.length - 1]}`
}

/** Leyenda de la barra del día; se muestra una vez sobre la lista de días. */
export function ScheduleOccupancyLegend({ className }: { className?: string }) {
  const swatch = "h-2.5 w-3.5 rounded-[3px]"
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-muted-foreground",
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={cn(swatch, "bg-primary")} />
        Libre
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className={cn(swatch, "bg-input")} />
        Ocupado
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(swatch, "border bg-muted")}
          style={{ backgroundImage: HATCH }}
        />
        Sin atención
      </span>
    </div>
  )
}

export function ScheduleWeekOverview({
  days,
  today,
  onSelect,
  className,
}: ScheduleWeekOverviewProps) {
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {days.map((day) => {
        // Al cuarto de hora: «7 h libres» se lee mejor que «7 h 04».
        const free = Math.floor(freeMinutesOf(day.segments) / 15) * 15
        const past = today !== undefined && day.date < today
        const open = day.segments.some((segment) => segment.kind !== "closed")
        const [weekday = "", number = ""] = formatDayShort(day.date).split(" ")
        return (
          <li key={day.date}>
            <button
              type="button"
              onClick={() => onSelect(day.date)}
              aria-label={`${formatDateLong(day.date)}${day.date === today ? ", hoy" : ""}: ${day.count} ${day.count === 1 ? "cita" : "citas"}, ${free > 0 ? `${formatSpan(free)} libres` : "sin tiempo libre"}. ${freeSummary(day.segments)}`}
              className="flex w-full flex-col gap-2.5 rounded-2xl border bg-card px-3.5 py-3 text-left outline-none transition-colors hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex w-full items-center gap-2">
                <span className="text-[15px] font-bold capitalize">
                  {weekday.replace(".", "")} {number}
                </span>
                {day.date === today ? (
                  <span className="rounded-full bg-primary px-2 text-[11px] leading-[18px] font-bold text-primary-foreground">
                    Hoy
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                  {day.count} {day.count === 1 ? "cita" : "citas"}
                  {day.note ? ` · ${day.note}` : ""}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-sm font-bold",
                    free > 0 ? "text-primary-soft-foreground" : "text-muted-foreground",
                  )}
                >
                  {free > 0
                    ? `${formatSpan(free)} libres`
                    : past
                      ? ""
                      : open
                        ? "Sin sitio"
                        : "Sin atención"}
                </span>
              </span>
              <span aria-hidden className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
                {day.segments.map((segment) => (
                  <span
                    key={`${segment.kind}-${segment.startMinutes}`}
                    data-kind={segment.kind}
                    className={SEGMENT_CLASS[segment.kind]}
                    style={{
                      flex: `${segment.endMinutes - segment.startMinutes} 1 0`,
                      backgroundImage: segment.kind === "closed" ? HATCH : undefined,
                    }}
                  />
                ))}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
