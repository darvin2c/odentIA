import {
  conditionLabel,
  FDI_ADULT_ROWS,
  FDI_CHILD_ROWS,
  findingAbbreviation,
  findingColor,
  surfaceLabel,
  toothTypeOf,
} from "@odentia/dental"
import { useId } from "react"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { activeOrgLocale, activeOrgTimeZone } from "@odentia/clinic-app/lib/locale"

export interface OdontogramDocumentProps {
  entries: OdontogramEntry[]
  /** Norma con la que se dibuja y se firma («NTS 188-MINSA/DGIESP-2022»). */
  standard: string
  date?: string
  specifications?: string
  observations?: string
  examinerName?: string
  /** Título de quien firma, de su perfil («Cirujano dentista»). */
  examinerTitle?: string
  registrationNumber?: string
  patientName?: string
}

const RED = "#dc2626"
const BLUE = "#2563eb"
const INK = "#111111"

const SPAN_CONDITIONS: Record<string, true> = {
  fixed_partial_denture: true,
  complete_denture: true,
  removable_partial_denture: true,
  fixed_orthodontic_appliance: true,
  removable_orthodontic_appliance: true,
  edentulous_arch: true,
}

const PAIR_CONDITIONS: Record<string, true> = {
  diastema: true,
  supernumerary_tooth: true,
  transposition: true,
  fusion: true,
}

const FILL_CONDITIONS: Record<string, true> = { caries: true, definitive_restoration: true }
const CONTOUR_CONDITIONS: Record<string, true> = { temporary_restoration: true, tooth_wear: true }

const CELL = 60
const NUM_H = 24
const ROOT_LEN = 26
const CROWN_W = 46
const CROWN_H = 44
const MID_MARGIN = 18

function paintHex(entry: OdontogramEntry): string | null {
  if (entry.needsReview) return null
  const color = findingColor(entry)
  if (color === "red") return RED
  if (color === "blue") return BLUE
  return null
}

function abbreviation(entry: OdontogramEntry): string {
  try {
    return findingAbbreviation(entry) ?? ""
  } catch {
    return ""
  }
}

function involvedTeeth(entry: OdontogramEntry): number[] {
  const related = entry.details?.relatedTeeth
  if (related && related.length > 0) return [...new Set([entry.toothNumber, ...related])]
  return [entry.toothNumber]
}

function isMolarTooth(tooth: number): boolean {
  return toothTypeOf(tooth) === "molar"
}

function isAnteriorTooth(tooth: number): boolean {
  const kind = toothTypeOf(tooth)
  return kind === "incisor" || kind === "canine"
}

interface GraphicEntry {
  entry: OdontogramEntry
  paint: string
}

function graphicOf(live: OdontogramEntry[], tooth: number): GraphicEntry[] {
  const out: GraphicEntry[] = []
  for (const entry of live) {
    if (entry.toothNumber !== tooth) continue
    const paint = paintHex(entry)
    if (paint) out.push({ entry, paint })
  }
  return out
}

interface CrownGeom {
  x: number
  y: number
  cx: number
}

/** Polígono de la zona de una superficie (claves en inglés) sobre la corona cuadrada. */
function zonePolygon(
  surface: string,
  tooth: number,
  index: number,
  count: number,
  g: CrownGeom,
): string {
  const { x, y, cx } = g
  const yb = y + CROWN_H
  const mesialOnRight = index < count / 2
  const leftKey = mesialOnRight ? "distal" : "mesial"
  const outerKey = isAnteriorTooth(tooth) ? "facial" : "buccal"
  const quadrant = Math.trunc(tooth / 10)
  const innerKey =
    quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6 ? "palatal" : "lingual"
  const centralKey = isAnteriorTooth(tooth) ? "incisal" : "occlusal"
  const ix0 = cx - 9
  const ix1 = cx + 9
  const iy0 = y + 14
  const iy1 = yb - 14
  const topKey =
    quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6 ? outerKey : innerKey
  if (surface === topKey) return `${x},${y} ${x + CROWN_W},${y} ${ix1},${iy0} ${ix0},${iy0}`
  if (surface === (topKey === outerKey ? innerKey : outerKey))
    return `${x},${yb} ${x + CROWN_W},${yb} ${ix1},${iy1} ${ix0},${iy1}`
  if (surface === leftKey) return `${x},${y} ${ix0},${iy0} ${ix0},${iy1} ${x},${yb}`
  if (surface === centralKey) return `${ix0},${iy0} ${ix1},${iy0} ${ix1},${iy1} ${ix0},${iy1}`
  return `${x + CROWN_W},${y} ${ix1},${iy0} ${ix1},${iy1} ${x + CROWN_W},${yb}`
}

function CrownSymbol({
  graphic,
  g,
  marker,
  upper,
  mesialOnRight,
}: {
  graphic: GraphicEntry[]
  g: CrownGeom
  marker: (paint: string) => string
  upper: boolean
  mesialOnRight: boolean
}) {
  const { x, y, cx } = g
  const yb = y + CROWN_H
  const mid = y + CROWN_H / 2
  return (
    <g pointerEvents="none">
      {graphic.map(({ entry, paint }) => {
        const key = `${entry.id}-sym`
        switch (entry.condition) {
          case "missing_tooth":
            return (
              <g key={key} stroke={paint} strokeWidth={2.4} strokeLinecap="round">
                <line
                  x1={x + 4}
                  y1={upper ? y - ROOT_LEN : y}
                  x2={x + CROWN_W - 4}
                  y2={upper ? yb : yb + ROOT_LEN}
                />
                <line
                  x1={x + CROWN_W - 4}
                  y1={upper ? y - ROOT_LEN : y}
                  x2={x + 4}
                  y2={upper ? yb : yb + ROOT_LEN}
                />
              </g>
            )
          case "crown":
          case "temporary_crown":
            return (
              <rect
                key={key}
                x={x - 2}
                y={y - 2}
                width={CROWN_W + 4}
                height={CROWN_H + 4}
                fill="none"
                stroke={paint}
                strokeWidth={1.8}
              />
            )
          case "post_and_core":
            return (
              <g key={key} stroke={paint} strokeWidth={1.8}>
                <line
                  x1={cx}
                  y1={upper ? y - ROOT_LEN : y}
                  x2={cx}
                  y2={upper ? yb : yb + ROOT_LEN}
                />
                <rect x={cx - 7} y={mid - 8} width={14} height={16} fill="none" />
              </g>
            )
          case "root_canal_treatment":
            return (
              <line
                key={key}
                x1={cx}
                y1={upper ? y - ROOT_LEN : y}
                x2={cx}
                y2={upper ? yb : yb + ROOT_LEN}
                stroke={paint}
                strokeWidth={2}
              />
            )
          case "pulpotomy":
            return (
              <rect
                key={key}
                x={cx - 6}
                y={y + 8}
                width={12}
                height={14}
                rx={4}
                fill={paint}
                fillOpacity={0.35}
                stroke={paint}
                strokeWidth={1.6}
              />
            )
          case "rotation": {
            const clockwise = entry.details?.direction === "clockwise"
            const forward = upper ? !clockwise : clockwise
            const baseline = upper ? yb + 3 : y - 3
            return (
              <path
                key={key}
                d={`M ${cx + (forward ? -12 : 12)} ${baseline} Q ${cx} ${upper ? yb + 18 : y - 18} ${cx + (forward ? 12 : -12)} ${baseline}`}
                fill="none"
                stroke={paint}
                strokeWidth={1.6}
                markerEnd={marker(paint)}
              />
            )
          }
          case "erupting_tooth":
            return (
              <polyline
                key={key}
                points={[
                  [0, 6],
                  [-4, 14],
                  [3, 20],
                  [-2, 26],
                  [1, 32],
                ]
                  .map(([dx, dy]) => `${cx + dx},${upper ? y + dy : yb - dy}`)
                  .join(" ")}
                fill="none"
                stroke={paint}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={marker(paint)}
              />
            )
          case "sealant": {
            if (entry.details?.drawing?.length) return null
            let sx = cx
            let sy = mid
            if (entry.surface === "mesial" || entry.surface === "distal")
              sx += ((entry.surface === "mesial") === mesialOnRight ? 1 : -1) * 16
            else if (entry.surface === "buccal" || entry.surface === "facial")
              sy = upper ? y + 7 : yb - 7
            else if (entry.surface === "palatal" || entry.surface === "lingual")
              sy = upper ? yb - 7 : y + 7
            return (
              <path
                key={key}
                d={`M${sx - 5},${sy + 2} L${sx - 1},${sy - 1} L${sx + 4},${sy + 2} M${sx - 1},${sy - 1} L${sx + 1},${sy - 4}`}
                fill="none"
                stroke={paint}
                strokeWidth={2}
                strokeLinecap="round"
              />
            )
          }
          case "gemination":
            return null
          case "peg_tooth":
            return (
              <polygon
                key={key}
                points={`${cx},${upper ? y - ROOT_LEN - 10 : yb + ROOT_LEN + 10} ${cx - 5},${upper ? y - ROOT_LEN - 2 : yb + ROOT_LEN + 2} ${cx + 5},${upper ? y - ROOT_LEN - 2 : yb + ROOT_LEN + 2}`}
                fill="none"
                stroke={paint}
                strokeWidth={1.6}
              />
            )
          default:
            return null
        }
      })}
    </g>
  )
}

/** Trazos clínicos persistidos: la mitad coronal va a la corona cuadrada y la mitad radicular al segmento de raíces. */
function DrawingStrokes({
  graphic,
  g,
  upper,
}: {
  graphic: GraphicEntry[]
  g: CrownGeom
  upper: boolean
}) {
  const { x, y, cx } = g
  const mapPoint = (p: number[]): string => {
    const px = (p[0] * 24) / 100
    const py = (p[1] * 28) / 100
    const mappedX = x + ((px - 5) / 14) * CROWN_W
    const mappedY =
      py <= 13.5
        ? upper
          ? y + CROWN_H - ((py - 2.5) / 11) * CROWN_H
          : y + ((py - 2.5) / 11) * CROWN_H
        : upper
          ? y - ((py - 13.5) / 14.5) * ROOT_LEN
          : y + CROWN_H + ((py - 13.5) / 14.5) * ROOT_LEN
    return `${mappedX.toFixed(1)},${mappedY.toFixed(1)}`
  }
  return (
    <g pointerEvents="none" aria-hidden="true">
      {graphic.flatMap(({ entry, paint }) => {
        const drawing = entry.details?.drawing
        if (!drawing) return []
        return drawing.flatMap((stroke, i) => {
          if (stroke.length === 0) return []
          if (stroke.length === 1) {
            const [sx, sy] = mapPoint(stroke[0]).split(",").map(Number)
            return [<circle key={`${entry.id}-d-${i}`} cx={sx} cy={sy} r={1.6} fill={paint} />]
          }
          return [
            <polyline
              key={`${entry.id}-d-${i}`}
              points={stroke.map((p) => mapPoint(p)).join(" ")}
              fill={FILL_CONDITIONS[entry.condition] && stroke.length >= 3 ? paint : "none"}
              stroke={paint}
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />,
          ]
        })
      })}
    </g>
  )
}

interface SpanDraw {
  id: string
  condition: string
  paint: string
  x0: number
  x1: number
  abutments: number[]
}

function spansFor(live: OdontogramEntry[], row: readonly number[]): SpanDraw[] {
  const out: SpanDraw[] = []
  const seen = new Set<string>()
  for (const entry of live) {
    if (!SPAN_CONDITIONS[entry.condition] || seen.has(entry.id)) continue
    const paint = paintHex(entry)
    if (!paint) continue
    seen.add(entry.id)
    const idxs = involvedTeeth(entry)
      .filter((t) => row.includes(t))
      .map((t) => row.indexOf(t))
      .sort((a, b) => a - b)
    if (idxs.length === 0) continue
    const abutments = (entry.details?.abutmentTeeth ?? [])
      .filter((t) => row.includes(t))
      .map((t) => row.indexOf(t) * CELL + CELL / 2)
    out.push({
      id: entry.id,
      condition: entry.condition,
      paint,
      x0: idxs[0] * CELL + 8,
      x1: idxs[idxs.length - 1] * CELL + CELL - 8,
      abutments,
    })
  }
  return out
}

interface PairDraw {
  condition: string
  paint: string
  gap: number
  right: number
}

function pairsFor(live: OdontogramEntry[], row: readonly number[]): PairDraw[] {
  return live.flatMap((entry) => {
    if (!PAIR_CONDITIONS[entry.condition]) return []
    const paint = paintHex(entry)
    const indices = involvedTeeth(entry)
      .map((tooth) => row.indexOf(tooth))
      .sort((a, b) => a - b)
    if (!paint || indices.length !== 2 || indices[0] < 0) return []
    return [{ condition: entry.condition, paint, gap: indices[0], right: indices[1] }]
  })
}

function DocRow({
  teeth,
  upper,
  entries: live,
}: {
  teeth: readonly number[]
  upper: boolean
  entries: OdontogramEntry[]
}) {
  const rowId = useId().replace(/[^a-zA-Z0-9]/g, "")
  const n = teeth.length
  const W = n * CELL
  const ownAbbr = teeth.map((tooth) => {
    const labels = new Map<string, { text: string; paint: string }>()
    for (const entry of live) {
      if (entry.toothNumber !== tooth || entry.needsReview) continue
      const text = abbreviation(entry)
      const paint = paintHex(entry)
      if (text && paint) labels.set(`${text}:${paint}`, { text, paint })
    }
    return [...labels.values()]
  })
  const maxAbbr = Math.max(1, ...ownAbbr.map((a) => a.length))
  const siglaH = 20 + 12 * maxAbbr
  const crownTop = upper ? siglaH + NUM_H + 12 + ROOT_LEN : MID_MARGIN
  const crownBottom = crownTop + CROWN_H
  const H = upper ? crownBottom + MID_MARGIN : crownBottom + ROOT_LEN + 12 + NUM_H + siglaH
  const numY = upper ? siglaH + NUM_H / 2 : crownBottom + ROOT_LEN + 12 + NUM_H / 2
  const siglaY = upper ? 0 : H - siglaH
  const apexY = upper ? crownTop - ROOT_LEN - 5 : crownBottom + ROOT_LEN + 5
  const crownLineY = (crownTop + crownBottom) / 2
  const marker = (paint: string) => `url(#${rowId}-${paint === RED ? "r" : "b"})`
  const spans = spansFor(live, teeth)
  const pairs = pairsFor(live, teeth)
  const geom = (i: number): CrownGeom => ({
    x: i * CELL + (CELL - CROWN_W) / 2,
    y: crownTop,
    cx: i * CELL + CELL / 2,
  })

  const zigzag = (x0: number, x1: number, yBase: number): string => {
    const pts: string[] = []
    let up = true
    for (let px = x0; px <= x1; px += 12) {
      pts.push(`${px},${yBase + (up ? -8 : 8)}`)
      up = !up
    }
    pts.push(`${x1},${yBase}`)
    return pts.join(" ")
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={`mx-auto block ${n > 12 ? "w-full odonto-doc-row-16" : "w-[62.5%] odonto-doc-row-10"}`}
      role="group"
      aria-label={upper ? "Arcada superior" : "Arcada inferior"}
    >
      <defs>
        {(
          [
            ["r", RED],
            ["b", BLUE],
          ] as const
        ).map(([name, color]) => (
          <marker
            key={name}
            id={`${rowId}-${name}`}
            viewBox="0 0 6 5"
            refX={4.6}
            refY={2.5}
            markerWidth={4}
            markerHeight={3.4}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0.4,0.4 L5.6,2.5 L0.4,4.6 z" fill={color} />
          </marker>
        ))}
      </defs>

      {teeth.map((tooth, i) => (
        <text
          key={`num-${tooth}`}
          x={i * CELL + CELL / 2}
          y={numY}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={13}
          fontWeight={700}
          fill={INK}
        >
          {tooth}
        </text>
      ))}

      {teeth.map((tooth, i) => {
        const g = geom(i)
        const graphic = graphicOf(live, tooth)
        const fills = new Map<string, string>()
        for (const { entry, paint } of graphic) {
          if (FILL_CONDITIONS[entry.condition] && entry.surface && !fills.has(entry.surface))
            fills.set(entry.surface, paint)
        }
        const contours = new Map<string, string>()
        for (const { entry, paint } of graphic) {
          if (CONTOUR_CONDITIONS[entry.condition] && entry.surface && !contours.has(entry.surface))
            contours.set(entry.surface, paint)
        }
        const roots = isMolarTooth(tooth) ? 3 : toothTypeOf(tooth) === "premolar" ? 2 : 1
        return (
          <g key={`tooth-${tooth}`}>
            {Array.from({ length: roots }, (_, r) => {
              const x0 = g.x + (r * CROWN_W) / roots
              const x1 = x0 + CROWN_W / roots
              const baseY = upper ? g.y : g.y + CROWN_H
              const tipY = upper ? g.y - ROOT_LEN : g.y + CROWN_H + ROOT_LEN
              return (
                <path
                  key={r}
                  d={`M${x0},${baseY} L${(x0 + x1) / 2},${tipY} L${x1},${baseY}`}
                  fill="none"
                  stroke={INK}
                  strokeWidth={1.6}
                />
              )
            })}
            <rect
              x={g.x}
              y={g.y}
              width={CROWN_W}
              height={CROWN_H}
              fill="#fff"
              stroke={INK}
              strokeWidth={1.6}
            />
            {[...fills.entries()].map(([surface, paint]) => (
              <polygon key={surface} points={zonePolygon(surface, tooth, i, n, g)} fill={paint} />
            ))}
            <g stroke={INK} strokeWidth={0.8} fill="none">
              <rect x={g.cx - 9} y={g.y + 14} width={18} height={CROWN_H - 28} />
              <line x1={g.x} y1={g.y} x2={g.cx - 9} y2={g.y + 14} />
              <line x1={g.x + CROWN_W} y1={g.y} x2={g.cx + 9} y2={g.y + 14} />
              <line x1={g.x} y1={g.y + CROWN_H} x2={g.cx - 9} y2={g.y + CROWN_H - 14} />
              <line x1={g.x + CROWN_W} y1={g.y + CROWN_H} x2={g.cx + 9} y2={g.y + CROWN_H - 14} />
            </g>
            {[...contours.entries()].map(([surface, paint]) => (
              <polygon
                key={surface}
                points={zonePolygon(surface, tooth, i, n, g)}
                fill="none"
                stroke={paint}
                strokeWidth={2}
              />
            ))}
            <CrownSymbol
              graphic={graphic}
              g={g}
              marker={marker}
              upper={upper}
              mesialOnRight={i < n / 2}
            />
            <DrawingStrokes graphic={graphic} g={g} upper={upper} />
            {graphic
              .filter(
                ({ entry }) =>
                  entry.condition === "extruded_tooth" || entry.condition === "intruded_tooth",
              )
              .map(({ entry, paint }) => {
                const ay = upper ? g.y + CROWN_H + 5 : g.y - 5
                const outward = entry.condition === "extruded_tooth"
                const y1 = upper ? (outward ? ay : ay + 11) : outward ? ay : ay - 11
                const y2 = upper ? (outward ? ay + 11 : ay) : outward ? ay - 11 : ay
                return (
                  <line
                    key={`${entry.id}-arr`}
                    x1={g.cx}
                    y1={y1}
                    x2={g.cx}
                    y2={y2}
                    stroke={paint}
                    strokeWidth={1.6}
                    markerEnd={marker(paint)}
                  />
                )
              })}
          </g>
        )
      })}

      {teeth.map((tooth, i) => (
        <rect
          key={`recuadro-${tooth}`}
          x={i * CELL}
          y={siglaY}
          width={CELL}
          height={siglaH}
          fill="none"
          stroke={INK}
          strokeWidth={1.3}
        />
      ))}
      {teeth.flatMap((tooth, i) =>
        live
          .filter((entry) => entry.toothNumber === tooth && entry.condition === "gemination")
          .map((entry) => (
            <circle
              key={entry.id}
              cx={i * CELL + CELL / 2}
              cy={numY}
              r={14}
              fill="none"
              stroke={paintHex(entry) ?? "none"}
              strokeWidth={2}
            />
          )),
      )}
      {ownAbbr.flatMap((labels, i) =>
        labels.map(({ text, paint }, line) => (
          <text
            key={`${i}-${text}-${paint}`}
            x={i * CELL + CELL / 2}
            y={siglaY + 14 + line * 12}
            textAnchor="middle"
            fontSize={10}
            fontWeight={700}
            fill={paint}
          >
            {text}
          </text>
        )),
      )}

      {spans.map((s) => (
        <g key={s.id} fill="none" stroke={s.paint} strokeWidth={2.4} strokeLinecap="round">
          {s.condition === "edentulous_arch" ? (
            <line x1={s.x0} y1={crownLineY} x2={s.x1} y2={crownLineY} />
          ) : s.condition === "removable_orthodontic_appliance" ? (
            <polyline points={zigzag(s.x0, s.x1, apexY)} strokeWidth={2} strokeLinejoin="round" />
          ) : s.condition === "fixed_orthodontic_appliance" ? (
            <g>
              <line x1={s.x0} y1={apexY} x2={s.x1} y2={apexY} />
              <rect x={s.x0 - 7} y={apexY - 8} width={14} height={16} />
              <rect x={s.x1 - 7} y={apexY - 8} width={14} height={16} />
              {[s.x0, s.x1].map((cx) => (
                <path
                  key={cx}
                  d={`M${cx - 4},${apexY - 5} L${cx + 4},${apexY + 5} M${cx + 4},${apexY - 5} L${cx - 4},${apexY + 5}`}
                />
              ))}
            </g>
          ) : s.condition === "fixed_partial_denture" ? (
            <g>
              <line x1={s.x0} y1={apexY} x2={s.x1} y2={apexY} />
              {s.abutments.map((ax) => (
                <line key={ax} x1={ax} y1={apexY - 12} x2={ax} y2={apexY + 12} />
              ))}
            </g>
          ) : (
            <g>
              <line x1={s.x0} y1={apexY - 6} x2={s.x1} y2={apexY - 6} />
              <line x1={s.x0} y1={apexY + 6} x2={s.x1} y2={apexY + 6} />
            </g>
          )}
        </g>
      ))}

      {pairs.map((p, pi) => {
        const bx = ((p.gap + p.right + 1) * CELL) / 2
        const key = `${p.condition}-${pi}`
        if (p.condition === "fusion") {
          const leftX = p.gap * CELL + CELL / 2
          const rightX = p.right * CELL + CELL / 2
          return (
            <g key={key} fill="none" stroke={p.paint} strokeWidth={2}>
              <ellipse cx={leftX + 9} cy={numY} rx={23} ry={14} />
              <ellipse cx={rightX - 9} cy={numY} rx={23} ry={14} />
            </g>
          )
        }
        if (p.condition === "transposition") {
          return (
            <g key={key} fill="none" stroke={p.paint} strokeWidth={1.8}>
              <path
                d={`M ${p.gap * CELL + CELL / 2} ${numY - 7} Q ${bx} ${numY + 15} ${p.right * CELL + CELL / 2} ${numY + 7}`}
                markerEnd={marker(p.paint)}
              />
              <path
                d={`M ${p.right * CELL + CELL / 2} ${numY - 7} Q ${bx} ${numY + 15} ${p.gap * CELL + CELL / 2} ${numY + 7}`}
                markerEnd={marker(p.paint)}
              />
            </g>
          )
        }
        if (p.condition === "supernumerary_tooth") {
          return (
            <g key={key}>
              <circle cx={bx} cy={apexY} r={9} fill="#fff" stroke={p.paint} strokeWidth={2} />
              <text
                x={bx}
                y={apexY}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={11}
                fontWeight={700}
                fill={p.paint}
              >
                S
              </text>
            </g>
          )
        }
        const my = crownTop + CROWN_H / 2
        return (
          <g key={key} fill="none" stroke={p.paint} strokeWidth={2}>
            <path d={`M ${bx - 5} ${my - 12} Q ${bx + 3} ${my} ${bx - 5} ${my + 12}`} />
            <path d={`M ${bx + 5} ${my - 12} Q ${bx - 3} ${my} ${bx + 5} ${my + 12}`} />
          </g>
        )
      })}
    </svg>
  )
}

function formatDate(raw?: string): string {
  if (!raw) return ""
  const time = new Date(raw).getTime()
  if (Number.isNaN(time)) return raw
  // La fecha del documento es la de la clínica, no la del navegador que imprime.
  return new Date(raw).toLocaleDateString(activeOrgLocale(), { timeZone: activeOrgTimeZone() })
}

/**
 * Gráfico oficial del odontograma (solo en clínicas de Perú: NTS 188; ADR
 * 0036): un SVG por fila con piezas, franja externa de números, recuadros de
 * siglas, coronas cuadradas de 5 zonas, raíces y overlays continuos de parejas
 * y tramos. El gráfico va en negro (5.17) y los hallazgos en rojo o azul
 * (5.12 y 5.13). Respeta los entries recibidos (el servidor entrega la
 * instantánea firmada). Se firma con el perfil, sin trazo: en papel queda la
 * línea «Firma y sello» (5.3). Componente puro, sin mutaciones ni queries; no
 * es la vista de boca, que es la misma en todos los países.
 */
export function OdontogramDocument({
  entries,
  standard,
  date,
  specifications,
  observations,
  examinerName,
  examinerTitle,
  registrationNumber,
  patientName,
}: OdontogramDocumentProps) {
  const rows: Array<{ teeth: readonly number[]; upper: boolean; caption: string }> = [
    { teeth: FDI_ADULT_ROWS[0] ?? [], upper: true, caption: "Dentición permanente superior" },
    { teeth: FDI_CHILD_ROWS[0] ?? [], upper: true, caption: "Dentición temporal superior" },
    { teeth: FDI_CHILD_ROWS[1] ?? [], upper: false, caption: "Dentición temporal inferior" },
    { teeth: FDI_ADULT_ROWS[1] ?? [], upper: false, caption: "Dentición permanente inferior" },
  ]
  const specLines: string[] = []
  if (specifications) specLines.push(specifications)
  const obsLines: string[] = []
  if (observations) obsLines.push(observations)
  for (const entry of entries) {
    const abbr = abbreviation(entry)
    const tag = `Pieza ${entry.toothNumber}${abbr ? ` ${abbr}` : ""}`
    const spec = entry.details?.specifications
    if (spec) specLines.push(`${tag}: ${spec}`)
    const obs = entry.details?.observations
    if (obs) obsLines.push(`${tag}: ${obs}`)
    if (entry.note)
      (entry.condition === "clinical_observation" ? obsLines : specLines).push(
        `${tag}: ${entry.note}`,
      )
    if (entry.needsReview) obsLines.push(`${tag}: registro previo en revisión.`)
  }
  return (
    <div className="odontogram-document mx-auto w-full max-w-3xl bg-white p-4 text-gray-900">
      <style>{`@media print{.odontogram-document{max-width:none}.odontogram-document .odonto-doc-row-16{width:170mm}.odontogram-document .odonto-doc-row-10{width:106mm}.odontogram-document *{print-color-adjust:exact;-webkit-print-color-adjust:exact}}`}</style>
      <div
        role="img"
        aria-label={`Odontograma normativo de ${patientName ?? "la historia clínica"} con ${entries.length} hallazgos registrados.`}
      >
        <header className="mb-3 flex items-start justify-between gap-4 border-b-2 border-gray-900 pb-2">
          <div>
            <h2 className="text-lg font-bold tracking-wide">ODONTOGRAMA</h2>
            <p className="text-[11px] text-gray-700">{standard} · Gráfico oficial</p>
            {patientName ? (
              <p className="mt-1 text-sm font-semibold">Paciente: {patientName}</p>
            ) : null}
          </div>
          <p className="shrink-0 text-sm">
            <span className="font-semibold">FECHA: </span>
            {formatDate(date)}
          </p>
        </header>

        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <section key={row.caption} aria-label={row.caption}>
              <DocRow teeth={row.teeth} upper={row.upper} entries={entries} />
            </section>
          ))}
        </div>

        <div className="mt-4 grid gap-3">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide">Especificaciones</h3>
            <div className="mt-1 min-h-16 whitespace-pre-wrap rounded-sm border border-gray-400 p-2 text-xs leading-relaxed">
              {specLines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide">Observaciones</h3>
            <div className="mt-1 min-h-16 whitespace-pre-wrap rounded-sm border border-gray-400 p-2 text-xs leading-relaxed">
              {obsLines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          </div>
        </div>

        <footer className="mt-4 flex flex-wrap items-end justify-between gap-4 border-t border-gray-400 pt-3">
          <div className="text-xs">
            <p>
              <span className="font-semibold">Examinador: </span>
              {examinerName || ""}
              {examinerTitle ? ` · ${examinerTitle}` : ""}
            </p>
            <p className="mt-1">
              <span className="font-semibold">Colegiatura: </span>
              {registrationNumber || ""}
            </p>
          </div>
          <div className="text-center">
            <div className="h-20 w-64 border-b border-gray-800" aria-hidden="true" />
            <p className="mt-1 text-[11px] text-gray-700">Firma y sello</p>
          </div>
        </footer>
        <p className="mt-3 text-center text-[10px] text-gray-600">
          Fuente: Dirección de Salud Bucal - Dirección General de Intervenciones Estratégicas en
          Salud Pública
        </p>
      </div>

      <ul className="sr-only">
        {rows.flatMap((row) =>
          row.teeth.map((tooth) => {
            const own = entries.filter((e) => e.toothNumber === tooth)
            if (own.length === 0) return null
            return (
              <li key={`${row.caption}-${tooth}`}>
                {`Pieza ${tooth}: ${own
                  .map((e) => {
                    const abbr = abbreviation(e)
                    const scope = e.surface ? ` (${surfaceLabel(e.surface)})` : ""
                    return `${abbr ? `${abbr} · ` : ""}${conditionLabel(e.condition)}${scope}`
                  })
                  .join("; ")}`}
              </li>
            )
          }),
        )}
      </ul>
    </div>
  )
}
