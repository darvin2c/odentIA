import { Button } from "@odentia/ui"
import { useEffect, useRef, useState } from "react"

/**
 * Captura de firma manuscrita: el trazo se dibuja en el lienzo y se entrega
 * como lista de trazos (coordenadas 0–1000). Es evidencia manuscrita simple:
 * no se afirma firma certificada ni valor de firma digital.
 */
export function FirmaPad({
  onChange,
  disabled = false,
  label = "Área de firma manuscrita",
  describedBy,
}: {
  onChange: (strokes: number[][][]) => void
  disabled?: boolean
  /** Nombre accesible del recuadro (p. ej. «Firma de la paciente»). */
  label?: string
  describedBy?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawing = useRef<number[][] | null>(null)
  const [strokes, setStrokes] = useState<number[][][]>([])
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.floor(rect.width * ratio))
    canvas.height = Math.max(1, Math.floor(rect.height * ratio))
    const context = canvas.getContext("2d")
    if (!context) return
    context.scale(ratio, ratio)
    context.lineWidth = 2
    context.lineCap = "round"
    context.strokeStyle = "#111827"
    redraw(context, rect.width, rect.height, strokes)
  }, [strokes])

  const position = (event: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = Math.min(1000, Math.max(0, ((event.clientX - rect.left) / rect.width) * 1000))
    const y = Math.min(1000, Math.max(0, ((event.clientY - rect.top) / rect.height) * 1000))
    return [Math.round(x), Math.round(y)]
  }

  const commit = (next: number[][][]) => {
    setStrokes(next)
    setEmpty(next.length === 0)
    onChange(next)
  }

  return (
    <div>
      <canvas
        ref={canvasRef}
        // Proporción fija (la del PDF): el trazo se guarda normalizado y no se deforma.
        className="aspect-[22/7] w-full touch-none rounded-md border bg-white"
        role="img"
        aria-label={label}
        aria-describedby={describedBy}
        onPointerDown={(event) => {
          if (disabled) return
          event.preventDefault()
          ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
          drawing.current = [position(event)]
        }}
        onPointerMove={(event) => {
          if (disabled || !drawing.current) return
          event.preventDefault()
          drawing.current.push(position(event))
          const canvas = canvasRef.current
          const context = canvas?.getContext("2d")
          if (canvas && context) {
            const rect = canvas.getBoundingClientRect()
            redraw(context, rect.width, rect.height, [...strokes, drawing.current])
          }
        }}
        onPointerUp={() => {
          if (disabled || !drawing.current) return
          const finished = drawing.current
          drawing.current = null
          if (finished.length > 1) commit([...strokes, finished])
        }}
      />
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {empty ? "Firma con el dedo o el mouse en el recuadro." : `${strokes.length} trazo(s) capturados.`}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || empty}
          onClick={() => commit([])}
        >
          Limpiar
        </Button>
      </div>
    </div>
  )
}

function redraw(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  strokes: number[][][],
): void {
  context.clearRect(0, 0, width, height)
  for (const stroke of strokes) {
    if (stroke.length < 2) continue
    context.beginPath()
    stroke.forEach(([x, y], index) => {
      const px = (x / 1000) * width
      const py = (y / 1000) * height
      if (index === 0) context.moveTo(px, py)
      else context.lineTo(px, py)
    })
    context.stroke()
  }
}

/** Vista estática del trazo guardado (historial e impresión). */
export function FirmaView({
  strokes,
  label = "Firma registrada",
}: {
  strokes: number[][][]
  label?: string
}): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = Math.max(1, Math.floor(rect.width * ratio))
    canvas.height = Math.max(1, Math.floor(rect.height * ratio))
    const context = canvas.getContext("2d")
    if (!context) return
    context.scale(ratio, ratio)
    context.lineWidth = 2
    context.lineCap = "round"
    context.strokeStyle = "#111827"
    redraw(context, rect.width, rect.height, strokes)
  }, [strokes])
  return (
    <canvas
      ref={ref}
      className="aspect-[22/7] w-full rounded-md border bg-white"
      role="img"
      aria-label={label}
    />
  )
}
