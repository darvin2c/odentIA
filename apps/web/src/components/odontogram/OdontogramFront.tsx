// La boca de frente de la app en la web: cada pieza con su corona y su raíz dentro de la encía, junto
// al arco, como en el odontograma de la clínica desde el 24 nov. Usa la misma geometría
// (`@odentia/dental/tooth-front`) y las mismas reglas de qué se dibuja (`tooth-front-marks`); el
// dibujo es el de `apps/dental-clinic/src/components/dental/odontogram-front.tsx`, solo con lo que
// muestran los ejemplos de la web (caras, corona, conductos, pulpotomía, ausente, la que sale). Es una
// vista de ejemplo: no guarda nada.
import { archNeighbor } from "@odentia/dental/odontogram-arch"
import {
  canalPaths,
  crownPath,
  type FrontRow,
  type FrontTooth,
  frontRow,
  frontRowWidthMm,
  frontSpecOf,
  mesialIsRight,
  rootPaths,
} from "@odentia/dental/tooth-front"
import { type FrontEntry, type FrontMarks, frontMarksOf, type Paint } from "@odentia/dental/tooth-front-marks"
import { type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react"
import type { ExampleFinding } from "./OdontogramArch"

/** Lo que es cada hallazgo de los ejemplos en la app: la condición, su cara y que está en buen estado. */
const EXAMPLE_ENTRY: Record<ExampleFinding, { condition: string; surface?: string }> = {
  caries: { condition: "caries", surface: "occlusal" },
  restauracion: { condition: "definitive_restoration", surface: "occlusal" },
  sellante: { condition: "sealant", surface: "occlusal" },
  ausente: { condition: "missing_tooth" },
  corona: { condition: "crown" },
  saliendo: { condition: "erupting_tooth" },
  sigla: { condition: "deep_pits_fissures" },
}

/**
 * Los hallazgos de una pieza del ejemplo, como los guarda la app, para dibujarla de frente. `also`
 * suma lo que el arco no muestra y de frente sí (la endodoncia bajo la corona, la pulpotomía).
 */
export function exampleEntries(
  tooth: number,
  kind: ExampleFinding | undefined,
  also: readonly string[] = [],
): FrontEntry[] {
  const list: { condition: string; surface?: string }[] = [
    ...(kind ? [EXAMPLE_ENTRY[kind]] : []),
    ...also.map((condition) => ({ condition })),
  ]
  return list.map((entry, i) => ({
    id: `${tooth}-${i}`,
    toothNumber: tooth,
    condition: entry.condition,
    surface: entry.surface ?? null,
    details: { quality: "good" },
  }))
}

const INK: Record<Paint, string> = { red: "#dc2626", blue: "#2563eb" }
/** Unidades del SVG por mm de dibujo, y px de pantalla por mm: el mismo tamaño que en la app. */
const S = 5
const PX_PER_MM = 3.5
/** Solo con temporales va más grande, como en la app; en el teléfono, hasta 5,2. */
const PRIMARY_PX_PER_MM = 4.4
const PHONE_MAX_PX_PER_MM = 5.2
/** Las de leche en su propia fila, junto a las permanentes: a este tanto de su tamaño. */
const PRIMARY_OWN_ROW = 0.88
const NUMBER_BAND = 24
const ROW_GAP = 10
const GROUP_GAP = 26
const n = (value: number) => value.toFixed(1)
const pct = (value: number, total: number) => `${n((value / total) * 100)}%`

const isPrimaryRow = (teeth: readonly number[]) => teeth.length > 0 && Math.trunc(teeth[0]! / 10) >= 5

/** Las filas una debajo de otra, cada una con sus números del lado de las coronas (como la app). */
function layoutRows(rows: readonly (readonly number[])[]) {
  const withPermanent = rows.some((teeth) => teeth.length > 0 && !isPrimaryRow(teeth))
  const scaleOf = (teeth: readonly number[], aligned: boolean) =>
    isPrimaryRow(teeth) && withPermanent && !aligned ? S * PRIMARY_OWN_ROW : S
  const widths = rows.map((teeth) => frontRowWidthMm(teeth) * scaleOf(teeth, false))
  const width = Math.max(...widths) + 2 * 2.6 * S + 8
  // En la mixta, cada pieza de leche va bajo la permanente que la reemplaza (la 55 bajo la 15).
  const slots = new Map<number, { x: number; w: number }>()
  /** La fila de cada reemplazo: la de leche va bajo ella solo si todas caen en la misma. */
  const rowOf = new Map<number, number>()
  rows.forEach((teeth, i) => {
    if (isPrimaryRow(teeth)) return
    for (const t of frontRow(teeth, { scale: S, left: (width - widths[i]!) / 2, yOcc: 0 }).teeth) {
      slots.set(t.tooth + 40, { x: t.x, w: t.w })
      rowOf.set(t.tooth + 40, i)
    }
  })
  /** Dos filas van juntas si una es la de leche de la otra, con todas sus temporales bajo ella. */
  const together = (a: readonly number[], b: readonly number[]) => {
    if (isPrimaryRow(a) === isPrimaryRow(b)) return false
    const primary = isPrimaryRow(a) ? a : b
    const pair = rows.indexOf(isPrimaryRow(a) ? b : a)
    return primary.every((tooth) => rowOf.get(tooth) === pair)
  }
  let cursor = 4
  const placed: Placed[] = rows.map((teeth, i) => {
    // Entre una fila y la de leche que va con ella, poco; entre grupos, más (como la app).
    const prev = rows[i - 1]
    if (prev && !together(prev, teeth) && (isPrimaryRow(prev) || isPrimaryRow(teeth))) cursor += GROUP_GAP
    const aligned =
      isPrimaryRow(teeth) && teeth.every((tooth) => slots.has(tooth) && rowOf.get(tooth) === rowOf.get(teeth[0]!))
    const left = (width - widths[i]!) / 2
    const opts = aligned ? { slots } : {}
    const scale = scaleOf(teeth, aligned)
    const probe = frontRow(teeth, { scale, left, yOcc: 0, ...opts })
    if (probe.up) {
      const yOcc = cursor - probe.top
      const row = frontRow(teeth, { scale, left, yOcc, ...opts })
      const bottom = yOcc + NUMBER_BAND + 4
      cursor = bottom + ROW_GAP
      return { row, numberY: yOcc + NUMBER_BAND / 2 + 2, top: row.top, bottom }
    }
    const top = cursor
    const row = frontRow(teeth, { scale, left, yOcc: cursor + NUMBER_BAND + 4, ...opts })
    cursor = row.bottom + ROW_GAP
    return { row, numberY: top + NUMBER_BAND / 2 + 2, top, bottom: row.bottom }
  })
  return { width, height: cursor - ROW_GAP + 4, placed }
}

interface Placed {
  row: FrontRow
  /** Dónde van los números (centro de la franja). */
  numberY: number
  /** Lo que ocupa la fila con sus números: lo que se toca de cada pieza. */
  top: number
  bottom: number
}

/**
 * ↑ ↓: la pieza de la fila de al lado que está justo arriba o abajo en el dibujo. Por posición en
 * la fila no sirve en la mixta: la 55 va bajo la 15, no repartida a lo ancho (como la app).
 */
function aboveOrBelow(placed: readonly Placed[], tooth: number, step: -1 | 1): number | null {
  const r = placed.findIndex((p) => p.row.teeth.some((t) => t.tooth === tooth))
  const next = placed[r + step]?.row.teeth
  if (r < 0 || !next || next.length === 0) return null
  const from = placed[r]!.row.teeth.find((t) => t.tooth === tooth)!
  const center = from.x + from.w / 2
  let best = next[0]!
  for (const t of next) if (Math.abs(t.x + t.w / 2 - center) < Math.abs(best.x + best.w / 2 - center)) best = t
  return best.tooth
}

/**
 * En el teléfono, como la app (`singleArchRows`): las permanentes en dos filas de 8 y las de leche
 * enteras del lado de las coronas (solas, también en dos). Así, a 360 px, ninguna pieza baja de 24 px.
 */
function phoneRows(rows: readonly (readonly number[])[]): number[][] {
  const halves = (row: readonly number[]) => [row.slice(0, row.length / 2), row.slice(row.length / 2)]
  const upper = (row: readonly number[]) => [1, 2, 5, 6].includes(Math.trunc(row[0]! / 10))
  const arch = (isUpper: boolean) => {
    const permanent = rows.find((row) => row.length > 0 && upper(row) === isUpper && !isPrimaryRow(row))
    const primary = rows.find((row) => row.length > 0 && upper(row) === isUpper && isPrimaryRow(row))
    if (!permanent) return primary ? halves(primary) : []
    if (!primary) return halves(permanent)
    return isUpper ? [...halves(permanent), [...primary]] : [[...primary], ...halves(permanent)]
  }
  return [...arch(true), ...arch(false)]
}

/** Una cara vista de frente: el borde (oclusal o incisal), un lado o el centro. */
function surfaceShape(zone: FrontMarks["surfaces"][number]["zone"], tooth: number, w: number, ch: number): string {
  const right = mesialIsRight(tooth)
  const side = zone === "mesial" ? (right ? "right" : "left") : zone === "distal" ? (right ? "left" : "right") : null
  if (zone === "edge")
    return `M${n(0.24 * w)},${n(0.1 * ch)} Q${n(0.5 * w)},${n(0.02 * ch)} ${n(0.76 * w)},${n(0.1 * ch)} Q${n(0.72 * w)},${n(0.3 * ch)} ${n(0.5 * w)},${n(0.3 * ch)} Q${n(0.28 * w)},${n(0.3 * ch)} ${n(0.24 * w)},${n(0.1 * ch)} Z`
  if (side === "left")
    return `M${n(0.08 * w)},${n(0.25 * ch)} Q${n(0.26 * w)},${n(0.3 * ch)} ${n(0.27 * w)},${n(0.55 * ch)} Q${n(0.26 * w)},${n(0.8 * ch)} ${n(0.12 * w)},${n(0.85 * ch)} Q${n(0.03 * w)},${n(0.55 * ch)} ${n(0.08 * w)},${n(0.25 * ch)} Z`
  if (side === "right")
    return `M${n(0.92 * w)},${n(0.25 * ch)} Q${n(0.74 * w)},${n(0.3 * ch)} ${n(0.73 * w)},${n(0.55 * ch)} Q${n(0.74 * w)},${n(0.8 * ch)} ${n(0.88 * w)},${n(0.85 * ch)} Q${n(0.97 * w)},${n(0.55 * ch)} ${n(0.92 * w)},${n(0.25 * ch)} Z`
  return `M${n(0.5 * w)},${n(0.36 * ch)} m${n(-0.17 * w)},0 a${n(0.17 * w)},${n(0.17 * ch)} 0 1,0 ${n(0.34 * w)},0 a${n(0.17 * w)},${n(0.17 * ch)} 0 1,0 ${n(-0.34 * w)},0`
}

/** La pieza con lo que tiene, en su sitio; se dibuja con la corona arriba y se refleja si es de arriba. */
function ToothFront({ t, yOcc, reach, marks }: { t: FrontTooth; yOcc: number; reach: number; marks: FrontMarks }) {
  const spec = frontSpecOf(t.tooth)
  const { w, ch, rl } = t
  const crown = crownPath(spec.kind, w, ch)
  const roots = rootPaths(spec, w, ch, rl)
  const line = (paint: Paint, width: number) => ({
    stroke: INK[paint],
    strokeWidth: width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  })
  const canals = marks.canals
    ? canalPaths(spec, w, ch, rl).map((d) => <path key={d} d={d} {...line(marks.canals!, 2)} />)
    : null
  let body: React.ReactNode
  if (marks.body === "missing") {
    const paint = marks.bodyPaint ?? "blue"
    body = (
      <g opacity={0.75}>
        <path d={crown} {...line(paint, 1.2)} strokeDasharray="4 3" />
        <path d={roots.front} {...line(paint, 1)} strokeDasharray="4 3" />
        <line x1={w * 0.1} y1={ch * 0.05} x2={w * 0.9} y2={ch + rl * 0.9} {...line(paint, 1.6)} />
        <line x1={w * 0.9} y1={ch * 0.05} x2={w * 0.1} y2={ch + rl * 0.9} {...line(paint, 1.6)} />
      </g>
    )
  } else {
    const arrow = marks.arrow?.kind === "erupting" ? INK[marks.arrow.paint] : null
    const x = w / 2
    body = (
      <>
        {/* La raíz marfil, distinta de la corona. */}
        <g fill="#f7f1e6" stroke="#c9d1dc">
          {roots.back ? <path d={roots.back} fillOpacity={0.7} strokeWidth={0.9} /> : null}
          <path d={roots.front} strokeWidth={1} strokeLinejoin="round" />
        </g>
        {marks.crown ? (
          <path d={crown} fill={INK[marks.crown]} fillOpacity={0.16} stroke={INK[marks.crown]} strokeWidth={2} strokeLinejoin="round" />
        ) : (
          <path d={crown} fill="#f8fafc" stroke="#8a97ab" strokeWidth={1.3} strokeLinejoin="round" />
        )}
        {marks.pulpotomy ? (
          <rect
            x={w * 0.38}
            y={ch * 0.38}
            width={w * 0.24}
            height={ch * 0.55}
            rx={w * 0.1}
            fill={INK[marks.pulpotomy]}
            fillOpacity={0.4}
            stroke={INK[marks.pulpotomy]}
            strokeWidth={1.2}
          />
        ) : null}
        {marks.surfaces.map((mark) => {
          const d = surfaceShape(mark.zone, t.tooth, w, ch)
          return mark.style === "fill" ? (
            <path key={`${mark.zone}-${mark.paint}`} d={d} fill={INK[mark.paint]} fillOpacity={0.85} />
          ) : (
            <path key={`${mark.zone}-${mark.paint}`} d={d} {...line(mark.paint, 1.6)} />
          )
        })}
        {canals}
        {/* La que está saliendo: la flecha en zigzag hacia el borde, dentro de la corona (NTS 6.1.23). */}
        {arrow ? (
          <g stroke={arrow} fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <polyline
              points={`${n(x)},${n(ch * 0.88)} ${n(x - 3)},${n(ch * 0.7)} ${n(x + 3)},${n(ch * 0.5)} ${n(x - 3)},${n(ch * 0.3)} ${n(x)},${n(ch * 0.12)}`}
            />
            <path d={`M${n(x - 3.5)},${n(ch * 0.12 + 4)} L${n(x)},${n(ch * 0.12)} L${n(x + 3.5)},${n(ch * 0.12 + 4)}`} />
          </g>
        ) : null}
      </>
    )
  }
  // La que sale va corrida hacia la raíz, sin pasar de la encía.
  const shift = marks.shift > 0 ? Math.min(marks.shift * ch, Math.max(0, reach - ch - rl - 4)) : marks.shift * ch
  const transform = `translate(${n(t.x)} ${n(yOcc)})${t.up ? " scale(1 -1)" : ""}${shift ? ` translate(0 ${n(shift)})` : ""}`
  return <g transform={transform}>{body}</g>
}

/** El ancho donde va la vista: `null` hasta medirlo (en el servidor, a su tamaño). */
function useAvailableWidth(ref: React.RefObject<HTMLDivElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      if (el.clientWidth > 100) setWidth(el.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * La boca de frente. Cada pieza es un botón (una sola parada de Tab y las flechas), con el mismo
 * elegido que el arco de al lado.
 */
export default function OdontogramFront({
  rows,
  entriesOf,
  selected,
  onPick,
  labelOf,
}: {
  /** Las filas de arriba abajo, cada una de izquierda a derecha como se ven. */
  rows: readonly (readonly number[])[]
  entriesOf: (tooth: number) => readonly FrontEntry[]
  selected: number | null
  onPick: (tooth: number) => void
  labelOf: (tooth: number) => string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const hintId = useId()
  const available = useAvailableWidth(wrapRef)
  const whole = rows.filter((row) => row.length > 0)
  const wide = layoutRows(whole)
  const base = whole.every(isPrimaryRow) ? PRIMARY_PX_PER_MM : PX_PER_MM
  // Si no cabe a su tamaño, la arcada en dos filas, que llenan el ancho (como la app en el celular).
  const phone = available !== null && (wide.width * base) / S > available
  const shown = phone ? phoneRows(whole) : whole
  const { width: W, height: H, placed } = phone ? layoutRows(shown) : wide
  const px = phone ? Math.min(PHONE_MAX_PX_PER_MM, ((available ?? 0) * S) / W) : base
  const [visited, setVisited] = useState<number | null>(null)
  const visible = shown.flat()
  const tabStop =
    (visited !== null && visible.includes(visited) ? visited : null) ??
    (selected !== null && visible.includes(selected) ? selected : null) ??
    visible[0]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-front-tooth]")
    if (!el) return
    const tooth = Number(el.dataset.frontTooth)
    const next =
      event.key === "ArrowUp" || event.key === "ArrowDown"
        ? aboveOrBelow(placed, tooth, event.key === "ArrowUp" ? -1 : 1)
        : archNeighbor(shown, tooth, event.key)
    if (next === null) return
    event.preventDefault()
    setVisited(next)
    ref.current?.querySelector<HTMLElement>(`[data-front-tooth="${next}"]`)?.focus()
  }

  return (
    <div ref={wrapRef} className="of-wrap">
    <div
      ref={ref}
      className="of"
      style={{ width: `${n((W * px) / S)}px` }}
      role="group"
      aria-label="De frente, cada pieza con su raíz"
      aria-describedby={hintId}
      onKeyDown={onKeyDown}
    >
      <span id={hintId} className="sr-only">
        Usa las flechas para moverte entre piezas.
      </span>
      <svg aria-hidden="true" viewBox={`0 0 ${n(W)} ${n(H)}`} className="of-svg">
        {placed.map((p) => {
          const reach = Math.abs((p.row.up ? p.row.top : p.row.bottom) - p.row.yOcc)
          return (
            <g key={p.row.teeth[0]?.tooth ?? p.top}>
              <path d={p.row.gum} fill="#f9dde2" stroke="none" />
              {p.row.teeth.map((t) => (
                <ToothFront key={t.tooth} t={t} yOcc={p.row.yOcc} reach={reach} marks={frontMarksOf(t.tooth, entriesOf(t.tooth))} />
              ))}
              {/* La encía por delante: cubre el cuello de cada corona con su festón. */}
              <path d={p.row.gumFront} fill="#f9dde2" stroke="none" />
              <path d={p.row.gumLine} fill="none" stroke="#efb8c2" strokeWidth={1.2} strokeLinejoin="round" />
              {p.row.teeth.map((t) => {
                if (t.tooth !== selected) return null
                const top = t.up ? p.row.yOcc - t.ch - t.rl - 6 : p.row.yOcc - 6
                return (
                  <rect
                    key={`sel-${t.tooth}`}
                    x={t.x - 4}
                    y={top}
                    width={t.w + 8}
                    height={t.ch + t.rl + 12}
                    rx={10}
                    fill="rgba(124, 58, 237, .1)"
                    stroke="#7c3aed"
                    strokeWidth={1.6}
                  />
                )
              })}
              {p.row.teeth.map((t) => {
                const cx = t.x + t.w / 2
                const on = t.tooth === selected
                return (
                  <g key={`n-${t.tooth}`}>
                    {on ? <rect x={cx - 18} y={p.numberY - 11} width={36} height={22} rx={11} fill="#7c3aed" /> : null}
                    <text
                      x={cx}
                      y={p.numberY}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={15}
                      fontWeight={on ? 700 : 500}
                      fill={on ? "#fff" : "#4b5563"}
                    >
                      {t.tooth}
                    </text>
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
      {placed.flatMap((p) =>
        p.row.teeth.map((t) => (
          <button
            key={t.tooth}
            type="button"
            className="of-tooth"
            data-front-tooth={t.tooth}
            aria-label={labelOf(t.tooth)}
            aria-pressed={t.tooth === selected}
            tabIndex={t.tooth === tabStop ? 0 : -1}
            onClick={() => onPick(t.tooth)}
            onFocus={() => setVisited(t.tooth)}
            style={{
              left: pct((t.hit?.x ?? t.x) - 1, W),
              width: pct((t.hit?.w ?? t.w) + 2, W),
              top: pct(p.top, H),
              height: pct(p.bottom - p.top, H),
            }}
          />
        )),
      )}
    </div>
    </div>
  )
}
