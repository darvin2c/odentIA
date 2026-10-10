/**
 * Próximos huecos: lo que el servicio de reserva devolvió, agrupado por día y
 * dicho como hora + con quién. Elegir uno es toda la decisión de «cuándo»: no
 * hay que escribir fecha ni hora. El patrón no calcula ningún hueco; solo
 * ordena, agrupa y recorta los que recibe.
 */

import { cn, Spinner } from "@odentia/ui"
import * as React from "react"

import { addDays, dayMinutesIn, hourLabel, zonedDateOf } from "./time.js"

export interface ScheduleSlotChoice {
  /** Identidad estable del hueco (instante + recurso). */
  id: string
  start: string
  end: string
  /** Con quién, cuando se busca sin fijar recurso. */
  resourceLabel?: string
}

export interface ScheduleSlotChoicesProps {
  slots: ScheduleSlotChoice[]
  timeZone: string
  /** Id del hueco elegido. */
  value: string | null
  onChange: (slot: ScheduleSlotChoice) => void
  /** Hoy en la zona de la sede, para decir «Hoy» y «Mañana». */
  today?: string
  /** Huecos por día antes de «Más». */
  perDay?: number
  /** Días que se muestran. */
  maxDays?: number
  /**
   * Una sola opción por hora: cuando no se fijó con quién, basta elegir la
   * hora y queda el primer recurso libre a esa hora, que la ficha nombra.
   */
  distinctTimes?: boolean
  loading?: boolean
  /** Control a la derecha del rótulo («Otra fecha»). */
  action?: React.ReactNode
  label?: string
  emptyLabel?: string
  className?: string
}

const weekdayFormatter = new Intl.DateTimeFormat("es-PE", {
  timeZone: "UTC",
  weekday: "long",
  day: "numeric",
})

/** «lunes 12» para rotular el día de un grupo de huecos. */
function weekdayDay(dateISO: string): string {
  const [year = 0, month = 1, day = 1] = dateISO.split("-").map(Number)
  const parts = weekdayFormatter.formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("weekday")} ${get("day")}`
}

function dayHeading(dateISO: string, today: string | undefined): string {
  const said = weekdayDay(dateISO)
  if (today && dateISO === today) return `Hoy, ${said}`
  if (today && dateISO === addDays(today, 1)) return `Mañana, ${said}`
  return said.charAt(0).toLocaleUpperCase("es") + said.slice(1)
}

export function ScheduleSlotChoices({
  slots,
  timeZone,
  value,
  onChange,
  today,
  perDay = 4,
  maxDays = 3,
  distinctTimes = false,
  loading = false,
  action,
  label = "Próximos huecos",
  emptyLabel = "No hay huecos en los próximos días. Prueba otra fecha u otro profesional.",
  className,
}: ScheduleSlotChoicesProps) {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const labelId = React.useId()

  const days = React.useMemo(() => {
    const byDay = new Map<string, ScheduleSlotChoice[]>()
    const taken = new Set<string>()
    // El hueco elegido se conserva aunque otro recurso comparta su hora.
    const chosenStart = slots.find((slot) => slot.id === value)?.start
    for (const slot of [...slots].sort((a, b) => a.start.localeCompare(b.start))) {
      if (
        distinctTimes &&
        slot.id !== value &&
        (taken.has(slot.start) || slot.start === chosenStart)
      ) {
        continue
      }
      taken.add(slot.start)
      const day = zonedDateOf(slot.start, timeZone)
      const list = byDay.get(day) ?? []
      list.push(slot)
      byDay.set(day, list)
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, maxDays)
  }, [slots, timeZone, maxDays, distinctTimes, value])

  return (
    <div className={cn("flex min-w-0 flex-col gap-2.5", className)}>
      <div className="flex items-baseline gap-2">
        <span id={labelId} className="text-sm font-semibold">
          {label}
        </span>
        {loading ? <Spinner className="size-3.5" /> : null}
        <span className="flex-1" />
        {action}
      </div>
      {days.length === 0 && !loading ? (
        <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
          {emptyLabel}
        </p>
      ) : null}
      {days.map(([day, daySlots]) => {
        const open = expanded.has(day)
        // El hueco elegido nunca se esconde tras «Más».
        const chosenBeyond = daySlots.findIndex((slot) => slot.id === value) >= perDay - 1
        // Con más huecos que sitio, el último lugar de la fila es «Más».
        const visible =
          open || chosenBeyond || daySlots.length <= perDay
            ? daySlots
            : daySlots.slice(0, perDay - 1)
        const hidden = daySlots.length - visible.length
        return (
          <fieldset key={day} className="flex min-w-0 flex-col gap-1.5 border-0 p-0">
            <legend className="mb-1.5 p-0 text-xs text-muted-foreground">
              {dayHeading(day, today)}
            </legend>
            <div className="grid grid-cols-4 gap-2">
              {visible.map((slot) => {
                const chosen = slot.id === value
                return (
                  <button
                    key={slot.id}
                    type="button"
                    aria-pressed={chosen}
                    onClick={() => onChange(slot)}
                    className={cn(
                      "flex h-12 min-w-0 flex-col items-center justify-center rounded-xl border px-1 outline-none transition-colors",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                      chosen
                        ? "border-primary bg-primary-soft text-primary-soft-foreground ring-1 ring-primary"
                        : "border-input bg-card hover:border-primary",
                    )}
                  >
                    <span className="text-[15px] leading-5 font-bold tabular-nums">
                      {hourLabel(dayMinutesIn(slot.start, timeZone))}
                    </span>
                    {slot.resourceLabel ? (
                      <span
                        className={cn(
                          "max-w-full truncate text-[11px] leading-4",
                          !chosen && "text-muted-foreground",
                        )}
                      >
                        {slot.resourceLabel}
                      </span>
                    ) : null}
                  </button>
                )
              })}
              {hidden > 0 ? (
                <button
                  type="button"
                  aria-label={`Ver ${hidden} huecos más del ${weekdayDay(day)}`}
                  onClick={() => setExpanded((current) => new Set(current).add(day))}
                  className="flex h-12 items-center justify-center rounded-xl border border-dashed text-[13px] font-semibold text-muted-foreground outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Más
                </button>
              ) : null}
            </div>
          </fieldset>
        )
      })}
    </div>
  )
}
