/**
 * Timeline: el tiempo en horizontal y los recursos como filas, con los días
 * concatenados en un eje continuo e infinito (las sentinelas de los bordes
 * cargan el día anterior o el siguiente; al anteponer, el contenido no salta
 * bajo el viewport). La cabecera de días y la regla de recursos quedan
 * pegadas; la línea de «ahora» marca la hora viva y `apiRef.scrollToNow()`
 * vuelve al día actual con la hora centrada. Las filas crecen cuando hay
 * solapes; el arrastre cambia hora, recurso o día. En teléfono, `focus`
 * delega en `ScheduleTimelineVertical`, con un recurso elegido mediante
 * chips; `team` conserva todas las filas con una regla compacta.
 */

import { Button, cn, ScrollArea, Spinner } from "@odentia/ui"
import { CalendarClock, TriangleAlert } from "lucide-react"
import * as React from "react"

import { useAxisDrag } from "./axis-drag.js"
import { ScheduleBlock } from "./block.js"
import { DragLiveRegion } from "./drag.js"
import { layoutOverlaps } from "./layout.js"
import { SCHEDULE_SMALL_QUERY, useMediaQuery } from "./media.js"
import { useInfiniteSentinel } from "./sentinel.js"
import {
  dayMinutesIn,
  formatDateLong,
  formatDayMonthShort,
  hourLabel,
  timeRangeLabel,
  zonedDateOf,
} from "./time.js"
import { ScheduleTimelineVertical } from "./timeline-vertical.js"
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
import { SCHEDULE_DEFAULT_WINDOW } from "./types.js"
import { ScheduleWeekStrip } from "./week-strip.js"

/** Lo mínimo que mide una subfila solapada: que el título se lea entero. */
const MIN_SUBLANE_PX = 44

export interface ScheduleTimelineApi {
  /** Vuelve al día actual con la hora actual centrada en el viewport. */
  scrollToNow: () => void
  /** Sin minutos alinea el inicio del día; con minutos centra esa hora. */
  scrollToDate: (date: string, minutes?: number, behavior?: ScrollBehavior) => void
}

export interface ScheduleTimelineProps {
  /** Días cargados, contiguos y ordenados. */
  dates: string[]
  timeZone: string
  /** Los recursos, uno por fila. */
  columns: ScheduleColumn[]
  entries: ScheduleEntry[]
  blocked?: ScheduleBlocked[]
  slots?: ScheduleSlot[]
  window?: ScheduleWindow
  /** Píxeles por hora del eje. */
  hourWidth?: number
  /** Alto mínimo de la fila; crece cuando hay solapes. */
  rowHeight?: number
  now?: string
  snapMinutes?: number
  onEntryClick?: ScheduleEntryHandler
  onEntryMove?: ScheduleMoveHandler
  onEntryResize?: ScheduleResizeHandler
  onSlotClick?: (slot: ScheduleSlot) => void
  /** Las sentinelas de los bordes piden el día anterior o el siguiente. */
  onExtendDays?: ScheduleExtendHandler
  extending?: boolean
  /** Recibe la API de scroll (volver a ahora, centrar un día). */
  apiRef?: React.RefObject<ScheduleTimelineApi | null>
  /** Al montar, centra la hora actual (sí por defecto cuando hay `now`). */
  autoScrollToNow?: boolean
  /** El día bajo el borde del viewport cambia: la barra superior lo rotula. */
  onVisibleDateChange?: (date: string) => void
  /** Equipo conserva todas las filas también en teléfono. */
  mobileLayout?: "focus" | "team"
  /** Solicita al consumidor una fecha aún no cargada en la franja. */
  onDateRequest?: (date: string) => void
  emptyLabel?: string
  className?: string
}

export function ScheduleTimeline({
  dates,
  timeZone,
  columns,
  entries,
  blocked = [],
  slots = [],
  window = SCHEDULE_DEFAULT_WINDOW,
  hourWidth = 110,
  rowHeight = 72,
  now,
  snapMinutes = 15,
  onEntryClick,
  onEntryMove,
  onEntryResize,
  onSlotClick,
  onExtendDays,
  extending = false,
  onVisibleDateChange,
  apiRef,
  mobileLayout = "focus",
  onDateRequest,
  autoScrollToNow = true,
  emptyLabel = "Sin recursos en la agenda",
  className,
}: ScheduleTimelineProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrollContainer = React.useCallback(
    // El viewport de ScrollArea envuelve al contenido: se busca hacia arriba.
    () => rootRef.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null,
    [],
  )

  // En teléfono la timeline se vuelve vertical (ScheduleTimelineVertical):
  // aquí solo vive la elección del recurso para la barra de chips y el día
  // visible para la franja semanal.
  const small = useMediaQuery(SCHEDULE_SMALL_QUERY)
  const focusMobile = small && mobileLayout === "focus"
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")
  const hasColumns = columns.length > 0
  const [chosenColumn, setChosenColumn] = React.useState<string | null>(null)
  const activeColumnId =
    focusMobile && columns.length > 0
      ? (columns.find((column) => column.id === chosenColumn)?.id ?? columns[0].id)
      : null
  const verticalApiRef = React.useRef<ScheduleTimelineApi>(null)
  const [visibleDate, setVisibleDate] = React.useState(() =>
    now === undefined ? dates[0] : zonedDateOf(now, timeZone),
  )
  // «Hoy» intersecta el viewport aunque sea un píxel: alimenta el botón flotante.
  const [todayVisible, setTodayVisible] = React.useState(true)

  const reportedDate = React.useRef<string | undefined>(undefined)
  const handleVisibleDate = React.useCallback(
    (day: string | undefined) => {
      if (!day || reportedDate.current === day) return
      reportedDate.current = day
      setVisibleDate(day)
      onVisibleDateChange?.(day)
    },
    [onVisibleDateChange],
  )

  const pxPerMinute = hourWidth / 60
  const span = window.endMinutes - window.startMinutes
  const dayWidth = span * pxPerMinute
  const totalWidth = dates.length * dayWidth

  const drag = useAxisDrag({
    timeZone,
    window,
    axis: "horizontal",
    pxPerMinute,
    snap: snapMinutes,
    dateOf: () => dates[0],
    dates,
    moveColumnId: (laneId) => laneId,
    columnOrder: columns.map((column) => column.id),
    describeColumn: (columnId) =>
      columns.find((column) => column.id === columnId)?.label ?? columnId,
    onMove: onEntryMove,
    onResize: onEntryResize,
    scrollContainer,
  })

  // Los días no cambian a mitad del arrastre: abortaría el gesto.
  // Margen de dos días: el vecino se carga con dos días de colchón, así la
  // rueda nunca choca con el límite mientras llega la carga (con un día se
  // alcanzaba el borde y el scroll parecía perderse). En estado estable la
  // sentinela deja de disparar cuando el colchón ya existe: no hay cascada.
  const prefetchMargin = `0px ${Math.round(dayWidth * 2)}px`
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

  /**
   * Posición en la coordenada continua (minutos de ventana desde el primer
   * día cargado). La cita que cruza medianoche se recorta a su día de inicio,
   * igual que en el carril vertical.
   */
  const globalRangeOf = React.useCallback(
    (startIso: string, endIso: string) => {
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
        startGlobal: dayIndex * span + (localStart - window.startMinutes),
        endGlobal: dayIndex * span + (localEnd - window.startMinutes),
      }
    },
    [dates, span, timeZone, window.startMinutes, window.endMinutes],
  )

  const hourMarks: number[] = []
  for (let minutes = window.startMinutes; minutes <= window.endMinutes; minutes += 60) {
    hourMarks.push(minutes)
  }

  const nowDate = now === undefined ? null : zonedDateOf(now, timeZone)
  const nowMinutes = now === undefined ? Number.NaN : dayMinutesIn(now, timeZone)

  /**
   * Scroll suave a prueba del router: Chrome cancela un scroll suave en curso
   * ante cualquier `history.replaceState`, y aquí cada cruce de día informa la
   * fecha al padre (que navega). Mientras dura el gesto el informe al padre
   * queda en pausa (`smoothScroll`) y se emite solo al asentarse.
   */
  const smoothScroll = React.useRef(false)
  const scrollToX = React.useCallback(
    (left: number, behavior: ScrollBehavior) => {
      const viewport = scrollContainer()
      if (!viewport || typeof viewport.scrollTo !== "function") return
      if (reducedMotion || behavior === "auto") {
        viewport.scrollTo({ left, behavior: "auto" })
        return
      }
      smoothScroll.current = true
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        globalThis.clearTimeout(timer)
        smoothScroll.current = false
        // Informe final con la posición ya aterrizada.
        viewport.dispatchEvent(new Event("scroll"))
      }
      // Colchón por si `scrollend` no existe: largo, un salto de 15 días
      // dura ~1 s; un fallback corto navegaría a mitad del gesto y Chrome
      // cancelaría el scroll antes de llegar.
      const timer = globalThis.setTimeout(finish, 2500)
      viewport.addEventListener("scrollend", finish, { once: true })
      // El usuario toma el volante: se libera igual.
      viewport.addEventListener("wheel", finish, { once: true, passive: true })
      viewport.addEventListener("pointerdown", finish, { once: true })
      viewport.scrollTo({ left, behavior: "smooth" })
    },
    [scrollContainer, reducedMotion],
  )
  const scrollToDate = React.useCallback(
    (date: string, minutes?: number, behavior: ScrollBehavior = "smooth") => {
      const viewport = scrollContainer()
      const root = rootRef.current
      const dayIndex = dates.indexOf(date)
      if (!viewport || !root || dayIndex < 0) return
      const point =
        dayIndex * dayWidth + ((minutes ?? window.startMinutes) - window.startMinutes) * pxPerMinute
      const gutter =
        Number.parseFloat(getComputedStyle(root).getPropertyValue("--schedule-gutter")) || 216
      const left = minutes === undefined ? point : point - (viewport.clientWidth - gutter) / 2
      scrollToX(Math.max(0, left), behavior)
    },
    [dates, dayWidth, pxPerMinute, scrollContainer, window.startMinutes, scrollToX],
  )
  const scrollToNow = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (nowDate === null) return
      scrollToDate(nowDate, nowMinutes, behavior)
    },
    [nowDate, nowMinutes, scrollToDate],
  )

  /** La franja en escritorio: el día elegido aterrice tras la regla de recursos. */
  const scrollToDayFlush = React.useCallback(
    (day: string) => {
      const dayIndex = dates.indexOf(day)
      if (dayIndex < 0) {
        onDateRequest?.(day)
        return
      }
      scrollToX(dayIndex * dayWidth, "smooth")
    },
    [dates, dayWidth, scrollToX, onDateRequest],
  )

  /**
   * Botón flotante «Volver a hoy»: aparece cuando el día bajo el viewport no
   * es el actual. Si hoy está cargado basta con desplazarse (el scroll ya
   * informa el día visible al padre); si no, se pide la fecha al padre.
   */
  const goToday = React.useCallback(() => {
    if (nowDate === null) return
    if (dates.includes(nowDate)) {
      if (focusMobile) verticalApiRef.current?.scrollToNow()
      else scrollToNow()
    } else {
      onDateRequest?.(nowDate)
    }
  }, [nowDate, dates, focusMobile, scrollToNow, onDateRequest])
  const todayButton =
    nowDate !== null && !todayVisible && (dates.includes(nowDate) || onDateRequest) ? (
      <Button
        type="button"
        size="sm"
        aria-label="Volver a hoy"
        onClick={goToday}
        className="absolute right-4 bottom-4 z-50 rounded-full shadow-md"
      >
        <CalendarClock aria-hidden className="size-4" />
        Hoy
      </Button>
    ) : null

  React.useImperativeHandle(apiRef, () => ({
    // En teléfono manda la timeline vertical; en escritorio, la horizontal.
    scrollToNow: () => (focusMobile ? verticalApiRef.current?.scrollToNow() : scrollToNow()),
    scrollToDate: (date, minutes, behavior) =>
      focusMobile
        ? verticalApiRef.current?.scrollToDate(date, minutes, behavior)
        : scrollToDate(date, minutes, behavior),
  }))

  // Centrar al montar o cambiar de superficie, nunca al cambiar el zoom.
  const lastAutoScroll = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (focusMobile || !hasColumns) {
      lastAutoScroll.current = null
      return
    }
    if (!autoScrollToNow || nowDate === null) return
    if (!dates.includes(nowDate)) return
    const signature = `${nowDate}:${focusMobile}`
    if (lastAutoScroll.current === signature) return
    lastAutoScroll.current = signature
    scrollToNow("auto")
  }, [autoScrollToNow, dates, nowDate, scrollToNow, focusMobile, hasColumns])

  const previousWidth = React.useRef(dayWidth)
  React.useLayoutEffect(() => {
    const viewport = scrollContainer()
    if (viewport && previousWidth.current !== dayWidth) {
      viewport.scrollLeft = (viewport.scrollLeft / previousWidth.current) * dayWidth
    }
    previousWidth.current = dayWidth
  }, [dayWidth, scrollContainer])

  // Anclaje al anteponer días: el contenido no salta bajo el viewport.
  const firstDateRef = React.useRef(dates[0])
  React.useLayoutEffect(() => {
    const previous = firstDateRef.current
    firstDateRef.current = dates[0]
    if (!previous || previous === dates[0]) return
    const shift = dates.indexOf(previous)
    const viewport = scrollContainer()
    if (viewport && shift > 0) viewport.scrollLeft += shift * dayWidth
  }, [dates, dayWidth, scrollContainer])

  // Con filas desbordadas, la rueda recorre recursos. Mayús+rueda recorre tiempo.
  // El gesto horizontal del trackpad conserva su comportamiento nativo.
  React.useEffect(() => {
    if (focusMobile || !hasColumns) return
    const viewport = scrollContainer()
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return // pellizco/zoom del navegador
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return // gesto horizontal
      if (!event.shiftKey && viewport.scrollHeight > viewport.clientHeight) return
      if (viewport.scrollWidth <= viewport.clientWidth) return
      event.preventDefault()
      const delta = event.deltaY * (event.deltaMode === 1 ? 33 : 1)
      viewport.scrollLeft = Math.min(
        Math.max(viewport.scrollLeft + delta, 0),
        viewport.scrollWidth - viewport.clientWidth,
      )
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [scrollContainer, focusMobile, hasColumns])

  // La regla tapa el margen inicial del contenido: el día visible es
  // scrollLeft/dayWidth (con tolerancia de aterrizaje), también en móvil.
  React.useEffect(() => {
    if (focusMobile || !hasColumns) return
    const viewport = scrollContainer()
    if (!viewport) return
    const onScroll = () => {
      // El aterrizaje puede quedar a píxeles del borde exacto (barras, ajustes
      // de layout): con tolerancia, casi-en-el-borde informa el día que se ve.
      const index = Math.min(
        dates.length - 1,
        Math.max(0, Math.floor((viewport.scrollLeft + 16) / dayWidth)),
      )
      if (smoothScroll.current) {
        // En pleno salto suave solo se refresca lo local (franja semanal);
        // informar al padre navegaría y Chrome cancelaría el gesto. El dedupe
        // (`reportedDate`) queda intacto para el informe final del aterrizaje.
        const day = dates[index]
        if (day) setVisibleDate(day)
      } else {
        handleVisibleDate(dates[index])
      }
      if (nowDate === null) return
      const idx = dates.indexOf(nowDate)
      if (idx < 0) {
        setTodayVisible(false)
        return
      }
      const gutter =
        Number.parseFloat(
          getComputedStyle(rootRef.current ?? viewport).getPropertyValue("--schedule-gutter"),
        ) || 216
      const dayStart = gutter + idx * dayWidth
      // «Hoy» visible = su franja asoma por el hueco útil (menos la regla fija).
      setTodayVisible(
        dayStart < viewport.scrollLeft + viewport.clientWidth &&
          dayStart + dayWidth > viewport.scrollLeft + gutter,
      )
    }
    onScroll()
    viewport.addEventListener("scroll", onScroll, { passive: true })
    return () => viewport.removeEventListener("scroll", onScroll)
  }, [focusMobile, dates, dayWidth, scrollContainer, handleVisibleDate, hasColumns, nowDate])

  if (columns.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-40 items-center justify-center rounded-xl border bg-background p-6 text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyLabel}
      </div>
    )
  }

  const resourceBar = (
    <fieldset
      aria-label="Recurso de la agenda"
      className="flex shrink-0 gap-1.5 overflow-x-auto border-b bg-background p-2"
    >
      {columns.map((column) => {
        const active = column.id === activeColumnId
        return (
          <button
            key={column.id}
            type="button"
            aria-pressed={active}
            title={column.warning}
            onClick={() => setChosenColumn(column.id)}
            className={cn(
              "h-9 shrink-0 rounded-full px-3.5 text-sm font-medium transition-colors",
              active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {column.label}
            {column.warning && (
              <TriangleAlert aria-label={column.warning} className="ml-1 inline size-3.5" />
            )}
          </button>
        )
      })}
    </fieldset>
  )

  // Teléfono: tiempo vertical infinito, un recurso por pantalla, franja semanal.
  if (focusMobile && activeColumnId !== null) {
    const activeColumn = columns.find((column) => column.id === activeColumnId) ?? columns[0]
    return (
      <div
        className={cn("relative flex flex-col overflow-hidden rounded-xl border bg-background", className)}
      >
        {resourceBar}
        <div className="shrink-0">
          <ScheduleWeekStrip
            date={visibleDate}
            entries={entries}
            timeZone={timeZone}
            nowDate={nowDate ?? undefined}
            onSelect={(day) =>
              dates.includes(day) ? verticalApiRef.current?.scrollToDate(day) : onDateRequest?.(day)
            }
          />
        </div>
        {activeColumn.warning && (
          <p className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            {activeColumn.warning}
          </p>
        )}
        <ScheduleTimelineVertical
          className="h-auto min-h-0 flex-1"
          dates={dates}
          timeZone={timeZone}
          column={activeColumn}
          entries={entries}
          blocked={blocked}
          slots={slots}
          window={window}
          now={now}
          snapMinutes={snapMinutes}
          onEntryClick={onEntryClick}
          onEntryMove={onEntryMove}
          onEntryResize={onEntryResize}
          onSlotClick={onSlotClick}
          onExtendDays={onExtendDays}
          extending={extending}
          apiRef={verticalApiRef}
          onVisibleDateChange={handleVisibleDate}
          onTodayVisibleChange={setTodayVisible}
          autoScrollToNow={autoScrollToNow}
        />
        {todayButton}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-xl border bg-background [--schedule-gutter:216px]",
        mobileLayout === "team" && "max-sm:[--schedule-gutter:152px]",
        className,
      )}
    >
      <div className="shrink-0">
        <ScheduleWeekStrip
          date={visibleDate}
          entries={entries}
          timeZone={timeZone}
          nowDate={nowDate ?? undefined}
          onSelect={scrollToDayFlush}
        />
      </div>
      <ScrollArea
        horizontal
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:[overflow-anchor:none]"
      >
        <div ref={rootRef} className="w-fit">
          <div className="sticky top-0 z-40 flex bg-background">
            <div className="sticky left-0 z-30 w-[var(--schedule-gutter)] shrink-0 border-r border-b bg-background" />
            {dates.map((day) => (
              <div
                key={day}
                data-day-header={day}
                className="shrink-0 border-l border-b"
                style={{ width: dayWidth }}
              >
                {/*
                 * La etiqueta del día (con su mes) es sticky dentro de su propia
                 * celda: mientras sigas dentro del día sigue pegada al borde de
                 * la regla de recursos; solo la empuja el día siguiente.
                 */}
                <div className="sticky left-[var(--schedule-gutter)] z-10 flex w-fit items-center gap-1.5 rounded-r-md bg-background/95 px-2 py-1 text-xs font-medium">
                  {formatDayMonthShort(day)}
                  {day === nowDate ? (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
                      Hoy
                    </span>
                  ) : null}
                  <span className="sr-only">{formatDateLong(day)}</span>
                </div>
                <div className="relative h-6">
                  {hourMarks.map((minutes) => (
                    <span
                      key={minutes}
                      className={cn(
                        "absolute top-1 text-[11px] tabular-nums text-muted-foreground",
                        // Los bordes miran hacia adentro: nunca cortados ni invaden el día vecino.
                        minutes === window.startMinutes
                          ? "translate-x-0 pl-1"
                          : minutes >= window.endMinutes
                            ? "-translate-x-full pr-1"
                            : "-translate-x-1/2",
                      )}
                      style={{ left: (minutes - window.startMinutes) * pxPerMinute }}
                    >
                      {hourLabel(minutes)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="relative">
            {onExtendDays ? (
              <>
                <div
                  ref={reachStart}
                  data-sentinel="start"
                  className="absolute inset-y-0 left-[var(--schedule-gutter)] w-px"
                />
                <div
                  ref={reachEnd}
                  data-sentinel="end"
                  className="absolute inset-y-0 w-px"
                  style={{ left: `calc(var(--schedule-gutter) + ${totalWidth}px)` }}
                />
              </>
            ) : null}
            {extending ? (
              <div className="absolute top-1 left-1/2 z-10">
                <Spinner className="size-4" />
              </div>
            ) : null}

            {/* Retícula de fondo: una sola capa para todas las filas. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-[var(--schedule-gutter)]"
              style={{ width: totalWidth }}
            >
              {dates.map((day, dayIndex) => (
                <React.Fragment key={day}>
                  {dayIndex > 0 ? (
                    <div
                      className="absolute inset-y-0 border-l-2 border-border"
                      style={{ left: dayIndex * dayWidth }}
                    />
                  ) : null}
                  {hourMarks.map((minutes) => (
                    <div
                      key={minutes}
                      className="absolute inset-y-0 border-l border-border/40"
                      style={{
                        left: dayIndex * dayWidth + (minutes - window.startMinutes) * pxPerMinute,
                      }}
                    />
                  ))}
                </React.Fragment>
              ))}
            </div>

            {columns.map((column) => {
              const rowRanges = entries
                .filter((entry) => entry.columnId === column.id)
                .map((entry) => ({ entry, range: globalRangeOf(entry.start, entry.end) }))
                .filter(
                  (
                    item,
                  ): item is {
                    entry: ScheduleEntry
                    range: { startGlobal: number; endGlobal: number }
                  } => item.range !== null,
                )
              const placements = layoutOverlaps(rowRanges, (item) => ({
                startMinutes: item.range.startGlobal,
                endMinutes: item.range.endGlobal,
              }))
              const maxLanes = placements.reduce(
                (max, placement) => Math.max(max, placement.lanes),
                1,
              )
              const minLanePx = rowRanges.some(({ entry }) => entry.resourceLabel || entry.warning)
                ? 68
                : MIN_SUBLANE_PX
              const rowPx = Math.max(rowHeight, maxLanes * minLanePx)
              const preview =
                drag.session && drag.session.target.columnId === column.id
                  ? drag.session.target
                  : null

              return (
                <div
                  key={column.id}
                  className="flex border-b last:border-b-0 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
                >
                  <div
                    className="sticky left-0 z-20 flex w-[var(--schedule-gutter)] shrink-0 flex-col justify-center border-r bg-background px-3 py-2"
                    style={{ minHeight: rowPx }}
                  >
                    <span className="text-sm font-medium break-words">{column.label}</span>
                    {column.detail ? (
                      <span className="text-xs text-muted-foreground break-words">
                        {column.detail}
                      </span>
                    ) : null}
                    {column.warning && (
                      <span
                        className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"
                        title={column.warning}
                      >
                        <TriangleAlert aria-hidden className="mt-0.5 size-3 shrink-0" />
                        <span>{column.warning}</span>
                      </span>
                    )}
                  </div>

                  <div
                    ref={(node) => drag.registerLane(column.id, node)}
                    data-column={column.id}
                    className="relative"
                    style={{ width: totalWidth, height: rowPx }}
                  >
                    {blocked
                      .filter((tramo) => tramo.columnId === column.id)
                      .map((tramo) => {
                        const range = globalRangeOf(tramo.start, tramo.end)
                        if (!range) return null
                        return (
                          <div
                            key={tramo.id}
                            data-blocked={tramo.id}
                            role="img"
                            aria-label={tramo.label ?? "No disponible"}
                            className="absolute inset-y-0 z-[1] bg-muted/50"
                            style={{
                              left: range.startGlobal * pxPerMinute,
                              width: (range.endGlobal - range.startGlobal) * pxPerMinute,
                              backgroundImage:
                                "repeating-linear-gradient(45deg, var(--border) 0 1px, transparent 1px 7px)",
                            }}
                          />
                        )
                      })}

                    {slots
                      .filter((slot) => slot.columnId === column.id)
                      .map((slot) => {
                        const range = globalRangeOf(slot.start, slot.end)
                        if (!range) return null
                        const box = {
                          left: range.startGlobal * pxPerMinute + 1,
                          width: (range.endGlobal - range.startGlobal) * pxPerMinute - 2,
                        }
                        return onSlotClick ? (
                          <button
                            key={`${slot.columnId}-${slot.start}`}
                            type="button"
                            aria-label={`Hueco libre, ${timeRangeLabel(slot.start, slot.end, timeZone)}`}
                            onClick={() => onSlotClick(slot)}
                            className="absolute inset-y-1 rounded-md border border-dashed border-primary/50 bg-primary/5 hover:bg-primary/10"
                            style={box}
                          />
                        ) : (
                          <div
                            key={`${slot.columnId}-${slot.start}`}
                            aria-hidden
                            className="absolute inset-y-1 rounded-md border border-dashed border-primary/40 bg-primary/5"
                            style={box}
                          />
                        )
                      })}

                    {placements.map((placement) => {
                      const ancho = Math.max(
                        (placement.endMinutes - placement.startMinutes) * pxPerMinute,
                        24,
                      )
                      const subPx = rowPx / placement.lanes
                      return (
                        <ScheduleBlock
                          key={placement.item.entry.id}
                          entry={placement.item.entry}
                          timeZone={timeZone}
                          axis="horizontal"
                          sizePx={ancho}
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
                            left: placement.startMinutes * pxPerMinute + 2,
                            width: ancho - 4,
                            top: placement.lane * subPx + 2,
                            height: subPx - 4,
                          }}
                        />
                      )
                    })}

                    {preview?.date != null && dates.includes(preview.date) ? (
                      <div
                        aria-hidden
                        data-drag-preview
                        className="pointer-events-none absolute inset-y-1 z-10 rounded-md border-2 border-dashed border-primary bg-primary/10"
                        style={{
                          left:
                            (dates.indexOf(preview.date) * span +
                              (preview.startMinutes - window.startMinutes)) *
                            pxPerMinute,
                          width: Math.max(
                            (preview.endMinutes - preview.startMinutes) * pxPerMinute,
                            24,
                          ),
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}

            {nowDate !== null &&
            dates.includes(nowDate) &&
            nowMinutes >= window.startMinutes &&
            nowMinutes <= window.endMinutes ? (
              <div
                data-now
                className="pointer-events-none absolute inset-y-0 z-10 border-l-2 border-destructive"
                style={{
                  left: `calc(var(--schedule-gutter) + ${(dates.indexOf(nowDate) * span + (nowMinutes - window.startMinutes)) * pxPerMinute}px)`,
                }}
              >
                <span className="absolute top-0 -left-1 rounded bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                  {hourLabel(nowMinutes)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <DragLiveRegion text={drag.announcement} />
      </ScrollArea>
      {todayButton}
    </div>
  )
}
