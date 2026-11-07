import { useEffect, useMemo, useRef, useState } from "react"
import { type PlaneImage, type WindowLevel, windowToRgba } from "../../lib/cbct-volume"
import { activeOrgLocale } from "../../lib/locale"
import { useZoomPan } from "../../lib/use-zoom-pan"
import { ZoomControls } from "./viewer-shell"

/**
 * Un corte de la tomografía en un lienzo (ADR 0056): la imagen con su ventana,
 * la retícula, las medidas y lo que dibuje cada vista encima. Clic, rueda,
 * flechas y arrastre llegan en coordenadas de la imagen. Cada corte se acerca
 * por su cuenta: dos dedos, Ctrl + rueda o doble clic; la rueda sola avanza.
 */

export type Point = { x: number; y: number }
export type Tool = "ninguna" | "medir" | "angulo"

export interface PlaneMeasure {
  id: string
  /** Vista y corte donde se marcó. */
  view: string
  index: number
  kind: "distancia" | "angulo"
  points: Point[]
  value: number
}

export function formatMeasure(measure: Pick<PlaneMeasure, "kind" | "value">): string {
  return measure.kind === "angulo"
    ? `${measure.value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })}°`
    : `${measure.value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })} mm`
}

/** Lo que dice la ayuda de abajo mientras se mide: con el teclado también se marca. */
export const MEASURE_KEYS_HINT = "Flechas mueven la mira (Mayús, más rápido) · Enter marca el punto · RePág y AvPág cambian el corte · Esc termina"

/**
 * Cuánto se estira cada eje para que el corte tenga la forma de los mm, no la de
 * los píxeles: con un vóxel que no es cúbico (0,25 × 0,25 × 0,5 mm) una fila
 * mide más que una columna.
 */
export function physicalScale(image: Pick<PlaneImage, "colMm" | "rowMm">): { kx: number; ky: number } {
  const col = image.colMm > 0 ? image.colMm : 1
  const row = image.rowMm > 0 ? image.rowMm : 1
  const min = Math.min(col, row)
  return { kx: col / min, ky: row / min }
}

/** Una imagen de corte en un lienzo, con su retícula y sus medidas. */
export function SliceCanvas({
  image,
  window,
  label,
  technical,
  cross,
  measures,
  draft,
  tool,
  onPick,
  onMark,
  onStep,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKey,
  overlay,
  className,
  zoomControls = true,
  onSwipe,
}: {
  image: PlaneImage
  window: WindowLevel
  label: string
  technical?: string
  /** Retícula en coordenadas de la imagen. */
  cross?: Point | null
  measures?: PlaneMeasure[]
  draft?: Point[]
  tool: Tool
  onPick?: (point: Point) => void
  onMark?: (point: Point) => void
  onStep?: (delta: number) => void
  /** Arrastrar (ajustar el arco): punto en coordenadas de la imagen. */
  onPointerDown?: (point: Point) => void
  onPointerMove?: (point: Point) => void
  onPointerUp?: () => void
  /** Tecla con el lienzo enfocado; true si la atendió. */
  onKey?: (key: string) => boolean
  /** Dibujo extra (arco, líneas de corte) en coordenadas de la imagen. */
  overlay?: (ctx: CanvasRenderingContext2D, image: PlaneImage) => void
  className?: string
  /** «− 100 % +» sobre el corte; en los cortes chicos solo quedan los gestos. */
  zoomControls?: boolean
  /** Deslizar con el corte ajustado (en el celular: el corte siguiente). */
  onSwipe?: (direction: -1 | 1) => void
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const zoom = useZoomPan({
    onWheelStep: onStep ? (delta, shift) => onStep(delta * (shift ? 5 : 1)) : undefined,
    // Mientras se arrastra el arco, arrastrar no mueve la imagen.
    canPan: () => !onPointerDown,
    canToggle: () => tool === "ninguna",
    onSwipe,
  })
  const rgba = useMemo(() => windowToRgba(image.values, window), [image, window])
  const { kx, ky } = physicalScale(image)
  // La mira del teclado: con «Medir» o «Ángulo», las flechas la mueven un vóxel y Enter marca el punto.
  const [aim, setAim] = useState<Point | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: otra herramienta u otro corte empiezan sin mira.
  useEffect(() => setAim(null), [tool, image.width, image.height])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = Math.round(image.width * kx)
    canvas.height = Math.round(image.height * ky)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const pixels = new ImageData(new Uint8ClampedArray(rgba), image.width, image.height)
    if (kx === 1 && ky === 1) ctx.putImageData(pixels, 0, 0)
    else {
      // Se pinta en píxeles y se estira a los mm; lo de encima sigue en coordenadas de la imagen.
      const flat = document.createElement("canvas")
      flat.width = image.width
      flat.height = image.height
      flat.getContext("2d")?.putImageData(pixels, 0, 0)
      ctx.setTransform(kx, 0, 0, ky, 0, 0)
      ctx.drawImage(flat, 0, 0)
    }
    const unit = Math.max(1, image.width / 320)
    if (cross) {
      ctx.lineWidth = unit
      ctx.strokeStyle = "rgba(34, 211, 238, 0.7)"
      ctx.beginPath()
      ctx.moveTo(0, cross.y)
      ctx.lineTo(image.width, cross.y)
      ctx.stroke()
      ctx.strokeStyle = "rgba(245, 158, 11, 0.7)"
      ctx.beginPath()
      ctx.moveTo(cross.x, 0)
      ctx.lineTo(cross.x, image.height)
      ctx.stroke()
    }
    overlay?.(ctx, image)
    const drawPath = (points: Point[], color: string) => {
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = unit * 1.5
      ctx.beginPath()
      points.forEach((p, i) => {
        if (i) ctx.lineTo(p.x, p.y)
        else ctx.moveTo(p.x, p.y)
      })
      ctx.stroke()
      for (const p of points) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, unit * 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    for (const measure of measures ?? []) {
      drawPath(measure.points, "#f59e0b")
      const last = measure.points[measure.points.length - 1]!
      ctx.font = `${Math.round(unit * 11)}px system-ui, sans-serif`
      ctx.fillStyle = "#fde68a"
      ctx.fillText(formatMeasure(measure), last.x + unit * 5, last.y - unit * 5)
    }
    if (draft?.length) drawPath(draft, "#fbbf24")
    if (aim && tool !== "ninguna") {
      ctx.strokeStyle = "#67e8f9"
      ctx.lineWidth = unit * 1.5
      const r = unit * 9
      ctx.beginPath()
      ctx.moveTo(aim.x - r, aim.y)
      ctx.lineTo(aim.x - r / 3, aim.y)
      ctx.moveTo(aim.x + r / 3, aim.y)
      ctx.lineTo(aim.x + r, aim.y)
      ctx.moveTo(aim.x, aim.y - r)
      ctx.lineTo(aim.x, aim.y - r / 3)
      ctx.moveTo(aim.x, aim.y + r / 3)
      ctx.lineTo(aim.x, aim.y + r)
      ctx.stroke()
    }
  }, [image, rgba, cross, measures, draft, overlay, aim, tool, kx, ky])

  // `object-contain` centra la imagen dentro del lienzo con su proporción en
  // mm: el clic se convierte con esa área, no con la caja entera.
  const aspect = (image.width * kx) / (image.height * ky)
  const toImage = (event: React.MouseEvent<HTMLCanvasElement> | React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    let width = rect.width
    let height = rect.width / aspect
    if (height > rect.height) {
      height = rect.height
      width = height * aspect
    }
    const left = rect.left + (rect.width - width) / 2
    const top = rect.top + (rect.height - height) / 2
    return {
      x: ((event.clientX - left) / width) * image.width,
      y: ((event.clientY - top) / height) * image.height,
    }
  }
  return (
    <div
      ref={zoom.frameRef}
      // Ajustado, deslizar hacia abajo desplaza la vista (en el celular, los cortes apilados).
      style={zoom.frameStyle}
      className={`relative min-w-0 overflow-hidden bg-black ${className ?? ""}`}
    >
      <div className="flex h-full w-full items-center" style={zoom.contentStyle}>
        <canvas
          ref={ref}
          role="img"
          aria-label={`${label}${measures?.length ? `; ${measures.map(formatMeasure).join(", ")}` : ""}${
            tool !== "ninguna" ? `; ${MEASURE_KEYS_HINT}` : ""
          }`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: el corte se recorre con las flechas del teclado.
          tabIndex={0}
          className={`mx-auto block max-h-full w-full max-w-full object-contain focus-visible:outline-2 focus-visible:outline-cyan-400 ${tool === "ninguna" ? "cursor-crosshair" : "cursor-cell"}`}
          style={{ aspectRatio: String(aspect) }}
          onClick={(event) => {
            // Al terminar de arrastrar la imagen ampliada no se elige ni se marca.
            if (zoom.consumeDrag()) return
            // El segundo clic de un doble clic no marca otro punto en el mismo lugar.
            if (tool !== "ninguna" && event.detail > 1) return
            const point = toImage(event)
            if (tool === "ninguna") onPick?.(point)
            else onMark?.(point)
          }}
          onPointerDown={onPointerDown ? (event) => onPointerDown(toImage(event)) : undefined}
          onPointerMove={onPointerMove ? (event) => onPointerMove(toImage(event)) : undefined}
          onPointerUp={onPointerUp}
          onKeyDown={(event) => {
            if (onKey?.(event.key)) {
              event.preventDefault()
              return
            }
            // Midiendo, las flechas son de la mira y los cortes pasan a RePág y AvPág.
            if (tool !== "ninguna" && onMark) {
              const step = event.shiftKey ? 10 : 1
              const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[
                event.key
              ]
              const from = aim ?? { x: image.width / 2, y: image.height / 2 }
              if (move) {
                event.preventDefault()
                setAim({
                  x: Math.max(0, Math.min(image.width - 1, from.x + move[0]!)),
                  y: Math.max(0, Math.min(image.height - 1, from.y + move[1]!)),
                })
                return
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                if (!aim) setAim(from)
                else onMark(aim)
                return
              }
              const page = { PageUp: -1, PageDown: 1 }[event.key]
              if (page && onStep) {
                event.preventDefault()
                onStep(page)
              }
              return
            }
            if (!onStep) return
            const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[event.key]
            if (step) {
              event.preventDefault()
              onStep(step)
            }
          }}
        />
      </div>
      <span
        className="absolute top-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[0.7rem] font-semibold tracking-wide text-slate-300 uppercase"
        title={technical ? `Corte ${technical}` : undefined}
      >
        {label}
      </span>
      {zoomControls && <ZoomControls zoom={zoom} className="absolute right-2 bottom-2" />}
    </div>
  )
}

