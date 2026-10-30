import { Button, cn, Calendar as DatePicker } from "@odentia/ui"
import { endOfMonth, format, startOfMonth, subDays, subMonths } from "date-fns"
import { es } from "date-fns/locale"
import { common } from "../common.js"
import { formatTimeZone } from "../locale.js"

export type CalendarRange = { from?: string; to?: string }

export type CalendarProps =
  | {
      mode: "single"
      selected?: string
      compact?: boolean
      /** Último día que se puede elegir (`yyyy-MM-dd`): los posteriores quedan deshabilitados. */
      max?: string
      onSelect: (value?: string) => void
    }
  | {
      mode: "range"
      selected?: CalendarRange
      compact?: boolean
      /** Último día que se puede elegir (`yyyy-MM-dd`): los posteriores quedan deshabilitados. */
      max?: string
      onSelect: (value: CalendarRange) => void
    }

/** Día local a medianoche desde una fecha-sola `yyyy-MM-dd` (sin desfase UTC). */
function parseDateOnly(value?: string): Date | undefined {
  if (!value) return undefined
  const [year, month, day] = value.split("-").map(Number)
  if (!year || !month || !day) return undefined
  return new Date(year, month - 1, day)
}

function toDateOnly(value: Date | undefined): string | undefined {
  return value ? format(value, "yyyy-MM-dd") : undefined
}

/** «Hoy» en la zona horaria de la clínica (`formatTimeZone`), no en el huso del
 * navegador: los presets de rango se anclan a la fecha de la clínica. Sin zona
 * fijada, la del entorno. */
function todayInClinicZone(): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: formatTimeZone(),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value)
  return new Date(part("year"), part("month") - 1, part("day"))
}

/** Con dos meses a la vista, el último elegido (o el tope) va a la derecha: no se abren meses por venir. */
function rangeMonth(last: Date | undefined, compact?: boolean): Date | undefined {
  if (!last) return undefined
  return compact ? last : subMonths(last, 1)
}

const RANGE_PRESETS = [
  { label: common.filters.today, days: 1 },
  { label: common.filters.last3Days, days: 3 },
  { label: common.filters.last7Days, days: 7 },
  { label: common.filters.last30Days, days: 30 },
]

/**
 * Envoltorio del `Calendar` estándar (react-day-picker) que conserva la API
 * pública fecha-sola (`yyyy-MM-dd`), los modos single/range y los accesos
 * rápidos de rango anclados a Lima.
 */
export function Calendar(props: CalendarProps) {
  if (props.mode === "single") {
    return (
      <DatePicker
        mode="single"
        locale={es}
        selected={parseDateOnly(props.selected)}
        defaultMonth={parseDateOnly(props.selected ?? props.max)}
        {...(props.max ? { disabled: { after: parseDateOnly(props.max) as Date } } : {})}
        onSelect={(day) => props.onSelect(toDateOnly(day))}
      />
    )
  }

  const selected = {
    from: parseDateOnly(props.selected?.from),
    to: parseDateOnly(props.selected?.to),
  }
  const today = todayInClinicZone()

  return (
    <div className="w-full space-y-3">
      <DatePicker
        mode="range"
        locale={es}
        numberOfMonths={props.compact ? 1 : 2}
        selected={selected}
        defaultMonth={rangeMonth(selected.to ?? parseDateOnly(props.max), props.compact)}
        {...(props.max ? { disabled: { after: parseDateOnly(props.max) as Date } } : {})}
        onSelect={(range) =>
          props.onSelect({ from: toDateOnly(range?.from), to: toDateOnly(range?.to) })
        }
      />
      <div
        className={cn(
          "grid grid-cols-2 content-start gap-2 border-t border-border pt-3",
          props.compact && "grid-cols-2",
        )}
      >
        {[
          ...RANGE_PRESETS.map((preset) => ({
            key: `dias-${preset.days}`,
            label: preset.label,
            from: format(subDays(today, preset.days - 1), "yyyy-MM-dd"),
            to: format(today, "yyyy-MM-dd"),
          })),
          // Los meses del calendario, para cuadrar el mes: el en curso llega hasta hoy.
          {
            key: "este-mes",
            label: common.filters.thisMonth,
            from: format(startOfMonth(today), "yyyy-MM-dd"),
            to: format(today, "yyyy-MM-dd"),
          },
          {
            key: "mes-pasado",
            label: common.filters.lastMonth,
            from: format(startOfMonth(subMonths(today, 1)), "yyyy-MM-dd"),
            to: format(endOfMonth(subMonths(today, 1)), "yyyy-MM-dd"),
          },
        ].map((preset) => {
          const active = props.selected?.from === preset.from && props.selected?.to === preset.to
          return (
            <Button
              key={preset.key}
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={active}
              className={cn("w-full justify-center", active && "border-accent bg-surface-muted")}
              onClick={() => props.onSelect({ from: preset.from, to: preset.to })}
            >
              {preset.label}
            </Button>
          )
        })}
      </div>
    </div>
  )
}
