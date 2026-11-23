import { archNeighbor } from "@odentia/dental/odontogram-arch"
import {
  canalPaths,
  mesialIsRight,
  crownPath,
  type FrontRow,
  type FrontTooth,
  frontRow,
  frontRowWidthMm,
  frontSpecOf,
  pegCrownPath,
  postRootCenter,
  rootPaths,
} from "@odentia/dental/tooth-front"
import {
  type FrontMarks,
  type FrontRowMark,
  frontMarksOf,
  frontRowMarksOf,
  type Paint,
} from "@odentia/dental/tooth-front-marks"
import { useId, useRef, useState } from "react"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { useOdontogramNotation } from "./odontogram-notation"
import { toothWords } from "./tooth-svg"

// Colores clínicos de la norma, los mismos del arco (rojo: por tratar; azul: lo que ya tiene).
const INK: Record<Paint, string> = { red: "#dc2626", blue: "#2563eb" }
/** Escala del dibujo: px por mm. El SVG se estira al ancho de su lugar. */
const S = 5
/** Alto de la franja de los números, del lado de las coronas. */
const NUMBER_BAND = 22
const ROW_GAP = 10
const n = (value: number) => value.toFixed(1)

interface Placed {
  row: FrontRow
  /** Dónde van los números (centro de la franja). */
  numberY: number
  /** Lo que ocupa la fila con sus números: lo que se toca de cada pieza. */
  top: number
  bottom: number
}

/** Ubica las filas una debajo de otra, cada una con sus números del lado de las coronas. */
function layoutRows(rows: readonly (readonly number[])[], primaryScale: number) {
  const widths = rows.map(
    (teeth) => frontRowWidthMm(teeth) * S * (isPrimaryRow(teeth) ? primaryScale : 1),
  )
  const inner = Math.max(...widths)
  const edge = 2.6 * S
  const width = inner + 2 * edge + 8
  let cursor = 4
  const placed: Placed[] = rows.map((teeth, i) => {
    const size = isPrimaryRow(teeth) ? primaryScale : 1
    const left = (width - widths[i]!) / 2
    const probe = frontRow(teeth, { scale: S, size, left, yOcc: 0 })
    const reach = probe.up ? -probe.top : probe.bottom
    if (probe.up) {
      const yOcc = cursor + reach
      const row = frontRow(teeth, { scale: S, size, left, yOcc })
      const numberY = yOcc + NUMBER_BAND / 2 + 2
      const bottom = yOcc + NUMBER_BAND + 4
      cursor = bottom + ROW_GAP
      return { row, numberY, top: row.top, bottom }
    }
    const yOcc = cursor + NUMBER_BAND + 4
    const row = frontRow(teeth, { scale: S, size, left, yOcc })
    const numberY = cursor + NUMBER_BAND / 2 + 2
    const top = cursor
    cursor = row.bottom + ROW_GAP
    return { row, numberY, top, bottom: row.bottom }
  })
  return { width, height: cursor - ROW_GAP + 4, placed }
}

const isPrimaryRow = (teeth: readonly number[]) =>
  teeth.length > 0 && Math.trunc(teeth[0]! / 10) >= 5

/** Un punto del dibujo de la pieza (y desde el borde de la corona hacia la raíz) en el SVG. */
const at = (t: FrontTooth, yOcc: number, lx: number, ly: number) => ({
  x: t.x + lx,
  y: yOcc + (t.up ? -ly : ly),
})

/** La pieza con lo que tiene, en su sitio. Todo se dibuja en coordenadas de la pieza (corona arriba). */
function ToothFront({
  t,
  yOcc,
  reach,
  marks,
}: {
  t: FrontTooth
  yOcc: number
  reach: number
  marks: FrontMarks
}) {
  const spec = frontSpecOf(t.tooth)
  const { w, ch, rl } = t
  const crown = marks.peg ? pegCrownPath(w, ch) : crownPath(spec.kind, w, ch)
  const roots = rootPaths(spec, w, ch, rl)
  const parts: React.ReactNode[] = []
  const stroke = (paint: Paint, width = 1.6) => ({
    stroke: INK[paint],
    strokeWidth: width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  })
  const rootShape = (
    <g
      key="roots"
      className="fill-amber-50 stroke-zinc-300 dark:fill-zinc-300 dark:stroke-zinc-400"
    >
      {roots.back ? <path d={roots.back} fillOpacity={0.55} strokeWidth={1} /> : null}
      <path d={roots.front} fillOpacity={0.85} strokeWidth={1.1} strokeLinejoin="round" />
    </g>
  )
  const crownShape = (extra?: { paint?: Paint }) => (
    // Con color, sin clases: una clase de CSS pisa los atributos `fill` y `stroke` del SVG.
    <path
      key="crown"
      d={crown}
      strokeLinejoin="round"
      {...(extra?.paint
        ? { fill: INK[extra.paint], fillOpacity: 0.16, stroke: INK[extra.paint], strokeWidth: 2 }
        : { className: "fill-white stroke-zinc-400", strokeWidth: 1.2 })}
    />
  )
  // Lo que va dentro de la raíz: un conducto por raíz y el perno en la raíz mayor, unido al muñón
  // dentro de la corona (NTS 6.1.8 y 6.1.37). En el resto radicular, sin muñón: no hay corona.
  const insideRoot = (withCore: boolean): React.ReactNode[] => {
    const inside: React.ReactNode[] = []
    if (marks.canals)
      for (const d of canalPaths(spec, w, ch, rl))
        inside.push(<path key={`canal-${d}`} d={d} {...stroke(marks.canals, 2)} />)
    if (marks.post) {
      const cx = postRootCenter(t.tooth, spec) * w
      const pw = Math.max(3.5, 0.11 * w)
      const top = withCore ? ch * 0.5 : ch
      inside.push(
        <g key="post">
          <rect
            x={cx - pw / 2}
            y={top}
            width={pw}
            height={ch + rl * 0.55 - top}
            rx={pw / 2}
            fill={INK[marks.post]}
          />
          {withCore ? (
            <path
              d={`M${n(w * 0.34)},${n(ch)} L${n(w * 0.37)},${n(ch * 0.4)} Q${n(w * 0.5)},${n(ch * 0.28)} ${n(w * 0.63)},${n(ch * 0.4)} L${n(w * 0.66)},${n(ch)} Z`}
              fill={INK[marks.post]}
              fillOpacity={0.3}
              stroke={INK[marks.post]}
              strokeWidth={1.2}
              strokeLinejoin="round"
            />
          ) : null}
        </g>,
      )
    }
    return inside
  }
  switch (marks.body) {
    case "none":
      break
    case "missing": {
      const paint = marks.bodyPaint ?? "blue"
      parts.push(
        <g key="missing" opacity={0.75}>
          <path d={crown} {...stroke(paint, 1.2)} strokeDasharray="4 3" />
          <path d={roots.front} {...stroke(paint, 1)} strokeDasharray="4 3" />
          <line
            x1={w * 0.1}
            y1={ch * 0.05}
            x2={w * 0.9}
            y2={ch + rl * 0.9}
            {...stroke(paint, 1.6)}
          />
          <line
            x1={w * 0.9}
            y1={ch * 0.05}
            x2={w * 0.1}
            y2={ch + rl * 0.9}
            {...stroke(paint, 1.6)}
          />
          {insideRoot(false)}
          {marks.fracture ? (
            <path
              d={`M${n(w * 0.25)},${n(ch + rl * 0.35)} L${n(w * 0.75)},${n(ch + rl * 0.45)}`}
              {...stroke(marks.fracture, 2)}
            />
          ) : null}
        </g>,
      )
      break
    }
    case "remnant": {
      // Solo la raíz, con el borde de arriba irregular a la altura de la encía (NTS 6.1.32).
      const paint = marks.bodyPaint ?? "red"
      parts.push(
        <g key="remnant">
          <path
            d={roots.front}
            fill={INK[paint]}
            fillOpacity={0.12}
            {...{ stroke: INK[paint], strokeWidth: 1.6, strokeLinejoin: "round" }}
          />
          <polyline
            points={[0.2, 0.36, 0.5, 0.64, 0.8]
              .map((f, i) => `${n(f * w)},${n(ch - 1 + (i % 2 ? -0.12 : 0.04) * ch)}`)
              .join(" ")}
            {...stroke(paint, 1.6)}
          />
        </g>,
      )
      break
    }
    case "implant": {
      // Un tornillo en lugar de la raíz; con corona, la corona encima; sin ella, la tapa (NTS 6.1.15).
      const paint = marks.bodyPaint ?? "blue"
      const X = (f: number) => f * w
      const R = (f: number) => ch + f * rl
      parts.push(
        <g key="implant">
          <path
            d={`M${n(X(0.3))},${n(ch - 1)} L${n(X(0.7))},${n(ch - 1)} L${n(X(0.64))},${n(R(0.8))} Q${n(X(0.5))},${n(R(0.97))} ${n(X(0.36))},${n(R(0.8))} Z`}
            fill={INK[paint]}
            fillOpacity={0.12}
            stroke={INK[paint]}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
          {[1, 2, 3, 4, 5, 6].map((i) => {
            const f = i / 7.3
            const half = 0.2 - 0.06 * f
            return (
              <line
                key={i}
                x1={X(0.5 - half)}
                y1={R(f * 0.86)}
                x2={X(0.5 + half)}
                y2={R(f * 0.86 + 0.03)}
                stroke={INK[paint]}
                strokeWidth={1.1}
              />
            )
          })}
          {marks.implantCrown ? null : (
            <rect
              x={X(0.28)}
              y={ch - 5}
              width={X(0.44)}
              height={5}
              rx={1.5}
              fill={INK[paint]}
              fillOpacity={0.3}
              stroke={INK[paint]}
              strokeWidth={1.2}
            />
          )}
        </g>,
      )
      if (marks.implantCrown) parts.push(crownShape({ paint: marks.implantCrown }))
      break
    }
    case "pontic":
    case "denture": {
      // Lo que repone la pieza: la corona sin raíz (el póntico del puente o el diente de la prótesis).
      const paint = marks.bodyPaint ?? "blue"
      parts.push(crownShape({ paint }))
      break
    }
    default: {
      parts.push(rootShape)
      const center = { x: w / 2, y: ch }
      const crownParts: React.ReactNode[] = [
        crownShape(marks.crown ? { paint: marks.crown } : undefined),
      ]
      if (marks.pulpotomy) {
        crownParts.push(
          <rect
            key="pulp"
            x={w * 0.38}
            y={ch * 0.38}
            width={w * 0.24}
            height={ch * 0.55}
            rx={w * 0.1}
            fill={INK[marks.pulpotomy]}
            fillOpacity={0.4}
            stroke={INK[marks.pulpotomy]}
            strokeWidth={1.2}
          />,
        )
      }
      for (const surface of marks.surfaces)
        crownParts.push(
          <SurfaceMark
            key={`${surface.zone}-${surface.style}-${surface.paint}`}
            mark={surface}
            w={w}
            ch={ch}
            tooth={t.tooth}
          />,
        )
      if (marks.gemination) {
        crownParts.push(
          <path
            key="gem"
            d={`M${n(w * 0.5)},${n(ch * 0.02)} L${n(w * 0.5)},${n(ch * 0.3)}`}
            {...stroke(marks.gemination, 1.6)}
          />,
        )
      }
      if (marks.fracture) {
        crownParts.push(
          <polyline
            key="fracture"
            points={`${n(w * 0.15)},${n(ch * 0.2)} ${n(w * 0.45)},${n(ch * 0.42)} ${n(w * 0.55)},${n(ch * 0.3)} ${n(w * 0.88)},${n(ch * 0.62)}`}
            {...stroke(marks.fracture, 2)}
          />,
        )
      }
      if (marks.bracket) {
        const b = Math.min(w * 0.42, 9)
        crownParts.push(
          <g key="bracket">
            <rect
              x={w / 2 - b / 2}
              y={ch * 0.5 - b / 2}
              width={b}
              height={b}
              rx={1}
              fill="white"
              {...{ stroke: INK[marks.bracket], strokeWidth: 1.4 }}
            />
            <path
              d={`M${n(w / 2 - b / 2)},${n(ch * 0.5 - b / 2)} L${n(w / 2 + b / 2)},${n(ch * 0.5 + b / 2)} M${n(w / 2 + b / 2)},${n(ch * 0.5 - b / 2)} L${n(w / 2 - b / 2)},${n(ch * 0.5 + b / 2)}`}
              {...stroke(marks.bracket, 1.1)}
            />
          </g>,
        )
      }
      const transform = [
        marks.tilt ? `rotate(${marks.tilt} ${n(center.x)} ${n(center.y)})` : "",
        marks.size !== 1
          ? `translate(${n(center.x)} ${n(center.y)}) scale(${marks.size}) translate(${n(-center.x)} ${n(-center.y)})`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
      parts.push(
        <g key="crown-group" transform={transform || undefined}>
          {crownParts}
        </g>,
      )
      parts.push(...insideRoot(true))
      if (marks.arrow) {
        // Dentro de la corona, para no tapar el número: la intruida apunta a la raíz; la extruida y
        // la que está erupcionando, al plano oclusal (NTS 6.1.23 a 6.1.25).
        const paint = INK[marks.arrow.paint]
        const x = w * 0.5
        const toApex = marks.arrow.kind === "intruded"
        const from = toApex ? ch * 0.14 : ch * 0.88
        const to = toApex ? ch * 0.86 : ch * 0.12
        const back = toApex ? -4 : 4
        parts.push(
          <g
            key="arrow"
            stroke={paint}
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {marks.arrow.kind === "erupting" ? (
              <polyline
                points={`${n(x)},${n(from)} ${n(x - 3)},${n(ch * 0.7)} ${n(x + 3)},${n(ch * 0.5)} ${n(x - 3)},${n(ch * 0.3)} ${n(x)},${n(to)}`}
              />
            ) : (
              <line x1={x} y1={from} x2={x} y2={to} />
            )}
            <path
              d={`M${n(x - 3.5)},${n(to + back)} L${n(x)},${n(to)} L${n(x + 3.5)},${n(to + back)}`}
            />
          </g>,
        )
      }
      if (marks.rotation) {
        const paint = INK[marks.rotation.paint]
        const y = ch * 0.18
        // La fila de arriba se dibuja reflejada: el sentido del giro se invierte para que se vea el dicho.
        const clockwise = t.up ? !marks.rotation.clockwise : marks.rotation.clockwise
        const d = clockwise
          ? `M${n(w * 0.2)},${n(y + 3)} Q${n(w * 0.5)},${n(y - 7)} ${n(w * 0.8)},${n(y + 3)}`
          : `M${n(w * 0.8)},${n(y + 3)} Q${n(w * 0.5)},${n(y - 7)} ${n(w * 0.2)},${n(y + 3)}`
        const end = clockwise ? w * 0.8 : w * 0.2
        const back = clockwise ? -4 : 4
        parts.push(
          <g key="rotation" stroke={paint} fill="none" strokeWidth={1.5} strokeLinecap="round">
            <path d={d} />
            <path
              d={`M${n(end + back)},${n(y - 1)} L${n(end)},${n(y + 3)} L${n(end + back)},${n(y + 6)}`}
            />
          </g>,
        )
      }
    }
  }
  if (marks.mobility) {
    // Movilidad: la doble flecha a lo ancho de la corona (NTS 6.1.19; el grado va al lado del número).
    const paint = INK[marks.mobility.paint]
    const y = ch * 0.62
    parts.push(
      <g
        key="mobility"
        stroke={paint}
        fill="none"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1={-w * 0.08} y1={y} x2={w * 1.08} y2={y} />
        <path
          d={`M${n(-w * 0.08 + 4)},${n(y - 3.5)} L${n(-w * 0.08)},${n(y)} L${n(-w * 0.08 + 4)},${n(y + 3.5)}`}
        />
        <path
          d={`M${n(w * 1.08 - 4)},${n(y - 3.5)} L${n(w * 1.08)},${n(y)} L${n(w * 1.08 - 4)},${n(y + 3.5)}`}
        />
      </g>,
    )
  }
  // Hacia la raíz, la pieza se corre solo hasta donde llega la encía: la retenida queda adentro.
  const shift =
    marks.shift > 0
      ? Math.min(marks.shift * ch, Math.max(0, reach - ch - rl - 4))
      : marks.shift * ch
  const transform = `translate(${n(t.x)} ${n(yOcc)})${t.up ? " scale(1 -1)" : ""}${shift ? ` translate(0 ${n(shift)})` : ""}`
  if (marks.buriedPaint) {
    // La impactada, dentro de la encía y con su contorno del color de la norma.
    parts.push(
      <g key="buried" fill="none" stroke={INK[marks.buriedPaint]} strokeWidth={1.6} strokeLinejoin="round">
        <path d={crown} />
        <path d={roots.front} />
      </g>,
    )
  }
  return (
    <g transform={transform} opacity={marks.buried ? 0.75 : undefined}>
      {parts}
    </g>
  )
}

/** Una cara de la corona vista de frente: el borde (oclusal o incisal), un lado (mesial o distal) o el centro. */
function SurfaceMark({
  mark,
  w,
  ch,
  tooth,
}: {
  mark: FrontMarks["surfaces"][number]
  w: number
  ch: number
  tooth: number
}) {
  const ink = INK[mark.paint]
  const mesialRight = [1, 4, 5, 8].includes(Math.trunc(tooth / 10))
  const side =
    mark.zone === "mesial"
      ? mesialRight
        ? "right"
        : "left"
      : mark.zone === "distal"
        ? mesialRight
          ? "left"
          : "right"
        : null
  if (mark.style === "wear") {
    // El borde aplanado, con una línea roja (NTS 6.1.36).
    return (
      <line
        x1={w * 0.18}
        y1={ch * 0.06}
        x2={w * 0.82}
        y2={ch * 0.06}
        stroke={ink}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    )
  }
  const shape =
    mark.zone === "edge"
      ? `M${n(0.24 * w)},${n(0.1 * ch)} Q${n(0.5 * w)},${n(0.02 * ch)} ${n(0.76 * w)},${n(0.1 * ch)} Q${n(0.72 * w)},${n(0.3 * ch)} ${n(0.5 * w)},${n(0.3 * ch)} Q${n(0.28 * w)},${n(0.3 * ch)} ${n(0.24 * w)},${n(0.1 * ch)} Z`
      : side === "left"
        ? `M${n(0.08 * w)},${n(0.25 * ch)} Q${n(0.26 * w)},${n(0.3 * ch)} ${n(0.27 * w)},${n(0.55 * ch)} Q${n(0.26 * w)},${n(0.8 * ch)} ${n(0.12 * w)},${n(0.85 * ch)} Q${n(0.03 * w)},${n(0.55 * ch)} ${n(0.08 * w)},${n(0.25 * ch)} Z`
        : side === "right"
          ? `M${n(0.92 * w)},${n(0.25 * ch)} Q${n(0.74 * w)},${n(0.3 * ch)} ${n(0.73 * w)},${n(0.55 * ch)} Q${n(0.74 * w)},${n(0.8 * ch)} ${n(0.88 * w)},${n(0.85 * ch)} Q${n(0.97 * w)},${n(0.55 * ch)} ${n(0.92 * w)},${n(0.25 * ch)} Z`
          : `M${n(0.5 * w)},${n(0.36 * ch)} m${n(-0.17 * w)},0 a${n(0.17 * w)},${n(0.17 * ch)} 0 1,0 ${n(0.34 * w)},0 a${n(0.17 * w)},${n(0.17 * ch)} 0 1,0 ${n(-0.34 * w)},0`
  return mark.style === "fill" ? (
    <path d={shape} fill={ink} fillOpacity={0.85} />
  ) : (
    <path d={shape} fill="none" stroke={ink} strokeWidth={1.6} />
  )
}

/** Lo de par, tramo o arcada a lo largo de la fila. */
function RowMark({ mark, placed }: { mark: FrontRowMark; placed: Placed }) {
  const { row } = placed
  const byTooth = new Map(row.teeth.map((t) => [t.tooth, t]))
  const teeth = mark.teeth.flatMap((tooth) => (byTooth.has(tooth) ? [byTooth.get(tooth)!] : []))
  if (teeth.length === 0) return null
  const ink = INK[mark.paint]
  const y = (t: FrontTooth, f: number) => at(t, row.yOcc, 0, f * t.ch).y
  const pairs = teeth.slice(1).map((t, i) => [teeth[i]!, t] as const)
  const first = teeth[0]!
  const last = teeth.at(-1)!
  const apex = (f: number) =>
    row.yOcc + (row.up ? -1 : 1) * Math.max(...row.teeth.map((t) => t.ch + t.rl)) * f
  switch (mark.kind) {
    case "bridge":
    case "fusion":
      // Los conectores entre coronas vecinas del puente, o la unión de las dos coronas fusionadas.
      return (
        <g>
          {pairs.map(([a, b]) => {
            const h = Math.min(a.ch, b.ch) * 0.36
            const top = row.up ? y(a, 0.68) : y(a, 0.32)
            return (
              <rect
                key={`${a.tooth}-${b.tooth}`}
                x={a.x + a.w - 4}
                y={top}
                width={b.x - a.x - a.w + 8}
                height={h}
                rx={3}
                fill={ink}
                fillOpacity={0.55}
              />
            )
          })}
        </g>
      )
    case "diastema": {
      // El paréntesis invertido «)(» entre las coronas (NTS 6.1.6). Con la arcada en dos filas, el de
      // la línea media queda partido: cada pieza lleva su mitad, del lado del espacio.
      const curve = (x: number, toward: 1 | -1, t: FrontTooth) => {
        const y0 = y(t, 0.2)
        const y1 = y(t, 0.8)
        return `M${n(x)},${n(y0)} Q${n(x + toward * 4.5)},${n((y0 + y1) / 2)} ${n(x)},${n(y1)}`
      }
      if (pairs.length > 0) {
        const [a, b] = pairs[0]!
        const mid = (a.x + a.w + b.x) / 2
        return (
          <g stroke={ink} fill="none" strokeWidth={1.6} strokeLinecap="round">
            <path d={curve(mid - 4, 1, a)} />
            <path d={curve(mid + 4, -1, a)} />
          </g>
        )
      }
      if (!mark.split) return null
      const lone = first
      const right = mesialIsRight(lone.tooth)
      return (
        <path
          d={right ? curve(lone.x + lone.w + 1, 1, lone) : curve(lone.x - 1, -1, lone)}
          stroke={ink}
          fill="none"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      )
    }
    case "transposition": {
      if (teeth.length < 2) return null
      const a = first
      const b = last
      const yN = placed.numberY + (row.up ? 12 : -12)
      const x0 = a.x + a.w / 2
      const x1 = b.x + b.w / 2
      return (
        <g stroke={ink} fill="none" strokeWidth={1.4} strokeLinecap="round">
          <path d={`M${n(x0)},${n(yN)} Q${n((x0 + x1) / 2)},${n(yN - 9)} ${n(x1)},${n(yN)}`} />
          <path
            d={`M${n(x1)},${n(yN - 6)} Q${n((x0 + x1) / 2)},${n(yN + 3)} ${n(x0)},${n(yN - 6)}`}
          />
        </g>
      )
    }
    case "supernumerary": {
      // Una pieza chica y cónica entre las raíces de las vecinas, con su círculo y la S (NTS 6.1.26).
      const a = first
      const b = teeth.length > 1 ? last : first
      // Partida en la línea media: se dibuja una vez, junto a la pieza del lado derecho del paciente.
      if (mark.split && teeth.length === 1 && !mesialIsRight(a.tooth)) return null
      const cx =
        teeth.length > 1 ? (a.x + a.w + b.x) / 2 : mesialIsRight(a.tooth) ? a.x + a.w + 2 : a.x - 2
      const cy = at(a, row.yOcc, 0, a.ch + a.rl * 0.75).y
      return (
        <g>
          <circle cx={cx} cy={cy} r={9} fill="white" stroke={ink} strokeWidth={1.5} />
          <text
            x={cx}
            y={cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={10}
            fontWeight={700}
            fill={ink}
          >
            S
          </text>
        </g>
      )
    }
    case "orthodontic_wire": {
      const yw = y(first, 0.5)
      return (
        <line
          x1={first.x + first.w / 2}
          y1={yw}
          x2={last.x + last.w / 2}
          y2={yw}
          stroke={ink}
          strokeWidth={1.6}
        />
      )
    }
    case "removable_orthodontic": {
      // Zigzag a la altura de los ápices (NTS 6.1.2).
      const ya = apex(0.95)
      const points: string[] = []
      for (let x = first.x, k = 0; x <= last.x + last.w; x += 8, k++)
        points.push(`${n(x)},${n(ya + (k % 2 ? 4 : -4))}`)
      return (
        <polyline
          points={points.join(" ")}
          stroke={ink}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )
    }
    case "denture_lines": {
      // Dos líneas paralelas a la altura de los ápices (NTS 6.1.30 y 6.1.31).
      const ya = apex(0.9)
      const d = row.up ? 5 : -5
      return (
        <g stroke={ink} strokeWidth={1.5}>
          <line x1={first.x} y1={ya} x2={last.x + last.w} y2={ya} />
          <line x1={first.x} y1={ya + d} x2={last.x + last.w} y2={ya + d} />
        </g>
      )
    }
    case "edentulous_line": {
      // La línea horizontal sobre las coronas del maxilar sin dientes (NTS 6.1.7).
      const yl = y(first, 0.5)
      return <line x1={first.x} y1={yl} x2={last.x + last.w} y2={yl} stroke={ink} strokeWidth={2} />
    }
    default:
      return null
  }
}

/**
 * La boca vista de frente (lienzo del 23 nov 2026): cada pieza con su corona y su raíz dentro de
 * la encía. Se toca una pieza y se abre su registro, como en el arco. Con el teclado es una sola
 * parada de Tab y se recorre con las flechas, como el arco.
 */
export function OdontogramFront({
  rows,
  entriesOf,
  selected,
  disabled = false,
  onToggle,
}: {
  /** Las filas de arriba abajo, cada una de izquierda a derecha como se ven. */
  rows: readonly (readonly number[])[]
  entriesOf: (tooth: number) => OdontogramEntry[]
  selected: number[]
  disabled?: boolean
  onToggle: (tooth: number, additive: boolean) => void
}): React.JSX.Element {
  const official = useOdontogramNotation()
  const hintId = useId()
  const ref = useRef<HTMLDivElement | null>(null)
  const shown = rows.filter((row) => row.length > 0)
  // Las de leche, más grandes que su medida real: así ninguna baja de 24 px para tocarla (la mixta
  // de la boca entera a 900 px dejaba las incisivas inferiores en 18). En filas de 5 (una
  // arcada), un poco más.
  const halfRows = shown.some((row) => isPrimaryRow(row) && row.length <= 5)
  const { width: W, height: H, placed } = layoutRows(shown, halfRows ? 1.35 : 1.3)
  const [visited, setVisited] = useState<number | null>(null)
  const visible = shown.flat()
  const tabStop =
    visited !== null && visible.includes(visited)
      ? visited
      : (selected.find((tooth) => visible.includes(tooth)) ?? visible[0])
  const toothOf = (target: EventTarget): number | null => {
    const el = (target as HTMLElement).closest<HTMLElement>("[data-front-tooth]")
    return el ? Number(el.dataset.frontTooth) : null
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tooth = toothOf(event.target)
    if (tooth === null) return
    if ((event.key === " " || event.key === "Enter") && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!disabled) onToggle(tooth, true)
      return
    }
    const next = archNeighbor(shown, tooth, event.key)
    if (next === null) return
    event.preventDefault()
    setVisited(next)
    ref.current?.querySelector<HTMLElement>(`[data-front-tooth="${next}"]`)?.focus()
  }
  const pct = (value: number, total: number) => `${(value / total) * 100}%`
  return (
    <div
      ref={ref}
      className="relative w-full min-w-0"
      role="group"
      aria-label="De frente, cada pieza con su raíz"
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const tooth = toothOf(event.target)
        if (tooth !== null) setVisited(tooth)
      }}
    >
      <span id={hintId} className="sr-only">
        Usa las flechas para moverte entre piezas.
      </span>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${n(W)} ${n(H)}`}
        className="block h-auto w-full select-none"
      >
        {placed.map((p) => {
          const rowMarks = frontRowMarksOf(
            p.row.teeth.map((t) => t.tooth),
            entriesOf,
          )
          return (
            <g key={p.row.teeth[0]?.tooth ?? p.top}>
              {/* La encía, del mismo rosado que el arco de arriba. */}
              <path
                d={p.row.gum}
                className="fill-rose-100 stroke-rose-200 dark:fill-rose-950/70 dark:stroke-rose-900"
                strokeWidth={1.2}
                strokeLinejoin="round"
              />
              {p.row.teeth.map((t) => {
                const isSelected = selected.includes(t.tooth)
                if (!isSelected) return null
                const top = t.up ? p.row.yOcc - t.ch - t.rl - 6 : p.row.yOcc - 6
                return (
                  <rect
                    key={`sel-${t.tooth}`}
                    x={t.x - 4}
                    y={top}
                    width={t.w + 8}
                    height={t.ch + t.rl + 12}
                    rx={10}
                    className="fill-violet-600/10 stroke-violet-600"
                    strokeWidth={1.6}
                  />
                )
              })}
              {p.row.teeth.map((t) => (
                <ToothFront
                  key={t.tooth}
                  t={t}
                  yOcc={p.row.yOcc}
                  reach={Math.abs((p.row.up ? p.row.top : p.row.bottom) - p.row.yOcc)}
                  marks={frontMarksOf(t.tooth, entriesOf(t.tooth))}
                />
              ))}
              {rowMarks.map((mark) => (
                <RowMark
                  key={`${mark.kind}-${mark.paint}-${mark.teeth.join("-")}`}
                  mark={mark}
                  placed={p}
                />
              ))}
              {p.row.teeth.map((t) => {
                const cx = t.x + t.w / 2
                const isSelected = selected.includes(t.tooth)
                const marks = frontMarksOf(t.tooth, entriesOf(t.tooth))
                // El grado de movilidad cambia la conducta: va junto al número (con la sigla M solo donde la
                // norma del país la usa).
                const label = marks.mobility?.grade
                  ? `${t.tooth}·${official ? "M" : ""}${marks.mobility.grade}`
                  : String(t.tooth)
                return (
                  <g key={`n-${t.tooth}`}>
                    {marks.ringNumber ? (
                      <circle
                        cx={cx}
                        cy={p.numberY}
                        r={11.5}
                        fill="none"
                        stroke={INK[marks.ringNumber]}
                        strokeWidth={1.4}
                      />
                    ) : null}
                    {isSelected ? (
                      <rect
                        x={cx - 16}
                        y={p.numberY - 10}
                        width={32}
                        height={20}
                        rx={10}
                        className="fill-violet-600"
                      />
                    ) : null}
                    <text
                      x={cx}
                      y={p.numberY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={label.length > 3 ? 10 : 12}
                      fontWeight={isSelected ? 700 : 400}
                      className={
                        isSelected
                          ? "fill-white"
                          : marks.mobility
                            ? "fill-red-700 dark:fill-red-400"
                            : "fill-muted-foreground"
                      }
                    >
                      {label}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {placed.flatMap((p) =>
        p.row.teeth.map((t) => {
          const isSelected = selected.includes(t.tooth)
          const { title, label } = toothWords(t.tooth, entriesOf(t.tooth), official)
          return (
            <button
              key={t.tooth}
              type="button"
              data-front-tooth={t.tooth}
              aria-label={label}
              aria-pressed={isSelected}
              title={title}
              disabled={disabled}
              tabIndex={t.tooth === tabStop ? 0 : -1}
              onClick={(event) => onToggle(t.tooth, event.ctrlKey || event.metaKey)}
              className={`absolute rounded-md bg-transparent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-foreground ${disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted-foreground/10"}`}
              style={{
                left: pct(t.x - 1, W),
                width: pct(t.w + 2, W),
                top: pct(p.top, H),
                height: pct(p.bottom - p.top, H),
              }}
            />
          )
        }),
      )}
    </div>
  )
}
