/**
 * Franja de días: los días de la semana visible como botones, con el elegido
 * resaltado y hoy con su borde. Los puntos dicen qué tan lleno está cada día, de
 * uno a tres, nunca uno por cita: con muchas citas no cabrían ni se podrían contar.
 * El número exacto va en el nombre accesible.
 */

import { cn } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { formatDateLong, formatDayShort } from "./time.js"

/** Qué tan lleno está un día: ninguna cita, poco, a medias o casi lleno. */
export type ScheduleDayLoad = { level: 0 | 1 | 2 | 3; count: number }

export interface ScheduleDayStripProps {
  /** Días que se ofrecen, en orden (los que la sede atiende esa semana). */
  dates: string[]
  value: string
  onChange: (date: string) => void
  /** Hoy en la zona de la sede. */
  today?: string
  onPrevious?: () => void
  onNext?: () => void
  /** Cuánto hay agendado por fecha; sin el dato, el día no lleva puntos. */
  load?: (date: string) => ScheduleDayLoad | undefined
  className?: string
}

export function ScheduleDayStrip({
  dates,
  value,
  onChange,
  today,
  onPrevious,
  onNext,
  load,
  className,
}: ScheduleDayStripProps) {
  const arrow =
    "flex h-[50px] w-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <nav aria-label="Días de la semana" className={cn("flex items-center gap-1", className)}>
      {onPrevious ? (
        <button type="button" aria-label="Semana anterior" onClick={onPrevious} className={arrow}>
          <ChevronLeft aria-hidden className="size-[18px]" />
        </button>
      ) : null}
      {dates.map((date) => {
        const chosen = date === value
        const [weekday = "", number = ""] = formatDayShort(date).split(" ")
        const day = load?.(date)
        const dots = day?.level ?? 0
        return (
          <button
            key={date}
            type="button"
            aria-label={`${formatDateLong(date)}${date === today ? ", hoy" : ""}${
              day ? `, ${day.count === 0 ? "sin citas" : day.count === 1 ? "1 cita" : `${day.count} citas`}` : ""
            }`}
            aria-current={chosen ? "date" : undefined}
            onClick={() => onChange(date)}
            className={cn(
              "relative flex h-[54px] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-px rounded-lg border pb-1.5 outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              chosen
                ? "border-primary bg-primary text-primary-foreground"
                : date === today
                  ? "border-primary bg-card"
                  : "border-border bg-card hover:border-primary",
            )}
          >
            <span
              className={cn(
                "text-[11px] leading-[15px] font-semibold capitalize",
                !chosen && "text-muted-foreground",
              )}
            >
              {weekday.replace(".", "")}
            </span>
            <span className="text-base leading-[19px] font-bold tabular-nums">{number}</span>
            {dots > 0 ? (
              <span aria-hidden data-dots={dots} className="absolute bottom-[5px] flex gap-0.5">
                {Array.from({ length: dots }, (_, index) => (
                  <span
                    key={index}
                    className={cn("size-1 rounded-full", chosen ? "bg-primary-foreground" : "bg-primary")}
                  />
                ))}
              </span>
            ) : null}
          </button>
        )
      })}
      {onNext ? (
        <button type="button" aria-label="Semana siguiente" onClick={onNext} className={arrow}>
          <ChevronRight aria-hidden className="size-[18px]" />
        </button>
      ) : null}
    </nav>
  )
}
