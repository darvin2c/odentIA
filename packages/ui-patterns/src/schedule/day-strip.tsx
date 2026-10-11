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
        return (
          <button
            key={date}
            type="button"
            aria-label={`${formatDateLong(date)}${date === today ? ", hoy" : ""}`}
            aria-current={chosen ? "date" : undefined}
            onClick={() => onChange(date)}
            className={cn(
              "relative flex h-[50px] min-w-0 flex-1 basis-0 flex-col items-center justify-center gap-px rounded-lg border outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              chosen
                ? "border-primary bg-primary text-primary-foreground"
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
            {/* Hoy solo se marca cuando se mira otro día: elegido ya se distingue. */}
            {date === today && !chosen ? (
              <span aria-hidden className="absolute bottom-[3px] size-1 rounded-full bg-primary" />
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
