/**
 * El bloque del eje de tiempo: posición absoluta que le da el carril,
 * densidad de texto por tamaño. El fantasma (transform) va en el envoltorio,
 * los gestos en el botón principal y las asas de los bordes son botones
 * hermanos, nunca anidados (HTML válido, ARIA limpio).
 */

import { cn } from "@odentia/ui"
import { TriangleAlert } from "lucide-react"
import type * as React from "react"

import type { EntryDragBlockProps, EntryDragResizeProps } from "./drag.js"
import { statusBlockClasses } from "./status.js"
import { timeRangeLabel } from "./time.js"
import type { ScheduleEntry } from "./types.js"

interface CommonProps {
  entry: ScheduleEntry
  timeZone: string
  draggable: boolean
  dragProps: EntryDragBlockProps
  onOpen?: (entry: ScheduleEntry) => void
  suppressClick: () => boolean
}

function accessibleName(entry: ScheduleEntry, timeZone: string, draggable: boolean): string {
  const base = `Cita de ${entry.title}, ${timeRangeLabel(entry.start, entry.end, timeZone)}${entry.subtitle ? `, ${entry.subtitle}` : ""}${entry.warning ? `. Atención: ${entry.warning}` : ""}`
  return draggable ? `${base}. Alt+Intro para moverla` : base
}

function openHandler(entry: ScheduleEntry, props: CommonProps) {
  return (event: React.MouseEvent | React.KeyboardEvent) => {
    if (props.suppressClick()) return
    event.stopPropagation()
    props.onOpen?.(entry)
  }
}

function composeKeyDown(entry: ScheduleEntry, props: CommonProps) {
  return (event: React.KeyboardEvent) => {
    props.dragProps.onKeyDown(event)
    if (event.defaultPrevented) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      if (!props.suppressClick()) props.onOpen?.(entry)
    }
  }
}

/** Bloque del eje: posición absoluta que le da el carril, densidad por tamaño. */
export function ScheduleBlock({
  axis,
  sizePx,
  resizeProps,
  className,
  style,
  ...props
}: CommonProps & {
  axis: "vertical" | "horizontal"
  /** Alto (eje vertical) o ancho (horizontal) en px: decide qué texto cabe. */
  sizePx: number
  /** Asas de los dos bordes; null cuando la vista no permite redimensionar. */
  resizeProps: { start: EntryDragResizeProps; end: EntryDragResizeProps } | null
  className?: string
  style?: React.CSSProperties
}) {
  const { entry, timeZone } = props
  const { style: ghostStyle, ...buttonDragProps } = props.dragProps
  const dragging = props.dragProps["data-dragging"] === "true"
  return (
    <div
      data-dragging={dragging ? "true" : undefined}
      className={cn("absolute", dragging && "z-20", className)}
      style={{ ...style, ...ghostStyle }}
    >
      <button
        type="button"
        {...buttonDragProps}
        onKeyDown={composeKeyDown(entry, props)}
        onClick={openHandler(entry, props)}
        aria-label={accessibleName(entry, timeZone, props.draggable)}
        title={entry.warning}
        className={cn(
          "flex size-full touch-manipulation flex-col overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs select-none",
          statusBlockClasses(entry.status),
          entry.warning && "ring-2 ring-inset ring-amber-600 dark:ring-amber-400",
          props.draggable && "cursor-grab",
          dragging && "cursor-grabbing opacity-70 shadow-lg ring-2 ring-ring",
        )}
      >
        <span className="flex w-full shrink-0 items-center gap-1 leading-tight font-medium">
          {entry.warning && (
            <TriangleAlert
              aria-hidden
              className="size-3 shrink-0 text-amber-700 dark:text-amber-300"
            />
          )}
          <span className="min-w-0 truncate">{entry.title}</span>
        </span>
        {entry.resourceLabel && (axis === "horizontal" || sizePx >= 56) && (
          <span
            className="mt-0.5 max-w-full shrink-0 self-start truncate rounded border border-current/15 px-1 text-[10px] leading-tight"
            title={entry.resourceLabel}
          >
            {entry.resourceLabel}
          </span>
        )}
        {/*
         * En el eje vertical `sizePx` es la ALTURA (cuántas líneas caben); en
         * el horizontal es el ANCHO (cuánto texto cabe). Umbrales distintos:
         * la hora solo cuando se lee entera, nunca cortada.
         */}
        {(axis === "vertical" ? sizePx >= 36 : sizePx >= 104) ? (
          <span className="truncate text-[11px] leading-tight opacity-80">
            {timeRangeLabel(entry.start, entry.end, timeZone)}
          </span>
        ) : null}
        {(axis === "vertical" ? sizePx >= 56 : sizePx >= 168) && entry.subtitle ? (
          <span className="truncate text-[11px] leading-tight opacity-70">{entry.subtitle}</span>
        ) : null}
      </button>
      {resizeProps ? (
        <>
          <button
            type="button"
            {...resizeProps.start}
            aria-label={`Cambiar el inicio de la cita de ${entry.title}`}
            className={cn(
              "absolute opacity-0 transition-opacity focus-visible:opacity-100 hover:opacity-100",
              axis === "vertical"
                ? "inset-x-0 top-0 h-2.5 cursor-ns-resize"
                : "inset-y-0 left-0 w-2.5 cursor-ew-resize",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute bg-foreground/40",
                axis === "vertical"
                  ? "inset-x-2 top-0.5 h-0.5 rounded-full"
                  : "inset-y-2 left-0.5 w-0.5 rounded-full",
              )}
            />
          </button>
          <button
            type="button"
            {...resizeProps.end}
            aria-label={`Cambiar la duración de ${entry.title}`}
            className={cn(
              "absolute opacity-0 transition-opacity focus-visible:opacity-100 hover:opacity-100",
              axis === "vertical"
                ? "inset-x-0 bottom-0 h-2.5 cursor-ns-resize"
                : "inset-y-0 right-0 w-2.5 cursor-ew-resize",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "absolute bg-foreground/40",
                axis === "vertical"
                  ? "inset-x-2 bottom-0.5 h-0.5 rounded-full"
                  : "inset-y-2 right-0.5 w-0.5 rounded-full",
              )}
            />
          </button>
        </>
      ) : null}
    </div>
  )
}
