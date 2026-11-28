/**
 * Franja de días: los días de la semana visible como botones, con el elegido
 * resaltado y hoy con su borde. Los puntos dicen qué tan lleno está cada día, de
 * uno a tres, nunca uno por cita: con muchas citas no cabrían ni se podrían contar.
 * El número exacto va en el nombre accesible.
 *
 * Con `loadDisplay="count"` el día dice su número exacto debajo («19»), o
 * «Feriado»: lo que pide una lista de entregas, donde se cuentan una por una.
 * Dentro de un `ScheduleDropProvider` cada día es un destino al arrastrar, y
 * quedarse sobre una flecha pasa de semana.
 */

import { cn } from "@odentia/ui"

import { ScheduleStepArrow, useScheduleDropTarget } from "./drop.js"
import { formatDateLong, formatDayShort } from "./time.js"

/**
 * Lo que tiene un día. `level`: qué tan lleno está (ninguna cita, poco, a
 * medias o casi lleno), para los puntos. `count`: cuántas hay. `holiday`: el
 * nombre del feriado. `alert`: algo que pide mirar ese día, en palabras («algo
 * no se entregó»), que se marca con un punto rojo.
 */
export type ScheduleDayLoad = {
  level?: 0 | 1 | 2 | 3
  count: number
  holiday?: string
  alert?: string
}

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
  /**
   * `dots` (predeterminado): de uno a tres puntos según `level`. `count`: el
   * número exacto de cada día bajo la fecha, y «Feriado» si lo es.
   */
  loadDisplay?: "dots" | "count"
  /** Lo que se cuenta, en singular y en plural, para el nombre de cada día: «cita», «citas» (predeterminado). */
  noun?: readonly [string, string]
  /** `compact` (predeterminado): las flechas angostas de la agenda. `touch`: de 44 px. */
  arrowSize?: "compact" | "touch"
  className?: string
}

const DEFAULT_NOUN = ["cita", "citas"] as const

export function ScheduleDayStrip({
  dates,
  value,
  onChange,
  today,
  onPrevious,
  onNext,
  load,
  loadDisplay = "dots",
  noun = DEFAULT_NOUN,
  arrowSize = "compact",
  className,
}: ScheduleDayStripProps) {
  return (
    <nav aria-label="Días de la semana" className={cn("flex items-center gap-1", className)}>
      {onPrevious ? (
        <ScheduleStepArrow direction={-1} label="Semana anterior" onStep={onPrevious} size={arrowSize} />
      ) : null}
      {dates.map((date) => (
        <DayButton
          key={date}
          date={date}
          chosen={date === value}
          today={date === today}
          day={load?.(date)}
          loadDisplay={loadDisplay}
          noun={noun}
          onChange={onChange}
        />
      ))}
      {onNext ? (
        <ScheduleStepArrow direction={1} label="Semana siguiente" onStep={onNext} size={arrowSize} />
      ) : null}
    </nav>
  )
}

function DayButton({
  date,
  chosen,
  today,
  day,
  loadDisplay,
  noun,
  onChange,
}: {
  date: string
  chosen: boolean
  today: boolean
  day: ScheduleDayLoad | undefined
  loadDisplay: "dots" | "count"
  noun: readonly [string, string]
  onChange: (date: string) => void
}) {
  const drop = useScheduleDropTarget({ date })
  const [weekday = "", number = ""] = formatDayShort(date).split(" ")
  const dots = day?.level ?? 0
  const counted = loadDisplay === "count"
  const [one, many] = noun
  const said = day
    ? `${day.holiday ? `, feriado: ${day.holiday}` : ""}, ${
        day.count === 0 ? `sin ${many}` : day.count === 1 ? `1 ${one}` : `${day.count} ${many}`
      }${day.alert ? `, ${day.alert}` : ""}`
    : ""
  return (
    <button
      type="button"
      aria-label={`${formatDateLong(date)}${today ? ", hoy" : ""}${said}`}
      aria-current={chosen ? "date" : undefined}
      onClick={() => onChange(date)}
      {...drop.props}
      className={cn(
        "relative flex min-w-0 flex-1 basis-0 flex-col items-center justify-center outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        counted
          ? "h-[62px] rounded-xl border transition-[background-color,border-color,transform] duration-150 select-none motion-reduce:transition-none"
          : "h-[54px] gap-px rounded-lg border pb-1.5 transition-colors",
        chosen
          ? "border-primary bg-primary text-primary-foreground"
          : today
            ? "border-primary bg-card"
            : "border-border bg-card hover:border-primary",
        day?.holiday && !chosen && "border-dashed bg-muted/60",
        // Con algo levantado, cada día se marca como destino; el de abajo del dedo, más.
        drop.active && "border-dashed",
        drop.over && "border-2 border-primary bg-primary-soft text-foreground motion-safe:scale-[1.06]",
      )}
    >
      <span
        className={cn(
          "text-[11px] font-semibold capitalize",
          counted ? "leading-[14px]" : "leading-[15px]",
          !chosen && "text-muted-foreground",
          drop.over && "text-foreground",
        )}
      >
        {weekday.replace(".", "")}
      </span>
      <span
        className={cn(
          "font-bold tabular-nums",
          counted ? "text-[17px] leading-[20px]" : "text-base leading-[19px]",
        )}
      >
        {number}
      </span>
      {counted ? (
        <span
          aria-hidden
          data-count=""
          className={cn(
            // Recortado: en un día angosto «Feriado» no se sale del botón (lo dice entero su nombre).
            "mt-0.5 h-[15px] max-w-full truncate px-0.5 text-[11px] leading-[15px] font-semibold tabular-nums",
            chosen && !drop.over ? "text-primary-foreground/85" : "text-muted-foreground",
          )}
        >
          {day?.holiday ? "Feriado" : day && day.count > 0 ? day.count : "·"}
        </span>
      ) : dots > 0 ? (
        <span aria-hidden data-dots={dots} className="absolute bottom-[5px] flex gap-0.5">
          {Array.from({ length: dots }, (_, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: los puntos son iguales; solo cuenta cuántos hay.
              key={index}
              className={cn("size-1 rounded-full", chosen ? "bg-primary-foreground" : "bg-primary")}
            />
          ))}
        </span>
      ) : null}
      {day?.alert ? (
        <span
          aria-hidden
          data-alert=""
          className={cn(
            "absolute top-1 right-1 size-2 rounded-full",
            chosen && !drop.over ? "bg-primary-foreground" : "bg-destructive",
          )}
        />
      ) : null}
    </button>
  )
}
