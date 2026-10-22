import { Fragment, type RefObject, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { archLayout, archNeighbor, type ArchRows } from "../lib/odontogram-arch"
import type { OdontogramEntry } from "../lib/patients"
import { ToothSVG } from "./tooth-svg"

/** Ancho con el que se dibuja antes de medir el contenedor. */
const FALLBACK_WIDTH = 360

/** Ancho real del arco: las piezas y los números se calculan para él. */
function useArchWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      // Dentro de un panel plegado mide 0: se conserva el último ancho útil.
      if (el.clientWidth > 100) setWidth(el.clientWidth)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

const pct = (value: number, total: number) => `${(value / total) * 100}%`

/**
 * El arco del odontograma en herradura (issue 150): más ancho que alto, con la
 * encía detrás de las piezas y la derecha y la izquierda del paciente al
 * centro. Crece con su contenedor hasta 520 px. Con el teclado es una sola
 * parada de Tab y se recorre con las flechas.
 */
export function OdontogramArch({
  teeth,
  inner,
  entriesOf,
  selected,
  disabled = false,
  onToggle,
}: {
  teeth: ArchRows
  /** Segundo arco concéntrico (temporales en dentición mixta); sus números van hacia el centro. */
  inner?: ArchRows
  entriesOf: (tooth: number) => OdontogramEntry[]
  selected: number[]
  disabled?: boolean
  onToggle: (tooth: number, additive: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const hintId = useId()
  const width = useArchWidth(ref)
  const layout = useMemo(
    () => archLayout(width, teeth, inner),
    // Las filas son las constantes FDI: cambian solo al cambiar de dentición.
    [width, teeth.upper, teeth.lower, inner?.upper, inner?.lower],
  )
  // De arriba abajo, tal como se ven: así ↑ ↓ pasan a la fila de al lado.
  const rows = useMemo(
    () => [teeth.upper, inner?.upper ?? [], inner?.lower ?? [], teeth.lower].filter((row) => row.length > 0),
    [teeth.upper, teeth.lower, inner?.upper, inner?.lower],
  )
  const [visited, setVisited] = useState<number | null>(null)
  const visible = rows.flat()
  const tabStop =
    visited !== null && visible.includes(visited)
      ? visited
      : (selected.find((tooth) => visible.includes(tooth)) ?? visible[0])

  const toothOf = (target: EventTarget): number | null => {
    const el = (target as HTMLElement).closest<HTMLElement>("[data-tooth]")
    return el ? Number(el.dataset.tooth) : null
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tooth = toothOf(event.target)
    if (tooth === null) return
    if ((event.key === " " || event.key === "Enter") && (event.ctrlKey || event.metaKey)) {
      // Igual que Ctrl + clic: la suma a las ya elegidas.
      event.preventDefault()
      if (!disabled) onToggle(tooth, true)
      return
    }
    const next = archNeighbor(rows, tooth, event.key)
    if (next === null) return
    event.preventDefault()
    setVisited(next)
    ref.current?.querySelector<HTMLElement>(`[data-tooth="${next}"]`)?.focus()
  }

  const { width: W, height: H } = layout
  return (
    <div
      ref={ref}
      className="relative mx-auto aspect-[10/9] w-full min-w-0 max-w-[520px]"
      role="group"
      aria-label="Odontograma"
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
      <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible" viewBox={`0 0 ${W} ${H}`}>
        {layout.gums.map((gum) => (
          <path
            key={gum.d}
            d={gum.d}
            fill="none"
            strokeWidth={gum.width}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={gum.inner ? "stroke-primary-soft/40" : "stroke-primary-soft/70"}
          />
        ))}
        <line x1={W / 2} x2={W / 2} y1={H / 2 - 0.03 * H} y2={H / 2 + 0.03 * H} className="stroke-border" />
        <line x1={W / 2 - 0.03 * W} x2={W / 2 + 0.03 * W} y1={H / 2} y2={H / 2} className="stroke-border" />
      </svg>
      {/* La 18 se ve a la izquierda pero es del lado derecho del paciente. */}
      {(["Derecha", "Izquierda"] as const).map((side, i) => (
        <span
          key={side}
          aria-hidden="true"
          className="absolute -translate-x-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase leading-none tracking-wider text-muted-foreground"
          style={{ left: `${50 + (i === 0 ? -17 : 17)}%`, top: "50%" }}
        >
          {side}
        </span>
      ))}
      {layout.teeth.map((t) => {
        const isSelected = selected.includes(t.tooth)
        return (
          <Fragment key={t.tooth}>
            <div
              className="absolute [&>button]:block [&>button]:w-full"
              style={{
                left: pct(t.x, W),
                top: pct(t.y, H),
                width: pct(t.w, W),
                transform: `translate(-50%,-50%) rotate(${t.rotation}deg)`,
              }}
            >
              <ToothSVG
                toothNumber={t.tooth}
                entries={entriesOf(t.tooth)}
                selected={isSelected}
                disabled={disabled}
                size="arch"
                showRoots={false}
                tabIndex={t.tooth === tabStop ? 0 : -1}
                onSelect={(event) => onToggle(t.tooth, Boolean(event?.ctrlKey || event?.metaKey))}
              />
            </div>
            <span
              aria-hidden="true"
              className={`absolute -translate-x-1/2 -translate-y-1/2 leading-none ${t.w >= 32 ? "text-xs" : "text-[11px]"} ${
                isSelected ? "font-semibold text-foreground" : "text-muted-foreground"
              }`}
              style={{ left: pct(t.labelX, W), top: pct(t.labelY, H) }}
            >
              {t.tooth}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}
