import { Button, cn } from "@odentia/ui"
import { SlidersHorizontal, X } from "lucide-react"
import * as React from "react"
import { common } from "../common.js"
import { FilterControl, hasFilterValue } from "./filter-control.js"
import type { FilterDef, SortOption } from "./filter-def.js"
import { paramKeys } from "./filter-def.js"
import { FilterDrawer } from "./filter-drawer.js"
import { useListSearch } from "./list-search.js"
import { SearchInput } from "./search-input.js"
import { SortMenu } from "./sort-menu.js"

interface FittedInline {
  containerRef: React.RefObject<HTMLDivElement | null>
  visibleCount: number
}

/**
 * Cuántos filtros elegibles caben inline según el ancho medido del row.
 * Optimista: ante más espacio potencial (resize, valores que se achican)
 * prueba con todo y encoge de a uno hasta que `scrollWidth <= clientWidth`.
 * Solo encoge dentro de cada ajuste: nunca oscila.
 */
function useFittedInlineCount(eligibleCount: number, contentKey: string): FittedInline {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [measureTick, setMeasureTick] = React.useState(0)
  // Reset optimista en fase de render (sin carrera con el encogimiento):
  // ante más espacio potencial se prueba con todo y el layout encoge.
  const resetKey = `${eligibleCount}|${contentKey}|${measureTick}`
  const [fitted, setFitted] = React.useState({ key: resetKey, count: eligibleCount })
  if (fitted.key !== resetKey) {
    setFitted({ key: resetKey, count: eligibleCount })
  }
  const visibleCount = Math.min(fitted.count, eligibleCount)

  React.useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => setMeasureTick((tick) => tick + 1))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  React.useLayoutEffect(() => {
    const element = containerRef.current
    if (!element) return
    if (element.scrollWidth - element.clientWidth > 1 && visibleCount > 0) {
      setFitted((previous) => ({
        key: previous.key,
        count: Math.max(0, previous.count - 1),
      }))
    }
  })

  return { containerRef, visibleCount }
}
export interface FilterBarProps {
  filters: FilterDef[]
  sortOptions: SortOption[]
  searchPlaceholder?: string
}

export function FilterBar({
  filters,
  sortOptions,
  searchPlaceholder = common.filters.search,
}: FilterBarProps) {
  const [drawerMode, setDrawerMode] = React.useState<"all" | "overflow" | null>(null)
  const { get, resetFilters } = useListSearch()
  // Pool ordenado por prioridad inline: primarias primero y las de
  // `placement: "overflow"` al final (entran a inline solo si sobra sitio).
  const orderedFilters = React.useMemo(
    () => [
      ...filters.filter((filter) => filter.placement !== "overflow"),
      ...filters.filter((filter) => filter.placement === "overflow"),
    ],
    [filters],
  )
  // Todo lo que cambia el ancho del row: valores de filtros, `q` y `sort`
  // (botones Limpiar/orden). Ante cualquier cambio se reintenta con todo.
  const contentKey = React.useMemo(
    () =>
      JSON.stringify([
        ...orderedFilters.flatMap((filter) => paramKeys(filter).map((key) => get(key) ?? "")),
        get("q") ?? "",
        get("sort") ?? "",
      ]),
    [orderedFilters, get],
  )
  const { containerRef, visibleCount } = useFittedInlineCount(orderedFilters.length, contentKey)
  const primaryFilters = orderedFilters.slice(0, visibleCount)
  const overflowFilters = orderedFilters.slice(visibleCount)
  const activeFilterCount = filters.filter((filter) => hasFilterValue(filter, get)).length
  const activeOverflowCount = overflowFilters.filter((filter) => hasFilterValue(filter, get)).length
  const hasActiveCriteria = activeFilterCount > 0 || Boolean(get("q"))
  const drawerFilters = drawerMode === "overflow" ? overflowFilters : filters
  const drawerTitle = drawerMode === "overflow" ? common.filters.moreFilters : common.filters.label

  return (
    <div className="flex p-3 bg-white rounded-md">
      <div
        ref={containerRef}
        data-filter-row="desktop"
        className="hidden w-full min-w-0 items-center gap-2 overflow-hidden p-1 -m-1 md:flex"
      >
        <SearchInput placeholder={searchPlaceholder} expandable />
        {primaryFilters.map((filter) => (
          <FilterControl key={`${filter.type}:${filter.key}`} filter={filter} layout="popover" />
        ))}
        {overflowFilters.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            className={cn("shrink-0", activeOverflowCount > 0 && "border-accent")}
            onClick={() => setDrawerMode("overflow")}
            aria-label={
              activeOverflowCount > 0
                ? `${common.filters.moreFilters}: ${activeOverflowCount}`
                : common.filters.moreFilters
            }
          >
            <SlidersHorizontal />
            {common.filters.moreFilters}
            {activeOverflowCount > 0 ? (
              <span className="flex min-w-5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs text-accent-foreground">
                {activeOverflowCount}
              </span>
            ) : null}
          </Button>
        ) : null}
        {hasActiveCriteria ? (
          <Button type="button" variant="ghost" className="shrink-0" onClick={resetFilters}>
            <X />
            {common.filters.clear}
          </Button>
        ) : null}
        <div className="ml-auto shrink-0">
          <SortMenu options={sortOptions} />
        </div>
      </div>
      <div className="flex w-full min-w-0 items-center gap-2 md:hidden">
        <SearchInput placeholder={searchPlaceholder} className="min-w-0 flex-1 sm:max-w-64" />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          aria-label={common.filters.label}
          onClick={() => setDrawerMode("all")}
        >
          <SlidersHorizontal />
          <span className="hidden sm:inline">{common.filters.label}</span>
          {activeFilterCount > 0 ? (
            <span className="flex min-w-5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-xs text-accent-foreground">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
        <div className="ml-auto shrink-0">
          <SortMenu options={sortOptions} compact />
        </div>
      </div>
      <FilterDrawer
        filters={drawerFilters}
        open={drawerMode !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerMode(null)
        }}
        title={drawerTitle}
      />
    </div>
  )
}
