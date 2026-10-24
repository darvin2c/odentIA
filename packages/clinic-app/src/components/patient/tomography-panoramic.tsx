import { Button, Slider } from "@odentia/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import {
  type CrossImage,
  type CurveSample,
  crossSection,
  detectArch,
  jawRows,
  panorama,
  panoramaRows,
  type Point,
  sampleCurve,
  dentitionOf,
  jawOf,
  toothAt,
  toothIndex,
} from "../../lib/cbct-arch"
import {
  type CbctVolume,
  type PlaneImage,
  planeAngleDeg,
  planeDistanceMm,
  planeImage,
  type WindowLevel,
  windowToRgba,
} from "../../lib/cbct-volume"
import { orgSlugFromHostname, requestHostname } from "../../lib/host"
import { activeOrgLocale } from "../../lib/locale"
import type { PatientDocument } from "../../lib/patients"
import { MeasureList, type SavedMeasure, type SavedMeasures, type Vec3 } from "./tomography-measures"
import { formatMeasure, type PlaneMeasure, SliceCanvas, type Tool } from "./tomography-slice"

/**
 * «Panorámica y cortes» (tablero 5 del lienzo): la panorámica reconstruida, cinco
 * cortes transversales seguidos (cada 1 mm) y el corte desde arriba con el
 * arco. El arco lo propone el visor y se ajusta; las medidas se guardan con
 * quién y cuándo, y la vista se guarda en la atención de hoy.
 */

const CROSS_OFFSETS = [-2, -1, 0, 1, 2]
const HALF_WIDTH_MM = 16

interface Encounter {
  id: string
  status: string
  createdAt: string
}

/** mm del volumen de un punto de una vista. */
function toMm(volume: CbctVolume, voxel: { x: number; y: number; z: number }): Vec3 {
  return [voxel.x * volume.sx, voxel.y * volume.sy, voxel.z * volume.sz]
}

function crossPointToVoxel(c: CurveSample, image: CrossImage, p: Point) {
  const o = p.x * image.colMm - HALF_WIDTH_MM
  return { x: c.x + c.nx * o, y: c.y + c.ny * o, z: image.zTop - p.y }
}

/** Puntos de una medida guardada en la imagen de un corte transversal, si está en ese plano. */
function projectOnCross(volume: CbctVolume, c: CurveSample, image: CrossImage, points: Vec3[]): Point[] | null {
  const px = c.x * volume.sx
  const py = c.y * volume.sy
  const t = [c.tx * volume.sx, c.ty * volume.sy]
  const n = [c.nx * volume.sx, c.ny * volume.sy]
  const out: Point[] = []
  for (const [x, y, z] of points) {
    const dx = x - px
    const dy = y - py
    if (Math.abs(dx * t[0]! + dy * t[1]!) > 0.6) return null
    out.push({ x: (dx * n[0]! + dy * n[1]! + HALF_WIDTH_MM) / image.colMm, y: image.zTop - z / volume.sz })
  }
  return out
}

function projectOnPanorama(volume: CbctVolume, curve: readonly CurveSample[], image: CrossImage, points: Vec3[]): Point[] | null {
  const out: Point[] = []
  for (const [x, y, z] of points) {
    const row = image.zTop - z / volume.sz
    if (row < 0 || row > image.height - 1) return null
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < curve.length; i++) {
      const d = (curve[i]!.x * volume.sx - x) ** 2 + (curve[i]!.y * volume.sy - y) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (Math.sqrt(bestD) > 1.5) return null
    out.push({ x: best, y: row })
  }
  return out
}

/** El arco: propuesto, ajustado o marcado a mano (cinco puntos sobre el corte desde arriba). */
function useArch(volume: CbctVolume) {
  const proposal = useMemo(() => detectArch(volume), [volume])
  const [control, setControl] = useState<Point[] | null>(proposal?.control ?? null)
  const [axialZ, setAxialZ] = useState(proposal?.z ?? Math.floor(volume.nz / 2))
  const curve = useMemo(() => (control && control.length >= 5 ? sampleCurve(volume, control) : []), [volume, control])
  return { proposal, control, setControl, axialZ, setAxialZ, curve }
}

/** Pinta una imagen de plano en un lienzo fuera de pantalla (para «Guardar vista»). */
function paint(image: PlaneImage, window: WindowLevel): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = image.width
  canvas.height = image.height
  canvas
    .getContext("2d")
    ?.putImageData(new ImageData(new Uint8ClampedArray(windowToRgba(image.values, window)), image.width, image.height), 0, 0)
  return canvas
}

export function PanoramicView({
  volume,
  window,
  tool,
  viewOnly,
  canWrite,
  patientId,
  doc,
  adjusting,
  onTool,
  saved,
  note,
}: {
  volume: CbctVolume
  window: WindowLevel
  tool: Tool
  viewOnly: boolean
  canWrite: boolean
  patientId: string
  doc: PatientDocument
  adjusting: boolean
  onTool: (tool: Tool) => void
  saved: SavedMeasures
  /** Medidas orientativas (decisión 9). */
  note: string
}) {
  const queryClient = useQueryClient()
  const { proposal, control, setControl, axialZ, setAxialZ, curve } = useArch(volume)
  const occlusalZ = proposal?.z ?? axialZ
  const pano = useMemo(
    () => (curve.length ? panorama(volume, curve, 12, ...panoramaRows(volume, occlusalZ)) : null),
    [volume, curve, occlusalZ],
  )
  const step = curve.length > 1 ? curve[1]!.s - curve[0]!.s : volume.sx
  const perMm = Math.max(1, Math.round(1 / step))
  const teeth = doc.toothNumbers
  const [tooth, setTooth] = useState<number | null>(teeth[0] ?? null)
  const jaw = tooth ? jawOf(tooth) : "lower"
  // La pieza que se nombra al medir es de la dentición de la pieza elegida: un niño da «55».
  const dentition = tooth ? dentitionOf(tooth) : "permanent"
  const [index, setIndex] = useState(0)
  const placed = useRef(false)
  useEffect(() => {
    if (!curve.length || placed.current) return
    placed.current = true
    const at = tooth ? toothIndex(curve, tooth) : null
    setIndex(at ?? Math.floor(curve.length / 2))
  }, [curve, tooth])
  const clampIndex = useCallback(
    (i: number) => Math.max(2 * perMm, Math.min(curve.length - 1 - 2 * perMm, Math.round(i))),
    [curve.length, perMm],
  )
  // Los transversales muestran el maxilar de la pieza elegida (el inferior si no hay).
  const crosses = useMemo(() => {
    if (!curve.length) return []
    const [zFrom, zTo] = jawRows(volume, occlusalZ, jaw)
    return CROSS_OFFSETS.map((k) => {
      const at = clampIndex(index) + k * perMm
      return { at, image: crossSection(volume, curve, at, HALF_WIDTH_MM, zFrom, zTo) }
    })
  }, [volume, curve, index, perMm, clampIndex, occlusalZ, jaw])
  const axial = useMemo(() => planeImage(volume, "axial", axialZ), [volume, axialZ])

  const measures = saved.measures

  // Marcar puntos de una medida en la panorámica, un transversal o el corte de arriba.
  const [draft, setDraft] = useState<{ view: string; at: number; points: Point[] } | null>(null)
  useEffect(() => {
    if (tool === "ninguna") setDraft(null)
  }, [tool])
  const mark = (view: "panoramica" | "transversal" | "axial", at: number, image: PlaneImage | CrossImage, p: Point) => {
    const needed = tool === "angulo" ? 3 : 2
    const current = draft?.view === view && draft.at === at ? draft.points : []
    const points = [...current, p]
    if (points.length < needed) return setDraft({ view, at, points })
    setDraft(null)
    const voxel = (q: Point) =>
      view === "transversal"
        ? crossPointToVoxel(curve[at]!, image as CrossImage, q)
        : view === "panoramica"
          ? { x: curve[Math.round(q.x)]!.x, y: curve[Math.round(q.x)]!.y, z: (image as CrossImage).zTop - q.y }
          : { x: q.x, y: q.y, z: axialZ }
    void saved.keep({
      kind: tool === "angulo" ? "angulo" : "distancia",
      view,
      points: points.map((q) => toMm(volume, voxel(q))),
      value:
        tool === "angulo"
          ? planeAngleDeg(image, points[0]!, points[1]!, points[2]!)
          : planeDistanceMm(image, points[0]!, points[1]!),
      // La pieza a la altura de la medida: el corte transversal o la columna de la panorámica.
      toothNumber:
        curve.length && view !== "axial"
          ? toothAt(curve, view === "transversal" ? at : Math.round(points[0]!.x), jaw, dentition)
          : null,
    })
  }
  const asPlane = (m: SavedMeasure, points: Point[]): PlaneMeasure => ({
    id: m.id,
    view: m.view,
    index: 0,
    kind: m.kind,
    points,
    value: m.value,
  })

  // Ajustar el arco: arrastrar un punto o elegirlo con 1–5 y moverlo con las flechas.
  const [selected, setSelected] = useState<number | null>(null)
  const dragging = useRef(false)
  const nearest = (p: Point) => {
    if (!control) return null
    let best: number | null = null
    let bestD = 8 / volume.sx
    control.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y)
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }
  const movePoint = (i: number, p: Point) =>
    setControl((prev) => (prev ? prev.map((c, k) => (k === i ? { x: p.x, y: p.y } : c)) : prev))
  const [marking, setMarking] = useState<Point[]>([])

  // Guardar vista en la atención de hoy (borrador).
  const encounters = useQuery({
    queryKey: ["encounters-open", patientId],
    queryFn: () => apiFetch<{ data: Encounter[] }>(`/api/patients/${patientId}/encounters?limit=20`),
    enabled: canWrite && !viewOnly,
  })
  const draftEncounter = encounters.data?.data.find((e) => e.status === "borrador") ?? null
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const saveView = async () => {
    if (!pano || !draftEncounter) return
    setSaving("saving")
    try {
      const top = paint(pano, window)
      const strip = crosses.map((c) => paint(c.image, window))
      const scale = 1200 / top.width
      const crossW = 1200 / 5
      const crossH = crossW * (strip[0]!.height / strip[0]!.width) * ((crosses[0]!.image.rowMm / crosses[0]!.image.colMm) || 1)
      const out = document.createElement("canvas")
      out.width = 1200
      out.height = Math.round(top.height * scale * (pano.rowMm / pano.colMm) + crossH + 80)
      const ctx = out.getContext("2d")
      if (!ctx) throw new Error("Sin lienzo")
      ctx.fillStyle = "#000"
      ctx.fillRect(0, 0, out.width, out.height)
      const panoH = top.height * scale * (pano.rowMm / pano.colMm)
      ctx.drawImage(top, 0, 0, 1200, panoH)
      strip.forEach((canvas, i) => ctx.drawImage(canvas, i * crossW, panoH, crossW, crossH))
      ctx.fillStyle = "#e2e8f0"
      ctx.font = "16px system-ui, sans-serif"
      const shown = measures.filter((m) => !tooth || m.toothNumber === tooth || m.toothNumber === null)
      ctx.fillText(
        shown.length ? shown.map((m) => `${formatMeasure(m)}${m.toothNumber ? ` (${m.toothNumber})` : ""}`).join(" · ") : doc.label,
        12,
        panoH + crossH + 30,
      )
      ctx.fillStyle = "#94a3b8"
      ctx.font = "13px system-ui, sans-serif"
      ctx.fillText("Medidas orientativas: para planificar una cirugía, confírmalas en el programa del equipo.", 12, panoH + crossH + 58)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"))
      if (!blob) throw new Error("Sin imagen")
      const form = new FormData()
      form.append("file", new File([blob], "vista-tomografia.png", { type: "image/png" }))
      form.append("category", "radiografia")
      form.append("imageType", "tomografia")
      form.append("label", `Vista de la tomografía${tooth ? ` · pieza ${tooth}` : ""}`)
      form.append("encounterId", draftEncounter.id)
      form.append("toothNumbers", JSON.stringify(tooth ? [tooth] : []))
      form.append("tags", "[]")
      const slug = orgSlugFromHostname(requestHostname())
      const response = await fetch(`${API_URL}/api/patients/${patientId}/documents`, {
        method: "POST",
        credentials: "include",
        headers: slug ? { "x-odentia-org": slug } : {},
        body: form,
      })
      if (!response.ok) throw new Error(`Error ${response.status}`)
      setSaving("saved")
      void queryClient.invalidateQueries({ queryKey: ["patient-documents", patientId] })
    } catch {
      setSaving("error")
    }
  }

  const teethLabel = curve.length ? toothAt(curve, clampIndex(index), jaw, dentition) : null
  const tick = useCallback(
    (ctx: CanvasRenderingContext2D, image: PlaneImage) => {
      if (!curve.length) return
      // En píxeles de la imagen: finas, porque el lienzo se agranda en pantalla.
      for (const k of CROSS_OFFSETS) {
        const x = clampIndex(index) + k * perMm
        ctx.strokeStyle = k === 0 ? "#f59e0b" : "rgba(148, 163, 184, 0.6)"
        ctx.lineWidth = k === 0 ? Math.max(0.6, image.width / 320) : Math.max(0.3, image.width / 800)
        ctx.beginPath()
        ctx.moveTo(x, image.height * 0.08)
        ctx.lineTo(x, image.height * 0.95)
        ctx.stroke()
      }
    },
    [curve, index, perMm, clampIndex],
  )
  const archOverlay = useCallback(
    (ctx: CanvasRenderingContext2D, image: PlaneImage) => {
      const unit = Math.max(1, image.width / 300)
      if (curve.length) {
        ctx.strokeStyle = "#22d3ee"
        ctx.setLineDash([5 * unit, 4 * unit])
        ctx.lineWidth = 1.5 * unit
        ctx.beginPath()
        curve.forEach((c, i) => {
          if (i) ctx.lineTo(c.x, c.y)
          else ctx.moveTo(c.x, c.y)
        })
        ctx.stroke()
        ctx.setLineDash([])
        const c = curve[clampIndex(index)]!
        const o = HALF_WIDTH_MM
        ctx.strokeStyle = "#f59e0b"
        ctx.lineWidth = 2 * unit
        ctx.beginPath()
        ctx.moveTo(c.x - c.nx * o, c.y - c.ny * o)
        ctx.lineTo(c.x + c.nx * o, c.y + c.ny * o)
        ctx.stroke()
      }
      const points = control ?? marking
      points.forEach((p, i) => {
        ctx.fillStyle = selected === i ? "#fde68a" : "#22d3ee"
        ctx.beginPath()
        ctx.arc(p.x, p.y, (adjusting ? 4.5 : 3) * unit, 0, Math.PI * 2)
        ctx.fill()
        if (adjusting) {
          ctx.fillStyle = "#03252e"
          ctx.font = `${Math.round(6 * unit)}px system-ui, sans-serif`
          ctx.fillText(String(i + 1), p.x - 2 * unit, p.y + 2 * unit)
        }
      })
    },
    [curve, control, marking, index, adjusting, selected, clampIndex],
  )

  const noArch = !control || control.length < 5
  return (
    // En pantallas angostas la vista se desplaza; en anchas, todo cabe sin desplazar.
    // scroll-nativo: visor sobre fondo oscuro que deja de desplazarse en ancho (`lg:overflow-hidden`);
    // ScrollArea no se apaga por ancho y encerraría los cortes, que miden su propio alto.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div className="flex min-w-0 flex-col gap-px bg-slate-800 lg:min-h-0 lg:flex-1">
        {pano ? (
          <SliceCanvas
            className="flex items-center lg:min-h-0 lg:flex-[3]"
            image={pano}
            window={window}
            label="Panorámica reconstruida"
            tool={viewOnly ? "ninguna" : tool}
            overlay={tick}
            measures={measures
              .filter((m) => m.view === "panoramica")
              .flatMap((m) => {
                const points = projectOnPanorama(volume, curve, pano, m.points)
                return points ? [asPlane(m, points)] : []
              })}
            draft={draft?.view === "panoramica" ? draft.points : undefined}
            onPick={(p) => setIndex(clampIndex(p.x))}
            onMark={(p) => mark("panoramica", 0, pano, p)}
            onStep={(delta) => setIndex((i) => clampIndex(i + delta * perMm))}
          />
        ) : (
          <div role="status" className="m-auto max-w-md p-6 text-center text-sm text-slate-300">
            <p className="font-semibold text-slate-100">Marca el arco para armar la panorámica</p>
            <p className="mt-1">
              Haz clic en 5 puntos sobre el hueso del corte de la derecha, de un lado al otro (
              {marking.length} de 5). Mientras tanto, «Tres cortes» funciona.
            </p>
          </div>
        )}
        {crosses.length > 0 && (
          <div className="grid grid-cols-5 gap-px bg-slate-800 lg:min-h-0 lg:flex-[2]">
            {crosses.map((c, i) => {
              const k = CROSS_OFFSETS[i]!
              return (
                <SliceCanvas
                  key={k}
                  className={k === 0 ? "ring-2 ring-amber-500 ring-inset" : ""}
                  image={c.image}
                  window={window}
                  label={k === 0 ? "Corte elegido" : `${k > 0 ? "+" : "−"}${Math.abs(k)} mm`}
                  tool={viewOnly ? "ninguna" : tool}
                  measures={measures
                    .filter((m) => m.view === "transversal")
                    .flatMap((m) => {
                      const points = projectOnCross(volume, curve[c.at]!, c.image, m.points)
                      return points ? [asPlane(m, points)] : []
                    })}
                  draft={draft?.view === "transversal" && draft.at === c.at ? draft.points : undefined}
                  onPick={() => setIndex(clampIndex(c.at))}
                  onMark={(p) => mark("transversal", c.at, c.image, p)}
                  onStep={(delta) => setIndex((x) => clampIndex(x + delta * perMm))}
                />
              )
            })}
          </div>
        )}
        {curve.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 bg-[#05080c] px-4 py-2 text-xs text-slate-400">
            <span id="cortes-label">Cortes</span>
            <Slider
              aria-labelledby="cortes-label"
              className="min-w-40 flex-1"
              value={[clampIndex(index)]}
              min={2 * perMm}
              max={curve.length - 1 - 2 * perMm}
              step={1}
              onValueChange={(v) => setIndex(clampIndex(Array.isArray(v) ? (v[0] ?? 0) : (v as number)))}
            />
            <output className="min-w-40 font-semibold text-slate-100 tabular-nums">
              Corte {Math.round(curve[clampIndex(index)]!.s)} de {Math.round(curve[curve.length - 1]!.s)}
              {teethLabel ? ` · pieza ${teethLabel}` : ""}
            </output>
            <span>Cada corte: 1 mm · Rueda o ↑ ↓ para avanzar</span>
          </div>
        )}
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-px border-slate-800 bg-slate-800 lg:w-80 lg:border-l">
        <SliceCanvas
          className="flex items-center"
          image={axial}
          window={window}
          label="Desde arriba"
          technical="axial"
          tool={adjusting || noArch ? "ninguna" : viewOnly ? "ninguna" : tool}
          overlay={archOverlay}
          measures={measures
            .filter((m) => m.view === "axial" && m.points.every((p) => Math.abs(p[2] / volume.sz - axialZ) < 0.6))
            .map((m) => asPlane(m, m.points.map(([x, y]) => ({ x: x / volume.sx, y: y / volume.sy }))))}
          draft={draft?.view === "axial" ? draft.points : undefined}
          onPick={(p) => {
            if (adjusting) {
              setSelected(nearest(p))
              return
            }
            if (noArch && !viewOnly) {
              const next = [...marking, p]
              if (next.length < 5) setMarking(next)
              else {
                setControl([...next].sort((a, b) => a.x - b.x))
                setMarking([])
              }
              return
            }
            // Fuera de ajustar: elegir el punto del arco más cercano.
            let best = 0
            curve.forEach((c, i) => {
              if (Math.hypot(c.x - p.x, c.y - p.y) < Math.hypot(curve[best]!.x - p.x, curve[best]!.y - p.y)) best = i
            })
            if (curve.length) setIndex(clampIndex(best))
          }}
          onMark={(p) => mark("axial", 0, axial, p)}
          onStep={(delta) => setAxialZ((z) => Math.max(0, Math.min(volume.nz - 1, z + delta)))}
          onPointerDown={
            adjusting
              ? (p) => {
                  const i = nearest(p)
                  setSelected(i)
                  dragging.current = i !== null
                }
              : undefined
          }
          onPointerMove={adjusting ? (p) => dragging.current && selected !== null && movePoint(selected, p) : undefined}
          onPointerUp={() => {
            dragging.current = false
          }}
          onKey={
            adjusting
              ? (key) => {
                  if (/^[1-5]$/.test(key)) {
                    setSelected(Number(key) - 1)
                    return true
                  }
                  if (selected === null || !control) return false
                  const d = 0.5 / volume.sx
                  const move = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[key]
                  if (!move) return false
                  const c = control[selected]!
                  movePoint(selected, { x: c.x + move[0]!, y: c.y + move[1]! })
                  return true
                }
              : undefined
          }
        />
        <div className="flex flex-1 flex-col gap-3 bg-[#0d131b] p-4 text-sm">
          {adjusting && (
            <p className="rounded-lg bg-cyan-950/60 p-2 text-xs text-cyan-100">
              Arrastra los puntos del arco o elige uno con 1–5 y muévelo con las flechas.
              {proposal ? "" : " El visor no encontró el arco solo."}
            </p>
          )}
          {teeth.length > 0 && curve.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">Ir a la pieza</span>
              {teeth.map((t) => (
                <Button
                  key={t}
                  type="button"
                  size="sm"
                  variant={t === tooth ? "secondary" : "outline"}
                  onClick={() => {
                    setTooth(t)
                    const at = toothIndex(curve, t)
                    if (at !== null) setIndex(clampIndex(at))
                  }}
                >
                  {t}
                </Button>
              ))}
            </div>
          )}
          <MeasureList saved={saved} canWrite={canWrite} viewOnly={viewOnly} />
          <p className="text-xs text-slate-400">{note}</p>
          {canWrite && !viewOnly && pano && (
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                size="sm"
                disabled={!draftEncounter || saving === "saving"}
                onClick={() => void saveView()}
              >
                {saving === "saving" ? "Guardando…" : "Guardar vista en la atención"}
              </Button>
              <p className="text-xs text-slate-400" aria-live="polite">
                {saving === "saved"
                  ? "Vista guardada en la atención de hoy."
                  : saving === "error"
                    ? "No se pudo guardar la vista. Vuelve a intentarlo."
                    : draftEncounter
                      ? "La imagen con las medidas queda en la atención de hoy."
                      : "Abre la atención de hoy para guardar la vista."}
              </p>
            </div>
          )}
          <p className="text-xs text-slate-500">
            {Math.round(curve.length ? curve[curve.length - 1]!.s : 0).toLocaleString(activeOrgLocale())} mm de arco
          </p>
          {tool !== "ninguna" && !viewOnly && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onTool("ninguna")}>
              Terminar de medir
            </Button>
          )}
        </div>
      </aside>
    </div>
  )
}
