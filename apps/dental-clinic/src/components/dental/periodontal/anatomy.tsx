/**
 * Anatomía del periodontograma (lienzo, tableros 4 y 7): cada pieza vista de
 * frente con su forma, raíces e implante con rosca, y la pieza de la placa,
 * que es la misma corona del odontograma con sus cuatro caras.
 */
import { toothTypeOf } from "@odentia/dental"
import { useId } from "react"
import { silhouetteFor, zonesFor } from "../tooth-svg"

/** Escala del gráfico: 4 px por milímetro hacia la raíz desde el límite del esmalte. */
export const MM = 4
/** Ancho del cuello y de la corona, en px por mm. */
const H = 3.1

export const quadrantOf = (tooth: number) => Math.floor(tooth / 10)
/** Lado derecho del paciente (cuadrantes 1 y 4): a la izquierda de la pantalla. */
export const rightSide = (tooth: number) => quadrantOf(tooth) === 1 || quadrantOf(tooth) === 4
export const isUpper = (tooth: number) => quadrantOf(tooth) === 1 || quadrantOf(tooth) === 2

type Kind = "inc" | "can" | "pre" | "mol"
const kindOf = (tooth: number): Kind => {
  const unit = tooth % 10
  return unit <= 2 ? "inc" : unit === 3 ? "can" : unit <= 5 ? "pre" : "mol"
}

/** Medidas en mm: [corona, ancho en el cuello, ancho de la corona, raíz]. */
const DIM: Record<number, [number, number, number, number]> = {
  11: [10.5, 6.5, 8.5, 13],
  12: [9, 5, 6.5, 13],
  13: [10, 5.5, 7.5, 17],
  14: [8.5, 5, 7, 14],
  15: [8.5, 5, 6.5, 14],
  16: [7.5, 8, 10, 12.5],
  17: [7, 7.5, 9, 12],
  18: [6.5, 7, 8.5, 11],
  31: [9, 3.5, 5, 12.5],
  32: [9.5, 4, 5.5, 14],
  33: [11, 5.5, 7, 16],
  34: [8, 5, 7, 14],
  35: [8, 5, 7, 14.5],
  36: [7.5, 9, 11, 14],
  37: [7, 8.5, 10.5, 13],
  38: [7, 8, 10, 11],
}
const dims = (tooth: number) => DIM[(isUpper(tooth) ? 10 : 30) + (tooth % 10)]!

const KIND_NAMES = ["", "Incisivo central", "Incisivo lateral", "Canino", "Primer premolar", "Segundo premolar", "Primer molar", "Segundo molar", "Tercer molar"]
const QUADRANT_NAMES: Record<number, string> = { 1: "superior derecho", 2: "superior izquierdo", 3: "inferior izquierdo", 4: "inferior derecho" }
/** «Primer molar inferior izquierdo». */
export function toothName(tooth: number): string {
  return `${KIND_NAMES[tooth % 10] ?? "Pieza"} ${QUADRANT_NAMES[quadrantOf(tooth)] ?? ""}`.trim()
}
/** La cara de dentro de la pieza: palatino arriba, lingual abajo. */
export const innerName = (tooth: number) => (isUpper(tooth) ? "palatino" : "lingual")

/** Contorno suave (Catmull-Rom) que pasa por los puntos dados. */
function smoothPath(points: Array<[number, number]>): string {
  const f = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`
  let d = `M${f(points[0]!)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    d += `C${f(c1)} ${f(c2)} ${f(p2)}`
  }
  return `${d}Z`
}

/**
 * La pieza vista por fuera o por dentro, con el límite del esmalte en y=0, la
 * corona hacia +y y la raíz hacia -y. Los puntos se escriben con mesial a la
 * derecha y se reflejan por cuadrante: mesial siempre mira al centro de la boca.
 */
export function ToothShape({
  tooth,
  cx,
  mode,
  view,
}: {
  tooth: number
  cx: number
  mode: "tooth" | "implant" | "ghost"
  view: "out" | "in"
}): React.JSX.Element {
  const [cmm, neck, wide, rmm] = dims(tooth)
  const ch = cmm * MM
  const rl = rmm * MM
  const hn = (neck * H) / 2
  const hc = (wide * H) / 2
  const kind = kindOf(tooth)
  const unit = tooth % 10
  const upper = isUpper(tooth)
  const m = rightSide(tooth) ? 1 : -1
  const P = (points: Array<[number, number]>): Array<[number, number]> => points.map(([x, y]) => [cx + m * x, y])
  const cls = (name: string) => (mode === "ghost" ? "ghost-tooth" : name)
  const parts: React.ReactNode[] = []

  if (mode === "implant") {
    const fw = Math.max(9, hn * 1.5)
    const fl = Math.min(rl, 44)
    parts.push(
      <path
        key="fixture"
        className="fixture"
        d={`M${cx - fw / 2},2 L${cx - fw / 2 + 0.5},${-fl + 6} Q${cx},${-fl - 1} ${cx + fw / 2 - 0.5},${-fl + 6} L${cx + fw / 2},2 Z`}
      />,
    )
    for (let y = -5; y > -fl + 6; y -= 5) {
      parts.push(<line key={`t${y}`} className="thread" x1={cx - fw / 2 - 1.2} x2={cx + fw / 2 + 1.2} y1={y} y2={y - 1.6} />)
    }
    parts.push(<rect key="abutment" className="fixture" x={cx - hn} y={-1} width={2 * hn} height={3} rx={1} />)
  } else if (kind === "mol") {
    // Dos raíces de frente: la mesial, más larga y ancha; las dos se curvan un poco hacia distal.
    const spread = upper ? 1.12 : 1.02
    const rlD = rl * (upper ? 0.88 : 0.93)
    const tilt = hn * 0.1
    const fx = 14
    const twoRoots = P([
      [-hn, 2],
      [-hn * spread, -rl * 0.45],
      [-hn * 0.74 - tilt, -rlD],
      [-hn * 0.36, -rl * 0.55],
      [0, -fx],
      [hn * 0.3, -rl * 0.55],
      [hn * 0.62 - tilt, -rl],
      [hn * (spread - 0.04), -rl * 0.45],
      [hn, 2],
    ])
    if (upper && view === "in") {
      // Desde el paladar se ve sobre todo la raíz palatina, ancha y al centro; las de fuera asoman detrás.
      parts.push(<path key="back" className={mode === "ghost" ? "ghost-tooth" : "dentin back"} d={smoothPath(twoRoots)} />)
      parts.push(
        <path
          key="root"
          className={cls("dentin")}
          d={smoothPath(
            P([
              [-hn * 0.74, 2],
              [-hn * 0.72, -rl * 0.5],
              [-hn * 0.32, -rl * 0.98],
              [0, -rl * 1.05],
              [hn * 0.32, -rl * 0.98],
              [hn * 0.72, -rl * 0.5],
              [hn * 0.74, 2],
            ]),
          )}
        />,
      )
    } else {
      parts.push(<path key="root" className={cls("dentin")} d={smoothPath(twoRoots)} />)
    }
  } else if (upper && unit === 4) {
    // Primer premolar superior: raíz por fuera y raíz por dentro, superpuestas, que se separan en la punta.
    parts.push(
      <path
        key="root"
        className={cls("dentin")}
        d={smoothPath(
          P([
            [-hn * 0.92, 2],
            [-hn * 0.8, -rl * 0.45],
            [-hn * 0.54, -rl * 0.86],
            [-hn * 0.32, -rl * 0.97],
            [-hn * 0.06, -rl * 0.62],
            [hn * 0.2, -rl],
            [hn * 0.48, -rl * 0.87],
            [hn * 0.8, -rl * 0.45],
            [hn * 0.92, 2],
          ]),
        )}
      />,
    )
  } else {
    const tilt = hn * 0.16
    parts.push(
      <path
        key="root"
        className={cls("dentin")}
        d={smoothPath(
          P([
            [-hn * 0.92, 2],
            [-hn * 0.82, -rl * 0.5],
            [-hn * 0.42 - tilt, -rl * 0.9],
            [-tilt, -rl],
            [hn * 0.34 - tilt, -rl * 0.9],
            [hn * 0.8, -rl * 0.5],
            [hn * 0.92, 2],
          ]),
        )}
      />,
    )
  }

  // Corona: el contacto mesial queda más cerca del borde que el distal y el ángulo mesial es más marcado.
  let crown: Array<[number, number]>
  if (kind === "inc") {
    crown = [[-hn, 0], [-hc * 0.9, ch * 0.42], [-hc * 0.98, ch * 0.7], [-hc * 0.86, ch * 0.93], [-hc * 0.55, ch * 0.995], [hc * 0.2, ch], [hc * 0.88, ch * 0.99], [hc * 0.99, ch * 0.92], [hc, ch * 0.8], [hc * 0.88, ch * 0.4], [hn, 0]]
  } else if (kind === "can") {
    // La punta del canino está corrida hacia mesial: la vertiente mesial es más corta.
    crown = [[-hn, 0], [-hc * 0.93, ch * 0.38], [-hc, ch * 0.6], [-hc * 0.48, ch * 0.84], [hc * 0.1, ch], [hc * 0.62, ch * 0.86], [hc * 0.98, ch * 0.7], [hc * 0.9, ch * 0.36], [hn, 0]]
  } else if (kind === "pre") {
    // El primer premolar superior es la excepción: su cúspide queda hacia distal.
    const tip = upper && unit === 4 ? -hc * 0.08 : hc * 0.05
    crown = [[-hn, 0], [-hc * 0.92, ch * 0.4], [-hc, ch * 0.66], [-hc * 0.52, ch * 0.9], [tip, ch], [hc * 0.54, ch * 0.9], [hc, ch * 0.74], [hc * 0.9, ch * 0.38], [hn, 0]]
  } else if (!upper && unit === 6 && view === "out") {
    // Primer molar inferior por fuera: tres cúspides (mesial, distal y una distal pequeña).
    crown = [[-hn, 0], [-hc * 0.94, ch * 0.4], [-hc, ch * 0.62], [-hc * 0.76, ch * 0.92], [-hc * 0.56, ch * 0.86], [-hc * 0.24, ch * 0.99], [hc * 0.06, ch * 0.86], [hc * 0.46, ch], [hc * 0.86, ch * 0.9], [hc, ch * 0.74], [hc * 0.92, ch * 0.4], [hn, 0]]
  } else {
    // Dos cúspides; la mesial, más ancha.
    crown = [[-hn, 0], [-hc * 0.95, ch * 0.42], [-hc, ch * 0.66], [-hc * 0.8, ch * 0.88], [-hc * 0.5, ch * 0.99], [-hc * 0.06, ch * 0.86], [hc * 0.42, ch], [hc * 0.85, ch * 0.9], [hc, ch * 0.74], [hc * 0.93, ch * 0.4], [hn, 0]]
  }
  parts.push(<path key="crown" className={cls("enamel")} d={smoothPath(P(crown))} />)
  if (mode !== "ghost") {
    parts.push(
      <path
        key="shine"
        className="shine"
        d={`M${cx + m * hc * 0.46},${ch * 0.2} Q${cx + m * hc * 0.66},${ch * 0.45} ${cx + m * hc * 0.58},${ch * 0.72}`}
      />,
    )
  }
  return <>{parts}</>
}

/**
 * Las caras de O'Leary en el orden en que se guardan (por fuera, por dentro,
 * mesial y distal), sobre las zonas de la corona del odontograma.
 */
function plaqueFaceOf(surface: string): number | null {
  if (surface === "buccal" || surface === "facial") return 0
  if (surface === "lingual" || surface === "palatal") return 1
  if (surface === "mesial") return 2
  if (surface === "distal") return 3
  return null
}

/**
 * La pieza de la placa: la corona del odontograma con sus cuatro caras y el
 * centro, que no cuenta. Arriba se voltea para que la cara de fuera mire al
 * borde del gráfico; la mesial mira al centro de la boca. Con `onToggle`, cada
 * cara es un botón (Tab y Enter o Espacio).
 */
export function PlaqueTooth({
  tooth,
  faces,
  x,
  y,
  width,
  onToggle,
  disabled,
}: {
  tooth: number
  /** null: la placa no se marcó en esta pieza. */
  faces: boolean[] | null
  x: number
  y: number
  width: number
  onToggle?: (face: number) => void
  disabled?: boolean
}): React.JSX.Element {
  const clipId = useId()
  const crown = silhouetteFor(toothTypeOf(tooth)).crown
  const zones = zonesFor(tooth)
  const faceWords = ["por fuera", "por dentro", "mesial", "distal"]
  return (
    <g transform={`translate(${x} ${y}) scale(${width / 18}) translate(-3 0)`}>
      <g transform={isUpper(tooth) ? "translate(0 16) scale(1 -1)" : undefined}>
        <clipPath id={clipId}>
          <path d={crown} />
        </clipPath>
        <g clipPath={`url(#${clipId})`}>
          {zones.map((zone) => {
            const face = plaqueFaceOf(zone.surface)
            if (face === null) return <polygon key={zone.surface} points={zone.points} className="occl" />
            const on = faces?.[face] === true
            const className = `pz${faces === null ? " none" : on ? " on" : ""}${onToggle && !disabled ? " press" : ""}`
            if (!onToggle) return <polygon key={zone.surface} points={zone.points} className={className} />
            return (
              // biome-ignore lint/a11y/useSemanticElements: la cara es una zona del dibujo; en un SVG no hay casilla nativa.
              <polygon
                key={zone.surface}
                points={zone.points}
                className={className}
                role="checkbox"
                aria-checked={on}
                aria-disabled={disabled || undefined}
                aria-label={`Pieza ${tooth}, ${faceWords[face]}: ${on ? "con placa" : "sin placa"}`}
                tabIndex={disabled ? -1 : 0}
                onClick={() => {
                  if (!disabled) onToggle(face)
                }}
                onKeyDown={(event) => {
                  if (disabled) return
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault()
                    onToggle(face)
                  }
                }}
              />
            )
          })}
        </g>
        <path d={crown} className="pz-line" />
      </g>
    </g>
  )
}

/** La pieza de la placa sola, para el detalle de la pieza. */
export function PlaqueToothIcon({ tooth, faces, size = 54 }: { tooth: number; faces: boolean[] | null; size?: number }) {
  return (
    <svg width={size} height={(size * 16) / 18} viewBox={`0 0 ${size} ${(size * 16) / 18}`} aria-hidden="true">
      <PlaqueTooth tooth={tooth} faces={faces} x={0} y={0} width={size} />
    </svg>
  )
}
