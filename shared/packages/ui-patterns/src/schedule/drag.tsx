/**
 * Núcleo de arrastrar y soltar de la agenda. Sin dependencias: Pointer Events
 * para ratón, lápiz y táctil, y el teclado como vía completa (WCAG 2.1.1).
 *
 * Reglas del gesto:
 * - Ratón: el arrastre despierta tras 4 px de movimiento; un clic sin mover
 *   sigue siendo un clic (abre la cita).
 * - Táctil: pulsación larga de 400 ms; sin ella el gesto es scroll y no se
 *   pelea con él. Mientras la sesión está activa se cancela el scroll nativo
 *   con un `touchmove` no pasivo; al soltar, todo vuelve a la normalidad.
 * - Teclado: Alt+Intro levanta la cita; las flechas la mueven, Alt+flecha
 *   mueve el borde de fin y Alt+Mayús+flecha el de inicio; Intro suelta,
 *   Escape cancela. Intro a secas sigue abriendo la cita, así que no hay
 *   conflicto de teclas.
 *
 * El patrón nunca muta los datos: al soltar dispara `onMove`/`onResize` y el
 * padre decide. Mientras tanto, el fantasma sigue al puntero y una región
 * viva anuncia cada destino.
 */

import * as React from "react"

import type { ScheduleEntry } from "./types.js"

const LONG_PRESS_MS = 400
const MOUSE_THRESHOLD_PX = 4
const TOUCH_CANCEL_PX = 10
const EDGE_PX = 56
const EDGE_STEP_PX = 14
const CLICK_SUPPRESS_MS = 350

/** Geometría que cada vista conoce y el núcleo no: dónde cae el destino. */
/** Borde de la cita que se redimensiona: inicio (asa izquierda/superior) o fin. */
export type ResizeEdge = "start" | "end"

export interface DragGeometry<TTarget> {
  /**
   * Destino bajo el puntero; null cuando está fuera de cualquier carril.
   * `grab` es el punto del pointerdown: la cita conserva el desfase de donde
   * se agarró, no salta a la posición del cursor.
   */
  targetFromPoint(
    entry: ScheduleEntry,
    point: { x: number; y: number },
    resizing: ResizeEdge | null,
    grab?: { x: number; y: number },
  ): TTarget | null
  /** Destino de partida del modo teclado: la posición actual de la cita. */
  initialTarget(entry: ScheduleEntry): TTarget
  /**
   * Siguiente destino de teclado. `key` llega como «ArrowUp», «Alt+ArrowUp»
   * (borde de fin) o «Alt+Shift+ArrowUp» (borde de inicio).
   * Null = la tecla no hace nada.
   */
  keyboardTarget(entry: ScheduleEntry, current: TTarget, key: string): TTarget | null
  sameTarget(a: TTarget, b: TTarget): boolean
  /** Frase para la región viva: «Dra. Ana Quispe, 10:30 a 11:15». */
  describe(entry: ScheduleEntry, target: TTarget): string
  onMove(entry: ScheduleEntry, target: TTarget): void
  onResize?(entry: ScheduleEntry, target: TTarget): void
}

export interface UseEntryDragOptions {
  enabled?: boolean
  /** Contenedor con scroll, para el auto-scroll al arrastrar cerca del borde. */
  scrollContainer?: () => HTMLElement | null
}

export interface DragSessionInfo<TTarget> {
  entryId: string
  target: TTarget
  resizing: ResizeEdge | null
  keyboard: boolean
}

interface PendingDrag {
  entry: ScheduleEntry
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  resizing: ResizeEdge | null
  longPress: number | null
}

interface ActiveDrag<TTarget> {
  entry: ScheduleEntry
  target: TTarget
  resizing: ResizeEdge | null
  keyboard: boolean
}

/** Props que el núcleo entrega al bloque arrastrable. */
export interface EntryDragBlockProps {
  onPointerDown: (event: React.PointerEvent) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  "data-dragging"?: "true" | undefined
  style?: React.CSSProperties
}

/** Props del asa de duración. */
export interface EntryDragResizeProps {
  onPointerDown: (event: React.PointerEvent) => void
  onKeyDown: (event: React.KeyboardEvent) => void
  onClick: (event: React.MouseEvent) => void
}

/** Lo que devuelve `useEntryDrag`: sesión, fantasma, anuncios y props. */
export interface UseEntryDragResult<TTarget> {
  session: DragSessionInfo<TTarget> | null
  ghostDelta: { x: number; y: number } | null
  announcement: string
  getBlockProps: (entry: ScheduleEntry) => EntryDragBlockProps
  getResizeProps: ((entry: ScheduleEntry, edge: ResizeEdge) => EntryDragResizeProps) | null
  suppressClick: () => boolean
}

export function useEntryDrag<TTarget>(
  geometry: DragGeometry<TTarget>,
  options?: UseEntryDragOptions,
): UseEntryDragResult<TTarget> {
  const enabled = options?.enabled ?? true
  const [session, setSession] = React.useState<ActiveDrag<TTarget> | null>(null)
  const [ghostDelta, setGhostDelta] = React.useState<{ x: number; y: number } | null>(null)
  const [announcement, setAnnouncement] = React.useState("")

  const sessionRef = React.useRef<ActiveDrag<TTarget> | null>(null)
  const pendingRef = React.useRef<PendingDrag | null>(null)
  const grabRef = React.useRef({ x: 0, y: 0 })
  const suppressClickAtRef = React.useRef(0)
  const listeningRef = React.useRef(false)
  const geometryRef = React.useRef(geometry)
  geometryRef.current = geometry
  const scrollContainerRef = React.useRef(options?.scrollContainer)
  scrollContainerRef.current = options?.scrollContainer

  const handlers = React.useMemo(() => {
    const applySession = (next: ActiveDrag<TTarget> | null) => {
      sessionRef.current = next
      setSession(next)
      if (!next) setGhostDelta(null)
    }

    const cancelPending = () => {
      const pending = pendingRef.current
      if (pending?.longPress != null) window.clearTimeout(pending.longPress)
      pendingRef.current = null
      maybeDetach()
    }

    const autoScroll = (x: number, y: number) => {
      const container = scrollContainerRef.current?.()
      if (!container) return
      const rect = container.getBoundingClientRect()
      let dx = 0
      let dy = 0
      if (y < rect.top + EDGE_PX) dy = -EDGE_STEP_PX
      else if (y > rect.bottom - EDGE_PX) dy = EDGE_STEP_PX
      if (x < rect.left + EDGE_PX) dx = -EDGE_STEP_PX
      else if (x > rect.right - EDGE_PX) dx = EDGE_STEP_PX
      if (dx !== 0 || dy !== 0) container.scrollBy(dx, dy)
    }

    const activate = (pending: PendingDrag) => {
      const target = geometryRef.current.initialTarget(pending.entry)
      grabRef.current = { x: pending.startX, y: pending.startY }
      applySession({
        entry: pending.entry,
        target,
        resizing: pending.resizing,
        keyboard: false,
      })
      setGhostDelta({ x: 0, y: 0 })
      setAnnouncement(
        pending.resizing
          ? pending.resizing === "start"
            ? `Cambiando el inicio de ${pending.entry.title}`
            : `Cambiando la duración de ${pending.entry.title}`
          : `Moviendo ${pending.entry.title}`,
      )
      if (pending.pointerType === "touch") navigator.vibrate?.(20)
    }

    const finish = (commit: boolean) => {
      const active = sessionRef.current
      if (!active) return
      suppressClickAtRef.current = Date.now()
      applySession(null)
      maybeDetach()
      if (!commit) {
        setAnnouncement("Movimiento cancelado")
        return
      }
      const initial = geometryRef.current.initialTarget(active.entry)
      if (!active.resizing && geometryRef.current.sameTarget(active.target, initial)) {
        setAnnouncement("La cita no cambió de lugar")
        return
      }
      if (active.resizing && geometryRef.current.onResize) {
        geometryRef.current.onResize(active.entry, active.target)
      } else {
        geometryRef.current.onMove(active.entry, active.target)
      }
      setAnnouncement(
        `${active.resizing ? (active.resizing === "start" ? "Inicio cambiado" : "Duración cambiada") : "Cita movida"}: ${geometryRef.current.describe(active.entry, active.target)}`,
      )
    }

    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingRef.current
      if (pending && event.pointerId === pending.pointerId) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY)
        if (pending.pointerType === "touch") {
          if (distance > TOUCH_CANCEL_PX) cancelPending()
        } else if (distance > MOUSE_THRESHOLD_PX) {
          pendingRef.current = null
          activate(pending)
        }
        return
      }
      const active = sessionRef.current
      if (!active || active.keyboard) return
      setGhostDelta({
        x: event.clientX - grabRef.current.x,
        y: event.clientY - grabRef.current.y,
      })
      const target = geometryRef.current.targetFromPoint(
        active.entry,
        { x: event.clientX, y: event.clientY },
        active.resizing,
        grabRef.current,
      )
      if (target && !geometryRef.current.sameTarget(target, active.target)) {
        applySession({ ...active, target })
        setAnnouncement(geometryRef.current.describe(active.entry, target))
      }
      autoScroll(event.clientX, event.clientY)
    }

    const onPointerUp = (event: PointerEvent) => {
      if (pendingRef.current?.pointerId === event.pointerId) cancelPending()
      if (sessionRef.current && !sessionRef.current.keyboard) finish(true)
    }

    const onPointerCancel = () => {
      cancelPending()
      if (sessionRef.current && !sessionRef.current.keyboard) finish(false)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (sessionRef.current && !sessionRef.current.keyboard) event.preventDefault()
    }

    function maybeDetach() {
      if (pendingRef.current || sessionRef.current || !listeningRef.current) return
      listeningRef.current = false
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerup", onPointerUp)
      window.removeEventListener("pointercancel", onPointerCancel)
      window.removeEventListener("touchmove", onTouchMove)
    }

    const attach = () => {
      if (listeningRef.current) return
      listeningRef.current = true
      window.addEventListener("pointermove", onPointerMove)
      window.addEventListener("pointerup", onPointerUp)
      window.addEventListener("pointercancel", onPointerCancel)
      window.addEventListener("touchmove", onTouchMove, { passive: false })
    }

    return { attach, cancelPending, finish, onBlockPointerDown, onBlockKeyDown, onResizeKeyDown }

    function onBlockPointerDown(entry: ScheduleEntry, resizing: ResizeEdge | null) {
      return (event: React.PointerEvent) => {
        if (!enabled || event.button !== 0) return
        const pending: PendingDrag = {
          entry,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
          startX: event.clientX,
          startY: event.clientY,
          resizing,
          longPress: null,
        }
        if (event.pointerType === "touch") {
          pending.longPress = window.setTimeout(() => {
            if (pendingRef.current === pending) {
              pendingRef.current = null
              activate(pending)
            }
          }, LONG_PRESS_MS)
        }
        pendingRef.current = pending
        attach()
      }
    }

    function onBlockKeyDown(entry: ScheduleEntry) {
      return (event: React.KeyboardEvent) => {
        if (!enabled) return
        const active = sessionRef.current
        if (event.altKey && event.key === "Enter" && !active) {
          event.preventDefault()
          const target = geometryRef.current.initialTarget(entry)
          applySession({ entry, target, resizing: null, keyboard: true })
          setAnnouncement(
            `Moviendo ${entry.title}. Flechas para mover, Alt y flecha para el fin, Alt+Mayús y flecha para el inicio, Intro para soltar, Escape para cancelar.`,
          )
          return
        }
        if (!active?.keyboard || active.entry.id !== entry.id) return
        const key = event.altKey ? `Alt+${event.shiftKey ? "Shift+" : ""}${event.key}` : event.key
        if (key === "Enter") {
          event.preventDefault()
          finish(true)
          return
        }
        if (key === "Escape") {
          event.preventDefault()
          finish(false)
          return
        }
        const next = geometryRef.current.keyboardTarget(active.entry, active.target, key)
        if (next) {
          event.preventDefault()
          const resizing = key.startsWith("Alt+Shift+")
            ? ("start" as const)
            : key.startsWith("Alt+")
              ? ("end" as const)
              : null
          applySession({ ...active, target: next, resizing })
          setAnnouncement(geometryRef.current.describe(active.entry, next))
        }
      }
    }

    function onResizeKeyDown(entry: ScheduleEntry, edge: ResizeEdge) {
      return (event: React.KeyboardEvent) => {
        if (!enabled || !geometryRef.current.onResize) return
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        event.stopPropagation()
        const prefix = edge === "start" ? "Alt+Shift+" : "Alt+"
        const key = event.key === "ArrowUp" ? `${prefix}ArrowUp` : `${prefix}ArrowDown`
        const next = geometryRef.current.keyboardTarget(entry, geometryRef.current.initialTarget(entry), key)
        if (next) {
          geometryRef.current.onResize(entry, next)
          const que = edge === "start" ? "Inicio" : "Duración"
          setAnnouncement(`${que}: ${geometryRef.current.describe(entry, next)}`)
        }
      }
    }
  }, [enabled])

  React.useEffect(
    () => () => {
      const pending = pendingRef.current
      if (pending?.longPress != null) window.clearTimeout(pending.longPress)
    },
    [],
  )

  const info: DragSessionInfo<TTarget> | null = session
    ? {
        entryId: session.entry.id,
        target: session.target,
        resizing: session.resizing,
        keyboard: session.keyboard,
      }
    : null

  return {
    session: info,
    ghostDelta: session && !session.keyboard ? ghostDelta : null,
    announcement,
    /** Props del bloque: arrastre de cuerpo entero + teclado. */
    getBlockProps(entry: ScheduleEntry) {
      const dragging = session?.entry.id === entry.id
      return {
        onPointerDown: handlers.onBlockPointerDown(entry, null),
        onKeyDown: handlers.onBlockKeyDown(entry),
        "data-dragging": dragging ? ("true" as const) : undefined,
        style:
          dragging && ghostDelta && !session.keyboard
            ? { transform: `translate(${ghostDelta.x}px, ${ghostDelta.y}px)` }
            : undefined,
      }
    },
    /** Props del asa de un borde; null cuando la vista no permite redimensionar. */
    getResizeProps: geometry.onResize
      ? (entry: ScheduleEntry, edge: ResizeEdge) => ({
          onPointerDown: handlers.onBlockPointerDown(entry, edge),
          onKeyDown: handlers.onResizeKeyDown(entry, edge),
          onClick: (event: React.MouseEvent) => event.stopPropagation(),
        })
      : null,
    /** Tras soltar, el clic fantasma del gesto no debe abrir la cita. */
    suppressClick: () => Date.now() - suppressClickAtRef.current < CLICK_SUPPRESS_MS,
  }
}

/** Región viva del arrastre: una por vista, lee los anuncios en voz alta. */
export function DragLiveRegion({ text }: { text: string }) {
  return (
    <span aria-live="polite" role="status" className="sr-only">
      {text}
    </span>
  )
}
