import { Button } from "@odentia/ui"
import { CalendarDays, X } from "lucide-react"
import { DatePickerButton } from "../date-picker-button.js"
import {
  dayMinutesIn,
  formatDateLong,
  minutesToInstant,
  regionTimeZone,
  zonedDateOf,
} from "../schedule/time.js"
import { clockMinutes, clockValue, TimeSelect } from "./time-select.js"

/** Al elegir solo el día, vence a las 9:00 de la clínica. */
const DEFAULT_MINUTES = 9 * 60

/** Día y minutos del día de un instante en la zona dada; `null` sin instante válido. */
export function dueParts(
  iso: string | null | undefined,
  timeZone: string = regionTimeZone(),
): { date: string; minutes: number } | null {
  if (!iso || Number.isNaN(Date.parse(iso))) return null
  return { date: zonedDateOf(iso, timeZone), minutes: dayMinutesIn(iso, timeZone) }
}

export interface DueAtFieldProps {
  /** Instante ISO 8601 o `null` (sin fecha). */
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  /** Zona en que se eligen día y hora; por defecto, la de la clínica. */
  timeZone?: string
  /** Del grupo día + hora. */
  id?: string
  /** Nombre del grupo: la etiqueta («Vence») la pinta la pantalla. */
  "aria-labelledby"?: string
  "aria-label"?: string
  invalid?: boolean
  "aria-describedby"?: string
  /** Al salir el foco del grupo. */
  onBlur?: () => void
}

/**
 * «Día y hora»: cuándo vence algo (una tarea), con el día del calendario
 * estándar y la hora de la lista, los dos en la zona de la clínica y no en la
 * del navegador. Guarda un instante ISO 8601. Sustituye al campo de fecha y
 * hora del navegador, que escribe distinto en cada equipo. No pinta etiqueta
 * ni ayuda: las pone la pantalla (`FieldSet` + `FieldLegend`, o una etiqueta
 * con `aria-labelledby`).
 */
export function DueAtField({
  value,
  onChange,
  disabled = false,
  timeZone: zoneProp,
  id,
  "aria-labelledby": labelledBy,
  "aria-label": ariaLabel,
  invalid = false,
  "aria-describedby": describedBy,
  onBlur,
}: DueAtFieldProps) {
  const timeZone = zoneProp ?? regionTimeZone()
  const parts = dueParts(value, timeZone)
  const today = zonedDateOf(new Date().toISOString(), timeZone)
  const minutes = parts?.minutes ?? DEFAULT_MINUTES
  const at = (date: string, chosen: number) => minutesToInstant(date, chosen, timeZone)
  return (
    <fieldset
      id={id}
      className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onBlur={
        onBlur
          ? (event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
    >
      <DatePickerButton
        value={parts?.date ?? ""}
        min={today}
        disabled={disabled}
        aria-label={parts ? `Día: ${formatDateLong(parts.date)}` : "Elegir el día"}
        aria-invalid={invalid || undefined}
        onChange={(date) => onChange(at(date, minutes))}
      >
        <CalendarDays aria-hidden />
        {parts ? formatDateLong(parts.date) : "Sin fecha"}
      </DatePickerButton>
      {parts ? (
        <>
          <TimeSelect
            aria-label="Hora"
            min="06:00"
            max="22:00"
            value={clockValue(minutes)}
            disabled={disabled}
            invalid={invalid}
            onChange={(time) => onChange(at(parts.date, clockMinutes(time) ?? minutes))}
          />
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
            <X aria-hidden />
            Sin fecha
          </Button>
        </>
      ) : null}
    </fieldset>
  )
}
