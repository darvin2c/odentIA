import { Fragment, type RefObject, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { archLayout, archNeighbor, type ArchRows } from "@odentia/dental/odontogram-arch"
import { Button } from "@odentia/ui"
import type { OdontogramEntry } from "../../lib/dental/odontogram"
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
  single,
}: {
  /** Una sola arcada a lo ancho (en el celular), para que cada pieza se pueda tocar. */
  single?: "upper" | "lower"
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
  const shownTeeth = single ? { upper: single === "upper" ? teeth.upper : [], lower: single === "lower" ? teeth.lower : [] } : teeth
  const shownInner =
    inner && single ? { upper: single === "upper" ? inner.upper : [], lower: single === "lower" ? inner.lower : [] } : inner
  // biome-ignore lint/correctness/useExhaustiveDependencies: las filas cambian con la dentición y la arcada.
  const layout = useMemo(
    () => archLayout(width, shownTeeth, shownInner, single ? { single } : {}),
    // Las filas son las constantes FDI: cambian solo al cambiar de dentición.
    [width, single, teeth.upper, teeth.lower, inner?.upper, inner?.lower],
  )
  // De arriba abajo, tal como se ven: así ↑ ↓ pasan a la fila de al lado.
  // biome-ignore lint/correctness/useExhaustiveDependencies: las filas cambian con la dentición y la arcada.
  const rows = useMemo(
    () =>
      [shownTeeth.upper, shownInner?.upper ?? [], shownInner?.lower ?? [], shownTeeth.lower].filter((row) => row.length > 0),
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
  return (
    <div
      ref={ref}
      className={`relative mx-auto w-full min-w-0 max-w-[520px] ${single ? "aspect-[10/11]" : "aspect-[10/9]"}`}
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
            // La encía en el tono de odentIA, no en el de la clínica (ADR 0162): el odontograma no cambia.
            className={gum.inner ? "stroke-[color-mix(in_oklab,var(--identity-accent)_10%,transparent)]" : "stroke-[color-mix(in_oklab,var(--identity-accent)_20%,transparent)]"}
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
                {chosen > 0 ? `${label} · ${chosen} ${chosen === 1 ? "elegida" : "elegidas"}` : label}
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
