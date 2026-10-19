import { Button, Field, FieldLabel, Slider } from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetchBytes } from "../../lib/api"
import {
  type DicomImage,
  DicomUnsupportedError,
  decodeDicom,
  distanceMm,
  renderDicom,
} from "../../lib/dicom"
import { activeOrgLocale } from "../../lib/locale"

type Point = { x: number; y: number }

function sliderValue(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number)
}

function formatDicomDate(value: string | null): string | null {
  if (!value || !/^\d{8}$/.test(value)) return value
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00`,
  ).toLocaleDateString(activeOrgLocale(), { dateStyle: "medium" })
}

/**
 * Visor DICOM 2D básico: ventana (nivel y ancho, que en radiografía hacen de
 * brillo y contraste), zoom, inversión, medición de distancias en mm con el
 * espaciado del detector y paso entre cuadros. Los ajustes son de pantalla: el
 * archivo no cambia y se conservan al cambiar de cuadro. La tomografía
 * volumétrica no se reconstruye aquí.
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
  const [frame, setFrame] = useState(0)
  const bytes = useQuery({
    queryKey: ["patient-document-dicom", patientId, documentId],
    queryFn: () => apiFetchBytes(`/api/patients/${patientId}/documents/${documentId}/content`),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  // Cada cuadro se decodifica al pedirlo; el anterior sigue a la vista mientras tanto.
  const query = useQuery({
    queryKey: ["patient-document-dicom-frame", patientId, documentId, frame],
    queryFn: () => {
      if (!bytes.data) throw new Error("El archivo aún no llega")
      return decodeDicom(bytes.data, frame)
    },
    enabled: bytes.isSuccess,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    placeholderData: keepPreviousData,
  })
  // Si un cuadro falla, sigue a la vista el último que se pudo mostrar.
  const lastImage = useRef<DicomImage | undefined>(undefined)
  if (query.data) lastImage.current = query.data
  const image = query.data ?? lastImage.current
  const [center, setCenter] = useState<number | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [invert, setInvert] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [measuring, setMeasuring] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  // La ventana sugerida se toma del primer cuadro y no cambia al pasar de cuadro.
  useEffect(() => {
    if (!image || center !== null) return
    setCenter(image.window.center)
    setWidth(image.window.width)
  }, [image, center])
  const goTo = (next: number) => {
    if (!image) return
    setFrame(Math.min(image.frames - 1, Math.max(0, next)))
    setPoints([])
  }

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

  const failure = bytes.error ?? query.error
  if (failure && (!image || image.frames === 1)) {
    const error = failure
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
  if (!image) return <LoadingState message="Abriendo el DICOM…" />
  if (center === null || width === null) return null
  const frameFailed = query.isError && image.frame !== frame

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* scroll-nativo: visor con zoom; se recorre arrastrando y con el teclado sobre la imagen ampliada. */}
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
      {image.frames > 1 && (
        <fieldset className="flex flex-wrap items-center gap-2">
          <legend className="sr-only">Cuadros</legend>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => goTo(frame - 1)}
            disabled={frame === 0}
          >
            <ChevronLeft aria-hidden />
            Anterior
          </Button>
          <Slider
            aria-label="Cuadro"
            className="min-w-32 flex-1"
            value={[frame + 1]}
            min={1}
            max={image.frames}
            step={1}
            onValueChange={(v) => goTo(sliderValue(v) - 1)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => goTo(frame + 1)}
            disabled={frame === image.frames - 1}
          >
            Siguiente
            <ChevronRight aria-hidden />
          </Button>
          <p aria-live="polite" className="w-full text-xs text-muted-foreground sm:w-auto">
            {query.isFetching
              ? `Abriendo el cuadro ${frame + 1}…`
              : `Cuadro ${image.frame + 1} de ${image.frames}`}
          </p>
          {frameFailed && (
            <p role="alert" className="w-full text-xs text-destructive">
              No se pudo mostrar el cuadro {frame + 1}; sigue a la vista el cuadro {image.frame + 1}.
              {query.error instanceof DicomUnsupportedError ? ` ${query.error.message}` : ""}
            </p>
          )}
        </fieldset>
      )}
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
            {image.frames > 1 ? ` · ${image.frames} cuadros` : ""}
          </dd>
        </div>
      </dl>
    </div>
  )
}
