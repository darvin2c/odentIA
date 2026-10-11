/**
 * Elegir el «cuándo» de una cita sobre las horas de un día: blanco es lo que
 * está libre y gris lo que no. Un toque en lo libre coloca el bloque con la
 * duración habitual; el bloque se arrastra para cambiar la hora (o de
 * profesional) y se estira para cambiar la duración. Con teclado, las flechas
 * lo mueven y Mayús con flechas lo estiran.
 *
 * El patrón no decide qué está libre: lo recibe del servicio (`free`) y solo
 * dice cómo queda la elección (`scheduleRangeState`). Quien valida y reserva
 * es el servicio.
 */

import { cn } from "@odentia/ui"
import * as React from "react"

import { clipRanges, dayRangeOf, isCovered, type MinuteRange, windowCovering } from "./occupancy.js"
import { dayMinutesIn, hourLabel, minutesToInstant, zonedDateOf } from "./time.js"
import { ResourceAvatar } from "./tone.js"
import type { ScheduleAvailability, ScheduleColumn } from "./types.js"
import { SCHEDULE_DEFAULT_WINDOW } from "./types.js"

/** Ancho del canal de horas. */
const GUTTER_PX = 44

export interface ScheduleRangeValue {
  columnId: string
  start: string
  end: string
}

/** Cómo queda la elección: reservable, dentro del horario pero ocupada, o fuera del horario. */
export type ScheduleRangeState = "free" | "taken" | "outside"

function rangesOf(
  items: ScheduleAvailability[] | undefined,
  columnId: string,
  date: string,
  timeZone: string,
): MinuteRange[] {
  return (items ?? [])
    .filter((item) => item.columnId === columnId)
    .flatMap((item): MinuteRange[] => {
      const range = dayRangeOf(item.start, item.end, date, timeZone)
      return range ? [range] : []
    })
}

/** Dice si el tramo elegido cabe en lo libre, cae en algo ocupado o sale del horario. */
export function scheduleRangeState(
  value: ScheduleRangeValue,
  input: { free: ScheduleAvailability[]; open?: ScheduleAvailability[]; timeZone: string },
): ScheduleRangeState {
  const date = zonedDateOf(value.start, input.timeZone)
  const range = dayRangeOf(value.start, value.end, date, input.timeZone)
  if (!range) return "outside"
  if (isCovered(range, rangesOf(input.free, value.columnId, date, input.timeZone))) return "free"
  return isCovered(range, rangesOf(input.open, value.columnId, date, input.timeZone))
    ? "taken"
    : "outside"
}

export interface ScheduleRangePickerProps {
  /** Recursos entre los que se elige; con uno solo no se rotula la cabecera. */
  lanes: ScheduleColumn[]
  /** Día que se muestra («2026-10-12»). */
  date: string
  timeZone: string
  /** Tramos reservables por recurso, tal como los devolvió el servicio. */
  free: ScheduleAvailability[]
  /** Horario de atención por recurso: decide la jornada visible y qué es «fuera de horario». */
  open?: ScheduleAvailability[]
  value: ScheduleRangeValue | null
  onChange: (value: ScheduleRangeValue) => void
  /** Duración que toma el bloque al tocar un hueco. */
  defaultMinutes: number
  now?: string
  /** Píxeles por hora. */
  hourHeight?: number
  snapMinutes?: number
  /**
   * Margen que se enseña antes y después de la atención del día. Queda en gris:
   * dice dónde acaba el horario y deja colocar ahí una cita fuera de él.
   */
  marginMinutes?: number
  /** Nombre accesible del selector. */
  label?: string
  className?: string
}

type DragMode = "move" | "start" | "end"

export function ScheduleRangePicker({
  lanes,
  date,
  timeZone,
  free,
  open,
  value,
  onChange,
  defaultMinutes,
  now,
  hourHeight = 44,
  snapMinutes = 15,
  marginMinutes = 60,
  label = "Horas del día",
  className,
}: ScheduleRangePickerProps) {
  const px = hourHeight / 60
  const laneRefs = React.useRef(new Map<string, HTMLDivElement>())
  const drag = React.useRef<{
    mode: DragMode
    originY: number
    start: number
    end: number
  } | null>(null)

  const today = now !== undefined && zonedDateOf(now, timeZone) === date
  const nowMinutes = now === undefined ? 0 : dayMinutesIn(now, timeZone)
  const chosen = value ? dayRangeOf(value.start, value.end, date, timeZone) : null

  const window = React.useMemo(() => {
    const hours = lanes.flatMap((lane) => rangesOf(open, lane.id, date, timeZone))
    const base = windowCovering(
      [...hours, ...lanes.flatMap((lane) => rangesOf(free, lane.id, date, timeZone))],
      SCHEDULE_DEFAULT_WINDOW,
    )
    // Sin atención ese día se enseña la jornada habitual, sin margen.
    const margin = hours.length > 0 ? marginMinutes : 0
    const first = Math.max(0, base.startMinutes - margin)
    const last = Math.min(1440, base.endMinutes + margin)
    // Hoy no hace falta enseñar las horas que ya pasaron.
    const start = today
      ? Math.min(Math.max(first, Math.floor(nowMinutes / 60) * 60), last - 60)
      : first
    return { startMinutes: start, endMinutes: last }
  }, [lanes, open, free, date, timeZone, today, nowMinutes, marginMinutes])

  const topOf = (minutes: number) => (minutes - window.startMinutes) * px
  const snap = (minutes: number) => Math.round(minutes / snapMinutes) * snapMinutes
  const emit = (columnId: string, start: number, end: number) => {
    const from = Math.max(window.startMinutes, Math.min(start, window.endMinutes - snapMinutes))
    const to = Math.min(window.endMinutes, Math.max(end, from + snapMinutes))
    onChange({
      columnId,
      start: minutesToInstant(date, from, timeZone),
      end: minutesToInstant(date, to, timeZone),
    })
  }

  const laneAt = (clientX: number): string | null => {
    for (const [id, node] of laneRefs.current) {
      const rect = node.getBoundingClientRect()
      if (clientX >= rect.left && clientX < rect.right) return id
    }
    return null
  }

  const startDrag = (mode: DragMode) => (event: React.PointerEvent<HTMLElement>) => {
    if (!chosen) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drag.current = {
      mode,
      originY: event.clientY,
      start: chosen.startMinutes,
      end: chosen.endMinutes,
    }
  }
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const session = drag.current
    if (!session || !value) return
    const delta = snap((event.clientY - session.originY) / px)
    if (session.mode === "move") {
      const length = session.end - session.start
      const start = Math.max(
        window.startMinutes,
        Math.min(session.start + delta, window.endMinutes - length),
      )
      emit(laneAt(event.clientX) ?? value.columnId, start, start + length)
    } else if (session.mode === "start") {
      emit(value.columnId, Math.min(session.start + delta, session.end - snapMinutes), session.end)
    } else {
      emit(value.columnId, session.start, Math.max(session.end + delta, session.start + snapMinutes))
    }
  }
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    drag.current = null
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!value || !chosen) return
    const length = chosen.endMinutes - chosen.startMinutes
    const index = lanes.findIndex((lane) => lane.id === value.columnId)
    const step = event.key === "ArrowDown" ? snapMinutes : event.key === "ArrowUp" ? -snapMinutes : 0
    if (step !== 0) {
      event.preventDefault()
      if (event.shiftKey) emit(value.columnId, chosen.startMinutes, chosen.endMinutes + step)
      else {
        const start = Math.max(
          window.startMinutes,
          Math.min(chosen.startMinutes + step, window.endMinutes - length),
        )
        emit(value.columnId, start, start + length)
      }
      return
    }
    const side = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0
    const next = lanes[index + side]
    if (side !== 0 && next) {
      event.preventDefault()
      emit(next.id, chosen.startMinutes, chosen.endMinutes)
    }
  }

  const hourMarks: number[] = []
  for (let minutes = window.startMinutes; minutes < window.endMinutes; minutes += 60) {
    hourMarks.push(minutes)
  }
  const bodyHeight = (window.endMinutes - window.startMinutes) * px
  const state = value ? scheduleRangeState(value, { free, open, timeZone }) : "free"
  const chosenLane = lanes.find((lane) => lane.id === value?.columnId)

  return (
    <section
      aria-label={label}
      className={cn("overflow-hidden rounded-2xl border bg-card", className)}
    >
      {lanes.length > 1 ? (
        <div className="flex border-b">
          <div className="shrink-0" style={{ width: GUTTER_PX }} aria-hidden />
          {lanes.map((lane) => (
            <div
              key={lane.id}
              title={lane.label}
              className="flex h-9 min-w-0 flex-1 basis-0 items-center justify-center border-l"
            >
              <ResourceAvatar label={lane.label} tone={lane.tone} size="sm" />
            </div>
          ))}
        </div>
      ) : null}

      <div className="relative flex bg-muted" style={{ height: bodyHeight }}>
        <div className="relative shrink-0 bg-card" style={{ width: GUTTER_PX }}>
          {hourMarks.map((minutes) => (
            <span
              key={minutes}
              className={cn(
                "absolute right-1.5 text-[11px] text-muted-foreground tabular-nums",
                minutes === window.startMinutes ? "pt-1" : "-translate-y-1/2",
              )}
              style={{ top: topOf(minutes) }}
            >
              {hourLabel(minutes)}
            </span>
          ))}
        </div>

        {lanes.map((lane) => {
          const whites = clipRanges(rangesOf(free, lane.id, date, timeZone), window)
          const mine = value?.columnId === lane.id ? chosen : null
          const visible = mine ? clipRanges([mine], window)[0] : null
          const blockHeight = visible
            ? Math.max((visible.endMinutes - visible.startMinutes) * px, 16)
            : 0
          // En un bloque corto las asas se quedan sin marca: lo que tiene que leerse es la hora.
          const compact = blockHeight < 40
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: tocar un hueco es el atajo de puntero; con teclado el bloque se mueve con las flechas.
            // biome-ignore lint/a11y/useSemanticElements: el carril es un grupo con posición propia; un fieldset trae maquetación que rompe la rejilla.
            <div
              key={lane.id}
              ref={(node) => {
                if (node) laneRefs.current.set(lane.id, node)
                else laneRefs.current.delete(lane.id)
              }}
              role="group"
              aria-label={lane.label}
              data-range-lane={lane.id}
              className="relative min-w-0 flex-1 basis-0 cursor-pointer border-l"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-range-block]")) return
                const rect = event.currentTarget.getBoundingClientRect()
                const pointed = window.startMinutes + (event.clientY - rect.top) / px
                const start = Math.floor(pointed / snapMinutes) * snapMinutes
                const room = whites.find(
                  (range) => range.startMinutes <= start && range.endMinutes > start,
                )
                // En un hueco más corto que la cita habitual, el bloque toma el hueco.
                const length = room
                  ? Math.max(snapMinutes, Math.min(defaultMinutes, room.endMinutes - start))
                  : defaultMinutes
                emit(lane.id, start, start + length)
              }}
            >
              {/* Lo que no se puede reservar va un punto más oscuro: lo blanco tiene que saltar a la vista. */}
              <div aria-hidden className="absolute inset-0 bg-muted-foreground/[0.08]" />
              {whites.map((range) => (
                <div
                  key={range.startMinutes}
                  data-range-free
                  className="absolute inset-x-0 bg-card"
                  style={{
                    top: topOf(range.startMinutes),
                    height: (range.endMinutes - range.startMinutes) * px,
                  }}
                />
              ))}
              {hourMarks.map((minutes) =>
                minutes === window.startMinutes ? null : (
                  <div
                    key={minutes}
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 border-t border-border/50"
                    style={{ top: topOf(minutes) }}
                  />
                ),
              )}
              {visible ? (
                <div
                  data-range-block
                  data-state={state}
                  className={cn(
                    "absolute inset-x-[3px] z-[2] flex touch-none flex-col rounded-[9px] select-none",
                    state === "free" && "bg-primary text-primary-foreground",
                    state === "outside" &&
                      "border-2 border-warning bg-warning-soft text-warning-foreground",
                    state === "taken" && "bg-destructive text-background",
                  )}
                  style={{
                    top: topOf(visible.startMinutes),
                    height: blockHeight,
                  }}
                >
                  <div
                    aria-hidden
                    className={cn(
                      "flex shrink-0 cursor-ns-resize items-center justify-center",
                      compact ? "h-1" : "h-2",
                    )}
                    onPointerDown={startDrag("start")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {compact ? null : (
                      <span className="h-[3px] w-5 rounded-full bg-current opacity-70" />
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={`De ${hourLabel(visible.startMinutes)} a ${hourLabel(visible.endMinutes)} con ${chosenLane?.label ?? lane.label}. Flechas para mover; Mayús con flechas para cambiar la duración`}
                    className="min-h-0 flex-1 cursor-grab overflow-hidden rounded-[6px] text-center text-xs leading-none font-bold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    onKeyDown={onKeyDown}
                    onPointerDown={startDrag("move")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {hourLabel(visible.startMinutes)}
                  </button>
                  <div
                    aria-hidden
                    className={cn(
                      "flex shrink-0 cursor-ns-resize items-center justify-center",
                      compact ? "h-1" : "h-2",
                    )}
                    onPointerDown={startDrag("end")}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    {compact ? null : (
                      <span className="h-[3px] w-5 rounded-full bg-current opacity-70" />
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}

        {today && nowMinutes >= window.startMinutes && nowMinutes <= window.endMinutes ? (
          <div
            aria-hidden
            className="pointer-events-none absolute right-0 z-[1] border-t-2 border-destructive"
            style={{ left: GUTTER_PX, top: topOf(nowMinutes) }}
          />
        ) : null}
      </div>
    </section>
  )
}
