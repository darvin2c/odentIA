import {
  type FindingDetails,
  findingColor,
  type OdontogramStandardProfile,
  surfaceLabel,
  toothTypeOf,
} from "@odentia/dental"
import {
  CROWN_SQUARE,
  groovesFor,
  MISSING_TOOTH_LINES,
  silhouetteFor,
  zonesFor,
} from "@odentia/dental/tooth-shapes"
import { useId, useRef, useState } from "react"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { findingWords, useOdontogramNotation } from "./odontogram-notation"

// Colores clínicos normativos (rojo/azul de la NTS 188). La selección de la UI
// usa violeta (ring) y nunca rellena la corona, para no confundirse con un hallazgo.
const RED = "#dc2626"
const BLUE = "#2563eb"

export interface ToothSVGProps {
  toothNumber: number
  entries: OdontogramEntry[]
  selected?: boolean
  painting?: boolean
  disabled?: boolean
  /** "tile" conserva el recuadro con borde y número; "arch" es solo corona compacta; "preview" es corona grande para cabeceras. */
  size?: "tile" | "arch" | "preview"
  /** Mostrar raíces; el arco y el preview las ocultan para compactar. */
  showRoots?: boolean
  onSelect?: (event?: React.MouseEvent) => void
  onPaint?: (surface: string) => void
  /** Dibujo libre: la pieza padre controla el borrador (trazos normalizados 0..100). */
  onDrawingChange?: (drawing: number[][][]) => void
  draftDrawing?: number[][][]
  drawingEnabled?: boolean
  /** En el arco solo una pieza es parada de Tab; las demás se alcanzan con las flechas. */
  tabIndex?: number
}

function detailsOf(entry: OdontogramEntry): FindingDetails {
  return (entry.details ?? {}) as FindingDetails
}

/**
 * Tinta normativa del hallazgo (hex) o null si no participa del dibujo
 * normativo: registro previo en revisión o dato requerido pendiente.
 */
function paintOf(entry: OdontogramEntry): string | null {
  if (entry.needsReview) return null
  const color = findingColor(entry)
  if (color === "red") return RED
  if (color === "blue") return BLUE
  return null
}

/**
 * Línea de cabecera accesible por hallazgo: la etiqueta y su variante, con la
 * sigla oficial solo en clínicas de un país con odontograma oficial (Perú).
 */
function entryLine(
  entry: OdontogramEntry,
  _toothNumber: number,
  official: OdontogramStandardProfile | null,
): string {
  const scope = entry.surface ? ` · ${surfaceLabel(entry.surface)}` : ""
  const head = findingWords(official, { condition: entry.condition, details: detailsOf(entry) })
  if (entry.needsReview) return `Registro previo · requiere revisión — ${head}${scope}`
  if (!paintOf(entry)) return `${head}${scope} · dato pendiente`
  return `${head}${scope}`
}

// Hallazgos que pintan la superficie completa con su color normativo.
const FILL_CONDITIONS: Record<string, true> = { caries: true, definitive_restoration: true }
// Hallazgos que solo marcan el contorno de la forma observada.
const CONTOUR_CONDITIONS: Record<string, true> = { temporary_restoration: true, tooth_wear: true }

interface Markers {
  red: string
  blue: string
}

function markerFor(markers: Markers, paint: string): string {
  return paint === RED ? markers.red : markers.blue
}

/**
 * Símbolo normativo de un hallazgo sobre el gráfico de la pieza, en
 * coordenadas pre-flip del viewBox 0 0 24 28. Los hallazgos de solo sigla
 * (recuadro) devuelven null: nunca tiñen la corona arbitrariamente.
 */
function symbolFor(
  condition: string,
  paint: string,
  details: FindingDetails,
  toothNumber: number,
  markers: Markers,
  surface: OdontogramEntry["surface"],
  rotatedOnArch = false,
): React.ReactNode {
  const marker = `url(#${markerFor(markers, paint)})`
  const stroke = {
    stroke: paint,
    fill: "none",
    strokeWidth: 1,
    strokeLinecap: "round" as const,
    pointerEvents: "none" as const,
  }
  switch (condition) {
    case "missing_tooth":
      // Aspa sobre el gráfico de la pieza.
      return (
        <g {...stroke} aria-hidden="true">
          {MISSING_TOOTH_LINES.map((line) => (
            <line key={`${line.x1}-${line.y1}`} {...line} />
          ))}
        </g>
      )
    case "peg_tooth":
      // Triángulo en la zona cervical, junto al número.
      return (
        <polygon
          points="12,12.4 9.4,16.6 14.6,16.6"
          fill="none"
          stroke={paint}
          strokeWidth={1}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "erupting_tooth":
      // Flecha en zigzag sobre el gráfico hacia el plano oclusal.
      return (
        <polyline
          points="12,3.2 10.2,5.6 13,7.6 10.8,9.8 12.6,12.4"
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={marker}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "extruded_tooth":
      // Flecha recta fuera del gráfico, se aleja de incisal/oclusal.
      return (
        <line
          x1={12}
          y1={4.6}
          x2={12}
          y2={0.7}
          stroke={paint}
          strokeWidth={0.9}
          markerEnd={marker}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "intruded_tooth":
      // Flecha recta hacia la zona incisal/oclusal (apunta a la pieza).
      return (
        <line
          x1={12}
          y1={0.7}
          x2={12}
          y2={4.6}
          stroke={paint}
          strokeWidth={0.9}
          markerEnd={marker}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "supernumerary_tooth":
      // Circunferencia entre ápices; la sigla S se dibuja fuera del flip para no espejarse.
      return (
        <circle
          cx={12}
          cy={22}
          r={2.8}
          fill="none"
          stroke={paint}
          strokeWidth={1}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "pulpotomy":
      // Dibujo de la pulpa coronal.
      return (
        <g pointerEvents="none" aria-hidden="true">
          <rect
            x={9.8}
            y={4.5}
            width={4.4}
            height={6}
            rx={2}
            fill={paint}
            fillOpacity={0.35}
            stroke={paint}
            strokeWidth={0.9}
          />
        </g>
      )
    case "rotation":
      // Flecha curva en la zona oclusal según el sentido del giro.
      return details.direction === "counterclockwise" ? (
        <path
          d="M14.7 6.6 A3.1 3.1 0 1 0 15.1 9.8"
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          markerEnd={marker}
          pointerEvents="none"
          aria-hidden="true"
        />
      ) : (
        <path
          d="M9.3 6.6 A3.1 3.1 0 1 1 8.9 9.8"
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          markerEnd={marker}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "fixed_orthodontic_appliance":
      // Cuadrado a nivel apical + línea recta del tramo visible en la pieza.
      return (
        <g pointerEvents="none" aria-hidden="true">
          <rect
            x={9.6}
            y={21.5}
            width={4.8}
            height={4}
            fill="none"
            stroke={paint}
            strokeWidth={0.9}
          />
          <line x1={3.5} y1={23.5} x2={20.5} y2={23.5} stroke={paint} strokeWidth={0.9} />
        </g>
      )
    case "removable_orthodontic_appliance":
      // Zigzag a nivel de los ápices.
      return (
        <polyline
          points="3.5,23 7,25 10.5,23 14,25 17.5,23 20.5,25"
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          strokeLinecap="round"
          strokeLinejoin="round"
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "crown":
    case "temporary_crown":
      // Cuadrado sobre la corona clínica (+ sigla en el recuadro/cabecera).
      return (
        <rect
          {...CROWN_SQUARE}
          fill="none"
          stroke={paint}
          strokeWidth={1}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "post_and_core":
      // Línea vertical en la raíz + cuadrado en la corona.
      return (
        <g pointerEvents="none" aria-hidden="true">
          <line x1={12} y1={14.5} x2={12} y2={25.5} stroke={paint} strokeWidth={1} />
          <rect x={9} y={4} width={6} height={7} fill="none" stroke={paint} strokeWidth={0.9} />
        </g>
      )
    case "diastema":
      // Paréntesis entre piezas: en vista individual marca ambos bordes.
      return (
        <g fill="none" stroke={paint} strokeWidth={0.9} pointerEvents="none" aria-hidden="true">
          <path d="M5.6 5.5 Q3.8 8 5.6 10.5" />
          <path d="M18.4 5.5 Q20.2 8 18.4 10.5" />
        </g>
      )
    case "edentulous_arch":
      // Línea horizontal sobre las coronas del maxilar (segmento por pieza).
      return (
        <line
          x1={3.5}
          y1={1.1}
          x2={20.5}
          y2={1.1}
          stroke={paint}
          strokeWidth={1}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "fusion":
      // Dos circunferencias interceptadas (segmento por pieza del par).
      return (
        <g fill="none" stroke={paint} strokeWidth={0.9} pointerEvents="none" aria-hidden="true">
          <circle cx={9} cy={7.8} r={3.6} />
          <circle cx={15} cy={7.8} r={3.6} />
        </g>
      )
    case "gemination":
      // Una circunferencia sobre la pieza.
      return (
        <circle
          cx={12}
          cy={7.8}
          r={4.6}
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "sealant": {
      if (details.drawing?.length) return null
      const zone = zonesFor(toothNumber, rotatedOnArch).find((item) => item.surface === surface)
      if (!zone) return null
      const { cx, cy } = zone.dot
      return (
        <path
          d={`M${cx - 1.5},${cy + 0.5} L${cx},${cy - 0.5} L${cx + 1.5},${cy + 0.5} M${cx},${cy - 0.5} L${cx + 0.5},${cy - 1.5}`}
          fill="none"
          stroke={paint}
          strokeWidth={0.9}
          strokeLinecap="round"
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    }
    case "root_canal_treatment":
      // Línea recta vertical sobre el gráfico (+ sigla TC/PC en recuadro).
      return (
        <line
          x1={12}
          y1={2.8}
          x2={12}
          y2={25.5}
          stroke={paint}
          strokeWidth={1}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    case "fixed_partial_denture": {
      // Línea a nivel apical + tick vertical si esta pieza es pilar.
      const abutment = details.abutmentTeeth?.includes(toothNumber) === true
      return (
        <g pointerEvents="none" aria-hidden="true">
          <line x1={3} y1={23.8} x2={21} y2={23.8} stroke={paint} strokeWidth={1} />
          {abutment ? (
            <line x1={12} y1={20} x2={12} y2={26.5} stroke={paint} strokeWidth={1} />
          ) : null}
        </g>
      )
    }
    case "complete_denture":
    case "removable_partial_denture":
      // Dos líneas paralelas a nivel apical (segmento por pieza del tramo/arcada).
      return (
        <g stroke={paint} strokeWidth={0.9} pointerEvents="none" aria-hidden="true">
          <line x1={3.5} y1={22.3} x2={20.5} y2={22.3} />
          <line x1={3.5} y1={24.3} x2={20.5} y2={24.3} />
        </g>
      )
    case "transposition":
      // Dos flechas curvas entrecruzadas a la altura de los números.
      return (
        <g fill="none" stroke={paint} strokeWidth={0.8} pointerEvents="none" aria-hidden="true">
          <path d="M8.2 2.5 Q12 0.3 15.8 2.2" markerEnd={marker} />
          <path d="M8.2 0.9 Q12 2.7 15.8 1.1" markerEnd={marker} />
        </g>
      )
    default:
      // Solo sigla en recuadro/cabecera: sin dibujo sobre el gráfico.
      return null
  }
}

interface ToothCanvasProps {
  toothNumber: number
  entries: OdontogramEntry[]
  showRoots: boolean
  flip: boolean
  grooves: boolean
  zoneLines: boolean
  className: string
  strokeScale: number
  mode: "static" | "paint" | "draw" | "paint-draw"
  disabled?: boolean
  onPaint?: (surface: string) => void
  draftDrawing?: number[][][]
  onDrawingChange?: (drawing: number[][][]) => void
  titleText: string
  editLabel: string
  clipId: string
  /** La pieza se dibuja girada sobre el arco (ver `zonesFor`). */
  rotatedOnArch?: boolean
}

/**
 * Lienzo puro de la pieza: corona anatómica de 5 zonas, símbolos normativos,
 * trazos clínicos persistidos y capa de dibujo libre. Sin mutaciones ni queries.
 */
function ToothCanvas({
  toothNumber,
  entries,
  showRoots,
  flip,
  grooves,
  zoneLines,
  className,
  strokeScale,
  mode,
  disabled = false,
  onPaint,
  draftDrawing,
  onDrawingChange,
  titleText,
  editLabel,
  clipId,
  rotatedOnArch = false,
}: ToothCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const official = useOdontogramNotation()
  const [live, setLive] = useState<number[][] | null>(null)
  const drawingRef = useRef(false)
  const liveRef = useRef<number[][]>([])
  const type = toothTypeOf(toothNumber)
  const zones = zonesFor(toothNumber, rotatedOnArch)
  const silhouette = silhouetteFor(type)
  const cropped = !showRoots
  const paintMode = (mode === "paint" || mode === "paint-draw") && !disabled
  const drawMode = (mode === "draw" || mode === "paint-draw") && !disabled
  const interactiveSvg = mode !== "static"

  const markers: Markers = {
    red: `${clipId}-m-red`,
    blue: `${clipId}-m-blue`,
  }

  // Solo dibujo normativo rojo/azul: previos en revisión e incompletos no
  // generan símbolo (la cabecera sí los muestra con su advertencia).
  const graphic: Array<{ entry: OdontogramEntry; paint: string }> = []
  for (const entry of entries) {
    if (entry.needsReview) continue
    const paint = paintOf(entry)
    if (paint) graphic.push({ entry, paint })
  }

  // Rellenos y contornos normativos por superficie (coexisten todos los hallazgos).
  const fillOf: Record<string, string> = {}
  const contourOf: Record<string, string> = {}
  for (const { entry, paint } of graphic) {
    if (!entry.surface) continue
    if (FILL_CONDITIONS[entry.condition] && !fillOf[entry.surface]) fillOf[entry.surface] = paint
    if (CONTOUR_CONDITIONS[entry.condition] && !contourOf[entry.surface])
      contourOf[entry.surface] = paint
  }

  const supernumeraryPaint =
    graphic.find((g) => g.entry.condition === "supernumerary_tooth")?.paint ?? BLUE
  const hasSupernumerary = graphic.some((g) => g.entry.condition === "supernumerary_tooth")

  const toNorm = (clientX: number, clientY: number): [number, number] | null => {
    const matrix = svgRef.current?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    const y = flip ? 28 - point.y : point.y
    return [
      Math.min(100, Math.max(0, (point.x / 24) * 100)),
      Math.min(100, Math.max(0, (y / 28) * 100)),
    ]
  }

  const handlePointerDown = (event: React.PointerEvent<SVGRectElement>) => {
    if (!drawMode || !onDrawingChange || event.button !== 0) return
    const point = toNorm(event.clientX, event.clientY)
    if (!point) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    liveRef.current = [point]
    setLive(liveRef.current)
  }

  const handlePointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    if (!drawingRef.current || liveRef.current.length >= 512) return
    event.stopPropagation()
    const point = toNorm(event.clientX, event.clientY)
    if (!point) return
    const last = liveRef.current.at(-1)
    if (last && (point[0] - last[0]) ** 2 + (point[1] - last[1]) ** 2 < 1.44) return
    liveRef.current = [...liveRef.current, point]
    setLive(liveRef.current)
  }

  const finishStroke = (event: React.PointerEvent<SVGRectElement>) => {
    if (!drawingRef.current) return
    event.stopPropagation()
    drawingRef.current = false
    const stroke = liveRef.current
    liveRef.current = []
    setLive(null)
    if (event.type !== "pointercancel" && stroke.length >= 2 && (draftDrawing?.length ?? 0) < 64) {
      onDrawingChange?.([...(draftDrawing ?? []), stroke])
    }
  }

  const renderStroke = (stroke: number[][], color: string, key: string, fill = false) => {
    if (stroke.length === 1) {
      const [x, y] = stroke[0]
      return (
        <circle
          key={key}
          cx={(x / 100) * 24}
          cy={(y / 100) * 28}
          r={0.9}
          fill={color}
          pointerEvents="none"
          aria-hidden="true"
        />
      )
    }
    return (
      <polyline
        key={key}
        points={stroke
          .map((p) => `${((p[0] / 100) * 24).toFixed(2)},${((p[1] / 100) * 28).toFixed(2)}`)
          .join(" ")}
        fill={fill && stroke.length >= 3 ? color : "none"}
        stroke={color}
        strokeWidth={0.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
        aria-hidden="true"
      />
    )
  }

  const persistedStrokes: Array<{ stroke: number[][]; color: string; key: string; fill: boolean }> =
    []
  for (const { entry, paint } of graphic) {
    const drawing = detailsOf(entry).drawing
    if (!drawing) continue
    drawing.forEach((stroke, i) => {
      if (stroke.length > 0)
        persistedStrokes.push({
          stroke,
          color: paint,
          key: `${entry.id}-draw-${i}`,
          fill: !!FILL_CONDITIONS[entry.condition],
        })
    })
  }
  const draftGraphic = graphic.find(({ entry }) => entry.id.startsWith("draft-"))

  const handlePaint = (surface: string, event: React.SyntheticEvent) => {
    event.stopPropagation()
    if (!disabled) onPaint?.(surface)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={cropped ? "3 0 18 15" : "0 0 24 28"}
      className={className}
      strokeWidth={strokeScale}
      {...(interactiveSvg
        ? { role: "group" as const, "aria-label": editLabel }
        : { "aria-hidden": true })}
    >
      {interactiveSvg ? <title>{titleText}</title> : null}
      <defs>
        <clipPath id={clipId}>
          <path d={silhouette.crown} />
        </clipPath>
        {(
          [
            ["red", RED],
            ["blue", BLUE],
          ] as const
        ).map(([name, color]) => (
          <marker
            key={name}
            id={`${clipId}-m-${name}`}
            viewBox="0 0 6 5"
            refX={4.6}
            refY={2.5}
            markerWidth={3.6}
            markerHeight={3}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path d="M0.4,0.4 L5.6,2.5 L0.4,4.6 z" fill={color} />
          </marker>
        ))}
      </defs>
      <g transform={flip ? "translate(0 28) scale(1 -1)" : undefined}>
        <g className="fill-white stroke-gray-500">
          <path d={silhouette.crown} strokeLinejoin="round" />
          {showRoots
            ? silhouette.roots.map((d) => <path key={d} d={d} strokeLinejoin="round" />)
            : null}
        </g>
        <g clipPath={`url(#${clipId})`}>
          {zones.map((zone) => {
            const fill = fillOf[zone.surface] ?? "fill-white"
            const isPainted = fill !== "fill-white"
            const common = {
              "data-surface": zone.surface,
              points: zone.points,
              className: isPainted ? undefined : "fill-white",
              fill: isPainted ? fill : undefined,
              stroke: zoneLines ? "#9ca3af" : "none",
              strokeWidth: 0.3,
              fillOpacity: isPainted ? 1 : 0.55,
              style: { pointerEvents: paintMode ? ("auto" as const) : ("none" as const) },
            }
            if (!paintMode) {
              return <polygon key={zone.surface} {...common} aria-hidden="true" />
            }
            const winner = graphic.find(({ entry }) => entry.surface === zone.surface)?.entry
            return (
              <polygon
                key={zone.surface}
                {...common}
                role="button"
                tabIndex={0}
                aria-label={`Superficie ${surfaceLabel(zone.surface)} de la pieza ${toothNumber}${
                  winner ? `: ${entryLine(winner, toothNumber, official)}` : ": sin hallazgos"
                }`}
                aria-disabled={disabled || undefined}
                onClick={(e) => handlePaint(zone.surface, e)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    handlePaint(zone.surface, e)
                  }
                }}
              />
            )
          })}
          {(Object.entries(contourOf) as Array<[string, string]>).map(([surface, color]) => {
            const zone = zones.find((z) => z.surface === surface)
            if (!zone) return null
            return (
              <polygon
                key={`contour-${surface}`}
                points={zone.points}
                fill="none"
                stroke={color}
                strokeWidth={0.9}
                pointerEvents="none"
                aria-hidden="true"
              />
            )
          })}
        </g>
        {persistedStrokes.map((s) => renderStroke(s.stroke, s.color, s.key, s.fill))}
        {live && draftGraphic
          ? renderStroke(
              live,
              draftGraphic.paint,
              "live",
              !!FILL_CONDITIONS[draftGraphic.entry.condition],
            )
          : null}
        {graphic.map(({ entry, paint }) => {
          const node = symbolFor(
            entry.condition,
            paint,
            detailsOf(entry),
            toothNumber,
            markers,
            entry.surface,
            rotatedOnArch,
          )
          if (!node) return null
          return <g key={`${entry.id}-symbol`}>{node}</g>
        })}
        {grooves
          ? groovesFor(type).map((d) => (
              <path
                key={d}
                d={d}
                fill="none"
                stroke="#9ca3af"
                strokeWidth={0.45}
                opacity={0.7}
                pointerEvents="none"
                aria-hidden="true"
              />
            ))
          : null}
        {drawMode ? (
          <rect
            x={0}
            y={0}
            width={24}
            height={28}
            fill="#fff"
            fillOpacity={0}
            style={{ touchAction: "none", cursor: "crosshair" }}
            tabIndex={0}
            role="button"
            aria-label={`Dibujo libre sobre la pieza ${toothNumber}. Arrastre para trazar la forma observada.`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
          />
        ) : null}
      </g>
      {hasSupernumerary ? (
        <text
          x={12}
          y={flip ? 6 : 22}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={3.4}
          fontWeight={700}
          fill={supernumeraryPaint}
          pointerEvents="none"
          aria-hidden="true"
        >
          S
        </text>
      ) : null}
    </svg>
  )
}

export function ToothSVG({
  toothNumber,
  entries,
  selected = false,
  painting = false,
  disabled = false,
  size = "tile",
  showRoots = true,
  onSelect,
  onPaint,
  onDrawingChange,
  draftDrawing,
  drawingEnabled = false,
  tabIndex,
}: ToothSVGProps) {
  const clipId = useId()
  const official = useOdontogramNotation()
  const quadrant = Math.trunc(toothNumber / 10)
  const upper = quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6

  const lines = entries.map((entry) => entryLine(entry, toothNumber, official))
  const title = `Pieza ${toothNumber} — ${lines.length > 0 ? lines.join("; ") : "sin hallazgos"}`
  const pieceLabel = `Pieza ${toothNumber}: ${lines.length > 0 ? lines.join("; ") : "sin hallazgos"}. Seleccionar pieza.`
  const editLabel = `Edición de la pieza ${toothNumber}: superficies pintables y dibujo libre de la forma observada.`

  const isTile = size === "tile"
  const isPreview = size === "preview"
  // Sin raíces la corona ocupa todo el viewBox: crop real sin hueco invisible.
  // El flip por cuadrante solo aplica al tile con raíces; en arco/preview la
  // orientación la define el arco (rotación) o es natural (preview).
  const flip = upper && showRoots
  const drawActive = drawingEnabled && !disabled
  const mode: ToothCanvasProps["mode"] =
    painting && drawActive ? "paint-draw" : painting ? "paint" : drawActive ? "draw" : "static"

  const handleSelect = (event?: React.MouseEvent) => {
    if (!disabled) onSelect?.(event)
  }

  const canvas = (
    <ToothCanvas
      toothNumber={toothNumber}
      entries={entries}
      showRoots={showRoots}
      flip={flip}
      grooves={!isTile && mode === "static"}
      zoneLines={isTile || isPreview || mode !== "static"}
      className={isTile ? "h-12 w-10" : isPreview ? "h-24 w-20 sm:h-32 sm:w-28" : "h-auto w-full"}
      strokeScale={isTile ? 1.4 : 0.6}
      mode={mode}
      disabled={disabled}
      onPaint={onPaint}
      draftDrawing={draftDrawing}
      onDrawingChange={onDrawingChange}
      titleText={title}
      editLabel={editLabel}
      clipId={clipId}
      rotatedOnArch={size === "arch"}
    />
  )

  const tileClass = `flex min-h-11 min-w-11 cursor-pointer flex-col items-center gap-0.5 rounded-md border bg-background p-1 transition-colors ${
    selected ? "border-violet-700 ring-2 ring-violet-600" : "hover:ring-2 hover:ring-ring"
  } ${disabled ? "cursor-not-allowed opacity-60" : ""}`

  // El foco usa contorno y no anillo: así convive con el anillo violeta de la selección.
  const archClass = `rounded bg-transparent p-0 transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
    selected ? "ring-2 ring-violet-600" : disabled ? "" : "hover:ring-2 hover:ring-ring"
  } ${disabled ? (isPreview ? "" : "cursor-not-allowed opacity-60") : "cursor-pointer"}`

  if (!isTile && mode === "static") {
    return (
      <button
        type="button"
        data-tooth={toothNumber}
        onClick={handleSelect}
        disabled={disabled}
        aria-label={pieceLabel}
        aria-pressed={selected}
        title={title}
        tabIndex={tabIndex}
        className={archClass}
      >
        {canvas}
      </button>
    )
  }

  if (!isTile) {
    return (
      <div onClick={handleSelect} title={title} data-tooth={toothNumber} className={archClass}>
        {canvas}
      </div>
    )
  }

  if (mode === "static") {
    return (
      <button
        type="button"
        data-tooth={toothNumber}
        onClick={handleSelect}
        disabled={disabled}
        aria-label={pieceLabel}
        aria-pressed={selected}
        title={title}
        className={tileClass}
      >
        {canvas}
        <span aria-hidden="true" className="text-xs font-medium leading-none">
          {toothNumber}
        </span>
      </button>
    )
  }

  return (
    <div
      onClick={handleSelect}
      title={title}
      data-tooth={toothNumber}
      className={`${tileClass} ${disabled ? "" : "hover:ring-2 hover:ring-ring"}`}
    >
      {canvas}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          handleSelect()
        }}
        disabled={disabled}
        aria-label={pieceLabel}
        aria-pressed={selected}
        className="rounded px-1 text-xs font-medium leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {toothNumber}
      </button>
    </div>
  )
}
