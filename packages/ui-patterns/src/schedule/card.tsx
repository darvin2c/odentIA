/**
 * Tarjeta de cita de la rejilla: el fondo dice el estado, la primera línea
 * dice quién y la segunda cuándo y para qué. Cuando no caben dos líneas queda
 * una sola con la hora delante. El fantasma del arrastre va en el envoltorio,
 * los gestos en el botón y las asas de los bordes son botones hermanos.
 */

import { cn } from "@odentia/ui"
import { TriangleAlert } from "lucide-react"
import type * as React from "react"

import { entryAccessibleName } from "./block.js"
import type { EntryDragBlockProps, EntryDragResizeProps } from "./drag.js"
import { entryState, StatusIcon, statusSurfaceClass } from "./status.js"
import { dayMinutesIn, hourLabel } from "./time.js"
import type { ScheduleEntry } from "./types.js"

/** Por debajo de este alto la tarjeta se queda en una sola línea. */
const TWO_LINES_PX = 34

export interface ScheduleCardProps {
  entry: ScheduleEntry
  timeZone: string
  /** Alto disponible en px: decide cuántas líneas caben. */
  heightPx: number
  /** La cita cuyo detalle está abierto al lado. */
  selected?: boolean
  draggable: boolean
  dragProps: EntryDragBlockProps
  /** Asas de los dos bordes; null cuando la vista no permite redimensionar. */
  resizeProps: { start: EntryDragResizeProps; end: EntryDragResizeProps } | null
  onOpen?: (entry: ScheduleEntry) => void
  suppressClick: () => boolean
  className?: string
  style?: React.CSSProperties
}

export function ScheduleCard({
  entry,
  timeZone,
  heightPx,
  selected = false,
  draggable,
  dragProps,
  resizeProps,
  onOpen,
  suppressClick,
  className,
  style,
}: ScheduleCardProps) {
  const { style: ghostStyle, ...buttonDragProps } = dragProps
  const dragging = dragProps["data-dragging"] === "true"
  const startLabel = hourLabel(dayMinutesIn(entry.start, timeZone))
  const twoLines = heightPx >= TWO_LINES_PX
  const state = entryState(entry)

  const open = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (suppressClick()) return
    event.stopPropagation()
    onOpen?.(entry)
  }

  return (
    <div
      data-entry={entry.id}
      data-dragging={dragging ? "true" : undefined}
      className={cn("absolute", dragging && "z-20", className)}
      style={{ ...style, ...ghostStyle }}
    >
      <button
        type="button"
        {...buttonDragProps}
        onKeyDown={(event) => {
          buttonDragProps.onKeyDown(event)
          if (event.defaultPrevented) return
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            if (!suppressClick()) onOpen?.(entry)
          }
        }}
        onClick={open}
        aria-label={entryAccessibleName(entry, timeZone, draggable)}
        aria-current={selected ? "true" : undefined}
        title={entry.warning}
        className={cn(
          "flex size-full touch-manipulation flex-col justify-center overflow-hidden rounded-[10px] px-2.5 text-left outline-none select-none",
          "transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
          statusSurfaceClass(state),
          entry.warning && "ring-2 ring-warning ring-inset",
          selected && "ring-2 ring-ring",
          draggable && "cursor-grab",
          dragging && "cursor-grabbing opacity-80 shadow-lg ring-2 ring-ring",
        )}
      >
        {twoLines ? (
          <>
            <span className="flex w-full items-center gap-1.5 text-[13px] leading-[17px] font-semibold">
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {entry.warning ? (
                <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-warning" />
              ) : null}
              <StatusIcon status={state} className="size-3.5" />
            </span>
            <span className="w-full truncate text-xs leading-[15px] text-muted-foreground">
              <span className="font-semibold tabular-nums">{startLabel}</span>
              {entry.subtitle ? ` ${entry.subtitle}` : null}
            </span>
          </>
        ) : (
          <span className="flex w-full items-center gap-1.5 text-xs leading-4 font-semibold">
            <span className="shrink-0 tabular-nums">{startLabel}</span>
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            <StatusIcon status={state} className="size-3.5" />
          </span>
        )}
      </button>
      {resizeProps ? (
        <>
          <button
            type="button"
            {...resizeProps.start}
            aria-label={`Cambiar el inicio de la cita de ${entry.title}`}
            className="absolute inset-x-0 top-0 h-2.5 cursor-ns-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          >
            <span
              aria-hidden
              className="absolute inset-x-3 top-0.5 h-0.5 rounded-full bg-foreground/40"
            />
          </button>
          <button
            type="button"
            {...resizeProps.end}
            aria-label={`Cambiar la duración de ${entry.title}`}
            className="absolute inset-x-0 bottom-0 h-2.5 cursor-ns-resize opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          >
            <span
              aria-hidden
              className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-foreground/40"
            />
          </button>
        </>
      ) : null}
    </div>
  )
}
