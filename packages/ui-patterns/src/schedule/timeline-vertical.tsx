/**
 * Timeline vertical: la variante de teléfono. El tiempo corre hacia abajo en
 * scroll natural — al terminar el día sigue el siguiente, sin fin en ninguna
 * dirección — con un solo recurso a pantalla completa. Una sola cabecera
 * pegada arriba muestra siempre el día (y mes) bajo el pulgar: cambia al
 * cruzar la línea divisoria de medianoche. La línea roja cruza en la hora
 * viva y las sentinelas precargan dos días de colchón por lado, de modo que
 * el scroll nunca choca con el borde. Arrastrar una cita la mueve de hora o
 * de día; cambiar de recurso se hace con los chips de arriba.
 *
 * El lienzo es continuo (los días no llevan cabeceras en flujo) para que la
 * geometría del arrastre — minutos globales desde el primer día — sea pura.
 */

import { cn, Spinner } from "@odentia/ui"
import * as React from "react"

import { useAxisDrag } from "./axis-drag.js"
import { ScheduleBlock } from "./block.js"
import { SCHEDULE_DEFAULT_WINDOW } from "./types.js"
import { DragLiveRegion } from "./drag.js"
import { layoutOverlaps } from "./layout.js"
import { useMediaQuery } from "./media.js"
import { useInfiniteSentinel } from "./sentinel.js"
import type { ScheduleTimelineApi } from "./timeline.js"
import {
  dayMinutesIn,
  formatDateLong,
  formatDayMonthShort,
  hourLabel,
  timeRangeLabel,
  zonedDateOf,
} from "./time.js"
import type {
  ScheduleBlocked,
  ScheduleColumn,
  ScheduleEntry,
  ScheduleEntryHandler,
  ScheduleExtendHandler,
  ScheduleMoveHandler,
  ScheduleResizeHandler,
  ScheduleSlot,
  ScheduleWindow,
} from "./types.js"

/** Ancho del canal de horas a la izquierda. */
const GUTTER_PX = 48
/** Alto de la cabecera pegada (día y mes visibles siempre). */
const HEADER_PX = 37
/** Píxeles por hora en el eje vertical: 30 min quedan en 44px, tocables. */
const MOBILE_HOUR_HEIGHT = 88

export interface ScheduleTimelineVerticalProps {
  dates: string[]
  timeZone: string
  /** El recurso elegido en los chips; la única columna visible. */
  column: ScheduleColumn
  entries: ScheduleEntry[]
  blocked?: ScheduleBlocked[]
  slots?: ScheduleSlot[]
  window?: ScheduleWindow
  now?: string
  snapMinutes?: number
  onEntryClick?: ScheduleEntryHandler
  onEntryMove?: ScheduleMoveHandler
  onEntryResize?: ScheduleResizeHandler
  onSlotClick?: (slot: ScheduleSlot) => void
  onExtendDays?: ScheduleExtendHandler
  extending?: boolean
  apiRef?: React.RefObject<ScheduleTimelineApi | null>
  autoScrollToNow?: boolean
  /** El día bajo la cabecera pegada cambió (alimenta la franja semanal). */
  onVisibleDateChange?: (date: string) => void
  className?: string
}

export function ScheduleTimelineVertical({
  dates,
  timeZone,
  column,
  entries,
  blocked = [],
  slots = [],
  window = SCHEDULE_DEFAULT_WINDOW,
  now,
  snapMinutes = 15,
  onEntryClick,
  onEntryMove,
  onEntryResize,
  onSlotClick,
  onExtendDays,
  extending = false,
  apiRef,
  autoScrollToNow = true,
  onVisibleDateChange,
  className,
}: ScheduleTimelineVerticalProps) {
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const scrollContainer = React.useCallback(() => scrollRef.current, [])
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")

  const pxPerMinute = MOBILE_HOUR_HEIGHT / 60
  const span = window.endMinutes - window.startMinutes
  const dayHeight = span * pxPerMinute
  const totalHeight = dates.length * dayHeight

  const drag = useAxisDrag({
    timeZone,
    window,
    axis: "vertical",
    pxPerMinute,
    snap: snapMinutes,
    dateOf: () => dates[0],
    dates,
    moveColumnId: () => column.id,
    columnOrder: [column.id],
    describeColumn: () => column.label,
    onMove: onEntryMove,
    onResize: onEntryResize,
    scrollContainer,
  })

  // Colchón de dos días (vertical): la carga llega antes de tocar el borde.
  const prefetchMargin = `${Math.round(dayHeight * 2)}px 0px`
  const reachStart = useInfiniteSentinel(() => onExtendDays?.("start"), {
    disabled: !onExtendDays || extending || drag.session != null,
    rootMargin: prefetchMargin,
    root: scrollContainer,
  })
  const reachEnd = useInfiniteSentinel(() => onExtendDays?.("end"), {
    disabled: !onExtendDays || extending || drag.session != null,
    rootMargin: prefetchMargin,
    root: scrollContainer,
  })

  const hourMarks: number[] = []
  for (let minutes = window.startMinutes; minutes <= window.endMinutes; minutes += 60) {
    hourMarks.push(minutes)
  }

  const nowDate = now === undefined ? null : zonedDateOf(now, timeZone)
  const nowMinutes = now === undefined ? Number.NaN : dayMinutesIn(now, timeZone)

  // Día visible bajo la cabecera pegada: arranca en «hoy» (a donde salta el
  // auto-scroll) y luego solo cambia al cruzar medianoche.
  const [visibleDay, setVisibleDay] = React.useState<string>(nowDate ?? dates[0])

  React.useEffect(() => {
    const viewport = scrollContainer()
    if (!viewport) return
    const onScroll = () => {
      const index = Math.min(
        Math.max(Math.floor(viewport.scrollTop / dayHeight), 0),
        dates.length - 1,
      )
      setVisibleDay((current) => (dates[index] === current ? current : dates[index]))
    }
    // Sin llamada inicial: el estado ya arranca en «hoy» y el auto-scroll
    // emite su propio evento al aterrizar.
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [dates, dayHeight, scrollContainer])

  // La franja semanal sigue al día bajo la cabecera.
  React.useEffect(() => {
    onVisibleDateChange?.(visibleDay)
  }, [visibleDay, onVisibleDateChange])

  const scrollToDate = React.useCallback(
    (date: string, minutes?: number, behavior: ScrollBehavior = "smooth") => {
      const viewport = scrollContainer()
      const dayIndex = dates.indexOf(date)
      if (!viewport || dayIndex < 0 || typeof viewport.scrollTo !== "function") return
      const point =
        dayIndex * dayHeight +
        ((minutes ?? window.startMinutes) - window.startMinutes) * pxPerMinute
      // Un tercio desde arriba: contexto de lo que viene sin perder el ahora.
      const top =
        minutes === undefined ? dayIndex * dayHeight : point - viewport.clientHeight / 3 + HEADER_PX
      viewport.scrollTo({ top: Math.max(0, top), behavior: reducedMotion ? "auto" : behavior })
    },
    [dates, dayHeight, pxPerMinute, scrollContainer, window.startMinutes, reducedMotion],
  )
  const scrollToNow = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (nowDate === null) return
      scrollToDate(nowDate, nowMinutes, behavior)
    },
    [nowDate, nowMinutes, scrollToDate],
  )

  React.useImperativeHandle(apiRef, () => ({
    scrollToNow: () => scrollToNow(),
    scrollToDate: (date, minutes, behavior) => scrollToDate(date, minutes, behavior),
  }))

  // Posicionamiento inicial: la hora actual, con firma de métricas.
  const lastAutoScroll = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!autoScrollToNow || nowDate === null) return
    if (!dates.includes(nowDate)) return
    const signature = `${nowDate}:${Math.round(dayHeight)}`
    if (lastAutoScroll.current === signature) return
    lastAutoScroll.current = signature
    scrollToNow("auto")
  }, [autoScrollToNow, dates, nowDate, scrollToNow, dayHeight])

  // Anclaje al anteponer días: el contenido no salta bajo el viewport.
  const firstDateRef = React.useRef(dates[0])
  React.useLayoutEffect(() => {
    const previous = firstDateRef.current
    firstDateRef.current = dates[0]
    if (!previous || previous === dates[0]) return
    const shift = dates.indexOf(previous)
    const viewport = scrollContainer()
    if (viewport && shift > 0) viewport.scrollTop += shift * dayHeight
  }, [dates, dayHeight, scrollContainer])

  /** Minutos de ventana desde el primer día cargado (coordenada continua). */
  const globalTopOf = (startIso: string, endIso: string) => {
    const startDate = zonedDateOf(startIso, timeZone)
    const dayIndex = dates.indexOf(startDate)
    if (dayIndex < 0) return null
    const localStart = Math.min(
      Math.max(dayMinutesIn(startIso, timeZone), window.startMinutes),
      window.endMinutes,
    )
    let localEnd = Math.min(
      Math.max(dayMinutesIn(endIso, timeZone), window.startMinutes),
      window.endMinutes,
    )
    if (zonedDateOf(endIso, timeZone) !== startDate) localEnd = window.endMinutes
    if (localEnd <= localStart) return null
    return {
      top: (dayIndex * span + (localStart - window.startMinutes)) * pxPerMinute,
      height: (localEnd - localStart) * pxPerMinute,
    }
  }

  // Solapes por día: el reparto lado a lado es por jornada, nunca entre días.
  type VerticalItem = { entry: ScheduleEntry; top: number; height: number }
  const placementsByDay = new Map<number, VerticalItem[]>()
  const columnEntries = entries.filter((entry) => entry.columnId === column.id)
  const ranged = columnEntries
    .map((entry) => {
      const box = globalTopOf(entry.start, entry.end)
      return box ? { entry, top: box.top, height: box.height } : null
    })
    .filter((item) => item !== null)
  for (const item of ranged) {
    const dayIndex = Math.floor(item.top / (dayHeight || 1))
    const dayItems = placementsByDay.get(dayIndex) ?? []
    dayItems.push(item)
    placementsByDay.set(dayIndex, dayItems)
  }

  return (
    <div
      ref={scrollRef}
      className={cn(
        "relative h-[70svh] overflow-y-auto overscroll-contain [overflow-anchor:none]",
        className,
      )}
    >
      {/* Cabecera pegada: el día (y mes) bajo el pulgar, siempre. */}
      <div
        className="sticky top-0 z-20 flex h-9 items-center gap-1.5 border-b bg-background/95 px-2 text-sm font-medium backdrop-blur"
        style={{ marginBottom: -HEADER_PX }}
      >
        {formatDayMonthShort(visibleDay)}
        {visibleDay === nowDate ? (
          <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
            Hoy
          </span>
        ) : null}
        <span className="sr-only">{formatDateLong(visibleDay)}</span>
      </div>

      {onExtendDays ? (
        <>
          <div ref={reachStart} data-sentinel="start" className="absolute inset-x-0 top-0 h-px" />
          <div
            ref={reachEnd}
            data-sentinel="end"
            className="absolute inset-x-0 h-px"
            style={{ top: totalHeight }}
          />
        </>
      ) : null}
      {extending ? (
        <div className="sticky top-10 z-20 flex justify-center">
          <Spinner className="size-4" />
        </div>
      ) : null}

      {/* Lienzo continuo y único carril de arrastre. */}
      <div
        ref={(node) => drag.registerLane(column.id, node)}
        data-column={column.id}
        className="relative"
        style={{ height: totalHeight }}
      >
        {/* Retícula: horas y divisoria de medianoche, una capa para todo. */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {dates.map((day, dayIndex) => (
            <React.Fragment key={day}>
              {dayIndex > 0 ? (
                <div
                  className="absolute inset-x-0 border-t-2 border-border"
                  style={{ top: dayIndex * dayHeight }}
                />
              ) : null}
              {hourMarks.map((minutes) => (
                <div
                  key={minutes}
                  className="absolute right-0 border-t border-border/40"
                  style={{
                    left: GUTTER_PX,
                    top: dayIndex * dayHeight + (minutes - window.startMinutes) * pxPerMinute,
                  }}
                />
              ))}
            </React.Fragment>
          ))}
        </div>

        {/* Etiquetas de hora por día */}
        {dates.map((day, dayIndex) => (
          <React.Fragment key={day}>
            {hourMarks.map((minutes) => (
              <span
                key={minutes}
                className={cn(
                  "absolute left-1 text-[11px] tabular-nums text-muted-foreground",
                  minutes === window.startMinutes ? "pt-0.5" : "-translate-y-1/2",
                )}
                style={{
                  top: dayIndex * dayHeight + (minutes - window.startMinutes) * pxPerMinute,
                }}
              >
                {hourLabel(minutes)}
              </span>
            ))}
          </React.Fragment>
        ))}

        {blocked
          .filter((tramo) => tramo.columnId === column.id)
          .map((tramo) => {
            const box = globalTopOf(tramo.start, tramo.end)
            if (!box) return null
            return (
              <div
                key={tramo.id}
                data-blocked={tramo.id}
                role="img"
                aria-label={tramo.label ?? "No disponible"}
                className="absolute z-[1] bg-muted/50"
                style={{
                  left: GUTTER_PX,
                  right: 0,
                  top: box.top,
                  height: box.height,
                  backgroundImage:
                    "repeating-linear-gradient(45deg, var(--border) 0 1px, transparent 1px 7px)",
                }}
              />
            )
          })}

        {slots
          .filter((slot) => slot.columnId === column.id)
          .map((slot) => {
            const box = globalTopOf(slot.start, slot.end)
            if (!box) return null
            const style = {
              left: GUTTER_PX + 1,
              right: 1,
              top: box.top + 1,
              height: box.height - 2,
            }
            return onSlotClick ? (
              <button
                key={`${slot.columnId}-${slot.start}`}
                type="button"
                aria-label={`Hueco libre, ${timeRangeLabel(slot.start, slot.end, timeZone)}`}
                onClick={() => onSlotClick(slot)}
                className="absolute rounded-md border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/10"
                style={style}
              />
            ) : (
              <div
                key={`${slot.columnId}-${slot.start}`}
                aria-hidden
                className="absolute rounded-md border border-dashed border-primary/40 bg-primary/5"
                style={style}
              />
            )
          })}

        {[...placementsByDay.values()].map((items) => {
          const placements = layoutOverlaps(items, (item) => ({
            startMinutes: item.top / pxPerMinute,
            endMinutes: (item.top + item.height) / pxPerMinute,
          }))
          return placements.map((placement) => {
            const alto = Math.max(placement.item.height, 30)
            return (
              <ScheduleBlock
                key={placement.item.entry.id}
                entry={placement.item.entry}
                timeZone={timeZone}
                axis="vertical"
                sizePx={alto}
                draggable
                dragProps={drag.getBlockProps(placement.item.entry)}
                resizeProps={
                  drag.getResizeProps
                    ? {
                        start: drag.getResizeProps(placement.item.entry, "start"),
                        end: drag.getResizeProps(placement.item.entry, "end"),
                      }
                    : null
                }
                onOpen={onEntryClick}
                suppressClick={drag.suppressClick}
                style={{
                  top: placement.item.top + 2,
                  height: alto - 4,
                  left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${placement.lane / placement.lanes})`,
                  width: `calc((100% - ${GUTTER_PX}px) / ${placement.lanes} - 4px)`,
                }}
              />
            )
          })
        })}

        {drag.session && drag.session.target.columnId === column.id && drag.session.target.date ? (
          <div
            aria-hidden
            data-drag-preview
            className="pointer-events-none absolute z-10 rounded-md border-2 border-dashed border-primary bg-primary/10"
            style={{
              left: GUTTER_PX,
              right: 2,
              top:
                (dates.indexOf(drag.session.target.date) * span +
                  (drag.session.target.startMinutes - window.startMinutes)) *
                pxPerMinute,
              height: Math.max(
                (drag.session.target.endMinutes - drag.session.target.startMinutes) * pxPerMinute,
                30,
              ),
            }}
          />
        ) : null}

        {nowDate !== null &&
        dates.includes(nowDate) &&
        nowMinutes >= window.startMinutes &&
        nowMinutes <= window.endMinutes ? (
          <div
            data-now
            className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
            style={{
              top:
                (dates.indexOf(nowDate) * span + (nowMinutes - window.startMinutes)) * pxPerMinute,
            }}
          >
            <span className="absolute -top-2.5 left-1 rounded bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {hourLabel(nowMinutes)}
            </span>
          </div>
        ) : null}
      </div>
      <DragLiveRegion text={drag.announcement} />
    </div>
  )
}
