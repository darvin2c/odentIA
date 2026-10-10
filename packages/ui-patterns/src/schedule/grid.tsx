/**
 * Rejilla de la agenda: el tiempo corre hacia abajo y cada carril es un
 * recurso en un día. Con varios recursos del mismo día es la vista Día; con
 * un recurso y varios días, la vista Semana; con un solo carril, el teléfono.
 *
 * Blanco es lo que se puede reservar y gris lo que no (fuera de horario o ya
 * pasado); un bloqueo va rayado porque es la excepción dentro del horario. Lo
 * libre se toca: el cursor anticipa «Reservar a las 11:00» y el clic avisa al
 * consumidor. La rejilla nunca decide si el hueco es válido: eso lo confirma
 * el servicio al reservar. El arrastre mueve la cita de hora, de recurso o de
 * día, con el teclado como vía completa (Alt+Intro).
 */

import { cn, ScrollArea } from "@odentia/ui"
import { Plus, TriangleAlert } from "lucide-react"
import * as React from "react"

import { useAxisDrag } from "./axis-drag.js"
import { ScheduleCard } from "./card.js"
import { DragLiveRegion } from "./drag.js"
import { layoutOverlaps } from "./layout.js"
import {
  clipRanges,
  dayRangeOf,
  isCovered,
  type MinuteRange,
  overlapsAny,
  subtractRanges,
  windowCovering,
} from "./occupancy.js"
import { dayMinutesIn, hourLabel, minutesToInstant, zonedDateOf } from "./time.js"
import { ResourceAvatar } from "./tone.js"
import type {
  ScheduleAvailability,
  ScheduleBlocked,
  ScheduleCreateTarget,
  ScheduleEntry,
  ScheduleEntryHandler,
  ScheduleLane,
  ScheduleMoveHandler,
  SchedulePreview,
  ScheduleResizeHandler,
  ScheduleWindow,
} from "./types.js"
import { SCHEDULE_DEFAULT_WINDOW } from "./types.js"

/** Ancho del canal de horas. */
const GUTTER_PX = 60
/** Por debajo de este alto un tramo apagado no lleva rótulo. */
const LABEL_MIN_PX = 28

export interface ScheduleGridProps {
  /** Carriles en orden visual. */
  lanes: ScheduleLane[]
  timeZone: string
  entries: ScheduleEntry[]
  /**
   * Tramos de atención por recurso. Con ellos, lo que queda fuera se apaga;
   * sin la prop (undefined) la rejilla no afirma nada sobre el horario.
   */
  availability?: ScheduleAvailability[]
  blocked?: ScheduleBlocked[]
  /** Jornada visible; por defecto cubre la atención y las citas de los carriles. */
  window?: ScheduleWindow
  /** Píxeles por hora. */
  hourHeight?: number
  /** Ancho mínimo de un carril: con muchos recursos la rejilla se desplaza. */
  minLaneWidth?: number
  now?: string
  snapMinutes?: number
  /** Duración que se propone al tocar un hueco libre. */
  createMinutes?: number
  /** Cita con el detalle abierto. */
  selectedEntryId?: string
  /** Cita por reservar que el formulario propone. */
  preview?: SchedulePreview | null
  onEntryClick?: ScheduleEntryHandler
  onEntryMove?: ScheduleMoveHandler
  onEntryResize?: ScheduleResizeHandler
  /** Clic en un hueco libre. Sin él la rejilla no ofrece reservar. */
  onCreate?: (target: ScheduleCreateTarget) => void
  /**
   * Sin cabecera de carriles: con un solo carril cuyo recurso ya se nombra
   * fuera (las fichas del teléfono), repetirlo solo quita sitio a la agenda.
   */
  hideHeader?: boolean
  /** Nombre accesible de la región («Agenda del lunes 21 de setiembre»). */
  label?: string
  emptyLabel?: string
  className?: string
}

interface LaneBlock extends MinuteRange {
  id: string
  label?: string
}

interface LaneItem {
  entry: ScheduleEntry
  range: MinuteRange
}

interface LaneModel {
  lane: ScheduleLane
  /** Tramos de atención del día; null si no se conoce el horario. */
  open: MinuteRange[] | null
  closed: MinuteRange[]
  blocks: LaneBlock[]
  items: LaneItem[]
  /** Atención que ya pasó: se apaga igual que lo cerrado, pero conserva las líneas de hora. */
  past: MinuteRange[]
  /** Dónde se puede proponer una reserva nueva. */
  free: MinuteRange[]
}

/** Estados que ocupan al recurso; lo cancelado o no asistido deja el sitio libre. */
function occupies(entry: ScheduleEntry): boolean {
  return entry.status !== "cancelada" && entry.status !== "no_asistio"
}

export function ScheduleGrid({
  lanes,
  timeZone,
  entries,
  availability,
  blocked = [],
  window: windowProp,
  hourHeight = 72,
  minLaneWidth = 168,
  now,
  snapMinutes = 15,
  createMinutes = 30,
  selectedEntryId,
  preview,
  onEntryClick,
  onEntryMove,
  onEntryResize,
  onCreate,
  hideHeader = false,
  label = "Agenda",
  emptyLabel = "No hay a quién mostrar en la agenda",
  className,
}: ScheduleGridProps) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const scrollContainer = React.useCallback(
    () => rootRef.current?.closest<HTMLElement>("[data-slot=scroll-area-viewport]") ?? null,
    [],
  )

  const nowDate = now === undefined ? null : zonedDateOf(now, timeZone)
  const nowMinutes = now === undefined ? Number.NaN : dayMinutesIn(now, timeZone)

  // Rangos del día de cada carril, antes de conocer la ventana.
  const raw = React.useMemo(
    () =>
      lanes.map((lane) => ({
        lane,
        open:
          availability === undefined
            ? null
            : availability
                .filter((item) => item.columnId === lane.columnId)
                .flatMap((item): MinuteRange[] => {
                  const range = dayRangeOf(item.start, item.end, lane.date, timeZone)
                  return range ? [range] : []
                }),
        blocks: blocked
          .filter((item) => item.columnId === lane.columnId)
          .flatMap((item): LaneBlock[] => {
            const range = dayRangeOf(item.start, item.end, lane.date, timeZone)
            return range ? [{ ...range, id: item.id, label: item.label }] : []
          }),
        items: entries
          .filter((entry) => entry.columnId === lane.columnId)
          .flatMap((entry): LaneItem[] => {
            const range = dayRangeOf(entry.start, entry.end, lane.date, timeZone)
            return range ? [{ entry, range }] : []
          }),
      })),
    [lanes, availability, blocked, entries, timeZone],
  )

  const window = React.useMemo(
    () =>
      windowProp ??
      windowCovering(
        raw.flatMap((item) => [...(item.open ?? []), ...item.items.map((entry) => entry.range)]),
        SCHEDULE_DEFAULT_WINDOW,
      ),
    [windowProp, raw],
  )

  const models = React.useMemo<LaneModel[]>(() => {
    const whole = [{ startMinutes: window.startMinutes, endMinutes: window.endMinutes }]
    return raw.map((item) => {
      const open = item.open === null ? null : clipRanges(item.open, window)
      const bookable = subtractRanges(open ?? whole, item.blocks)
      const busy = item.items.filter(({ entry }) => occupies(entry)).map(({ range }) => range)
      const past =
        item.lane.date === nowDate
          ? [{ startMinutes: window.startMinutes, endMinutes: nowMinutes }]
          : nowDate !== null && item.lane.date < nowDate
            ? whole
            : []
      return {
        lane: item.lane,
        open,
        closed: open === null ? [] : subtractRanges(whole, open),
        blocks: item.blocks,
        items: item.items,
        past: past.flatMap((range) => clipRanges(open ?? whole, range)),
        free: subtractRanges(bookable, [...busy, ...past]),
      }
    })
  }, [raw, window, nowDate, nowMinutes])

  const pxPerMinute = hourHeight / 60
  const span = window.endMinutes - window.startMinutes
  const bodyHeight = span * pxPerMinute
  const topOf = (minutes: number) => (minutes - window.startMinutes) * pxPerMinute

  const laneById = React.useMemo(() => new Map(lanes.map((lane) => [lane.id, lane])), [lanes])

  const drag = useAxisDrag({
    timeZone,
    window,
    axis: "vertical",
    pxPerMinute,
    snap: snapMinutes,
    dateOf: (laneId) => laneById.get(laneId)?.date ?? lanes[0]?.date ?? "",
    moveColumnId: (laneId, entry) => laneById.get(laneId)?.columnId ?? entry.columnId,
    columnOrder: lanes.map((lane) => lane.id),
    describeColumn: (laneId) => laneById.get(laneId)?.label ?? laneId,
    onMove: onEntryMove,
    onResize: onEntryResize,
    scrollContainer,
  })

  // Hueco bajo el cursor: solo anticipa; el clic lo propone al consumidor.
  const [hint, setHint] = React.useState<(MinuteRange & { laneId: string }) | null>(null)
  const candidateAt = (model: LaneModel, clientY: number, rect: DOMRect): MinuteRange | null => {
    const pointed = window.startMinutes + (clientY - rect.top) / pxPerMinute
    const start = Math.floor(pointed / snapMinutes) * snapMinutes
    const room = model.free.find((range) => range.startMinutes <= start && range.endMinutes > start)
    if (!room) return null
    const end = Math.min(start + createMinutes, room.endMinutes)
    return end - start >= snapMinutes ? { startMinutes: start, endMinutes: end } : null
  }
  const creating = onCreate != null && drag.session == null

  // Al abrir o cambiar de día: la hora actual a un tercio del alto; otro día,
  // el comienzo de la atención. Nunca al llegar datos nuevos del mismo día.
  const laneSignature = lanes.map((lane) => `${lane.id}:${lane.date}`).join("|")
  const lastScroll = React.useRef<string | null>(null)
  React.useLayoutEffect(() => {
    const viewport = scrollContainer()
    if (!viewport || lanes.length === 0) return
    const signature = `${laneSignature}:${hourHeight}`
    if (lastScroll.current === signature) return
    lastScroll.current = signature
    const today = nowDate !== null && lanes.some((lane) => lane.date === nowDate)
    const firstOpen = Math.min(
      ...models.flatMap((model) => (model.open ?? []).map((range) => range.startMinutes)),
      ...models.flatMap((model) => model.items.map((item) => item.range.startMinutes)),
      window.endMinutes,
    )
    const anchor =
      today && nowMinutes >= window.startMinutes && nowMinutes <= window.endMinutes
        ? (nowMinutes - window.startMinutes) * pxPerMinute - viewport.clientHeight / 3
        : (firstOpen - window.startMinutes) * pxPerMinute - 16
    viewport.scrollTop = Math.max(0, anchor)
  }, [
    laneSignature,
    hourHeight,
    lanes,
    models,
    nowDate,
    nowMinutes,
    pxPerMinute,
    scrollContainer,
    window,
  ])

  if (lanes.length === 0) {
    return (
      <div
        className={cn(
          "flex min-h-40 items-center justify-center rounded-2xl border bg-card p-6 text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyLabel}
      </div>
    )
  }

  const hourMarks: number[] = []
  for (let minutes = window.startMinutes; minutes < window.endMinutes; minutes += 60) {
    hourMarks.push(minutes)
  }

  const nowInWindow =
    nowDate !== null && nowMinutes >= window.startMinutes && nowMinutes <= window.endMinutes
  const allToday = nowInWindow && lanes.every((lane) => lane.date === nowDate)
  const someToday = nowInWindow && lanes.some((lane) => lane.date === nowDate)

  return (
    <section
      aria-label={label}
      className={cn(
        "elevated flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card",
        className,
      )}
    >
      <ScrollArea horizontal className="min-h-0 flex-1">
        {/* El ancho mínimo lo fija la cuenta de carriles, no el texto de las cabeceras. */}
        <div
          ref={rootRef}
          className="w-full"
          style={{ minWidth: GUTTER_PX + lanes.length * minLaneWidth }}
        >
          <div className={cn("sticky top-0 z-30 flex border-b bg-card", hideHeader && "hidden")}>
            <div
              className="sticky left-0 z-10 shrink-0 bg-card"
              style={{ width: GUTTER_PX }}
              aria-hidden
            />
            {lanes.map((lane) => (
              <div
                key={lane.id}
                data-lane-header={lane.id}
                className="flex min-w-0 flex-1 basis-0 items-center gap-2.5 border-l px-3 py-2.5"
              >
                {lane.kind === "day" ? null : <ResourceAvatar label={lane.label} tone={lane.tone} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{lane.label}</span>
                    {lane.kind === "day" && lane.date === nowDate ? (
                      <span className="shrink-0 rounded-full bg-primary px-2 text-[11px] leading-[18px] font-bold text-primary-foreground">
                        Hoy
                      </span>
                    ) : null}
                    {lane.warning ? (
                      <TriangleAlert
                        role="img"
                        aria-label={lane.warning}
                        className="size-3.5 shrink-0 text-warning"
                      />
                    ) : null}
                  </div>
                  {lane.detail ? (
                    <div className="truncate text-xs text-muted-foreground">{lane.detail}</div>
                  ) : null}
                  {lane.summary ? (
                    <div className="truncate text-xs font-semibold text-primary-soft-foreground">
                      {lane.summary}
                    </div>
                  ) : null}
                  {lane.action ? (
                    <button
                      type="button"
                      data-lane-action
                      onClick={lane.action.onSelect}
                      className="mt-1 flex h-7 max-w-full items-center gap-1 rounded-full bg-primary-soft pr-3 pl-2 text-[13px] font-bold text-primary-soft-foreground outline-none hover:bg-primary-soft/70 focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Plus aria-hidden className="size-3.5 shrink-0" strokeWidth={3} />
                      <span className="truncate">{lane.action.label}</span>
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div className="relative flex" style={{ height: bodyHeight }}>
            {/* Líneas de hora: una capa bajo todos los carriles. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0"
              style={{ left: GUTTER_PX }}
            >
              {hourMarks.map((minutes) =>
                minutes === window.startMinutes ? null : (
                  <div
                    key={minutes}
                    className="absolute inset-x-0 border-t border-border/60"
                    style={{ top: topOf(minutes) }}
                  />
                ),
              )}
            </div>

            <div className="sticky left-0 z-20 shrink-0 bg-card" style={{ width: GUTTER_PX }}>
              {hourMarks.map((minutes) => (
                <span
                  key={minutes}
                  className={cn(
                    "absolute right-2.5 text-xs text-muted-foreground tabular-nums",
                    minutes === window.startMinutes ? "pt-1" : "-translate-y-1/2",
                  )}
                  style={{ top: topOf(minutes) }}
                >
                  {hourLabel(minutes)}
                </span>
              ))}
              {someToday ? (
                <span
                  data-now-label
                  className="absolute right-1.5 z-10 -translate-y-1/2 rounded-full bg-destructive px-1.5 text-xs leading-[18px] font-bold text-background tabular-nums"
                  style={{ top: topOf(nowMinutes) }}
                >
                  {hourLabel(nowMinutes)}
                </span>
              ) : null}
            </div>

            {models.map((model) => {
              const { lane } = model
              const placements = layoutOverlaps(model.items, (item) => item.range)
              const target =
                drag.session && drag.session.target.columnId === lane.id
                  ? drag.session.target
                  : null
              const targetFits =
                target === null ||
                ((model.open === null || isCovered(target, model.open)) &&
                  !overlapsAny(target, model.blocks))
              const laneHint = creating && hint?.laneId === lane.id ? hint : null
              const lanePreview =
                preview && preview.columnId === lane.columnId
                  ? dayRangeOf(preview.start, preview.end, lane.date, timeZone)
                  : null
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: reservar desde un hueco es un atajo de puntero; la vía de teclado es el botón «Nueva cita» de la página.
                // biome-ignore lint/a11y/useSemanticElements: el carril es un grupo con posición propia; un fieldset trae maquetación que rompe la rejilla.
                <div
                  key={lane.id}
                  ref={(node) => drag.registerLane(lane.id, node)}
                  data-lane={lane.id}
                  role="group"
                  aria-label={lane.label}
                  className={cn("relative min-w-0 flex-1 basis-0 border-l", creating && "cursor-cell")}
                  onMouseMove={
                    creating
                      ? (event) => {
                          const candidate = candidateAt(
                            model,
                            event.clientY,
                            event.currentTarget.getBoundingClientRect(),
                          )
                          setHint((current) =>
                            candidate === null
                              ? null
                              : current?.laneId === lane.id &&
                                  current.startMinutes === candidate.startMinutes &&
                                  current.endMinutes === candidate.endMinutes
                                ? current
                                : { ...candidate, laneId: lane.id },
                          )
                        }
                      : undefined
                  }
                  onMouseLeave={creating ? () => setHint(null) : undefined}
                  onClick={
                    creating
                      ? (event) => {
                          if ((event.target as HTMLElement).closest("[data-entry]")) return
                          const candidate = candidateAt(
                            model,
                            event.clientY,
                            event.currentTarget.getBoundingClientRect(),
                          )
                          if (!candidate) return
                          setHint(null)
                          onCreate?.({
                            columnId: lane.columnId,
                            date: lane.date,
                            start: minutesToInstant(lane.date, candidate.startMinutes, timeZone),
                            end: minutesToInstant(lane.date, candidate.endMinutes, timeZone),
                          })
                        }
                      : undefined
                  }
                >
                  {model.closed.map((range) => {
                    const height = (range.endMinutes - range.startMinutes) * pxPerMinute
                    return (
                      <div
                        key={`closed-${range.startMinutes}`}
                        data-closed
                        className="absolute inset-x-0 bg-muted"
                        style={{ top: topOf(range.startMinutes), height }}
                      >
                        {height >= LABEL_MIN_PX ? (
                          <span className="absolute top-2 left-3 text-xs leading-5 text-muted-foreground">
                            Sin atención
                          </span>
                        ) : null}
                      </div>
                    )
                  })}

                  {model.past.map((range) => (
                    <div
                      key={`past-${range.startMinutes}`}
                      aria-hidden
                      data-past
                      className="absolute inset-x-0 bg-muted-foreground/[0.08]"
                      style={{
                        top: topOf(range.startMinutes),
                        height: (range.endMinutes - range.startMinutes) * pxPerMinute,
                      }}
                    />
                  ))}

                  {model.blocks.map((block) => {
                    const range = clipRanges([block], window)[0]
                    if (!range) return null
                    const height = (range.endMinutes - range.startMinutes) * pxPerMinute
                    return (
                      <div
                        key={block.id}
                        data-blocked={block.id}
                        className="absolute inset-x-0 z-[1] flex items-start bg-muted"
                        style={{
                          top: topOf(range.startMinutes),
                          height,
                          backgroundImage:
                            "repeating-linear-gradient(135deg, var(--input) 0 1px, transparent 1px 8px)",
                        }}
                      >
                        <span
                          className={cn(
                            "ml-2.5 max-w-[calc(100%-1.25rem)] truncate rounded-full bg-card px-2 text-xs leading-5 font-semibold text-muted-foreground",
                            height >= LABEL_MIN_PX ? "mt-2" : "self-center",
                          )}
                        >
                          {block.label ?? "No disponible"}
                        </span>
                      </div>
                    )
                  })}

                  {laneHint ? (
                    <div
                      data-create-hint
                      className="pointer-events-none absolute inset-x-1.5 z-[2] flex items-center justify-center gap-1.5 overflow-hidden rounded-[10px] border-[1.5px] border-dashed border-primary bg-agent-soft px-2 text-[13px] font-semibold whitespace-nowrap text-primary-soft-foreground"
                      style={{
                        top: topOf(laneHint.startMinutes) + 1,
                        height: (laneHint.endMinutes - laneHint.startMinutes) * pxPerMinute - 2,
                      }}
                    >
                      <Plus aria-hidden className="size-4 shrink-0" />
                      <span className="truncate">
                        Reservar a las {hourLabel(laneHint.startMinutes)}
                      </span>
                    </div>
                  ) : null}

                  {placements.map((placement) => {
                    const { entry, range } = placement.item
                    const visible = clipRanges([range], window)[0]
                    if (!visible) return null
                    const height = Math.max(
                      (visible.endMinutes - visible.startMinutes) * pxPerMinute - 2,
                      20,
                    )
                    return (
                      <ScheduleCard
                        key={entry.id}
                        entry={entry}
                        timeZone={timeZone}
                        heightPx={height}
                        selected={entry.id === selectedEntryId}
                        draggable={onEntryMove != null}
                        dragProps={drag.getBlockProps(entry)}
                        resizeProps={
                          drag.getResizeProps
                            ? {
                                start: drag.getResizeProps(entry, "start"),
                                end: drag.getResizeProps(entry, "end"),
                              }
                            : null
                        }
                        onOpen={onEntryClick}
                        suppressClick={drag.suppressClick}
                        className="z-[3]"
                        style={{
                          top: topOf(visible.startMinutes) + 1,
                          height,
                          left: `calc(${(placement.lane / placement.lanes) * 100}% + 6px)`,
                          width: `calc(${100 / placement.lanes}% - 12px)`,
                        }}
                      />
                    )
                  })}

                  {lanePreview ? (
                    <div
                      data-preview
                      className="pointer-events-none absolute inset-x-1.5 z-[4] flex flex-col justify-center overflow-hidden rounded-[10px] border-2 border-primary bg-primary-soft px-2.5 text-primary-soft-foreground"
                      style={{
                        top: topOf(Math.max(lanePreview.startMinutes, window.startMinutes)) + 1,
                        height:
                          (Math.min(lanePreview.endMinutes, window.endMinutes) -
                            Math.max(lanePreview.startMinutes, window.startMinutes)) *
                            pxPerMinute -
                          2,
                      }}
                    >
                      <span className="truncate text-[13px] leading-[17px] font-bold">
                        {preview?.title}
                      </span>
                      <span className="truncate text-xs leading-[15px]">
                        <span className="font-semibold tabular-nums">
                          {hourLabel(lanePreview.startMinutes)}
                        </span>{" "}
                        {preview?.subtitle ?? "por reservar"}
                      </span>
                    </div>
                  ) : null}

                  {target ? (
                    <div
                      aria-hidden
                      data-drag-preview
                      data-fits={targetFits ? "true" : "false"}
                      className={cn(
                        "pointer-events-none absolute inset-x-1.5 z-[5] flex items-start rounded-[10px] border-2 border-dashed px-2 pt-0.5 text-xs font-semibold",
                        targetFits
                          ? "border-primary bg-primary/10 text-primary-soft-foreground"
                          : "border-destructive bg-destructive/10 text-destructive",
                      )}
                      style={{
                        top: topOf(target.startMinutes),
                        height: Math.max((target.endMinutes - target.startMinutes) * pxPerMinute, 20),
                      }}
                    >
                      <span className="truncate">
                        {targetFits
                          ? `${hourLabel(target.startMinutes)} – ${hourLabel(target.endMinutes)}`
                          : "Fuera del horario"}
                      </span>
                    </div>
                  ) : null}

                  {someToday && !allToday && lane.date === nowDate ? (
                    <div
                      aria-hidden
                      data-now
                      className="pointer-events-none absolute inset-x-0 z-[6] border-t-2 border-destructive"
                      style={{ top: topOf(nowMinutes) }}
                    />
                  ) : null}
                </div>
              )
            })}

            {allToday ? (
              <div
                aria-hidden
                data-now
                className="pointer-events-none absolute right-0 z-[6] border-t-2 border-destructive"
                style={{ left: GUTTER_PX, top: topOf(nowMinutes) }}
              />
            ) : null}
          </div>
        </div>
        <DragLiveRegion text={drag.announcement} />
      </ScrollArea>
    </section>
  )
}
