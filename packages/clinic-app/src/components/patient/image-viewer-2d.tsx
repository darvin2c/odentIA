import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Slider,
} from "@odentia/ui"
import { LoadingState } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetchBytes } from "../../lib/api"
import {
  type DicomImage,
  DicomUnsupportedError,
  distanceMm,
  measurableSpacing,
  openDicom,
  renderDicom,
  spacingIssueText,
} from "../../lib/dicom"
import { dicomDate } from "../../lib/clinical-journey"
import { activeOrgLocale } from "../../lib/locale"
import { useZoomPan } from "../../lib/use-zoom-pan"
import {
  fromOriented,
  nextTurn,
  type Orientation,
  orientContext,
  orientedSize,
  type Point,
  sliderValue,
  toOriented,
  UPRIGHT,
} from "../../lib/view-transform"
import { filterOf } from "./image-viewer"
import { ZoomControls } from "./viewer-shell"

/**
 * El visor de una radiografía o una foto (JPG, PNG, WebP o DICOM), dentro del
 * armazón oscuro: la imagen a todo el alto, acercar con dos dedos, Ctrl + rueda
 * o doble clic, brillo y contraste a la vista y lo poco frecuente en «Más».
 * Todo es para mirar: el archivo no cambia. Medir en mm solo donde el archivo
 * trae una escala que vale (`measureSpacing`); si no, se dice al intentarlo.
 */

export interface View2D {
  /** % (100 = como viene). */
  brightness: number
  /** % (100 = como viene). */
  contrast: number
  invert: boolean
  orientation: Orientation
}

export const DEFAULT_VIEW: View2D = {
  brightness: 100,
  contrast: 100,
  invert: false,
  orientation: UPRIGHT,
}

function isDefault(view: View2D): boolean {
  return (
    view.brightness === 100 &&
    view.contrast === 100 &&
    !view.invert &&
    view.orientation.turns === 0 &&
    !view.orientation.flip
  )
}

/**
 * La ventana de un DICOM según el brillo y el contraste de pantalla: más brillo
 * baja el nivel, más contraste angosta el ancho (PS3.3 C.11.2.1.2).
 */
export function windowFor(
  image: Pick<DicomImage, "window">,
  view: Pick<View2D, "brightness" | "contrast">,
) {
  const { center, width } = image.window
  return {
    center: center - ((view.brightness - 100) / 100) * (width / 2),
    width: Math.max(1, (width * 100) / view.contrast),
  }
}

type Source =
  | { kind: "image"; element: HTMLImageElement; width: number; height: number }
  | { kind: "dicom"; image: DicomImage; width: number; height: number }

/** Punto del lienzo (en px de la pantalla) en px del lienzo, con la imagen ajustada sin recortar. */
function canvasPoint(
  event: React.MouseEvent<HTMLCanvasElement>,
  canvasWidth: number,
  canvasHeight: number,
): Point {
  const rect = event.currentTarget.getBoundingClientRect()
  const aspect = canvasWidth / canvasHeight
  let width = rect.width
  let height = rect.width / aspect
  if (height > rect.height) {
    height = rect.height
    width = height * aspect
  }
  const left = rect.left + (rect.width - width) / 2
  const top = rect.top + (rect.height - height) / 2
  return {
    x: ((event.clientX - left) / width) * canvasWidth,
    y: ((event.clientY - top) / height) * canvasHeight,
  }
}

/** La imagen orientada en el lienzo, con la medida encima. */
function Stage({
  source,
  view,
  label,
  points,
  measuring,
  onPoint,
  measurement,
}: {
  source: Source
  view: View2D
  label: string
  points: Point[]
  measuring: boolean
  onPoint: (point: Point) => void
  measurement: string | null
}) {
  const zoom = useZoomPan({ arrowPan: true, canToggle: () => !measuring })
  const ref = useRef<HTMLCanvasElement | null>(null)
  const size = orientedSize(source.width, source.height, view.orientation)
  // La ventana del DICOM se calcula solo cuando cambian el cuadro, el brillo, el contraste o el negativo:
  // girar, voltear o marcar un punto vuelven a dibujar sin recorrer los píxeles.
  const flat = useMemo(() => {
    if (source.kind !== "dicom") return null
    const pixels = renderDicom(source.image, {
      ...windowFor(source.image, { brightness: view.brightness, contrast: view.contrast }),
      invert: view.invert,
    })
    const canvas = document.createElement("canvas")
    canvas.width = source.width
    canvas.height = source.height
    canvas
      .getContext("2d")
      ?.putImageData(
        new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, source.width, source.height),
        0,
        0,
      )
    return canvas
  }, [source, view.brightness, view.contrast, view.invert])
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    orientContext(ctx, source.width, source.height, view.orientation)
    if (source.kind === "image") ctx.drawImage(source.element, 0, 0)
    else if (flat) ctx.drawImage(flat, 0, 0)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (points.length) {
      const unit = Math.max(1, size.width / 400)
      const shown = points.map((p) => toOriented(p, source.width, source.height, view.orientation))
      ctx.strokeStyle = "#f59e0b"
      ctx.fillStyle = "#f59e0b"
      ctx.lineWidth = unit
      for (const p of shown) {
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(2, size.width / 200), 0, Math.PI * 2)
        ctx.fill()
      }
      if (shown.length === 2) {
        ctx.beginPath()
        ctx.moveTo(shown[0]!.x, shown[0]!.y)
        ctx.lineTo(shown[1]!.x, shown[1]!.y)
        ctx.stroke()
      }
    }
  }, [source, flat, view.orientation, points, size.width, size.height])

  // En una foto, brillo, contraste y negativo los pone el navegador; en un DICOM, la ventana.
  const filter = source.kind === "image" ? filterOf(view) : undefined
  return (
    // biome-ignore lint/a11y/useSemanticElements: el marco recibe el foco y los gestos; un fieldset no.
    <div
      ref={zoom.frameRef}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: la imagen ampliada se recorre con el teclado.
      tabIndex={0}
      role="group"
      aria-label={`${label}. Dos dedos, Ctrl + rueda o doble clic acercan; con la imagen ampliada, arrastra o usa las flechas.`}
      className="relative min-h-0 flex-1 touch-none overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-inset"
    >
      <div className="absolute inset-0" style={zoom.contentStyle}>
        <canvas
          ref={ref}
          role="img"
          aria-label={`${label}${measurement ? `; medida ${measurement}` : ""}`}
          className={`block h-full w-full object-contain ${measuring ? "cursor-crosshair" : ""}`}
          style={{ filter }}
          onClick={(event) => {
            // El segundo clic de un doble clic no marca otro punto en el mismo lugar.
            if (zoom.consumeDrag() || !measuring || event.detail > 1) return
            const p = canvasPoint(event, size.width, size.height)
            onPoint(fromOriented(p, source.width, source.height, view.orientation))
          }}
        />
      </div>
      {view.orientation.flip && (
        <span className="absolute top-2 left-2 rounded-md bg-black/75 px-2 py-1 text-xs font-medium text-amber-200">
          Volteada: es la imagen en espejo del archivo
        </span>
      )}
      <span className="absolute bottom-3 left-3 hidden text-xs text-slate-400 md:block">
        Ctrl + rueda o dos dedos acercan · doble clic ajusta
      </span>
      <ZoomControls zoom={zoom} className="absolute right-3 bottom-3" />
    </div>
  )
}

function useImageElement(url: string | null) {
  const [state, setState] = useState<{ element: HTMLImageElement | null; error: boolean }>({
    element: null,
    error: false,
  })
  useEffect(() => {
    if (!url) return
    let alive = true
    setState({ element: null, error: false })
    const element = new Image()
    element.decoding = "async"
    element.onload = () => alive && setState({ element, error: false })
    element.onerror = () => alive && setState({ element: null, error: true })
    element.src = url
    return () => {
      alive = false
    }
  }, [url])
  return state
}

function useDicomFrames(patientId: string, documentId: string, enabled: boolean) {
  const [frame, setFrame] = useState(0)
  const bytes = useQuery({
    queryKey: ["patient-document-dicom", patientId, documentId],
    queryFn: () => apiFetchBytes(`/api/patients/${patientId}/documents/${documentId}/content`),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    enabled,
  })
  // La cabecera se lee una vez por archivo; cada cuadro se decodifica al pedirlo y el anterior sigue a
  // la vista mientras tanto. Los cuadros ya vistos no se guardan: se vuelven a decodificar.
  const file = useMemo(() => {
    if (!bytes.data) return null
    try {
      return { ok: openDicom(bytes.data) } as const
    } catch (error) {
      return { error } as const
    }
  }, [bytes.data])
  const query = useQuery({
    queryKey: ["patient-document-dicom-frame", patientId, documentId, frame],
    queryFn: () => {
      if (!file) throw new Error("El archivo aún no llega")
      if ("error" in file) throw file.error
      return file.ok.decode(frame)
    },
    enabled: enabled && Boolean(file),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
  })
  // Si un cuadro falla, sigue a la vista el último que se pudo mostrar.
  const last = useRef<DicomImage | undefined>(undefined)
  if (query.data) last.current = query.data
  return {
    frame,
    setFrame,
    image: query.data ?? last.current,
    query,
    failure: bytes.error ?? query.error,
  }
}

function failureText(error: unknown): string {
  return error instanceof DicomUnsupportedError
    ? error.message
    : error instanceof ApiError
      ? (error.shape.message ?? "No se pudo leer el archivo.")
      : "El archivo no es un DICOM legible. Descárgalo para abrirlo en el programa del equipo."
}

export function ImageViewer2D({
  patientId,
  documentId,
  url,
  dicom,
  label,
  imageType,
  photo: isPhoto = false,
}: {
  patientId: string
  documentId: string
  /** URL firmada de la foto (JPG, PNG o WebP). */
  url: string | null
  dicom: boolean
  label: string
  /** Qué es, según la ficha: decide si se mide en mm. */
  imageType?: string | null
  /** Una foto clínica no trae escala; se dice distinto que en una radiografía. */
  photo?: boolean
}) {
  const id = useId()
  const [view, setView] = useState<View2D>(DEFAULT_VIEW)
  const [measuring, setMeasuring] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const photo = useImageElement(dicom ? null : url)
  const frames = useDicomFrames(patientId, documentId, dicom)
  // Otro archivo vuelve a montar el visor (`key`): empieza ajustado y como viene.
  const stopMeasuring = () => {
    setMeasuring(false)
    setPoints([])
    setNotice(null)
  }

  const source = useMemo<Source | null>(() => {
    if (dicom)
      return frames.image
        ? {
            kind: "dicom",
            image: frames.image,
            width: frames.image.width,
            height: frames.image.height,
          }
        : null
    return photo.element
      ? {
          kind: "image",
          element: photo.element,
          width: photo.element.naturalWidth,
          height: photo.element.naturalHeight,
        }
      : null
  }, [dicom, frames.image, photo.element])

  const image = dicom ? frames.image : undefined
  // La escala con que se mide: la del archivo, según lo que la ficha dice que es.
  const scale = image
    ? measurableSpacing(image, imageType)
    : { spacing: null, issue: isPhoto ? ("foto" as const) : ("sin_espaciado" as const) }
  const measurement = useMemo(() => {
    if (!scale.spacing || points.length !== 2) return null
    const mm = distanceMm({ pixelSpacing: scale.spacing }, points[0]!, points[1]!)
    return mm === null
      ? null
      : `${mm.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })} mm`
  }, [scale.spacing, points])

  const startMeasuring = () => {
    if (measuring) {
      stopMeasuring()
      return
    }
    // Medir queda a la vista; si aquí no se puede, se dice al intentarlo, con la salida.
    if (!scale.spacing) {
      setNotice(spacingIssueText(scale.issue))
      return
    }
    setMeasuring(true)
    setPoints([])
    setNotice("Marca dos puntos sobre la imagen.")
  }
  const addPoint = (p: Point) => {
    const next = points.length >= 2 ? [p] : [...points, p]
    setPoints(next)
    if (next.length === 1) setNotice("Marca el segundo punto.")
    else setNotice(null)
  }

  if (dicom && frames.failure && (!image || image.frames === 1)) {
    return (
      <div
        role="alert"
        className="m-auto flex max-w-md flex-col gap-2 rounded-xl border border-slate-700 p-5 text-sm"
      >
        <p className="font-semibold">No se puede mostrar esta radiografía</p>
        <p className="text-slate-300">{failureText(frames.failure)}</p>
      </div>
    )
  }
  if (!dicom && photo.error) {
    return (
      <p role="alert" className="m-auto p-6 text-sm text-slate-300">
        No se pudo abrir la imagen. Revisa la conexión y vuelve a intentarlo.
      </p>
    )
  }
  if (!source) {
    return (
      <div className="m-auto w-full max-w-sm">
        <LoadingState message={dicom ? "Abriendo la radiografía…" : "Abriendo la imagen…"} />
      </div>
    )
  }
  const frameFailed = Boolean(image && frames.query.isError && image.frame !== frames.frame)
  const goTo = (next: number) => {
    if (!image) return
    frames.setFrame(Math.min(image.frames - 1, Math.max(0, next)))
    setPoints([])
  }
  const status =
    measurement !== null
      ? `${measurement} · orientativa. Marca otro punto para medir de nuevo.`
      : notice

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-800 px-3 py-2 sm:px-4">
        <div className="flex min-w-36 flex-1 items-center gap-2 sm:max-w-56">
          <span id={`${id}-b`} className="text-xs text-slate-400">
            Brillo
          </span>
          <Slider
            aria-labelledby={`${id}-b`}
            className="flex-1"
            value={[view.brightness]}
            min={40}
            max={200}
            step={5}
            onValueChange={(v) => setView((s) => ({ ...s, brightness: sliderValue(v) }))}
          />
        </div>
        <div className="flex min-w-36 flex-1 items-center gap-2 sm:max-w-56">
          <span id={`${id}-c`} className="text-xs text-slate-400">
            Contraste
          </span>
          <Slider
            aria-labelledby={`${id}-c`}
            className="flex-1"
            value={[view.contrast]}
            min={40}
            max={250}
            step={5}
            onValueChange={(v) => setView((s) => ({ ...s, contrast: sliderValue(v) }))}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant={measuring ? "secondary" : "outline"}
          aria-pressed={measuring}
          onClick={startMeasuring}
        >
          Medir
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type="button" size="sm" variant="outline" />}>
            Más
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuCheckboxItem
              checked={view.invert}
              onCheckedChange={(checked) => setView((s) => ({ ...s, invert: Boolean(checked) }))}
            >
              Negativo
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem
              onClick={() =>
                setView((s) => ({
                  ...s,
                  orientation: { ...s.orientation, turns: nextTurn(s.orientation.turns) },
                }))
              }
            >
              Girar a la derecha
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={view.orientation.flip}
              onCheckedChange={(checked) =>
                setView((s) => ({
                  ...s,
                  orientation: { ...s.orientation, flip: Boolean(checked) },
                }))
              }
            >
              Voltear
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={isDefault(view) && points.length === 0}
              onClick={() => {
                setView(DEFAULT_VIEW)
                stopMeasuring()
              }}
            >
              Restablecer
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <p
          aria-live="polite"
          className="min-w-0 basis-full text-xs text-amber-200 empty:hidden lg:basis-auto"
        >
          {status}
        </p>
      </div>
      <Stage
        source={source}
        view={view}
        label={label}
        points={points}
        measuring={measuring}
        onPoint={addPoint}
        measurement={measurement}
      />
      {image && image.frames > 1 && (
        <fieldset className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-3 py-2 sm:px-4">
          <legend className="sr-only">Cuadros</legend>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => goTo(frames.frame - 1)}
            disabled={frames.frame === 0}
          >
            <ChevronLeft aria-hidden="true" />
            Anterior
          </Button>
          <Slider
            aria-label="Cuadro"
            className="min-w-32 flex-1"
            value={[frames.frame + 1]}
            min={1}
            max={image.frames}
            step={1}
            onValueChange={(v) => goTo(sliderValue(v) - 1)}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => goTo(frames.frame + 1)}
            disabled={frames.frame === image.frames - 1}
          >
            Siguiente
            <ChevronRight aria-hidden="true" />
          </Button>
          <p aria-live="polite" className="w-full text-xs text-slate-400 sm:w-auto">
            {frames.query.isFetching
              ? `Abriendo el cuadro ${frames.frame + 1}…`
              : `Cuadro ${image.frame + 1} de ${image.frames}`}
          </p>
          {frameFailed && (
            <p role="alert" className="w-full text-xs text-red-300">
              No se pudo mostrar el cuadro {frames.frame + 1}; sigue a la vista el cuadro{" "}
              {image.frame + 1}.
              {frames.query.error instanceof DicomUnsupportedError
                ? ` ${frames.query.error.message}`
                : ""}
            </p>
          )}
        </fieldset>
      )}
    </div>
  )
}

/** Lo técnico del DICOM, para «Detalles»: no estorba a la imagen. */
export function DicomFacts({ patientId, documentId }: { patientId: string; documentId: string }) {
  const frames = useDicomFrames(patientId, documentId, true)
  const image = frames.image
  if (!image) return null
  const date = dicomDate(image.meta.studyDate) ?? image.meta.studyDate
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm">
      {date && (
        <div>
          <dt className="text-xs text-muted-foreground">Fecha del estudio</dt>
          <dd>{date}</dd>
        </div>
      )}
      {image.meta.manufacturer && (
        <div>
          <dt className="text-xs text-muted-foreground">Equipo</dt>
          <dd>{image.meta.manufacturer}</dd>
        </div>
      )}
      <div>
        <dt className="text-xs text-muted-foreground">Tamaño</dt>
        <dd>
          {image.width.toLocaleString(activeOrgLocale())} ×{" "}
          {image.height.toLocaleString(activeOrgLocale())} px
          {image.pixelSpacing
            ? ` · ${image.pixelSpacing[1].toLocaleString(activeOrgLocale())} mm por píxel`
            : ""}
          {image.frames > 1 ? ` · ${image.frames} cuadros` : ""}
        </dd>
      </div>
    </dl>
  )
}
