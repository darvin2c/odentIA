import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { Calendar, type CalendarRange } from "@odentia/ui-patterns"
import { CalendarRange as CalendarRangeIcon, Check, ChevronDown, ChevronLeft } from "lucide-react"
import { useEffect, useState } from "react"
import { monthLabel, monthName, type YearMonth } from "../../lib/commissions"
import { daysLabel, monthKey, rangeOfPeriod, rangePeriod, REPORT_PRESET_LABELS, REPORT_PRESETS, type ReportPreset } from "../../lib/reports"
import { MonthGrid } from "../finance/MonthPicker"

/** Un rango abarca como mucho dos años (lo mismo exige el servidor). */
const RANGE_MAX_DAYS = 731

function shift(value: YearMonth, delta: number): YearMonth {
  const index = value.year * 12 + (value.month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

function monthOfKey(key: string): YearMonth | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key)
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null
}

function daysInRange(range: { from: string; to: string }): number {
  return Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1
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

type View = "options" | "months" | "range"

/**
 * El periodo de toda la pantalla (decisión 15): los meses primero, que es lo
 * más usado, «Otro mes» y «Elegir fechas» con el calendario de rango de los
 * filtros. Todas las cifras usan el mismo tramo y se comparan con el anterior
 * de la misma duración; las fechas son las de la clínica y no se eligen días
 * que aún no pasan.
 */
export function ReportPeriodPicker({
  value,
  label,
  currentMonth,
  today,
  locale,
  onChange,
}: {
  /** Opción vigente: un preajuste, `YYYY-MM` o un rango. */
  value: string
  /** Lo que dice el botón: el tramo que respondió el servidor. */
  label: string
  /** Mes en curso de la clínica: límite de «Otro mes». */
  currentMonth: YearMonth
  /** Hoy en la clínica (`YYYY-MM-DD`): el último día que se puede elegir. */
  today: string
  locale: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>("options")
  const chosenMonth = monthOfKey(value)
  const chosenRange = rangeOfPeriod(value)
  const [viewYear, setViewYear] = useState(chosenMonth?.year ?? currentMonth.year)
  const [draft, setDraft] = useState<CalendarRange>(chosenRange ?? {})

  // Al abrir se ven las opciones; los meses y el calendario, solo si se piden.
  useEffect(() => {
    if (!open) return
    setView("options")
    setViewYear(monthOfKey(value)?.year ?? currentMonth.year)
    setDraft(rangeOfPeriod(value) ?? {})
  }, [open, value, currentMonth.year])

  const pick = (next: string): void => {
    onChange(next)
    setOpen(false)
  }

  const complete = draft.from && draft.to ? { from: draft.from, to: draft.to } : null
  const tooLong = complete ? daysInRange(complete) > RANGE_MAX_DAYS : false

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" aria-label={`Periodo: ${label}. Cambiar`} />}>
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("gap-1 p-1.5", view === "range" ? "w-auto max-w-[calc(100vw-2rem)]" : "w-72")}>
        {view === "months" ? (
          <div className="flex flex-col gap-3 p-1.5">
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setView("options")}>
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
        ) : view === "range" ? (
          <div className="flex flex-col gap-3 p-1.5">
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setView("options")}>
              <ChevronLeft aria-hidden />
              Opciones
            </Button>
            {/* Dos meses a la vista en pantalla ancha; uno en el teléfono. */}
            <div className="hidden sm:block">
              <Calendar mode="range" selected={draft} max={today} onSelect={setDraft} />
            </div>
            <div className="sm:hidden">
              <Calendar mode="range" compact selected={draft} max={today} onSelect={setDraft} />
            </div>
            <p className="text-[13px] text-muted-foreground">
              {tooLong ? "Un rango abarca como mucho dos años." : "Fechas de la clínica. Se compara con los mismos días justo antes."}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancelar
              </Button>
              <Button type="button" disabled={!complete || tooLong} onClick={() => complete && pick(rangePeriod(complete.from, complete.to))}>
                {complete ? `Ver ${daysLabel(complete, locale).replace(/ de \d{4}$/, "")}` : "Elige el primer y el último día"}
              </Button>
            </div>
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
              onClick={() => setView("months")}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left text-sm font-semibold",
                chosenMonth ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
              )}
            >
              <span className="flex-1">{chosenMonth ? `Otro mes: ${monthLabel(chosenMonth, locale)}` : "Otro mes…"}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setView("range")}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left text-sm font-semibold",
                chosenRange ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
              )}
            >
              <CalendarRangeIcon aria-hidden className="size-4 shrink-0" />
              <span className="flex-1">{chosenRange ? `Fechas: ${daysLabel(chosenRange, locale)}` : "Elegir fechas…"}</span>
            </Button>
            <p className="px-2.5 pt-1 pb-1.5 text-[13px] text-muted-foreground">Se compara con el periodo anterior de la misma duración.</p>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
