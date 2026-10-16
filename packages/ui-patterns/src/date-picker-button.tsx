import { Button, Calendar, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { format } from "date-fns"
import { es } from "date-fns/locale"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import { formatDayMonthYear } from "./schedule/time.js"

/** Día local a medianoche desde una fecha-sola `yyyy-MM-dd` (sin desfase UTC). */
function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day)
}

function toDateOnly(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

/** Años que ofrece la lista cuando no hay límites: los que caben en una ficha. */
const YEARS_BACK = 100
const YEARS_AHEAD = 10

/** Nombres accesibles del calendario en español (los de la librería vienen en inglés). */
const LABELS = {
  labelMonthDropdown: () => "Elegir el mes",
  labelYearDropdown: () => "Elegir el año",
  labelNext: () => "Ir al mes siguiente",
  labelPrevious: () => "Ir al mes anterior",
  labelDayButton: (date: Date, modifiers: { today?: boolean; selected?: boolean }) => {
    const said = format(date, "PPPP", { locale: es })
    return `${modifiers.today ? "Hoy, " : ""}${said}${modifiers.selected ? ", elegido" : ""}`
  },
}

export interface DatePickerButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "value" | "onChange"> {
  /** Fecha-sola elegida (`yyyy-MM-dd`); vacía = sin fecha. */
  value: string
  onChange: (value: string) => void
  /** Primera fecha que se puede elegir. */
  min?: string
  /** Última fecha que se puede elegir. */
  max?: string
  /** Hacia dónde se alinea el calendario respecto del botón. */
  align?: "start" | "center" | "end"
  /**
   * Para una fecha opcional: lo que dice el botón sin fecha («Sin
   * vencimiento») y la acción, debajo del calendario, que la quita.
   */
  emptyLabel?: string
  /** Lo que dice el botón sin fecha cuando la fecha no es opcional. */
  placeholder?: string
}

/**
 * «Día»: botón que dice la fecha con su año («Jue 20 nov 2026») y abre el
 * calendario estándar, con el mes y el año elegibles en una lista para llegar
 * lejos sin pasar mes a mes. Sustituye al campo de fecha del navegador, que la
 * escribe en un formato distinto según el equipo.
 *
 * Una pantalla puede poner sus propias palabras en el botón (`children`), por
 * ejemplo «Lunes 12 de octubre» en la agenda. Un periodo dentro de un
 * formulario son dos «Día», el segundo con `min` en el primero.
 */
export function DatePickerButton({
  value,
  onChange,
  min,
  max,
  align = "start",
  emptyLabel,
  placeholder = "Elegir el día",
  children,
  className,
  "aria-describedby": describedBy,
  ...button
}: DatePickerButtonProps) {
  const [open, setOpen] = React.useState(false)
  // Con la etiqueta del campo como nombre, la fecha elegida se anuncia como descripción.
  const valueId = React.useId()
  const selected = parseDateOnly(value)
  const first = parseDateOnly(min)
  const last = parseDateOnly(max)
  const bounds = [
    ...(first ? [{ before: first }] : []),
    ...(last ? [{ after: last }] : []),
  ]
  // La lista de años va de un límite al otro; sin límites, los años de una
  // ficha. Siempre incluye la fecha guardada, aunque sea antigua.
  const thisYear = new Date().getFullYear()
  const earliest = [first ?? new Date(thisYear - YEARS_BACK, 0, 1), selected].filter(
    (date): date is Date => date !== undefined,
  )
  const latest = [last ?? new Date(thisYear + YEARS_AHEAD, 11, 31), selected].filter(
    (date): date is Date => date !== undefined,
  )
  const startMonth = new Date(Math.min(...earliest.map((date) => date.getTime())))
  const endMonth = new Date(Math.max(...latest.map((date) => date.getTime())))
  const said = value ? formatDayMonthYear(value) : (emptyLabel ?? placeholder)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(children ? undefined : "justify-between font-normal", className)}
            aria-describedby={[describedBy, children ? undefined : valueId].filter(Boolean).join(" ") || undefined}
            {...button}
          />
        }
      >
        {children ?? (
          <>
            <span id={valueId} className={cn("truncate", !value && "text-muted-foreground")}>
              {said}
            </span>
            <ChevronDown aria-hidden className="text-muted-foreground" />
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0">
        <Calendar
          mode="single"
          locale={es}
          captionLayout="dropdown"
          startMonth={startMonth}
          endMonth={endMonth}
          labels={LABELS}
          selected={selected}
          defaultMonth={selected ?? (last && last < new Date() ? last : undefined)}
          disabled={bounds.length > 0 ? bounds : undefined}
          onSelect={(day) => {
            if (!day) return
            onChange(toDateOnly(day))
            setOpen(false)
          }}
        />
        {emptyLabel && value ? (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                onChange("")
                setOpen(false)
              }}
            >
              {emptyLabel}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
