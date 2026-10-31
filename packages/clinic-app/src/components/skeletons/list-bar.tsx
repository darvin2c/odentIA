/**
 * Piezas de esqueleto de Finanzas, Inventario, Servicios y Reportes: un renglón
 * del alto real de su texto, la barra de búsqueda y filtros sin datos y la
 * lectura de la dirección. Sin consultas: bajan con el arranque de la app.
 */
import { cn, InputGroup, InputGroupAddon, InputGroupInput, Skeleton } from "@odentia/ui"
import { useRouterState } from "@tanstack/react-router"
import { ArrowUpDown, ChevronDown, Search } from "lucide-react"
import type { ReactNode } from "react"

/**
 * Un valor de la dirección actual. El esqueleto de una ruta no recibe props y su
 * forma depende de la pestaña: el router ya está cargado y no pide nada por red.
 */
export function useSearchValue(name: string): string | undefined {
  const value = useRouterState({ select: (state) => (state.location.search as Record<string, unknown>)[name] })
  return typeof value === "string" ? value : undefined
}

/** Un renglón de texto: el alto de su línea, con la barra centrada. */
export function TextLine({ width, height = "h-5", bar = "h-3.5", className }: { width: string; height?: string; bar?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 max-w-full items-center", height, className)}>
      <Skeleton className={cn("max-w-full", bar, width)} />
    </div>
  )
}

/** Varios renglones seguidos, como una celda o un párrafo. */
export function TextLines({ widths, gap = "gap-0.5", className }: { widths: string[]; gap?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col", gap, className)}>
      {widths.map((width, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: renglones de relleno, siempre los mismos.
        <TextLine key={index} width={width} />
      ))}
    </div>
  )
}

/** Un buscador aún sin conectar: el mismo control, desactivado. */
export function SearchShell({ placeholder, className = "relative w-48 shrink-0" }: { placeholder: string; className?: string }) {
  return (
    <div className={className}>
      <InputGroup className="h-9">
        <InputGroupAddon align="inline-start">
          <Search aria-hidden />
        </InputGroupAddon>
        <InputGroupInput type="search" disabled tabIndex={-1} placeholder={placeholder} aria-hidden />
      </InputGroup>
    </div>
  )
}

/** Un filtro con su nombre, como lo dibuja `FilterControl` antes de elegir. */
export function FilterPill({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-input bg-card px-3 text-[13px] font-medium">
      {children}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </span>
  )
}

function SortPill() {
  return (
    <span aria-hidden className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-input bg-card px-3 text-sm font-medium [&_svg]:size-4">
      <ArrowUpDown />
      Ordenar
    </span>
  )
}

/** `FilterBar` mientras llega la pantalla: las dos filas (escritorio y teléfono) con las mismas clases. */
export function FilterBarShell({
  searchLabel,
  searchPlaceholder,
  filters = [],
  sort = false,
}: {
  /** Plegado en el escritorio; sin él, la barra no tiene buscador. */
  searchLabel?: string
  searchPlaceholder?: string
  filters?: string[]
  sort?: boolean
}) {
  return (
    <div className="flex rounded-md bg-card p-3">
      <div className="-m-1 hidden w-full min-w-0 items-center gap-2 overflow-hidden p-1 md:flex">
        {searchLabel ? <SearchShell placeholder={searchLabel} /> : null}
        {filters.map((filter) => (
          <FilterPill key={filter}>{filter}</FilterPill>
        ))}
        {sort ? (
          <div className="ml-auto shrink-0">
            <SortPill />
          </div>
        ) : null}
      </div>
      <div className="flex w-full min-w-0 flex-col gap-2 md:hidden">
        {searchLabel ? <SearchShell placeholder={searchPlaceholder ?? searchLabel} className="relative w-full min-w-0" /> : null}
        {filters.length > 0 || sort ? (
          <div className="-mx-1 flex min-w-0 items-center gap-2 overflow-hidden px-1 pb-0.5">
            {filters.map((filter) => (
              <FilterPill key={filter}>{filter}</FilterPill>
            ))}
            {sort ? <SortPill /> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
