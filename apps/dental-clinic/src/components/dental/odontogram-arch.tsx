import { type ArchRows, archLayout, archNeighbor } from "@odentia/dental/odontogram-arch"
import { frontRowMarksOf } from "@odentia/dental/tooth-front-marks"
import { Button } from "@odentia/ui"
import {
  Fragment,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
import { ToothSVG } from "./tooth-svg"

/** Cuánto más grande que su lugar se dibuja la pieza en el odontograma (`byTooth`). */
const ICON_FILL = 1.14

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
  single,
  aspect,
  title,
  byTooth = false,
}: {
  /** Una sola arcada a lo ancho (en el celular), para que cada pieza se pueda tocar. */
  single?: "upper" | "lower"
  /** Alto sobre ancho, con una sola arcada: más bajo cuando va junto a la vista de frente. */
  aspect?: number
  /**
   * El nombre de la arcada al centro («Superior»), en vez de «Derecha» e «Izquierda»; `null`, nada
   * (la pestaña de al lado ya dice cuál es).
   */
  title?: string | null
  /**
   * Cada pieza del ancho con que se dibuja de frente: el odontograma, junto a su vista de frente. El
   * selector de los formularios, no.
   */
  byTooth?: boolean
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
  // Con una sola arcada, solo sus filas.
  const shownTeeth = single
    ? { upper: single === "upper" ? teeth.upper : [], lower: single === "lower" ? teeth.lower : [] }
    : teeth
  const shownInner =
    inner && single
      ? {
          upper: single === "upper" ? inner.upper : [],
          lower: single === "lower" ? inner.lower : [],
        }
      : inner
  // biome-ignore lint/correctness/useExhaustiveDependencies: las filas cambian con la dentición y la arcada.
  const layout = useMemo(
    () =>
      archLayout(width, shownTeeth, shownInner, {
        ...(single ? { single, ...(aspect ? { aspect } : {}) } : {}),
        byTooth,
      }),
    // Las filas son las constantes FDI: cambian solo al cambiar de dentición.
    [width, single, aspect, byTooth, teeth.upper, teeth.lower, inner?.upper, inner?.lower],
  )
  // De arriba abajo, tal como se ven: así ↑ ↓ pasan a la fila de al lado.
  // biome-ignore lint/correctness/useExhaustiveDependencies: las filas cambian con la dentición y la arcada.
  const rows = useMemo(
    () =>
      [shownTeeth.upper, shownInner?.upper ?? [], shownInner?.lower ?? [], shownTeeth.lower].filter(
        (row) => row.length > 0,
      ),
    [single, teeth.upper, teeth.lower, inner?.upper, inner?.lower],
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
  // Los puentes de cada arcada, con sus piezas vecinas de a pares (el selector no tiene hallazgos).
  const bridges = [shownTeeth.upper, shownTeeth.lower].flatMap((row) =>
    frontRowMarksOf(row, entriesOf)
      .filter((mark) => mark.kind === "bridge")
      .map((mark) => {
        const placed = mark.teeth.flatMap((tooth) => layout.teeth.filter((t) => t.tooth === tooth))
        return {
          key: mark.teeth.join("-"),
          paint: mark.paint,
          pairs: placed.slice(1).map((b, i) => [placed[i]!, b] as const),
        }
      }),
  )
  return (
    <div
      ref={ref}
      className={`relative mx-auto w-full min-w-0 max-w-[520px] ${aspect ? "" : single ? "aspect-[10/11]" : "aspect-[10/9]"}`}
      style={aspect ? { aspectRatio: `1 / ${aspect}` } : undefined}
      role="group"
      aria-label={
        title
          ? `Arcada ${title.toLowerCase()}, de arriba`
          : single
            ? `Arcada ${single === "upper" ? "superior" : "inferior"}, de arriba`
            : "Odontograma"
      }
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
        className="absolute inset-0 size-full overflow-visible"
        viewBox={`0 0 ${W} ${H}`}
      >
        {/* La encía rosada, la misma de la vista de frente, con su borde un poco más oscuro (lienzo del
            23 nov 2026): la celeste del tono de odentIA no parecía encía. Nunca el color de la clínica
            (ADR 0162). */}
        {layout.gums.map((gum) => (
          <g key={gum.d} fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path
              d={gum.d}
              strokeWidth={gum.width + 2}
              className="stroke-[#efb8c2] dark:stroke-rose-900"
            />
            <path
              d={gum.d}
              strokeWidth={gum.width}
              className={
                gum.inner
                  ? "stroke-[#fcebee] dark:stroke-rose-950"
                  : "stroke-[#f9dde2] dark:stroke-rose-950"
              }
            />
          </g>
        ))}
        {title !== undefined ? null : (
          <>
            <line
              x1={W / 2}
              x2={W / 2}
              y1={H / 2 - 0.03 * H}
              y2={H / 2 + 0.03 * H}
              className="stroke-border"
            />
            <line
              x1={W / 2 - 0.03 * W}
              x2={W / 2 + 0.03 * W}
              y1={H / 2}
              y2={H / 2}
              className="stroke-border"
            />
          </>
        )}
      </svg>
      {title ? (
        <span
          aria-hidden="true"
          className="absolute -translate-x-1/2 -translate-y-1/2 text-[11px] font-semibold uppercase leading-none tracking-widest text-muted-foreground"
          style={{ left: "50%", top: single === "upper" ? "62%" : "40%" }}
        >
          {title}
        </span>
      ) : null}
      {/* La 18 se ve a la izquierda pero es del lado derecho del paciente. */}
      {(title !== undefined ? [] : (["Derecha", "Izquierda"] as const)).map((side, i) => (
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
                // En el odontograma el dibujo de la pieza llena su lugar: la corona vista de arriba deja
                // margen dentro de su recuadro y, a su tamaño, quedaba chica y separada (24 nov).
                width: pct(t.w * (byTooth ? ICON_FILL : 1), W),
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
            {/* La elegida, con su número en una pastilla violeta, igual que de frente. */}
            <span
              aria-hidden="true"
              className={`absolute -translate-x-1/2 -translate-y-1/2 leading-none ${byTooth ? "text-[11px] font-medium" : t.w >= 32 ? "text-xs" : "text-[11px]"} ${
                isSelected
                  ? "rounded-full bg-violet-600 px-1.5 py-0.5 font-semibold text-white"
                  : byTooth
                    ? "text-[#4b5563] dark:text-zinc-300"
                    : "text-muted-foreground"
              }`}
              style={(() => {
                // La pastilla de la elegida, un poco más afuera: así no pisa su anillo.
                const push = isSelected && byTooth ? 7 : 0
                const dx = t.labelX - t.x
                const dy = t.labelY - t.y
                const k = 1 + push / (Math.hypot(dx, dy) || 1)
                return { left: pct(t.x + dx * k, W), top: pct(t.y + dy * k, H) }
              })()}
            >
              {t.tooth}
            </span>
          </Fragment>
        )
      })}
      {/* El puente unido entre corona y corona, encima de las piezas, como de frente: con las piezas
          juntas, cada pilar y el póntico se leían como coronas sueltas (revisión del 24 nov). */}
      {bridges.length > 0 ? (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          viewBox={`0 0 ${W} ${H}`}
        >
          {bridges.map(({ key, paint, pairs }) =>
            pairs.map(([a, b]) => {
              const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
              const half = Math.min(a.w, b.w) * 0.22
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              return (
                <line
                  key={`${key}-${a.tooth}`}
                  x1={mx - ((b.x - a.x) / d) * half}
                  y1={my - ((b.y - a.y) / d) * half}
                  x2={mx + ((b.x - a.x) / d) * half}
                  y2={my + ((b.y - a.y) / d) * half}
                  stroke={paint === "red" ? "#dc2626" : "#2563eb"}
                  strokeOpacity={0.6}
                  strokeWidth={Math.min(a.h, b.h) * 0.3}
                  strokeLinecap="round"
                />
              )
            }),
          )}
        </svg>
      ) : null}
    </div>
  )
}

/**
 * Bajo este ancho el selector muestra una arcada a la vez: con las dos juntas,
 * a menos de unos 334 px las piezas quedan por debajo de 24 × 24 px (WCAG
 * 2.5.8); con una sola, a 278 px miden unos 42 × 35.
 */
const PICKER_SPLIT_BELOW = 380

/**
 * El arco para elegir piezas en un formulario (indicar un tratamiento, el
 * diagnóstico, un documento). Si cabe, las dos arcadas; si no (el celular), una
 * a la vez con «Superior» e «Inferior», como el odontograma de la ficha. Cada
 * botón dice cuántas piezas de su arcada están elegidas, sin depender del
 * color, y la vista pasa a la arcada de la pieza que se acaba de elegir (por
 * ejemplo, escrita con su número).
 */
export function OdontogramArchPicker({
  teeth,
  selected,
  disabled = false,
  onToggle,
}: {
  teeth: ArchRows
  selected: number[]
  disabled?: boolean
  onToggle: (tooth: number, additive: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      // Dentro de un panel plegado mide 0: no cambia nada.
      if (el.clientWidth === 0) return
      setNarrow(el.clientWidth < PICKER_SPLIT_BELOW)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const archOf = (tooth: number): "upper" | "lower" | null =>
    teeth.upper.includes(tooth) ? "upper" : teeth.lower.includes(tooth) ? "lower" : null
  const [arch, setArch] = useState<"upper" | "lower">(
    () => selected.map(archOf).find((value) => value !== null) ?? "upper",
  )
  // La última pieza que se agregó manda la vista: elegida en la otra arcada, se ve.
  const before = useRef(selected)
  const selectedKey = selected.join(",")
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con saber si cambió la selección.
  useEffect(() => {
    const added = selected.filter((tooth) => !before.current.includes(tooth))
    before.current = selected
    const last = added.at(-1)
    const next = last === undefined ? null : archOf(last)
    if (next) setArch(next)
  }, [selectedKey])

  return (
    <div ref={ref} className="flex w-full min-w-0 flex-col gap-2">
      {narrow ? (
        <fieldset className="m-0 flex min-w-0 gap-2 border-0 p-0" aria-label="Arcada">
          {(
            [
              ["upper", "Superior", teeth.upper],
              ["lower", "Inferior", teeth.lower],
            ] as const
          ).map(([value, label, row]) => {
            const chosen = row.filter((tooth) => selected.includes(tooth)).length
            return (
              <Button
                key={value}
                type="button"
                size="sm"
                className="min-h-11 flex-1"
                variant={arch === value ? "default" : "outline"}
                aria-pressed={arch === value}
                onClick={() => setArch(value)}
              >
                {chosen > 0
                  ? `${label} · ${chosen} ${chosen === 1 ? "elegida" : "elegidas"}`
                  : label}
              </Button>
            )
          })}
        </fieldset>
      ) : null}
      <OdontogramArch
        {...(narrow ? { single: arch } : {})}
        teeth={teeth}
        entriesOf={() => []}
        selected={selected}
        disabled={disabled}
        onToggle={onToggle}
      />
    </div>
  )
}
