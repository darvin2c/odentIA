import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export type FilterOption = {
  value: string
  label: string
  count?: number
  /** Indicador visual complementario; label conserva el nombre textual accesible. */
  leading?: ReactNode
}

export type FilterPlacement = "primary" | "overflow"

type FilterBase = {
  key: string
  label: string
  icon?: LucideIcon
  placement?: FilterPlacement
}

export type FilterDef =
  | (FilterBase & {
      type: "select"
      options: FilterOption[]
    })
  | (FilterBase & {
      type: "multi"
      options: FilterOption[]
      /** Sin parámetro selecciona todos; `none` representa ninguno (valor reservado). */
      emptyMeansAll?: boolean
    })
  | (FilterBase & {
      type: "number-range"
      money?: boolean
    })
  | (FilterBase & {
      type: "date"
    })
  | (FilterBase & {
      type: "date-range"
    })

export type SortOption = { value: string; label: string }

export function paramKeys(filter: FilterDef): string[] {
  switch (filter.type) {
    case "number-range":
      return [`${filter.key}_min`, `${filter.key}_max`]
    case "date":
      return [`${filter.key}_on`]
    case "date-range":
      return [`${filter.key}_from`, `${filter.key}_to`]
    default:
      return [filter.key]
  }
}
