/**
 * Franja de días: los días de la semana visible como botones, con el elegido
 * resaltado y hoy marcado. En teléfono es la forma de cambiar de día con el
 * pulgar; las flechas pasan a la semana anterior y a la siguiente.
 */

import { cn } from "@odentia/ui"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { formatDateLong, formatDayShort } from "./time.js"

export interface ScheduleDayStripProps {
  /** Días que se ofrecen, en orden (los que la sede atiende esa semana). */
  dates: string[]
  value: string
  onChange: (date: string) => void
  /** Hoy en la zona de la sede. */
  today?: string
  onPrevious?: () => void
  onNext?: () => void
  className?: string
}

export function ScheduleDayStrip({
  dates,
  value,
  onChange,
  today,
  onPrevious,
  onNext,
  className,
}: ScheduleDayStripProps) {
  const arrow =
    "flex h-14 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
  return (
    <nav aria-label="Días de la semana" className={cn("flex items-center gap-1", className)}>
      {onPrevious ? (
        <button type="button" aria-label="Semana anterior" onClick={onPrevious} className={arrow}>
          <ChevronLeft aria-hidden className="size-5" />
        </button>
      ) : null}
      {dates.map((date) => {
        const chosen = date === value
        const [weekday = "", number = ""] = formatDayShort(date).split(" ")
        return (
          <button
            key={date}
            type="button"
            aria-label={`${formatDateLong(date)}${date === today ? ", hoy" : ""}`}
            aria-current={chosen ? "date" : undefined}
            onClick={() => onChange(date)}
            className={cn(
              "relative flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-2xl border outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              chosen
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card hover:border-primary",
            )}
          >
            <span
              className={cn(
                "text-xs font-semibold capitalize",
                !chosen && "text-muted-foreground",
              )}
            >
              {weekday.replace(".", "")}
            </span>
            <span className="text-[17px] leading-5 font-bold tabular-nums">{number}</span>
            {date === today ? (
              <span
                aria-hidden
                className={cn(
                  "absolute bottom-1 size-1 rounded-full",
                  chosen ? "bg-primary-foreground" : "bg-primary",
                )}
              />
            ) : null}
          </button>
        )
      })}
      {onNext ? (
        <button type="button" aria-label="Semana siguiente" onClick={onNext} className={arrow}>
          <ChevronRight aria-hidden className="size-5" />
        </button>
      ) : null}
    </nav>
  )
}
