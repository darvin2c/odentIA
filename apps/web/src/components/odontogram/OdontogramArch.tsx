// El odontograma de la app en la web (lienzo del paso 3, tablero «Arch»): la misma herradura con
// encía (`archLayout`), las mismas siluetas, surcos y caras de cada pieza (`tooth-shapes`) y los
// mismos colores de la norma. Es una vista de ejemplo: no guarda nada. Se dibuja como el modo
// «arch» estático de `apps/dental-clinic/src/components/dental/tooth-svg.tsx`.
import { type ArchRows, archLayout, archNeighbor } from "@odentia/dental/odontogram-arch"
import {
  CROWN_SQUARE,
  groovesFor,
  MISSING_TOOTH_LINES,
  silhouetteFor,
  toothTypeOf,
  zonesFor,
} from "@odentia/dental/tooth-shapes"
import { Fragment, type KeyboardEvent, useId, useLayoutEffect, useRef, useState } from "react"
import "./odontogram.css"

/** Los hallazgos que muestra la web de ejemplo, con su dibujo de la norma. */
export type ExampleFinding = "caries" | "ausente" | "corona" | "restauracion"

/** Rojo y azul de la norma (NTS 188), los mismos de la app. */
const RED = "#dc2626"
const BLUE = "#2563eb"

/** Dentición permanente, como la ve el odontólogo: la 18 a la izquierda. */
const ADULT: ArchRows = {
  upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
}
const ROWS = [ADULT.upper, ADULT.lower]

/** Ancho con el que se dibuja en el servidor, antes de medir el contenedor (como la app). */
const FALLBACK_WIDTH = 360
/** Como en la app: crece con su contenedor hasta 520 px. */
const MAX_WIDTH = 520

// Redondeados: el servidor y el navegador no dan los mismos últimos decimales y React avisaría al hidratar.
const round = (value: number) => Math.round(value * 1000) / 1000
const pct = (value: number, total: number) => `${round((value / total) * 100)}%`

/** Una pieza en el modo «arco» de la app: corona sin raíces, sus caras, el símbolo y los surcos. */
function Tooth({ tooth, finding }: { tooth: number; finding?: ExampleFinding }) {
  const clipId = `oa-clip-${useId().replace(/:/g, "")}`
  const type = toothTypeOf(tooth)
  const silhouette = silhouetteFor(type)
  const zones = zonesFor(tooth, true)
  // La caries y la restauración del ejemplo son de la cara central (oclusal o incisal).
  const central = zones.find((zone) => zone.surface === "occlusal" || zone.surface === "incisal")
  const paint = finding === "caries" ? RED : finding ? BLUE : null
  return (
    <svg viewBox="3 0 18 15" className="oa-crown" strokeWidth={0.6} aria-hidden="true">
      <defs>
        <clipPath id={clipId}>
          <path d={silhouette.crown} />
        </clipPath>
      </defs>
      <path d={silhouette.crown} fill="#fff" stroke="#6b7280" strokeLinejoin="round" />
      <g clipPath={`url(#${clipId})`}>
        {zones.map((zone) => {
          const filled = paint && zone === central && (finding === "caries" || finding === "restauracion")
          return (
            <polygon
              key={zone.surface}
              points={zone.points}
              fill={filled ? paint : "#fff"}
              fillOpacity={filled ? 1 : 0.55}
              stroke="none"
            />
          )
        })}
      </g>
      {finding === "ausente" ? (
        <g stroke={BLUE} fill="none" strokeWidth={1} strokeLinecap="round">
          {MISSING_TOOTH_LINES.map((line) => (
            <line key={`${line.x1}-${line.y1}`} {...line} />
          ))}
        </g>
      ) : null}
      {finding === "corona" ? <rect {...CROWN_SQUARE} fill="none" stroke={BLUE} strokeWidth={1} /> : null}
      {groovesFor(type).map((d) => (
        <path key={d} d={d} fill="none" stroke="#9ca3af" strokeWidth={0.45} opacity={0.7} />
      ))}
    </svg>
  )
}

/** Ancho real del arco: las piezas y los números se calculan para él (como `useArchWidth` de la app). */
function useArchWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      if (el.clientWidth > 100) setWidth(Math.min(MAX_WIDTH, el.clientWidth))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * La herradura del odontograma. Con `onPick` cada pieza es un botón (una sola parada de Tab y las
 * flechas, como en la app); sin él es una imagen con su descripción.
 */
export default function OdontogramArch({
  findings,
  selected = null,
  onPick,
  labelOf,
  description,
}: {
  findings: Partial<Record<number, ExampleFinding>>
  selected?: number | null
  onPick?: (tooth: number) => void
  /** Lo que dice el lector de pantalla de cada pieza (solo con `onPick`). */
  labelOf?: (tooth: number) => string
  /** Descripción del dibujo cuando no se puede tocar. */
  description?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const hintId = useId()
  const width = useArchWidth(ref)
  const layout = archLayout(width, ADULT)
  const [visited, setVisited] = useState<number | null>(null)
  const interactive = Boolean(onPick)
  const tabStop = visited ?? selected ?? ADULT.upper[0]

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-tooth]")
    if (!el) return
    const next = archNeighbor(ROWS, Number(el.dataset.tooth), event.key)
    if (next === null) return
    event.preventDefault()
    setVisited(next)
    ref.current?.querySelector<HTMLElement>(`[data-tooth="${next}"]`)?.focus()
  }

  const { width: W, height: H } = layout
  return (
    <div className="oa">
      <div
        ref={ref}
        className="oa-arch"
        {...(interactive
          ? { role: "group", "aria-label": "Odontograma", "aria-describedby": hintId, onKeyDown }
          : { role: "img", "aria-label": description ?? "Odontograma" })}
      >
        {interactive ? (
          <span id={hintId} className="sr-only">
            Usa las flechas para moverte entre piezas.
          </span>
        ) : null}
        <svg aria-hidden="true" className="oa-under" viewBox={`0 0 ${W} ${H}`}>
          {layout.gums.map((gum) => (
            <path
              key={gum.d}
              d={gum.d}
              fill="none"
              stroke="#d9eff5"
              strokeOpacity={0.7}
              strokeWidth={round(gum.width)}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          <line x1={W / 2} x2={W / 2} y1={H / 2 - 0.03 * H} y2={H / 2 + 0.03 * H} stroke="#e2e8f0" />
          <line x1={W / 2 - 0.03 * W} x2={W / 2 + 0.03 * W} y1={H / 2} y2={H / 2} stroke="#e2e8f0" />
        </svg>
        {/* La 18 se ve a la izquierda pero es del lado derecho del paciente. */}
        {(["Derecha", "Izquierda"] as const).map((side, i) => (
          <span key={side} aria-hidden="true" className="oa-side" style={{ left: `${50 + (i === 0 ? -17 : 17)}%` }}>
            {side}
          </span>
        ))}
        {layout.teeth.map((t) => {
          const isSelected = t.tooth === selected
          const crown = <Tooth tooth={t.tooth} finding={findings[t.tooth]} />
          return (
            <Fragment key={t.tooth}>
              <div
                className="oa-slot"
                style={{
                  left: pct(t.x, W),
                  top: pct(t.y, H),
                  width: pct(t.w, W),
                  transform: `translate(-50%, -50%) rotate(${round(t.rotation)}deg)`,
                }}
              >
                {interactive ? (
                  <button
                    type="button"
                    className={`oa-tooth${isSelected ? " on" : ""}`}
                    data-tooth={t.tooth}
                    tabIndex={t.tooth === tabStop ? 0 : -1}
                    aria-pressed={isSelected}
                    aria-label={labelOf?.(t.tooth) ?? `Pieza ${t.tooth}`}
                    onClick={() => onPick?.(t.tooth)}
                    onFocus={() => setVisited(t.tooth)}
                  >
                    {crown}
                  </button>
                ) : (
                  <span className={`oa-tooth${isSelected ? " on" : ""}`}>{crown}</span>
                )}
              </div>
              <span
                aria-hidden="true"
                className={`oa-num${isSelected ? " on" : ""}`}
                style={{ left: pct(t.labelX, W), top: pct(t.labelY, H), fontSize: t.w >= 32 ? 12 : 11 }}
              >
                {t.tooth}
              </span>
            </Fragment>
          )
        })}
      </div>
      <div className="oa-legend">
        <span>
          <i style={{ background: RED }} />
          Patología, mal estado o temporal
        </span>
        <span>
          <i style={{ background: BLUE }} />
          Buen estado o característica no patológica
        </span>
      </div>
    </div>
  )
}
