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
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { LoadingState, ViewTabs } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import {
  type BrightnessPreset,
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
import { DicomUnsupportedError, decodeDicom, renderDicom } from "../../lib/dicom"
import { tomographyDownloadUrl } from "../../lib/imaging-upload"
import { MEASURE_NOTE, MeasureList, type SavedMeasures, useSavedMeasures, type Vec3 } from "./tomography-measures"
import { PanoramicView } from "./tomography-panoramic"
import { type PlaneMeasure, type Point, SliceCanvas, type Tool } from "./tomography-slice"
import { Tomography3D } from "./tomography-3d"
import { usePatientName, ViewerShell } from "./viewer-shell"
import { activeOrgLocale } from "../../lib/locale"
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
}: {
  volume: CbctVolume
  window: WindowLevel
  tool: Tool
  saved: SavedMeasures
  /** El cuarto cuadro: el 3D para mostrar (en la computadora). */
  show3d: boolean
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
            className="flex min-h-0 flex-1 items-center"
            image={images[plane]}
            window={window}
            label={PLANE_NAMES[plane].label}
            technical={PLANE_NAMES[plane].technical}
            cross={crossOf(plane)}
            measures={shown(plane)}
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
      {show3d && <Tomography3D volume={volume} window={window} />}
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

type TomographyView = "panoramica" | "corte" | "cortes" | "3d"

const PHONE_VIEWS: { value: TomographyView; label: string }[] = [
  { value: "panoramica", label: "Panorámica" },
  { value: "corte", label: "Pieza" },
  { value: "cortes", label: "Cortes" },
  { value: "3d", label: "3D" },
]

const VIEW_ONLY_NOTICE =
  "En el celular la tomografía es para mirar. Para medir, ábrela en una computadora o una tablet."

/** Pantalla completa del visor: «Panorámica» y «Cortes» (con el 3D), o una vista grande a la vez en el celular. */
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
  const loaded = useCbctVolume(patientId, doc.id)
  const volume = loaded.volume
  const viewOnly = useViewOnly()
  const patientName = usePatientName(patientId)
  const [preset, setPreset] = useState<BrightnessPreset | "mas">("hueso")
  const [custom, setCustom] = useState<WindowLevel | null>(null)
  const [tool, setTool] = useState<Tool>("ninguna")
  const saved = useSavedMeasures(patientId, doc.id, canWrite)
  const [view, setView] = useState<TomographyView>("panoramica")
  const [adjusting, setAdjusting] = useState(false)
  const [single, setSingle] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const window = volume
    ? preset === "mas"
      ? (custom ?? volume.presets.hueso)
      : volume.presets[preset]
    : null
  // En la computadora, «Corte» es parte de la panorámica y el 3D, de los cortes.
  const shown: TomographyView = viewOnly
    ? view
    : view === "corte"
      ? "panoramica"
      : view === "3d"
        ? "cortes"
        : view
  const files = loaded.files.data?.data.files
  const otherSeries = useMemo(
    () => new Set(files?.map((f) => f.seriesInstanceUid)).size > 1,
    [files],
  )

  // Al cambiar de vista, el aviso de la anterior ya no aplica.
  const changeView = (next: TomographyView) => {
    setView(next)
    setNotice(null)
  }
  const chooseTool = (next: Tool) => {
    // Medir queda a la vista; en el celular se dice por qué no, con la salida.
    if (viewOnly && next !== "ninguna") {
      setNotice(VIEW_ONLY_NOTICE)
      return
    }
    setNotice(null)
    setAdjusting(false)
    setTool(next)
  }

  // Los atajos leen la herramienta de ahora sin volver a registrarse en cada render.
  const keys = useRef({ tool, chooseTool })
  keys.current = { tool, chooseTool }
  useEffect(() => {
    if (!open || !volume) return
    const onKey = (event: KeyboardEvent) => {
      const { tool, chooseTool } = keys.current
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return
      if (event.key === "1") setPreset("hueso")
      else if (event.key === "2") setPreset("diente")
      else if (event.key === "3") setPreset("blando")
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
          {doc.imaging
            ? `${doc.imaging.sliceCount.toLocaleString(activeOrgLocale())} imágenes en el estudio`
            : ""}
          {/* El centro no se repite si ya está en el nombre. */}
          {doc.source && !doc.label.includes(doc.source) ? ` · ${doc.source}` : ""}
        </>
      }
      actions={
        <>
          {ready && !viewOnly && (
            <Tabs value={shown} onValueChange={(next) => changeView(next as TomographyView)}>
              <TabsList aria-label="Vista">
                <TabsTrigger value="panoramica">Panorámica</TabsTrigger>
                <TabsTrigger value="cortes">Cortes</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {onDetails && (
            <Button type="button" size="sm" variant="ghost" onClick={onDetails}>
              Detalles
            </Button>
          )}
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
                  options={PHONE_VIEWS}
                  onValueChange={changeView}
                />
              </div>
            )}
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
                {shown === "panoramica" && !viewOnly && canWrite && (
                  <DropdownMenuItem
                    onClick={() => {
                      setAdjusting((a) => !a)
                      setTool("ninguna")
                    }}
                  >
                    {adjusting ? "Terminar de ajustar el arco" : "Ajustar el arco"}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => {
                    setPreset("hueso")
                    setTool("ninguna")
                    setAdjusting(false)
                    setNotice(null)
                  }}
                >
                  Restablecer
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={download} className="flex-col items-start gap-0.5">
                  <span>Descargar para el programa del centro</span>
                  <span className="text-xs text-muted-foreground">
                    Para planificar el implante o seguir el nervio, ábrela en el programa del centro
                    de imágenes o del tomógrafo.
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p
              aria-live="polite"
              className="min-w-0 basis-full text-xs text-amber-200 empty:hidden lg:basis-auto"
            >
              {notice ??
                (adjusting
                  ? "Arrastra los puntos del arco o elige uno con 1–5 y muévelo con las flechas."
                  : "")}
            </p>
            {otherSeries && (
              <p className="min-w-0 basis-full text-xs text-slate-400">
                Este estudio trae otra serie además de la que se ve; para verla, descárgalo.
              </p>
            )}
          </>
        ) : undefined
      }
    >
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
              onTool={setTool}
              saved={saved}
              note={MEASURE_NOTE(voxel)}
              phoneView={viewOnly ? (shown === "corte" ? "corte" : "panoramica") : undefined}
            />
          ) : shown === "3d" ? (
            <Tomography3D volume={volume} window={window} className="flex-1" />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
              <ThreePlanes
                volume={volume}
                window={window}
                tool={viewOnly ? "ninguna" : tool}
                saved={saved}
                show3d={!viewOnly}
              />
              <aside className="flex w-full shrink-0 flex-col gap-3 border-t border-slate-800 bg-[#0d131b] p-4 text-sm lg:w-72 lg:border-t-0 lg:border-l">
                <MeasureList saved={saved} canWrite={canWrite} viewOnly={viewOnly} />
                <p className="text-xs text-slate-400">{MEASURE_NOTE(voxel)}</p>
                <p className="text-xs text-slate-500">
                  Rueda o ↑ ↓ avanzan el corte · Ctrl + rueda o dos dedos acercan · doble clic
                  ajusta · 1, 2 y 3 cambian el brillo
                  {viewOnly ? "" : " · M mide · A ángulo"}
                </p>
              </aside>
            </div>
          )}
        </>
      )}
    </ViewerShell>
  )
}
