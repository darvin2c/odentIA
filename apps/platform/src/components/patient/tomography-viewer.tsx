import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  FieldLabel,
  Slider,
} from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { LoadingState } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type BrightnessPreset,
  CbctTooLargeError,
  type CbctVolume,
  loadCbctVolume,
  type Plane,
  type PlaneImage,
  planeAngleDeg,
  planeCount,
  planeDistanceMm,
  planeImage,
  type WindowLevel,
  windowToRgba,
} from "../../lib/cbct-volume"
import { DicomUnsupportedError, decodeDicom, renderDicom } from "../../lib/dicom"
import { tomographyDownloadUrl } from "../../lib/imaging-upload"
import { activeOrgLocale } from "../../lib/locale"
import type { PatientDocument } from "../../lib/patients"

/**
 * Visor de tomografía a pantalla completa (ADR 0055): el volumen se arma en el
 * navegador y cada vista es un corte del volumen. Brillo por estudio, medida y
 * ángulo (orientativos), teclado y, en un celular, solo ver.
 */

export interface StudyFiles {
  sliceCount: number
  voxelMm: number | null
  files: { index: number; url: string; sizeBytes: number; seriesInstanceUid: string }[]
}

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

const PRESET_LABELS: Record<BrightnessPreset, string> = {
  hueso: "Hueso",
  diente: "Diente",
  blando: "Tejido blando",
}

const PLANE_NAMES: Record<Plane, { label: string; technical: string }> = {
  axial: { label: "Desde arriba", technical: "axial" },
  coronal: { label: "De frente", technical: "coronal" },
  sagittal: { label: "De lado", technical: "sagital" },
}

export function formatMeasure(measure: Pick<PlaneMeasure, "kind" | "value">): string {
  return measure.kind === "angulo"
    ? `${measure.value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })}°`
    : `${measure.value.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 1 })} mm`
}

/** ¿Es un teléfono? Ahí el visor solo muestra (decisión 8). */
export function useViewOnly(): boolean {
  const [viewOnly, setViewOnly] = useState(false)
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse) and (max-width: 767px)")
    const update = () => setViewOnly(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])
  return viewOnly
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

  const toImage = (event: React.MouseEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * image.width,
      y: ((event.clientY - rect.top) / rect.height) * image.height,
    }
  }
  const aspect = (image.width * image.colMm) / (image.height * image.rowMm)
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
        onKeyDown={(event) => {
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

/** Brillo: los tres del estudio y el ajuste fino en «Más». */
export function BrightnessControls({
  volume,
  preset,
  onPreset,
  window,
  onWindow,
}: {
  volume: CbctVolume
  preset: BrightnessPreset | "mas"
  onPreset: (preset: BrightnessPreset | "mas") => void
  window: WindowLevel
  onWindow: (window: WindowLevel) => void
}) {
  const id = useId()
  const span = Math.max(1, volume.range.max - volume.range.min)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Brillo</span>
      <ToggleGroup
        value={[preset]}
        onValueChange={(value: string[]) => {
          const next = value[0] as BrightnessPreset | "mas" | undefined
          if (next) onPreset(next)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        aria-label="Brillo"
      >
        {(Object.keys(PRESET_LABELS) as BrightnessPreset[]).map((key, i) => (
          <ToggleGroupItem key={key} value={key} aria-keyshortcuts={String(i + 1)}>
            {PRESET_LABELS[key]}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="mas">Más</ToggleGroupItem>
      </ToggleGroup>
      {preset === "mas" && (
        <div className="flex min-w-64 flex-1 flex-wrap gap-4">
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor={`${id}-c`}>Nivel · {Math.round(window.center)}</FieldLabel>
            <Slider
              id={`${id}-c`}
              aria-label="Nivel de ventana"
              value={[window.center]}
              min={volume.range.min}
              max={volume.range.max}
              step={Math.max(1, span / 400)}
              onValueChange={(v) => onWindow({ ...window, center: Array.isArray(v) ? (v[0] ?? 0) : (v as number) })}
            />
          </Field>
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor={`${id}-w`}>Ancho · {Math.round(window.width)}</FieldLabel>
            <Slider
              id={`${id}-w`}
              aria-label="Ancho de ventana"
              value={[window.width]}
              min={1}
              max={span * 2}
              step={Math.max(1, span / 400)}
              onValueChange={(v) => onWindow({ ...window, width: Array.isArray(v) ? (v[0] ?? 1) : (v as number) })}
            />
          </Field>
        </div>
      )}
    </div>
  )
}

/** Las tres vistas ortogonales con la retícula compartida. */
function ThreePlanes({
  volume,
  window,
  tool,
  measures,
  onMeasure,
}: {
  volume: CbctVolume
  window: WindowLevel
  tool: Tool
  measures: PlaneMeasure[]
  onMeasure: (measure: Omit<PlaneMeasure, "id">) => void
}) {
  const [point, setPoint] = useState({
    x: Math.floor(volume.nx / 2),
    y: Math.floor(volume.ny / 2),
    z: Math.floor(volume.nz / 2),
  })
  const [draft, setDraft] = useState<{ plane: Plane; points: Point[] } | null>(null)
  // Cambiar de herramienta descarta los puntos a medio marcar.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende solo de la herramienta a propósito.
  useEffect(() => setDraft(null), [tool])
  const indexOf = (plane: Plane) => (plane === "axial" ? point.z : plane === "coronal" ? point.y : point.x)
  const clamp = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.round(v)))
  const setIndex = (plane: Plane, value: number) =>
    setPoint((p) =>
      plane === "axial"
        ? { ...p, z: clamp(value, volume.nz) }
        : plane === "coronal"
          ? { ...p, y: clamp(value, volume.ny) }
          : { ...p, x: clamp(value, volume.nx) },
    )
  const images = useMemo(
    () => ({
      axial: planeImage(volume, "axial", point.z),
      coronal: planeImage(volume, "coronal", point.y),
      sagittal: planeImage(volume, "sagittal", point.x),
    }),
    [volume, point],
  )
  const crossOf = (plane: Plane): Point =>
    plane === "axial"
      ? { x: point.x, y: point.y }
      : plane === "coronal"
        ? { x: point.x, y: volume.nz - 1 - point.z }
        : { x: point.y, y: volume.nz - 1 - point.z }
  const pick = (plane: Plane, p: Point) =>
    setPoint((prev) =>
      plane === "axial"
        ? { ...prev, x: clamp(p.x, volume.nx), y: clamp(p.y, volume.ny) }
        : plane === "coronal"
          ? { ...prev, x: clamp(p.x, volume.nx), z: clamp(volume.nz - 1 - p.y, volume.nz) }
          : { ...prev, y: clamp(p.x, volume.ny), z: clamp(volume.nz - 1 - p.y, volume.nz) },
    )
  const mark = (plane: Plane, p: Point) => {
    const needed = tool === "angulo" ? 3 : 2
    const current = draft?.plane === plane ? draft.points : []
    const points = [...current, p]
    if (points.length < needed) return setDraft({ plane, points })
    const image = images[plane]
    onMeasure({
      view: plane,
      index: indexOf(plane),
      kind: tool === "angulo" ? "angulo" : "distancia",
      points,
      value:
        tool === "angulo"
          ? planeAngleDeg(image, points[0]!, points[1]!, points[2]!)
          : planeDistanceMm(image, points[0]!, points[1]!),
    })
    setDraft(null)
  }
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-slate-800 md:grid-cols-3">
      {(["axial", "coronal", "sagittal"] as const).map((plane) => (
        <div key={plane} className="flex min-h-0 min-w-0 flex-col bg-black">
          <SliceCanvas
            className="flex min-h-0 flex-1 items-center"
            image={images[plane]}
            window={window}
            label={PLANE_NAMES[plane].label}
            technical={PLANE_NAMES[plane].technical}
            cross={crossOf(plane)}
            measures={measures.filter((m) => m.view === plane && m.index === indexOf(plane))}
            draft={draft?.plane === plane ? draft.points : undefined}
            tool={tool}
            onPick={(p) => pick(plane, p)}
            onMark={(p) => mark(plane, p)}
            onStep={(delta) => setIndex(plane, indexOf(plane) + delta)}
          />
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-slate-400">
            <Slider
              aria-label={`Corte ${PLANE_NAMES[plane].label.toLowerCase()}`}
              className="flex-1"
              value={[indexOf(plane) + 1]}
              min={1}
              max={planeCount(volume, plane)}
              step={1}
              onValueChange={(v) => setIndex(plane, (Array.isArray(v) ? (v[0] ?? 1) : (v as number)) - 1)}
            />
            <span className="w-24 text-right tabular-nums">
              {indexOf(plane) + 1} de {planeCount(volume, plane)}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Carga de los archivos y del volumen, con su avance y sus fallos. */
export function useCbctVolume(patientId: string, documentId: string) {
  const files = useQuery({
    queryKey: ["imaging-study-files", patientId, documentId],
    queryFn: () => apiFetch<{ data: StudyFiles }>(`/api/patients/${patientId}/imaging/studies/${documentId}/files`),
    staleTime: 30 * 60 * 1000,
  })
  const [volume, setVolume] = useState<CbctVolume | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  // `attempt` vuelve a cargar al pedir «Reintentar».
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` es la señal de reintento.
  useEffect(() => {
    const sources = files.data?.data.files
    if (!sources) return
    const controller = new AbortController()
    setError(null)
    setProgress({ done: 0, total: sources.length })
    loadCbctVolume(documentId, sources, { onProgress: setProgress, signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setVolume(loaded)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e)
      })
    return () => controller.abort()
  }, [files.data, documentId, attempt])
  return {
    files,
    volume,
    progress,
    error: error ?? files.error,
    retry: () => {
      setAttempt((n) => n + 1)
      void files.refetch()
    },
  }
}

/**
 * Sin memoria para el volumen (tablero 9): los cortes de la serie mayor de a
 * uno, decodificados al pedirlos, con su propia ventana.
 */
function SingleSlices({ files }: { files: StudyFiles["files"] }) {
  const series = useMemo(() => {
    const counts = new Map<string, number>()
    for (const f of files) counts.set(f.seriesInstanceUid, (counts.get(f.seriesInstanceUid) ?? 0) + 1)
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return files.filter((f) => f.seriesInstanceUid === main)
  }, [files])
  const [index, setIndex] = useState(Math.floor(series.length / 2))
  const ref = useRef<HTMLCanvasElement | null>(null)
  const file = series[index]
  const slice = useQuery({
    queryKey: ["cbct-single-slice", file?.url],
    queryFn: async () => {
      const response = await fetch(file!.url)
      if (!response.ok) throw new Error("No se pudo leer el corte")
      return decodeDicom(await response.arrayBuffer())
    },
    enabled: Boolean(file),
    placeholderData: keepPreviousData,
  })
  useEffect(() => {
    const image = slice.data
    const canvas = ref.current
    if (!image || !canvas) return
    canvas.width = image.width
    canvas.height = image.height
    canvas
      .getContext("2d")
      ?.putImageData(
        new ImageData(new Uint8ClampedArray(renderDicom(image, { ...image.window, invert: false })), image.width, image.height),
        0,
        0,
      )
  }, [slice.data])
  const step = (delta: number) => setIndex((i) => Math.max(0, Math.min(series.length - 1, i + delta)))
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 p-4">
      <canvas
        ref={ref}
        role="img"
        aria-label={`Corte ${index + 1} de ${series.length}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: el corte se recorre con las flechas del teclado.
        tabIndex={0}
        className="max-h-[70dvh] max-w-full object-contain"
        onWheel={(event) => step(event.deltaY > 0 ? 1 : -1)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") step(-1)
          if (event.key === "ArrowDown") step(1)
        }}
      />
      <div className="flex w-full max-w-xl items-center gap-3 text-xs text-slate-400">
        <Slider
          aria-label="Corte"
          className="flex-1"
          value={[index + 1]}
          min={1}
          max={series.length}
          step={1}
          onValueChange={(v) => setIndex((Array.isArray(v) ? (v[0] ?? 1) : (v as number)) - 1)}
        />
        <span className="tabular-nums">
          {index + 1} de {series.length}
        </span>
      </div>
    </div>
  )
}

export function VolumeLoadError({
  error,
  patientId,
  documentId,
  onRetry,
  onSingle,
}: {
  error: unknown
  patientId: string
  documentId: string
  onRetry: () => void
  /** Sin memoria: ver los cortes de a uno. */
  onSingle?: () => void
}) {
  const tooLarge = error instanceof CbctTooLargeError
  const message = tooLarge
    ? "Esta computadora no tiene memoria suficiente para armar la tomografía. Ábrela en otra computadora o descárgala para el programa del equipo."
    : error instanceof DicomUnsupportedError
      ? error.message
      : error instanceof ApiError
        ? (error.shape.message ?? "No se pudo abrir la tomografía.")
        : "No se pudo abrir la tomografía. Revisa la conexión y vuelve a intentarlo."
  return (
    <div role="alert" className="m-auto flex max-w-md flex-col gap-3 rounded-xl border border-slate-700 p-5 text-sm">
      <p className="font-semibold">
        {tooLarge ? "Esta computadora no puede armar la tomografía" : "No podemos mostrar esta tomografía"}
      </p>
      <p className="text-slate-300">{message}</p>
      <div className="flex flex-wrap gap-2">
        {!tooLarge && (
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Reintentar
          </Button>
        )}
        {tooLarge && onSingle && (
          <Button type="button" size="sm" variant="outline" onClick={onSingle}>
            Ver cortes uno por uno
          </Button>
        )}
        <a
          href={tomographyDownloadUrl(patientId, documentId)}
          download
          className="inline-flex items-center rounded-full border border-slate-600 px-3 py-1.5 text-sm font-medium"
        >
          Descargar
        </a>
      </div>
    </div>
  )
}

export const MEASURE_NOTE = (voxelMm: number | null) =>
  `Medidas orientativas${voxelMm ? `, con el tamaño de vóxel del archivo (${voxelMm.toLocaleString(activeOrgLocale(), { maximumFractionDigits: 2 })} mm)` : ""}. Para planificar una cirugía, confírmalas en el programa del equipo.`

/** Pantalla completa del visor. `children` permite agregar vistas (la panorámica). */
export function TomographyViewer({
  patientId,
  doc,
  open,
  onClose,
  onDetails,
}: {
  patientId: string
  doc: PatientDocument
  open: boolean
  onClose: () => void
  /** Abre el detalle del documento (informe, contexto, retiro). */
  onDetails?: () => void
}) {
  const loaded = useCbctVolume(patientId, doc.id)
  const volume = loaded.volume
  const viewOnly = useViewOnly()
  const [preset, setPreset] = useState<BrightnessPreset | "mas">("hueso")
  const [custom, setCustom] = useState<WindowLevel | null>(null)
  const [tool, setTool] = useState<Tool>("ninguna")
  const [measures, setMeasures] = useState<PlaneMeasure[]>([])
  const [single, setSingle] = useState(false)
  const window = volume ? (preset === "mas" ? (custom ?? volume.presets.hueso) : volume.presets[preset]) : null

  useEffect(() => {
    if (!open || !volume) return
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      if (event.key === "1") setPreset("hueso")
      else if (event.key === "2") setPreset("diente")
      else if (event.key === "3") setPreset("blando")
      else if (!viewOnly && (event.key === "m" || event.key === "M")) setTool((t) => (t === "medir" ? "ninguna" : "medir"))
      else if (!viewOnly && (event.key === "a" || event.key === "A")) setTool((t) => (t === "angulo" ? "ninguna" : "angulo"))
      else if (event.key === "Escape" && tool !== "ninguna") {
        event.preventDefault()
        setTool("ninguna")
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, volume, viewOnly, tool])

  const voxel = doc.imaging?.voxelMm ?? volume?.sx ?? null
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="dark top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-[#05080c] p-0 text-slate-100 sm:max-w-none"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm font-semibold">{doc.label}</DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              {doc.imaging ? `${doc.imaging.sliceCount.toLocaleString(activeOrgLocale())} cortes` : ""}
              {doc.source ? ` · ${doc.source}` : ""}
              {" · Tres cortes"}
            </DialogDescription>
          </div>
          {onDetails && (
            <Button type="button" size="sm" variant="ghost" onClick={onDetails}>
              Detalles e informe
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            <X aria-hidden="true" />
            Cerrar
          </Button>
        </div>
        {single && loaded.files.data ? (
          <SingleSlices files={loaded.files.data.data.files} />
        ) : loaded.error ? (
          <VolumeLoadError
            error={loaded.error}
            patientId={patientId}
            documentId={doc.id}
            onRetry={loaded.retry}
            onSingle={loaded.files.data ? () => setSingle(true) : undefined}
          />
        ) : !volume || !window ? (
          <div className="m-auto w-full max-w-sm">
            <LoadingState
              message={
                loaded.progress && loaded.progress.total
                  ? `Abriendo ${loaded.progress.total.toLocaleString(activeOrgLocale())} cortes… ${Math.floor((loaded.progress.done / loaded.progress.total) * 100)} %`
                  : "Abriendo la tomografía…"
              }
            />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-800 px-4 py-2">
              <BrightnessControls
                volume={volume}
                preset={preset}
                onPreset={(next) => {
                  if (next === "mas") setCustom(window)
                  setPreset(next)
                }}
                window={window}
                onWindow={setCustom}
              />
              {!viewOnly && (
                <ToggleGroup
                  value={tool === "ninguna" ? [] : [tool]}
                  onValueChange={(value: string[]) => setTool((value[0] as Tool | undefined) ?? "ninguna")}
                  variant="outline"
                  size="sm"
                  aria-label="Herramienta"
                >
                  <ToggleGroupItem value="medir" aria-keyshortcuts="M">
                    Medir
                  </ToggleGroupItem>
                  <ToggleGroupItem value="angulo" aria-keyshortcuts="A">
                    Ángulo
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPreset("hueso")
                  setTool("ninguna")
                  setMeasures([])
                }}
              >
                Restablecer
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <ThreePlanes
                volume={volume}
                window={window}
                tool={tool}
                measures={measures}
                onMeasure={(m) => setMeasures((prev) => [...prev, { ...m, id: crypto.randomUUID() }])}
              />
              <aside className="flex w-full shrink-0 flex-col gap-3 border-t border-slate-800 bg-[#0d131b] p-4 text-sm lg:w-72 lg:border-t-0 lg:border-l">
                <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Medidas</h3>
                {measures.length === 0 ? (
                  <p className="text-slate-400">
                    {viewOnly
                      ? "Para medir, abre la tomografía en una computadora o una tablet."
                      : "Elige «Medir» y marca dos puntos, o «Ángulo» y marca tres."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {measures.map((m) => (
                      <li key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-900 px-2.5 py-1.5">
                        <span className="text-slate-300">
                          {m.kind === "angulo" ? "Ángulo" : "Distancia"} ·{" "}
                          {PLANE_NAMES[m.view as Plane]?.label.toLowerCase() ?? m.view}
                        </span>
                        <span className="flex items-center gap-1">
                          <b className="text-amber-400 tabular-nums">{formatMeasure(m)}</b>
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Quitar la medida"
                            onClick={() => setMeasures((prev) => prev.filter((x) => x.id !== m.id))}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-slate-400">{MEASURE_NOTE(voxel)}</p>
                <p className="text-xs text-slate-500">
                  Rueda o ↑ ↓ para avanzar · 1, 2 y 3 cambian el brillo{viewOnly ? "" : " · M mide · A ángulo"}
                </p>
              </aside>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
