/**
 * El periodo de una respuesta de Argos (tableros 7 a 12 del lienzo; decisiones
 * D8 a D16): el mismo botón y las mismas palabras de Reportes, con las opciones
 * según la pregunta (un día, una semana o las de Reportes), «Comparado con…» o
 * el segundo periodo, y la sede si la respuesta va por sede. Lo que es a hoy
 * solo se dice. Cambiar algo vuelve a correr la consulta en el servidor, sin el
 * modelo; los textos los entrega el servidor.
 */
import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { Calendar, type CalendarRange } from "@odentia/ui-patterns"
import { CalendarRange as CalendarRangeIcon, Check, ChevronDown, ChevronLeft, Clock } from "lucide-react"
import { useEffect, useState } from "react"
import type { ArgosChoice, ArgosPeriod } from "../../lib/argos"
import { daysLabel } from "../../lib/reports"
import { ReportPeriodPicker } from "../reports/report-period"
import { ChoiceSelect } from "../ui/choice-select"

const SHORT_OPTIONS = {
  dia: [
    { value: "hoy", title: "Hoy", detail: "Hasta ahora" },
    { value: "ayer", title: "Ayer", detail: "El día entero" },
  ],
  semana: [
    { value: "esta_semana", title: "Esta semana", detail: "De lunes a hoy" },
    { value: "semana_pasada", title: "La semana pasada", detail: "De lunes a domingo" },
  ],
} as const

/** Las opciones de un día o de una semana (D16) y su calendario: un día, o unas fechas. */
function ShortPeriodPicker({
  grain,
  value,
  label,
  today,
  locale,
  onChange,
}: {
  grain: "dia" | "semana"
  value: string
  label: string
  today: string
  locale: string
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [calendar, setCalendar] = useState(false)
  const [day, setDay] = useState<string | undefined>()
  const [range, setRange] = useState<CalendarRange>({})
  // Al abrir se ven las opciones; el calendario, solo si se pide.
  useEffect(() => {
    if (!open) return
    setCalendar(false)
    setDay(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined)
    const chosen = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value)
    setRange(chosen ? { from: chosen[1], to: chosen[2] } : {})
  }, [open, value])
  const pick = (next: string) => {
    onChange(next)
    setOpen(false)
  }
  const complete = range.from && range.to ? { from: range.from, to: range.to } : null
  const options = SHORT_OPTIONS[grain]
  const chosenOther = !options.some((option) => option.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" aria-label={`Periodo: ${label}. Cambiar`} />}>
        <span className="truncate">{label}</span>
        <ChevronDown aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className={cn("gap-1 p-1.5", calendar ? "w-auto max-w-[calc(100vw-2rem)]" : "w-72")}>
        {calendar ? (
          <div className="flex flex-col gap-3 p-1.5">
            <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setCalendar(false)}>
              <ChevronLeft aria-hidden />
              Opciones
            </Button>
            {grain === "dia" ? (
              <>
                <Calendar mode="single" selected={day} max={today} onSelect={(next) => next && pick(next)} />
                <p className="text-[13px] text-muted-foreground">Fechas de la clínica. Se compara con el día anterior.</p>
              </>
            ) : (
              <>
                <div className="hidden sm:block">
                  <Calendar mode="range" selected={range} max={today} onSelect={setRange} />
                </div>
                <div className="sm:hidden">
                  <Calendar mode="range" compact selected={range} max={today} onSelect={setRange} />
                </div>
                <p className="text-[13px] text-muted-foreground">Fechas de la clínica. Se compara con los mismos días justo antes.</p>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                    Cancelar
                  </Button>
                  <Button type="button" disabled={!complete} onClick={() => complete && pick(`${complete.from}..${complete.to}`)}>
                    {complete ? `Ver ${daysLabel(complete, locale).replace(/ de \d{4}$/, "")}` : "Elige el primer y el último día"}
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <fieldset aria-label="Periodo" className="flex min-w-0 flex-col">
              {options.map((option) => {
                const selected = value === option.value
                return (
                  <Button
                    key={option.value}
                    type="button"
                    variant="ghost"
                    aria-pressed={selected}
                    onClick={() => pick(option.value)}
                    className={cn(
                      "h-auto min-h-12 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left font-normal",
                      selected ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className={cn("text-sm", selected ? "font-bold" : "font-semibold")}>{option.title}</span>
                      <span className={cn("text-[13px]", selected ? "" : "text-muted-foreground")}>{option.detail}</span>
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
              onClick={() => setCalendar(true)}
              className={cn(
                "h-auto min-h-11 w-full justify-start gap-2 whitespace-normal rounded-lg px-2.5 py-1.5 text-left text-sm font-semibold",
                chosenOther ? "bg-primary-soft text-primary-soft-foreground hover:bg-primary-soft" : "",
              )}
            >
              <CalendarRangeIcon aria-hidden className="size-4 shrink-0" />
              <span className="flex-1">{chosenOther ? `Fechas: ${label}` : grain === "dia" ? "Elegir un día…" : "Elegir fechas…"}</span>
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Un selector del periodo con las opciones que tocan a la pregunta (D16). */
function PeriodPicker({ grain, value, label, today, locale, onChange }: { grain: ArgosPeriod["grain"]; value: string; label: string; today: string; locale: string; onChange: (next: string) => void }) {
  if (grain === "dia" || grain === "semana") return <ShortPeriodPicker grain={grain} value={value} label={label} today={today} locale={locale} onChange={onChange} />
  const [year, month] = today.split("-").map(Number)
  return <ReportPeriodPicker value={value} label={label} currentMonth={{ year: year ?? 2000, month: month ?? 1 }} today={today} locale={locale} onChange={onChange} />
}

/**
 * La fila del periodo arriba de la respuesta: el botón, «contra» y el segundo
 * botón cuando la pregunta nombra dos periodos, la sede si va por sede y
 * «Comparado con…». Mientras se calcula no se cambia otra vez.
 */
export function ArgosPeriodRow({
  period,
  locale,
  disabled,
  onChange,
}: {
  period: ArgosPeriod
  locale: string
  disabled: boolean
  onChange: (change: ArgosChoice) => void
}) {
  if (period.value === "a_hoy")
    return (
      <p className="flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground">
        <Clock aria-hidden className="size-3.5 shrink-0" />
        {period.label}
      </p>
    )
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 disabled:opacity-70">
      <legend className="sr-only">Periodo de la respuesta</legend>
      <PeriodPicker grain={period.grain} value={period.value} label={period.label} today={period.today} locale={locale} onChange={(next) => onChange({ period: next })} />
      {period.other ? (
        <>
          <span className="text-[13px] text-muted-foreground">contra</span>
          <PeriodPicker grain={period.grain} value={period.other.value} label={period.other.label} today={period.today} locale={locale} onChange={(next) => onChange({ other: next })} />
        </>
      ) : null}
      {period.branch ? (
        <ChoiceSelect aria-label="Sede" className="w-44" value={period.branch.id ?? ""} onChange={(event) => onChange({ branchId: event.target.value || null })}>
          <option value="">Todas las sedes</option>
          {period.branch.options.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </ChoiceSelect>
      ) : null}
      {period.compareLabel ? <span className="min-w-0 text-[13px] text-muted-foreground">Comparado con {period.compareLabel}</span> : null}
    </fieldset>
  )
}
