import { Button, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"
import {
  compareMonths,
  FIRST_YEAR,
  monthLabel,
  monthName,
  type YearMonth,
} from "../../lib/commissions"

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

/**
 * Mes y año con controles del sistema: un botón que dice el mes y abre los doce
 * meses del año, con el año a un paso. No hay texto libre ni meses futuros.
 */
export function MonthPicker({
  value,
  onChange,
  max,
  locale,
  align = "end",
}: {
  value: YearMonth
  onChange: (next: YearMonth) => void
  /** Último mes elegible: el mes en curso de la clínica. */
  max: YearMonth
  locale: string
  align?: "start" | "center" | "end"
}) {
  const [open, setOpen] = useState(false)
  const [viewYear, setViewYear] = useState(value.year)
  const label = monthLabel(value, locale)

  // Al abrir, el año a la vista es el del mes elegido.
  useEffect(() => {
    if (open) setViewYear(value.year)
  }, [open, value.year])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button type="button" variant="outline" aria-label={`${label}. Cambiar de mes`} />}
      >
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 gap-3">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Año anterior"
            disabled={viewYear <= FIRST_YEAR}
            onClick={() => setViewYear((year) => year - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <span className="text-sm font-semibold tabular-nums" aria-live="polite">
            {viewYear}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Año siguiente"
            disabled={viewYear >= max.year}
            onClick={() => setViewYear((year) => year + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <fieldset aria-label={`Meses de ${viewYear}`} className="grid min-w-0 grid-cols-3 gap-1">
          {MONTHS.map((month) => {
            const candidate = { year: viewYear, month }
            const selected = compareMonths(candidate, value) === 0
            return (
              <Button
                key={month}
                type="button"
                size="sm"
                variant={selected ? "default" : "ghost"}
                aria-pressed={selected}
                aria-label={monthLabel(candidate, locale)}
                disabled={compareMonths(candidate, max) > 0}
                onClick={() => {
                  onChange(candidate)
                  setOpen(false)
                }}
              >
                {monthName(month, locale, "short")}
              </Button>
            )
          })}
        </fieldset>
      </PopoverContent>
    </Popover>
  )
}
