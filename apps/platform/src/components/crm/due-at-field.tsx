import { Button, Field, FieldDescription, FieldLabel } from "@odentia/ui"
import { DatePickerButton, formatDateLong, hourLabel, zonedDateOf } from "@odentia/ui-patterns"
import { CalendarDays, X } from "lucide-react"
import { useId } from "react"
import { activeOrgTimeZone } from "../../lib/locale"
import { ChoiceSelect } from "../ui/choice-select"
import { dueFromParts, dueParts } from "./crm-helpers"

/** Horas que se ofrecen: de 6:00 a 22:00, cada media hora. */
const TIMES = Array.from({ length: 33 }, (_, index) => 6 * 60 + index * 30)
/** Al elegir solo el día, la tarea vence a las 9:00 de la clínica. */
const DEFAULT_MINUTES = 9 * 60

/**
 * Cuándo vence una tarea: el día con el calendario estándar y la hora de una
 * lista, los dos en la zona de la clínica (no en la del navegador). Sustituye
 * al campo de fecha y hora del navegador, que escribe distinto en cada equipo.
 */
export function DueAtField({
  label = "Vence",
  value,
  onChange,
  disabled = false,
  description,
}: {
  label?: string
  /** Instante ISO o null (sin fecha). */
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
  description?: string
}) {
  const id = useId()
  const timeZone = activeOrgTimeZone()
  const parts = dueParts(value, timeZone)
  const today = zonedDateOf(new Date().toISOString(), timeZone)
  const minutes = parts?.minutes ?? DEFAULT_MINUTES
  const times = TIMES.includes(minutes) ? TIMES : [...TIMES, minutes].sort((a, b) => a - b)
  return (
    <Field>
      <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-labelledby={`${id}-label`}>
        <DatePickerButton
          value={parts?.date ?? ""}
          min={today}
          disabled={disabled}
          aria-label={parts ? `Día: ${formatDateLong(parts.date)}` : "Elegir el día"}
          onChange={(date) => onChange(dueFromParts(date, minutes, timeZone))}
        >
          <CalendarDays aria-hidden />
          {parts ? formatDateLong(parts.date) : "Sin fecha"}
        </DatePickerButton>
        {parts ? (
          <>
            <ChoiceSelect
              aria-label="Hora"
              className="w-28"
              value={String(minutes)}
              disabled={disabled}
              onChange={(event) => onChange(dueFromParts(parts.date, Number(event.target.value), timeZone))}
            >
              {times.map((time) => (
                <option key={time} value={String(time)}>
                  {hourLabel(time)}
                </option>
              ))}
            </ChoiceSelect>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
              <X aria-hidden />
              Sin fecha
            </Button>
          </>
        ) : null}
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}
