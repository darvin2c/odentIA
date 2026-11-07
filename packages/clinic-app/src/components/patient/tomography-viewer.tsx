import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Slider,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@odentia/ui"
import { DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@odentia/ui/components/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { LoadingState, ViewTabs } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronDown, ChevronLeft } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  CbctTooLargeError,
  type CbctVolume,
  loadCbctVolume,
  type Plane,
  planeAngleDeg,
  planeCount,
  planeDistanceMm,
  planeImage,
  type WindowLevel,
} from "../../lib/cbct-volume"
import { canReconstruct, readSeriesInfo, seriesDetail, seriesName, type StudySeries, studySeries } from "../../lib/cbct-series"
import { cbctWindows, ctWindows, type ViewWindow } from "../../lib/ct-windows"
import { DicomUnsupportedError, decodeDicom, renderDicom } from "../../lib/dicom"
import { tomographyDownloadUrl } from "../../lib/imaging-upload"
import { CT_MEASURE_NOTE, MEASURE_NOTE, MeasureList, type SavedMeasures, useSavedMeasures, type Vec3 } from "./tomography-measures"
import { detectArch } from "../../lib/cbct-arch"
import { PanoramicView, type SavedArch } from "./tomography-panoramic"
import { MEASURE_KEYS_HINT, type PlaneMeasure, type Point, SliceCanvas, type Tool } from "./tomography-slice"
import { Tomography3D } from "./tomography-3d"
import { usePatientName, ViewerShell } from "./viewer-shell"
import { formatDate } from "../../lib/clinical-journey"
import { activeOrgLocale } from "../../lib/locale"
import { categoryLabel, imageTypeLabel, reportStatusLabel, takenAt, tomographyKind } from "./document-labels"
import type { PatientDocument } from "../../lib/patients"

/**
 * Visor de tomografía a pantalla completa (ADR 0056 y 0147): el volumen se arma
 * en el navegador y cada vista es un corte del volumen; el 3D es solo para
 * mostrar. Brillo por estudio, medida y ángulo (orientativos), acercar en cada
 * vista, teclado y, en un celular, solo ver: una vista grande a la vez.
 */

export interface StudyFiles {
  sliceCount: number
  voxelMm: number | null
  files: { index: number; url: string; sizeBytes: number; seriesInstanceUid: string }[]
  /** El arco ajustado a mano, si alguien lo guardó. */
  arch?: SavedArch
}

const PLANE_NAMES: Record<Plane, { label: string; technical: string }> = {
  axial: { label: "Desde arriba", technical: "axial" },
  coronal: { label: "De frente", technical: "coronal" },
  sagittal: { label: "De lado", technical: "sagital" },
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

/**
 * Brillo o ventana: los del estudio en la CBCT, las ventanas en HU en la tomografía médica
 * (`lib/ct-windows.ts`), y el ajuste fino.
 */
export function BrightnessControls({
  volume,
  label,
  options,
  preset,
  onPreset,
  window,
  onWindow,
}: {
  volume: CbctVolume
  /** «Brillo» en la CBCT; «Ventana» en la tomografía médica, como se dice en radiología. */
  label: string
  options: readonly ViewWindow[]
  /** La clave de una opción, o «mas» para el ajuste fino. */
  preset: string
  onPreset: (preset: string) => void
  window: WindowLevel
  onWindow: (window: WindowLevel) => void
}) {
  const id = useId()
  const span = Math.max(1, volume.range.max - volume.range.min)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">{label}</span>
      <ToggleGroup
        value={[preset]}
        onValueChange={(value: string[]) => {
          const next = value[0]
          if (next) onPreset(next)
        }}
        variant="outline"
        size="sm"
        spacing={0}
        aria-label={label}
      >
        {options.map((option, i) => (
          <ToggleGroupItem key={option.key} value={option.key} aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}>
            {option.label}
          </ToggleGroupItem>
        ))}
        <ToggleGroupItem value="mas">Ajuste fino</ToggleGroupItem>
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
const VIEW_OF: Record<Plane, "axial" | "coronal" | "sagital"> = {
  axial: "axial",
  coronal: "coronal",
  sagittal: "sagital",
}

function ThreePlanes({
  volume,
  window,
  tool,
  saved,
  show3d,
  onExpand3d,
  onStopTool,
  atTeeth,
}: {
  volume: CbctVolume
  window: WindowLevel
  tool: Tool
  /** La CBCT abre a la altura de los dientes; la tomografía médica, en el corte del medio. */
  atTeeth: boolean
  /** Esc mientras se mide: termina de medir. */
  onStopTool: () => void
  saved: SavedMeasures
  /** El cuarto cuadro: el 3D para mostrar (en la computadora). */
  show3d: boolean
  /** «Ver grande» del cuarto cuadro: la pestaña «3D». */
  onExpand3d?: () => void
}) {
  // Abre a la altura de los dientes: el corte del medio de una tomografía de campo
  // grande cae en la nariz o en la base del cráneo.
  const [point, setPoint] = useState(() => ({
    x: Math.floor(volume.nx / 2),
    y: Math.floor(volume.ny / 2),
    z: (atTeeth ? detectArch(volume)?.z : undefined) ?? Math.floor(volume.nz / 2),
  }))
  // El borrador es de un corte: cambiar de corte a mitad de una medida la empieza de nuevo.
  const [draft, setDraft] = useState<{ plane: Plane; at: number; points: Point[] } | null>(null)
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
    const at = indexOf(plane)
    const current = draft?.plane === plane && draft.at === at ? draft.points : []
    const points = [...current, p]
    if (points.length < needed) return setDraft({ plane, at, points })
    const image = images[plane]
    // Puntos en mm dentro del volumen, como se guardan.
    const toMm = (q: Point): Vec3 => {
      const v =
        plane === "axial"
          ? { x: q.x, y: q.y, z: point.z }
          : plane === "coronal"
            ? { x: q.x, y: point.y, z: volume.nz - 1 - q.y }
            : { x: point.x, y: q.x, z: volume.nz - 1 - q.y }
      return [v.x * volume.sx, v.y * volume.sy, v.z * volume.sz]
    }
    void saved.keep({
      view: VIEW_OF[plane],
      kind: tool === "angulo" ? "angulo" : "distancia",
      points: points.map(toMm),
      value:
        tool === "angulo"
          ? planeAngleDeg(image, points[0]!, points[1]!, points[2]!)
          : planeDistanceMm(image, points[0]!, points[1]!),
      toothNumber: null,
    })
    setDraft(null)
  }
  /** Las medidas guardadas que caen en el corte que se ve. */
  const shown = (plane: Plane): PlaneMeasure[] =>
    saved.measures
      .filter((m) => m.view === VIEW_OF[plane])
      .flatMap((m) => {
        const near = (v: number, at: number) => Math.abs(v - at) < 0.6
        const fits = m.points.every(([x, y, z]) =>
          plane === "axial"
            ? near(z / volume.sz, point.z)
            : plane === "coronal"
              ? near(y / volume.sy, point.y)
              : near(x / volume.sx, point.x),
        )
        if (!fits) return []
        const points = m.points.map(([x, y, z]) =>
          plane === "axial"
            ? { x: x / volume.sx, y: y / volume.sy }
            : plane === "coronal"
              ? { x: x / volume.sx, y: volume.nz - 1 - z / volume.sz }
              : { x: y / volume.sy, y: volume.nz - 1 - z / volume.sz },
        )
        return [{ id: m.id, view: m.view, index: 0, kind: m.kind, points, value: m.value }]
      })
  return (
    // scroll-nativo: en el celular los tres cortes van uno bajo otro; en ancho, la cuadrícula cabe sin desplazar.
    <div
      className={`grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-slate-800 md:overflow-hidden ${show3d ? "md:grid-cols-2 md:grid-rows-2" : "md:grid-cols-3"}`}
    >
      {(["axial", "coronal", "sagittal"] as const).map((plane) => (
        <div key={plane} className="flex min-h-0 min-w-0 flex-col bg-black">
          <SliceCanvas
            onEscape={onStopTool}
            className="flex min-h-0 flex-1 items-center"
            image={images[plane]}
            window={window}
            label={PLANE_NAMES[plane].label}
            technical={PLANE_NAMES[plane].technical}
            cross={crossOf(plane)}
            measures={shown(plane)}
            draft={draft?.plane === plane && draft.at === indexOf(plane) ? draft.points : undefined}
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
      {show3d && <Tomography3D volume={volume} window={window} onExpand={onExpand3d} />}
    </div>
  )
}

/**
 * Carga de los archivos y del volumen de una serie, con su avance y sus fallos.
 * `seriesUid`: la serie elegida; sin elegir, la mayor (`studySeries`).
 */
export function useCbctVolume(patientId: string, documentId: string, seriesUid: string | null = null) {
  const files = useQuery({
    queryKey: ["imaging-study-files", patientId, documentId],
    queryFn: () => apiFetch<{ data: StudyFiles }>(`/api/patients/${patientId}/imaging/studies/${documentId}/files`),
    staleTime: 30 * 60 * 1000,
  })
  const series = useMemo(() => studySeries(files.data?.data.files ?? []), [files.data?.data.files])
  const shown = series.find((item) => item.uid === seriesUid) ?? series[0] ?? null
  const [volume, setVolume] = useState<CbctVolume | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  // `attempt` vuelve a cargar al pedir «Reintentar».
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` es la señal de reintento.
  useEffect(() => {
    if (!shown) return
    const controller = new AbortController()
    // Otra serie es otro volumen: mientras se arma, no se ve la anterior con el nombre de la nueva.
    setVolume(null)
    setError(null)
    setProgress({ done: 0, total: shown.files.length })
    loadCbctVolume(`${documentId}:${shown.uid}`, shown.files, { onProgress: setProgress, signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) setVolume(loaded)
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e)
      })
    return () => controller.abort()
  }, [shown, documentId, attempt])
  return {
    files,
    series,
    shown,
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
 * Sin memoria para el volumen (tablero 9): los cortes de la serie que se ve, de
 * a uno, decodificados al pedirlos, con su propia ventana.
 */
function SingleSlices({ series: shown, onRetry }: { series: StudySeries; onRetry: () => void }) {
  const series = shown.files
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
      {/* Mientras llega el corte pedido, el anterior se atenúa: nunca se muestra con el número del nuevo. */}
      {slice.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-200">
          No se pudo cargar el corte {index + 1}.
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Reintentar
          </Button>
        </div>
      )}
      <canvas
        ref={ref}
        role="img"
        aria-label={
          slice.isPlaceholderData || slice.isError
            ? `Cargando el corte ${index + 1} de ${series.length}`
            : `Corte ${index + 1} de ${series.length}`
        }
        aria-busy={slice.isPlaceholderData}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: el corte se recorre con las flechas del teclado.
        tabIndex={0}
        className={`max-h-[70dvh] max-w-full object-contain ${slice.isPlaceholderData || slice.isError ? "opacity-30" : ""}`}
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
    ? "Esta computadora no tiene memoria suficiente para armar la tomografía. Ábrela en otra computadora o descárgala para el programa del tomógrafo."
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

type TomographyView = "panoramica" | "corte" | "cortes" | "3d"

const PHONE_VIEWS: { value: TomographyView; label: string }[] = [
  { value: "panoramica", label: "Panorámica" },
  { value: "corte", label: "Pieza" },
  { value: "cortes", label: "Cortes" },
  { value: "3d", label: "3D" },
]

/**
 * La serie que se ve, en la barra (ADR 0151): un estudio médico trae varias y
 * medir en la equivocada (el topograma, una reconstrucción gruesa) es el riesgo
 * mayor. Solo aparece si hay más de una; el topograma se ve y no se elige.
 */
function SeriesPicker({
  documentId,
  series,
  shown,
  onChoose,
}: {
  documentId: string
  series: readonly StudySeries[]
  shown: StudySeries
  onChoose: (uid: string) => void
}) {
  const info = useQuery({
    queryKey: ["imaging-series-info", documentId],
    queryFn: async ({ signal }) =>
      Object.fromEntries(
        await Promise.all(
          series.map(async (item) => [item.uid, await readSeriesInfo(item, signal).catch(() => null)] as const),
        ),
      ),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const locale = activeOrgLocale() ?? "es"
  const infoOf = (item: StudySeries) => info.data?.[item.uid] ?? null
  // En el orden del centro (su número de serie); sin número, como llegaron.
  const listed = [...series].sort(
    (a, b) => (infoOf(a)?.number ?? Number.POSITIVE_INFINITY) - (infoOf(b)?.number ?? Number.POSITIVE_INFINITY),
  )
  const nameOf = (item: StudySeries) => seriesName(infoOf(item), series.indexOf(item))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="sm" variant="outline" className="max-w-full min-w-0" />}>
        <span className="text-slate-400">Serie</span>
        <span className="min-w-0 truncate font-semibold">
          {nameOf(shown)} · {seriesDetail(shown, infoOf(shown), locale)}
        </span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup value={shown.uid} onValueChange={(uid) => onChoose(String(uid))}>
          {listed.map((item) => (
            <DropdownMenuRadioItem
              key={item.uid}
              value={item.uid}
              disabled={!canReconstruct(item, infoOf(item))}
              // Elegir es todo lo que se hace aquí: la lista se cierra y se ve la serie.
              closeOnClick
              className="flex items-baseline justify-between gap-3"
            >
              <span className="min-w-0 truncate">{nameOf(item)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{seriesDetail(item, infoOf(item), locale)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const VIEW_ONLY_NOTICE =
  "En el celular la tomografía es para mirar. Para medir, ábrela en una computadora o una tablet."

/** Pantalla completa del visor: «Panorámica», «Cortes» y «3D», o una vista grande a la vez en el celular. */
export function TomographyViewer({
  patientId,
  doc,
  open,
  onClose,
  onDetails,
  canWrite = false,
}: {
  patientId: string
  doc: PatientDocument
  open: boolean
  onClose: () => void
  /** Abre el detalle del documento (informe, contexto, retiro). */
  onDetails?: () => void
  /** Escribe en la ficha: guarda medidas y la vista en la atención. */
  canWrite?: boolean
}) {
  // La dental (CBCT) abre en la panorámica, con sus brillos; la médica, en cortes y con sus ventanas.
  const ct = tomographyKind() === "ct"
  const [seriesUid, setSeriesUid] = useState<string | null>(null)
  const loaded = useCbctVolume(patientId, doc.id, seriesUid)
  const volume = loaded.volume
  const viewOnly = useViewOnly()
  const patientName = usePatientName(patientId)
  /** La opción elegida (null: la primera, con la que abre) o «mas», el ajuste fino. */
  const [preset, setPreset] = useState<string | null>(null)
  const [custom, setCustom] = useState<WindowLevel | null>(null)
  const [tool, setTool] = useState<Tool>("ninguna")
  const mainSeries = loaded.series[0]?.uid ?? null
  const shownSeries = loaded.shown?.uid ?? null
  const onMainSeries = shownSeries === mainSeries
  const saved = useSavedMeasures(
    patientId,
    doc.id,
    canWrite,
    shownSeries && mainSeries ? { shown: shownSeries, main: mainSeries } : null,
  )
  const [view, setView] = useState<TomographyView>(ct ? "cortes" : "panoramica")
  const [adjusting, setAdjusting] = useState(false)
  const [facts, setFacts] = useState(false)
  const factsButton = useRef<HTMLButtonElement | null>(null)
  const [single, setSingle] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const options = useMemo(() => (volume ? (ct ? ctWindows(volume) : cbctWindows(volume)) : []), [volume, ct])
  // Otra serie puede no traer la ventana elegida (la «Del archivo»): queda la primera.
  const active = options.find((option) => option.key === preset) ?? options[0] ?? null
  const window = volume && active ? (preset === "mas" ? (custom ?? active.window) : active.window) : null
  // En la computadora, «Pieza» es parte de la panorámica; el 3D tiene su pestaña, para mostrarlo grande.
  const shown: TomographyView = !viewOnly && view === "corte" ? "panoramica" : view

  // Al cambiar de vista, el aviso de la anterior ya no aplica.
  // Al llegar con «Ver grande», el foco pasa al 3D: el botón deja de existir.
  const [expanded3d, setExpanded3d] = useState(false)
  const changeView = (next: TomographyView) => {
    setView(next)
    setNotice(null)
    setAdjusting(false)
    if (next !== "3d") setExpanded3d(false)
  }
  const chooseTool = (next: Tool) => {
    // Medir queda a la vista; en el celular se dice por qué no, con la salida.
    if (viewOnly && next !== "ninguna") {
      setNotice(VIEW_ONLY_NOTICE)
      return
    }
    // El 3D es solo para mostrar: M y A dicen dónde se mide en vez de encender una herramienta oculta.
    if (view === "3d" && next !== "ninguna") {
      setNotice(`El 3D es para mostrar. Para medir, usa ${ct ? "los cortes" : "la panorámica o los cortes"}.`)
      return
    }
    setNotice(null)
    setAdjusting(false)
    setTool(next)
  }

  // Los atajos leen la herramienta de ahora sin volver a registrarse en cada render.
  const keys = useRef({ tool, chooseTool, options })
  keys.current = { tool, chooseTool, options }
  useEffect(() => {
    if (!open || !volume) return
    const onKey = (event: KeyboardEvent) => {
      const { tool, chooseTool, options } = keys.current
      // Lo que ya atendió un corte (1–5 al ajustar el arco, las flechas) no cambia el brillo.
      if (event.defaultPrevented) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return
      const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0
      if (digit && digit <= options.length) setPreset(options[digit - 1]!.key)
      else if (event.key === "m" || event.key === "M")
        chooseTool(tool === "medir" ? "ninguna" : "medir")
      else if (event.key === "a" || event.key === "A")
        chooseTool(tool === "angulo" ? "ninguna" : "angulo")
      else if (event.key === "Escape" && tool !== "ninguna") {
        event.preventDefault()
        setTool("ninguna")
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, volume])

  const download = () => {
    const anchor = document.createElement("a")
    anchor.href = tomographyDownloadUrl(patientId, doc.id)
    anchor.download = ""
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  }

  const voxel = doc.imaging?.voxelMm ?? volume?.sx ?? null
  const ready = Boolean(volume && window && !single && !loaded.error)
  return (
    <ViewerShell
      open={open}
      onClose={onClose}
      title={patientName ? `${patientName} · ${doc.label}` : doc.label}
      subtitle={
        <>
          {doc.retiredAt ? (
            <span className="font-medium text-red-300">
              Retirada{doc.retireReason ? ` · ${doc.retireReason}` : ""} ·{" "}
            </span>
          ) : null}
          {/* Con varias series, los cortes de cada una los dice «Serie»; el total del estudio no. */}
          {loaded.series.length > 1
            ? `${loaded.series.length} series en el estudio`
            : doc.imaging
              ? `${doc.imaging.sliceCount.toLocaleString(activeOrgLocale())} imágenes en el estudio`
              : ""}
          {/* El centro no se repite si ya está en el nombre. */}
          {doc.source && !doc.label.includes(doc.source) ? ` · ${doc.source}` : ""}
        </>
      }
      actions={
        <>
          {loaded.shown && loaded.series.length > 1 && (
            <SeriesPicker
              documentId={doc.id}
              series={loaded.series}
              shown={loaded.shown}
              onChoose={(uid) => {
                setSeriesUid(uid)
                setSingle(false)
                setTool("ninguna")
                setAdjusting(false)
                setNotice(null)
              }}
            />
          )}
          {ready && !viewOnly && (
            <Tabs value={shown} onValueChange={(next) => changeView(next as TomographyView)}>
              <TabsList aria-label="Vista">
                {!ct && <TabsTrigger value="panoramica">Panorámica</TabsTrigger>}
                <TabsTrigger value="cortes">Cortes</TabsTrigger>
                <TabsTrigger value="3d">3D</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          <Button
            ref={factsButton}
            type="button"
            size="sm"
            variant={facts ? "secondary" : "ghost"}
            aria-pressed={facts}
            onClick={() => setFacts((open) => !open)}
          >
            Informe y datos
          </Button>
        </>
      }
      toolbar={
        ready && volume && window ? (
          <>
            {/* En el celular, las vistas van primero: son la navegación principal. */}
            {viewOnly && (
              <div className="min-w-0 basis-full">
                <ViewTabs
                  label="Vista"
                  value={view}
                  options={ct ? PHONE_VIEWS.filter((item) => item.value === "cortes" || item.value === "3d") : PHONE_VIEWS}
                  onValueChange={changeView}
                />
              </div>
            )}
            <BrightnessControls
              volume={volume}
              label={ct ? "Ventana" : "Brillo"}
              options={options}
              preset={preset === "mas" ? "mas" : (active?.key ?? "")}
              onPreset={(next) => {
                if (next === "mas") setCustom(window)
                setPreset(next)
              }}
              window={window}
              onWindow={setCustom}
            />
            {shown !== "3d" && (
              <ToggleGroup
                value={tool === "ninguna" ? [] : [tool]}
                onValueChange={(value: string[]) =>
                  chooseTool((value[0] as Tool | undefined) ?? "ninguna")
                }
                variant="outline"
                size="sm"
                aria-label="Herramienta"
              >
                <ToggleGroupItem value="medir" aria-keyshortcuts="M">
                  Medir
                </ToggleGroupItem>
                {!viewOnly && (
                  <ToggleGroupItem value="angulo" aria-keyshortcuts="A">
                    Ángulo
                  </ToggleGroupItem>
                )}
              </ToggleGroup>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" size="sm" variant="outline" />}>
                Más
                <ChevronDown aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* El arco guardado es de la serie mayor: en otra serie no se ajusta. */}
                {shown === "panoramica" && !viewOnly && !adjusting && onMainSeries && (
                  <DropdownMenuItem
                    onClick={() => {
                      setAdjusting(true)
                      setTool("ninguna")
                    }}
                  >
                    Ajustar el arco
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    setPreset(null)
                    setTool("ninguna")
                    setAdjusting(false)
                    setNotice(null)
                  }}
                >
                  Restablecer
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={download} className="flex-col items-start gap-0.5">
                  <span>{ct ? "Descargar para el programa de imágenes" : "Descargar para el programa del tomógrafo"}</span>
                  <span className="text-xs text-muted-foreground">
                    {ct
                      ? "Para reconstrucciones y otras herramientas, ábrela en el programa del centro de imágenes."
                      : "Para planificar el implante o seguir el nervio, ábrela en el programa del centro de imágenes o del tomógrafo."}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p
              aria-live="polite"
              className="min-w-0 basis-full text-xs text-amber-200 empty:hidden lg:basis-auto"
            >
              {notice ?? ""}
            </p>
          </>
        ) : undefined
      }
    >
      {/* «Informe y datos» se abre encima de la columna derecha: la imagen, la pestaña y la pieza quedan igual. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      {facts && (
        <TomographyFacts
          doc={doc}
          onClose={() => {
            setFacts(false)
            factsButton.current?.focus()
          }}
          onEdit={onDetails}
        />
      )}
      {single && loaded.shown ? (
        <SingleSlices key={loaded.shown.uid} series={loaded.shown} onRetry={() => void loaded.files.refetch()} />
      ) : loaded.error ? (
        <VolumeLoadError
          error={loaded.error}
          patientId={patientId}
          documentId={doc.id}
          onRetry={loaded.retry}
          onSingle={loaded.shown ? () => setSingle(true) : undefined}
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
          {shown === "panoramica" || shown === "corte" ? (
            <PanoramicView
              volume={volume}
              window={window}
              tool={tool}
              viewOnly={viewOnly}
              canWrite={canWrite}
              patientId={patientId}
              doc={doc}
              adjusting={adjusting}
              onAdjustDone={() => setAdjusting(false)}
              savedArch={onMainSeries ? (loaded.files.data?.data.arch ?? null) : null}
              onTool={setTool}
              saved={saved}
              note={MEASURE_NOTE(voxel)}
              phoneView={viewOnly ? (shown === "corte" ? "corte" : "panoramica") : undefined}
            />
          ) : shown === "3d" ? (
            <Tomography3D volume={volume} window={window} className="flex-1" focusOnOpen={expanded3d} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <ThreePlanes
                key={shownSeries ?? undefined}
                atTeeth={!ct}
                volume={volume}
                window={window}
                tool={viewOnly ? "ninguna" : tool}
                onStopTool={() => setTool("ninguna")}
                saved={saved}
                // En la médica, el 3D solo se arma al tocar su pestaña: es lo más pesado.
                show3d={!viewOnly && !ct}
                onExpand3d={() => {
                  setExpanded3d(true)
                  changeView("3d")
                }}
              />
              <aside className="flex w-full shrink-0 flex-col gap-3 border-t border-slate-800 bg-[#0d131b] p-4 text-sm lg:w-72 lg:border-t-0 lg:border-l">
                <MeasureList
                  saved={saved}
                  canWrite={canWrite}
                  viewOnly={viewOnly}
                  note={ct ? CT_MEASURE_NOTE : MEASURE_NOTE(voxel)}
                />
                <p className="text-xs text-slate-500" aria-live="polite">
                  {tool !== "ninguna" && !viewOnly
                    ? MEASURE_KEYS_HINT
                    : `Rueda o ↑ ↓ avanzan el corte · Ctrl + rueda o dos dedos acercan · doble clic ajusta · ${ct ? `del 1 al ${options.length} cambian la ventana` : "1, 2 y 3 cambian el brillo"}${viewOnly ? "" : " · M mide · A ángulo"}`}
                </p>
              </aside>
            </div>
          )}
        </>
      )}
      </div>
    </ViewerShell>
  )
}

/**
 * Lo que se sabe del archivo, sin salir de la tomografía: tipo, toma, origen,
 * informe, piezas y etiquetas. Editarlo, informarlo o retirarlo se hace en su
 * tarjeta, que abre «Editar, informar o retirar».
 */
function TomographyFacts({ doc, onClose, onEdit }: { doc: PatientDocument; onClose: () => void; onEdit?: () => void }) {
  const rows: [string, string][] = [
    ["Tipo", imageTypeLabel(doc.imageType) ?? categoryLabel(doc.category)],
    // La fecha del estudio DICOM no trae hora: se dice solo el día, como en el resto de la ficha.
    [doc.capturedAt ? "Tomada" : "Subida", formatDate(takenAt(doc))],
    ...(doc.imaging
      ? ([
          [
            "Estudio",
            `${doc.imaging.sliceCount.toLocaleString(activeOrgLocale())} cortes${
              doc.imaging.voxelMm ? ` · vóxel de ${doc.imaging.voxelMm.toLocaleString(activeOrgLocale())} mm` : ""
            }`,
          ],
        ] as [string, string][])
      : []),
    ...(doc.source ? ([["Origen", doc.source]] as [string, string][]) : []),
    ...(doc.reportStatus ? ([["Informe", reportStatusLabel(doc.reportStatus) ?? doc.reportStatus]] as [string, string][]) : []),
    ...(doc.toothNumbers.length
      ? ([[doc.toothNumbers.length === 1 ? "Pieza" : "Piezas", doc.toothNumbers.join(", ")]] as [string, string][])
      : []),
    ...(doc.tags.length ? ([["Etiquetas", doc.tags.join(", ")]] as [string, string][]) : []),
    ...(doc.retiredAt ? ([["Retirada", doc.retireReason ?? "Sí"]] as [string, string][]) : []),
  ]
  return (
    // scroll-nativo: panel sobre el visor oscuro, como la columna derecha que reemplaza.
    <aside
      aria-label="Informe y datos"
      className="absolute inset-y-0 right-0 z-20 flex w-full flex-col gap-4 overflow-y-auto border-l border-slate-800 bg-[#0d131b] p-4 text-sm sm:w-80"
    >
      <Button type="button" size="sm" variant="outline" className="self-start" autoFocus onClick={onClose}>
        <ChevronLeft aria-hidden="true" />
        Volver a la imagen
      </Button>
      <dl className="grid grid-cols-1 gap-y-2.5">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs text-slate-400">{term}</dt>
            <dd className="text-slate-100">{value}</dd>
          </div>
        ))}
      </dl>
      {doc.reportStatus === "pendiente" && (
        <p className="text-xs text-slate-400">El informe va como resultado de su orden o en la evolución de la atención.</p>
      )}
      {onEdit && (
        <div className="flex flex-col gap-1">
          <Button type="button" size="sm" variant="outline" className="self-start" onClick={onEdit}>
            Editar, informar o retirar
          </Button>
          <p className="text-xs text-slate-400">Abre la tarjeta del archivo; vuelves aquí con «Abrir visor».</p>
        </div>
      )}
    </aside>
  )
}
