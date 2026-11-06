import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react"
import { clampZoom, FITTED, type Point, toggleZoom, type ZoomState, zoomAt } from "./view-transform"

/**
 * Acercar y moverse por una imagen, igual en la radiografía y en cada vista de
 * la tomografía: dos dedos o Ctrl + rueda acercan donde se apunta, doble clic
 * alterna entre ajustada y 2×, con la imagen ampliada se arrastra, y `+`, `−`
 * y `0` hacen lo mismo con el teclado. La rueda sola queda para quien la use
 * (en la tomografía, cambiar de corte).
 *
 * Los escuchas son nativos: la rueda de React es pasiva y no deja frenar el
 * acercamiento de la página entera.
 */

export interface ZoomPanOptions {
  /** La rueda sin Ctrl: en la tomografía avanza el corte. */
  onWheelStep?: (delta: number, shift: boolean) => void
  /** Si arrastrar mueve la imagen ampliada (no mientras se ajusta el arco). */
  canPan?: () => boolean
  /** Deslizar con la imagen ajustada: pasar al corte siguiente (−1 o 1). */
  onSwipe?: (direction: -1 | 1) => void
  /** Las flechas desplazan la imagen ampliada (en la radiografía). */
  arrowPan?: boolean
  /** Si el doble clic acerca: no mientras se mide, donde cada clic marca un punto. */
  canToggle?: () => boolean
}

const DRAG_PX = 4
const SWIPE_PX = 50

function sizeOf(el: HTMLElement) {
  return { width: el.clientWidth, height: el.clientHeight }
}

function pointIn(el: HTMLElement, clientX: number, clientY: number): Point {
  const rect = el.getBoundingClientRect()
  return { x: clientX - rect.left, y: clientY - rect.top }
}

export function useZoomPan(options: ZoomPanOptions = {}) {
  const [zoom, setZoom] = useState<ZoomState>(FITTED)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [frame, setFrame] = useState<HTMLElement | null>(null)
  const dragged = useRef(false)

  useEffect(() => {
    if (!frame) return
    const pointers = new Map<number, Point>()
    let start: { at: Point; zoom: ZoomState } | null = null
    let pinch: { distance: number } | null = null
    let panning = false
    // Hubo dos dedos en este gesto: al soltar no es un deslizamiento.
    let multi = false

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        // En un trackpad, pellizcar llega como Ctrl + rueda.
        event.preventDefault()
        const factor = Math.exp(-Math.max(-50, Math.min(50, event.deltaY)) * 0.01)
        setZoom((z) =>
          zoomAt(z, factor, pointIn(frame, event.clientX, event.clientY), sizeOf(frame)),
        )
        return
      }
      const step = optionsRef.current.onWheelStep
      if (!step) return
      event.preventDefault()
      step(event.deltaY > 0 ? 1 : -1, event.shiftKey)
    }
    const onPointerDown = (event: PointerEvent) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 1) {
        dragged.current = false
        panning = false
        multi = false
        start = { at: { x: event.clientX, y: event.clientY }, zoom: zoomRef.current }
      } else if (pointers.size === 2) {
        multi = true
        const [a, b] = [...pointers.values()]
        pinch = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y) }
        dragged.current = true
      }
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        if (distance > 0 && pinch.distance > 0) {
          const center = pointIn(frame, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2)
          const factor = distance / pinch.distance
          pinch = { distance }
          setZoom((z) => zoomAt(z, factor, center, sizeOf(frame)))
        }
        return
      }
      if (!start || pointers.size !== 1) return
      const dx = event.clientX - start.at.x
      const dy = event.clientY - start.at.y
      if (!dragged.current && Math.hypot(dx, dy) > DRAG_PX) dragged.current = true
      const canPan = optionsRef.current.canPan?.() ?? true
      if (dragged.current && start.zoom.scale > 1 && canPan) {
        if (!panning) {
          panning = true
          frame.setPointerCapture?.(event.pointerId)
        }
        const from = start.zoom
        setZoom(clampZoom({ scale: from.scale, x: from.x + dx, y: from.y + dy }, sizeOf(frame)))
      }
    }
    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = null
      // De dos dedos a uno: el que queda sigue desde donde está, con el acercamiento de ahora.
      if (pointers.size === 1) {
        const [rest] = [...pointers.values()]
        start = { at: rest!, zoom: zoomRef.current }
        panning = false
      }
      if (pointers.size === 0 && start) {
        const dx = event.clientX - start.at.x
        const dy = event.clientY - start.at.y
        const swipe = optionsRef.current.onSwipe
        if (
          swipe &&
          !multi &&
          start.zoom.scale === 1 &&
          Math.abs(dx) > SWIPE_PX &&
          Math.abs(dx) > 2 * Math.abs(dy)
        ) {
          swipe(dx < 0 ? 1 : -1)
        }
        start = null
        panning = false
      }
    }
    const onDoubleClick = (event: MouseEvent) => {
      // Dos clics rápidos en «+» o «−» no ajustan la imagen.
      if (event.target instanceof Element && event.target.closest("button, fieldset, input")) return
      if (optionsRef.current.canToggle && !optionsRef.current.canToggle()) return
      setZoom((z) => toggleZoom(z, pointIn(frame, event.clientX, event.clientY), sizeOf(frame)))
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const size = sizeOf(frame)
      const center = { x: size.width / 2, y: size.height / 2 }
      if (event.key === "+" || event.key === "=") setZoom((z) => zoomAt(z, 1.25, center, size))
      else if (event.key === "-") setZoom((z) => zoomAt(z, 0.8, center, size))
      else if (event.key === "0") setZoom(FITTED)
      else {
        const step = {
          ArrowLeft: [1, 0],
          ArrowRight: [-1, 0],
          ArrowUp: [0, 1],
          ArrowDown: [0, -1],
        }[event.key]
        if (!step || !optionsRef.current.arrowPan || zoomRef.current.scale <= 1) return
        setZoom((z) =>
          clampZoom(
            { ...z, x: z.x + step[0]! * size.width * 0.1, y: z.y + step[1]! * size.height * 0.1 },
            size,
          ),
        )
      }
      // Con la imagen ampliada, las flechas no pasan de archivo.
      event.preventDefault()
      event.stopPropagation()
    }
    frame.addEventListener("wheel", onWheel, { passive: false })
    frame.addEventListener("pointerdown", onPointerDown)
    frame.addEventListener("pointermove", onPointerMove)
    frame.addEventListener("pointerup", onPointerEnd)
    frame.addEventListener("pointercancel", onPointerEnd)
    frame.addEventListener("dblclick", onDoubleClick)
    frame.addEventListener("keydown", onKeyDown)
    return () => {
      frame.removeEventListener("wheel", onWheel)
      frame.removeEventListener("pointerdown", onPointerDown)
      frame.removeEventListener("pointermove", onPointerMove)
      frame.removeEventListener("pointerup", onPointerEnd)
      frame.removeEventListener("pointercancel", onPointerEnd)
      frame.removeEventListener("dblclick", onDoubleClick)
      frame.removeEventListener("keydown", onKeyDown)
    }
  }, [frame])

  const byButton = useCallback(
    (factor: number) => {
      if (!frame) return
      const size = sizeOf(frame)
      setZoom((z) => zoomAt(z, factor, { x: size.width / 2, y: size.height / 2 }, size))
    },
    [frame],
  )

  /** Con la imagen ajustada se desplaza la página hacia abajo; ampliada, el gesto es de la imagen. */
  const frameStyle: CSSProperties = { touchAction: zoom.scale > 1 ? "none" : "pan-y" }
  const contentStyle: CSSProperties = {
    transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
    transformOrigin: "0 0",
  }

  return {
    /** Ref del marco: recibe los gestos y recorta la imagen ampliada. */
    frameRef: setFrame,
    zoom,
    /** Estilo del marco: qué gestos quedan para la página. */
    frameStyle,
    /** Estilo de lo que se acerca, dentro del marco. */
    contentStyle,
    zoomIn: () => byButton(1.25),
    zoomOut: () => byButton(0.8),
    fit: () => setZoom(FITTED),
    /** True si el último gesto arrastró: el clic que sigue no marca ni elige. */
    consumeDrag: () => {
      const was = dragged.current
      dragged.current = false
      return was
    },
  }
}

export type ZoomPan = ReturnType<typeof useZoomPan>
