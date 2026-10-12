import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { Check, ChevronDown, ChevronLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { monthLabel, monthName, type YearMonth } from "../../lib/commissions"
import { monthKey, REPORT_PRESET_LABELS, REPORT_PRESETS, type ReportPreset } from "../../lib/reports"
import { MonthGrid } from "../finance/MonthPicker"

function shift(value: YearMonth, delta: number): YearMonth {
  const index = value.year * 12 + (value.month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function monthOfKey(key: string): YearMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null
}

/** Qué meses abarca cada opción hoy, para leerlo antes de elegir. */
function presetDetail(preset: ReportPreset, current: YearMonth, locale: string): string {
  const lower = (text: string): string => text.charAt(0).toLocaleLowerCase(locale) + text.slice(1)
  if (preset === "este_mes") return `${monthName(current.month, locale)}, hasta hoy`
  if (preset === "mes_pasado") return monthLabel(shift(current, -1), locale)
  if (preset === "ultimos_3_meses")
    return `${monthName(shift(current, -3).month, locale)} a ${lower(monthName(shift(current, -1).month, locale))}`
  return `${monthName(1, locale)} a hoy`
}

/**
 * El periodo de toda la pantalla: cuatro opciones de meses completos y «Otro
 * mes». No hay rango libre, así cada cifra comparte el mismo tramo y su
 * comparación.
 */
export function ReportPeriodPicker({
  value,
  label,
  currentMonth,
  locale,
  onChange,
}: {
  /** Opción vigente: un preajuste o `YYYY-MM`. */
  value: string
  /** Lo que dice el botón: el tramo que respondió el servidor. */
  label: string
  /** Mes en curso de la clínica: límite de «Otro mes». */
  currentMonth: YearMonth
  locale: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [months, setMonths] = useState(false)
  const chosenMonth = monthOfKey(value)
  const [viewYear, setViewYear] = useState(chosenMonth?.year ?? currentMonth.year)

  // Al abrir se ven las opciones; los meses, solo si se piden.
  useEffect(() => {
    if (!open) return
    setMonths(false)
    setViewYear(chosenMonth?.year ?? currentMonth.year)
  }, [open, chosenMonth?.year, currentMonth.year])

  const pick = (next: string): void => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" aria-label={`Periodo: ${label}. Cambiar`} />}>
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-1 p-1.5">
        {months ? (
          <div className="flex flex-col gap-3 p-1.5">
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setMonths(false)}>
              <ChevronLeft aria-hidden />
              Opciones
            </Button>
            <MonthGrid
              value={chosenMonth}
              max={currentMonth}
              locale={locale}
              viewYear={viewYear}
              onViewYear={setViewYear}
              onPick={(month) => pick(monthKey(month))}
            />
          </div>
        ) : (
          <>
            <fieldset aria-label="Periodo" className="flex min-w-0 flex-col">
              {REPORT_PRESETS.map((preset) => {
                const selected = value === preset
                return (
                  <Button
                    key={preset}
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    onClick={() => pick(preset)}
                    className={cn(
                      "h-auto min-h-12 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left font-normal",
                      selected ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("text-sm", selected ? "font-bold" : "font-semibold")}>{REPORT_PRESET_LABELS[preset]}</span>
                      <span className={cn("text-[13px]", selected ? "" : "text-muted-foreground")}>
                        {presetDetail(preset, currentMonth, locale)}
                      </span>
                    </span>
                    {selected ? <Check aria-hidden className="size-4 shrink-0" strokeWidth={2.5} /> : null}
                  </Button>
                )
              })}
            </fieldset>
            <div aria-hidden className="mx-1.5 my-1 h-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              onClick={() => setMonths(true)}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left text-sm font-semibold",
                chosenMonth ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
              )}
            >
              <span className="flex-1">{chosenMonth ? `Otro mes: ${monthLabel(chosenMonth, locale)}` : "Otro mes…"}</span>
            </Button>
            <p className="px-2.5 pt-1 pb-1.5 text-[13px] text-muted-foreground">Se compara con el periodo anterior de la misma duración.</p>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
