import { Button, Field, FieldLabel, Slider } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetchBytes } from "../../lib/api"
import { DicomUnsupportedError, decodeDicom, distanceMm, renderDicom } from "../../lib/dicom"

type Point = { x: number; y: number }

function sliderValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number)
}

function formatDicomDate(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return value
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00`,
  ).toLocaleDateString("es-PE", { dateStyle: "medium" })
}

/**
 * Visor DICOM 2D básico: ventana (nivel y ancho, que en radiografía hacen de
 * brillo y contraste), zoom, inversión y medición de distancias en mm con el
 * espaciado del detector. Los ajustes son de pantalla: el archivo no cambia.
 * La tomografía volumétrica no se reconstruye aquí.
 */
export function DicomViewer({
  patientId,
  documentId,
  label,
}: {
  patientId: string
  documentId: string
  label: string
}) {
  const id = useId()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const query = useQuery({
    queryKey: ["patient-document-dicom", patientId, documentId],
    queryFn: async () =>
      decodeDicom(
        await apiFetchBytes(`/api/patients/${patientId}/documents/${documentId}/content`),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const image = query.data
  const [center, setCenter] = useState<number | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [invert, setInvert] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [measuring, setMeasuring] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  useEffect(() => {
    if (!image) return
    setCenter(image.window.center)
    setWidth(image.window.width)
  }, [image])

  const span = image ? Math.max(1, image.range.max - image.range.min) : 1
  useEffect(() => {
    const canvas = canvasRef.current
    if (!image || !canvas || center === null || width === null) return
    canvas.width = image.width
    canvas.height = image.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const pixels = renderDicom(image, { center, width, invert })
    ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), image.width, image.height), 0, 0)
    if (points.length > 0) {
      ctx.strokeStyle = "#f59e0b"
      ctx.fillStyle = "#f59e0b"
      ctx.lineWidth = Math.max(1, image.width / 400)
      for (const p of points) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(2, image.width / 200), 0, Math.PI * 2)
        ctx.fill()
      }
      if (points.length === 2) {
        ctx.beginPath()
        ctx.moveTo(points[0]!.x, points[0]!.y)
        ctx.lineTo(points[1]!.x, points[1]!.y)
        ctx.stroke()
      }
    }
  }, [image, center, width, invert, points])

  const measurement = useMemo(() => {
    if (!image || points.length !== 2) return null
    const mm = distanceMm(image, points[0]!, points[1]!)
    const px = Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y)
    return mm === null
      ? `${px.toFixed(0)} px (el archivo no declara el espaciado del detector)`
      : `${mm.toFixed(2)} mm`
  }, [image, points])

  if (query.isPending) return <LoadingState message="Abriendo el DICOM…" />
  if (query.isError) {
    const error = query.error
    return (
      <div role="alert" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
        <p className="font-medium">No se puede mostrar este DICOM</p>
        <p className="text-muted-foreground">
          {error instanceof DicomUnsupportedError
            ? error.message
            : error instanceof ApiError
              ? (error.shape.message ?? "No se pudo leer el archivo.")
              : "El archivo no es un DICOM legible. Descárgalo para abrirlo en el software del equipo."}
        </p>
      </div>
    )
  }
  if (!image || center === null || width === null) return null

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        className="max-h-[60vh] overflow-auto rounded-md bg-black"
        tabIndex={zoom > 1 ? 0 : undefined}
        role={zoom > 1 ? "group" : undefined}
        aria-label={zoom > 1 ? `${label} ampliada; usa las flechas para desplazarte` : undefined}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${label}${measurement ? `; medición ${measurement}` : ""}`}
          className={`mx-auto block h-auto max-w-none ${measuring ? "cursor-crosshair" : ""}`}
          style={{ width: `${zoom * 100}%` }}
          onClick={(event) => {
            if (!measuring) return
            const rect = event.currentTarget.getBoundingClientRect()
            const point = {
              x: ((event.clientX - rect.left) / rect.width) * image.width,
              y: ((event.clientY - rect.top) / rect.height) * image.height,
            }
            setPoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]))
          }}
        />
      </div>
      <fieldset className="grid grid-cols-1 gap-3 rounded-md border px-3 py-2 sm:grid-cols-3">
        <legend className="px-1 text-xs font-medium text-muted-foreground">
          Ventana y vista (no modifican el archivo)
        </legend>
        <Field>
          <FieldLabel htmlFor={`${id}-level`}>Brillo (nivel) · {Math.round(center)}</FieldLabel>
          <Slider
            id={`${id}-level`}
            aria-label="Nivel de ventana"
            value={[center]}
            min={image.range.min}
            max={image.range.max}
            step={Math.max(1, span / 200)}
            onValueChange={(v) => setCenter(sliderValue(v))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-width`}>Contraste (ancho) · {Math.round(width)}</FieldLabel>
          <Slider
            id={`${id}-width`}
            aria-label="Ancho de ventana"
            value={[width]}
            min={1}
            max={span * 2}
            step={Math.max(1, span / 200)}
            onValueChange={(v) => setWidth(sliderValue(v))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-zoom`}>Acercar · {Math.round(zoom * 100)} %</FieldLabel>
          <Slider
            id={`${id}-zoom`}
            aria-label="Acercar"
            value={[zoom]}
            min={1}
            max={4}
            step={0.1}
            onValueChange={(v) => setZoom(sliderValue(v))}
          />
        </Field>
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <Button
            type="button"
            size="sm"
            variant={invert ? "secondary" : "outline"}
            aria-pressed={invert}
            onClick={() => setInvert(!invert)}
          >
            Invertir
          </Button>
          <Button
            type="button"
            size="sm"
            variant={measuring ? "secondary" : "outline"}
            aria-pressed={measuring}
            onClick={() => {
              setMeasuring(!measuring)
              setPoints([])
            }}
          >
            Medir
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setCenter(image.window.center)
              setWidth(image.window.width)
              setInvert(false)
              setZoom(1)
              setPoints([])
            }}
          >
            Restablecer
          </Button>
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground sm:col-span-3">
          {measuring
            ? measurement
              ? `Distancia: ${measurement}. Marca otro punto para medir de nuevo.`
              : "Marca dos puntos sobre la imagen para medir la distancia."
            : "La medición usa el espaciado del detector declarado en el archivo; es orientativa."}
        </p>
      </fieldset>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
        <div>
          <dt>Modalidad</dt>
          <dd className="text-foreground">{image.meta.modality ?? "—"}</dd>
        </div>
        <div>
          <dt>Fecha del estudio</dt>
          <dd className="text-foreground">{formatDicomDate(image.meta.studyDate) ?? "—"}</dd>
        </div>
        <div>
          <dt>Equipo</dt>
          <dd className="text-foreground">{image.meta.manufacturer ?? "—"}</dd>
        </div>
        <div>
          <dt>Tamaño</dt>
          <dd className="text-foreground">
            {image.width} × {image.height} px
            {image.pixelSpacing ? ` · ${image.pixelSpacing[1]} mm/px` : ""}
            {image.frames > 1 ? ` · cuadro 1 de ${image.frames}` : ""}
          </dd>
        </div>
      </dl>
    </div>
  )
}
