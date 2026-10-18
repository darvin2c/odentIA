import { useEffect, useMemo, useRef } from "react"
import { type PlaneImage, type WindowLevel, windowToRgba } from "../../lib/cbct-volume"
import { activeOrgLocale } from "../../lib/locale"

/**
 * Un corte de la tomografía en un lienzo (ADR 0056): la imagen con su ventana,
 * la retícula, las medidas y lo que dibuje cada vista encima. Clic, rueda,
 * flechas y arrastre llegan en coordenadas de la imagen.
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
}) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const rgba = useMemo(() => windowToRgba(image.values, window), [image, window])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), image.width, image.height), 0, 0)
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
  }, [image, rgba, cross, measures, draft, overlay])

  // `object-contain` centra la imagen dentro del lienzo con su proporción en
  // píxeles: el clic se convierte con esa área, no con la caja entera. (En una
  // tomografía el vóxel es isótropo: la proporción en píxeles es la de los mm.)
  const aspect = image.width / image.height
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
    <div className={`relative min-w-0 bg-black ${className ?? ""}`}>
      <canvas
        ref={ref}
        role="img"
        aria-label={`${label}${measures?.length ? `; ${measures.map(formatMeasure).join(", ")}` : ""}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: el corte se recorre con las flechas del teclado.
        tabIndex={0}
        className={`mx-auto block max-h-full w-full max-w-full object-contain focus-visible:outline-2 focus-visible:outline-cyan-400 ${tool === "ninguna" ? "cursor-crosshair" : "cursor-cell"}`}
        style={{ aspectRatio: String(aspect) }}
        onClick={(event) => {
          const point = toImage(event)
          if (tool === "ninguna") onPick?.(point)
          else onMark?.(point)
        }}
        onWheel={(event) => {
          if (!onStep) return
          event.preventDefault()
          onStep((event.deltaY > 0 ? 1 : -1) * (event.shiftKey ? 5 : 1))
        }}
        onPointerDown={onPointerDown ? (event) => onPointerDown(toImage(event)) : undefined}
        onPointerMove={onPointerMove ? (event) => onPointerMove(toImage(event)) : undefined}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (onKey?.(event.key)) {
            event.preventDefault()
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
      <span
        className="absolute top-2 left-2 rounded bg-black/70 px-1.5 py-0.5 text-[0.7rem] font-semibold tracking-wide text-slate-300 uppercase"
        title={technical ? `Corte ${technical}` : undefined}
      >
        {label}
      </span>
    </div>
  )
}

