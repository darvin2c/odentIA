import { cn, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@odentia/ui"
import { hourLabel } from "../schedule/time.js"

/** «08:30» → 510 minutos del día; `null` si no es una hora `HH:MM` válida. */
export function clockMinutes(value: string | null | undefined): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value?.trim() ?? "")
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** 510 → «08:30»: la hora local ISO 8601 que se guarda. */
export function clockValue(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/**
 * Horas que ofrece la lista: de `min` a `max` cada `step` minutos, más la ya
 * guardada si cae fuera de ese paso (una hora de antes no desaparece).
 */
export function timeOptions({
  step = 15,
  min = "00:00",
  max = "23:59",
  value,
}: {
  step?: number
  min?: string
  max?: string
  value?: string
}): string[] {
  const first = clockMinutes(min) ?? 0
  const last = clockMinutes(max) ?? 24 * 60 - 1
  const start = Math.ceil(first / step) * step
  const out: number[] = []
  for (let minute = start; minute <= last; minute += step) out.push(minute)
  const current = clockMinutes(value)
  if (current !== null && !out.includes(current)) out.push(current)
  return out.sort((a, b) => a - b).map(clockValue)
}

export interface TimeSelectProps {
  /** Hora local `HH:MM` (ISO 8601) o vacío. */
  value: string
  onChange: (value: string) => void
  /** Minutos entre una opción y la siguiente; 15, como la Agenda. */
  step?: number
  /** Primera hora que se ofrece (`HH:MM`). */
  min?: string
  /** Última hora que se ofrece (`HH:MM`). */
  max?: string
  /** Primera opción, que deja la hora vacía («Ahora (10:35)»). */
  emptyLabel?: string
  /** Lo que dice el campo sin hora y sin `emptyLabel`. */
  placeholder?: string
  id?: string
  disabled?: boolean
  invalid?: boolean
  className?: string
  "aria-label"?: string
  "aria-describedby"?: string
}

/**
 * «Hora»: una lista cada 15 minutos, escrita como en la Agenda (`hourLabel`),
 * para horarios, ausencias, las horas del agente y la hora de fin de la
 * atención. La hora es la de la clínica: el campo no la convierte, guarda la
 * hora local `HH:MM` que se eligió. Sustituye al campo de hora del navegador,
 * que cambia de aspecto (y de 24 a 12 horas) según el equipo.
 */
export function TimeSelect({
  value,
  onChange,
  step = 15,
  min,
  max,
  emptyLabel,
  placeholder = "Elegir la hora",
  id,
  disabled = false,
  invalid = false,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: TimeSelectProps) {
  const times = timeOptions({ step, min, max, value })
  const label = (time: string) => hourLabel(clockMinutes(time) ?? 0)
  const items: Record<string, string> = Object.fromEntries([
    ...(emptyLabel !== undefined ? [["", emptyLabel]] : []),
    ...times.map((time) => [time, label(time)]),
  ])
  return (
    <Select
      items={items}
      // Sin hora y sin opción vacía, el campo dice su `placeholder`.
      value={value === "" && emptyLabel === undefined ? null : value}
      disabled={disabled}
      onValueChange={(next) => onChange(next == null ? "" : String(next))}
    >
      <SelectTrigger
        id={id}
        className={cn("w-28 tabular-nums", className)}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        {/* La opción vacía («Ahora (10:35)») es también lo que dice el campo sin hora. */}
        <SelectValue placeholder={emptyLabel ?? placeholder} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel !== undefined ? <SelectItem value="">{emptyLabel}</SelectItem> : null}
        {times.map((time) => (
          <SelectItem key={time} value={time} className="tabular-nums">
            {label(time)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
