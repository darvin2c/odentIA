/**
 * El gráfico del periodontograma (lienzo, tablero 4): arriba y abajo, cada uno
 * visto por fuera y por dentro, con las coronas hacia el centro y a escala
 * (una línea gris cada 2 mm desde el límite del esmalte). La línea roja es el
 * borde de la encía, la azul el fondo de la bolsa y lo sombreado, la bolsa.
 * Pasar sobre un sitio dice sus medidas; clic o Enter en una pieza la elige.
 */
import { attachmentLoss, PERIODONTAL_SITE_WORDS, type PeriodontalToothRecord } from "@odentia/clinical"
import { cn, ScrollArea } from "@odentia/ui"
import { useEffect, useMemo, useRef, useState } from "react"
import { innerName, isUpper, MM, PlaqueTooth, rightSide, ToothShape } from "./anatomy"

/** Ancho de una pieza, margen de las etiquetas, alto de una fila y del dibujo, en px. */
const W = 43
const LBL = 100
const ROW = 15
const DRAW = 124
/** Dónde va cada uno de los tres sitios de una cara, en fracción del ancho de la pieza. */
const SX = [0.2, 0.5, 0.8] as const

export const UPPER_ROW = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]
export const LOWER_ROW = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38]

export type ChartFace = "out" | "in"
export interface ChartArch {
  teeth: number[]
  top: ChartFace
  bottom: ChartFace | null
  mobility?: boolean
  title?: string
  gap?: number
}

/** Las dos arcadas completas, como el periodontograma en papel. */
export const FULL_ARCHES: ChartArch[] = [
  { teeth: UPPER_ROW, top: "out", bottom: "in", mobility: true, title: "ARRIBA" },
  { teeth: LOWER_ROW, top: "in", bottom: "out", mobility: true, title: "ABAJO", gap: 4 },
]

type Row = "furca" | "bop" | "rec" | "pd"
const ROWS: Row[] = ["furca", "bop", "rec", "pd"]
const ROW_LABEL: Record<Row, string> = { furca: "Furca", bop: "Sangrado", rec: "Recesión", pd: "Profundidad" }

/** Los índices (orden guardado) de los tres sitios de una cara, de izquierda a derecha en pantalla. */
export function displaySites(tooth: number, face: ChartFace): [number, number, number] {
  if (face === "out") return rightSide(tooth) ? [2, 1, 0] : [0, 1, 2]
  return rightSide(tooth) ? [5, 4, 3] : [3, 4, 5]
}

const severity = (pd: number) => (pd >= 6 ? "deep" : pd >= 4 ? "warn" : "")
export const signed = (value: number) => (value < 0 ? `−${Math.abs(value)}` : String(value))

/** Entradas de furca de una cara: [posición del sitio, grado, dónde]. */
function furcationMarks(tooth: PeriodontalToothRecord | undefined, face: ChartFace): Array<[number, number, string]> {
  if (!tooth) return []
  const f = tooth.furcation
  const t = tooth.toothNumber
  const mesialX = rightSide(t) ? SX[2] : SX[0]
  const distalX = rightSide(t) ? SX[0] : SX[2]
  const out: Array<[number, number, string]> = []
  if (face === "out" && f.buccal) out.push([SX[1], f.buccal, "por fuera"])
  if (face === "in") {
    if (f.lingual) out.push([SX[1], f.lingual, "por dentro"])
    if (f.mesiopalatal) out.push([mesialX, f.mesiopalatal, "mesial por dentro"])
    if (f.distopalatal) out.push([distalX, f.distopalatal, "distal por dentro"])
    if (f.mesial) out.push([mesialX, f.mesial, "mesial"])
    if (f.distal) out.push([distalX, f.distal, "distal"])
  }
  return out
}

function Furcation({ x, y, grade }: { x: number; y: number; grade: number }) {
  const d = `M${x},${y - 4.5} L${x + 5},${y + 4} L${x - 5},${y + 4} Z`
  return (
    <>
      <path className="furca" d={d} />
      {grade === 2 ? <path className="furca-fill" d={`M${x},${y - 4.5} L${x},${y + 4} L${x - 5},${y + 4} Z`} /> : null}
      {grade === 3 ? <path className="furca-fill" d={d} /> : null}
    </>
  )
}

function linePath(xs: number[], ys: Array<number | null>): string {
  let d = ""
  let pen = false
  xs.forEach((x, j) => {
    const y = ys[j]
    if (y == null) {
      pen = false
      return
    }
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`
    pen = true
  })
  return d
}

function areaPath(xs: number[], a: Array<number | null>, b: Array<number | null>): string {
  let d = ""
  let seg: number[] = []
  const flush = () => {
    if (seg.length > 1) {
      d += `M${seg.map((j) => `${xs[j]!.toFixed(1)},${a[j]!.toFixed(1)}`).join("L")}L${[...seg]
        .reverse()
        .map((j) => `${xs[j]!.toFixed(1)},${b[j]!.toFixed(1)}`)
        .join("L")}Z`
    }
    seg = []
  }
  xs.forEach((_, j) => {
    if (a[j] == null || b[j] == null) flush()
    else seg.push(j)
  })
  flush()
  return d
}

interface FaceLayout {
  face: ChartFace
  teeth: number[]
  rowY: Partial<Record<Row, number>>
  top: number
  bottom: number
  cej: number
  /** 1: la raíz va hacia arriba; -1: hacia abajo. */
  flip: 1 | -1
  rowsAbove: boolean
  /** Tramos de sitios seguidos, cortados por las piezas ausentes. */
  runs: Array<Array<{ tooth: number; site: number; x: number }>>
}

interface Layout {
  width: number
  height: number
  faces: FaceLayout[]
  columns: Array<{ tooth: number; x0: number; top: number; bottom: number }>
  separators: Array<{ x: number; top: number; bottom: number; kind: "sep" | "mid" | "sext" }>
  titles: Array<{ y: number; text: string }>
  mobilityRows: Array<{ y: number; teeth: number[] }>
  numberRows: Array<{ y: number; teeth: number[] }>
  plaqueRows: Array<{ top: number; bottom: number; teeth: number[] }>
}

function buildLayout(arches: ChartArch[], present: (tooth: number) => boolean, plaque: boolean): Layout {
  const faces: FaceLayout[] = []
  const columns: Layout["columns"] = []
  const separators: Layout["separators"] = []
  const titles: Layout["titles"] = []
  const mobilityRows: Layout["mobilityRows"] = []
  const numberRows: Layout["numberRows"] = []
  const plaqueRows: Layout["plaqueRows"] = []
  let y = 4
  let maxCols = 0
  const face = (teeth: number[], faceName: ChartFace, rowsAbove: boolean, y0: number): number => {
    let yy = y0
    const rowY: FaceLayout["rowY"] = {}
    const doRows = (list: Row[]) => {
      for (const row of list) {
        rowY[row] = yy
        yy += ROW
      }
    }
    if (rowsAbove) doRows(ROWS)
    const top = yy
    const cej = rowsAbove ? top + 76 : top + 48
    const runs: FaceLayout["runs"] = []
    let current: FaceLayout["runs"][number] = []
    teeth.forEach((tooth, c) => {
      if (!present(tooth)) {
        if (current.length) runs.push(current)
        current = []
        return
      }
      displaySites(tooth, faceName).forEach((site, k) => {
        current.push({ tooth, site, x: LBL + c * W + W * SX[k]! })
      })
    })
    if (current.length) runs.push(current)
    yy = top + DRAW
    if (!rowsAbove) doRows([...ROWS].reverse())
    faces.push({ face: faceName, teeth, rowY, top: y0, bottom: yy, cej, flip: rowsAbove ? 1 : -1, rowsAbove, runs })
    return yy
  }
  for (const arch of arches) {
    maxCols = Math.max(maxCols, arch.teeth.length)
    if (arch.title) {
      titles.push({ y: y + 11, text: arch.title })
      y += 18
    }
    const top = y
    if (arch.mobility) {
      mobilityRows.push({ y, teeth: arch.teeth })
      y += ROW
    }
    y = face(arch.teeth, arch.top, true, y)
    numberRows.push({ y, teeth: arch.teeth })
    y += 24
    if (plaque) {
      plaqueRows.push({ top: y, bottom: y + 24, teeth: arch.teeth })
      y += 26
    }
    if (arch.bottom) y = face(arch.teeth, arch.bottom, false, y)
    const bottom = y
    arch.teeth.forEach((tooth, c) => {
      const x0 = LBL + c * W
      columns.push({ tooth, x0, top, bottom })
      if (c > 0) {
        const prev = arch.teeth[c - 1]!
        const mid = prev % 10 === 1 && tooth % 10 === 1
        const sext = (prev % 10 === 4 && tooth % 10 === 3) || (prev % 10 === 3 && tooth % 10 === 4)
        separators.push({ x: x0, top, bottom, kind: mid ? "mid" : sext ? "sext" : "sep" })
      }
    })
    y += arch.gap ?? 30
  }
  return { width: LBL + maxCols * W + 6, height: y, faces, columns, separators, titles, mobilityRows, numberRows, plaqueRows }
}

type Geometry = Map<string, { gm: number; bt: number }>

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

/** Las líneas se mueven a la medida nueva al cambiar de visita (520 ms), salvo con movimiento reducido. */
function useTweenedGeometry(target: Geometry, animate: boolean): Geometry {
  const [shown, setShown] = useState(target)
  const shownRef = useRef(target)
  useEffect(() => {
    const from = shownRef.current
    if (!animate || prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      shownRef.current = target
      setShown(target)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / 520)
      const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
      const mix: Geometry = new Map()
      for (const [key, to] of target) {
        const was = from.get(key)
        mix.set(key, was ? { gm: was.gm + (to.gm - was.gm) * e, bt: was.bt + (to.bt - was.bt) * e } : to)
      }
      shownRef.current = mix
      setShown(mix)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, animate])
  return shown
}

export interface PeriodontalChartProps {
  teeth: readonly PeriodontalToothRecord[]
  /** Piezas que se sondean: las demás se dibujan punteadas como ausentes. */
  expectedTeeth: readonly number[]
  implantTeeth: readonly number[]
  /** Otra visita: su fondo de la bolsa, punteado. */
  ghost?: readonly PeriodontalToothRecord[] | null
  /** «El 10 ago»: cómo se nombra la otra visita en las medidas del sitio. */
  ghostLabel?: string
  arches?: ChartArch[]
  /** Fila «Placa» con la pieza del odontograma bajo los números. */
  plaque?: boolean
  selected?: number | null
  onSelect?: (tooth: number) => void
  /** El sitio que se está midiendo, marcado con un triángulo. */
  marker?: { tooth: number; face: ChartFace; position: number } | null
  /** Las líneas se mueven a la medida nueva al cambiar de datos. */
  animate?: boolean
  label: string
  className?: string
}

export function PeriodontalChart({
  teeth,
  expectedTeeth,
  implantTeeth,
  ghost = null,
  ghostLabel = "La otra visita",
  arches = FULL_ARCHES,
  plaque = false,
  selected = null,
  onSelect,
  marker = null,
  animate = false,
  label,
  className,
}: PeriodontalChartProps): React.JSX.Element {
  const expected = useMemo(() => new Set(expectedTeeth), [expectedTeeth])
  const implants = useMemo(() => new Set(implantTeeth), [implantTeeth])
  const byTooth = useMemo(() => new Map(teeth.map((tooth) => [tooth.toothNumber, tooth])), [teeth])
  const ghostBy = useMemo(() => (ghost ? new Map(ghost.map((tooth) => [tooth.toothNumber, tooth])) : null), [ghost])
  const present = (tooth: number) => expected.has(tooth)
  const layout = useMemo(() => buildLayout(arches, (tooth) => expected.has(tooth), plaque), [arches, expected, plaque])

  const target = useMemo(() => {
    const geo: Geometry = new Map()
    for (const face of layout.faces) {
      for (const run of face.runs) {
        for (const s of run) {
          const tooth = byTooth.get(s.tooth)
          const pd = tooth?.probingDepth[s.site] ?? null
          const rec = tooth?.recession[s.site] ?? null
          if (pd === null || rec === null) continue
          geo.set(`${face.face}:${s.tooth}:${s.site}`, { gm: face.cej - face.flip * rec * MM, bt: face.cej - face.flip * (rec + pd) * MM })
        }
      }
    }
    return geo
  }, [layout, byTooth])
  const shown = useTweenedGeometry(target, animate)

  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const hitRefs = useRef<Array<SVGRectElement | null>>([])
  const [hover, setHover] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const [tip, setTip] = useState<{ left: number; top: number; title: string; lines: string[]; flags: string[] } | null>(null)
  const interactive = !!onSelect

  const siteTip = (event: React.MouseEvent, column: Layout["columns"][number]) => {
    const svg = svgRef.current
    const wrap = wrapRef.current
    if (!svg || !wrap) return
    const rect = svg.getBoundingClientRect()
    const scale = rect.width ? layout.width / rect.width : 1
    const px = (event.clientX - rect.left) * scale
    const py = (event.clientY - rect.top) * scale
    const t = column.tooth
    let next: NonNullable<typeof tip> | null = null
    const face = layout.faces.find((f) => f.teeth.includes(t) && py >= f.top && py <= f.bottom)
    const plaqueRow = layout.plaqueRows.find((r) => r.teeth.includes(t) && py >= r.top && py <= r.bottom)
    const record = byTooth.get(t)
    if (!present(t)) next = { left: 0, top: 0, title: `Pieza ${t}`, lines: ["Ausente en el odontograma"], flags: [] }
    else if (plaqueRow) {
      const marks = record?.plaque
      if (!marks || implants.has(t)) {
        setTip(null)
        return
      }
      const words = ["por fuera", "por dentro", "mesial", "distal"].filter((_, i) => marks[i])
      next = { left: 0, top: 0, title: `${t} · placa`, lines: [`${words.length} de 4 caras${words.length ? `: ${words.join(", ")}` : ""}`], flags: [] }
    } else if (face && record) {
      const rel = (px - column.x0) / W
      const k = rel < 0.36 ? 0 : rel < 0.64 ? 1 : 2
      const site = displaySites(t, face.face)[k]!
      const where = `${t} · ${PERIODONTAL_SITE_WORDS[site]}${implants.has(t) ? " (implante)" : ""}`
      const pd = record.probingDepth[site] ?? null
      const rec = record.recession[site] ?? null
      if (pd === null) next = { left: 0, top: 0, title: where, lines: [record.skipped ? "Pieza saltada" : "Sin medir todavía"], flags: [] }
      else {
        const lines = [`Bolsa ${pd} mm · recesión ${rec === null ? "sin medir" : `${signed(rec)} mm`}`]
        const loss = attachmentLoss(pd, rec)
        if (!implants.has(t) && loss !== null) lines.push(`Pérdida de inserción ${loss} mm`)
        const before = ghostBy?.get(t)?.probingDepth[site]
        if (before != null) lines.push(`${ghostLabel}: bolsa ${before} mm`)
        const flags = [record.bleeding[site] ? "Sangra" : "", record.suppuration[site] ? "Supura" : ""].filter(Boolean)
        next = { left: 0, top: 0, title: where, lines, flags }
      }
    }
    if (!next) {
      setTip(null)
      return
    }
    // La ventanita se ubica junto al cursor y se da vuelta antes de salirse de lo visible.
    const wrapRect = wrap.getBoundingClientRect()
    const visible = (wrap.closest("[data-slot=scroll-area]") ?? wrap).getBoundingClientRect()
    let left = event.clientX - wrapRect.left + 14
    let topPx = event.clientY - wrapRect.top + 14
    if (event.clientX + 214 > visible.right) left = event.clientX - wrapRect.left - 214
    if (topPx + 90 > wrapRect.height) topPx = event.clientY - wrapRect.top - 100
    setTip({ ...next, left: Math.max(visible.left - wrapRect.left, left), top: Math.max(0, topPx) })
  }

  const toothSummary = (t: number): string => {
    if (!present(t)) return `Pieza ${t}: ausente`
    const record = byTooth.get(t)
    const pds = record ? record.probingDepth.filter((v): v is number => v !== null) : []
    const implant = implants.has(t) ? ", implante" : ""
    if (record?.skipped) return `Pieza ${t}${implant}: saltada`
    if (!pds.length) return `Pieza ${t}${implant}: sin medir`
    const bleeding = record ? record.bleeding.filter((value, i) => value && record.probingDepth[i] !== null).length : 0
    return `Pieza ${t}${implant}: bolsa máxima ${Math.max(...pds)} mm, sangra en ${bleeding} de ${pds.length} sitios`
  }

  const markerPath = (() => {
    if (!marker) return null
    const face = layout.faces.find((f) => f.face === marker.face && f.teeth.includes(marker.tooth))
    if (!face) return null
    const c = face.teeth.indexOf(marker.tooth)
    const x = LBL + c * W + W * SX[marker.position as 0 | 1 | 2]!
    const yv = face.rowY.pd != null ? face.rowY.pd + ROW + 1 : face.top
    return `M${x - 4},${yv + 4} L${x + 4},${yv + 4} L${x},${yv - 1} Z`
  })()

  return (
    <ScrollArea horizontal className={cn("perio max-w-full", className)}>
      <div ref={wrapRef} className="relative w-max pb-2">
      <svg
        ref={svgRef}
        role={interactive ? "group" : "img"}
        aria-label={label}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        className="block max-w-none"
      >
        {/* Resalte de la pieza (debajo de todo). */}
        <g>
          {layout.columns.map((column) => (
            <rect
              key={`hl-${column.tooth}-${column.top}`}
              className={cn(
                "colhl",
                hover === column.tooth && "hover",
                selected === column.tooth && "sel",
                focused === column.tooth && "focus",
              )}
              x={column.x0 + 1}
              y={column.top - 2}
              width={W - 2}
              height={column.bottom - column.top + 4}
              rx={8}
            />
          ))}
        </g>
        {/* Escala: una línea cada 2 mm desde el límite del esmalte hacia la raíz. */}
        <g>
          {layout.faces.map((face) => {
            const x1 = LBL + face.teeth.length * W
            return (
              <g key={`grid-${face.top}`}>
                {[2, 4, 6, 8, 10].map((mm) => {
                  const yl = face.cej - face.flip * mm * MM
                  return (
                    <g key={mm}>
                      <line className="mm" x1={LBL} x2={x1} y1={yl} y2={yl} />
                      {mm % 4 === 0 ? (
                        <text className="tick" x={LBL - 4} y={yl + 3} textAnchor="end">
                          {mm}
                        </text>
                      ) : null}
                    </g>
                  )
                })}
                <text className="tick" x={LBL - 4} y={face.cej + 3} textAnchor="end">
                  0
                </text>
              </g>
            )
          })}
        </g>
        {/* Piezas. */}
        <g>
          {layout.faces.map((face) =>
            face.teeth.map((t, c) => {
              const x0 = LBL + c * W
              const cx = x0 + W / 2
              const transform = face.rowsAbove ? `translate(0 ${face.cej})` : `translate(0 ${face.cej}) scale(1 -1)`
              if (!present(t)) {
                return (
                  <g key={`tooth-${face.top}-${t}`}>
                    <g transform={transform}>
                      <ToothShape tooth={t} cx={cx} mode="ghost" view={face.face} />
                    </g>
                    <text className="tag" x={cx} y={face.rowsAbove ? face.cej + 22 : face.cej - 18} textAnchor="middle">
                      ausente
                    </text>
                  </g>
                )
              }
              return (
                <g key={`tooth-${face.top}-${t}`}>
                  <g transform={transform}>
                    <ToothShape tooth={t} cx={cx} mode={implants.has(t) ? "implant" : "tooth"} view={face.face} />
                  </g>
                  <line className="cej" x1={x0 + 5} x2={x0 + W - 5} y1={face.cej} y2={face.cej} />
                </g>
              )
            }),
          )}
        </g>
        {/* Bolsa, borde de la encía y fondo de la bolsa, por tramos. */}
        <g>
          {layout.faces.map((face) =>
            face.runs.map((run) => {
              const xs = run.map((s) => s.x)
              const gm = run.map((s) => shown.get(`${face.face}:${s.tooth}:${s.site}`)?.gm ?? null)
              const bt = run.map((s) => shown.get(`${face.face}:${s.tooth}:${s.site}`)?.bt ?? null)
              const gh = run.map((s) => {
                const before = ghostBy?.get(s.tooth)
                const pd = before?.probingDepth[s.site] ?? null
                const rec = before?.recession[s.site] ?? null
                return pd === null || rec === null ? null : face.cej - face.flip * (rec + pd) * MM
              })
              return (
                <g key={`run-${face.top}-${run[0]!.tooth}`}>
                  <path className="pocket" d={areaPath(xs, gm, bt)} />
                  {ghostBy ? <path className="cal ghost" d={linePath(xs, gh)} /> : null}
                  <path className="gm" d={linePath(xs, gm)} />
                  <path className="cal" d={linePath(xs, bt)} />
                  {run.map((s, j) =>
                    bt[j] == null ? null : <circle key={`${s.tooth}-${s.site}`} className="sitedot" cx={s.x} cy={bt[j]!} r={2.1} />,
                  )}
                </g>
              )
            }),
          )}
        </g>
        {/* Números, sangrado, furca, movilidad y placa. */}
        <g>
          {layout.titles.map((title) => (
            <text key={title.y} className="lbl-strong" x={0} y={title.y}>
              {title.text}
            </text>
          ))}
          {layout.mobilityRows.map((row) => (
            <g key={`mob-${row.y}`}>
              <text className="lbl" x={LBL - 8} y={row.y + 11} textAnchor="end">
                Movilidad
              </text>
              {row.teeth.map((t, c) => {
                const mobility = byTooth.get(t)?.mobility
                return mobility ? (
                  <text key={t} className="n warn" x={LBL + c * W + W / 2} y={row.y + 11.5} textAnchor="middle">
                    {mobility}
                  </text>
                ) : null
              })}
            </g>
          ))}
          {layout.faces.map((face) => (
            <g key={`rows-${face.top}`}>
              <text className="lbl-strong" x={0} y={face.cej - face.flip * 24 + 4}>
                {face.face === "out" ? "Por fuera" : "Por dentro"}
              </text>
              {ROWS.map((row) => {
                const yy = face.rowY[row]
                if (yy === undefined) return null
                return (
                  <g key={row}>
                    <text className="lbl" x={LBL - 8} y={yy + 11} textAnchor="end">
                      {ROW_LABEL[row]}
                    </text>
                    {face.teeth.map((t, c) => {
                      if (!present(t)) return null
                      const x0 = LBL + c * W
                      const record = byTooth.get(t)
                      if (row === "furca") {
                        return (
                          <g key={t}>
                            {furcationMarks(record, face.face).map(([sx, grade, where]) => (
                              <Furcation key={where} x={x0 + W * sx} y={yy + 8} grade={grade} />
                            ))}
                          </g>
                        )
                      }
                      return (
                        <g key={t}>
                          {displaySites(t, face.face).map((site, k) => {
                            const x = x0 + W * SX[k]!
                            const pd = record?.probingDepth[site] ?? null
                            const rec = record?.recession[site] ?? null
                            if (row === "bop") {
                              if (pd === null) return null
                              return (
                                <g key={site}>
                                  <circle className="site-empty" cx={x} cy={yy + 8} r={2.6} />
                                  {record?.bleeding[site] ? <circle className="bop" cx={x} cy={yy + 8} r={3.5} /> : null}
                                  {record?.suppuration[site] ? <circle className="sup" cx={x} cy={yy + 8} r={5.4} /> : null}
                                </g>
                              )
                            }
                            if (row === "pd") {
                              return (
                                <g key={site}>
                                  {pd !== null && pd >= 6 ? <rect className="n-bg" x={x - 6} y={yy + 1.5} width={12} height={13} rx={3} /> : null}
                                  <text className={cn("n", pd !== null && severity(pd))} x={x} y={yy + 11.5} textAnchor="middle">
                                    {pd === null ? "" : pd}
                                  </text>
                                </g>
                              )
                            }
                            return (
                              <text key={site} className={cn("n", rec === 0 && "zero")} x={x} y={yy + 11.5} textAnchor="middle">
                                {rec === null ? "" : signed(rec)}
                              </text>
                            )
                          })}
                        </g>
                      )
                    })}
                  </g>
                )
              })}
            </g>
          ))}
          {layout.numberRows.map((row) => (
            <g key={`num-${row.y}`}>
              <text className="lbl" x={LBL - 8} y={row.y + 15} textAnchor="end">
                Pieza
              </text>
              {row.teeth.map((t, c) => (
                <text key={t} className={cn("tn", !present(t) && "dim")} x={LBL + c * W + W / 2} y={row.y + 16} textAnchor="middle">
                  {t}
                </text>
              ))}
            </g>
          ))}
          {layout.plaqueRows.map((row) => (
            <g key={`plaque-${row.top}`}>
              <text className="lbl" x={LBL - 8} y={row.top + 14} textAnchor="end">
                Placa
              </text>
              {row.teeth.map((t, c) => {
                if (!present(t)) return null
                const cx = LBL + c * W + W / 2
                if (implants.has(t)) {
                  return (
                    <text key={t} className="tag" x={cx} y={row.top + 14} textAnchor="middle">
                      imp.
                    </text>
                  )
                }
                return <PlaqueTooth key={t} tooth={t} faces={byTooth.get(t)?.plaque ?? null} x={cx - 12} y={row.top + 1} width={24} />
              })}
            </g>
          ))}
        </g>
        <g>
          {layout.separators.map((s) => (
            <line key={`${s.x}-${s.top}`} className={s.kind} x1={s.x} x2={s.x} y1={s.top} y2={s.bottom} />
          ))}
        </g>
        {markerPath ? <path className="marker" d={markerPath} /> : null}
        {/* Zonas que se tocan: una por pieza, con su resumen para el lector de pantalla. */}
        {interactive ? (
          <g>
            {layout.columns.map((column, idx) => (
              // biome-ignore lint/a11y/useSemanticElements: la zona es la columna de la pieza en el dibujo; en un SVG no hay botón nativo.
              <rect
                key={`hit-${column.tooth}-${column.top}`}
                ref={(node) => {
                  hitRefs.current[idx] = node
                }}
                className="hit"
                x={column.x0}
                y={column.top - 2}
                width={W}
                height={column.bottom - column.top + 4}
                tabIndex={0}
                role="button"
                aria-pressed={selected === column.tooth}
                aria-label={toothSummary(column.tooth)}
                onMouseEnter={() => setHover(column.tooth)}
                onMouseLeave={() => {
                  setHover(null)
                  setTip(null)
                }}
                onMouseMove={(event) => siteTip(event, column)}
                onClick={() => onSelect?.(column.tooth)}
                onFocus={() => setFocused(column.tooth)}
                onBlur={() => setFocused(null)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onSelect?.(column.tooth)
                  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                    const next = hitRefs.current[idx + (event.key === "ArrowRight" ? 1 : -1)]
                    if (next) {
                      event.preventDefault()
                      next.focus()
                    }
                  }
                }}
              />
            ))}
          </g>
        ) : null}
      </svg>
      {tip ? (
        <div
          role="presentation"
          className="pointer-events-none absolute z-10 flex min-w-40 flex-col gap-px rounded-lg bg-foreground px-2.5 py-2 text-xs leading-snug text-background shadow-lg"
          style={{ left: tip.left, top: tip.top }}
        >
          <b className="text-[0.8rem]">{tip.title}</b>
          {tip.lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
          {tip.flags.length ? (
            <span className="mt-0.5 flex gap-1.5">
              {tip.flags.map((flag) => (
                <span key={flag} className="rounded-full bg-background/25 px-1.5 text-[0.7rem] font-bold">
                  {flag}
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      </div>
    </ScrollArea>
  )
}

/** Leyenda del gráfico: los colores y las marcas, con palabras. */
export function PeriodontalLegend({ plaque = false }: { plaque?: boolean }) {
  const swatch = (style: React.CSSProperties) => <span aria-hidden="true" className="legend-swatch" style={style} />
  return (
    <div className="perio flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <span>
        {swatch({ background: "var(--perio-gm)", height: 3, borderRadius: 2 })}Borde de la encía
      </span>
      <span>
        {swatch({ background: "var(--perio-cal)", height: 3, borderRadius: 2 })}Fondo de la bolsa
      </span>
      <span>{swatch({ background: "var(--perio-pocket)" })}Bolsa</span>
      <span>{swatch({ background: "var(--perio-bop)", borderRadius: 999, width: 8, height: 8 })}Sangra</span>
      <span>{swatch({ border: "2px solid var(--perio-sup)", borderRadius: 999, width: 10, height: 10 })}Supura</span>
      {plaque ? <span>{swatch({ background: "var(--perio-plaque)" })}Placa (O'Leary)</span> : null}
      <span>
        Profundidad: <b className="text-warning">4–5 mm</b> · <b className="text-danger">6 mm o más</b>
      </span>
      <span>Furca: △ I · ◭ II · ▲ III</span>
    </div>
  )
}

export { innerName, isUpper }
