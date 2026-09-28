/**
 * Geometría de arrastre sobre el eje de tiempo del timeline: el destino es
 * `{ columnId, startMinutes, endMinutes }` y aquí se convierte
 * puntero/teclado ↔ minutos ↔ instantes ISO. Las superficies solo registran
 * sus carriles, dicen qué fecha tiene cada carril y qué recurso recibe la
 * cita al soltar (horizontal: el carril ES el recurso; vertical: el carril
 * es un día y el recurso no cambia).
 */

import * as React from "react"

import { useEntryDrag, type DragGeometry } from "./drag.js"
import {
  clampToWindow,
  dayMinutesIn,
  durationMinutes,
  hourLabel,
  minutesToInstant,
  snapMinutes,
  zonedDateOf,
  formatDayShort,
} from "./time.js"
import type {
  ScheduleEntry,
  ScheduleMoveHandler,
  ScheduleResizeHandler,
  ScheduleWindow,
} from "./types.js"

export interface AxisTarget {
  columnId: string
  /** Día civil del destino; solo en modo multi-día (timeline). */
  date?: string
  startMinutes: number
  endMinutes: number
}

export interface UseAxisDragConfig {
  timeZone: string
  window: ScheduleWindow
  /** Dirección del eje de tiempo: vertical en día/semana, horizontal en timeline. */
  axis: "vertical" | "horizontal"
  /** Píxeles por minuto del eje (`hourHeight / 60` u `hourWidth / 60`). */
  pxPerMinute: number
  /** Snap del arrastre en minutos. */
  snap?: number
  /** Fecha civil de cada carril (día/timeline: siempre la misma; semana: la del día). */
  dateOf: (columnId: string) => string
  /**
   * Días cargados y contiguos (timeline multi-día): el eje de tiempo se vuelve
   * continuo entre días y el destino lleva `date`. Sin esto, un solo día.
   */
  dates?: string[]
  /** Recurso del movimiento al soltar en un carril (semana: el de la cita). */
  moveColumnId: (laneId: string, entry: ScheduleEntry) => string
  /** Orden visual de los carriles, para las flechas izquierda/derecha. */
  columnOrder: string[]
  /** Etiqueta hablada del carril («Dra. Ana Quispe», «martes 22»). */
  describeColumn: (columnId: string) => string
  onMove?: ScheduleMoveHandler
  onResize?: ScheduleResizeHandler
  scrollContainer?: () => HTMLElement | null
}

export function useAxisDrag(config: UseAxisDragConfig) {
  const {
    timeZone,
    window,
    axis,
    pxPerMinute,
    snap = 15,
    dateOf,
    dates,
    moveColumnId,
    columnOrder,
    describeColumn,
    onMove,
    onResize,
    scrollContainer,
  } = config

  const lanesRef = React.useRef(new Map<string, HTMLElement>())
  const registerLane = React.useCallback((columnId: string, node: HTMLElement | null) => {
    if (node) lanesRef.current.set(columnId, node)
    else lanesRef.current.delete(columnId)
  }, [])

  const columnOrderRef = React.useRef(columnOrder)
  columnOrderRef.current = columnOrder
  const configRef = React.useRef({
    timeZone,
    window,
    axis,
    pxPerMinute,
    snap,
    dateOf,
    dates,
    moveColumnId,
    describeColumn,
    onMove,
    onResize,
  })
  configRef.current = {
    timeZone,
    window,
    axis,
    pxPerMinute,
    snap,
    dateOf,
    dates,
    moveColumnId,
    describeColumn,
    onMove,
    onResize,
  }

  const geometry = React.useMemo<DragGeometry<AxisTarget>>(() => {
    const toIso = (entry: ScheduleEntry, target: AxisTarget) => {
      const cfg = configRef.current
      const date = target.date ?? cfg.dateOf(target.columnId)
      return {
        columnId: cfg.moveColumnId(target.columnId, entry),
        start: minutesToInstant(date, target.startMinutes, cfg.timeZone),
        end: minutesToInstant(date, target.endMinutes, cfg.timeZone),
      }
    }

    return {
      targetFromPoint(entry, point, resizing, grab) {
        const cfg = configRef.current
        const span = cfg.window.endMinutes - cfg.window.startMinutes
        const laneAt = (p: { x: number; y: number }) => {
          for (const [columnId, lane] of lanesRef.current) {
            const rect = lane.getBoundingClientRect()
            const onLane =
              cfg.axis === "vertical"
                ? p.x >= rect.left && p.x <= rect.right
                : p.y >= rect.top && p.y <= rect.bottom
            if (onLane) return { columnId, rect }
          }
          return null
        }
        // Minutos de ventana desde el primer día cargado (multi-día) o desde
        // la medianoche del día (un día): una sola coordenada continua.
        const globalOf = (date: string, minutes: number) => {
          const idx = cfg.dates ? Math.max(cfg.dates.indexOf(date), 0) : 0
          return idx * span + (minutes - cfg.window.startMinutes)
        }
        // Desfase de donde se agarró la cita: al arrastrar, el bloque no salta
        // al cursor; conserva el punto de agarre (como Google Calendar).
        let grabOffsetPx = 0
        if (grab) {
          const origin = laneAt(grab)
          if (origin) {
            const grabAlong =
              cfg.axis === "vertical" ? grab.y - origin.rect.top : grab.x - origin.rect.left
            const edgeIso = resizing === "end" ? entry.end : entry.start
            grabOffsetPx =
              grabAlong -
              globalOf(zonedDateOf(edgeIso, cfg.timeZone), dayMinutesIn(edgeIso, cfg.timeZone)) *
                cfg.pxPerMinute
          }
        }
        const hit = laneAt(point)
        if (!hit) return null
        const along =
          (cfg.axis === "vertical" ? point.y - hit.rect.top : point.x - hit.rect.left) -
          grabOffsetPx
        const rawGlobal = along / cfg.pxPerMinute
        if (resizing) {
          // Redimensionar no cruza días: el día es el del inicio de la cita y
          // solo se mueve el borde agarrado; el otro queda fijo.
          const dayIndex = cfg.dates
            ? Math.max(cfg.dates.indexOf(zonedDateOf(entry.start, cfg.timeZone)), 0)
            : 0
          const localRaw = rawGlobal - dayIndex * span + cfg.window.startMinutes
          if (resizing === "end") {
            const start = dayMinutesIn(entry.start, cfg.timeZone)
            const end = Math.max(start + cfg.snap, snapMinutes(localRaw, cfg.snap))
            return {
              columnId: hit.columnId,
              date: cfg.dates?.[dayIndex],
              startMinutes: start,
              endMinutes: Math.min(end, cfg.window.endMinutes),
            }
          }
          const end = dayMinutesIn(entry.end, cfg.timeZone)
          const start = Math.min(end - cfg.snap, snapMinutes(localRaw, cfg.snap))
          return {
            columnId: hit.columnId,
            date: cfg.dates?.[dayIndex],
            startMinutes: Math.max(start, cfg.window.startMinutes),
            endMinutes: end,
          }
        }
        const duration = durationMinutes(entry)
        if (cfg.dates) {
          // Eje continuo entre días: el destino cae en el día bajo el puntero.
          const maxGlobal = Math.max(cfg.dates.length * span - duration, 0)
          const global = Math.min(Math.max(snapMinutes(rawGlobal, cfg.snap), 0), maxGlobal)
          const dayIndex = Math.min(Math.floor(global / span), cfg.dates.length - 1)
          const start = Math.min(
            cfg.window.startMinutes + (global - dayIndex * span),
            cfg.window.endMinutes - duration,
          )
          return {
            columnId: hit.columnId,
            date: cfg.dates[dayIndex],
            startMinutes: start,
            endMinutes: start + duration,
          }
        }
        const start = clampToWindow(
          snapMinutes(rawGlobal + cfg.window.startMinutes, cfg.snap),
          duration,
          cfg.window,
        )
        return { columnId: hit.columnId, startMinutes: start, endMinutes: start + duration }
      },
      initialTarget(entry) {
        // El carril inicial no siempre es `entry.columnId`: en la semana los
        // carriles son fechas y el recurso se conserva aparte. Se busca el
        // carril del recurso en la fecha de la cita y, si no existe (vista de
        // semana), el carril de la fecha.
        const cfg = configRef.current
        const date = zonedDateOf(entry.start, cfg.timeZone)
        const lanes = columnOrderRef.current
        const lane =
          lanes.find((id) => id === entry.columnId && cfg.dateOf(id) === date) ??
          lanes.find((id) => cfg.dateOf(id) === date) ??
          entry.columnId
        return {
          columnId: lane,
          date: cfg.dates ? date : undefined,
          startMinutes: dayMinutesIn(entry.start, cfg.timeZone),
          endMinutes: dayMinutesIn(entry.end, cfg.timeZone),
        }
      },
      keyboardTarget(entry, current, key) {
        void entry
        const cfg = configRef.current
        const duration = current.endMinutes - current.startMinutes
        const timeKeys: Record<string, number> =
          cfg.axis === "vertical"
            ? { ArrowUp: -cfg.snap, ArrowDown: cfg.snap }
            : { ArrowLeft: -cfg.snap, ArrowRight: cfg.snap }
        const columnKeys: Record<string, number> =
          cfg.axis === "vertical"
            ? { ArrowLeft: -1, ArrowRight: 1 }
            : { ArrowUp: -1, ArrowDown: 1 }

        if (key in timeKeys) {
          if (cfg.dates) {
            // Paso continuo entre días: al cruzar el borde de la jornada la
            // cita amanece en el día vecino conservando su recurso.
            const span = cfg.window.endMinutes - cfg.window.startMinutes
            const maxLocal = span - duration
            let idx = Math.max(cfg.dates.indexOf(current.date ?? cfg.dates[0]), 0)
            let local = current.startMinutes - cfg.window.startMinutes + timeKeys[key]
            if (local > maxLocal) {
              if (idx < cfg.dates.length - 1) {
                idx += 1
                local = 0
              } else {
                local = maxLocal
              }
            } else if (local < 0) {
              if (idx > 0) {
                idx -= 1
                local = maxLocal
              } else {
                local = 0
              }
            }
            const start = cfg.window.startMinutes + local
            return { ...current, date: cfg.dates[idx], startMinutes: start, endMinutes: start + duration }
          }
          const start = clampToWindow(current.startMinutes + timeKeys[key], duration, cfg.window)
          return { ...current, startMinutes: start, endMinutes: start + duration }
        }
        if (key in columnKeys) {
          const order = columnOrderRef.current
          const next = order[order.indexOf(current.columnId) + columnKeys[key]]
          return next ? { ...current, columnId: next } : null
        }
        if (key === "Alt+Shift+ArrowUp" || key === "Alt+Shift+ArrowLeft") {
          const start = Math.max(cfg.window.startMinutes, current.startMinutes - cfg.snap)
          return { ...current, startMinutes: start }
        }
        if (key === "Alt+Shift+ArrowDown" || key === "Alt+Shift+ArrowRight") {
          const start = Math.min(current.endMinutes - cfg.snap, current.startMinutes + cfg.snap)
          return { ...current, startMinutes: start }
        }
        if (key === "Alt+ArrowUp" || key === "Alt+ArrowLeft") {
          const end = Math.max(current.startMinutes + cfg.snap, current.endMinutes - cfg.snap)
          return { ...current, endMinutes: end }
        }
        if (key === "Alt+ArrowDown" || key === "Alt+ArrowRight") {
          const end = Math.min(cfg.window.endMinutes, current.endMinutes + cfg.snap)
          return { ...current, endMinutes: end }
        }
        return null
      },
      sameTarget(a, b) {
        return (
          a.columnId === b.columnId &&
          (a.date ?? null) === (b.date ?? null) &&
          a.startMinutes === b.startMinutes &&
          a.endMinutes === b.endMinutes
        )
      },
      describe(entry, target) {
        void entry
        const cfg = configRef.current
        const horas = `${hourLabel(target.startMinutes)} a ${hourLabel(target.endMinutes)}`
        if (target.date) {
          return `${cfg.describeColumn(target.columnId)}, ${formatDayShort(target.date)}, ${horas}`
        }
        return `${cfg.describeColumn(target.columnId)}, ${horas}`
      },
      onMove(entry, target) {
        configRef.current.onMove?.(entry, toIso(entry, target))
      },
      onResize: configRef.current.onResize
        ? (entry, target) => {
            const iso = toIso(entry, target)
            configRef.current.onResize?.(entry, { start: iso.start, end: iso.end })
          }
        : undefined,
    }
  }, [])

  const drag = useEntryDrag<AxisTarget>(geometry, {
    enabled: onMove != null || onResize != null,
    scrollContainer,
  })

  return { ...drag, registerLane }
}
