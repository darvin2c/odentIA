import { cn } from "@odentia/ui"
import { X } from "lucide-react"
import { common } from "../common.js"
import type { FilterDef, FilterTone } from "./filter-def.js"
import { useListSearch } from "./list-search.js"

type StripFilter = Extract<FilterDef, { type: "strip" }>

export interface FilterStripProps {
  filter: StripFilter
  className?: string
}

/**
 * El punto de cada tono, el color de su `Badge`. `outline` es un aro (su `Badge` no tiene relleno)
 * y `default` lleva un halo, para que no se confunda con `soft` en una fila de puntos.
 */
const DOT: Record<FilterTone, string> = {
  default: "bg-primary ring-2 ring-primary/30",
  secondary: "bg-muted-foreground/50",
  destructive: "bg-destructive",
  outline: "border border-foreground/60",
  soft: "bg-primary/60",
  success: "bg-success",
  warning: "bg-warning",
}

const CHIP =
  "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"

/**
 * La tira de un filtro (`type: "strip"`): con un vistazo, cuántas hay en cada opción, y tocar una
 * filtra. «Todas» lleva el total y quita el filtro; la elegida lleva «×» y tocarla otra vez también
 * lo quita. Cada ficha es un botón que se aprieta (`aria-pressed`), con su nombre y su número
 * escritos: el color del punto nunca es la única señal.
 *
 * Lee y escribe el mismo parámetro que los demás filtros (`useListSearch`), así «Limpiar» del
 * `FilterBar` la quita también. En el teléfono la fila se desliza de lado; desde `sm`, se parte en
 * líneas. Sin opciones con algo (ni una elegida), no se pinta.
 */
export function FilterStrip({ filter, className }: FilterStripProps) {
  const { get, setParam } = useListSearch()
  const value = get(filter.key)
  // Lo que no tiene ninguna no se ofrece; la elegida se queda aunque se quede en cero (otro día).
  const shown = filter.options.filter((option) => option.count !== 0 || option.value === value)
  // Con algo elegido se queda «Todas», aunque lo elegido ya no exista: siempre hay cómo quitarlo.
  if (shown.length === 0 && !value) return null
  const total = filter.options.reduce((sum, option) => sum + (option.count ?? 0), 0)
  const hasCounts = filter.options.some((option) => option.count !== undefined)
  return (
    <fieldset
      data-filter-strip={filter.key}
      className={cn(
        // Una fila que se desliza sin barra; el margen negativo deja ver entero el anillo de foco.
        "-mx-1 flex min-w-0 gap-1.5 overflow-x-auto border-0 px-1 py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap",
        className,
      )}
    >
      <legend className="sr-only">{filter.label}</legend>
      <button
        type="button"
        aria-pressed={!value}
        onClick={() => setParam(filter.key, undefined)}
        className={cn(
          CHIP,
          value ? "border-border bg-card hover:border-primary" : "border-foreground bg-foreground text-background",
        )}
      >
        {/* El espacio cuenta: sin él, el lector de pantalla diría «Todas10». */}
        {filter.allLabel ?? common.filters.all}{" "}
        {hasCounts ? <b className="tabular-nums">{total}</b> : null}
      </button>
      {shown.map((option) => {
        const chosen = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={chosen}
            onClick={() => setParam(filter.key, chosen ? undefined : option.value)}
            className={cn(
              CHIP,
              chosen ? "border-primary bg-primary-soft font-medium" : "border-border bg-card hover:border-primary",
            )}
          >
            {option.leading ? (
              <span aria-hidden className="shrink-0">
                {option.leading}
              </span>
            ) : option.tone ? (
              <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", DOT[option.tone])} />
            ) : null}
            {option.label}{" "}
            {option.count !== undefined ? <b className="tabular-nums">{option.count}</b> : null}
            {chosen ? <X aria-hidden className="size-3.5" /> : null}
          </button>
        )
      })}
    </fieldset>
  )
}
