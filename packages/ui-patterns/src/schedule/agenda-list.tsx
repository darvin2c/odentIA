/**
 * Lista de la agenda: las citas del día en el orden en que hay que atenderlas.
 * Primero quien está en la clínica (llegó o está en atención: lo dice su
 * estado, no el reloj), después lo que viene, a la vista lo que ya pasó sin
 * cerrarse y, plegado, lo demás que ya pasó. Cada fila es una tarjeta del
 * color de su estado con la hora delante, quién viene, con quién y un único
 * paso siguiente; el resto de acciones va tras el menú. La fila entera abre el
 * detalle.
 */

import { cn } from "@odentia/ui"
import { ChevronDown, ChevronRight } from "lucide-react"
import * as React from "react"

import { SubmitButton } from "../form/submit-button.js"
import { type RowActionItem, RowActions } from "../row-actions.js"
import { formatSpan } from "./occupancy.js"
import { entryState, entryStateLabel, StatusIcon, statusSurfaceClass, statusTextClass } from "./status.js"
import { dayMinutesIn, durationMinutes, hourLabel, zonedDateOf } from "./time.js"
import { ResourceAvatar } from "./tone.js"
import type { ScheduleEntry, ScheduleStatus, ScheduleTone } from "./types.js"

export interface ScheduleAgendaItem {
  entry: ScheduleEntry
  /** Quién atiende; se muestra con sus iniciales de color. */
  resourceLabel: string
  /** Cómo decirlo cuando el nombre completo no cabe («Dra. Ana»). */
  resourceShortLabel?: string
  resourceTone?: ScheduleTone
  /** Dato secundario del recurso: la unidad dental. */
  resourceDetail?: string
}

export interface ScheduleAgendaAction {
  label: string
  onSelect: () => void
  /** La acción está en curso: el botón no admite otro clic. */
  pending?: boolean
}

export interface ScheduleAgendaListProps {
  items: ScheduleAgendaItem[]
  timeZone: string
  /** Instante actual, solo para el día de hoy: separa a quien está en la clínica, lo que viene y lo que pasó. */
  now?: string
  /** Paso siguiente de la cita, si lo tiene («Confirmar»). */
  primaryAction?: (item: ScheduleAgendaItem) => ScheduleAgendaAction | null
  /** Resto de acciones de la cita, tras el menú. */
  menuItems?: (item: ScheduleAgendaItem) => RowActionItem[]
  onOpen?: (entry: ScheduleEntry) => void
  emptyLabel?: string
  className?: string
}

/** «4 atendidas · 1 no vino»: qué fue de lo que ya pasó. */
function outcomeSummary(items: ScheduleAgendaItem[]): string {
  const counts = new Map<ScheduleStatus, number>()
  for (const item of items) {
    counts.set(item.entry.status, (counts.get(item.entry.status) ?? 0) + 1)
  }
  const said: Array<[ScheduleStatus, string, string]> = [
    ["atendida", "atendida", "atendidas"],
    ["no_asistio", "no vino", "no vinieron"],
    ["cancelada", "cancelada", "canceladas"],
  ]
  return said
    .filter(([status]) => (counts.get(status) ?? 0) > 0)
    .map(([status, one, many]) => {
      const count = counts.get(status) ?? 0
      return `${count} ${count === 1 ? one : many}`
    })
    .join(" · ")
}

function AgendaRow({
  item,
  timeZone,
  primaryAction,
  menuItems,
  onOpen,
}: {
  item: ScheduleAgendaItem
  timeZone: string
  primaryAction?: ScheduleAgendaListProps["primaryAction"]
  menuItems?: ScheduleAgendaListProps["menuItems"]
  onOpen?: ScheduleAgendaListProps["onOpen"]
}) {
  const { entry } = item
  const action = primaryAction?.(item) ?? null
  const menu = menuItems?.(item) ?? []
  const start = hourLabel(dayMinutesIn(entry.start, timeZone))
  const state = entryState(entry)
  const status = entryStateLabel(entry)
  return (
    <li
      data-entry={entry.id}
      data-status={entry.status}
      data-state={state}
      className={cn(
        "relative flex min-h-16 items-center gap-3 rounded-2xl py-2 pr-2 pl-4 sm:gap-4",
        statusSurfaceClass(state),
      )}
    >
      <div className="flex w-14 shrink-0 flex-col sm:w-20">
        <span className="text-base leading-6 font-bold tabular-nums sm:text-lg">{start}</span>
        <span className="text-xs text-muted-foreground">{formatSpan(durationMinutes(entry))}</span>
      </div>

      {/* En teléfono las iniciales van junto al nombre; el recurso completo, en la segunda línea. */}
      <ResourceAvatar
        label={item.resourceLabel}
        tone={item.resourceTone}
        size="sm"
        className="ring-2 ring-card sm:hidden"
      />

      <div className="flex min-w-0 flex-[1.3] flex-col">
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(entry)}
            className="truncate text-left text-[15px] font-semibold outline-none after:absolute after:inset-0 after:rounded-2xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {entry.title}
          </button>
        ) : (
          <span className="truncate text-[15px] font-semibold">{entry.title}</span>
        )}
        <span className="truncate text-[13px] text-muted-foreground">
          {entry.test ? <span className="font-semibold text-foreground">Prueba · </span> : null}
          {entry.subtitle}
          <span className="sm:hidden">
            {entry.subtitle ? " · " : ""}
            {item.resourceShortLabel ?? item.resourceLabel}
          </span>
        </span>
      </div>

      <div className="hidden min-w-0 flex-1 items-center gap-2.5 sm:flex">
        <ResourceAvatar
          label={item.resourceLabel}
          tone={item.resourceTone}
          className="ring-2 ring-card"
        />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{item.resourceLabel}</span>
          {item.resourceDetail ? (
            <span className="truncate text-xs text-muted-foreground">{item.resourceDetail}</span>
          ) : null}
        </div>
      </div>

      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[13px] font-bold sm:w-44",
          statusTextClass(state),
          action && "max-sm:hidden",
        )}
      >
        <StatusIcon status={state} />
        <span className="max-sm:sr-only">{status}</span>
      </span>

      {action || menu.length > 0 ? (
        <div className="relative z-10 flex shrink-0 items-center justify-end gap-1 sm:w-44">
          {action ? (
            <SubmitButton
              variant="outline"
              className="h-10 bg-card font-bold text-primary-soft-foreground shadow-xs hover:bg-card/80"
              pending={action.pending}
              onClick={action.onSelect}
            >
              {action.label}
            </SubmitButton>
          ) : null}
          {/* En teléfono, con paso siguiente a la vista, el resto está al abrir la cita. */}
          {menu.length > 0 ? (
            <span className={cn(action && onOpen && "max-sm:hidden")}>
              <RowActions label={`Más acciones para ${entry.title}`} items={menu} />
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** Sigue en pie: por confirmar o confirmada (con o sin llegada). */
const standing = (item: ScheduleAgendaItem) =>
  item.entry.status === "programada" || item.entry.status === "confirmada"

export function ScheduleAgendaList({
  items,
  timeZone,
  now,
  primaryAction,
  menuItems,
  onOpen,
  emptyLabel = "No hay citas este día.",
  className,
}: ScheduleAgendaListProps) {
  const [showPast, setShowPast] = React.useState(false)
  const pastId = React.useId()

  const sorted = React.useMemo(
    () => [...items].sort((a, b) => a.entry.start.localeCompare(b.entry.start)),
    [items],
  )
  const nowMs = now === undefined ? null : Date.parse(now)
  const current: ScheduleAgendaItem[] = []
  const upcoming: ScheduleAgendaItem[] = []
  const unclosed: ScheduleAgendaItem[] = []
  const past: ScheduleAgendaItem[] = []
  const today = now === undefined ? null : zonedDateOf(now, timeZone)
  for (const item of sorted) {
    const end = Date.parse(item.entry.end)
    // Lo que está en curso sale del estado real: hoy llegó o está en atención.
    // Una llegada de otro día ya no es «en la clínica»: es algo sin cerrar.
    const inClinic = item.entry.stage !== undefined && (today === null || zonedDateOf(item.entry.start, timeZone) === today)
    if (inClinic) current.push(item)
    else if (standing(item) && item.entry.stage === undefined && (nowMs === null || end > nowMs)) upcoming.push(item)
    // Su hora pasó y nadie la cerró: queda a la vista, con su salida.
    else if (standing(item)) unclosed.push(item)
    else past.push(item)
  }

  if (sorted.length === 0) {
    return (
      <p
        className={cn(
          "rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyLabel}
      </p>
    )
  }

  const row = (item: ScheduleAgendaItem) => (
    <AgendaRow
      key={item.entry.id}
      item={item}
      timeZone={timeZone}
      primaryAction={primaryAction}
      menuItems={menuItems}
      onOpen={onOpen}
    />
  )

  // Otro día (sin «ahora») o uno que ya pasó entero se lee completo: no hay nada «por venir» que priorizar.
  if (now === undefined || (current.length === 0 && upcoming.length === 0)) {
    return <ul className={cn("flex flex-col gap-2", className)}>{sorted.map(row)}</ul>
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {now !== undefined && (current.length > 0 || past.length > 0 || unclosed.length > 0) ? (
        <div className="flex items-center gap-2.5 px-1 pt-1" data-now>
          <span className="shrink-0 rounded-full bg-destructive px-2.5 text-xs leading-[22px] font-bold text-background tabular-nums">
            Ahora · {hourLabel(dayMinutesIn(now, timeZone))}
          </span>
          <span aria-hidden className="h-0 flex-1 border-t-2 border-destructive" />
        </div>
      ) : null}

      {current.length > 0 ? (
        <ul aria-label="En la clínica" className="flex flex-col gap-2">
          {current.map(row)}
        </ul>
      ) : null}

      {upcoming.length > 0 ? (
        <>
          {current.length > 0 || past.length > 0 || unclosed.length > 0 ? (
            <h2 className="px-1 pt-2 text-sm font-bold text-muted-foreground">
              Lo que viene · {upcoming.length}
            </h2>
          ) : null}
          <ul aria-label="Lo que viene" className="flex flex-col gap-2">
            {upcoming.map(row)}
          </ul>
        </>
      ) : null}

      {unclosed.length > 0 ? (
        <>
          <h2 className="px-1 pt-2 text-sm font-bold text-muted-foreground">
            Ya pasaron · sin cerrar · {unclosed.length}
          </h2>
          <ul aria-label="Ya pasaron sin cerrar" className="flex flex-col gap-2">
            {unclosed.map(row)}
          </ul>
        </>
      ) : null}

      {past.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showPast}
            aria-controls={pastId}
            onClick={() => setShowPast((value) => !value)}
            className="mt-2 flex min-h-14 items-center gap-2.5 rounded-2xl border border-dashed px-4 text-left text-sm font-semibold text-muted-foreground outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showPast ? (
              <ChevronDown aria-hidden className="size-4 shrink-0" />
            ) : (
              <ChevronRight aria-hidden className="size-4 shrink-0" />
            )}
            <span className="flex-1">
              Ya pasaron · {past.length} {past.length === 1 ? "cita" : "citas"}
            </span>
            <span className="font-medium">{outcomeSummary(past)}</span>
          </button>
          {showPast ? (
            <ul id={pastId} aria-label="Ya pasaron" className="flex flex-col gap-2">
              {past.map(row)}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
