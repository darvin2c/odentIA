import { Button, Slider } from "@odentia/ui"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { apiFetch } from "../../lib/api"
import { API_URL } from "../../lib/auth-client"
import {
  ARCH_BEYOND_MM,
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
import { formatDate } from "../../lib/clinical-journey"
import { useMyUserId } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
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
  professionalUserId: string
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

/** El arco guardado con la tomografía, en mm del volumen (lo que devuelve la API). */
export interface SavedArch {
  arch: { points: [number, number][]; z: number } | null
  updatedAt: string | null
  updatedByName: string | null
}

/**
 * El arco: el guardado con la tomografía, el que propone el visor o el marcado
 * a mano (cinco puntos sobre el corte desde arriba).
 */
function useArch(volume: CbctVolume, saved: SavedArch["arch"]) {
  const proposal = useMemo(() => detectArch(volume), [volume])
  const [control, setControl] = useState<Point[] | null>(
    saved ? saved.points.map(([x, y]) => ({ x: x / volume.sx, y: y / volume.sy })) : (proposal?.control ?? null),
  )
  const [axialZ, setAxialZ] = useState(
    saved ? Math.round(saved.z / volume.sz) : (proposal?.z ?? Math.floor(volume.nz / 2)),
  )
  // El arco llega hasta el último esmalte; se prolonga hacia la rama para ver las terceras molares.
  const curve = useMemo(
    () => (control && control.length >= 5 ? sampleCurve(volume, control, undefined, ARCH_BEYOND_MM) : []),
    [volume, control],
  )
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
  onAdjustDone,
  savedArch,
  onTool,
  saved,
  note,
  phoneView,
}: {
  volume: CbctVolume
  window: WindowLevel
  tool: Tool
  viewOnly: boolean
  canWrite: boolean
  patientId: string
  doc: PatientDocument
  adjusting: boolean
  /** Termina «Ajustar el arco» (guardado o cancelado). */
  onAdjustDone: () => void
  /** El arco guardado con la tomografía, si alguien lo ajustó. */
  savedArch: SavedArch | null
  onTool: (tool: Tool) => void
  saved: SavedMeasures
  /** Medidas orientativas (decisión 9). */
  note: string
  /** En el celular, una vista grande a la vez: la panorámica o el corte elegido. */
  phoneView?: "panoramica" | "corte"
}) {
  const queryClient = useQueryClient()
  const { proposal, control, setControl, axialZ, setAxialZ, curve } = useArch(volume, savedArch?.arch ?? null)
  // El arco que vale al terminar o cancelar el ajuste: el guardado o el propuesto.
  const [archState, setArchState] = useState<{ baseline: Point[] | null; info: SavedArch | null }>(() => ({
    baseline: control,
    info: savedArch?.arch ? savedArch : null,
  }))
  const [archMessage, setArchMessage] = useState<string | null>(null)
  const saveArch = async (next: Point[] | null) => {
    if (!canWrite || viewOnly) return
    try {
      const { data } = await apiFetch<{ data: SavedArch }>(`/api/patients/${patientId}/imaging/studies/${doc.id}/arch`, {
        method: "PUT",
        body: JSON.stringify({
          arch: next
            ? { points: next.map((p) => [p.x * volume.sx, p.y * volume.sy]), z: axialZ * volume.sz }
            : null,
        }),
      })
      setArchState({ baseline: next ?? proposal?.control ?? null, info: data.arch ? data : null })
      setArchMessage(next ? "Arco guardado con la tomografía." : "Vuelve el arco que propone el visor.")
    } catch {
      setArchMessage("No se pudo guardar el arco. Vuelve a intentarlo.")
    }
  }
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
  // La pieza pedida que no cae sobre el arco: se dice en vez de marcarla como elegida.
  const [missing, setMissing] = useState<number | null>(null)
  const placed = useRef(false)
  useEffect(() => {
    if (!curve.length || placed.current) return
    placed.current = true
    const at = tooth ? toothIndex(curve, tooth) : null
    if (tooth && at === null) setMissing(tooth)
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
          ? view === "transversal"
            ? toothAt(curve, at, jaw, dentition)
            : panoramaTooth(points, image as CrossImage)
          : null,
    })
  }
  // La panorámica muestra los dos maxilares: la pieza sale de la altura de los
  // puntos respecto del plano oclusal, no de la pieza elegida. Si la medida cruza
  // de un maxilar al otro, queda sin pieza.
  const panoramaTooth = (points: Point[], image: CrossImage) => {
    const above = points.map((q) => image.zTop - q.y > occlusalZ)
    if (above.some((a) => a !== above[0])) return null
    return toothAt(curve, Math.round(points[0]!.x), above[0] ? "upper" : "lower", dentition)
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

  // Guardar vista: solo en la atención que lleva quien mira y que abrió hoy. La
  // ficha tiene a lo más un borrador, y puede ser de otro profesional o de otro día.
  const myUserId = useMyUserId()
  const encounters = useQuery({
    queryKey: ["encounters-open", patientId],
    queryFn: () => apiFetch<{ data: Encounter[] }>(`/api/patients/${patientId}/encounters?status=borrador&limit=5`),
    enabled: canWrite && !viewOnly,
  })
  const today = formatDate(new Date().toISOString())
  const draftEncounter =
    encounters.data?.data.find(
      (e) => e.status === "borrador" && e.professionalUserId === myUserId && formatDate(e.createdAt) === today,
    ) ?? null
  const draftTime = draftEncounter
    ? new Date(draftEncounter.createdAt).toLocaleTimeString(activeOrgLocale(), {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: activeOrgTimeZone(),
      })
    : null
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
      ctx.fillText("Medidas orientativas: para planificar una cirugía, confírmalas en el programa del tomógrafo.", 12, panoH + crossH + 58)
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

  const goToTooth = (t: number) => {
    setTooth(t)
    const at = toothIndex(curve, t)
    setMissing(at === null ? t : null)
    if (at !== null) setIndex(clampIndex(at))
  }
  const panelId = useId()
  // La columna derecha, en el orden del trabajo: ir a la pieza, medir y guardar lo visto.
  const toothSection = teeth.length > 0 && curve.length > 0 && (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-xs font-semibold tracking-wide text-slate-400 uppercase">Ir a la pieza</legend>
      <div className="flex flex-wrap gap-2">
        {teeth.map((t) => (
          <Button
            key={t}
            type="button"
            size="sm"
            variant={t === tooth && missing !== t ? "secondary" : "outline"}
            aria-pressed={t === tooth && missing !== t}
            aria-describedby={`${panelId}-tooth`}
            onClick={() => goToTooth(t)}
          >
            {t}
          </Button>
        ))}
      </div>
      <p id={`${panelId}-tooth`} className="text-xs text-slate-400" aria-live="polite">
        {missing
          ? `La ${missing} no cae sobre el arco: llega con la barra de cortes o ajusta el arco en «Más».`
          : "Lleva la panorámica y los cortes a esa pieza."}
      </p>
    </fieldset>
  )
  const attentionSection = canWrite && !viewOnly && pano && (
    <section aria-labelledby={`${panelId}-attention`} className="flex flex-col gap-2">
      <h3 id={`${panelId}-attention`} className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        En la atención
      </h3>
      {draftEncounter ? (
        <>
          <Button type="button" size="sm" disabled={saving === "saving"} onClick={() => void saveView()}>
            {saving === "saving" ? "Guardando…" : `Guardar en tu atención de hoy · ${draftTime}`}
          </Button>
          <p className="text-xs text-slate-400" aria-live="polite">
            {saving === "saved"
              ? "Guardada en tu atención de hoy, con las medidas."
              : saving === "error"
                ? "No se pudo guardar. Vuelve a intentarlo."
                : "Guarda esta imagen, con las medidas, en la nota de la atención."}
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-400">
          Para guardar esta imagen en la nota, abre tu atención de hoy con este paciente.
        </p>
      )}
    </section>
  )

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
  // Dónde está el corte elegido: la pieza y los mm a lo largo del arco (no la cantidad de cortes del archivo).
  const arcPosition = curve.length
    ? `${teethLabel ? `Pieza ${teethLabel} · ` : ""}${Math.round(curve[clampIndex(index)]!.s).toLocaleString(activeOrgLocale())} de ${Math.round(curve[curve.length - 1]!.s).toLocaleString(activeOrgLocale())} mm del arco`
    : ""
  if (phoneView) {
    const chosen = crosses[CROSS_OFFSETS.indexOf(0)]
    const step = (delta: number) => setIndex((i) => clampIndex(i + delta * perMm))
    return (
      // scroll-nativo: en el celular la vista grande va arriba y lo demás se desplaza debajo.
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {phoneView === "panoramica" ? (
          pano ? (
            <SliceCanvas
              className="flex items-center"
              image={pano}
              window={window}
              label="Panorámica reconstruida"
              tool="ninguna"
              overlay={tick}
              measures={measures
                .filter((m) => m.view === "panoramica")
                .flatMap((m) => {
                  const points = projectOnPanorama(volume, curve, pano, m.points)
                  return points ? [asPlane(m, points)] : []
                })}
              onPick={(p) => setIndex(clampIndex(p.x))}
              onStep={step}
            />
          ) : (
            <p role="status" className="m-auto max-w-sm p-6 text-center text-sm text-slate-300">
              El visor no encontró el arco. Para marcarlo, ábrela en una computadora; mientras
              tanto, «Cortes» funciona.
            </p>
          )
        ) : chosen ? (
          <SliceCanvas
            className="flex min-h-[55dvh] items-center"
            image={chosen.image}
            window={window}
            label={teethLabel ? `Corte de la pieza ${teethLabel}` : "Corte"}
            tool="ninguna"
            measures={measures
              .filter((m) => m.view === "transversal")
              .flatMap((m) => {
                const points = projectOnCross(volume, curve[chosen.at]!, chosen.image, m.points)
                return points ? [asPlane(m, points)] : []
              })}
            onStep={step}
            onSwipe={step}
          />
        ) : (
          <p role="status" className="m-auto max-w-sm p-6 text-center text-sm text-slate-300">
            Sin arco no hay cortes a lo largo de la boca. Para marcarlo, ábrela en una computadora.
          </p>
        )}
        {curve.length > 0 && (
          <div className="flex flex-col gap-1 border-t border-slate-800 px-3 py-2 text-xs text-slate-400">
            <div className="flex items-center gap-3">
              <span id="cortes-label-celular">A lo largo del arco</span>
              <Slider
                aria-labelledby="cortes-label-celular"
                className="min-w-32 flex-1"
                value={[clampIndex(index)]}
                min={2 * perMm}
                max={curve.length - 1 - 2 * perMm}
                step={1}
                onValueChange={(v) =>
                  setIndex(clampIndex(Array.isArray(v) ? (v[0] ?? 0) : (v as number)))
                }
              />
            </div>
            <output className="font-semibold text-slate-100 tabular-nums">{arcPosition}</output>
            {phoneView === "corte" && (
              <span>Desliza con el dedo para pasar al corte siguiente.</span>
            )}
          </div>
        )}
        <div className="flex flex-col gap-4 bg-[#0d131b] p-4 text-sm">
          {toothSection}
          <MeasureList saved={saved} canWrite={canWrite} viewOnly={viewOnly} note={note} />
        </div>
      </div>
    )
  }
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
              {marking.length} de 5). Mientras tanto, «Cortes» funciona.
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
                  zoomControls={false}
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
              {arcPosition}
            </output>
            <span>Cada corte: 1 mm · Rueda o ↑ ↓ avanzan · Ctrl + rueda acerca</span>
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
                const sorted = [...next].sort((a, b) => a.x - b.x)
                setControl(sorted)
                setMarking([])
                void saveArch(sorted)
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
          {adjusting ? (
            <div role="status" className="flex flex-col gap-2 rounded-lg bg-cyan-950/60 p-3 text-xs text-cyan-100">
              <p className="font-semibold">Ajustando el arco</p>
              <p>
                Arrastra los puntos sobre el corte de arriba, o elige uno con 1–5 y muévelo con las flechas.
                {proposal ? "" : " El visor no encontró el arco solo."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    if (control) void saveArch(control)
                    onAdjustDone()
                  }}
                >
                  {canWrite ? "Terminar y guardar" : "Terminar"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setControl(archState.baseline)
                    setArchMessage(null)
                    onAdjustDone()
                  }}
                >
                  Cancelar
                </Button>
                {canWrite && archState.info && proposal && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setControl(proposal.control)
                      void saveArch(null)
                      onAdjustDone()
                    }}
                  >
                    Volver al arco propuesto
                  </Button>
                )}
              </div>
            </div>
          ) : (
            (archMessage || archState.info) && (
              <p className="text-xs text-slate-400" aria-live="polite">
                {archMessage ??
                  `Arco ajustado a mano${archState.info?.updatedByName ? ` por ${archState.info.updatedByName}` : ""}${
                    archState.info?.updatedAt ? `, ${formatDate(archState.info.updatedAt)}` : ""
                  }.`}
              </p>
            )
          )}
          {toothSection}
          <MeasureList saved={saved} canWrite={canWrite} viewOnly={viewOnly} note={note} />
          {attentionSection}
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
