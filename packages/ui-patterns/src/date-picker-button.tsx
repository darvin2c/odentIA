import { Button, Calendar, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { es } from "date-fns/locale"
import * as React from "react"

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

export interface DatePickerButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "value" | "onChange"> {
  /** Fecha-sola elegida (`yyyy-MM-dd`). */
  value: string
  onChange: (value: string) => void
  /** Primera fecha que se puede elegir. */
  min?: string
  /** Última fecha que se puede elegir. */
  max?: string
  /** Hacia dónde se alinea el calendario respecto del botón. */
  align?: "start" | "center" | "end"
}

/**
 * Botón que dice la fecha con las palabras de la pantalla («Lunes 12 de
 * octubre») y abre el calendario estándar para cambiarla. Sustituye al campo de
 * fecha del navegador, que la escribe en un formato distinto según el equipo.
 */
export function DatePickerButton({
  value,
  onChange,
  min,
  max,
  align = "start",
  children,
  ...button
}: DatePickerButtonProps) {
  const [open, setOpen] = React.useState(false)
  const selected = parseDateOnly(value)
  const first = parseDateOnly(min)
  const last = parseDateOnly(max)
  const bounds = [
    ...(first ? [{ before: first }] : []),
    ...(last ? [{ after: last }] : []),
  ]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" {...button} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0">
        <Calendar
          mode="single"
          locale={es}
          selected={selected}
          defaultMonth={selected}
          disabled={bounds.length > 0 ? bounds : undefined}
          onSelect={(day) => {
            if (!day) return
            onChange(toDateOnly(day))
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
